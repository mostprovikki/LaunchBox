// M6: the product is LaunchBox. "claude-scheduler" may survive only as
//   (a) a bead id, claude-scheduler-<3–4 char id>[.n];
//   (b) the legacy names in the files below, which exist to read old installs;
//   (c) docs/, history, and this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SCAN = ['lib', 'bin', 'public', 'tools', 'extensions', 'helper', 'skills', 'server.js', 'install.sh', 'uninstall.sh', 'package.json'];
// Files allowed to name the old product, only on lines that say why (regex below).
const LEGACY_OK = new Set(['lib/paths.js', 'lib/beads.js', 'lib/migrate.js', 'lib/uninstall.js', 'uninstall.sh', 'skills/registered-repo-session/SKILL.md']);
const SKIP_DIR = new Set(['node_modules', 'vendor', 'fixtures']);
const OFFENDER = /claude-scheduler(?!-[a-z0-9]{2,4}(?:\.\d+)?\b)/g;

function* files(p) {
  let st;
  try { st = statSync(p); } catch { return; }
  if (st.isFile()) { yield p; return; }
  for (const n of readdirSync(p)) if (!SKIP_DIR.has(n)) yield* files(join(p, n));
}

export function offenders() {
  const out = [];
  for (const top of SCAN) {
    for (const f of files(join(ROOT, top))) {
      const rel = relative(ROOT, f);
      if (!/\.(m?js|sh|json|swift|md|html|css)$/.test(rel)) continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (!line.match(OFFENDER)) return;
        if (LEGACY_OK.has(rel) && /legacy|pre-M6|SCHEDULER_ACTORS|\.claude-scheduler/.test(line)) return;
        out.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  return out;
}

test('no product identifier still says claude-scheduler', () => {
  assert.deepEqual(offenders(), []);
});
