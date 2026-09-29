// claude-scheduler-btv.23: POST /api/v2/projects/:id/beads/:beadId/hold.
// A handed-back bead is already open and back in `bd ready`, so the scheduler
// retries it on its own; Hold is how the owner stops that — `bd defer` for
// 7 days — and it takes the bead out of GET /api/v2/inbox's handedBack.
//
// Order is validate → authorize → write: every refusal below asserts the fake
// bd was never invoked, so a refused hold leaves no partial state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpData, extensions, fakeSpawn, fakeBd } from './helpers.js';
import { ensureDirs } from '../lib/paths.js';
import { ensureToken } from '../lib/token.js';
import { openDb, createJob, insertRun, updateRun, createProject } from '../lib/db.js';
import { createRunner } from '../lib/runner.js';
import { createScheduler } from '../lib/scheduler.js';
import { createBeads } from '../lib/beads.js';
import { recordHold } from '../lib/inbox.js';
import { createApp } from '../server.js';

const DAY_MS = 24 * 60 * 60 * 1000;
let currentToken = null;

async function boot({ defer = { stdout: '[]' } } = {}) {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const bd = fakeBd({ defer });
  const beads = createBeads({ db, execFileFn: bd });
  const runner = createRunner({ db, extensions, spawnFn: fakeSpawn(), notifyFn: () => {} });
  const scheduler = createScheduler({ db, runner });
  currentToken = ensureToken();
  // projects only has to be non-null for needProjects(); the hold route never polls.
  const app = createApp({
    db, runner, scheduler, extensions, awake: null, beads, projects: { stop() {} },
    branches: { list: async () => [] }, token: currentToken,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { db, bd, server, base: () => `http://127.0.0.1:${server.address().port}` };
}

async function call(base, method, path, { token = currentToken } = {}) {
  // POSTs carry JSON: the server 415s a body-less POST before it looks at the token.
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) };
  const res = await fetch(base + path, { method, headers, body: method === 'POST' ? '{}' : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const register = (db, name, path) => createProject(db, {
  name, path, beadsDir: join(path, '.beads'), state: 'active', config: {},
});

function handBack(db, project, beadId, { finishedAt = new Date().toISOString() } = {}) {
  const job = createJob(db, {
    name: `bead ${beadId}`, type: 'claude', cwd: project.path, schedule: '@manual',
    params: { prompt: 'x', _beadId: beadId, _projectId: project.id },
  });
  const run = insertRun(db, { jobId: job.id, status: 'running', trigger: 'bead' });
  updateRun(db, run.id, { status: 'success', finishedAt, beadOutcome: 'handed-back', meta: null });
  return job;
}

const holdPath = (p, beadId) => `/api/v2/projects/${encodeURIComponent(p)}/beads/${encodeURIComponent(beadId)}/hold`;

test('hold defers the bead and drops it from the inbox', async (t) => {
  const { db, bd, server, base } = await boot();
  t.after(() => server.close());
  const p = register(db, 'alpha', '/repo/alpha');
  handBack(db, p, 'alpha-1');
  handBack(db, p, 'alpha-2');
  assert.equal((await call(base(), 'GET', '/api/v2/inbox')).body.handedBack.length, 2);

  const before = Date.now();
  const r = await call(base(), 'POST', holdPath(p.id, 'alpha-1'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.beadId, 'alpha-1');

  // One bd call, argv only, pointed at THIS project's database.
  assert.equal(bd.calls.length, 1);
  const { args, opts, env } = bd.calls[0];
  assert.equal(args[0], 'defer');
  assert.equal(args[1], 'alpha-1');
  const until = args[args.indexOf('--until') + 1];
  const ahead = Date.parse(until) - before;
  assert.ok(ahead >= 7 * DAY_MS - 1000 && ahead <= 7 * DAY_MS + 5000, `until ${until} is not now + 7 days`);
  assert.equal(r.body.until, until);
  assert.equal(opts.cwd, '/repo/alpha');
  assert.equal(env.BEADS_DIR, '/repo/alpha/.beads');

  const inbox = (await call(base(), 'GET', '/api/v2/inbox')).body;
  assert.deepEqual(inbox.handedBack.map((h) => h.beadId), ['alpha-2']);
  assert.equal(inbox.count, 1);
});

test('a hand-back AFTER the hold shows again — the hold covers the run it was placed on, not every later one', async (t) => {
  const { db, server, base } = await boot();
  t.after(() => server.close());
  const p = register(db, 'alpha', '/repo/alpha');
  handBack(db, p, 'alpha-1', { finishedAt: new Date(Date.now() - 60_000).toISOString() });
  assert.equal((await call(base(), 'POST', holdPath(p.id, 'alpha-1'))).status, 200);
  assert.equal((await call(base(), 'GET', '/api/v2/inbox')).body.handedBack.length, 0);
  handBack(db, p, 'alpha-1', { finishedAt: new Date(Date.now() + 60_000).toISOString() });
  assert.deepEqual((await call(base(), 'GET', '/api/v2/inbox')).body.handedBack.map((h) => h.beadId), ['alpha-1']);
});

test('the same bead id in another project is not held by this one', async (t) => {
  const { db, server, base } = await boot();
  t.after(() => server.close());
  const a = register(db, 'alpha', '/repo/alpha');
  const b = register(db, 'beta', '/repo/beta');
  handBack(db, a, 'x-1');
  handBack(db, b, 'x-1');
  assert.equal((await call(base(), 'POST', holdPath(a.id, 'x-1'))).status, 200);
  const inbox = (await call(base(), 'GET', '/api/v2/inbox')).body;
  assert.deepEqual(inbox.handedBack.map((h) => h.projectId), [b.id]);
});

test('refused before bd runs: missing or invalid token', async (t) => {
  const { db, bd, server, base } = await boot();
  t.after(() => server.close());
  const p = register(db, 'alpha', '/repo/alpha');
  handBack(db, p, 'alpha-1');
  for (const token of ['', 'not-the-token']) {
    const r = await call(base(), 'POST', holdPath(p.id, 'alpha-1'), { token });
    assert.equal(r.status, 401);
  }
  assert.equal(bd.calls.length, 0);
  assert.equal((await call(base(), 'GET', '/api/v2/inbox')).body.handedBack.length, 1);
});

test('refused before bd runs: unknown project', async (t) => {
  const { db, bd, server, base } = await boot();
  t.after(() => server.close());
  const p = register(db, 'alpha', '/repo/alpha');
  handBack(db, p, 'alpha-1');
  const r = await call(base(), 'POST', holdPath('no-such-project', 'alpha-1'));
  assert.equal(r.status, 404);
  assert.equal(bd.calls.length, 0);
});

test('refused before bd runs: a bead id from another project\'s prefix', async (t) => {
  const { db, bd, server, base } = await boot();
  t.after(() => server.close());
  const a = register(db, 'alpha', '/repo/alpha');
  const b = register(db, 'beta', '/repo/beta');
  handBack(db, a, 'alpha-1');
  handBack(db, b, 'beta-1');
  // beta-1 is a real bead — in beta's graph. Holding it "in alpha" would run
  // `bd defer beta-1` against alpha's database.
  const r = await call(base(), 'POST', holdPath(a.id, 'beta-1'));
  assert.equal(r.status, 404);
  assert.equal(bd.calls.length, 0);
});

test('refused before bd runs: a bead id bd would read as a flag', async (t) => {
  const { db, bd, server, base } = await boot();
  t.after(() => server.close());
  const p = register(db, 'alpha', '/repo/alpha');
  handBack(db, p, '--help');
  for (const id of ['--help', 'alpha-1 --until=never', '']) {
    const r = await call(base(), 'POST', holdPath(p.id, id || ' '));
    assert.ok(r.status === 400 || r.status === 404, `${JSON.stringify(id)} → ${r.status}`);
  }
  assert.equal(bd.calls.length, 0);
});

test('bd refusing the defer is a 502 and the bead stays in the inbox', async (t) => {
  const { db, bd, server, base } = await boot({ defer: { code: 1, stderr: 'Error: issue not found' } });
  t.after(() => server.close());
  const p = register(db, 'alpha', '/repo/alpha');
  handBack(db, p, 'alpha-1');
  const r = await call(base(), 'POST', holdPath(p.id, 'alpha-1'));
  assert.equal(r.status, 502);
  assert.match(r.body.error, /not found/);
  assert.equal(bd.calls.length, 1);
  assert.equal((await call(base(), 'GET', '/api/v2/inbox')).body.handedBack.length, 1);
});

test('a busy beads database is a 503 and the bead stays in the inbox', async (t) => {
  const { db, server, base } = await boot({ defer: { timeout: true } });
  t.after(() => server.close());
  const p = register(db, 'alpha', '/repo/alpha');
  handBack(db, p, 'alpha-1');
  const r = await call(base(), 'POST', holdPath(p.id, 'alpha-1'));
  assert.equal(r.status, 503);
  assert.equal(r.body.busy, true);
  assert.equal((await call(base(), 'GET', '/api/v2/inbox')).body.handedBack.length, 1);
});

test('a lapsed hold stops hiding the bead — it mirrors a defer that has run out', async (t) => {
  const { db, server, base } = await boot();
  t.after(() => server.close());
  const p = register(db, 'alpha', '/repo/alpha');
  handBack(db, p, 'alpha-1', { finishedAt: new Date(Date.now() - 9 * DAY_MS).toISOString() });
  recordHold(db, p.id, 'alpha-1', {
    at: new Date(Date.now() - 8 * DAY_MS).toISOString(),
    until: new Date(Date.now() - DAY_MS).toISOString(),
  });
  assert.deepEqual((await call(base(), 'GET', '/api/v2/inbox')).body.handedBack.map((h) => h.beadId), ['alpha-1']);
});
