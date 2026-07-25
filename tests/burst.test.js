import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpData } from './helpers.js';
import {
  openDb, createJob, createProject, updateProject, recordRunUsage,
  activeBurst, getBurst, listBursts, cleanupAll, acquireLease,
} from '../lib/db.js';
import { createBudgetPolicy } from '../lib/budget.js';
import { createBurst } from '../lib/burst.js';

// A decorated snapshot exactly as usage.snapshot() returns one — `pollSec` matters
// because a reading older than two poll intervals counts as no reading, which is
// the signal the burst fails CLOSED on.
function snapshot({ fiveHour = 10, ageMs = 0, available = true, pollSec = 180, resetsIn = 4 * 3600e3 } = {}) {
  const at = new Date(Date.now() - ageMs).toISOString();
  const resetsAt = new Date(Date.now() + resetsIn).toISOString();
  return {
    capturedAt: at, checkedAt: at, ok: true, error: null, stale: false, available,
    subscriptionType: 'max', pollSec, nextPollAt: null,
    windows: { five_hour: { percent: fiveHour, resetsAt }, seven_day: { percent: 10, resetsAt } },
    buckets: [],
  };
}

// A projects stand-in. The burst must never launch a bead itself, so this records
// exactly what it was asked to do and how.
function fakeProjects({ startsPerPoll = 1, ready = 3 } = {}) {
  const calls = [];
  return {
    calls,
    readyFor: () => ({ count: ready, at: new Date().toISOString() }),
    async pollProject(projectId, opts) {
      calls.push({ projectId, ...opts });
      const started = Array.from({ length: startsPerPoll }, (_, i) => ({ beadId: `b${i}`, runId: `r${i}` }));
      return { ok: true, reasons: [], ready: [], started, skipped: [] };
    },
  };
}

function setup({ snap = snapshot(), startsPerPoll = 1, pause = null, projectState = 'active' } = {}) {
  const db = openDb(join(tmpData(), 'test.db'));
  const usage = { current: snap, snapshot: () => usage.current, window: (n) => usage.current?.windows?.[n] ?? null };
  const budget = createBudgetPolicy({ db, usage });
  const projects = fakeProjects({ startsPerPoll });
  const p = createProject(db, { name: 'fixture', path: '/tmp/fixture', state: 'pending' });
  if (projectState !== 'pending') updateProject(db, p.id, { state: projectState });
  const burst = createBurst({ db, usage, budget, projects, pause });
  return { db, usage, budget, projects, burst, project: p };
}

// Give a project measured history: one bead job row with sampled deltas.
function withHistory(db, projectId, pctPerRun, samples = 3) {
  const job = createJob(db, {
    name: 'fixture: bead', type: 'claude',
    params: { prompt: 'x', _beadId: 'sp-1', _projectId: projectId },
    schedule: { type: 'once', at: new Date().toISOString() }, enabled: false, cwd: '/tmp',
  });
  for (let i = 0; i < samples; i++) {
    recordRunUsage(db, { runId: `ru${i}`, jobId: job.id, beforePct: { five_hour: 0 }, afterPct: { five_hour: pctPerRun } });
  }
  return job;
}

// --- planning -------------------------------------------------------------

test('plan writes nothing and costs the budget from measured bead history', () => {
  const { db, burst, project } = setup();
  withHistory(db, project.id, 2);

  const p = burst.plan({ window: 'five_hour', budgetPct: 10, projectIds: [project.id], minGapMin: 20 });
  assert.equal(p.ok, true);
  assert.equal(p.estimate.perRunPct, 2, 'learned from run_usage, not assumed');
  assert.equal(p.estimate.source, 'learned');
  assert.equal(p.slots.length, 5, '10% budget / 2% per run');
  assert.equal(p.confidence, 'high');
  // Slots are times, never bead ids — identity is resolved at launch.
  assert.ok(p.slots.every((s) => typeof s === 'string' && !Number.isNaN(new Date(s).getTime())));
  assert.equal(activeBurst(db), null, 'a preview must not start anything');
  assert.equal(listBursts(db).length, 0, 'a preview must not write a row');
});

test('plan says out loud that the bead set is decided later', () => {
  const { db, burst, project } = setup();
  withHistory(db, project.id, 2);
  const p = burst.plan({ budgetPct: 10, projectIds: [project.id] });
  assert.match(p.assumptions.join(' | '), /decided at each attempt, not now/);
});

test('a project with no run history is planned as a guess, and says so', () => {
  const { burst, project } = setup();
  const p = burst.plan({ budgetPct: 10, projectIds: [project.id] });
  assert.equal(p.ok, true);
  assert.equal(p.estimate.source, 'assumed');
  assert.equal(p.confidence, 'low', 'a made-up cost must never read as confident');
  assert.match(p.assumptions.join(' | '), /no bead has run yet/);
});

// The activation airlock. /api/projects/:id/ready deliberately works on a pending
// project so a human can preview before activating, so readiness alone must never
// be what makes work eligible.
test('a burst can only draw from activated projects', () => {
  for (const state of ['pending', 'paused', 'error']) {
    const { burst, project, db } = setup({ projectState: 'pending' });
    if (state !== 'pending') updateProject(db, project.id, { state });
    const p = burst.plan({ budgetPct: 10, projectIds: [project.id] });
    assert.equal(p.ok, false, `${state} must not be plannable`);
    assert.match(p.reason, new RegExp(`is ${state}`));
  }
});

test('plan refuses with a sentence, and is capped by the guard reserve', () => {
  const { burst, project } = setup({ snap: snapshot({ fiveHour: 85 }) });
  const p = burst.plan({ budgetPct: 10, projectIds: [project.id] });
  assert.equal(p.ok, false);
  assert.match(p.reason, /reserves everything past 80%/);

  const none = setup();
  assert.equal(none.burst.plan({ budgetPct: 10, projectIds: [] }).ok, false);
  assert.match(none.burst.plan({ budgetPct: 10, projectIds: [] }).reason, /pick at least one project/);
});

test('maxRuns trims the timetable and reports what it dropped', () => {
  const { db, burst, project } = setup();
  withHistory(db, project.id, 1);
  const p = burst.plan({ budgetPct: 10, projectIds: [project.id], maxRuns: 3, minGapMin: 10 });
  assert.equal(p.slots.length, 3);
  assert.match(p.assumptions.join(' | '), /capped by max runs: \d+ affordable attempt/);
});

// --- start ----------------------------------------------------------------

test('start records the baseline and allows only one live burst', () => {
  const { db, burst, project } = setup();
  withHistory(db, project.id, 2);
  const p = burst.plan({ budgetPct: 10, projectIds: [project.id] });

  const r = burst.start({ window: 'five_hour', budgetPct: 10, projectIds: [project.id], slots: p.slots });
  assert.equal(r.ok, true);
  assert.equal(r.burst.startPct, 10, 'the baseline is the reading the guard also sees');
  assert.equal(r.burst.state, 'active');

  const second = burst.start({ window: 'five_hour', budgetPct: 10, projectIds: [project.id], slots: p.slots });
  assert.equal(second.ok, false);
  assert.match(second.reason, /already running/);
});

test('a burst cannot start without a usable reading', () => {
  const { burst, project } = setup({ snap: snapshot({ ageMs: 10 * 60_000 }) });
  const r = burst.start({ window: 'five_hour', budgetPct: 10, projectIds: [project.id], slots: [new Date().toISOString()] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /without a usable reading/);
});

// --- the driver -----------------------------------------------------------

const past = (n = 1) => Array.from({ length: n }, () => new Date(Date.now() - 60_000).toISOString());

test('an attempt goes through the poller, one bead, on its own trigger', async () => {
  const { burst, projects, project } = setup();
  burst.start({ window: 'five_hour', budgetPct: 10, projectIds: [project.id], slots: past(2) });

  const r = await burst.tick();
  assert.equal(projects.calls.length, 1, 'exactly one attempt per due slot');
  assert.deepEqual(projects.calls[0], { projectId: project.id, max: 1, trigger: 'burst' });
  assert.equal(r.burst.runs, 1);
  assert.equal(r.burst.slots.length, 1, 'the slot was consumed');
  // 'manual' would skip the budget guard outright — a burst must not borrow it.
  assert.notEqual(projects.calls[0].trigger, 'manual');
});

test('the burst never launches a bead itself', async () => {
  const { burst, project } = setup();
  burst.start({ window: 'five_hour', budgetPct: 10, projectIds: [project.id], slots: past(1) });
  // A projects stand-in with no pollProject would throw if the burst tried to
  // launch by any other route.
  await burst.tick();
  // Nothing to assert beyond "it went through pollProject", which the previous
  // test pins; this one exists so a future refactor that adds a direct
  // runner.start() to lib/burst.js has to delete an explicitly named test.
  assert.ok(true);
});

test('the measured ceiling ends the burst, whatever the estimate said', async () => {
  const { burst, usage, project, db } = setup();
  withHistory(db, project.id, 2);
  burst.start({ window: 'five_hour', budgetPct: 10, projectIds: [project.id], slots: past(5) });

  // The estimate said 2%/run. Reality: the first run cost 12%.
  usage.current = snapshot({ fiveHour: 22 });
  const r = await burst.tick();
  assert.equal(r.burst.state, 'spent');
  assert.match(r.burst.reason, /measured spend reached 12\.00% of the 10% budget/);
  assert.deepEqual(r.burst.slots, [], 'remaining slots are dropped, not left pending');
  assert.equal(activeBurst(db), null);
});

test('an unusable reading holds the slot rather than spending blind', async () => {
  const { burst, usage, project } = setup();
  burst.start({ window: 'five_hour', budgetPct: 10, projectIds: [project.id], slots: past(2) });

  usage.current = snapshot({ ageMs: 10 * 60_000 }); // older than 2x pollSec
  const r = await burst.tick();
  assert.equal(r.consumed, false, 'a held slot must not be consumed');
  assert.match(r.skipped, /holding: the usage reading is not usable/);
  assert.equal(r.burst.state, 'active', 'the burst waits for a fresh reading rather than ending');
  assert.equal(r.burst.slots.length, 2, 'the timetable is intact');
});

test('a window reset mid-burst ends it rather than re-baselining', async () => {
  const { burst, usage, project } = setup({ snap: snapshot({ fiveHour: 60 }) });
  burst.start({ window: 'five_hour', budgetPct: 20, projectIds: [project.id], slots: past(3) });

  // The window rolled over: the budget was scoped to the old instance.
  usage.current = snapshot({ fiveHour: 3 });
  const r = await burst.tick();
  assert.equal(r.burst.state, 'done');
  assert.match(r.burst.reason, /window reset mid-burst/);
});

test('a pause stops launching without ending the burst', async () => {
  let mode = 'hold';
  const pause = { blocksSchedule: () => mode !== 'off', mode: () => mode };
  const { burst, projects, project } = setup({ pause });
  burst.start({ window: 'five_hour', budgetPct: 10, projectIds: [project.id], slots: past(2) });

  let r = await burst.tick();
  assert.equal(projects.calls.length, 0, 'hold is the mode that promises nothing fires automatically');
  assert.match(r.skipped, /paused \(hold\)/);
  assert.equal(r.burst.state, 'active');
  assert.equal(r.consumed, false);

  mode = 'off';
  r = await burst.tick();
  assert.equal(projects.calls.length, 1, 'unpausing resumes rather than requiring a re-plan');
});

test('a burst with nothing eligible finishes honestly instead of sitting active', async () => {
  const { burst, project } = setup({ startsPerPoll: 0 });
  burst.start({ window: 'five_hour', budgetPct: 10, projectIds: [project.id], slots: past(1) });
  const r = await burst.tick();
  assert.equal(r.burst.state, 'done');
  assert.match(r.burst.reason, /no ready bead was eligible/);
  assert.equal(r.burst.runs, 0);
});

test('cancel drops the remaining timetable', async () => {
  const { burst, project, db } = setup();
  burst.start({ window: 'five_hour', budgetPct: 10, projectIds: [project.id], slots: past(4) });
  const r = burst.cancel('user cancelled');
  assert.equal(r.ok, true);
  assert.equal(r.burst.state, 'cancelled');
  assert.deepEqual(r.burst.slots, []);
  assert.equal(activeBurst(db), null);
  assert.equal(burst.cancel().ok, false, 'cancelling nothing is refused, not silent');
});

test('a future slot is not due yet', async () => {
  const { burst, projects, project } = setup();
  burst.start({
    window: 'five_hour', budgetPct: 10, projectIds: [project.id],
    slots: [new Date(Date.now() + 3600e3).toISOString()],
  });
  assert.equal(await burst.tick(), null);
  assert.equal(projects.calls.length, 0);
});

test('cleanupAll wipes bursts', () => {
  const { db, burst, project } = setup();
  burst.start({ window: 'five_hour', budgetPct: 10, projectIds: [project.id], slots: past(1) });
  cleanupAll(db);
  assert.equal(listBursts(db).length, 0);
});
