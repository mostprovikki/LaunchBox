# M1 — Usage foundation

Design: [`2026-07-25-launchbox-design.md`](../specs/2026-07-25-launchbox-design.md). Verify: `npm test`.

**Goal:** the daemon always knows the real usage/limit state, records it, and shows it unobtrusively on the main page. No scheduling behaviour changes yet — M1 is read-only observation plus the calibration data M2/M4 depend on.

**Definition of done:** the Jobs page shows current 5-hour / weekly / model-scoped utilisation with reset countdowns; usage history is persisted; every run records the usage delta it caused; nothing about existing job firing has changed.

---

## Steps

### 1 · `lib/usage.js` — the monitor

`createUsageMonitor({ db, spawnFn = spawn, getClaudePath, intervalMs, now = () => Date.now(), pollFloorMs = 60_000 })` → `{ start, stop, snapshot, window, refresh, events, status }`

- **Probe:** spawn `<claudePath> -p --input-format stream-json --output-format stream-json --verbose` with `stdio: ['pipe','pipe','pipe']`; write one line
  `{"type":"control_request","request_id":"<n>","request":{"subtype":"get_usage"}}`, then `end()` stdin.
- **Parse:** scan stdout lines for `type === 'control_response'`; payload at `.response.response`. Ignore everything else.
- **Flatten** into the snapshot shape below. Build `windows` **generically**: every `rate_limits.*` value that is a non-array object exposing a numeric `utilization` or a `resets_at`. This naturally admits future codename buckets and skips `extra_usage`/`spend`/`model_scoped`/`limits`.
- **Buckets** come from `rate_limits.limits[]` verbatim-ish: `{kind, group, percent, severity, resetsAt, scopeModel: scope?.model?.display_name, isActive}`.
- **Persist** every result — including failures — via `insertUsageSnapshot`, then `pruneUsageSnapshots(2000)`.
- **Emit** `events.emit('usage', snapshot)` only when something *changed* (compare percents + resetsAt) to avoid needless re-arming in M2.
- **Timing:** `setInterval` at `max(pollFloorMs, intervalMs)`, `.unref()`. Kill the probe child after a 60s watchdog. On failure: exponential backoff (×2 up to 15min), preserve the last good snapshot, mark it stale.
- **Degrade:** `rate_limits_available: false` or a non-subscription auth → `{available: false}`, no error state, no retries storm.

Snapshot shape (also the `GET /api/usage` body):

```js
{
  capturedAt: ISO, ok: bool, error: string|null, stale: bool,
  available: bool, subscriptionType: 'team'|…|null,
  windows: { five_hour: {percent, resetsAt}, seven_day: {…}, … },   // generic
  buckets: [ {kind, group, percent, severity, resetsAt, scopeModel, isActive} ],
  pollSec: number, nextPollAt: ISO
}
```

**Fail open, always.** A broken probe must never block a run or suppress a fire. Every consumer treats "unknown" as "allowed".

### 2 · db — snapshots + per-run calibration

Append to `SCHEMA` (pure additions, no migration needed):

```sql
CREATE TABLE IF NOT EXISTS usage_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capturedAt TEXT NOT NULL, ok INTEGER NOT NULL DEFAULT 1,
  available INTEGER NOT NULL DEFAULT 0, subscriptionType TEXT,
  windows TEXT NOT NULL DEFAULT '{}', buckets TEXT NOT NULL DEFAULT '[]', error TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_captured ON usage_snapshots(capturedAt);
CREATE TABLE IF NOT EXISTS run_usage (
  runId TEXT PRIMARY KEY, jobId TEXT NOT NULL,
  beforePct TEXT, afterPct TEXT, deltaPct TEXT,   -- JSON {window: number}
  sampledAt TEXT NOT NULL
);
```

New functions: `insertUsageSnapshot`, `latestUsageSnapshot`, `listUsageSnapshots({limit, okOnly})`, `pruneUsageSnapshots(keep)`, `recordRunUsage`, `getRunUsage(runId)`, `avgDeltaForJob(jobId)`.

Add both tables to `cleanupAll()`. Keep the house rule: **the db layer never touches the filesystem**.

### 3 · Per-run usage delta (the calibration that M4 needs)

Because the API gives **percent, not tokens**, cost per job must be learned:

- On `launch()`, stash the current snapshot's percents on the run entry (no extra probe — reuse the cached snapshot).
- On `finish()`, request `usage.refresh()`; when it lands, write `run_usage` with before/after/delta per window.
- Deltas are noisy (concurrent runs, interactive use, other devices). Store raw; let M4 aggregate with a median and treat any single sample as weak evidence. Do **not** present a single delta as authoritative in the UI.
- Wire via an injectable callback so runner tests need no usage monitor.

### 4 · Settings

Core settings (cross-cutting, so they live in the core block at `server.js:182-205`, not per-extension):

| key | default | meaning |
|---|---|---|
| `usagePollSec` | `180` | poll interval, floored at 60 |
| `usageShow` | `banner` | `banner` \| `compact` \| `off` — main-page display |
| `usageWarnPct` | `80` | amber threshold for the display |

Guard/reserve settings are **M2**, not here — M1 ships no enforcement.

### 5 · API

- `GET /api/usage` → snapshot (§1 shape) + `{display: usageShow, warnPct}`
- `POST /api/usage/refresh` → force a probe, 202 + snapshot when it lands (rate-limited server-side to the poll floor)
- `GET /api/usage/history?limit=` → `{snapshots: [...]}` for the sparkline
- Extend `GET /api/settings` / `PUT /api/settings` with the three keys above.

### 6 · UI — unobtrusive by default

Extract `public/util.js` first (`api`, `esc`, `toast`, `relTime`, `fullTime`, `duration`), re-point `app.js` and `fields.js` at it. This is the prerequisite for every later UI addition and removes the duplicated `esc`.

Then a **usage strip** at the top of the Jobs tab, above the toolbar. Three display modes via `usageShow`:

- **`banner`** (default) — one row of slim labelled meters: `5h 24%` · `week 63%` · `Fable 89%`, each with a reset countdown (`resets in 2h 14m`). Amber past `usageWarnPct`, red past 95%, and any bucket with `severity !== 'normal'` or `isActive` gets the accent regardless of percent. Reuse existing `.chip`/`.pill`/`.card` and the `--ok/--warn/--fail` tokens; add no new colour vocabulary.
- **`compact`** — a single chip in the header next to "N running": worst-bucket percent only, full detail on hover/click.
- **`off`** — nothing rendered, endpoint still polled for M2.

Rules: it must never shift layout when it appears/disappears; stale snapshots render greyed with a "stale" tooltip, not hidden; `available: false` shows a one-line "usage unavailable (API-key session)" instead of empty meters. Poll `GET /api/usage` on the existing 2500ms `refreshJobs` tick — no second timer, no SSE for M1.

### 7 · Tests

Follow house style: `node:test`, `tests/usage.test.js`, fake `spawnFn` from `tests/helpers.js`.

- parses a real captured `control_response` fixture → correct windows/buckets (use the verified payload in the design doc as the fixture)
- generic window discovery: an unknown codename bucket with `utilization` appears; `extra_usage`/`spend` do not
- `rate_limits_available: false` → `{available: false}`, no error
- malformed/partial stdout, non-JSON noise, and probe non-zero exit → `ok: false`, previous good snapshot retained and marked stale
- poll floor is enforced (an `intervalMs` of 5s is clamped to 60s)
- backoff grows on repeated failure and resets on success
- `events.emit('usage')` fires on change and **not** on an identical repeat
- db: snapshot round-trip, prune keeps newest N, `cleanupAll` wipes both new tables, double-`openDb` is idempotent
- `run_usage` delta recorded across a fake run
- api: `GET /api/usage` shape; refresh rate-limiting; settings round-trip

**No test may spawn the real `claude` binary.** Keep one manual verification note in the plan instead (below).

### 8 · Manual verification

```bash
# ground truth, ~2s, $0
printf '%s\n' '{"type":"control_request","request_id":"1","request":{"subtype":"get_usage"}}' \
  | claude -p --input-format stream-json --output-format stream-json --verbose
```

Then `CS_DATA=$(mktemp -d) CS_PORT=18741 node server.js`, open the UI, confirm the strip matches the raw probe, and confirm all three `usageShow` modes render without layout shift.

---

## Risks

| Risk | Mitigation |
|---|---|
| `get_usage` shape changes (explicitly experimental) | Store raw payload; parse defensively; generic bucket discovery; fail open. A parse failure degrades to "unknown", never to a blocked scheduler. |
| `/api/oauth/usage` rate-limits our polling | 60s floor, 180s default, exponential backoff, server-side throttle on the manual refresh route. |
| Probe spawns a CLI process every 180s | Measured $0 and no model turn. Watchdog-kill at 60s. Revisit if the process cost proves material. |
| Percent-only data tempts fake precision | Never display a derived token/cost figure as fact; M4 planner must show its confidence and its sample size. |

## Appendix — sourced ToS extract

Verbatim, fetched 2026-07-25. Raw copies were saved to the session scratchpad; re-fetch to re-verify.

**Which contract applies.** Claude Code "Legal and compliance" (code.claude.com/docs/en/legal-and-compliance): *"Your use of Claude Code is subject to: Commercial Terms - for Team, Enterprise, and Claude API users; Consumer Terms of Service - for Free, Pro, and Max users."* This account reports `subscription_type: "team"` → **Commercial Terms**.

**Automated access.** Consumer ToS §3 (eff. 2025-10-08) prohibits: *"Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise."* → **No counterpart exists in the Commercial Terms.** Full-text search for "automated", "bot", "script", "rate limit", "excessive", "unattended", "circumvent" over the Commercial Terms returns no substantive hits.

**The "ordinary usage" clause.** Claude Code legal page, Acceptable use: *"Claude Code usage is subject to the Anthropic Usage Policy. Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."* → Scoped to Pro/Max; not applicable to Team. Undefined terms, no stated consequence, and it is the only "character of use" statement anywhere.

**What does apply to Team.** Commercial Terms D.2: *"Customer and its Users may only use the Services in compliance with these Terms, including (a) the Usage Policy … (c) our Service Specific Terms."* And I.3.a: *"Anthropic may suspend Customer's access … if … (iii) Anthropic's provision of the Services to Customer is prohibited by applicable law or would result in a material increase in the cost of providing the Services."* — the only cost-keyed clause in any Anthropic document, and commercial-only.

**Usage Policy (eff. 2025-09-15)** is a content/harm policy. Its only automation clause is *"Utilize automation in account creation or to engage in spammy behavior"*; its guardrail-bypass clause is limited to *"instructing the model to produce harmful outputs (e.g., jailbreaking or prompt injection)"*. **Silent** on volume, duration, scheduling, and quota evasion. Enforcement: *"we may throttle, suspend, or terminate your access."*

**The bright line.** Claude Code legal page, Authentication: *"Anthropic does not permit third-party developers to offer Claude.ai login or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."* Plus Consumer ToS §2: *"You may not share your Account login information … You also may not make your Account available to anyone else."*

**First-party precedent for scheduled/unattended use.** Anthropic ships: `claude -p` headless (*"Run Claude Code programmatically"*), the Agent SDK, `claude setup-token` (*"For CI pipelines, scripts … generate a one-year OAuth token … requires a Pro, Max, Team, or Enterprise plan"*), in-session cron (`CronCreate`, min interval 1 minute), Desktop scheduled tasks, and **Routines** — *"Routines run autonomously as full Claude Code cloud sessions"*, *"Routines draw down subscription usage the same way interactive sessions do"*, controlled by a per-account **daily run cap** rather than a prohibition.

**Correction to a common assumption.** A support article announced that from 2026-06-15 Agent SDK / `claude -p` usage would stop counting against subscription limits. It was **rescinded**: *"Update June 15: We're pausing the changes to Claude Agent SDK usage described below. For now, nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits."* Build against the current model: **headless usage does consume the same limits.**

**Affirmative findings of absence** (verified by full-text search, not inference): no clause in any of the three instruments prohibits circumventing/evading usage or rate limits; none addresses continuous, unattended, idle, or background operation; none uses "excessive use" or "high volume" as a restriction on a subscription; no absolute figures for any plan's 5-hour or weekly limit are published anywhere.

**Operational rule for this repo:** local-only; drives the user's own `claude` binary with the user's own credential; no hosted component; no third-party token acceptance; no pooling or proxying; conservative reserve defaults; maximization strictly opt-in. This is also why M2's guard defaults protect headroom rather than consume it.
