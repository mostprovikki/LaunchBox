import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpData, jobPayload, extensions } from './helpers.js';
import { splitArgs, validateJob, previewSchedule } from '../lib/validate.js';

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

test('previewSchedule merges entries sorted', () => {
  const a = new Date(Date.now() + 7200e3).toISOString();
  const b = new Date(Date.now() + 3600e3).toISOString();
  const next = previewSchedule([{ type: 'once', at: a }, { type: 'once', at: b }], 3);
  assert.deepEqual(next, [b, a].map((d) => new Date(d).toISOString()));
});

test('previewSchedule returns next fires', () => {
  const cron = previewSchedule({ type: 'cron', expr: '0 9 * * *' });
  assert.equal(cron.length, 3);
  assert.ok(cron[0] < cron[1] && cron[1] < cron[2]);

  const future = new Date(Date.now() + 3600e3).toISOString();
  assert.deepEqual(previewSchedule({ type: 'once', at: future }), [new Date(future).toISOString()]);
  assert.throws(() => previewSchedule({ type: 'cron', expr: 'bogus' }));
});
