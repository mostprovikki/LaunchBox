// lib/branches.js — the review queue's git half. Lists the scheduler's bead branches that
// main has not absorbed, fast-forwards one into main, deletes one. Every mutation refuses
// rather than leaving partial state: a dirty primary checkout and a non-fast-forward both
// stop before git moves anything (validate → authorize → write, CLAUDE.md).
import { execFile } from 'node:child_process';

export class BranchError extends Error {
  constructor(message, { code = 'git', stderr = '' } = {}) {
    super(message); this.name = 'BranchError'; this.code = code; this.stderr = stderr;
  }
}

const PREFIX = 'scheduler/';
const SNAPSHOT_RE = /^wip\([^)]+\): uncommitted work at run end/;

/** The bead id is the segment after the LAST `--` (lib/worktree.js worktreeName). */
export function parseBeadId(branch) {
  const name = branch.startsWith(PREFIX) ? branch.slice(PREFIX.length) : null;
  if (!name) return null;
  const i = name.lastIndexOf('--');
  return i === -1 ? null : name.slice(i + 2) || null;
}

export function createBranches({ execFileFn = execFile, timeoutMs = 20_000 } = {}) {
  function git(cwd, args) {
    return new Promise((resolve) => {
      execFileFn('git', args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, exitCode: err?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    });
  }
  const must = async (cwd, args, what) => {
    const r = await git(cwd, args);
    if (!r.ok) throw new BranchError(`${what}: ${r.stderr.trim() || `git exited ${r.exitCode}`}`, { stderr: r.stderr });
    return r.stdout;
  };

  async function exists(repoPath, branch) {
    return (await git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
  }
  async function aheadBehind(repoPath, branch) {
    const out = await must(repoPath, ['rev-list', '--left-right', '--count', `main...${branch}`], 'could not count commits');
    const [behind, ahead] = out.trim().split(/\s+/).map(Number);
    return { ahead, behind };
  }

  return {
    async list(repoPath) {
      const out = await must(repoPath, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${PREFIX}`], 'could not list branches');
      const rows = [];
      for (const branch of out.split('\n').map((s) => s.trim()).filter(Boolean)) {
        const { ahead, behind } = await aheadBehind(repoPath, branch);
        if (ahead === 0) continue; // main already has everything on it
        const tip = await must(repoPath, ['log', '-1', '--format=%h%x00%s', branch], 'could not read tip');
        const [tipSha, tipSubject] = tip.trim().split('\0');
        const shortstat = (await must(repoPath, ['diff', '--shortstat', `main...${branch}`], 'could not diff')).trim();
        rows.push({ branch, beadId: parseBeadId(branch), ahead, behind, shortstat, tipSha, tipSubject, snapshotTip: SNAPSHOT_RE.test(tipSubject) });
      }
      return rows;
    },

    async mergeFastForward(repoPath, branch) {
      if (!await exists(repoPath, branch)) throw new BranchError(`no branch ${branch}`, { code: 'unknown-branch' });
      const status = await must(repoPath, ['status', '--porcelain'], 'could not read status');
      if (status.trim()) throw new BranchError('the primary checkout has uncommitted changes; commit or stash them first', { code: 'dirty' });
      const { behind } = await aheadBehind(repoPath, branch);
      if (behind > 0) throw new BranchError(`${branch} is ${behind} commit(s) behind main — not a fast-forward; rebase it first`, { code: 'not-ff' });
      const head = (await must(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], 'could not read HEAD')).trim();
      if (head !== 'main') throw new BranchError(`the primary checkout is on ${head}, not main`, { code: 'dirty' });
      await must(repoPath, ['merge', '--ff-only', '-q', branch], 'merge refused');
      const sha = (await must(repoPath, ['rev-parse', '--short', 'HEAD'], 'could not read HEAD')).trim();
      return { ok: true, sha };
    },

    async remove(repoPath, branch, { force = false } = {}) {
      if (!await exists(repoPath, branch)) throw new BranchError(`no branch ${branch}`, { code: 'unknown-branch' });
      if (!force) {
        const { ahead } = await aheadBehind(repoPath, branch);
        if (ahead > 0) throw new BranchError(`${branch} has ${ahead} commit(s) main does not — pass force to discard them`, { code: 'unmerged' });
      }
      await must(repoPath, ['branch', force ? '-D' : '-d', branch], 'could not delete branch');
      return { ok: true };
    },
  };
}
