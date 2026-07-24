# Extensions roadmap (future work)

Status: planned, not started. Context: as of 2026-07-19 the scheduler is extension-based — core is job-type agnostic; `command` and `claude` are extensions under `extensions/`, forms/settings/run-actions are config-driven, keep-awake (caffeinate) shipped. This doc collects the next layer of extension capabilities.

> **Updated 2026-07-25.** Still live, but several items are now claimed by the LaunchBox v2 plans — see [`specs/2026-07-25-launchbox-design.md`](../specs/2026-07-25-launchbox-design.md). Mapping:
>
> | Item here | Now covered by |
> |---|---|
> | §2 tmux attach | Partly superseded. [M3 §3.3](2026-07-25-m3-pause-modes.md) adds a **stdin control channel** to the `claude` child (`interrupt`, `set_model`, `set_permission_mode` are all real control-request subtypes in 2.1.206). That is a much lighter path to mid-run steering than tmux, and it lands first. Keep tmux only if a real TTY is still wanted afterwards. |
> | §3 settings namespacing + `claudePath`/`maxConcurrent` migration | Prerequisite for the new settings added by M1–M4. New keys ship prefixed from the start; the legacy migration stays owned here. |
> | §5 per-extension run-history columns (cost for claude) | [M1 §3](2026-07-25-m1-usage-foundation.md) (`run_usage` percent deltas) and [M5 §5.4](2026-07-25-m5-sessions-dashboard.md) (deduped tokens per session, grouped by job). Note the measured **2.5× token inflation** — dedupe on `message.id` or any cost column will be wrong. |
> | §5 wake-from-sleep (`pmset schedule wake`) | Raised in priority by [M2 §2.4](2026-07-25-m2-usage-aware-scheduling.md): reset-anchored fires are the first feature where a missed 3 a.m. fire actually loses paid capacity. caffeinate-only remains the shipped mitigation. |
>
> Unaffected and still wanted as written: §1 (rich output rendering), §4 (more agent extensions), §5 hot-reload and `doctor()`.

## 1. Output handlers → rich log rendering

Today `createOutputHandler` shapes plaintext lines. Extend to declared render hints so the UI can syntax-highlight:

- Manifest gains `output: { language?: 'ansi'|'json'|'diff'|…, render?: 'text'|'markdown'|'html' }`, or per-line hints via `onLine(text, {kind})` (`kind: tool|text|result|stderr`).
- UI: colorize per line-kind (claude: tool lines dim, result lines bold); optional markdown rendering for assistant text; ANSI escape support for `command` jobs (many CLIs emit color).
- Keep the log file plaintext — render hints are display-only metadata in a sidecar or line prefix, so `tail -f`/`grep` on log files stays clean.
- Candidate impl: tiny client-side highlighter (no build step) keyed by `kind`, not a full grammar lib.

## 2. tmux capability — attach a run to a terminal

Goal: watch/steer a live run in a real terminal, not just the log drawer.

- Extension opt-in: `tmux: true` → runner spawns the child inside `tmux new-session -d -s cs-<runId>` (or a shared `cs` session with one window per run) instead of a bare pipe.
- Log streaming still works via `tmux pipe-pane` to the run's log file.
- Run action (core-provided when tmux enabled): "Attach in Terminal" → osascript opens Terminal running `tmux attach -t cs-<runId>`.
- For claude jobs this enables mid-run interaction (answer a permission prompt, nudge the agent).
- Open questions: tmux availability check at boot (settings warning if missing); cleanup of dead sessions; kill semantics (`tmux kill-session` vs SIGTERM to pane pid).

## 3. Per-extension config beyond flat settings

`ext.settings` today is a flat key list stored in the shared settings table. Next:

- Namespacing enforced by the loader (auto-prefix `<extId>:` unless key marked `legacy`), migration for claude's `claudePath`/`maxConcurrent`.
- Config schema per extension: nested objects, secrets (keychain-backed, never in sqlite plaintext), per-job overrides of extension settings.
- Extension-owned config files: allow `extensions/<id>/config.json` defaults shipped with the extension, overridden by DB values.

## 4. More agent extensions

The point of the platform — clone `_template` and wire other agents:

- `codex/`, `gemini/`, `opencode/` etc.: same shape as claude (prompt field, binary path setting, output handler parsing their stream format, resume action where the CLI supports it).
- Generic `webhook/` extension: POST a URL on schedule (fields: url, method, body; no child process — needs a small runner hook to support non-spawn extensions, e.g. `run(job, ctx)` alternative to `command()`).

## 5. Misc

- Wake-from-sleep scheduling: `pmset schedule wake` before next fire (needs sudo — investigate helper or accept caffeinate-only).
- Extension health: `doctor()` hook surfacing binary-missing/misconfig warnings as a banner.
- Hot-reload extensions without daemon restart (fs watch on `extensions/`).
- Per-extension run-history columns (e.g. cost for claude) via `meta` → declared list columns in manifest.
