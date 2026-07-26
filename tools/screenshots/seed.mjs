// Seeds a sandboxed scheduler instance with demo data for screenshots.
//
// Safety rules this file must keep:
//   * only `command`-type jobs are ever executed — `claude` jobs are created
//     disabled and never fired, so a capture run costs no API quota;
//   * no project is ever activated — activation arms unattended claude runs and
//     is the user's call, so rows stay `pending`/`paused`;
//   * fixture repos live in a temp dir, never in a real checkout.

import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Api {
  constructor(base) { this.base = base; }

  async req(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      // Unconditional, not `body ? … : undefined`: the daemon's CSRF guard
      // requires application/json on every mutating method, and several of the
      // calls made here (a manual run, a poll) legitimately have no body.
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (!res.ok) {
      throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return json;
  }

  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b); }
  put(p, b) { return this.req('PUT', p, b); }
}

/** Jobs: 9 command (real, cheap) + 3 claude (created disabled, never run). */
function jobDefs(repoDir) {
  return [
    { key: 'pull', body: {
      name: 'Nightly repo pull', type: 'command', cwd: repoDir,
      schedules: [{ type: 'cron', expr: '0 4 * * *' }],
      params: { command: 'echo "Already up to date."; echo "HEAD is 8424e7f"' },
      timeoutMin: 10, retryCount: 1, retryDelayMin: 5, notify: 'failure',
    } },
    { key: 'disk', body: {
      name: 'Disk usage report', type: 'command', cwd: '/tmp',
      schedules: [
        { type: 'cron', expr: '*/30 9-18 * * 1-5' },
        { type: 'once', at: futureIso(38 * 24 * 3600) },
      ],
      params: { command: 'df -h / | tail -1; echo "Downloads: 4.2G"' },
      timeoutMin: 5, notify: 'never',
    } },
    { key: 'docker', body: {
      name: 'Prune docker images', type: 'command', cwd: '/tmp',
      schedules: [{ type: 'cron', expr: '0 5 * * 0' }],
      params: { command: 'echo "Total reclaimed space: 1.83GB"' },
      timeoutMin: 15, notify: 'always',
    } },
    { key: 'fail', body: {
      name: 'Backup to NAS', type: 'command', cwd: '/tmp',
      schedules: [{ type: 'cron', expr: '15 2 * * *' }],
      params: { command: 'echo "rsync: connection refused (111) while connecting to nas.local:873" >&2; exit 1' },
      timeoutMin: 5, retryCount: 1, retryDelayMin: 1, notify: 'failure',
    } },
    { key: 'timeout', body: {
      name: 'Sync design tokens', type: 'command', cwd: '/tmp',
      schedules: [{ type: 'cron', expr: '0 */6 * * *' }],
      params: { command: 'echo "fetching token manifest…"; sleep 200' },
      timeoutMin: 1, notify: 'failure',
    } },
    { key: 'kill', body: {
      name: 'Reindex search corpus', type: 'command', cwd: '/tmp',
      schedules: [{ type: 'cron', expr: '0 3 * * *' }],
      params: { command: 'for i in $(seq 1 300); do echo "indexing batch $i / 300"; sleep 1; done' },
      timeoutMin: 30, notify: 'never',
    } },
    { key: 'stop', body: {
      name: 'Warm CI cache', type: 'command', cwd: '/tmp',
      schedules: [{ type: 'cron', expr: '30 7 * * 1-5' }],
      params: { command: 'for i in $(seq 1 300); do echo "warming layer $i"; sleep 1; done' },
      timeoutMin: 20, notify: 'failure',
    } },
    { key: 'live', body: {
      name: 'Rotate and ship logs', type: 'command', cwd: '/tmp',
      schedules: [{ type: 'cron', expr: '7 * * * *' }],
      params: { command: 'for i in $(seq 1 900); do echo "[$(date +%H:%M:%S)] shipping chunk $i — 2.4MB gzipped"; sleep 1; done' },
      timeoutMin: 30, notify: 'never',
    } },
    // Ignores SIGINT, so "wind down" leaves it visibly in the stopping… state.
    { key: 'drain', body: {
      name: 'Drain message queue', type: 'command', cwd: '/tmp',
      schedules: [{ type: 'cron', expr: '23 * * * *' }],
      params: { command: 'trap "" INT TERM; for i in $(seq 1 240); do echo "draining message $i (uninterruptible section)"; sleep 1; done' },
      timeoutMin: 10, notify: 'never',
    } },
    { key: 'disabled', body: {
      name: 'Vacuum sqlite (paused)', type: 'command', cwd: '/tmp',
      schedules: [{ type: 'cron', expr: '0 1 * * 6' }],
      params: { command: 'echo vacuumed' },
      enabled: false, timeoutMin: 10, notify: 'never',
    } },

    // ---- claude jobs: created disabled, never triggered. No quota spent. ----
    { key: 'triage', body: {
      name: 'Weekly dependency triage', type: 'claude', cwd: repoDir, enabled: false,
      schedules: [{ type: 'cron', expr: '0 6 * * 1' }],
      params: {
        prompt: 'Review package.json for outdated deps and summarise risky upgrades.',
        model: 'sonnet', permMode: 'acceptEdits', extraArgs: '--max-turns 30',
      },
      timeoutMin: 45, retryCount: 2, retryDelayMin: 10, notify: 'always',
    } },
    { key: 'burn', body: {
      name: 'Burn leftover quota on docs', type: 'claude', cwd: repoDir, enabled: false,
      schedules: [{ type: 'afterReset', window: 'five_hour', offsetMin: 3, jitterMin: 2 }],
      params: {
        prompt: 'Tidy the docs/ folder: fix broken links and stale dates.',
        model: 'haiku', permMode: 'default', extraArgs: '',
      },
      timeoutMin: 30, notify: 'failure',
    } },
    { key: 'flaky', body: {
      name: 'Flaky test hunter', type: 'claude', cwd: repoDir, enabled: false,
      schedules: [{ type: 'cron', expr: '0 22 * * *' }],
      params: {
        prompt: 'Run the suite 10x, isolate any test that fails non-deterministically, and record the name.',
        model: 'opus', permMode: 'auto', extraArgs: '--max-turns 60',
      },
      timeoutMin: 90, retryCount: 1, retryDelayMin: 15, notify: 'always',
    } },
  ];
}

function futureIso(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

const REPO_FIXTURES = [
  {
    name: 'checkout-service',
    config: {
      enabled: true, autoLabel: 'unattended', cwd: '.', maxConcurrent: 1,
      defaults: { timeoutMin: 45, model: 'sonnet', notify: 'always', permMode: 'acceptEdits' },
      budget: { minHeadroomPct: 20 },
    },
    beads: [
      { title: 'Retry webhook deliveries that failed with 5xx', p: 1, type: 'bug', labels: 'unattended,webhooks' },
      { title: 'Bump the Adyen SDK to 12.4 and re-run contract tests', p: 2, type: 'chore', labels: 'deps,unattended' },
      { title: 'Split the basket totals helper out of checkout.js', p: 2, type: 'feature', labels: 'design' },
    ],
  },
  {
    name: 'design-tokens',
    config: {
      enabled: true, autoLabel: 'auto-ok', cwd: '.', maxConcurrent: 2,
      defaults: { timeoutMin: 20, model: 'default', notify: 'failure', permMode: 'default' },
    },
    beads: [
      { title: 'Add WCAG AA contrast assertions for the new warning palette', p: 1, type: 'task', labels: 'a11y,auto-ok' },
      { title: 'Regenerate Android XML output after the spacing scale change', p: 2, type: 'chore', labels: 'auto-ok,build' },
    ],
  },
  {
    name: 'infra-terraform',
    config: {
      enabled: true, autoLabel: 'scheduler-safe', cwd: '.', maxConcurrent: 1,
      defaults: { timeoutMin: 60, model: 'opus', notify: 'never', permMode: 'auto' },
      budget: { minHeadroomPct: 35 },
    },
    beads: [
      { title: 'Pin the EKS module to 20.8.x in staging', p: 1, type: 'task', labels: 'scheduler-safe,staging' },
      { title: 'Add a conftest rule forbidding public S3 bucket ACLs', p: 2, type: 'feature', labels: 'policy,scheduler-safe' },
      { title: 'Rotate the DynamoDB lock table to on-demand billing', p: 3, type: 'chore', labels: 'scheduler-safe' },
    ],
  },
];

/** Build fixture repos in a temp dir. Beads are best-effort — `bd` may be absent. */
export async function buildFixtureRepos(log) {
  const root = await mkdtemp(join(tmpdir(), 'cs-shots-repos-'));
  let bdOk = true;
  try { await exec('bd', ['version'], { timeout: 10_000 }); }
  catch { bdOk = false; log('  bd not usable — Ready panels will show their empty/fault state'); }

  for (const fx of REPO_FIXTURES) {
    const dir = join(root, fx.name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'README.md'), `# ${fx.name}\n\nFixture repo for screenshots.\n`);
    await writeFile(join(dir, '.scheduler.json'), JSON.stringify(fx.config, null, 2) + '\n');

    const git = (...args) => exec('git', ['-C', dir, ...args], { timeout: 20_000 });
    try {
      await git('init', '-q', '-b', 'main');
      await git('-c', 'user.email=shots@local', '-c', 'user.name=Shots',
        'commit', '--allow-empty', '-q', '-m', 'init');
      await git('add', '-A');
      await git('-c', 'user.email=shots@local', '-c', 'user.name=Shots',
        'commit', '-q', '-m', 'add scheduler config');
    } catch (err) { log(`  git init failed for ${fx.name}: ${err.message.split('\n')[0]}`); }

    if (!bdOk) continue;
    // `bd -C <dir>` refuses to run until a beads project exists there, so every
    // call is scoped with cwd instead — including `init` itself.
    const bd = (args, timeout = 60_000) => exec('bd', args, {
      cwd: dir,
      timeout,
      env: { ...process.env, BD_NON_INTERACTIVE: '1' },
    });
    try {
      await bd(['init', '--skip-agents', '--skip-hooks'], 180_000);
      const ids = [];
      for (const b of fx.beads) {
        const { stdout } = await bd([
          'create', b.title, '-p', String(b.p), '-t', b.type, '-l', b.labels, '--json',
        ]);
        ids.push(parseBeadId(stdout));
      }
      // One blocked bead, so the Ready panel visibly excludes something.
      if (ids[0] && ids[1]) await bd(['dep', 'add', ids[1], ids[0]], 30_000).catch(() => {});
    } catch (err) {
      const detail = (err.stderr || err.message || '').split('\n').find((l) => l.trim()) ?? '';
      log(`  beads setup failed for ${fx.name}: ${detail.slice(0, 160)}`);
    }
  }
  return root;
}

function parseBeadId(stdout) {
  try {
    const j = JSON.parse(stdout);
    return j.id ?? j.issue?.id ?? j.issues?.[0]?.id ?? null;
  } catch {
    return stdout.trim().match(/\b[a-z]+-[a-z0-9]+\b/i)?.[0] ?? null;
  }
}

/**
 * Seed everything. Returns handles the shot list needs (job ids, run ids).
 */
export async function seed({ api, repoDir, fixtureRoot, log }) {
  log('· settings');
  await api.put('/api/settings', { projectRoots: fixtureRoot });

  log('· jobs');
  const ids = {};
  for (const { key, body } of jobDefs(repoDir)) {
    const job = await api.post('/api/jobs', body);
    ids[key] = job.id;
  }

  // Fire the slow-settling one first so its 1-minute timeout elapses while we
  // do everything else, instead of adding a minute of dead wait at the end.
  log('· run history (timeout job first, it needs ~60s to settle)');
  await api.post(`/api/jobs/${ids.timeout}/run`, {});

  for (const key of ['pull', 'disk', 'docker', 'pull']) {
    await api.post(`/api/jobs/${ids[key]}/run`, {});
    await sleep(1200);
  }

  await api.post(`/api/jobs/${ids.fail}/run`, {});
  await sleep(1200);

  const killRun = await api.post(`/api/jobs/${ids.kill}/run`, {});
  await sleep(2500);
  await api.post(`/api/runs/${killRun.id}/kill`, {});

  const stopRun = await api.post(`/api/jobs/${ids.stop}/run`, {});
  await sleep(2500);
  await api.post(`/api/runs/${stopRun.id}/stop`, {});

  log('· projects (discover only — nothing is activated)');
  await api.post('/api/projects/discover', {});
  const { projects } = await api.get('/api/projects');
  const paused = projects.find((p) => p.name === 'infra-terraform');
  if (paused) await api.put(`/api/projects/${paused.id}`, { state: 'paused' });

  log('· waiting for the timeout run to settle');
  await waitFor(async () => {
    const { runs } = await api.get('/api/runs?limit=100');
    return runs.some((r) => r.status === 'timeout');
  }, 90_000, 'a run to reach status=timeout');

  // Started last and left alive, so the live-run states are on screen. Fired
  // *after* the settle wait so it is unambiguously the newest run of that job
  // (the Jobs tab derives its live controls from the job's most recent run).
  log('· starting the live run');
  const liveRun = await api.post(`/api/jobs/${ids.live}/run`, {});
  await sleep(2500);

  log('· starting + winding down the uninterruptible run');
  const drainRun = await api.post(`/api/jobs/${ids.drain}/run`, {});
  await sleep(2000);
  await api.post(`/api/runs/${drainRun.id}/stop`, {});
  await sleep(1500);

  const { runs } = await api.get('/api/runs?limit=100');
  const seen = [...new Set(runs.map((r) => r.status))].sort();
  log(`· ${runs.length} runs, statuses: ${seen.join(', ')}`);

  return { ids, liveRunId: liveRun.id, drainRunId: drainRun.id, statuses: seen };
}

export async function waitFor(pred, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(500);
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`);
}
