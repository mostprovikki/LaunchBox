# M4 — Backlog pool & budget bursts

> ⚠️ **PARTIALLY SUPERSEDED 2026-07-25 by [`2026-07-25-m4a-beads-task-sources.md`](./2026-07-25-m4a-beads-task-sources.md).**
> Tasks are no longer owned by the scheduler: projects declare their own in **beads** (`bd`)
> and the scheduler polls `bd ready --json` per registered repo.
>
> - **§4.2 `backlog_tasks` is dead** — do not build that table. The `bursts` table in the same
>   section **survives as written**.
> - **§4.1 (measured live ceiling), §4.3 (materialise as normal `jobs` rows) and §4.4
>   (planning + `admit` enforcement) all survive**; only the *source* of candidate tasks
>   changes, from `backlog_tasks` rows to ready beads.
> - **§4.5's Backlog tab** becomes a Projects + ready-work tab; the burst preview/confirm
>   screen is unchanged.
> - Read M4a first, then this document for the burst mechanics.

Design: [`2026-07-25-launchbox-design.md`](../specs/2026-07-25-launchbox-design.md). Depends on **M1** (usage + `run_usage` calibration) and **M2** (guard + admit hook). Verify: `npm test`.

**Goal:** keep a pool of never-urgent tasks, then spend a chosen slice of capacity on them in one click — *"run a few backlog tasks using ~15% of my session limit"* or *"…using 5% of my weekly limit."*

**Definition of done:** tasks can be added to a backlog; a burst previews which tasks it will run and what it expects to spend; on confirm they execute spread over time; and the burst **stops itself** when the measured spend reaches the budget, regardless of how wrong the estimate was.

---

## 4.1 Why the measured ceiling is the core of this feature

The API gives **percent, not tokens** (`limit_dollars` is `null`), so cost per task can only be *learned*, and early estimates will be bad. A burst that trusts its estimate would overspend.

So a burst carries two independent limits:

1. **Planning estimate** — picks *which* tasks and how many, from `run_usage` medians. Best-effort, shown with its confidence.
2. **Measured live ceiling** — the burst records `startPct` for its window at kickoff; once `currentPct - startPct >= budgetPct`, every remaining task in that burst is refused. This is ground truth from M1 and it is what actually enforces the budget.

The estimate can be wildly wrong and the burst still respects the budget. That relationship is the whole design; everything else is plumbing.

## 4.2 Data model

```sql
CREATE TABLE IF NOT EXISTS backlog_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'claude',   -- extension id
  params TEXT NOT NULL DEFAULT '{}',     -- same shape as jobs.params (prompt, model, …)
  cwd TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,  -- lower runs first
  tags TEXT,
  estPct REAL,                           -- manual override; else learned
  state TEXT NOT NULL DEFAULT 'idle',    -- idle | planned | running | done | archived
  lastRunId TEXT, runCount INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bursts (
  id TEXT PRIMARY KEY,
  window TEXT NOT NULL,                  -- five_hour | seven_day | …
  budgetPct REAL NOT NULL,
  startPct REAL, currentPct REAL,
  maxTasks INTEGER, minGapMin INTEGER,
  state TEXT NOT NULL,                   -- planned | active | spent | done | cancelled
  startedAt TEXT, finishedAt TEXT, createdAt TEXT NOT NULL
);
```

Both are pure additions (no migration code). Both must be wiped by `cleanupAll()`.

## 4.3 Execution: reuse the existing machinery

A burst does **not** get a new execution path. Each selected task materialises into a normal `jobs` row with a single `once` entry at its slot time, carrying `params._backlogId` and `params._burstId`.

This buys scheduling, concurrency caps, logs, history, SSE tailing, the M2 guard and M3 pause **for free**, and it's why this milestone is small. Consequences to handle:

- One-shot jobs auto-disable after firing (existing behaviour) — so a reaper deletes disabled backlog-originated jobs older than `backlogReapDays` (default 7), after their run history has served its purpose. `deleteJob` already cascades runs and returns log paths to unlink.
- The jobs list needs a "hide backlog tasks" toggle so a 20-task burst doesn't bury real jobs. Filter on `params._burstId`.
- A synthetic in-memory job object was considered and **rejected**: `drainQueue()` and the retry path both call `getJob(db, …)` and silently drop anything not in the table, so off-books jobs would lose queueing and retries.

## 4.4 Burst planning & enforcement

`lib/backlog.js`: `createBacklog({ db, usage, budget, now })` → `{ list, upsert, remove, planBurst, startBurst, cancelBurst, burstStatus, admitBurstRun }`

`planBurst({ window, budgetPct, maxTasks, minGapMin, deadline })` → preview:

```js
{ burst: {window, budgetPct, …},
  slots: [{taskId, title, at, estPct, estSource: 'task'|'learned'|'default'}],
  totals: {estPct, taskCount},
  headroomPct, reserveCapPct,
  confidence: 'high'|'medium'|'low', assumptions: [string] }
```

- Cost per task: `estPct` override → median of that task's `run_usage` deltas → global median across runs of the same type → conservative default (flag `estSource: 'default'`, `confidence: 'low'`).
- Selection: ascending `priority`, accumulate while `Σ estPct <= budgetPct` and `count <= maxTasks`.
- **Capped by the M2 reserve** — a burst may never plan past `reserveFiveHourPct` / `reserveWeeklyPct`. If `budgetPct` exceeds available headroom under the reserve, the preview says so and offers the reduced figure rather than silently trimming.
- Slots spread from now, honouring `minGapMin`, and **never past `resetsAt`** for the chosen window (capacity is lost at the boundary; a slot after it belongs to the next window, not this budget).
- Always a **preview the user confirms.** No burst starts implicitly.

`startBurst` records `startPct` from the current snapshot and materialises the jobs.

**Enforcement** hooks into M2's `admit(job, trigger)` — one extra check before the normal policy:

```
if (job.params._burstId) {
  b = burst(job.params._burstId)
  if (b.state !== 'active')                          → block 'burst <state>'
  if (currentPct(b.window) - b.startPct >= b.budgetPct) → block 'burst budget spent'  → mark burst 'spent'
}
```

When a burst flips to `spent`, its remaining materialised jobs are disabled in one sweep so they don't each have to fail admission individually. Notify once.

Edge cases that must be handled explicitly: window resets mid-burst (`currentPct` drops below `startPct`) → re-baseline `startPct` to the new window's value and log it, or end the burst — **end it**, because the budget was expressed against a specific window instance. Stale/unavailable usage → do **not** fail open here (unlike the general guard): a burst without measurement has no ceiling, so hold its remaining tasks until a fresh snapshot arrives, and say so in the UI.

## 4.5 API & UI

- `GET/POST /api/backlog`, `PUT/DELETE /api/backlog/:id`
- `POST /api/backlog/burst/plan` → preview (no writes)
- `POST /api/backlog/burst` → start from a confirmed plan
- `GET /api/backlog/burst/:id`, `POST /api/backlog/burst/:id/cancel` (cancels remaining; in-flight runs follow M3 stop semantics)

UI — a **Backlog** tab (4-edit pattern; see the design doc):

- Task list: title, project, priority, learned cost, state; inline add/edit reusing `renderFields` with the extension's own field config, so a backlog task is authored exactly like a job.
- A **Burst** button with presets — `10% of session` · `25% of session` · `5% of weekly` · custom — plus max-tasks and min-gap.
- The preview is the important screen: the task list with per-task estimates, the total, the headroom and reserve cap, the confidence badge, and the assumptions in plain language ("3 of 6 tasks have never run; cost is a guess"). Confirm/Cancel.
- Active burst strip: spent-vs-budget meter driven by **measured** percent, tasks done/remaining, cancel.

Settings: `backlogReapDays` (7), `backlogDefaultEstPct`, `burstMinGapMin`.

## 4.6 Tests

- backlog CRUD + validation via the extension's field specs (an invalid prompt is rejected the same way a job's is)
- plan: priority order; stops at `budgetPct`; stops at `maxTasks`; capped by reserve; never slots past `resetsAt`; honours `minGapMin`
- estimate sourcing: task override > learned median > global median > default, with the right `estSource`/`confidence`
- `planBurst` writes nothing
- enforcement: once measured delta ≥ budget, further burst runs are blocked, the burst flips to `spent`, and remaining jobs are disabled
- window reset mid-burst ends the burst rather than silently re-baselining
- stale/unavailable usage **holds** burst runs (does not fail open) — the deliberate exception to M2's rule
- cancel: remaining jobs disabled, in-flight untouched (M3 handles stopping)
- reaper deletes disabled backlog jobs past `backlogReapDays` and unlinks their logs
- `cleanupAll` wipes both tables

## Risks

| Risk | Mitigation |
|---|---|
| Estimates are bad early, so the burst overspends | The measured ceiling (§4.1) is the real enforcement; estimates only choose the task set. |
| A burst floods the jobs list | Materialised jobs are tagged and filterable; reaper cleans up. |
| Fail-open would remove the ceiling entirely | Bursts deliberately **fail closed** — no measurement, no spending. Documented as the one exception. |
| Reset mid-burst makes the budget meaningless | End the burst; a budget is scoped to one window instance. |
| Burst + guard + pause interact badly | All three funnel through the single `admit(job, trigger)` hook, in a defined order, with tests for the combinations. |
