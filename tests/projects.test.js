import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { tmpData, fakeBd, bdReadyRow } from './helpers.js';
import { openDb, createProject, getProject, updateProject, listProjects, getLease, listJobs, acquireLease, getRunUsage, recordRunUsage, avgDeltaForJob, setSetting } from '../lib/db.js';
import { createBeads } from '../lib/beads.js';
import { createProjects, parseProjectConfig, completionMarker, beadPrompt } from '../lib/projects.js';

function freshDb() {
  return openDb(join(tmpData(), 'test.db'));
}

// A runner stand-in: records starts and lets a test drive completion, which is
// how the real runner signals outcome (`done:<runId>`).
function fakeRunner({ db = null, status = 'running' } = {}) {
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const starts = [];
  let n = 0;
  return {
    events,
    starts,
    start(job, trigger) {
      const id = `run-${++n}`;
      // A real row, because the poller reads the run's recorded final message to
      // decide whether the task was actually done — exit status alone is not
      // evidence of completion.
      if (db) {
        db.prepare('INSERT INTO runs (id, jobId, status, trigger, createdAt) VALUES (?, ?, ?, ?, ?)')
          .run(id, job.id, status, trigger, new Date().toISOString());
      }
      const run = { id, jobId: job.id, status, trigger };
      starts.push({ job, trigger, run });
      return run;
    },
    // `said` is the agent's closing message. Completion is something the agent
    // asserts, so a test that expects a close has to state that it said so.
    finish(runId, status, { said = null } = {}) {
      if (db && said != null) {
        db.prepare('UPDATE runs SET meta = ? WHERE id = ?').run(JSON.stringify({ resultText: said }), runId);
      }
      events.emit(`done:${runId}`, status);
    },
  };
}

const CONFIG = { autoLabel: 'unattended', maxConcurrent: 1, defaults: { timeoutMin: 30, model: 'default', notify: 'failure' } };

function setup({ bdHandlers = {}, runnerOpts = {}, config = CONFIG, state = 'active' } = {}) {
  const db = freshDb();
  const bd = fakeBd({
    '--version': { stdout: 'bd version 1.1.0 (Homebrew)' },
    where: { stdout: JSON.stringify({ path: '/repo/.beads', database_path: '/repo/.beads/embeddeddolt' }) },
    ...bdHandlers,
  });
  const beads = createBeads({ execFileFn: bd });
  const runner = fakeRunner({ db, ...runnerOpts });
  const project = createProject(db, { name: 'repo', path: '/repo', state, config, beadsDir: '/repo/.beads' });
  const projects = createProjects({ db, beads, runner });
  return { db, bd, beads, runner, project, projects };
}

// --- config ------------------------------------------------------------

test('autoLabel is mandatory — its absence is an error, never "run everything"', () => {
  const bad = parseProjectConfig({ enabled: true });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /autoLabel/);

  const good = parseProjectConfig({ autoLabel: 'unattended' });
  assert.equal(good.ok, true);
  assert.equal(good.config.autoLabel, 'unattended');
  assert.equal(good.config.maxConcurrent, 1, 'conservative default');
});

test('a project with no autoLabel contributes zero work and lands in error', async () => {
  const { db, projects, project, runner } = setup({ config: { enabled: true } });
  const r = await projects.pollProject(project.id);

  assert.equal(r.ok, false);
  assert.deepEqual(r.started, []);
  assert.match(r.reasons.join(' '), /autoLabel/);
  assert.equal(getProject(db, project.id).state, 'error');
  assert.equal(runner.starts.length, 0, 'nothing may run without the opt-in label');
});

// --- the activation airlock -------------------------------------------

test('discovery creates pending only, and never polls or runs', async () => {
  const dir = tmpData();
  const db = openDb(join(dir, 'test.db'));
  const bd = fakeBd({ ready: { stdout: JSON.stringify([bdReadyRow({ labels: ['unattended'] })]) } });
  const runner = fakeRunner();
  const projects = createProjects({
    db, beads: createBeads({ execFileFn: bd }), runner,
    fsx: {
      readdir: async () => [{ name: 'repoA', isDirectory: () => true }],
      readFile: async () => JSON.stringify({ autoLabel: 'unattended' }),
    },
  });

  const found = await projects.discover({ roots: ['/roots'] });
  assert.equal(found.length, 1);
  assert.equal(found[0].project.state, 'pending', 'discovery may only ever write pending');

  // A pending project is inert: polling it does nothing and starts nothing.
  const r = await projects.pollProject(found[0].project.id);
  assert.equal(r.skipped, true);
  assert.deepEqual(r.started, []);
  assert.equal(runner.starts.length, 0);
  assert.match(projects.explain(found[0].project).join(' '), /activate/);

  // And the whole-loop pass skips it too.
  await projects.pollAll();
  assert.equal(runner.starts.length, 0, 'no code path activates implicitly');
});

test('re-discovery refreshes the declaration but never resurrects state', async () => {
  const db = freshDb();
  const p = createProject(db, { name: 'repo', path: '/roots/repoA', state: 'paused', config: CONFIG });
  const projects = createProjects({
    db, beads: createBeads({ execFileFn: fakeBd() }), runner: fakeRunner(),
    fsx: {
      readdir: async () => [{ name: 'repoA', isDirectory: () => true }],
      readFile: async () => JSON.stringify({ autoLabel: 'changed-label' }),
    },
  });

  await projects.discover({ roots: ['/roots'] });
  const after = getProject(db, p.id);
  assert.equal(after.state, 'paused', 'discovery must not un-pause what a human paused');
  assert.equal(after.config.autoLabel, 'changed-label', 'but the declaration is refreshed');
});

// --- eligibility -------------------------------------------------------

test('only beads carrying autoLabel run; an unlabelled one is ignored, not fatal', async () => {
  const { projects, project, runner } = setup({
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-bare' }), bdReadyRow({ id: 'sp-ok', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-ok', labels: ['unattended'] })]) },
      update: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-ok', assignee: 'me' })]) },
    },
  });

  const r = await projects.pollProject(project.id);
  assert.equal(r.started.length, 1);
  assert.equal(r.started[0].beadId, 'sp-ok');
  assert.equal(runner.starts.length, 1);
});

test('a blocked bead is never offered, and a `related`-only bead still is', async () => {
  // bd itself does the dependency reasoning: a bead with an open *blocking*
  // dependency simply doesn't appear in `ready`. A `related`/`discovered-from`
  // link does not block, so that bead does appear — and must be runnable.
  const { projects, project } = setup({
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-related', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-related', labels: ['unattended'] })]) },
      update: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-related' })]) },
    },
  });
  const r = await projects.pollProject(project.id);
  assert.deepEqual(r.ready.map((b) => b.id), ['sp-related']);
  assert.equal(r.started.length, 1);
});

// --- the lease is the lock --------------------------------------------

test('two poll cycles cannot double-run one bead', async () => {
  const { projects, project, runner } = setup({
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      update: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1' })]) },
    },
  });

  await projects.pollProject(project.id);
  await projects.pollProject(project.id); // the run is still going; lease is held
  assert.equal(runner.starts.length, 1, 'the held lease blocks the second cycle');
});

test('a bead already leased is refused by acquireLease, not merely by the slot cap', async () => {
  // maxConcurrent is deliberately 2 with only 1 lease held, so a free slot
  // exists and execution really does reach acquireLease. With maxConcurrent 1
  // the slot arithmetic would short-circuit first and this would prove nothing.
  const { db, projects, project, runner } = setup({
    config: { ...CONFIG, maxConcurrent: 2 },
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      update: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1' })]) },
    },
  });
  acquireLease(db, { projectId: project.id, beadId: 'sp-1' });

  const r = await projects.pollProject(project.id);
  assert.equal(r.started.length, 0, 'the lease row itself is what refuses the run');
  assert.equal(runner.starts.length, 0);
});

test('maxConcurrent caps how many beads a project runs at once', async () => {
  const { projects, project, runner } = setup({
    config: { ...CONFIG, maxConcurrent: 2 },
    bdHandlers: {
      ready: { stdout: JSON.stringify([
        bdReadyRow({ id: 'sp-1', labels: ['unattended'] }),
        bdReadyRow({ id: 'sp-2', labels: ['unattended'] }),
        bdReadyRow({ id: 'sp-3', labels: ['unattended'] }),
      ]) },
      show: ({ args }) => ({ stdout: JSON.stringify([bdReadyRow({ id: args[1], labels: ['unattended'] })]) }),
      update: ({ args }) => ({ stdout: JSON.stringify([bdReadyRow({ id: args[1] })]) }),
    },
  });

  const r = await projects.pollProject(project.id);
  assert.equal(r.started.length, 2);
  assert.equal(runner.starts.length, 2);
});

// --- pre-launch re-read ----------------------------------------------

test('pre-launch re-read aborts when the bead is no longer open', async () => {
  const { db, projects, project, runner } = setup({
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', status: 'closed', labels: ['unattended'] })]) },
    },
  });

  const r = await projects.pollProject(project.id);
  assert.equal(runner.starts.length, 0);
  assert.equal(r.started.length, 0);
  assert.equal(getLease(db, project.id, 'sp-1').state, 'released', 'the lease is handed back');
});

test('pre-launch re-read aborts when a human has been assigned the bead', async () => {
  const { projects, project, runner } = setup({
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      // `ready` carries no assignee, which is exactly why the re-read uses `show`.
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', assignee: 'a-human', labels: ['unattended'] })]) },
    },
  });

  await projects.pollProject(project.id);
  assert.equal(runner.starts.length, 0, 'reassigned work belongs to the human');
});

// --- claim semantics -------------------------------------------------

test('a failed claim WRITE does not prevent the run, but is logged', async () => {
  const { projects, project, runner } = setup({
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      update: { code: 1, stderr: 'Error: some unrelated write failure\n' },
    },
  });
  const logged = [];
  projects.events.on('claim-failed', (e) => logged.push(e));

  const r = await projects.pollProject(project.id);
  assert.equal(r.started.length, 1, 'the lease is authoritative, so the run proceeds');
  assert.equal(logged.length, 1);
});

test('a bead already claimed by someone else is abandoned, not run', async () => {
  const { projects, project, runner } = setup({
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      update: { code: 1, stderr: 'Error claiming sp-1: issue already claimed by racer1\n' },
    },
  });
  const abandoned = [];
  projects.events.on('abandoned', (e) => abandoned.push(e));

  await projects.pollProject(project.id);
  assert.equal(runner.starts.length, 0);
  assert.match(abandoned[0].reason, /racer1/, 'the competitor is named');
});

test('a claim that times out gives the bead back for a later poll', async () => {
  const { db, projects, project, runner } = setup({
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      update: { timeout: true },
    },
  });

  await projects.pollProject(project.id);
  assert.equal(runner.starts.length, 0);
  // Measured: a killed claim leaves no phantom write, so releasing is correct.
  assert.equal(getLease(db, project.id, 'sp-1').state, 'released');
});

// --- outcome contract ------------------------------------------------

function successSetup(runnerOpts) {
  return setup({
    runnerOpts,
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      update: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1' })]) },
      close: { stdout: '' },
    },
  });
}

test('on ok the bead is closed and the lease completes', async () => {
  const { db, bd, projects, project, runner } = successSetup();
  await projects.pollProject(project.id);
  const finished = new Promise((r) => projects.events.once('finished', r));
  // The marker is the whole point: without it the run is treated as unfinished.
  runner.finish('run-1', 'ok', { said: `done.\n${completionMarker('sp-1')}` });
  const e = await finished;

  assert.equal(e.closed, true);
  assert.equal(getLease(db, project.id, 'sp-1').state, 'done');
  assert.ok(bd.calls.some((c) => c.sub === 'close'), 'the scheduler closes the bead, not the agent');
});

for (const status of ['fail', 'killed']) {
  test(`on ${status} the bead is NOT closed and the lease is released`, async () => {
    const { db, bd, projects, project, runner } = successSetup();
    await projects.pollProject(project.id);
    const finished = new Promise((r) => projects.events.once('finished', r));
    runner.finish('run-1', status);
    const e = await finished;

    assert.equal(e.closed, false);
    assert.equal(getLease(db, project.id, 'sp-1').state, 'released', 'retryable on a later poll');
    assert.ok(!bd.calls.some((c) => c.sub === 'close'), 'a failed run must never close its bead');
  });
}

test('an M3 `stopped` wind-down leaves the bead open and unclaimed-for-retry', async () => {
  const { db, bd, projects, project, runner } = successSetup();
  await projects.pollProject(project.id);
  const finished = new Promise((r) => projects.events.once('finished', r));
  runner.finish('run-1', 'stopped');
  await finished;

  // A graceful wind-down is a scheduling decision, not a task failure. Closing
  // here would mark work done that nobody finished.
  assert.ok(!bd.calls.some((c) => c.sub === 'close'));
  assert.equal(getLease(db, project.id, 'sp-1').state, 'released');
});

test('a guard-skipped run hands the bead straight back', async () => {
  const { db, projects, project } = successSetup({ status: 'skipped' });
  const r = await projects.pollProject(project.id);
  assert.equal(r.started.length, 0, 'a skipped run did not start');
  assert.equal(getLease(db, project.id, 'sp-1').state, 'released');
});

test('a close that fails leaves the lease released rather than claiming success', async () => {
  const { db, projects, project, runner } = setup({
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      update: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1' })]) },
      close: { timeout: true },
    },
  });
  await projects.pollProject(project.id);
  const failed = new Promise((r) => projects.events.once('close-failed', r));
  runner.finish('run-1', 'ok', { said: completionMarker('sp-1') });
  const e = await failed;

  assert.equal(e.busy, true);
  assert.equal(getLease(db, project.id, 'sp-1').state, 'released', 'state stays honest');
});

// --- materialised job -------------------------------------------------

test('the job carries _beadId/_projectId and is disabled so cron never arms it', async () => {
  const { db, projects, project, runner } = successSetup();
  await projects.pollProject(project.id);

  const [job] = listJobs(db);
  assert.equal(job.params._beadId, 'sp-1');
  assert.equal(job.params._projectId, project.id);
  assert.equal(job.enabled, false, 'the poller launches it directly; the scheduler must not');
  assert.equal(job.type, 'claude');
  assert.equal(runner.starts[0].trigger, 'beads');
  assert.match(job.params.prompt, /Do NOT close the bead/, 'closing is the scheduler\'s job');
});

test('re-running one bead reuses its job row, so learned cost accumulates', async () => {
  // §4a.7: run_usage keys by jobId. A stable row per bead is what stops burst
  // estimates regressing to the default forever.
  const { db, projects, project, runner } = successSetup();
  await projects.pollProject(project.id);
  const jobId = listJobs(db)[0].id;
  recordRunUsage(db, { runId: 'run-1', jobId, beforePct: { five_hour: 10 }, afterPct: { five_hour: 14 } });
  runner.finish('run-1', 'fail'); // released, so it is eligible again
  await new Promise((r) => setImmediate(r));

  await projects.pollProject(project.id);
  assert.equal(listJobs(db).length, 1, 'one job row per bead, not one per run');
  assert.equal(listJobs(db)[0].id, jobId);
  assert.equal(avgDeltaForJob(db, jobId).median.five_hour, 4, 'cost history survives the next run');
});

// --- resilience -------------------------------------------------------

test('a bd failure marks the project error with a reason and does not kill the loop', async () => {
  const db = freshDb();
  const bd = fakeBd({
    '--version': { stdout: 'bd version 1.1.0 (Homebrew)' },
    where: { stdout: JSON.stringify({ path: '/r/.beads', database_path: '/r/.beads/db' }) },
    ready: ({ opts }) => (opts.env.BEADS_DIR === '/broken/.beads'
      ? { code: 1, stderr: 'Error: database is corrupt\n' }
      : { stdout: JSON.stringify([]) }),
  });
  const broken = createProject(db, { name: 'broken', path: '/broken', state: 'active', config: CONFIG, beadsDir: '/broken/.beads' });
  const fine = createProject(db, { name: 'fine', path: '/fine', state: 'active', config: CONFIG, beadsDir: '/fine/.beads' });
  const projects = createProjects({ db, beads: createBeads({ execFileFn: bd }), runner: fakeRunner() });

  const results = await projects.pollAll();
  assert.equal(results.length, 2, 'the loop visits every project');
  assert.equal(getProject(db, broken.id).state, 'error');
  assert.match(getProject(db, broken.id).lastError, /corrupt/);
  assert.equal(getProject(db, fine.id).state, 'active', 'one bad project does not poison the rest');
});

test('a busy database is not an error state, and the streak is counted', async () => {
  const { db, projects, project } = setup({ bdHandlers: { where: { timeout: true } } });

  const r1 = await projects.pollProject(project.id);
  assert.equal(r1.busy, true);
  assert.equal(r1.consecutive, 1);
  // Contention is the common case when a human is working in the repo — latching
  // `error` here would cry wolf.
  assert.equal(getProject(db, project.id).state, 'active');
  assert.equal(getProject(db, project.id).lastError, null);

  const r2 = await projects.pollProject(project.id);
  assert.equal(r2.consecutive, 2, 'repeated timeouts are what deserve attention');
});

test('a project recovers from error on its own once bd works again', async () => {
  let broken = true;
  const db = freshDb();
  const bd = fakeBd({
    '--version': { stdout: 'bd version 1.1.0 (Homebrew)' },
    where: { stdout: JSON.stringify({ path: '/r/.beads', database_path: '/r/.beads/db' }) },
    ready: () => (broken ? { code: 1, stderr: 'Error: nope\n' } : { stdout: '[]' }),
  });
  const p = createProject(db, { name: 'r', path: '/r', state: 'active', config: CONFIG, beadsDir: '/r/.beads' });
  const projects = createProjects({ db, beads: createBeads({ execFileFn: bd }), runner: fakeRunner() });

  await projects.pollProject(p.id);
  assert.equal(getProject(db, p.id).state, 'error');
  broken = false;
  await projects.pollProject(p.id);
  assert.equal(getProject(db, p.id).state, 'active', 'no manual poke needed');
});

test('a bd version change surfaces a warning and does not poll on silently', async () => {
  const { db, projects, project } = setup({
    bdHandlers: {
      '--version': { stdout: 'bd version 2.0.0 (Homebrew)' },
      ready: { stdout: '[]' },
    },
  });
  updateProject(db, project.id, { bdVersion: 'bd version 1.1.0 (Homebrew)' });
  const warned = [];
  projects.events.on('warning', (w) => warned.push(w));

  const r = await projects.pollProject(project.id);
  assert.equal(warned.length, 1);
  assert.match(warned[0].message, /1\.1\.0.*2\.0\.0|version changed/);
  assert.equal(r.warnings.length, 1, 'the warning travels with the poll result');
  assert.equal(projects.warningsFor(project.id).length, 1);
});

test('a hollow .beads/ is reported as unhealthy with that reason, not obscurely', async () => {
  const { db, projects, project, runner } = setup({
    bdHandlers: { where: { stdout: JSON.stringify({ path: '/wt/.beads' }) } }, // no database_path
  });

  const r = await projects.pollProject(project.id);
  assert.equal(r.ok, false);
  assert.equal(runner.starts.length, 0, 'contributes zero ready tasks');
  assert.match(getProject(db, project.id).lastError, /hollow|no database/i);
});

test('refreshHealth learns beadsDir from bd where, never by concatenation', async () => {
  const { db, projects, project } = setup({
    bdHandlers: { where: { stdout: JSON.stringify({ path: '/elsewhere/.beads', database_path: '/elsewhere/.beads/db' }) } },
  });
  await projects.refreshHealth(project.id);

  const after = getProject(db, project.id);
  assert.equal(after.beadsDir, '/elsewhere/.beads');
  assert.equal(after.bdVersion, 'bd version 1.1.0 (Homebrew)');
});

// --- pause (M3) ---------------------------------------------------------
// The poller launches runs *directly*, not through the scheduler, so nothing in
// M3 covered it: `pause.gate()` deliberately admits everything under `hold`
// (in v1 the only things that could reach the runner were a manual click and an
// armed retry), and the scheduler is what drops held fires. A bead run is
// neither, so without an explicit check the button whose entire promise is
// "nothing fires automatically" would leave the most unattended work in the
// system running.

// A pause controller stand-in: only `blocksSchedule`/`mode` are consulted here.
const fakePause = (mode) => ({ mode: () => mode, blocksSchedule: () => mode !== 'off' });

for (const mode of ['hold', 'soft', 'hard']) {
  test(`a ${mode} pause stops bead pickup — the poller does not bypass the pause`, async () => {
    const { db, projects: _unused, project, runner, beads } = setup({
      bdHandlers: { ready: { stdout: JSON.stringify([bdReadyRow({ labels: ['unattended'] })]) } },
    });
    const projects = createProjects({ db, beads, runner, pause: fakePause(mode) });

    const r = await projects.pollProject(project.id);

    assert.equal(runner.starts.length, 0, 'nothing may be launched while paused');
    assert.equal(r.held, true);
    assert.equal(r.ok, true, 'being paused is not a failure of the project');
    assert.match(r.reasons.join(' '), new RegExp(mode));
    // The count still has to be honest: a pause stops launching, not looking, and
    // the Projects tab exists to say "there is work here and it is being held".
    assert.equal(r.ready.length, 1);
    assert.equal(projects.readyFor(project.id).count, 1);
    // And it must not latch the project into a fault state.
    assert.notEqual(getProject(db, project.id).state, 'error');
    assert.equal(getProject(db, project.id).lastPollOk, true);
  });
}

test('a lease is not taken while paused, so the bead is still eligible on resume', async () => {
  const { db, project, runner, beads } = setup({
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-held', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-held', labels: ['unattended'] })]) },
      update: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-held', assignee: 'scheduler' })]) },
    },
  });
  const paused = createProjects({ db, beads, runner, pause: fakePause('hold') });
  await paused.pollProject(project.id);
  assert.equal(getLease(db, project.id, 'sp-held'), null, 'a held schedule must not consume the bead');

  // Resuming is all it should take — no manual poke, no released lease to clean up.
  const live = createProjects({ db, beads, runner, pause: fakePause('off') });
  await live.pollProject(project.id);
  assert.equal(runner.starts.length, 1);
  assert.equal(getLease(db, project.id, 'sp-held').state, 'held');
});

test('explain() says the schedule is paused, so "nothing is running" is never a mystery', () => {
  const { db, project, runner, beads } = setup();
  const projects = createProjects({ db, beads, runner, pause: fakePause('soft') });
  assert.match(projects.explain(getProject(db, project.id)).join(' '), /paused \(soft\)/);

  const off = createProjects({ db, beads, runner, pause: fakePause('off') });
  assert.deepEqual(off.explain(getProject(db, project.id)), [], 'an active, healthy project explains nothing');
});

// --- handing a bead back (found by live-driving, not by reasoning) -------
// `bd ready` excludes `in_progress`. Our claim sets exactly that, so releasing
// only our own lease leaves the bead invisible to every future poll: the outcome
// contract's "fail/stopped/killed leaves it open for retry" would have meant
// "retired forever, silently". Every path that gives up AFTER a successful claim
// has to un-claim in beads too.

// Did we ask bd to put the bead back? Measured shape: `update <id> --status open
// --assignee ""` restores it to `bd ready` in one call.
const unclaimCalls = (bd) => bd.calls.filter((c) =>
  c.sub === 'update' && c.args.includes('--status') && c.args.includes('open'));

test('a failed run hands the bead back to open, not just un-leases it', async () => {
  const { db, bd, projects, project, runner } = setup({
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      update: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', assignee: 'claude-scheduler' })]) },
    },
  });
  await projects.pollProject(project.id);
  assert.equal(runner.starts.length, 1);
  assert.equal(unclaimCalls(bd).length, 0, 'nothing is handed back while the run is live');

  runner.finish(runner.starts[0].run.id, 'fail');
  await new Promise((r) => setImmediate(r));

  assert.equal(unclaimCalls(bd).length, 1, 'a failed run must return the bead to bd ready');
  assert.deepEqual(unclaimCalls(bd)[0].args, ['update', 'sp-1', '--status', 'open', '--assignee', '']);
  assert.equal(getLease(db, project.id, 'sp-1').state, 'released');
});

test('an M3 wind-down hands the bead back too — a stop is not a completion', async () => {
  const { bd, projects, project, runner } = setup({
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      update: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', assignee: 'claude-scheduler' })]) },
    },
  });
  await projects.pollProject(project.id);
  runner.finish(runner.starts[0].run.id, 'stopped');
  await new Promise((r) => setImmediate(r));

  assert.equal(unclaimCalls(bd).length, 1);
  // And it is emphatically not closed: nobody finished the work.
  assert.equal(bd.calls.filter((c) => c.sub === 'close').length, 0);
});

test('a guard-skipped run hands the bead back — a temporary no must not be permanent', async () => {
  const { bd, projects, project, runner } = setup({
    runnerOpts: { status: 'skipped' },
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      update: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', assignee: 'claude-scheduler' })]) },
    },
  });
  const r = await projects.pollProject(project.id);

  assert.equal(unclaimCalls(bd).length, 1, 'the budget guard refusing must not retire the bead');
  assert.equal(r.started.length, 0);
  // And the poll says why nothing started, per bead.
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /guard/);
});

test('a bead claimed by someone else is NEVER un-claimed — that would steal it back', async () => {
  const { bd, projects, project, runner } = setup({
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      // The measured loser-of-a-race shape: exit 1 naming the winner.
      update: { code: 1, stderr: 'Error claiming sp-1: issue already claimed by a-human' },
    },
  });
  const r = await projects.pollProject(project.id);

  assert.equal(runner.starts.length, 0);
  assert.equal(unclaimCalls(bd).length, 0, 'we must not touch a claim we did not place');
  assert.match(r.skipped[0].reason, /a-human/);
});

test('a failed un-claim is reported loudly — a stuck bead is otherwise invisible', async () => {
  const { bd, projects, project, runner } = setup({
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      update: ({ args }) => (args.includes('--claim')
        ? { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', assignee: 'claude-scheduler' })]) }
        : { timeout: true }), // the un-claim hits a busy database
    },
  });
  const failures = [];
  projects.events.on('unclaim-failed', (e) => failures.push(e));

  await projects.pollProject(project.id);
  runner.finish(runner.starts[0].run.id, 'fail');
  await new Promise((r) => setImmediate(r));

  assert.equal(failures.length, 1);
  assert.equal(failures[0].beadId, 'sp-1');
  assert.equal(failures[0].busy, true, 'busy is distinguishable, so the caller can say "worth retrying"');
});

test('every bd call identifies the scheduler as the actor, not the repo owner', async () => {
  const { bd, projects, project } = setup({
    bdHandlers: { ready: { stdout: '[]' } },
  });
  await projects.pollProject(project.id);

  assert.ok(bd.calls.length > 0);
  // Otherwise `--claim` assigns the bead to the human's own git user.name, and the
  // notice board says "taken" without being able to say by whom.
  for (const c of bd.calls) assert.equal(c.env.BEADS_ACTOR, 'claude-scheduler', `actor missing on bd ${c.sub}`);
});

// --- "ok" is not "done" (found by live-driving) --------------------------
// Measured against the real CLI: a run whose every write was denied finished
// `subtype: success`, exit 0, and stated in plain English that it had done
// nothing — and the bead was closed. Exit status describes the process; it says
// nothing about the task. So closing now requires the agent to assert completion.

function markerSetup(opts = {}) {
  return setup({
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      update: ({ args }) => (args.includes('--claim')
        ? { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', assignee: 'claude-scheduler' })]) }
        : { stdout: '' }),
    },
    ...opts,
  });
}

test('a run that exits ok WITHOUT signalling completion does not close the bead', async () => {
  const { db, bd, projects, project, runner } = markerSetup();
  await projects.pollProject(project.id);
  const finished = new Promise((r) => projects.events.once('finished', r));
  // The exact shape of the live failure: cheerful exit, work not done.
  runner.finish('run-1', 'ok', { said: 'I need write permission to create the file. This is a blocker.' });
  const e = await finished;

  assert.equal(e.closed, false, 'an unfinished task must not be marked done');
  assert.ok(!bd.calls.some((c) => c.sub === 'close'));
  assert.equal(getLease(db, project.id, 'sp-1').state, 'released', 'retryable');
  assert.equal(unclaimCalls(bd).length, 1, 'and returned to bd ready');
});

test('the agent’s closing words are left on the bead, so a retry is not a mystery', async () => {
  const { bd, projects, project, runner } = markerSetup();
  await projects.pollProject(project.id);
  const finished = new Promise((r) => projects.events.once('finished', r));
  runner.finish('run-1', 'ok', { said: 'Blocked: the API key is missing.' });
  await finished;

  const note = bd.calls.find((c) => c.sub === 'note');
  assert.ok(note, 'an unexplained retry is worse than a slow one');
  assert.equal(note.args[1], 'sp-1');
  assert.match(note.args[2], /API key is missing/);
});

test('the marker must name THIS bead — a stray marker cannot close the wrong task', async () => {
  const { bd, projects, project, runner } = markerSetup();
  await projects.pollProject(project.id);
  const finished = new Promise((r) => projects.events.once('finished', r));
  runner.finish('run-1', 'ok', { said: `all done\n${completionMarker('sp-somebody-else')}` });
  const e = await finished;

  assert.equal(e.closed, false);
  assert.ok(!bd.calls.some((c) => c.sub === 'close'));
});

test('a run that does signal completion closes the bead', async () => {
  const { db, bd, projects, project, runner } = markerSetup();
  await projects.pollProject(project.id);
  const finished = new Promise((r) => projects.events.once('finished', r));
  runner.finish('run-1', 'ok', { said: `wrote the file.\n${completionMarker('sp-1')}` });
  const e = await finished;

  assert.equal(e.closed, true);
  assert.ok(bd.calls.some((c) => c.sub === 'close'));
  assert.equal(getLease(db, project.id, 'sp-1').state, 'done');
  assert.equal(unclaimCalls(bd).length, 0, 'a closed bead is not handed back');
});

test('the prompt tells the agent the marker and what a missing one costs', () => {
  const text = beadPrompt({ name: 'repo' }, { id: 'sp-1', title: 't' }, { autoLabel: 'unattended' });
  assert.ok(text.includes(completionMarker('sp-1')), 'asking for a signal nobody was told about is a trap');
  assert.match(text, /retry|returned to the backlog/i);
  assert.match(text, /do NOT close the bead/i);
});

// --- permMode (the reason the live run could not write anything) ---------

test('permMode is declared by the repo, defaults to the fail-closed value', () => {
  assert.equal(parseProjectConfig({ autoLabel: 'x' }).config.defaults.permMode, 'default',
    'silence must not grant unattended write access');
  assert.equal(parseProjectConfig({ autoLabel: 'x', defaults: { permMode: 'auto' } }).config.defaults.permMode, 'auto');
  assert.equal(parseProjectConfig({ autoLabel: 'x', defaults: { permMode: 'acceptEdits' } }).config.defaults.permMode, 'acceptEdits');
});

test('an unrecognised permMode is an error, not a silent downgrade', () => {
  const r = parseProjectConfig({ autoLabel: 'x', defaults: { permMode: 'yolo' } });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /permMode/);
  // It still resolves to the safe value, so a typo cannot widen permissions.
  assert.equal(r.config.defaults.permMode, 'default');
});

test('the materialised job carries permMode — a field default would never apply', async () => {
  const { projects, project, runner } = setup({
    config: { ...CONFIG, defaults: { ...CONFIG.defaults, permMode: 'auto' } },
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      update: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1' })]) },
    },
  });
  await projects.pollProject(project.id);

  // materialise() calls createJob directly rather than going through validateJob,
  // so the extension's own field default is never applied — which is exactly how
  // every scheduled bead ended up unable to write a file.
  assert.equal(runner.starts[0].job.params.permMode, 'auto');
});

// --- restart recovery ---------------------------------------------------
// A daemon that dies mid-run (or is simply restarted — which happens constantly)
// leaves a held lease AND a bead sitting `in_progress` from our claim. Releasing
// the lease is the obvious half; without the un-claim, `bd ready` never offers
// that bead again, so an ordinary restart silently strands exactly the work that
// was in flight.

test('a restart returns a bead that was mid-run to the backlog', async () => {
  const { db, bd, projects, project } = setup({
    bdHandlers: {
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', status: 'in_progress', assignee: 'claude-scheduler' })]) },
    },
  });
  acquireLease(db, { projectId: project.id, beadId: 'sp-1' });

  const out = await projects.recoverOrphans();

  assert.deepEqual(out, [{ beadId: 'sp-1', handedBack: true }]);
  assert.equal(unclaimCalls(bd).length, 1);
});

test('a restart does NOT take back a bead a human now holds', async () => {
  const { db, bd, projects, project } = setup({
    bdHandlers: {
      // Our claim never landed and someone else took it since.
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', status: 'in_progress', assignee: 'a-human' })]) },
    },
  });
  acquireLease(db, { projectId: project.id, beadId: 'sp-1' });

  const out = await projects.recoverOrphans();

  assert.equal(out[0].handedBack, false);
  assert.match(out[0].reason, /a-human/);
  assert.equal(unclaimCalls(bd).length, 0, 'taking a bead off a human is worse than leaving a stale one');
});

test('a restart leaves an already-closed bead alone', async () => {
  const { db, bd, projects, project } = setup({
    bdHandlers: { show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', status: 'closed' })]) } },
  });
  acquireLease(db, { projectId: project.id, beadId: 'sp-1' });

  const out = await projects.recoverOrphans();
  assert.equal(out[0].handedBack, false);
  assert.equal(unclaimCalls(bd).length, 0, 'the run finished before the daemon died — do not reopen it');
});

test('a bead that cannot be re-read on restart is reported, not guessed at', async () => {
  const { db, projects, project } = setup({ bdHandlers: { show: { timeout: true } } });
  acquireLease(db, { projectId: project.id, beadId: 'sp-1' });
  const unresolved = [];
  projects.events.on('orphan-unresolved', (e) => unresolved.push(e));

  const out = await projects.recoverOrphans();

  assert.equal(out[0].handedBack, false);
  assert.equal(unresolved.length, 1, 'a bead we could not check may stay hidden — say so');
});

// --- races and lost updates (found by code review, verified here) --------
// A poll holds bd calls that each block for up to BD_TIMEOUT_MS, so tens of
// seconds can separate reading the project row from writing the poll result.
// Anything captured before those awaits and written after is a lost update.

test('a Pause landing mid-poll is not overwritten by the poll result', async () => {
  const { db, project, runner, beads } = setup({
    bdHandlers: {
      // The human pauses the project while this call is in flight.
      ready: () => {
        updateProject(db, project.id, { state: 'paused' });
        return { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) };
      },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      update: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1' })]) },
    },
  });
  const projects = createProjects({ db, beads, runner });

  await projects.pollProject(project.id);

  // Echoing the pre-await state back would re-activate the project and then launch
  // every ready bead — the airlock and the pause both defeated by a stale write.
  assert.equal(getProject(db, project.id).state, 'paused');
});

test('a poll failure does not stamp `error` over a human\'s pause', async () => {
  const { db, project, runner, beads } = setup({
    bdHandlers: {
      where: () => {
        updateProject(db, project.id, { state: 'paused' });
        return { code: 1, stderr: 'boom' };
      },
    },
  });
  const projects = createProjects({ db, beads, runner });

  await projects.pollProject(project.id);

  // `error` is a POLLED_STATE, so stamping it here would resume polling something
  // the human switched off — and the next poll would promote it back to active.
  assert.equal(getProject(db, project.id).state, 'paused');
});

test('a recovered project still leaves `error` on its own', async () => {
  const { db, project, runner, beads } = setup({
    state: 'error',
    bdHandlers: { ready: { stdout: '[]' } },
  });
  const projects = createProjects({ db, beads, runner });
  await projects.pollProject(project.id);
  assert.equal(getProject(db, project.id).state, 'active', 'self-healing must survive the lost-update fix');
});

test('a Hold landing between beads stops the rest of the loop', async () => {
  let seen = 0;
  const { db, project, runner, beads } = setup({
    config: { ...CONFIG, maxConcurrent: 5 },
    bdHandlers: {
      ready: {
        stdout: JSON.stringify([
          bdReadyRow({ id: 'sp-1', labels: ['unattended'] }),
          bdReadyRow({ id: 'sp-2', labels: ['unattended'] }),
          bdReadyRow({ id: 'sp-3', labels: ['unattended'] }),
        ]),
      },
      show: ({ args }) => ({ stdout: JSON.stringify([bdReadyRow({ id: args[1], labels: ['unattended'] })]) }),
      update: ({ args }) => ({ stdout: JSON.stringify([bdReadyRow({ id: args[1] })]) }),
    },
  });
  // Paused after the first bead has been launched.
  let mode = 'off';
  const pause = { mode: () => mode, blocksSchedule: () => mode !== 'off' };
  const projects = createProjects({ db, beads, runner, pause });
  runner.events.on('x', () => {});
  const origStart = runner.start;
  runner.start = (job, trigger) => { if (++seen === 1) mode = 'hold'; return origStart(job, trigger); };

  const r = await projects.pollProject(project.id);

  assert.equal(r.started.length, 1, 'the rest must not launch after the pause lands');
  assert.match(r.reasons.join(' '), /paused \(hold\)/);
});

test('recoverOrphans releases only the leases it enumerated', async () => {
  const { db, project, runner, beads } = setup({
    bdHandlers: { show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-old', status: 'in_progress', assignee: 'claude-scheduler' })]) } },
  });
  const projects = createProjects({ db, beads, runner });
  acquireLease(db, { projectId: project.id, beadId: 'sp-old' }); // the orphan

  const p = projects.recoverOrphans(); // synchronous prefix captures + releases
  // A live lease taken by a poll that started *after* recovery began must survive:
  // a blanket `WHERE state='held'` release freed these, and if the bead's advisory
  // claim had failed it would then be leased and run a second time.
  acquireLease(db, { projectId: project.id, beadId: 'sp-live' });
  await p;

  assert.equal(getLease(db, project.id, 'sp-old').state, 'released');
  assert.equal(getLease(db, project.id, 'sp-live').state, 'held', 'a live lease must not be swept up');
});

test('a run that is already finished when start() returns does not leak a lease', async () => {
  const { db, project, runner, beads } = setup({
    // The runner reports a run that already failed (a synchronous spawn throw).
    runnerOpts: { status: 'fail' },
    bdHandlers: {
      ready: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', labels: ['unattended'] })]) },
      update: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1' })]) },
    },
  });
  const projects = createProjects({ db, beads, runner });

  const r = await projects.pollProject(project.id);

  // `once('done:…')` attaching after the emit would wait forever: lease held and
  // bead in_progress, with no symptom at all.
  assert.equal(r.started.length, 0);
  assert.equal(getLease(db, project.id, 'sp-1').state, 'released');
});

test('the declaration is re-read from disk each poll, so a fixed typo takes effect', async () => {
  const db = freshDb();
  const bd = fakeBd({
    '--version': { stdout: 'bd version 1.1.0 (Homebrew)' },
    where: { stdout: JSON.stringify({ path: '/repo/.beads', database_path: '/repo/.beads/db' }) },
    ready: { stdout: '[]' },
  });
  // Registered by hand with no autoLabel; the file on disk has since been fixed.
  const project = createProject(db, { name: 'repo', path: '/repo', state: 'active', config: { enabled: true } });
  const projects = createProjects({
    db, beads: createBeads({ execFileFn: bd }), runner: fakeRunner({ db }),
    fsx: { readdir: async () => [], readFile: async () => JSON.stringify({ autoLabel: 'unattended' }) },
  });

  const r = await projects.pollProject(project.id);

  // Only discover() used to re-read the file, and discovery only walks
  // projectRoots — so a hand-registered repo could never be repaired.
  assert.equal(r.ok, true);
  assert.equal(getProject(db, project.id).config.autoLabel, 'unattended');
});

test('a project sharing one worktree runs a single bead at a time', async () => {
  const { db, project, runner, beads } = setup({
    config: { ...CONFIG, maxConcurrent: 4 },
    bdHandlers: {
      ready: {
        stdout: JSON.stringify([
          bdReadyRow({ id: 'sp-1', labels: ['unattended'] }),
          bdReadyRow({ id: 'sp-2', labels: ['unattended'] }),
        ]),
      },
      show: ({ args }) => ({ stdout: JSON.stringify([bdReadyRow({ id: args[1], labels: ['unattended'] })]) }),
      update: ({ args }) => ({ stdout: JSON.stringify([bdReadyRow({ id: args[1] })]) }),
    },
  });
  setSetting(db, 'worktreeRoot', '/tmp/wt');
  const worktrees = { ensure: async () => ({ path: '/tmp/wt/repo', created: false }) };
  const projects = createProjects({ db, beads, runner, worktrees });

  const r = await projects.pollProject(project.id);

  // One worktree per project: two concurrent beads would share a checkout and a
  // branch and edit each other's files.
  assert.equal(r.started.length, 1);
  assert.match(r.reasons.join(' '), /share a single git worktree/);
});
