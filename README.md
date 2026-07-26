# Claude Scheduler

Local web UI to schedule cron jobs and one-shot tasks — on time, without the UI open. macOS only.

At its core it's a friendly frontend for cron-style jobs. Job *types* are pluggable **extensions**: shell commands (`command`) and headless Claude Code runs (`claude`) ship built-in, and you can add your own agent/type by cloning a folder — see [`extensions/README.md`](extensions/README.md).

## Install

```bash
./install.sh
```

Installs deps, builds the approval helper, writes
`~/Library/LaunchAgents/com.claude-scheduler.plist` (RunAtLoad + KeepAlive) and starts the daemon.

**Open the UI with the CLI, not a bookmark:**

```bash
node bin/claude-scheduler.mjs open      # or: claude-scheduler open, if npm-linked
```

That prints a one-time URL carrying your session key and opens it. Visiting
`http://127.0.0.1:9099` directly shows a banner explaining that it has no key — which is the
point.

Data lives in `~/.claude-scheduler/` (sqlite db, per-run logs, daemon.log, `token`, `bin/`). The
`claude` binary path is auto-detected at first boot; fix it in Settings if needed.

## Security

Creating a job here means **arbitrary code execution on your Mac, on a schedule, under a trusted
parent process**. That is the thing being protected, and binding to `127.0.0.1` does not protect
it — a web page you visit can still make your browser send requests to your own machine. This was
measured, not assumed: before these guards, one cross-origin form-style `POST` to `/api/cleanup`
returned `200` and deleted every job in the database.

Four layers, smallest first:

1. **Loopback bind.** Nothing on your network can reach the port. Verified: a connection to this
   machine's LAN address is refused.
2. **Loopback-only `Host`/`Origin`.** Defeats DNS rebinding, the trick that turns a read-only
   endpoint into data exfiltration on a hostile network.
3. **`Content-Type: application/json` on every mutating method.** A cross-origin HTML form cannot
   set that header, and a cross-origin `fetch` that does becomes preflighted — which is never
   answered. Note that checking the *body* would not work: the destructive routes take no body.
4. **A capability token** (`~/.claude-scheduler/token`, mode `0600`) required on every `/api`
   route, reads included. This is what holds if a header check ever regresses, what shuts out a
   browser extension, and what protects you if the port is ever exposed by accident — a container
   forward, an `ssh -R`, a VPN misconfig.

On top of that, six **high-power actions** additionally require Touch ID or your login password:
creating or editing a job, activating a project, `POST /api/cleanup`, `POST /api/uninstall`, and
**any change to `claudePath` or `bdPath`** — those name executables, so repointing one would make
every existing job run a different binary without creating a job at all. Approving one job opens a
5-minute window for further job edits; cleanup, uninstall, activation and the executable settings
never ride that window, because a grace window is also an attack window.

What this deliberately does **not** defend against: code already running as you. Such code can run
your command directly instead of asking the scheduler to schedule it, so gating the API buys little
there. The approval layer exists for the narrower cases where it does help — macOS grants
permissions per *application*, so a job run through this daemon inherits its TCC grants, and a job
scheduled here persists without the LaunchAgent that monitoring tools watch for.

Details, including the measurements behind each decision:
[`docs/specs/2026-07-26-local-api-auth-design.md`](docs/specs/2026-07-26-local-api-auth-design.md).

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
