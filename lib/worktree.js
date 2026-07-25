import { execFile } from 'node:child_process';
import { join } from 'node:path';

// Git worktree lifecycle for scheduled work (M4a §4a.5).
//
// WHY: the contended resource that actually matters is not the beads database —
// it is the *working tree*. Two agents editing one checkout is a lost race no
// amount of task-level locking prevents. So scheduled work runs in its own
// worktree and the human keeps `main` mid-edit, untouched.
//
// The worktree root must live OUTSIDE the repo: the spike found that a worktree
// created inside the primary checkout shows up as `?? .worktrees/` in the
// human's `git status` — littering the very checkout we promised not to touch.
//
// Note what this does NOT protect: `bd close` appends to the git-tracked
// `.beads/interactions.jsonl`, and that follows the resolved beads dir, so it
// lands in the PRIMARY checkout even when the close runs from here. Measured;
// unavoidable; see §4a.6.

const GIT_TIMEOUT_MS = 30_000;

export class WorktreeError extends Error {
  constructor(message, { stderr = '', args = [] } = {}) {
    super(message);
    this.name = 'WorktreeError';
    this.stderr = stderr;
    this.args = args;
  }
}

// One worktree per project, reused across runs — creating one per bead would
// multiply clone cost and leave a mess to reap for every task.
export function worktreeName(project) {
  const base = (project.name || 'project').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  // The id keeps two same-named projects apart; the name keeps the directory
  // legible to a human who stumbles on it.
  return `${base}-${String(project.id).slice(0, 8)}`;
}

export const branchFor = (project) => `scheduler/${worktreeName(project)}`;

export function createWorktrees({ execFileFn = execFile, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  function git(cwd, args) {
    return new Promise((resolve, reject) => {
      execFileFn('git', args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const out = stdout == null ? '' : String(stdout);
        const errOut = stderr == null ? '' : String(stderr);
        if (err) {
          if (typeof err.code === 'number') { resolve({ ok: false, exitCode: err.code, stdout: out, stderr: errOut }); return; }
          reject(new WorktreeError(`git failed (${err.code ?? err.message}): ${args.join(' ')}`, { stderr: errOut, args }));
          return;
        }
        resolve({ ok: true, exitCode: 0, stdout: out, stderr: errOut });
      });
    });
  }

  // `git worktree list --porcelain` is the only trustworthy answer to "does this
  // worktree exist?" — a bare directory check would be fooled by a leftover
  // folder whose registration git has already pruned.
  async function list(repoPath) {
    const res = await git(repoPath, ['worktree', 'list', '--porcelain']);
    if (!res.ok) throw new WorktreeError(`git worktree list failed: ${res.stderr.trim()}`, { stderr: res.stderr });
    return res.stdout.split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim());
  }

  async function branchExists(repoPath, branch) {
    const res = await git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return res.ok;
  }

  return {
    list,
    branchExists,

    // Idempotent: returns the existing worktree if it is already registered, so a
    // poll every 60s does not churn the disk.
    async ensure(project, { root }) {
      if (!root) throw new WorktreeError('worktreeRoot is not configured');
      const path = join(root, worktreeName(project));
      const existing = await list(project.path);
      if (existing.includes(path)) return { path, created: false };

      const branch = branchFor(project);
      // Reuse the branch across re-creations so the scheduler's history survives
      // a reaped worktree; only create it when it isn't there yet.
      const args = await branchExists(project.path, branch)
        ? ['worktree', 'add', path, branch]
        : ['worktree', 'add', '-b', branch, path];
      const res = await git(project.path, args);
      if (!res.ok) {
        throw new WorktreeError(`could not create worktree at ${path}: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
          { stderr: res.stderr, args });
      }
      return { path, created: true };
    },

    // Reap. `--force` because the agent will have left edits behind and we are
    // deliberately discarding them; the branch is kept so nothing is truly lost.
    async remove(project, { root }) {
      const path = join(root, worktreeName(project));
      const res = await git(project.path, ['worktree', 'remove', '--force', path]);
      if (!res.ok && !/not a working tree|is not a valid/i.test(res.stderr)) {
        throw new WorktreeError(`could not remove worktree ${path}: ${res.stderr.trim()}`, { stderr: res.stderr });
      }
      return { path, removed: res.ok };
    },

    // Is the human's checkout clean? Used only for reporting — we never block on
    // it, because the worktree means we are not competing for their files anyway.
    async isDirty(repoPath) {
      const res = await git(repoPath, ['status', '--porcelain']);
      if (!res.ok) return null;
      return res.stdout.trim().length > 0;
    },
  };
}
