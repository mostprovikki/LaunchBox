// tests/review-api.test.js — the review queue's three routes:
//   GET    /api/v2/projects/:id/branches
//   POST   /api/v2/projects/:id/branches/:name/merge
//   DELETE /api/v2/projects/:id/branches/:name
//
// Real git in a temp repo, not a fake: fast-forward-ness, dirtiness and "this
// branch does not exist" are git's semantics, and a double that agrees with my
// reading of them proves only that I typed my reading twice (same reasoning as
// tests/branches.test.js).
//
// The two collaborators that ARE doubled:
//   * bd — `fakeBd`, because no test may shell out to the real binary. Its
//     `show` output is where the bead title and the evidence note come from.
//   * the approval layer — `recordingApprover` (copied from
//     tests/approval-resend.test.js), because one entry in `asked` is one Touch
//     ID sheet the owner would have been shown. Both mutations are gated, so
//     "was the user asked, and asked for WHAT" is asserted, not assumed.
//
// The load-bearing safety property has its own test: `:name` is the branch
// WITHOUT the `scheduler/` prefix and the server prepends it, so no request can
// name a branch outside `scheduler/*`. It is asserted from the consumer's
// position — the request Chrome would send — and by the state of the repo
// afterwards, not only by the status code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tmpData, fakeSpawn, fakeBd, extensions } from './helpers.js';
import { ensureDirs } from '../lib/paths.js';
import { ensureToken } from '../lib/token.js';
import { openDb, createProject } from '../lib/db.js';
import { createBeads } from '../lib/beads.js';
import { createProjects } from '../lib/projects.js';
import { createRunner } from '../lib/runner.js';
import { createScheduler } from '../lib/scheduler.js';
import { createBranches } from '../lib/branches.js';
import { createApp } from '../server.js';

// ------------------------------------------------------------- a real repo

const g = (cwd, ...args) => execFileSync(
  'git',
  ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8' },
);

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'cs-review-api-'));
  g(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  g(dir, 'add', 'a.txt');
  g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function branchWithCommit(dir, name, file, msg) {
  g(dir, 'checkout', '-q', '-b', name);
  writeFileSync(join(dir, file), `${msg}\n`);
  g(dir, 'add', file);
  g(dir, 'commit', '-q', '-m', msg);
  g(dir, 'checkout', '-q', 'main');
}

const mainCount = (dir) => Number(g(dir, 'rev-list', '--count', 'main').trim());

// -------------------------------------------------------------- the server

const PROJECT_CONFIG = {
  autoLabel: 'unattended', enabled: true, cwd: '.', maxConcurrent: 1,
  defaults: { timeoutMin: 30, model: 'default', notify: 'failure' },
};

// One entry in `asked` = one system dialog. Copied from
// tests/approval-resend.test.js rather than imported: that file exports nothing.
function recordingApprover(answer) {
  const asked = [];
  return {
    asked,
    available: () => ({ ok: true, degraded: false, platform: 'darwin' }),
    request: async (spec) => {
      asked.push(spec);
      return typeof answer === 'function' ? answer(spec, asked.length) : answer;
    },
    events: new EventEmitter(),
  };
}

let currentToken = null;

async function boot({ show = { stdout: '[]' }, approvalAnswer = { ok: true }, withBranches = true } = {}) {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const bd = fakeBd({
    '--version': { stdout: 'bd version 1.1.0 (Homebrew)' },
    where: { stdout: JSON.stringify({ path: '/repo/.beads', database_path: '/repo/.beads/embeddeddolt' }) },
    show,
  });
  const beads = createBeads({ db, execFileFn: bd });
  const runner = createRunner({ db, extensions, spawnFn: fakeSpawn(), notifyFn: () => {} });
  const scheduler = createScheduler({ db, runner });
  const projects = createProjects({
    db,
    beads,
    runner,
    fsx: { readdir: async () => [], readFile: async () => { throw new Error('ENOENT'); } },
  });
  const approval = recordingApprover(approvalAnswer);
  currentToken = ensureToken();
  const app = createApp({
    db, runner, scheduler, extensions, awake: null, projects, beads, approval, token: currentToken,
    ...(withBranches ? { branches: createBranches() } : {}),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return {
    db, bd, beads, approval, server,
    base: () => `http://127.0.0.1:${server.address().port}`,
    close() { projects.stop(); server.close(); },
  };
}

const register = (db, path) => createProject(db, {
  name: 'the repo', path, beadsDir: join(path, '.beads'), state: 'active', config: PROJECT_CONFIG,
});

async function call(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${currentToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const branchesPath = (id) => `/api/v2/projects/${encodeURIComponent(id)}/branches`;

// ------------------------------------------------------------------- GET

test('GET branches lists scheduler branches with the bead title and the note verdict', async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const NOTE = 'run: gates passed — branch scheduler/the-repo--sp-1\nnpm test: 312 pass\n';
  const { db, server, base, close } = await boot({
    show: { stdout: JSON.stringify([{ id: 'sp-1', title: 'Teach the runner to snapshot', notes: NOTE }]) },
  });
  t.after(() => close());
  void server;
  branchWithCommit(dir, 'scheduler/the-repo--sp-1', 'b.txt', 'feat: the thing (sp-1)');
  const p = register(db, dir);

  const r = await call(base(), 'GET', branchesPath(p.id));
  assert.equal(r.status, 200);
  assert.equal(r.body.branches.length, 1);
  const row = r.body.branches[0];
  assert.equal(row.branch, 'scheduler/the-repo--sp-1');
  assert.equal(row.beadId, 'sp-1');
  assert.equal(row.title, 'Teach the runner to snapshot', "the bead's title, read through beads.get");
  assert.equal(row.note.gates, 'passed');
  assert.match(row.note.first, /^run: gates passed/);
  // The git facts travel through untouched — the page renders them, it does not
  // recompute them.
  assert.equal(row.ahead, 1);
  assert.equal(row.behind, 0);
  assert.equal(row.snapshotTip, false);
  assert.match(row.shortstat, /1 file changed/);
});

test('GET branches reads each verdict form, and a note that states none is not a pass', async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // One bead per branch: the fake answers by subcommand, so it is keyed on the
  // id in the args — a single canned reply would let a route that asked for the
  // wrong bead still look right.
  const NOTES = {
    'sp-1': 'run: gates failed — branch scheduler/r--sp-1\n3 failing',
    'sp-2': 'run: no gates — branch scheduler/r--sp-2',
    'sp-3': 'just some prose, no verdict line',
  };
  const { db, server, base, close } = await boot({
    show: ({ args }) => {
      const id = args[1];
      return { stdout: JSON.stringify([{ id, title: `bead ${id}`, notes: NOTES[id] ?? null }]) };
    },
  });
  t.after(() => close());
  void server;
  for (const id of ['sp-1', 'sp-2', 'sp-3']) branchWithCommit(dir, `scheduler/r--${id}`, `${id}.txt`, `work ${id}`);
  const p = register(db, dir);

  const r = await call(base(), 'GET', branchesPath(p.id));
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.branches.map((b) => [b.beadId, b]));
  assert.equal(by['sp-1'].note.gates, 'failed');
  assert.equal(by['sp-2'].note.gates, 'none');
  assert.equal(by['sp-3'].note.gates, null, 'a note with no verdict line is null, never "passed"');
  assert.equal(by['sp-3'].note.first, 'just some prose, no verdict line');
  assert.equal(by['sp-1'].title, 'bead sp-1');
});

test('GET branches judges a bead by its LATEST run line, not its first', async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The skill appends one `run: …` line per run via --append-notes. A bead's
  // second run must be the verdict shown — a pass-then-fail bead is not
  // mergeable just because its first run passed.
  const PASS_THEN_FAIL = 'run: gates passed — branch scheduler/x\nchanged: a\n\n'
    + 'run: gates failed — branch scheduler/x\ngates: npm test → 1 failing';
  const FAIL_THEN_PASS = 'run: gates failed — branch scheduler/x\ngates: npm test → 1 failing\n\n'
    + 'run: gates passed — branch scheduler/x\nchanged: a';
  const NOTES = { 'sp-1': PASS_THEN_FAIL, 'sp-2': FAIL_THEN_PASS };
  const { db, server, base, close } = await boot({
    show: ({ args }) => {
      const id = args[1];
      return { stdout: JSON.stringify([{ id, title: `bead ${id}`, notes: NOTES[id] ?? null }]) };
    },
  });
  t.after(() => close());
  void server;
  for (const id of ['sp-1', 'sp-2']) branchWithCommit(dir, `scheduler/r--${id}`, `${id}.txt`, `work ${id}`);
  const p = register(db, dir);

  const r = await call(base(), 'GET', branchesPath(p.id));
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.branches.map((b) => [b.beadId, b]));
  assert.equal(by['sp-1'].note.gates, 'failed', 'pass-then-fail must read as failed, not the stale first-run pass');
  assert.equal(by['sp-2'].note.gates, 'passed', 'fail-then-pass must read as passed, not the stale first-run fail');
});

test('GET branches: a snapshot tip is flagged, and a bead bd cannot read is still listed', async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { db, server, base, close } = await boot({
    show: { code: 1, stderr: 'Error fetching sp-9: no issue found matching "sp-9"' },
  });
  t.after(() => close());
  void server;
  branchWithCommit(dir, 'scheduler/r--sp-9', 'c.txt', 'wip(sp-9): uncommitted work at run end');
  const p = register(db, dir);

  const r = await call(base(), 'GET', branchesPath(p.id));
  assert.equal(r.status, 200);
  const row = r.body.branches[0];
  assert.equal(row.snapshotTip, true, 'the wip(...) tip Task 6 writes must be flagged');
  assert.equal(row.title, null, 'an unreadable bead loses its title, not its row');
  assert.deepEqual(row.note, { first: null, gates: null });
});

test('GET branches: an unknown project is 404, and a repo git cannot read is 502', async (t) => {
  const notARepo = mkdtempSync(join(tmpdir(), 'cs-review-norepo-'));
  const { db, server, base, close } = await boot();
  t.after(() => { close(); rmSync(notARepo, { recursive: true, force: true }); });
  void server;

  assert.equal((await call(base(), 'GET', branchesPath('nope'))).status, 404);
  const p = register(db, notARepo);
  const r = await call(base(), 'GET', branchesPath(p.id));
  assert.equal(r.status, 502, 'a directory that is not a git repo is the collaborator failing, not this request');
  assert.ok(r.body.error);
});

// ----------------------------------------------------------------- merge

test('merge: asks for approval naming the branch, fast-forwards main, and reports the sha', async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { db, server, base, close, approval } = await boot();
  t.after(() => close());
  void server;
  branchWithCommit(dir, 'scheduler/r--sp-1', 'b.txt', 'feat (sp-1)');
  const p = register(db, dir);

  const r = await call(base(), 'POST', `${branchesPath(p.id)}/r--sp-1/merge`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(mainCount(dir), 2, 'main really moved');
  assert.equal(g(dir, 'rev-parse', '--short', 'main').trim(), r.body.sha);

  assert.equal(approval.asked.length, 1, 'the owner was asked exactly once');
  assert.equal(approval.asked[0].action, 'branch.merge');
  assert.match(approval.asked[0].detail, /scheduler\/r--sp-1/, 'the sheet names the branch being merged');
  assert.match(approval.asked[0].detail, /the repo/, '…and the project it is in');
});

test('merge: a denied approval merges nothing', async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { db, server, base, close, approval } = await boot({
    approvalAnswer: { ok: false, code: 'approval_denied' },
  });
  t.after(() => close());
  void server;
  branchWithCommit(dir, 'scheduler/r--sp-1', 'b.txt', 'feat (sp-1)');
  const p = register(db, dir);

  const r = await call(base(), 'POST', `${branchesPath(p.id)}/r--sp-1/merge`, {});
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'approval_denied');
  assert.equal(approval.asked.length, 1);
  assert.equal(mainCount(dir), 1, 'a refusal leaves no partial state');
});

test('merge: a dirty checkout is 409 dirty and a non-ff branch is 409 not-ff, both merging nothing', async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { db, server, base, close } = await boot();
  t.after(() => close());
  void server;
  branchWithCommit(dir, 'scheduler/r--sp-1', 'b.txt', 'feat (sp-1)');
  const p = register(db, dir);

  writeFileSync(join(dir, 'a.txt'), 'edited by a human\n');
  let r = await call(base(), 'POST', `${branchesPath(p.id)}/r--sp-1/merge`, {});
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'dirty');
  assert.equal(mainCount(dir), 1);
  g(dir, 'checkout', '-q', '--', 'a.txt');

  // main moves on → the branch is no longer a fast-forward.
  writeFileSync(join(dir, 'e.txt'), 'e\n');
  g(dir, 'add', 'e.txt');
  g(dir, 'commit', '-q', '-m', 'main moves');
  r = await call(base(), 'POST', `${branchesPath(p.id)}/r--sp-1/merge`, {});
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'not-ff');
  assert.equal(mainCount(dir), 2, 'still nothing merged');
});

test('merge: an unknown branch under the prefix is 404', async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { db, server, base, close } = await boot();
  t.after(() => close());
  void server;
  const p = register(db, dir);

  const r = await call(base(), 'POST', `${branchesPath(p.id)}/r--nope/merge`, {});
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'unknown-branch');
});

// ------------------------------------------------- the containment itself

test('the routes can never name a branch outside scheduler/*', async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { db, server, base, close, approval } = await boot();
  t.after(() => close());
  void server;
  // A branch a caller might want to reach, and one that main has commits from.
  branchWithCommit(dir, 'feature/precious', 'p.txt', 'a human’s work');
  branchWithCommit(dir, 'scheduler/r--sp-1', 'b.txt', 'feat (sp-1)');
  const p = register(db, dir);
  const before = mainCount(dir);

  // Every shape that could escape the prefix: a traversal, an encoded slash, a
  // plain other-namespace branch, and the empty name.
  const escapes = ['..%2Fmain', '..%2F..%2Fmain', 'feature%2Fprecious', '%2Fmain', '..'];
  for (const name of escapes) {
    const merged = await call(base(), 'POST', `${branchesPath(p.id)}/${name}/merge`, {});
    assert.equal(merged.status, 404, `POST merge of ${name} must be 404`);
    const removed = await call(base(), 'DELETE', `${branchesPath(p.id)}/${name}`, { force: true });
    assert.equal(removed.status, 404, `DELETE of ${name} must be 404`);
  }

  // The repo is the real assertion: nothing moved and nothing was deleted.
  assert.equal(mainCount(dir), before, 'main must not have moved');
  assert.match(g(dir, 'branch', '--list'), /feature\/precious/, 'the human’s branch is untouched');
  // And the owner was never asked to approve a refused request — a sheet for
  // something the server was going to refuse anyway is a way to train a yes.
  assert.equal(approval.asked.length, 0, 'a name that can never resolve must not raise a dialog');
});

// --------------------------------------------------------------- discard

test('discard: unmerged without force is 409, with force deletes the branch, both behind approval', async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { db, server, base, close, approval } = await boot();
  t.after(() => close());
  void server;
  branchWithCommit(dir, 'scheduler/r--sp-1', 'b.txt', 'feat (sp-1)');
  const p = register(db, dir);

  let r = await call(base(), 'DELETE', `${branchesPath(p.id)}/r--sp-1`, {});
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'unmerged');
  assert.match(g(dir, 'branch', '--list'), /sp-1/, 'refused means still there');
  assert.equal(approval.asked[0].action, 'branch.discard');

  r = await call(base(), 'DELETE', `${branchesPath(p.id)}/r--sp-1`, { force: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.doesNotMatch(g(dir, 'branch', '--list'), /sp-1/);
  // The forcing case says out loud what is being thrown away.
  assert.match(approval.asked[1].detail, /discard its unmerged commits/);
  assert.equal(approval.asked.length, 2);

  assert.equal((await call(base(), 'DELETE', `${branchesPath(p.id)}/r--sp-1`, { force: true })).status, 404);
});

// --------------------------------------------------------- not wired in

test('with no branches engine the three routes are 501, the same as the other optional deps', async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { db, server, base, close } = await boot({ withBranches: false });
  t.after(() => close());
  void server;
  const p = register(db, dir);

  assert.equal((await call(base(), 'GET', branchesPath(p.id))).status, 501);
  assert.equal((await call(base(), 'POST', `${branchesPath(p.id)}/r--sp-1/merge`, {})).status, 501);
  assert.equal((await call(base(), 'DELETE', `${branchesPath(p.id)}/r--sp-1`, {})).status, 501);
});
