import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { tmpData, fakeSpawn, sleep } from './helpers.js';
import { openDb, setSetting, listUsageSnapshots, insertUsageSnapshot } from '../lib/db.js';
import { createUsageMonitor, flattenUsage } from '../lib/usage.js';

// Real `get_usage` response captured from this account ($0, no model turn).
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/get-usage-response.json', import.meta.url)));
const payload = () => structuredClone(FIXTURE.response.response);

function setup({ intervalMs = 60_000, ...opts } = {}) {
  const dir = tmpData();
  const db = openDb(join(dir, 'test.db'));
  const spawnFn = fakeSpawn();
  let t = Date.UTC(2026, 6, 25, 12, 0, 0);
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const usage = createUsageMonitor({
    db, spawnFn, getClaudePath: () => '/opt/bin/claude', intervalMs, now: clock.now, ...opts,
  });
  return { db, dir, spawnFn, usage, clock };
}

// Answer the pending probe the way the CLI does: unrelated stream events and
// non-JSON noise around the one line we asked for.
function reply(spawnFn, response) {
  const { child } = spawnFn.calls.at(-1);
  child.stdout.emit('data', '{"type":"system","subtype":"init","session_id":"x"}\n');
  child.stdout.emit('data', 'plain log noise, not json\n');
  child.stdout.emit('data', JSON.stringify({ type: 'control_response', response }) + '\n');
}

const ok = (response = payload()) => ({ subtype: 'success', request_id: '1', response });

test('flattenUsage: real fixture → generic windows, buckets, subscription', () => {
  const flat = flattenUsage(payload());
  assert.equal(flat.available, true);
  assert.equal(flat.subscriptionType, 'team');

  // Exactly the two real windows: null codenames aren't objects, extra_usage's
  // utilization is null with no resets_at, spend/limits/model_scoped are shaped out.
  assert.deepEqual(Object.keys(flat.windows).sort(), ['five_hour', 'seven_day']);
  assert.equal(flat.windows.five_hour.percent, 37);
  assert.equal(flat.windows.five_hour.resetsAt, '2026-07-25T00:20:00.386209+00:00');
  assert.equal(flat.windows.seven_day.percent, 64);

  assert.equal(flat.buckets.length, 3);
  assert.deepEqual(flat.buckets[2], {
    kind: 'weekly_scoped', group: 'weekly', percent: 90, severity: 'critical',
    resetsAt: '2026-07-25T18:00:00.386445+00:00', scopeModel: 'Fable', isActive: true,
  });
});

test('flattenUsage: an unknown codename bucket is discovered; non-windows are not', () => {
  const p = payload();
  p.rate_limits.tangelo = { utilization: 12, resets_at: '2026-07-26T00:00:00Z' };
  p.rate_limits.nimbus_quill = { resets_at: '2026-07-26T00:00:00Z' }; // resets_at alone qualifies
  p.rate_limits.mystery_meat = { enabled: false }; // neither → not a window

  const { windows } = flattenUsage(p);
  assert.deepEqual(Object.keys(windows).sort(), ['five_hour', 'nimbus_quill', 'seven_day', 'tangelo']);
  assert.equal(windows.tangelo.percent, 12);
  assert.equal(windows.nimbus_quill.percent, null);
  for (const k of ['extra_usage', 'spend', 'limits', 'model_scoped', 'mystery_meat', 'seven_day_opus']) {
    assert.equal(k in windows, false, `${k} must not be a window`);
  }
});

test('flattenUsage: rate_limits_available false → unavailable, not an error', () => {
  const p = payload();
  p.rate_limits_available = false;
  const flat = flattenUsage(p);
  assert.equal(flat.available, false);
  assert.deepEqual(flat.windows, {});
  assert.deepEqual(flat.buckets, []);
});

test('probe: writes one get_usage control request on stdin and closes it', async () => {
  const { spawnFn, usage } = setup();
  const p = usage.refresh();

  const { cmd, args, opts, child } = spawnFn.calls[0];
  assert.equal(cmd, '/opt/bin/claude');
  assert.deepEqual(args, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
  assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(JSON.parse(child.stdin.written), {
    type: 'control_request', request_id: '1', request: { subtype: 'get_usage' },
  });
  assert.equal(child.stdin.ended, true);

  reply(spawnFn, ok());
  const snap = await p;
  assert.equal(snap.ok, true);
  assert.equal(snap.stale, false);
  assert.equal(snap.windows.five_hour.percent, 37);
  assert.equal(snap.pollSec, 60);
  // Answered → no reason to keep the child around.
  assert.equal(child.killedWith, 'SIGTERM');
});

test('unavailable session degrades quietly: no error, no backoff', async () => {
  const { usage, spawnFn } = setup();
  const p = usage.refresh();
  const unavailable = payload();
  unavailable.rate_limits_available = false;
  unavailable.subscription_type = null;
  reply(spawnFn, ok(unavailable));
  const snap = await p;

  assert.equal(snap.ok, true);
  assert.equal(snap.available, false);
  assert.equal(snap.error, null);
  assert.equal(usage.status().failures, 0);
});

test('probe failure: last good snapshot retained, marked stale, failure recorded', async () => {
  const { db, usage, spawnFn } = setup();
  const good = usage.refresh();
  reply(spawnFn, ok());
  await good;

  // Non-JSON noise then a non-zero exit, i.e. no usable response at all.
  const bad = usage.refresh();
  const { child } = spawnFn.calls.at(-1);
  child.stdout.emit('data', 'Error: something went sideways\n');
  child.stderr.emit('data', 'auth expired\n');
  child.emit('close', 1);
  const snap = await bad;

  assert.equal(snap.ok, false);
  assert.equal(snap.stale, true);
  assert.match(snap.error, /exited 1 without a usage response: auth expired/);
  assert.equal(snap.windows.five_hour.percent, 37, 'stale truth beats no truth');
  assert.equal(usage.window('seven_day').percent, 64);

  // Both outcomes are in the log; the failure row carries no fabricated percents.
  const rows = listUsageSnapshots(db, { limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ok, false);
  assert.deepEqual(rows[0].windows, {});
  assert.equal(rows[1].ok, true);
  assert.equal(listUsageSnapshots(db, { okOnly: true }).length, 1);
});

test('probe watchdog: a child that never answers is killed and reported', async () => {
  const { usage, spawnFn } = setup({ probeTimeoutMs: 20 });
  const p = usage.refresh();
  const { child } = spawnFn.calls[0];
  const snap = await p;

  assert.equal(child.killedWith, 'SIGKILL');
  assert.equal(snap.ok, false);
  assert.match(snap.error, /timed out after 20ms/);
});

test('poll interval is floored at 60s, from the setting or the override', async () => {
  const { usage } = setup({ intervalMs: 5_000 });
  assert.equal(usage.status().pollSec, 60);

  const bySetting = setup({ intervalMs: null });
  assert.equal(bySetting.usage.status().pollSec, 180, 'default');
  setSetting(bySetting.db, 'usagePollSec', 5);
  assert.equal(bySetting.usage.status().pollSec, 60, 'setting cannot go under the floor');
  setSetting(bySetting.db, 'usagePollSec', 600);
  assert.equal(bySetting.usage.status().pollSec, 600);
});

test('backoff doubles per consecutive failure and resets on success', async () => {
  const { usage, spawnFn, clock } = setup({ intervalMs: 60_000 });
  const at = (ms) => new Date(clock.now() + ms).toISOString();

  const fail = async () => {
    const p = usage.refresh();
    spawnFn.calls.at(-1).child.emit('close', 1);
    await p;
  };
  const nextAfterSchedule = () => {
    usage.stop();
    usage.start({ immediate: false });
    const { nextPollAt } = usage.status();
    usage.stop();
    return nextPollAt;
  };

  await fail();
  assert.equal(nextAfterSchedule(), at(120_000));
  await fail();
  assert.equal(nextAfterSchedule(), at(240_000));

  const p = usage.refresh();
  reply(spawnFn, ok());
  await p;
  assert.equal(usage.status().failures, 0);
  assert.equal(nextAfterSchedule(), at(60_000));
});

test('backoff is capped at 15 minutes', async () => {
  const { usage, spawnFn, clock } = setup({ intervalMs: 60_000 });
  for (let i = 0; i < 12; i++) {
    const p = usage.refresh();
    spawnFn.calls.at(-1).child.emit('close', 1);
    await p;
  }
  usage.start({ immediate: false });
  assert.equal(usage.status().nextPollAt, new Date(clock.now() + 15 * 60_000).toISOString());
  usage.stop();
});

test('usage event fires on change only, not on an identical repeat', async () => {
  const { usage, spawnFn } = setup();
  const seen = [];
  usage.events.on('usage', (s) => seen.push(s));

  const first = usage.refresh();
  reply(spawnFn, ok());
  await first;
  assert.equal(seen.length, 1);

  const same = usage.refresh();
  reply(spawnFn, ok());
  await same;
  assert.equal(seen.length, 1, 'identical snapshot must not re-arm consumers');

  const moved = payload();
  moved.rate_limits.five_hour.utilization = 41;
  const changed = usage.refresh();
  reply(spawnFn, ok(moved));
  await changed;
  assert.equal(seen.length, 2);
  assert.equal(seen[1].windows.five_hour.percent, 41);
});

test('concurrent refreshes coalesce into one probe', async () => {
  const { usage, spawnFn } = setup();
  const a = usage.refresh();
  const b = usage.refresh();
  assert.equal(spawnFn.calls.length, 1);
  reply(spawnFn, ok());
  const [sa, sb] = await Promise.all([a, b]);
  assert.equal(sa.windows.five_hour.percent, 37);
  assert.deepEqual(sa, sb);
});

test('start polls on the interval and stop halts it', async () => {
  // Floor lowered only so the test doesn't take a minute; production floors at 60s.
  const { usage, spawnFn } = setup({ intervalMs: 20, pollFloorMs: 5 });
  usage.start();
  await sleep(5);
  assert.equal(spawnFn.calls.length, 1);
  reply(spawnFn, ok());
  await sleep(40);
  assert.ok(spawnFn.calls.length >= 2, `expected a second poll, got ${spawnFn.calls.length}`);
  usage.stop();
  const after = spawnFn.calls.length;
  await sleep(40);
  assert.equal(spawnFn.calls.length, after);
  assert.equal(usage.status().running, false);
});

test('a restart serves the last recorded snapshot, marked stale', () => {
  const dir = tmpData();
  const db = openDb(join(dir, 'test.db'));
  insertUsageSnapshot(db, {
    capturedAt: '2026-07-25T11:00:00.000Z', ok: true, available: true, subscriptionType: 'team',
    windows: { five_hour: { percent: 22, resetsAt: '2026-07-25T14:00:00Z' } }, buckets: [],
  });

  const usage = createUsageMonitor({ db, spawnFn: fakeSpawn(), intervalMs: 60_000 });
  const snap = usage.snapshot();
  assert.equal(snap.capturedAt, '2026-07-25T11:00:00.000Z');
  assert.equal(snap.windows.five_hour.percent, 22);
  assert.equal(snap.stale, true);
  assert.equal(snap.ok, false, 'nothing has been verified in this process yet');
});

test('snapshot is null before any probe on a fresh db', () => {
  const { usage } = setup();
  assert.equal(usage.snapshot(), null);
  assert.equal(usage.window('five_hour'), null);
  assert.deepEqual(usage.status().running, false);
});
