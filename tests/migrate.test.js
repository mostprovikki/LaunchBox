import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, copyFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fixtureInstall } from './helpers.js';
import { openDb } from '../lib/db.js';
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

for (const [name, live, tweak, re] of [
  ['the daemon answers on its port', {}, (f) => { f.portAlive = async () => true; }, /daemon is running/],
  ['a run is live', { run: true }, () => {}, /running or queued/],
  ['a lease is held', { lease: true }, () => {}, /lease/],
  ['a worktree is checked out', { worktree: true }, () => {}, /worktree/],
  ['the target exists and is not empty', {}, (f) => { mkdirSync(f.newDir); writeFileSync(join(f.newDir, 'x'), '1'); }, /already exists/],
  ['a non-empty launchbox.db sits in the old dir', {}, (f) => { writeFileSync(join(f.oldDir, 'launchbox.db'), 'data'); }, /launchbox\.db/],
]) {
  test(`refuses when ${name}`, async () => {
    const f = { ...fixtureInstall({ live }), portAlive: dead };
    tweak(f);
    const plan = await planMigration(f);
    assert.equal(plan.state, 'refused');
    assert.ok(plan.refusals.some((r) => re.test(r)), plan.refusals.join(' | '));
  });
}

test('a missing old dir reports nothing', async () => {
  const { root, newDir } = fixtureInstall();
  const plan = await planMigration({ oldDir: join(root, 'absent'), newDir, portAlive: dead });
  assert.equal(plan.state, 'nothing');
});

// -shm is SQLite's rebuildable wal-index: any open, even read-only, rewrites it. Its
// presence is checked via the file list; its bytes are not data.
const snapshot = (dir) => Object.fromEntries(readdirSync(dir, { recursive: true })
  .filter((e) => statSync(join(dir, e)).isFile())
  .map((e) => [e, e.endsWith('-shm') ? 'shm' : createHash('sha256').update(readFileSync(join(dir, e))).digest('hex')]));

test('planning is read-only: a crashed daemon\'s -wal/-shm survive, and the WAL-only row is counted', async () => {
  const { root, newDir } = fixtureInstall();
  const oldDir = join(root, 'crashed');
  mkdirSync(oldDir);
  // Hold a writer open so -wal/-shm exist with an un-checkpointed row, copy the three
  // files aside as a crash would leave them, then let the writer go.
  const src = fixtureInstall();
  const w = openDb(join(src.oldDir, 'scheduler.db'));
  w.prepare(`INSERT INTO settings (key,value) VALUES ('extra',?)`).run(`${oldDir}/x`);
  for (const ext of ['', '-wal', '-shm']) copyFileSync(join(src.oldDir, `scheduler.db${ext}`), join(oldDir, `scheduler.db${ext}`));
  w.close();
  assert.ok(existsSync(join(oldDir, 'scheduler.db-wal')) && existsSync(join(oldDir, 'scheduler.db-shm')));
  const before = snapshot(oldDir);
  const plan = await planMigration({ oldDir, newDir, portAlive: dead });
  assert.deepEqual(snapshot(oldDir), before);
  assert.equal(plan.rewrites.find((r) => r.table === 'settings').rows, 1);
});

test('an already-migrated install (old path is a symlink to the new) reports already', async () => {
  const { root, newDir } = fixtureInstall();
  const oldLink = join(root, 'linked');
  mkdirSync(newDir); symlinkSync(newDir, oldLink);
  assert.equal((await planMigration({ oldDir: oldLink, newDir, portAlive: dead })).state, 'already');
});
