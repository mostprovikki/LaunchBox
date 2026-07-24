# WIP

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
- [ ] **M2 · usage-aware scheduling** — `2026-07-25-m2-usage-aware-scheduling.md`
  - [ ] `afterReset` schedule type (+ validate, preview, deterministic jitter)
  - [ ] budget guard via injectable `admit(job, trigger)` on `createRunner`
  - [ ] burn-down planner (preview + confirm)
  - [ ] reset-aware keep-awake
- [ ] **M3 · pause modes** — `2026-07-25-m3-pause-modes.md`
  - [ ] `pauseMode` state machine `off|hold|soft|hard` (+ legacy `paused` alias)
  - [ ] **spike first:** stdin control channel for the `claude` child (§3.3, four questions)
  - [ ] graceful-stop ladder (`interrupt` → SIGINT → SIGTERM → SIGKILL)
  - [ ] new run status `stopped` (10 call sites — enumerated in the plan)
- [ ] **M4 · backlog & bursts** — `2026-07-25-m4-backlog-bursts.md`
  - [ ] `backlog_tasks` + `bursts` tables
  - [ ] plan/preview/confirm flow; materialise as tagged one-shot jobs
  - [ ] **measured** live ceiling (the actual enforcement; fails *closed*)
  - [ ] Backlog tab + burst presets
- [ ] **M5 · sessions dashboard** — `2026-07-25-m5-sessions-dashboard.md`
  - [ ] attribution first (`LICENSES/`, `NOTICE`, Lucide ISC)
  - [ ] `lib/sessions.js` port + **`message.id` dedupe fix**
  - [ ] mtime/size cache, watcher + SSE
  - [ ] Sessions tab; run ↔ session cross-links
- [ ] **M6 · deferred** — full rename (launchd label `com.claude-scheduler`, package name, `~/.claude-scheduler` data dir) with migration; optional `node:sqlite` migration

## Environment notes

- **`better-sqlite3` and macOS Gatekeeper.** The downloaded prebuilt `.node` gets flagged by XProtect and removed — symptom is `ERR_DLOPEN_FAILED: library load disallowed by system policy`, or an empty `node_modules/better-sqlite3/build/Release/`, plus "unsafe software" popups. Fix: `npm rebuild better-sqlite3 --build-from-source`. A locally compiled binary is ad-hoc linker-signed with no `com.apple.quarantine` xattr, so Gatekeeper leaves it alone. Node 26 is also newer than the shipped prebuild ABI. M6 tracks migrating to built-in `node:sqlite` (verified available on this Node) to remove the native dep entirely.
- Dev server: `CS_DATA=$(mktemp -d) CS_PORT=18741 node server.js`. Tests: `npm test` (sandboxed `CS_DATA`, fake spawns).
- Usage probe (ground truth, ~2s, $0): `printf '%s\n' '{"type":"control_request","request_id":"1","request":{"subtype":"get_usage"}}' | claude -p --input-format stream-json --output-format stream-json --verbose`
