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

**Invocation contract, settled by the spike (§4a.6):** every call runs with
`BEADS_DIR=project.beadsDir` and `BD_NON_INTERACTIVE=1` in the environment, keys success off the
**exit code** (stderr carries warnings on success), and treats `[]` as a legitimate empty result.
`healthy()` is `bd where --json` + a present `database_path`; `beadsDir` itself is discovered by
the same call at registration, never by string-concatenating `.beads` onto the repo path.

**Every call takes a hard timeout — this is the single most important thing item 3 found.** Under
contention `bd` does not error, it **waits indefinitely** (measured: 104s for a 100s hold, rc=0,
empty stderr), and *every* DB-touching command does it — `ready`, `where`, `show`, `close`. A
daemon without timeouts does not get a retryable failure; it gets a wedged poll loop.

- One `timeoutMs` on `execFileFn` for all of `ready`/`claim`/`close`/`get`/`healthy`, defaulting to
  a few seconds (uncontended calls are ~200–700ms). `version()` is the sole exemption — it never
  opens the DB and cannot hang.
- A timeout is **`ETIMEDOUT`, not a bd failure**, and must be reported as "beads is busy" rather
  than "beads is broken" — the project is healthy, something else holds the lock.
- **Killing a blocked call is safe**: a claim killed mid-wait leaves the bead `open` under both
  `SIGTERM` and `SIGKILL`, with no write landing later. So a timed-out `claim`/`close` can be
  treated as *definitely did not happen* and retried on the next poll. This is what makes the
  timeout approach viable at all.
- Because contention is normal (a human running `bd` in the same repo), a timeout is an **expected
  event, logged at info** — not an error state for the project. Repeated timeouts are what deserve
  attention, so surface a consecutive-timeout count rather than alarming on the first.

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

**Spike item 3 measured `--claim` as stronger than that, and the decision stands anyway.** At 1.1.0
it is genuinely compare-and-set: 8 concurrent claims of one bead produced exactly 1 winner, with
the losers exiting rc=1 and naming the winner. That is a real back-stop, and worth *logging* (the
winner's name is a far better diagnostic than "claim failed"). It still does not become our lock:
the lease covers the window **before** the claim lands, it is transactional with the rest of our
state, and it does not depend on upstream keeping a property that reports say has regressed before.
Measured strength here buys belt-and-braces, not a change of owner.

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

M3's spike changed that milestone's shape by measuring instead of assuming. Same discipline.

**Pinned binary: `bd 1.1.0` (Homebrew) + `dolt 2.2.2`, installed 2026-07-25 and `brew pin`ned**
so an unrelated `brew upgrade` can't move it under us. Homebrew's 1.1.0 is also upstream's
latest (`v1.1.0`, 2026-07-04), so there is no pin-vs-latest tension to manage yet.
**Every conclusion below is re-checkable, by two scripts** that build throwaway fixture repos and
assert against whatever `bd` is installed. Both are deliberately outside `npm test` because they
shell out to the real `bd`. Run them after any `bd` upgrade — a FAIL means this section's reasoning
needs revisiting, not that the script is broken.

| Script | Covers | Status |
|---|---|---|
| `docs/spikes/m4a-beads-worktree.sh` | items 1 & 2 — worktree resolution, `ready --json` shape | 24/24 |
| `docs/spikes/m4a-beads-lock-contention.sh` | item 3 — contention, timeouts, claim atomicity, git dirtying | 33/33 |

Both green on 2026-07-25. The contention script takes ~2 minutes: several of its conclusions can
only be established by actually waiting out a held lock.

### Item 1 — `.beads/` in a git worktree: **ANSWERED, and the premise was wrong**

The fear was that `.beads/` would be *absent* from the worktree. The truth is worse, because it
is quieter:

- **`bd init` does not gitignore `.beads/` — it commits it.** Tracked: `.beads/config.yaml`,
  `metadata.json`, `README.md`, `hooks/`, `interactions.jsonl`, and `.beads/.gitignore` itself.
  (`bd init` also auto-commits them for you.)
- **`.beads/.gitignore` ignores `embeddeddolt/`** — the actual 2.1 MB Dolt database. The root
  `.gitignore` additionally gets `.dolt/`, `*.db`, `.beads-credential-key`, `.beads/proxieddb/`.
- **So a worktree gets a *hollow* `.beads/`**: present, plausible-looking, and dataless. This is
  the real hazard. `existsSync(path.join(cwd, '.beads'))` returns **true** in a worktree and
  tells you nothing — a "is beads set up here?" check written that way is actively misleading.

**bd resolves across the worktree boundary on its own, via git.** From both a *sibling* and a
*nested* worktree, `bd where --json` reports the **primary checkout's** paths, and
`bd ready`/`bd update --claim`/`bd close` all read and write the primary's database. Writes made
from the worktree are immediately visible in the primary. Proof that git is the bridge, not a
filesystem upward-walk (a sibling worktree isn't under the primary, so a walk can't explain it):
copy the hollow worktree, delete its `.git` file, and resolution collapses to the local hollow
dir — the `database_path` key **disappears** from `bd where --json` and `bd ready` exits **1**
with `no beads database found`.

**Decision: be explicit anyway. Do not lean on the implicit resolution.**

- Every `bd` call from the scheduler passes **`BEADS_DIR=<projects.beadsDir>`** (verified to work
  even in a directory with *no git at all*), and/or **`-C <primaryCheckout>`** — `-C` is a
  first-class global flag, `git -C` semantics, not a hack.
- Rationale: the implicit path is undocumented behaviour in a CLI with ~93 releases and a known
  breaking change, and its failure mode is silent-and-confusing (a hollow dir that resolves to
  "no database" rather than to an error naming the real cause). Explicit is strictly more robust
  and costs one env var.
- **`projects.beadsDir` stays a stored column and is populated from `bd where --json`, never
  derived by concatenating `path + '/.beads'`.** This is the column's justification, as designed
  — the reason is just different from the one anticipated.
- The *work* runs in the worktree; only `bd` is pointed at the primary. §4a.5's worktree plan
  survives intact.

Two further measured consequences:

- **`healthy()` is `bd where --json`** — rc 0 **and** a `database_path` key present. Cheap, no
  DB write, and it distinguishes "no beads here" from "beads here but unusable". Do not probe
  health by running `ready`.
- **`worktreeRoot` must live outside the repo.** A worktree created *inside* the primary
  (`.worktrees/nested`) shows up as `?? .worktrees/` in the human's `git status` — we'd be
  littering the checkout we promised not to touch. Outside the repo, or the project gitignores it.
- **Polling is git-silent — but `close` is not.** From a committed clean baseline: reads, a
  `--claim` from the worktree, and 6 `bd note` writes all left `git status --porcelain` **empty** in
  both checkouts. ⚠️ **This item never exercised a `close`, and `bd close` *does* dirty the tracked
  `.beads/interactions.jsonl` — see item 3's tail below.** Scope the claim to reads and `--claim`.

Worth knowing before we ask anyone to adopt beads: **`bd init` is invasive.** Beyond `.beads/` it
wrote `AGENTS.md`, `CLAUDE.md`, `.claude/`, `.codex/`, `.agents/` and committed them. Another
reason adoption is a human's deliberate act in their repo, not something we do for them.

### Item 2 — `bd ready --json`'s real schema: **largely answered as a by-product**

Measured against 1.1.0. Top level is a **bare array**, not an envelope; empty is `[]` (never
`null`); rc is **0** on empty and **1** on a real failure.

| Emitted field | Type | Note |
|---|---|---|
| `id` | string | hash-based, e.g. `sp-2qy` |
| `title` | string | |
| `status` | string | |
| `priority` | **int** | 0–4, `0` = critical |
| `issue_type` | string | **not** `type` — exactly the rename to absorb at the boundary |
| `created_at` / `updated_at` | ISO-8601 Z string | |
| `labels` | string[] | **the key is omitted entirely when a bead has no labels** — not `[]`, not `null`. Normalise `labels ?? []` or an `autoLabel` filter written as `b.labels.includes(...)` throws on the first unlabelled bead. |
| `dependency_count` / `dependent_count` / `comment_count` | int | |

- **No `assignee` in `ready` output.** So §4a.5's "abandon if reassigned" pre-launch re-read must
  use `bd show <id> --json`, which *does* carry `assignee`, `status`, and `started_at`.
- **`bd show --json` returns a one-element *array*, not an object** — unwrap `[0]`.
- `--label` filters as expected (AND across repeats; `--label-any` is the OR variant).
- Blocking dependencies work as documented: `B blocks-on A` keeps B out of `ready` until A is
  **closed** — A merely being `in_progress` is not enough.
- **`ready` excludes `in_progress`**, so a successful `bd update --claim` also removes the bead
  from subsequent polls. Useful belt-and-braces, but it does **not** demote our lease: the lease
  covers the window *before* the claim lands and the case where the claim write fails.
- `ready --explain --json` is a **different top-level shape** — an envelope
  `{ready: [], blocked: [{…, blocked_by: [...], blocked_by_count}], summary: {...},
  schema_version: 1}`. `schema_version` is present on `where` and `explain` but **not** on plain
  `ready`; assert it where it exists.
- **stderr carries warnings on success** (`beads.role not configured (GH#2950)`, `.beads` perms
  0755 vs recommended 0700). The adapter must key failure off the **exit code**, never off
  non-empty stderr.
- Set **`BD_NON_INTERACTIVE=1`** on every daemon invocation (auto-detected for non-TTY, but a
  daemon should not rely on detection). Note `BD_JSON_ENVELOPE` exists as an env var — leave it
  unset, and pin the assumption that plain `ready` is a bare array.

Still to confirm under item 3's fixture: `bd update --claim`'s own JSON shape.

### Item 3 — lock contention: **ANSWERED. It blocks — silently, and without limit**

Re-checkable via a second script, **`docs/spikes/m4a-beads-lock-contention.sh`** (33/33 green).
The lock holder is a real `dolt sql -q 'select sleep(N)'` against the embedded DB.

Backend is **embedded (`bd info` → `Mode: direct`)**, and embedded mode has **no raw-SQL escape
hatch**: `bd sql` returns `'bd sql' is not yet supported in embedded mode`. So the CLI is the only
interface; there is no "just read the DB directly" fallback available to us.

**The headline: contention is not an error. It is an unbounded wait.** With the DB held, a claim
waits out the *entire* hold and then succeeds — measured at **104s of waiting for a 100s hold**,
`rc=0`, **empty stderr**, correct final state, no corruption. There is no lock timeout, no
`SQLITE_BUSY`-style code, and nothing in stderr to key a retry off.

This inverts the expected design. **There is no retry policy to write, because there is no error
to retry.** The only protection is a **client-side timeout that we impose**, and the failure mode
it defends against is a daemon that hangs forever rather than one that fails loudly.

**Every DB-touching command blocks — including the health probe.** Each measured against its own
fresh holder (a blocking read consumes the holder's lifetime and masks the next command, which is
how an earlier version of this probe fooled itself into "reads don't block"):

| Command | Blocks? |
|---|---|
| `bd ready --json` (the poll loop) | **yes** |
| `bd where --json` (`healthy()`) | **yes** |
| `bd show --json` (pre-launch re-read) | **yes** |
| `bd close` | **yes** |
| `bd --version` | **no** (~200ms — never opens the DB) |

So `healthy()` is cheap but **not** hang-proof, and the poll loop itself can wedge. `bd --version`
is the *only* call safe to make without a timeout, which is convenient: the boot version/mismatch
assertion cannot hang.

**A client-side timeout is safe — no phantom writes.** Killing a claim that is blocked mid-wait
leaves the bead **`open`** under both `SIGTERM` and `SIGKILL`; the write does not land later when
the holder releases. So timeout-then-kill cannot half-apply a claim, and a timed-out claim can be
treated as "definitely did not happen". (`SIGTERM` is enough — the blocked process does die.)

**`bd update --claim` *is* compare-and-set.** 8 concurrent claims of one bead → **exactly 1
winner**; the other 7 exit **rc=1** with a parseable `Error claiming <id>: issue already claimed
by <actor>`, and `assignee` is the single winner. No corruption. This is stronger than §4a.5
assumed — but it does **not** promote `--claim` to our lock, because the lease covers the window
*before* the claim lands. It does make `--claim` a genuine back-stop that also *names* the winner,
which is a better log line than "claim failed".

`bd update --claim --json` returns a **one-element array** (same shape as `show`) carrying
`assignee` and `started_at`.

**Config discrepancy worth pinning:** `--help` documents `--dolt-auto-commit` as `Default: off`,
but a `bd init`-ed repo reports **`on`** (`bd config get dolt.auto-commit`). The effective value is
what governs how eagerly writes hit git, so the spike asserts `on` and we do not trust the help text.

`--readonly` rejects writes (`operation 'update' is not allowed in read-only mode`) — a usable
safety belt for the *work* process, asserted in the companion script.

**Consequence for §4a.3: every `bd` call takes a hard timeout.** See the invocation contract.

### Item 3's sting in the tail — `bd close` dirties the human's checkout

Item 1 claimed "polling is git-silent". That is **true for reads and for `--claim`, and false for
`close`** — item 1 simply never exercised a close.

`bd close` appends exactly **one line** to `.beads/interactions.jsonl`, which is **git-tracked**,
leaving ` M .beads/interactions.jsonl` in the working tree. Reproduced 3/3. The entry is an audit
`field_change` record (`status: in_progress → closed`).

**It cannot be turned off.** Neither `BD_NO_AUDIT=1` nor `audit.enabled=false` suppresses it, and
there is no config key for it — `bd audit --help` says the file "is intended to be versioned in
git". This is design, not a bug.

**The worktree does not shield the primary.** `interactions.jsonl` follows the *resolved beads
dir*, so a close run from the worktree (or via `-C`) still dirties the **primary** checkout, while
leaving the worktree clean. §4a.5's worktree isolation protects the human from our *file edits*;
it cannot protect them from this.

So the promise "we never touch your checkout" needs one honest asterisk: **a scheduled close
leaves one appended audit line as an uncommitted modification in the human's working tree.** We
should not paper over it.

**Decided (2026-07-25, with the user): (a) + (b).**

- **(a) Leave the line.** It is intended to be committed, it is append-only, and one line per
  completed job will not conflict with the human's own edits. We do not try to suppress it.
- **(b) Surface it in the Projects tab as *expected* noise** — a plain-language note that a
  completed scheduled bead leaves one appended audit line in `.beads/interactions.jsonl`, so it
  never reads as corruption or as the scheduler having gone rogue in the checkout.
- **(c) Committing it ourselves is rejected** — it would make the scheduler a writer of the human's
  git history, a far bigger promise to break than a dirty file.
- **(d) Documented per-project escape hatch:** a project that does not want the audit trail
  versioned can `git rm --cached .beads/interactions.jsonl` and gitignore it. That is the only
  thing that achieves actual silence, and it is deliberately **the repo owner's call, not ours** —
  the scheduler never does this to someone's repo. (Mechanically obvious; not spike-verified.)

What we must *not* do is claim silence we do not have.

## 4a.7 Cost attribution — the unsolved bit worth naming

`run_usage` (M1) keys learned cost by **`jobId`**, but a bead's materialised job is ephemeral
(reaped per §4.3). So burst planning would forget what a bead costs the moment its job is
reaped — the learned-cost feature would silently degrade to the default estimate forever.

Options considered: key `run_usage` additionally by `(projectId, beadId)`; aggregate per
`(projectId, bead type/label)`; or write the measured cost back to the bead's `Metadata` blob,
which keeps it with the task but makes us a writer of task data.

**RESOLVED while implementing (2026-07-25) — the premise was the bug, and no new table is
needed.** The problem only existed because §4.3 assumed the materialised job row is *reaped*
after each run. It doesn't have to be. `lib/projects.js` materialises **one job row per bead,
reused on every run of that bead** (looked up via `findJobByBead`, which matches
`json_extract(params,'$._beadId')`). Because `run_usage` already keys by `jobId`, that stable row
makes `avgDeltaForJob` accumulate the bead's real observed cost across runs for free — no schema
change, no second aggregation path, and the existing median-not-mean logic applies unchanged.

The cost is a few hundred bytes of `jobs` row per bead ever run, which also gives the user a
visible history of that bead's runs. Reaping, if it is ever wanted, becomes a pruning policy over
old rows rather than something on the hot path — and the burst planner's per-project median
fallback is still available for a bead that has never run. Covered by a test asserting the job row
is reused and the learned delta survives into the next run.

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

Added by the spike, because these are measured traps rather than imagined ones:

- a bead whose `ready` entry **omits `labels`** does not throw and is correctly judged ineligible
  under `autoLabel` (the real 1.1.0 shape — see §4a.6)
- a **hollow `.beads/`** (present dir, no `database_path` from `bd where`) is reported as
  unhealthy with that reason, and the project contributes zero ready tasks rather than erroring
  obscurely
- a `bd` call that exits **0 with non-empty stderr** is treated as success, not failure
- `beadsDir` is taken from `bd where --json`; no code path derives it by concatenation

From item 3 (contention) — the fake `bd` simulates a hang by never calling back until killed:

- **every adapter call passes a `timeoutMs`**; a fake `bd` that never returns causes the call to
  reject as a timeout instead of hanging the test — asserted per method
  (`ready`/`claim`/`close`/`get`/`healthy`), because item 3 showed *all* of them can block
- `version()` is the documented exemption and needs no timeout
- a **timed-out `ready`** leaves the project healthy and pollable (reported "busy", not "error"),
  and the next poll proceeds normally — a hang must not latch the project into a failed state
- a **timed-out `claim`** is treated as *did not happen*: the lease is released and the bead is
  eligible again next poll (justified by the measured absence of phantom writes)
- a **timed-out `healthy()`** does not flap the project to `error`
- consecutive timeouts increment a counter that the Projects tab can surface; a single timeout does
  not raise an alarm
- a `claim` that fails with **`already claimed by <actor>`** is logged with the winning actor's name
  and does not abort the run (the lease is authoritative)

## Risks

| Risk | Mitigation |
|---|---|
| ~~`.beads/` invisible inside a git worktree~~ | **Retired by spike item 1 — the real shape is a *hollow* `.beads/` (tracked config, gitignored `embeddeddolt/`), which is worse because an `existsSync` check passes.** Mitigated by always passing `BEADS_DIR`/`-C` and by probing health with `bd where --json` requiring `database_path`. |
| `bd` CLI churn breaks us | One adapter, pinned version, boot assertion + visible banner, normalised shapes at the boundary. |
| `--claim` race double-runs a bead | Our own transactional lease is the lock; `--claim` is advisory only. Tested. Spike item 3 measured `--claim` as compare-and-set at 1.1.0 (1 winner of 8), so this is now belt-and-braces rather than the sole defence — the lease still owns the pre-claim window. |
| **A `bd` call hangs and wedges the poll loop** | **The real failure mode found by item 3: contention produces an unbounded silent wait (104s for a 100s hold, rc=0, empty stderr), and it affects every DB-touching command including `healthy()`.** Mitigated by a hard client-side `timeoutMs` on every call (only `bd --version` is exempt), treating a timeout as "busy, retry next poll" rather than an error, and relying on the measured fact that killing a blocked call leaves no phantom write. |
| A scheduled `close` dirties the human's working tree | Unavoidable and by design: `bd close` appends one line to the git-tracked `.beads/interactions.jsonl`, cannot be suppressed (`BD_NO_AUDIT`/`audit.enabled` have no effect), and lands in the **primary** checkout even when run from the worktree. Mitigation is honesty, not concealment — surface it as expected noise in the Projects tab and drop the unqualified "we never touch your checkout" claim. |
| Scheduler and human collide in one checkout | Run in a worktree; later, defer on M5's active-session signal. |
| Scheduler runs a task nobody meant to be autonomous | Opt-in `autoLabel` (never opt-out) **plus** human activation. Two independent gates. |
| Learned cost lost when jobs are reaped | §4a.7 — decide attribution in the spike, or bursts quietly regress to default estimates. |
| Projects adopt beads then let it rot, so `bd ready` is empty or stale | Surface ready-count and staleness per project; prove the loop on one repo before rolling out. |
