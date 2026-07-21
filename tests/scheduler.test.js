import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpData, jobPayload, sleep } from './helpers.js';
import { openDb, createJob, getJob, updateJob, setSetting } from '../lib/db.js';
import { createScheduler } from '../lib/scheduler.js';

function setup() {
  const dir = tmpData();
  const db = openDb(join(dir, 'test.db'));
  const starts = [];
  const runner = { start: (job, trigger) => starts.push({ jobId: job.id, trigger }) };
  const scheduler = createScheduler({ db, runner });
  return { db, starts, scheduler };
}

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
