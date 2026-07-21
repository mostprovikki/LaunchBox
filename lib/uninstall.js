import { spawn } from 'node:child_process';
import { writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './paths.js';

export const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PLIST = 'com.claude-scheduler';

export function removalScript({ toolDir = TOOL_DIR, data = dataDir() } = {}) {
  // Removes the daemon (launchd agent) and all schedules/data ONLY.
  // The source tree is intentionally left in place — deleting the tool dir
  // here is what destroyed the app before. We print it for manual removal.
  return `#!/bin/zsh
# claude-scheduler uninstall — stops daemon, removes schedules/data. Keeps source.
sleep 1
launchctl bootout gui/$(id -u)/${PLIST} 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/${PLIST}.plist"
rm -rf ${JSON.stringify(data)}
echo "claude-scheduler uninstalled: daemon stopped, schedules and data removed."
echo "Source code left at ${toolDir}"
echo "To delete the source too, remove that directory manually."
`;
}

// Kicks off removal: writes the script to a temp path (so it runs independently
// of this process), spawns it detached, then shuts this daemon down.
export function startUninstall({ runner, server, spawnFn = spawn, exitFn = process.exit, toolDir, data } = {}) {
  const script = join(tmpdir(), `claude-scheduler-uninstall-${Date.now()}.sh`);
  writeFileSync(script, removalScript({ toolDir, data }));
  chmodSync(script, 0o755);
  const child = spawnFn('/bin/zsh', [script], { detached: true, stdio: 'ignore' });
  child.unref?.();
  setTimeout(() => {
    try { runner?.killAll(); } catch {}
    try { server?.close(); } catch {}
    exitFn(0);
  }, 300);
  return script;
}
