# Claude Scheduler

Local web UI to schedule cron jobs and one-shot tasks — on time, without the UI open. macOS only.

At its core it's a friendly frontend for cron-style jobs. Job *types* are pluggable **extensions**: shell commands (`command`) and headless Claude Code runs (`claude`) ship built-in, and you can add your own agent/type by cloning a folder — see [`extensions/README.md`](extensions/README.md).

## Install

```bash
./install.sh
```

Installs deps, writes `~/Library/LaunchAgents/com.claude-scheduler.plist` (RunAtLoad + KeepAlive) and starts the daemon. UI: **http://127.0.0.1:9099** (localhost only, no auth).

Data lives in `~/.claude-scheduler/` (sqlite db, per-run logs, daemon.log). The `claude` binary path is auto-detected at first boot; fix it in Settings if needed.

## Features

- **Jobs**: any extension type · working dir · cron (builder presets or raw expr, live next-3-fires preview) or once-at-datetime · timeout · retries · per-job notifications (macOS banners). Job forms are generated from each extension's field config.
- **Extensions**: job types are plugins under `extensions/` — fields, settings, output parsing, concurrency caps and per-run actions all declared per extension. Copy `extensions/_template` to add one.
- **Claude extension**: model + permission mode (`auto` = `--dangerously-skip-permissions` for unattended runs) · extra CLI args · live progress (current tool, tool calls, turns) from `stream-json` · **Resume in Terminal** (one click opens `claude --resume <sessionId>` in the job's cwd) · max concurrent runs (default 2, queued FIFO beyond).
- **Keep awake** (☕ in the header): prevents the Mac sleeping through scheduled fires, à la `caffeinate`. Modes: **while jobs are scheduled** (auto — holds awake only when a run is active or an enabled job has a future fire), **for a set period** (30m–8h), **indefinitely**, or off. The assertion dies with the daemon, so a crash can't leave the Mac insomniac.
- **Visibility**: "N running" badge, per-run logs with live tail (SSE), run history with status filters, kill button for running/queued runs.
- **Controls**: pause-all switch, overlap-skip per job, multiple schedules per job.
- **Semantics**: runs missed while the Mac slept are skipped; one-shots auto-disable after firing; last 50 runs kept per job.

## Cleanup / Uninstall

- **Settings → Cleanup**: wipes all jobs, run history and logs (daemon + settings stay).
- **Settings → Uninstall** or `./uninstall.sh`: removes launchd agent, `~/.claude-scheduler`, and this directory.

## Dev

```bash
npm test                                  # sandboxed (tmp CS_DATA, fake spawns)
CS_DATA=$(mktemp -d) CS_PORT=18741 node server.js   # dev server
npm run screenshots                       # capture the whole UI to a versioned folder
```

Env: `CS_PORT` (default 9099), `CS_DATA` (default `~/.claude-scheduler`), `CS_NO_NOTIFY=1` (suppress banners).

### UI screenshots

`npm run screenshots` writes every screen and dialog to
`working_prototype_screenshots/v<N>/` (next free `N`) plus a generated `INDEX.md`, for
before/after comparison across a UI overhaul. Needs Chrome (or `CHROME_PATH`) and node 22+;
no npm dependencies. Takes ~3 min, most of it seeding.

It boots its own scheduler on a free port against a throwaway `CS_DATA`, so
`~/.claude-scheduler` is never touched. `claudePath` is pre-seeded to a fake binary, so the
usage meters read fixed percentages from `tests/fixtures/get-usage-response.json` and **no
real `claude` can run** — a capture spends no API quota. Only `command`-type jobs are
executed; `claude` jobs are created disabled and never fired, and no project is ever
activated.

```bash
npm run screenshots -- --label v2      # explicit folder name
npm run screenshots -- --only history  # just the matching shots
npm run screenshots -- --headful       # watch it drive a real window
npm run screenshots -- --keep          # leave the sandbox up to poke at
```

Every DOM selector lives in [`tools/screenshots/shots.mjs`](tools/screenshots/shots.mjs). After
an overhaul, failed shots are listed with the reason and the run exits non-zero — fix them
there. Add a screen by appending one entry to that file; `INDEX.md` is generated from it.

Future plans: [`docs/plans/2026-07-19-extensions-roadmap.md`](docs/plans/2026-07-19-extensions-roadmap.md) — rich output handlers (syntax highlighting), tmux attach, per-extension config, more agent extensions.
