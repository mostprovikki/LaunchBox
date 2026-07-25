import { readdir, readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { join, basename } from 'node:path';
import { BD_ACTOR } from './beads.js';
import { budgetParams } from './validate.js';
import {
  listProjects, getProject, createProject, updateProject, getProjectByPath,
  acquireLease, releaseLease, completeLease, attachLeaseRun, listLeases,
  createJob, updateJob, findJobByBead, getSetting, getRun,
} from './db.js';

// The beads poller (M4a §4a.4/§4a.5): for each *activated* project, ask
// `bd ready` what is actionable, take our own lease, and materialise the bead as
// an ordinary job row so it inherits logs, history, SSE tailing and the M2 budget
// guard — and so `run_usage` accumulates that bead's real cost across runs.
//
// ⚠️ The row is NOT armed: it ships disabled with a spent `once` entry and is
// launched from here, directly. The original design said this bought the guard
// *and the pause* "for free"; the pause half was false — `hold` deliberately
// admits everything that reaches the runner, so this file checks
// `pause.blocksSchedule()` itself, between beads. Anything else that learns to
// launch a bead (a burst, M4) must come through here for the same reason: the
// lease, the pre-launch re-read, the claim and the close all live on this path.
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

// What a run has to say for the scheduler to close its bead.
//
// This exists because exit status is not a completion signal. Measured live: a
// run that could not do the work at all — the write was denied, and it said so
// in plain English — still ended `subtype: success`, exit 0, and the bead was
// closed. "Only ok closes the bead" is worthless if `ok` means "the model
// stopped talking without crashing". So closing now requires the agent to
// *assert* completion, and the bead id is part of the marker so a marker echoed
// from some other context cannot close the wrong task.
export const completionMarker = (beadId) => `TASK-COMPLETE: ${beadId}`;

// Anchored, NOT a substring test. bd ids are short suffixes, so prefix pairs are
// routine: a plain `includes` meant a marker naming `sp-12` — the wrong id, copied
// from a sibling task, which is the exact mistake putting the id in the marker is
// meant to catch — closed `sp-1` unworked.
export function signalledComplete(text, beadId) {
  if (typeof text !== 'string' || !beadId) return false;
  const id = String(beadId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`TASK-COMPLETE:\\s*${id}(?![\\w-])`).test(text);
}

// Keep the end of a long message, not the beginning.
const tailOf = (s, n) => (s.length > n ? `…${s.slice(-n)}` : s);

// A repo may declare how much the scheduler is allowed to do unattended in it.
// Absent means `default`, which prompts for permission — and with no terminal to
// answer, the tool call is denied. That is the right default (it fails closed and
// can change nothing), but it also means a repo has to opt in explicitly before
// scheduled work can edit a single file.
export const PERM_MODES = ['default', 'acceptEdits', 'auto'];

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
  // An unrecognised permMode is an error rather than a silent fall back to the
  // safe value: this is the key that decides what unattended work may do to the
  // repo, and a typo that quietly means something else is exactly the kind of
  // mistake a security-relevant setting must not absorb.
  const permMode = obj.defaults?.permMode;
  if (permMode != null && !PERM_MODES.includes(permMode)) {
    errors.push(`${CONFIG_FILE}: defaults.permMode must be one of ${PERM_MODES.join('|')} (got ${JSON.stringify(permMode)})`);
  }
  const config = {
    enabled: obj.enabled !== false,
    autoLabel,
    cwd: typeof obj.cwd === 'string' && obj.cwd ? obj.cwd : '.',
    maxConcurrent: num(obj.maxConcurrent, 1),
    defaults: {
      timeoutMin: num(obj.defaults?.timeoutMin, 30),
      model: typeof obj.defaults?.model === 'string' ? obj.defaults.model : 'default',
      notify: typeof obj.defaults?.notify === 'string' ? obj.defaults.notify : 'failure',
      // Declared by the repo, in the repo, under git review — not by the
      // scheduler on the repo's behalf.
      permMode: PERM_MODES.includes(permMode) ? permMode : 'default',
    },
    // Validated, not merely shape-checked. `materialise` copies this straight onto
    // `params.budget`, and it builds its row with `createJob` rather than
    // `validateJob` — so until this went through `budgetParams` a repo could
    // declare anything here and have the guard read it unchecked, including
    // `{"ignoreGuard": true}`, which `allowIgnoreGuard: false` now refuses.
    budget: budgetParams(obj, errors, { label: `${CONFIG_FILE}: budget`, allowIgnoreGuard: false }) ?? null,
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
    // `-C` rather than a bare `bd show`: the work runs in a git worktree, whose
    // `.beads/` is present but HOLLOW (committed config, gitignored database). The
    // scheduler's own calls pass BEADS_DIR, but this child process does not inherit
    // it, so the very first instruction in the prompt could fail. `-C` is a
    // first-class global flag with git -C semantics.
    `Read the full task first: bd -C ${project.path} show ${bead.id}`,
    `It is already claimed for you (status: in_progress).`,
    '',
    `Do the work. Do NOT close the bead yourself — the scheduler closes it.`,
    '',
    // The scheduler cannot tell "done" from "gave up" by looking at an exit code,
    // so it asks for the difference in words. Stated as a contract with its
    // consequence spelled out, because an agent that knows a missing marker means
    // a retry has a reason to be honest rather than optimistic.
    `When — and only when — the task is genuinely finished, end your final message`,
    `with this exact line:`,
    '',
    `    ${completionMarker(bead.id)}`,
    '',
    `Without that line the scheduler assumes the work did not get done: the bead is`,
    `returned to the backlog for a retry and your closing message is attached to it`,
    `as a note. So if you could not finish — blocked, missing permission, unclear`,
    `requirements — do NOT write the line. Say what stopped you instead; that`,
    `explanation is what the next attempt (or a human) will read.`,
  ].filter((l) => l !== null).join('\n');
}

export function createProjects({
  db,
  beads,
  runner,
  worktrees = null,
  // M3's pause controller. The poller launches runs *directly* rather than
  // through the scheduler, so without this a `hold` — the button whose whole
  // promise is "nothing fires automatically" — would leave bead pickup running,
  // which is the most unattended work in the system. `gate()` cannot cover it:
  // `hold` deliberately admits everything that reaches the runner, because in v1
  // that could only be a manual click or an armed retry. A bead run is neither.
  pause = null,
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
  // What the last successful poll saw. The Projects tab wants a ready count per
  // project on every refresh, and asking `bd` for it would mean one DB-touching
  // call per project per render — each able to block for as long as a human holds
  // the lock. The poller already has the answer, so it remembers it instead. The
  // timestamp rides along so the UI can say how old the number is rather than
  // presenting a stale count as current.
  const readyCache = new Map(); // projectId -> { count, at }

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
    const patch = { lastPollAt: new Date(now()).toISOString(), lastPollOk: health.ok };
    if (health.beadsDir) patch.beadsDir = health.beadsDir;
    if (health.ok) {
      patch.lastError = null;
      try { patch.bdVersion = await beads.version(); } catch { /* version is a nicety here */ }
    } else if (!health.busy) {
      // Recorded now, not at the next poll. Otherwise activating a repo bd cannot
      // read leaves a project sitting there looking `active` and healthy for up to
      // a poll interval, with nothing on the row to say it can do nothing — the
      // silent-nothing failure this whole surface exists to prevent.
      patch.lastError = health.reason;
    }
    // `state` is deliberately NOT touched: it belongs to the human (pending →
    // active) and to the poll loop (→ error). A probe is not a verdict.
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
    // Said out loud rather than left as a mystery: with the schedule held, a
    // project can be active, healthy and full of ready work and still run none
    // of it. That is correct, but it must not look like a fault.
    if (pause?.blocksSchedule()) {
      reasons.push(`the schedule is paused (${pause.mode()}), so no bead is picked up until you resume`);
    }
    if (health && !health.ok) reasons.push(health.reason);
    return reasons;
  }

  // Record the outcome of a poll WITHOUT clobbering a human's decision.
  //
  // A poll holds `bd` calls that each block for up to BD_TIMEOUT_MS, so tens of
  // seconds can pass between reading the project row and writing the result. In
  // that window a human can click Pause. Writing back a `state` captured before
  // the awaits is a lost update that silently re-activates the project — and then
  // launches every ready bead — which defeats both the activation airlock and the
  // pause. So `state` is re-read at write time and only ever *transitioned*,
  // never echoed back.
  function recordPoll(projectId, patch, { wantState = null } = {}) {
    const fresh = getProject(db, projectId);
    if (!fresh) return null;
    const out = { ...patch };
    // Only a project the poll loop still owns may be moved. If the human paused it
    // (or un-registered and re-registered it) while we were waiting on bd, their
    // decision wins and we record the poll result without touching state.
    if (wantState && wantState !== fresh.state && POLLED_STATES.has(fresh.state)) {
      out.state = wantState;
    }
    return updateProject(db, projectId, out);
  }

  // `max` caps how many beads this call may start, and `trigger` names what asked.
  // Both exist for M4's bursts: a burst attempt is a poll of one project for one
  // bead, deliberately routed through here rather than launching anything itself,
  // because the lease, the pre-launch re-read, the claim, the hand-back and the
  // close all live on this path. Anything that launches a bead some other way
  // bypasses all five.
  async function pollProject(projectId, { max = null, trigger = 'beads' } = {}) {
    const project = getProject(db, projectId);
    if (!project) return { ok: false, reasons: ['project no longer exists'], started: [] };
    if (!POLLED_STATES.has(project.state)) {
      return { ok: true, skipped: true, reasons: explain(project), started: [], ready: [] };
    }

    // Re-read the declaration from disk every poll. The repo owns it (§4a.4), so
    // the file — not our snapshot of it — is the source of truth, and an edit
    // should take effect on the next poll.
    //
    // Without this, only `discover()` ever re-read the file, and discovery only
    // walks `projectRoots`: a repo registered by hand with a typo'd `autoLabel` was
    // stuck in `error` with a stale reason forever, because fixing the file changed
    // nothing, PUT only sets state, and re-registering 409s on the duplicate path.
    // A file that has gone missing or unreadable keeps the stored config rather than
    // knocking out a working project.
    let stored = project.config ?? {};
    try {
      const raw = await fsx.readFile(join(project.path, CONFIG_FILE), 'utf8');
      const fresh = parseProjectConfig(raw);
      if (fresh.config) {
        stored = fresh.config;
        updateProject(db, project.id, { config: fresh.config });
      }
    } catch { /* unreadable: carry on with what we already had */ }

    const parsed = parseProjectConfig(stored);
    const at = new Date(now()).toISOString();
    warnings.delete(project.id);

    // An unusable declaration is an error state, not a silent no-op — and
    // explicitly not "run everything".
    if (!parsed.ok || parsed.config.enabled === false) {
      const reasons = parsed.ok ? [`disabled in its own ${CONFIG_FILE}`] : parsed.errors;
      recordPoll(project.id, { lastPollAt: at, lastPollOk: false, lastError: reasons.join('; ') },
        { wantState: parsed.ok ? null : 'error' });
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
      // A timeout is the database being busy, which every other call below treats
      // as "retry later" — latching `error` here would cry wolf on the common case
      // just because the version probe happened to be the call that hit it.
      if (err?.busy) {
        const n = (busyStreak.get(project.id) ?? 0) + 1;
        busyStreak.set(project.id, n);
        recordPoll(project.id, { lastPollAt: at, lastPollOk: false, lastError: null });
        events.emit('busy', { projectId: project.id, consecutive: n });
        return { ok: true, busy: true, consecutive: n, reasons: [err.message], started: [], ready: [] };
      }
      recordPoll(project.id, { lastPollAt: at, lastPollOk: false, lastError: err.message }, { wantState: 'error' });
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
        recordPoll(project.id, { lastPollAt: at, lastPollOk: false, lastError: null });
        events.emit('busy', { projectId: project.id, consecutive: n });
        return { ok: true, busy: true, consecutive: n, reasons: [health.reason], started: [], ready: [] };
      }
      recordPoll(project.id, { lastPollAt: at, lastPollOk: false, lastError: health.reason }, { wantState: 'error' });
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
        recordPoll(project.id, { lastPollAt: at, lastPollOk: false, lastError: null });
        events.emit('busy', { projectId: project.id, consecutive: n });
        return { ok: true, busy: true, consecutive: n, reasons: [err.message], started: [], ready: [] };
      }
      // A bd failure marks the project and is reported — but it must never take
      // the poll loop down with it.
      recordPoll(project.id, { lastPollAt: at, lastPollOk: false, lastError: err.message }, { wantState: 'error' });
      changed();
      return { ok: false, reasons: [err.message], started: [], ready: [] };
    }

    // A recovered project comes back out of `error` on its own — but only if it is
    // still `error` now, not because it was when this poll started.
    const before = getProject(db, project.id);
    recordPoll(project.id, {
      lastPollAt: at, lastPollOk: true, lastError: null, readyCount: ready.length,
      beadsDir: health.beadsDir ?? project.beadsDir,
    }, { wantState: before?.state === 'error' ? 'active' : null });

    readyCache.set(project.id, { count: ready.length, at });

    // Checked AFTER the read, deliberately: a paused project should still report
    // an honest ready count (that is what the tab is for) — what a pause stops is
    // launching, not looking. Nothing here marks the project as failing, because
    // being paused is not a fault of the project.
    if (pause?.blocksSchedule()) {
      const reason = `the schedule is paused (${pause.mode()}) — ${ready.length} ready bead${ready.length === 1 ? '' : 's'} left untouched`;
      events.emit('held', { projectId: project.id, mode: pause.mode(), ready: ready.length });
      changed();
      return { ok: true, held: true, reasons: [reason], ready, started: [], warnings: warnings.get(project.id) ?? [] };
    }

    const started = [];
    const reasons = [];
    // Why each ready bead did NOT start. Without this a poll reports "3 ready,
    // 0 started" and offers no way to find out why — which is the silent-nothing
    // failure the whole project is supposed to avoid, just one level down.
    const skipped = [];
    const held = listLeases(db, { projectId: project.id, state: 'held' }).length;
    // Worktrees are per bead (M4), so two of this project's beads no longer share a
    // checkout or a branch and `maxConcurrent` can finally mean what it says. It
    // still defaults to 1: lifting a data-loss clamp is not the same as deciding
    // parallelism is the right default, and each concurrent bead costs another
    // checkout on disk.
    const cap = config.maxConcurrent;
    // A caller-imposed cap composes with the project's own rather than replacing
    // it: a burst asking for one bead must still respect the worktree clamp and
    // the leases already held.
    let slots = Math.max(0, cap - held);
    if (Number.isFinite(max)) slots = Math.min(slots, Math.max(0, Math.floor(max)));
    const waiting = () => ready.length - started.length - skipped.length;
    for (const bead of ready) {
      if (slots <= 0) {
        reasons.push(`at this project's limit of ${config.maxConcurrent} run${config.maxConcurrent === 1 ? '' : 's'} at once`
          + ` — ${waiting()} ready bead(s) wait for the next poll`);
        break;
      }
      // Re-checked every iteration, not just once before the loop: each bead costs
      // a `bd show` plus a `bd update --claim`, seconds apiece, so with several
      // ready beads a human who hits Hold partway through would otherwise watch the
      // rest launch anyway. `soft`/`hard` get caught downstream by the runner's
      // gate, but `hold` deliberately admits everything there — so the one mode
      // that promises "nothing fires automatically" is the one needing this check.
      if (pause?.blocksSchedule()) {
        reasons.push(`stopped part-way: the schedule was paused (${pause.mode()}) with ${waiting()} ready bead(s) still to consider`);
        break;
      }
      const r = await tryRun(getProject(db, project.id), bead, config, trigger);
      // A skip does NOT consume a slot: it is usually specific to that bead (a
      // lease already held, a human who took it since the poll), and the next
      // bead deserves its turn.
      if (r.started) { started.push(r); slots -= 1; continue; }
      skipped.push({ beadId: r.beadId, reason: r.reason });
      // A guard refusal is the exception — it is a judgement about the machine,
      // not about the bead, so the next bead would be refused identically. Trying
      // them all would claim and hand back every ready bead on every poll, which
      // is real churn in the human's audit log for a guaranteed no.
      if (r.guardSkipped) {
        reasons.push(`stopped after the first refusal — ${r.reason}; the same guard would refuse the other ${waiting()} ready bead(s)`);
        break;
      }
    }
    changed();
    return { ok: true, reasons, ready, started, skipped, warnings: warnings.get(project.id) ?? [] };
  }

  // --- one bead ----------------------------------------------------------
  async function tryRun(project, bead, config, trigger = 'beads') {
    // The lease is the lock, and it is taken FIRST — before the re-read, before
    // the claim, before the launch. Everything after this point can fail safely
    // because this row is what prevents a second cycle touching the same bead.
    if (!acquireLease(db, { projectId: project.id, beadId: bead.id })) {
      return { started: false, beadId: bead.id, reason: 'already leased' };
    }

    // Set once a worktree exists for this bead, so every give-up path below reaps
    // it. Worktrees are now per bead, so a leaked one is not "the project's dir,
    // reused next time" — it is permanent litter, one directory per bead that ever
    // failed to launch.
    let prepared = false;

    const abandon = async (reason) => {
      if (prepared) await reap(project, bead.id);
      releaseLease(db, project.id, bead.id);
      events.emit('abandoned', { projectId: project.id, beadId: bead.id, reason });
      return { started: false, beadId: bead.id, reason };
    };

    // Same as abandon, but for the paths that run AFTER our claim landed — and
    // the difference is not cosmetic. `bd ready` excludes `in_progress`, so a
    // bead we claimed and then didn't run is invisible to every later poll:
    // releasing only our own lease would quietly retire it forever. Deliberately
    // a separate function from `abandon` so that the pre-claim paths — above all
    // "someone else claimed it" — cannot reach it and un-claim a human's bead.
    const handBack = async (reason) => {
      await unclaim(project, bead.id, reason);
      return abandon(reason);
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
    // human's session can see the bead is taken — and, because the adapter sets
    // BEADS_ACTOR, taken visibly by the scheduler rather than under their name.
    const claim = await beads.claim(project, bead.id);
    // Whether OUR claim is on the bead right now. Everything below has to know,
    // because handing back a bead we never took is wrong in the other direction.
    const claimed = claim.ok;
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
        // Per bead, not per project (M4): one worktree per project meant two of our
        // own runs shared a checkout and a branch, which is why concurrency was
        // clamped to 1.
        const wt = await worktrees.ensure(project, { root, beadId: bead.id });
        cwd = config.cwd && config.cwd !== '.' ? join(wt.path, config.cwd) : wt.path;
        prepared = true;
      } catch (err) {
        const why = `could not prepare a git worktree: ${err.message}`;
        return claimed ? handBack(why) : abandon(why);
      }
    }

    const job = materialise(project, bead, config, cwd);
    // NB: never 'manual'. `budget.admit` allows a manual trigger unconditionally,
    // so a burst borrowing it would skip the guard on every run — a burst is
    // subject to the normal guard *and* its own measured ceiling.
    const run = runner.start(job, trigger);
    if (!run) {
      const why = 'runner declined to start the job';
      return claimed ? handBack(why) : abandon(why);
    }
    attachLeaseRun(db, project.id, bead.id, run.id);

    // `skipped` means a guard (M2 budget, M3 pause, or a job already running)
    // refused it. That is not a failure of the bead — hand it straight back, and
    // that means un-claiming it too, or the guard's temporary "not now" would
    // permanently remove the bead from `bd ready`.
    if (run.status === 'skipped') {
      const why = run.meta?.skipReason
        ? `a scheduling guard skipped this run — ${run.meta.skipReason}`
        : 'a scheduling guard skipped this run';
      const out = claimed ? await handBack(why) : await abandon(why);
      return { ...out, runId: run.id, reason: why, guardSkipped: true };
    }

    // A run can be over before we get here: `runner.start` returns synchronously,
    // and a spawn that throws is failed inside that call, emitting `done:` before
    // anything could subscribe. `once` would then wait forever, leaving the lease
    // held and the bead in_progress — precisely the silent retirement the rest of
    // this file exists to prevent. So a terminal status is handled inline.
    if (!['running', 'queued'].includes(run.status)) {
      const why = `the run ended immediately (${run.status})`;
      const out = claimed ? await handBack(why) : await abandon(why);
      return { ...out, runId: run.id, reason: why };
    }

    onDone(project, bead, run.id, { claimed });
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
      // Set explicitly, and this row is created directly rather than through
      // validateJob — so a field default declared by the extension would never be
      // applied. That is how scheduled beads ended up in `default` mode with
      // every write denied: `permMode` was simply absent from params.
      permMode: config.defaults.permMode,
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

  // Best-effort un-claim. Loud on failure rather than silent, because a bead left
  // `in_progress` is one `bd ready` will never offer again — it does not look
  // broken, it just quietly stops existing as far as the scheduler is concerned,
  // and only a human running `bd` in that repo would ever notice.
  async function unclaim(project, beadId, why) {
    try {
      const res = await beads.release(project, beadId);
      if (res.ok) {
        events.emit('handed-back', { projectId: project.id, beadId, reason: why });
        return true;
      }
      events.emit('unclaim-failed', { projectId: project.id, beadId, reason: res.reason, busy: !!res.busy });
    } catch (err) {
      events.emit('unclaim-failed', { projectId: project.id, beadId, reason: err?.message ?? String(err), busy: false });
    }
    return false;
  }

  // Reap a bead's worktree. Best-effort and never fatal: a run's outcome is
  // already decided by the time this is called, and failing to tidy up must not
  // change what happened to the bead. But it IS reported, because worktrees are
  // now per bead — before M4 there was one per project, reused forever, so
  // "forgot to reap" cost nothing; now it is one directory per bead that ever ran,
  // growing without bound.
  async function reap(project, beadId) {
    const root = setting('worktreeRoot', '') || null;
    if (!worktrees || !root) return false;
    try {
      await worktrees.remove(project, { root, beadId });
      return true;
    } catch (err) {
      events.emit('reap-failed', { projectId: project.id, beadId, reason: err?.message ?? String(err) });
      return false;
    }
  }

  // The outcome contract: a bead is closed only when the run succeeded AND the
  // run said it finished the task. Both halves are needed — see
  // `completionMarker` for why the exit status alone is not evidence.
  function onDone(project, bead, runId, { claimed = true } = {}) {
    runner.events.once(`done:${runId}`, async (status) => {
      try {
        if (status !== 'ok') {
          // fail / killed / stopped / skipped all leave the bead OPEN and
          // release the lease so a later poll can retry it. An M3 `stopped` is a
          // deliberate wind-down, not a failure — treating it as one would close
          // a task nobody finished.
          //
          // "Open" has to mean open in BEADS too, not just un-leased here. Our
          // claim set it `in_progress`, and `bd ready` excludes that — so without
          // the un-claim this branch says "retry later" and guarantees never.
          if (claimed) await unclaim(project, bead.id, `run ${runId} finished ${status}`);
          releaseLease(db, project.id, bead.id);
          events.emit('finished', { projectId: project.id, beadId: bead.id, runId, status, closed: false });
          changed();
          return;
        }
        // Exited fine — but did it actually do the task? Measured live: a run
        // whose every write was denied still ended `success` and explained, in
        // words, that it had done nothing. Closing on that is how a tracker
        // quietly fills up with work nobody did.
        const said = getRun(db, runId)?.meta?.resultText ?? '';
        if (!signalledComplete(said, bead.id)) {
          // The agent's own closing words are the most useful thing a human or a
          // later attempt can read, so they go on the bead rather than only into
          // a log file nobody will look for.
          await beads.note(project, bead.id, [
            `claude-scheduler run ${runId} ended without signalling completion, so this task was returned`,
            `to the backlog. What the run said at the end:`,
            '',
            // Tail, for the same reason the formatter kept the tail: the sentence
            // explaining what went wrong is at the END of a closing message, so
            // truncating from the front would drop exactly the part worth reading.
            said ? tailOf(said.trim(), 3000) : '(the run produced no closing message)',
          ].join('\n'));
          if (claimed) await unclaim(project, bead.id, `run ${runId} did not signal completion`);
          releaseLease(db, project.id, bead.id);
          events.emit('unfinished', { projectId: project.id, beadId: bead.id, runId, said });
          events.emit('finished', { projectId: project.id, beadId: bead.id, runId, status, closed: false });
          changed();
          return;
        }
        const res = await beads.close(project, bead.id, { reason: `completed by claude-scheduler run ${runId}` });
        if (res.ok) {
          completeLease(db, project.id, bead.id);
        } else {
          // The work IS done, so the bead is deliberately NOT handed back: a retry
          // would redo finished work, and that is worse than a stale status. But it
          // stays `in_progress`, which `bd ready` excludes — so this bead is now
          // invisible to the scheduler and only a human can resolve it. That makes
          // this the one outcome we cannot fix ourselves, and it must not be a
          // one-line warning nobody reads.
          releaseLease(db, project.id, bead.id);
          events.emit('close-failed', { projectId: project.id, beadId: bead.id, runId, reason: res.reason, busy: !!res.busy, stranded: true });
        }
        events.emit('finished', { projectId: project.id, beadId: bead.id, runId, status, closed: res.ok });
        changed();
      } catch (err) {
        // Same shape as a refused close, and the same consequence: the work happened
        // but the bead still reads `in_progress`.
        releaseLease(db, project.id, bead.id);
        events.emit('close-failed', { projectId: project.id, beadId: bead.id, runId, reason: err.message, busy: false, stranded: true });
        changed();
      } finally {
        // In `finally`, not paired with each of the five release sites above: the
        // run is over on every one of those paths, so the worktree is spent on all
        // of them, and a path added later would otherwise leak a directory
        // silently. The branch survives the reap, so nothing the agent committed is
        // lost — only the checkout goes.
        await reap(project, bead.id);
      }
    });
  }

  // Boot recovery. `releaseOrphanLeases` frees the leases a dead daemon left
  // behind, which is necessary but not sufficient: the beads themselves are still
  // `in_progress` from our claim, and `bd ready` will never offer those again. So
  // a crash — or an ordinary restart mid-run — strands exactly the work it was
  // doing, and does it silently.
  //
  // Runs BEFORE the leases are released so it can still see which beads were ours.
  // Each bead is re-read first and handed back only if OUR actor still holds it: if
  // the claim never landed and a human has since taken it, un-claiming would take
  // it off them.
  async function recoverOrphans() {
    // Everything up to the first `await` runs synchronously, and the caller relies
    // on that: the orphan list is captured and those leases are released BEFORE the
    // poll interval is armed. Doing it afterwards was a real double-run — a blanket
    // `WHERE state = 'held'` release cannot tell an orphan from a lease the first
    // poll just acquired, so it freed a live one; if that bead's advisory claim had
    // also failed, `bd ready` offered it again and it ran twice.
    const orphans = listLeases(db, { state: 'held' });
    for (const lease of orphans) releaseLease(db, lease.projectId, lease.beadId);

    const out = [];
    for (const lease of orphans) {
      const project = getProject(db, lease.projectId);
      if (!project) continue;
      // The run that owned this worktree is gone, so nothing else will ever reap
      // it. Done before the `bd` calls below, which can block on a busy database —
      // tidying the disk should not be held up by, or skipped because of, that.
      await reap(project, lease.beadId);
      let bead = null;
      try {
        bead = await beads.get(project, lease.beadId);
      } catch (err) {
        // Busy or broken: leave it claimed rather than guess. Reported, because a
        // bead we cannot check is a bead that may stay invisible.
        events.emit('orphan-unresolved', { projectId: project.id, beadId: lease.beadId, reason: err?.message ?? String(err) });
        out.push({ beadId: lease.beadId, handedBack: false, reason: 'could not re-read the bead' });
        continue;
      }
      if (!bead || bead.status !== 'in_progress') {
        out.push({ beadId: lease.beadId, handedBack: false, reason: 'not in progress — nothing to undo' });
        continue;
      }
      // Strictly ours, so a null assignee does NOT qualify. Our claim always sets
      // the assignee, so `in_progress` with no assignee means somebody else moved
      // it there by hand — flipping their work back to `open` would be exactly the
      // "never un-claim a claim we did not place" rule, broken.
      if (bead.assignee !== BD_ACTOR) {
        out.push({ beadId: lease.beadId, handedBack: false, reason: `held by ${bead.assignee ?? 'someone else, without claiming'}, not us` });
        continue;
      }
      const ok = await unclaim(project, lease.beadId, 'the scheduler restarted while this bead was running');
      out.push({ beadId: lease.beadId, handedBack: ok });
    }
    return out;
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
    events, start, stop, pollAll, pollProject, discover, refreshHealth, explain, recoverOrphans,
    warningsFor: (id) => warnings.get(id) ?? [],
    busyStreakFor: (id) => busyStreak.get(id) ?? 0,
    // `null` count means "never successfully polled" — distinct from a real zero,
    // which means "polled, and nothing is actionable". Falls back to the persisted
    // column so a restarted daemon reports what it last knew instead of pairing a
    // stale "polled 40s ago" with "ready unknown".
    readyFor: (id) => {
      const live = readyCache.get(id);
      if (live) return live;
      const p = getProject(db, id);
      return { count: p?.readyCount ?? null, at: p?.lastPollAt ?? null };
    },
    pollSec: () => Math.round(pollMs() / 1000),
    // Re-arm after a settings change: lowering the interval from an hour should
    // take effect now, not in an hour.
    restart() { stop(); start(); },
  };
}
