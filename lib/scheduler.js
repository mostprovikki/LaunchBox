import { Cron } from 'croner';
import { listJobs, getJob, updateJob, getSetting } from './db.js';
import { scheduleEntries } from './validate.js';

// Holds croner instances per enabled job (one per schedule entry — a job may
// have several, e.g. once@5am + once@10am). Pause-all (settings.paused='1')
// suppresses fires without touching job state. Once-entries drop off as they
// fire; when nothing can ever fire again the job auto-disables.
export function createScheduler({ db, runner }) {
  const crons = new Map(); // jobId -> Cron[]

  const paused = () => getSetting(db, 'paused', '0') === '1';

  function fire(jobId, entryType, cron) {
    if (paused()) return;
    const job = getJob(db, jobId);
    if (entryType === 'once') {
      // A once-entry never re-fires: drop it, and disable the job when no
      // entry (this or others) has a future run left.
      cron.stop();
      const rest = (crons.get(jobId) || []).filter((c) => c !== cron);
      crons.set(jobId, rest);
      if (job && !rest.some((c) => c.nextRun())) {
        updateJob(db, jobId, { enabled: false });
        unschedule(jobId);
      }
    }
    if (!job || !job.enabled) return;
    runner.start(job, entryType === 'once' ? 'once' : 'schedule');
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
      } else {
        const at = new Date(entry.at);
        if (at > new Date()) {
          const c = new Cron(at, { unref: true }, () => fire(job.id, 'once', c));
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

  function nextFire(jobId) {
    const nexts = (crons.get(jobId) || []).map((c) => c.nextRun()).filter(Boolean);
    if (!nexts.length) return null;
    return new Date(Math.min(...nexts.map((d) => d.getTime()))).toISOString();
  }

  function start() {
    for (const job of listJobs(db)) schedule(job);
  }

  function stop() {
    for (const id of [...crons.keys()]) unschedule(id);
  }

  return { start, stop, reload, nextFire };
}
