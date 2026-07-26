#!/usr/bin/env node
// The token delivery mechanism. The token rides in the URL *fragment*: fragments
// are never sent to the server, so unlike a query string they cannot land in a
// log. The page stores it and strips it immediately.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureToken } from '../lib/token.js';
import { dataDir, ensureDirs } from '../lib/paths.js';

const cmd = process.argv[2] ?? 'open';
ensureDirs();
const token = ensureToken();

// The running daemon writes the port it actually bound. Preferred over guessing,
// because sending someone to the wrong port with a valid token looks exactly
// like a broken token. An explicit CS_PORT still wins, since that is someone
// telling us where they are pointing.
//
// Deliberately does NOT open the database: doing so runs migrate() + the schema
// and would *create* ~/.claude-scheduler/scheduler.db as a side effect of asking
// for a URL. A read-only command should stay read-only.
function port() {
  if (process.env.CS_PORT) return Number(process.env.CS_PORT);
  try {
    const f = join(dataDir(), 'port');
    if (existsSync(f)) {
      const p = Number(readFileSync(f, 'utf8').trim());
      if (Number.isInteger(p) && p > 0 && p < 65536) return p;
    }
  } catch { /* fall through to the default */ }
  return 9099;
}

const url = `http://127.0.0.1:${port()}/#token=${token}`;

if (cmd === 'token') {
  console.log(token);
} else if (cmd === 'url') {
  console.log(url);
} else if (cmd === 'open') {
  console.log(url);
  // `open` is macOS; on other platforms print the URL and let the user click it.
  if (process.platform === 'darwin') execFile('open', [url], () => {});
  else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
  else execFile('xdg-open', [url], () => {});
} else {
  console.error('usage: claude-scheduler [open|url|token]');
  process.exit(2);
}
