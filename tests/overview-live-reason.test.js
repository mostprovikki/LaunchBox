// claude-scheduler-ddu — /api/v2/overview's LIVE budget reason is structured
// data read from the guard, not the guard's English sentence parsed back apart.
//
// The defect this pins: `blockReason()` (lib/budget.js) composed three
// sentences, and server.js regex-parsed them to rebuild the numbers it needed.
// Rewording one sentence therefore silently degraded that reason to
// `{code:'other'}` on every /v2 surface, with only tests that pin the prose
// going red — none of which point at the regexes.
//
// What still parses, on purpose: `meta.skipReason` on a STORED run row is prose
// frozen at the moment of the skip, with no structured twin anywhere. The
// historical decoder (`SKIP_REASON_PATTERNS`/`decodeReason`) must stay, and the
// last test here holds it to that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { tmpData, validJob, extensions, fakeSpawn } from './helpers.js';
import { ensureDirs } from '../lib/paths.js';
import { ensureToken } from '../lib/token.js';
import { openDb, createJob, insertRun, updateRun } from '../lib/db.js';
import { createRunner } from '../lib/runner.js';
import { createScheduler } from '../lib/scheduler.js';
import { createPauseController } from '../lib/pause.js';
import { createBudgetPolicy } from '../lib/budget.js';
import { createApp } from '../server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIVE_MIN_CRON = '*/5 * * * *';
let currentToken = null;

async function req(base, path) {
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${currentToken}` } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function usageStub(snap) {
  return {
    events: new EventEmitter(),
    snapshot: () => snap,
    window: (n) => snap?.windows?.[n] ?? null,
    status: () => ({ running: false, pollSec: 180, nextPollAt: null }),
    refresh: async () => snap,
  };
}

async function boot(snap) {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const usage = usageStub(snap);
  const budget = createBudgetPolicy({ db, usage });
  let pause = null;
  const runner = createRunner({
    db, extensions, spawnFn: fakeSpawn(), notifyFn: () => {}, usage,
    admit: (job, trigger, opts) => pause?.gate(job, trigger, opts) ?? budget.admit(job, trigger, opts),
  });
  pause = createPauseController({ db, runner });
  const scheduler = createScheduler({ db, runner, usage, pause });
  currentToken = ensureToken();
  const app = createApp({
    db, runner, scheduler, extensions, awake: null, usage, budget, pause,
    projects: null, beads: null, token: currentToken,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { db, budget, scheduler, server, base: () => `http://127.0.0.1:${server.address().port}` };
}

// A hot bucket whose label the sentence-parsing decoder CANNOT read back.
//
// `SKIP_REASON_PATTERNS`'s bucket group is `(.+?)`, and `.` does not match a
// newline — so this label makes `blockReason()`'s sentence unparseable while
// leaving the decision itself perfectly ordinary. It stands in for any wording
// the regexes don't anticipate (a reword, a new value, a label carrying
// punctuation the pattern didn't plan for): the live path must not care,
// because it never reads the sentence.
const UNPARSEABLE_LABEL = 'Fable\nPreview';

function snapshot({ fiveHour = 10, sevenDay = 10, buckets = [] } = {}) {
  const at = new Date().toISOString();
  const resetsAt = new Date(Date.now() + 3 * 3600_000).toISOString();
  return {
    capturedAt: at, checkedAt: at, ok: true, error: null, stale: false, available: true,
    subscriptionType: 'max', pollSec: 180, nextPollAt: null,
    windows: { five_hour: { percent: fiveHour, resetsAt }, seven_day: { percent: sevenDay, resetsAt } },
    buckets,
  };
}

// The centrepiece. ONE sentence, produced once by the real guard, reaching the
// SAME endpoint by both routes:
//
//   live  → next24h.fires[].blockedBy.budget — structured, exact, no parsing
//   stored→ attention.items[].reason         — prose, so all it can do is parse
//
// The live half must be exact where the parsing half gives up. If the live path
// ever goes back to parsing, both halves say `other` and this goes red.
test('the live budget reason survives a sentence the historical decoder cannot parse', async (t) => {
  const snap = snapshot({
    buckets: [{ kind: 'model_scoped', group: null, scopeModel: UNPARSEABLE_LABEL, percent: 90, severity: 'critical', resetsAt: null, isActive: true }],
  });
  const { server, base, db, budget, scheduler } = await boot(snap);
  t.after(() => server.close());

  const job = createJob(db, validJob({ name: 'hot bucket job', schedule: { type: 'cron', expr: FIVE_MIN_CRON } }));
  scheduler.reload(job.id);

  // The sentence is taken from the real producer, never retyped here — a
  // retyped expectation would only prove the test agrees with itself.
  const sentence = budget.explain(job).blocked;
  assert.ok(sentence, 'precondition: this snapshot must actually block the job');

  // A stored row recording that same skip, exactly as the scheduler would.
  const run = insertRun(db, { jobId: job.id, status: 'skipped', trigger: 'schedule' });
  updateRun(db, run.id, {
    finishedAt: new Date().toISOString(),
    meta: JSON.stringify({ skipReason: sentence }),
  });

  const r = await req(base(), '/api/v2/overview');
  assert.equal(r.status, 200);

  // Live: structured, straight from the guard.
  const fire = r.body.next24h.fires.find((f) => f.jobId === job.id);
  assert.ok(fire, 'the job must appear in next-24h');
  assert.equal(fire.admitted, false);
  assert.equal(fire.blockedBy.budget.code, 'bucket_severity');
  assert.equal(fire.blockedBy.budget.bucket, UNPARSEABLE_LABEL, 'the label must arrive whole — parsing it out of the sentence cannot do this');
  assert.equal(fire.blockedBy.budget.percent, 90);
  assert.equal(fire.blockedBy.budget.severity, 'critical');
  assert.equal(fire.blockedBy.budget.message, sentence, 'the sentence rides along for humans, unchanged');

  // Stored: the same sentence, and all the historical decoder can do is fail
  // over to `other` — which is precisely what the live path used to do too.
  const item = r.body.attention.items.find((i) => i.jobId === job.id);
  assert.ok(item, 'the stored skip must still surface as a needs-attention item');
  assert.equal(item.reason.code, 'other');
  assert.equal(item.reason.message, sentence, 'undecodable is still surfaced, never dropped');
});

// The three branches again, but asserting the live values come back exact for
// ordinary inputs too — so a structural break (a renamed code, a dropped value)
// is caught even when the prose happens to still be parseable.
const CASES = [
  {
    what: 'severity-bucket',
    snap: () => snapshot({ buckets: [{ kind: 'model_scoped', group: null, scopeModel: 'Fable', percent: 90, severity: 'critical', resetsAt: null, isActive: true }] }),
    job: () => ({ name: 'bucket job', schedule: { type: 'cron', expr: FIVE_MIN_CRON } }),
    expect: { code: 'bucket_severity', bucket: 'Fable', percent: 90, severity: 'critical' },
  },
  {
    what: 'reserve-window',
    snap: () => snapshot({ fiveHour: 85 }),
    job: () => ({ name: 'reserve job', schedule: { type: 'cron', expr: FIVE_MIN_CRON } }),
    expect: { code: 'reserve', windowLabel: '5h', usedPct: 85 },
  },
  {
    what: 'per-job floor',
    snap: () => snapshot(),
    job: () => ({ name: 'picky job', schedule: { type: 'cron', expr: FIVE_MIN_CRON }, params: { prompt: 'do the thing', budget: { minHeadroomPct: 95 } } }),
    expect: { code: 'job_min_headroom', minHeadroomPct: 95, leftPct: 90 },
  },
];

for (const c of CASES) {
  test(`live budget reason is exact for the ${c.what} branch`, async (t) => {
    const { server, base, db, budget, scheduler } = await boot(c.snap());
    t.after(() => server.close());
    const job = createJob(db, validJob(c.job()));
    scheduler.reload(job.id);

    const r = await req(base(), '/api/v2/overview');
    const fire = r.body.next24h.fires.find((f) => f.jobId === job.id);
    assert.ok(fire);
    assert.equal(fire.admitted, false);
    assert.deepEqual(
      fire.blockedBy.budget,
      { ...c.expect, message: budget.explain(job).blocked },
      'the live reason must be the guard\'s own structured answer, message included',
    );
  });
}

// --- the coupling the endpoint must keep, and the one it must not -----------

test('the /api/v2/overview live budget field reads the guard, and only stored prose is decoded', () => {
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8');
  const route = /app\.get\('\/api\/v2\/overview'[\s\S]*?\n {2}\}\);/.exec(src)?.[0];
  assert.ok(route, 'could not locate the /api/v2/overview route');
  // Comments name `decodeReason` on purpose (to say where it does NOT belong),
  // so scan code only.
  const code = route.replace(/^\s*\/\/.*$/gm, '');

  assert.match(code, /budget: liveBudgetReason\(budgetExplain\)/, 'the live fire reason must come from the guard\'s structured answer');
  const parsed = [...code.matchAll(/decodeReason\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(parsed, ['last.meta.skipReason'],
    'the only thing this endpoint may still parse is a STORED run row\'s prose skipReason');
});

test('the historical decoder still exists — this bead removed the parse from the live path, not the codebase', () => {
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8');
  assert.equal((src.match(/const SKIP_REASON_PATTERNS = /g) ?? []).length, 1,
    'stored rows predating the structured reason are prose and nothing else can read them');
  assert.match(src, /function decodeReason\(raw\)/);
  // pause.gate still emits prose only, and stored rows carry it.
  assert.match(src, /code: 'paused', re:/);
});
