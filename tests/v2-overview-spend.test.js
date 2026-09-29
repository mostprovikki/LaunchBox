// claude-scheduler-btv.25: the Overview spend rollup (GET /api/v2/overview →
// `spend`) and the daemon-side last visit (POST /api/v2/visits). Same harness
// as tests/v2-overview.test.js; the clock is injected so the 7-day boundary and
// the 30-minute visit rule are pinned exactly rather than raced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { tmpData, validJob, extensions, fakeSpawn } from './helpers.js';
import { ensureDirs } from '../lib/paths.js';
import { ensureToken } from '../lib/token.js';
import { openDb, createJob, createProject, recordRunUsage, spendRollup, getSetting } from '../lib/db.js';
import { createRunner } from '../lib/runner.js';
import { createScheduler } from '../lib/scheduler.js';
import { createPauseController } from '../lib/pause.js';
import { createBudgetPolicy } from '../lib/budget.js';
import { createApp, nextVisit, VISIT_GAP_MS } from '../server.js';

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

function usageStub() {
  return {
    events: new EventEmitter(),
    snapshot: () => null,
    window: () => null,
    status: () => ({ running: false, pollSec: 180, nextPollAt: null }),
    refresh: async () => null,
  };
}

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const DAY = 24 * 3600_000;

async function boot({ clock } = {}) {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const usage = usageStub();
  const budget = createBudgetPolicy({ db, usage });
  let pause = null;
  const runner = createRunner({
    db, extensions, spawnFn: fakeSpawn(), notifyFn: () => {}, usage,
    admit: (job, trigger, opts) => pause?.gate(job, trigger, opts) ?? budget.admit(job, trigger, opts),
  });
  pause = createPauseController({ db, runner });
  const scheduler = createScheduler({ db, runner, usage, pause });
  currentToken = ensureToken();
  const time = { ms: NOW };
  const app = createApp({
    db, runner, scheduler, extensions, awake: null, usage, budget, pause,
    token: currentToken, clock: clock ?? (() => time.ms),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = () => `http://127.0.0.1:${server.address().port}`;
  return { db, server, base, time };
}

function jobFor(db, projectId, name) {
  const j = validJob({ name });
  return createJob(db, projectId ? { ...j, params: { ...j.params, _projectId: projectId } } : j);
}

let runSeq = 0;
// One sampled run, backdated to `atMs`. recordRunUsage stamps sampledAt with
// the real clock; the rollup reads sampledAt, so it is rewritten afterwards.
function spent(db, jobId, sevenDay, atMs, { fiveHour = 1 } = {}) {
  const runId = `run-${++runSeq}`;
  const before = { seven_day: 10, five_hour: 10 };
  const after = { five_hour: 10 + fiveHour };
  if (sevenDay !== undefined) after.seven_day = 10 + sevenDay;
  recordRunUsage(db, { runId, jobId, beforePct: before, afterPct: after });
  db.prepare('UPDATE run_usage SET sampledAt = ? WHERE runId = ?').run(new Date(atMs).toISOString(), runId);
  return runId;
}

test('last7 groups seven_day deltas by project', async (t) => {
  const { db, server, base } = await boot();
  t.after(() => server.close());
  const a = createProject(db, { name: 'alpha', path: '/tmp/alpha-' + Math.random(), state: 'active' });
  const b = createProject(db, { name: 'beta', path: '/tmp/beta-' + Math.random(), state: 'active' });
  const ja1 = jobFor(db, a.id, 'a1');
  const ja2 = jobFor(db, a.id, 'a2');
  const jb = jobFor(db, b.id, 'b1');
  spent(db, ja1.id, 1.5, NOW - 1 * DAY);
  spent(db, ja2.id, 0.5, NOW - 2 * DAY);
  spent(db, jb.id, 2, NOW - 3 * DAY);

  const r = await req(base(), 'GET', '/api/v2/overview');
  assert.equal(r.status, 200);
  const s = r.body.spend;
  assert.ok(s, 'response must carry spend');
  assert.equal(s.asOf, new Date(NOW).toISOString());
  assert.equal(s.last7.pct, 4);
  const by = Object.fromEntries(s.last7.byProject.map((p) => [p.projectId, p]));
  assert.equal(by[a.id].pct, 2, 'both alpha jobs sum into one alpha row');
  assert.equal(by[a.id].name, 'alpha');
  assert.equal(by[b.id].pct, 2);
  assert.equal(s.last7.byProject.length, 2);
});

test('the 7-day window is inclusive at exactly now − 7d and excludes anything older', async (t) => {
  const { db, server, base } = await boot();
  t.after(() => server.close());
  const p = createProject(db, { name: 'alpha', path: '/tmp/alpha-' + Math.random(), state: 'active' });
  const j = jobFor(db, p.id, 'a1');
  spent(db, j.id, 3, NOW - 7 * DAY);         // on the boundary — in
  spent(db, j.id, 5, NOW - 7 * DAY - 1);     // one ms older — out
  spent(db, j.id, 7, NOW + 60_000);          // after `now` — out

  const { body } = await req(base(), 'GET', '/api/v2/overview');
  assert.equal(body.spend.last7.pct, 3);
  assert.deepEqual(body.spend.last7.byProject.map((x) => x.pct), [3]);
});

test('a project-less run counts toward last7.pct but not byProject; negative or missing deltas count 0', async (t) => {
  const { db, server, base } = await boot();
  t.after(() => server.close());
  const p = createProject(db, { name: 'alpha', path: '/tmp/alpha-' + Math.random(), state: 'active' });
  const jp = jobFor(db, p.id, 'a1');
  const loose = jobFor(db, null, 'loose');
  spent(db, jp.id, 1, NOW - DAY);
  spent(db, loose.id, 2.25, NOW - DAY);
  spent(db, jp.id, -4, NOW - DAY);            // window reset mid-run: negative
  spent(db, jp.id, undefined, NOW - DAY);     // no seven_day reading at all

  const { body } = await req(base(), 'GET', '/api/v2/overview');
  assert.equal(body.spend.last7.pct, 3.25);
  assert.deepEqual(body.spend.last7.byProject, [{ projectId: p.id, name: 'alpha', pct: 1 }]);
});

test('spendRollup is the one query: range is [since, until]', () => {
  const dir = tmpData();
  const db = openDb(join(dir, 'r.db'));
  const j = jobFor(db, null, 'x');
  spent(db, j.id, 1, NOW - 10 * DAY);
  spent(db, j.id, 2, NOW - DAY);
  const r = spendRollup(db, { sinceIso: new Date(NOW - 7 * DAY).toISOString(), untilIso: new Date(NOW).toISOString() });
  assert.equal(r.pct, 2);
  assert.deepEqual(r.byProject, []);
});

test('nextVisit: only a gap of more than 30 minutes advances prevVisitAt', () => {
  assert.equal(VISIT_GAP_MS, 30 * 60_000);
  const t0 = NOW;
  const first = nextVisit({ lastVisitAt: null, prevVisitAt: null }, t0);
  assert.deepEqual(first, { lastVisitAt: new Date(t0).toISOString(), prevVisitAt: null });
  const soon = nextVisit(first, t0 + 29 * 60_000);
  assert.equal(soon.prevVisitAt, null, 'within 30 min: prev untouched');
  assert.equal(soon.lastVisitAt, new Date(t0 + 29 * 60_000).toISOString());
  const exactly = nextVisit({ lastVisitAt: new Date(t0).toISOString(), prevVisitAt: null }, t0 + 30 * 60_000);
  assert.equal(exactly.prevVisitAt, null, 'exactly 30 min is not "more than"');
  const later = nextVisit({ lastVisitAt: new Date(t0).toISOString(), prevVisitAt: null }, t0 + 31 * 60_000);
  assert.equal(later.prevVisitAt, new Date(t0).toISOString());
});

test('POST /api/v2/visits: 30-minute rule over HTTP, and sinceVisit reads from prevVisitAt', async (t) => {
  const { db, server, base, time } = await boot();
  t.after(() => server.close());
  const j = jobFor(db, null, 'x');

  let o = await req(base(), 'GET', '/api/v2/overview');
  assert.deepEqual(o.body.spend.sinceVisit, { pct: null, from: null }, 'no visit yet');

  const v1 = await req(base(), 'POST', '/api/v2/visits');
  assert.equal(v1.status, 200);
  assert.equal(v1.body.prevVisitAt, null);
  const firstVisit = new Date(NOW).toISOString();
  assert.equal(v1.body.lastVisitAt, firstVisit);

  // Repeated POSTs inside 30 minutes (every 10 min, 40 min total) never
  // advance prev — the last-visit stamp slides, so the gap never opens.
  for (let i = 1; i <= 4; i++) {
    time.ms = NOW + i * 10 * 60_000;
    const v = await req(base(), 'POST', '/api/v2/visits');
    assert.equal(v.body.prevVisitAt, null, `POST ${i} inside the gap must not advance prev`);
  }
  o = await req(base(), 'GET', '/api/v2/overview');
  assert.deepEqual(o.body.spend.sinceVisit, { pct: null, from: null });

  const lastStamp = new Date(time.ms).toISOString();
  spent(db, j.id, 1, time.ms - 60_000);        // before prev — out of sinceVisit
  time.ms += 2 * 3600_000;
  spent(db, j.id, 0.75, time.ms - 3600_000);   // after prev — in
  const v2 = await req(base(), 'POST', '/api/v2/visits');
  assert.equal(v2.body.prevVisitAt, lastStamp);
  o = await req(base(), 'GET', '/api/v2/overview');
  assert.deepEqual(o.body.spend.sinceVisit, { pct: 0.75, from: lastStamp });
  assert.equal(o.body.spend.last7.pct, 1.75);
});

test('POST /api/v2/visits refuses without the token and records nothing', async (t) => {
  const { db, server, base } = await boot();
  t.after(() => server.close());
  const r = await req(base(), 'POST', '/api/v2/visits', null, { token: '' });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'token_invalid');
  assert.equal(getSetting(db, 'lastVisitAt'), null, 'the refused POST must not have counted as a visit');
  const ok = await req(base(), 'POST', '/api/v2/visits');
  assert.equal(ok.status, 200);
  assert.equal(getSetting(db, 'lastVisitAt'), new Date(NOW).toISOString());
});
