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
    const db = openSqlite(dbFile, { readOnly: true });
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
