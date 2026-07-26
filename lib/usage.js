import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { getSetting, insertUsageSnapshot, latestUsageSnapshot, pruneUsageSnapshots } from './db.js';

export const POLL_FLOOR_SEC = 60;
export const DEFAULT_POLL_SEC = 180;
export const USAGE_SHOW_MODES = ['banner', 'compact', 'off'];
// Display-only severity thresholds for the usage strip. Deliberately *not* the
// budget guard's `reserveFiveHourPct`/`reserveWeeklyPct`, which decide whether a
// run fires: colouring a meter red and refusing to launch are different
// judgements, and tying them would mean a cosmetic tweak changing what runs.
// Kept as a validated pair (crit > warn) so the warn band can't become dead.
export const DEFAULT_WARN_PCT = 75;
export const DEFAULT_CRIT_PCT = 85;
const PROBE_TIMEOUT_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const KEEP_SNAPSHOTS = 2000;

// Flatten a `get_usage` payload into the snapshot shape.
//
// `rate_limits` is an open map: alongside five_hour/seven_day it carries a
// rotating set of codename buckets (`tangelo`, `nimbus_quill`, …), almost all
// null for any given account, plus fixed non-window members (extra_usage,
// spend, limits[], model_scoped[]). Rather than name the windows we want — and
// silently miss whichever bucket ships next — admit any non-array object that
// exposes a numeric `utilization` or a `resets_at`. On this account that rule
// yields exactly five_hour and seven_day: the null codenames aren't objects,
// extra_usage's utilization is null with no resets_at, spend reports `percent`
// under a different name, and the two arrays are excluded by shape.
export function flattenUsage(payload) {
  const rl = payload?.rate_limits;
  const available = payload?.rate_limits_available === true && !!rl && typeof rl === 'object';

  const windows = {};
  if (available) {
    for (const [key, v] of Object.entries(rl)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const percent = typeof v.utilization === 'number' ? v.utilization : null;
      const resetsAt = typeof v.resets_at === 'string' ? v.resets_at : null;
      if (percent === null && resetsAt === null) continue;
      windows[key] = { percent, resetsAt };
    }
  }

  const buckets = available && Array.isArray(rl.limits)
    ? rl.limits.filter((b) => b && typeof b === 'object').map((b) => ({
      kind: b.kind ?? null,
      group: b.group ?? null,
      percent: typeof b.percent === 'number' ? b.percent : null,
      severity: b.severity ?? 'normal',
      resetsAt: typeof b.resets_at === 'string' ? b.resets_at : null,
      scopeModel: b.scope?.model?.display_name ?? null,
      isActive: !!b.is_active,
    }))
    : [];

  return { available, subscriptionType: payload?.subscription_type ?? null, windows, buckets };
}

// The numeric part of a snapshot: `{window: percent}`, skipping windows that
// report no percent. This is all a delta can be computed from.
export function usagePercents(snapshot) {
  const out = {};
  for (const [w, v] of Object.entries(snapshot?.windows ?? {})) {
    if (typeof v?.percent === 'number') out[w] = v.percent;
  }
  return out;
}

// First complete `control_response` line in the buffer, or undefined if the
// answer hasn't arrived yet. Everything else on stdout (init events, log noise,
// non-JSON) is ignored rather than treated as an error: the CLI is free to emit
// whatever it likes around the reply we asked for.
function firstControlResponse(buffer) {
  const lines = buffer.split('\n');
  lines.pop(); // trailing fragment — may still be mid-line
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type === 'control_response' && obj.response) return obj.response;
  }
  return undefined;
}

// One `get_usage` probe. A stdin control request is the only supported way to
// ask the CLI what the account's limits are; it costs $0 and takes no model
// turn, and the child is killed the moment it answers rather than waited on.
function runProbe({ spawnFn, cmd, requestId, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(cmd, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
        { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }

    let out = '';
    let err = '';
    let done = false;
    const settle = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      fn(arg);
    };

    // A hung probe must not pin a poll slot forever — SIGKILL, not SIGTERM,
    // because a wedged child is exactly the one that ignores a polite signal.
    // Settle before killing, here and below: the kill makes the child exit
    // non-zero, and a `close` handler that could still win the race would throw
    // away an answer we already have.
    const watchdog = setTimeout(() => {
      settle(reject, new Error(`probe timed out after ${timeoutMs}ms`));
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    watchdog.unref?.();

    child.stdout.on('data', (d) => {
      out += d;
      const response = firstControlResponse(out);
      if (response !== undefined) {
        settle(resolve, response);
        try { child.kill('SIGTERM'); } catch {}
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => settle(reject, e));
    child.on('close', (code) => {
      const tail = err.trim().split('\n').slice(-1)[0] ?? '';
      settle(reject, new Error(`probe exited ${code} without a usage response${tail ? `: ${tail}` : ''}`));
    });

    try {
      child.stdin.write(JSON.stringify({
        type: 'control_request',
        request_id: String(requestId),
        request: { subtype: 'get_usage' },
      }) + '\n');
      child.stdin.end();
    } catch (e) {
      settle(reject, e);
    }
  });
}

// Signature of everything a consumer would re-plan on: percents, reset times,
// and whether usage is legible at all. Used to suppress no-op `usage` events so
// M2 doesn't re-arm timers every poll.
function signature(s) {
  if (!s) return '';
  const w = Object.entries(s.windows ?? {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v.percent}@${v.resetsAt}`);
  const b = (s.buckets ?? []).map((x) => `${x.kind}/${x.scopeModel}:${x.percent}/${x.severity}@${x.resetsAt}${x.isActive ? '!' : ''}`);
  return `${s.ok ? 1 : 0}${s.available ? 1 : 0}|${w.join(',')}|${b.join(',')}`;
}

const emptySnapshot = (capturedAt) => ({
  capturedAt, checkedAt: capturedAt, ok: false, error: null, stale: true,
  available: false, subscriptionType: null, windows: {}, buckets: [],
});

// Polls `get_usage` so the daemon always knows the real limit state, records
// every result (failures included), and emits on change.
//
// **Fails open by construction.** A broken probe leaves the last good snapshot
// in place marked stale and never throws at a caller; nothing here can block a
// run or suppress a fire. Every consumer must read "unknown" as "allowed".
export function createUsageMonitor({
  db,
  spawnFn = spawn,
  getClaudePath = () => getSetting(db, 'claudePath', 'claude'),
  intervalMs = null,
  now = () => Date.now(),
  pollFloorMs = POLL_FLOOR_SEC * 1000,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const events = new EventEmitter();
  let last = null;
  let timer = null;
  let inFlight = null;
  let stopped = true;
  let failures = 0;
  let reqId = 0;
  let nextAt = null;
  let emitted = '';

  // Survive a daemon restart with something to show: the newest recorded good
  // snapshot, marked stale until the first probe of this process lands.
  try {
    const seed = latestUsageSnapshot(db, { okOnly: true });
    if (seed) last = { ...seed, checkedAt: seed.capturedAt, ok: false, stale: true, error: null };
  } catch {}

  // The setting is authoritative and editable at runtime; an explicit
  // `intervalMs` (tests, embedding) overrides it. Floored either way — the
  // ceiling on how often we may ask is not the caller's to raise.
  function pollMs() {
    if (intervalMs != null) return Math.max(pollFloorMs, intervalMs);
    const sec = Number(getSetting(db, 'usagePollSec', DEFAULT_POLL_SEC));
    return Math.max(pollFloorMs, (Number.isFinite(sec) && sec > 0 ? sec : DEFAULT_POLL_SEC) * 1000);
  }

  const delayMs = () => (failures ? Math.min(pollMs() * 2 ** failures, BACKOFF_MAX_MS) : pollMs());

  const decorate = (s) => (s ? {
    ...s,
    pollSec: Math.round(pollMs() / 1000),
    nextPollAt: nextAt ? new Date(nextAt).toISOString() : null,
  } : null);

  function record(snap) {
    try {
      insertUsageSnapshot(db, snap);
      pruneUsageSnapshots(db, KEEP_SNAPSHOTS);
    } catch {
      // Losing a history row is not worth failing a poll over.
    }
  }

  function publish(snap) {
    last = snap;
    const sig = signature(snap);
    if (sig === emitted) return;
    emitted = sig;
    events.emit('usage', decorate(snap));
  }

  async function tick() {
    const at = new Date(now()).toISOString();
    try {
      const response = await runProbe({
        spawnFn, cmd: getClaudePath() || 'claude', requestId: ++reqId, timeoutMs: probeTimeoutMs,
      });
      if (response.subtype && response.subtype !== 'success') {
        throw new Error(response.error?.message ?? `control_response ${response.subtype}`);
      }
      failures = 0;
      const snap = { capturedAt: at, checkedAt: at, ok: true, error: null, stale: false, ...flattenUsage(response.response) };
      record(snap);
      publish(snap);
    } catch (err) {
      failures++;
      const msg = err?.message ?? String(err);
      // The row records the failure itself — a gap in the good series is the
      // signal that monitoring broke. What we keep *serving* is the last good
      // reading, because stale truth beats no truth for a fail-open consumer.
      record({ capturedAt: at, ok: false, error: msg, available: false, subscriptionType: null, windows: {}, buckets: [] });
      publish({ ...(last ?? emptySnapshot(at)), checkedAt: at, ok: false, stale: true, error: msg });
    }
    return decorate(last);
  }

  // A refresh landing on top of a scheduled poll joins it instead of spawning a
  // second probe. `coalesce: false` opts out: a caller measuring what just
  // happened (per-run calibration) must not be handed a probe that started
  // before it asked, so it waits its turn and then probes for itself.
  function refresh({ coalesce = true } = {}) {
    if (inFlight) return coalesce ? inFlight : inFlight.then(() => refresh({ coalesce: false }));
    inFlight = tick().finally(() => { inFlight = null; });
    return inFlight;
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (stopped) return;
    const ms = delayMs();
    nextAt = now() + ms;
    timer = setTimeout(cycle, ms);
    timer.unref?.();
  }

  async function cycle() {
    await refresh();
    schedule();
  }

  function start({ immediate = true } = {}) {
    if (!stopped) return status();
    stopped = false;
    if (immediate) cycle();
    else schedule();
    return status();
  }

  function stop() {
    stopped = true;
    clearTimeout(timer);
    timer = null;
    nextAt = null;
  }

  const snapshot = () => decorate(last);
  const window = (name) => last?.windows?.[name] ?? null;

  function status() {
    return {
      running: !stopped,
      pollSec: Math.round(pollMs() / 1000),
      nextPollAt: nextAt ? new Date(nextAt).toISOString() : null,
      failures,
      ok: last?.ok ?? null,
      stale: last?.stale ?? null,
      available: last?.available ?? null,
      error: last?.error ?? null,
    };
  }

  return { start, stop, snapshot, window, refresh, events, status };
}
