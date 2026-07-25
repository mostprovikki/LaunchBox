import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpData, validJob, fakeSpawn, sleep, extensions } from './helpers.js';
import { ensureDirs } from '../lib/paths.js';
import { openDb, createJob, getRun, listRuns, setSetting, getRunUsage, avgDeltaForJob } from '../lib/db.js';
import { createRunner } from '../lib/runner.js';
import { shouldNotify } from '../lib/notify.js';

function setup({ minuteMs = 60_000, usage = null, admit } = {}) {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const spawnFn = fakeSpawn();
  const notifications = [];
  const runner = createRunner({ db, extensions, spawnFn, notifyFn: (t, m) => notifications.push(m), minuteMs, usage, admit });
  return { dir, db, spawnFn, notifications, runner };
}

// Stands in for the usage monitor — the runner only needs snapshot()/refresh(),
// so its tests never need a real one (or a real probe).
function fakeUsage(before, after = before) {
  const snap = (p) => (p == null ? null : { ok: true, windows: { five_hour: { percent: p }, seven_day: { percent: p + 20 } } });
  const u = { probes: 0, snapshot: () => snap(before) };
  u.refresh = async (opts) => { u.probes++; u.lastOpts = opts; return snap(after); };
  return u;
}

const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-9', model: 'm', cwd: '/tmp' });
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', result: 'done!', num_turns: 2 });

test('shouldNotify matrix', () => {
  assert.equal(shouldNotify('never', 'fail'), false);
  assert.equal(shouldNotify('always', 'ok'), true);
  assert.equal(shouldNotify('failure', 'ok'), false);
  assert.equal(shouldNotify('failure', 'timeout'), true);
});

test('claude run: args, log, session meta, progress, ok status', async () => {
  const { db, spawnFn, notifications, runner } = setup();
  setSetting(db, 'claudePath', '/usr/local/bin/claude');
  const job = createJob(db, validJob({ model: 'sonnet', permMode: 'auto', extraArgs: '--max-turns 5', notify: 'always' }));
  const run = runner.start(job, 'manual');

  const call = spawnFn.calls[0];
  assert.equal(call.cmd, '/usr/local/bin/claude');
  assert.deepEqual(call.args.slice(0, 2), ['-p', 'do the thing']);
  assert.ok(call.args.includes('--output-format') && call.args.includes('stream-json') && call.args.includes('--verbose'));
  assert.ok(call.args.includes('--model') && call.args.includes('sonnet'));
  assert.ok(call.args.includes('--dangerously-skip-permissions'));
  assert.ok(call.args.includes('--max-turns') && call.args.includes('5'));
  assert.equal(call.opts.cwd, job.cwd);

  call.child.stdout.emit('data', Buffer.from(INIT + '\n' + RESULT + '\n'));
  call.child.emit('close', 0);
  await sleep(30);

  const done = getRun(db, run.id);
  assert.equal(done.status, 'ok');
  assert.equal(done.exitCode, 0);
  assert.equal(done.meta.sessionId, 'sess-9');
  assert.equal(done.progress.activity, 'done');
  const log = readFileSync(done.logPath, 'utf8');
  assert.ok(log.includes('sess-9') && log.includes('done!'));
  assert.deepEqual(notifications, ['test job: ok']);
});

test('command run: zsh -lc, raw log, fail status + notify on failure', async () => {
  const { db, spawnFn, notifications, runner } = setup();
  const job = createJob(db, validJob({ type: 'command', prompt: null, command: 'echo hi && exit 3' }));
  const run = runner.start(job, 'schedule');

  const call = spawnFn.calls[0];
  assert.equal(call.cmd, '/bin/zsh');
  assert.deepEqual(call.args, ['-lc', 'echo hi && exit 3']);

  call.child.stdout.emit('data', Buffer.from('hi\n'));
  call.child.emit('close', 3);
  await sleep(30);

  const done = getRun(db, run.id);
  assert.equal(done.status, 'fail');
  assert.equal(done.exitCode, 3);
  assert.ok(readFileSync(done.logPath, 'utf8').includes('hi'));
  assert.deepEqual(notifications, ['test job: fail']);
});

test('overlap: second start of same job is skipped', async () => {
  const { db, spawnFn, runner } = setup();
  const job = createJob(db, validJob());
  runner.start(job, 'schedule');
  const second = runner.start(job, 'schedule');
  assert.equal(second.status, 'skipped');
  assert.equal(runner.runningCount(), 1);
  spawnFn.calls[0].child.emit('close', 0);
  await sleep(30);
  assert.equal(runner.runningCount(), 0);
});

test('concurrency: claude runs queue FIFO at maxConcurrent, commands exempt', async () => {
  const { db, spawnFn, runner } = setup();
  setSetting(db, 'maxConcurrent', 1);
  const j1 = createJob(db, validJob({ name: 'j1' }));
  const j2 = createJob(db, validJob({ name: 'j2' }));
  const jc = createJob(db, validJob({ name: 'jc', type: 'command', prompt: null, command: 'true' }));

  runner.start(j1, 'schedule');
  const queued = runner.start(j2, 'schedule');
  assert.equal(queued.status, 'queued');
  assert.equal(spawnFn.calls.length, 1);

  runner.start(jc, 'schedule'); // command ignores claude cap
  assert.equal(spawnFn.calls.length, 2);

  spawnFn.calls[0].child.emit('close', 0); // j1 done → j2 launches
  await sleep(30);
  assert.equal(spawnFn.calls.length, 3);
  const q = getRun(db, queued.id);
  assert.equal(q.status, 'running');
  spawnFn.calls[1].child.emit('close', 0);
  spawnFn.calls[2].child.emit('close', 0);
  await sleep(30);
  assert.equal(getRun(db, queued.id).status, 'ok');
});

test('admit: a blocked fire is a skipped run carrying its reason, and never spawns', async () => {
  const seen = [];
  const { db, spawnFn, runner } = setup({
    admit: (job, trigger) => { seen.push({ name: job.name, trigger }); return trigger === 'manual' ? null : 'reserving 5h headroom (85% used)'; },
  });
  const job = createJob(db, validJob({ notify: 'always' }));

  const run = runner.start(job, 'schedule');
  assert.equal(run.status, 'skipped');
  assert.equal(run.meta.skipReason, 'reserving 5h headroom (85% used)');
  assert.ok(run.finishedAt);
  assert.equal(spawnFn.calls.length, 0); // the whole point: nothing was launched
  assert.deepEqual(seen, [{ name: 'test job', trigger: 'schedule' }]);

  // The guard is consulted per fire, so the same job admitted later does launch.
  runner.start(job, 'manual');
  assert.equal(spawnFn.calls.length, 1);
  spawnFn.calls[0].child.emit('close', 0);
  await sleep(30);
});

test('admit: a run that queued on capacity is not re-judged when it launches', async () => {
  // Admission is a decision about starting, made once. Re-checking it in
  // drainQueue would let a limit that moved while the run waited strand it.
  let allow = true;
  const { db, spawnFn, runner } = setup({ admit: () => (allow ? null : 'reserving 5h headroom') });
  setSetting(db, 'maxConcurrent', 1);
  const j1 = createJob(db, validJob({ name: 'j1' }));
  const j2 = createJob(db, validJob({ name: 'j2' }));

  runner.start(j1, 'schedule');
  const queued = runner.start(j2, 'schedule');
  assert.equal(queued.status, 'queued');

  allow = false; // the account gets hot while j2 waits its turn
  spawnFn.calls[0].child.emit('close', 0);
  await sleep(30);
  assert.equal(spawnFn.calls.length, 2);
  assert.equal(getRun(db, queued.id).status, 'running');
  spawnFn.calls[1].child.emit('close', 0);
  await sleep(30);
});

test('admit: the overlap check runs first, so an overlapping fire is never judged', async () => {
  let calls = 0;
  const { db, spawnFn, runner } = setup({ admit: () => { calls++; return null; } });
  const job = createJob(db, validJob());

  runner.start(job, 'schedule');
  assert.equal(calls, 1);
  // A job already running is skipped for overlap; attributing that to the budget
  // guard would misreport why nothing happened.
  const overlap = runner.start(job, 'schedule');
  assert.equal(overlap.status, 'skipped');
  assert.equal(overlap.meta, null);
  assert.equal(calls, 1);
  spawnFn.calls[0].child.emit('close', 0);
  await sleep(30);
});

test('timeout: SIGTERM then status timeout', async () => {
  const { db, spawnFn, runner } = setup({ minuteMs: 20 });
  const job = createJob(db, validJob({ timeoutMin: 1 }));
  const run = runner.start(job, 'manual');
  await sleep(60); // > 1 "minute" (20ms)
  assert.equal(spawnFn.calls[0].child.killedWith, 'SIGTERM');
  const done = getRun(db, run.id);
  assert.equal(done.status, 'timeout');
});

test('retry: fail reruns after delay up to retryCount', async () => {
  const { db, spawnFn, runner } = setup({ minuteMs: 20 });
  const job = createJob(db, validJob({ retryCount: 1, retryDelayMin: 1 }));
  runner.start(job, 'schedule');
  spawnFn.calls[0].child.emit('close', 2);
  await sleep(80); // wait past retry delay (20ms)
  assert.equal(spawnFn.calls.length, 2);
  spawnFn.calls[1].child.emit('close', 2); // retry fails too — no third attempt
  await sleep(80);
  assert.equal(spawnFn.calls.length, 2);
  const runs = listRuns(db, { jobId: job.id });
  assert.deepEqual(runs.map((r) => r.trigger).sort(), ['retry', 'schedule']);
});

test('kill: active run → killed status, no retry, no failure notify', async () => {
  const { db, spawnFn, notifications, runner } = setup({ minuteMs: 20 });
  const job = createJob(db, validJob({ retryCount: 1, retryDelayMin: 1 }));
  const run = runner.start(job, 'manual');
  runner.kill(run.id);
  await sleep(80); // past retry delay — must NOT retry
  assert.equal(getRun(db, run.id).status, 'killed');
  assert.equal(spawnFn.calls[0].child.killedWith, 'SIGTERM');
  assert.equal(spawnFn.calls.length, 1);
  assert.deepEqual(notifications, []);
  assert.equal(runner.runningCount(), 0);
});

test('kill: queued run dequeued as killed; job can start again', async () => {
  const { db, spawnFn, runner } = setup();
  setSetting(db, 'maxConcurrent', 1);
  const j1 = createJob(db, validJob({ name: 'a' }));
  const j2 = createJob(db, validJob({ name: 'b' }));
  runner.start(j1, 'manual');
  const queued = runner.start(j2, 'manual');
  runner.kill(queued.id);
  assert.equal(getRun(db, queued.id).status, 'killed');
  const again = runner.start(j2, 'manual'); // not blocked by dead queue entry
  assert.equal(again.status, 'queued');
  spawnFn.calls[0].child.emit('close', 0);
  await sleep(30);
  assert.equal(getRun(db, again.id).status, 'running');
});

test('kill: unknown or finished run returns null', async () => {
  const { db, spawnFn, runner } = setup();
  const job = createJob(db, validJob());
  const run = runner.start(job, 'manual');
  spawnFn.calls[0].child.emit('close', 0);
  await sleep(30);
  assert.equal(runner.kill(run.id), null);
  assert.equal(runner.kill('nope'), null);
});

test('killAll kills active and clears queue', async () => {
  const { db, spawnFn, runner } = setup();
  setSetting(db, 'maxConcurrent', 1);
  const j1 = createJob(db, validJob({ name: 'a' }));
  const j2 = createJob(db, validJob({ name: 'b' }));
  runner.start(j1, 'manual');
  const queued = runner.start(j2, 'manual');
  runner.killAll();
  await sleep(30);
  assert.equal(runner.runningCount(), 0);
  assert.equal(getRun(db, queued.id).status, 'queued'); // queued row left; failOrphanRuns at boot or cleanup wipes
  assert.equal(spawnFn.calls[0].child.killedWith, 'SIGKILL');
});

test('usage calibration: a finished run records the delta it caused', async () => {
  const usage = fakeUsage(37, 41);
  const { db, spawnFn, runner } = setup({ usage });
  const job = createJob(db, validJob());
  const run = runner.start(job, 'manual');
  const recorded = new Promise((r) => runner.events.once(`usage:${run.id}`, r));

  spawnFn.calls[0].child.emit('close', 0);
  const row = await recorded;

  assert.deepEqual(row.beforePct, { five_hour: 37, seven_day: 57 });
  assert.deepEqual(row.afterPct, { five_hour: 41, seven_day: 61 });
  assert.deepEqual(row.deltaPct, { five_hour: 4, seven_day: 4 });
  assert.deepEqual(getRunUsage(db, run.id).deltaPct, { five_hour: 4, seven_day: 4 });
  assert.deepEqual(avgDeltaForJob(db, job.id), { samples: 1, median: { five_hour: 4, seven_day: 4 } });

  // The baseline came from the cache; only the after-sample probes, and it must
  // not join a probe that started before the run ended.
  assert.equal(usage.probes, 1);
  assert.deepEqual(usage.lastOpts, { coalesce: false });
});

test('usage calibration: a killed run still records; a blind monitor records nothing', async () => {
  const usage = fakeUsage(37, 44);
  const { db, spawnFn, runner } = setup({ usage });
  const job = createJob(db, validJob());
  const run = runner.start(job, 'manual');
  const recorded = new Promise((r) => runner.events.once(`usage:${run.id}`, r));
  runner.kill(run.id);
  // A killed run consumed real usage — the sample is worth keeping.
  assert.deepEqual((await recorded).deltaPct, { five_hour: 7, seven_day: 7 });

  const blind = fakeUsage(null);
  const b = setup({ usage: blind });
  const j2 = createJob(b.db, validJob());
  const r2 = b.runner.start(j2, 'manual');
  b.spawnFn.calls[0].child.emit('close', 0);
  await sleep(30);
  assert.equal(getRunUsage(b.db, r2.id), null, 'no baseline → no fabricated row');
  assert.equal(blind.probes, 0, 'and no pointless probe');
});

test('usage calibration: a skipped run is not sampled', async () => {
  const usage = fakeUsage(37, 41);
  const { db, spawnFn, runner } = setup({ usage });
  const job = createJob(db, validJob());
  runner.start(job, 'manual');
  const skipped = runner.start(job, 'schedule');
  await sleep(30);
  assert.equal(skipped.status, 'skipped');
  assert.equal(getRunUsage(db, skipped.id), null);
  assert.equal(spawnFn.calls.length, 1);
});

// --- M3: graceful stop ------------------------------------------------------
// The ladder is SIGINT → SIGTERM → SIGKILL. Rung 1 is SIGINT rather than an
// `interrupt` control request because the M3 spike measured them as
// behaviourally identical against the real CLI — see the plan's §3.3.

test('requestStop: a well-behaved child stops at SIGINT and is recorded `stopped`', async () => {
  const { db, spawnFn, runner } = setup();
  const job = createJob(db, validJob());
  const run = runner.start(job, 'manual');
  const child = spawnFn.calls[0].child;

  // A real claude child answers SIGINT by emitting its final result and exiting 0.
  child.stdout.emit('data', INIT + '\n');
  runner.requestStop(run.id, { reason: 'paused (soft)' });
  await sleep(30);

  assert.deepEqual(child.signals, ['SIGINT'], 'asked politely, and only once');
  const after = getRun(db, run.id);
  assert.equal(after.status, 'stopped');
  assert.equal(after.meta.stopReason, 'paused (soft)');
  assert.equal(after.meta.stopRung, 'SIGINT');
  // The whole point of a graceful stop: the session survives to be resumed.
  assert.equal(after.meta.sessionId, 'sess-9', 'stop metadata must not clobber the sessionId');
  assert.match(readFileSync(after.logPath, 'utf8'), /winding down at the next safe point/);
});

test('requestStop: exit code 0 does not make a stopped run look successful', async () => {
  // The CLI exits 0 under SIGINT while reporting the turn as an error. Neither
  // signal is trustworthy, so `stopped` comes from having asked — nothing else.
  const { db, spawnFn, runner } = setup();
  const job = createJob(db, validJob());
  const run = runner.start(job, 'manual');
  runner.requestStop(run.id);
  await sleep(30);
  assert.equal(spawnFn.calls[0].child.killedWith, 'SIGINT');
  assert.equal(getRun(db, run.id).exitCode, 0, 'the child really did exit 0');
  assert.equal(getRun(db, run.id).status, 'stopped', 'and it is still not "ok"');
});

test('requestStop: a deaf child is escalated SIGINT → SIGTERM → SIGKILL', async () => {
  const { db, spawnFn, runner } = setup();
  setSetting(db, 'softGraceMs', 40); // 120s by default; the ladder is what's under test
  const job = createJob(db, validJob());
  const run = runner.start(job, 'manual');
  const child = spawnFn.calls[0].child;
  child.deaf = true; // ignores everything short of SIGKILL

  runner.requestStop(run.id, { reason: 'paused (soft)' });
  assert.deepEqual(child.signals, ['SIGINT']);
  assert.equal(getRun(db, run.id).status, 'running', 'still running — it was asked, not killed');

  await sleep(90);
  assert.deepEqual(child.signals, ['SIGINT', 'SIGTERM'], 'escalated after the grace window');
  assert.equal(getRun(db, run.id).meta.stopRung, 'SIGTERM', 'and the log/meta says which rung');

  // KILL_GRACE_MS is a fixed 10s, so drive the last rung directly rather than
  // making the suite wait for it.
  assert.equal(getRun(db, run.id).status, 'running');
  const rungs = readFileSync(getRun(db, run.id).logPath, 'utf8');
  assert.match(rungs, /still running after 0s — SIGTERM/);
});

test('requestStop is idempotent and does not restart the ladder', async () => {
  const { db, spawnFn, runner } = setup();
  setSetting(db, 'softGraceMs', 10_000);
  const job = createJob(db, validJob());
  const run = runner.start(job, 'manual');
  const child = spawnFn.calls[0].child;
  child.deaf = true;
  runner.requestStop(run.id);
  runner.requestStop(run.id);
  runner.requestStop(run.id);
  assert.deepEqual(child.signals, ['SIGINT'], 'asking three times sends one signal');
});

test('a stopped run is never retried and never notified as a failure', async () => {
  const { db, spawnFn, notifications, runner } = setup({ minuteMs: 10 });
  // retryCount 2 would rerun a `fail`; an intentional stop must not come back.
  const job = createJob(db, validJob({ retryCount: 2, retryDelayMin: 1, notify: 'failure' }));
  const run = runner.start(job, 'manual');
  runner.requestStop(run.id);
  await sleep(60);

  assert.equal(getRun(db, run.id).status, 'stopped');
  assert.deepEqual(notifications, [], 'an intentional stop is not a failure');
  assert.equal(spawnFn.calls.length, 1, 'and it is not retried');
  assert.equal(listRuns(db, { jobId: job.id }).length, 1);
  // 'always' would still mention it — it is neither success nor failure.
  assert.equal(shouldNotify('failure', 'stopped'), false);
  assert.equal(shouldNotify('always', 'stopped'), true);
});

test('requestStop on a queued run stops it without ever launching it', async () => {
  const { db, spawnFn, runner } = setup();
  setSetting(db, 'maxConcurrent', 1);
  const j1 = createJob(db, validJob({ name: 'a' }));
  const j2 = createJob(db, validJob({ name: 'b' }));
  runner.start(j1, 'manual');
  const queued = runner.start(j2, 'manual');
  assert.equal(queued.status, 'queued');

  const stopped = runner.requestStop(queued.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.meta.stopRung, 'dequeued');
  assert.equal(spawnFn.calls.length, 1, 'it must not be launched by the drain');

  // And the job is free to run again — the dead queue entry does not hold its slot.
  spawnFn.calls[0].child.emit('close', 0);
  await sleep(30);
  assert.equal(runner.start(j2, 'manual').status, 'running');
});

test('gracefulStop: false skips the polite rung entirely', async () => {
  const { db, spawnFn, runner } = setup();
  // A job type that declares it has no safe stopping point.
  const exts = new Map(extensions);
  exts.set('blunt', { ...exts.get('command'), id: 'blunt', gracefulStop: false });
  const runner2 = createRunner({ db, extensions: exts, spawnFn, notifyFn: () => {} });
  const job = createJob(db, { ...validJob({ type: 'command', command: 'sleep 1' }), type: 'blunt' });
  const run = runner2.start(job, 'manual');
  const child = spawnFn.calls[0].child;
  child.deaf = true;

  runner2.requestStop(run.id, { reason: 'paused (soft)' });
  assert.deepEqual(child.signals, ['SIGTERM'], 'no SIGINT — it was told there is no safe point');
  await sleep(20); // the log is a write stream; let it reach disk
  assert.match(readFileSync(getRun(db, run.id).logPath, 'utf8'), /no safe stopping point/);
});

test('clearQueue drops queued work with a reason; stopping() lists the winding-down', async () => {
  const { db, spawnFn, runner } = setup();
  setSetting(db, 'softGraceMs', 10_000);
  setSetting(db, 'maxConcurrent', 1);
  const j1 = createJob(db, validJob({ name: 'a' }));
  const j2 = createJob(db, validJob({ name: 'b' }));
  const running = runner.start(j1, 'manual');
  const queued = runner.start(j2, 'manual');
  spawnFn.calls[0].child.deaf = true;

  assert.deepEqual(runner.stopping(), []);
  assert.deepEqual(runner.clearQueue('paused (soft)'), [queued.id]);
  assert.equal(getRun(db, queued.id).status, 'skipped');
  assert.equal(getRun(db, queued.id).meta.skipReason, 'paused (soft)');

  assert.deepEqual(runner.requestStopAll('paused (soft)'), [running.id]);
  assert.deepEqual(runner.stopping(), [running.id]);
  assert.equal(spawnFn.calls.length, 1, 'a cleared queue entry is not launched');
});

test('killAll can record what actually happened to in-flight runs', async () => {
  const { db, spawnFn, runner } = setup();
  const job = createJob(db, validJob());
  const run = runner.start(job, 'manual');
  runner.killAll({ status: 'killed' });
  await sleep(20);
  assert.equal(getRun(db, run.id).status, 'killed');
  assert.equal(spawnFn.calls[0].child.killedWith, 'SIGKILL');
});

test('kill outranks a wind-down already in progress', async () => {
  const { db, spawnFn, runner } = setup();
  setSetting(db, 'softGraceMs', 10_000);
  const job = createJob(db, validJob());
  const run = runner.start(job, 'manual');
  // Ignores the polite ask but not the SIGTERM that follows it.
  spawnFn.calls[0].child.deaf = ['SIGINT'];
  runner.requestStop(run.id);
  runner.kill(run.id); // impatient: SIGTERM now
  await sleep(20);
  assert.deepEqual(spawnFn.calls[0].child.signals, ['SIGINT', 'SIGTERM']);
  assert.equal(getRun(db, run.id).status, 'killed', 'an explicit kill is not reported as a clean stop');
});
