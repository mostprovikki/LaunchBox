import { execFile } from 'node:child_process';

// The only place in the scheduler that knows `bd` exists (M4a §4a.3). Every call
// is `--json` and every shape is normalised here, so a breaking `bd` release is
// a one-file fix rather than a hunt through the poller and the UI.
//
// Everything below encodes behaviour that was *measured* against bd 1.1.0 in
// docs/spikes/m4a-beads-lock-contention.sh and m4a-beads-worktree.sh. The
// comments say which finding forces which line — if one of those scripts starts
// failing, this file is what needs rereading.

// Uncontended calls measured at 200–700ms. The timeout exists for a different
// reason than slowness: under lock contention `bd` does not fail, it waits
// *indefinitely* (measured: 104s of waiting for a 100s hold, exit 0, empty
// stderr). There is no error to retry and no upper bound, so a client-side
// deadline is the only thing standing between a busy repo and a wedged daemon.
export const BD_TIMEOUT_MS = 15_000;

// `bd --version` never opens the database, so contention cannot hang it — it is
// the one call that needs no deadline for lock reasons. It still gets a generous
// one, because a misconfigured `bdPath` pointing at something that reads stdin
// would otherwise hang forever, which is a different failure with the same shape.
export const BD_VERSION_TIMEOUT_MS = 10_000;

// Killing a blocked `bd` is safe: the spike showed a claim interrupted mid-wait
// leaves the bead untouched under both SIGTERM and SIGKILL, with no write
// landing later when the holder releases. SIGTERM suffices — the blocked
// process does die — and that measured absence of phantom writes is what makes
// a timeout usable at all: a timed-out claim *definitely did not happen*.
const KILL_SIGNAL = 'SIGTERM';

// `bd ready` on a large graph is still only tens of KB, but the default 1MB
// execFile buffer is a silly thing to discover in production.
const MAX_BUFFER = 16 * 1024 * 1024;

// Who bd records as having done this. Without it bd falls back to the *repo's*
// git user.name, so every scheduler claim would show up under the human's own
// name — which defeats the entire point of the claim as a notice board ("this
// bead is taken" — by whom?) and makes our writes indistinguishable from theirs
// in the audit trail. Measured: `--claim` under this actor reports
// `assignee: claude-scheduler`.
export const BD_ACTOR = 'claude-scheduler';

export class BeadsError extends Error {
  constructor(message, { busy = false, exitCode = null, stderr = '', args = [] } = {}) {
    super(message);
    this.name = 'BeadsError';
    // `busy` means "the repo is in use, try later" — NOT "beads is broken".
    // Contention is normal when a human is running bd in the same repo, so
    // callers must not latch a project into an error state on it.
    this.busy = busy;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.args = args;
  }
}

// One `bd` invocation. Never throws for a non-zero exit — several are expected
// outcomes (a claim losing a race exits 1) — so it reports and lets each method
// decide. Only a spawn failure or a timeout is exceptional.
function invoke({ execFileFn, bdPath, args, beadsDir, cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    // BD_NON_INTERACTIVE is auto-detected for a non-TTY, but a daemon should
    // never rely on detection. BEADS_DIR is what makes resolution explicit:
    // bd *can* find the primary checkout's database from a worktree by itself,
    // via git, but that is undocumented behaviour whose failure mode is a
    // silent hollow `.beads/` — so we always say where the database is.
    const env = { ...process.env, BD_NON_INTERACTIVE: '1', BEADS_ACTOR: BD_ACTOR };
    if (beadsDir) env.BEADS_DIR = beadsDir;

    const opts = { env, timeout: timeoutMs, killSignal: KILL_SIGNAL, maxBuffer: MAX_BUFFER };
    if (cwd) opts.cwd = cwd;

    let child;
    try {
      child = execFileFn(bdPath, args, opts, (err, stdout, stderr) => {
        const out = stdout == null ? '' : String(stdout);
        const errOut = stderr == null ? '' : String(stderr);
        if (!err) {
          resolve({ ok: true, exitCode: 0, stdout: out, stderr: errOut });
          return;
        }
        // A timeout kills the child, so node reports `killed` and/or a signal.
        // Distinguish it from a real failure before anything else: this is the
        // contention case and it must surface as "busy", not "broken".
        if (err.killed || err.signal) {
          reject(new BeadsError(`bd ${args[0] ?? ''} timed out after ${timeoutMs}ms (database busy)`,
            { busy: true, stderr: errOut, args }));
          return;
        }
        // A string `code` is a spawn failure (ENOENT = no such binary); a
        // number is an exit status, which is a normal result here.
        if (typeof err.code === 'string') {
          reject(new BeadsError(`bd could not be run (${err.code}): ${bdPath}`,
            { exitCode: null, stderr: errOut, args }));
          return;
        }
        resolve({ ok: false, exitCode: typeof err.code === 'number' ? err.code : 1, stdout: out, stderr: errOut });
      });
    } catch (err) {
      reject(new BeadsError(`bd could not be spawned: ${err?.message ?? err}`, { args }));
      return;
    }
    // A fake execFile in tests need not return a child object.
    if (child && typeof child.on === 'function') child.on('error', () => {});
  });
}

// bd's own account of a failure, in a form worth showing a person.
//
// Two things learned by reading real failures rather than guessing: some are
// reported on **stdout** rather than stderr (so keying only on stderr yields the
// useless "failed (exit 1): no stderr"), and under `--json` they arrive as an
// envelope — `{error, message, hint, schema_version}`. Dumping that envelope raw
// puts pretty-printed JSON in a UI sentence, when `message` + `hint` is exactly
// the sentence we wanted.
export function bdErrorText(res) {
  const said = (res.stderr || '').trim() || (res.stdout || '').trim();
  if (!said) return '';
  try {
    const obj = JSON.parse(said);
    const parts = [obj?.message, obj?.hint].filter((s) => typeof s === 'string' && s.trim());
    if (parts.length) return parts.join(' ');
  } catch { /* not an envelope — the raw text is the best we have */ }
  return said;
}

// Success is the exit code and nothing else. `bd` writes warnings to stderr on
// perfectly good runs (`beads.role not configured`, `.beads` perms 0755 vs
// recommended 0700), so treating non-empty stderr as failure would fail every
// call on a normally-configured repo.
function must(res, what) {
  if (!res.ok) {
    const said = bdErrorText(res);
    throw new BeadsError(`bd ${what} failed (exit ${res.exitCode})${said ? `: ${said}` : ''}`,
      { exitCode: res.exitCode, stderr: res.stderr, args: [what] });
  }
  return res;
}

function parseJson(res, what) {
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new BeadsError(`bd ${what} returned unparseable JSON: ${res.stdout.slice(0, 200)}`,
      { exitCode: res.exitCode, stderr: res.stderr, args: [what] });
  }
}

// Our shape, never bd's. Three renames matter and all three were measured:
//   * `issue_type`, not `type` — the field we most want is the one renamed.
//   * `labels` is OMITTED ENTIRELY for an unlabelled bead — not [], not null.
//     `b.labels.includes(autoLabel)` would throw on the first unlabelled bead,
//     and that filter is the safety gate deciding what may run unattended.
//   * `assignee`/`started_at` appear in `show` and `update --claim` output but
//     NOT in `ready`, which is why the pre-launch re-read cannot use `ready`.
export function normaliseBead(b) {
  return {
    id: b.id,
    title: b.title ?? '',
    status: b.status ?? null,
    priority: typeof b.priority === 'number' ? b.priority : null,
    type: b.issue_type ?? null,
    labels: Array.isArray(b.labels) ? b.labels : [],
    assignee: b.assignee ?? null,
    startedAt: b.started_at ?? null,
    createdAt: b.created_at ?? null,
    updatedAt: b.updated_at ?? null,
    dependencyCount: b.dependency_count ?? 0,
    dependentCount: b.dependent_count ?? 0,
    commentCount: b.comment_count ?? 0,
  };
}

// `bd show --json` and `bd update --claim --json` both return a ONE-ELEMENT
// ARRAY rather than an object. Plain `bd ready --json` is a bare array of beads.
function firstOf(parsed) {
  if (Array.isArray(parsed)) return parsed[0] ?? null;
  return parsed ?? null;
}

// A losing claim exits 1 with `Error claiming sp-x: issue already claimed by <actor>`.
// The spike measured `--claim` as genuinely compare-and-set (8 concurrent
// claims, exactly 1 winner), so this is a real signal and worth reporting with
// the winner's name — a far better log line than "claim failed".
const ALREADY_CLAIMED = /already claimed by\s+(\S+)/i;

export function createBeads({
  db,
  execFileFn = execFile,
  bdPath = () => 'bd',
  timeoutMs = BD_TIMEOUT_MS,
  versionTimeoutMs = BD_VERSION_TIMEOUT_MS,
} = {}) {
  const resolveBd = typeof bdPath === 'function' ? bdPath : () => bdPath;
  let versionCache = null;

  // `project` may be a full row or any `{beadsDir, path}`-ish object. `beadsDir`
  // is passed as BEADS_DIR; `path` is only ever the cwd, never a source for
  // deriving the beads location.
  const call = (project, args, ms = timeoutMs) => invoke({
    execFileFn,
    bdPath: resolveBd(),
    args,
    beadsDir: project?.beadsDir ?? null,
    cwd: project?.path ?? null,
    timeoutMs: ms,
  });

  return {
    // Cached: the pinned-version assertion runs at boot and on every project
    // registration, and it cannot change under a running daemon.
    async version() {
      if (versionCache != null) return versionCache;
      const res = await invoke({
        execFileFn, bdPath: resolveBd(), args: ['--version'],
        beadsDir: null, cwd: null, timeoutMs: versionTimeoutMs,
      });
      must(res, '--version');
      versionCache = res.stdout.trim();
      return versionCache;
    },

    // Forget the cached version — for tests and for a deliberate re-check after
    // the operator upgrades bd under a running daemon.
    resetVersion() { versionCache = null; },

    // Where does bd think this repo's database is? This is BOTH the health probe
    // and the only sanctioned way to learn `beadsDir`.
    //
    // Never derive `beadsDir` by joining '.beads' onto the repo path: a git
    // worktree contains a *hollow* `.beads/` — the directory and its committed
    // config are present, the (gitignored) database is not — so a derived path
    // can point somewhere that exists and holds nothing. `database_path` being
    // present is the real test, and it is what distinguishes "no beads here"
    // from "beads here but unusable".
    async where(project) {
      const res = await call(project, ['where', '--json']);
      must(res, 'where');
      const parsed = parseJson(res, 'where');
      const obj = Array.isArray(parsed) ? parsed[0] ?? {} : parsed ?? {};
      return {
        beadsDir: obj.path ?? null,
        databasePath: obj.database_path ?? null,
        prefix: obj.prefix ?? null,
      };
    },

    // Cheap, no DB write, and it never throws — the Projects tab wants a reason,
    // not an exception. Note this DOES touch the database and therefore CAN
    // block, so it is subject to the same timeout as everything else; a busy
    // repo reports `busy: true` and must not be shown as broken.
    async healthy(project) {
      try {
        const { beadsDir, databasePath, prefix } = await this.where(project);
        if (!databasePath) {
          return {
            ok: false, busy: false, beadsDir, databasePath: null, prefix,
            reason: 'beads is present but has no database here (a git worktree carries a hollow .beads/ — register the primary checkout)',
          };
        }
        return { ok: true, busy: false, beadsDir, databasePath, prefix, reason: null };
      } catch (err) {
        const busy = !!err?.busy;
        // The overwhelmingly common failure is "this repo has no beads graph", and
        // a raw `bd where failed (exit 1)` makes that look like a malfunction
        // rather than the one-line fix it is. Named plainly, with bd's own words
        // kept on the end so a genuinely odd failure is still diagnosable.
        const notInitialised = !busy && err?.exitCode != null;
        return {
          ok: false,
          busy,
          beadsDir: null,
          databasePath: null,
          prefix: null,
          reason: busy
            ? 'beads database is busy (another bd or dolt process holds it)'
            : notInitialised
              ? `no beads database in this repo — bd could not locate one, so there is no backlog to poll (run \`bd init\` there if it should have one). bd said: ${err.message}`
              : (err?.message ?? String(err)),
        };
      }
    },

    // Actionable work: open, unblocked, and — critically — carrying `autoLabel`.
    //
    // The label is filtered TWICE on purpose. `--label` lets bd do it, and the
    // JS filter repeats it because this is the gate that decides what may run
    // unattended: if a future bd release changes `--label` semantics, the
    // consequence must be "we run nothing" and not "we run someone's design
    // spike". An absent `label` returns nothing at all rather than everything —
    // §4a.4 makes `autoLabel` mandatory, so no label means no eligible work.
    async ready(project, { label, limit = 100 } = {}) {
      if (!label) return [];
      const args = ['ready', '--json', '--label', label, '--limit', String(limit)];
      const res = await call(project, args);
      must(res, 'ready');
      const parsed = parseJson(res, 'ready');
      // Top level is a bare array — `[]` when empty, never null, exit 0.
      const rows = Array.isArray(parsed) ? parsed : (parsed?.ready ?? []);
      return rows.map(normaliseBead).filter((b) => b.labels.includes(label));
    },

    // The pre-launch re-read (§4a.5): has anything changed since we polled?
    // Must be `show`, not `ready`, because only `show` carries `assignee`.
    async get(project, beadId) {
      const res = await call(project, ['show', beadId, '--json']);
      if (!res.ok) {
        // A missing bead is a legitimate answer, not a failure to escalate.
        if (/not found|no such issue/i.test(res.stderr)) return null;
        must(res, `show ${beadId}`);
      }
      const bead = firstOf(parseJson(res, `show ${beadId}`));
      return bead ? normaliseBead(bead) : null;
    },

    // The notice board, not the lock. Written after our lease is held so a
    // human's session can see the bead is taken.
    //
    // Returns a result rather than throwing: losing a claim race is an expected
    // outcome, and a timeout is "definitely did not happen" (measured — no
    // phantom write lands later), so both are reportable states. `--claim` is
    // documented idempotent for the same actor, which makes a retry safe.
    async claim(project, beadId) {
      let res;
      try {
        res = await call(project, ['update', beadId, '--claim', '--json']);
      } catch (err) {
        if (err?.busy) return { ok: false, busy: true, claimedBy: null, bead: null, reason: err.message };
        throw err;
      }
      if (!res.ok) {
        const m = ALREADY_CLAIMED.exec(res.stderr);
        return {
          ok: false,
          busy: false,
          claimedBy: m ? m[1] : null,
          bead: null,
          reason: bdErrorText(res) || `exit ${res.exitCode}`,
        };
      }
      // `--json` output is a one-element array carrying assignee + started_at.
      let bead = null;
      try { bead = firstOf(JSON.parse(res.stdout)); } catch { /* claim landed; shape is a bonus */ }
      return { ok: true, busy: false, claimedBy: bead?.assignee ?? null, bead: bead ? normaliseBead(bead) : null, reason: null };
    },

    // Leave a note on the bead. Used to record what a run concluded when it did
    // NOT signal completion — so the next person to look at the task reads the
    // agent's own last words instead of finding an unexplained retry. Shorthand
    // for `bd update <id> --append-notes`, so it appends and never overwrites
    // whatever a human wrote there.
    //
    // Never fatal: failing to annotate must not change what happens to the bead.
    async note(project, beadId, text) {
      try {
        const res = await call(project, ['note', beadId, String(text ?? '').slice(0, 4000)]);
        if (!res.ok) return { ok: false, busy: false, reason: bdErrorText(res) || `exit ${res.exitCode}` };
        return { ok: true, busy: false, reason: null };
      } catch (err) {
        if (err?.busy) return { ok: false, busy: true, reason: err.message };
        return { ok: false, busy: false, reason: err?.message ?? String(err) };
      }
    },

    // Hand a bead back. The counterpart to `claim`, and the fix for a bug that
    // live-driving exposed: `bd ready` EXCLUDES `in_progress`, so a bead we
    // claimed and then did not finish is not merely un-leased, it is *invisible*
    // to every future poll. Releasing our own lease is not enough — without this
    // the "fail/stopped/killed leaves the bead open for retry" contract silently
    // means "that bead is never offered again".
    //
    // Measured (bd 1.1.0): `--status open --assignee ""` in one call restores it
    // to `bd ready` (an assignee alone does not keep a bead out of ready, but
    // leaving ours on it would misreport who holds it), rc 0, and unlike `--claim`
    // this one DOES append to the audit log — two lines, one per changed field.
    //
    // Only ever called for a claim WE placed. Un-claiming a bead a human just
    // took would be actively harmful, which is why the caller tracks whether its
    // own claim landed rather than inferring it from the bead's state.
    async release(project, beadId) {
      try {
        const res = await call(project, ['update', beadId, '--status', 'open', '--assignee', '']);
        if (!res.ok) return { ok: false, busy: false, reason: bdErrorText(res) || `exit ${res.exitCode}` };
        return { ok: true, busy: false, reason: null };
      } catch (err) {
        if (err?.busy) return { ok: false, busy: true, reason: err.message };
        throw err;
      }
    },

    // Closing is what makes a bead done — and the one call that dirties the
    // human's checkout. `bd close` appends a line to `.beads/interactions.jsonl`,
    // which is git-tracked and cannot be suppressed (no config key;
    // BD_NO_AUDIT and audit.enabled have no effect). It lands in the PRIMARY
    // checkout even when run from a worktree, because the audit log follows the
    // resolved beads dir. Decided in §4a.6: leave the line (it is meant to be
    // committed) and tell the user to expect it, rather than concealing it or
    // committing on their behalf.
    async close(project, beadId, { reason } = {}) {
      const args = ['close', beadId];
      if (reason) args.push('--reason', reason);
      try {
        const res = await call(project, args);
        if (!res.ok) {
          return { ok: false, busy: false, reason: bdErrorText(res) || `exit ${res.exitCode}` };
        }
        return { ok: true, busy: false, reason: null };
      } catch (err) {
        if (err?.busy) return { ok: false, busy: true, reason: err.message };
        throw err;
      }
    },
  };
}
