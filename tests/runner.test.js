import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpData, validJob, fakeSpawn, sleep, extensions } from './helpers.js';
import { ensureDirs } from '../lib/paths.js';
import { openDb, createJob, getRun, listRuns, setSetting } from '../lib/db.js';
import { createRunner } from '../lib/runner.js';
import { shouldNotify } from '../lib/notify.js';

function setup({ minuteMs = 60_000 } = {}) {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const spawnFn = fakeSpawn();
  const notifications = [];
  const runner = createRunner({ db, extensions, spawnFn, notifyFn: (t, m) => notifications.push(m), minuteMs });
  return { dir, db, spawnFn, notifications, runner };
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
