import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { tmpData, validJob, fakeSpawn } from './helpers.js';
import { openDb, createJob, setSetting, updateJob } from '../lib/db.js';
import { createAwake } from '../lib/awake.js';

function setup({ nextFire = null, running = 0, usage = null } = {}) {
  const dir = tmpData();
  const db = openDb(join(dir, 'test.db'));
  const spawnFn = fakeSpawn();
  const state = { running, nextFire };
  const runner = { runningCount: () => state.running, events: new EventEmitter() };
  const scheduler = { nextFire: () => state.nextFire };
  let t = Date.now();
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const awake = createAwake({ db, runner, scheduler, usage, spawnFn, now: clock.now });
  return { db, spawnFn, runner, state, awake, clock };
}

// Only window() and events are read by awake, so no probe is involved.
function fakeUsage(resetsAt) {
  const u = { resetsAt, events: new EventEmitter() };
  u.window = () => ({ percent: 10, resetsAt: u.resetsAt });
  return u;
}

test('off by default; on spawns caffeinate tied to daemon pid; off kills it', () => {
  const { spawnFn, awake } = setup();
  assert.deepEqual(awake.refresh(), { mode: 'off', until: null, active: false });
  assert.equal(spawnFn.calls.length, 0);

  const st = awake.set({ mode: 'on' });
  assert.deepEqual(st, { mode: 'on', until: null, active: true });
  assert.equal(spawnFn.calls[0].cmd, 'caffeinate');
  assert.deepEqual(spawnFn.calls[0].args, ['-i', '-w', String(process.pid)]);
  assert.equal(spawnFn.calls[0].opts.stdio, 'ignore');

  awake.set({ mode: 'off' });
  assert.equal(spawnFn.calls[0].child.killedWith, 'SIGTERM');
  assert.equal(awake.status().active, false);
  assert.equal(spawnFn.calls.length, 1); // no respawn
});

test('timed: active until deadline, then flips to off and releases', () => {
  const { spawnFn, awake, clock } = setup();
  const st = awake.set({ mode: 'timed', minutes: 30 });
  assert.equal(st.active, true);
  assert.equal(new Date(st.until).getTime(), clock.now() + 30 * 60_000);

  clock.advance(31 * 60_000);
  const after = awake.refresh();
  assert.deepEqual(after, { mode: 'off', until: null, active: false });
  assert.equal(spawnFn.calls[0].child.killedWith, 'SIGTERM');
});

test('timed persists across restart (awakeUntil in settings)', () => {
  const { db, awake } = setup();
  awake.set({ mode: 'timed', minutes: 30 });
  awake.stop();
  // simulate new daemon against same db
  const spawn2 = fakeSpawn();
  const awake2 = createAwake({ db, runner: { runningCount: () => 0, events: new EventEmitter() }, scheduler: { nextFire: () => null }, spawnFn: spawn2 });
  assert.equal(awake2.refresh().active, true);
  assert.equal(spawn2.calls.length, 1);
});

test('set validation: bad mode / bad minutes throw', () => {
  const { awake } = setup();
  assert.throws(() => awake.set({ mode: 'sometimes' }));
  assert.throws(() => awake.set({ mode: 'timed' }));
  assert.throws(() => awake.set({ mode: 'timed', minutes: 0 }));
  assert.throws(() => awake.set({ mode: 'timed', minutes: 999999 }));
});

test('auto: follows running count via runner change events', () => {
  const { spawnFn, runner, state, awake } = setup();
  awake.set({ mode: 'auto' });
  assert.equal(awake.status().active, false);

  state.running = 1;
  runner.events.emit('change');
  assert.equal(awake.status().active, true);

  state.running = 0;
  runner.events.emit('change');
  assert.equal(awake.status().active, false);
  assert.equal(spawnFn.calls[0].child.killedWith, 'SIGTERM');
});

test('auto: holds for an imminent reset-anchored fire even with nothing armed', () => {
  // The scheduler can only arm an afterReset entry once usage reports a reset
  // time, and there is no catch-up — so a 3 a.m. rollover on a sleeping Mac is a
  // lost run. `auto` has to hold on the reset itself, not on an armed timer.
  const usage = fakeUsage(null);
  const { db, awake, clock } = setup({ usage });
  const job = createJob(db, validJob({
    schedule: { type: 'afterReset', window: 'five_hour', offsetMin: 0, jitterMin: 0 },
  }));
  awake.set({ mode: 'auto' });
  assert.equal(awake.status().active, false); // no reset time known yet

  // Well outside the 20-minute default lead: still allowed to sleep.
  usage.resetsAt = new Date(clock.now() + 90 * 60_000).toISOString();
  assert.equal(awake.refresh().active, false);

  // Inside the lead: hold.
  usage.resetsAt = new Date(clock.now() + 10 * 60_000).toISOString();
  assert.equal(awake.refresh().active, true);

  // A usage event is enough on its own — no other refresh trigger needed.
  awake.set({ mode: 'off' });
  awake.set({ mode: 'auto' });
  assert.equal(awake.status().active, true);

  // A reset time frozen in the past by a broken probe must not hold forever.
  usage.resetsAt = new Date(clock.now() - 5 * 60_000).toISOString();
  assert.equal(awake.refresh().active, false);

  // And a disabled job is not worth staying up for.
  usage.resetsAt = new Date(clock.now() + 5 * 60_000).toISOString();
  assert.equal(awake.refresh().active, true);
  updateJob(db, job.id, { enabled: false });
  assert.equal(awake.refresh().active, false);
});

test('auto: enabled job with a future fire holds awake; paused releases', () => {
  const { db, state, awake } = setup();
  const job = createJob(db, validJob());
  state.nextFire = new Date(Date.now() + 3600e3).toISOString();
  awake.set({ mode: 'auto' });
  assert.equal(awake.status().active, true);

  setSetting(db, 'paused', '1');
  assert.equal(awake.refresh().active, false);

  setSetting(db, 'paused', '0');
  assert.equal(awake.refresh().active, true);

  updateJob(db, job.id, { enabled: false });
  assert.equal(awake.refresh().active, false);
});
