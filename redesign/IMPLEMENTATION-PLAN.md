# LaunchBox /v2 implementation plan — FINAL (decided 1 Aug 2026)

Decisions locked with owner: **/v2 parallel UI** (new UI at `/v2`, cutover at parity, old UI
untouched until then) · **beads filed** (epic `claude-scheduler-btv`, graph verified) · build
order **Foundation → parity tabs → new surfaces → dialogs → gates** · **all sub-agents run
Sonnet 5**.

**API policy (owner directive): additive only.**
- If an existing endpoint already fits → **reuse it unchanged**.
- If the new UI needs something that doesn't exist → **build it new** under `/api/v2/*`.
- If an existing endpoint would need its shape/semantics changed → **don't touch it**; ship a
  `/api/v2/*` variant and leave the old one serving the old UI until cutover.
- Nothing the current UI calls is ever modified. `npm test` green is part of every merge bar.

Ground truth: current UI is `public/index.html` + vanilla ES modules (~5k lines), hash
routing, served by `server.js`. `/v2` is built the same way — no framework, no build step —
under `public/v2/`, sharing the daemon's auth/token flow. The mockups in this folder are the
spec; REVIEW.md's nine applied recommendations must be **preserved**, not re-invented.

## Execution model — Sonnet 5 sub-agents, human-gated

- **Beads are tracking and sequencing only** (no `autoLabel`; code tasks can't self-verify
  under unattended scheduler runs). Execution is interactive sessions dispatching Sonnet 5
  sub-agents in waves.
- **Parallel only where files are disjoint.** `server.js` (wave 0) and the shared chrome
  (wave 1) are named merge points — never two concurrent agents. Wave-2 page agents each own
  one module under `public/v2/` and may run in git worktrees.
- Every agent brief carries: its mockup page(s), the REVIEW.md constraints, the API policy
  above, a hard tool-call/output budget, and instruction to report UNVERIFIED rather than
  speculate.
- **Merge bar per task:** `bd` bead claimed/closed · qa gate green on its routes in both
  themes · zero console errors · aria contract (iconbtn labels, focus-visible tooltips,
  disabled-with-reason) · driven once in a real browser · tests mutation-checked ·
  `npm test` green · old UI byte-identical.
- Dispatching 3+ agents needs owner approval with agent count + cost estimate first
  (standing rule). Proposed dispatch sizes are listed per wave below.

## Waves and beads (epic `claude-scheduler-btv`)

Hierarchy is `--parent` (display only); ordering is explicit `blocks` edges — verified after
filing: `bd ready` offers only A1; `bd dep tree claude-scheduler-btv.15` shows the full chain.

**Wave 0 — server groundwork · 1 agent, sequential (all touch `server.js`)**
- `…btv.1` **A1** `/v2` static route + assets + skeleton shell. Copy
  `redesign/assets/{system,launchbox}.css` + `theme.js`; `/v2` serves an empty dark shell
  through the existing token/auth flow; current UI byte-identical.
- `…btv.2` **C1a** `GET /api/v2/overview` — one additive aggregation endpoint (meters incl.
  resets, attention items with reasons, next-24h fires incl. after-reset ≈time, running,
  project pulse, today-so-far). Blocked by A1.
- `…btv.3` **D1a** `POST /api/v2/schedule-preview` — next 3 fires for preset/cron/once/
  after-reset, **reusing the scheduler's own parser** (a second parser in JS = "preview said
  11:50, fired 11:47" bugs). Blocked by C1a (same file, same agent).

**Wave 1 — 1 agent, blocks all UI**
- `…btv.4` **A2** shared chrome + hash router + API client: appbar (nav, usage chips,
  running chip, pause segs, theme toggle), banner slot with control-disabling under
  daemon-down/token-invalid (REVIEW #2), page shell, tooltip/a11y helpers. Frozen once
  merged. Blocked by A1.

**Wave 2 — up to 6 parallel Sonnet 5 agents, disjoint modules, all blocked by A2**
- `…btv.5` **B1** Jobs tab (row grammar, dot forms, reason lines, filter/segs, switch,
  disabled-reason actions).
- `…btv.6` **B2** Runs tab + log drawer (live/failed/winding-down, mark styling, snapshot
  semantics, burst→transcript links).
- `…btv.7` **B3** Settings + danger zone (setrows, sticky actionbar, type-to-arm).
- `…btv.8` **C1** Overview (+ quiet/unreachable/token states, as-of stamps, stale dimming).
  Also blocked by C1a.
- `…btv.9` **C2** Projects + detail + burst-live strip (activation stays a human click).
- `…btv.10` **C3** Sessions + transcript (coordinate with in-flight M5 — diff first).

**Wave 3 — 2 parallel agents**
- `…btv.11` **D1** New-job dialog + schedule builder (live next-fires via D1a; validation
  anchors focus fields; frozen approval form; explicit Cancel). Blocked by B1 + D1a.
- `…btv.12` **D2** Burn-down + burst planners (server computes plan; additive endpoints if
  the existing burst API lacks preview, `/api/v2/*` if semantics differ). Blocked by B1 + C2.

**Wave 4 — gates and cutover · E1 can start alongside wave 2**
- `…btv.13` **E1** Route-walk gate: port `redesign/qa/audit.mjs` against
  `http://127.0.0.1:43400/v2`, every route × both themes (contrast, stranded, overflow,
  console). Mutation-checked. Blocked by A2.
- `…btv.14` **E2** Interaction gates per ui-verify (dialogs, filters, keyboard walk, focus
  tooltips, daemon-down disabling). Blocked by every page + dialog task.
- `…btv.15` **E3** Parity review + cutover prep: side-by-side vs old UI, `/ → /v2` behind a
  flag (default OFF), old UI at `/v1` for one release. **The cutover click is the owner's.**
  Blocked by E1 + E2.

## Dispatch schedule (all Sonnet 5 — for approval at each wave)

| Wave | Agents | Isolation | Rough cost each |
|---|---|---|---|
| 0 | 1 (sequential A1→C1a→D1a) | main checkout | server work, medium session |
| 1 | 1 (A2) | main checkout | the big shared-contract session |
| 2 | 6 (B1 B2 B3 C1 C2 C3) | git worktrees | one page family each |
| 3 | 2 (D1, D2) | worktrees | D1 is the hardest single component |
| 4 | 1–2 (E1 early; E2 then E3) | main checkout | gate-writing sessions |

## Risks
- `server.js` contention → wave 0 single-agent by construction.
- Overview JSON shape — C1a merges before C1 starts; the endpoint's tests are the contract.
- M5 sessions work in flight → C3 brief starts with a diff of what M5 landed.
- Old-UI regressions → `/v2` never edits existing modules; `npm test` in every merge bar;
  E3's parity checklist is the final backstop.
