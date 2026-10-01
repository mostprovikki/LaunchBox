// QA sandbox ports (claude-scheduler-9u2). The gates used to bind a fixed
// 43410 and accept ANY 200 there as their own sandbox — so a concurrent
// worktree run's server was driven and its results reported as ours.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qaPort, assertPortFree, waitForOwnSandbox } from '../tools/qa/sandbox-port.mjs';

const primary = () => { const d = mkdtempSync(join(tmpdir(), 'qa-prim-')); mkdirSync(join(d, '.git')); return d; };
const linked = () => { const d = mkdtempSync(join(tmpdir(), 'qa-wt-')); writeFileSync(join(d, '.git'), 'gitdir: /x\n'); return d; };

test('primary checkout uses the QA slots 43410-43412, one per tool', () => {
  const repo = primary();
  assert.equal(qaPort('route-walk', { env: {}, repo }), 43410);
  assert.equal(qaPort('interactions', { env: {}, repo }), 43411);
  assert.equal(qaPort('screenshots', { env: {}, repo }), 43412);
});

test('worktree instance k uses 43450+10k plus the tool offset', () => {
  const repo = linked();
  assert.equal(qaPort('route-walk', { env: { CS_INSTANCE: '0' }, repo }), 43450);
  assert.equal(qaPort('interactions', { env: { CS_INSTANCE: '2' }, repo }), 43471);
  assert.equal(qaPort('screenshots', { env: { CS_INSTANCE: '4' }, repo }), 43492);
});

test('a linked worktree without CS_INSTANCE refuses rather than taking the primary slot', () => {
  assert.throws(() => qaPort('interactions', { env: {}, repo: linked() }), /CS_INSTANCE/);
});

test('CS_INSTANCE outside 0-4, or junk, is refused', () => {
  for (const v of ['5', '-1', '1.5', 'x', '']) {
    assert.throws(() => qaPort('interactions', { env: { CS_INSTANCE: v }, repo: linked() }), /CS_INSTANCE/, v);
  }
});

test('unknown tool role is refused', () => {
  assert.throws(() => qaPort('nope', { env: {}, repo: primary() }), /role/);
});

test('assertPortFree fails fast on a listening port and names the holder', async () => {
  const s = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const { port } = s.address();
  try {
    await assert.rejects(assertPortFree(port), (e) => {
      assert.match(e.message, new RegExp(`${port}.*already in use`));
      assert.match(e.message, new RegExp(`pid ${process.pid}`), 'names the PID holding it');
      return true;
    });
  } finally { s.close(); }
  await assertPortFree(port); // freed → passes
});

// A stand-in for server.js: answers 200 on / and writes $CS_DATA/port on listen.
function fakeServer({ port, dataDir, writePortFile = true }) {
  const code = `
    const http = require('http'), fs = require('fs'), path = require('path');
    http.createServer((q, r) => r.end('ok')).listen(${port}, '127.0.0.1', () => {
      ${writePortFile ? `fs.writeFileSync(path.join(${JSON.stringify(dataDir)}, 'port'), '${port}\\n');` : ''}
    });`;
  return spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
}
const freePort = () => new Promise((res) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

test('waitForOwnSandbox resolves once its own child wrote the port file and answers', async () => {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'qa-own-'));
  const child = fakeServer({ port, dataDir });
  try {
    await waitForOwnSandbox({ child, dataDir, port, timeoutMs: 10_000 });
  } finally { child.kill(); }
});

test('a 200 from a server that is not ours is NOT readiness', async () => {
  // Someone else answers on the port; our sandbox dir never gets a port file.
  const port = await freePort();
  const otherDir = mkdtempSync(join(tmpdir(), 'qa-other-'));
  const ourDir = mkdtempSync(join(tmpdir(), 'qa-ours-'));
  const other = fakeServer({ port, dataDir: otherDir });
  const ours = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(waitForOwnSandbox({ child: ours, dataDir: ourDir, port, timeoutMs: 1500 }), /port file|sandbox/);
  } finally { other.kill(); ours.kill(); }
});

test('our child exiting (e.g. EADDRINUSE) rejects at once, not at the timeout', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qa-exit-'));
  const child = spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'ignore' });
  const t0 = Date.now();
  await assert.rejects(waitForOwnSandbox({ child, dataDir, port: 1, timeoutMs: 20_000 }), /exited/);
  assert.ok(Date.now() - t0 < 5000, 'fails fast');
});

test('the restated PORT_BASE matches lib/paths.js', async () => {
  const { PORT_BASE } = await import('../lib/paths.js');
  assert.equal(qaPort('route-walk', { env: {}, repo: primary() }), PORT_BASE + 10);
});
