#!/usr/bin/env node
// Temp-dir leak gate (claude-scheduler-6o4). `npm test` runs through this.
//
// Runs the suite with TMPDIR/TMP/TEMP pointed at a fresh empty dir, then fails
// naming every entry left behind. A private dir, not a count of the shared
// $TMPDIR: concurrent suites and worktrees would make a count flaky.
// The suite's own exit code wins — a red suite is never reported green.
//
//   node tools/check-tmp-leaks.mjs [test files...]   (default: tests/*.test.js)

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const files = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), 'cs-leakgate-'));
let code;
try {
  const r = spawnSync(process.execPath, ['--test', ...(files.length ? files : ['tests/*.test.js'])], {
    stdio: 'inherit',
    env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir },
  });
  code = r.status ?? 1;
  if (r.error) { console.error(`leak gate: could not run suite: ${r.error.message}`); code = 1; }

  const left = readdirSync(dir).sort();
  if (left.length) {
    console.error(`\nleak gate: FAILED — ${left.length} temp entr${left.length === 1 ? 'y' : 'ies'} left in TMPDIR by the suite:`);
    for (const e of left) console.error(`  ${e}`);
    console.error('Remove each mkdtemp in an after()/t.after()/finally (rmSync recursive+force).');
    if (code === 0) code = 1;
  } else {
    console.error('\nleak gate: no temp entries left behind');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
