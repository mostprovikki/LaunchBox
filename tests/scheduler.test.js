import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { tmpData, jobPayload, sleep } from './helpers.js';
import { openDb, createJob, getJob, updateJob, setSetting } from '../lib/db.js';
import { createScheduler } from '../lib/scheduler.js';
import { afterResetFireAt } from '../lib/validate.js';

// Stands in for the usage monitor: the scheduler only reads window() and listens
// on events, so no probe (real or fake) is needed anywhere in here.
function fakeUsage(windows = {}) {
  const u = { windows, events: new EventEmitter() };
  u.window = (name) => u.windows[name] ?? null;
  u.set = (name, resetsAt) => {
    u.windows = { ...u.windows, [name]: { percent: 1, resetsAt } };
    u.events.emit('usage', { windows: u.windows });
  };
  return u;
}

function setup({ usage = null } = {}) {
  const dir = tmpData();
  const db = openDb(join(dir, 'test.db'));
  const starts = [];
  const runner = { start: (job, trigger) => starts.push({ jobId: job.id, trigger }) };
  const scheduler = createScheduler({ db, runner, usage });
  return { db, starts, scheduler };
}

// An afterReset entry firing `ms` from now: offset/jitter are minute-grained, so
// the reset time itself is what these tests move.
const resetIn = (ms) => new Date(Date.now() + ms).toISOString();
const RESET_ENTRY = { type: 'afterReset', window: 'five_hour', offsetMin: 0, jitterMin: 0 };

// 6-field cron (with seconds) keeps these tests fast.
test('cron job fires repeatedly; nextFire reported', async () => {
  const { db, starts, scheduler } = setup();
  const job = createJob(db, jobPayload({ schedule: { type: 'cron', expr: '* * * * * *' } }));
  scheduler.start();
  assert.ok(scheduler.nextFire(job.id));
  await sleep(2100);
  scheduler.stop();
  assert.ok(starts.length >= 1);
  assert.equal(starts[0].trigger, 'schedule');
  assert.equal(starts[0].jobId, job.id);
});

test('once job fires once and auto-disables', async () => {
  const { db, starts, scheduler } = setup();
  const job = createJob(db, jobPayload({ schedule: { type: 'once', at: new Date(Date.now() + 200).toISOString() } }));
  scheduler.start();
  await sleep(700);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].trigger, 'once');
  assert.equal(getJob(db, job.id).enabled, false);
  assert.equal(scheduler.nextFire(job.id), null);
  scheduler.stop();
});

test('multi-schedule: both once-entries fire, job disables after the last', async () => {
  const { db, starts, scheduler } = setup();
  const job = createJob(db, jobPayload({
    schedule: [
      { type: 'once', at: new Date(Date.now() + 150).toISOString() },
      { type: 'once', at: new Date(Date.now() + 400).toISOString() },
    ],
  }));
  scheduler.start();
  await sleep(250);
  assert.equal(starts.length, 1);
  assert.equal(getJob(db, job.id).enabled, true); // second entry still pending
  await sleep(500);
  assert.equal(starts.length, 2);
  assert.equal(getJob(db, job.id).enabled, false); // all entries done
  assert.equal(scheduler.nextFire(job.id), null);
  scheduler.stop();
});

test('multi-schedule: cron + once — once fires, cron keeps job enabled', async () => {
  const { db, starts, scheduler } = setup();
  const job = createJob(db, jobPayload({
    schedule: [
      { type: 'cron', expr: '0 9 * * *' },
      { type: 'once', at: new Date(Date.now() + 150).toISOString() },
    ],
  }));
  scheduler.start();
  await sleep(400);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].trigger, 'once');
  assert.equal(getJob(db, job.id).enabled, true);
  assert.ok(scheduler.nextFire(job.id)); // cron still scheduled
  scheduler.stop();
});

test('afterReset fires at resetsAt + offset + jitter, with trigger "schedule"', async () => {
  const usage = fakeUsage({ five_hour: { percent: 40, resetsAt: resetIn(200) } });
  const { db, starts, scheduler } = setup({ usage });
  const job = createJob(db, jobPayload({ schedule: RESET_ENTRY }));
  scheduler.start();

  // nextFire is the computed time, not the raw reset — the offset/jitter are part
  // of the schedule, so the UI must see what will actually happen.
  assert.equal(scheduler.nextFire(job.id), afterResetFireAt(RESET_ENTRY, usage.windows.five_hour.resetsAt, job.id));
  await sleep(400);
  scheduler.stop();
  assert.equal(starts.length, 1);
  assert.equal(starts[0].trigger, 'schedule'); // not 'once' — must not auto-disable
  assert.equal(getJob(db, job.id).enabled, true);
});

test('afterReset: not armed without usage, a past reset is not caught up on', async () => {
  // No monitor at all: the entry simply never arms, and the job stays enabled and
  // editable rather than being treated as broken.
  let s = setup();
  const jobA = createJob(s.db, jobPayload({ schedule: RESET_ENTRY }));
  s.scheduler.start();
  assert.equal(s.scheduler.nextFire(jobA.id), null);
  assert.equal(getJob(s.db, jobA.id).enabled, true);
  s.scheduler.stop();

  // A reset whose computed fire time already passed (Mac asleep, daemon down) is
  // skipped, not fired late — same no-catch-up rule as a stale once-entry.
  s = setup({ usage: fakeUsage({ five_hour: { percent: 40, resetsAt: resetIn(-60_000) } }) });
  const jobB = createJob(s.db, jobPayload({ schedule: RESET_ENTRY }));
  s.scheduler.start();
  assert.equal(s.scheduler.nextFire(jobB.id), null);
  await sleep(150);
  assert.equal(s.starts.length, 0);
  s.scheduler.stop();
});

test('afterReset re-arms on a usage event and never fires the same window twice', async () => {
  const usage = fakeUsage({ five_hour: { percent: 40, resetsAt: resetIn(-60_000) } });
  const { db, starts, scheduler } = setup({ usage });
  const job = createJob(db, jobPayload({ schedule: RESET_ENTRY }));
  scheduler.start();
  assert.equal(scheduler.nextFire(job.id), null); // past reset — nothing armed

  // A new reading carrying a future reset arms it.
  usage.set('five_hour', resetIn(200));
  assert.ok(scheduler.nextFire(job.id));
  await sleep(400);
  assert.equal(starts.length, 1);

  // Re-arming against the *same* resetsAt must not fire again: the reset time
  // doesn't move until the window actually rolls over, and every usage poll
  // re-arms.
  usage.events.emit('usage', { windows: usage.windows });
  usage.events.emit('usage', { windows: usage.windows });
  await sleep(150);
  assert.equal(starts.length, 1);

  // A genuinely new window instance does fire again.
  usage.set('five_hour', resetIn(150));
  await sleep(350);
  scheduler.stop();
  assert.equal(starts.length, 2);
});

test('afterReset alongside a once-entry: the spent once must not disable the job', async () => {
  // The once auto-disable path counts armed crons; an unarmed afterReset entry
  // has none, so without the explicit check the job would be disabled for good.
  const { db, starts, scheduler } = setup({ usage: fakeUsage() });
  const job = createJob(db, jobPayload({
    schedule: [{ type: 'once', at: new Date(Date.now() + 150).toISOString() }, RESET_ENTRY],
  }));
  scheduler.start();
  await sleep(400);
  scheduler.stop();
  assert.equal(starts.length, 1);
  assert.equal(starts[0].trigger, 'once');
  assert.equal(getJob(db, job.id).enabled, true);
});

test('paused suppresses an afterReset fire and it does not come back on re-arm', async () => {
  const usage = fakeUsage({ five_hour: { percent: 40, resetsAt: resetIn(150) } });
  const { db, starts, scheduler } = setup({ usage });
  createJob(db, jobPayload({ schedule: RESET_ENTRY }));
  setSetting(db, 'paused', '1');
  scheduler.start();
  await sleep(350);
  assert.equal(starts.length, 0);

  setSetting(db, 'paused', '0');
  usage.events.emit('usage', { windows: usage.windows });
  await sleep(150);
  scheduler.stop();
  assert.equal(starts.length, 0); // that window instance is spent, pause or not
});

test('paused suppresses fires; disabled jobs not scheduled; reload picks up changes', async () => {
  const { db, starts, scheduler } = setup();
  const job = createJob(db, jobPayload({ schedule: { type: 'cron', expr: '* * * * * *' } }));
  setSetting(db, 'paused', '1');
  scheduler.start();
  await sleep(1200);
  assert.equal(starts.length, 0); // paused

  setSetting(db, 'paused', '0');
  updateJob(db, job.id, { enabled: false });
  scheduler.reload(job.id);
  assert.equal(scheduler.nextFire(job.id), null); // disabled → unscheduled
  await sleep(1200);
  assert.equal(starts.length, 0);

  updateJob(db, job.id, { enabled: true });
  scheduler.reload(job.id);
  await sleep(1500);
  scheduler.stop();
  assert.ok(starts.length >= 1);
});
