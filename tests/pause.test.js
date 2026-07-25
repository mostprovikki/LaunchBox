import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpData, validJob, fakeSpawn, sleep, extensions } from './helpers.js';
import { ensureDirs } from '../lib/paths.js';
import { openDb, createJob, getRun, getSetting, setSetting } from '../lib/db.js';
import { createRunner } from '../lib/runner.js';
import { createScheduler } from '../lib/scheduler.js';
import { createPauseController, PAUSE_MODES } from '../lib/pause.js';

// Wired the way main() wires it: admit reads `pause` late, because the controller
// needs the runner and the runner needs the controller.
function setup({ now = () => Date.now() } = {}) {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const spawnFn = fakeSpawn();
  let pause = null;
  const runner = createRunner({
    db, extensions, spawnFn, notifyFn: () => {},
    admit: (job, trigger, opts) => pause?.gate(job, trigger, opts) ?? null,
  });
  pause = createPauseController({ db, runner, now });
  return { db, spawnFn, runner, pause };
}

test('modes are ordered least-to-most forceful', () => {
  assert.deepEqual(PAUSE_MODES, ['off', 'hold', 'soft', 'hard']);
});

test('migration: a v1 db with paused=1 reads as hold, not something stronger', () => {
  const { db, pause } = setup();
  // v1 wrote only this key. Promoting it to soft/hard on upgrade would silently
  // start stopping work that used to be left alone.
  setSetting(db, 'paused', '1');
  assert.equal(pause.mode(), 'hold');
  assert.equal(pause.status().blocking.schedule, true);
  assert.equal(pause.status().blocking.manual, false, 'hold never blocked manual runs');

  setSetting(db, 'paused', '0');
  assert.equal(pause.mode(), 'off');
});

test('the `paused` alias stays true for every non-off mode', () => {
  const { db, pause } = setup();
  for (const mode of ['hold', 'soft', 'hard']) {
    pause.set({ mode });
    assert.equal(getSetting(db, 'paused', '0'), '1', `${mode} must read as paused`);
    assert.equal(pause.mode(), mode);
  }
  pause.set({ mode: 'off' });
  assert.equal(getSetting(db, 'paused', '0'), '0');
});

test('set rejects an unknown mode', () => {
  const { pause } = setup();
  assert.throws(() => pause.set({ mode: 'nope' }), /mode must be one of/);
  assert.throws(() => pause.set({ mode: 'soft', minutes: 0 }), /minutes must be/);
  assert.throws(() => pause.set({ mode: 'off', minutes: 30 }), /needs a mode other than off/);
});

// --- what each mode blocks --------------------------------------------------

test('hold blocks scheduled fires but not manual runs — exactly the v1 behaviour', async () => {
  const { db, spawnFn, runner, pause } = setup();
  const job = createJob(db, validJob());
  pause.set({ mode: 'hold' });

  // The scheduler drops its own fires; the runner must not also refuse them,
  // and above all must not refuse the manual click that still worked in v1.
  const manual = runner.start(job, 'manual');
  assert.equal(manual.status, 'running', 'hold has never blocked a manual run');
  assert.equal(spawnFn.calls.length, 1);
  spawnFn.calls[0].child.emit('close', 0);
  await sleep(20);

  // A retry armed before the pause also went through in v1.
  assert.equal(runner.start(job, 'retry').status, 'running');
});

test('soft and hard block manual runs; off restores everything', async () => {
  const { db, runner, pause } = setup();
  const job = createJob(db, validJob());

  for (const mode of ['soft', 'hard']) {
    pause.set({ mode });
    const run = runner.start(job, 'manual');
    assert.equal(run.status, 'skipped', `${mode} must refuse a manual run`);
    assert.equal(run.meta.skipReason, `paused (${mode})`);
  }

  pause.set({ mode: 'off' });
  assert.equal(runner.start(job, 'manual').status, 'running');
});

test('a confirmed override runs despite a soft pause', () => {
  const { db, runner, pause } = setup();
  const job = createJob(db, validJob());
  pause.set({ mode: 'soft' });
  assert.equal(runner.start(job, 'manual', 0, { force: true }).status, 'running');
});

test('the pause reason outranks a budget reason', () => {
  // Composed the way main() composes them: whichever guard speaks first wins, and
  // "paused" is the more useful thing to tell someone than a headroom figure.
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const spawnFn = fakeSpawn();
  let pause = null;
  const budgetAdmit = () => 'reserving 5h headroom (99% used)';
  const runner = createRunner({
    db, extensions, spawnFn, notifyFn: () => {},
    admit: (job, trigger, opts) => pause?.gate(job, trigger, opts) ?? budgetAdmit(),
  });
  pause = createPauseController({ db, runner });
  const job = createJob(db, validJob());

  pause.set({ mode: 'hard' });
  assert.equal(runner.start(job, 'schedule').meta.skipReason, 'paused (hard)');
  pause.set({ mode: 'off' });
  assert.match(runner.start(job, 'schedule').meta.skipReason, /reserving 5h headroom/);
});

// --- effect on work already in flight ---------------------------------------

test('entering soft drains: queue cleared, running work asked to wind down', async () => {
  const { db, spawnFn, runner, pause } = setup();
  setSetting(db, 'softGraceMs', 10_000); // don't escalate during the test
  setSetting(db, 'maxConcurrent', 1);
  const j1 = createJob(db, validJob({ name: 'a' }));
  const j2 = createJob(db, validJob({ name: 'b' }));
  const running = runner.start(j1, 'manual');
  const queued = runner.start(j2, 'manual');
  spawnFn.calls[0].child.deaf = ['SIGINT']; // takes its time winding down

  const out = pause.set({ mode: 'soft' });
  assert.deepEqual(out.stopped, [running.id]);
  assert.deepEqual(out.clearedQueue, [queued.id]);
  assert.equal(out.mode, 'soft');
  assert.deepEqual(out.stopping, [running.id]);

  // Asked, not killed.
  assert.deepEqual(spawnFn.calls[0].child.signals, ['SIGINT']);
  assert.equal(getRun(db, running.id).status, 'running');
  // A queued run left `queued` after a pause would be a lie — it is never coming back.
  assert.equal(getRun(db, queued.id).status, 'skipped');
  assert.equal(getRun(db, queued.id).meta.skipReason, 'paused (soft)');
  assert.equal(spawnFn.calls.length, 1, 'the drained queue entry must not launch');
});

test('lifting a soft pause does not resurrect the dropped queue', async () => {
  const { db, spawnFn, runner, pause } = setup();
  setSetting(db, 'maxConcurrent', 1);
  const j1 = createJob(db, validJob({ name: 'a' }));
  const j2 = createJob(db, validJob({ name: 'b' }));
  runner.start(j1, 'manual');
  const queued = runner.start(j2, 'manual');

  pause.set({ mode: 'soft' });
  await sleep(20);
  pause.set({ mode: 'off' });
  await sleep(20);

  assert.equal(getRun(db, queued.id).status, 'skipped', 'still skipped — the next fire is the recovery path');
  assert.equal(runner.runningCount(), 0);
});

test('entering hard kills in-flight work immediately and records it as killed', async () => {
  const { db, spawnFn, runner, pause } = setup();
  const job = createJob(db, validJob());
  const run = runner.start(job, 'manual');

  pause.set({ mode: 'hard' });
  await sleep(20);

  assert.equal(spawnFn.calls[0].child.killedWith, 'SIGKILL', 'hard means now, not politely');
  assert.equal(getRun(db, run.id).status, 'killed');
  assert.equal(runner.runningCount(), 0);
});

test('hold leaves in-flight work completely alone', async () => {
  const { db, spawnFn, runner, pause } = setup();
  const job = createJob(db, validJob());
  const run = runner.start(job, 'manual');

  pause.set({ mode: 'hold' });
  assert.deepEqual(spawnFn.calls[0].child.signals, [], 'not signalled at all');
  assert.equal(getRun(db, run.id).status, 'running');

  spawnFn.calls[0].child.emit('close', 0);
  await sleep(20);
  assert.equal(getRun(db, run.id).status, 'ok', 'and it finished normally');
});

// --- timed pause ------------------------------------------------------------

test('a timed pause expires back to off, even if the timer never fired', () => {
  let clock = Date.parse('2026-07-25T12:00:00Z');
  const { db, pause } = setup({ now: () => clock });

  pause.set({ mode: 'hold', minutes: 30 });
  assert.equal(pause.mode(), 'hold');
  assert.equal(pause.status().until, '2026-07-25T12:30:00.000Z');

  clock += 29 * 60_000;
  assert.equal(pause.mode(), 'hold', 'still inside the window');

  // Past the deadline. The Mac may have been asleep, so this must not depend on
  // the expiry timer having run.
  clock += 2 * 60_000;
  assert.equal(pause.mode(), 'off');
  assert.equal(pause.status().until, null);

  // refresh() is what writes the lapse back to the db.
  pause.refresh();
  assert.equal(getSetting(db, 'pauseMode', null), 'off');
  assert.equal(getSetting(db, 'paused', '0'), '0');
});

test('an untimed pause never expires', () => {
  let clock = Date.parse('2026-07-25T12:00:00Z');
  const { pause } = setup({ now: () => clock });
  pause.set({ mode: 'soft' });
  clock += 30 * 24 * 3600e3;
  assert.equal(pause.mode(), 'soft');
  assert.equal(pause.status().until, null);
});

// --- the scheduler's view ---------------------------------------------------

test('every pause mode drops a scheduled fire identically', async () => {
  const { db, runner, pause } = setup();
  const starts = [];
  const fakeRunner = { ...runner, start: (job, trigger) => starts.push(trigger) };
  const scheduler = createScheduler({ db, runner: fakeRunner, pause });
  createJob(db, validJob({ schedule: { type: 'cron', expr: '* * * * * *' } }));
  scheduler.start();

  for (const mode of ['hold', 'soft', 'hard']) {
    pause.set({ mode });
    starts.length = 0;
    await sleep(1100);
    assert.deepEqual(starts, [], `${mode} must suppress the fire`);
  }

  pause.set({ mode: 'off' });
  await sleep(1100);
  assert.ok(starts.length >= 1, 'and unpausing lets it fire again');
  scheduler.stop();
});
