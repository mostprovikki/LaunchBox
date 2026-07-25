import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { tmpData, fakeBd, bdReadyRow } from './helpers.js';
import { openDb, createProject, getLease, setSetting } from '../lib/db.js';
import { createBeads } from '../lib/beads.js';
import { createProjects } from '../lib/projects.js';
import { createWorktrees, worktreeName, branchFor, WorktreeError } from '../lib/worktree.js';

// `fakeBd` is a generic execFile fake keyed by first arg, so it stands in for
// `git` here just as well as for `bd`.
const fakeGit = fakeBd;

const PROJECT = { id: 'abcdef1234567890', name: 'my repo', path: '/repo' };
const listing = (paths) => ({ stdout: paths.map((p) => `worktree ${p}\nHEAD abc\n`).join('\n') });

// Per-bead naming (M4). The separator is `--` rather than `/` on purpose: git
// refuses a branch `a/b` when branch `a` exists, and M4a installs already have
// per-project `scheduler/<proj>` branches — so nesting would break on exactly the
// repos that have been running longest. A nested path would also plant the bead's
// worktree inside the project's old one, which then reports it as untracked.
test('a bead gets its own worktree path and branch, never nested under the project\'s', () => {
  assert.equal(worktreeName(PROJECT, 'sp-1'), 'my-repo-abcdef12--sp-1');
  assert.equal(branchFor(PROJECT, 'sp-1'), 'scheduler/my-repo-abcdef12--sp-1');
  // No slash beyond the single `scheduler/` namespace, or git's ref directory/file
  // conflict comes back.
  assert.equal(branchFor(PROJECT, 'sp-1').split('/').length, 2);
  assert.ok(!worktreeName(PROJECT, 'sp-1').includes('/'), 'one path segment, so it cannot nest');

  // Prefix pairs are distinct directories — equality is what matters here, unlike
  // the completion-marker check where a substring test was the bug.
  assert.notEqual(worktreeName(PROJECT, 'sp-1'), worktreeName(PROJECT, 'sp-12'));

  // Two ids that sanitise to the same string must NOT collapse onto one checkout —
  // two beads sharing a worktree is the exact collision this change removes.
  assert.notEqual(worktreeName(PROJECT, 'sp/1'), worktreeName(PROJECT, 'sp-1'));
  for (const id of ['../escape', 'sp/1', '', '..', 'a b']) {
    const n = worktreeName(PROJECT, id);
    assert.ok(!n.includes('/'), `${JSON.stringify(id)} -> ${n} must be a single segment`);
    assert.equal(join('/root', n), `/root/${n}`, 'must not escape the worktree root');
  }
});

test('worktree name is filesystem-safe and disambiguated by project id', () => {
  assert.equal(worktreeName({ id: 'abcdef1234567890', name: 'my repo' }), 'my-repo-abcdef12');
  assert.equal(branchFor(PROJECT), 'scheduler/my-repo-abcdef12');

  // Path separators are stripped, so a hostile name collapses to ONE segment.
  // Dots survive (they are legal in a directory name), which is only safe
  // because the id suffix means the result can never be exactly '.' or '..' —
  // assert that, since it is the property that prevents escaping the root.
  for (const name of ['weird/../name!', '..', '.', '/etc/passwd', '']) {
    const n = worktreeName({ id: 'deadbeefcafe', name });
    assert.ok(!n.includes('/'), `${JSON.stringify(name)} -> ${n} must be a single segment`);
    assert.ok(n !== '.' && n !== '..', `${JSON.stringify(name)} -> ${n} must not be a traversal`);
    assert.equal(join('/root', n), `/root/${n}`, 'must not escape the worktree root');
  }
  assert.equal(worktreeName({ id: 'x', name: 'weird/../name!' }), 'weird-..-name-x');
});

test('ensure creates a worktree with a fresh branch when neither exists', async () => {
  const git = fakeGit({
    worktree: ({ args }) => (args[1] === 'list' ? listing(['/repo']) : { stdout: '' }),
    'show-ref': { code: 1 }, // branch does not exist
  });
  const wt = createWorktrees({ execFileFn: git });

  const r = await wt.ensure(PROJECT, { root: '/outside' });
  assert.equal(r.path, join('/outside', 'my-repo-abcdef12'));
  assert.equal(r.created, true);
  const add = git.calls.find((c) => c.args[1] === 'add');
  assert.deepEqual(add.args, ['worktree', 'add', '-b', 'scheduler/my-repo-abcdef12', '/outside/my-repo-abcdef12']);
  assert.equal(add.opts.cwd, '/repo', 'git runs in the primary checkout');
});

test('ensure reuses an existing branch rather than failing on it', async () => {
  const git = fakeGit({
    worktree: ({ args }) => (args[1] === 'list' ? listing(['/repo']) : { stdout: '' }),
    'show-ref': { code: 0 }, // branch already exists
  });
  const wt = createWorktrees({ execFileFn: git });

  await wt.ensure(PROJECT, { root: '/outside' });
  const add = git.calls.find((c) => c.args[1] === 'add');
  // Reusing the branch keeps the scheduler's history across a reaped worktree.
  assert.deepEqual(add.args, ['worktree', 'add', '/outside/my-repo-abcdef12', 'scheduler/my-repo-abcdef12']);
});

test('ensure is idempotent — an already-registered worktree is not re-added', async () => {
  const git = fakeGit({
    worktree: ({ args }) => (args[1] === 'list' ? listing(['/repo', '/outside/my-repo-abcdef12']) : { stdout: '' }),
  });
  const wt = createWorktrees({ execFileFn: git });

  const r = await wt.ensure(PROJECT, { root: '/outside' });
  assert.equal(r.created, false, 'polling every minute must not churn the disk');
  assert.ok(!git.calls.some((c) => c.args[1] === 'add'));
});

test('a leftover directory git has pruned is not mistaken for a live worktree', async () => {
  // `git worktree list` is authoritative; a bare directory check would be fooled.
  const git = fakeGit({
    worktree: ({ args }) => (args[1] === 'list' ? listing(['/repo']) : { stdout: '' }),
    'show-ref': { code: 1 },
  });
  const wt = createWorktrees({ execFileFn: git });
  const r = await wt.ensure(PROJECT, { root: '/outside' });
  assert.equal(r.created, true);
});

test('a refused worktree add is an error, never a silent fallback', async () => {
  const git = fakeGit({
    worktree: ({ args }) => (args[1] === 'list'
      ? listing(['/repo'])
      : { code: 128, stderr: "fatal: '/outside/x' already exists\n" }),
    'show-ref': { code: 1 },
  });
  const wt = createWorktrees({ execFileFn: git });

  await assert.rejects(() => wt.ensure(PROJECT, { root: '/outside' }), (err) => {
    assert.ok(err instanceof WorktreeError);
    assert.match(err.message, /already exists/);
    return true;
  });
});

test('ensure refuses to run without a configured root', async () => {
  const wt = createWorktrees({ execFileFn: fakeGit() });
  await assert.rejects(() => wt.ensure(PROJECT, { root: null }), /worktreeRoot is not configured/);
});

test('remove tolerates an already-absent worktree', async () => {
  const git = fakeGit({ worktree: { code: 128, stderr: "fatal: '/outside/x' is not a working tree\n" } });
  const wt = createWorktrees({ execFileFn: git });
  const r = await wt.remove(PROJECT, { root: '/outside' });
  assert.equal(r.removed, false, 'reaping something already gone is not an error');
});

// --- the poller's use of it -------------------------------------------

// `db`/`project` can be passed in to simulate a restart against the same state —
// the reaping tests need a second daemon over a database that already has a held
// lease. `runnerStarts: false` makes the runner decline, which is a give-up path
// *after* the worktree was created.
function pollerSetup({
  gitHandlers, worktreeRoot = '/outside', db: existingDb = null,
  project: existingProject = null, runnerStarts = true,
} = {}) {
  const db = existingDb ?? openDb(join(tmpData(), 'test.db'));
  const bd = fakeBd({
    '--version': { stdout: 'bd version 1.1.0 (Homebrew)' },
    where: { stdout: JSON.stringify({ path: '/repo/.beads', database_path: '/repo/.beads/db' }) },
    ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
    show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
    update: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1' })]) },
  });
  const git = fakeGit(gitHandlers ?? {
    worktree: ({ args }) => (args[1] === 'list' ? listing(['/repo']) : { stdout: '' }),
    'show-ref': { code: 1 },
  });
  const starts = [];
  let n = 0;
  const runner = {
    events: new EventEmitter(),
    start(job, trigger) {
      if (!runnerStarts) return null;
      starts.push(job);
      return { id: `run-${++n}`, jobId: job.id, status: 'running', trigger };
    },
  };
  runner.events.setMaxListeners(50);
  const project = existingProject ?? createProject(db, {
    name: 'repo', path: '/repo', state: 'active', beadsDir: '/repo/.beads',
    config: { autoLabel: 'unattended', maxConcurrent: 1, defaults: { timeoutMin: 30, model: 'default', notify: 'failure' } },
  });
  if (worktreeRoot) setSetting(db, 'worktreeRoot', worktreeRoot);
  const projects = createProjects({
    db, beads: createBeads({ execFileFn: bd }), runner,
    worktrees: createWorktrees({ execFileFn: git }),
  });
  return { db, projects, project, starts, git, runner };
}

test('scheduled work runs in the worktree, not the human\'s checkout', async () => {
  const { projects, project, starts } = pollerSetup();
  const r = await projects.pollProject(project.id);

  assert.equal(r.started.length, 1);
  // The project id is a uuid, so assert the shape rather than a literal path. The
  // `--sp-1` suffix is the per-bead part (M4): one checkout per bead, so two of our
  // own runs cannot edit each other's files.
  assert.match(starts[0].cwd, /^\/outside\/repo-[0-9a-f]{8}--sp-1$/, `expected a per-bead worktree cwd, got ${starts[0].cwd}`);
  assert.ok(!starts[0].cwd.startsWith('/repo'), 'never the primary checkout');
});

test('if the worktree cannot be prepared the bead is abandoned, not run in the checkout', async () => {
  const { db, projects, project, starts } = pollerSetup({
    gitHandlers: {
      worktree: ({ args }) => (args[1] === 'list' ? listing(['/repo']) : { code: 128, stderr: 'fatal: nope\n' }),
      'show-ref': { code: 1 },
    },
  });
  const abandoned = [];
  projects.events.on('abandoned', (e) => abandoned.push(e));

  const r = await projects.pollProject(project.id);
  assert.equal(r.started.length, 0);
  assert.equal(starts.length, 0, 'failing to isolate is a reason NOT to run');
  assert.match(abandoned[0].reason, /worktree/);
  assert.equal(getLease(db, project.id, 'sp-1').state, 'released');
});

test('with no worktreeRoot configured the work falls back to the project path', async () => {
  const { projects, project, starts } = pollerSetup({ worktreeRoot: null });
  await projects.pollProject(project.id);
  assert.equal(starts[0].cwd, '/repo');
});

// --- reaping (mandatory once worktrees are per bead) -----------------------
// Before M4 there was one worktree per project, reused forever, so forgetting to
// reap cost nothing — `worktree.remove` had no production caller at all. Per bead
// it is one directory per bead that ever ran, so a missed reap is an unbounded
// disk leak.

const removals = (git) => git.calls
  .filter((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')
  .map((c) => c.args[c.args.length - 1]);

test('a bead\'s worktree is reaped when its run finishes, whatever the outcome', async () => {
  for (const status of ['ok', 'fail', 'stopped', 'killed']) {
    const { projects, project, git, runner } = pollerSetup();
    const r = await projects.pollProject(project.id);
    assert.equal(r.started.length, 1, status);
    assert.deepEqual(removals(git), [], 'not reaped while the run is still going');

    runner.events.emit(`done:${r.started[0].runId}`, status);
    await new Promise((res) => setTimeout(res, 30));
    assert.deepEqual(removals(git), [`/outside/repo-${project.id.slice(0, 8)}--sp-1`],
      `a ${status} run must still release its checkout`);
  }
});

test('a bead abandoned after its worktree was made does not leak the directory', async () => {
  // The runner declines, which is a give-up path *after* `ensure` succeeded — the
  // shape that leaks if reaping is only wired into the completion handler.
  const { projects, project, git } = pollerSetup({ runnerStarts: false });
  const r = await projects.pollProject(project.id);
  assert.equal(r.started.length, 0);
  assert.deepEqual(removals(git), [`/outside/repo-${project.id.slice(0, 8)}--sp-1`],
    'the worktree was created, so giving up has to clean it up');
});

test('a crash leaves no orphan worktree: recoverOrphans sweeps them', async () => {
  const { db, projects, project, git } = pollerSetup();
  const r = await projects.pollProject(project.id);
  assert.equal(r.started.length, 1);
  // The daemon dies here: the lease is still held and nothing will ever fire
  // `done:` for that run, so the completion handler cannot be what reaps it.
  const fresh = pollerSetup({ db, project });
  await fresh.projects.recoverOrphans();
  assert.deepEqual(removals(fresh.git), [`/outside/repo-${project.id.slice(0, 8)}--sp-1`]);
});

test('a failed reap is reported, never fatal to the run\'s outcome', async () => {
  const { projects, project, runner } = pollerSetup({
    gitHandlers: {
      worktree: ({ args }) => {
        if (args[1] === 'list') return listing(['/repo']);
        if (args[1] === 'remove') return { code: 1, stderr: 'fatal: cannot remove\n' };
        return { stdout: '' };
      },
      'show-ref': { code: 1 },
    },
  });
  const failures = [];
  projects.events.on('reap-failed', (e) => failures.push(e));
  const finished = [];
  projects.events.on('finished', (e) => finished.push(e));

  const r = await projects.pollProject(project.id);
  runner.events.emit(`done:${r.started[0].runId}`, 'fail');
  await new Promise((res) => setTimeout(res, 30));

  assert.equal(failures.length, 1, 'a leak must be reported rather than swallowed');
  assert.equal(failures[0].beadId, 'sp-1');
  assert.equal(finished.length, 1, 'and it must not change what happened to the bead');
});
