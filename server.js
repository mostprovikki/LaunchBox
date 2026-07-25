import express from 'express';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ensureDirs, dbPath } from './lib/paths.js';
import {
  openDb, createJob, listJobs, getJob, updateJob, deleteJob,
  insertRun, getRun, listRuns, lastRun, failOrphanRuns,
  getSetting, setSetting, cleanupAll, listUsageSnapshots,
  listProjects, getProject, getProjectByPath, createProject, updateProject, deleteProject,
  listLeases, listJobsByProject,
} from './lib/db.js';
import { validateJob, previewSchedule, scheduleEntries } from './lib/validate.js';
import { loadExtensions, manifest, validateFields } from './lib/extensions.js';
import { createRunner, DEFAULT_SOFT_GRACE_MS } from './lib/runner.js';
import { createScheduler } from './lib/scheduler.js';
import { createAwake, DEFAULT_RESET_LEAD_MIN } from './lib/awake.js';
import { createPauseController, PAUSE_MODES } from './lib/pause.js';
import { createUsageMonitor, POLL_FLOOR_SEC, DEFAULT_POLL_SEC, USAGE_SHOW_MODES } from './lib/usage.js';
import { createBudgetPolicy } from './lib/budget.js';
import { createBurst, BURST_DEFAULTS } from './lib/burst.js';
import { createBeads } from './lib/beads.js';
import { createWorktrees } from './lib/worktree.js';
import {
  createProjects, parseProjectConfig, CONFIG_FILE,
  DEFAULT_POLL_SEC as BEADS_DEFAULT_POLL_SEC, POLL_FLOOR_SEC as BEADS_POLL_FLOOR_SEC,
} from './lib/projects.js';
import { startUninstall } from './lib/uninstall.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
// Ceiling on one confirmed burn-down plan. A plan is a preview a human read: at
// some size that stops being true, and 200 one-shot entries on a job is already
// well past anything worth confirming in one click.
const PLAN_SLOT_MAX = 200;

// The one honest asterisk on "the scheduler never touches your checkout" (M4a
// §4a.6, decision (b) settled with the user). `bd close` appends to a git-tracked
// file, it cannot be suppressed, and the worktree does not shield the primary
// from it. Concealing that would make a completed task look like the scheduler
// had gone rogue in someone's repo, so the Projects tab states it up front.
// No backticks: this string is rendered as plain text, and markdown that never
// gets parsed just makes the one note nobody should skim look like debug output.
const AUDIT_NOTE = 'Expect .beads/interactions.jsonl to show up as modified. bd records status changes in '
  + 'that file and keeps it under git on purpose: closing a finished bead appends one line, and handing an '
  + 'unfinished one back appends two. Claiming a bead and reading the backlog append nothing. It cannot be '
  + 'turned off (there is no bd setting for it), and it lands in the repo\'s primary checkout even when the '
  + 'work itself ran in a separate worktree. The scheduler leaves those lines uncommitted and never commits '
  + 'on your behalf. If you would rather not version the audit trail at all, that is your repo\'s call: '
  + 'git rm --cached .beads/interactions.jsonl, then ignore it.';

// A human may activate or pause. `pending` belongs to discovery and `error` to the
// poller, so neither is settable here — accepting them would let a client
// hand-wave a project into a state the daemon uses to mean something specific.
const PROJECT_SETTABLE_STATES = ['active', 'paused'];

// How long a *failed* `bd --version` is remembered. Success is cached inside the
// adapter for the daemon's life; this exists so a missing binary doesn't mean a
// spawn attempt on every render of the Projects tab.
const BD_INFO_TTL_MS = 30_000;

export function createApp({
  db, runner, scheduler, extensions, awake, usage = null, budget = null, pause = null,
  projects = null, beads = null, burst = null,
  execFileFn = execFile, uninstallFn = startUninstall,
  usageRefreshFloorMs = POLL_FLOOR_SEC * 1000,
}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(join(ROOT, 'public')));

  // main() passes the same policy the runner admits against; a standalone app
  // (tests, embedding) gets an equivalent one so the settings routes still read
  // and write the same keys.
  const policy = budget ?? createBudgetPolicy({ db, usage });

  // The live window list constrains which window an afterReset entry may anchor
  // to; null (no monitor, or nothing probed yet) means validate falls back to the
  // known windows rather than rejecting the job.
  const windows = () => usage?.snapshot()?.windows ?? null;

  const decorate = (job) => ({
    ...job,
    nextFire: scheduler.nextFire(job.id),
    // skipReason rides along so the jobs list can say *why* the last fire didn't
    // run without fetching the run's meta separately.
    lastRun: (({ id, status, finishedAt, startedAt, meta } = {}) => (id
      ? { id, status, finishedAt, startedAt, skipReason: meta?.skipReason ?? null }
      : null))(lastRun(db, job.id) ?? {}),
  });

  app.get('/api/extensions', (req, res) => {
    res.json({ extensions: manifest(extensions) });
  });

  app.get('/api/jobs', (req, res) => {
    res.json({
      jobs: listJobs(db).map(decorate),
      running: runner.runningCount(),
      awake: awake?.status() ?? null,
      // Rides this tick so the pause banner (and its winding-down count) stays
      // live without a second poller.
      pause: pause?.status() ?? null,
    });
  });

  app.post('/api/jobs', (req, res) => {
    const v = validateJob(req.body, extensions, { windows: windows() });
    if (!v.ok) return res.status(400).json({ errors: v.errors });
    const job = createJob(db, v.job);
    scheduler.reload(job.id);
    awake?.refresh();
    res.status(201).json(decorate(job));
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = getJob(db, req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    res.json(decorate(job));
  });

  app.put('/api/jobs/:id', (req, res) => {
    const existing = getJob(db, req.params.id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    const merged = { ...existing, ...req.body, params: { ...existing.params, ...(req.body?.params ?? {}) } };
    // Toggling enabled on an existing once-job whose time passed: allow disable, block enable.
    const v = validateJob(merged, extensions, { windows: windows() });
    if (!v.ok && !(req.body.enabled === false)) return res.status(400).json({ errors: v.errors });
    const job = updateJob(db, req.params.id, v.ok ? v.job : { enabled: false });
    scheduler.reload(job.id);
    awake?.refresh();
    res.json(decorate(job));
  });

  app.delete('/api/jobs/:id', (req, res) => {
    if (!getJob(db, req.params.id)) return res.status(404).json({ error: 'not found' });
    for (const p of deleteJob(db, req.params.id)) {
      try { unlinkSync(p); } catch {}
    }
    scheduler.reload(req.params.id);
    awake?.refresh();
    res.json({ ok: true });
  });

  // `force` is the confirmed override of a soft pause — the UI asks first.
  app.post('/api/jobs/:id/run', (req, res) => {
    const job = getJob(db, req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    res.status(202).json(runner.start(job, 'manual', 0, { force: !!req.body?.force }));
  });

  app.post('/api/runs/:id/kill', (req, res) => {
    const run = getRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    if (!['running', 'queued'].includes(run.status)) return res.status(409).json({ error: 'run is not active' });
    const killed = runner.kill(run.id);
    if (!killed) return res.status(409).json({ error: 'run is not active' });
    res.status(202).json(killed);
  });

  // The soft counterpart to /kill: ask this run to wind down at its next safe
  // point. 202 because it is a request — the run keeps going until it reaches one.
  app.post('/api/runs/:id/stop', (req, res) => {
    const run = getRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    if (!['running', 'queued'].includes(run.status)) return res.status(409).json({ error: 'run is not active' });
    const stopped = runner.requestStop(run.id, { reason: 'stop requested' });
    if (!stopped) return res.status(409).json({ error: 'run is not active' });
    res.status(202).json(stopped);
  });

  // Extension-defined per-run actions (e.g. claude's "Resume in Terminal").
  app.post('/api/runs/:id/actions/:actionId', async (req, res) => {
    const run = getRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    const job = getJob(db, run.jobId);
    if (!job) return res.status(404).json({ error: 'job gone' });
    const action = extensions.get(job.type)?.runActions?.find((a) => a.id === req.params.actionId);
    if (!action) return res.status(404).json({ error: 'unknown action' });
    if (action.requiresRunMeta && !run.meta?.[action.requiresRunMeta]) {
      return res.status(400).json({ error: `run has no ${action.requiresRunMeta}` });
    }
    try {
      const result = await action.exec({ run, job, db, setting: (k, d) => getSetting(db, k, d), execFileFn });
      res.json(result ?? { ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.get('/api/runs', (req, res) => {
    res.json({ runs: listRuns(db, { jobId: req.query.job, status: req.query.status, limit: Number(req.query.limit) || 100 }) });
  });

  app.get('/api/runs/:id/log', (req, res) => {
    const run = getRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    res.type('text/plain').send(run.logPath && existsSync(run.logPath) ? readFileSync(run.logPath, 'utf8') : '');
  });

  app.get('/api/runs/:id/tail', (req, res) => {
    const run = getRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (event, data) => res.write((event ? `event: ${event}\n` : '') + `data: ${data}\n\n`);

    if (run.logPath && existsSync(run.logPath)) {
      for (const l of readFileSync(run.logPath, 'utf8').split('\n')) if (l) send(null, l);
    }
    if (!['running', 'queued'].includes(run.status)) {
      send('done', run.status);
      return res.end();
    }
    const onLine = (l) => send(null, l);
    const onProgress = (p) => send('progress', JSON.stringify(p));
    const onDone = (status) => { send('done', status); cleanup(); res.end(); };
    const cleanup = () => {
      runner.events.off(`line:${run.id}`, onLine);
      runner.events.off(`progress:${run.id}`, onProgress);
      runner.events.off(`done:${run.id}`, onDone);
    };
    runner.events.on(`line:${run.id}`, onLine);
    runner.events.on(`progress:${run.id}`, onProgress);
    runner.events.on(`done:${run.id}`, onDone);
    req.on('close', cleanup);
  });

  // `{next, unknown}` — `unknown` means an afterReset entry whose reset time
  // isn't known yet, which is a state to report, not an error.
  app.post('/api/schedule/preview', (req, res) => {
    try {
      res.json(previewSchedule(req.body?.schedules ?? req.body?.schedule, 3, {
        windows: windows(),
        jobId: req.body?.jobId ?? '',
      }));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Pause modes. `blocking` says what the mode is actually stopping and
  // `stopping` lists runs mid-wind-down, so the UI never has to infer either from
  // the mode name.
  app.get('/api/pause', (req, res) => {
    if (!pause) return res.status(501).json({ error: 'pause controller not available' });
    res.json(pause.status());
  });

  app.put('/api/pause', (req, res) => {
    if (!pause) return res.status(501).json({ error: 'pause controller not available' });
    try {
      const out = pause.set({
        mode: req.body?.mode,
        minutes: req.body?.minutes != null ? Number(req.body.minutes) : undefined,
      });
      awake?.refresh();
      res.json(out);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/awake', (req, res) => {
    if (!awake) return res.status(501).json({ error: 'awake not available' });
    res.json(awake.status());
  });

  app.put('/api/awake', (req, res) => {
    if (!awake) return res.status(501).json({ error: 'awake not available' });
    try {
      res.json(awake.set({ mode: req.body?.mode, minutes: req.body?.minutes != null ? Number(req.body.minutes) : undefined }));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Usage: read-only in M1 — nothing here influences whether a job fires.
  const usageShow = () => {
    const v = getSetting(db, 'usageShow', 'banner');
    return USAGE_SHOW_MODES.includes(v) ? v : 'banner';
  };
  const usageWarnPct = () => Number(getSetting(db, 'usageWarnPct', 80)) || 80;

  // A snapshot of "nothing known yet" rather than null: the client renders the
  // same shape whether or not the first probe has landed.
  const pendingSnapshot = () => ({
    capturedAt: null, checkedAt: null, ok: null, error: null, stale: null,
    available: null, subscriptionType: null, windows: {}, buckets: [],
    ...(usage ? { pollSec: usage.status().pollSec, nextPollAt: usage.status().nextPollAt } : {}),
  });

  const usageBody = () => ({
    ...(usage?.snapshot() ?? pendingSnapshot()),
    display: usageShow(),
    warnPct: usageWarnPct(),
  });

  app.get('/api/usage', (req, res) => {
    if (!usage) return res.status(501).json({ error: 'usage monitor not available' });
    res.json(usageBody());
  });

  // Throttled to the poll floor: a UI with a refresh button must not become a
  // way to hammer the endpoint the floor exists to protect.
  let lastForcedAt = 0;
  app.post('/api/usage/refresh', async (req, res) => {
    if (!usage) return res.status(501).json({ error: 'usage monitor not available' });
    const since = Date.now() - lastForcedAt;
    if (since < usageRefreshFloorMs) {
      return res.status(429).json({
        error: 'refreshed too recently',
        retryAfterSec: Math.ceil((usageRefreshFloorMs - since) / 1000),
        ...usageBody(),
      });
    }
    lastForcedAt = Date.now();
    await usage.refresh();
    res.status(202).json(usageBody());
  });

  app.get('/api/usage/history', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 2000);
    res.json({ snapshots: listUsageSnapshots(db, { limit, okOnly: req.query.okOnly === '1' }) });
  });

  // Budget guard: what it would do to a scheduled fire right now, and whether
  // it's enforcing at all. `enforcing: false` is a normal state (guard off, or
  // usage unreadable and therefore failing open) that the UI must surface.
  app.get('/api/budget', (req, res) => {
    const job = req.query.job ? getJob(db, req.query.job) : null;
    if (req.query.job && !job) return res.status(404).json({ error: 'not found' });
    res.json(policy.explain(job));
  });

  // A bead's job row is not plannable, and this is a safety rule rather than a
  // tidiness one. That row exists to carry per-bead cost history and ships
  // deliberately disabled with a spent `once` entry so the cron scheduler can
  // never arm it; `lib/projects.js` launches it directly, taking a lease,
  // re-reading the bead, claiming it, and closing it only on an asserted
  // completion. A planned `once` entry would fire it through the scheduler
  // instead — no lease, no claim, no marker check, no close — and could race the
  // poller for the same bead, which is the one thing the lease exists to prevent.
  // Checked here and not only in the dialog: the dialog is a convenience, this is
  // the rule.
  const beadJobIds = (ids) => ids.filter((id) => getJob(db, id)?.params?._beadId);
  const NOT_PLANNABLE = 'bead-backed jobs cannot be planned: the scheduler runs those from their project (lease, claim and close), and arming one here would bypass all three';

  // Burn-down preview. Never writes: the slots come back for the user to confirm.
  app.post('/api/budget/plan', (req, res) => {
    const b = req.body || {};
    const jobIds = Array.isArray(b.jobIds) ? b.jobIds : [b.jobIds].filter(Boolean);
    const beads = beadJobIds(jobIds);
    if (beads.length) return res.status(400).json({ ok: false, reason: NOT_PLANNABLE });
    const result = policy.plan({
      window: b.window,
      targetPct: Number(b.targetPct),
      deadline: b.deadline || null,
      jobIds,
      minGapMin: Number(b.minGapMin) || undefined,
      maxConcurrent: Number(b.maxConcurrent) || undefined,
    });
    res.status(result.ok ? 200 : 400).json(result);
  });

  // Confirmed plan → `once` entries on the named jobs. The slots are re-checked
  // here rather than trusted: a preview left open for an hour is stale, and
  // materialising fire times that have already passed would be silent no-ops.
  app.post('/api/budget/plan/apply', (req, res) => {
    const slots = Array.isArray(req.body?.slots) ? req.body.slots : [];
    if (!slots.length) return res.status(400).json({ errors: ['slots required'] });
    if (slots.length > PLAN_SLOT_MAX) return res.status(400).json({ errors: [`at most ${PLAN_SLOT_MAX} slots`] });

    const byJob = new Map();
    for (const s of slots) {
      const at = new Date(s?.at ?? '');
      if (Number.isNaN(at.getTime())) return res.status(400).json({ errors: [`invalid slot time: ${s?.at}`] });
      if (at <= new Date()) return res.status(400).json({ errors: ['this plan has expired — re-plan and confirm again'] });
      const job = getJob(db, s?.jobId);
      if (!job) return res.status(404).json({ errors: [`unknown job: ${s?.jobId}`] });
      // Rejected wholesale rather than dropped: apply() below force-enables every
      // job it touches, so silently skipping this slot would leave the user's
      // confirmed plan short by one with nothing said.
      //
      // Measured consequence of not having this check (reproduced live 2026-07-25,
      // then fixed): the row came back enabled with a real future fire AND
      // `_beadId`/`_projectId` stripped, because the round-trip through
      // `validateJob` runs `validateFields`, which drops keys the extension does
      // not declare. That detaches the row from its bead permanently —
      // `findJobByBead` stops matching, so the poller can neither heal the row nor
      // reuse it, mints a second row for the same bead, and throws away the cost
      // history §4a.7 depends on. Meanwhile the orphan keeps firing the bead's
      // prompt on a schedule with no lease, no claim and no close.
      if (job.params?._beadId) return res.status(400).json({ errors: [NOT_PLANNABLE] });
      if (!byJob.has(job.id)) byJob.set(job.id, { job, ats: [] });
      byJob.get(job.id).ats.push(at.toISOString());
    }

    const enabled = [];
    const jobs = [];
    for (const { job, ats } of byJob.values()) {
      const schedules = [...scheduleEntries(job.schedule), ...ats.map((at) => ({ type: 'once', at }))];
      const v = validateJob({ ...job, schedules }, extensions, { windows: windows() });
      if (!v.ok) return res.status(400).json({ errors: v.errors });
      // A confirmed plan is an instruction to run: a disabled job would swallow
      // every slot silently, so enable it — and say so in the response.
      if (!job.enabled) enabled.push(job.name);
      const saved = updateJob(db, job.id, { ...v.job, enabled: true });
      scheduler.reload(saved.id);
      jobs.push(decorate(saved));
    }
    awake?.refresh();
    res.json({ ok: true, added: slots.length, jobs, enabled });
  });

  // ---------------------------------------------------------------- projects
  // Registered repos whose tasks live in their own `.beads/` (M4a). Two safety
  // gates run through these routes and both are load-bearing:
  //   1. `autoLabel` in the repo's own `.scheduler.json` — opt-in, never opt-out.
  //   2. human activation — nothing here may activate a project as a side effect.
  // An agent may write `.scheduler.json` and file beads; only a human may click
  // Activate. If one actor could do both, an agent could arrange for arbitrary
  // unattended work to run on this machine.

  const projectRoots = () => String(getSetting(db, 'projectRoots', '') || '')
    .split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const bdPathSetting = () => getSetting(db, 'bdPath', 'bd') || 'bd';
  const worktreeRootSetting = () => getSetting(db, 'worktreeRoot', '') || null;
  const beadsPollSec = () => Number(getSetting(db, 'beadsPollSec', BEADS_DEFAULT_POLL_SEC)) || BEADS_DEFAULT_POLL_SEC;

  // `~` is what a human types; every path we store is absolute so that
  // `getProjectByPath` can't be fooled into registering one repo twice.
  const expandPath = (p) => {
    const s = String(p ?? '').trim();
    if (!s) return '';
    return resolvePath(s.startsWith('~') ? join(homedir(), s.slice(1)) : s);
  };

  let bdInfo = { at: 0, version: null, error: null };
  async function bdStatus() {
    if (!beads) return { version: null, error: 'beads adapter not available', path: bdPathSetting() };
    if (bdInfo.at && Date.now() - bdInfo.at < BD_INFO_TTL_MS) return { ...bdInfo, at: undefined, path: bdPathSetting() };
    try {
      bdInfo = { at: Date.now(), version: await beads.version(), error: null };
    } catch (err) {
      bdInfo = { at: Date.now(), version: null, error: err?.message ?? String(err) };
    }
    return { version: bdInfo.version, error: bdInfo.error, path: bdPathSetting() };
  }

  // Everything the Projects tab needs about one project WITHOUT touching the
  // beads database: a list render must not cost one blocking `bd` call per row.
  // `reasons` is the "contributing nothing must never be silent" contract — a
  // project that will never do anything says why, in plain language.
  const decorateProject = (p) => {
    const parsed = parseProjectConfig(p.config ?? {});
    return {
      ...p,
      configErrors: parsed.errors,
      reasons: projects ? projects.explain(p, { config: parsed.config }) : [],
      warnings: projects?.warningsFor(p.id) ?? [],
      busyStreak: projects?.busyStreakFor(p.id) ?? 0,
      ready: projects?.readyFor(p.id) ?? { count: null, at: null },
      leases: { held: listLeases(db, { projectId: p.id, state: 'held' }).length },
    };
  };

  // 501 rather than 404: the routes exist, the engine behind them wasn't wired
  // in — a distinction worth keeping for anything embedding createApp directly.
  const needProjects = (res) => {
    if (projects && beads) return true;
    res.status(501).json({ error: 'project task sources are not available in this instance' });
    return false;
  };

  app.get('/api/projects', async (req, res) => {
    res.json({
      projects: listProjects(db).map(decorateProject),
      bd: await bdStatus(),
      roots: projectRoots(),
      worktreeRoot: worktreeRootSetting(),
      pollSec: projects?.pollSec() ?? beadsPollSec(),
      auditNote: AUDIT_NOTE,
    });
  });

  // Register one path by hand. Creates `pending` and NOTHING else — `state` is
  // deliberately not read from the body, so no payload can register-and-activate
  // in one call.
  app.post('/api/projects', async (req, res) => {
    if (!needProjects(res)) return;
    const path = expandPath(req.body?.path);
    if (!path) return res.status(400).json({ error: 'path required' });
    try {
      if (!statSync(path).isDirectory()) return res.status(400).json({ error: `${path} is not a directory` });
    } catch {
      return res.status(400).json({ error: `${path} does not exist` });
    }
    if (getProjectByPath(db, path)) return res.status(409).json({ error: 'that path is already registered' });
    let raw;
    try {
      raw = readFileSync(join(path, CONFIG_FILE), 'utf8');
    } catch {
      return res.status(400).json({
        error: `no ${CONFIG_FILE} at ${path} — a project declares itself with a committed ${CONFIG_FILE} `
          + 'naming the label a bead must carry to be eligible ({"autoLabel": "unattended"})',
      });
    }
    const parsed = parseProjectConfig(raw);
    const project = createProject(db, {
      name: parsed.config?.name || path.split('/').filter(Boolean).pop() || path,
      path,
      state: 'pending',
      config: parsed.config ?? {},
    });
    // Learn where the database actually is now rather than at first poll, so the
    // tab can show the truth before anyone is asked to activate anything.
    let health = null;
    try { health = await projects.refreshHealth(project.id); } catch (err) { health = { ok: false, busy: false, reason: err?.message ?? String(err) }; }
    res.status(201).json({ project: decorateProject(getProject(db, project.id)), errors: parsed.errors, health });
  });

  // Scan `projectRoots` for `.scheduler.json`. Writes `pending` only; finding a
  // repo is not consent to run it.
  app.post('/api/projects/discover', async (req, res) => {
    if (!needProjects(res)) return;
    const roots = projectRoots();
    if (!roots.length) {
      return res.status(400).json({ error: 'no projectRoots configured — set them under Task sources in Settings' });
    }
    try {
      const found = await projects.discover();
      res.json({
        found: found.map((f) => ({ project: decorateProject(getProject(db, f.project.id)), created: f.created, errors: f.errors })),
        roots,
      });
    } catch (err) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // THE AIRLOCK. The only route that can make a project eligible to run work,
  // and it does exactly one thing so that it can never happen incidentally.
  app.put('/api/projects/:id', async (req, res) => {
    if (!needProjects(res)) return;
    const project = getProject(db, req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });
    const state = req.body?.state;
    if (!PROJECT_SETTABLE_STATES.includes(state)) {
      return res.status(400).json({
        error: `state must be one of ${PROJECT_SETTABLE_STATES.join('|')} — "pending" is written by discovery `
          + 'and "error" by the poller',
      });
    }
    // Probe before flipping the state so the response can say what activating
    // just signed up for, including a beads dir that doesn't resolve.
    let health = null;
    try { health = await projects.refreshHealth(project.id); } catch (err) { health = { ok: false, busy: false, reason: err?.message ?? String(err) }; }
    const updated = updateProject(db, project.id, { state });
    const parsed = parseProjectConfig(updated.config ?? {});
    res.json({
      project: decorateProject(updated),
      health,
      reasons: projects.explain(updated, { config: parsed.config, health }),
      warnings: projects.warningsFor(updated.id),
    });
  });

  // Un-register. A held lease means a bead of this project is running right now,
  // so the default is to refuse and name it rather than orphan a live run.
  app.delete('/api/projects/:id', (req, res) => {
    if (!needProjects(res)) return;
    const project = getProject(db, req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });
    const held = listLeases(db, { projectId: project.id, state: 'held' });
    if (held.length && !req.body?.force) {
      return res.status(409).json({
        error: `${held.length} bead${held.length === 1 ? '' : 's'} of this project ${held.length === 1 ? 'is' : 'are'} still leased to a run`,
        held: held.map((l) => l.beadId),
      });
    }
    // A bead's job row is kept across runs to preserve its learned cost (§4a.7),
    // which means un-registering has to clear them deliberately — otherwise the
    // Jobs list keeps rows pointing at a project id that no longer resolves.
    const beadJobs = listJobsByProject(db, project.id);
    for (const job of beadJobs) {
      for (const p of deleteJob(db, job.id)) {
        try { unlinkSync(p); } catch {}
      }
      scheduler.reload(job.id);
    }
    deleteProject(db, project.id);
    awake?.refresh();
    res.json({ ok: true, removedJobs: beadJobs.length });
  });

  // Live `bd ready` passthrough for one project — human-initiated, so it is
  // allowed to be slow. Works on a `pending` project too: seeing what *would*
  // run is exactly what you want before deciding whether to activate.
  app.get('/api/projects/:id/ready', async (req, res) => {
    if (!needProjects(res)) return;
    const project = getProject(db, req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });
    const parsed = parseProjectConfig(project.config ?? {});
    const autoLabel = parsed.config?.autoLabel || null;
    const health = await beads.healthy(project);
    // Busy is not broken — and it short-circuits, because `ready` would then
    // block on the same lock and double the wait the browser is sitting through.
    if (health.busy) {
      return res.json({ beads: [], busy: true, reasons: [health.reason], health, autoLabel });
    }
    if (!health.ok) return res.json({ beads: [], busy: false, reasons: [health.reason], health, autoLabel });
    if (!autoLabel) {
      return res.json({ beads: [], busy: false, reasons: parsed.errors, health, autoLabel: null });
    }
    try {
      const rows = await beads.ready(project, { label: autoLabel });
      res.json({ beads: rows, busy: false, reasons: [], health, autoLabel });
    } catch (err) {
      if (err?.busy) return res.json({ beads: [], busy: true, reasons: [err.message], health, autoLabel });
      res.status(502).json({ error: err?.message ?? String(err) });
    }
  });

  // Poll one project now. This can start runs — which is what an active project
  // means — but it changes no state, so it is not a back door around the airlock:
  // a `pending` project answers `skipped` with the reason.
  app.post('/api/projects/:id/poll', async (req, res) => {
    if (!needProjects(res)) return;
    if (!getProject(db, req.params.id)) return res.status(404).json({ error: 'not found' });
    try {
      const out = await projects.pollProject(req.params.id);
      res.json({ projectId: req.params.id, ...out, project: decorateProject(getProject(db, req.params.id)) });
    } catch (err) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // ------------------------------------------------------------------ bursts
  // "Spend ~15% of this window working through ready beads." The burst owns *when*
  // to attempt and *whether the budget still allows it*; the attempt itself goes
  // through projects.pollProject, which holds the lease, re-reads the bead, claims
  // it and owns the outcome. These routes must never launch anything themselves.
  const needBurst = (res) => {
    if (!burst) { res.status(503).json({ error: 'bursts are not available in this process' }); return false; }
    return true;
  };

  // Preview. Writes nothing — the slots come back for the user to confirm, and the
  // 400 carries `reason` so the existing client error handling renders it.
  app.post('/api/bursts/plan', (req, res) => {
    if (!needBurst(res)) return;
    const b = req.body || {};
    const result = burst.plan({
      window: b.window,
      budgetPct: Number(b.budgetPct),
      projectIds: Array.isArray(b.projectIds) ? b.projectIds : [b.projectIds].filter(Boolean),
      maxRuns: b.maxRuns == null || b.maxRuns === '' ? null : Number(b.maxRuns),
      minGapMin: b.minGapMin == null || b.minGapMin === '' ? null : Number(b.minGapMin),
      deadline: b.deadline || null,
    });
    res.status(result.ok ? 200 : 400).json(result);
  });

  // Confirm. Re-validated rather than trusted: a preview left open goes stale, and
  // an expired timetable is rejected WHOLESALE rather than part-applied, matching
  // /api/budget/plan/apply. Nothing here is claimed — the first bead is claimed at
  // the first attempt, not now.
  app.post('/api/bursts', (req, res) => {
    if (!needBurst(res)) return;
    const b = req.body || {};
    const slots = Array.isArray(b.slots) ? b.slots : [];
    if (!slots.length) return res.status(400).json({ errors: ['slots required'] });
    if (slots.length > PLAN_SLOT_MAX) return res.status(400).json({ errors: [`at most ${PLAN_SLOT_MAX} slots`] });
    const projectIds = Array.isArray(b.projectIds) ? b.projectIds.filter(Boolean) : [];
    if (!projectIds.length) return res.status(400).json({ errors: ['projectIds required'] });

    const ats = [];
    for (const s of slots) {
      const at = new Date(typeof s === 'string' ? s : s?.at ?? '');
      if (Number.isNaN(at.getTime())) return res.status(400).json({ errors: [`invalid slot time: ${JSON.stringify(s)}`] });
      ats.push(at.toISOString());
    }
    // The last slot may legitimately be far out; it is the FIRST one passing that
    // means the preview went stale on screen.
    if (new Date(ats[0]).getTime() <= Date.now()) {
      return res.status(400).json({ errors: ['this plan has expired — re-plan and confirm again'] });
    }
    // The airlock is re-checked here, not just at plan time: a project could have
    // been paused or de-activated between preview and confirm.
    for (const id of projectIds) {
      const p = getProject(db, id);
      if (!p) return res.status(404).json({ errors: [`unknown project: ${id}`] });
      if (p.state !== 'active') return res.status(400).json({ errors: [`${p.name} is ${p.state} — only an activated project can contribute to a burst`] });
    }

    const r = burst.start({
      window: b.window, budgetPct: Number(b.budgetPct), projectIds, slots: ats,
      maxRuns: b.maxRuns == null || b.maxRuns === '' ? null : Number(b.maxRuns),
      minGapMin: b.minGapMin == null || b.minGapMin === '' ? null : Number(b.minGapMin),
    });
    if (!r.ok) return res.status(409).json({ errors: [r.reason] });
    res.status(201).json({ ok: true, burst: r.burst });
  });

  app.get('/api/bursts', (req, res) => {
    if (!needBurst(res)) return;
    res.json({ active: burst.status(), bursts: burst.history({ limit: Number(req.query.limit) || 20 }) });
  });

  app.post('/api/bursts/:id/cancel', (req, res) => {
    if (!needBurst(res)) return;
    const active = burst.status();
    if (!active || active.id !== req.params.id) return res.status(404).json({ error: 'no such running burst' });
    const r = burst.cancel('cancelled from the UI');
    if (!r.ok) return res.status(409).json({ error: r.reason });
    res.json(r);
  });

  // Settings: core {paused, home} + per-extension blocks from each ext's
  // `settings` field specs (defaults applied on read, validated on write).
  const extSettingsOut = () => Object.fromEntries([...extensions.values()]
    .filter((e) => e.settings?.length)
    .map((e) => [e.id, Object.fromEntries(e.settings.map((s) => {
      const raw = getSetting(db, s.key, null);
      const v = raw == null ? s.default ?? null : s.type === 'number' ? Number(raw) : raw;
      return [s.key, v];
    }))]));

  app.get('/api/settings', (req, res) => {
    res.json({
      // `paused` is the v1 alias, true for any mode other than off.
      paused: pause ? pause.mode() !== 'off' : getSetting(db, 'paused', '0') === '1',
      pauseMode: pause?.mode() ?? (getSetting(db, 'paused', '0') === '1' ? 'hold' : 'off'),
      softGraceMs: Number(getSetting(db, 'softGraceMs', DEFAULT_SOFT_GRACE_MS)) || DEFAULT_SOFT_GRACE_MS,
      home: process.env.HOME || '',
      usagePollSec: Number(getSetting(db, 'usagePollSec', DEFAULT_POLL_SEC)) || DEFAULT_POLL_SEC,
      usageShow: usageShow(),
      usageWarnPct: usageWarnPct(),
      awakeResetLeadMin: Number(getSetting(db, 'awakeResetLeadMin', DEFAULT_RESET_LEAD_MIN)) || DEFAULT_RESET_LEAD_MIN,
      // Task sources (M4a). `bdPath` is pinned deliberately: bd shipped ~93
      // releases in 9 months with a breaking change, so which binary we talk to
      // is a setting, not a lookup.
      projectRoots: getSetting(db, 'projectRoots', ''),
      beadsPollSec: beadsPollSec(),
      bdPath: bdPathSetting(),
      worktreeRoot: getSetting(db, 'worktreeRoot', ''),
      // How far apart a burst spaces its attempts. It is a floor, not a target:
      // spacing is what stops a burst spending its whole slice in three minutes,
      // and it keeps attempts far enough apart that the usage reading driving the
      // ceiling has actually refreshed between them.
      burstMinGapMin: Number(getSetting(db, 'burstMinGapMin', BURST_DEFAULTS.burstMinGapMin)) || BURST_DEFAULTS.burstMinGapMin,
      ...policy.settings(),
      extensions: extSettingsOut(),
    });
  });

  app.put('/api/settings', (req, res) => {
    const b = req.body || {};
    // Usage keys are core, not per-extension: M2's guard and M4's planner read
    // the same numbers, so they can't belong to any one job type.
    if ('usagePollSec' in b) {
      const n = Number(b.usagePollSec);
      if (!Number.isFinite(n) || n < POLL_FLOOR_SEC || n > 3600) {
        return res.status(400).json({ errors: [`usagePollSec must be ${POLL_FLOOR_SEC}-3600`] });
      }
      setSetting(db, 'usagePollSec', Math.round(n));
    }
    if ('usageShow' in b) {
      if (!USAGE_SHOW_MODES.includes(b.usageShow)) {
        return res.status(400).json({ errors: [`usageShow must be one of ${USAGE_SHOW_MODES.join('|')}`] });
      }
      setSetting(db, 'usageShow', b.usageShow);
    }
    if ('usageWarnPct' in b) {
      const n = Number(b.usageWarnPct);
      if (!Number.isFinite(n) || n < 1 || n > 99) return res.status(400).json({ errors: ['usageWarnPct must be 1-99'] });
      setSetting(db, 'usageWarnPct', Math.round(n));
    }
    // Budget guard keys — core for the same reason the usage keys are: the guard,
    // the planner and (later) the backlog all read these same numbers.
    for (const [key, min, max] of [['reserveFiveHourPct', 1, 100], ['reserveWeeklyPct', 1, 100], ['awakeResetLeadMin', 0, 240], ['burstMinGapMin', 1, 240]]) {
      if (!(key in b)) continue;
      const n = Number(b[key]);
      if (!Number.isFinite(n) || n < min || n > max) return res.status(400).json({ errors: [`${key} must be ${min}-${max}`] });
      setSetting(db, key, Math.round(n));
    }
    for (const key of ['budgetGuard', 'pauseOnWarning']) {
      if (key in b) setSetting(db, key, b[key] ? 1 : 0);
    }
    // A new interval takes effect now rather than after the old one elapses —
    // otherwise lowering it from an hour means waiting an hour to find out.
    if ('usagePollSec' in b && usage?.status().running) {
      usage.stop();
      usage.start({ immediate: false });
    }
    if ('extensions' in b) {
      for (const [extId, values] of Object.entries(b.extensions || {})) {
        const ext = extensions.get(extId);
        if (!ext?.settings?.length) return res.status(400).json({ error: `unknown extension: ${extId}` });
        const specs = ext.settings.filter((s) => s.key in values);
        const { params, errors } = validateFields(specs, values);
        if (errors.length) return res.status(400).json({ errors });
        for (const s of specs) setSetting(db, s.key, params[s.key]);
      }
    }
    // Task sources (M4a).
    if ('beadsPollSec' in b) {
      const n = Number(b.beadsPollSec);
      if (!Number.isFinite(n) || n < BEADS_POLL_FLOOR_SEC || n > 3600) {
        return res.status(400).json({ errors: [`beadsPollSec must be ${BEADS_POLL_FLOOR_SEC}-3600`] });
      }
      setSetting(db, 'beadsPollSec', Math.round(n));
    }
    // worktreeRoot is VALIDATED BEFORE anything in this group is written. It used
    // to be checked last, which meant a rejected save had already persisted the new
    // poll interval and then returned before re-arming the poller. Worse: the form
    // submits all four fields every time and this check runs against currently
    // registered projects, so registering a repo that happens to contain the
    // existing worktreeRoot made *every* settings save fail — usage, pause, budget
    // and all — with an error message about worktrees.
    let worktreeRoot = null;
    if ('worktreeRoot' in b) {
      // Expanded for the same reason as projectRoots, and additionally because
      // `git worktree add` would happily create a directory called `~` in the cwd.
      worktreeRoot = expandPath(b.worktreeRoot);
      // The spike measured this: a worktree created inside the primary checkout
      // shows up as `?? .worktrees/` in the human's `git status` — littering the
      // very checkout the worktree exists to keep clean. Cheap to catch here for
      // any repo we already know about.
      const inside = worktreeRoot
        && listProjects(db).find((p) => worktreeRoot === p.path || worktreeRoot.startsWith(p.path + '/'));
      // Already-stored values are grandfathered: rejecting a value the user is not
      // changing would wedge every future save behind an error about a field they
      // did not touch.
      if (inside && worktreeRoot !== (getSetting(db, 'worktreeRoot', '') || null)) {
        return res.status(400).json({
          errors: [`worktreeRoot must live outside every registered repo — ${worktreeRoot} is inside ${inside.path}, `
            + 'so the worktree would show up as untracked noise in that repo\'s git status'],
        });
      }
    }
    // Stored expanded and absolute. `~/dev` is what a human types (and what the
    // field suggests), but discovery hands these straight to readdir, which would
    // look for a directory literally named `~` and find nothing — and discovery
    // treats an absent root as "not an error", so the failure would be silent.
    if ('projectRoots' in b) {
      setSetting(db, 'projectRoots', String(b.projectRoots ?? '')
        .split(/[\n,]/).map((s) => expandPath(s)).filter(Boolean).join('\n'));
    }
    if ('bdPath' in b) {
      const p = String(b.bdPath ?? '').trim() || 'bd';
      // A different binary may be a different version, and the adapter caches the
      // answer for the daemon's life — so forget it, or the mismatch banner would
      // keep reporting the binary we used to be pointed at.
      if (p !== bdPathSetting()) beads?.resetVersion();
      setSetting(db, 'bdPath', p);
    }
    if (worktreeRoot !== null) setSetting(db, 'worktreeRoot', worktreeRoot);
    if ('beadsPollSec' in b) projects?.restart();
    // How long a run gets to wind down before the ladder escalates to SIGTERM.
    if ('softGraceMs' in b) {
      const n = Number(b.softGraceMs);
      if (!Number.isFinite(n) || n < 1000 || n > 600_000) {
        return res.status(400).json({ errors: ['softGraceMs must be 1000-600000'] });
      }
      setSetting(db, 'softGraceMs', Math.round(n));
    }
    // The v1 alias, kept working: `paused: true` means what it always meant, which
    // is `hold`. Routed through the controller so both keys stay in step.
    if ('paused' in b) {
      const wanted = b.paused ? 'hold' : 'off';
      // Don't demote a stronger mode: PUT {paused:true} while soft/hard is active
      // would otherwise quietly weaken the pause.
      if (pause) {
        if (!(b.paused && pause.mode() !== 'off')) pause.set({ mode: wanted });
      } else {
        setSetting(db, 'paused', b.paused ? '1' : '0');
      }
    }
    awake?.refresh();
    res.json({ ok: true });
  });

  app.post('/api/cleanup', (req, res) => {
    runner.killAll();
    scheduler.stop();
    pause?.stop();
    for (const p of cleanupAll(db)) {
      try { unlinkSync(p); } catch {}
    }
    scheduler.start(); // no jobs left, but keeps instance consistent
    awake?.refresh();
    res.json({ ok: true });
  });

  app.post('/api/uninstall', (req, res) => {
    res.status(202).json({ ok: true, message: 'uninstalling — daemon will exit' });
    awake?.stop();
    pause?.stop();
    uninstallFn({ runner, server: app.locals.server });
  });

  return app;
}

export async function main() {
  ensureDirs();
  const db = openDb(dbPath());
  failOrphanRuns(db);
  const extensions = await loadExtensions();
  for (const ext of extensions.values()) {
    try {
      ext.init?.({ getSetting: (k, d) => getSetting(db, k, d), setSetting: (k, v) => setSetting(db, k, v) });
    } catch (err) {
      console.error(`extension ${ext.id} init failed:`, err.message);
    }
  }
  // Created before the runner so runs can be sampled either side; started after
  // the scheduler because the first probe must never delay a fire.
  const usage = createUsageMonitor({ db });
  const budget = createBudgetPolicy({ db, usage });
  // The pause controller needs the runner (to drain it) and the runner needs the
  // controller (to refuse work) — so admit reads `pause` late, through the
  // closure, rather than the two being built in an impossible order.
  let pause = null;
  const runner = createRunner({
    db,
    extensions,
    usage,
    // Being paused outranks any budget reason, and is the more useful thing to
    // tell the user.
    admit: (job, trigger, opts) => pause?.gate(job, trigger, opts) ?? budget.admit(job, trigger, opts),
  });
  pause = createPauseController({ db, runner });
  pause.refresh(); // a timed pause that lapsed while the daemon was down ends now
  const scheduler = createScheduler({ db, runner, usage, pause });
  scheduler.start();
  usage.start();
  const awake = createAwake({ db, runner, scheduler, usage, pause });
  awake.refresh();

  // Task sources (M4a). `bdPath` is read through a closure on every call so a
  // settings change takes effect without a restart.
  const beads = createBeads({ db, bdPath: () => getSetting(db, 'bdPath', 'bd') || 'bd' });
  const worktrees = createWorktrees();
  const projects = createProjects({ db, beads, runner, worktrees, pause });
  // A daemon that swallows these is a daemon that polls silently and tells nobody
  // why nothing ran. Busy is logged as the routine event it is, not as a fault.
  projects.events.on('busy', ({ projectId, consecutive }) =>
    console.log(`beads: ${projectId} database busy (${consecutive} in a row) — retrying next poll`));
  projects.events.on('warning', ({ projectId, message }) => console.warn(`beads: ${projectId} — ${message}`));
  projects.events.on('error', ({ projectId, message }) => console.error(`beads: ${projectId} — ${message}`));
  projects.events.on('started', ({ beadId, runId }) => console.log(`beads: started ${beadId} as run ${runId}`));
  projects.events.on('abandoned', ({ beadId, reason }) => console.log(`beads: skipped ${beadId} — ${reason}`));
  projects.events.on('claim-failed', ({ beadId, reason }) => console.warn(`beads: claim of ${beadId} failed — ${reason} (running anyway: our lease is the lock)`));
  projects.events.on('held', ({ mode, ready }) => console.log(`beads: schedule paused (${mode}) — ${ready} ready bead(s) left untouched`));
  projects.events.on('handed-back', ({ beadId, reason }) => console.log(`beads: handed ${beadId} back to the backlog — ${reason}`));
  // The loud one. A bead left in_progress is excluded from `bd ready` forever, so
  // this is the difference between "will retry" and "silently gone".
  projects.events.on('unclaim-failed', ({ beadId, reason, busy }) => console.error(
    `beads: COULD NOT hand ${beadId} back (${reason}) — it stays in_progress, which means bd ready will not `
    + `offer it again until someone runs: bd update ${beadId} --status open --assignee ""`
    + `${busy ? ' (the database was busy — worth retrying)' : ''}`));
  // Loud, like unclaim-failed, and for the same reason: the work is done but the
  // bead still reads `in_progress`, which `bd ready` excludes — so the scheduler
  // cannot see it again and only a human can finish the bookkeeping. Deliberately
  // NOT handed back, because a retry would redo completed work.
  projects.events.on('close-failed', ({ beadId, reason, busy, stranded }) => console.error(
    `beads: the work for ${beadId} finished but the bead could NOT be closed (${reason})`
    + `${stranded ? ` — it stays in_progress and hidden from bd ready. Close it yourself with: bd close ${beadId}` : ''}`
    + `${busy ? ' (the database was busy — worth retrying)' : ''}`));
  projects.events.on('finished', ({ beadId, status, closed }) =>
    console.log(`beads: ${beadId} finished ${status}${closed ? ' — closed' : ' — left open for retry'}`));
  projects.events.on('unfinished', ({ beadId, runId }) => console.log(
    `beads: ${beadId} — run ${runId} exited ok but never signalled completion, so the bead was returned to the backlog with a note`));
  projects.events.on('orphan-unresolved', ({ beadId, reason }) => console.warn(
    `beads: could not check orphaned bead ${beadId} after the restart (${reason}) — it may still be in_progress and hidden from bd ready`));

  // Same role as failOrphanRuns: a daemon that died mid-run left leases with no
  // live run behind them, and beads still `in_progress` from our claim — which
  // `bd ready` excludes, so the work in flight would be hidden forever.
  //
  // Called BEFORE `start()` and deliberately NOT awaited. `recoverOrphans`
  // synchronously captures the orphan list and releases exactly those leases, then
  // does the slow `bd` un-claiming in the background. Both halves matter: releasing
  // by key rather than by `WHERE state = 'held'` is what stops a live lease being
  // freed under a running poll, and getting the synchronous half in before the
  // interval is armed is what stops the poll seeing stale `held` rows.
  projects.recoverOrphans()
    .then((out) => {
      for (const r of out.filter((x) => x.handedBack)) console.log(`beads: returned ${r.beadId} to the backlog after a restart`);
    })
    .catch((err) => console.error(`beads: orphan recovery failed (${err?.message ?? err})`));
  projects.start();

  // Bursts (M4). Started after the poller, and `resume()` rather than a fresh
  // start: a burst that was active when the daemon stopped keeps its timetable, so
  // a restart continues it instead of abandoning work the user confirmed. Slots
  // that passed while the process was down come due at once, and the ceiling is
  // re-measured on the first tick — so it cannot resume into a budget it has
  // already spent.
  const burst = createBurst({ db, usage, budget, projects, pause });
  burst.events.on('started', (b) => console.log(`burst: started — ${b.budgetPct}% of ${b.window} across ${b.slots.length} attempt(s) from ${b.startPct}%`));
  burst.events.on('finished', (b) => console.log(`burst: ${b.state} — ${b.reason} (${b.runs} run(s))`));
  burst.events.on('error', (err) => console.error(`burst: tick failed — ${err?.message ?? err}`));
  const resumed = burst.resume();
  if (resumed) console.log(`burst: resuming — ${resumed.slots.length} attempt(s) left of ${resumed.budgetPct}% of ${resumed.window}`);

  const app = createApp({ db, runner, scheduler, extensions, awake, usage, budget, pause, projects, beads, burst });
  const port = Number(process.env.CS_PORT) || 9099;
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`claude-scheduler on http://127.0.0.1:${port} · extensions: ${[...extensions.keys()].join(', ')}`);
  });
  app.locals.server = server;
  return server;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
