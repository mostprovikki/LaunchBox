// Pure (DOM-free) helpers for the Jobs tab (claude-scheduler-btv.5 / B1).
// Split out of jobs.js so the row-grammar/reason-per-state logic — the part
// REVIEW.md calls "the single best property of the design" — can be unit
// tested directly, no jsdom required. Only public/v2/pages/jobs.js imports
// this module.
//
// Schedule-text formatting (cronPreset/entryDescribe/scheduleDescribe) is
// copied in spirit from public/app.js's cronToPreset()/entryText() (NOT
// imported — /v2 owns its own modules, see README.md) and trimmed to the
// read-only "describe" case this list needs; the editable builder is D1's
// (claude-scheduler-btv.11).
//
// Reason-per-state copy for skipped/timeout/killed/stopped rows is derived
// from GET /api/v2/overview's `attention[]` (claude-scheduler-btv.2, already
// landed) — that endpoint decodes lib/budget.js's/lib/pause.js's own English
// sentences into {code, ...fields} once, server-side, precisely so no page
// has to re-parse them or invent a second wording. See server.js's
// `decodeReason()`/`SKIP_REASON_PATTERNS` comment for the sentence shapes.

// The status -> {colour class, dot form, label} table and ordinal() used to be
// declared in this file too. Both now come from ../state-vocab.js, the single
// definition every /v2 page shares (claude-scheduler-bmn) — B2 had written its
// own copy and the two had already drifted on the 'fail' label.
import { statusMeta, ordinal } from '../state-vocab.js';

export const pad2 = (n) => String(n).padStart(2, '0');

export function fmtClock(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "08:12" for something that happened today (or in the last 24h, same
// calendar day check is skipped for simplicity — a job list has no need for
// the old UI's timezone-naming nuance), else "19 Jul".
export function fmtWhen(iso, now = Date.now()) {
  if (!iso) return null;
  const d = new Date(iso);
  const sameDay = d.getFullYear() === new Date(now).getFullYear()
    && d.getMonth() === new Date(now).getMonth()
    && d.getDate() === new Date(now).getDate();
  return sameDay ? fmtClock(iso) : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// "0m 41s" / "15m 00s" — always minutes+seconds, matching the mockups' style
// even for sub-minute runs (never bare seconds).
export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${pad2(secs)}s`;
}

// "in 26m" / "in 4h 19m" / "due now" — next-fire countdown.
export function relIn(iso, now = Date.now()) {
  if (!iso) return null;
  const diff = new Date(iso).getTime() - now;
  if (!Number.isFinite(diff)) return null;
  if (diff <= 0) return 'due now';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remM = mins % 60;
  if (hrs < 24) return remM ? `in ${hrs}h ${remM}m` : `in ${hrs}h`;
  return `in ${Math.floor(hrs / 24)}d`;
}

// `{time} · {duration}` when both are known, else whichever half exists —
// never the literal string "null" (fmtDuration/fmtWhen return null cleanly).
export function timeAndDuration(startedAt, finishedAt, now) {
  const when = fmtWhen(finishedAt ?? startedAt, now);
  const dur = startedAt && finishedAt ? fmtDuration(new Date(finishedAt) - new Date(startedAt)) : null;
  if (when && dur) return `${when} · ${dur}`;
  return when ?? dur ?? '';
}

const RESET_WINDOW_LABEL = { five_hour: '5-hour', seven_day: 'weekly' };
function cronPreset(expr) {
  let m;
  if ((m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(expr))) return `daily ${pad2(+m[2])}:${pad2(+m[1])}`;
  if ((m = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/.exec(expr))) return `weekdays ${pad2(+m[2])}:${pad2(+m[1])}`;
  if ((m = /^0 \*\/(\d+) \* \* \*$/.exec(expr))) return `every ${m[1]}h`;
  if ((m = /^\*\/(\d+) \* \* \* \*$/.exec(expr))) return `every ${m[1]}m`;
  if ((m = /^(\d{1,2}) \* \* \* \*$/.exec(expr))) return `hourly at :${pad2(+m[1])}`;
  return `cron ${expr}`;
}
function entryDescribe(e) {
  if (!e || typeof e !== 'object') return 'no schedule';
  if (e.type === 'once') return `once, ${e.at ? new Date(e.at).toLocaleString() : '?'}`;
  if (e.type === 'afterReset') {
    return `after ${RESET_WINDOW_LABEL[e.window] ?? e.window ?? '?'} reset${e.offsetMin ? ` +${e.offsetMin}m` : ''}`;
  }
  return cronPreset(e.expr ?? '');
}
export function scheduleEntries(schedule) {
  return Array.isArray(schedule) ? schedule : schedule ? [schedule] : [];
}
export function scheduleDescribe(schedule) {
  const entries = scheduleEntries(schedule);
  if (!entries.length) return 'no schedule';
  const parts = entries.map(entryDescribe);
  return parts.length > 2 ? `${parts.slice(0, 2).join(' · ')} +${parts.length - 2} more` : parts.join(' · ');
}
export const hasAfterReset = (schedule) => scheduleEntries(schedule).some((e) => e?.type === 'afterReset');

// job.type -> the two-letter badge + tooltip. `names` is the /api/extensions
// manifest's {id -> name} map (fetched once by jobs.js) so a third-party
// extension gets its own name instead of a guessed one.
export function typeBadge(type, names = {}) {
  if (type === 'claude') return { code: 'CL', info: true, tip: names.claude ?? 'Claude job' };
  if (type === 'command') return { code: 'SH', info: false, tip: names.command ?? 'Shell command' };
  return { code: (type ?? '??').slice(0, 2).toUpperCase(), info: false, tip: names[type] ?? type ?? 'Unknown job type' };
}

// Second line of the "Job" column: the command/prompt-derived detail. The
// mockup (redesign/jobs.html) mixes cron text, cwd and command per row by
// hand; real jobs need one deterministic rule, so: command jobs show the
// command, claude jobs show cwd (+ model, when pinned away from "default").
export function jobDetailLine(job) {
  if (job.type === 'command') return job.params?.command || '';
  const bits = [job.cwd || ''].filter(Boolean);
  if (job.params?.model && job.params.model !== 'default') bits.push(`model ${job.params.model}`);
  return bits.join(' · ');
}

// Structured reason (from /api/v2/overview's attention[]) -> the single-line
// copy the mockups use. Never invents a cause the data doesn't support —
// see jobs.js's top comment on the 'killed' fallback.
export function reasonText(reason) {
  if (!reason) return null;
  switch (reason.code) {
    case 'reserve': return `would breach ${reason.windowLabel} reserve`;
    case 'bucket_severity': return `${reason.bucket} at ${reason.percent}%`;
    case 'job_min_headroom': return `needs ${reason.minHeadroomPct}% headroom (${reason.leftPct}% left)`;
    case 'paused': return `paused (${reason.mode})`;
    default: return reason.message ?? null;
  }
}

export function stopReasonText(reason) {
  if (/^paused \(soft\)$/.test(reason?.stopReason ?? '')) return 'wound down during soft pause';
  return 'stopped — not a failure';
}

// GET /api/v2/overview wraps this as `{ asOf, items: [...] }`, not a bare
// array (server.js: `attention: { asOf: nowIso, items: attention }`) — caught
// by driving this page against the real endpoint in a real browser, not by
// the jsdom tests, which had fed computeRowState a hand-built (and wrong)
// shape. Kept defensive (`?.items ?? []`) so a future reshape degrades to "no
// extra reason text" instead of a thrown TypeError.
export function attentionByJobId(overview) {
  const map = new Map();
  for (const a of overview?.attention?.items ?? []) if (a.jobId) map.set(a.jobId, a);
  return map;
}
export function runningByJobId(overview) {
  const map = new Map();
  for (const r of overview?.running?.runs ?? []) map.set(r.jobId, r);
  return map;
}

// The row-grammar decision: which shared state a row is in, plus the reason
// line. The colour class / dot form / label triple is NOT decided here — it is
// looked up in ../state-vocab.js via `vocab()` below, so Jobs can never again
// word a state differently from Runs. What stays local is the part that is
// genuinely Jobs-specific: which state a *job* (not a run) is in, and the
// second line of prose.
//
// `attention`/`running` are the Map()s above, already keyed by jobId so this
// stays a plain lookup — no re-fetching per row.
const vocab = (status, rest) => {
  const m = statusMeta(status);
  return { stateClass: m.cls, dotForm: m.form, label: m.label, ...rest };
};

export function computeRowState(job, { attention, running, now = Date.now() } = {}) {
  const live = running?.get(job.id);
  if (live) {
    return vocab('running', {
      link: 'runs',
      l2: `since ${fmtClock(live.startedAt) ?? '?'} · ${fmtDuration(live.elapsedMs) ?? '0m 00s'}`,
    });
  }

  const lr = job.lastRun;
  if (lr?.status === 'queued') {
    return vocab('queued', {
      link: 'runs',
      l2: `queued ${fmtClock(lr.startedAt) ?? ''} · waiting for a slot`.replace(/\s+·/, ' ·').trim(),
    });
  }

  if (!job.enabled) {
    const l2 = lr
      ? `${timeAndDuration(lr.startedAt, lr.finishedAt, now)} ${lr.status}`.trim()
      : 'has never run';
    return vocab('disabled', { link: lr ? 'runs' : null, l2 });
  }

  if (!lr) return vocab('never', { link: null, l2: 'has never run' });

  const att = attention?.get(job.id);
  const attFor = (kind) => (att && att.kind === kind ? att : null);

  switch (lr.status) {
    case 'ok':
    case 'fail':
      return vocab(lr.status, { link: 'runs', l2: timeAndDuration(lr.startedAt, lr.finishedAt, now) });
    case 'timeout': {
      const streak = attFor('timeout')?.reason?.streak;
      const streakTxt = Number.isFinite(streak) && streak > 1 ? ` · ${ordinal(streak)} in a row` : '';
      return vocab('timeout', {
        link: 'runs',
        l2: `${timeAndDuration(lr.startedAt, lr.finishedAt, now)}${streakTxt}`,
      });
    }
    case 'killed':
      // lib/runner.js's kill() records no reason in meta (unlike requestStop's
      // stopReason) — a manual /kill and a hard-pause killAll are indistinguishable
      // after the fact, so this never claims "hard stop was active" (the mockup's
      // wording) without data to back it; "stopped immediately" is always true.
      return vocab('killed', { link: 'runs', l2: `${fmtWhen(lr.finishedAt ?? lr.startedAt, now) ?? ''} · stopped immediately`.trim() });
    case 'stopped':
      return vocab('stopped', { link: 'runs', l2: stopReasonText(attFor('stopped')?.reason) });
    case 'skipped':
      return vocab('skipped', { link: 'runs', l2: reasonText(attFor('skipped')?.reason) ?? lr.skipReason ?? 'skipped' });
    default:
      return vocab(lr.status, { link: 'runs', l2: '' });
  }
}

// Filter/segment logic behind the toolbar (search box + All/Claude/Shell
// segs). `type` is 'all' | 'claude' | 'command'.
export function filterJobs(jobs, { query = '', type = 'all' } = {}) {
  const q = query.trim().toLowerCase();
  return jobs.filter((j) => {
    if (type !== 'all' && j.type !== type) return false;
    if (!q) return true;
    const hay = [j.name, j.cwd, scheduleDescribe(j.schedule), ...Object.values(j.params ?? {})]
      .map((v) => String(v ?? '').toLowerCase());
    return hay.some((h) => h.includes(q));
  });
}
