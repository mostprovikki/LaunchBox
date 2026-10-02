import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { nonEmptyFile } from './paths.js';

// A pre-M6 install whose data has not moved yet. Starting would open an empty
// launchbox.db and silently look like a fresh install with no jobs or history.
// Keyed on the databases, not the dirs: `launchbox url|token|open` and install.sh
// create the new dir (logs/ + token) without making it an install.
export function legacyInstallBlocks({ legacy, current, explicit }) {
  if (explicit || !existsSync(join(legacy, 'scheduler.db')) || nonEmptyFile(join(current, 'launchbox.db'))) return null;
  return `LaunchBox found a pre-rename install at ${legacy} and none at ${current}.\n`
    + 'Move it first:  launchbox migrate --dry-run   then   launchbox migrate\n'
    + '(from a checkout: node bin/launchbox.mjs migrate ...)';
}
