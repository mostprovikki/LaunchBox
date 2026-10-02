// `launchbox migrate`: move a pre-M6 ~/.claude-scheduler install to ~/.launchbox.
// planMigration() only reads; it backs --dry-run and every refusal.
// applyMigration() runs: validate → back up → rewrite → move → symlink → rename DB → verify → repair.
// A failure before the move leaves the old dir as it was.
import { copyFileSync, existsSync, lstatSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { openSqlite } from './sqlite.js';

export const REWRITE_COLUMNS = Object.freeze([
  ['runs', 'logPath', 'prefix'], ['jobs', 'cwd', 'prefix'], ['jobs', 'params', 'json'],
  ['runs', 'meta', 'json'], ['settings', 'value', 'prefix'],
]);

const where = (col, kind) => (kind === 'prefix' ? `${col} LIKE ? || '/%'` : `instr(${col}, ? || '/') > 0`);
const nonEmptyDir = (p) => existsSync(p) && readdirSync(p).length > 0;

// A Ctrl-C mid-run leaves live runs, held leases and worktrees that only the old
// install's own boot recovery releases properly (it hands leases back to beads).
// migrate never fails them itself.
const recover = (oldDir) => ` — start the old install once so it recovers orphaned runs: LB_DATA=${oldDir} npm start`
  + ' — wait until idle (no runs), stop it, then run migrate again';
const describe = (dir) => readdirSync(dir).sort().map((n) => (lstatSync(join(dir, n)).isDirectory() ? `${n}/` : n)).join(', ');

export async function planMigration({ oldDir, newDir, portAlive }) {
  if (!existsSync(oldDir)) return { state: 'nothing', refusals: [], rewrites: [], strayEmptyDb: false };
  if (lstatSync(oldDir).isSymbolicLink() && existsSync(newDir) && realpathSync(oldDir) === realpathSync(newDir)) {
    return { state: 'already', refusals: [], rewrites: [], strayEmptyDb: false };
  }
  const refusals = [];
  if (await portAlive()) refusals.push('the daemon is running — stop it (Ctrl-C in its terminal) and run migrate again');
  if (nonEmptyDir(newDir)) {
    refusals.push(`${newDir} already exists and is not empty (contains: ${describe(newDir)}); `
      + 'if it holds only an empty logs/ and a token (left by launchbox open|url|token or install.sh), delete it and run migrate again');
  }
  const stray = join(oldDir, 'launchbox.db');
  const strayEmptyDb = existsSync(stray) && statSync(stray).size === 0;
  if (existsSync(stray) && !strayEmptyDb) refusals.push(`${stray} is not empty — it is not the known 0-byte stray; inspect it by hand`);
  if (nonEmptyDir(join(oldDir, 'worktrees'))) refusals.push(`a bead worktree is still checked out under worktrees/${recover(oldDir)}`);

  const rewrites = [];
  const dbFile = join(oldDir, 'scheduler.db');
  if (existsSync(dbFile)) {
    const db = openSqlite(dbFile, { readOnly: true });
    try {
      if (db.prepare(`SELECT COUNT(*) n FROM runs WHERE status IN ('running','queued')`).get().n) refusals.push(`a run is running or queued${recover(oldDir)}`);
      if (db.prepare('SELECT COUNT(*) n FROM task_leases WHERE releasedAt IS NULL').get().n) refusals.push(`a bead lease is still held${recover(oldDir)}`);
      for (const [table, column, kind] of REWRITE_COLUMNS) {
        rewrites.push({ table, column, rows: db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where(column, kind)}`).get(oldDir).n });
      }
    } finally { db.close(); }
  }
  return { state: refusals.length ? 'refused' : 'ready', refusals, rewrites, strayEmptyDb };
}

const run = promisify(execFile);

async function defaultGitRepair(path) {
  try { await run('git', ['-C', path, 'worktree', 'repair']); return { ok: true, path }; }
  catch (err) { return { ok: false, path, error: String(err.stderr || err.message).trim() }; }
}

const fault = (at, step) => { if (at === step) throw new Error(`injected fault at ${step}`); };

// faultAt is test-only: throws right before the named step.
export async function applyMigration({ oldDir, newDir, portAlive, projectPaths = [], gitRepair = defaultGitRepair, faultAt } = {}) {
  const plan = await planMigration({ oldDir, newDir, portAlive });
  if (plan.state !== 'ready') return { state: plan.state, refusals: plan.refusals, repaired: [] };
  const dbFile = join(oldDir, 'scheduler.db');

  fault(faultAt, 'backup');
  { const db = openSqlite(dbFile); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); }
  // The first backup is the pristine one: a crash between COMMIT and the move
  // leaves a rewritten DB, and a re-run must not copy that over it. This
  // attempt's own copy (what a failed move restores) then goes beside it.
  const bak = `${dbFile}.pre-m6.bak`;
  const attempt = existsSync(bak) ? `${dbFile}.pre-m6.attempt` : bak;
  copyFileSync(dbFile, attempt);
  const dropAttempt = (dir) => { if (attempt !== bak) rmSync(join(dir, 'scheduler.db.pre-m6.attempt'), { force: true }); };

  try {
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
      // Best effort: an error here must not mask the one being thrown.
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
      db.close();
    }

    // The DB now holds new-dir paths but still sits in the old dir. If the move
    // fails, put this attempt's copy back so the old install keeps working as it was.
    try {
      fault(faultAt, 'move');
      renameSync(oldDir, newDir);
    } catch (err) {
      for (const sfx of ['-wal', '-shm']) rmSync(`${dbFile}${sfx}`, { force: true });
      copyFileSync(attempt, dbFile);
      throw err;
    }
  } catch (err) {
    dropAttempt(oldDir);
    throw err;
  }

  // Moved. Link the old path first, so anything failing below still leaves
  // every old-path reference (and the next migrate run) pointing at the data.
  symlinkSync(newDir, oldDir);
  try {
    dropAttempt(newDir);
    if (plan.strayEmptyDb) rmSync(join(newDir, 'launchbox.db'));
    fault(faultAt, 'dbrename');
    for (const sfx of ['', '-wal', '-shm']) {
      const from = join(newDir, `scheduler.db${sfx}`);
      if (existsSync(from)) renameSync(from, join(newDir, `launchbox.db${sfx}`));
    }
    const final = join(newDir, 'launchbox.db');
    if (!existsSync(final) || statSync(final).size === 0) throw new Error(`${final} is missing or empty`);
  } catch (err) {
    throw new Error(`moved ${oldDir} to ${newDir} (the old path now links there) but finishing failed: ${err.message}. `
      + `Data is in ${newDir}; rename scheduler.db* there to launchbox.db* by hand if it is still named scheduler.db.`);
  }
  const repaired = [];
  for (const p of projectPaths) repaired.push(await gitRepair(p)); // eslint-disable-line no-await-in-loop
  return { state: 'migrated', repaired };
}
