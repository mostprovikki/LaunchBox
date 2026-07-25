import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpData, jobPayload, extensions } from './helpers.js';
import { splitArgs, validateJob, previewSchedule, resetJitterMs, afterResetFireAt } from '../lib/validate.js';

tmpData();

const vj = (overrides) => validateJob(jobPayload(overrides), extensions);

test('splitArgs handles quotes', () => {
  assert.deepEqual(splitArgs(`--max-turns 5 --append-system-prompt "be very careful" -x 'a b'`),
    ['--max-turns', '5', '--append-system-prompt', 'be very careful', '-x', 'a b']);
  assert.deepEqual(splitArgs(''), []);
  assert.deepEqual(splitArgs(null), []);
});

test('valid claude job: defaults applied, flat ext keys folded into params', () => {
  const r = vj();
  assert.equal(r.ok, true);
  assert.equal(r.job.params.prompt, 'do the thing');
  assert.equal(r.job.params.model, 'default');
  assert.equal(r.job.params.permMode, 'auto');
  assert.equal(r.job.params.extraArgs, '');
  assert.equal(r.job.timeoutMin, 60);
  assert.equal(r.job.enabled, true);
  assert.ok(!('prompt' in r.job)); // ext fields live only in params
});

test('params object shape wins over flat keys and unknown keys dropped', () => {
  const r = vj({ prompt: 'flat', params: { prompt: 'nested', junk: 'x' } });
  assert.equal(r.ok, true);
  assert.equal(r.job.params.prompt, 'nested');
  assert.ok(!('junk' in r.job.params));
});

test('missing required ext fields per type', () => {
  let r = vj({ prompt: '' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /prompt/i.test(e)));

  r = vj({ type: 'command', prompt: null });
  assert.ok(r.errors.some((e) => /command/i.test(e)));

  r = vj({ type: 'command', prompt: null, command: 'echo hi' });
  assert.equal(r.ok, true);

  r = vj({ type: 'doesnotexist' });
  assert.ok(r.errors.some((e) => e.includes('unknown job type')));
});

test('rejects bad cwd, cron, past once, bad enums/ranges', () => {
  assert.ok(vj({ cwd: '/nope/nope' }).errors.some((e) => e.includes('cwd')));
  assert.ok(vj({ schedule: { type: 'cron', expr: 'not a cron' } }).errors.some((e) => e.includes('cron')));
  assert.ok(vj({ schedule: { type: 'once', at: '2020-01-01T00:00:00Z' } }).errors.some((e) => e.includes('future')));
  assert.ok(vj({ model: 'gpt' }).errors.some((e) => e.includes('model')));
  assert.ok(vj({ permMode: 'yolo' }).errors.some((e) => e.includes('permMode')));
  assert.ok(vj({ timeoutMin: 0 }).errors.some((e) => e.includes('timeoutMin')));
  assert.ok(vj({ retryCount: 9 }).errors.some((e) => e.includes('retryCount')));
});

test('multi-schedule: array accepted, single kept as object', () => {
  const future = new Date(Date.now() + 3600e3).toISOString();
  let r = vj({ schedules: [{ type: 'cron', expr: '0 5 * * *' }, { type: 'once', at: future }] });
  assert.equal(r.ok, true);
  assert.equal(r.job.schedule.length, 2);

  r = vj({ schedules: [{ type: 'cron', expr: '0 5 * * *' }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.job.schedule, { type: 'cron', expr: '0 5 * * *' });

  r = vj({ schedules: [{ type: 'cron', expr: 'junk' }, { type: 'once', at: future }] });
  assert.equal(r.ok, false);

  // past once tolerated when a live entry exists; alone it's an error
  r = vj({ schedules: [{ type: 'cron', expr: '0 5 * * *' }, { type: 'once', at: '2020-01-01T00:00:00Z' }] });
  assert.equal(r.ok, true);
  r = vj({ schedules: [{ type: 'once', at: '2020-01-01T00:00:00Z' }] });
  assert.ok(r.errors.some((e) => e.includes('future')));
});

test('afterReset: defaults filled, ranges enforced, window checked against live snapshot', () => {
  let r = vj({ schedule: { type: 'afterReset', window: 'five_hour' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.job.schedule, { type: 'afterReset', window: 'five_hour', offsetMin: 3, jitterMin: 2 });

  assert.ok(vj({ schedule: { type: 'afterReset', window: 'nope' } }).errors.some((e) => e.includes('window')));
  assert.ok(vj({ schedule: { type: 'afterReset', window: 'five_hour', offsetMin: 241 } }).errors.some((e) => e.includes('offsetMin')));
  assert.ok(vj({ schedule: { type: 'afterReset', window: 'five_hour', offsetMin: 1.5 } }).errors.some((e) => e.includes('offsetMin')));
  assert.ok(vj({ schedule: { type: 'afterReset', window: 'five_hour', jitterMin: 61 } }).errors.some((e) => e.includes('jitterMin')));
  assert.ok(vj({ schedule: { type: 'sometime' } }).errors.some((e) => e.includes('afterReset')));

  // A window the live snapshot reports is accepted even though it isn't one of
  // the two hardcoded fallbacks — that's the point of consulting the snapshot.
  const windows = { five_hour: { percent: 1, resetsAt: null }, tangelo: { percent: 2, resetsAt: null } };
  r = validateJob(jobPayload({ schedule: { type: 'afterReset', window: 'tangelo' } }), extensions, { windows });
  assert.equal(r.ok, true);
  // …and one it doesn't report is rejected, so a stale UI can't retarget a job.
  r = validateJob(jobPayload({ schedule: { type: 'afterReset', window: 'seven_day' } }), extensions, { windows });
  assert.equal(r.ok, false);
});

test('a job with only an afterReset entry validates (it always has a future fire)', () => {
  // entryFires() must not consult usage: an unreadable snapshot would otherwise
  // make the job look dead and auto-disable it.
  const r = vj({ schedules: [{ type: 'afterReset', window: 'seven_day', offsetMin: 0, jitterMin: 0 }] });
  assert.equal(r.ok, true);
  assert.ok(!r.errors);
});

test('per-job budget overrides survive validation; bad ones are rejected', () => {
  let r = vj({ params: { prompt: 'p', budget: { ignoreGuard: true, minHeadroomPct: 25 } } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.job.params.budget, { ignoreGuard: true, minHeadroomPct: 25 });

  // An empty block stores nothing — that's how unticking the box clears it.
  r = vj({ params: { prompt: 'p', budget: {} } });
  assert.equal(r.ok, true);
  assert.ok(!('budget' in r.job.params));

  assert.ok(vj({ params: { prompt: 'p', budget: { minHeadroomPct: 0 } } }).errors.some((e) => e.includes('minHeadroomPct')));
  assert.ok(vj({ params: { prompt: 'p', budget: 'yes' } }).errors.some((e) => e.includes('budget')));
});

test('reset jitter is deterministic per (jobId, window) and bounded', () => {
  const a = resetJitterMs('job-a', 'five_hour', 5);
  assert.equal(a, resetJitterMs('job-a', 'five_hour', 5)); // stable across calls
  assert.ok(a >= 0 && a <= 5 * 60_000);
  assert.notEqual(a, resetJitterMs('job-b', 'five_hour', 5)); // spread across jobs
  assert.notEqual(a, resetJitterMs('job-a', 'seven_day', 5)); // and across windows
  assert.equal(resetJitterMs('job-a', 'five_hour', 0), 0);

  const entry = { type: 'afterReset', window: 'five_hour', offsetMin: 3, jitterMin: 0 };
  const resetsAt = '2026-07-25T12:00:00.000Z';
  assert.equal(afterResetFireAt(entry, resetsAt, 'job-a'), '2026-07-25T12:03:00.000Z');
  assert.equal(afterResetFireAt(entry, 'not a date', 'job-a'), null);
  assert.equal(afterResetFireAt(entry, null, 'job-a'), null);
});

test('previewSchedule resolves afterReset only when the reset time is known', () => {
  const entry = { type: 'afterReset', window: 'five_hour', offsetMin: 5, jitterMin: 0 };
  const resetsAt = new Date(Date.now() + 3600e3).toISOString();

  let p = previewSchedule(entry, 3, { windows: { five_hour: { percent: 10, resetsAt } }, jobId: 'j1' });
  assert.deepEqual(p, { next: [new Date(new Date(resetsAt).getTime() + 5 * 60_000).toISOString()], unknown: false });

  // No windows at all, and a window whose reset already passed, are both
  // "will fire, can't say when" — never a thrown error or a wrong time.
  assert.deepEqual(previewSchedule(entry, 3), { next: [], unknown: true });
  p = previewSchedule(entry, 3, { windows: { five_hour: { percent: 10, resetsAt: '2020-01-01T00:00:00Z' } } });
  assert.deepEqual(p, { next: [], unknown: true });

  // A cron entry alongside it still previews; unknown just rides along.
  p = previewSchedule([entry, { type: 'cron', expr: '0 9 * * *' }], 3);
  assert.equal(p.unknown, true);
  assert.equal(p.next.length, 3);
});

test('previewSchedule merges entries sorted', () => {
  const a = new Date(Date.now() + 7200e3).toISOString();
  const b = new Date(Date.now() + 3600e3).toISOString();
  const { next, unknown } = previewSchedule([{ type: 'once', at: a }, { type: 'once', at: b }], 3);
  assert.deepEqual(next, [b, a].map((d) => new Date(d).toISOString()));
  assert.equal(unknown, false);
});

test('previewSchedule returns next fires', () => {
  const cron = previewSchedule({ type: 'cron', expr: '0 9 * * *' }).next;
  assert.equal(cron.length, 3);
  assert.ok(cron[0] < cron[1] && cron[1] < cron[2]);

  const future = new Date(Date.now() + 3600e3).toISOString();
  assert.deepEqual(previewSchedule({ type: 'once', at: future }).next, [new Date(future).toISOString()]);
  assert.throws(() => previewSchedule({ type: 'cron', expr: 'bogus' }));
});
