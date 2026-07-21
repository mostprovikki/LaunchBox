import { spawn } from 'node:child_process';
import { listJobs, getSetting, setSetting } from './db.js';

export const AWAKE_MODES = ['off', 'auto', 'timed', 'on'];

// Keeps the Mac awake (à la `caffeinate`) so scheduled jobs actually fire.
// Modes:
//   off   — never hold awake
//   on    — hold awake indefinitely
//   timed — hold awake until a deadline (awakeUntil setting), then flip to off
//   auto  — hold awake only while a run is active, or any enabled job has a
//           future fire (and schedules aren't paused)
// The assertion is one `caffeinate -i -w <daemon pid>` child: `-w` ties its
// lifetime to the daemon, so a crash can't leave the Mac insomniac.
export function createAwake({ db, runner, scheduler, spawnFn = spawn, now = () => Date.now() }) {
  let child = null;
  let expiryTimer = null;

  const mode = () => {
    const m = getSetting(db, 'awakeMode', 'off');
    return AWAKE_MODES.includes(m) ? m : 'off';
  };
  const until = () => getSetting(db, 'awakeUntil', null);

  function desired() {
    switch (mode()) {
      case 'on': return true;
      case 'timed': return !!until() && new Date(until()).getTime() > now();
      case 'auto': {
        if (runner.runningCount() > 0) return true;
        if (getSetting(db, 'paused', '0') === '1') return false;
        return listJobs(db).some((j) => j.enabled && scheduler.nextFire(j.id));
      }
      default: return false;
    }
  }

  function refresh() {
    clearTimeout(expiryTimer);
    if (mode() === 'timed') {
      const ms = until() ? new Date(until()).getTime() - now() : 0;
      if (ms <= 0) {
        setSetting(db, 'awakeMode', 'off');
      } else {
        expiryTimer = setTimeout(refresh, ms + 50);
        expiryTimer.unref?.();
      }
    }
    const want = desired();
    if (want && !child) {
      child = spawnFn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      child.unref?.();
      child.on?.('error', () => { child = null; });
      child.on?.('exit', () => { child = null; });
    } else if (!want && child) {
      const c = child;
      child = null;
      try { c.kill('SIGTERM'); } catch {}
    }
    return status();
  }

  function set({ mode: m, minutes } = {}) {
    if (!AWAKE_MODES.includes(m)) throw new Error(`mode must be one of ${AWAKE_MODES.join('|')}`);
    if (m === 'timed') {
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 7 * 1440) throw new Error('minutes must be 1-10080');
      setSetting(db, 'awakeUntil', new Date(now() + minutes * 60_000).toISOString());
    }
    setSetting(db, 'awakeMode', m);
    return refresh();
  }

  function status() {
    const m = mode();
    return { mode: m, until: m === 'timed' ? until() : null, active: !!child };
  }

  function stop() {
    clearTimeout(expiryTimer);
    if (child) { try { child.kill('SIGTERM'); } catch {} child = null; }
  }

  // Run start/stop flips `auto`; job/settings edits call refresh() via routes.
  runner.events.on('change', refresh);

  return { status, set, refresh, stop };
}
