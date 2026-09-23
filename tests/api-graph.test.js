// tests/api-graph.test.js — GET /api/v2/projects/:id/graph.html
// (claude-scheduler-vo4.4, Phase A of the beads visualizer).
//
// The endpoint serves bd's own graph page, which is why the interesting
// assertions are about what the response does NOT contain and what the browser
// is told it may do: no off-box origin survives, and the CSP that contains the
// page's inline script is asserted against the SERVED constant rather than a
// retyped copy of it — a retyped expectation only proves the test agrees with
// itself.
//
// The boot helper below is tests/api.test.js's `bootWithProjects` — the real
// projects/beads engine behind a fake `bd`, since no test may shell out to the
// real binary. It is duplicated rather than imported because api.test.js
// exports nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpData, fakeSpawn, fakeBd, extensions } from './helpers.js';
import { ensureDirs } from '../lib/paths.js';
import { ensureToken } from '../lib/token.js';
import { openDb, createProject } from '../lib/db.js';
import { createBeads } from '../lib/beads.js';
import { createProjects } from '../lib/projects.js';
import { createRunner } from '../lib/runner.js';
import { createScheduler } from '../lib/scheduler.js';
import { createApp, GRAPH_CSP } from '../server.js';
import { LOCAL_D3_SRC, D3_CDN_SRC } from '../lib/beads-graph.js';

const BD_VERSION = 'bd version 1.1.0 (Homebrew)';
const PROJECT_CONFIG = {
  autoLabel: 'unattended', enabled: true, cwd: '.', maxConcurrent: 1,
  defaults: { timeoutMin: 30, model: 'default', notify: 'failure' },
};

// bd's page in the shape that matters here: its script reference is the CDN
// one, and its own script is inline (which is exactly why the CSP has to allow
// 'unsafe-inline' and then take the network away).
const BD_PAGE = [
  '<!doctype html><html><head><title>beads graph</title>',
  `<script src="${D3_CDN_SRC}"></script>`,
  '</head><body><svg id="g"></svg>',
  '<script>const data = {"nodes":[{"id":"x","title":"a bead"}]};</script>',
  '</body></html>',
].join('');

let currentToken = null;

async function bootWithProjects({ handlers = {} } = {}) {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const spawnFn = fakeSpawn();
  const bd = fakeBd({
    '--version': { stdout: BD_VERSION },
    where: { stdout: JSON.stringify({ path: '/repo/.beads', database_path: '/repo/.beads/embeddeddolt' }) },
    ...handlers,
  });
  const beads = createBeads({ db, execFileFn: bd });
  const runner = createRunner({ db, extensions, spawnFn, notifyFn: () => {} });
  const scheduler = createScheduler({ db, runner });
  const projects = createProjects({
    db,
    beads,
    runner,
    fsx: { readdir: async () => [], readFile: async () => { throw new Error('ENOENT'); } },
  });
  currentToken = ensureToken();
  const app = createApp({ db, runner, scheduler, extensions, awake: null, projects, beads, token: currentToken });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return {
    db, bd, beads, projects, server,
    base: () => `http://127.0.0.1:${server.address().port}`,
    close() { projects.stop(); server.close(); },
  };
}

const registerProject = (db, over = {}) => createProject(db, {
  name: 'repo', path: '/repo', beadsDir: '/repo/.beads',
  state: 'active', config: PROJECT_CONFIG, ...over,
});

const get = (base, path) => fetch(base + path, { headers: { Authorization: `Bearer ${currentToken}` } });

test('the graph page is served localised, under the locked-down CSP', async (t) => {
  const { db, server, base, close } = await bootWithProjects({ handlers: { graph: { stdout: BD_PAGE } } });
  t.after(() => close());
  void server;
  const p = registerProject(db);

  const res = await get(base(), `/api/v2/projects/${p.id}/graph.html`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  // Asserted against the exported constant, not a retyped string.
  assert.equal(res.headers.get('content-security-policy'), GRAPH_CSP);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  const body = await res.text();
  assert.ok(!body.includes('d3js.org'), 'the CDN reference must not survive');
  assert.ok(body.includes(LOCAL_D3_SRC), 'the vendored copy must be referenced instead');
  assert.ok(body.includes('a bead'), "bd's own page content is what is served");
});

// The CSP is the containment, so its load-bearing clauses are pinned
// individually: allowing inline script is only survivable because the page can
// reach no network at all.
test('the CSP takes the network away from the inline script it must allow', async (t) => {
  const { db, server, base, close } = await bootWithProjects({ handlers: { graph: { stdout: BD_PAGE } } });
  t.after(() => close());
  void server;
  const p = registerProject(db);

  const res = await get(base(), `/api/v2/projects/${p.id}/graph.html`);
  await res.text();
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /connect-src 'none'/, 'injected script must have nowhere to send anything');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /img-src 'none'/);
  assert.ok(!/script-src[^;]*https?:/.test(csp), 'no off-box script origin may be allowed');
});

test('an unknown project is 404, not an empty graph', async (t) => {
  const { server, base, close, bd } = await bootWithProjects({ handlers: { graph: { stdout: BD_PAGE } } });
  t.after(() => close());
  void server;

  const res = await get(base(), '/api/v2/projects/nope/graph.html');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not found' });
  // And no bd ran: an id that resolves to no row must not reach the binary.
  assert.ok(!bd.calls.some((c) => c.sub === 'graph'), 'bd must not be invoked for an unknown project');
});

test('a busy beads database is 503 busy, not a failure', async (t) => {
  const { db, server, base, close } = await bootWithProjects({ handlers: { graph: { timeout: true } } });
  t.after(() => close());
  void server;
  const p = registerProject(db);

  const res = await get(base(), `/api/v2/projects/${p.id}/graph.html`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.busy, true);
  assert.match(body.error, /busy/i);
});

test('bd failing, or emitting a page that cannot be localised, is 502', async (t) => {
  const { db, server, base, close } = await bootWithProjects({
    handlers: { graph: { code: 1, stderr: 'no beads database here' } },
  });
  t.after(() => close());
  void server;
  const p = registerProject(db);

  let res = await get(base(), `/api/v2/projects/${p.id}/graph.html`);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /no beads database here/);

  // A page carrying an origin the localiser does not know how to make local is
  // refused rather than served — the same 502, from the other collaborator.
  const evil = await bootWithProjects({
    handlers: { graph: { stdout: '<script src="https://evil.example.com/x.js"></script>' } },
  });
  t.after(() => evil.close());
  const p2 = registerProject(evil.db);
  res = await get(evil.base(), `/api/v2/projects/${p2.id}/graph.html`);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /evil\.example\.com/);
});

test('bd is invoked in the stored row’s path, never one named by the request', async (t) => {
  const { db, server, base, close, bd } = await bootWithProjects({ handlers: { graph: { stdout: BD_PAGE } } });
  t.after(() => close());
  void server;
  const p = registerProject(db, { path: '/repo', beadsDir: '/repo/.beads' });

  const res = await get(base(), `/api/v2/projects/${p.id}/graph.html`);
  await res.text();
  const call = bd.calls.find((c) => c.sub === 'graph');
  assert.ok(call, 'bd graph should have run');
  assert.equal(call.opts.cwd, '/repo');
  assert.equal(call.env.BEADS_DIR, '/repo/.beads');
  // Read-only, and the whole graph: no write subcommand, no label filter.
  assert.deepEqual(call.args, ['graph', '--all', '--html']);
});
