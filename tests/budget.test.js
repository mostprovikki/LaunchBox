import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpData, validJob } from './helpers.js';
import { openDb, createJob, setSetting, recordRunUsage } from '../lib/db.js';
import { createBudgetPolicy } from '../lib/budget.js';

// A decorated snapshot exactly as usage.snapshot() returns one. `pollSec` matters:
// the guard treats a reading older than two poll intervals as no reading at all.
function snapshot({ fiveHour = 10, sevenDay = 10, buckets = [], ageMs = 0, available = true, pollSec = 180, resetsIn = 3600e3 } = {}) {
  const at = new Date(Date.now() - ageMs).toISOString();
  const resetsAt = new Date(Date.now() + resetsIn).toISOString();
  return {
    capturedAt: at, checkedAt: at, ok: true, error: null, stale: false, available,
    subscriptionType: 'max', pollSec, nextPollAt: null,
    windows: {
      ...(fiveHour == null ? {} : { five_hour: { percent: fiveHour, resetsAt } }),
      ...(sevenDay == null ? {} : { seven_day: { percent: sevenDay, resetsAt } }),
    },
    buckets,
  };
}

function setup(snap = snapshot()) {
  const dir = tmpData();
  const db = openDb(join(dir, 'test.db'));
  const usage = { current: snap, snapshot: () => usage.current, window: (n) => usage.current?.windows?.[n] ?? null };
  const policy = createBudgetPolicy({ db, usage });
  return { db, usage, policy };
}

const job = (params = {}) => ({ id: 'j1', name: 'j', params });

test('admit: a manual run is never blocked, however hot the account is', () => {
  const { policy } = setup(snapshot({ fiveHour: 99, sevenDay: 99 }));
  assert.equal(policy.admit(job(), 'manual'), null);
  // …while the same job on a schedule is refused.
  assert.ok(policy.admit(job(), 'schedule'));
});

test('admit: guard off allows everything', () => {
  const { db, policy } = setup(snapshot({ fiveHour: 99 }));
  assert.ok(policy.admit(job(), 'schedule'));
  setSetting(db, 'budgetGuard', 0);
  assert.equal(policy.admit(job(), 'schedule'), null);
  assert.equal(policy.explain().enforcing, false);
  assert.equal(policy.explain().why, 'guard is off');
});

test('admit: fails open on a missing, unavailable or stale snapshot', () => {
  // Nothing probed yet.
  const { usage, policy } = setup(null);
  assert.equal(policy.admit(job(), 'schedule'), null);
  assert.equal(policy.explain().enforcing, false);

  // An API-key session reports no limits at all.
  usage.current = snapshot({ fiveHour: 99, available: false });
  assert.equal(policy.admit(job(), 'schedule'), null);

  // Two poll intervals old: the monitor isn't keeping up, so acting on the
  // reading would be guessing. One interval old is still trusted.
  usage.current = snapshot({ fiveHour: 99, pollSec: 60, ageMs: 121_000 });
  assert.equal(policy.admit(job(), 'schedule'), null);
  assert.match(policy.explain().why, /old/);

  usage.current = snapshot({ fiveHour: 99, pollSec: 60, ageMs: 30_000 });
  assert.ok(policy.admit(job(), 'schedule'));
  assert.equal(policy.explain().enforcing, true);
});

test('admit: an active warning/critical bucket stands the scheduler down', () => {
  const hot = [{ kind: 'weekly', group: 'weekly', percent: 89, severity: 'warning', resetsAt: null, scopeModel: 'Fable', isActive: true }];
  const { db, policy } = setup(snapshot({ fiveHour: 10, sevenDay: 10, buckets: hot }));
  assert.equal(policy.admit(job(), 'schedule'), 'paused: Fable at 89% (warning)');

  // Severity only counts on the *active* limit — a flagged bucket that isn't in
  // force isn't costing the user anything right now.
  const idle = [{ ...hot[0], isActive: false }];
  const s2 = setup(snapshot({ buckets: idle }));
  assert.equal(s2.policy.admit(job(), 'schedule'), null);

  setSetting(db, 'pauseOnWarning', 0);
  assert.equal(policy.admit(job(), 'schedule'), null);
});

test('admit: reserve thresholds block with the window named in the reason', () => {
  const { db, usage, policy } = setup(snapshot({ fiveHour: 80, sevenDay: 10 }));
  assert.equal(policy.admit(job(), 'schedule'), 'reserving 5h headroom (80% used)');

  usage.current = snapshot({ fiveHour: 10, sevenDay: 96 });
  assert.equal(policy.admit(job(), 'schedule'), 'reserving weekly headroom (96% used)');

  // Raising the reserve above the current percent unblocks it.
  setSetting(db, 'reserveWeeklyPct', 99);
  assert.equal(policy.admit(job(), 'schedule'), null);

  // Just under the threshold is allowed — the check is >=, not >.
  usage.current = snapshot({ fiveHour: 79.9, sevenDay: 10 });
  assert.equal(policy.admit(job(), 'schedule'), null);
});

test('admit: per-job minHeadroomPct measures the tightest window; ignoreGuard bypasses', () => {
  const { policy } = setup(snapshot({ fiveHour: 30, sevenDay: 70 }));
  assert.equal(policy.admit(job({ budget: { minHeadroomPct: 20 } }), 'schedule'), null);
  // 70% used on the weekly window leaves 30% — a job wanting 40% is refused even
  // though the 5-hour window has plenty.
  assert.equal(policy.admit(job({ budget: { minHeadroomPct: 40 } }), 'schedule'), 'job needs 40% headroom (30% left)');

  // The opt-out beats every block, including the reserves.
  const hot = setup(snapshot({ fiveHour: 99, sevenDay: 99 }));
  assert.ok(hot.policy.admit(job(), 'schedule'));
  assert.equal(hot.policy.admit(job({ budget: { ignoreGuard: true } }), 'schedule'), null);
});

test('explain reports what a fire would hit right now', () => {
  const { policy } = setup(snapshot({ fiveHour: 85 }));
  const e = policy.explain();
  assert.equal(e.enforcing, true);
  assert.equal(e.blocked, 'reserving 5h headroom (85% used)');
  assert.deepEqual(
    { budgetGuard: e.budgetGuard, reserveFiveHourPct: e.reserveFiveHourPct, reserveWeeklyPct: e.reserveWeeklyPct, pauseOnWarning: e.pauseOnWarning },
    { budgetGuard: true, reserveFiveHourPct: 80, reserveWeeklyPct: 95, pauseOnWarning: true },
  );
});

// --- planner --------------------------------------------------------------

// n measured runs of `jobId`, each costing `pct` of the 5-hour window.
function sample(db, jobId, pct, n) {
  for (let i = 0; i < n; i++) {
    recordRunUsage(db, { runId: `${jobId}-r${i}`, jobId, beforePct: { five_hour: 0 }, afterPct: { five_hour: pct } });
  }
}

test('plan: respects headroom, target, min gap and the reset boundary', () => {
  const { db, policy, usage } = setup(snapshot({ fiveHour: 20, resetsIn: 4 * 3600e3 }));
  const j = createJob(db, validJob());
  sample(db, j.id, 2, 5); // 2% per run, well-measured

  // 20% target ÷ 2% per run = 10 runs, and 4h of horizon at a 15min gap allows 16
  // slots — so the budget is the binding constraint here.
  const p = policy.plan({ window: 'five_hour', targetPct: 20, jobIds: [j.id], minGapMin: 15 });
  assert.equal(p.ok, true);
  assert.equal(p.slots.length, 10);
  assert.equal(p.confidence, 'high');
  assert.equal(p.estTotalPct, 20);

  const times = p.slots.map((s) => new Date(s.at).getTime());
  assert.ok(times[0] > Date.now()); // never "now"
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 15 * 60_000);
  // Never past the reset: capacity is lost at the boundary, so with no deadline
  // given the horizon *is* the reset and the last slot lands before it.
  assert.equal(p.horizonEnd, usage.current.windows.five_hour.resetsAt);
  assert.ok(times.at(-1) < new Date(p.horizonEnd).getTime());

  // A tighter gap can't create budget, but a coarser one caps the run count.
  const capped = policy.plan({ window: 'five_hour', targetPct: 20, jobIds: [j.id], minGapMin: 60 });
  assert.equal(capped.slots.length, 3); // 4h minus the lead leaves room for 3 hourly slots
  assert.ok(capped.assumptions.some((a) => a.includes('capped by the minimum gap')));
});

test('plan: capped by the guard reserve, and refused when there is nothing to spend', () => {
  const { db, policy } = setup(snapshot({ fiveHour: 75 }));
  const j = createJob(db, validJob());
  sample(db, j.id, 1, 3);

  // 25% of headroom is left, but the guard reserves everything past 80% — so a
  // plan asking for 25% may only lay out 5%. The planner must never hand out
  // slots the guard would then refuse.
  const p = policy.plan({ window: 'five_hour', targetPct: 25, jobIds: [j.id], minGapMin: 1 });
  assert.equal(p.usablePct, 5);
  assert.equal(p.slots.length, 5);

  const spent = setup(snapshot({ fiveHour: 85 }));
  createJob(spent.db, validJob());
  const r = spent.policy.plan({ window: 'five_hour', targetPct: 10, jobIds: ['x'] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /reserves everything past 80%/);
});

test('plan: fewer than 3 samples is reported as low confidence, not as fact', () => {
  const { db, policy } = setup(snapshot({ fiveHour: 10 }));
  const measured = createJob(db, validJob());
  const fresh = createJob(db, validJob({ name: 'never run' }));
  sample(db, measured.id, 2, 2); // measured, but only twice

  let p = policy.plan({ window: 'five_hour', targetPct: 10, jobIds: [measured.id], minGapMin: 1 });
  assert.equal(p.confidence, 'low');

  // A job with no history at all falls back to an assumed cost and says so.
  p = policy.plan({ window: 'five_hour', targetPct: 10, jobIds: [fresh.id], minGapMin: 1 });
  assert.equal(p.confidence, 'low');
  assert.ok(p.assumptions.some((a) => a.includes('no measured cost')));

  sample(db, measured.id, 2, 3);
  p = policy.plan({ window: 'five_hour', targetPct: 10, jobIds: [measured.id], minGapMin: 1 });
  assert.equal(p.confidence, 'high');
});

test('plan: refuses rather than guessing when it lacks the numbers', () => {
  const { db, policy, usage } = setup(snapshot({ fiveHour: 10 }));
  const j = createJob(db, validJob());
  sample(db, j.id, 2, 3);

  assert.match(policy.plan({ jobIds: [] }).reason, /at least one job/);
  assert.match(policy.plan({ jobIds: [j.id], targetPct: 0 }).reason, /targetPct/);
  assert.match(policy.plan({ jobIds: [j.id], targetPct: 10, deadline: '2020-01-01T00:00:00Z' }).reason, /deadline is already past/);
  assert.match(policy.plan({ window: 'nope', jobIds: [j.id], targetPct: 10 }).reason, /unknown/);

  // One run costs more than the whole target.
  assert.match(policy.plan({ jobIds: [j.id], targetPct: 1 }).reason, /one run costs about 2.00%/);

  // A window with no reset time can't be bounded, so no plan is offered.
  usage.current = { ...usage.current, windows: { five_hour: { percent: 10, resetsAt: null } } };
  assert.match(policy.plan({ jobIds: [j.id], targetPct: 10 }).reason, /no reset time/);

  usage.current = null;
  assert.match(policy.plan({ jobIds: [j.id], targetPct: 10 }).reason, /unknown/);
});

test('plan: an earlier deadline wins over the reset, and jobs share slots round-robin', () => {
  const { db, policy } = setup(snapshot({ fiveHour: 0, resetsIn: 5 * 3600e3 }));
  const a = createJob(db, validJob({ name: 'a' }));
  const b = createJob(db, validJob({ name: 'b' }));
  sample(db, a.id, 2, 3);
  sample(db, b.id, 2, 3);

  const deadline = new Date(Date.now() + 3600e3).toISOString();
  const p = policy.plan({ window: 'five_hour', targetPct: 8, jobIds: [a.id, b.id], deadline, minGapMin: 10, maxConcurrent: 2 });
  assert.equal(p.ok, true);
  assert.equal(p.horizonEnd, deadline); // deadline is before the reset
  assert.ok(new Date(p.slots.at(-1).at) < new Date(deadline));
  assert.equal(p.slots.length, 4); // 8% / 2% per run
  // maxConcurrent 2 → two runs share each time, and both jobs are used.
  assert.equal(p.slots[0].at, p.slots[1].at);
  assert.deepEqual([...new Set(p.slots.map((s) => s.jobId))].sort(), [a.id, b.id].sort());
});
