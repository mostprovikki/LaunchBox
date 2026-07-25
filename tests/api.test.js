import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { tmpData, jobPayload, fakeSpawn, fakeBd, bdReadyRow, sleep, extensions } from './helpers.js';
import { ensureDirs } from '../lib/paths.js';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import {
  openDb, listRuns, getSetting, setSetting, recordRunUsage,
  createProject, getProject, acquireLease, listJobsByProject, createJob, getJob, findJobByBead,
} from '../lib/db.js';
import { createBeads } from '../lib/beads.js';
import { createProjects } from '../lib/projects.js';
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
    // Task sources (M4a). All four ship empty/unpinned: no roots means discovery
    // has nowhere to look, and no worktreeRoot means work runs in the repo itself
    // — both are deliberate defaults a human has to opt out of.
    projectRoots: '',
    beadsPollSec: 60,
    bdPath: 'bd',
    worktreeRoot: '',
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

// A bead's job row is disabled on purpose so only its project can launch it —
// with a lease, a claim, and a close that only happens on an asserted completion.
// The burn-down planner force-enables every job in a confirmed plan, so before
// this it could arm a bead row and have the cron scheduler fire it with none of
// those three, racing the poller for the same bead.
test('burn-down: a bead-backed job row cannot be planned or armed', async (t) => {
  const { server, base, db } = await bootWithUsage({ fiveHour: 10, resetsIn: 4 * 3600e3 });
  t.after(() => server.close());

  // Built the way materialise() builds it: directly, because validateFields drops
  // unknown params keys, so `_beadId` cannot survive the public POST /api/jobs.
  const bead = createJob(db, {
    name: 'proj: do the thing',
    type: 'claude',
    params: { prompt: 'work on sp-1', permMode: 'acceptEdits', _beadId: 'sp-1', _projectId: 'p1' },
    schedule: { type: 'once', at: new Date().toISOString() },
    enabled: false,
    cwd: tmpdir(),
  });
  const ordinary = (await req(base(), 'POST', '/api/jobs', jobPayload())).body;

  // Preview refuses, and says why rather than returning an empty plan.
  let r = await req(base(), 'POST', '/api/budget/plan', { window: 'five_hour', targetPct: 10, jobIds: [bead.id] });
  assert.equal(r.status, 400);
  assert.match(r.body.reason, /bead-backed jobs cannot be planned/);

  // Mixed in with a legitimate job it still refuses — rejecting wholesale rather
  // than quietly planning for one of the two jobs the user picked.
  r = await req(base(), 'POST', '/api/budget/plan', { window: 'five_hour', targetPct: 10, jobIds: [ordinary.id, bead.id] });
  assert.equal(r.status, 400);

  // And apply() is checked independently of preview: this is the call that enables.
  const at = new Date(Date.now() + 3600e3).toISOString();
  r = await req(base(), 'POST', '/api/budget/plan/apply', { slots: [{ jobId: bead.id, at }] });
  assert.equal(r.status, 400);
  assert.match(r.body.errors[0], /bead-backed jobs cannot be planned/);

  // The row is untouched: still disabled, still carrying only its spent one-shot.
  const after = getJob(db, bead.id);
  assert.equal(after.enabled, false, 'a refused plan must not enable a bead row');
  assert.equal(after.schedule.type, 'once');
  // The sharper consequence, and the reason this is permanent rather than
  // self-healing: apply() round-trips the row through validateJob, and
  // validateFields drops keys the extension doesn't declare — so an applied plan
  // strips `_beadId`, detaching the row from its bead. findJobByBead then stops
  // matching, so the poller can no longer heal or reuse the row: it mints a second
  // one and loses the cost history, while the orphan keeps firing the bead's
  // prompt with no lease, claim or close. Reproduced live before fixing.
  assert.equal(after.params._beadId, 'sp-1', 'the row must stay attached to its bead');
  assert.equal(after.params._projectId, 'p1');
  assert.ok(findJobByBead(db, 'p1', 'sp-1'), 'the poller must still be able to find this row');

  // A slot list that hides the bead behind a valid job must not be applied in part.
  r = await req(base(), 'POST', '/api/budget/plan/apply', { slots: [{ jobId: ordinary.id, at }, { jobId: bead.id, at }] });
  assert.equal(r.status, 400);
  assert.equal(getJob(db, ordinary.id).enabled, true, 'the ordinary job was created enabled');
  assert.deepEqual((await req(base(), 'GET', `/api/jobs/${ordinary.id}`)).body.schedule, { type: 'cron', expr: '0 9 * * *' },
    'the valid half of a rejected plan must not be armed');
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

// --- M4a: project task sources ---------------------------------------------
// Two safety properties run through every test below, and both were decided
// rather than inherited: `autoLabel` is an opt-in a repo has to declare, and only
// a human may activate a project. Everything else here is the third measured
// property — busy is not broken.

const BD_VERSION = 'bd version 1.1.0 (Homebrew)';
const PROJECT_CONFIG = {
  autoLabel: 'unattended', enabled: true, cwd: '.', maxConcurrent: 1,
  defaults: { timeoutMin: 30, model: 'default', notify: 'failure' },
};

// `boot()` deliberately wires no projects/beads engine — that is what the 501
// contract test below asserts on — so the rest of this section boots its own app
// with the real engine behind a fake `bd`. No test may shell out to the real
// binary, same rule as "no test spawns the real claude".
async function bootWithProjects({ handlers = {}, fsx = null } = {}) {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const spawnFn = fakeSpawn();
  const bd = fakeBd({
    '--version': { stdout: BD_VERSION },
    // A healthy repo: `database_path` present is what distinguishes a real beads
    // dir from the hollow `.beads/` a git worktree carries.
    where: { stdout: JSON.stringify({ path: '/repo/.beads', database_path: '/repo/.beads/embeddeddolt' }) },
    ...handlers,
  });
  const beads = createBeads({ db, execFileFn: bd });
  const runner = createRunner({ db, extensions, spawnFn, notifyFn: () => {} });
  const scheduler = createScheduler({ db, runner });
  const projects = createProjects({
    db,
    beads,
    runner,
    // Discovery reads the filesystem through this seam, so a test says what is
    // out there instead of depending on whatever happens to be on this machine.
    fsx: fsx ?? { readdir: async () => [], readFile: async () => { throw new Error('ENOENT'); } },
  });
  const app = createApp({ db, runner, scheduler, extensions, awake: null, projects, beads });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return {
    db, bd, beads, runner, projects, spawnFn, server,
    base: () => `http://127.0.0.1:${server.address().port}`,
    close() { projects.stop(); server.close(); },
  };
}

// POST /api/projects reads the declaration with the un-injectable readFileSync /
// statSync — deliberately, since "does this path really exist" is the question it
// is answering — so that one route needs a real directory.
function repoDir(config) {
  const dir = mkdtempSync(join(tmpdir(), 'cs-proj-'));
  if (config !== null) {
    writeFileSync(join(dir, '.scheduler.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return dir;
}

test('projects: every route answers 501 with no engine wired — except the list', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());

  // 501, not 404: the routes exist, the engine behind them was not passed in. An
  // embedder calling createApp directly should be told the feature is absent
  // rather than that it typed the URL wrong.
  for (const [method, path, body] of [
    ['POST', '/api/projects', { path: '/x' }],
    ['POST', '/api/projects/discover', null],
    ['PUT', '/api/projects/abc', { state: 'active' }],
    ['DELETE', '/api/projects/abc', null],
    ['GET', '/api/projects/abc/ready', null],
    ['POST', '/api/projects/abc/poll', null],
  ]) {
    const r = await req(base(), method, path, body);
    assert.equal(r.status, 501, `${method} ${path}`);
  }

  // The list is the exception on purpose: the Projects tab has to render before
  // anything is registered, and a 501 here would mean it could not draw at all.
  const r = await req(base(), 'GET', '/api/projects');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.projects, []);
});

test('discovery registers pending only, and re-discovery never resurrects state', async (t) => {
  const declared = {
    '/roots/repoA': { autoLabel: 'unattended' },
    '/roots/repoB': { autoLabel: 'nightly' },
  };
  const p = await bootWithProjects({
    fsx: {
      readdir: async () => [
        { name: 'repoA', isDirectory: () => true },
        { name: 'repoB', isDirectory: () => true },
        { name: 'notes.md', isDirectory: () => false },
      ],
      readFile: async (path) => JSON.stringify(declared[dirname(path)]),
    },
  });
  t.after(() => p.close());
  await req(p.base(), 'PUT', '/api/settings', { projectRoots: '/roots' });

  let r = await req(p.base(), 'POST', '/api/projects/discover');
  assert.equal(r.status, 200);
  // Finding a repo is not consent to run it. If discovery could write anything
  // else, an agent that can write `.scheduler.json` could arrange for unattended
  // work to run on this machine — the one thing the airlock exists to prevent.
  assert.deepEqual(r.body.found.map((f) => f.project.state), ['pending', 'pending']);
  assert.deepEqual(r.body.found.map((f) => f.project.name).sort(), ['repoA', 'repoB']);

  // A human decides "not now" for one of them…
  const repoA = r.body.found.find((f) => f.project.name === 'repoA').project;
  r = await req(p.base(), 'PUT', `/api/projects/${repoA.id}`, { state: 'paused' });
  assert.equal(r.body.project.state, 'paused');

  // …and the next scan must not undo that. Re-discovery refreshes the
  // declaration and touches nothing else; if it wrote state, a background scan
  // would silently re-arm a project someone switched off.
  declared['/roots/repoA'] = { autoLabel: 'changed-label' };
  r = await req(p.base(), 'POST', '/api/projects/discover');
  const again = r.body.found.find((f) => f.project.id === repoA.id).project;
  assert.equal(again.state, 'paused', 'not back to pending, and certainly not active');
  assert.equal(again.config.autoLabel, 'changed-label', 'the declaration is refreshed, the state is not');
  const states = (await req(p.base(), 'GET', '/api/projects')).body.projects.map((x) => x.state).sort();
  assert.deepEqual(states, ['paused', 'pending'], 'no route made anything active');
});

test('discover with no projectRoots names the setting to fix', async (t) => {
  const p = await bootWithProjects();
  t.after(() => p.close());

  // Empty roots is the shipped default, so this is the first thing a new user
  // hits — an error that doesn't say where to look would strand them.
  const r = await req(p.base(), 'POST', '/api/projects/discover');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /projectRoots/);
});

test('POST /api/projects registers pending — a payload cannot activate anything', async (t) => {
  const p = await bootWithProjects();
  t.after(() => p.close());
  const dir = repoDir({ autoLabel: 'unattended' });

  // The body asks for `active`. Registration is not activation: `state` is not
  // read from the body at all, so no single call can register-and-arm a repo.
  let r = await req(p.base(), 'POST', '/api/projects', { path: dir, state: 'active' });
  assert.equal(r.status, 201);
  assert.equal(r.body.project.state, 'pending');
  assert.deepEqual(r.body.errors, []);
  assert.equal(r.body.project.path, dir);

  // One repo, one registration — two rows would mean two leases and two job rows
  // for the same bead.
  r = await req(p.base(), 'POST', '/api/projects', { path: dir });
  assert.equal(r.status, 409);

  r = await req(p.base(), 'POST', '/api/projects', { path: join(dir, 'nope') });
  assert.equal(r.status, 400);
  r = await req(p.base(), 'POST', '/api/projects', {});
  assert.equal(r.status, 400);

  // A repo that has not declared itself is not a project. The message has to name
  // the file, because writing it is the entire fix.
  r = await req(p.base(), 'POST', '/api/projects', { path: repoDir(null) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /\.scheduler\.json/);
});

test('a config with no autoLabel registers, reports the error, and offers no beads', async (t) => {
  const p = await bootWithProjects({
    // bd has ready work to hand over. None of it may reach the client: a missing
    // autoLabel means "nothing is eligible", never "everything is".
    handlers: { ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) } },
  });
  t.after(() => p.close());

  let r = await req(p.base(), 'POST', '/api/projects', { path: repoDir({ enabled: true }) });
  assert.equal(r.status, 201, 'registering is still useful — the tab can then say what is wrong');
  assert.ok(r.body.errors.length);
  assert.match(r.body.project.configErrors.join(' '), /autoLabel/);

  r = await req(p.base(), 'GET', `/api/projects/${r.body.project.id}/ready`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.beads, [], 'no opt-in label means no eligible work, not all of it');
  assert.equal(r.body.autoLabel, null);
  assert.match(r.body.reasons.join(' '), /autoLabel/, 'contributing nothing must never be silent');
});

test('PUT /api/projects/:id is the airlock: active|paused and nothing else', async (t) => {
  const p = await bootWithProjects();
  t.after(() => p.close());
  const proj = createProject(p.db, {
    name: 'repo', path: '/repo', state: 'pending', config: PROJECT_CONFIG, beadsDir: '/repo/.beads',
  });

  let r = await req(p.base(), 'PUT', `/api/projects/${proj.id}`, { state: 'active' });
  assert.equal(r.status, 200);
  assert.equal(r.body.project.state, 'active');
  r = await req(p.base(), 'PUT', `/api/projects/${proj.id}`, { state: 'paused' });
  assert.equal(r.status, 200);
  assert.equal(r.body.project.state, 'paused');

  // `pending` is discovery's word and `error` is the poller's. A client able to
  // write them could hide a broken project, or make an un-reviewed one look as
  // though it had been through the airlock.
  for (const body of [{ state: 'pending' }, { state: 'error' }, {}, { state: 'nonsense' }]) {
    r = await req(p.base(), 'PUT', `/api/projects/${proj.id}`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(getProject(p.db, proj.id).state, 'paused', 'a rejected write changes nothing');

  r = await req(p.base(), 'PUT', '/api/projects/ghost', { state: 'active' });
  assert.equal(r.status, 404);
});

test('GET /api/projects carries bd version, roots, pollSec and the audit note', async (t) => {
  const p = await bootWithProjects();
  t.after(() => p.close());
  await req(p.base(), 'PUT', '/api/settings', { projectRoots: '/roots/one\n/roots/two', beadsPollSec: 120 });

  const r = await req(p.base(), 'GET', '/api/projects');
  // Which bd we are talking to is a fact the tab has to show: bd shipped a
  // breaking change inside a year, so "some bd on PATH" is not an answer.
  assert.equal(r.body.bd.version, BD_VERSION);
  assert.equal(r.body.bd.error, null);
  assert.deepEqual(r.body.roots, ['/roots/one', '/roots/two']);
  assert.equal(r.body.pollSec, 120, 'the live interval, not the default');
  // Decision (b): `bd close` appends to a git-tracked `interactions.jsonl` and
  // that cannot be suppressed. The tab is required to say so up front, so the API
  // has to supply the words — a completed task must not look like the scheduler
  // went rogue in someone's repo.
  assert.ok(r.body.auditNote.length);
  assert.match(r.body.auditNote, /interactions\.jsonl/);
});

test(':id/ready returns our normalised shape and filters to autoLabel', async (t) => {
  const p = await bootWithProjects({
    handlers: {
      // The label filter is repeated in JS on top of `bd --label`, so this fake
      // hands back everything and the filtering under test is ours.
      ready: { stdout: JSON.stringify([
        bdReadyRow({ id: 'sp-bare' }), // measured 1.1.0: NO `labels` key at all
        bdReadyRow({ id: 'sp-other', labels: ['docs'] }),
        bdReadyRow({ id: 'sp-ok', labels: ['unattended'] }),
      ]) },
    },
  });
  t.after(() => p.close());
  const proj = createProject(p.db, {
    name: 'repo', path: '/repo', state: 'active', config: PROJECT_CONFIG, beadsDir: '/repo/.beads',
  });

  const r = await req(p.base(), 'GET', `/api/projects/${proj.id}/ready`);
  assert.equal(r.status, 200);
  // `sp-bare` is the trap: `labels.includes(...)` on a row with no labels key
  // throws, and that filter is the gate deciding what may run unattended — so it
  // must exclude the row, not blow up the request.
  assert.deepEqual(r.body.beads.map((b) => b.id), ['sp-ok']);
  assert.equal(r.body.beads[0].type, 'task', 'our shape — bd calls this issue_type');
  assert.ok(!('issue_type' in r.body.beads[0]), 'bd\'s shape must not leak past the adapter');
  assert.deepEqual(r.body.beads[0].labels, ['unattended']);
  assert.equal(r.body.autoLabel, 'unattended');
  assert.equal(r.body.busy, false);
});

test('a busy beads database is reported as busy, not as broken', async (t) => {
  const p = await bootWithProjects({ handlers: { where: { timeout: true } } });
  t.after(() => p.close());
  const proj = createProject(p.db, {
    name: 'repo', path: '/repo', state: 'active', config: PROJECT_CONFIG, beadsDir: '/repo/.beads',
  });

  const r = await req(p.base(), 'GET', `/api/projects/${proj.id}/ready`);
  // Contention is the common case — a human running bd in the same repo. A 4xx/5xx
  // here would show a working repo as failing every time someone opened a terminal.
  assert.equal(r.status, 200);
  assert.equal(r.body.busy, true);
  assert.ok(r.body.reasons.length, 'and it says so rather than looking empty');
  assert.deepEqual(r.body.beads, []);
  assert.equal(getProject(p.db, proj.id).state, 'active', 'busy must never latch a project into error');
});

test('a real bd failure on ready is a 502, not an empty list', async (t) => {
  const p = await bootWithProjects({
    // `where` is fine, so the project is healthy and this is bd genuinely failing
    // — distinct from busy, and it must not be dressed up as "nothing is ready".
    handlers: { ready: { code: 1, stderr: 'Error: database is corrupt\n' } },
  });
  t.after(() => p.close());
  const proj = createProject(p.db, {
    name: 'repo', path: '/repo', state: 'active', config: PROJECT_CONFIG, beadsDir: '/repo/.beads',
  });

  const r = await req(p.base(), 'GET', `/api/projects/${proj.id}/ready`);
  assert.equal(r.status, 502);
  assert.match(r.body.error, /corrupt/);
});

test('DELETE refuses while a bead is leased, and force overrides', async (t) => {
  const p = await bootWithProjects();
  t.after(() => p.close());
  const proj = createProject(p.db, {
    name: 'repo', path: '/repo', state: 'active', config: PROJECT_CONFIG, beadsDir: '/repo/.beads',
  });
  acquireLease(p.db, { projectId: proj.id, beadId: 'sp-1' });

  // A held lease means a bead of this project is running right now. Silently
  // un-registering would orphan that run — so name it and let the human decide.
  let r = await req(p.base(), 'DELETE', `/api/projects/${proj.id}`);
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.held, ['sp-1']);
  assert.ok(getProject(p.db, proj.id), 'the refusal changed nothing');

  r = await req(p.base(), 'DELETE', `/api/projects/${proj.id}`, { force: true });
  assert.equal(r.status, 200);
  assert.equal(getProject(p.db, proj.id), null);
  assert.deepEqual((await req(p.base(), 'GET', '/api/projects')).body.projects, []);
});

test('DELETE clears the bead job rows it materialised rather than orphaning them', async (t) => {
  const p = await bootWithProjects({
    handlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      update: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', assignee: 'scheduler' })]) },
    },
  });
  t.after(() => p.close());
  const proj = createProject(p.db, {
    name: 'repo', path: '/repo', state: 'active', config: PROJECT_CONFIG, beadsDir: '/repo/.beads',
  });

  let r = await req(p.base(), 'POST', `/api/projects/${proj.id}/poll`);
  assert.equal(r.status, 200);
  assert.equal(r.body.started.length, 1, 'an active project really does materialise a job');
  assert.equal(listJobsByProject(p.db, proj.id).length, 1);

  // §4a.7 keeps one job row per bead across runs so learned cost accumulates,
  // which is exactly why un-registering has to clear them deliberately —
  // otherwise the Jobs list keeps rows pointing at a project id that no longer
  // resolves, and nothing will ever tidy them up.
  r = await req(p.base(), 'DELETE', `/api/projects/${proj.id}`, { force: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.removedJobs, 1, 'and it reports what it removed');
  assert.deepEqual(listJobsByProject(p.db, proj.id), []);
  assert.deepEqual((await req(p.base(), 'GET', '/api/jobs')).body.jobs, []);
});

test('polling a pending project does nothing and says why', async (t) => {
  const p = await bootWithProjects({
    // There is eligible, labelled, ready work waiting. It must still not run.
    handlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      update: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', assignee: 'scheduler' })]) },
    },
  });
  t.after(() => p.close());
  const proj = createProject(p.db, {
    name: 'repo', path: '/repo', state: 'pending', config: PROJECT_CONFIG, beadsDir: '/repo/.beads',
  });

  const r = await req(p.base(), 'POST', `/api/projects/${proj.id}/poll`);
  assert.equal(r.status, 200);
  assert.equal(r.body.skipped, true);
  assert.match(r.body.reasons.join(' '), /activate/, 'the reason is the fix');
  assert.deepEqual(r.body.started, []);
  // Poll-now is a human clicking a button, so it is allowed to start runs on an
  // *active* project — but it must not be a back door around activation.
  assert.equal(p.spawnFn.calls.length, 0);
  assert.equal(getProject(p.db, proj.id).state, 'pending', 'and it activates nothing as a side effect');
  assert.equal((await req(p.base(), 'GET', '/api/runs')).body.runs.length, 0);

  const missing = await req(p.base(), 'POST', '/api/projects/ghost/poll');
  assert.equal(missing.status, 404);
});

test('settings: task-source keys round-trip and reject a worktreeRoot inside a repo', async (t) => {
  const p = await bootWithProjects();
  t.after(() => p.close());

  let r = await req(p.base(), 'PUT', '/api/settings', {
    projectRoots: '/roots/a\n/roots/b',
    beadsPollSec: 300,
    bdPath: '/opt/homebrew/bin/bd',
    worktreeRoot: '/tmp/cs-worktrees',
  });
  assert.equal(r.status, 200);
  r = await req(p.base(), 'GET', '/api/settings');
  assert.equal(r.body.projectRoots, '/roots/a\n/roots/b');
  assert.equal(r.body.beadsPollSec, 300);
  assert.equal(r.body.bdPath, '/opt/homebrew/bin/bd', 'which binary we talk to is pinned, not looked up');
  assert.equal(r.body.worktreeRoot, '/tmp/cs-worktrees');

  // Every poll is a blocking bd call per project, so the floor is not the
  // client's to lower — and an interval past an hour is not a poller.
  for (const bad of [5, 4000, 'often']) {
    r = await req(p.base(), 'PUT', '/api/settings', { beadsPollSec: bad });
    assert.equal(r.status, 400, String(bad));
  }
  assert.equal((await req(p.base(), 'GET', '/api/settings')).body.beadsPollSec, 300, 'a rejected write changes nothing');

  // The spike measured this: a worktree created under the primary checkout shows
  // up as `?? .worktrees/` in the human's `git status` — littering the very
  // checkout the worktree exists to keep clean.
  createProject(p.db, { name: 'repo', path: '/repo', state: 'active', config: PROJECT_CONFIG });
  r = await req(p.base(), 'PUT', '/api/settings', { worktreeRoot: '/repo/.worktrees' });
  assert.equal(r.status, 400);
  assert.match(r.body.errors.join(' '), /outside every registered repo/);
  assert.equal((await req(p.base(), 'GET', '/api/settings')).body.worktreeRoot, '/tmp/cs-worktrees');
});
