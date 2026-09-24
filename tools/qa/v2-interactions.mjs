#!/usr/bin/env node
// The /v2 interaction gates (claude-scheduler-btv.14 / E2).
//
//   npm run qa:v2:interactions
//   npm run qa:v2:interactions -- --keep --headful
//
// E1 (tools/qa/v2-route-walk.mjs) walks every route and measures what is
// PAINTED. This measures what HAPPENS: dialogs, filters, the keyboard walk,
// focus tooltips, and the daemon-down disabling contract. Between them they are
// the two halves of "driven once in a real browser".
//
// Rules live in tools/qa/interaction-rules.mjs so they can be unit tested and
// mutation-checked (tests/qa-interactions.test.js). This file boots, drives and
// collects — it decides nothing.
//
// Isolated by construction, same as E1: its own daemon on 43410 (the allocated
// QA slot) with a throwaway CS_DATA and a sandbox-only approval stub. The
// owner's 43400 is never touched.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser, sleep } from '../screenshots/cdp.mjs';
import { Api, buildFixtureRepos, buildFixtureSessions, waitFor } from '../screenshots/seed.mjs';
import {
  V2_DIALOGS, DIALOG_CONTRACT, evaluateDialog, evaluateFilter, evaluateKeyboardWalk,
  evaluateFocusTooltip, evaluateDegraded, evaluateRecovery, evaluateAppbarPollFocus, summarise,
} from './interaction-rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const PORT = 43410;
const log = (m) => process.stdout.write(m + '\n');


// Chrome applies `:focus-visible` to a KEYBOARD focus, not to a programmatic
// `el.focus()`. The first version of the keyboard and tooltip gates used
// `el.focus()` and therefore measured `:focus` — reporting nine controls as
// having no focus indicator when the app styles `:focus-visible` correctly,
// and declining to assert any tooltip at all. Both were my measurement, not
// the product. Real key events through CDP are the only honest way to ask.
async function pressTab(conn, { shift = false } = {}) {
  const common = { windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, key: 'Tab', code: 'Tab', modifiers: shift ? 8 : 0 };
  await conn.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
  await conn.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}

function parseArgs(argv) {
  const o = { keep: false, headful: false };
  for (const a of argv) {
    if (a === '--keep') o.keep = true;
    else if (a === '--headful') o.headful = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

async function bootSandbox() {
  const dataDir = await mkdtemp(join(tmpdir(), 'cs-qa-int-'));
  await mkdir(join(dataDir, 'bin'), { recursive: true });
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
  const sessionsRoot = await buildFixtureSessions(log);

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

// Named fixtures, never list[0]: a gate that grabs whatever exists silently
// stops asserting once the data changes.
const FIXTURE_JOBS = [
  { name: 'QA alpha rotate logs', params: { command: 'true' } },
  { name: 'QA beta drain queue', params: { command: 'true' } },
  { name: 'QA gamma backup', params: { command: 'true' } },
];

async function seed(api) {
  const ids = {};
  for (const j of FIXTURE_JOBS) {
    await api.post('/api/jobs', {
      name: j.name, type: 'command', cwd: REPO,
      schedule: { type: 'cron', expr: '0 3 * * *' }, params: j.params,
    }).catch((e) => log(`  ! could not create ${j.name}: ${e.message}`));
  }
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
  return ids;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { log('Usage: npm run qa:v2:interactions -- [--keep] [--headful]'); return 0; }

  let sandbox = null;
  let browser = null;
  const findings = [];

  try {
    sandbox = await bootSandbox();
    const { baseUrl, token } = sandbox;
    const api = new Api(baseUrl, token);
    log('· seeding named fixtures');
    await seed(api);

    browser = await launchBrowser({ width: 1512, height: 950, scale: 2, headful: opts.headful });
    const { page, conn } = browser;
    await conn.send('Network.enable');

    await page.goto(`${baseUrl}/v2/#token=${token}`);
    await sleep(900);

    // ------------------------------------------------------- dialogs
    log('\n· dialogs');
    for (const d of V2_DIALOGS) {
      await page.goto(`${baseUrl}/v2/${d.route}`);
      await sleep(1600);
      const results = {};

      const open = async () => page.eval((pattern) => {
        const b = [...document.querySelectorAll('button, a')].find((x) => new RegExp(pattern).test(x.textContent));
        if (!b || b.disabled) return false;
        b.click();
        return true;
      }, d.openerText.source);

      results.opens = await open();
      await sleep(1200);
      if (results.opens !== true) {
        // Explicitly recorded as a failure of every downstream point rather
        // than skipped — an unopenable dialog must not read as five passes.
        for (const k of DIALOG_CONTRACT) if (!(k in results)) results[k] = 'the dialog never opened';
        findings.push(...evaluateDialog({ name: d.name, results }));
        log(`  ✗ ${d.name}: never opened`);
        continue;
      }

      Object.assign(results, await page.eval(() => {
        const m = document.querySelector('.modalwrap .modal');
        if (!m) return { role: 'no .modal in the DOM after opening' };
        const label = (m.getAttribute('aria-label') || '').trim();
        return {
          role: (m.getAttribute('role') === 'dialog' && m.getAttribute('aria-modal') === 'true' && label.length > 2)
            ? true
            : `role=${m.getAttribute('role')} aria-modal=${m.getAttribute('aria-modal')} aria-label="${label}"`,
          focusInside: document.activeElement && m.contains(document.activeElement)
            ? true
            : `focus is on ${document.activeElement?.tagName ?? 'nothing'} outside the dialog`,
        };
      }));

      // Escape
      await page.eval(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await sleep(400);
      results.escapeCloses = await page.eval(() => !document.querySelector('.modalwrap')) || 'Escape left the dialog open';

      // Backdrop click
      await open(); await sleep(1200);
      await page.eval(() => {
        const w = document.querySelector('.modalwrap');
        w?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await sleep(400);
      results.backdropCloses = await page.eval(() => !document.querySelector('.modalwrap')) || 'a backdrop click left the dialog open';

      // The close icon button
      await open(); await sleep(1200);
      await page.eval(() => document.querySelector('.modalwrap .modal__head .iconbtn')?.click());
      await sleep(400);
      results.closeButtonCloses = await page.eval(() => !document.querySelector('.modalwrap')) || 'the close button left the dialog open';
      await page.eval(() => document.querySelector('.modalwrap')?.remove());

      const found = evaluateDialog({ name: d.name, results });
      findings.push(...found);
      log(`  ${found.length ? '✗' : '✓'} ${d.name}${found.length ? ` — ${found.length} finding(s)` : ''}`);
      for (const f of found) log(`      ${f.detail}`);
    }

    // ------------------------------------------------------- filters
    log('\n· live filters');
    for (const [route, inputId, query, rowSel] of [
      ['#jobs', 'jobs-search', 'alpha', '.row.jobrow:not(.row--head)'],
      ['#sessions', 'sessions-search', 'basket', '.card[data-session-id]'],
    ]) {
      await page.goto(`${baseUrl}/v2/${route}`);
      await sleep(1800);
      const measured = await page.eval(async (id, q, sel) => {
        const input = document.getElementById(id);
        if (!input) return { missing: id };
        const before = document.querySelectorAll(sel).length;
        input.focus();
        // Typed character by character, because the defect this catches is a
        // re-render between keystrokes stealing focus mid-word.
        for (const ch of q) {
          input.value += ch;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 40));
        }
        await new Promise((r) => setTimeout(r, 200));
        return {
          before,
          after: document.querySelectorAll(sel).length,
          focusedId: document.activeElement?.id ?? null,
          caret: document.activeElement?.selectionStart ?? null,
          value: input.value,
        };
      }, inputId, query, rowSel);

      if (measured.missing) {
        findings.push({ kind: 'filter', surface: route, detail: `#${measured.missing} is not on the page — the filter could not be exercised` });
        log(`  ✗ ${route}: no filter input`);
        continue;
      }
      const found = evaluateFilter({
        surface: route, before: measured.before, after: measured.after, query,
        focusedId: measured.focusedId, expectedId: inputId,
        caret: measured.caret, expectedCaret: query.length,
      });
      findings.push(...found);
      log(`  ${found.length ? '✗' : '✓'} ${route} "${query}" — ${measured.before} → ${measured.after} rows, focus ${measured.focusedId}, caret ${measured.caret}`);
      for (const f of found) log(`      ${f.detail}`);
    }

    // -------------------------------------------------- keyboard walk
    log('\n· keyboard walk + focus indicators');
    await page.goto(`${baseUrl}/v2/#jobs`);
    await sleep(1800);
    // Snapshot every focusable's RESTING style first, then Tab through for
    // real and snapshot each one again while it actually holds keyboard focus.
    await page.eval(() => {
      window.__qaKey = (el) => {
        let s = el.tagName.toLowerCase();
        if (el.id) s += '#' + el.id;
        const cl = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cl.length) s += '.' + cl.join('.');
        return s;
      };
      window.__qaSnap = (el) => {
        const cs = getComputedStyle(el);
        return { outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle, boxShadow: cs.boxShadow, borderColor: cs.borderTopColor };
      };
      window.__qaResting = new Map();
      window.__qaAncResting = new Map();
      for (const el of document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')) {
        const k = window.__qaKey(el);
        window.__qaResting.set(k, window.__qaSnap(el));
        const anc = el.closest('.search, label, .segs');
        if (anc && anc !== el) window.__qaAncResting.set(k, window.__qaSnap(anc));
      }
      document.body.focus();
    });

    const stopsRaw = [];
    const TAB_STEPS = 40;
    for (let i = 0; i < TAB_STEPS; i++) {
      await pressTab(conn);
      await sleep(35);
      const stop = await page.eval(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return null;
        const key = window.__qaKey(el);
        // The wrapper is captured as well: a ring can legitimately live on an
        // ancestor via :focus-within (the .search box does exactly this).
        const anc = el.closest('.search, label, .segs') ;
        return {
          key,
          focusVisible: el.matches(':focus-visible'),
          resting: window.__qaResting.get(key) ?? null,
          focused: window.__qaSnap(el),
          ancestorResting: anc ? window.__qaAncResting.get(key) ?? null : null,
          ancestorFocused: anc && anc !== el ? window.__qaSnap(anc) : null,
        };
      });
      if (stop) stopsRaw.push(stop);
    }
    const { hasVisibleFocusIndicator } = await import('./interaction-rules.mjs');
    const stops = stopsRaw.map((s) => ({ ...s, visibleIndicator: hasVisibleFocusIndicator(s) }));
    const kbFindings = evaluateKeyboardWalk({ stops });
    findings.push(...kbFindings);
    log(`  ${kbFindings.length ? '✗' : '✓'} ${stops.length} focusable controls walked`);
    for (const f of kbFindings) log(`      ${f.detail}`);

    // ------------------------------------------------- focus tooltips
    log('\n· focus tooltips (REVIEW #5)');
    // Tab to each [data-tip] control for real, for the same reason as the
    // keyboard walk: :focus-visible is what reveals the tooltip, and a
    // programmatic focus() never sets it.
    await page.eval(() => {
      window.__qaTips = [...document.querySelectorAll('[data-tip]')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1 && !el.disabled;
      }).slice(0, 8);
      window.__qaTipSel = (el) => el.tagName.toLowerCase()
        + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
      // Keyed by selector over EVERY [data-tip] on the page, not just the
      // first eight: the capped pre-scan left controls further down the tab
      // order with no resting value, which the rules then (correctly) reported
      // as "never measured" — a harness hole wearing a finding's clothes.
      window.__qaTipResting = new Map();
      for (const el of document.querySelectorAll('[data-tip]')) {
        const k = window.__qaTipSel(el);
        if (!window.__qaTipResting.has(k)) {
          window.__qaTipResting.set(k, {
            restingOpacity: getComputedStyle(el, '::after').opacity,
            content: getComputedStyle(el, '::after').content,
          });
        }
      }
      document.body.focus();
    });
    const tips = [];
    for (let i = 0; i < 60 && tips.length < 4; i++) {
      await pressTab(conn);
      // launchbox.css animates the tooltip with `transition: opacity .1s ease
      // .05s` — 150ms in total. The first version read the opacity 35ms after
      // Tab and reported every control as never revealing its tooltip. The
      // product was right; the stopwatch was wrong.
      await sleep(260);
      const t = await page.eval(() => {
        const el = document.activeElement;
        if (!el || !el.hasAttribute?.('data-tip')) return null;
        if (!el.matches(':focus-visible')) return null;
        const sel = window.__qaTipSel(el);
        const resting = window.__qaTipResting.get(sel);
        return {
          selector: sel,
          restingOpacity: resting?.restingOpacity ?? null,
          content: getComputedStyle(el, '::after').content,
          focusedOpacity: getComputedStyle(el, '::after').opacity,
          matchesFocusVisible: true,
        };
      });
      if (t && !tips.some((x) => x.selector === t.selector)) tips.push(t);
    }
    if (!tips.length) {
      // A silent skip reads exactly like a pass: if tabbing never landed on a
      // [data-tip] control under :focus-visible, this gate measured NOTHING
      // and must say so rather than printing a clean line.
      findings.push({ kind: 'tooltip', surface: '#jobs', detail: 'tabbing never reached a [data-tip] control under :focus-visible — the tooltip reveal was not measured at all' });
    }
    for (const t of tips) {
      // Only assert the reveal where the browser actually applied
      // :focus-visible — otherwise the measurement is of the wrong state, and
      // a false red here would train everyone to ignore this gate.
      const found = evaluateFocusTooltip({ surface: '#jobs', ...t });
      findings.push(...found);
      for (const f of found) log(`      ${f.detail}`);
    }
    log(`  ${tips.length} tooltip control(s) measured`);

    // ------------------------------------------- appbar poll vs focus
    log('\n· appbar poll vs keyboard focus (btv.17)');
    // chrome.js polls every 15s and used to wipe the whole appbar each time,
    // so a keyboard user resting on the keep-awake chip lost focus every 15s.
    // Tab to the chip for real, mark the node, then wait out two REAL polls —
    // counted from the page's own /api/awake fetches, not from a stopwatch —
    // and ask whether it is still the same node and still focused.
    await page.eval(() => { document.body.focus(); window.__qaAwake = null; });
    let startedOnChip = false;
    for (let i = 0; i < 60 && !startedOnChip; i++) {
      await pressTab(conn);
      startedOnChip = await page.eval(() => {
        const a = document.activeElement;
        if (a?.id !== 'v2-awake') return false;
        window.__qaAwake = a;
        window.__qaAwakePolls0 = performance.getEntriesByType('resource').filter((e) => /\/api\/awake(\?|$)/.test(e.name)).length;
        return true;
      });
    }
    let pollMeasure = { startedOnChip, pollsSeen: 0, sameNode: false, focusStillOnChip: false };
    if (startedOnChip) {
      // Two cycles of the 15s poll, plus slack for the fetch to land.
      await sleep(32_000);
      pollMeasure = await page.eval(() => ({
        startedOnChip: true,
        pollsSeen: performance.getEntriesByType('resource').filter((e) => /\/api\/awake(\?|$)/.test(e.name)).length - window.__qaAwakePolls0,
        sameNode: document.getElementById('v2-awake') === window.__qaAwake,
        focusStillOnChip: document.activeElement === window.__qaAwake,
      }));
    }
    const pollFound = evaluateAppbarPollFocus(pollMeasure);
    findings.push(...pollFound);
    log(`  ${pollFound.length ? '✗' : '✓'} ${pollMeasure.pollsSeen} poll(s) seen; same node ${pollMeasure.sameNode}; focus kept ${pollMeasure.focusStillOnChip}`);
    for (const f of pollFound) log(`      ${f.detail}`);

    // ------------------------------------------ daemon-down disabling
    log('\n· daemon-down disabling (REVIEW #2)');
    await conn.send('Network.setBlockedURLs', { urls: ['*/api/*'] });
    // A poll has to fail for api.js to flip the global state; jobs polls every 4s.
    await sleep(6000);
    const downControls = await page.eval(() => [...document.querySelectorAll('[data-mutating]')].map((el) => ({
      key: el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '') + (el.textContent ? `["${el.textContent.trim().slice(0, 18)}"]` : ''),
      disabled: !!el.disabled,
      tip: el.getAttribute('data-tip'),
    })));
    const degFindings = evaluateDegraded({ controls: downControls });
    findings.push(...degFindings);
    log(`  ${degFindings.length ? '✗' : '✓'} ${downControls.length} data-mutating control(s) with the daemon blocked`);
    for (const f of degFindings) log(`      ${f.detail}`);

    await conn.send('Network.setBlockedURLs', { urls: [] });
    await sleep(6000);
    const backControls = await page.eval(() => [...document.querySelectorAll('[data-mutating]')].map((el) => ({
      key: el.tagName.toLowerCase() + (el.textContent ? `["${el.textContent.trim().slice(0, 18)}"]` : ''),
      disabled: !!el.disabled,
      // A control disabled for its OWN reason (a running burst, a sole
      // schedule) is legitimately still dead after recovery — the sweep must
      // not revive those, which is the compound-disable rule D2 hit.
      businessDisabled: !el.hasAttribute('data-mutating') || /already running|at least one/i.test(el.getAttribute('data-tip') ?? ''),
    })));
    const recFindings = evaluateRecovery({ controls: backControls });
    findings.push(...recFindings);
    log(`  ${recFindings.length ? '✗' : '✓'} ${backControls.length} control(s) after recovery`);
    for (const f of recFindings) log(`      ${f.detail}`);

    const verdict = summarise(findings);
    log('');
    if (verdict.ok) log('interaction gates clean');
    else {
      log(`interaction gates FAILED — ${verdict.findings.length} finding(s): ${JSON.stringify(verdict.byKind)}`);
      for (const f of verdict.findings) log(`  [${f.kind}/${f.surface}] ${f.detail}`);
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
    } else log('· --keep: sandbox left running');
  }
}

process.exitCode = await main();
