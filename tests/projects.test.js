import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { tmpData, fakeBd, bdReadyRow } from './helpers.js';
import { openDb, createProject, getProject, updateProject, listProjects, getLease, listJobs, acquireLease, getRunUsage, recordRunUsage, avgDeltaForJob } from '../lib/db.js';
import { createBeads } from '../lib/beads.js';
import { createProjects, parseProjectConfig } from '../lib/projects.js';

function freshDb() {
  return openDb(join(tmpData(), 'test.db'));
}

// A runner stand-in: records starts and lets a test drive completion, which is
// how the real runner signals outcome (`done:<runId>`).
function fakeRunner({ status = 'running' } = {}) {
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const starts = [];
  let n = 0;
  return {
    events,
    starts,
    start(job, trigger) {
      const run = { id: `run-${++n}`, jobId: job.id, status, trigger };
      starts.push({ job, trigger, run });
      return run;
    },
    finish(runId, status) { events.emit(`done:${runId}`, status); },
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
  const runner = fakeRunner(runnerOpts);
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
  runner.finish('run-1', 'ok');
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
  runner.finish('run-1', 'ok');
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
