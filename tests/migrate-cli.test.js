// Drives the real bin against a fixture via LB_HOME
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureInstall, tmpDir } from './helpers.js';

const BIN = new URL('../bin/launchbox.mjs', import.meta.url).pathname;

// A port nothing listens on, so the daemon probe never hits the live daemon (F9).
const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const PORT = String(await freePort());

// Async (not execFileSync) so an in-process HTTP server can answer the bin's probe.
const run = (args, home, extraEnv = {}) => new Promise((resolve) => {
  execFile(process.execPath, [BIN, ...args], {
    env: { ...process.env, LB_HOME: home, LB_DATA: '', CS_DATA: '', LB_PORT: PORT, CS_PORT: '', ...extraEnv }, encoding: 'utf8',
  }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }));
});
const cli = (args, home, extraEnv) => run(['migrate', ...args], home, extraEnv);

test('--dry-run reports, prints state: ready, exits 0 and writes nothing', async () => {
  const { root, newDir } = fixtureInstall();
  const r = await cli(['--dry-run'], root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /state: ready/);
  assert.match(r.out, /runs\.logPath\s+1/);
  assert.equal(existsSync(newDir), false);
});

test('migrate moves the fixture install; a re-run exits 0 saying already', async () => {
  const { root, newDir } = fixtureInstall();
  const r = await cli([], root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /migrated/);
  assert.ok(existsSync(`${newDir}/launchbox.db`));
  const again = await cli([], root);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /already/);
});

test('a refused migrate exits 1', async () => {
  const { root, oldDir } = fixtureInstall({ live: { run: true } });
  const r = await cli([], root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /refused: a run is running or queued/);
  assert.equal(lstatSync(oldDir).isSymbolicLink(), false);
});

// F3: a stray CS_DATA must not become the move target.
test('migrate refuses while LB_DATA/CS_DATA is set, and moves nothing', async () => {
  const { root, oldDir, newDir } = fixtureInstall();
  const stray = tmpDir();
  for (const k of ['CS_DATA', 'LB_DATA']) {
    const r = await cli([], root, { [k]: stray });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /unset LB_DATA\/CS_DATA before migrating/);
  }
  assert.equal(lstatSync(oldDir).isSymbolicLink(), false);
  assert.ok(existsSync(join(oldDir, 'scheduler.db')));
  assert.equal(existsSync(newDir), false);
  assert.equal(existsSync(join(stray, 'scheduler.db')), false);
});

// F8: the daemon may be on the port it wrote, not the default/env one.
test('migrate refuses when a daemon answers on the port in <oldDir>/port', async () => {
  const { root, oldDir } = fixtureInstall();
  const srv = createServer((q, s) => s.end('ok'));
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  writeFileSync(join(oldDir, 'port'), String(srv.address().port));
  try {
    const r = await cli(['--dry-run'], root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /daemon is running/);
  } finally { await new Promise((res) => srv.close(res)); }
});

// F2: url/token/open before migrate must not create the new dir.
for (const sub of ['url', 'token', 'open']) {
  test(`launchbox ${sub} on a legacy-only install exits 1 with the guard message and creates nothing`, async () => {
    const { root, newDir } = fixtureInstall();
    const r = await run([sub], root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /launchbox migrate/);
    assert.equal(existsSync(newDir), false);
  });
}
