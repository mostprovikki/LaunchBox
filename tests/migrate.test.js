import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, copyFileSync, existsSync, readdirSync, readFileSync, statSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fixtureInstall } from './helpers.js';
import { openDb } from '../lib/db.js';
import { planMigration, applyMigration } from '../lib/migrate.js';

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

// F1: a Ctrl-C mid-run leaves these three behind; each refusal must name the way out.
for (const [name, live] of [['a run is live', { run: true }], ['a lease is held', { lease: true }], ['a worktree is checked out', { worktree: true }]]) {
  test(`the refusal when ${name} names the recovery command`, async () => {
    const f = fixtureInstall({ live });
    const plan = await planMigration({ ...f, portAlive: dead });
    assert.equal(plan.state, 'refused');
    const r = plan.refusals.find((x) => /running or queued|lease|worktree/.test(x));
    assert.ok(r, plan.refusals.join(' | '));
    assert.ok(r.includes(`LB_DATA=${f.oldDir} npm start`), r);
    assert.match(r, /wait until idle.*stop it.*run migrate again/s);
  });
}

// F2: `launchbox url` / install.sh before migrate leaves ~/.launchbox with logs/ + token.
test('the target-not-empty refusal lists what is there and when it is safe to delete', async () => {
  const f = fixtureInstall();
  mkdirSync(join(f.newDir, 'logs'), { recursive: true });
  writeFileSync(join(f.newDir, 'token'), 't');
  const plan = await planMigration({ ...f, portAlive: dead });
  const r = plan.refusals.find((x) => /already exists/.test(x));
  assert.ok(r, plan.refusals.join(' | '));
  assert.match(r, /contains: logs\/, token/);
  assert.match(r, /only an empty logs\/ and a token.*delete/s);
});

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

// -wal/-shm are skipped: SQLite creates them on any read-only open of a WAL db (planMigration's), content untouched.
const hashTree = (dir) => {
  const h = createHash('sha256');
  for (const n of readdirSync(dir, { recursive: true }).sort()) {
    if (/-(wal|shm)$/.test(n)) continue;
    const p = join(dir, n);
    if (lstatSync(p).isFile()) h.update(n).update(readFileSync(p));
  }
  return h.digest('hex');
};
const okRepair = async (path) => ({ ok: true, path });

test('apply moves the install, rewrites exactly the old-dir paths, leaves sessions alone', async () => {
  const { root, oldDir, newDir } = fixtureInstall();
  const res = await applyMigration({ oldDir, newDir, portAlive: dead, projectPaths: ['/p'], gitRepair: okRepair });
  assert.equal(res.state, 'migrated');
  assert.ok(lstatSync(oldDir).isSymbolicLink());
  assert.ok(existsSync(join(newDir, 'launchbox.db')));
  assert.ok(existsSync(join(newDir, 'scheduler.db.pre-m6.bak')));
  const db = openDb(join(newDir, 'launchbox.db'));
  const r1 = db.prepare(`SELECT logPath, meta FROM runs WHERE id='r1'`).get();
  assert.equal(r1.logPath, `${newDir}/logs/r1.log`);
  assert.equal(JSON.parse(r1.meta).wt, `${newDir}/worktrees/p--b1`);
  assert.equal(db.prepare(`SELECT logPath FROM runs WHERE id='r2'`).get().logPath, `${root}/.claude-scheduler-old/r2.log`);
  assert.equal(db.prepare(`SELECT cwd FROM jobs WHERE id='j1'`).get().cwd, `${newDir}/worktrees/p--b1`);
  assert.equal(JSON.parse(db.prepare(`SELECT params FROM jobs`).get().params).logDir, `${newDir}/logs`);
  assert.equal(db.prepare(`SELECT value FROM settings WHERE key='worktreeRoot'`).get().value, `${newDir}/worktrees`);
  assert.equal(db.prepare(`SELECT cwd FROM sessions WHERE id='s1'`).get().cwd, `${oldDir}/worktrees/p--b1`);
  db.close();
  assert.deepEqual(res.repaired, [{ ok: true, path: '/p' }]);
});

test('re-running after success says already and changes nothing', async () => {
  const { oldDir, newDir } = fixtureInstall();
  await applyMigration({ oldDir, newDir, portAlive: dead, projectPaths: [], gitRepair: okRepair });
  const before = hashTree(newDir);
  assert.equal((await applyMigration({ oldDir, newDir, portAlive: dead, projectPaths: [], gitRepair: okRepair })).state, 'already');
  assert.equal(hashTree(newDir), before);
});

for (const faultAt of ['backup', 'rewrite', 'commit', 'move']) {
  test(`a failure at ${faultAt} leaves the old install byte-identical and the new dir absent`, async () => {
    const { oldDir, newDir } = fixtureInstall();
    const before = hashTree(oldDir);
    await assert.rejects(applyMigration({ oldDir, newDir, portAlive: dead, projectPaths: [], gitRepair: okRepair, faultAt }));
    assert.equal(existsSync(newDir), false);
    assert.equal(lstatSync(oldDir).isSymbolicLink(), false);
    const after = hashTree(oldDir);
    if (faultAt === 'backup') assert.equal(after, before);
    else {
      // A completed backup file is the only allowed difference.
      const db = openDb(join(oldDir, 'scheduler.db'));
      assert.equal(db.prepare(`SELECT logPath FROM runs WHERE id='r1'`).get().logPath, `${oldDir}/logs/r1.log`);
      db.close();
    }
  });
}

test('a failed git worktree repair is reported, and the move is not undone', async () => {
  const { oldDir, newDir } = fixtureInstall();
  const res = await applyMigration({ oldDir, newDir, portAlive: dead, projectPaths: ['/gone'],
    gitRepair: async (path) => ({ ok: false, path, error: 'not a git repository' }) });
  assert.equal(res.state, 'migrated');
  assert.deepEqual(res.repaired, [{ ok: false, path: '/gone', error: 'not a git repository' }]);
});
