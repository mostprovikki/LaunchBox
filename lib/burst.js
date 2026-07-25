import { EventEmitter } from 'node:events';
import {
  getProject, listJobsByProject, avgDeltaForJob, getSetting,
  createBurst as insertBurst, getBurst, activeBurst, updateBurst, listBursts,
} from './db.js';

// Budget bursts (M4). "Spend ~15% of this window working through ready beads."
//
// A burst is NOT a new way to run a bead. It owns two things — *when* to attempt,
// and *whether the budget still allows it* — and delegates the attempt itself to
// `projects.pollProject`, which holds the lease, re-reads the bead, claims it,
// launches it, hands it back on any non-ok outcome and closes it only on an
// asserted completion. Anything that launches a bead another way skips all five,
// and would race the poller for the same bead besides.
//
// Two rules M4a paid for, restated because they are easy to undo:
//
//   1. **Never claim ahead.** A claim makes the bead `in_progress`, which
//      `bd ready` excludes, so a bead claimed at plan time and abandoned later is
//      invisible to every future poll. It is also measurably rude: a hand-back
//      appends two lines to the human's git-tracked `.beads/interactions.jsonl`,
//      so a 20-slot burst that tripped its ceiling early would leave ~34
//      uncommitted audit lines for work that never ran. Slots therefore carry
//      *times*, and one bead is claimed immediately before it is launched.
//   2. **Never materialise `once` entries.** A bead's job row ships disabled with
//      a spent one-shot precisely so the cron scheduler cannot arm it.
export const BURST_DEFAULTS = { burstMinGapMin: 15 };

// How often the driver wakes to see whether a slot is due. Slots are minutes
// apart, so this only needs to be finer than the smallest gap.
const TICK_MS = 30_000;

// Cost assumed for a project whose beads have never been sampled. Matches
// lib/budget.js's ASSUMED_COST_PCT; the burst says out loud when it is guessing.
const ASSUMED_COST_PCT = 1;
const MIN_SAMPLES = 3;

export function createBurst({
  db, usage, budget, projects, pause = null,
  now = () => Date.now(), tickMs = TICK_MS,
}) {
  const events = new EventEmitter();
  let timer = null;
  let ticking = false;

  const setting = (k, d) => {
    const v = Number(getSetting(db, k, d));
    return Number.isFinite(v) ? v : d;
  };

  // --- costing -------------------------------------------------------------
  // A project's per-run cost is the median over its bead job rows. Those rows are
  // permanent and reused per bead (M4a §4a.7), so this is real measured history
  // rather than a guess — for any bead that has run at least once.
  function costFor(projectId, window) {
    const rows = listJobsByProject(db, projectId).filter((j) => j.params?._beadId);
    const measured = [];
    let samples = 0;
    for (const row of rows) {
      const { samples: n, median } = avgDeltaForJob(db, row.id);
      samples += n;
      const m = median?.[window];
      if (typeof m === 'number' && m > 0) measured.push(m);
    }
    if (!measured.length) return { cost: ASSUMED_COST_PCT, samples, source: 'assumed', rows: rows.length };
    const mean = measured.reduce((a, b) => a + b, 0) / measured.length;
    return { cost: mean, samples, source: 'learned', rows: rows.length };
  }

  // --- plan ----------------------------------------------------------------
  // Writes nothing. Returns the M2 planner's `{ok:false, reason}` shape on refusal
  // so the existing client error handling works unchanged.
  function plan({
    window = 'five_hour', budgetPct = 10, projectIds = [],
    maxRuns = null, minGapMin = null, deadline = null,
  } = {}) {
    const ids = [...new Set((projectIds ?? []).filter(Boolean))];
    if (!ids.length) return { ok: false, reason: 'pick at least one project to draw ready beads from' };

    // The activation airlock. `GET /api/projects/:id/ready` deliberately works on a
    // `pending` project so a human can see what *would* run before activating one —
    // so a planner that just read ready-work would plan, and then run, work from a
    // repo nobody activated. That is the one gate an agent must never be able to
    // route around, so it is checked here by state, not by readiness.
    const chosen = [];
    const refused = [];
    for (const id of ids) {
      const p = getProject(db, id);
      if (!p) { refused.push(`${id.slice(0, 8)} no longer exists`); continue; }
      if (p.state !== 'active') {
        refused.push(`${p.name} is ${p.state} — only an activated project can contribute to a burst`);
        continue;
      }
      chosen.push(p);
    }
    if (!chosen.length) {
      return { ok: false, reason: refused.join('; ') || 'none of those projects can contribute to a burst' };
    }

    const gap = Math.max(1, Number(minGapMin) || setting('burstMinGapMin', BURST_DEFAULTS.burstMinGapMin));
    const costs = new Map(chosen.map((p) => [p.id, costFor(p.id, window)]));
    // Mean across projects: a burst round-robins across them, so the mean per-run
    // cost is what the budget buys, not the cheapest project's.
    const perRun = [...costs.values()].reduce((a, c) => a + c.cost, 0) / costs.size;

    // The budget arithmetic — reserve cap, never past the reset, PLAN_LEAD_MS,
    // spacing — belongs to lib/budget.js and stays there, so a burst can never lay
    // out slots the guard would refuse.
    const base = budget.plan({
      window, targetPct: Number(budgetPct), deadline, minGapMin: gap,
      maxConcurrent: 1, costPct: perRun,
    });
    if (!base.ok) return base;

    let slots = base.slots.map((s) => s.at);
    let cappedByMaxRuns = 0;
    const cap = Number(maxRuns);
    if (Number.isFinite(cap) && cap > 0 && slots.length > cap) {
      cappedByMaxRuns = slots.length - cap;
      slots = slots.slice(0, cap);
    }

    const anyLearned = [...costs.values()].some((c) => c.source === 'learned');
    const totalSamples = [...costs.values()].reduce((a, c) => a + c.samples, 0);

    // Ready counts come from the poller's cache, so a preview costs zero `bd`
    // calls — the same reason GET /api/projects doesn't probe per row.
    const perProject = chosen.map((p) => {
      const c = costs.get(p.id);
      const r = projects.readyFor?.(p.id) ?? { count: null, at: null };
      return {
        id: p.id, name: p.name, state: p.state,
        readyCount: r.count, readyAt: r.at,
        perRunPct: Number(c.cost.toFixed(3)), samples: c.samples, source: c.source,
      };
    });

    const assumptions = [
      ...base.assumptions,
      ...perProject.map((p) => (p.source === 'learned'
        ? `${p.name}: ${p.perRunPct}%/run from ${p.samples} sample${p.samples === 1 ? '' : 's'}`
        : `${p.name}: no bead has run yet — assuming ${ASSUMED_COST_PCT}%/run`)),
      // Stated every time, because it is the one way a burst preview differs from
      // the burn-down planner's: that one names the jobs it will fire, this one
      // cannot, and a user who assumes otherwise would be misled about what runs.
      'which beads run is decided at each attempt, not now — the burst asks for whatever is ready and eligible then',
    ];
    if (cappedByMaxRuns) assumptions.push(`capped by max runs: ${cappedByMaxRuns} affordable attempt(s) left unplanned`);
    for (const r of refused) assumptions.push(`excluded: ${r}`);

    return {
      ok: true,
      window,
      budgetPct: Number(budgetPct),
      slots,
      projects: perProject,
      estimate: {
        perRunPct: Number(perRun.toFixed(3)),
        expectedRuns: slots.length,
        source: anyLearned ? 'learned' : 'assumed',
        samples: totalSamples,
      },
      usablePct: base.usablePct,
      estTotalPct: Number((perRun * slots.length).toFixed(2)),
      horizonEnd: base.horizonEnd,
      minGapMin: gap,
      confidence: anyLearned && totalSamples >= MIN_SAMPLES ? base.confidence : 'low',
      assumptions,
      excluded: refused,
    };
  }

  // --- start ---------------------------------------------------------------
  // `startPct` is read from the same snapshot the guard reads. A burst measured
  // against a second source could drift from what admit() sees and enforce a
  // different budget than the one displayed.
  function start({ window, budgetPct, projectIds, slots, maxRuns = null, minGapMin = null }) {
    const problem = budget.snapshotProblem();
    if (problem) return { ok: false, reason: `cannot start a burst without a usable reading: ${problem}` };
    const pct = usage?.snapshot()?.windows?.[window]?.percent;
    if (typeof pct !== 'number') return { ok: false, reason: `usage for ${window} is unknown` };
    if (activeBurst(db)) return { ok: false, reason: 'a burst is already running — cancel it first' };

    const row = insertBurst(db, {
      window, budgetPct: Number(budgetPct), startPct: pct, currentPct: pct,
      projectIds, slots, maxRuns, minGapMin, state: 'active',
    });
    // insertBurst returns null if a burst was created between the check above and
    // the insert. Reported rather than ignored: silently running a second burst is
    // the failure this guards.
    if (!row) return { ok: false, reason: 'a burst was started concurrently — only one may run at a time' };
    events.emit('started', row);
    arm();
    return { ok: true, burst: row };
  }

  function finish(id, state, reason) {
    const row = updateBurst(db, id, { state, reason, finishedAt: new Date(now()).toISOString(), slots: [] });
    events.emit('finished', row);
    return row;
  }

  function cancel(reason = 'cancelled') {
    const b = activeBurst(db);
    if (!b) return { ok: false, reason: 'no burst is running' };
    // Remaining slots are dropped, not disabled: a burst materialises nothing, so
    // there is no job row to sweep. In-flight runs are left to M3's stop
    // semantics, and a `stopped` run is not a task failure — the poller hands its
    // bead back rather than closing it.
    return { ok: true, burst: finish(b.id, 'cancelled', reason) };
  }

  const status = () => activeBurst(db);
  const history = (opts) => listBursts(db, opts);

  // --- the driver ----------------------------------------------------------
  // One attempt per due slot, in this order. Every early return leaves the burst
  // able to continue except where it explicitly finishes.
  async function tick() {
    if (ticking) return null;
    const b = activeBurst(db);
    if (!b) { disarm(); return null; }
    if (b.state !== 'active') return null;

    // Index, not value: two slots can legitimately carry the same timestamp (the
    // planner emits one `at` per concurrent slot), and removing "the slot equal to
    // this one" would consume every duplicate at once — silently discarding
    // attempts the user confirmed.
    const dueIdx = (b.slots ?? []).findIndex((at) => new Date(at).getTime() <= now());
    if (dueIdx < 0) return null;

    ticking = true;
    try {
      // A pause stops launching, not the burst: unpausing should resume it rather
      // than require re-planning. `hold` is included deliberately — it is the mode
      // whose whole promise is "nothing fires automatically", and it is the one the
      // runner's own gate lets through.
      if (pause?.blocksSchedule()) {
        return { burst: b, skipped: `the schedule is paused (${pause.mode()})`, consumed: false };
      }

      // Fails CLOSED, unlike the guard, and this is the milestone's one deliberate
      // departure from the design spec's fail-open rule: a burst whose spend cannot
      // be measured has no ceiling. The slot is held, not consumed, so the attempt
      // happens once a fresh reading lands.
      const problem = budget.snapshotProblem();
      if (problem) {
        return { burst: b, skipped: `holding: the usage reading is not usable (${problem})`, consumed: false };
      }

      const pct = usage?.snapshot()?.windows?.[b.window]?.percent;
      if (typeof pct !== 'number') {
        return { burst: b, skipped: `holding: ${b.window} reports no percentage`, consumed: false };
      }
      updateBurst(db, b.id, { currentPct: pct });

      // The window reset under us. The budget was expressed against one window
      // instance, and re-baselining would silently grant a second full budget — so
      // this ends the burst rather than continuing into capacity the user never
      // approved.
      if (pct < b.startPct) {
        return { burst: finish(b.id, 'done', `the ${b.window} window reset mid-burst, so the budget it was measured against no longer exists`), consumed: false };
      }

      const spent = pct - b.startPct;
      if (spent >= b.budgetPct) {
        return { burst: finish(b.id, 'spent', `measured spend reached ${spent.toFixed(2)}% of the ${b.budgetPct}% budget`), consumed: false };
      }
      if (b.maxRuns != null && b.runs >= b.maxRuns) {
        return { burst: finish(b.id, 'done', `reached its limit of ${b.maxRuns} run(s)`), consumed: false };
      }

      // Consume exactly one slot, whatever the attempt yields. A slot is an
      // attempt, not a promise of a run: if nothing is ready the burst has looked,
      // and re-offering the same slot would spin.
      const remaining = [...(b.slots ?? [])];
      remaining.splice(dueIdx, 1);
      updateBurst(db, b.id, { slots: remaining });

      const attempts = [];
      let started = 0;
      for (const projectId of b.projectIds ?? []) {
        if (started) break;
        // One bead, through the poller — which re-checks the pause between beads,
        // takes the lease, re-reads, claims, and owns the outcome.
        const r = await projects.pollProject(projectId, { max: 1, trigger: 'burst' });
        attempts.push({ projectId, started: r?.started?.length ?? 0, reasons: r?.reasons ?? [], skipped: r?.skipped ?? [] });
        started += r?.started?.length ?? 0;
      }
      if (started) updateBurst(db, b.id, { runs: b.runs + started });

      const after = getBurst(db, b.id);
      // Nothing left to attempt and nothing running: the burst is done rather than
      // sitting `active` forever with an empty timetable.
      if (!(after.slots ?? []).length) {
        return { burst: finish(after.id, 'done', started || after.runs ? `worked through its timetable (${after.runs} run(s))` : 'no ready bead was eligible at any attempt'), attempts, consumed: true };
      }
      events.emit('attempt', { burst: after, attempts });
      return { burst: after, attempts, consumed: true };
    } finally {
      ticking = false;
    }
  }

  function arm() {
    if (timer) return;
    timer = setInterval(() => { tick().catch((err) => events.emit('error', err)); }, tickMs);
    timer.unref?.();
  }

  function disarm() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // Called at boot: a burst that was active when the daemon stopped keeps its
  // timetable, so it resumes rather than being abandoned. Slots that passed while
  // the process was down are due immediately, and the ceiling is re-measured on
  // the first tick — so a burst cannot resume into a budget it has already spent.
  function resume() {
    const b = activeBurst(db);
    if (b) arm();
    return b;
  }

  return { events, plan, start, cancel, status, history, tick, resume, stop: disarm };
}
