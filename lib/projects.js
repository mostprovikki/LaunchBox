import { readdir, readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { join, basename } from 'node:path';
import {
  listProjects, getProject, createProject, updateProject, getProjectByPath,
  acquireLease, releaseLease, completeLease, attachLeaseRun, listLeases,
  createJob, updateJob, findJobByBead, getSetting,
} from './db.js';

// The beads poller (M4a §4a.4/§4a.5): for each *activated* project, ask
// `bd ready` what is actionable, take our own lease, and materialise the bead as
// an ordinary one-shot job so it inherits scheduling, concurrency caps, logs,
// SSE, the M2 budget guard and M3 pause for free.
//
// Two safety gates, and they are independent by design:
//   1. `autoLabel` — only beads carrying it are eligible. Opt-in, never opt-out.
//   2. human activation — discovery may only ever write `state: 'pending'`.
// An agent may write `.scheduler.json` and file beads; an agent must never
// activate a project. If it could do both, an agent could arrange for arbitrary
// unattended work to run on this machine.

export const DEFAULT_POLL_SEC = 60;
export const POLL_FLOOR_SEC = 15;
export const CONFIG_FILE = '.scheduler.json';

// Projects in these states are polled. `pending` never is — that is the airlock.
// `paused` is a human saying "not now". `error` IS polled, so a project recovers
// by itself once the cause is fixed rather than needing a manual poke.
const POLLED_STATES = new Set(['active', 'error']);

// `.scheduler.json` as the repo declares it. Absence of `autoLabel` is an
// error, NOT a default-to-all: most beads in a repo need a human in the loop,
// and without an explicit opt-in the first poll would happily run someone's
// design spike unattended.
export function parseProjectConfig(raw) {
  let obj;
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    return { ok: false, errors: [`${CONFIG_FILE} is not valid JSON: ${err.message}`], config: null };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: [`${CONFIG_FILE} must be a JSON object`], config: null };
  }
  const errors = [];
  const autoLabel = typeof obj.autoLabel === 'string' ? obj.autoLabel.trim() : '';
  if (!autoLabel) {
    errors.push(`${CONFIG_FILE} must set "autoLabel" — the label a bead must carry to be eligible for unattended runs. There is no default: without it nothing runs.`);
  }
  const num = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt);
  const config = {
    enabled: obj.enabled !== false,
    autoLabel,
    cwd: typeof obj.cwd === 'string' && obj.cwd ? obj.cwd : '.',
    maxConcurrent: num(obj.maxConcurrent, 1),
    defaults: {
      timeoutMin: num(obj.defaults?.timeoutMin, 30),
      model: typeof obj.defaults?.model === 'string' ? obj.defaults.model : 'default',
      notify: typeof obj.defaults?.notify === 'string' ? obj.defaults.notify : 'failure',
    },
    budget: obj.budget && typeof obj.budget === 'object' ? obj.budget : null,
  };
  return { ok: errors.length === 0, errors, config };
}

// What the agent is told. It must NOT close the bead: the scheduler ran the work
// and the scheduler owns the outcome, so closing is ours to do only on success.
export function beadPrompt(project, bead, { autoLabel }) {
  return [
    `Work on beads task ${bead.id} in the "${project.name}" project.`,
    '',
    `Title: ${bead.title}`,
    bead.type ? `Type: ${bead.type}` : null,
    typeof bead.priority === 'number' ? `Priority: ${bead.priority} (0 = critical)` : null,
    '',
    `This task was picked up automatically because it is ready — no open blocking`,
    `dependencies — and carries the "${autoLabel}" label.`,
    '',
    `Read the full task first: bd show ${bead.id}`,
    `It is already claimed for you (status: in_progress).`,
    '',
    `Do the work. Do NOT close the bead — the scheduler closes it if this run`,
    `succeeds, so that a failed or interrupted run leaves the task open for retry.`,
  ].filter((l) => l !== null).join('\n');
}

export function createProjects({
  db,
  beads,
  runner,
  worktrees = null,
  fsx = { readdir, readFile },
  now = () => Date.now(),
  intervalMs = null,
}) {
  const events = new EventEmitter();
  events.setMaxListeners(100);
  let timer = null;
  let polling = false;
  // Contention is expected (a human running bd in the same repo), so a single
  // timeout is an info-level event, not an alarm. What deserves attention is a
  // project that is busy every time, so we count consecutively.
  const busyStreak = new Map(); // projectId -> count
  const warnings = new Map(); // projectId -> string[]

  const setting = (k, d) => getSetting(db, k, d);
  const changed = () => events.emit('change');

  function pollMs() {
    if (intervalMs != null) return Math.max(POLL_FLOOR_SEC * 1000, intervalMs);
    const sec = Number(setting('beadsPollSec', DEFAULT_POLL_SEC));
    return Math.max(POLL_FLOOR_SEC * 1000, (Number.isFinite(sec) && sec > 0 ? sec : DEFAULT_POLL_SEC) * 1000);
  }

  const roots = () => String(setting('projectRoots', '') || '')
    .split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

  // --- discovery ---------------------------------------------------------
  // Writes `pending` and nothing else, ever. This function existing is not a
  // way to get work running; a human still has to activate what it finds.
  async function discover({ roots: only = null } = {}) {
    const found = [];
    for (const root of only ?? roots()) {
      let entries;
      try {
        entries = await fsx.readdir(root, { withFileTypes: true });
      } catch {
        continue; // a configured root that isn't there is not an error worth failing on
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const path = join(root, e.name);
        let raw;
        try {
          raw = await fsx.readFile(join(path, CONFIG_FILE), 'utf8');
        } catch {
          continue; // no declaration, not a candidate
        }
        const parsed = parseProjectConfig(raw);
        const existing = getProjectByPath(db, path);
        if (existing) {
          // Keep the declaration fresh, but never touch `state`: re-running
          // discovery must not re-activate something a human paused, nor
          // activate something that is merely pending.
          const upd = updateProject(db, existing.id, { config: parsed.config ?? {}, name: existing.name });
          found.push({ project: upd, created: false, errors: parsed.errors });
          continue;
        }
        const project = createProject(db, {
          name: parsed.config?.name || basename(path),
          path,
          state: 'pending',
          config: parsed.config ?? {},
        });
        found.push({ project, created: true, errors: parsed.errors });
      }
    }
    if (found.length) changed();
    return found;
  }

  // Learn where the database really is, and what bd we are talking to. Called at
  // registration/activation — `beadsDir` comes from `bd where`, never from
  // joining '.beads' onto the path, because a git worktree carries a hollow
  // `.beads/` that would satisfy the obvious guess and hold no data.
  async function refreshHealth(projectId) {
    const project = getProject(db, projectId);
    if (!project) return null;
    const health = await beads.healthy(project);
    const patch = { lastPollAt: new Date(now()).toISOString() };
    if (health.beadsDir) patch.beadsDir = health.beadsDir;
    if (health.ok) {
      try { patch.bdVersion = await beads.version(); } catch { /* version is a nicety here */ }
    }
    updateProject(db, projectId, patch);
    return health;
  }

  // --- the poll ----------------------------------------------------------

  // Everything that can stop a project contributing work, named in plain
  // language. "Contributing nothing" must never be silent — a project that
  // quietly does nothing is indistinguishable from a broken one.
  function explain(project, { health = null, config = null } = {}) {
    const reasons = [];
    if (project.state === 'pending') reasons.push('waiting for you to activate it');
    if (project.state === 'paused') reasons.push('paused');
    if (config && !config.autoLabel) reasons.push(`no "autoLabel" in ${CONFIG_FILE}, so no bead is eligible`);
    if (config && config.enabled === false) reasons.push(`disabled in its own ${CONFIG_FILE}`);
    if (health && !health.ok) reasons.push(health.reason);
    return reasons;
  }

  async function pollProject(projectId) {
    const project = getProject(db, projectId);
    if (!project) return { ok: false, reasons: ['project no longer exists'], started: [] };
    if (!POLLED_STATES.has(project.state)) {
      return { ok: true, skipped: true, reasons: explain(project), started: [], ready: [] };
    }

    const parsed = parseProjectConfig(project.config ?? {});
    const at = new Date(now()).toISOString();
    warnings.delete(project.id);

    // An unusable declaration is an error state, not a silent no-op — and
    // explicitly not "run everything".
    if (!parsed.ok || parsed.config.enabled === false) {
      const reasons = parsed.ok ? [`disabled in its own ${CONFIG_FILE}`] : parsed.errors;
      updateProject(db, project.id, {
        lastPollAt: at, lastPollOk: false, lastError: reasons.join('; '),
        state: parsed.ok ? project.state : 'error',
      });
      changed();
      return { ok: false, reasons, started: [], ready: [] };
    }
    const config = parsed.config;

    // A bd we have not verified is a bd we should not trust to have the same
    // JSON shapes. Warn loudly and keep going — failing closed here would take
    // every project down on a routine upgrade — but never warn *silently*.
    let liveVersion = null;
    try {
      liveVersion = await beads.version();
      if (project.bdVersion && liveVersion && project.bdVersion !== liveVersion) {
        const w = `bd version changed since this project was registered (was "${project.bdVersion}", now "${liveVersion}") — re-run the spike scripts in docs/spikes/ before trusting these results`;
        warnings.set(project.id, [w]);
        events.emit('warning', { projectId: project.id, message: w });
      }
    } catch (err) {
      updateProject(db, project.id, { lastPollAt: at, lastPollOk: false, lastError: err.message, state: 'error' });
      changed();
      return { ok: false, reasons: [err.message], started: [], ready: [] };
    }

    const health = await beads.healthy(project);
    if (!health.ok) {
      // Busy is NOT broken. A human holding the database is normal, the wait is
      // unbounded by design, and latching the project into `error` for it would
      // be crying wolf on the common case.
      if (health.busy) {
        const n = (busyStreak.get(project.id) ?? 0) + 1;
        busyStreak.set(project.id, n);
        updateProject(db, project.id, { lastPollAt: at, lastPollOk: false, lastError: null });
        events.emit('busy', { projectId: project.id, consecutive: n });
        return { ok: true, busy: true, consecutive: n, reasons: [health.reason], started: [], ready: [] };
      }
      updateProject(db, project.id, { lastPollAt: at, lastPollOk: false, lastError: health.reason, state: 'error' });
      changed();
      return { ok: false, reasons: [health.reason], started: [], ready: [] };
    }
    busyStreak.delete(project.id);

    let ready;
    try {
      ready = await beads.ready(project, { label: config.autoLabel });
    } catch (err) {
      if (err?.busy) {
        const n = (busyStreak.get(project.id) ?? 0) + 1;
        busyStreak.set(project.id, n);
        updateProject(db, project.id, { lastPollAt: at, lastPollOk: false, lastError: null });
        events.emit('busy', { projectId: project.id, consecutive: n });
        return { ok: true, busy: true, consecutive: n, reasons: [err.message], started: [], ready: [] };
      }
      // A bd failure marks the project and is reported — but it must never take
      // the poll loop down with it.
      updateProject(db, project.id, { lastPollAt: at, lastPollOk: false, lastError: err.message, state: 'error' });
      changed();
      return { ok: false, reasons: [err.message], started: [], ready: [] };
    }

    // A recovered project comes back out of `error` on its own.
    updateProject(db, project.id, {
      lastPollAt: at, lastPollOk: true, lastError: null,
      beadsDir: health.beadsDir ?? project.beadsDir,
      state: project.state === 'error' ? 'active' : project.state,
    });

    const started = [];
    const held = listLeases(db, { projectId: project.id, state: 'held' }).length;
    let slots = Math.max(0, config.maxConcurrent - held);
    for (const bead of ready) {
      if (slots <= 0) break;
      const r = await tryRun(getProject(db, project.id), bead, config);
      if (r.started) { started.push(r); slots -= 1; }
    }
    changed();
    return { ok: true, reasons: [], ready, started, warnings: warnings.get(project.id) ?? [] };
  }

  // --- one bead ----------------------------------------------------------
  async function tryRun(project, bead, config) {
    // The lease is the lock, and it is taken FIRST — before the re-read, before
    // the claim, before the launch. Everything after this point can fail safely
    // because this row is what prevents a second cycle touching the same bead.
    if (!acquireLease(db, { projectId: project.id, beadId: bead.id })) {
      return { started: false, beadId: bead.id, reason: 'already leased' };
    }

    const abandon = (reason) => {
      releaseLease(db, project.id, bead.id);
      events.emit('abandoned', { projectId: project.id, beadId: bead.id, reason });
      return { started: false, beadId: bead.id, reason };
    };

    // Pre-launch re-read. `ready` carries no `assignee`, so this must use
    // `bd show`. Between the poll and now a human may have taken the bead,
    // closed it, or blocked it.
    let fresh;
    try {
      fresh = await beads.get(project, bead.id);
    } catch (err) {
      return abandon(err?.busy ? 'beads was busy during the pre-launch re-read' : `pre-launch re-read failed: ${err.message}`);
    }
    if (!fresh) return abandon('bead no longer exists');
    if (fresh.status !== 'open') return abandon(`bead is no longer open (status: ${fresh.status})`);
    if (fresh.assignee) return abandon(`bead was assigned to ${fresh.assignee}`);

    // The notice board. Our lease already guarantees exclusivity; this is so a
    // human's session can see the bead is taken.
    const claim = await beads.claim(project, bead.id);
    if (!claim.ok) {
      // Someone else genuinely holds it — measured as compare-and-set, so this
      // is real evidence and not a flaky write.
      if (claim.claimedBy) return abandon(`bead was claimed by ${claim.claimedBy}`);
      // A timed-out claim definitely did not happen (no phantom write), so the
      // honest move is to give the bead back and retry on the next poll.
      if (claim.busy) return abandon('beads was busy when claiming — will retry');
      // Any other write failure does NOT stop the run: the lease is
      // authoritative and the claim is advisory. But it is logged.
      events.emit('claim-failed', { projectId: project.id, beadId: bead.id, reason: claim.reason });
    }

    // Isolate the work from the human's checkout. Failing to get a worktree is
    // a reason not to run, not a reason to run in their checkout instead.
    let cwd = join(project.path, config.cwd);
    const root = setting('worktreeRoot', '') || null;
    if (worktrees && root) {
      try {
        const wt = await worktrees.ensure(project, { root });
        cwd = config.cwd && config.cwd !== '.' ? join(wt.path, config.cwd) : wt.path;
      } catch (err) {
        return abandon(`could not prepare a git worktree: ${err.message}`);
      }
    }

    const job = materialise(project, bead, config, cwd);
    const run = runner.start(job, 'beads');
    if (!run) return abandon('runner declined to start the job');
    attachLeaseRun(db, project.id, bead.id, run.id);

    // `skipped` means a guard (M2 budget, M3 pause, or a job already running)
    // refused it. That is not a failure of the bead — hand it straight back.
    if (run.status === 'skipped') {
      releaseLease(db, project.id, bead.id);
      events.emit('abandoned', { projectId: project.id, beadId: bead.id, reason: 'a scheduling guard skipped this run' });
      return { started: false, beadId: bead.id, runId: run.id, reason: 'skipped by a guard' };
    }

    onDone(project, bead, run.id);
    events.emit('started', { projectId: project.id, beadId: bead.id, runId: run.id, jobId: job.id });
    return { started: true, beadId: bead.id, runId: run.id, jobId: job.id };
  }

  // One job row per bead, reused on every run of that bead. That reuse is what
  // preserves learned cost: `run_usage` keys by jobId, so a stable row means
  // `avgDeltaForJob` accumulates this bead's real cost instead of resetting to
  // the default estimate every time (§4a.7).
  function materialise(project, bead, config, cwd) {
    const params = {
      prompt: beadPrompt(project, bead, { autoLabel: config.autoLabel }),
      model: config.defaults.model,
      _beadId: bead.id,
      _projectId: project.id,
    };
    if (config.budget) params.budget = config.budget;
    const shape = {
      name: `${project.name}: ${bead.title}`.slice(0, 200),
      type: 'claude',
      params,
      cwd,
      // Disabled with a spent one-shot schedule: this row exists to be launched
      // directly by the poller and must never be armed by the cron scheduler.
      schedule: { type: 'once', at: new Date(now()).toISOString() },
      enabled: false,
      timeoutMin: config.defaults.timeoutMin,
      notify: config.defaults.notify,
    };
    const existing = findJobByBead(db, project.id, bead.id);
    return existing ? updateJob(db, existing.id, shape) : createJob(db, shape);
  }

  // The outcome contract: a bead is closed ONLY when the run succeeded.
  function onDone(project, bead, runId) {
    runner.events.once(`done:${runId}`, async (status) => {
      try {
        if (status !== 'ok') {
          // fail / killed / stopped / skipped all leave the bead OPEN and
          // release the lease so a later poll can retry it. An M3 `stopped` is a
          // deliberate wind-down, not a failure — treating it as one would close
          // a task nobody finished.
          releaseLease(db, project.id, bead.id);
          events.emit('finished', { projectId: project.id, beadId: bead.id, runId, status, closed: false });
          changed();
          return;
        }
        const res = await beads.close(project, bead.id, { reason: `completed by claude-scheduler run ${runId}` });
        if (res.ok) {
          completeLease(db, project.id, bead.id);
        } else {
          // The work is done but the bookkeeping is not. Release rather than
          // complete so the state stays honest; a human (or a retry) can close it.
          releaseLease(db, project.id, bead.id);
          events.emit('close-failed', { projectId: project.id, beadId: bead.id, runId, reason: res.reason, busy: !!res.busy });
        }
        events.emit('finished', { projectId: project.id, beadId: bead.id, runId, status, closed: res.ok });
        changed();
      } catch (err) {
        releaseLease(db, project.id, bead.id);
        events.emit('close-failed', { projectId: project.id, beadId: bead.id, runId, reason: err.message, busy: false });
        changed();
      }
    });
  }

  // --- loop --------------------------------------------------------------
  async function pollAll() {
    if (polling) return [];
    polling = true;
    const out = [];
    try {
      for (const p of listProjects(db)) {
        if (!POLLED_STATES.has(p.state)) continue;
        try {
          out.push({ projectId: p.id, ...(await pollProject(p.id)) });
        } catch (err) {
          // Belt and braces: one project's surprise must not stop the others,
          // and must not kill the interval.
          events.emit('error', { projectId: p.id, message: err?.message ?? String(err) });
          out.push({ projectId: p.id, ok: false, reasons: [err?.message ?? String(err)], started: [] });
        }
      }
    } finally {
      polling = false;
    }
    return out;
  }

  function start() {
    if (timer) return;
    // unref: the daemon is held open by its HTTP listener, not by this.
    timer = setInterval(() => { pollAll().catch(() => {}); }, pollMs());
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    events, start, stop, pollAll, pollProject, discover, refreshHealth, explain,
    warningsFor: (id) => warnings.get(id) ?? [],
    busyStreakFor: (id) => busyStreak.get(id) ?? 0,
  };
}
