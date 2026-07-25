import { spawn } from 'node:child_process';
import { listJobs, getSetting, setSetting } from './db.js';
import { scheduleEntries, afterResetFireAt } from './validate.js';

export const AWAKE_MODES = ['off', 'auto', 'timed', 'on'];
export const DEFAULT_RESET_LEAD_MIN = 20;
// How far past a computed fire time we keep holding. Small and bounded: without
// it, a reset time frozen by a broken probe would hold the Mac awake forever.
const RESET_GRACE_MS = 60_000;

// Keeps the Mac awake (à la `caffeinate`) so scheduled jobs actually fire.
// Modes:
//   off   — never hold awake
//   on    — hold awake indefinitely
//   timed — hold awake until a deadline (awakeUntil setting), then flip to off
//   auto  — hold awake only while a run is active, any enabled job has a
//           future fire, or a reset-anchored fire is due soon (and schedules
//           aren't paused)
// The assertion is one `caffeinate -i -w <daemon pid>` child: `-w` ties its
// lifetime to the daemon, so a crash can't leave the Mac insomniac.
export function createAwake({ db, runner, scheduler, usage = null, pause = null, spawnFn = spawn, now = () => Date.now() }) {
  let child = null;
  let expiryTimer = null;

  const mode = () => {
    const m = getSetting(db, 'awakeMode', 'off');
    return AWAKE_MODES.includes(m) ? m : 'off';
  };
  const until = () => getSetting(db, 'awakeUntil', null);
  const leadMs = () => {
    const n = Number(getSetting(db, 'awakeResetLeadMin', DEFAULT_RESET_LEAD_MIN));
    return (Number.isFinite(n) && n >= 0 ? n : DEFAULT_RESET_LEAD_MIN) * 60_000;
  };

  // A reset-anchored fire is only armed once usage reports a reset time, and
  // there is no catch-up — so a 3 a.m. window rollover on a sleeping Mac is
  // simply a missed run. Hold awake as the reset approaches, whether or not the
  // scheduler has managed to arm a timer for it yet.
  function resetFireDueSoon() {
    if (!usage) return false;
    const lead = leadMs();
    for (const job of listJobs(db)) {
      if (!job.enabled) continue;
      for (const entry of scheduleEntries(job.schedule)) {
        if (entry.type !== 'afterReset') continue;
        const at = afterResetFireAt(entry, usage.window(entry.window)?.resetsAt, job.id);
        if (!at) continue;
        const dt = new Date(at).getTime() - now();
        if (dt <= lead && dt > -RESET_GRACE_MS) return true;
      }
    }
    return false;
  }

  function desired() {
    switch (mode()) {
      case 'on': return true;
      case 'timed': return !!until() && new Date(until()).getTime() > now();
      case 'auto': {
        if (runner.runningCount() > 0) return true;
        // Any pause mode means nothing is going to fire, so there is nothing to
        // stay awake for. Falls back to the legacy setting without a controller.
        if (pause ? pause.blocksSchedule() : getSetting(db, 'paused', '0') === '1') return false;
        if (listJobs(db).some((j) => j.enabled && scheduler.nextFire(j.id))) return true;
        return resetFireDueSoon();
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
  // A new reading can move a reset boundary into (or out of) the lead window.
  usage?.events.on('usage', refresh);

  return { status, set, refresh, stop };
}
