# M2 — Usage-aware scheduling

Design: [`2026-07-25-launchbox-design.md`](../specs/2026-07-25-launchbox-design.md). Depends on **M1**. Verify: `npm test`.

**Goal:** schedule against the real limit state — fire right after a window resets, protect headroom for interactive work, and spread a chosen amount of remaining capacity across a deadline.

**Definition of done:** a job can be scheduled as "N minutes after the 5-hour window resets"; scheduled runs are skipped (with a visible reason) when they'd eat into reserved headroom; and a burn-down plan can lay out fires to consume a target percentage by a deadline.

---

## 2.1 Reset-anchored schedules

New schedule entry type alongside `cron` and `once`:

```js
{ type: 'afterReset', window: 'five_hour'|'seven_day', offsetMin: 3, jitterMin: 2 }
```

Fires at `resets_at + offsetMin + deterministic_jitter(jobId, window)`. Covers the "start 2–5 minutes after the limit resets so no time is wasted" case; the offset exists because `resets_at` is the server's boundary and firing exactly on it risks landing in the old window.

**Jitter is deterministic** (hash of `jobId|window` → `0..jitterMin`), so previews are stable and repeated arming doesn't drift. Anthropic's own scheduler does the same thing for the same reason.

- `lib/validate.js`: accept the type; `window` must be a key present in the live snapshot's `windows` (fall back to allowing `five_hour`/`seven_day` when usage is unavailable, so a job stays editable); `offsetMin` 0–240; `jitterMin` 0–60. `entryFires()` returns **true** — an afterReset entry always has a future occurrence, so a job with only this entry validates and never auto-disables.
- `previewSchedule(schedule, n, { windows })`: compute from the passed-in reset times; when usage is unknown, return a `{unknown: true}` marker rather than throwing, and have the UI say "next fire depends on live usage" instead of showing a wrong time.
- `lib/scheduler.js`: `createScheduler({db, runner, usage})`.
  - `armAfterReset(job, entry)`: read `usage.window(entry.window)`; if no `resetsAt`, skip (re-armed on the next `usage` event). Compute `at`; **if `at <= now`, skip** — consistent with the existing no-catch-up semantics. Otherwise `new Cron(new Date(at), {unref:true}, …)`.
  - Guard against double-firing for the same window instance: `firedResets: Map<'jobId|window', resetsAtISO>`, set on fire, checked before arming.
  - Re-arm on `usage.events.on('usage', …)` by re-running `schedule(job)` for jobs carrying an afterReset entry. Rebuilding is safe: `cron` entries recompute from their expression and already-fired `once` entries are naturally excluded by their `at > now` check.
  - Fire with trigger `'schedule'` and entry type `'afterReset'` — it must **not** take the `once` auto-disable path (`scheduler.js:16-27`).
- **Known limitation to document, not fix here:** a reset that lands while the Mac is asleep or the daemon is down produces no run (no catch-up, by design). M2.4 mitigates with keep-awake; a real catch-up feature would need persisted per-entry fire state, which the schema does not have.

## 2.2 Budget guard / reserve

An **admission check**, not a queue. Blocked fires are recorded as `skipped` with a reason so they're visible in history — never silently dropped, and never parked (see the design doc on why the existing queue is the wrong home).

- `lib/budget.js`: `createBudgetPolicy({db, usage})` → `{ admit(job, trigger), explain(job), plan(opts) }`.
- `lib/runner.js`: add injectable `admit = () => null` to `createRunner`; call it in `start()` **after** the overlap check and **before** `atCapacity`. A truthy return is the block reason:

```js
const blocked = admit(job, trigger);
if (blocked) {
  const run = insertRun(db, { jobId: job.id, status: 'skipped', trigger });
  updateRun(db, run.id, { finishedAt: new Date().toISOString(), meta: JSON.stringify({ skipReason: blocked }) });
  changed();
  return getRun(db, run.id);
}
```

Checked only in `start()`, **not** in `drainQueue()` — a run that passed admission then queued on capacity should launch when capacity frees, not be re-judged against a moved limit. This deliberately avoids the lingering-queue problem.

Policy order (first match wins):

1. `trigger === 'manual'` → **always allow.** An explicit click is never overridden by a budget policy.
2. guard disabled (`budgetGuard = 0`) → allow.
3. snapshot missing, stale beyond `2 × pollSec`, or `available: false` → **allow (fail open)**, and surface a UI warning that the guard is not currently enforcing.
4. any bucket with `isActive` and `severity` in `warning|critical` while `pauseOnWarning` is on → block: `"paused: <kind> at <pct>% (<severity>)"`.
5. `five_hour.percent >= reserveFiveHourPct` → block: `"reserving 5h headroom (<pct>% used)"`.
6. `seven_day.percent >= reserveWeeklyPct` → block.
7. per-job override `params.budget.minHeadroomPct` unmet → block.
8. otherwise allow.

Settings (core), defaulting **conservative** — this is an employer-managed seat and the guard's first duty is to not lock the human out of their own terminal:

| key | default | meaning |
|---|---|---|
| `budgetGuard` | `1` | enforce at all |
| `reserveFiveHourPct` | `80` | don't let scheduled runs push the 5h window past this |
| `reserveWeeklyPct` | `95` | same for the weekly window |
| `pauseOnWarning` | `1` | stand down when an active bucket is flagged `warning`/`critical` |

Per-job opt-out for genuinely important jobs: `params.budget = { ignoreGuard: true }` — needs an explicit, clearly-labelled checkbox in the job form, not a default.

## 2.3 Burn-down planner

Answers *"I have 30% of my weekly limit left and want it used within 36 hours."* A **generator of fire times**, not a gate.

`plan({ window, targetPct, deadline, jobIds|backlogRef, minGapMin, maxConcurrent })` → `{ slots: [{at, jobId, estPct}], assumptions, confidence }`

- Headroom = `100 - windows[window].percent`, capped by `targetPct` and further capped so the relevant reserve is respected (a plan must not fight the guard from §2.2).
- Cost per run comes from `run_usage` medians (M1 §3). With fewer than 3 samples for a job, mark `confidence: 'low'` and **say so in the UI** — do not present a slot count as fact.
- Spread slots evenly across `now → min(deadline, resetsAt)` honouring `minGapMin`; never schedule past the reset (capacity is lost at the boundary, so a slot after it is meaningless for this plan).
- Output is a **preview the user confirms**, which then materialises as `once` schedule entries. No hidden background growth of the job list.
- Re-plan on demand, not automatically. Automatic re-planning plus a moving limit is how runaway loops happen.

## 2.4 Reset-aware keep-awake

`lib/awake.js` currently holds the Mac awake while a run is active or an enabled job has a future fire. Extend `auto` mode to also hold when an afterReset fire is due within the next N minutes — otherwise a 3 a.m. reset-anchored job is simply missed, since there is no catch-up.

## 2.5 UI

- Schedule builder: a fourth mode "after limit reset" — window select, offset (min), jitter (min), plus the live next-fire preview (or the "depends on live usage" state).
- Jobs list: a small chip on jobs whose last fire was budget-skipped, with the reason on hover.
- History: `skipped` rows show `meta.skipReason`.
- Settings: a "Budget & reserve" fieldset for the four keys, with a plain-language note that the guard protects interactive headroom and fails open.
- A "Plan burn-down" action opening the §2.3 preview (slots, assumptions, confidence) with Confirm/Cancel.

## 2.6 Tests

- `afterReset` validation: bad window/offset/jitter rejected; a job with only an afterReset entry validates and does not auto-disable
- deterministic jitter: same `(jobId, window)` → identical offset across calls
- arming: fires at `resetsAt + offset + jitter`; a past computed time is skipped; re-arm on a `usage` event picks up a new `resetsAt`; the same window instance never fires twice
- `previewSchedule` with and without known reset times
- admit: manual always allowed; guard off allows; stale/unavailable snapshot allows (fail open); warning-severity blocks; 5h and weekly thresholds block with the right reason; per-job `ignoreGuard` bypasses
- a blocked fire writes a `skipped` run carrying `meta.skipReason` and does **not** spawn
- a run that passed admission and queued on capacity still launches after the limit moves (no re-judgement in `drainQueue`)
- planner: respects headroom, target, deadline, reset boundary, `minGapMin`; reports low confidence with <3 samples; never plans past the reset
- awake: holds for an imminent afterReset fire

Scheduler/runner tests keep using the existing fake-runner and `minuteMs` compression; the usage monitor is injected as a stub returning a fixed snapshot.

## Risks

| Risk | Mitigation |
|---|---|
| Guard silently stops the scheduler when usage polling breaks | Fail open (policy step 3) + a visible "guard not enforcing" indicator. Tested. |
| Reset-anchored fires cluster with other users' at the same instant | Deterministic jitter, default non-zero offset. |
| Burn-down plan overshoots because percent-per-job is noisy | Medians, explicit confidence, a confirmation step, and a hard cap by the reserve. Plans never auto-refresh. |
| Missed fires while asleep look like bugs | Documented non-goal; keep-awake mitigation in §2.4; surface "missed (asleep)" rather than staying silent — a `skipped` row with that reason is better than nothing. |
| Guard and planner disagree (planner schedules what the guard then blocks) | Planner is capped by the same reserve values it must respect; a plan that would be blocked is refused at preview time with an explanation. |

## Not doing yet

- **Model routing by scoped bucket** (`set_model` control request exists; the Fable weekly bucket sits at 89% while general weekly is 63%, so downgrading a job's model when its scoped bucket is hot is genuinely useful). Deferred because it needs the stdin control channel from M3 and a per-job model-fallback policy. Revisit after M3.
- **Pre-reset drain** (escalate concurrency when a window is about to reset with capacity unspent). Wants the backlog pool from M4 to have anything worth escalating.
- Absolute token budgeting — the API exposes percent only; see the design doc.
