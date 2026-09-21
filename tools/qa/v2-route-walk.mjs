#!/usr/bin/env node
// The /v2 route-walk gate (claude-scheduler-btv.13 / E1).
//
//   npm run qa:v2                 # boot an isolated instance, walk, exit non-zero on findings
//   npm run qa:v2 -- --keep       # leave the sandbox up afterwards
//   npm run qa:v2 -- --url URL    # walk an instance that is ALREADY running
//   npm run qa:v2 -- --json FILE  # also write the findings as JSON
//
// Walks every route main.js registers, in BOTH themes, and checks four things
// per route — WCAG AA contrast, light surfaces stranded in dark mode,
// horizontal overflow, and that no route presents an empty #v2-page — plus
// console errors and failed requests across the whole walk.
//
// The rules live in tools/qa/audit-rules.mjs so they can be unit tested and
// mutation-checked without a browser (tests/qa-route-walk.test.js). This file
// is only the driver: boot, drive, collect, report.
//
// TWO DELIBERATE DEPARTURES FROM THE BEAD'S WORDING, both recorded here rather
// than silently taken:
//
//  1. The bead says "against http://127.0.0.1:43400/v2" — the OWNER'S daemon.
//     This boots its OWN instance on 43410 (the allocated QA slot in
//     ~/.claude/ports.json) with a throwaway CS_DATA instead. 43400 is a
//     foreground process the owner runs, it holds their real jobs, and a gate
//     that needs it running is a gate that cannot run in CI or on a clean
//     checkout. `--url` still allows pointing at a live instance deliberately.
//  2. redesign/qa/audit.mjs, which this ports, requires playwright-core through
//     a hard-coded path into another project's node_modules. This uses the
//     repo's own dependency-free CDP client instead.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser, sleep } from '../screenshots/cdp.mjs';
import { Api, buildFixtureRepos, buildFixtureSessions, waitFor } from '../screenshots/seed.mjs';
import {
  V2_ROUTES, resolveHash, isWalkable, evaluateRoute, summarise,
  AA_NORMAL, AA_LARGE, LARGE_PX, LARGE_BOLD_PX, LARGE_BOLD_WEIGHT,
  STRANDED_MIN_ALPHA, STRANDED_MIN_LUM, STRANDED_MIN_W, STRANDED_MIN_H,
} from './audit-rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const PORT = 43410;

const log = (m) => process.stdout.write(m + '\n');

function parseArgs(argv) {
  const opts = { keep: false, url: null, json: null, headful: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') opts.keep = true;
    else if (a === '--headful') opts.headful = true;
    else if (a === '--url') opts.url = argv[++i];
    else if (a === '--json') opts.json = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

// The in-page probe. Ported from redesign/qa/audit.mjs's AUDIT_SRC, with the
// thresholds injected from audit-rules.mjs rather than retyped — so the tested
// rule and the measured rule cannot drift.
function probeSource(thresholds) {
  return `(() => {
  const T = ${JSON.stringify(thresholds)};
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05;
  };
  const parse = (c) => {
    const m = String(c || '').match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const comp = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const effBg = (el) => {
    let n = el; const stack = [];
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
      n = n.parentElement;
    }
    if (!stack.length || stack[stack.length - 1].a < 1) stack.push(parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 });
    let bg = stack.pop();
    while (stack.length) bg = comp(stack.pop(), bg);
    return bg;
  };
  const sel = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cl = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/).slice(0, 2) : [];
    if (cl.length) s += '.' + cl.join('.');
    return s;
  };

  const out = { contrast: [], stranded: [], unnamedIconButtons: [], overflowPx: 0, pageTextLen: 0 };
  const page = document.querySelector('#v2-page');
  out.pageTextLen = ((page && page.innerText) || '').trim().length;
  out.overflowPx = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  const isDark = document.documentElement.dataset.theme === 'dark';

  for (const b of document.querySelectorAll('.iconbtn')) {
    if (!vis(b)) continue;
    if (!(b.getAttribute('aria-label') || '').trim()) out.unnamedIconButtons.push(sel(b));
  }

  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el)) continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    if (el.tagName === 'SVG' || el.closest('svg')) continue;
    const cs = getComputedStyle(el);

    if (isDark) {
      const bgc = parse(cs.backgroundColor);
      const r = el.getBoundingClientRect();
      if (bgc && bgc.a >= T.strandedAlpha && lum(bgc) > T.strandedLum
          && r.width > T.strandedW && r.height > T.strandedH
          && !el.classList.contains('switch') && cs.borderRadius !== '50%') {
        const k = 'st:' + sel(el);
        if (!seen.has(k)) { seen.add(k); out.stranded.push({ sel: sel(el), bg: cs.backgroundColor, w: Math.round(r.width), h: Math.round(r.height) }); }
      }
    }

    let hasText = false;
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) { hasText = true; break; }
    if (!hasText) continue;
    const fg0 = parse(cs.color); if (!fg0) continue;
    const bg = effBg(el);
    const fg = fg0.a < 1 ? comp(fg0, bg) : fg0;
    const rt = ratio(fg, bg);
    const px = parseFloat(cs.fontSize), w = parseInt(cs.fontWeight) || 400;
    const large = px >= T.largePx || (px >= T.largeBoldPx && w >= T.largeBoldWeight);
    const need = large ? T.aaLarge : T.aaNormal;
    if (rt < need) {
      const k = sel(el) + '|' + cs.color + '|' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b);
      if (!seen.has(k)) {
        seen.add(k);
        out.contrast.push({
          sel: sel(el), text: (el.textContent || '').trim().slice(0, 40),
          fg: cs.color, bg: Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b),
          ratio: Math.round(rt * 100) / 100, px, w, need,
        });
      }
    }
  }
  out.contrast.sort((a, b) => a.ratio - b.ratio);
  return out;
})()`;
}

const THRESHOLDS = {
  aaNormal: AA_NORMAL, aaLarge: AA_LARGE,
  largePx: LARGE_PX, largeBoldPx: LARGE_BOLD_PX, largeBoldWeight: LARGE_BOLD_WEIGHT,
  strandedAlpha: STRANDED_MIN_ALPHA, strandedLum: STRANDED_MIN_LUM,
  strandedW: STRANDED_MIN_W, strandedH: STRANDED_MIN_H,
};

async function bootSandbox() {
  const dataDir = await mkdtemp(join(tmpdir(), 'cs-qa-v2-'));
  await mkdir(join(dataDir, 'bin'), { recursive: true });
  // Sandbox-only approval stub. Lives in the throwaway CS_DATA and is deleted
  // with it; it must never be copied into a real install — the real helper's
  // whole point is that it cannot be satisfied without a human.
  const helper = join(dataDir, 'bin', 'LaunchBox');
  await writeFile(helper, [
    '#!/bin/bash',
    'if [ "$1" = "--check" ]; then echo \'{"mode":"check","canEvaluate":true,"errorCode":0}\'; exit 0; fi',
    'echo \'{"mode":"auth","success":true,"errorCode":0}\'',
    'exit 0', '',
  ].join('\n'));
  await chmod(helper, 0o755);

  process.env.CS_DATA = dataDir;
  const { ensureDirs } = await import(`file://${join(REPO, 'lib/paths.js')}`);
  ensureDirs();

  log('· planting session fixtures');
  const sessionsRoot = await buildFixtureSessions(log);

  log('· booting an isolated daemon on ' + PORT);
  const server = spawn(process.execPath, [join(REPO, 'server.js')], {
    cwd: REPO,
    env: { ...process.env, CS_DATA: dataDir, CS_PORT: String(PORT), CS_NO_NOTIFY: '1', CS_SESSIONS_ROOT: sessionsRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  server.on('exit', (c) => { if (c) log(`  server exited ${c}:\n${serverLog.slice(-1200)}`); });

  const baseUrl = `http://127.0.0.1:${PORT}`;
  await waitFor(async () => { try { return (await fetch(`${baseUrl}/`)).ok; } catch { return false; } }, 30_000, 'the server to listen');
  const token = (await readFile(join(dataDir, 'token'), 'utf8')).trim();
  return { server, dataDir, sessionsRoot, baseUrl, token };
}

// Enough real content that a route renders its populated state rather than its
// empty one — an empty page passes contrast trivially, which would make the
// whole walk vacuous.
async function seedForWalk(api) {
  const ids = {};
  try {
    const fixtureRoot = await buildFixtureRepos(log);
    ids.fixtureRoot = fixtureRoot;
    await api.put('/api/settings', { projectRoots: fixtureRoot });
    await api.post('/api/projects/discover', {});
    const { projects } = await api.get('/api/projects');
    if (projects[0]) {
      await api.put(`/api/projects/${projects[0].id}`, { state: 'active' });
      ids.projectId = projects[0].id;
    }
  } catch (err) {
    log(`  ! could not seed projects: ${err.message}`);
  }
  try {
    await api.post('/api/jobs', {
      name: 'QA walk job', type: 'command', cwd: REPO,
      schedule: { type: 'cron', expr: '0 3 * * *' }, params: { command: 'true' },
    });
    const job = (await api.get('/api/jobs')).jobs[0];
    if (job) await api.post(`/api/jobs/${job.id}/run`, {});
  } catch (err) {
    log(`  ! could not seed a job: ${err.message}`);
  }
  try {
    await waitFor(async () => {
      const r = await api.get('/api/sessions?all=1').catch(() => null);
      return !!r?.sessions?.length;
    }, 20_000, 'the sessions index');
    const s = await api.get('/api/sessions?all=1');
    ids.sessionId = s.sessions[0]?.id;
  } catch {
    log('  ! no sessions indexed — the session route will be reported as skipped');
  }
  return ids;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    log('Usage: npm run qa:v2 -- [--url URL] [--json FILE] [--keep] [--headful]');
    return 0;
  }

  let sandbox = null;
  let browser = null;
  const routeFindings = [];
  const consoleErrors = [];
  const requestFailures = [];
  const skipped = [];

  try {
    let baseUrl = opts.url;
    let api = null;
    if (!baseUrl) {
      sandbox = await bootSandbox();
      baseUrl = sandbox.baseUrl;
      api = new Api(baseUrl, sandbox.token);
    } else {
      log(`· walking an instance that is already running: ${baseUrl}`);
      log('  (no seeding — the walk reports whatever that instance has)');
    }

    const ids = api ? await seedForWalk(api) : {};
    browser = await launchBrowser({ width: 1512, height: 950, scale: 2, headful: opts.headful });
    const { page, conn } = browser;

    await conn.send('Runtime.enable');
    await conn.send('Log.enable');
    await conn.send('Network.enable');
    conn.onEvent((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map((x) => x.value ?? x.description ?? '').join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? 'uncaught exception');
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        // The `url` is appended because Chrome's own text for a failed
        // subresource is the generic "Failed to load resource: ... 404" with
        // no indication of WHAT failed. Without this the allow-list cannot
        // tell the known favicon 404 from a missing stylesheet, and the honest
        // options are both bad: broaden the pattern until it hides real
        // failures, or fail the walk on every run.
        consoleErrors.push([msg.params.entry.text, msg.params.entry.url].filter(Boolean).join(' '));
      }
      if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
        requestFailures.push(`${msg.params.response.status} ${msg.params.response.url}`);
      }
    });

    if (sandbox) {
      await page.goto(`${baseUrl}/v2/#token=${sandbox.token}`);
      await sleep(900);
    } else {
      await page.goto(`${baseUrl}/v2/`);
      await sleep(900);
    }

    const probe = probeSource(THRESHOLDS);
    for (const theme of ['dark', 'light']) {
      log(`\n· theme: ${theme}`);
      await page.eval((t) => { document.documentElement.setAttribute('data-theme', t); }, theme);
      for (const route of V2_ROUTES) {
        if (!isWalkable(route, ids)) {
          skipped.push(`${route.name} (${theme}) — no id available to deep-link with`);
          log(`  – ${route.name}: skipped (no id)`);
          continue;
        }
        await page.goto(`${baseUrl}/v2/${resolveHash(route.hash, ids)}`);
        // Long enough for a blocking `bd ready` on the project detail page.
        await sleep(route.name === 'project' ? 4500 : 1800);
        const measured = await page.eval(new Function(`return ${probe}`));
        const found = evaluateRoute({ route: route.name, theme, page: measured });
        routeFindings.push(...found);
        log(`  ${found.length ? '✗' : '✓'} ${route.name}${found.length ? ` — ${found.length} finding${found.length === 1 ? '' : 's'}` : ''}`);
        for (const f of found) log(`      ${f.kind}: ${f.detail}`);
      }
    }

    const verdict = summarise({ routeFindings, consoleErrors, requestFailures });
    log('');
    if (skipped.length) {
      // Reported loudly: a route the walk never visited is a route with no
      // gate, and silence about it is the "can mean didn't run" failure.
      log(`SKIPPED ${skipped.length} route-theme pair(s) — these were NOT checked:`);
      for (const s of skipped) log(`  – ${s}`);
      log('');
    }
    if (verdict.ok) {
      log(`route walk clean — ${V2_ROUTES.length} routes × 2 themes, ${skipped.length} skipped`);
    } else {
      log(`route walk FAILED — ${verdict.findings.length} finding(s): ${JSON.stringify(verdict.byKind)}`);
      for (const f of verdict.findings) log(`  [${f.route}/${f.theme}] ${f.kind}: ${f.detail}`);
    }
    if (opts.json) {
      await writeFile(opts.json, JSON.stringify({ ...verdict, skipped }, null, 2));
      log(`· findings written to ${opts.json}`);
    }
    return verdict.ok ? 0 : 1;
  } finally {
    if (!opts.keep) {
      try { await browser?.close(); } catch { /* already gone */ }
      if (sandbox) {
        try { sandbox.server.kill('SIGTERM'); } catch { /* already gone */ }
        await sleep(600);
        try { sandbox.server.kill('SIGKILL'); } catch { /* already gone */ }
        await rm(sandbox.sessionsRoot, { recursive: true, force: true }).catch(() => {});
        await rm(sandbox.dataDir, { recursive: true, force: true }).catch(() => {});
        log('· sandbox torn down');
      }
    } else {
      log('· --keep: sandbox left running');
    }
  }
}

process.exitCode = await main();
