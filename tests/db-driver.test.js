import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './helpers.js';
import { openDb, listJobs, getSetting } from '../lib/db.js';

test('a database written by better-sqlite3 opens and reads under node:sqlite', () => {
  const path = join(tmpDir(), 'old.db');
  copyFileSync(new URL('./fixtures/m6-better-sqlite3.db', import.meta.url), path);
  const db = openDb(path);
  assert.equal(listJobs(db).length, 1);
  assert.equal(listJobs(db)[0].name, 'fixture');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 1);
  assert.equal(getSetting(db, 'worktreeRoot', null), '/tmp/wt');
  db.close();
});

test('better-sqlite3 is gone from the dependency graph', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies?.['better-sqlite3'], undefined);
  // node:sqlite needs a flag before 22.13; allowUnknownNamedParameters/readOnly came later.
  assert.equal(pkg.engines.node, '>=24');
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.packages[''].engines.node, '>=24');
});

test('a fresh database is opened in WAL mode', () => {
  const db = openDb(join(tmpDir(), 'fresh.db'));
  assert.equal(db.pragma('journal_mode')[0].journal_mode, 'wal');
  db.close();
});
