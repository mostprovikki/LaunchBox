#!/usr/bin/env node
// Capture the whole UI to a versioned screenshot folder.
//
//   npm run screenshots                 # -> working_prototype_screenshots/v1, v2, …
//   npm run screenshots -- --label v2   # explicit folder name
//   npm run screenshots -- --only jobs  # just the shots whose file matches
//   npm run screenshots -- --headful    # watch it drive a real window
//   npm run screenshots -- --keep       # leave the sandbox up for poking at
//
// It boots its OWN scheduler on a free port against a throwaway CS_DATA, so it
// never touches ~/.claude-scheduler. `claudePath` is pre-seeded to a fake
// binary, which means the usage probe returns fixed percentages (screenshots
// stay comparable between runs) and no real `claude` can be invoked even by
// accident — a capture run cannot spend API quota.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser, sleep } from './cdp.mjs';
import { Api, buildFixtureRepos, seed, waitFor } from './seed.mjs';
import { shots } from './shots.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT_ROOT = join(REPO, 'working_prototype_screenshots');

const VIEWPORT = { width: 1512, height: 806, scale: 2 };

// A stand-in for the `claude` binary. It answers the get_usage control request
// from the repo's own recorded fixture, rewriting only the reset timestamps to
// be in the future — so the meters read the same fixed percentages on every
// run (a version-to-version diff is then a UI diff, not a quota diff), while
// the payload *shape* stays whatever the fixture says it is.
//
// The offsets are deliberately not round numbers: exactly 2h reads as
// "resets in 1h 60m" in the UI's humaniser.
const FAKE_CLAUDE = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';

if (!process.argv.includes('--input-format')) {
  // A claude-type job should never be fired by the capture, but if one ever is,
  // answer plausibly instead of exploding.
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-session' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'fake run' }) + '\\n');
  process.exit(0);
}

const SESSION_MS = (2 * 60 + 7) * 60e3;               // 2h07m
const WEEKLY_MS = (3 * 24 * 60 + 5 * 60 + 13) * 60e3; // 3d05h13m
const iso = (ms) => new Date(Date.now() + ms).toISOString();

const fixture = JSON.parse(readFileSync(process.env.CS_SHOTS_FIXTURE, 'utf8'));
const payload = fixture.response.response;
const rl = payload.rate_limits ?? {};
if (rl.five_hour) rl.five_hour.resets_at = iso(SESSION_MS);
if (rl.seven_day) rl.seven_day.resets_at = iso(WEEKLY_MS);
for (const b of rl.limits ?? []) {
  b.resets_at = iso(b.group === 'session' ? SESSION_MS : WEEKLY_MS);
}
for (const m of rl.model_scoped ?? []) m.resets_at = iso(WEEKLY_MS);

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  if (!buf.includes('control_request')) return;
  let requestId = '1';
  for (const line of buf.split('\\n')) {
    try { const o = JSON.parse(line); if (o.request_id) requestId = o.request_id; } catch {}
  }
  process.stdout.write(JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: payload },
  }) + '\\n');
});
setTimeout(() => process.exit(0), 15_000);
`;

function parseArgs(argv) {
  const opts = { label: null, only: null, headful: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label' || a === '--out') opts.label = argv[++i];
    else if (a === '--only') opts.only = argv[++i];
    else if (a === '--headful') opts.headful = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.unref();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

async function nextLabel() {
  await mkdir(OUT_ROOT, { recursive: true });
  const existing = await readdir(OUT_ROOT, { withFileTypes: true });
  const nums = existing
    .filter((e) => e.isDirectory())
    .map((e) => /^v(\d+)$/.exec(e.name)?.[1])
    .filter(Boolean)
    .map(Number);
  return `v${nums.length ? Math.max(...nums) + 1 : 0}`;
}

const log = (m) => process.stdout.write(m + '\n');

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    log(`Usage: npm run screenshots -- [--label vN] [--only substr] [--headful] [--keep]`);
    return 0;
  }

  const label = opts.label ?? (await nextLabel());
  const outDir = join(OUT_ROOT, label);
  if (existsSync(outDir) && !opts.label) throw new Error(`${outDir} exists — pass --label`);
  await mkdir(outDir, { recursive: true });

  const dataDir = await mkdtemp(join(tmpdir(), 'cs-shots-data-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  // Filled in after the daemon boots and writes its token file.
  let api = new Api(baseUrl);

  log(`claude-scheduler screenshots → ${outDir}`);
  log(`  sandbox CS_DATA=${dataDir}  port=${port}`);

  // Fake claude, and pre-seed it as claudePath BEFORE boot so the extension's
  // autodetect execSync is skipped and the very first probe uses the fake.
  // A non-prompting stand-in for the approval helper, written into the SANDBOX
  // data dir only. Creating a job is gated by a system Touch ID dialog, so
  // without this the harness answers 503 on every seed call and captures 40
  // screenshots of an empty app — and with the real helper it would raise ~15
  // modal dialogs at whoever ran it.
  //
  // ⚠️ This is safe *because* it lives in a throwaway CS_DATA that is deleted at
  // the end of the run. It must never be copied into a real install: the whole
  // point of the real helper is that it cannot be satisfied without a human.
  // Same principle as the fake `claude` below — a capture run must not depend on,
  // or be able to affect, anything real.
  await mkdir(join(dataDir, 'bin'), { recursive: true });
  const stubHelper = join(dataDir, 'bin', 'LaunchBox');
  await writeFile(stubHelper, [
    '#!/bin/bash',
    '# sandbox stub — auto-approves. See tools/screenshots/capture.mjs.',
    'if [ "$1" = "--check" ]; then echo \'{"mode":"check","canEvaluate":true,"errorCode":0}\'; exit 0; fi',
    'echo \'{"mode":"auth","success":true,"errorCode":0}\'',
    'exit 0',
    '',
  ].join('\n'));
  await chmod(stubHelper, 0o755);

  const fakeClaude = join(dataDir, 'fake-claude.mjs');
  await writeFile(fakeClaude, FAKE_CLAUDE);
  await chmod(fakeClaude, 0o755);

  const fixture = join(REPO, 'tests/fixtures/get-usage-response.json');
  if (!existsSync(fixture)) {
    throw new Error(`usage fixture missing: ${fixture} — the fake claude reads it for the meters`);
  }

  process.env.CS_DATA = dataDir;
  const { openDb, setSetting } = await import(`file://${join(REPO, 'lib/db.js')}`);
  const { ensureDirs, dbPath } = await import(`file://${join(REPO, 'lib/paths.js')}`);
  ensureDirs();
  {
    const db = openDb(dbPath());
    setSetting(db, 'claudePath', fakeClaude);
    db.close();
  }

  let server; let browser; let fixtureRoot;
  const results = [];

  try {
    log('· booting server');
    server = spawn(process.execPath, [join(REPO, 'server.js')], {
      cwd: REPO,
      env: {
        ...process.env,
        CS_DATA: dataDir,
        CS_PORT: String(port),
        CS_NO_NOTIFY: '1',
        // Inherited by the faked `claude` the usage monitor spawns.
        CS_SHOTS_FIXTURE: fixture,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    server.stdout.on('data', (d) => { serverLog += d; });
    server.stderr.on('data', (d) => { serverLog += d; });
    server.on('exit', (code) => {
      if (code !== 0 && code !== null) log(`  server exited early (${code}):\n${serverLog.slice(-1500)}`);
    });

    // Probes `/`, not /api/settings: every /api route now answers 401 without the
    // capability token, and `.ok` would therefore never become true — the harness
    // would time out against a perfectly healthy daemon.
    await waitFor(async () => {
      try { return (await fetch(`${baseUrl}/`)).ok; } catch { return false; }
    }, 30_000, 'the server to listen');

    // The daemon creates this on first boot; read it rather than generating one,
    // so the harness uses the same key the running instance expects.
    const token = (await readFile(join(dataDir, 'token'), 'utf8')).trim();
    api = new Api(baseUrl, token);
    log(`· capability token loaded (${token.slice(0, 8)}…)`);

    log('· waiting for the (faked) usage probe');
    await waitFor(async () => {
      const u = await api.get('/api/usage').catch(() => null);
      return u?.ok === true;
    }, 30_000, 'a usage snapshot').catch((err) => {
      log(`  ! ${err.message} — the usage banner may render its "checking usage…" state`);
    });

    browser = await launchBrowser({ ...VIEWPORT, headful: opts.headful });
    const page = browser.page;

    const wanted = shots.filter((s) => !opts.only || s.file.includes(opts.only));
    // Deliver the token to the browser once. The page stores it in localStorage
    // and strips the fragment; every later goto(`${baseUrl}/#jobs`) then carries
    // it automatically. Without this every shot would be the auth banner.
    await page.goto(`${baseUrl}/#token=${token}`);
    await sleep(600);

    const ctx = { api, baseUrl, ids: {}, liveRunId: null, drainRunId: null };

    const runPhase = async (phase) => {
      for (const shot of wanted.filter((s) => s.phase === phase)) {
        const file = join(outDir, `${String(results.length + 1).padStart(2, '0')}-${shot.file}.png`);
        try {
          await shot.setup?.(page, ctx);
          const png = await page.screenshot({ fullPage: !!shot.fullPage });
          await writeFile(file, png);
          if (png.length < 5000) throw new Error(`suspiciously small png (${png.length}B)`);
          results.push({ ...shot, ok: true, file });
          log(`  ✓ ${shot.file}`);
        } catch (err) {
          results.push({ ...shot, ok: false, error: err.message });
          log(`  ✗ ${shot.file} — ${err.message}`);
        } finally {
          try { await shot.teardown?.(page, ctx); } catch { /* best effort */ }
        }
      }
    };

    await page.goto(`${baseUrl}/#jobs`);
    await sleep(800);
    log('· zero-state shots');
    await runPhase('empty');

    // Seeding is the slow part (a 1-minute timeout settle, plus `bd init` per
    // fixture repo), so skip it entirely when only zero-state shots are wanted.
    const needsSeed = wanted.some((s) => s.phase !== 'empty');
    if (needsSeed) {
      log('· seeding demo data');
      fixtureRoot = await buildFixtureRepos(log);
      const seeded = await seed({ api, repoDir: REPO, fixtureRoot, log });
      Object.assign(ctx, seeded);

      await page.goto(`${baseUrl}/#jobs`);
      await sleep(1000);
      log('· main shots');
      await runPhase('main');

      log('· global-state shots (pause modes — these stop live work)');
      await runPhase('global');
    } else {
      log('· skipping seed (no non-empty-phase shots selected)');
    }

    await writeFile(join(outDir, 'INDEX.md'), indexMd({ label, results, ctx }));
    log(`  ✓ INDEX.md`);
  } finally {
    if (opts.keep) {
      log(`\n--keep: sandbox left running at ${baseUrl} (CS_DATA=${dataDir})`);
      log('  stop it with:  kill ' + (server?.pid ?? '<pid>'));
      if (browser) await browser.close();
    } else {
      if (browser) await browser.close();
      if (server) server.kill('SIGTERM');
      await sleep(400);
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
      if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  const failed = results.filter((r) => !r.ok);
  log(`\n${results.length - failed.length}/${results.length} shots captured → ${outDir}`);
  if (failed.length) {
    log(`\n${failed.length} failed — most likely selectors that moved in the overhaul:`);
    for (const f of failed) log(`  ${f.file}: ${f.error}`);
    log(`\nFix them in tools/screenshots/shots.mjs (every selector lives there).`);
    return 1;
  }
  return 0;
}

function indexMd({ label, results, ctx }) {
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  const group = (phase, title) => {
    const rows = ok.filter((r) => r.phase === phase);
    if (!rows.length) return '';
    return `### ${title}\n\n| File | State |\n|---|---|\n${
      rows.map((r) => `| \`${r.file.split('/').pop()}\` | ${r.desc}${r.fullPage ? ' *(fullpage)*' : ''} |`).join('\n')
    }\n\n`;
  };

  return `# ${label} — UI screenshot baseline

Generated by \`npm run screenshots\` on ${new Date().toISOString().slice(0, 10)}.

Viewport ${VIEWPORT.width}×${VIEWPORT.height} at DPR ${VIEWPORT.scale}, so PNGs are
${VIEWPORT.width * VIEWPORT.scale}px wide. *(fullpage)* shots are taller than the viewport;
the sticky header appears mid-image in those, which is a capture artifact, not a layout bug.

**Dark theme only** — the app has no light mode (single hardcoded palette in
\`public/style.css\`, no \`prefers-color-scheme\` query, no theme toggle).

## How this was produced

A throwaway scheduler on its own port against a temp \`CS_DATA\`; \`~/.claude-scheduler\` is
never touched. \`claudePath\` is pre-seeded to a fake binary, so the usage meters read fixed
values (5h 37%, weekly 64%, Fable 90%) and **no real \`claude\` can run** — a capture spends
no API quota. Only \`command\`-type jobs are ever executed; the three \`claude\` jobs are
created disabled and never fired. No project is ever activated, which is why the burst
dialog shows its "No activated projects" state.

Run statuses present: ${ctx.statuses?.join(', ') ?? 'n/a'}. \`queued\` is unreachable without
firing a claude job past its concurrency cap.

## Contents

${group('empty', 'Zero states')}${group('main', 'Populated UI')}${group('global', 'Global pause states')}${
  bad.length
    ? `## Failed shots\n\n${bad.map((b) => `- \`${b.file}\` — ${b.error}`).join('\n')}\n`
    : ''
}`;
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write(`\nfailed: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
