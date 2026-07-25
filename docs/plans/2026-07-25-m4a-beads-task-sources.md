# M4a — Beads task sources: projects register, the scheduler polls

Design context: [`2026-07-25-launchbox-design.md`](../specs/2026-07-25-launchbox-design.md).
User-facing explainer (global, machine-wide): `~/.claude/docs/beads-task-tracking.md`.
Supersedes §4.2's `backlog_tasks` in [`2026-07-25-m4-backlog-bursts.md`](./2026-07-25-m4-backlog-bursts.md).
Depends on **M1** (usage + `run_usage`), **M2** (guard + `admit`), **M3** (pause + graceful stop).
Verify: `npm test`, then live.

**Goal:** other projects on this machine declare their own tasks in **beads** (`bd`), and the
scheduler picks up whatever is *actionable* — dependency-ready, opted-in, and affordable.

**Definition of done:** a repo with a `.beads/` graph and a committed `.scheduler.json` can be
discovered, activated by a human, and have its ready-and-labelled beads run on schedule with
the bead claimed and closed; a bead blocked by an open dependency is never run; and an
interactive session in the same repo can work alongside the scheduler without either
corrupting the other's work.

---

## 4a.1 The decision, and what it rests on

**Beads is the source of truth. The scheduler polls `bd ready --json` per registered repo and
mirrors nothing.**

Rejected alternative: copy tasks into a scheduler-owned table. A copy needs reconciliation
forever — every edit in either place is a potential divergence, and beads' whole value is the
dependency graph, which a flat mirror would have to re-implement to stay useful.

Consequences that make this cheap:

- Each repo keeps its own independent `.beads/`. We depend on **nothing** beyond single-repo
  beads, which is the part that is well documented and verified. Beads' multi-repo story
  (prefix routing, federation) could not be confirmed from primary sources, so we build the
  aggregation ourselves and never rely on it.
- No MCP server. Registration is a property of a *repo*, not of a conversation, so MCP has
  the wrong lifetime for it; task filing already works through `bd`. (An official `beads-mcp`
  exists if a conversational interface is ever wanted — it is not on our path.)
- No completion callbacks. The scheduler *is* what runs the work, so it closes the bead
  itself. Callbacks would only matter if something else did the work.

### What survives of M4, and what dies

| M4 section | Fate |
|---|---|
| §4.1 measured live ceiling | **Survives unchanged.** Still the core of bursts. |
| §4.2 `backlog_tasks` table | **Dies.** Beads owns task definitions. `bursts` survives as written. |
| §4.3 materialise as normal `jobs` rows | **Survives, and is what makes this small** — a bead becomes a one-shot job and inherits scheduling, concurrency caps, logs, SSE, the M2 guard and M3 pause for free. |
| §4.4 burst planning/enforcement | Survives; task *selection* now reads `bd ready` instead of `backlog_tasks`. |
| §4.5 Backlog tab | Becomes a **Projects + ready-work** tab; bursts keep their preview/confirm screen. |

So a burst becomes: *"spend ~15% of my session limit running ready beads from these
projects."* Same ceiling, better task source.

## 4a.2 Data model — two small tables, no task table

```sql
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,          -- repo root containing .scheduler.json
  beadsDir TEXT,                      -- resolved .beads location (see 4a.6 — NOT always path/.beads)
  state TEXT NOT NULL DEFAULT 'pending', -- pending | active | paused | error
  config TEXT NOT NULL DEFAULT '{}',  -- last-read .scheduler.json
  bdVersion TEXT,                     -- what `bd --version` said at registration
  lastPollAt TEXT, lastPollOk INTEGER, lastError TEXT,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
-- Our lock, not beads'. Single daemon + transactional = airtight against double-running.
CREATE TABLE IF NOT EXISTS task_leases (
  projectId TEXT NOT NULL,
  beadId TEXT NOT NULL,
  runId TEXT,
  state TEXT NOT NULL,                -- held | done | released
  acquiredAt TEXT NOT NULL, releasedAt TEXT,
  PRIMARY KEY (projectId, beadId)
);
```

Pure additions, no migration. Both wiped by `cleanupAll()`. `state: 'pending'` is the airlock
in 4a.4 — a discovered project runs nothing until a human activates it.

## 4a.3 `lib/beads.js` — the only place that knows `bd` exists

```js
createBeads({ db, execFileFn, bdPath, now }) → {
  version(),                                  // `bd --version`, cached
  ready(project, {label, limit}),             // `bd ready --json` → normalised beads[]
  claim(project, beadId),                     // `bd update <id> --claim`  (advisory, see 4a.5)
  close(project, beadId),                     // `bd close <id>`
  get(project, beadId),                       // re-read for the pre-launch check
  healthy(project),                           // cheap probe for the Projects tab
}
```

Every call is `--json` and goes through here, so a breaking `bd` change is a one-file fix.

**Version policy:** pin the version, record it per project at registration
(`projects.bdVersion`), assert `bd --version` at boot, and surface a visible banner on
mismatch rather than failing obscurely mid-poll. `bd` shipped ~93 releases in 9 months with at
least one breaking API change, so pinning is not paranoia. Revisit deliberately every couple
of months; never auto-upgrade.

**Normalise at the boundary.** `ready()` returns our own shape (`{id, title, priority, type,
labels, ...}`), never raw `bd` JSON, so field renames upstream don't leak into the scheduler.

## 4a.4 Registration: repo declares, human activates

Two halves with different owners — this split is the safety property, not a convenience.

**1. The project declares itself** with a committed `.scheduler.json` at its root, so the
declaration is reviewable in git and survives re-clones:

```jsonc
{
  "enabled": true,
  "autoLabel": "unattended",   // ONLY beads with this label are eligible. Opt-in, never opt-out.
  "cwd": ".",
  "maxConcurrent": 1,
  "defaults": { "timeoutMin": 30, "model": "default", "notify": "failure" },
  "budget": { "minHeadroomPct": 20 }   // per-job M2 override, same shape as jobs.params.budget
}
```

**2. A human activates it** in the Projects tab. Discovery (globbing a `projectRoots` setting
for `.scheduler.json`) only ever creates `state: 'pending'`.

**An agent may write this file, run `bd init`, and file beads. An agent must never activate a
project.** If an agent could both register a repo and have us autonomously run its tasks, an
agent could arrange for arbitrary unattended work to run on this machine. The activation click
is the airlock, and it is deliberately not automatable.

**`autoLabel` is mandatory, and absence means nothing runs.** Most beads in a repo need a human
in the loop; without an explicit opt-in label the first poll would pick up someone's design
spike and run it unattended. A config with no `autoLabel` is an error, not a default-to-all.

## 4a.5 Concurrency: the scheduler and a live session in the same repo

Two different resources are contended, and only one is a database problem.

**Our lease is the lock.** Insert `task_leases` (transactional, single daemon) *before*
launching. `bd update --claim` is written afterwards as a **notice board** so a human's session
can see the bead is taken — if that write fails the run proceeds anyway, because the lease is
authoritative. This is deliberate: beads has open reports of `--claim` races handing the same
ready issue to two agents, so **`--claim` must never be our only lock.**

**Re-read immediately before launch** and abandon if the bead is no longer ready or was
reassigned. Closes the window where a human grabbed it seconds earlier.

**Keep beads writes tiny.** Embedded mode is single-writer. A claim and a close are
milliseconds; bounded retry with jitter absorbs contention with an interactive `bd`. This is
what lets us avoid a `dolt sql-server` per project.

**The real hazard is the working tree.** Two agents editing one checkout is far worse than a DB
race, and no amount of task-level locking prevents it. So scheduled work runs in a **git
worktree**, not the primary checkout — you stay mid-edit on `main`, untouched. The runner
already takes a per-job `cwd`, so this is mostly plumbing plus lifecycle (create, reuse, reap).

**Deferring to humans (once M5 lands).** M5 reads `~/.claude/projects/**` session transcripts,
which is a genuine "someone is working in this repo right now" signal. Holding scheduled work
in a project with an active session in the last N minutes falls out nearly free, and is a
better interlock than anything we could invent. Design for it; don't block M4a on it.

## 4a.6 Spike first — three things to verify before building

M3's spike changed that milestone's shape by measuring instead of assuming. Same discipline:

1. **`.beads/` and git worktrees — the one that could sink the worktree plan.** Worktrees share
   `.git` but *not* untracked directories. If `.beads/` is gitignored (likely: Dolt data
   shouldn't be committed), **a worktree will not contain the beads DB at all.** Verify, then
   decide: point `BEADS_DIR` at the primary checkout's `.beads` (probable answer, and why
   `projects.beadsDir` exists as a column rather than being derived), or commit `.beads/`, or
   run `bd` with `cwd` = primary checkout while the *work* happens in the worktree. Do not
   write the poller until this is settled.
2. **`bd ready --json`'s actual schema** against the pinned binary — exact field names and
   types, empty-result shape, and whether `--label` filters as expected. Normalise from what it
   really emits, never from docs.
3. **Lock contention behaviour** — hold an interactive `bd` command open, fire a claim from the
   daemon, and observe: does it block, error, or corrupt? That answer sets the retry policy,
   and whether embedded mode is viable at all.

## 4a.7 Cost attribution — the unsolved bit worth naming

`run_usage` (M1) keys learned cost by **`jobId`**, but a bead's materialised job is ephemeral
(reaped per §4.3). So burst planning would forget what a bead costs the moment its job is
reaped — the learned-cost feature would silently degrade to the default estimate forever.

Options, to be decided in the spike: key `run_usage` additionally by `(projectId, beadId)`; or
aggregate per `(projectId, bead type/label)` which generalises better across one-off beads; or
write the measured cost back to the bead's `Metadata` blob, which keeps it with the task but
makes us a writer of task data. **Leaning to per-`(projectId, beadId)` plus a per-project
median fallback**, since most beads run once and the project-level median is what a fresh bead
actually needs.

## 4a.8 API & UI

- `GET /api/projects`, `POST /api/projects` (register a path → `pending`),
  `PUT /api/projects/:id` (activate/pause — the human airlock), `DELETE /api/projects/:id`
- `POST /api/projects/discover` → scan `projectRoots`, return candidates (writes only `pending`)
- `GET /api/projects/:id/ready` → live `bd ready` passthrough, normalised
- Projects tab: path, state, `bd` version + mismatch warning, last poll, ready count, and a
  plain-language reason when a project is contributing nothing (no `autoLabel`, all blocked,
  `bd` missing, beads dir unresolved). "Contributing nothing" must never be silent.
- Ready-work list per project showing *why* something is ready or blocked (`bd ready --explain`
  is the natural source).

Settings: `projectRoots`, `beadsPollSec`, `bdPath`, `worktreeRoot`.

## 4a.9 Tests

All with a **fake `bd`** (`execFileFn` injection) — no test shells out to a real binary, same
rule as "no test spawns the real `claude`".

- discovery creates `pending` only; a `pending` project is never polled and never runs anything
- activation requires an explicit state change; no code path activates implicitly
- a config with no `autoLabel` is an error, and the project contributes zero ready tasks
- only beads carrying `autoLabel` are eligible; others are ignored even when ready
- a bead with an open **blocking** dependency is never offered (fake `bd ready` omits it) —
  and a bead related only by `related`/`discovered-from` **is** offered
- lease: two poll cycles cannot double-run one bead; a held lease blocks the second
- a failed `claim` write does **not** prevent the run (lease is authoritative) but is logged
- pre-launch re-read aborts the run when the bead is no longer ready
- `bd` version mismatch surfaces a warning and does not silently poll on
- a `bd` failure marks the project `error` with the reason and does not kill the poll loop
- materialised job carries `params._beadId`/`_projectId`; on `ok` the bead is closed; on
  `fail`/`stopped`/`killed` it is **not** closed and the lease is released
- an M3 `stopped` run leaves the bead open and unclaimed-for-retry (a wind-down is not a failure)
- `cleanupAll` wipes `projects` and `task_leases`

## Risks

| Risk | Mitigation |
|---|---|
| `.beads/` invisible inside a git worktree | Spike item 1, before any poller code. `projects.beadsDir` is explicit rather than derived precisely so the answer is storable. |
| `bd` CLI churn breaks us | One adapter, pinned version, boot assertion + visible banner, normalised shapes at the boundary. |
| `--claim` race double-runs a bead | Our own transactional lease is the lock; `--claim` is advisory only. Tested. |
| Scheduler and human collide in one checkout | Run in a worktree; later, defer on M5's active-session signal. |
| Scheduler runs a task nobody meant to be autonomous | Opt-in `autoLabel` (never opt-out) **plus** human activation. Two independent gates. |
| Learned cost lost when jobs are reaped | §4a.7 — decide attribution in the spike, or bursts quietly regress to default estimates. |
| Projects adopt beads then let it rot, so `bd ready` is empty or stale | Surface ready-count and staleness per project; prove the loop on one repo before rolling out. |
