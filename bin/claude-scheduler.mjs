#!/usr/bin/env node
// The token delivery mechanism. The token rides in the URL *fragment*: fragments
// are never sent to the server, so unlike a query string they cannot land in a
// log. The page stores it and strips it immediately.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureToken } from '../lib/token.js';
import { dataDir, ensureDirs, defaultPort } from '../lib/paths.js';

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
} else if (cmd === 'ui') {
  // The cutover switch (docs/plans/2026-10-01-v2-cutover.md, phase A): which UI
  // `/` opens. Goes through the daemon's Touch ID-gated route, never the DB, so
  // the owner's approval is the only way it changes. No argument = report.
  const want = process.argv[3];
  const USAGE = 'usage: claude-scheduler ui [v1|v2]   (no argument prints the current default)';
  if (want !== undefined && want !== 'v1' && want !== 'v2') { console.error(USAGE); process.exit(2); }
  const base = `http://127.0.0.1:${port()}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let res;
  try {
    res = want === undefined
      ? await fetch(`${base}/api/settings`, { headers })
      : await fetch(`${base}/api/ui-default`, { method: 'PUT', headers, body: JSON.stringify({ ui: want }) });
  } catch {
    console.error(`No scheduler answering on port ${port()}. Start it, then try again.`);
    process.exit(1);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = body.code ?? body.error ?? (body.errors ?? []).join('; ') ?? `HTTP ${res.status}`;
    console.error(`Not switched: ${why}`);
    process.exit(1);
  }
  if (want === undefined) {
    console.log(`${body.uiDefault}  (/ opens ${body.uiDefault === 'v2' ? 'the new LaunchBox UI' : 'the existing UI'}; /v1 and /v2 always work)`);
  } else {
    console.log(`/ now opens ${body.ui}${body.ui === 'v2' ? ' — the existing UI stays at /v1' : ''}`);
  }
} else {
  console.error('usage: claude-scheduler [open|url|token|ui [v1|v2]]');
  process.exit(2);
}
