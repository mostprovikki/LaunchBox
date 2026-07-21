# Claude Scheduler Implementation Plan

> Spec: `docs/specs/2026-07-17-claude-scheduler-design.md` (authoritative). Executed inline in-session, TDD per task, commit per task.

**Goal:** Local web UI (127.0.0.1:9099) to schedule cron/one-shot jobs that run headless `claude -p` or shell commands via a launchd-kept-alive Node daemon.

**Stack:** Node >=20, ESM, express + croner + better-sqlite3, vanilla SPA, node:test.

## Global constraints

- Bind 127.0.0.1 only. Port `CS_PORT` || 9099.
- Data in `CS_DATA` || `~/.claude-scheduler` (`scheduler.db`, `logs/`, `daemon.log`).
- Deps: express, croner, better-sqlite3 only.
- Tests sandboxed: `CS_DATA` tmpdir, `CS_NO_NOTIFY=1`, listen on port 0, injected fake spawn/notify. Time-scaled via runner `minuteMs` option.

## Tasks

### 1. Scaffold + paths
Create: `package.json` (type module, scripts start/test), `.gitignore` (node_modules), `lib/paths.js`, `tests/paths.test.js`.
Produces: `dataDir()`, `logsDir()`, `dbPath()`, `ensureDirs()` — env read at call time.

### 2. db
Create: `lib/db.js`, `tests/db.test.js`.
Schema per spec (jobs, runs, settings; retry as retryCount/retryDelayMin cols; schedule/progress JSON text).
Produces: `openDb(path)`, `createJob(db,job)`, `listJobs(db)`, `getJob(db,id)`, `updateJob(db,id,patch)`, `deleteJob(db,id)` (cascades runs, returns logPaths), `insertRun(db,{jobId,status,trigger})`, `updateRun(db,id,patch)`, `getRun(db,id)`, `listRuns(db,{jobId,status,limit})`, `lastRun(db,jobId)`, `pruneRuns(db,jobId,keep=50)`→logPaths (finished only), `failOrphanRuns(db)`, `getSetting(db,key,dflt)`, `setSetting(db,key,val)`, `cleanupAll(db)`→logPaths. Rows returned parsed (schedule/progress objects, enabled bool).

### 3. validate + preview
Create: `lib/validate.js`, `tests/validate.test.js`.
Produces: `splitArgs(str)` (quote-aware tokenizer), `validateJob(payload)`→`{ok,job}|{ok:false,errors}` (defaults + enums + cwd-exists + cron-valid + once-in-future per spec), `previewSchedule(schedule,n=3)`→ISO[].

### 4. formatter
Create: `lib/formatter.js`, `tests/formatter.test.js` (canned NDJSON fixtures).
Produces: `createFormatter({onLine,onProgress,onSession})`→`{write(chunk),flush()}`. init→session id; assistant text/tool_use→readable lines + progress {activity,toolCalls}; result→summary line + turns. Non-JSON lines pass through.

### 5. notify + runner
Create: `lib/notify.js`, `lib/runner.js`, `tests/runner.test.js`.
notify: `notify(title,msg)` osascript (skip if CS_NO_NOTIFY), `shouldNotify(setting,status)`.
runner: `createRunner({db,spawnFn,notifyFn,minuteMs})`→`{start(job,trigger),events,runningCount(),killAll()}`. Overlap skip; claude concurrency queue (maxConcurrent setting, FIFO); spawn claude (stream-json+formatter) / command (`/bin/zsh -lc`); log stream `logs/<runId>.log`; timeout SIGTERM→+10s SIGKILL; retry on fail/timeout up to retryCount after retryDelayMin; prune after finish; events `line:<id>`/`progress:<id>`/`done:<id>`/`change`.

### 6. scheduler
Create: `lib/scheduler.js`, `tests/scheduler.test.js`.
Produces: `createScheduler({db,runner})`→`{start,stop,reload(id),nextFire(id)}`. croner per enabled job; 6-field cron ok; once→date trigger + auto-disable on fire; pause-all via settings `paused`.

### 7. API server
Create: `server.js`, `lib/uninstall.js`, `tests/api.test.js`.
`createApp({db,runner,scheduler,execFileFn,uninstallFn})` + `main()` boot (ensureDirs, failOrphanRuns, lazy claudePath resolve via `zsh -lc command -v claude`, listen 127.0.0.1). Routes per spec: jobs CRUD (+nextFire,lastRun decoration), run-now, runs list/log/tail(SSE)/resume, schedule/preview, settings, cleanup, uninstall. static public/.
uninstall.js: `startUninstall({runner,server,spawnFn,exitFn})` — temp detached zsh script: bootout, rm plist, rm data, rm tool dir.

### 8. UI
Create: `public/index.html`, `public/style.css`, `public/app.js`.
Header running-badge + pause toggle; jobs table (type, schedule text, next fire, last status, spinner, toggle/run/edit/delete); editor dialog (type switch, builder presets + raw cron + next-3 preview, claude opts); history + log viewer + SSE live tail + resume button; settings + danger zone (typed confirms). Poll 3s.

### 9. install/uninstall + README + smoke
Create: `install.sh`, `uninstall.sh`, `README.md`.
plist RunAtLoad+KeepAlive, node abs path, daemon.log. Manual smoke: install, create job, watch run, resume, cleanup.
