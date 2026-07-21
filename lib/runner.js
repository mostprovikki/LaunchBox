import { spawn } from 'node:child_process';
import { createWriteStream, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { logsDir } from './paths.js';
import { getJob, insertRun, updateRun, getRun, pruneRuns, getSetting } from './db.js';
import { notify as osNotify, shouldNotify } from './notify.js';

const RETAIN = 50;
const KILL_GRACE_MS = 10_000;

// Orchestrates run lifecycle: overlap skip, per-extension concurrency queue,
// spawn, log streaming, timeout, retry, prune. Knows nothing about job types —
// the job's extension supplies the spawn spec (ext.command) and an optional
// stdout parser (ext.createOutputHandler). `minuteMs` scales minute-based
// fields (timeoutMin/retryDelayMin) so tests run fast.
export function createRunner({ db, extensions, spawnFn = spawn, notifyFn = osNotify, minuteMs = 60_000 }) {
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const active = new Map(); // runId -> {child, job, timers[]}
  const activeByJob = new Map(); // jobId -> runId (running or queued)
  const queue = []; // [{job, trigger, attempt, runId}]

  const extOf = (job) => extensions.get(job.type);
  const setting = (k, d) => getSetting(db, k, d);
  const changed = () => events.emit('change');

  // Extensions with a `concurrency` block cap simultaneous runs of their type
  // via a setting; others run unlimited.
  function atCapacity(job) {
    const c = extOf(job)?.concurrency;
    if (!c) return false;
    const max = Math.max(1, Number(setting(c.settingKey, c.default ?? 2)) || c.default || 2);
    return [...active.values()].filter((a) => a.job.type === job.type).length >= max;
  }

  function start(job, trigger, attempt = 0) {
    if (activeByJob.has(job.id)) {
      const run = insertRun(db, { jobId: job.id, status: 'skipped', trigger });
      updateRun(db, run.id, { finishedAt: new Date().toISOString() });
      changed();
      return getRun(db, run.id);
    }
    if (atCapacity(job)) {
      const run = insertRun(db, { jobId: job.id, status: 'queued', trigger });
      activeByJob.set(job.id, run.id);
      queue.push({ job, trigger, attempt, runId: run.id });
      changed();
      return run;
    }
    return launch(job, trigger, attempt);
  }

  function launch(job, trigger, attempt, existingRunId = null) {
    const startedAt = new Date().toISOString();
    const run = existingRunId
      ? updateRun(db, existingRunId, { status: 'running', startedAt })
      : insertRun(db, { jobId: job.id, status: 'running', trigger });
    if (!existingRunId) updateRun(db, run.id, { startedAt });
    activeByJob.set(job.id, run.id);

    const logPath = join(logsDir(), `${run.id}.log`);
    updateRun(db, run.id, { logPath });
    const stream = createWriteStream(logPath, { flags: 'a' });
    const t0 = Date.now();

    const writeLine = (text) => {
      stream.write(text + '\n');
      events.emit(`line:${run.id}`, text);
    };

    const ext = extOf(job);
    const meta = {};
    const handler = ext.createOutputHandler?.({
      onLine: writeLine,
      onProgress: (p) => {
        updateRun(db, run.id, { progress: JSON.stringify(p) });
        events.emit(`progress:${run.id}`, p);
      },
      onMeta: (patch) => {
        Object.assign(meta, patch);
        updateRun(db, run.id, { meta: JSON.stringify(meta) });
      },
    }) ?? null;

    let child;
    const entry = { job, timers: [] };
    try {
      const spec = ext.command(job, { setting });
      child = spawnFn(spec.cmd, spec.args ?? [], {
        cwd: job.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(spec.env ? { env: { ...process.env, ...spec.env } } : {}),
      });
    } catch (err) {
      writeLine(`spawn error: ${err.message}`);
      stream.end();
      return finish(run.id, job, trigger, attempt, 'fail', -1);
    }
    entry.child = child;
    active.set(run.id, entry);
    changed();

    let timedOut = false;
    const tKill = setTimeout(() => {
      timedOut = true;
      writeLine(`⏱ timeout after ${job.timeoutMin}min — SIGTERM`);
      try { child.kill('SIGTERM'); } catch {}
      const t2 = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, KILL_GRACE_MS);
      t2.unref?.();
      entry.timers.push(t2);
    }, job.timeoutMin * minuteMs);
    tKill.unref?.();
    entry.timers.push(tKill);

    const raw = (d) => String(d).split('\n').filter((l, i, a) => l !== '' || i < a.length - 1).forEach((l) => writeLine(l));
    if (handler) {
      child.stdout.on('data', (d) => handler.write(d));
      child.stderr.on('data', (d) => String(d).split('\n').filter((l) => l.trim()).forEach(writeLine));
    } else {
      child.stdout.on('data', raw);
      child.stderr.on('data', raw);
    }

    child.on('error', (err) => {
      writeLine(`spawn error: ${err.message}`);
      settle('fail', -1);
    });
    child.on('close', (code) => {
      handler?.flush();
      settle(entry.killed ? 'killed' : timedOut ? 'timeout' : code === 0 ? 'ok' : 'fail', code);
    });

    let settled = false;
    function settle(status, code) {
      if (settled) return;
      settled = true;
      for (const t of entry.timers) clearTimeout(t);
      stream.end();
      finish(run.id, job, trigger, attempt, status, code, Date.now() - t0);
    }
    return getRun(db, run.id);
  }

  function finish(runId, job, trigger, attempt, status, exitCode, durationMs = 0) {
    updateRun(db, runId, { status, exitCode, finishedAt: new Date().toISOString(), durationMs });
    active.delete(runId);
    if (activeByJob.get(job.id) === runId) activeByJob.delete(job.id);

    if (shouldNotify(job.notify, status)) notifyFn('Claude Scheduler', `${job.name}: ${status}`);

    for (const p of pruneRuns(db, job.id, RETAIN)) {
      try { unlinkSync(p); } catch {}
    }

    if ((status === 'fail' || status === 'timeout') && attempt < job.retryCount) {
      const t = setTimeout(() => {
        const j = getJob(db, job.id);
        if (j && j.enabled) start(j, 'retry', attempt + 1);
      }, job.retryDelayMin * minuteMs);
      t.unref?.();
    }

    events.emit(`done:${runId}`, status);
    changed();
    drainQueue();
    return getRun(db, runId);
  }

  function drainQueue() {
    for (let i = 0; i < queue.length;) {
      const next = queue[i];
      const j = getJob(db, next.job.id);
      if (!j) { queue.splice(i, 1); continue; }
      if (atCapacity(j)) { i++; continue; }
      queue.splice(i, 1);
      launch(j, next.trigger, next.attempt, next.runId);
    }
  }

  function runningCount() {
    return active.size;
  }

  // Kill one run: dequeue if queued, SIGTERM→SIGKILL if running. Status 'killed'
  // (never retried, not a failure notification). Returns run or null if not live.
  function kill(runId) {
    const qi = queue.findIndex((q) => q.runId === runId);
    if (qi !== -1) {
      const { job } = queue.splice(qi, 1)[0];
      updateRun(db, runId, { status: 'killed', finishedAt: new Date().toISOString() });
      if (activeByJob.get(job.id) === runId) activeByJob.delete(job.id);
      events.emit(`done:${runId}`, 'killed');
      changed();
      return getRun(db, runId);
    }
    const entry = active.get(runId);
    if (!entry) return null;
    entry.killed = true;
    try { entry.child.kill('SIGTERM'); } catch {}
    const t = setTimeout(() => { try { entry.child.kill('SIGKILL'); } catch {} }, KILL_GRACE_MS);
    t.unref?.();
    entry.timers.push(t);
    return getRun(db, runId);
  }

  function killAll() {
    queue.length = 0;
    for (const [runId, entry] of [...active.entries()]) {
      for (const t of entry.timers) clearTimeout(t);
      try { entry.child.kill('SIGKILL'); } catch {}
      updateRun(db, runId, { status: 'fail', finishedAt: new Date().toISOString() });
      active.delete(runId);
    }
    activeByJob.clear();
    changed();
  }

  return { start, events, runningCount, kill, killAll };
}
