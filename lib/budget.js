import { getSetting, avgDeltaForJob } from './db.js';
import { DEFAULT_POLL_SEC } from './usage.js';

// Defaults ship conservative on purpose. This runs on an admin-managed employer
// seat against capacity that may be pooled, and the guard's first duty is to
// leave the human enough headroom to use their own terminal — so the shipped
// posture is "don't waste capacity already paid for", never "saturate the cap".
export const BUDGET_DEFAULTS = {
  budgetGuard: 1,
  reserveFiveHourPct: 80,
  reserveWeeklyPct: 95,
  pauseOnWarning: 1,
};

// Which reserve setting governs which window. A window with no entry here (a
// codename bucket that ships later) has no reserve of its own — the severity
// check in step 5 is what covers it.
const RESERVE_KEY = { five_hour: 'reserveFiveHourPct', seven_day: 'reserveWeeklyPct' };
const RESERVE_LABEL = { five_hour: '5h', seven_day: 'weekly' };

// A snapshot older than this many poll intervals is treated as no snapshot at
// all: two missed polls means the monitor is not keeping up, and a guard acting
// on a reading that old would be guessing.
const STALE_POLLS = 2;

// Assumed cost of one run for a job that has never been sampled. Deliberately
// small-but-nonzero: it makes a plan possible for a brand-new job while the
// `confidence: 'low'` flag says plainly that the number is made up.
const ASSUMED_COST_PCT = 1;
const MIN_SAMPLES = 3;
// No slot is placed inside this window. It has to cover reading the preview,
// deciding, and confirming: apply() refuses a plan whose first slot has passed
// rather than silently dropping fires the user confirmed, so too short a lead
// makes a plan expire while it's still on screen.
const PLAN_LEAD_MS = 5 * 60_000;

const bucketLabel = (b) => b.scopeModel ?? b.kind ?? b.group ?? 'limit';

// Turns settings + the live snapshot into an admission decision, and lays out
// burn-down plans from the same numbers so the two can never disagree.
//
// **Fails open.** Every path that can't see the limit state allows the run: a
// broken probe must not become a silent scheduler outage.
export function createBudgetPolicy({ db, usage = null, now = () => Date.now() }) {
  const num = (k) => {
    const v = Number(getSetting(db, k, BUDGET_DEFAULTS[k]));
    return Number.isFinite(v) ? v : BUDGET_DEFAULTS[k];
  };
  const on = (k) => num(k) !== 0;

  const settings = () => ({
    budgetGuard: num('budgetGuard') !== 0,
    reserveFiveHourPct: num('reserveFiveHourPct'),
    reserveWeeklyPct: num('reserveWeeklyPct'),
    pauseOnWarning: num('pauseOnWarning') !== 0,
  });

  // Is the snapshot something we're willing to act on? Returns the reason it
  // isn't, or null when it is.
  function untrustworthy(snap) {
    if (!snap) return 'no usage reading yet';
    if (snap.available === false) return 'usage unavailable for this session';
    if (typeof snap.capturedAt !== 'string') return 'no usage reading yet';
    const ageMs = now() - new Date(snap.capturedAt).getTime();
    const pollSec = Number(snap.pollSec) || DEFAULT_POLL_SEC;
    if (!Number.isFinite(ageMs) || ageMs > STALE_POLLS * pollSec * 1000) {
      return `usage reading is ${Math.round((ageMs || 0) / 60_000)}min old`;
    }
    return null;
  }

  // The blocking reason for a scheduled fire of `job` given `snap`, or null.
  // Split out from admit() so `explain()` can report exactly what a fire would
  // hit right now without pretending to run one.
  function blockReason(job, snap) {
    const s = settings();
    if (s.pauseOnWarning) {
      const hot = (snap.buckets ?? []).find((b) => b.isActive && ['warning', 'critical'].includes(b.severity));
      // NB: this exact sentence shape (`paused: <bucket> at <pct>% (<severity>)`)
      // is parsed by `SKIP_REASON_PATTERNS` (server.js, code 'bucket_severity')
      // to decompose it for /api/v2/overview's needs-attention/next-24h reasons.
      // Reword it and update that regex in the same change, or the v2 Overview
      // silently degrades this reason to `{code:'other'}`.
      if (hot) return `paused: ${bucketLabel(hot)} at ${hot.percent}% (${hot.severity})`;
    }
    for (const [key, reserveKey] of Object.entries(RESERVE_KEY)) {
      const pct = snap.windows?.[key]?.percent;
      if (typeof pct === 'number' && pct >= num(reserveKey)) {
        // NB: this exact sentence shape (`reserving <label> headroom (<pct>% used)`)
        // is parsed by `SKIP_REASON_PATTERNS` (server.js, code 'reserve') for
        // /api/v2/overview. Reword it and update that regex together, or the v2
        // Overview silently degrades this reason to `{code:'other'}`.
        return `reserving ${RESERVE_LABEL[key]} headroom (${pct}% used)`;
      }
    }
    // Per-job floor, measured against the tightest window: a job asking for 40%
    // headroom means 40% on the window that has least, not on average.
    const min = Number(job?.params?.budget?.minHeadroomPct);
    if (Number.isFinite(min) && min > 0) {
      const worst = Math.max(...Object.values(snap.windows ?? {})
        .map((w) => (typeof w?.percent === 'number' ? w.percent : -Infinity)));
      if (Number.isFinite(worst) && 100 - worst < min) {
        // NB: this exact sentence shape (`job needs <min>% headroom (<left>% left)`)
        // is parsed by `SKIP_REASON_PATTERNS` (server.js, code 'job_min_headroom')
        // for /api/v2/overview. Reword it and update that regex together, or the
        // v2 Overview silently degrades this reason to `{code:'other'}`.
        return `job needs ${min}% headroom (${Math.round((100 - worst) * 10) / 10}% left)`;
      }
    }
    return null;
  }

  // First match wins. A truthy return is the reason the fire was refused.
  function admit(job, trigger) {
    // An explicit click is never overridden by a budget policy — the person is
    // right there, watching, and can see the same numbers the guard can.
    if (trigger === 'manual') return null;
    if (!on('budgetGuard')) return null;
    if (job?.params?.budget?.ignoreGuard) return null;
    const snap = usage?.snapshot();
    if (untrustworthy(snap)) return null; // fail open
    return blockReason(job, snap);
  }

  // What the guard is doing right now, for the UI. `enforcing: false` is not an
  // error state but it must be visible: the user needs to know the guard is
  // currently letting everything through.
  function explain(job = null) {
    const snap = usage?.snapshot();
    const why = untrustworthy(snap);
    const guard = on('budgetGuard');
    return {
      ...settings(),
      enforcing: guard && !why,
      why: !guard ? 'guard is off' : why,
      blocked: guard && !why ? blockReason(job, snap) : null,
      checkedAt: snap?.checkedAt ?? null,
    };
  }

  // --- burn-down planner --------------------------------------------------
  // Answers "I have N% of this window left and want it used by <deadline>" with
  // a list of fire times. A generator, not a gate: the output is a preview the
  // user confirms, and it is capped by the same reserves admit() enforces so a
  // plan can never lay out slots the guard would then refuse.
  // `costPct` lets a caller supply the per-run cost instead of having it derived
  // from `jobIds`. M4's bursts need this: their candidates are *projects*, whose
  // cost is the mean over their bead rows, and they resolve which bead runs only
  // at launch — so there is no job to attribute a slot to at plan time. Passing
  // the cost in keeps this function the single owner of the budget arithmetic
  // (reserve cap, horizon, spacing) rather than growing a second copy of it in
  // lib/burst.js that could disagree with what admit() enforces.
  function plan({
    window = 'five_hour', targetPct = 100, deadline = null,
    jobIds = [], minGapMin = 10, maxConcurrent = 1, costPct = null,
  } = {}) {
    const ids = [...new Set((jobIds ?? []).filter(Boolean))];
    const supplied = Number.isFinite(Number(costPct)) && Number(costPct) > 0 ? Number(costPct) : null;
    if (!ids.length && supplied == null) return { ok: false, reason: 'pick at least one job to spread the capacity across' };

    const target = Number(targetPct);
    if (!Number.isFinite(target) || target <= 0 || target > 100) return { ok: false, reason: 'targetPct must be 1-100' };
    const gapMs = Math.max(1, Number(minGapMin) || 0) * 60_000;
    const concurrent = Math.max(1, Math.min(10, Math.floor(Number(maxConcurrent) || 1)));

    const snap = usage?.snapshot();
    const w = snap?.windows?.[window];
    if (typeof w?.percent !== 'number') {
      return { ok: false, reason: `usage for ${window} is unknown — refresh the reading before planning` };
    }
    if (!w.resetsAt || Number.isNaN(new Date(w.resetsAt).getTime())) {
      return { ok: false, reason: `${window} reports no reset time — a plan can't tell where the window ends` };
    }

    const reserveKey = RESERVE_KEY[window];
    const reserve = reserveKey ? num(reserveKey) : null;
    const guard = on('budgetGuard');
    const headroom = 100 - w.percent;
    const byReserve = guard && reserve != null ? reserve - w.percent : headroom;
    const usable = Math.min(target, headroom, byReserve);
    if (usable <= 0) {
      return {
        ok: false,
        reason: guard && reserve != null && byReserve <= 0
          ? `${window} is at ${w.percent}% and the guard reserves everything past ${reserve}% — nothing to plan`
          : `${window} is at ${w.percent}% — no headroom to plan`,
      };
    }

    // Never past the reset: capacity is lost at the boundary, so a slot after it
    // belongs to a different window and isn't part of this plan.
    const resetMs = new Date(w.resetsAt).getTime();
    const deadlineMs = deadline ? new Date(deadline).getTime() : resetMs;
    if (!Number.isFinite(deadlineMs)) return { ok: false, reason: 'invalid deadline' };
    const start = now() + PLAN_LEAD_MS;
    const end = Math.min(deadlineMs, resetMs);
    const span = end - start;
    if (span <= 0) {
      return {
        ok: false,
        reason: deadlineMs < resetMs ? 'deadline is already past' : `${window} resets in under a minute — nothing to plan`,
      };
    }

    const costs = new Map();
    let lowConfidence = false;
    for (const id of ids) {
      const { samples, median } = avgDeltaForJob(db, id);
      const measured = median?.[window];
      const cost = typeof measured === 'number' && measured > 0 ? measured : ASSUMED_COST_PCT;
      if (samples < MIN_SAMPLES || !(typeof measured === 'number' && measured > 0)) lowConfidence = true;
      costs.set(id, { cost, samples, measured: typeof measured === 'number' ? measured : null });
    }
    // Jobs are assigned round-robin, so the mean per-run cost is what the budget
    // buys — not the cheapest job's.
    const avgCost = supplied ?? ([...costs.values()].reduce((a, c) => a + c.cost, 0) / costs.size);

    const runsByBudget = Math.floor(usable / avgCost);
    const slotsByGap = Math.max(1, Math.floor(span / gapMs));
    const timeSlots = Math.min(Math.ceil(runsByBudget / concurrent), slotsByGap);
    const runs = Math.min(runsByBudget, timeSlots * concurrent);
    if (runs < 1) {
      return {
        ok: false,
        reason: `one run costs about ${avgCost.toFixed(2)}% of ${window} but only ${usable.toFixed(2)}% is usable`,
      };
    }

    // Evenly spaced over `span` with step ≥ gap, and the last slot lands a full
    // step before the boundary rather than on it.
    const step = span / timeSlots;
    const slots = [];
    for (let i = 0; i < timeSlots && slots.length < runs; i++) {
      const at = new Date(start + i * step).toISOString();
      for (let c = 0; c < concurrent && slots.length < runs; c++) {
        // No jobId when the cost was supplied: the caller resolves what runs, so
        // naming a job here would be an invented attribution.
        const jobId = ids.length ? ids[slots.length % ids.length] : null;
        slots.push({ at, jobId, estPct: Number((jobId ? costs.get(jobId).cost : avgCost).toFixed(3)) });
      }
    }

    const assumptions = [
      `${window} is at ${w.percent}%, resets ${new Date(w.resetsAt).toISOString()}`,
      `usable: ${usable.toFixed(2)}% (target ${target}%, headroom ${headroom.toFixed(2)}%${guard && reserve != null ? `, guard reserve ${reserve}%` : ''})`,
      ...[...costs.entries()].map(([id, c]) => (c.measured
        ? `${id.slice(0, 8)}: ${c.measured.toFixed(2)}%/run from ${c.samples} sample${c.samples === 1 ? '' : 's'}`
        : `${id.slice(0, 8)}: no measured cost — assuming ${ASSUMED_COST_PCT}%/run (${c.samples} sample${c.samples === 1 ? '' : 's'})`)),
      `${runs} run${runs === 1 ? '' : 's'} across ${timeSlots} slot${timeSlots === 1 ? '' : 's'}, ${Math.round(step / 60_000)}min apart (min gap ${Math.round(gapMs / 60_000)}min)`,
      `horizon ends ${new Date(end).toISOString()}${end === resetMs ? ' (window reset)' : ' (deadline)'}`,
    ];
    if (timeSlots === slotsByGap && runsByBudget > runs) {
      assumptions.push(`capped by the minimum gap: ${runsByBudget - runs} affordable run${runsByBudget - runs === 1 ? '' : 's'} left unplanned`);
    }

    return {
      ok: true,
      window,
      slots,
      assumptions,
      confidence: lowConfidence ? 'low' : 'high',
      usablePct: Number(usable.toFixed(2)),
      estTotalPct: Number(slots.reduce((a, s) => a + s.estPct, 0).toFixed(2)),
      horizonEnd: new Date(end).toISOString(),
    };
  }

  // Exported so M4's bursts test the *same* reading this policy tests, and then
  // act oppositely on purpose: `admit` fails OPEN when the snapshot can't be
  // trusted, because a broken probe must not become a silent scheduler outage; a
  // burst fails CLOSED on the identical signal, because a burst whose spend
  // cannot be measured has no ceiling at all. Two policies, one detector — so
  // they can never disagree about whether the reading is usable.
  const snapshotProblem = () => untrustworthy(usage?.snapshot());

  return { admit, explain, plan, settings, snapshotProblem };
}
