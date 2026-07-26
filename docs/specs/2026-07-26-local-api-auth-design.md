# Local API authentication and approval — design

Status: **approved in conversation 2026-07-26**, not yet implemented.
Supersedes the "decide it explicitly for the whole API" note in
[M5 §5.6](../plans/2026-07-25-m5-sessions-dashboard.md).

Spec lives in `docs/specs/` rather than `docs/superpowers/specs/` to match this repo's
existing convention (`2026-07-25-launchbox-design.md`).

## Why this exists

Creating a job in this app is **arbitrary code execution on the user's Mac**, on a schedule,
under a trusted parent process. That is the asset being protected. The trigger was a measured
exploit, not a theory — see "What is already fixed".

The user's stated goals, verbatim:

1. prevent any website they visit from changing things on the machine;
2. prevent rogue systems on a trusted network (home or office) from scheduling jobs or
   stealing information.

## Threat model, and one thing deliberately out of scope

| Attacker | Reachable? | Covered by |
|---|---|---|
| A website the user visits | Yes, via the browser | **Already fixed** (commit `9717025`) + token |
| A rogue device on the LAN, directly | **No** — measured: bind is hardcoded `127.0.0.1` (`server.js:1115`), no env override, connection to `192.168.0.5:PORT` refused, `lsof` confirms the socket is loopback-only | the loopback bind |
| A rogue LAN device *indirectly* — serving a malicious page, or DNS-rebinding a hostname to 127.0.0.1 (the classic hostile-network move) | Yes, via the browser | the `Host` check |
| A browser extension with localhost permission | Yes | **token** |
| Accidental exposure — container port-forward, `ssh -R`, VPN misconfig, a future remote feature | Potentially | **token** |
| Same-user local malware | Yes | **partially — see below** |

**Same-user local malware is explicitly a lower priority, on the user's reasoning, which is
sound:** our API offers such an attacker *a detour, not a capability*. Code already running as
the user can run the command directly instead of asking us to schedule it. So no amount of
gating our API prevents the damage it could do anyway.

That reasoning is right about raw capability and wrong in three specific ways, which is why
Layer 2 exists at all rather than not at all:

1. **"Runs as me" ≠ "can do everything I can". Measured on this machine.** macOS TCC grants
   permissions per *application identity*, not per uid. This process tree currently has
   `~/Desktop` **granted** (48 entries) and `~/Downloads` **granted** (36), `~/Documents`
   **denied**, no Full Disk Access. A freshly-dropped unsigned process is denied or prompts;
   a job scheduled through our daemon runs as our child and **inherits our grants**. Textbook
   confused deputy, worse on the many dev machines where Terminal has Full Disk Access.
2. **Persistence laundering.** We are a legitimate, user-installed, persistent scheduler.
   Malware scheduling through us gets persistence *without* writing its own LaunchAgent —
   the artifact monitoring tools watch for — under a trusted parent, and **the job survives
   removal of the malware**.
3. **Delegated credentials we hold and a random process does not.** Our daemon drives the
   *authenticated* `claude` CLI: an attacker can spend the user's subscription quota, read
   usage, and via `permMode: auto` or project activation obtain an agent with **file-write
   authority** running unattended in their repos.

## What is already fixed (commit `9717025`, 284 tests green at the time)

Settled by exploiting it, not by reasoning about it. Against a throwaway dev server: two real
jobs created, then one cross-origin form-style `POST` (`Host: evil.example.com`,
`Content-Type: text/plain`, **no body**) to `/api/cleanup` returned **`200 {"ok":true}` and both
jobs were gone**; `GET /api/settings` with a foreign `Host` returned `200` and leaked the
payload including `home`.

Two guards, since they stop different attacks:

- **`Content-Type: application/json` required on POST/PUT/PATCH/DELETE.** A cross-origin form
  can only send urlencoded/multipart/text-plain; a cross-origin `fetch` that sets JSON becomes
  preflighted and we never answer with CORS headers. Note that rejecting an unparseable *body*
  would **not** have helped: the destructive routes take no body at all, so `express.json` left
  `req.body` as `{}` and they ran anyway. **The header is the signal, not the payload.**
- **Loopback-only `Host` (and `Origin` when present).** Defeats DNS rebinding, which is what
  turns a read-only endpoint into exfiltration.

Both are portable — pure HTTP, no OS dependency. Re-verified after patching: 403, canaries
intact, app unaffected.

## Layer 1 — capability token

- 32 random bytes (`randomBytes`), hex, generated on first boot, stored `0600` at
  `~/.claude-scheduler/token`.
- Required as `Authorization: Bearer <token>` on **every `/api/*` route, reads included** —
  "steal information" is one of the two stated goals, and transcripts are the most sensitive
  thing this app can serve.
- Static assets (`index.html`, css, js) stay unauthenticated: they contain no data, and a
  rebound origin still cannot read the real origin's `localStorage`.
- Comparison uses `timingSafeEqual` on equal-length buffers.

**Delivery.** A CLI `claude-scheduler open` opens `http://127.0.0.1:PORT/#token=…`. The page
stores it and immediately strips the fragment via `history.replaceState`. A **fragment**, not a
query string: fragments are never sent to the server and so cannot reach a log.

> **This CLI is a new component.** `package.json` has **no `bin` entry** today (only the `start`,
> `test` and `screenshots` scripts), so the plan must add one rather than extend something
> existing. Until it exists there is no supported way into the UI, which makes it part of the
> minimum shippable set, not a nicety.

**Storage: `localStorage`, not a cookie.** The non-obvious reason, which reverses the usual
"HttpOnly cookie is safer" instinct: an origin is scheme+host+**port**, so `localStorage` for
`http://127.0.0.1:9099` is unreachable from any other port — but **cookies ignore the port
entirely**, so a cookie set for `127.0.0.1` is sent to *every* local service on *every* port.
`__Host-` prefixing would fix that but requires HTTPS.

**Residual risk, recorded rather than hidden:** if the daemon is not running and another
process binds our port, it becomes the same origin and could read the stored token. That
requires same-user code, which is the attacker we already agreed acts directly.

## Layer 2 — human presence on high-power actions

One interface: `requestApproval({ action, detail })` → `{ ok, code }`. macOS implementation
spawns a compiled Swift helper; other platforms have no implementation yet (see Portability).

### The helper

A **separate ~40-line Mach-O binary**, not part of the daemon: Node cannot call
`LocalAuthentication`, so the only way to raise the system sheet is to spawn a native
executable and read its exit code. Installed to `~/.claude-scheduler/bin/LaunchBox`.

Policy is **`.deviceOwnerAuthentication`**, deliberately not `...WithBiometrics`: a wet finger,
a Mac with no Touch ID, or too many failed reads must fall back to the login password rather
than locking the user out of their own scheduler.

### Spike findings (2026-07-26) — all measured, several changed this design

| Question | Result |
|---|---|
| Can `LAContext` prompt from a background launchd **agent**? | **Yes.** `canEvaluatePolicy: true`; `evaluatePolicy` → `success: true`, exit 0, from `gui/502` with no TTY. This was the one finding that could have invalidated the approach. |
| Compile at install? | **Yes.** `swiftc -O`: **3.7s**, 59KB, and swiftc emits an **adhoc/linker signature automatically** — no developer certificate, no Xcode project. Compiling from source is also what avoids the XProtect problem WIP.md records for prebuilt `.node` binaries. |
| Signing required? | **The adhoc signature it already gets is mandatory.** Stripping it → **SIGKILL (137)**, no output. Apple Silicon refuses unsigned binaries. |
| Deny distinguishable from broken? | **Yes.** Deny → `errorCode: -2`, exit 1. |
| Rename safe? | Yes — copying to `bin/LaunchBox` preserved the signature and authenticated. |
| Touch ID vs password distinguishable? | **No, by design.** Approvals differed only in elapsed time (34.4s vs 67.6s); `errorCode: 0`, `success: true` both times. |

Three consequences:

1. **The dialog title is the helper's filename**, and the reason string is appended to
   "*<title> is trying to* …". Verified across three dialogs: the file named `laprobe` produced
   "laprobe is trying to…", and after renaming, "**LaunchBox** is trying to create the scheduled
   job "nightly backlog sweep", which can run commands on this Mac." So the binary must be
   *named for the product*, and **every reason string must be written to complete that
   sentence**, naming the specific object in quotes.
2. **The adhoc requirement is a security feature to lean on.** A tampered helper does not
   misbehave, it is SIGKILLed. Install-time verification is therefore just "run `--check`,
   require exit 0", which detects tampering for free.
3. **The dialog is not proof of provenance.** An adhoc CLI has no app icon — the sheet shows a
   generic fingerprint-with-`exec` badge, so any other adhoc binary named `LaunchBox` would
   produce a visually identical dialog. Acceptable under this threat model, but it means the
   prompt authenticates **the user, not the app**, and nothing in the UI may imply otherwise.

**The audit log records "approved at T" and never "approved by fingerprint",** because
LocalAuthentication does not report which factor was used and we must not imply a stronger
claim than the mechanism supports.

### Timeout: 180s, measured

The password approval consumed **67.6s** — over half of the 120s bound originally written, and
that was without opening a password manager. Bound raised to 180s. A bound is still required:
a background agent must never hang forever on a dialog nobody is looking at.

### Gated actions

| Action | Why gated |
|---|---|
| create / edit a job | arbitrary command execution, inheriting our TCC grants |
| enable a disabled job | the same, one click later |
| activate a project | unattended agent runs with write access |
| set `permMode: auto` | agent file-write authority |
| **change `claudePath` or `bdPath`** | **see below — this one bypasses everything else** |
| `POST /api/cleanup` | destroys every job, run and log |
| `POST /api/uninstall` | removes the daemon |

> ⚠️ **`claudePath` / `bdPath` were missed in the first draft of this spec and are the most
> important entry in the table.** They name *executables*. An attacker who can write settings
> simply repoints `claudePath` at their own binary and every existing claude job then runs their
> code — **without ever creating a job, and therefore without ever touching the approval gate**.
> Gating job creation while leaving these ungated would have been a complete bypass of Layer 2.
> Any settings write that changes either value requires approval, and the reason string names
> the old and new path.

**Explicitly NOT gated, with reasons — recorded so these are decisions rather than omissions:**

| Action | Why not |
|---|---|
| `POST /api/jobs/:id/run` (manual run) | the job's contents were already approved when it was created or edited; gating it would prompt on the single most common action, training the user to approve reflexively — which is worse than the risk |
| *Disabling* a job, or pausing | strictly reduces what the machine will do |
| `POST /api/projects` (register) | discovery writes `pending` only; nothing runs until the separately-gated activation |
| `POST /api/bursts` | bursts draw only on **activated** projects, so they inherit that gate |
| `POST /api/runs/:id/actions/:actionId` | the action is resolved from the extension manifest's own `runActions` list (`server.js:259`), so a client can only pick from a declared set — it cannot supply a command |
| All other settings | they tune scheduling and thresholds; none names an executable or grants authority |

### Grace window

**5 minutes for job create/edit/enable only. No grace for cleanup, uninstall, or project
activation.** A grace window *is* an attack window — malware can wait for a legitimate approval
and ride it — so the actions where riding it would be worst do not get one. Grace is **bound to
the specific token**, so a second caller cannot ride an approval.

### One prompt at a time

Approvals are **serialised through a queue**: one outstanding dialog, later requests wait, and
the queue is bounded (`409` when full). Stacked system dialogs are how people approve the wrong
thing. An approval also holds an HTTP request open for up to 180s, so the UI needs an explicit
"waiting for your approval…" state rather than appearing hung.

## The state-preservation contract

A refused approval must never cost the user their work. This is a **hard requirement**, in two
halves:

- **Server:** the approval gate runs **before any write**, so a refusal leaves **zero** partial
  state. This repo already learned that lesson — M4a shipped a settings `PUT` that persisted one
  key before a later check could reject the save.
- **Client:** forms close and clear **only on a 2xx**. Never optimistically.

For the client to comply, refusals carry **machine-readable codes**, not just prose:

| Code | HTTP | Client behaviour |
|---|---|---|
| `approval_denied` | 403 | toast "you denied that — nothing was saved, press Submit to try again"; **state kept** |
| `approval_timeout` | 408 | toast naming the timeout; **state kept** |
| `approval_unavailable` | 503 | toast naming the missing/broken helper and the fix; **state kept** |
| `approval_busy` | 409 | toast "another approval is waiting"; **state kept** |
| `token_invalid` | 401 | **persistent banner** (not a 3.5s toast — it needs an action): "this session key is no longer valid — stop the scheduler, start it again, then reopen from the CLI"; **state kept** |

No automatic retry after an approval failure. The user re-presses Submit, so a re-prompt is
always something they chose.

## The core auth module — structural, not conventional

The risk the user identified: each page handling the token, the approval flow, state
preservation and toast wording slightly differently, and a newly-added page getting it wrong.

**"Remember to include the auth module" is exactly how one page ends up different.** So instead
of a module pages must opt into, **`api()` in `public/util.js` is upgraded in place.** Every
page already imports and uses it (`app.js`, `projects.js`, `usage.js`, `fields.js`), so a new
page inherits the token header, the 401 banner, the approval toasts and the never-clear-on-
failure rule **by doing nothing**. Opting *out* becomes the unusual act.

On top of that:

- **`public/auth.js`** owns the token, the persistent banner, the shared toast vocabulary, and
  **`guardedSubmit(form, fn)`** — which owns the "do not reset state unless it succeeded" rule
  so a page author cannot get it wrong by forgetting.
- **A self-policing test:** enumerate `public/*.js` and fail if any file calls `fetch(` against
  `/api/` directly instead of going through the wrapper. An agent adding a page in six months
  gets a failing test rather than a silent inconsistency.
- A README "adding a page" checklist.

## Live log streaming is removed, not authenticated

`EventSource` cannot set an `Authorization` header — its entire API is `new EventSource(url)` —
so requiring the token would have `401`ed the log drawer's live tail while the rest of the UI
worked: a confusing partial failure.

**Decision (user's, and it is the better answer): drop live streaming.** The web log view shows
the log *as of when it was opened*, with a **Refresh** button and an "as of HH:MM:SS" label so
the snapshot is honest. Anyone wanting live output follows it in a terminal.

This is net-deleting and needs no new route: **`GET /api/runs/:id/log` already exists**
(`server.js:276`) and returns the whole log as `text/plain`.

- Delete `GET /api/runs/:id/tail` (`server.js:282`) and the `EventSource` block
  (`public/app.js:707-739`).
- The drawer's progress line currently comes only from the stream's `progress` event
  (`app.js:722`); it now reads `runs.progress`, which is already a column and already served by
  `GET /api/runs`.
- **`GET /api/sessions/stream` is dropped from M5 §5.6** for the same reason. The Sessions tab
  uses the 5s visibility-gated poll that Projects already uses. This also removes the trap
  recorded in WIP.md — an SSE route must call `res.end()` or the test suite's
  `fetch`-then-`await res.text()` style hangs.
- Two existing SSE tests (`tests/api.test.js:255`, `:354`) are rewritten against the snapshot
  route.

**Follow-in-a-terminal affordance:** the drawer shows a copyable `tail -f <logPath>` command.
Launching Terminal automatically via the `osascript` path the resume action uses is
**deferred** — copying a command is one line of UI and no new execution surface.

> ⚠️ **Security rule for that affordance:** the server constructs the command from the **run's
> own `logPath`**; the client sends only a run id. An endpoint that accepted a command string
> from the client would be an arbitrary-execution hole — reintroducing exactly what this spec
> exists to close.

Deliberately out of scope: attaching to a live session (tmux-style). It needs the run to have
been launched under a multiplexer, which is a separate feature.

## Portability

`lib/approval.js` selects an authenticator by `process.platform`. Only `darwin` ships now;
`win32` (Windows Hello `UserConsentVerifier`) and `linux` (polkit) are later drop-ins with no
call-site changes. Layer 1 is already portable.

**On a non-macOS platform, gated actions are allowed**, with a notice in the UI and a line in
the log. This is the one place the design fails *open*, on the user's explicit instruction that
macOS-only is acceptable for now — recorded here so it can never be mistaken for protection
that exists. Every other failure mode fails closed:

| Situation | Behaviour |
|---|---|
| Helper missing / not compiled | **refuse**, `503 approval_unavailable` naming the fix |
| Helper SIGKILLed (tampered) | **refuse**, log loudly |
| User denies (`-2`) | **refuse**, `403`, no retry loop |
| Timeout (180s) | **refuse**, `408` |
| Prompt already open | **queue**; `409` when the queue is full |
| Token file missing at boot | generate it, `0600` |
| Token wrong or absent | `401` on all `/api/*` |
| Non-macOS platform | allow, with a visible notice |

## Testing

House rule is "no test shells out to the real thing", so `requestApproval` is injected exactly
like `spawnFn` and `fakeBd`: a `fakeApprover` recording what it was asked, returning
approve / deny / timeout / unavailable.

- Token required on **every** `/api/*` route, asserted by a test that **enumerates the routes**,
  so a newly-added one cannot silently ship unauthenticated.
- Each gated action refused on deny, on timeout, and on unavailable — and **nothing written** in
  each case (the state-preservation contract, server half).
- Grace window honoured for job edits; **not** honoured for cleanup / uninstall / activation.
- Grace bound to one token: a second token does not inherit it.
- The queue serialises; a full queue returns `409`.
- `timingSafeEqual` comparison; wrong-length and empty tokens rejected.
- The `public/*.js` no-raw-`fetch` lint test.
- The Swift helper gets a re-runnable script in `docs/spikes/` (the M4a pattern), outside
  `npm test` because it spawns a real binary and needs a human finger.

Mutation checks, matching this repo's habit of proving a test bites: neutralise the token check,
the grace-window scope, and the no-write-on-refusal ordering; each must fail tests.

## Suggested implementation order — two phases

Flagged during spec self-review as a scope check: this is large enough that one plan would mix
native-code risk with routine work. Splitting it also means **the first phase alone already
delivers both of the user's stated goals**.

**Phase 1 — no native code.** Token layer, the `public/util.js` `api()` upgrade, `auth.js` with
the banner and `guardedSubmit`, the state-preservation codes, the `bin` CLI, SSE removal, and
the no-raw-`fetch` lint test. Fully portable. Covers websites, LAN devices, extensions and
accidental exposure.

**Phase 2 — the presence layer.** The Swift helper, its install-and-verify step,
`lib/approval.js`, the gated-action wiring, the queue and the grace window. Adds the
confused-deputy, persistence-laundering and delegated-credential protections.

Phase 2 depends on Phase 1 (the approval codes ride the same client plumbing); Phase 1 does not
depend on Phase 2.

## Out of scope

- Multi-user / remote access. Loopback only.
- Protecting against same-user malware beyond the three escalations named above.
- Hardware keys, TPM, passkeys.
- Signing the helper with a developer certificate (the spike proved it unnecessary).
- Rotating the token on a schedule. Restarting the daemon is the rotation story.


## Verification evidence (2026-07-26)

Recorded because "has the approval layer been tested?" has a subtler answer than yes or no: every
link in the chain is verified, but the *last continuous run* needs a human, and no amount of
engineering removes that.

| Link | How it was verified | Result |
|---|---|---|
| Real helper + real **Touch ID approve** | Human, during the spike (screenshotted) | exit 0, `success:true, errorCode:0`, 34.4s |
| Real helper + real **password approve** | Human, during the spike (screenshotted) | exit 0, identical payload, 67.6s — indistinguishable from biometry by design |
| Real helper + real **Deny** | Human, during the spike (screenshotted) | exit 1, `errorCode:-2`, "Authentication canceled." |
| Real helper prompts from a **background launchd agent** | Spike, `gui/502`, no TTY | `canEvaluate:true`, then `success:true` |
| **Server → `lib/approval.js` → real binary → real dialog** | `tools/verify-approval-timeout.sh`, unattended | 5/5; helper process asserted alive, `approval_timeout`, nothing written |
| exit code → `{ok, code}` mapping, queue, grace, per-token scoping | `tests/approval.test.js` | 17/17, mutation-checked |
| Each gated route: approve / deny / timeout / unavailable, and **nothing written** on refusal | `tests/api.test.js` | mutation-checked (moving a write before its gate fails 3 tests) |
| Frontend keeps the user's work on refusal | `tools/verify-auth-ui.mjs`, real Chrome | 19/19 |
| Whole app under both layers | `npm run screenshots` | 40/40 |
| The live daemon | probes against the running instance | exploit → 403, form content-type → 415, `Host` leak → 403, tokenless → 401 |

**What cannot be automated, and why that is the point.** The approve and deny outcomes of a real
dialog require a human. This was tested rather than assumed: an attempt to click the sheet through
System Events failed with `-1743, Not authorised to send Apple events`, and granting the Automation
permission that would allow it would weaken the machine in order to test a feature whose purpose is
to protect it. **The layer's value is precisely that no local process — including this one — can
satisfy its dialog.** A build that could self-approve would be a bypass, and malware would use it.

So `docs/spikes/auth-verify.sh` (8 steps, 5 dialogs) is not an outstanding implementation task. It
is the human half of a two-party protocol, and the machine half is complete.
