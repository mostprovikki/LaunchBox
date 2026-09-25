// tests/branches.test.js
// Real git in a temp dir: fast-forward vs. not, dirty vs. clean, are git's semantics, and a
// fake that agrees with my reading of them proves only that I can type my reading twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBranches, parseBeadId, BranchError } from '../lib/branches.js';

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'cs-branches-'));
  g(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a\n'); g(dir, 'add', 'a.txt'); g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
function branchWithCommit(dir, name, file, msg) {
  g(dir, 'checkout', '-q', '-b', name);
  writeFileSync(join(dir, file), `${msg}\n`); g(dir, 'add', file); g(dir, 'commit', '-q', '-m', msg);
  g(dir, 'checkout', '-q', 'main');
}

test('parseBeadId reads the segment after the last "--", or null', () => {
  assert.equal(parseBeadId('scheduler/my-repo-abcdef12--sp-1'), 'sp-1');
  assert.equal(parseBeadId('scheduler/my-repo-abcdef12--sp-1-x9k2q1'), 'sp-1-x9k2q1');
  assert.equal(parseBeadId('scheduler/my-repo-abcdef12'), null);
  assert.equal(parseBeadId('feature/x'), null);
});

test('list: only scheduler/* branches with commits not in main, with counts, shortstat and snapshot flag', async () => {
  const dir = repo();
  try {
    branchWithCommit(dir, 'scheduler/p-1--sp-1', 'b.txt', 'feat: b (sp-1)');
    branchWithCommit(dir, 'scheduler/p-1--sp-2', 'c.txt', 'wip(sp-2): uncommitted work at run end');
    branchWithCommit(dir, 'feature/not-ours', 'd.txt', 'x');
    g(dir, 'branch', 'scheduler/p-1--sp-3'); // no commits beyond main → merged, must not appear
    const b = createBranches();
    const rows = await b.list(dir);
    assert.deepEqual(rows.map((r) => r.branch).sort(), ['scheduler/p-1--sp-1', 'scheduler/p-1--sp-2']);
    const sp1 = rows.find((r) => r.beadId === 'sp-1');
    assert.equal(sp1.ahead, 1); assert.equal(sp1.behind, 0);
    assert.match(sp1.shortstat, /1 file changed/);
    assert.equal(sp1.snapshotTip, false);
    assert.equal(rows.find((r) => r.beadId === 'sp-2').snapshotTip, true, 'a wip(...) tip is flagged');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mergeFastForward: merges when ff is possible, refuses dirty tree and non-ff, leaves no partial state', async () => {
  const dir = repo();
  try {
    const b = createBranches();
    branchWithCommit(dir, 'scheduler/p-1--sp-1', 'b.txt', 'feat (sp-1)');
    // dirty primary → refuse before touching anything
    writeFileSync(join(dir, 'a.txt'), 'edited\n');
    await assert.rejects(b.mergeFastForward(dir, 'scheduler/p-1--sp-1'), (e) => e instanceof BranchError && e.code === 'dirty');
    assert.equal(g(dir, 'rev-list', '--count', 'main'), '1\n', 'nothing merged');
    g(dir, 'checkout', '-q', '--', 'a.txt');
    // non-ff: main moves on
    writeFileSync(join(dir, 'e.txt'), 'e\n'); g(dir, 'add', 'e.txt'); g(dir, 'commit', '-q', '-m', 'main moves');
    await assert.rejects(b.mergeFastForward(dir, 'scheduler/p-1--sp-1'), (e) => e.code === 'not-ff');
    assert.equal(g(dir, 'rev-list', '--count', 'main'), '2\n', 'still nothing merged');
    // ff possible: a fresh branch off the new main
    branchWithCommit(dir, 'scheduler/p-1--sp-9', 'f.txt', 'feat (sp-9)');
    const r = await b.mergeFastForward(dir, 'scheduler/p-1--sp-9');
    assert.equal(g(dir, 'rev-parse', '--short', 'main').trim(), r.sha);
    assert.equal(g(dir, 'rev-list', '--count', 'main'), '3\n');
    await assert.rejects(b.mergeFastForward(dir, 'scheduler/nope'), (e) => e.code === 'unknown-branch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('remove: deletes a merged branch, refuses an unmerged one without force', async () => {
  const dir = repo();
  try {
    const b = createBranches();
    branchWithCommit(dir, 'scheduler/p-1--sp-1', 'b.txt', 'feat (sp-1)');
    await assert.rejects(b.remove(dir, 'scheduler/p-1--sp-1'), (e) => e.code === 'unmerged');
    await b.mergeFastForward(dir, 'scheduler/p-1--sp-1');
    await b.remove(dir, 'scheduler/p-1--sp-1');
    assert.doesNotMatch(g(dir, 'branch', '--list'), /sp-1/);
    branchWithCommit(dir, 'scheduler/p-1--sp-2', 'c.txt', 'discard me');
    await b.remove(dir, 'scheduler/p-1--sp-2', { force: true });
    assert.doesNotMatch(g(dir, 'branch', '--list'), /sp-2/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
