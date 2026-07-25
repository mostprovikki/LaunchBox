# M3 — Soft & hard pause

Design: [`2026-07-25-launchbox-design.md`](../specs/2026-07-25-launchbox-design.md). Verify: `npm test`.

**Goal:** two distinct stop controls — a **soft pause** that asks in-flight Claude runs to wind down gracefully at the next safe point, and a **hard pause** that forcefully stops everything immediately and refuses all new work.

**Definition of done:** soft pause leaves in-flight sessions cleanly terminated and resumable, with runs marked `stopped` (not `fail`); hard pause kills everything including manual triggers; the existing pause-all behaviour is preserved under its own mode name.

---

## 3.1 The mode model

Today `settings.paused = '1'` suppresses scheduled fires and leaves running work alone; manual runs bypass it entirely. That is a useful behaviour and must not silently change on upgrade. So four modes, not two:

| mode | new fires | manual runs | in-flight runs |
|---|---|---|---|
| `off` | allowed | allowed | untouched |
| `hold` | blocked | **allowed** (unchanged legacy behaviour) | untouched |
| `soft` | blocked | blocked (override available, with confirm) | **asked to wind down gracefully** |
| `hard` | blocked | blocked | **force-killed now** |

- `settings.pauseMode` replaces `settings.paused`. Migration: `paused === '1'` → `hold`, else `off`. Keep reading/writing `paused` as a derived alias for one release so nothing external breaks — `paused` is true for any mode other than `off`.
- Optional `pauseUntil` (ISO) for a timed pause, mirroring `lib/awake.js`'s `timed` mode; expiry returns to `off`.
- `lib/pause.js`: `createPauseController({ db, runner, extensions, now })` → `{ status(), set({mode, minutes}), gate(trigger) }`. Constructed in `main()` beside runner/scheduler/awake, injected into `createApp`, and stopped by `/api/cleanup` and uninstall.

**Enforcement points:**
- `lib/scheduler.js:15` — `paused()` becomes `pause.blocksSchedule()`. Behaviour for `hold`/`soft`/`hard` is identical here: drop the fire.
- `runner.start()` — the M2 `admit(job, trigger)` hook is reused: `soft`/`hard` block all triggers; `hold` blocks nothing (the scheduler already gated it); manual is blocked only under `soft`/`hard`. This is why `admit` receives `trigger`.
- The queue is cleared on entering `soft` or `hard`: each queued entry becomes `skipped` with `meta.skipReason = 'paused (<mode>)'`. Queued runs are memory-only and die at boot anyway, so leaving them pending would be a lie. Lifting the pause does **not** resurrect them; the next scheduled fire is the recovery path.

## 3.2 Graceful stop — the mechanism

`interrupt` **is** a real control-request subtype in Claude Code 2.1.206 (verified alongside `initialize`, `set_model`, `set_permission_mode`, `get_usage`, `can_use_tool`, `hook_callback`, `mcp_message`, `control_cancel_request`). So a genuine turn-boundary stop is achievable rather than SIGTERM-and-hope.

Using it requires a **piped stdin control channel**, which the runner does not have today (`stdio: ['ignore','pipe','pipe']`). Hence the ladder — each rung is a real fallback, and the feature is useful even if rung 1 never ships:

1. **`interrupt` control request** — for children spawned with the control channel (§3.3). Claude aborts at the next safe point and exits cleanly; the session stays resumable. Status `stopped`.
2. **SIGINT** — Claude Code's cancel signal. Cleaner than SIGTERM; may leave a resumable session. Status `stopped`.
3. **SIGTERM** after `softGraceMs` (default 120s, configurable) — the run gets a generous window to finish on its own first.
4. **SIGKILL** after a further `KILL_GRACE_MS`.

Soft pause always begins by **not starting anything new** — a drain. Rungs only apply to work already in flight, and the log records which rung was used so the behaviour is auditable rather than mysterious.

Non-`claude` extensions (e.g. `command`) have no notion of a turn boundary: for them soft pause means rungs 2→4 only, and extensions may declare `gracefulStop: 'signal' | 'control' | false`.

## 3.3 Prerequisite spike — the stdin control channel

**RUN 2026-07-25 against the real CLI (2.1.211, `--model haiku`, ~$0.06 total). All four questions answered — and the headline is that the control channel turned out to be _unnecessary_ for soft pause.**

**The finding that reshapes this section: plain `SIGINT` on the *current* argv path is behaviourally identical to the `interrupt` control request, and exits more cleanly.** Both stop at a safe point — the in-flight tool call is denied with `tool_result: "The user doesn't want to proceed with this tool use"`, so the tool never runs — both emit a final `result` event, and both leave a fully resumable session whose history correctly reflects that the denied step did not happen (verified by resuming each and asking what the last command was: "`echo step1`" and "`sleep 3 && echo step2` (which you rejected)"). Measured:

| stop mechanism | in-flight tool | final `result` event | exit | resumable |
|---|---|---|---|---|
| `interrupt` via stdin control channel | denied at safe point | `subtype=error_during_execution`, `is_error=true` | **1** (after `stdin.end()`) | yes ✓ |
| **SIGINT, argv path** | denied at safe point | `subtype=error_during_execution`, `is_error=true` | **0**, in ~930ms | yes ✓ |
| SIGTERM, argv path | abandoned | **none emitted** | 143, in ~920ms | yes, but no closing record |

So rung 1 buys nothing over rung 2 for stopping a run, while carrying the entire regression risk of changing how every claude job is invoked. **The ladder collapses to SIGINT → SIGTERM → SIGKILL.**

**The trap this exposes, and the real work in §3.4:** a graceful stop reports itself as a *failure*. `result.subtype` is `error_during_execution` with `is_error: true`, and `error_during_execution` is not distinguishable from a genuine mid-run error. The control-channel path is worse still — exit code `1`. Therefore **`stopped` can only be derived from the fact that we asked for the stop**, exactly as `killed` and `timeout` already are (`entry.killed` / `timedOut` in `launch()`); the child's own exit reporting must not be trusted for it. The claude formatter must also not mark an interrupted run as errored.

Answers to the four questions as originally posed:

1. **Envelope confirmed:** `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}` is accepted as-is.
2. **Confirmed, and it is a hazard:** with stdin held open the child does **not** exit after the turn — still alive 33s after `result`, and after an interrupt still alive 81s later. It exits ~1s after `stdin.end()`. Any control-channel implementation *must* close stdin on the `result` event, and needs a watchdog, or every run hangs forever.
3. **Yes:** `interrupt` is acked in ~6ms with `{"subtype":"success","request_id":…,"response":{"still_queued":[]}}`, stops at a safe point, and leaves a resumable session. But the `result` subtype is **not** cleanly distinguishable (see the trap above), and the exit code is 1.
4. **No difference in the run itself** — identical event-type stream on both paths (`system/init`, `system/thinking_tokens`, `assistant`, `user`, `rate_limit_event`, `result`); `--dangerously-skip-permissions` behaves the same; only `rate_limit_event` ordering floats, which is nondeterministic anyway.

**Decision: the stdin control channel is deferred out of M3** — no `stdin: 'control'`, no `control: {send, endInput}` on the output handler, no `claude:controlChannel` setting. M3's `claude` invocation is untouched, which retires the milestone's top risk entirely. The channel's remaining value is *not* stopping runs but the other verified subtypes (`set_model` for the model-scoped routing the M2 findings call for, `get_usage` in-session); it should be built when that feature needs it, starting from the facts above. The ladder's rung 1 slot stays in the extension contract as `gracefulStop: 'signal' | false` so a future `'control'` value slots in without a redesign.

Original spike brief, kept for the record:

**This is the risky part and it gets verified before it gets built.**

Current invocation: `['-p', prompt, '--output-format','stream-json','--verbose']`, stdin ignored.
Proposed: `['-p','--input-format','stream-json','--output-format','stream-json','--verbose']`, stdin piped, prompt written as a stream-json user message.

Open questions the spike must answer, by experiment against the real CLI:

1. The exact accepted user-message envelope for `--input-format stream-json` (likely `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`).
2. **Does the child exit after the turn with stdin still open?** Expected: **no** — in streaming-input mode the CLI waits for more input. If so, the extension must close stdin on the `result` event to get a clean exit. That is precisely what keeps the control channel available *during* the run while still terminating afterwards.
3. Does `interrupt` mid-turn produce a clean exit and a resumable session? Does it emit a distinguishable `result` subtype?
4. Any behavioural difference in the run itself (tool permissions, `--dangerously-skip-permissions` interaction, output events) versus the current argv-prompt path.

**Rollout is opt-in until proven.** The current argv path stays the default; the control channel is enabled by a setting (`claude:controlChannel`, default off) and/or per job. Soft pause degrades to rung 2+ when it's off. Under no circumstances does M3 regress ordinary `claude` job execution — that is the acceptance bar for this step.

Contract extension needed (design it in this step, keep it small):
- `ext.command()` may return `stdin: 'control'` → runner spawns with `stdio: ['pipe','pipe','pipe']`.
- `ext.createOutputHandler({...})` additionally receives `control: { send(request), endInput() }`.
- Runner exposes `runner.requestStop(runId, {mode})` walking the ladder, and the extension may declare `gracefulStop`.

## 3.4 New run status `stopped`

Distinct from `killed` (explicit per-run kill) and `fail` (error). **Never retried, never notified as a failure** — it's an intentional, clean stop.

Adding a status is cross-cutting; all sites, from reading the source:

- `lib/db.js:188` (prune exclusion — `stopped` is finished, so it prunes normally), `lib/db.js:198` (orphan sweep — unaffected)
- `server.js:87` (kill guard: `stopped` is not active), `server.js:132` (SSE live check)
- `public/app.js:129, 408, 436, 471` (live checks + status filters)
- `public/index.html:56-61` (history filter chips — add one)
- `public/style.css:114-122` (add `--stopped` token plus `.dot.stopped` / `.st-stopped`; `--queued`/`--killed` are the pattern to copy)

Also: `finish()` must not schedule a retry for `stopped`, and `shouldNotify` must treat it as neither success nor failure (or notify only under `always`).

## 3.5 API & UI

- `GET /api/pause` → `{mode, until, blocking: {schedule, manual}, stopping: [runId]}`
- `PUT /api/pause` → `{mode, minutes?}`; keep `PUT /api/settings {paused}` working as the alias.
- `POST /api/runs/:id/stop` → graceful stop of one run (the soft counterpart to the existing `/kill`).
- UI: replace the pause switch with a 4-way segmented control (`off | hold | soft | hard`) in the header, reusing `.seg`. Hard pause requires a confirm — it kills work. A banner states the active mode, what it's blocking, and how many runs are winding down. Runs mid-wind-down show a distinct chip ("stopping…") and their log records the rung used.
- Settings: `softGraceMs`, and the `claude:controlChannel` toggle with a plain note that it is experimental.

## 3.6 Tests

- mode migration: legacy `paused='1'` → `hold`; `paused` alias still reads true for every non-`off` mode
- `hold` blocks scheduled fires but **not** manual (exact legacy behaviour — guard against regression)
- `soft` and `hard` block manual too; `off` restores everything
- entering `soft`/`hard` clears the queue, marking entries `skipped` with `meta.skipReason`
- ladder, with a fake child: control channel present → `interrupt` sent, no signal; absent → SIGINT, then SIGTERM after `softGraceMs`, then SIGKILL
- `stopped` never retries and never sends a failure notification
- `hard` SIGKILLs in-flight children immediately and marks them (existing `killAll` semantics, plus the new blocking)
- timed pause expires back to `off`
- status plumbing: a `stopped` run is not "active" for the kill guard or the SSE live check, and appears under its history filter

## Risks

| Risk | Mitigation |
|---|---|
| stdin/stream-json change regresses normal claude runs | Opt-in setting, default off; argv path remains default; spike (§3.3) must answer all four questions before any default flips. Acceptance bar: no regression. |
| Child never exits with stdin held open | Close stdin on the `result` event; watchdog to rungs 3→4. Explicitly question 2 of the spike. |
| `interrupt` leaves a half-finished edit | It stops at a *safe point*, not mid-write; but soft pause is still "wind down", not "roll back" — document that clearly. Prefer draining (start nothing new, let it finish) as the default soft behaviour, with interrupt as the escalation. |
| Four modes confuse | Segmented control with one-line descriptions; `hold` is the old behaviour under a name, so existing muscle memory keeps working. |
| New status missed at a call site | The 10 sites are enumerated above; a test covers each behavioural one. |
