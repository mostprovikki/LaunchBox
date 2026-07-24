# LaunchBox — Design (v2)

2026-07-25. Supersedes the scope of [`2026-07-17-claude-scheduler-design.md`](2026-07-17-claude-scheduler-design.md) (still accurate for the scheduling core; read it first).

## What changes

v1 was "a friendly frontend for cron-style jobs" with `claude` as one job type. v2 adds a **second core pillar**: managing the Claude Code sessions on this machine, and scheduling work against **real subscription usage limits** so paid capacity isn't wasted.

Two pillars, one daemon:

1. **Scheduling** — unchanged. Cron/one-shot jobs, pluggable extension types, launchd-backed daemon.
2. **Claude session & usage management** — live view of every session on the machine, ground-truth usage/limit state, and scheduling policies driven by it.

Product name in UI/docs is **LaunchBox**. The launchd label (`com.claude-scheduler`), npm package name, and data dir (`~/.claude-scheduler`) stay as-is for now — renaming those needs a migration and is deliberately deferred (see M6).

## Milestones

| M | Plan | Delivers |
|---|---|---|
| M1 | [m1-usage-foundation](../plans/2026-07-25-m1-usage-foundation.md) | Usage monitor (ground truth), usage banner on main page, settings |
| M2 | [m2-usage-aware-scheduling](../plans/2026-07-25-m2-usage-aware-scheduling.md) | Reset-anchored schedules, budget guard/reserve, burn-down planner |
| M3 | [m3-pause-modes](../plans/2026-07-25-m3-pause-modes.md) | Soft pause (graceful wind-down) + hard pause (force stop) |
| M4 | [m4-backlog-bursts](../plans/2026-07-25-m4-backlog-bursts.md) | Backlog task pool + "spend N% of session/weekly limit" bursts |
| M5 | [m5-sessions-dashboard](../plans/2026-07-25-m5-sessions-dashboard.md) | Sessions dashboard (port of claude-sessions-dashboard, MIT) |
| M6 | deferred | Full LaunchBox rename (launchd label, package, data dir) + optional `node:sqlite` migration |

---

## Findings that constrain the design

Everything below was verified on this machine on 2026-07-25 (Claude Code 2.1.206, Homebrew build). Where a claim is inherited from docs rather than measured, it says so.

### 1. Ground-truth usage IS available, free, and structured

The `get_usage` control request over the stream-json control channel:

```bash
printf '%s\n' '{"type":"control_request","request_id":"1","request":{"subtype":"get_usage"}}' \
  | claude -p --input-format stream-json --output-format stream-json --verbose
```

Response at `.response.response`. Measured cost: **`total_cost_usd: 0`, no model turn, ~2s wall**. Verified payload on this account:

```
subscription_type: "team"   rate_limits_available: true
five_hour      24%  resets_at 2026-07-25T00:19:59.050491+00:00
seven_day      63%  resets_at 2026-07-25T17:59:59.050519+00:00
weekly_scoped  89%  resets_at 2026-07-25T18:00:00.050822+00:00
               scope.model.display_name "Fable", severity "warning", is_active true
```

Design consequences, each load-bearing:

- **Percent only, no absolute budget.** `limit_dollars` / `used_dollars` / `remaining_dollars` are all `null` on this plan. So "spend 20% of my session limit" is expressible, but "how many jobs fit in 20%?" is **not** knowable a priori. → We must *learn* cost per job by sampling usage before/after runs (M1 records it, M4 depends on it).
- **Never hardcode the bucket list.** Alongside the real buckets the payload carries `seven_day_oauth_apps`, `seven_day_cowork`, `seven_day_omelette`, `tangelo`, `iguana_necktie`, `omelette_promotional`, `nimbus_quill`, `cinder_cove`, `amber_ladder` — all `null`, clearly unreleased. Iterate generically: derive named windows from any `rate_limits.*` object exposing `utilization`/`resets_at`, and use `limits[]` (`kind`/`group`/`percent`/`severity`/`resets_at`/`scope`/`is_active`) for display.
- **Experimental.** The CLI's own schema describes it as *"Experimental — the response shape may change."* The SDK method is literally named `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`. → Store the raw payload, parse defensively, and **fail open** everywhere (a monitoring break must never silently stop the scheduler).
- **`rate_limits_available: false`** for API-key / Bedrock / Vertex sessions. Must degrade cleanly.
- The underlying `GET /api/oauth/usage` is itself aggressively rate-limited. → Poll floor **60s**, default **180s**, with backoff on failure.

### 2. Available control-request subtypes (verified in the 2.1.206 binary)

`initialize`, `interrupt`, `set_model`, `set_permission_mode`, `get_usage`, `can_use_tool`, `hook_callback`, `mcp_message`, `control_cancel_request`.

- `interrupt` makes **soft pause genuinely graceful** (M3) rather than SIGTERM-and-hope.
- `set_model` enables budget-driven model routing mid-run (future; see M2 "not doing yet").
- Using any of these requires the child be spawned with `--input-format stream-json` **and a piped stdin**. The runner currently uses `stdio: ['ignore', …]`, so this is a real change to the `claude` extension — a shared prerequisite for M3.

### 3. Token counts in session JSONL are inflated ~2.5×

Claude Code writes **one assistant row per content block** (`thinking`, `text`, `tool_use`), and every one of those rows repeats the **same** `usage` object. Measured across all 10 session files on this machine:

| field | naive sum | deduped by `message.id` | inflation |
|---|---|---|---|
| input | 274,069 | 108,969 | 2.52× |
| output | 1,635,633 | 605,936 | 2.70× |
| cache read | 474,003,630 | 232,238,303 | 2.04× |
| cache write | 5,448,622 | 2,086,241 | 2.61× |

2,140 assistant rows → 1,013 unique `message.id`. **Any token accounting must dedupe on `message.id` (fallback `requestId`).** The upstream `claude-sessions-dashboard` does not, so its token/cost figures are wrong; do not port that loop as-is. `ccusage` and similar jsonl-summing tools inherit the same flaw.

Corollary: jsonl summation is an **estimate** regardless — it cannot see usage from other devices, claude.ai, or Cowork, all of which count against the same server-side limits. Use it for *attribution* (which job cost what), never for *limits*.

### 4. Secondary usage sources (fallback / enrichment, not primary)

| Source | Gives | Verdict |
|---|---|---|
| `statusLine` stdin `rate_limits` | `used_percentage` float, `resets_at` **epoch seconds** — only `five_hour`/`seven_day` | Officially documented, free, no network. But fires only inside the interactive TUI, so it needs a registered statusline script dumping to a file, and goes stale when no session runs. Optional enrichment. |
| `rate_limit_event` in stream-json | `status`, `resetsAt`, `rateLimitType`, sometimes `utilization` | Free **push** signal from any running job — use to invalidate the poll cache early. `utilization` usually absent until near a limit. |
| `anthropic-ratelimit-unified-*` headers | fraction + epoch reset, per window | Origin of all the above, but reachable only by proxying traffic. Not doing this. |
| `GET /api/oauth/usage` direct | richest payload | Undocumented; needs the OAuth token (macOS Keychain: service `Claude Code-credentials`). `get_usage` already wraps it *with* token refresh. Don't reimplement. |

Verified negatives worth recording so nobody re-searches: **nothing on disk caches usage or reset times** (grepped all of `~/.claude`); session `.jsonl` files contain **no** rate-limit rows; **OpenTelemetry exposes no rate-limit metric** (all 8 metrics are session/LOC/PR/commit/cost/token/edit-decision/active-time); there is **no `claude usage` subcommand or `--usage` flag**; the 429 error text is human-readable only in 2.1.206.

### 5. Legal / ToS position

Full sourced analysis lives in the M1 plan appendix. The short version:

- **`subscription_type` is `team`** → governed by Anthropic's **Commercial Terms**, not the Consumer Terms (per Claude Code's own legal page: *"Commercial Terms — for Team, Enterprise, and Claude API users"*).
- The Consumer Terms clause prohibiting *"access the Services through automated or non-human means, whether through a bot, script, or otherwise"* **has no counterpart in the Commercial Terms** — it does not apply here.
- The *"Advertised usage limits for Pro and Max plans assume ordinary, individual usage"* sentence is **expressly scoped to Pro and Max** — it does not apply to Team either.
- What *does* apply: Commercial Terms **D.2** (comply with the Usage Policy and Service Specific Terms) and **I.3.a(iii)**, permitting suspension where providing the service *"would result in a material increase in the cost of providing the Services"* — the only cost-keyed clause in any Anthropic document, and commercial-only.
- Scripted/scheduled/headless invocation of one's own subscription is **first-party supported** (`claude -p`, Agent SDK, `claude setup-token` for CI, in-session cron, Desktop scheduled tasks, and Routines — which run unattended on subscription usage by design).
- **Bright line, unchanged:** Anthropic *"does not permit third-party developers to offer Claude.ai login or to route requests through Free, Pro, or Max plan credentials on behalf of their users."* LaunchBox must stay local-only, driving the user's own installed `claude` with their own credential. No hosted component, no accepting someone else's token, no pooling or proxying — ever.
- Note also: this is an **admin-managed employer seat** (`member_dashboard_available: false`, `can_purchase_credits: false`, `can_toggle: false`). The capacity being managed is the organisation's and may be pooled. That is an internal-policy consideration, not an Anthropic-terms one — and it is the reason **reserve/guard defaults ship conservative and maximization is opt-in**.

**Design rule derived from this:** frame and default every budget feature as *"don't waste capacity already paid for,"* with explicit user-set ceilings — not *"saturate the cap."* Same capability, materially better posture.

### 6. Licensing of the ported dashboard

`claude-sessions-dashboard` is **MIT © wannabemrrobot**. Permits use/modify/merge/sublicense/sell commercially; sole obligation is to include the copyright notice and license text. Bundled **Lucide** icons are **ISC** (the upstream README says ISC, an inline comment says MIT — ISC is correct). The local copy has **no `.git`**, so no provenance commit can be pinned; record the upstream URL and copy date instead. Deliverables in M5.

---

## Architecture: how this lands in the existing codebase

The codebase convention is a `createX({...deps})` factory per subsystem with **every external effect injectable** (`spawnFn`, `notifyFn`, `execFileFn`, `now`, `minuteMs`). That is what makes the 53-test suite hermetic. All new subsystems follow it.

### New modules

| Module | Factory | Job |
|---|---|---|
| `lib/usage.js` | `createUsageMonitor({db, spawnFn, getClaudePath, intervalMs, now})` | Poll `get_usage`, persist snapshots, emit `usage` events, expose `snapshot()`/`window(name)`/`refresh()` |
| `lib/budget.js` | `createBudgetPolicy({db, usage})` | Turn settings + snapshot into an `admit(job, trigger)` decision and a burn-down plan |
| `lib/pause.js` | `createPauseController({db, runner, extensions})` | `off`/`soft`/`hard` mode state machine (M3) |
| `lib/backlog.js` | `createBacklog({db, ...})` | Backlog pool + burst planner (M4) |
| `lib/sessions.js` | `createSessionIndex({db, root, ...})` | Scan/parse `~/.claude/projects` with mtime-keyed caching (M5) |

### Seams (verified by reading the source)

- **Admission gate → `runner.start()`.** Add an injectable `admit(job, trigger)` to `createRunner`, defaulting to allow. `start()` already branches three ways (overlap-skip / queue / launch); a fourth check before `atCapacity` covers **scheduled, manual and retry** triggers uniformly. Decorating the runner from outside would miss the manual route (`server.js:81`) and the internal retry path (`lib/runner.js:159`).
- **Do NOT park budget-blocked runs in the existing queue.** `drainQueue()` is only ever called from `finish()` — a run held on a time/budget condition would sit forever — and `queued` rows are swept to `fail` at boot (`lib/db.js:198`) while `queue` is memory-only. Blocked fires are **recorded as skipped with a reason**; deferral is expressed by *scheduling*, not queueing.
- **Reset-anchored fires → `lib/scheduler.js`.** Arm a one-shot `Cron` at `resets_at + offset + jitter`, re-armed on each `usage` event. Beware: the `once`-entry teardown/auto-disable at `scheduler.js:16-27` runs *before* the fire decision.
- **New DB tables are the cheapest change available.** `SCHEMA` is `exec`'d idempotently on every open, so pure table additions need **no migration code**. Gotchas: new *columns* on `jobs`/`runs` need both a `migrate()` block **and** an entry in `JOB_COLS`/`RUN_COLS` or writes silently no-op; there is no `PRAGMA user_version`; `cleanupAll()` must learn about every new table.
- **A new run status is cross-cutting** — 10 call sites: `lib/db.js:188,198`, `server.js:87,132`, `public/app.js:129,408,436,471`, `public/index.html:56-61`, `public/style.css:114-122`. Budget skips reuse `skipped`; M3 introduces `stopped` and pays this cost once, deliberately.
- **Background pollers** are constructed in `main()` beside runner/scheduler/awake and injected into `createApp`. Not via `ext.init` — that hook gets only `{getSetting, setSetting}`, no db handle, no lifecycle. `POST /api/cleanup` and `startUninstall` must stop them (compare `awake?.stop()`).
- **Every timer `.unref()`s.** Non-negotiable — the test suite exits on it.
- **UI: a new top-level tab is 4 edits** — nav anchor (`index.html:12-16`), `<section id="tab-*">`, add the name to the hardcoded array at `public/app.js:99` plus a `showTab()` branch, and a render/refresh pair with a visibility-guarded interval. First extract the shared helpers (`api`, `esc`, `toast`, `relTime`) into `public/util.js` — `app.js` is a single 635-line module that exports none of them and `fields.js` already duplicates `esc`.

### Data model additions (all pure additions)

```sql
usage_snapshots(id, capturedAt, ok, available, subscriptionType, windows JSON, buckets JSON, error)   -- M1
run_usage(runId, jobId, beforeJson, afterJson, deltaPct JSON, sampledAt)                              -- M1/M4 calibration
backlog_tasks(id, title, prompt, cwd, type, params JSON, priority, estPct, state, createdAt, ...)     -- M4
sessions(id, filePath, mtimeMs, sizeBytes, cwd, project, gitBranch, ..., scannedAt)                   -- M5
```

## Non-goals (v2)

Unchanged from v1: multi-user, remote access, auth, Linux/Windows, catch-up of runs missed while asleep. Plus, explicitly:

- **No proxying or hosting.** Local-only, own-credential (see §5).
- **No absolute token budgeting.** The API gives percent; we learn percent-per-job empirically and stay in percent.
- **No scraping of Anthropic web surfaces** for usage. `get_usage` is the sanctioned path.
- **No attempt to defeat or evade a limit.** Every feature schedules *within* limits; the guard exists to protect headroom, not to extend it.
