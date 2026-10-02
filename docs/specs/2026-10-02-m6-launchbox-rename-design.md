# M6 — LaunchBox rename + node:sqlite

Status: design approved by owner 2026-10-02 (brainstorm in session). Epic: claude-scheduler-l6d.
Supersedes the one-line M6 row in [2026-07-25-launchbox-design.md](2026-07-25-launchbox-design.md).

## Goal

Everything says LaunchBox: package, bin, data dir, launchd label, beads actor, docs and skills.
Drop the native `better-sqlite3` dependency for the built-in `node:sqlite`, which removes the
`ERR_DLOPEN_FAILED` / `npm rebuild better-sqlite3 --build-from-source` workaround.

## Owner decisions

| Question | Decision |
|---|---|
| Scope | Full consistency (not visible-names-only) |
| Existing install | Explicit `launchbox migrate`, run by hand; new daemon refuses to start while `~/.claude-scheduler` exists and `~/.launchbox` does not |
| node:sqlite | Yes, as its own phase, before the rename |
| Branch prefix `scheduler/` | Kept — it names the role, not the product |
| Repo folder `~/mydevelopment/claude-scheduler` | Kept (GitHub repo is already LaunchBox) |
| Old bead ids `claude-scheduler-*` | Kept — beads cannot rename ids |

## Facts measured on the live install (2026-10-02)

- Daemon runs as `npm start` → `node server.js` in a terminal; no launchd agent is installed
  (`launchctl print gui/$UID/com.claude-scheduler` → not found). The label matters only to
  `install.sh` / `uninstall.sh` / `lib/uninstall.js`.
- `~/.claude-scheduler` holds `scheduler.db` (+ `-wal`, `-shm`), `token`, `port`, `logs/`,
  `worktrees/`, `bin/LaunchBox` (Touch ID helper), daemon logs, and a **0-byte stray
  `launchbox.db`** (2026-09-21).
- Absolute data-dir paths stored in the DB: `runs.logPath` 236 rows, `jobs.cwd` 65,
  `settings.worktreeRoot` 1, `jobs.params` 1, `runs.meta` 1, `sessions.cwd` 139,
  `sessions.firstPrompt` 1.
- Each registered repo's `.git/worktrees/*/gitdir` points into `~/.claude-scheduler/worktrees/`.
- Driver surface: `lib/db.js` is the only importer of `better-sqlite3`; non-`prepare` calls are
  `new Database`, `pragma('journal_mode = WAL')` and three `pragma('table_info(..)')`. No
  `.transaction()`, `.iterate()`, `.pluck()`, `.backup()`.
- Env vars: `CS_DATA`, `CS_PORT`, `CS_NO_NOTIFY`, `CS_SESSIONS_ROOT`, `CS_FORCE_PLATFORM`,
  `CS_APPROVAL_TIMEOUT_MS`, `CS_SHOTS_FIXTURE`, `CS_SITTING_HEADFUL`.
- `lib/beads.js:42` `BD_ACTOR = 'claude-scheduler'` is written into every registered repo's
  `.beads/interactions.jsonl`; the registered-repo-session skill filters on it.

## Phase 1 — node:sqlite

- `lib/db.js` opens `DatabaseSync` from `node:sqlite`. `pragma(x)` calls become
  `exec('PRAGMA …')` / `prepare('PRAGMA table_info(..)').all()`.
- `engines.node` → `>=22.5`; `better-sqlite3` removed from `package.json`; README and CLAUDE.md
  drop the rebuild note.
- Any behaviour gap found (named-parameter syntax, BigInt, boolean binding, `run()` result shape)
  is fixed in `lib/db.js` or at the call site, not by editing tests.
- **Gates:** full suite passes with no test edits. New test opens a DB file written by the
  current schema under `better-sqlite3` (checked-in fixture, generated once before the swap) and
  reads every table. Mutation: break the adapter (e.g. drop the WAL exec or the table_info
  mapping) → red.

## Phase 2 — rename in code

- package `launchbox`; bin `bin/launchbox.mjs` (usage string `launchbox [open|url|token|migrate]`).
- Default data dir `~/.launchbox`; DB file `launchbox.db`.
- launchd label `com.launchbox` in `install.sh`, `uninstall.sh`, `lib/uninstall.js`.
- `BD_ACTOR = 'launchbox'`.
- Env vars `LB_*` with `CS_*` read as fallback (one helper in `lib/paths.js`, not per call site).
- Product strings, comments and UI copy say LaunchBox. Bead-id references in comments stay.
- Startup guard: if `~/.claude-scheduler` exists and the new data dir does not, refuse to start
  with the exact `launchbox migrate` command. `LB_DATA`/`CS_DATA` set explicitly bypasses it.
- **Ordering:** the default-dir change and the startup guard land in the same merge as Phase 3,
  so `main` never has a daemon that refuses to start with no `migrate` to run.
- **Gate:** a source-scan test fails `npm test` when `claude-scheduler` appears in code outside
  (a) bead-id references `claude-scheduler-<id>`, (b) the legacy fallback list in one named
  module, (c) docs/history. Mutation: plant one occurrence in each offender shape (string, comment,
  path, identifier) → red each time.

## Phase 3 — `launchbox migrate`

Order: validate → refuse → back up → rewrite → move. A failure before the move leaves the old
dir untouched and usable.

1. **Refuse** (each with its own message and test) when: the daemon answers on the port; any
   run is `running`/`queued` in the DB; any `task_leases` row is unreleased or any worktree under
   `worktrees/` is checked out; `~/.launchbox` exists and is not empty.
2. **Back up** `scheduler.db` (after `PRAGMA wal_checkpoint(TRUNCATE)`) to
   `scheduler.db.pre-m6.bak` inside the old dir.
3. **Rewrite** in one transaction: prefix `~/.claude-scheduler/` → `~/.launchbox/` in
   `runs.logPath`, `jobs.cwd`, `jobs.params`, `runs.meta`, `settings.value`. `sessions.*` is left
   alone: it records where each Claude session ran, and transcripts under `~/.claude/projects`
   are keyed by that path.
4. **Move** the dir with one `rename(2)`; rename `scheduler.db*` → `launchbox.db*`; remove the
   0-byte stray `launchbox.db` first (refuse if it is non-empty).
5. **Repair** `git worktree repair` in each registered project path; report any repo that fails
   without undoing the move.
6. **Symlink** `~/.claude-scheduler` → `~/.launchbox` for one release.
7. Re-running after success prints "already migrated" and exits 0.

`--dry-run` prints every refusal check, row counts per column to rewrite, and the moves, and
changes nothing.

**Gates:** every refusal tested on a fixture tree under `CS_DATA`/`LB_DATA` in TMPDIR; a
fault-injected failure at each step leaves the old tree byte-identical; idempotent re-run;
dry-run writes nothing (mtime + hash of fixture unchanged). Never run against the real dir in
tests.

## Phase 4 — outside the repo

- `~/.claude/CLAUDE.md`, `~/.claude/docs/beads-task-tracking.md`, `skills/` in this repo (and the
  installed copies via `npm run install:skills`), the SessionStart hook text.
- Readers of `interactions.jsonl` accept **both** `claude-scheduler` and `launchbox` as the
  scheduler actor.
- Worktree path references `~/.claude-scheduler/worktrees/` → `~/.launchbox/worktrees/`.
- **Gate:** a briefing run in this repo after the rename still lists pre-rename scheduler history.

## Owner sitting (end)

1. `launchbox migrate --dry-run`, read the output.
2. Stop the daemon (Ctrl-C in its terminal), run `launchbox migrate`.
3. `npm start`; open the UI; trigger one scheduled bead and watch it run in its worktree.
4. After one release with no issues, delete the `~/.claude-scheduler` symlink and the `.bak`.

## Out of scope

Branch prefix, repo folder name, old bead ids, the M5 cost estimate.
