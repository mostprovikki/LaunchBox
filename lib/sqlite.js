// The one place that knows which SQLite driver we use. node:sqlite is built in,
// so there is no native addon to rebuild after a Node upgrade or to trip macOS
// Gatekeeper (ERR_DLOPEN_FAILED) — the reason better-sqlite3 was dropped (M6).
// It differs from better-sqlite3 in three ways lib/db.js relies on; this adapter
// restores them so the data layer did not have to change:
//   1. extra keys in a named-parameter object are ignored (db.js spreads rows);
//   2. undefined binds as NULL;
//   3. rows come back as plain objects, not null-prototype ones.
import { DatabaseSync } from 'node:sqlite';

const nul = (v) => (v === undefined ? null : v);

function normalise(params) {
  if (params.length === 1 && params[0] && typeof params[0] === 'object'
    && !Array.isArray(params[0]) && !Buffer.isBuffer(params[0])) {
    const o = {};
    for (const [k, v] of Object.entries(params[0])) o[k] = nul(v);
    return [o];
  }
  return params.map(nul);
}

const plain = (row) => (row === undefined ? undefined : { ...row });

export function openSqlite(path) {
  const db = new DatabaseSync(path, { allowUnknownNamedParameters: true });
  return {
    prepare(sql) {
      const st = db.prepare(sql);
      return {
        run: (...p) => st.run(...normalise(p)),
        get: (...p) => plain(st.get(...normalise(p))),
        all: (...p) => st.all(...normalise(p)).map(plain),
      };
    },
    exec: (sql) => db.exec(sql),
    pragma: (stmt) => db.prepare(`PRAGMA ${stmt}`).all().map(plain),
    close: () => db.close(),
  };
}
