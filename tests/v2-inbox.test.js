// claude-scheduler-btv.22: GET /api/v2/inbox — the cross-project Inbox source.
// Waiting to merge (unmerged scheduler/* branches, every registered project)
// plus handed back (beads whose LATEST run came back handed-back or stranded).
// `count` is the one needs-me number Overview and the nav badge both show.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpData, extensions, fakeSpawn } from './helpers.js';
import { ensureDirs } from '../lib/paths.js';
import { ensureToken } from '../lib/token.js';
import { openDb, createJob, insertRun, updateRun, createProject } from '../lib/db.js';
import { createRunner } from '../lib/runner.js';
import { createScheduler } from '../lib/scheduler.js';
import { parseBeadId } from '../lib/branches.js';
import { createApp } from '../server.js';

let currentToken = null;

async function req(base, path, { token = currentToken } = {}) {
  const res = await fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// branches.list stand-in keyed on repo path — lib/branches.js's own git
// behaviour is covered by tests/branches.test.js; here only the fan-out matters.
function fakeBranches(byPath = {}) {
  return {
    list: async (path) => (byPath[path] ?? []).map((branch) => ({
      branch, beadId: parseBeadId(branch), ahead: 1, behind: 0, shortstat: '1 file changed', tipSha: 'abc1234', tipSubject: 'feat: x', snapshotTip: false,
    })),
  };
}

async function boot({ branches = fakeBranches() } = {}) {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const runner = createRunner({ db, extensions, spawnFn: fakeSpawn(), notifyFn: () => {} });
  const scheduler = createScheduler({ db, runner });
  currentToken = ensureToken();
  const app = createApp({ db, runner, scheduler, extensions, awake: null, branches, token: currentToken });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { db, server, base: () => `http://127.0.0.1:${server.address().port}` };
}

const register = (db, name, path) => createProject(db, { name, path, state: 'active', config: {} });

function beadJob(db, project, beadId) {
  return createJob(db, {
    name: `bead ${beadId}`, type: 'claude', cwd: project.path, schedule: '@manual',
    params: { prompt: 'x', _beadId: beadId, _projectId: project.id },
  });
}

function beadRun(db, job, { outcome, status = 'success', resultText } = {}) {
  const run = insertRun(db, { jobId: job.id, status: 'running', trigger: 'bead' });
  return updateRun(db, run.id, {
    status, finishedAt: new Date().toISOString(), beadOutcome: outcome,
    meta: resultText === undefined ? null : JSON.stringify({ resultText }),
  });
}

test('GET /api/v2/inbox is refused without the bearer token, like every /api/v2 route', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());
  const r = await req(base(), '/api/v2/inbox', { token: '' });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'token_invalid');
  assert.equal((await req(base(), '/api/v2/inbox')).status, 200);
});

test('empty: count 0, both lists empty, asOf stamped', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());
  const r = await req(base(), '/api/v2/inbox');
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 0);
  assert.deepEqual(r.body.waiting, []);
  assert.deepEqual(r.body.handedBack, []);
  assert.ok(!Number.isNaN(Date.parse(r.body.asOf)));
});

test('GET /api/v2/inbox lists a handed-back run with its closing words', async (t) => {
  const { db, server, base } = await boot();
  t.after(() => server.close());
  const p = register(db, 'alpha', '/repo/alpha');
  const long = 'x'.repeat(1000) + 'blocked: no permission to run npm test';
  const run = beadRun(db, beadJob(db, p, 'alpha-1'), { outcome: 'handed-back', status: 'success', resultText: long });
  const r = await req(base(), '/api/v2/inbox');
  assert.equal(r.body.count, 1);
  assert.equal(r.body.handedBack.length, 1);
  const item = r.body.handedBack[0];
  assert.equal(item.kind, 'handed-back');
  assert.equal(item.projectId, p.id);
  assert.equal(item.projectName, 'alpha');
  assert.equal(item.beadId, 'alpha-1');
  assert.equal(item.runId, run.id);
  assert.equal(item.status, 'success');
  assert.equal(item.finishedAt, run.finishedAt);
  assert.equal(item.reason, long.slice(-600));
  assert.equal(item.reason.length, 600);
});

test('a handed-back run with no resultText has reason null', async (t) => {
  const { db, server, base } = await boot();
  t.after(() => server.close());
  const p = register(db, 'alpha', '/repo/alpha');
  beadRun(db, beadJob(db, p, 'alpha-1'), { outcome: 'handed-back', status: 'failed' });
  const r = await req(base(), '/api/v2/inbox');
  assert.equal(r.body.handedBack[0].reason, null);
});

test('a later closed run for the same bead removes it; a non-bead run is ignored', async (t) => {
  const { db, server, base } = await boot();
  t.after(() => server.close());
  const p = register(db, 'alpha', '/repo/alpha');
  const job = beadJob(db, p, 'alpha-1');
  beadRun(db, job, { outcome: 'handed-back', resultText: 'first try failed' });
  beadRun(db, job, { outcome: 'closed', resultText: 'done' });
  const plain = createJob(db, { name: 'plain', type: 'command', cwd: '/tmp', schedule: '@manual', params: { command: 'true' } });
  beadRun(db, plain, { outcome: null, status: 'failed' });
  const r = await req(base(), '/api/v2/inbox');
  assert.equal(r.body.count, 0);
  assert.deepEqual(r.body.handedBack, []);
});

test('a later handed-back run after a closed one DOES appear — latest wins, not any', async (t) => {
  const { db, server, base } = await boot();
  t.after(() => server.close());
  const p = register(db, 'alpha', '/repo/alpha');
  const job = beadJob(db, p, 'alpha-1');
  beadRun(db, job, { outcome: 'closed' });
  const second = beadRun(db, job, { outcome: 'handed-back', resultText: 'reopened' });
  const r = await req(base(), '/api/v2/inbox');
  assert.equal(r.body.handedBack.length, 1);
  assert.equal(r.body.handedBack[0].runId, second.id);
});

test('a stranded run appears with kind "stranded"', async (t) => {
  const { db, server, base } = await boot();
  t.after(() => server.close());
  const p = register(db, 'alpha', '/repo/alpha');
  beadRun(db, beadJob(db, p, 'alpha-2'), { outcome: 'stranded', resultText: 'bd close refused' });
  const r = await req(base(), '/api/v2/inbox');
  assert.equal(r.body.count, 1);
  assert.equal(r.body.handedBack[0].kind, 'stranded');
  assert.equal(r.body.handedBack[0].beadId, 'alpha-2');
});

test('two projects\' branches both appear, and count sums both lists', async (t) => {
  const branches = fakeBranches({
    '/repo/alpha': ['scheduler/alpha-abc--alpha-7'],
    '/repo/beta': ['scheduler/beta-def--beta-3', 'scheduler/beta-def--beta-4'],
  });
  const { db, server, base } = await boot({ branches });
  t.after(() => server.close());
  const a = register(db, 'alpha', '/repo/alpha');
  const b = register(db, 'beta', '/repo/beta');
  beadRun(db, beadJob(db, a, 'alpha-1'), { outcome: 'handed-back' });
  const r = await req(base(), '/api/v2/inbox');
  assert.equal(r.body.waiting.length, 3);
  assert.equal(r.body.count, 4);
  assert.equal(r.body.count, r.body.waiting.length + r.body.handedBack.length);
  const alpha = r.body.waiting.find((w) => w.projectId === a.id);
  assert.equal(alpha.projectName, 'alpha');
  assert.equal(alpha.beadId, 'alpha-7');
  assert.equal(alpha.branch, 'scheduler/alpha-abc--alpha-7');
  assert.equal(alpha.ahead, 1);
  assert.equal(alpha.shortstat, '1 file changed');
  assert.deepEqual(r.body.waiting.filter((w) => w.projectId === b.id).map((w) => w.beadId).sort(), ['beta-3', 'beta-4']);
});

test('one project git cannot read does not hide the others; the failure is reported, not swallowed', async (t) => {
  const ok = fakeBranches({ '/repo/beta': ['scheduler/beta-def--beta-3'] });
  const branches = { list: async (path) => { if (path === '/repo/alpha') throw new Error('not a git repo'); return ok.list(path); } };
  const { db, server, base } = await boot({ branches });
  t.after(() => server.close());
  const a = register(db, 'alpha', '/repo/alpha');
  register(db, 'beta', '/repo/beta');
  const r = await req(base(), '/api/v2/inbox');
  assert.equal(r.status, 200);
  assert.equal(r.body.waiting.length, 1);
  assert.equal(r.body.errors.length, 1);
  assert.equal(r.body.errors[0].projectId, a.id);
  assert.match(r.body.errors[0].error, /not a git repo/);
});

test('with no branches engine the route is 501, never a silently short count', async (t) => {
  const { server, base } = await boot({ branches: null });
  t.after(() => server.close());
  assert.equal((await req(base(), '/api/v2/inbox')).status, 501);
});

// --- titles (claude-scheduler-btv.26) ------------------------------------
// The Inbox titled handed-back rows by short id ("9zq.4") and waiting rows by
// the tip subject. The title comes from the bead's job row — written on every
// run from the beads graph — so a 15s poll costs no bd call per row.

function titledJob(db, project, beadId, { title, name } = {}) {
  return createJob(db, {
    name: name ?? `${project.name}: ${title ?? beadId}`, type: 'claude', cwd: project.path, schedule: '@manual',
    params: { prompt: 'x', _beadId: beadId, _projectId: project.id, ...(title === undefined ? {} : { _beadTitle: title }) },
  });
}

test('titles: a handed-back row carries the bead title from its job row', async (t) => {
  const { db, server, base } = await boot();
  t.after(() => server.close());
  const p = register(db, 'repo', '/r/repo');
  beadRun(db, titledJob(db, p, 'rp-1', { title: 'Fix the: colon title', name: 'repo: truncated…' }), { outcome: 'handed-back' });
  const [row] = (await req(base(), '/api/v2/inbox')).body.handedBack;
  assert.equal(row.title, 'Fix the: colon title', '_beadTitle wins over the (truncatable) job name');
});

test('titles: a job row minted before _beadTitle falls back to its name, minus the project prefix', async (t) => {
  const { db, server, base } = await boot();
  t.after(() => server.close());
  const p = register(db, 'repo', '/r/repo');
  beadRun(db, titledJob(db, p, 'rp-1', { name: 'repo: Old bead title' }), { outcome: 'handed-back' });
  beadRun(db, titledJob(db, p, 'rp-2', { name: 'renamed: something' }), { outcome: 'stranded' });
  const rows = (await req(base(), '/api/v2/inbox')).body.handedBack;
  const by = Object.fromEntries(rows.map((r) => [r.beadId, r.title]));
  assert.equal(by['rp-1'], 'Old bead title');
  assert.equal(by['rp-2'], null, 'a name that does not carry the project prefix is not a title — the UI falls back');
});

test('titles: a waiting row carries the title of its bead; a branch with no job row has none', async (t) => {
  const p0 = { path: '/r/repo' };
  const branches = fakeBranches({ [p0.path]: ['scheduler/repo-1a2b--rp-1', 'scheduler/repo-1a2b--rp-9'] });
  const { db, server, base } = await boot({ branches });
  t.after(() => server.close());
  const p = register(db, 'repo', p0.path);
  titledJob(db, p, 'rp-1', { title: 'Waiting bead title' });
  const rows = (await req(base(), '/api/v2/inbox')).body.waiting;
  const by = Object.fromEntries(rows.map((r) => [r.beadId, r.title]));
  assert.equal(by['rp-1'], 'Waiting bead title');
  assert.equal(by['rp-9'], null);
});
