import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpData, jobPayload, fakeSpawn, sleep, extensions } from './helpers.js';
import { ensureDirs } from '../lib/paths.js';
import { readFileSync } from 'node:fs';
import { openDb, listRuns, getSetting, setSetting, recordRunUsage } from '../lib/db.js';
import { createRunner } from '../lib/runner.js';
import { createScheduler } from '../lib/scheduler.js';
import { createAwake } from '../lib/awake.js';
import { createUsageMonitor } from '../lib/usage.js';
import { createBudgetPolicy } from '../lib/budget.js';
import { createPauseController } from '../lib/pause.js';
import { createApp } from '../server.js';
import { removalScript } from '../lib/uninstall.js';
import { EventEmitter } from 'node:events';

const USAGE_PAYLOAD = JSON.parse(readFileSync(new URL('./fixtures/get-usage-response.json', import.meta.url)))
  .response.response;

async function boot() {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const spawnFn = fakeSpawn();
  const caffSpawn = fakeSpawn();
  const usageSpawn = fakeSpawn();
  const usage = createUsageMonitor({ db, spawnFn: usageSpawn, getClaudePath: () => '/fake/claude' });
  // Wired exactly as main() does, including the late-bound `pause` in admit —
  // the API's pause behaviour is only meaningful with the real controller behind it.
  let pause = null;
  const runner = createRunner({
    db, extensions, spawnFn, notifyFn: () => {}, usage,
    admit: (job, trigger, opts) => pause?.gate(job, trigger, opts) ?? null,
  });
  pause = createPauseController({ db, runner });
  const scheduler = createScheduler({ db, runner, pause });
  const awake = createAwake({ db, runner, scheduler, pause, spawnFn: caffSpawn });
  const osaCalls = [];
  const uninstalls = [];
  const app = createApp({
    db, runner, scheduler, extensions, awake, usage, pause,
    usageRefreshFloorMs: 5_000,
    execFileFn: (cmd, args, cb) => { osaCalls.push({ cmd, args }); cb(null); },
    uninstallFn: (opts) => uninstalls.push(opts),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = () => `http://127.0.0.1:${server.address().port}`;
  return { db, spawnFn, caffSpawn, usageSpawn, usage, runner, scheduler, awake, pause, server, base, osaCalls, uninstalls };
}

// A second boot whose usage monitor is a fixed snapshot rather than a probe: the
// budget guard, the planner and afterReset arming are all functions of the limit
// state, so the tests that exercise them need to *state* that limit state. The
// real monitor (and the recorded fixture, with its fixed timestamps) is exercised
// by the usage tests above.
async function bootWithUsage({ fiveHour = 20, sevenDay = 20, buckets = [], resetsIn = 4 * 3600e3 } = {}) {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const spawnFn = fakeSpawn();
  const at = new Date().toISOString();
  const resetsAt = new Date(Date.now() + resetsIn).toISOString();
  const snap = {
    capturedAt: at, checkedAt: at, ok: true, error: null, stale: false, available: true,
    subscriptionType: 'max', pollSec: 180, nextPollAt: null,
    windows: { five_hour: { percent: fiveHour, resetsAt }, seven_day: { percent: sevenDay, resetsAt } },
    buckets,
  };
  const usage = {
    events: new EventEmitter(),
    snapshot: () => snap,
    window: (n) => snap.windows[n] ?? null,
    status: () => ({ running: true, pollSec: 180, nextPollAt: null }),
    refresh: async () => snap,
  };
  const budget = createBudgetPolicy({ db, usage });
  const runner = createRunner({ db, extensions, spawnFn, notifyFn: () => {}, admit: budget.admit });
  const scheduler = createScheduler({ db, runner, usage });
  const app = createApp({ db, runner, scheduler, extensions, awake: null, usage, budget });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { db, spawnFn, usage, snap, resetsAt, runner, scheduler, server, base: () => `http://127.0.0.1:${server.address().port}` };
}

// Answer the probe a request is waiting on, once the route has spawned it.
async function answerProbe(usageSpawn, payload = USAGE_PAYLOAD) {
  const before = usageSpawn.calls.length;
  for (let i = 0; i < 100 && usageSpawn.calls.length === before; i++) await sleep(2);
  usageSpawn.calls.at(-1).child.stdout.emit('data',
    JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: '1', response: payload } }) + '\n');
}

async function req(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* plaintext (log) responses */ }
  return { status: res.status, body: parsed, raw: text };
}

test('extensions manifest lists claude+command, functions stripped', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());

  const r = await req(base(), 'GET', '/api/extensions');
  const ids = r.body.extensions.map((e) => e.id).sort();
  assert.deepEqual(ids, ['claude', 'command']);
  const claude = r.body.extensions.find((e) => e.id === 'claude');
  assert.ok(claude.fields.some((f) => f.key === 'prompt' && f.required));
  assert.deepEqual(claude.runActions, [{ id: 'resume', label: 'Resume in Terminal', requiresRunMeta: 'sessionId' }]);
  assert.ok(!('command' in claude) && !('exec' in claude.runActions[0]));
});

test('jobs CRUD + validation + decoration + params fold-in', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());

  let r = await req(base(), 'POST', '/api/jobs', jobPayload({ name: 'daily' }));
  assert.equal(r.status, 201);
  const id = r.body.id;
  assert.ok(r.body.nextFire); // decorated
  assert.equal(r.body.lastRun, null);
  assert.equal(r.body.params.prompt, 'do the thing'); // flat key folded into params

  r = await req(base(), 'POST', '/api/jobs', jobPayload({ cwd: '/nope' }));
  assert.equal(r.status, 400);
  assert.ok(r.body.errors.length);

  r = await req(base(), 'POST', '/api/jobs', jobPayload({ type: 'nope' }));
  assert.equal(r.status, 400);

  r = await req(base(), 'GET', '/api/jobs');
  assert.equal(r.body.jobs.length, 1);
  assert.equal(r.body.running, 0);
  assert.equal(r.body.awake.mode, 'off');

  r = await req(base(), 'PUT', `/api/jobs/${id}`, { name: 'renamed', enabled: false, params: { model: 'opus' } });
  assert.equal(r.body.name, 'renamed');
  assert.equal(r.body.enabled, false);
  assert.equal(r.body.params.model, 'opus');
  assert.equal(r.body.params.prompt, 'do the thing'); // params merge, not replace
  assert.equal(r.body.nextFire, null); // disabled → unscheduled

  r = await req(base(), 'DELETE', `/api/jobs/${id}`);
  assert.equal(r.body.ok, true);
  r = await req(base(), 'GET', `/api/jobs/${id}`);
  assert.equal(r.status, 404);
});

test('run-now, runs list, log, resume action', async (t) => {
  const { spawnFn, server, base, osaCalls } = await boot();
  t.after(() => server.close());

  const { body: job } = await req(base(), 'POST', '/api/jobs', jobPayload());
  let r = await req(base(), 'POST', `/api/jobs/${job.id}/run`);
  assert.equal(r.status, 202);
  const runId = r.body.id;
  assert.equal(r.body.status, 'running');

  // resume before session id lands → 400
  r = await req(base(), 'POST', `/api/runs/${runId}/actions/resume`);
  assert.equal(r.status, 400);

  const child = spawnFn.calls[0].child;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-x', model: 'm' }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', result: 'yo', num_turns: 1 }) + '\n'));
  child.emit('close', 0);
  await sleep(30);

  r = await req(base(), 'GET', `/api/runs?job=${job.id}`);
  assert.equal(r.body.runs.length, 1);
  assert.equal(r.body.runs[0].status, 'ok');
  assert.equal(r.body.runs[0].meta.sessionId, 'sess-x');

  r = await req(base(), 'GET', `/api/runs/${runId}/log`);
  assert.ok(r.raw.includes('sess-x') && r.raw.includes('yo'));

  r = await req(base(), 'POST', `/api/runs/${runId}/actions/resume`);
  assert.equal(r.status, 200);
  assert.equal(osaCalls[0].cmd, 'osascript');
  assert.ok(osaCalls[0].args[1].includes('--resume sess-x'));
  assert.ok(osaCalls[0].args[1].includes(job.cwd));

  r = await req(base(), 'POST', `/api/runs/${runId}/actions/nope`);
  assert.equal(r.status, 404);
});

test('kill endpoint: 202 active, 409 finished, 404 unknown', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());

  const { body: job } = await req(base(), 'POST', '/api/jobs', jobPayload());
  const { body: run } = await req(base(), 'POST', `/api/jobs/${job.id}/run`);

  let r = await req(base(), 'POST', `/api/runs/${run.id}/kill`);
  assert.equal(r.status, 202);
  assert.equal(r.body.status, 'killed');

  r = await req(base(), 'POST', `/api/runs/${run.id}/kill`);
  assert.equal(r.status, 409);
  r = await req(base(), 'POST', '/api/runs/nope/kill');
  assert.equal(r.status, 404);
});

// --- M3: pause modes & graceful stop ---------------------------------------

test('stop endpoint: 202 active, 409 finished, 404 unknown', async (t) => {
  const { spawnFn, server, base } = await boot();
  t.after(() => server.close());

  const { body: job } = await req(base(), 'POST', '/api/jobs', jobPayload());
  const { body: run } = await req(base(), 'POST', `/api/jobs/${job.id}/run`);

  let r = await req(base(), 'POST', `/api/runs/${run.id}/stop`);
  assert.equal(r.status, 202);
  assert.equal(r.body.status, 'stopped');
  assert.equal(r.body.meta.stopRung, 'SIGINT');
  assert.equal(spawnFn.calls[0].child.killedWith, 'SIGINT');

  // A `stopped` run is finished — not active for the kill guard, the stop guard,
  // or the SSE live check.
  r = await req(base(), 'POST', `/api/runs/${run.id}/stop`);
  assert.equal(r.status, 409);
  r = await req(base(), 'POST', `/api/runs/${run.id}/kill`);
  assert.equal(r.status, 409);
  r = await req(base(), 'POST', '/api/runs/nope/stop');
  assert.equal(r.status, 404);

  const sse = await fetch(`${base()}/api/runs/${run.id}/tail`);
  const text = await sse.text();
  assert.match(text, /event: done\ndata: stopped/, 'the tail closes rather than hanging open');

  // And it is reachable under its own history filter.
  r = await req(base(), 'GET', '/api/runs?status=stopped');
  assert.deepEqual(r.body.runs.map((x) => x.id), [run.id]);
});

test('GET/PUT /api/pause: modes, what they block, and the runs winding down', async (t) => {
  const { db, spawnFn, server, base } = await boot();
  t.after(() => server.close());
  setSetting(db, 'softGraceMs', 10_000); // no escalation mid-test

  let r = await req(base(), 'GET', '/api/pause');
  assert.deepEqual(r.body, { mode: 'off', until: null, blocking: { schedule: false, manual: false }, stopping: [] });

  const { body: job } = await req(base(), 'POST', '/api/jobs', jobPayload());
  const { body: run } = await req(base(), 'POST', `/api/jobs/${job.id}/run`);
  spawnFn.calls[0].child.deaf = ['SIGINT'];

  r = await req(base(), 'PUT', '/api/pause', { mode: 'soft' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'soft');
  assert.deepEqual(r.body.blocking, { schedule: true, manual: true });
  assert.deepEqual(r.body.stopped, [run.id]);
  assert.deepEqual(r.body.stopping, [run.id]);

  // The banner reads this off the jobs tick rather than needing its own poller.
  r = await req(base(), 'GET', '/api/jobs');
  assert.equal(r.body.pause.mode, 'soft');
  assert.deepEqual(r.body.pause.stopping, [run.id]);

  // Overlap-skip is judged *before* admission, so re-running the job that is
  // still winding down reports the overlap (correctly — it is still running) and
  // carries no reason. The pause refusal needs a job that isn't already busy.
  r = await req(base(), 'POST', `/api/jobs/${job.id}/run`);
  assert.equal(r.body.status, 'skipped');
  assert.equal(r.body.meta, null, 'already-running wins, and it has no skipReason to give');

  const { body: other } = await req(base(), 'POST', '/api/jobs', jobPayload({ name: 'idle job' }));
  r = await req(base(), 'POST', `/api/jobs/${other.id}/run`);
  assert.equal(r.body.status, 'skipped');
  assert.equal(r.body.meta.skipReason, 'paused (soft)', 'the reason the UI offers to override');
  // ...and the confirmed override goes through.
  r = await req(base(), 'POST', `/api/jobs/${other.id}/run`, { force: true });
  assert.equal(r.body.status, 'running');

  r = await req(base(), 'PUT', '/api/pause', { mode: 'nope' });
  assert.equal(r.status, 400);
});

test('pause: the legacy settings alias still works and cannot weaken a stronger mode', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());

  // v1 clients only know this key.
  await req(base(), 'PUT', '/api/settings', { paused: true });
  let r = await req(base(), 'GET', '/api/pause');
  assert.equal(r.body.mode, 'hold', 'paused:true means what it always meant');
  r = await req(base(), 'GET', '/api/settings');
  assert.equal(r.body.paused, true);
  assert.equal(r.body.pauseMode, 'hold');

  // A stale client re-asserting paused:true must not quietly downgrade a hard pause.
  await req(base(), 'PUT', '/api/pause', { mode: 'hard' });
  await req(base(), 'PUT', '/api/settings', { paused: true });
  r = await req(base(), 'GET', '/api/pause');
  assert.equal(r.body.mode, 'hard', 'still hard');

  // Clearing it is unambiguous, so it is honoured.
  await req(base(), 'PUT', '/api/settings', { paused: false });
  r = await req(base(), 'GET', '/api/pause');
  assert.equal(r.body.mode, 'off');
});

test('settings: softGraceMs round-trips and rejects out-of-range values', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());

  let r = await req(base(), 'PUT', '/api/settings', { softGraceMs: 45_000 });
  assert.equal(r.status, 200);
  r = await req(base(), 'GET', '/api/settings');
  assert.equal(r.body.softGraceMs, 45_000);

  for (const bad of [999, 600_001, 'soon']) {
    r = await req(base(), 'PUT', '/api/settings', { softGraceMs: bad });
    assert.equal(r.status, 400, `${bad} must be rejected`);
  }
});

test('SSE tail streams history + done for finished run', async (t) => {
  const { spawnFn, server, base } = await boot();
  t.after(() => server.close());

  const { body: job } = await req(base(), 'POST', '/api/jobs', jobPayload({ type: 'command', prompt: null, command: 'echo hi' }));
  const { body: run } = await req(base(), 'POST', `/api/jobs/${job.id}/run`);
  spawnFn.calls[0].child.stdout.emit('data', Buffer.from('hello world\n'));
  spawnFn.calls[0].child.emit('close', 0);
  await sleep(30);

  const res = await fetch(`${base()}/api/runs/${run.id}/tail`);
  const text = await res.text(); // finished run → server ends stream
  assert.ok(text.includes('data: hello world'));
  assert.ok(text.includes('event: done'));
});

test('schedule preview + settings round-trip (per-extension)', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());

  let r = await req(base(), 'POST', '/api/schedule/preview', { schedule: { type: 'cron', expr: '0 9 * * *' } });
  assert.equal(r.body.next.length, 3);
  r = await req(base(), 'POST', '/api/schedule/preview', { schedule: { type: 'cron', expr: 'junk' } });
  assert.equal(r.status, 400);

  r = await req(base(), 'GET', '/api/settings');
  assert.equal(r.body.paused, false);
  assert.deepEqual(r.body.extensions.claude, { claudePath: 'claude', maxConcurrent: 2 });

  r = await req(base(), 'PUT', '/api/settings', { paused: true, extensions: { claude: { claudePath: '/opt/claude', maxConcurrent: 4 } } });
  assert.equal(r.body.ok, true);
  r = await req(base(), 'GET', '/api/settings');
  assert.deepEqual(r.body, {
    paused: true,
    // The legacy `paused: true` alias means what it always meant: hold.
    pauseMode: 'hold',
    softGraceMs: 120_000,
    home: process.env.HOME || '',
    usagePollSec: 180,
    usageShow: 'banner',
    usageWarnPct: 80,
    awakeResetLeadMin: 20,
    // Budget guard defaults ship conservative — see lib/budget.js.
    budgetGuard: true,
    reserveFiveHourPct: 80,
    reserveWeeklyPct: 95,
    pauseOnWarning: true,
    extensions: { claude: { claudePath: '/opt/claude', maxConcurrent: 4 } },
  });

  r = await req(base(), 'PUT', '/api/settings', { extensions: { claude: { maxConcurrent: 99 } } });
  assert.equal(r.status, 400);
  r = await req(base(), 'PUT', '/api/settings', { extensions: { nope: { x: 1 } } });
  assert.equal(r.status, 400);
});

test('settings: usage keys round-trip and reject out-of-range values', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());

  let r = await req(base(), 'PUT', '/api/settings', { usagePollSec: 300, usageShow: 'compact', usageWarnPct: 70 });
  assert.equal(r.body.ok, true);
  r = await req(base(), 'GET', '/api/settings');
  assert.equal(r.body.usagePollSec, 300);
  assert.equal(r.body.usageShow, 'compact');
  assert.equal(r.body.usageWarnPct, 70);
  r = await req(base(), 'GET', '/api/usage');
  assert.equal(r.body.display, 'compact');
  assert.equal(r.body.warnPct, 70);
  assert.equal(r.body.pollSec, 300, 'a new interval applies without a restart');

  // The 60s floor is not the client's to lower.
  for (const bad of [{ usagePollSec: 30 }, { usagePollSec: 'soon' }, { usageShow: 'sideways' }, { usageWarnPct: 0 }]) {
    r = await req(base(), 'PUT', '/api/settings', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  r = await req(base(), 'GET', '/api/settings');
  assert.equal(r.body.usagePollSec, 300, 'a rejected write changes nothing');
});

test('settings: budget keys round-trip and reject out-of-range values', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());

  let r = await req(base(), 'PUT', '/api/settings', {
    budgetGuard: false, reserveFiveHourPct: 60, reserveWeeklyPct: 90, pauseOnWarning: false, awakeResetLeadMin: 45,
  });
  assert.equal(r.body.ok, true);
  r = await req(base(), 'GET', '/api/settings');
  assert.deepEqual(
    [r.body.budgetGuard, r.body.reserveFiveHourPct, r.body.reserveWeeklyPct, r.body.pauseOnWarning, r.body.awakeResetLeadMin],
    [false, 60, 90, false, 45],
  );

  for (const bad of [{ reserveFiveHourPct: 0 }, { reserveWeeklyPct: 101 }, { reserveFiveHourPct: 'lots' }, { awakeResetLeadMin: 999 }]) {
    r = await req(base(), 'PUT', '/api/settings', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  r = await req(base(), 'GET', '/api/settings');
  assert.equal(r.body.reserveFiveHourPct, 60, 'a rejected write changes nothing');
});

test('budget: explain reflects the live snapshot and the guard fails open', async (t) => {
  const hot = await bootWithUsage({ fiveHour: 88 });
  t.after(() => hot.server.close());

  let r = await req(hot.base(), 'GET', '/api/budget');
  assert.equal(r.body.enforcing, true);
  assert.equal(r.body.blocked, 'reserving 5h headroom (88% used)');

  await req(hot.base(), 'PUT', '/api/settings', { budgetGuard: false });
  r = await req(hot.base(), 'GET', '/api/budget');
  assert.equal(r.body.enforcing, false);
  assert.equal(r.body.why, 'guard is off');
  assert.equal(r.body.blocked, null);

  // A per-job question is answered against that job's own overrides.
  const created = await req(hot.base(), 'POST', '/api/jobs', jobPayload({ params: { prompt: 'p', budget: { minHeadroomPct: 50 } } }));
  await req(hot.base(), 'PUT', '/api/settings', { budgetGuard: true });
  r = await req(hot.base(), 'GET', `/api/budget?job=${created.body.id}`);
  assert.equal(r.body.blocked, 'reserving 5h headroom (88% used)');
  r = await req(hot.base(), 'GET', '/api/budget?job=nope');
  assert.equal(r.status, 404);
});

test('budget: a blocked scheduled fire is visible as skipped, with its reason', async (t) => {
  const { server, base, db, runner, spawnFn } = await bootWithUsage({ fiveHour: 90 });
  t.after(() => server.close());

  const created = await req(base(), 'POST', '/api/jobs', jobPayload());
  const job = { ...created.body };

  // A scheduled fire is refused…
  runner.start({ ...job, params: job.params }, 'schedule');
  assert.equal(spawnFn.calls.length, 0);
  let r = await req(base(), 'GET', '/api/runs');
  assert.equal(r.body.runs[0].status, 'skipped');
  assert.equal(r.body.runs[0].meta.skipReason, 'reserving 5h headroom (90% used)');

  // …and the jobs list carries the reason so the row can say why.
  r = await req(base(), 'GET', '/api/jobs');
  assert.equal(r.body.jobs[0].lastRun.status, 'skipped');
  assert.equal(r.body.jobs[0].lastRun.skipReason, 'reserving 5h headroom (90% used)');

  // …while an explicit click always goes ahead.
  r = await req(base(), 'POST', `/api/jobs/${job.id}/run`);
  assert.equal(r.body.status, 'running');
  assert.equal(spawnFn.calls.length, 1);
  spawnFn.calls[0].child.emit('close', 0);
  await sleep(30);
  assert.equal(listRuns(db, { jobId: job.id })[0].status, 'ok');
});

test('afterReset: job accepted, previewed from live resets, and armed', async (t) => {
  const { server, base, resetsAt } = await bootWithUsage({ resetsIn: 90 * 60_000 });
  t.after(() => server.close());

  const entry = { type: 'afterReset', window: 'five_hour', offsetMin: 5, jitterMin: 0 };
  let r = await req(base(), 'POST', '/api/jobs', jobPayload({ schedule: entry }));
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.schedule, entry);
  // nextFire is the computed fire time — armed against the live reset.
  assert.equal(r.body.nextFire, new Date(new Date(resetsAt).getTime() + 5 * 60_000).toISOString());

  r = await req(base(), 'POST', '/api/schedule/preview', { schedule: entry });
  assert.equal(r.body.unknown, false);
  assert.deepEqual(r.body.next, [new Date(new Date(resetsAt).getTime() + 5 * 60_000).toISOString()]);

  // A window this account doesn't report is refused rather than silently retargeted.
  r = await req(base(), 'POST', '/api/jobs', jobPayload({ schedule: { ...entry, window: 'tangelo' } }));
  assert.equal(r.status, 400);
});

test('burn-down: plan previews without writing, then materialises as once entries', async (t) => {
  const { server, base, db } = await bootWithUsage({ fiveHour: 10, resetsIn: 4 * 3600e3 });
  t.after(() => server.close());

  const created = await req(base(), 'POST', '/api/jobs', jobPayload({ enabled: false }));
  const jobId = created.body.id;
  for (let i = 0; i < 3; i++) {
    recordRunUsage(db, { runId: `r${i}`, jobId, beforePct: { five_hour: 0 }, afterPct: { five_hour: 2 } });
  }

  let r = await req(base(), 'POST', '/api/budget/plan', { window: 'five_hour', targetPct: 10, jobIds: [jobId], minGapMin: 20 });
  assert.equal(r.status, 200);
  assert.equal(r.body.slots.length, 5); // 10% / 2% per run
  assert.equal(r.body.confidence, 'high');
  const slots = r.body.slots;
  // A preview writes nothing.
  assert.deepEqual((await req(base(), 'GET', `/api/jobs/${jobId}`)).body.schedule, { type: 'cron', expr: '0 9 * * *' });

  r = await req(base(), 'POST', '/api/budget/plan/apply', { slots });
  assert.equal(r.body.added, 5);
  assert.deepEqual(r.body.enabled, ['test job'], 'a confirmed plan enables the job it plans for');
  const after = (await req(base(), 'GET', `/api/jobs/${jobId}`)).body;
  assert.equal(after.enabled, true);
  assert.equal(after.schedule.length, 6); // the original cron + 5 one-shots
  assert.equal(after.schedule.filter((s) => s.type === 'once').length, 5);

  // A plan the guard would refuse is refused at preview time instead.
  const spent = await bootWithUsage({ fiveHour: 85 });
  t.after(() => spent.server.close());
  r = await req(spent.base(), 'POST', '/api/budget/plan', { window: 'five_hour', targetPct: 10, jobIds: [jobId] });
  assert.equal(r.status, 400);
  assert.match(r.body.reason, /reserves everything past 80%/);
});

test('burn-down: apply validates its slots rather than trusting the client', async (t) => {
  const { server, base } = await bootWithUsage();
  t.after(() => server.close());
  const created = await req(base(), 'POST', '/api/jobs', jobPayload());
  const jobId = created.body.id;
  const at = new Date(Date.now() + 3600e3).toISOString();

  for (const [body, status] of [
    [{ slots: [] }, 400],
    [{ slots: [{ jobId, at: 'whenever' }] }, 400],
    // A stale preview must not silently schedule fires in the past.
    [{ slots: [{ jobId, at: '2020-01-01T00:00:00Z' }] }, 400],
    [{ slots: [{ jobId: 'ghost', at }] }, 404],
    [{ slots: Array.from({ length: 201 }, () => ({ jobId, at })) }, 400],
  ]) {
    const r = await req(base(), 'POST', '/api/budget/plan/apply', body);
    assert.equal(r.status, status, JSON.stringify(body).slice(0, 60));
  }
  // None of the rejects touched the schedule.
  assert.deepEqual((await req(base(), 'GET', `/api/jobs/${jobId}`)).body.schedule, { type: 'cron', expr: '0 9 * * *' });
});

test('usage: pending snapshot, throttled refresh, history', async (t) => {
  const { server, base, usageSpawn } = await boot();
  t.after(() => server.close());

  // Before the first probe the shape is the same, with nothing asserted in it.
  let r = await req(base(), 'GET', '/api/usage');
  assert.equal(r.body.ok, null);
  assert.equal(r.body.available, null);
  assert.deepEqual(r.body.windows, {});
  assert.equal(r.body.display, 'banner');
  assert.equal(r.body.warnPct, 80);
  assert.equal(r.body.pollSec, 180);

  const forced = req(base(), 'POST', '/api/usage/refresh');
  await answerProbe(usageSpawn);
  r = await forced;
  assert.equal(r.status, 202);
  assert.equal(r.body.windows.five_hour.percent, 37);
  assert.equal(r.body.windows.seven_day.percent, 64);
  assert.equal(r.body.buckets.length, 3);
  assert.equal(r.body.subscriptionType, 'team');
  assert.equal(r.body.stale, false);

  // A refresh button must not become a way to hammer the endpoint the poll
  // floor exists to protect — but the caller still gets the current reading.
  r = await req(base(), 'POST', '/api/usage/refresh');
  assert.equal(r.status, 429);
  assert.ok(r.body.retryAfterSec >= 1 && r.body.retryAfterSec <= 5);
  assert.equal(r.body.windows.five_hour.percent, 37);
  assert.equal(usageSpawn.calls.length, 1, 'no second probe');

  r = await req(base(), 'GET', '/api/usage/history?limit=5');
  assert.equal(r.body.snapshots.length, 1);
  assert.equal(r.body.snapshots[0].ok, true);
  assert.equal(r.body.snapshots[0].windows.five_hour.percent, 37);
});

test('usage: a manual run records its delta and cleanup wipes the history', async (t) => {
  const { db, base, server, spawnFn, usageSpawn, runner } = await boot();
  t.after(() => server.close());

  const forced = req(base(), 'POST', '/api/usage/refresh');
  await answerProbe(usageSpawn);
  await forced;

  const job = (await req(base(), 'POST', '/api/jobs', jobPayload())).body;
  const run = (await req(base(), 'POST', `/api/jobs/${job.id}/run`)).body;
  const recorded = new Promise((r) => runner.events.once(`usage:${run.id}`, r));
  spawnFn.calls[0].child.emit('close', 0);
  const after = { ...USAGE_PAYLOAD, rate_limits: { ...USAGE_PAYLOAD.rate_limits, five_hour: { utilization: 39, resets_at: '2026-07-25T00:20:00Z' } } };
  await answerProbe(usageSpawn, after);
  assert.deepEqual((await recorded).deltaPct, { five_hour: 2, seven_day: 0 });

  assert.ok((await req(base(), 'GET', '/api/usage/history')).body.snapshots.length >= 2);
  await req(base(), 'POST', '/api/cleanup');
  assert.deepEqual((await req(base(), 'GET', '/api/usage/history')).body.snapshots, []);
  assert.equal(getSetting(db, 'usageShow', 'banner'), 'banner', 'settings survive cleanup');
});

test('awake endpoints: modes, timed validation, caffeinate lifecycle', async (t) => {
  const { server, base, caffSpawn } = await boot();
  t.after(() => server.close());

  let r = await req(base(), 'GET', '/api/awake');
  assert.deepEqual(r.body, { mode: 'off', until: null, active: false });

  r = await req(base(), 'PUT', '/api/awake', { mode: 'on' });
  assert.deepEqual(r.body, { mode: 'on', until: null, active: true });
  assert.equal(caffSpawn.calls[0].cmd, 'caffeinate');
  assert.deepEqual(caffSpawn.calls[0].args, ['-i', '-w', String(process.pid)]);

  r = await req(base(), 'PUT', '/api/awake', { mode: 'off' });
  assert.deepEqual(r.body, { mode: 'off', until: null, active: false });
  assert.equal(caffSpawn.calls[0].child.killedWith, 'SIGTERM');

  r = await req(base(), 'PUT', '/api/awake', { mode: 'timed', minutes: 60 });
  assert.equal(r.body.mode, 'timed');
  assert.ok(new Date(r.body.until) > new Date());
  assert.equal(r.body.active, true);

  r = await req(base(), 'PUT', '/api/awake', { mode: 'timed' }); // minutes required
  assert.equal(r.status, 400);
  r = await req(base(), 'PUT', '/api/awake', { mode: 'bogus' });
  assert.equal(r.status, 400);

  // auto: no enabled jobs+no runs → inactive; job with future fire → active
  r = await req(base(), 'PUT', '/api/awake', { mode: 'auto' });
  assert.equal(r.body.active, false);
  await req(base(), 'POST', '/api/jobs', jobPayload());
  r = await req(base(), 'GET', '/api/awake');
  assert.equal(r.body.active, true);
});

test('cleanup wipes jobs+runs, keeps settings; uninstall fires hook', async (t) => {
  const { db, spawnFn, server, base, uninstalls } = await boot();
  t.after(() => server.close());

  await req(base(), 'PUT', '/api/settings', { extensions: { claude: { maxConcurrent: 3 } } });
  const { body: job } = await req(base(), 'POST', '/api/jobs', jobPayload());
  await req(base(), 'POST', `/api/jobs/${job.id}/run`);
  spawnFn.calls[0].child.emit('close', 0);
  await sleep(30);

  let r = await req(base(), 'POST', '/api/cleanup');
  assert.equal(r.body.ok, true);
  r = await req(base(), 'GET', '/api/jobs');
  assert.equal(r.body.jobs.length, 0);
  assert.equal(listRuns(db).length, 0);
  assert.equal(getSetting(db, 'maxConcurrent'), '3');

  r = await req(base(), 'POST', '/api/uninstall');
  assert.equal(r.status, 202);
  assert.equal(uninstalls.length, 1);
});

test('removalScript removes plist + data but NEVER deletes the tool dir', () => {
  const s = removalScript({ toolDir: '/x/tool', data: '/y/data' });
  assert.ok(s.includes('launchctl bootout'));
  assert.ok(s.includes('com.claude-scheduler.plist'));
  assert.ok(s.includes('rm -rf "/y/data"'));
  // Source tree must be preserved — the tool dir is only mentioned, not rm -rf'd.
  assert.ok(!/rm -rf "?\/x\/tool"?/.test(s), 'must not rm -rf the tool dir');
  assert.ok(s.includes('/x/tool'), 'should print the tool dir for manual removal');
});
