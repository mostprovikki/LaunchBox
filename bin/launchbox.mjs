#!/usr/bin/env node
// The token delivery mechanism. The token rides in the URL *fragment*: fragments
// are never sent to the server, so unlike a query string they cannot land in a
// log. The page stores it and strips it immediately.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureToken } from '../lib/token.js';
import { dataDir, legacyDataDir, ensureDirs, defaultPort, env } from '../lib/paths.js';

const cmd = process.argv[2] ?? 'open';

// Must run before ensureDirs(): that would create the new data dir and trip the
// "target not empty" refusal.
if (cmd === 'migrate') {
  const { planMigration, applyMigration } = await import('../lib/migrate.js');
  const { openSqlite } = await import('../lib/sqlite.js');
  const oldDir = legacyDataDir();
  const newDir = dataDir();
  const portAlive = async () => {
    try { return (await fetch(`http://127.0.0.1:${env('PORT') || defaultPort()}/`, { signal: AbortSignal.timeout(1500) })).ok; }
    catch { return false; }
  };
  try {
    const plan = await planMigration({ oldDir, newDir, portAlive });
    console.log(`state: ${plan.state}`);
    for (const r of plan.refusals ?? []) console.log(`refused: ${r}`);
    for (const w of plan.rewrites ?? []) console.log(`rewrite ${`${w.table}.${w.column}`.padEnd(16)} ${w.rows}`);
    if (plan.strayEmptyDb) console.log('remove: 0-byte launchbox.db (stray)');
    if (plan.state === 'ready') console.log(`move: ${oldDir} -> ${newDir}, then symlink the old path`);
    if (process.argv.includes('--dry-run') || plan.state !== 'ready') process.exit(plan.state === 'refused' ? 1 : 0);
    let projectPaths = [];
    const db = openSqlite(join(oldDir, 'scheduler.db'), { readOnly: true });
    try { projectPaths = db.prepare('SELECT path FROM projects').all().map((r) => r.path); }
    catch { /* no projects table: nothing to repair */ }
    finally { db.close(); }
    const res = await applyMigration({ oldDir, newDir, portAlive, projectPaths });
    console.log(res.state);
    for (const r of res.refusals ?? []) console.log(`refused: ${r}`);
    for (const r of res.repaired ?? []) console.log(`git worktree repair ${r.path}: ${r.ok ? 'ok' : r.error}`);
    process.exit(res.state === 'refused' ? 1 : 0);
  } catch (e) {
    console.error(`migrate failed: ${e.message}`);
    process.exit(1);
  }
}

ensureDirs();
const token = ensureToken();

// The running daemon writes the port it actually bound. Preferred over guessing,
// because sending someone to the wrong port with a valid token looks exactly
// like a broken token. An explicit LB_PORT (CS_PORT still read) wins, since that is someone
// telling us where they are pointing.
//
// Deliberately does NOT open the database: doing so runs migrate() + the schema
// and would *create* ~/.launchbox/launchbox.db as a side effect of asking
// for a URL. A read-only command should stay read-only.
function port() {
  if (env('PORT')) return Number(env('PORT'));
  try {
    const f = join(dataDir(), 'port');
    if (existsSync(f)) {
      const p = Number(readFileSync(f, 'utf8').trim());
      if (Number.isInteger(p) && p > 0 && p < 65536) return p;
    }
  } catch { /* fall through to the default */ }
  return defaultPort();
}

const url = `http://127.0.0.1:${port()}/#token=${token}`;

if (cmd === 'token') {
  console.log(token);
} else if (cmd === 'url') {
  console.log(url);
} else if (cmd === 'open') {
  // Check the daemon is actually there before opening a browser at it. The port
  // file survives a crash, and handing someone a URL that does not answer while
  // telling them it carries their key is the most confusing possible failure —
  // it reads as "the key is broken".
  //
  // Probes `/`, which is deliberately unauthenticated; every /api route answers
  // 401 without the token and would look like a dead server here.
  let live = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port()}/`, { signal: AbortSignal.timeout(2500) });
    live = res.ok;
  } catch { live = false; }

  if (!live) {
    console.error(`No scheduler answering on port ${port()}.`);
    console.error('Start it with ./install.sh (or `npm start` for a foreground run), then try again.');
    console.error(`\nYour session key is stored, so this URL will work once it is up:\n  ${url}`);
    process.exit(1);
  }

  console.log(url);
  // `open` is macOS; on other platforms print the URL and let the user click it.
  if (process.platform === 'darwin') execFile('open', [url], () => {});
  else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
  else execFile('xdg-open', [url], () => {});
} else {
  console.error('usage: launchbox [open|url|token|migrate [--dry-run]]');
  process.exit(2);
}
