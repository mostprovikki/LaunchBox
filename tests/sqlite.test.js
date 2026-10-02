import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpDir } from './helpers.js';
import { openSqlite } from '../lib/sqlite.js';

function fresh() {
  const db = openSqlite(join(tmpDir(), 't.db'));
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b INTEGER)');
  return db;
}

test('extra keys in a named-parameter object are ignored, as better-sqlite3 did', () => {
  const db = fresh();
  const r = db.prepare('INSERT INTO t (a, b) VALUES (@a, @b)').run({ a: 'x', b: 1, notAColumn: 2 });
  assert.deepEqual(r, { changes: 1, lastInsertRowid: 1 });
});

test('undefined binds as NULL, named and positional', () => {
  const db = fresh();
  db.prepare('INSERT INTO t (a, b) VALUES (@a, @b)').run({ a: undefined, b: 1 });
  db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(undefined, 2);
  assert.deepEqual(db.prepare('SELECT a FROM t ORDER BY id').all(), [{ a: null }, { a: null }]);
});

test('rows are plain objects, so deepStrictEqual against a literal holds', () => {
  const db = fresh();
  db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run('x', 1);
  const row = db.prepare('SELECT * FROM t').get();
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.deepStrictEqual(row, { id: 1, a: 'x', b: 1 });
  assert.equal(db.prepare('SELECT * FROM t WHERE id = 99').get(), undefined);
});

test('pragma() returns rows for a query pragma and runs a setting pragma', () => {
  const db = fresh();
  assert.deepEqual(db.pragma('table_info(t)').map((c) => c.name), ['id', 'a', 'b']);
  db.pragma('journal_mode = WAL');
  assert.equal(db.pragma('journal_mode')[0].journal_mode, 'wal');
});

test('a readOnly handle reads but rejects a write', () => {
  const path = join(tmpDir(), 'ro.db');
  const w = openSqlite(path);
  w.exec('CREATE TABLE t (a)'); w.prepare('INSERT INTO t VALUES (1)').run(); w.close();
  const ro = openSqlite(path, { readOnly: true });
  assert.equal(ro.prepare('SELECT COUNT(*) n FROM t').get().n, 1);
  assert.throws(() => ro.prepare('INSERT INTO t VALUES (2)').run(), /readonly/i);
  ro.close();
});
