import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { tmpData, fakeBd, bdReadyRow, waitFor } from './helpers.js';
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

test('snapshot commits a dirty worktree as wip(<bead>) with the scheduler identity, and skips a clean one', async () => {
  const dirty = fakeGit({
    status: { stdout: ' M lib/a.js\n?? new.txt\n' },
    add: { stdout: '' },
    commit: { stdout: '' },
    'rev-parse': { stdout: 'abc1234\n' },
  });
  const wt = createWorktrees({ execFileFn: dirty });
  const r = await wt.snapshot(PROJECT, { root: '/outside', beadId: 'sp-1' });
  assert.equal(r.committed, true);
  assert.equal(r.sha, 'abc1234');
  const commit = dirty.calls.find((c) => c.args[0] === '-c' || c.args[0] === 'commit');
  assert.ok(commit, 'a commit was made');
  assert.ok(commit.args.includes('user.name=LaunchBox'), 'committed as the scheduler, not as the owner');
  assert.ok(commit.args.some((a) => /^wip\(sp-1\): uncommitted work at run end$/.test(a)), 'fixed-form message the review queue recognises');
  assert.equal(commit.opts.cwd, join('/outside', worktreeName(PROJECT, 'sp-1')), 'runs IN the bead worktree');
  // -A on purpose here and nowhere else: the point is to lose nothing. `.beads/`
  // is excluded (see the next test) — this is the final shape of that call.
  const add = dirty.calls.find((c) => c.args[0] === 'add');
  assert.deepEqual(add.args, ['add', '-A', '--', '.', ':(exclude).beads']);

  const clean = fakeGit({ status: { stdout: '' } });
  const wt2 = createWorktrees({ execFileFn: clean });
  const r2 = await wt2.snapshot(PROJECT, { root: '/outside', beadId: 'sp-1' });
  assert.equal(r2.committed, false);
  assert.ok(!clean.calls.some((c) => c.args.includes('commit')), 'nothing to commit → no commit');
});

test('snapshot never touches .beads/ — the scheduler owns bead writes, and a stray audit line must not ride along', async () => {
  const git = fakeGit({
    status: { stdout: ' M .beads/interactions.jsonl\n M src/x.js\n' },
    add: { stdout: '' }, commit: { stdout: '' }, 'rev-parse': { stdout: 'def5678\n' },
  });
  const wt = createWorktrees({ execFileFn: git });
  await wt.snapshot(PROJECT, { root: '/outside', beadId: 'sp-1' });
  const add = git.calls.find((c) => c.args[0] === 'add');
  assert.deepEqual(add.args, ['add', '-A', '--', '.', ':(exclude).beads']);
});

test('snapshot surfaces an unreadable HEAD after a successful commit, rather than a silent null sha', async () => {
  const git = fakeGit({
    status: { stdout: ' M src/x.js\n' },
    add: { stdout: '' }, commit: { stdout: '' },
    'rev-parse': { code: 1, stderr: 'boom' },
  });
  const wt = createWorktrees({ execFileFn: git });
  await assert.rejects(
    wt.snapshot(PROJECT, { root: '/outside', beadId: 'sp-1' }),
    (e) => e instanceof WorktreeError && /HEAD is unreadable/.test(e.message),
  );
});

test('snapshot surfaces a broken status read as a WorktreeError, not a silent no-op', async () => {
  const git = fakeGit({ status: { code: 1, stderr: 'fatal: not a git repository\n' } });
  const wt = createWorktrees({ execFileFn: git });
  await assert.rejects(
    wt.snapshot(PROJECT, { root: '/outside', beadId: 'sp-1' }),
    (e) => e instanceof WorktreeError && /could not read status of/.test(e.message),
  );
});

test('snapshot surfaces a refused stage as a WorktreeError, not a silent no-op', async () => {
  const git = fakeGit({
    status: { stdout: ' M src/x.js\n' },
    add: { code: 1, stderr: 'fatal: pathspec did not match\n' },
  });
  const wt = createWorktrees({ execFileFn: git });
  await assert.rejects(
    wt.snapshot(PROJECT, { root: '/outside', beadId: 'sp-1' }),
    (e) => e instanceof WorktreeError && /could not stage leftovers in/.test(e.message),
  );
});

test('snapshot surfaces a refused commit as a WorktreeError, not a silent no-op', async () => {
  const git = fakeGit({
    status: { stdout: ' M src/x.js\n' },
    add: { stdout: '' },
    commit: { code: 1, stderr: 'fatal: cannot commit\n' },
  });
  const wt = createWorktrees({ execFileFn: git });
  await assert.rejects(
    wt.snapshot(PROJECT, { root: '/outside', beadId: 'sp-1' }),
    (e) => e instanceof WorktreeError && /could not snapshot/.test(e.message),
  );
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

test('the project\'s linkFromMain reaches ensure(): a missing asset abandons the bead, not runs it bare', async () => {
  const db = openDb(join(tmpData(), 'test.db'));
  const project = createProject(db, {
    name: 'repo', path: '/repo', state: 'active', beadsDir: '/repo/.beads',
    config: { autoLabel: 'unattended', maxConcurrent: 1, linkFromMain: ['.venv'], defaults: { timeoutMin: 30, model: 'default', notify: 'failure' } },
  });
  const { projects, starts } = pollerSetup({ db, project });
  const abandoned = [];
  projects.events.on('abandoned', (e) => abandoned.push(e));
  const r = await projects.pollProject(project.id);
  assert.equal(r.started.length, 0);
  assert.equal(starts.length, 0);
  assert.match(abandoned[0]?.reason ?? '', /missing in main checkout: \/repo\/\.venv/);
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

// --- snapshot() failure paths, through reap() -------------------------------
// snapshot() runs inside reap()'s `try`, which never blocks the reap on a
// failure (see the big comment above `reap` in lib/projects.js): each of these
// asserts the WorktreeError-shaped reason reaches `snapshot-failed` AND that
// `remove` still ran, for every one of snapshot()'s three git steps.

for (const [label, gitOverrides, reasonPattern] of [
  ['cannot read status', { status: { code: 1, stderr: 'fatal: not a git repository\n' } }, /could not read status of/],
  ['cannot stage leftovers', {
    status: { stdout: ' M src/x.js\n' },
    add: { code: 1, stderr: 'fatal: pathspec did not match\n' },
  }, /could not stage leftovers in/],
  ['cannot commit', {
    status: { stdout: ' M src/x.js\n' },
    add: { stdout: '' },
    commit: { code: 1, stderr: 'fatal: cannot commit\n' },
  }, /could not snapshot/],
]) {
  test(`a snapshot that ${label} is reported, and reap still removes the worktree`, async () => {
    const { projects, project, runner, git } = pollerSetup({
      gitHandlers: {
        worktree: ({ args }) => (args[1] === 'list' ? listing(['/repo']) : { stdout: '' }),
        'show-ref': { code: 1 },
        ...gitOverrides,
      },
    });
    const failures = [];
    projects.events.on('snapshot-failed', (e) => failures.push(e));

    const r = await projects.pollProject(project.id);
    runner.events.emit(`done:${r.started[0].runId}`, 'fail');
    await waitFor(() => removals(git).length > 0);

    assert.equal(failures.length, 1, 'a lost snapshot must be reported rather than swallowed');
    assert.equal(failures[0].beadId, 'sp-1');
    assert.match(failures[0].reason, reasonPattern);
    assert.deepEqual(removals(git), [`/outside/repo-${project.id.slice(0, 8)}--sp-1`],
      'a failed snapshot must not block the reap');
  });
}

// --- linkFromMain: gitignored assets linked from the main checkout ----------
// Real git + real fs: whether a symlink is ignored is git's call (a dir-only
// `.venv/` pattern does NOT match a symlink), and a fake would only agree with me.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, readlinkSync, symlinkSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
function assetRepo(ignore = '.venv\nshared/.model-cache\n') {
  // realpath: git worktree list reports /private/var, and ensure() matches paths exactly.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cs-link-')));
  const main = join(base, 'main');
  mkdirSync(main);
  g(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, '.gitignore'), ignore);
  mkdirSync(join(main, 'shared'));
  writeFileSync(join(main, 'shared', 'keep.txt'), 'tracked\n');
  g(main, 'add', '.'); g(main, 'commit', '-q', '-m', 'init');
  mkdirSync(join(main, '.venv'));
  writeFileSync(join(main, '.venv', 'sentinel'), 'real\n');
  mkdirSync(join(main, 'shared', '.model-cache'));
  const project = { id: 'abcdef1234567890', name: 'assets', path: main };
  const root = join(base, 'wt');
  return { base, main, root, project, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const mainIntact = (main) => {
  assert.equal(lstatSync(join(main, '.venv')).isSymbolicLink(), false, 'main .venv is still a real dir');
  assert.equal(readFileSync(join(main, '.venv', 'sentinel'), 'utf8'), 'real\n');
};

test('ensure links declared gitignored assets from the main checkout', async () => {
  const r = assetRepo();
  try {
    const wt = createWorktrees();
    const res = await wt.ensure(r.project, { root: r.root, beadId: 'sp-1', linkFromMain: ['.venv', 'shared/.model-cache'] });
    assert.equal(res.created, true);
    for (const rel of ['.venv', 'shared/.model-cache']) {
      assert.ok(lstatSync(join(res.path, rel)).isSymbolicLink(), `${rel} is a link`);
      assert.equal(readlinkSync(join(res.path, rel)), join(r.main, rel));
    }
    assert.equal(readFileSync(join(res.path, '.venv', 'sentinel'), 'utf8'), 'real\n');
    assert.equal(g(res.path, 'status', '--porcelain'), '', 'links are ignored, so snapshot() commits nothing');
    mainIntact(r.main);
  } finally { r.cleanup(); }
});

test('ensure links on reuse of an existing worktree, and leaves a correct link alone', async () => {
  const r = assetRepo();
  try {
    const wt = createWorktrees();
    const first = await wt.ensure(r.project, { root: r.root, beadId: 'sp-1' });
    assert.equal(existsSync(join(first.path, '.venv')), false, 'nothing linked when nothing declared');
    const again = await wt.ensure(r.project, { root: r.root, beadId: 'sp-1', linkFromMain: ['.venv'] });
    assert.equal(again.created, false);
    assert.equal(readlinkSync(join(again.path, '.venv')), join(r.main, '.venv'));
    const third = await wt.ensure(r.project, { root: r.root, beadId: 'sp-1', linkFromMain: ['.venv'] });
    assert.equal(readlinkSync(join(third.path, '.venv')), join(r.main, '.venv'), 'idempotent');
    mainIntact(r.main);
  } finally { r.cleanup(); }
});

test('linkFromMain refusals: missing, source-is-symlink, not ignored, destination occupied', async () => {
  const wt = createWorktrees();
  const r = assetRepo('.venv/\nlinked\n');
  try {
    // Missing in main → refused before any worktree is made.
    await assert.rejects(wt.ensure(r.project, { root: r.root, beadId: 'm', linkFromMain: ['nope'] }),
      (e) => e instanceof WorktreeError && /missing in main checkout: .*nope/.test(e.message));
    assert.equal(existsSync(join(r.root, worktreeName(r.project, 'm'))), false, 'no worktree left behind');

    // Source in main is itself a symlink.
    symlinkSync(join(r.main, '.venv'), join(r.main, 'linked'));
    await assert.rejects(wt.ensure(r.project, { root: r.root, beadId: 's', linkFromMain: ['linked'] }),
      (e) => e instanceof WorktreeError && /itself a symlink: .*linked/.test(e.message));

    // `.venv/` ignores the real dir in main but not a symlink → refused, link removed.
    await assert.rejects(wt.ensure(r.project, { root: r.root, beadId: 'i', linkFromMain: ['.venv'] }),
      (e) => e instanceof WorktreeError && /\.venv is not gitignored/.test(e.message));
    const ipath = join(r.root, worktreeName(r.project, 'i'));
    assert.equal(existsSync(join(ipath, '.venv')), false, 'the unignored link is not left for snapshot() to commit');
    assert.equal(g(ipath, 'status', '--porcelain'), '');
    mainIntact(r.main);
  } finally { r.cleanup(); }

  const o = assetRepo();
  try {
    const first = await wt.ensure(o.project, { root: o.root, beadId: 'o' });
    mkdirSync(join(first.path, '.venv'));
    await assert.rejects(wt.ensure(o.project, { root: o.root, beadId: 'o', linkFromMain: ['.venv'] }),
      (e) => e instanceof WorktreeError && /\.venv already exists in the worktree/.test(e.message));
    mainIntact(o.main);
  } finally { o.cleanup(); }
});

// claude-scheduler-u9h: an asset dir ignored by content (`dir/*` + `!dir/manifest.json`)
// cannot be linked as a whole — a tracked manifest lives inside. A trailing `/*`
// expands against main's listing and links each ignored entry.
function fontsRepo() {
  const r = assetRepo('assets/fonts/*\n!assets/fonts/manifest.json\n');
  mkdirSync(join(r.main, 'assets', 'fonts'), { recursive: true });
  writeFileSync(join(r.main, 'assets', 'fonts', 'manifest.json'), '{}\n');
  g(r.main, 'add', '.'); g(r.main, 'commit', '-q', '-m', 'manifest');
  writeFileSync(join(r.main, 'assets', 'fonts', 'a.ttf'), 'font-a\n');
  return r;
}

test('linkFromMain glob links ignored files and skips tracked ones', async () => {
  const r = fontsRepo();
  try {
    const logs = [];
    const wt = createWorktrees({ log: (m) => logs.push(m) });
    const res = await wt.ensure(r.project, { root: r.root, beadId: 'f', linkFromMain: ['assets/fonts/*'] });
    assert.ok(lstatSync(join(res.path, 'assets/fonts/a.ttf')).isSymbolicLink(), 'ignored file is linked');
    assert.equal(readlinkSync(join(res.path, 'assets/fonts/a.ttf')), join(r.main, 'assets/fonts/a.ttf'));
    assert.equal(lstatSync(join(res.path, 'assets/fonts/manifest.json')).isSymbolicLink(), false, 'tracked manifest stays the checked-out file');
    assert.equal(g(res.path, 'status', '--porcelain'), '', 'nothing for snapshot() to commit');
    assert.equal(logs.length, 1, 'one log line for the skipped tracked entries');
    assert.match(logs[0], /assets\/fonts\/\*.*manifest\.json/);
  } finally { r.cleanup(); }
});

test('linkFromMain glob refusals: dir missing in main, nothing matched', async () => {
  const r = fontsRepo();
  try {
    const wt = createWorktrees({ log: () => {} });
    await assert.rejects(wt.ensure(r.project, { root: r.root, beadId: 'm', linkFromMain: ['assets/music/*'] }),
      (e) => e instanceof WorktreeError && /assets\/music is missing in main checkout/.test(e.message));
    assert.equal(existsSync(join(r.root, worktreeName(r.project, 'm'))), false, 'no worktree left behind');

    // Only the tracked manifest → an empty link set is a config mistake, not success.
    rmSync(join(r.main, 'assets', 'fonts', 'a.ttf'));
    await assert.rejects(wt.ensure(r.project, { root: r.root, beadId: 'e', linkFromMain: ['assets/fonts/*'] }),
      (e) => e instanceof WorktreeError && /assets\/fonts\/\* matched nothing to link/.test(e.message));
    assert.equal(existsSync(join(r.root, worktreeName(r.project, 'e'))), false, 'no worktree left behind');
  } finally { r.cleanup(); }
});

test('linkFromMain glob re-expands on reuse and links a file added to main since', async () => {
  const r = fontsRepo();
  try {
    const wt = createWorktrees({ log: () => {} });
    const first = await wt.ensure(r.project, { root: r.root, beadId: 'f', linkFromMain: ['assets/fonts/*'] });
    assert.equal(existsSync(join(first.path, 'assets/fonts/b.ttf')), false);
    writeFileSync(join(r.main, 'assets', 'fonts', 'b.ttf'), 'font-b\n');
    const again = await wt.ensure(r.project, { root: r.root, beadId: 'f', linkFromMain: ['assets/fonts/*'] });
    assert.equal(again.created, false);
    assert.equal(readlinkSync(join(again.path, 'assets/fonts/b.ttf')), join(r.main, 'assets/fonts/b.ttf'));
    assert.equal(readlinkSync(join(again.path, 'assets/fonts/a.ttf')), join(r.main, 'assets/fonts/a.ttf'), 'existing link left alone');
  } finally { r.cleanup(); }
});

test('remove() after linking leaves the main checkout\'s assets intact', async () => {
  const r = assetRepo();
  try {
    const wt = createWorktrees();
    const res = await wt.ensure(r.project, { root: r.root, beadId: 'sp-1', linkFromMain: ['.venv'] });
    await wt.remove(r.project, { root: r.root, beadId: 'sp-1' });
    assert.equal(existsSync(res.path), false, 'worktree gone');
    mainIntact(r.main);
  } finally { r.cleanup(); }
});

// claude-scheduler-0ok: git worktree list reports realpaths, so a worktreeRoot
// reached through a symlink (macOS: /var -> /private/var, /tmp -> /private/tmp)
// never matched — reuse fell through to `worktree add`, which failed "already exists".
test('ensure reuses a worktree when worktreeRoot is reached through a symlink', async () => {
  const r = assetRepo();
  try {
    symlinkSync(r.base, join(r.base, 'via-link'));
    const root = join(r.base, 'via-link', 'wt');
    const wt = createWorktrees();
    const first = await wt.ensure(r.project, { root, beadId: 'sp-1' });
    assert.equal(first.created, true);
    const again = await wt.ensure(r.project, { root, beadId: 'sp-1' });
    assert.equal(again.created, false, 'the second poll must reuse, not re-add');
    assert.equal(again.path, first.path, 'the path handed back is the configured one, so remove()/snapshot() agree');
    const removed = await wt.remove(r.project, { root, beadId: 'sp-1' });
    assert.equal(removed.removed, true, 'remove() through the same symlinked root still reaps it');
  } finally { r.cleanup(); }
});
