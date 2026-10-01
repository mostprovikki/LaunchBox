// Cutover (claude-scheduler-axg): v2 must stand alone once the old public/ root
// is deleted. These tests pin v2's dependencies on files outside public/v2/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpData, extensions } from './helpers.js';
import { ensureDirs } from '../lib/paths.js';
import { ensureToken } from '../lib/token.js';
import { openDb } from '../lib/db.js';
import { createRunner } from '../lib/runner.js';
import { createScheduler } from '../lib/scheduler.js';
import { createAwake } from '../lib/awake.js';
import { createApp } from '../server.js';

async function boot() {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const spawnFn = () => { throw new Error('no run should be spawned in this suite'); };
  const runner = createRunner({ db, extensions, spawnFn, notifyFn: () => {}, admit: () => null });
  const scheduler = createScheduler({ db, runner, pause: null });
  const awake = createAwake({ db, runner, scheduler, pause: null, spawnFn });
  const app = createApp({ db, runner, scheduler, extensions, awake, token: ensureToken() });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { server, db, base: `http://127.0.0.1:${server.address().port}` };
}

test('v2 favicon is served from v2 assets', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());

  const doc = await fetch(base + '/v2', { redirect: 'manual' });
  assert.equal(doc.status, 200);
  const m = (await doc.text()).match(/<link[^>]*rel="icon"[^>]*href="([^"]+)"/);
  assert.ok(m, 'v2 index must link a favicon');
  const url = new URL(m[1], base + '/v2');
  // The old public/favicon.svg goes away with the old UI (C3).
  assert.match(url.pathname, /^\/v2\/assets\//, `favicon must live under /v2/assets/, got ${url.pathname}`);
  const res = await fetch(url, { redirect: 'manual' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /^image\/svg\+xml/);
});

// C2 (claude-scheduler-axg.4): the switch is gone. `/` is v2 with no setting
// consulted, and an old `/v1` link fails loudly instead of serving a page
// that is about to be deleted.
test('/v1 answers 410 Gone and points at /', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());

  const res = await fetch(base + '/v1', { redirect: 'manual' });
  assert.equal(res.status, 410);
  const body = await res.text();
  assert.match(body, /href="\/"/, '410 body must link to /');
  assert.doesNotMatch(body, /<title>Scheduler<\/title>/, 'must not be the old UI');
});

test('/ serves v2 even with a stale v2Default=0 left in settings', async (t) => {
  const { server, base, db } = await boot();
  t.after(() => server.close());
  // A DB written before C2 may still carry the flag OFF; it must not matter.
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('v2Default', '0')").run();

  const res = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<title>LaunchBox<\/title>/);
});

test('the ui-default switch and uiDefault setting are gone', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());
  const headers = { Authorization: `Bearer ${ensureToken()}`, 'Content-Type': 'application/json' };

  const put = await fetch(base + '/api/ui-default', { method: 'PUT', headers, body: JSON.stringify({ ui: 'v1' }) });
  assert.equal(put.status, 404);
  const settings = await (await fetch(base + '/api/settings', { headers })).json();
  assert.equal('uiDefault' in settings, false);
});

// C4 (claude-scheduler-axg.5): the tools that compared or captured the old UI
// are gone, and the screenshot harness captures v2 — every route the qa:v2
// walk knows about, in both themes, read from V2_ROUTES rather than retyped.
test('the parity gate is retired', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal('qa:v2:parity' in pkg.scripts, false);
  assert.ok(pkg.scripts['qa:v2'] && pkg.scripts['qa:v2:interactions'], 'qa:v2 and qa:v2:interactions stay');
  assert.equal(existsSync(new URL('../tools/qa/v2-parity.mjs', import.meta.url)), false);
});

test('screenshot harness captures every v2 route in both themes, and nothing of the old UI', async () => {
  const { shots } = await import('../tools/screenshots/shots.mjs');
  const { V2_ROUTES } = await import('../tools/qa/audit-rules.mjs');
  const files = new Set(shots.map((s) => s.file));
  for (const r of V2_ROUTES) {
    for (const theme of ['dark', 'light']) {
      assert.ok(files.has(`${r.name}-${theme}`), `missing shot ${r.name}-${theme}`);
    }
  }
  for (const f of ['capture.mjs', 'shots.mjs']) {
    const src = await readFile(new URL(`../tools/screenshots/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /public\/style\.css/, `${f} still names the old stylesheet`);
    // Old-UI-only ids: none of these exist under public/v2.
    assert.doesNotMatch(src, /#(runs-list|pause-seg|log-drawer|awake-menu|log-close)\b/, `${f} drives old-UI selectors`);
  }
});
