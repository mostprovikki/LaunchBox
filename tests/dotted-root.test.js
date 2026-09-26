// claude-scheduler-f4y: res.sendFile(join(ROOT,'public',...)) without { root }
// hands `send` the FULL absolute path, and send's dotfiles:'ignore' rule
// checks every segment of whatever path it is given. So the moment the
// checkout itself sits under a dot-directory (measured: .claude/worktrees/),
// every plain sendFile call 404s — /, /v1 and /v2 all "contain a dotfile" as
// far as `send` is concerned, even though `public/index.html` plainly is not
// one. Passing { root: ROOT } (or an equivalent relative path) makes `send`
// check dotfiles only in the path *relative to root*, which is the only part
// a request can influence.
//
// This suite proves it end to end rather than by inspecting the call sites:
// it copies server.js + lib/ + public/ into a directory that is itself
// dot-prefixed (a real reproduction of the bug's precondition, not a mock of
// it) and boots createApp from there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpData, extensions } from './helpers.js';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(TESTS_DIR);

// node_modules is not copied (it's huge and irrelevant to the bug); instead
// we symlink to whichever ancestor of the repo actually has it, exactly the
// way Node's own bare-specifier resolution would find it by walking up.
function findNodeModules(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, 'node_modules');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('no node_modules found above ' + startDir);
    dir = parent;
  }
}

// Builds a throwaway copy of the app under a directory whose name itself
// starts with '.' — the exact precondition the bug needs. Returns the copy's
// root (== the server.js copy's own ROOT once loaded).
function makeDottedCopy() {
  const dottedParent = join(tmpdir(), '.cs-f4y-dotted');
  mkdirSync(dottedParent, { recursive: true });
  const appDir = mkdtempSync(join(dottedParent, 'app-'));
  cpSync(join(REPO_ROOT, 'lib'), join(appDir, 'lib'), { recursive: true });
  cpSync(join(REPO_ROOT, 'public'), join(appDir, 'public'), { recursive: true });
  cpSync(join(REPO_ROOT, 'server.js'), join(appDir, 'server.js'));
  cpSync(join(REPO_ROOT, 'package.json'), join(appDir, 'package.json'));
  symlinkSync(findNodeModules(REPO_ROOT), join(appDir, 'node_modules'), 'dir');

  // Dotfile-protection control: a real dotfile (and a nested one) planted
  // under the copy's own public/, so the suite can assert `send`'s
  // dotfiles:'ignore' rule still fires for the one path segment a request
  // actually controls — the served-relative path — even after the fix stops
  // it firing on ROOT's own (irrelevant) segments.
  writeFileSync(join(appDir, 'public', '.env'), 'SECRET=should-never-be-served\n');
  mkdirSync(join(appDir, 'public', 'sub'), { recursive: true });
  writeFileSync(join(appDir, 'public', 'sub', '.x'), 'also secret\n');

  assert.match(appDir, /\/\.[^/]+\//, 'sanity: the copy must actually sit under a dot-segment');
  return appDir;
}

async function bootDotted() {
  const appDir = makeDottedCopy();
  const url = (rel) => pathToFileURL(join(appDir, rel)).href;

  const { ensureDirs } = await import(url('lib/paths.js'));
  const { ensureToken } = await import(url('lib/token.js'));
  const { openDb } = await import(url('lib/db.js'));
  const { createRunner } = await import(url('lib/runner.js'));
  const { createScheduler } = await import(url('lib/scheduler.js'));
  const { createAwake } = await import(url('lib/awake.js'));
  const { createApp } = await import(url('server.js'));

  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const spawnFn = () => { throw new Error('no run should be spawned in this suite'); };
  const runner = createRunner({ db, extensions, spawnFn, notifyFn: () => {}, admit: () => null });
  const scheduler = createScheduler({ db, runner, pause: null });
  const awake = createAwake({ db, runner, scheduler, pause: null, spawnFn });
  const token = ensureToken();
  const app = createApp({ db, runner, scheduler, extensions, awake, token });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = () => `http://127.0.0.1:${server.address().port}`;
  return { server, base, appDir };
}

test('GET / returns 200 with the real bytes when the checkout sits under a dot-directory', async (t) => {
  const { server, base } = await bootDotted();
  t.after(() => server.close());

  const res = await fetch(base() + '/');
  assert.equal(res.status, 200, 'GET / must not 404 just because an ancestor directory starts with a dot');
  const body = await res.text();
  assert.match(body, /<title>Scheduler<\/title>/, 'must be the real old-UI markup, not an error/fallback page');
  assert.match(body, /id="usage-chip"/);
});

test('GET /v2 returns 200 with the real bytes when the checkout sits under a dot-directory', async (t) => {
  const { server, base } = await bootDotted();
  t.after(() => server.close());

  const res = await fetch(base() + '/v2', { redirect: 'manual' });
  assert.equal(res.status, 200, 'GET /v2 must not 404 just because an ancestor directory starts with a dot');
  const body = await res.text();
  assert.match(body, /data-theme="dark"/);
  assert.match(body, /<title>LaunchBox<\/title>/);
});

test('/v1 also survives a dotted checkout (third sendFile call site)', async (t) => {
  const { server, base } = await bootDotted();
  t.after(() => server.close());

  const res = await fetch(base() + '/v1');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<title>Scheduler<\/title>/);
});

test('a real subresource referenced by /v2 resolves to actual bytes, not a 404, under a dotted checkout', async (t) => {
  const { server, base } = await bootDotted();
  t.after(() => server.close());

  const shell = await fetch(base() + '/v2', { redirect: 'manual' });
  assert.equal(shell.status, 200);
  const body = await shell.text();
  const href = [...body.matchAll(/<link[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["']/g)]
    .map((m) => m[1])
    .find((h) => !h.startsWith('http'));
  assert.ok(href, 'expected a same-origin stylesheet link in the /v2 shell');

  const resolved = new URL(href, base() + '/v2');
  const assetRes = await fetch(resolved);
  assert.equal(assetRes.status, 200, `${href} -> ${resolved} must resolve under a dotted checkout too`);
  assert.match(assetRes.headers.get('content-type') || '', /text\/css/);
});

test('dotfiles under public/ are still refused — the fix must not weaken that protection', async (t) => {
  const { server, base } = await bootDotted();
  t.after(() => server.close());

  const env = await fetch(base() + '/.env');
  assert.notEqual(env.status, 200, '/.env must not be served, dotted checkout or not');

  const nested = await fetch(base() + '/sub/.x');
  assert.notEqual(nested.status, 200, '/sub/.x must not be served either');
});
