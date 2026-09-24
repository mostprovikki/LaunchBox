// tests/skills.test.js
// The skills are product surface (CLAUDE.md: "part of the claude-scheduler suite"), so they
// are versioned here and linted here. Two things rot silently in a SKILL.md: a bd flag that
// no longer exists (the CLI moves fast — see ~/.claude/docs/beads-task-tracking.md), and a
// description too vague to trigger. Both are caught here, not in someone's session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(ROOT, 'skills');
export const EXPECTED_SKILLS = ['bead-authoring', 'registered-repo-session', 'scheduled-bead-run'];

// Verified against `bd --help` output on 2026-09-24. Add here only after running the
// command and reading the resulting state (memory: verify-inferred-cli-semantics).
export const VERIFIED_BD_FLAGS = new Set([
  '--claim', '--add-label', '--remove-label', '--design', '--design-file', '--append-notes', '--notes',
  '--defer', '--parent', '--json', '--status', '--all', '--label', '-l', '-C', '--until',
  '--title', '--description', '--type', '--priority', '--reason', '--suggest-next', '--assignee',
]);

const skillDirs = () => existsSync(SKILLS)
  ? readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];

function frontmatter(src) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(src);
  assert.ok(m, 'SKILL.md must start with YAML frontmatter');
  const fm = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return fm;
}

test('the three skills exist, by name', () => {
  assert.deepEqual(skillDirs().sort(), [...EXPECTED_SKILLS].sort());
});

for (const name of EXPECTED_SKILLS) {
  test(`${name}: frontmatter names itself and has a trigger-worthy description`, () => {
    const src = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
    const fm = frontmatter(src);
    assert.equal(fm.name, name);
    assert.ok((fm.description ?? '').length >= 80, 'description must say WHEN to use it, not just what it is');
    assert.match(fm.description, /Use when|use when|Load when/, 'description must carry a "Use when" clause');
  });

  test(`${name}: every bd flag it mentions is one we verified`, () => {
    const src = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
    const seen = new Set();
    for (const m of src.matchAll(/\bbd\b[^\n`]*/g)) {
      for (const f of m[0].matchAll(/(?<=\s)(--?[a-z][a-z-]*)/g)) seen.add(f[1]);
    }
    const unknown = [...seen].filter((f) => !VERIFIED_BD_FLAGS.has(f));
    assert.deepEqual(unknown, [], `unverified bd flags in ${name}: ${unknown.join(' ')}`);
  });

  test(`${name}: never activates a project`, () => {
    const src = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
    // Any instruction to set a project active is the one thing a skill must not carry.
    assert.doesNotMatch(src, /state['"]?\s*:\s*['"]active|--state[= ]active|activate the project for/i);
  });
}
