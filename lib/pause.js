import { getSetting, setSetting } from './db.js';

// `hold` is the behaviour v1 shipped as `paused`, under a name. Ordered
// least-to-most forceful, which is also the order the segmented control shows.
export const PAUSE_MODES = ['off', 'hold', 'soft', 'hard'];

// What each mode does:
//   off   — nothing is blocked
//   hold  — scheduled fires are dropped; manual runs still allowed; in-flight
//           work untouched. Exactly what `settings.paused = '1'` did in v1.
//   soft  — nothing new starts (manual included, unless explicitly overridden)
//           and in-flight runs are asked to wind down at their next safe point
//   hard  — nothing new starts and everything in flight is killed now
//
// The distinction that matters: `hold` and `soft` differ not in what they block
// but in what they do to work already running. `hold` is a scheduling pause;
// `soft` is a drain.
export function createPauseController({ db, runner, now = () => Date.now() }) {
  let expiryTimer = null;

  const until = () => getSetting(db, 'pauseUntil', null);
  const lapsed = () => {
    const u = until();
    return !!u && new Date(u).getTime() <= now();
  };

  // Legacy read: a db written by v1 has `paused` and no `pauseMode`. `paused='1'`
  // meant "drop scheduled fires, leave manual alone" — that is `hold`, so an
  // upgrade must not silently promote it to something that stops more than it did.
  function stored() {
    const raw = getSetting(db, 'pauseMode', null);
    if (PAUSE_MODES.includes(raw)) return raw;
    return getSetting(db, 'paused', '0') === '1' ? 'hold' : 'off';
  }

  // A lapsed deadline reads as `off` even if the expiry timer never fired — the
  // Mac may have been asleep, and the pause is over regardless of whether this
  // process was awake to notice.
  function mode() {
    const m = stored();
    return m !== 'off' && lapsed() ? 'off' : m;
  }

  const blocksSchedule = () => mode() !== 'off';

  // The runner's `admit` hook. Composed ahead of the budget guard: being paused
  // outranks any budget reason, and it's the more useful thing to report.
  // `hold` deliberately returns null for every trigger — the scheduler has
  // already dropped the fire, and anything that reaches the runner under `hold`
  // (a manual click, a retry armed before the pause) went through in v1 too.
  function gate(job, trigger, { force = false } = {}) {
    const m = mode();
    if (m === 'off' || m === 'hold') return null;
    // An explicit, confirmed override — the person is right there and has been
    // told what the mode is.
    if (force) return null;
    return `paused (${m})`;
  }

  // Writes back a lapsed deadline and arms the timer for a live one. Separate
  // from mode() so reads stay side-effect-free.
  function refresh() {
    clearTimeout(expiryTimer);
    if (stored() !== 'off' && until()) {
      if (lapsed()) {
        setSetting(db, 'pauseMode', 'off');
        setSetting(db, 'paused', '0');
        setSetting(db, 'pauseUntil', '');
      } else {
        expiryTimer = setTimeout(refresh, new Date(until()).getTime() - now() + 50);
        expiryTimer.unref?.();
      }
    }
    return status();
  }

  function set({ mode: m, minutes } = {}) {
    if (!PAUSE_MODES.includes(m)) throw new Error(`mode must be one of ${PAUSE_MODES.join('|')}`);
    if (minutes != null) {
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 7 * 1440) throw new Error('minutes must be 1-10080');
      if (m === 'off') throw new Error('a timed pause needs a mode other than off');
    }
    setSetting(db, 'pauseMode', m);
    // Kept in step for one release: anything still reading `paused` (an older
    // cached UI, a script) sees true whenever a pause of any kind is in effect.
    setSetting(db, 'paused', m === 'off' ? '0' : '1');
    setSetting(db, 'pauseUntil', minutes != null ? new Date(now() + minutes * 60_000).toISOString() : '');

    const stoppedRuns = [];
    const clearedQueue = [];
    if (m === 'soft' || m === 'hard') {
      // Queued work first, either way: it hasn't started, so there is nothing to
      // wind down and nothing to kill.
      clearedQueue.push(...runner.clearQueue(`paused (${m})`));
    }
    if (m === 'soft') {
      stoppedRuns.push(...runner.requestStopAll(`paused (soft)`));
    } else if (m === 'hard') {
      // Recorded as `killed`, because that is what happened to them.
      runner.killAll({ status: 'killed' });
    }
    return { ...refresh(), stopped: stoppedRuns, clearedQueue };
  }

  function status() {
    const m = mode();
    return {
      mode: m,
      until: m === 'off' ? null : until() || null,
      blocking: {
        // `hold` blocks the scheduler only; soft/hard block manual runs too.
        schedule: m !== 'off',
        manual: m === 'soft' || m === 'hard',
      },
      stopping: runner.stopping(),
    };
  }

  function stop() {
    clearTimeout(expiryTimer);
  }

  return { status, set, refresh, gate, blocksSchedule, mode, stop };
}
