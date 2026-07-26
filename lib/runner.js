import { spawn } from 'node:child_process';
import { createWriteStream, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { logsDir } from './paths.js';
import { getJob, insertRun, updateRun, getRun, pruneRuns, getSetting, recordRunUsage } from './db.js';
import { notify as osNotify, shouldNotify } from './notify.js';
import { usagePercents } from './usage.js';
import { liveSubagentCount } from './sessions.js';

const RETAIN = 50;
const KILL_GRACE_MS = 10_000;
// How long a run gets to wind down on its own after being asked to, before the
// ladder escalates. Generous by default: the point of asking is to let the work
// reach a safe stopping point, and a claude turn can legitimately take minutes.
export const DEFAULT_SOFT_GRACE_MS = 120_000;

// How long a wind-down waits for a run's subagents to finish before signalling
// regardless. Bounded so a wedged subagent cannot make a stop unstoppable.
export const DEFAULT_SUBAGENT_HOLD_MS = 300_000;
// Cheap enough to be responsive, slow enough not to stat the tree in a spin.
const FANOUT_POLL_MS = 2_000;

// Orchestrates run lifecycle: overlap skip, per-extension concurrency queue,
// spawn, log streaming, timeout, retry, prune. Knows nothing about job types —
// the job's extension supplies the spawn spec (ext.command) and an optional
// stdout parser (ext.createOutputHandler). `minuteMs` scales minute-based
// fields (timeoutMin/retryDelayMin) so tests run fast. `usage` is optional —
// when a monitor is passed, each run is sampled either side for calibration;
// without one, runs behave exactly as before. `admit` is the budget guard's and
// pause controller's hook: return a string to refuse the fire (recorded as
// `skipped`), null to allow.
export function createRunner({
  db, extensions, spawnFn = spawn, notifyFn = osNotify, minuteMs = 60_000,
  usage = null, admit = () => null, fanoutFn = liveSubagentCount,
}) {
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const active = new Map(); // runId -> {child, job, timers[]}
  const activeByJob = new Map(); // jobId -> runId (running or queued)
  const queue = []; // [{job, trigger, attempt, runId}]

  const extOf = (job) => extensions.get(job.type);
  const setting = (k, d) => getSetting(db, k, d);
  const changed = () => events.emit('change');

  const softGraceMs = () => {
    const n = Number(setting('softGraceMs', DEFAULT_SOFT_GRACE_MS));
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SOFT_GRACE_MS;
  };

  const subagentHoldMs = () => {
    const n = Number(setting('subagentHoldMs', DEFAULT_SUBAGENT_HOLD_MS));
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SUBAGENT_HOLD_MS;
  };

  // How many subagents this run has in flight. A run with no sessionId — every
  // `command` job, and a claude run that has not reached its init event — cannot
  // have fan-out, so it answers 0 and stops exactly as it always did.
  //
  // Fails to ZERO, deliberately: if the probe throws, the wind-down proceeds
  // abruptly rather than holding. An abrupt stop is the bug being fixed here, but
  // a stop that never happens because a filesystem read failed is worse.
  const fanoutOf = (runId) => {
    try {
      const sid = getRun(db, runId)?.meta?.sessionId;
      if (!sid) return 0;
      const n = Number(fanoutFn(sid));
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  };

  // Extensions with a `concurrency` block cap simultaneous runs of their type
  // via a setting; others run unlimited.
  function atCapacity(job) {
    const c = extOf(job)?.concurrency;
    if (!c) return false;
    const max = Math.max(1, Number(setting(c.settingKey, c.default ?? 2)) || c.default || 2);
    return [...active.values()].filter((a) => a.job.type === job.type).length >= max;
  }

  // `opts.force` is a confirmed override of a soft pause; it reaches the guards
  // through `admit` rather than short-circuiting them, so the decision stays in
  // one place.
  function start(job, trigger, attempt = 0, opts = {}) {
    if (activeByJob.has(job.id)) {
      const run = insertRun(db, { jobId: job.id, status: 'skipped', trigger });
      updateRun(db, run.id, { finishedAt: new Date().toISOString() });
      changed();
      return getRun(db, run.id);
    }
    // Admission is judged once, here — never again in drainQueue(). A run that
    // passed the guard and then queued on capacity should launch when capacity
    // frees, not be re-judged against a limit that has since moved.
    const blocked = admit(job, trigger, opts);
    if (blocked) {
      const run = insertRun(db, { jobId: job.id, status: 'skipped', trigger });
      updateRun(db, run.id, {
        finishedAt: new Date().toISOString(),
        meta: JSON.stringify({ skipReason: blocked }),
      });
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
    // Shared with requestStop(): a graceful stop records why and how it stopped,
    // and must not clobber what the handler has already put in meta — the
    // sessionId is exactly what makes a stopped claude run resumable.
    const patchMeta = (patch) => {
      Object.assign(meta, patch);
      updateRun(db, run.id, { meta: JSON.stringify(meta) });
    };
    const handler = ext.createOutputHandler?.({
      onLine: writeLine,
      onProgress: (p) => {
        updateRun(db, run.id, { progress: JSON.stringify(p) });
        events.emit(`progress:${run.id}`, p);
      },
      onMeta: patchMeta,
    }) ?? null;

    let child;
    const entry = { job, timers: [], writeLine, patchMeta, handler };
    // Calibration baseline: read from the cached snapshot, never by probing —
    // starting a run must not wait on the network.
    entry.beforePct = usage ? usagePercents(usage.snapshot()) : null;
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
      // A graceful stop cannot be read off the exit code. The spike measured the
      // claude CLI reporting an interrupted turn as `error_during_execution` /
      // `is_error: true` — exit 0 under SIGINT, 1 over the control channel — none
      // of which is distinguishable from a real mid-run error. So `stopped`, like
      // `killed` and `timeout` before it, is known only because we asked for it.
      settle(
        entry.killed ? 'killed'
          : timedOut ? 'timeout'
            : entry.stopRequested ? 'stopped'
              : code === 0 ? 'ok' : 'fail',
        code,
      );
    });

    let settled = false;
    function settle(status, code) {
      if (settled) return;
      settled = true;
      for (const t of entry.timers) clearTimeout(t);
      // NB: `stream.end()` only *starts* the flush, so for a few milliseconds after
      // a run is recorded as finished its log file can still be short of the last
      // lines. That is deliberate — recording the terminal status behind the flush
      // was tried and delays every `killed`/`stopped` becoming visible in the UI,
      // which is a worse trade than a transient short read of a file the log view
      // re-reads anyway. Anything asserting on log *contents* right after a run
      // finishes has to wait for the flush rather than assume it.
      stream.end();
      finish(run.id, job, trigger, attempt, status, code, Date.now() - t0);
    }
    return getRun(db, run.id);
  }

  function finish(runId, job, trigger, attempt, status, exitCode, durationMs = 0) {
    updateRun(db, runId, { status, exitCode, finishedAt: new Date().toISOString(), durationMs });
    const beforePct = active.get(runId)?.beforePct;
    active.delete(runId);
    if (activeByJob.get(job.id) === runId) activeByJob.delete(job.id);

    if (shouldNotify(job.notify, status)) notifyFn('Claude Scheduler', `${job.name}: ${status}`);
    if (beforePct && Object.keys(beforePct).length) sampleUsage(runId, job.id, beforePct);

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

  // What did this run cost? The API reports percent and never tokens, so the
  // only way to know is to sample either side of the run. Off the critical path
  // and best-effort: the run is already finished and recorded, so a probe that
  // fails loses one noisy data point and nothing else. Deltas are polluted by
  // concurrent runs, interactive use and other devices — M4 aggregates them
  // with a median and never trusts a single sample.
  function sampleUsage(runId, jobId, beforePct) {
    usage.refresh({ coalesce: false })
      .then((after) => {
        const row = recordRunUsage(db, { runId, jobId, beforePct, afterPct: usagePercents(after) });
        events.emit(`usage:${runId}`, row);
      })
      .catch(() => {});
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

  // Ask a run to wind down at its next safe point rather than killing it. Status
  // 'stopped' — an intentional, clean stop: never retried, never notified as a
  // failure, and for claude jobs the session stays resumable.
  //
  // The ladder, and why it starts where it does: the M3 spike measured SIGINT
  // against the real CLI and found it behaviourally identical to the `interrupt`
  // control request — the in-flight tool call is denied *before it runs*, a final
  // result event is emitted, and the session resumes with accurate history. So
  // the piped-stdin control channel buys nothing here and rung 1 is SIGINT.
  // Escalation only happens if the child ignores it, and every rung is logged so
  // the outcome is auditable instead of mysterious.
  function requestStop(runId, { reason = 'stop requested' } = {}) {
    const qi = queue.findIndex((q) => q.runId === runId);
    if (qi !== -1) {
      // Never launched, so there is nothing to wind down: not starting it *is*
      // the clean stop.
      const { job } = queue.splice(qi, 1)[0];
      updateRun(db, runId, {
        status: 'stopped',
        finishedAt: new Date().toISOString(),
        meta: JSON.stringify({ stopReason: reason, stopRung: 'dequeued' }),
      });
      if (activeByJob.get(job.id) === runId) activeByJob.delete(job.id);
      events.emit(`done:${runId}`, 'stopped');
      changed();
      drainQueue();
      return getRun(db, runId);
    }

    const entry = active.get(runId);
    if (!entry) return null;
    if (entry.stopRequested) return getRun(db, runId); // idempotent — no double ladder

    entry.stopRequested = reason;
    // Let the output handler know, so an intentional stop doesn't get rendered as
    // the error the CLI reports it as.
    entry.handler?.stopping?.();

    const rung = (sig, note) => {
      entry.patchMeta({ stopReason: reason, stopRung: sig });
      entry.writeLine(note);
      try { entry.child.kill(sig); } catch {}
    };

    // An extension may declare `gracefulStop: false` when its work has no safe
    // stopping point — asking politely would just delay the inevitable.
    if (extOf(entry.job)?.gracefulStop === false) {
      rung('SIGTERM', `⏹ ${reason} — SIGTERM (this job type has no safe stopping point)`);
      const t = setTimeout(() => rung('SIGKILL', '⏹ still running — SIGKILL'), KILL_GRACE_MS);
      t.unref?.();
      entry.timers.push(t);
    } else {
      // The soft-grace ladder is armed by the SIGINT, not by the request, so a
      // hold does not eat the grace window the child was promised.
      const armLadder = () => {
        const grace = softGraceMs();
        rung('SIGINT', `⏹ ${reason} — winding down at the next safe point (SIGINT)`);
        const t1 = setTimeout(() => {
          rung('SIGTERM', `⏹ still running after ${Math.round(grace / 1000)}s — SIGTERM`);
          const t2 = setTimeout(() => rung('SIGKILL', '⏹ still running — SIGKILL'), KILL_GRACE_MS);
          t2.unref?.();
          entry.timers.push(t2);
        }, grace);
        t1.unref?.();
        entry.timers.push(t1);
      };

      // Why a run with subagents is held rather than signalled. Measured against
      // the real CLI 2026-07-26: one SIGINT with two subagents mid-generation
      // exits in 985ms with `result: error_during_execution`, and freezes both
      // subagent transcripts ~9KB short of where an uninterrupted run took them.
      // A subagent's work is not a tool call the parent can decline on its way
      // out — it is work already in progress, and it is discarded. So for fan-out
      // there is no "next safe point" to stop at; waiting for it to finish IS the
      // safe point, which is what the ⤓ button promises.
      const live = fanoutOf(runId);
      if (live === 0) {
        armLadder();
      } else {
        const cap = subagentHoldMs();
        const startedAt = Date.now();
        const plural = (n) => `${n} subagent${n === 1 ? '' : 's'}`;
        entry.patchMeta({ stopReason: reason, stopRung: 'holding', heldForSubagents: live });
        entry.writeLine(
          `⏹ ${reason} — ${plural(live)} mid-flight, holding the signal until they settle `
          + `(max ${Math.round(cap / 1000)}s)`,
        );
        const poll = () => {
          // A hard kill overtook the hold: it already sent SIGTERM, and adding a
          // SIGINT behind it would only muddy the recorded rung.
          if (entry.killed) return;
          const n = fanoutOf(runId);
          const heldS = Math.round((Date.now() - startedAt) / 1000);
          if (n === 0) {
            entry.writeLine(`⏹ fan-out settled after ${heldS}s`);
            armLadder();
          } else if (Date.now() - startedAt >= cap) {
            entry.writeLine(
              `⏹ ${plural(n)} still mid-flight after ${heldS}s — signalling anyway; `
              + 'their work will be discarded',
            );
            armLadder();
          } else {
            const t = setTimeout(poll, FANOUT_POLL_MS);
            t.unref?.();
            entry.timers.push(t);
          }
        };
        // Pushed onto entry.timers like every other rung, which is what makes a
        // child that exits during the hold cancel it: settle() clears them all.
        const t0 = setTimeout(poll, FANOUT_POLL_MS);
        t0.unref?.();
        entry.timers.push(t0);
      }
    }
    changed();
    return getRun(db, runId);
  }

  // Wind down everything in flight. Returns the runIds actually asked to stop.
  function requestStopAll(reason) {
    const ids = [...active.keys()];
    return ids.filter((id) => requestStop(id, { reason }));
  }

  // runIds currently walking the ladder — what the pause banner counts.
  function stopping() {
    return [...active.entries()].filter(([, e]) => e.stopRequested).map(([id]) => id);
  }

  // Drop everything queued, recording why. Queued runs are memory-only and die at
  // boot anyway, so leaving them `queued` after a pause would be a lie. Lifting
  // the pause does not resurrect them — the next scheduled fire is the recovery.
  function clearQueue(reason) {
    const dropped = queue.splice(0, queue.length);
    for (const { job, runId } of dropped) {
      updateRun(db, runId, {
        status: 'skipped',
        finishedAt: new Date().toISOString(),
        meta: JSON.stringify({ skipReason: reason }),
      });
      if (activeByJob.get(job.id) === runId) activeByJob.delete(job.id);
      events.emit(`done:${runId}`, 'skipped');
    }
    if (dropped.length) changed();
    return dropped.map((d) => d.runId);
  }

  // `status` is what in-flight runs are recorded as. Cleanup/uninstall keep the
  // original 'fail'; a hard pause passes 'killed', which is what actually happened.
  function killAll({ status = 'fail' } = {}) {
    queue.length = 0;
    for (const [runId, entry] of [...active.entries()]) {
      for (const t of entry.timers) clearTimeout(t);
      // Set before the signal: with a real child `close` arrives asynchronously,
      // and settle() would otherwise re-decide the status from an exit code that
      // only reflects this kill.
      entry.killed = true;
      try { entry.child.kill('SIGKILL'); } catch {}
      updateRun(db, runId, { status, finishedAt: new Date().toISOString() });
      active.delete(runId);
      events.emit(`done:${runId}`, status);
    }
    activeByJob.clear();
    changed();
  }

  return {
    start, events, runningCount, kill, killAll,
    requestStop, requestStopAll, stopping, clearQueue,
  };
}
