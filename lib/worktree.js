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

const sanitise = (s, fallback) => String(s ?? '')
  .replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;

// FNV-1a, only ever used to disambiguate two ids that sanitise to the same
// string. Not security-relevant; short on purpose so the directory stays legible.
function digest(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).slice(0, 6);
}

// Per project, or per *bead* when a beadId is given (M4). Per-bead is what lets a
// burst run more than one of a project's beads at once: one worktree per project
// meant two of our own runs shared a checkout AND a branch and edited each
// other's files, so concurrency had to be clamped to 1.
//
// ⚠️ The bead level is joined with `--`, deliberately NOT a `/`. Two reasons, both
// found by thinking about what already exists on disk:
//   - Git refuses a branch `a/b` when branch `a` exists (ref directory/file
//     conflict), and installs from M4a already have per-project
//     `scheduler/<proj>-<id8>` branches — so nesting would fail on exactly the
//     repos that have been running longest.
//   - A nested *path* would put the bead's worktree inside the project's old
//     worktree, which then reports `?? sp-1/` in its own status — the same
//     littering the "root must live outside the repo" rule exists to prevent.
export function worktreeName(project, beadId = null) {
  const base = sanitise(project.name || 'project', 'project');
  // The id keeps two same-named projects apart; the name keeps the directory
  // legible to a human who stumbles on it.
  const dir = `${base}-${String(project.id).slice(0, 8)}`;
  if (beadId == null) return dir;
  const safe = sanitise(beadId, 'bead');
  // Sanitising can collapse two distinct ids onto one name (`sp/1` and `sp-1`),
  // and two beads sharing a worktree is the collision this whole change removes.
  // Equality is what matters here, not prefixes: `sp-1` and `sp-12` are already
  // different directories.
  return `${dir}--${safe === String(beadId) ? safe : `${safe}-${digest(String(beadId))}`}`;
}

export const branchFor = (project, beadId = null) => `scheduler/${worktreeName(project, beadId)}`;

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
    async ensure(project, { root, beadId = null }) {
      if (!root) throw new WorktreeError('worktreeRoot is not configured');
      const path = join(root, worktreeName(project, beadId));
      const existing = await list(project.path);
      if (existing.includes(path)) return { path, created: false };

      const branch = branchFor(project, beadId);
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
    //
    // ⚠️ `beadId` must match whatever `ensure` was given. Both compute the path
    // independently, so a mismatch reaps a different directory — or, worse, none,
    // leaving a leak that looks like it was cleaned up.
    async remove(project, { root, beadId = null }) {
      const path = join(root, worktreeName(project, beadId));
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
