# M5 — Sessions dashboard

Design: [`2026-07-25-launchbox-design.md`](../specs/2026-07-25-launchbox-design.md). Verify: `npm test`.

**Goal:** a live view of every Claude Code session on this machine — browse, search, read transcripts, rename, delete, resume — and **joined to LaunchBox's own runs**, which is the part no standalone tool can do.

**Source:** ports logic from `claude-sessions-dashboard/claude-sessions` (2,218-line Python, stdlib only, **MIT © wannabemrrobot**). Not a wholesale port: ~150 lines carry the durable value, one measured bug gets fixed on the way in, and the full-rescan architecture is replaced.

**Definition of done:** a Sessions tab lists sessions with live running indicators, opens transcripts, renames/deletes/resumes; scheduled runs and their sessions are cross-linked both ways; attribution is in place.

---

## 5.1 Attribution (do this first — it's the licence obligation)

- `LICENSES/claude-sessions-dashboard-MIT.txt` — the upstream `LICENSE` verbatim, including `Copyright (c) 2026 wannabemrrobot`.
- `NOTICE` (or a README "Credits" section): *"Session discovery and JSONL parsing derived from claude-sessions-dashboard (MIT © wannabemrrobot), https://github.com/wannabemrrobot/claude-sessions-dashboard, copied 2026-07-24."* The local copy has no `.git`, so no commit can be pinned — record the date.
- Credit **Lucide** icons as **ISC** if any are reused (upstream README says ISC, an inline comment says MIT; ISC is correct).
- A header comment in `lib/sessions.js` naming the origin and the deviations (§5.3).

MIT permits commercial use, modification and sublicensing; the only obligation is carrying the notice. Nothing here requires open-sourcing LaunchBox.

## 5.2 `lib/sessions.js` — port faithfully

`createSessionIndex({ db, root = ~/.claude/projects, activeWindowS = 60, now })` → `{ scan, list, get, conversation, rename, remove, running, start, stop, events }`

Port these with care; upstream line numbers given so the original is checkable:

| Logic | Upstream | Note |
|---|---|---|
| Session id = **filename stem** | `:194` | Not any field; safer than in-row `sessionId`, which is absent from many row types |
| `cwd` from **in-row `cwd`**, first-wins | `:222-223` | **Critical:** the directory-name encoding maps `/`, `.` and `_` all to `-` and is **not invertible**. Folder-name decoding (`:293-295`) is a lossy last resort only — on this machine it would yield `/Users/vignesh/5036/mydevelopment/claude/scheduler`. Keep the warning comment. |
| First-wins `gitBranch`/`version`/`entrypoint`; **last-wins** `custom-title`/`ai-title` | `:222-243` | Document the asymmetry; branch is the branch at session *start* |
| `activeMs` from `system`/`turn_duration`.`durationMs` | `:244-248` | Authoritative, not a heuristic. Add the `subtype` check upstream omits. The `activeMs`-vs-`spanMs` contrast (50s of work inside a 1.2-day span) is the most informative thing on a card. |
| Pasted-image annotations | `:96-122` | Highest-value hard-won knowledge in the file: `[Image: source: …]` companion rows are deleted silently; `[Image: original WxH…]` becomes a "not stored" marker. Copy the explanatory comment verbatim. |
| Per-line `try/catch` + dict check + `errors='replace'`, streamed | `:210-219`, `:1831-1840` | Non-negotiable: these files are appended to while being read, so a trailing half-written line is normal |
| Transcript row/block handling | `:1844-1893` | `tool_result` as its own turn, `is_error`, `thinking` dropped, `tool_use` input pretty-printed |
| `<synthetic>` model exclusion | `:253`, `:1873` | |
| `custom-title` append protocol | `:430-447` | Exactly 3 keys; **ensure a trailing newline first** or the row glues onto the last line and corrupts both |
| `(cwd, customTitle)` ambiguity → resume by id | `:363-376` | Duplicate names make `claude --resume "<name>"` ambiguous |
| Refuse delete on a running session | `:2036-2051` | |
| Depth-1 discovery | `:352` | `root/*/*.jsonl` excludes `<uuid>/subagents/*.jsonl` structurally. If ever walking recursively, filter on `isSidechain === false` instead. |
| `INTERACTIVE_ENTRYPOINTS` allowlist including `""` | `:342` | Fail-open, so an unknown future entrypoint never silently vanishes |
| Naive timestamps mean **UTC** | `:64-74` | Replicate or durations shift by the local offset. Many row types carry no `timestamp` at all. |

## 5.3 Deliberate deviations from upstream

1. **Fix the token inflation.** Claude Code writes one assistant row per content block, each repeating the **same** `usage` object. Measured here: 2,140 assistant rows → 1,013 unique `message.id`; naive sums inflate input 2.52×, output 2.70×, cache-read 2.04×. **Dedupe on `message.id` (fallback `requestId`)** before accumulating tokens or counting model turns. Upstream does not, so its token and cost figures — and any tool that sums JSONL the same way — are wrong.
2. **Cache instead of rescanning.** Upstream re-reads and fully re-parses every `.jsonl` on every request, including after each rename and delete. Cache parsed metadata in the `sessions` table keyed on `(filePath, mtimeMs, sizeBytes)`; re-parse only changed files. Parse transcripts on demand, never in the list path.
3. **Watcher + SSE instead of 7s polling.** `fs.watch`/interval on `~/.claude/projects` → invalidate cache, emit running-state changes over SSE (the app already has SSE for run tails). **Must not** treat our own rename-append as activity — upstream's own rename bumps mtime and makes the session look "running" for 60s, greying out its own Delete button.
4. **Extend the prompt-noise filter.** Upstream leaks `<bash-input>`, `<bash-stdout>`, `◇ ultraplan` and similar into the prompt list. Add those prefixes, and prefer the `isMeta` / `promptSource` fields that exist on real rows over prefix-sniffing text. Dedupe repeated identical prompts (re-injected on resume/compaction).
5. **Cost estimate, if kept at all:** move server-side, include cache tiers (`in + 1.25×cache_creation + 0.10×cache_read`, vs upstream ignoring cache entirely on a session with 12.5k input and 358k cache-read), keep the prefix-match + turn-share apportionment and the `partial` flag. Given the account is a subscription, label it clearly as an API-rates approximation — or omit it and show tokens only.
6. Skip entirely: the embedded HTML/CSS/JS template, marker substitution, `--static` mode, image sidecar externalisation, argparse/serve, `turn_count` (dead code), `userMsgs` (counts tool-result rows; `prompts` is the meaningful number).

## 5.4 The integration that justifies building this

`extensions/claude/formatter.js:20` already captures `sessionId` from the `system/init` event into `runs.meta`. So:

- Session cards show **"created by job \<name\>"** and link to the run + its log.
- Run history rows link to the session transcript.
- Per-job token attribution becomes real (deduped tokens per session, grouped by job) — which is also the honest, tokens-based complement to M1's percent-based `run_usage` deltas.

## 5.5 Schema

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, filePath TEXT NOT NULL,
  mtimeMs INTEGER NOT NULL, sizeBytes INTEGER NOT NULL,
  cwd TEXT, project TEXT, gitBranch TEXT, version TEXT, entrypoint TEXT,
  customTitle TEXT, aiTitle TEXT, firstPrompt TEXT,
  firstTs TEXT, lastTs TEXT, spanMs INTEGER, activeMs INTEGER,
  prompts INTEGER, models TEXT,
  tokIn INTEGER, tokOut INTEGER, tokCacheCreate INTEGER, tokCacheRead INTEGER,
  webSearches INTEGER, webFetches INTEGER,
  scannedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_last ON sessions(lastTs);
```

Add to `cleanupAll()` — but note this table is a **cache of files we don't own**; wiping it must never delete session files. Deleting a *session* is an explicit user action only.

## 5.6 API

`GET /api/sessions` (+ `?all=1`) · `GET /api/sessions/:id` · `GET /api/sessions/:id/conversation` · `POST /api/sessions/:id/rename` · `DELETE /api/sessions/:id` · `POST /api/sessions/:id/resume` (osascript → Terminal, reusing the `claude` extension's existing action) · `GET /api/sessions/stream` (SSE running-state) · `GET /api/sessions/:id/image/:p/:i` (decode on demand; don't externalise to a sidecar dir).

Keep the upstream path-traversal guards: `^[A-Za-z0-9._-]+$` on the id (`:1984`) and a realpath prefix check on any file path (`:2063-2077`).

## 5.7 UI

New **Sessions** tab (4-edit pattern; extract `public/util.js` first if M1 hasn't). Worth keeping from upstream, as *logic* not markup: `activeMs` vs `spanMs` side by side; model label only on change (`:1474-1478`); tool rows collapsed by default and auto-expanded on a search hit (`:1366`); running sessions floated to top as a second sort pass (`:1631`); a precomputed lowercased search haystack (`:1124-1127`); `relTime` bucketing and `fmtTok` (`4187 → 4.2k`); auto-collapse prompts over 700 chars; arm-then-confirm inline delete. Rebuild the CSS, icons, tooltips and markdown rendering against the existing design tokens rather than porting 420 lines of upstream CSS.

## 5.8 Tests

Fixture-driven, using synthetic `.jsonl` files in a tmpdir `root` (never the real `~/.claude`):

- cwd resolution prefers in-row `cwd`; the lossy folder fallback is used only when absent
- first-wins vs last-wins field semantics
- **usage dedupe**: a fixture with 3 blocks sharing one `message.id` counts tokens **once** (regression guard for the 2.5× bug)
- `activeMs` sums only `turn_duration` rows; `spanMs` is wall clock
- malformed trailing line, invalid UTF-8, and a non-dict row are all skipped without throwing
- image annotations: `source:` companion dropped, `original WxH` → not-stored marker
- prompt filter drops `<bash-input>`/`<system-reminder>`/`<command-name>` and dedupes repeats
- subagent transcripts under `<uuid>/subagents/` are excluded; `entrypoint` allowlist incl. `""`
- rename appends exactly one 3-key `custom-title` row and inserts a missing trailing newline first
- rename does **not** mark the session running (the upstream self-inflicted bug)
- delete refused while running; ambiguous `(cwd, title)` resumes by id
- cache: unchanged file is not re-parsed (assert parse count); changed mtime/size triggers re-parse
- run↔session join resolves via `runs.meta.sessionId`
- traversal guards reject `../` and absolute paths

## Risks

| Risk | Mitigation |
|---|---|
| JSONL shape changes with Claude Code releases | Defensive per-row parsing, `isinstance`-equivalent checks, `or 0` on every numeric; unknown row types ignored, not fatal |
| We corrupt a live session file | Only ever **append** (rename), with the trailing-newline check; never rewrite. Delete is an explicit user action. |
| Scanning hundreds of MB blocks the event loop | mtime/size-keyed cache; stream line-by-line; transcripts parsed only on demand; scan off the request path |
| Cache table mistaken for source of truth | It is a cache of files we don't own — `cleanupAll` clears rows only, never files |
| Reading real session content in tests leaks personal data | All tests use synthetic fixtures in a tmpdir |
