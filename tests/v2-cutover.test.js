// Cutover (claude-scheduler-axg): v2 must stand alone once the old public/ root
// is deleted. These tests pin v2's dependencies on files outside public/v2/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
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
  return { server, base: `http://127.0.0.1:${server.address().port}` };
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
