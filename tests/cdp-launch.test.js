// CDP launch endpoint (claude-scheduler-jb7). launchBrowser used to pick a
// port, release it, then accept ANY /json/version answer there — so a process
// that took the port in between was driven as our Chrome. The endpoint now
// comes only from the DevToolsActivePort file in Chrome's own profile dir.
// No test here launches Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './helpers.js';
import { devToolsEndpoint } from '../tools/screenshots/cdp.mjs';

const OURS = '/devtools/browser/0000-ours';

// A debugger that is not ours: answers /json/version like Chrome would and
// counts every request it gets.
async function foreignDebugger() {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    const { port } = srv.address();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/FOREIGN` }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, hits: () => hits, close: () => new Promise((r) => srv.close(r)) };
}

test('waits for DevToolsActivePort in the profile dir and returns its endpoint', async () => {
  const dir = tmpDir('cs-cdp-');
  const t = setTimeout(() => writeFileSync(join(dir, 'DevToolsActivePort'), `51234\n${OURS}\n`), 250);
  const started = Date.now();
  const ws = await devToolsEndpoint(dir, { timeoutMs: 5000 });
  clearTimeout(t);
  assert.equal(ws, `ws://127.0.0.1:51234${OURS}`);
  assert.ok(Date.now() - started >= 200, 'returned before the file existed');
});

test('a half-written file (port line only) is not accepted', async () => {
  const dir = tmpDir('cs-cdp-');
  writeFileSync(join(dir, 'DevToolsActivePort'), '51234\n');
  const t = setTimeout(() => writeFileSync(join(dir, 'DevToolsActivePort'), `51234\n${OURS}\n`), 250);
  const ws = await devToolsEndpoint(dir, { timeoutMs: 5000 });
  clearTimeout(t);
  assert.equal(ws, `ws://127.0.0.1:51234${OURS}`);
});

test('a foreign debugger on the named port is never asked or trusted', async () => {
  const foreign = await foreignDebugger();
  try {
    const dir = tmpDir('cs-cdp-');
    writeFileSync(join(dir, 'DevToolsActivePort'), `${foreign.port}\n${OURS}\n`);
    const ws = await devToolsEndpoint(dir, { timeoutMs: 3000 });
    assert.equal(ws, `ws://127.0.0.1:${foreign.port}${OURS}`, 'endpoint must be the file\'s ws path');
    assert.equal(foreign.hits(), 0, 'helper queried a debugger instead of reading the file');
  } finally { await foreign.close(); }
});

test('times out cleanly when the file never appears, despite a live foreign debugger', async () => {
  const foreign = await foreignDebugger();
  try {
    const dir = tmpDir('cs-cdp-');
    const started = Date.now();
    await assert.rejects(devToolsEndpoint(dir, { timeoutMs: 400 }), /never wrote .*DevToolsActivePort/);
    assert.ok(Date.now() - started < 2000, 'timeout not honoured');
    assert.equal(foreign.hits(), 0);
  } finally { await foreign.close(); }
});

test('fails fast when Chrome exits before writing the file', async () => {
  const dir = tmpDir('cs-cdp-');
  await assert.rejects(devToolsEndpoint(dir, { timeoutMs: 5000, isAlive: () => false }), /exited before/);
});
