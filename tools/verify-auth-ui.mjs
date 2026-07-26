// Drives the real UI in Chrome to verify the auth frontend.
//
// Deliberately runs with NO approval helper compiled, so every gated action
// answers 503 approval_unavailable instead of raising a Touch ID dialog. That
// exercises the entire state-preservation contract — waiting state, shared copy,
// form keeps its values — without spending one of the user's batched prompts.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser, sleep } from '/Users/vignesh-5036/mydevelopment/claude-scheduler/tools/screenshots/cdp.mjs';

const REPO = '/Users/vignesh-5036/mydevelopment/claude-scheduler';
const PORT = 18973;
const DATA = mkdtempSync(join(tmpdir(), 'cs-uiverify-'));
const FAKE = mkdtempSync(join(tmpdir(), 'cs-fakebin-'));
let pass = 0; let fail = 0;
const ok = (m) => { console.log(`   ✓ ${m}`); pass += 1; };
const bad = (m) => { console.log(`   ✗ ${m}`); fail += 1; };
const eq = (label, actual, expected) => (String(actual) === String(expected)
  ? ok(`${label} (${actual})`) : bad(`${label} — expected ${expected}, got ${actual}`));

writeFileSync(join(FAKE, 'claude'), '#!/bin/bash\necho \'{"type":"result","subtype":"success"}\'\n');
chmodSync(join(FAKE, 'claude'), 0o755);
mkdirSync(join(DATA, 'bin'), { recursive: true });   // deliberately empty: no helper

const env = { ...process.env, CS_DATA: DATA, CS_PORT: String(PORT), CS_NO_NOTIFY: '1' };
const srv = spawn('node', [join(REPO, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = '';
srv.stdout.on('data', (d) => { srvLog += d; });
srv.stderr.on('data', (d) => { srvLog += d; });

let browser;
try {
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { /* not up */ }
    await sleep(250);
  }
  ok('daemon up with no approval helper (gated actions will 503, not prompt)');

  const token = (await import('node:child_process')).execFileSync(
    'node', [join(REPO, 'bin/claude-scheduler.mjs'), 'token'], { env },
  ).toString().trim();

  browser = await launchBrowser({ width: 1400, height: 900, scale: 1 });
  const page = browser.page;
  const errors = [];
  browser.conn.onEvent((m) => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.text ?? 'exception');
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      errors.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });
  await browser.conn.send('Runtime.enable');

  // ---- 1. no token at all
  console.log('\n── 1. loading with no token');
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await sleep(1200);
  eq('banner is visible', await page.eval(() => !document.querySelector('#auth-banner').hidden), 'true');
  const bannerText = await page.eval(() => document.querySelector('#auth-banner').textContent);
  ok(`banner says: "${bannerText.slice(0, 72)}…"`);
  eq('header still rendered (not a blank page)',
    await page.eval(() => !!document.querySelector('.tabs')), 'true');

  // ---- 2. with the token
  console.log('\n── 2. loading with the token in the fragment');
  await page.goto(`http://127.0.0.1:${PORT}/#token=${token}`);
  await sleep(1800);
  eq('banner hidden', await page.eval(() => document.querySelector('#auth-banner').hidden), 'true');
  eq('token stripped from the URL', await page.eval(() => location.hash), '');
  eq('token stored', await page.eval(() => (localStorage.getItem('cs.token') || '').length), 64);
  eq('jobs tab visible', await page.eval(() => !document.querySelector('#tab-jobs').hidden), 'true');

  // ---- 3. the state-preservation contract
  console.log('\n── 3. a refused approval must not cost the user their work');
  await page.eval(() => document.querySelector('#new-job').click());
  await sleep(700);
  eq('job dialog open', await page.eval(() => document.querySelector('#job-dialog').open), 'true');

  const typed = 'my carefully typed job name';
  // Fill every required field that is still empty. Native form validation blocks
  // submission silently — no submit event, no handler, no error box — which is
  // exactly how an earlier version of this script "failed" while the product was
  // behaving correctly.
  const validity = await page.eval((name) => {
    const form = document.querySelector('#job-form');
    document.querySelector('#f-name').value = name;
    const cwd = document.querySelector('#f-cwd');
    if (cwd) cwd.value = '/tmp';
    for (const el of form.querySelectorAll('[required]')) {
      if (!el.value) el.value = el.tagName === 'TEXTAREA' ? 'do the thing' : 'echo hello';
    }
    return { valid: form.checkValidity(), invalid: [...form.querySelectorAll(':invalid')].map((e) => e.id || e.name) };
  }, typed);
  if (validity.valid) ok('form passes native validation, so submit will actually fire');
  else bad(`form still invalid: ${validity.invalid.join(', ')}`);

  await page.eval(() => document.querySelector('#dialog-save').click());
  await sleep(2500);

  eq('dialog STILL open after the refusal', await page.eval(() => document.querySelector('#job-dialog').open), 'true');
  eq('the typed name survived', await page.eval(() => document.querySelector('#f-name').value), typed);
  const errText = await page.eval(() => {
    const b = document.querySelector('#form-errors');
    return b && !b.hidden ? b.textContent : '';
  });
  if (/helper is unavailable|refused/i.test(errText)) ok(`the reason is shown: "${errText.slice(0, 80)}"`);
  else {
    const diag = await page.eval(async () => {
      const b = document.querySelector('#form-errors');
      const direct = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('cs.token')}` },
        body: JSON.stringify({ name: 'probe', type: 'command', command: 'echo x', cwd: '/tmp', schedules: [{ type: 'cron', expr: '0 3 * * *' }] }),
      });
      return { hidden: b?.hidden, text: b?.textContent, status: direct.status, body: (await direct.text()).slice(0, 200) };
    });
    bad(`no reason shown — #form-errors hidden=${diag.hidden} text="${diag.text}"; direct POST gave ${diag.status} ${diag.body}`);
  }
  eq('submit button re-enabled for a retry',
    await page.eval(() => document.querySelector('#dialog-save').disabled), 'false');
  eq('submit label restored (not stuck on "waiting…")',
    await page.eval(() => /waiting/i.test(document.querySelector('#dialog-save').textContent)), 'false');
  eq('no job was created',
    await page.eval(async () => {
      const r = await fetch('/api/jobs', { headers: { Authorization: `Bearer ${localStorage.getItem('cs.token')}` } });
      return (await r.json()).jobs.length;
    }), 0);

  // ---- 4. an invalid token mid-session
  console.log('\n── 4. an invalid key mid-session raises the banner, keeps the page');
  await page.eval(() => { localStorage.setItem('cs.token', 'f'.repeat(64)); });
  await page.eval(() => document.querySelector('#job-dialog').close());
  await sleep(3200);
  eq('banner raised', await page.eval(() => !document.querySelector('#auth-banner').hidden), 'true');
  eq('page not wiped', await page.eval(() => !!document.querySelector('.tabs')), 'true');

  console.log('\n── console');
  const real = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  if (real.length === 0) ok(`no JS errors (${errors.length} network-level 401/404 entries ignored)`);
  else bad(`JS errors: ${real.slice(0, 3).join(' | ')}`);
} catch (err) {
  bad(`threw: ${err.message}`);
  console.log(srvLog.slice(-800));
} finally {
  await browser?.close?.();
  srv.kill('SIGTERM');
  await sleep(400);
  rmSync(DATA, { recursive: true, force: true });
  rmSync(FAKE, { recursive: true, force: true });
  console.log(`\n──────── ${pass} passed, ${fail} failed ────────`);
  process.exit(fail > 0 ? 1 : 0);
}
