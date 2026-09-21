// Pure (DOM-free) helpers for the burn-down planner and the burst planner
// (claude-scheduler-btv.12 / D2). Mockups: dialog-plan-burndown.html,
// dialog-burst.html.
//
// Both planners share one rule: THE SERVER COMPUTES THE PLAN. lib/budget.js
// owns the reserve cap, the never-past-the-reset horizon, the lead time and
// the spacing; lib/burst.js defers to it for exactly that reason, so a burst
// can never lay out slots the guard would refuse. Nothing here re-derives any
// of it. What this file does is arithmetic ON a returned plan (a running
// total, a count, a span) and the wording that goes around it.
//
// ---------------------------------------------------------------------------
// MOCKUP CLAIMS REFUSED, and why. Encoded as gates in
// tests/frontend-v2-plan-dialogs.test.js.
//
// • "Medium confidence" and "could land between 58% and 74%"
//   (dialog-plan-burndown.html). lib/budget.js returns `confidence: 'low' |
//   'high'` — there is no third value, and there is no interval anywhere. The
//   band is two invented numbers around a point estimate. C1's merge bar
//   already caught `burstSummary` inventing one of these; this is the same
//   claim in the dialog that would have taught it. Rendered as the two states
//   that exist, with the SAMPLE COUNT — which is real — as the evidence.
//
// • "Expected runs 2–3" (dialog-burst.html). `estimate.expectedRuns` is
//   `slots.length`, a single number the timetable already committed to. A
//   range would imply a distribution nothing computes.
//
// • "highest P0" / "wb-221 first" (dialog-burst.html). `burst.plan()` returns
//   `readyCount` per project and deliberately no bead list — its own comment
//   says the counts come from the poller's cache so a preview costs zero `bd`
//   calls. Naming the first bead would need exactly the call that comment
//   avoids, and would be a lie anyway: which bead runs is decided at each
//   attempt, which is the one thing that dialog must not misrepresent.
//
// • "beads db locked since 09:12". Same refusal C2 made: `busyStreak` is a
//   consecutive-miss count, not a start time.
//
// • "Jobs allowed to spend — Claude jobs only" (dialog-plan-burndown.html's
//   legend). The server's rule is narrower and different: any job may be
//   planned EXCEPT a bead-backed one, and that exclusion is a safety rule
//   (a planned `once` entry would fire a bead through the cron scheduler with
//   no lease, no claim and no close). Rendering "Claude jobs only" would hide
//   a shell job the reader is allowed to plan, and would not explain the
//   exclusion that actually exists.

export const pad2 = (n) => String(n).padStart(2, '0');

export function fmtClock(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export const WINDOW_LABELS = Object.freeze({ five_hour: '5-hour', seven_day: 'week' });
export const windowLabel = (k) => WINDOW_LABELS[k] ?? String(k ?? '').replace(/_/g, ' ');

/** "6.80%" — a cost, at the precision the mockups use. */
export const pct = (n) => (Number.isFinite(Number(n)) ? `${Number(n).toFixed(2)}%` : '—');

// --------------------------------------------------------------- burn-down

/**
 * The preview table's rows: each slot, its job, its estimated cost, and the
 * RUNNING projected total. The running total starts at the window's current
 * percentage — a plan that says "43.8%" means "where you will be", not "how
 * much this costs", and the mockup's column is the former.
 *
 * `startPct` null (no usable reading) means the projection cannot be stated;
 * the rows still list what will fire, with the total column blank rather than
 * anchored to a zero nobody measured.
 */
export function burnDownRows(plan, { jobsById = new Map(), startPct = null } = {}) {
  let running = Number.isFinite(startPct) ? Number(startPct) : null;
  return (plan?.slots ?? []).map((s) => {
    const est = Number(s.estPct) || 0;
    if (running != null) running += est;
    return {
      at: s.at,
      jobId: s.jobId,
      jobName: s.jobId ? (jobsById.get(s.jobId)?.name ?? s.jobId.slice(0, 8)) : 'whatever is eligible',
      estPct: est,
      projectedPct: running,
    };
  });
}

/**
 * The confidence statement. Two states, because two is what lib/budget.js
 * computes — and the evidence is the sample count, which is real, rather than
 * an interval, which is not.
 */
export function confidenceText(plan, { candidates = [] } = {}) {
  const low = plan?.confidence === 'low';
  const chosen = candidates.filter((c) => c.chosen);
  const samples = chosen.reduce((a, c) => a + (c.samples ?? 0), 0);
  const assumed = chosen.filter((c) => c.source === 'assumed').map((c) => c.name);
  if (!low) {
    return {
      tone: 'ok',
      title: 'Costs are measured.',
      body: `Every job in this plan has enough run history to estimate from — ${samples} sample`
        + `${samples === 1 ? '' : 's'} in total. The guard still checks every fire.`,
    };
  }
  return {
    tone: 'warn',
    title: 'Low confidence.',
    body: (assumed.length
      ? `${assumed.join(', ')} ${assumed.length === 1 ? 'has' : 'have'} never been measured, so a placeholder per-run cost is being used. `
      : `There is not enough run history yet (${samples} sample${samples === 1 ? '' : 's'}). `)
      // Deliberately no numeric band: lib/budget.js computes a point estimate
      // and a low/high flag, and nothing computes an interval.
      + 'The projected totals below are therefore an estimate, not a bound. The guard still checks every fire.',
  };
}

/** The burn-down footer. Counts and times come from the plan the server returned. */
export function burnDownConsequence(plan, { window = 'five_hour' } = {}) {
  const slots = plan?.slots ?? [];
  if (!slots.length) return 'Nothing to create — adjust the target or pick more jobs.';
  const first = fmtClock(slots[0].at);
  const last = fmtClock(slots[slots.length - 1].at);
  const total = Number(plan.estTotalPct) || 0;
  return `Creates ${slots.length} one-shot fire${slots.length === 1 ? '' : 's'} between ${first} and ${last}`
    + ` · est. +${total.toFixed(1)}% of the ${windowLabel(window)} window · each fire still passes the guard`;
}

/**
 * Split the candidate jobs into the ones that may be planned and the ones that
 * may not, each with its reason. `blocked` does NOT exclude a job — the guard
 * is checked again at fire time and the situation may have changed by then —
 * so it is reported as a warning on an includable row, which is the honest
 * distinction the mockup's flat "excluded" column loses.
 */
export function splitCandidates(jobs = []) {
  const eligible = [];
  const excluded = [];
  for (const j of jobs) {
    if (!j.plannable) {
      excluded.push({ ...j, reason: j.notPlannable?.message ?? 'cannot be planned' });
      continue;
    }
    eligible.push({ ...j, warning: j.blocked ? blockedText(j.blocked) : null });
  }
  return { eligible, excluded };
}

/**
 * The guard's own decoded reason as one line. Mirrors jobs-logic.js's
 * reasonText() deliberately — the same four codes must not be worded two ways
 * in two dialogs — and falls through to the server's raw sentence for a code
 * neither knows yet.
 */
export function blockedText(blocked) {
  if (!blocked) return null;
  switch (blocked.code) {
    case 'reserve': return `the guard is holding ${blocked.windowLabel} headroom (${blocked.usedPct}% used) right now`;
    case 'bucket_severity': return `${blocked.bucket} is at ${blocked.percent}% (${blocked.severity}) right now`;
    case 'job_min_headroom': return `this job asks for ${blocked.minHeadroomPct}% headroom and ${blocked.leftPct}% is left`;
    case 'paused': return `everything is paused (${blocked.mode}) right now`;
    default: return blocked.message ?? null;
  }
}

/** "avg 6.80% per run over 9 runs" / "never measured — assuming 1.00%/run". */
export function costText(candidate, { assumedCostPct = 1 } = {}) {
  if (candidate?.source === 'learned') {
    return `avg ${pct(candidate.costPct)} per run over ${candidate.samples} run${candidate.samples === 1 ? '' : 's'}`;
  }
  return `never measured — assuming ${pct(assumedCostPct)} per run`;
}

// ------------------------------------------------------------------ burst

export const BURST_PRESETS = Object.freeze([
  { id: '10-5h', label: '10% of 5-hour', window: 'five_hour', budgetPct: 10 },
  { id: '25-5h', label: '25% of 5-hour', window: 'five_hour', budgetPct: 25 },
  { id: '5-wk', label: '5% of week', window: 'seven_day', budgetPct: 5 },
]);

/**
 * The burst preview's four facts. Every value comes from the plan the server
 * returned; the two the mockup invents (a run RANGE and a "medium" confidence)
 * are not produced — see this file's header.
 */
export function burstFacts(plan, { startPct = null } = {}) {
  if (!plan?.ok) return null;
  const budget = Number(plan.budgetPct) || 0;
  const stopAt = Number.isFinite(startPct) ? Number(startPct) + budget : null;
  const est = plan.estimate ?? {};
  const runs = Number(est.expectedRuns) || 0;
  const samples = Number(est.samples) || 0;
  return [
    {
      k: 'Budget',
      v: `${budget}%`,
      d: stopAt != null
        ? `of ${windowLabel(plan.window)} · ${Number(startPct).toFixed(0)}% → stop at ${stopAt.toFixed(0)}%`
        : `of ${windowLabel(plan.window)} · current usage unknown`,
    },
    {
      // A single number, not the mockup's "2–3": this is `slots.length`, the
      // timetable the server just laid out.
      k: 'Attempts planned',
      v: String(runs),
      d: `${pct(est.perRunPct)} per run, ${est.source === 'learned' ? 'learned' : 'assumed'}`,
    },
    {
      k: 'Order',
      v: 'priority, then age',
      // NOT "wb-221 first": the plan carries ready COUNTS and no bead list, and
      // which bead runs is decided at each attempt anyway.
      d: 'decided at each attempt, not now',
    },
    {
      k: 'Confidence',
      v: plan.confidence === 'low' ? 'low' : 'high',
      d: `${samples} sample${samples === 1 ? '' : 's'}`,
      cls: plan.confidence === 'low' ? 'fact--warn' : null,
    },
  ];
}

/** The burst footer. */
export function burstConsequence(plan, { projects = [], maxRuns = null, startPct = null } = {}) {
  if (!plan?.ok) return 'Nothing to start yet — pick at least one activated project.';
  const names = (plan.projects ?? projects).map((p) => p.name).filter(Boolean);
  const runs = plan.slots?.length ?? 0;
  const stopAt = Number.isFinite(startPct) ? (Number(startPct) + Number(plan.budgetPct)).toFixed(0) : null;
  const bits = [
    `Claims up to ${runs} bead${runs === 1 ? '' : 's'} from ${names.join(', ') || 'the chosen projects'}, one at a time`,
  ];
  bits.push(stopAt != null ? `stops at ${stopAt}% measured` : `stops after ${plan.budgetPct}% of measured spend`);
  if (Number.isFinite(Number(maxRuns)) && Number(maxRuns) > 0) bits.push(`or ${maxRuns} runs`);
  bits.push('cancel any time');
  return bits.join(' · ');
}

/**
 * Which projects a burst may draw from, and why each of the others may not.
 * Mirrors lib/burst.js's own airlock check — state, never readiness — because
 * `GET /api/projects/:id/ready` deliberately answers for a pending project so
 * a human can see what WOULD run before activating it. A planner that keyed
 * off readiness would plan, and then run, work from a repo nobody activated.
 */
export function splitProjects(projects = []) {
  const eligible = [];
  const excluded = [];
  for (const p of projects) {
    if (p.state !== 'active') {
      excluded.push({ ...p, reason: `${p.state} — only an activated project can contribute to a burst` });
      continue;
    }
    if ((p.busyStreak ?? 0) > 0) {
      // Not a hard exclusion by the server's rules, but a burst drawing from a
      // project whose database cannot be read will find nothing — said as a
      // warning rather than silently producing an empty burst. The COUNT, not
      // a "since HH:MM" the row does not carry.
      eligible.push({ ...p, warning: `its beads database has been unreadable for ${p.busyStreak} poll${p.busyStreak === 1 ? '' : 's'} — a burst may find nothing to claim` });
      continue;
    }
    eligible.push({ ...p, warning: null });
  }
  return { eligible, excluded };
}
