import { Cron } from 'croner';
import { listJobs, getJob, updateJob, getSetting } from './db.js';
import { scheduleEntries, afterResetFireAt, hasAfterReset } from './validate.js';

// A one-shot timer for a fixed moment, in place of croner's Date mode. A timer
// can wake slightly early; croner then skipped the fire and re-armed from a
// second clock read that had ticked past the moment, found no next run and
// armed nothing — the fire was silently lost (claude-scheduler-ioy). Here each
// wake reads the clock once: early re-arms for the remainder, otherwise fire.
// A late wake still fires; callers decide up front whether a moment is stale.
// Long waits are chunked, since setTimeout overflows past ~24.8 days.
const MAX_TIMER_MS = 2 ** 31 - 1;
function oneShot(at, fn) {
  const t = new Date(at).getTime();
  let timer = null;
  let done = false;
  const handle = {
    nextRun: () => (done ? null : new Date(t)),
    stop: () => { done = true; clearTimeout(timer); },
  };
  const arm = (ms) => {
    // unref: the daemon is kept alive by its HTTP listener; timers must not
    // pin test processes open.
    timer = setTimeout(wake, Math.min(Math.max(ms, 0), MAX_TIMER_MS));
    timer.unref?.();
  };
  function wake() {
    if (done) return;
    const left = t - Date.now();
    if (left > 0) return arm(left);
    done = true;
    fn(handle);
  }
  arm(t - Date.now());
  return handle;
}

// Holds timers per enabled job — croner for cron entries, oneShot for fixed
// moments — one per schedule entry (a job may have several, e.g. once@5am +
// once@10am). Pause-all (settings.paused='1')
// suppresses fires without touching job state. Once-entries drop off as they
// fire; when nothing can ever fire again the job auto-disables.
//
// `usage` is optional. With a monitor attached, `afterReset` entries are armed
// against the live `resets_at` and re-armed whenever usage changes; without one
// they simply never arm — the job stays enabled and editable, which is the same
// fail-open posture the rest of the usage layer takes.
//
// `pause` is optional too: without a controller this falls back to reading the
// legacy `paused` setting directly, so a standalone scheduler behaves as it did.
// Every pause mode drops a scheduled fire identically — they differ only in what
// they do to work already running, which is not this module's business.
export function createScheduler({ db, runner, usage = null, pause = null }) {
  const crons = new Map(); // jobId -> (Cron | oneShot)[]
  // 'jobId|window' -> the resetsAt this pair has already fired for. Re-arming on
  // every usage event would otherwise fire the same window instance repeatedly:
  // the reset time doesn't move until the window actually rolls over.
  const firedResets = new Map();

  const paused = () => (pause ? pause.blocksSchedule() : getSetting(db, 'paused', '0') === '1');
  const resetKey = (jobId, window) => `${jobId}|${window}`;

  function fire(jobId, entryType, cron, { window, resetsAt } = {}) {
    const job = getJob(db, jobId);
    if (entryType === 'afterReset') {
      // Recorded before the pause check: this window instance has been dealt
      // with either way, and a suppressed fire must not come back on re-arm.
      firedResets.set(resetKey(jobId, window), resetsAt);
      cron.stop();
      crons.set(jobId, (crons.get(jobId) || []).filter((c) => c !== cron));
    }
    if (paused()) return;
    if (entryType === 'once') {
      // A once-entry never re-fires: drop it, and disable the job when no
      // entry (this or others) has a future run left.
      cron.stop();
      const rest = (crons.get(jobId) || []).filter((c) => c !== cron);
      crons.set(jobId, rest);
      // An unarmed afterReset entry has no cron to count, but it is still a
      // future fire — disabling the job here would lose it permanently.
      if (job && !rest.some((c) => c.nextRun()) && !hasAfterReset(job.schedule)) {
        updateJob(db, jobId, { enabled: false });
        unschedule(jobId);
      }
    }
    if (!job || !job.enabled) return;
    runner.start(job, entryType === 'once' ? 'once' : 'schedule');
  }

  // Arm the next reset-anchored fire, or don't — every reason to skip is a
  // reason to wait for the next usage event, which re-arms from scratch.
  function armAfterReset(job, entry, list) {
    const resetsAt = usage?.window(entry.window)?.resetsAt;
    if (!resetsAt) return;
    if (firedResets.get(resetKey(job.id, entry.window)) === resetsAt) return;
    const at = afterResetFireAt(entry, resetsAt, job.id);
    // A computed time already past is not caught up on — same no-catch-up
    // semantics as a once-entry whose moment passed while the daemon was down.
    if (!at || new Date(at) <= new Date()) return;
    const c = oneShot(at, () => fire(job.id, 'afterReset', c, { window: entry.window, resetsAt }));
    list.push(c);
  }

  function schedule(job) {
    unschedule(job.id);
    if (!job.enabled) return;
    const list = [];
    // unref: the daemon is kept alive by its HTTP listener; timers must not
    // pin test processes open.
    for (const entry of scheduleEntries(job.schedule)) {
      if (entry.type === 'cron') {
        try {
          const c = new Cron(entry.expr, { unref: true }, () => fire(job.id, 'cron', c));
          list.push(c);
        } catch { /* invalid entry — validated at write time; skip defensively */ }
      } else if (entry.type === 'afterReset') {
        armAfterReset(job, entry, list);
      } else {
        const at = new Date(entry.at);
        if (at > new Date()) {
          const c = oneShot(at, () => fire(job.id, 'once', c));
          list.push(c);
        }
      }
    }
    if (list.length) crons.set(job.id, list);
  }

  function unschedule(jobId) {
    for (const c of crons.get(jobId) || []) c.stop();
    crons.delete(jobId);
  }

  function reload(jobId) {
    const job = getJob(db, jobId);
    if (job) schedule(job);
    else unschedule(jobId);
  }

  // A new reading may mean a new reset boundary. Rebuilding the whole job is
  // safe: cron entries recompute from their expression, spent once-entries are
  // excluded by their `at > now` check, and firedResets stops a window instance
  // from firing twice.
  function onUsage() {
    for (const job of listJobs(db)) {
      if (job.enabled && hasAfterReset(job.schedule)) schedule(job);
    }
  }

  function nextFire(jobId) {
    const nexts = (crons.get(jobId) || []).map((c) => c.nextRun()).filter(Boolean);
    if (!nexts.length) return null;
    return new Date(Math.min(...nexts.map((d) => d.getTime()))).toISOString();
  }

  function start() {
    for (const job of listJobs(db)) schedule(job);
    usage?.events.on('usage', onUsage);
  }

  function stop() {
    usage?.events.off('usage', onUsage);
    for (const id of [...crons.keys()]) unschedule(id);
  }

  return { start, stop, reload, nextFire };
}
