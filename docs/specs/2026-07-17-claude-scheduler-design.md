# Claude Scheduler — Design

2026-07-17. Local scheduler UI to create cron jobs / one-shot tasks that run headless Claude Code (`claude -p`) on time. Standalone tool at `~/tools/claude-scheduler/` (own git repo, outside the system_migration suite).

## Goals

- Web UI to create/edit/enable/disable scheduled jobs; a job runs either `claude -p "<goal prompt>"` (chosen model/permission flags) or a raw shell command, in a chosen working dir.
- Jobs fire without the UI open, survive reboot/login — launchd keeps the daemon alive.
- Run history + per-run logs in the UI; live progress for running claude jobs (streamed events, not just final output); "N running" always visible.
- Interactive access on demand: resume any claude run in Terminal via its session id.
- Global controls: max-concurrent cap, pause-all switch; per-job retry on failure.
- macOS notifications on completion/failure (configurable per job).
- One-click cleanup (wipe all jobs/runs/logs) and one-click uninstall (remove all traces).

Non-goals: multi-user, remote access, auth, catch-up of runs missed while asleep (skip; possible later), Linux/Windows, attaching a TTY to a running headless run (resume covers it).

## Architecture (Approach A — launchd-managed daemon)

One LaunchAgent `~/Library/LaunchAgents/com.claude-scheduler.plist` (`RunAtLoad` + `KeepAlive`) keeps a single Node daemon alive from login. The daemon is everything: Express web UI + API, in-process cron engine (croner), and runner that spawns `claude -p` children. Full cron semantics, one plist ever written, daemon owns child processes so logs/history are trivial.

Rejected: per-job launchd plists (poor cron fidelity, plist churn, results must be written back out-of-process); plain crontab (macOS quirks, no clean logs).

## Stack & layout

Node + minimal deps: `express`, `croner`, `better-sqlite3`. Vanilla SPA (no framework, no build step).

```
~/tools/claude-scheduler/
  server.js            entry: express + boot scheduler
  lib/
    db.js              better-sqlite3 open + schema migrate
    scheduler.js       croner job registry (start/stop/reload per job)
    runner.js          spawn claude -p, stream logs, timeout, notify
    notify.js          osascript banner
    launchd.js         plist write/bootstrap/bootout helpers
    uninstall.js       detached full-removal sequence
  public/              SPA (index.html, app.js, style.css)
  install.sh           npm install; resolve `which claude` → settings; write+bootstrap plist
  uninstall.sh         same removal as UI one-click (idempotent)
  docs/specs/          this doc
```

Data lives outside the tool dir in `~/.claude-scheduler/`:
- `scheduler.db` (sqlite: jobs, runs, settings)
- `logs/<runId>.log` (combined stdout+stderr per run)
- `daemon.log` (launchd StandardOut/ErrorPath)

Server binds **127.0.0.1:9099** (no auth — never 0.0.0.0). Env overrides: `CS_PORT`, `CS_DATA` (tests run sandboxed: `CS_DATA=$(mktemp -d) CS_PORT=18740`).

## Job model (`jobs` table)

| Field | Notes |
|---|---|
| id | uuid |
| name | display name |
| type | `claude` \| `command` |
| prompt | claude type: goal text passed to `claude -p` |
| command | command type: shell string, run via `/bin/zsh -lc` |
| cwd | working dir; validated to exist on save |
| schedule | JSON: `{type:'cron', expr}` or `{type:'once', at:ISO}` |
| enabled | bool; one-shots auto-disable after firing (row kept for history) |
| model | claude type: `default` \| `opus` \| `sonnet` \| `haiku` → `--model` |
| permMode | claude type: `default` \| `acceptEdits` (`--permission-mode acceptEdits`) \| `auto` (`--dangerously-skip-permissions`, for unattended goal runs) |
| extraArgs | claude type: string, appended verbatim (shell-split, not shell-interpreted) |
| timeoutMin | default 60; SIGTERM then SIGKILL on breach → status `timeout` |
| retry | `{count: 0-3, delayMin}` — re-run after delay on `fail`/`timeout`; default off |
| notify | `always` \| `failure` (covers `fail` + `timeout`) \| `never` |
| createdAt / updatedAt | |

Overlap policy: fixed = **skip** if the previous run of the same job is still going (recorded as status `skipped`).

## Runs (`runs` table)

id, jobId, startedAt, finishedAt, exitCode, status (`queued`/`running`/`ok`/`fail`/`timeout`/`skipped`), durationMs, logPath, trigger (`schedule`/`manual`/`once`/`retry`), sessionId (claude runs, from stream init event), progress JSON (claude runs: current activity, turn count — updated live). Retention: keep last **50** runs+logs per job, pruned after each run.

## Execution flow

1. Boot: daemon loads enabled jobs, creates one croner instance per job (one-shots via croner date trigger).
2. Fire: overlap check → concurrency check (claude runs only: if `maxConcurrent` reached, insert run as `queued`, FIFO-start when a slot frees) → run row `running` → spawn:
   - claude type: `spawn(claudePath, ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...flags], {cwd})`. NDJSON piped through a formatter → human-readable `logs/<runId>.log` (assistant text + tool calls as they happen) + live progress on the run row (current activity, turns) + sessionId captured from the init event.
   - command type: `spawn('/bin/zsh', ['-lc', command], {cwd})`, combined stdout+stderr → `logs/<runId>.log`. Not counted against `maxConcurrent`.
3. `claudePath` is an absolute path stored in settings (resolved by `install.sh` via `which claude`; editable in UI) — launchd PATH is bare, never rely on it.
4. Exit: update run row, notify per job setting (`osascript -e 'display notification ...'` — name + status). On `fail`/`timeout` with retry configured: schedule re-run after `delayMin` (trigger `retry`), up to `count` times.
5. Job edits/toggles reload only that croner instance; delete stops it and removes runs+logs.
6. Run-now button: same flow, trigger `manual`, ignores schedule (overlap + concurrency rules still apply).
7. Pause-all (settings.paused): scheduled fires are ignored while on (logged to daemon.log, no run rows); run-now still works. UI shows a banner.
8. Missed while asleep/daemon down: skipped, by design.
9. Resume in Terminal: for any claude run with a sessionId, UI button → `osascript` opens Terminal.app running `claude --resume <sessionId>` in the job's cwd — full interactive session with that run's context. (No TTY attach to a live headless run; resume is the interactive path.)

## API

- `GET/POST /api/jobs`, `GET/PUT/DELETE /api/jobs/:id`
- `POST /api/jobs/:id/run` (run now)
- `GET /api/runs?job=<id>&status=running`, `GET /api/runs/:id/log` (full), `GET /api/runs/:id/tail` (SSE: log lines + progress while running)
- `POST /api/runs/:id/resume` (osascript → Terminal `claude --resume <sessionId>` in job cwd)
- `GET/PUT /api/settings` (claudePath, maxConcurrent — default 2, paused, defaults)
- `POST /api/schedule/preview` — cron expr or builder state → next 3 fire times (croner)
- `POST /api/cleanup` — wipe ALL jobs, runs, logs (confirm in UI)
- `POST /api/uninstall` — full removal (confirm in UI)

## UI (vanilla SPA)

- **Header**: "N running" badge (live), pause-all toggle (banner when on).
- **Jobs list**: name, type icon, schedule (human text), next fire, last-run status dot, spinner when running, enabled toggle, run-now, edit, delete.
- **Job editor**: name, type (claude prompt / shell command), prompt or command (textarea), cwd (text path, existence-validated), schedule builder — presets (daily at HH:MM, weekdays, every N hours/minutes, once at datetime) + raw cron field, either way a live "next 3 fires" preview; claude-only: model + permission dropdowns, extraArgs; timeout; retry; notify.
- **Run history**: per-job list of runs → log viewer; running claude jobs show live progress (current activity, turns) + streaming log via SSE; **Resume in Terminal** button on any run with a sessionId.
- **Settings**: claudePath, maxConcurrent, danger zone — **Cleanup** (wipe all jobs/runs/logs; typed confirm) and **Uninstall** (remove all traces; typed confirm).

## Cleanup & uninstall

- **Cleanup** (`POST /api/cleanup`): stop all croner instances, kill running children, delete all rows in jobs/runs, rm `logs/*`. Daemon + settings survive.
- **Uninstall** (`POST /api/uninstall` or `./uninstall.sh`): responds 202, then spawns a **detached** shell script (copied to a temp path so it survives dir removal) that: waits for daemon exit → `launchctl bootout gui/$UID/com.claude-scheduler` → rm plist → `rm -rf ~/.claude-scheduler` → `rm -rf ~/tools/claude-scheduler`; daemon kills running children and exits after responding. `uninstall.sh` runs the same sequence idempotently from disk.

## Error handling

- Invalid cron expr / missing cwd / bad claude path → 400 with message; UI inline errors.
- Spawn failure (claude path gone) → run status `fail`, error text written into the run log, notify on `failure`/`always`.
- Daemon crash → launchd restarts (KeepAlive); croner state rebuilt from db on boot; `running`/`queued` rows found at boot are marked `fail` (orphaned).
- SQLite is single-writer from one process — no lock concerns.

## Testing

`node:test`. All tests sandboxed (`CS_DATA` tmpdir, `CS_PORT` 18740–18749). Runner injected as a fake for scheduler tests (no real claude spawns); stream-json formatter tested against canned NDJSON fixtures. Cover: schema/CRUD, builder→cron mapping + preview times, overlap skip, concurrency queue (FIFO start on slot free), pause-all, retry scheduling, one-shot auto-disable, timeout kill, retention prune, formatter (readable log + progress + sessionId capture), cleanup endpoint, orphaned-run recovery. launchd/uninstall/resume osascript paths tested manually.
