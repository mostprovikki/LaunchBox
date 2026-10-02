import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureInstall } from './helpers.js';
import { planMigration } from '../lib/migrate.js';

const dead = async () => false;

test('a quiet pre-M6 install is ready, with per-column row counts', async () => {
  const { oldDir, newDir } = fixtureInstall();
  const plan = await planMigration({ oldDir, newDir, portAlive: dead });
  assert.equal(plan.state, 'ready');
  assert.deepEqual(plan.refusals, []);
  assert.equal(plan.strayEmptyDb, true);
  const n = Object.fromEntries(plan.rewrites.map((r) => [`${r.table}.${r.column}`, r.rows]));
  assert.deepEqual(n, { 'runs.logPath': 1, 'jobs.cwd': 1, 'jobs.params': 1, 'runs.meta': 1, 'settings.value': 1 });
});

for (const [name, setup, re] of [
  ['the daemon answers on its port', (f) => ({ ...f, portAlive: async () => true }), /daemon is running/],
  ['a run is live', () => ({ ...fixtureInstall({ live: { run: true } }), portAlive: dead }), /running or queued/],
  ['a lease is held', () => ({ ...fixtureInstall({ live: { lease: true } }), portAlive: dead }), /lease/],
  ['a worktree is checked out', () => ({ ...fixtureInstall({ live: { worktree: true } }), portAlive: dead }), /worktree/],
  ['the target exists and is not empty', (f) => { mkdirSync(f.newDir); writeFileSync(join(f.newDir, 'x'), '1'); return { ...f, portAlive: dead }; }, /already exists/],
  ['a non-empty launchbox.db sits in the old dir', (f) => { writeFileSync(join(f.oldDir, 'launchbox.db'), 'data'); return { ...f, portAlive: dead }; }, /launchbox\.db/],
]) {
  test(`refuses when ${name}`, async () => {
    const args = setup(fixtureInstall());
    const plan = await planMigration(args);
    assert.equal(plan.state, 'refused');
    assert.ok(plan.refusals.some((r) => re.test(r)), plan.refusals.join(' | '));
  });
}

test('an already-migrated install (old path is a symlink to the new) reports already', async () => {
  const { root, newDir } = fixtureInstall();
  const oldLink = join(root, 'linked');
  mkdirSync(newDir); symlinkSync(newDir, oldLink);
  assert.equal((await planMigration({ oldDir: oldLink, newDir, portAlive: dead })).state, 'already');
});
