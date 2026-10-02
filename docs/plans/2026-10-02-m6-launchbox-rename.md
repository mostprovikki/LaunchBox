# M6 — LaunchBox rename + node:sqlite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `better-sqlite3` with `node:sqlite`, then rename every product identifier from claude-scheduler to LaunchBox, with an explicit `launchbox migrate` that moves the one existing install safely.

**Architecture:** Phase 1 puts a thin compatibility adapter (`lib/sqlite.js`) between `lib/db.js` and `node:sqlite`, so the 600-line data layer is unchanged. Phase 2 renames identifiers behind two small seams: `lib/paths.js` (env vars, data dir, legacy dir) and `lib/beads.js` (actor name + legacy actor). Phase 3 is a two-part `lib/migrate.js`: `planMigration()` is pure and read-only (it backs `--dry-run` and every refusal), and `applyMigration()` runs validate → back up → rewrite → move → repair → symlink.

**Tech Stack:** Node ≥22.5 (`node:sqlite` `DatabaseSync`), `node:test`, zsh install scripts, git worktrees.

**Spec:** `docs/specs/2026-10-02-m6-launchbox-rename-design.md`

## Global Constraints

- `engines.node` = `>=22.5`; no native npm dependencies after Phase 1.
- Package and bin name `launchbox`; data dir `~/.launchbox`; DB file `launchbox.db`; launchd label `com.launchbox`; beads actor `launchbox`.
- Env vars: `LB_<NAME>` first, `CS_<NAME>` as fallback, through one helper (`env()` in `lib/paths.js`).
- Branch prefix `scheduler/` unchanged. Repo folder name unchanged. Bead ids `claude-scheduler-*` unchanged.
- `sessions.*` columns are never rewritten by migrate.
- Tests never touch the real `~/.claude-scheduler` or `~/.launchbox`: every test sets `CS_DATA`/`LB_DATA` via `tests/helpers.js` `tmpData()`/`tmpDir()`, and those dirs are removed on exit (the `npm test` leak gate fails otherwise).
- Every new test is mutation-checked: break the code, watch it go red, restore, and record the mutation in the commit message body.
- **Merge order:** Phase 1 (Tasks 1–2) may merge alone. Tasks 3–8 merge together: `main` must never have a daemon that defaults to `~/.launchbox` and refuses to start without a `migrate` to run.
- macOS has no `timeout` binary; cap long test runs with node's own `--test-timeout`.

## Review Focus

1. **A bead in progress under the old actor when the daemon restarts on the new name.** Orphan recovery must still hand it back. Expected: recovered. Test: Task 4.
2. **A migration while the daemon is mid-write.** WAL pages that are not checkpointed would be lost from the backup. Expected: refused while the port answers, and the backup is taken after `wal_checkpoint(TRUNCATE)`. Tests: Tasks 6 and 7.
3. **A sibling path that shares the prefix** (`/Users/x/.claude-scheduler-old/log`). Expected: left untouched, because only `<oldDir>/` with its trailing slash is rewritten. Test: Task 7.
4. **The 0-byte stray `launchbox.db` already present in the old dir; a non-empty one.** Expected: the empty one is removed and the migration proceeds; a non-empty one causes a refusal. Tests: Tasks 6 and 7.
5. **Re-running after success, where the old path is now a symlink to the new dir.** Expected: prints "already migrated", exits 0, changes nothing. Test: Task 7.

---

## Phase 1 — node:sqlite

### Task 1: `lib/sqlite.js` compatibility adapter

Measured on Node 26 (2026-10-02). These are the three behaviours where `node:sqlite` differs from `better-sqlite3` that this codebase relies on:

| Behaviour | better-sqlite3 | node:sqlite |
|---|---|---|
| Extra keys in a named-parameter object (`lib/db.js:246` spreads whole rows) | ignored | throws `Unknown named parameter` unless `allowUnknownNamedParameters: true` |
| `undefined` bound as a parameter | binds NULL | throws `cannot be bound` |
| Row prototype | `Object.prototype` | `null` (breaks `assert.deepStrictEqual` against literals) |

Same in both: `run()` → `{ changes, lastInsertRowid }`, `get()` on no row → `undefined`, booleans rejected.

**Files:**
- Create: `lib/sqlite.js`
- Test: `tests/sqlite.test.js`

**Interfaces:**
- Produces: `openSqlite(path: string) → Db`, where `Db` has `prepare(sql) → { run(...p), get(...p), all(...p) }`, `exec(sql)`, `pragma(stmt: string) → object[]`, and `close()`. Parameters are either one object of named params or positional values.

- [ ] **Step 1: Write the failing test**

```js
// tests/sqlite.test.js
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/sqlite.test.js`
Expected: FAIL with `Cannot find module '../lib/sqlite.js'`.

- [ ] **Step 3: Implement**

```js
// lib/sqlite.js
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
```

- [ ] **Step 4: Run and confirm it passes**

Run: `node --test tests/sqlite.test.js`
Expected: 4 pass.

- [ ] **Step 5: Mutation-check each adapter rule**

Make each change below in turn, run the test file, and confirm the named test goes red. Restore after each one.
- Remove `allowUnknownNamedParameters: true` → "extra keys…" is red.
- Change `nul` to `(v) => v` → "undefined binds as NULL…" is red.
- Change `plain` to `(row) => row` → "rows are plain objects…" is red.

- [ ] **Step 6: Commit**

```bash
git add lib/sqlite.js tests/sqlite.test.js
git commit -m "feat(db): node:sqlite adapter restoring better-sqlite3 semantics db.js relies on"
```

### Task 2: Swap `lib/db.js` to the adapter; drop better-sqlite3

**Files:**
- Create: `tests/fixtures/m6-better-sqlite3.db` (generated in Step 1, **before** the dependency is removed)
- Modify: `lib/db.js:1,202` (import and `openDb`)
- Modify: `tests/db.test.js:4` and its legacy-db builders, which import `better-sqlite3` directly. This is the only test edit allowed: the dependency is gone.
- Modify: `package.json` (remove `better-sqlite3`; `engines.node` → `>=22.5`), `package-lock.json` (via `npm uninstall`)
- Modify: `README.md`, `CLAUDE.md` (delete the `npm rebuild better-sqlite3` note)
- Test: `tests/db-driver.test.js`

**Interfaces:**
- Consumes: `openSqlite` (Task 1).
- Produces: `openDb(path)` is unchanged in signature; it now returns the adapter's `Db`.

- [ ] **Step 1: Generate the fixture with the current driver**

```bash
node -e "
import('./lib/db.js').then(({ openDb, createJob, insertRun, setSetting }) => {
  const db = openDb('tests/fixtures/m6-better-sqlite3.db');
  const job = createJob(db, { name: 'fixture', type: 'command', params: { command: 'true' }, cwd: '/tmp', schedule: { kind: 'manual' } });
  insertRun(db, { jobId: job.id, status: 'ok', trigger: 'manual' });
  setSetting(db, 'worktreeRoot', '/tmp/wt');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
});"
ls -la tests/fixtures/m6-better-sqlite3.db*
```

If `createJob`/`insertRun` need different fields, read their signatures in `lib/db.js` and adjust. The goal is one row in each of `jobs`, `runs` and `settings`. Delete any `-wal`/`-shm` files left next to the fixture.

- [ ] **Step 2: Write the failing test**

```js
// tests/db-driver.test.js
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
  assert.equal(pkg.engines.node, '>=22.5');
});
```

Use the real exported names from `lib/db.js`. Grep `^export function` there; if it has no `listJobs`, use `db.prepare('SELECT * FROM jobs').all()`.

- [ ] **Step 3: Run it and confirm it fails**

Run: `node --test tests/db-driver.test.js`
Expected: the second test fails (`better-sqlite3` is still listed).

- [ ] **Step 4: Swap the driver**

In `lib/db.js`, replace line 1 and `openDb`:

```js
import { openSqlite } from './sqlite.js';
// …
export function openDb(path) {
  const db = openSqlite(path);
  db.pragma('journal_mode = WAL');
  migrate(db);
  db.exec(SCHEMA);
  return db;
}
```

In `tests/db.test.js`, replace `import Database from 'better-sqlite3'` with `import { openSqlite } from '../lib/sqlite.js'` and each `new Database(p)` with `openSqlite(p)`.

```bash
npm uninstall better-sqlite3
node -e "const f='package.json',p=JSON.parse(require('fs').readFileSync(f));p.engines.node='>=22.5';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
grep -rn "better-sqlite3" lib server.js bin tools tests package.json README.md CLAUDE.md
```

Expected grep output: only the comment in `lib/sqlite.js`. Remove the rebuild note from `README.md` and `CLAUDE.md`, and the "same problem this repo already documents for better-sqlite3" aside in `install.sh`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: everything passes, the leak gate is clean, and the test count is the previous count + 6. If any test fails, fix it in `lib/sqlite.js` or at the call site in `lib/`, **not** in the test. Record each such fix in the commit body.

- [ ] **Step 6: Mutation-check**

In `openDb`, comment out `db.pragma('journal_mode = WAL')`. Run `node --test tests/sqlite.test.js tests/db.test.js tests/db-driver.test.js`. If nothing goes red, add this assertion to the first test in `tests/db-driver.test.js`:

```js
  assert.equal(db.pragma('journal_mode')[0].journal_mode, 'wal');
```

Then confirm it is red with the mutation in place and green once restored.

- [ ] **Step 7: Live check** (the daemon is the owner's; do not restart it)

```bash
LB_DATA=$(mktemp -d) CS_PORT=43409 node server.js &  P=$!; sleep 2
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:43409/
kill $P
```

Expected: `200`. Port 43409 is inside this repo's 43400 block (`~/.claude/ports.json`); first check with `lsof -nP -iTCP:43409 -sTCP:LISTEN` that it is free. Delete the temporary data dir afterwards.

- [ ] **Step 8: Commit**

```bash
git add lib/db.js tests/db.test.js tests/db-driver.test.js tests/fixtures/m6-better-sqlite3.db package.json package-lock.json README.md CLAUDE.md install.sh
git commit -m "feat(db): node:sqlite replaces better-sqlite3; engines node>=22.5"
```

---

## Phase 2 — rename in code (merges together with Phase 3)

### Task 3: `lib/paths.js` — env helper, new data dir, legacy dir

**Files:**
- Modify: `lib/paths.js`
- Modify: every `process.env.CS_*` read in `lib/`, `server.js`, `bin/` and `tools/` (list: `grep -rn "process.env.CS_" lib server.js bin tools`)
- Test: `tests/paths.test.js`

**Interfaces:**
- Produces: `env(name: string) → string|undefined` (reads `LB_<name>`, then `CS_<name>`; empty string = unset); `LB_HOME` test seam replaces `homedir()`; `dataDir()` → `env('DATA') || ~/.launchbox`; `dbPath()` → `<dataDir>/launchbox.db`; `legacyDataDir()` → `~/.claude-scheduler`; `explicitDataDir() → boolean` (true when `LB_DATA` or `CS_DATA` is set).

- [ ] **Step 1: Write the failing tests** (append to `tests/paths.test.js`, and update the existing `scheduler.db` assertion to `launchbox.db`)

```js
import { homedir } from 'node:os';
import { env, legacyDataDir, explicitDataDir } from '../lib/paths.js';

test('env() prefers LB_ and falls back to CS_', () => {
  delete process.env.LB_PROBE; process.env.CS_PROBE = 'old';
  assert.equal(env('PROBE'), 'old');
  process.env.LB_PROBE = 'new';
  assert.equal(env('PROBE'), 'new');
  process.env.LB_PROBE = '';
  assert.equal(env('PROBE'), 'old', 'empty LB_ falls through');
  process.env.CS_PROBE = '';
  assert.equal(env('PROBE'), undefined, 'empty both = unset');
  delete process.env.LB_PROBE; delete process.env.CS_PROBE;
});

test('default data dir is ~/.launchbox; the legacy dir is named for migrate', () => {
  const saved = { LB: process.env.LB_DATA, CS: process.env.CS_DATA };
  delete process.env.LB_DATA; delete process.env.CS_DATA;
  try {
    assert.equal(dataDir(), join(homedir(), '.launchbox'));
    assert.equal(legacyDataDir(), join(homedir(), '.claude-scheduler'));
    assert.equal(explicitDataDir(), false);
  } finally {
    if (saved.LB !== undefined) process.env.LB_DATA = saved.LB;
    if (saved.CS !== undefined) process.env.CS_DATA = saved.CS;
  }
  assert.equal(explicitDataDir(), true);
});
```

- [ ] **Step 2: Run and confirm red.** `node --test tests/paths.test.js` → FAIL: `env` is not exported.

- [ ] **Step 3: Implement**

```js
// lib/paths.js (replacing dataDir/dbPath; keep PORT_BASE and the rest)
// LB_* is the name; CS_* (claude-scheduler) still works so existing shells,
// scripts and the test helpers keep running across the M6 rename.
// An empty string counts as unset, so `LB_DATA=` in a test env cannot
// shadow nothing with nothing.
export function env(name) {
  return process.env[`LB_${name}`] || process.env[`CS_${name}`] || undefined;
}

export function explicitDataDir() {
  return env('DATA') !== undefined;
}

// LB_HOME is a test seam (tests/migrate-cli.test.js); never set in production.
const home = () => process.env.LB_HOME || homedir();

export function dataDir() {
  return env('DATA') || join(home(), '.launchbox');
}

// Where installs before M6 kept everything. Read only by migrate and the
// startup guard.
export function legacyDataDir() {
  return join(home(), '.claude-scheduler');
}

export function dbPath() {
  return join(dataDir(), 'launchbox.db');
}
```

Replace each `process.env.CS_X` read with `env('X')` (import `env` from `lib/paths.js`). Change the header comment "claude-scheduler's allocated…" to "LaunchBox's allocated…".

- [ ] **Step 4: Run.** `npm test` → all green.
- [ ] **Step 5: Mutation.** Swap the two `process.env` reads in `env()` → "env() prefers LB_…" is red. Restore.
- [ ] **Step 6: Commit.** `git commit -am "feat(paths): LB_* env with CS_* fallback; ~/.launchbox default (M6)"`

### Task 4: Beads actor `launchbox`, old actor still recognised

**Files:**
- Modify: `lib/beads.js:41-42`, `lib/projects.js:1075`, `lib/projects.js:975,991` (reason strings), `lib/worktree.js:203` (commit identity)
- Test: `tests/projects.test.js` (new test next to the existing `recoverOrphans` tests)

**Interfaces:**
- Produces: `BD_ACTOR = 'launchbox'`; `SCHEDULER_ACTORS = Object.freeze(['launchbox', 'claude-scheduler'])`; `isSchedulerActor(name) → boolean`.

- [ ] **Step 1: Write the failing test.** Copy the setup of the existing test in `tests/projects.test.js` that proves recoverOrphans hands back a bead assigned to `BD_ACTOR` (grep `recoverOrphans`). Duplicate it, and make the fake bead's `assignee` the literal `'claude-scheduler'`:

```js
test('recoverOrphans hands back a bead claimed under the pre-M6 actor name', async () => {
  // …same fixture as the BD_ACTOR orphan test above, except:
  //   fakeBd show → { id: 'b1', status: 'in_progress', assignee: 'claude-scheduler' }
  const out = await projects.recoverOrphans();
  assert.deepEqual(out.map((o) => [o.beadId, o.handedBack]), [['b1', true]]);
});
```

Also assert `BD_ACTOR === 'launchbox'` in `tests/beads.test.js`.

- [ ] **Step 2: Run and confirm red.** Before the code change it fails on `BD_ACTOR === 'launchbox'`. Once `BD_ACTOR` alone is renamed, the orphan test fails with `held by claude-scheduler, not us`.
- [ ] **Step 3: Implement**

```js
// lib/beads.js
// The name our claims and closes are written under (`bd --actor`, `assignee`).
// Renamed in M6; the old name is still ours: beads claimed before the rename,
// and every pre-M6 line in .beads/interactions.jsonl, carry it.
export const BD_ACTOR = 'launchbox';
export const SCHEDULER_ACTORS = Object.freeze([BD_ACTOR, 'claude-scheduler']);
export const isSchedulerActor = (name) => SCHEDULER_ACTORS.includes(name);
```

In `lib/projects.js:1075`, change `if (bead.assignee !== BD_ACTOR)` to `if (!isSchedulerActor(bead.assignee))` and update the import. Change the reason strings at :975 and :991 to "LaunchBox run …". Change `lib/worktree.js:203` to `user.name=LaunchBox` and `user.email=launchbox@localhost`.

- [ ] **Step 4: Run.** `npm test` → green. Update any test that pinned the old reason strings or committer identity (grep `'claude-scheduler run'` and `claude-scheduler@localhost` in `tests/`).
- [ ] **Step 5: Mutation.** Make `isSchedulerActor` return `name === BD_ACTOR` → the pre-M6 orphan test is red. Restore.
- [ ] **Step 6: Commit.** `git commit -am "feat(beads): actor launchbox; pre-M6 claude-scheduler claims still recovered (M6)"`

### Task 5: Rename everything else, plus a naming gate

**Files:**
- Rename: `bin/claude-scheduler.mjs` → `bin/launchbox.mjs` (`git mv`)
- Modify: `package.json` (`name`, `bin`), `install.sh`, `uninstall.sh`, `lib/uninstall.js`, `server.js` (lines 471, 2324, 2506, 2514, 2521), `public/v2/api.js:10,30,67`, `public/v2/chrome.js:404,415`, `public/v2/main.js:87`, `public/v2/pages/settings.js:399,458-459`, `helper/LaunchBox.swift:3,5`, `lib/sessions.js:175` (comment example), `tools/verify-approval-timeout.sh:51`, `tools/verify-auth-*.mjs`, `tools/screenshots/capture.mjs`, `tools/qa/vendored.json`, `skills/*` in this repo
- Modify: tests that pin these strings (`grep -rnP "claude-scheduler(?!-[a-z0-9]{2,4}\b)" tests`)
- Create: `tests/naming.test.js`

**Interfaces:**
- Consumes: `legacyDataDir` (Task 3), `BD_ACTOR` and `SCHEDULER_ACTORS` (Task 4).
- Produces: the CLI `node bin/launchbox.mjs [open|url|token|migrate]` (`migrate` is wired in Task 8).

- [ ] **Step 1: Write the gate**

```js
// tests/naming.test.js
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
  const st = statSync(p);
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
```

- [ ] **Step 2: Run.** `node --test tests/naming.test.js` → red, listing about 90 lines. That list is the worklist.
- [ ] **Step 3: Rename** each listed line:
  - CLI name → `launchbox`; data-dir text → `~/.launchbox`; launchd label → `com.launchbox`.
  - In `install.sh`/`uninstall.sh`, `DATA=$HOME/.launchbox`, `LABEL=com.launchbox`. The liveness probe uses `${LB_PORT:-${CS_PORT:-43400}}`; the old `9099` was stale and is now `PORT_BASE`.
  - `uninstall.sh` and `lib/uninstall.js` also boot out and remove the **old** label `com.claude-scheduler` if it is present. Mark those lines with a `legacy (pre-M6)` comment; both files are already in `LEGACY_OK`.
  - UI copy says LaunchBox; `public/v2/chrome.js:404` becomes `launchctl list | grep launchbox`.
- [ ] **Step 4: Run.** `npm test` → green, gate included.
- [ ] **Step 5: Mutation, one per offender shape.** Plant each of these in turn in `lib/runner.js`, confirm `tests/naming.test.js` is red, and remove it:
  - string `'claude-scheduler'`
  - comment `// claude-scheduler daemon`
  - path `'~/.claude-scheduler/x'`
  - identifier-ish `claude-scheduler.mjs`

  Plant `claude-scheduler-7v1` and confirm it stays green (a bead id is allowed).
- [ ] **Step 6: Commit.** `git commit -am "feat: rename product identifiers to LaunchBox; naming gate (M6)"`

---

## Phase 3 — `launchbox migrate`

### Task 6: `planMigration()` — read-only checks and dry-run report

**Files:**
- Create: `lib/migrate.js`
- Modify: `tests/helpers.js` (add `fixtureInstall`, shared with Task 8's CLI test; a test file must not import another test file, or that file's tests re-run)
- Test: `tests/migrate.test.js`

**Interfaces:**
- Consumes: `openSqlite` (Task 1).
- Produces:
  - `planMigration({ oldDir, newDir, portAlive: () => Promise<boolean> }) → Promise<Plan>`
  - `Plan = { state: 'ready'|'refused'|'already'|'nothing', refusals: string[], rewrites: { table, column, rows }[], strayEmptyDb: boolean }`
  - `REWRITE_COLUMNS = [['runs','logPath','prefix'],['jobs','cwd','prefix'],['jobs','params','json'],['runs','meta','json'],['settings','value','prefix']]`

Rules:
- `oldDir` is a symlink resolving to `newDir` → `already`.
- `oldDir` is missing → `nothing`.
- Refusal reasons, each its own string:
  - `portAlive()` → "the daemon is running…";
  - any `runs.status IN ('running','queued')`;
  - any `task_leases.releasedAt IS NULL`;
  - any entry under `oldDir/worktrees/`;
  - `newDir` exists and is non-empty;
  - `oldDir/launchbox.db` exists with size > 0.
- `strayEmptyDb` is true when `oldDir/launchbox.db` exists with size 0.
- Row counts: `prefix` columns use `LIKE oldDir || '/%'`; `json` columns use `instr(col, oldDir || '/') > 0`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/helpers.js — append (add mkdirSync/writeFileSync to its fs import, openDb import from ../lib/db.js)
// A pre-M6 install in miniature: scheduler.db with one path in each rewritten
// column, plus the 0-byte launchbox.db the real install has had since 2026-09-21.
export function fixtureInstall({ live = {} } = {}) {
  const root = tmpDir('cs-m6-');
  const oldDir = join(root, '.claude-scheduler');
  const newDir = join(root, '.launchbox');
  mkdirSync(join(oldDir, 'logs'), { recursive: true });
  mkdirSync(join(oldDir, 'worktrees'));
  const db = openDb(join(oldDir, 'scheduler.db'));
  db.prepare(`INSERT INTO jobs (id,name,type,params,cwd,schedule,createdAt,updatedAt)
    VALUES ('j1','bead','claude',?,?,'{}','t','t')`).run(
    JSON.stringify({ prompt: 'x', logDir: `${oldDir}/logs` }), `${oldDir}/worktrees/p--b1`);
  db.prepare(`INSERT INTO runs (id,jobId,status,trigger,logPath,meta,createdAt)
    VALUES ('r1','j1',?,'schedule',?,?,'t')`).run(
    live.run ? 'running' : 'ok', `${oldDir}/logs/r1.log`, JSON.stringify({ wt: `${oldDir}/worktrees/p--b1` }));
  db.prepare(`INSERT INTO runs (id,jobId,status,trigger,logPath,createdAt)
    VALUES ('r2','j1','ok','schedule',?,'t')`).run(`${root}/.claude-scheduler-old/r2.log`);
  db.prepare(`INSERT INTO settings (key,value) VALUES ('worktreeRoot',?)`).run(`${oldDir}/worktrees`);
  db.prepare(`INSERT INTO sessions (id,cwd) VALUES ('s1',?)`).run(`${oldDir}/worktrees/p--b1`);
  if (live.lease) db.prepare(`INSERT INTO task_leases (projectId,beadId,runId,state,acquiredAt) VALUES ('p','b1','r1','held','t')`).run();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  writeFileSync(join(oldDir, 'launchbox.db'), '');
  if (live.worktree) mkdirSync(join(oldDir, 'worktrees', 'p--b1'));
  return { root, oldDir, newDir };
}
```

```js
// tests/migrate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
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
```

The `INSERT` column lists must match the real schema in `lib/db.js` `SCHEMA`; add any `NOT NULL` columns it requires.

- [ ] **Step 2: Run and confirm red.** `node --test tests/migrate.test.js` → module not found.
- [ ] **Step 3: Implement**

```js
// lib/migrate.js
// `launchbox migrate`: move a pre-M6 ~/.claude-scheduler install to ~/.launchbox.
// planMigration() only reads; it backs --dry-run and every refusal.
// applyMigration() runs: validate → back up → rewrite → move → repair → symlink.
// A failure before the move leaves the old dir as it was.
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openSqlite } from './sqlite.js';

export const REWRITE_COLUMNS = Object.freeze([
  ['runs', 'logPath', 'prefix'], ['jobs', 'cwd', 'prefix'], ['jobs', 'params', 'json'],
  ['runs', 'meta', 'json'], ['settings', 'value', 'prefix'],
]);

const where = (col, kind) => (kind === 'prefix' ? `${col} LIKE ? || '/%'` : `instr(${col}, ? || '/') > 0`);
const nonEmptyDir = (p) => existsSync(p) && readdirSync(p).length > 0;

export async function planMigration({ oldDir, newDir, portAlive }) {
  if (!existsSync(oldDir)) return { state: 'nothing', refusals: [], rewrites: [], strayEmptyDb: false };
  if (lstatSync(oldDir).isSymbolicLink() && existsSync(newDir) && realpathSync(oldDir) === realpathSync(newDir)) {
    return { state: 'already', refusals: [], rewrites: [], strayEmptyDb: false };
  }
  const refusals = [];
  if (await portAlive()) refusals.push('the daemon is running — stop it (Ctrl-C in its terminal) and run migrate again');
  if (nonEmptyDir(newDir)) refusals.push(`${newDir} already exists and is not empty`);
  const stray = join(oldDir, 'launchbox.db');
  const strayEmptyDb = existsSync(stray) && statSync(stray).size === 0;
  if (existsSync(stray) && !strayEmptyDb) refusals.push(`${stray} is not empty — it is not the known 0-byte stray; inspect it by hand`);
  if (nonEmptyDir(join(oldDir, 'worktrees'))) refusals.push('a bead worktree is still checked out under worktrees/ — let it finish or discard it first');

  const rewrites = [];
  const dbFile = join(oldDir, 'scheduler.db');
  if (existsSync(dbFile)) {
    const db = openSqlite(dbFile);
    try {
      if (db.prepare(`SELECT COUNT(*) n FROM runs WHERE status IN ('running','queued')`).get().n) refusals.push('a run is running or queued');
      if (db.prepare('SELECT COUNT(*) n FROM task_leases WHERE releasedAt IS NULL').get().n) refusals.push('a bead lease is still held');
      for (const [table, column, kind] of REWRITE_COLUMNS) {
        rewrites.push({ table, column, rows: db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where(column, kind)}`).get(oldDir).n });
      }
    } finally { db.close(); }
  }
  return { state: refusals.length ? 'refused' : 'ready', refusals, rewrites, strayEmptyDb };
}
```

If `runs` has no `queued` status in this codebase, keep the `IN` list anyway; it costs nothing. Check `task_leases` for a `releasedAt` column (it has one: `projectId beadId runId state acquiredAt releasedAt`).

- [ ] **Step 4: Run.** → 8 pass.
- [ ] **Step 5: Mutation.** Delete each refusal line in turn → its own test is red. Change `'/%'` to `'%'` → the row-count test is red: `runs.logPath` becomes 2 because of the `.claude-scheduler-old` sibling.
- [ ] **Step 6: Commit.** `git commit -am "feat(migrate): planMigration — refusals and dry-run counts (M6)"`

### Task 7: `applyMigration()` — back up, rewrite, move, repair, symlink

**Files:**
- Modify: `lib/migrate.js`
- Test: `tests/migrate.test.js`

**Interfaces:**
- Consumes: `planMigration`, `REWRITE_COLUMNS` (Task 6).
- Produces: `applyMigration({ oldDir, newDir, portAlive, projectPaths: string[], gitRepair?: (path) => Promise<{ok, error?}>, faultAt?: 'backup'|'rewrite'|'commit'|'move' }) → Promise<{ state, repaired: {path, ok, error?}[] }>`. `faultAt` exists only for tests; it throws right before the named step.

Steps, in order:
1. Run `planMigration`; return early if its state is not `ready`.
2. Open `scheduler.db`, `PRAGMA wal_checkpoint(TRUNCATE)`, close, and copy it to `scheduler.db.pre-m6.bak`.
3. In one `BEGIN IMMEDIATE … COMMIT`, apply `UPDATE`s:
   - `prefix` columns: `col = ? || substr(col, length(?) + 1) WHERE col LIKE ? || '/%'`, with params (newDir, oldDir, oldDir);
   - `json` columns: `col = replace(col, ? || '/', ? || '/')` where `instr(...) > 0`.

   `ROLLBACK` on any throw.
4. `renameSync(oldDir, newDir)`. If it fails, restore `scheduler.db` from the backup and rethrow. Then remove the 0-byte `launchbox.db` if `strayEmptyDb`, and rename `scheduler.db*` → `launchbox.db*` inside `newDir`.
5. For each project path, run `git -C <path> worktree repair`. Failures are reported, never undone.
6. `symlinkSync(newDir, oldDir)`.

- [ ] **Step 1: Write the failing tests** (append)

```js
import { readFileSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { applyMigration } from '../lib/migrate.js';

const hashTree = (dir) => {
  const h = createHash('sha256');
  for (const n of readdirSync(dir, { recursive: true }).sort()) {
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
```

- [ ] **Step 2: Run and confirm red.** `applyMigration` is not exported.
- [ ] **Step 3: Implement** (append to `lib/migrate.js`)

```js
import { copyFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function defaultGitRepair(path) {
  try { await run('git', ['-C', path, 'worktree', 'repair']); return { ok: true, path }; }
  catch (err) { return { ok: false, path, error: String(err.stderr || err.message).trim() }; }
}

const fault = (at, step) => { if (at === step) throw new Error(`injected fault at ${step}`); };

export async function applyMigration({ oldDir, newDir, portAlive, projectPaths = [], gitRepair = defaultGitRepair, faultAt } = {}) {
  const plan = await planMigration({ oldDir, newDir, portAlive });
  if (plan.state !== 'ready') return { state: plan.state, refusals: plan.refusals, repaired: [] };
  const dbFile = join(oldDir, 'scheduler.db');

  fault(faultAt, 'backup');
  { const db = openSqlite(dbFile); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); }
  copyFileSync(dbFile, `${dbFile}.pre-m6.bak`);

  fault(faultAt, 'rewrite');
  const db = openSqlite(dbFile);
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const [table, column, kind] of REWRITE_COLUMNS) {
      if (kind === 'prefix') {
        db.prepare(`UPDATE ${table} SET ${column} = ? || substr(${column}, length(?) + 1) WHERE ${column} LIKE ? || '/%'`)
          .run(newDir, oldDir, oldDir);
      } else {
        db.prepare(`UPDATE ${table} SET ${column} = replace(${column}, ? || '/', ? || '/') WHERE instr(${column}, ? || '/') > 0`)
          .run(oldDir, newDir, oldDir);
      }
    }
    fault(faultAt, 'commit'); // inside the transaction: proves the rollback
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  }

  // The DB now holds new-dir paths but still sits in the old dir. If the move
  // fails, put the backup back so the old install keeps working as it was.
  try {
    fault(faultAt, 'move');
    renameSync(oldDir, newDir);
  } catch (err) {
    for (const sfx of ['-wal', '-shm']) rmSync(`${dbFile}${sfx}`, { force: true });
    copyFileSync(`${dbFile}.pre-m6.bak`, dbFile);
    throw err;
  }
  if (plan.strayEmptyDb) rmSync(join(newDir, 'launchbox.db'));
  for (const sfx of ['', '-wal', '-shm']) {
    const from = join(newDir, `scheduler.db${sfx}`);
    if (existsSync(from)) renameSync(from, join(newDir, `launchbox.db${sfx}`));
  }
  const repaired = [];
  for (const p of projectPaths) repaired.push(await gitRepair(p)); // eslint-disable-line no-await-in-loop
  symlinkSync(newDir, oldDir);
  return { state: 'migrated', repaired };
}
```

The `finally` above runs `wal_checkpoint` even after a `ROLLBACK`; that is harmless. If the test runner reports that the backup counts as a byte difference for `faultAt: 'rewrite'`, that is expected and the test already allows it.

- [ ] **Step 4: Run.** → all migrate tests pass.
- [ ] **Step 5: Mutation.**
  - Remove `db.exec('ROLLBACK')` → the `commit` fault test is red (the rewrite persists).
  - Remove the `copyFileSync` restore in the move `catch` → the `move` fault test is red.
  - Move `symlinkSync` before the `renameSync` → the first test is red.
  - Change the prefix `LIKE ? || '/%'` to `LIKE ? || '%'` → the `r2` sibling assertion is red.
- [ ] **Step 6: Commit.** `git commit -am "feat(migrate): applyMigration — backup, transactional rewrite, move, repair, symlink (M6)"`

### Task 8: CLI `launchbox migrate [--dry-run]` and the startup guard

**Files:**
- Modify: `bin/launchbox.mjs` (add a `migrate` branch **before** `ensureDirs()`/`ensureToken()`, which would otherwise create `~/.launchbox` and trip the "target not empty" refusal)
- Modify: `server.js` (guard near `ensureDirs()` at startup)
- Create: `lib/startup-guard.js`
- Test: `tests/startup-guard.test.js`, `tests/migrate-cli.test.js`

**Interfaces:**
- Consumes: `planMigration`, `applyMigration`, `legacyDataDir`, `dataDir`, `explicitDataDir`, `PORT_BASE`, and `db.listProjects` (or the `SELECT path FROM projects` equivalent).
- Produces: `legacyInstallBlocks({ legacy, current, explicit }) → string|null`, which returns the refusal message or null.

- [ ] **Step 1: Write the failing tests**

```js
// tests/startup-guard.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './helpers.js';
import { legacyInstallBlocks } from '../lib/startup-guard.js';

test('blocks start when only the legacy dir exists, naming the migrate command', () => {
  const r = tmpDir(); mkdirSync(join(r, 'old'));
  assert.match(legacyInstallBlocks({ legacy: join(r, 'old'), current: join(r, 'new'), explicit: false }), /launchbox migrate/);
});
test('does not block when the new dir exists, when none exists, or when the data dir is explicit', () => {
  const r = tmpDir(); mkdirSync(join(r, 'old')); mkdirSync(join(r, 'new'));
  assert.equal(legacyInstallBlocks({ legacy: join(r, 'old'), current: join(r, 'new'), explicit: false }), null);
  assert.equal(legacyInstallBlocks({ legacy: join(r, 'x'), current: join(r, 'y'), explicit: false }), null);
  assert.equal(legacyInstallBlocks({ legacy: join(r, 'old'), current: join(r, 'zz'), explicit: true }), null);
});
```

```js
// tests/migrate-cli.test.js — drives the real bin against a fixture via LB_HOME
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fixtureInstall } from './helpers.js';

const BIN = new URL('../bin/launchbox.mjs', import.meta.url).pathname;
const cli = (args, home) => execFileSync(process.execPath, [BIN, 'migrate', ...args], {
  env: { ...process.env, LB_HOME: home, LB_DATA: '', CS_DATA: '', LB_PORT: '43408' }, encoding: 'utf8' });

test('--dry-run reports and writes nothing', () => {
  const { root, newDir } = fixtureInstall();
  const out = cli(['--dry-run'], root);
  assert.match(out, /runs\.logPath\s+1/);
  assert.equal(existsSync(newDir), false);
});
test('migrate moves the fixture install', () => {
  const { root, newDir } = fixtureInstall();
  assert.match(cli([], root), /migrated/);
  assert.ok(existsSync(`${newDir}/launchbox.db`));
});
```

`LB_HOME` (Task 3) points both the legacy and the default dir at the fixture root; `LB_DATA=''` is treated as unset (Task 3). Port 43408 must have nothing listening; check with `lsof` first.

- [ ] **Step 2: Run and confirm red.**
- [ ] **Step 3: Implement**

```js
// lib/startup-guard.js
import { existsSync } from 'node:fs';

// A pre-M6 install whose data has not moved yet. Starting would create an empty
// ~/.launchbox and silently look like a fresh install with no jobs or history.
export function legacyInstallBlocks({ legacy, current, explicit }) {
  if (explicit || existsSync(current) || !existsSync(legacy)) return null;
  return `LaunchBox found a pre-rename install at ${legacy} and none at ${current}.\n`
    + 'Move it first:  node bin/launchbox.mjs migrate --dry-run   then   node bin/launchbox.mjs migrate';
}
```

In `server.js`, before `ensureDirs()`:

```js
const blocked = legacyInstallBlocks({ legacy: legacyDataDir(), current: dataDir(), explicit: explicitDataDir() });
if (blocked) { console.error(blocked); process.exit(1); }
```

In `bin/launchbox.mjs`, before `ensureDirs()`:

```js
if (cmd === 'migrate') {
  const { planMigration, applyMigration } = await import('../lib/migrate.js');
  const { openSqlite } = await import('../lib/sqlite.js');
  const oldDir = legacyDataDir(); const newDir = dataDir();
  const portAlive = async () => {
    try { return (await fetch(`http://127.0.0.1:${env('PORT') || defaultPort()}/`, { signal: AbortSignal.timeout(1500) })).ok; }
    catch { return false; }
  };
  const plan = await planMigration({ oldDir, newDir, portAlive });
  console.log(`state: ${plan.state}`);
  for (const r of plan.refusals) console.log(`refused: ${r}`);
  for (const w of plan.rewrites) console.log(`rewrite ${`${w.table}.${w.column}`.padEnd(16)} ${w.rows}`);
  if (plan.strayEmptyDb) console.log('remove: 0-byte launchbox.db (stray)');
  if (plan.state === 'ready') console.log(`move: ${oldDir} → ${newDir}, then symlink the old path`);
  if (process.argv.includes('--dry-run') || plan.state !== 'ready') process.exit(plan.state === 'refused' ? 1 : 0);
  const db = openSqlite(join(oldDir, 'scheduler.db'));
  const projectPaths = db.prepare('SELECT path FROM projects').all().map((r) => r.path);
  db.close();
  const res = await applyMigration({ oldDir, newDir, portAlive, projectPaths });
  console.log(res.state);
  for (const r of res.repaired) console.log(`git worktree repair ${r.path}: ${r.ok ? 'ok' : r.error}`);
  process.exit(0);
}
```

Update the usage line to `launchbox [open|url|token|migrate [--dry-run]]`.

- [ ] **Step 4: Run.** `npm test` → green.
- [ ] **Step 5: Mutation.** Remove the `explicit ||` check → the guard test is red. Move the `migrate` branch after `ensureDirs()` → the CLI `migrate` test is red ("already exists and is not empty").
- [ ] **Step 6: Live check without touching the real install.** Copy the real DB read-only into a scratch HOME and dry-run it:

```bash
H=$(mktemp -d); mkdir -p "$H/.claude-scheduler"
sqlite3 ~/.claude-scheduler/scheduler.db ".backup '$H/.claude-scheduler/scheduler.db'"
LB_HOME=$H LB_PORT=43408 node bin/launchbox.mjs migrate --dry-run
rm -rf "$H"
```

Expected: `state: ready`, with counts close to the spec's measured values (runs.logPath ≈236, jobs.cwd ≈65, settings.value 1). Record the output in the commit body.

- [ ] **Step 7: Commit.** `git commit -am "feat(migrate): launchbox migrate [--dry-run] + startup guard for pre-M6 installs (M6)"`

---

## Phase 4 — outside the repo (an interactive session, not a scheduled run: it writes under `~/.claude`)

### Task 9: Docs, skills, global instructions

**Files:**
- Modify: `skills/registered-repo-session/SKILL.md` and `skills/bead-authoring/SKILL.md`, `skills/README.md` (in repo), then `npm run install:skills` to refresh `~/.claude/skills/`
- Modify: `~/.claude/CLAUDE.md` (the "Task tracking: beads" section), `~/.claude/docs/beads-task-tracking.md`
- Test: `tests/skills.test.js`

- [ ] **Step 1: Write the failing test** (append to `tests/skills.test.js`)

```js
test('the session briefing counts scheduler activity under both actor names', () => {
  const s = readFileSync(new URL('../skills/registered-repo-session/SKILL.md', import.meta.url), 'utf8');
  assert.match(s, /actor\s*(==|in)[^\n]*launchbox/);
  assert.match(s, /claude-scheduler/); // pre-M6 history
  assert.match(s, /~\/\.launchbox\/worktrees/);
});
```

- [ ] **Step 2: Run and confirm red.**
- [ ] **Step 3: Edit.**
  - Briefing step 1 becomes: keep lines with `actor` in (`launchbox`, `claude-scheduler`). Every line naming the old actor or path must contain `pre-M6`, or the Task 5 naming gate flags it.
  - "Never touch `~/.launchbox/worktrees/*` by hand (pre-M6: `~/.claude-scheduler/worktrees/`)".
  - In `~/.claude/CLAUDE.md` and `beads-task-tracking.md`, "claude-scheduler" becomes "LaunchBox". Leave the repo path `~/mydevelopment/claude-scheduler` as it is: the folder is not renamed.
  - Run `npm run install:skills`, then `diff -r skills ~/.claude/skills` for the two skills (no output expected).
- [ ] **Step 4: Run.** `npm test` → green.
- [ ] **Step 5: Live check.** In this repo, run the briefing's filter by hand over `.beads/interactions.jsonl` and confirm it still lists pre-rename `claude-scheduler` entries (count > 0).
- [ ] **Step 6: Commit** (repo part only): `git commit -am "docs(skills): LaunchBox actor + paths; pre-M6 history still briefed (M6)"`

### Task 10: Owner sitting (human)

1. `node bin/launchbox.mjs migrate --dry-run` and read the output.
2. Wait until no job is running, Ctrl-C the daemon in its terminal, then run `node bin/launchbox.mjs migrate`.
3. `npm start`; open the UI with `node bin/launchbox.mjs open`; confirm Projects, Jobs and History all show the old data.
4. Trigger one scheduled bead (or wait for the next poll); confirm it runs in `~/.launchbox/worktrees/` and that its bead note names actor `launchbox`.
5. One release later: `rm ~/.claude-scheduler` (the symlink) and `~/.launchbox/scheduler.db.pre-m6.bak`.
