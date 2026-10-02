import { existsSync } from 'node:fs';

// A pre-M6 install whose data has not moved yet. Starting would create an empty
// ~/.launchbox and silently look like a fresh install with no jobs or history.
export function legacyInstallBlocks({ legacy, current, explicit }) {
  if (explicit || existsSync(current) || !existsSync(legacy)) return null;
  return `LaunchBox found a pre-rename install at ${legacy} and none at ${current}.\n`
    + 'Move it first:  launchbox migrate --dry-run   then   launchbox migrate\n'
    + '(from a checkout: node bin/launchbox.mjs migrate ...)';
}
