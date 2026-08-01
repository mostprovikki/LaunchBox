// C1a (claude-scheduler-btv.2): GET /api/v2/overview — the one additive
// aggregation endpoint the /v2 Overview tab (C1, btv.8) is built against.
// These tests ARE the contract: C1 reads this file, not the mockups, to know
// what shape it can rely on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { tmpData, validJob, extensions, fakeSpawn } from './helpers.js';
import { ensureDirs } from '../lib/paths.js';
import { ensureToken } from '../lib/token.js';
import {
  openDb, createJob, insertRun, updateRun, createProject, updateProject,
} from '../lib/db.js';
import { createRunner } from '../lib/runner.js';
import { createScheduler } from '../lib/scheduler.js';
import { createPauseController } from '../lib/pause.js';
import { createBudgetPolicy } from '../lib/budget.js';
import { previewSchedule } from '../lib/validate.js';
import { createApp } from '../server.js';

let currentToken = null;

async function req(base, method, path, body, { token = currentToken } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

// A usage monitor stand-in whose snapshot is exactly what the test hands it —
// deterministic headroom numbers without spawning the real `claude` probe.
// Mirrors tests/api.test.js's bootWithUsage stub.
function usageStub(snap) {
  return {
    events: new EventEmitter(),
    snapshot: () => snap,
    window: (n) => snap?.windows?.[n] ?? null,
    status: () => ({ running: false, pollSec: 180, nextPollAt: null }),
    refresh: async () => snap,
  };
}

async function boot({ snap = null, projects = null, beads = null } = {}) {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const spawnFn = fakeSpawn();
  const usage = usageStub(snap);
  const budget = createBudgetPolicy({ db, usage });
  let pause = null;
  const runner = createRunner({
    db, extensions, spawnFn, notifyFn: () => {}, usage,
    admit: (job, trigger, opts) => pause?.gate(job, trigger, opts) ?? budget.admit(job, trigger, opts),
  });
  pause = createPauseController({ db, runner });
  const scheduler = createScheduler({ db, runner, usage, pause });
  currentToken = ensureToken();
  const app = createApp({
    db, runner, scheduler, extensions, awake: null, usage, budget, pause, projects, beads,
    token: currentToken,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = () => `http://127.0.0.1:${server.address().port}`;
  return { db, dir, usage, budget, pause, scheduler, server, base };
}

const FIVE_MIN_CRON = '*/5 * * * *';

test('GET /api/v2/overview requires the bearer token', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());
  const r = await req(base(), 'GET', '/api/v2/overview', null, { token: '' });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'token_invalid');
  // The right key works — proves the 401 above was really the token gate, not
  // a route that doesn't exist (which would also be a 401 from nothing... no,
  // it would 404). Belt and braces for the "nobody later mounts it outside the
  // gate" guarantee this test exists for.
  const ok = await req(base(), 'GET', '/api/v2/overview');
  assert.equal(ok.status, 200);
});

test('every top-level section is present, and headroom/next24h carry their OWN as-of, not one global timestamp', async (t) => {
  const past = new Date(Date.now() - 5 * 60_000).toISOString();
  const resetsAt = new Date(Date.now() + 3 * 3600_000).toISOString();
  const snap = {
    capturedAt: past, checkedAt: past, ok: true, error: null, stale: false, available: true,
    subscriptionType: 'max', windows: { five_hour: { percent: 37, resetsAt }, seven_day: { percent: 64, resetsAt } },
    buckets: [],
  };
  const { server, base } = await boot({ snap });
  t.after(() => server.close());

  const r = await req(base(), 'GET', '/api/v2/overview');
  assert.equal(r.status, 200);
  const b = r.body;
  for (const key of ['pause', 'headroom', 'attention', 'next24h', 'running', 'today', 'automation']) {
    assert.ok(key in b, `response must carry a top-level "${key}"`);
  }
  // headroom's as-of is the usage poll's OWN checkedAt...
  assert.equal(b.headroom.asOf, past, 'headroom.asOf must be the usage snapshot\'s own checkedAt');
  // ...which must differ from next24h's as-of (a live, request-time read) —
  // proving the endpoint does not stamp every section with one shared "now".
  assert.notEqual(b.headroom.asOf, b.next24h.asOf);
  assert.ok('asOf' in b.attention && 'asOf' in b.running && 'asOf' in b.today);
});

test('usage unreadable produces an explicit "unknown" window, never a 0% that would render as healthy', async (t) => {
  const failSnap = {
    capturedAt: null, checkedAt: null, ok: false, error: 'probe timed out after 60000ms',
    available: false, subscriptionType: null, windows: {}, buckets: [],
  };
  const { server, base } = await boot({ snap: failSnap });
  t.after(() => server.close());

  const r = await req(base(), 'GET', '/api/v2/overview');
  assert.equal(r.body.headroom.available, false);
  assert.equal(r.body.headroom.asOf, null);
  const fiveHour = r.body.headroom.windows.find((w) => w.key === 'five_hour');
  assert.equal(fiveHour.unknown, true, 'no reading at all must mark the window unknown');
  assert.equal(fiveHour.percent, null, 'must be null, not 0 — a 0 renders as a healthy meter');
  // Fails open: the guard must say so in `why`, not silently report enforcing.
  assert.equal(r.body.headroom.guard.enforcing, false);
  assert.ok(r.body.headroom.guard.why, 'guard.why must explain the fail-open, not be empty');
});

test('budget reserve percentages come from settings, not a hardcoded number', async (t) => {
  const resetsAt = new Date(Date.now() + 3 * 3600_000).toISOString();
  const snap = {
    capturedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), ok: true, error: null,
    stale: false, available: true, subscriptionType: 'max',
    windows: { five_hour: { percent: 10, resetsAt }, seven_day: { percent: 10, resetsAt } }, buckets: [],
  };
  const { server, base } = await boot({ snap });
  t.after(() => server.close());

  const put = await req(base(), 'PUT', '/api/settings', { reserveFiveHourPct: 55 });
  assert.equal(put.status, 200);
  const r = await req(base(), 'GET', '/api/v2/overview');
  const fiveHour = r.body.headroom.windows.find((w) => w.key === 'five_hour');
  assert.equal(fiveHour.reservePct, 55);
});

test('pause suppression: Hold flags next-24h fires not-admitted, with the mode named', async (t) => {
  const { server, base, db, scheduler } = await boot();
  t.after(() => server.close());

  const job = createJob(db, validJob({ name: 'ticker', schedule: { type: 'cron', expr: FIVE_MIN_CRON } }));
  scheduler.reload(job.id);

  // Off first: the fire must be admitted and pause must not be named.
  let r = await req(base(), 'GET', '/api/v2/overview');
  let fire = r.body.next24h.fires.find((f) => f.jobId === job.id);
  assert.ok(fire, 'the job\'s next fire must appear in next24h.fires');
  assert.equal(fire.admitted, true);
  assert.equal(fire.blockedBy.pause, null);
  assert.equal(r.body.next24h.suppressedByPause, false);

  const setPause = await req(base(), 'PUT', '/api/pause', { mode: 'hold' });
  assert.equal(setPause.status, 200);

  r = await req(base(), 'GET', '/api/v2/overview');
  assert.equal(r.body.next24h.pauseMode, 'hold');
  assert.equal(r.body.next24h.suppressedByPause, true);
  fire = r.body.next24h.fires.find((f) => f.jobId === job.id);
  assert.ok(fire, 'the fire must still be LISTED while held, per REVIEW.md #1 — not hidden');
  assert.equal(fire.admitted, false, 'but flagged not-admitted');
  assert.deepEqual(fire.blockedBy.pause, { mode: 'hold' }, 'the mode must be named, not just a boolean');
});

test('next-fire times come from previewSchedule (the shared parser), not a second implementation', async (t) => {
  const { server, base, db, scheduler } = await boot();
  t.after(() => server.close());

  const job = createJob(db, validJob({ name: 'five-minutely', schedule: { type: 'cron', expr: FIVE_MIN_CRON } }));
  scheduler.reload(job.id);

  const expected = previewSchedule(job.schedule, 1, { windows: null, jobId: job.id });
  const r = await req(base(), 'GET', '/api/v2/overview');
  const fire = r.body.next24h.fires.find((f) => f.jobId === job.id);
  assert.ok(fire);
  assert.equal(fire.at, expected.next[0], 'the endpoint\'s fire time must be exactly what previewSchedule computes for this schedule');
});

test('needs-attention: a skip reason is decoded into structured data, not left as an English sentence to re-parse', async (t) => {
  const { server, base, db } = await boot();
  t.after(() => server.close());

  const job = createJob(db, validJob({ name: 'backup' }));
  const run = insertRun(db, { jobId: job.id, status: 'skipped', trigger: 'schedule' });
  updateRun(db, run.id, {
    finishedAt: new Date().toISOString(),
    meta: JSON.stringify({ skipReason: 'reserving 5h headroom (82% used)' }),
  });

  const r = await req(base(), 'GET', '/api/v2/overview');
  const item = r.body.attention.items.find((i) => i.jobId === job.id);
  assert.ok(item, 'the skipped run must surface as a needs-attention item');
  assert.equal(item.kind, 'skipped');
  assert.deepEqual(item.reason, {
    code: 'reserve', windowLabel: '5h', usedPct: 82, message: 'reserving 5h headroom (82% used)',
  });
});

test('needs-attention: consecutive timeouts are counted as a streak', async (t) => {
  const { server, base, db } = await boot();
  t.after(() => server.close());

  const job = createJob(db, validJob({ name: 'flaky' }));
  for (let i = 0; i < 3; i++) {
    const run = insertRun(db, { jobId: job.id, status: 'timeout', trigger: 'schedule' });
    updateRun(db, run.id, { finishedAt: new Date(Date.now() - (2 - i) * 1000).toISOString() });
  }

  const r = await req(base(), 'GET', '/api/v2/overview');
  const item = r.body.attention.items.find((i) => i.jobId === job.id);
  assert.ok(item);
  assert.equal(item.kind, 'timeout');
  assert.equal(item.reason.streak, 3, 'three timeouts in a row must count as a streak of 3');
});

test('running now: identity and elapsed time for an in-flight run', async (t) => {
  const { server, base, db } = await boot();
  t.after(() => server.close());

  const job = createJob(db, validJob({ name: 'long runner' }));
  const startedAt = new Date(Date.now() - 90_000).toISOString();
  const run = insertRun(db, { jobId: job.id, status: 'running', trigger: 'schedule' });
  updateRun(db, run.id, { startedAt });

  const r = await req(base(), 'GET', '/api/v2/overview');
  const entry = r.body.running.runs.find((x) => x.runId === run.id);
  assert.ok(entry);
  assert.equal(entry.jobId, job.id);
  assert.equal(entry.jobName, 'long runner');
  assert.ok(entry.elapsedMs >= 89_000, `elapsedMs should be ~90s, got ${entry.elapsedMs}`);
});

test('today so far tallies only today\'s finished runs, not yesterday\'s', async (t) => {
  const { server, base, db } = await boot();
  t.after(() => server.close());

  const job = createJob(db, validJob({ name: 'daily thing' }));
  const yesterday = new Date(Date.now() - 25 * 3600_000).toISOString();
  const r1 = insertRun(db, { jobId: job.id, status: 'ok', trigger: 'schedule' });
  updateRun(db, r1.id, { finishedAt: yesterday });
  db.prepare('UPDATE runs SET createdAt = ? WHERE id = ?').run(yesterday, r1.id);

  const r2 = insertRun(db, { jobId: job.id, status: 'ok', trigger: 'schedule' });
  updateRun(db, r2.id, { finishedAt: new Date().toISOString() });
  const r3 = insertRun(db, { jobId: job.id, status: 'timeout', trigger: 'schedule' });
  updateRun(db, r3.id, { finishedAt: new Date().toISOString() });

  const r = await req(base(), 'GET', '/api/v2/overview');
  assert.equal(r.body.today.total, 2, 'yesterday\'s run must not be counted');
  assert.equal(r.body.today.byStatus.ok, 1);
  assert.equal(r.body.today.byStatus.timeout, 1);
});

test('automation is explicitly unavailable (never an empty-looking zero) when projects/beads are not wired', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());
  const r = await req(base(), 'GET', '/api/v2/overview');
  assert.equal(r.body.automation.available, false);
  assert.equal(r.body.automation.projects, null, 'must be null, not [] — an empty array reads as "no projects registered"');
  assert.equal(r.body.automation.bd, null);
});

test('automation project pulse uses the project\'s OWN lastPollAt as its as-of, not request time', async (t) => {
  const projects = {
    pollSec: () => 90,
    busyStreakFor: () => 0,
    warningsFor: () => [],
    readyFor: () => ({ count: 4, at: null }),
    explain: () => [],
  };
  const beads = { version: async () => '1.2.3', healthy: async () => ({ ok: true }) };
  const { server, base, db, dir } = await boot({ projects, beads });
  t.after(() => server.close());

  const polledAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const project = createProject(db, { name: 'webapp', path: dir, state: 'active' });
  updateProject(db, project.id, { lastPollAt: polledAt, lastPollOk: true });

  const r = await req(base(), 'GET', '/api/v2/overview');
  assert.equal(r.body.automation.available, true);
  assert.equal(r.body.automation.asOf, polledAt, 'must be the project\'s own lastPollAt');
  assert.equal(r.body.automation.bd.version, '1.2.3', 'bd version must come through, not be null when it is known');
  const p = r.body.automation.projects.find((x) => x.id === project.id);
  assert.equal(p.ready.count, 4);
});

// ---------------------------------------------------------------------------
// Coupling to the REAL lib/budget.js producer.
//
// Everything above feeds `decodeReason` a hand-written string. That proves the
// decoder parses what it's given, but not that it still understands what
// `blockReason` (lib/budget.js) actually emits — a reword there could silently
// degrade every budget-blocked reason to `{code:'other'}` with nothing but
// budget.test.js/api.test.js noticing, neither of which points at these
// regexes. These three tests drive the real `createBudgetPolicy` through
// `/api/v2/overview` — no hardcoded sentence — one per `blockReason` branch,
// since each is matched by its own regex and each can drift independently.
test('budget-blocked fire is decoded from the REAL producer — severity-bucket branch', async (t) => {
  const resetsAt = new Date(Date.now() + 3 * 3600_000).toISOString();
  const snap = {
    capturedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), ok: true, error: null,
    stale: false, available: true, subscriptionType: 'max',
    windows: { five_hour: { percent: 10, resetsAt }, seven_day: { percent: 10, resetsAt } },
    buckets: [{ kind: 'model_scoped', group: null, percent: 90, severity: 'critical', resetsAt, scopeModel: 'Fable', isActive: true }],
  };
  const { server, base, db, scheduler } = await boot({ snap });
  t.after(() => server.close());
  const job = createJob(db, validJob({ name: 'fable job', schedule: { type: 'cron', expr: FIVE_MIN_CRON } }));
  scheduler.reload(job.id);

  const r = await req(base(), 'GET', '/api/v2/overview');
  const fire = r.body.next24h.fires.find((f) => f.jobId === job.id);
  assert.ok(fire);
  assert.equal(fire.admitted, false);
  assert.notEqual(fire.blockedBy.budget.code, 'other', 'the real blockReason() sentence must be recognised, not fall back to other');
  assert.equal(fire.blockedBy.budget.code, 'bucket_severity');
  assert.equal(fire.blockedBy.budget.bucket, 'Fable');
  assert.equal(fire.blockedBy.budget.percent, 90);
  assert.equal(fire.blockedBy.budget.severity, 'critical');
});

test('budget-blocked fire is decoded from the REAL producer — reserve-window branch', async (t) => {
  const resetsAt = new Date(Date.now() + 3 * 3600_000).toISOString();
  const snap = {
    capturedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), ok: true, error: null,
    stale: false, available: true, subscriptionType: 'max',
    // Past the default reserveFiveHourPct (80%); no hot bucket, so this branch
    // (and not the severity one above) is the one that fires.
    windows: { five_hour: { percent: 85, resetsAt }, seven_day: { percent: 10, resetsAt } },
    buckets: [],
  };
  const { server, base, db, scheduler } = await boot({ snap });
  t.after(() => server.close());
  const job = createJob(db, validJob({ name: 'hot window job', schedule: { type: 'cron', expr: FIVE_MIN_CRON } }));
  scheduler.reload(job.id);

  const r = await req(base(), 'GET', '/api/v2/overview');
  const fire = r.body.next24h.fires.find((f) => f.jobId === job.id);
  assert.ok(fire);
  assert.equal(fire.admitted, false);
  assert.notEqual(fire.blockedBy.budget.code, 'other', 'the real blockReason() sentence must be recognised, not fall back to other');
  assert.equal(fire.blockedBy.budget.code, 'reserve');
  assert.equal(fire.blockedBy.budget.windowLabel, '5h');
  assert.equal(fire.blockedBy.budget.usedPct, 85);
});

test('budget-blocked fire is decoded from the REAL producer — per-job floor branch', async (t) => {
  const resetsAt = new Date(Date.now() + 3 * 3600_000).toISOString();
  const snap = {
    capturedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), ok: true, error: null,
    stale: false, available: true, subscriptionType: 'max',
    // Both windows well under the default reserves and no hot bucket, so only
    // the job's own minHeadroomPct override can block this fire.
    windows: { five_hour: { percent: 10, resetsAt }, seven_day: { percent: 10, resetsAt } },
    buckets: [],
  };
  const { server, base, db, scheduler } = await boot({ snap });
  t.after(() => server.close());
  const job = createJob(db, validJob({
    name: 'picky job', schedule: { type: 'cron', expr: FIVE_MIN_CRON },
    params: { prompt: 'do the thing', budget: { minHeadroomPct: 95 } },
  }));
  scheduler.reload(job.id);

  const r = await req(base(), 'GET', '/api/v2/overview');
  const fire = r.body.next24h.fires.find((f) => f.jobId === job.id);
  assert.ok(fire);
  assert.equal(fire.admitted, false);
  assert.notEqual(fire.blockedBy.budget.code, 'other', 'the real blockReason() sentence must be recognised, not fall back to other');
  assert.equal(fire.blockedBy.budget.code, 'job_min_headroom');
  assert.equal(fire.blockedBy.budget.minHeadroomPct, 95);
  assert.equal(fire.blockedBy.budget.leftPct, 90);
});
