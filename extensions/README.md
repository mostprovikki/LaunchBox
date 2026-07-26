# Extensions

The scheduler core is job-type agnostic: it stores jobs, fires schedules, spawns processes, streams logs. **What** a job runs is defined by an extension. `command/` (shell commands) and `claude/` (headless Claude Code) are both plain extensions — nothing about them is special-cased in the core.

## Add your own

```bash
cp -r extensions/_template extensions/my-agent   # '_'-prefixed dirs are ignored; the copy is live
$EDITOR extensions/my-agent/index.js             # set id, fields, command()
# restart the daemon
```

That's it. The UI picks it up automatically: a type button in the job dialog, form fields rendered from your `fields` config, settings from `settings`, run-action buttons in the log drawer.

## Anatomy (`index.js` default export)

| Key | Req | Purpose |
|---|---|---|
| `id` | ✓ | Stored in `job.type`. Don't change after jobs exist. |
| `name`, `icon`, `description` |  | UI labels. `icon` is any unicode glyph. |
| `iconName` |  | An icon from `public/icons.js` (`terminal`, `claude`) — preferred over `icon`, which stays as the fallback. An unknown name falls back to the glyph rather than rendering nothing, so naming an icon a future version ships is safe. |
| `fields` | ✓ | Job form config. Values land in `job.params`, validated server-side. `advanced: true` → collapsed section. |
| `command(job, {setting})` | ✓ | Return `{cmd, args, env?}` — the process to spawn (cwd = job's cwd). |
| `settings` |  | Extension-scoped settings (Settings tab). Prefix keys with your id (`my-agent:binPath`) to avoid collisions. |
| `concurrency` |  | `{settingKey, default}` — cap simultaneous runs of this type; extras queue FIFO. |
| `createOutputHandler({onLine, onProgress, onMeta})` |  | Parse child stdout: `onLine` → log, `onProgress({text})` → live UI, `onMeta({...})` → persisted to `run.meta`. Omit for raw logging. |
| `runActions` |  | Per-run buttons (log drawer). `requiresRunMeta: 'key'` gates on `run.meta.key`; `exec()` runs server-side. |
| `validate(params)` |  | Extra validation beyond field specs. Return array of error strings. |
| `init({getSetting, setSetting})` |  | One-time boot hook (binary detection etc.). |

Field spec types: `text · textarea · select · number · checkbox` (see `_template/index.js` for all attrs).

The `claude/` extension exercises every hook — use it as the full reference; `command/` is the minimal one.
