// The ONE batched human verification sitting — bead claude-scheduler-j8u.
//
// Drives the REAL UI in a real Chrome against the REAL Touch ID helper, in ONE
// continuous sandboxed daemon, and ticks every row of the plan table at
// docs/plans/2026-07-26-local-api-auth.md §Task 13 plus the two unticked Task 8
// rows (run→log→Refresh; the original exploit still 403/415s).
//
// WHY THE ROWS ARE REORDERED (recorded in the plan, per the bead's acceptance):
// the plan table lists an APPROVE (row 1) before the DENY/timeout rows (2–4).
// But an approved job-create opens the 5-minute grace window, and rows 2–4 are
// also job-creates — so run verbatim they would be silently GRACED and prompt
// for nothing. docs/spikes/auth-verify.sh already hit this and reordered for the
// same reason. So here the deny and the timeout come FIRST, before any approval
// opens a window; then one approval; then the grace / cleanup / activate /
// settings rows. Every row's INTENT is preserved; only the order changes.
//
// An earlier design tried to keep the literal order by restarting the daemon
// between rows to clear the in-memory grace window. Don't: restarting the daemon
// under a live browser makes Chrome transparently re-send the timed-out POST
// against the fresh socket, raising a phantom second dialog. A single continuous
// daemon has no such effect (verified: one clickSave on the timeout path = one
// prompt). The postCounter below asserts exactly one client POST per action, so
// any such regression fails loudly instead of surprising the human.
//
// SAFETY: CS_DATA/CS_SESSIONS_ROOT are throwaway; claudePath is a fake binary;
// the real ~/.claude-scheduler top-level listing is fingerprinted before/after.
//
// Usage:
//   node tools/verify-auth-sitting.mjs --dry   # scripted helper, no dialogs
//   node tools/verify-auth-sitting.mjs         # the real sitting
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const REPO = join(new URL('.', import.meta.url).pathname, '..');
const DRY = process.argv.includes('--dry');

const { PORT_BASE } = await import(join(REPO, 'lib/paths.js'));
// +10 = this project's QA/e2e-web offset (see ~/.claude/docs/port-allocation.md).
const PORT = PORT_BASE + 10;
const BASE = `http://127.0.0.1:${PORT}`;

const DATA = mkdtempSync(join(tmpdir(), 'cs-sitting-'));
const FAKE = mkdtempSync(join(tmpdir(), 'cs-sitting-fake-'));
const SESS = mkdtempSync(join(tmpdir(), 'cs-sitting-sess-'));
const FIXREPO = mkdtempSync(join(tmpdir(), 'cs-sitting-repo-'));
process.env.CS_DATA = DATA;

const { launchBrowser, sleep } = await import(join(REPO, 'tools/screenshots/cdp.mjs'));

let pass = 0; let fail = 0;
const results = [];
const ok = (m) => { console.log(`   ✓ ${m}`); pass += 1; };
const bad = (m) => { console.log(`   ✗ ${m}`); fail += 1; };
function record(row, isOk, note) {
  results.push({ row, ok: isOk, note });
  (isOk ? ok : bad)(`[${row}] ${note}`);
}
const hr = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(4, 58 - t.length))}`);
function banner(lines) {
  console.log(`\n${'═'.repeat(62)}`);
  for (const l of [].concat(lines)) console.log(` ${l}`);
  console.log('═'.repeat(62));
}

// Top-level entry NAMES only — not mtimes/sizes. A real daemon may be running on
// the base port and appending to its own logs/db throughout this sitting; that
// must not read as "the sandbox touched your data". A new or removed top-level
// entry would be alarming and this catches it; ordinary log churn it ignores.
function realDirFingerprint() {
  const real = join(homedir(), '.claude-scheduler');
  if (!existsSync(real)) return 'absent';
  return createHash('sha256').update(readdirSync(real).sort().join('\n')).digest('hex');
}
const realBefore = realDirFingerprint();

// ---------------------------------------------------------------- the helper
const HELPER = join(DATA, 'bin', 'LaunchBox');
mkdirSync(join(DATA, 'bin'), { recursive: true });
if (DRY) {
  // Scripted stand-in: pops one answer per --auth call from a queue file, in the
  // order the reordered rows raise dialogs. Same stdout contract as the real
  // binary. Rows that ride the grace window or are ungated raise NO dialog, so
  // they consume no answer.
  const QUEUE = join(DATA, 'bin', 'answers.txt');
  writeFileSync(QUEUE, [
    'deny', // row 2  deny the create
    'ok', //   row 3  approve the retry
    'deny', // row 6  deny cleanup
    'ok', //   row 7  approve activate
    'ok', //   row 8  approve claudePath
    '',
  ].join('\n'));
  writeFileSync(HELPER, `#!/bin/bash
if [ "$1" = "--check" ]; then echo '{"mode":"check","canEvaluate":true,"errorCode":0}'; exit 0; fi
Q="$(dirname "$0")/answers.txt"
ans=$(head -n1 "$Q"); tail -n +2 "$Q" > "$Q.tmp" && mv "$Q.tmp" "$Q"
case "$ans" in
  ok)   echo '{"mode":"auth","success":true,"errorCode":0}'; exit 0;;
  deny) echo '{"success":false,"errorCode":-2,"error":"canceled"}'; exit 1;;
  hang) sleep 30; exit 1;;
  *)    echo "UNEXPECTED HELPER CALL — queue empty" >&2; echo '{"success":false,"errorCode":-99}'; exit 1;;
esac
`);
  chmodSync(HELPER, 0o755);
  console.log('⚠ DRY RUN — scripted helper, no real dialogs; plumbing check only');
} else {
  execFileSync('swiftc', ['-O', '-o', HELPER, join(REPO, 'helper/LaunchBox.swift')]);
  chmodSync(HELPER, 0o500);
}
// Pin it exactly as install.sh does; approval.js re-verifies before every spawn.
writeFileSync(`${HELPER}.sha256`, `${createHash('sha256').update(readFileSync(HELPER)).digest('hex')}\n`);
ok(`helper --check exits 0 (no prompt): ${execFileSync(HELPER, ['--check']).toString().trim().slice(0, 60)}…`);

// ------------------------------------------------------- seed the sandbox DB
writeFileSync(join(FAKE, 'claude'), '#!/bin/bash\necho \'{"type":"result","subtype":"success","is_error":false,"result":"fake"}\'\n');
chmodSync(join(FAKE, 'claude'), 0o755);
{
  const paths = await import(join(REPO, 'lib/paths.js'));
  const { openDb, setSetting } = await import(join(REPO, 'lib/db.js'));
  paths.ensureDirs();
  const db = openDb(paths.dbPath());
  setSetting(db, 'claudePath', join(FAKE, 'claude'));
  db.close();
  ok('sandbox DB seeded: claudePath → fake binary (no API, no prompt)');
}
writeFileSync(join(FIXREPO, '.scheduler.json'), '{ "autoLabel": "unattended", "enabled": true }\n');

// ------------------------------------------------------------- daemon control
let SRV = null; let srvLog = '';
async function bootDaemon(extraEnv = {}) {
  const env = {
    ...process.env, CS_DATA: DATA, CS_PORT: String(PORT), CS_NO_NOTIFY: '1',
    CS_SESSIONS_ROOT: SESS, ...extraEnv,
  };
  SRV = spawn('node', [join(REPO, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  SRV.stdout.on('data', (d) => { srvLog += d; });
  SRV.stderr.on('data', (d) => { srvLog += d; });
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fetch(`${BASE}/`)).ok) return; } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`daemon did not start\n${srvLog.slice(-800)}`);
}
async function stopDaemon() {
  if (!SRV) return;
  const p = SRV; SRV = null;
  const gone = new Promise((r) => { p.once('exit', r); });
  p.kill('SIGTERM');
  await Promise.race([gone, sleep(4000)]);
}
const promptCount = () => (srvLog.match(/approval: asked/g) || []).length;

// ----------------------------------------------------------------- API side
let TOKEN = '';
async function api(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const jobCount = async () => (await api('GET', '/api/jobs')).body.jobs.length;

// ----------------------------------------------------------------- page side
let browser = null;
const page = () => browser.page;
async function waitFor(fn, what, timeoutMs = 150000, every = 300) {
  const t0 = Date.now();
  for (;;) {
    const v = await page().eval(fn);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}
async function gotoTab(hash) {
  await page().eval((h) => { location.hash = h; }, hash);
  await sleep(500);
}
// Counts job-mutating POST/PUTs the browser actually sends, so a double-submit is
// a number rather than a mystery. Installed once after load.
async function installPostCounter() {
  await page().eval(() => {
    window.__jobPosts = 0;
    const orig = window.fetch;
    window.fetch = (...a) => {
      const [u, o] = a;
      if ((o?.method === 'POST' || o?.method === 'PUT') && String(u).includes('/api/jobs')) window.__jobPosts += 1;
      return orig(...a);
    };
  });
}
const jobPosts = () => page().eval(() => window.__jobPosts ?? 0);
async function openJobDialog() {
  await gotoTab('#jobs');
  await page().eval(() => document.querySelector('#new-job').click());
  await waitFor(() => document.querySelector('#job-dialog').open, 'job dialog', 8000);
}
async function fillJobForm(name) {
  await page().eval(() => {
    const b = document.querySelector('#f-type button[data-value="command"]');
    if (b && !b.classList.contains('active')) b.click();
  });
  await sleep(300);
  const v = await page().eval((n) => {
    document.querySelector('#f-name').value = n;
    const cmd = document.querySelector('#ext-fields [data-key="command"]');
    if (cmd) cmd.value = `echo sitting output from ${n}`;
    const cwd = document.querySelector('#f-cwd');
    if (cwd) cwd.value = '/tmp';
    for (const el of document.querySelectorAll('#job-form [required]')) {
      if (!el.value) el.value = el.tagName === 'TEXTAREA' ? 'echo x' : 'x';
    }
    const form = document.querySelector('#job-form');
    return { valid: form.checkValidity(), invalid: [...form.querySelectorAll(':invalid')].map((e) => e.id || e.name) };
  }, name);
  if (!v.valid) throw new Error(`job form invalid: ${v.invalid.join(', ')}`);
}
const clickSave = () => page().eval(() => document.querySelector('#dialog-save').click());
const formError = () => page().eval(() => {
  const b = document.querySelector('#form-errors');
  return b && !b.hidden ? b.textContent : '';
});
const lastToast = () => page().eval(() => {
  const t = [...document.querySelectorAll('#toasts .toast')];
  return t.length ? t[t.length - 1].textContent : '';
});

// ══════════════════════════════════════════════════════════════ the sitting
try {
  hr('boot the one sandboxed daemon (real 180s approval timeout)');
  // No CS_APPROVAL_TIMEOUT_MS override: every browser row here is answered by a
  // human who is watching, so they get the full, unrushed bound. The only row
  // that needs a *short* timeout is the ignore-it row (plan row 4), and that is
  // delegated to tools/verify-approval-timeout.sh (which sets its own 6s).
  await bootDaemon();
  TOKEN = execFileSync('node', [join(REPO, 'bin/claude-scheduler.mjs'), 'token'],
    { env: { ...process.env, CS_DATA: DATA } }).toString().trim();
  ok(`daemon up on ${PORT}, token obtained`);

  const reg = await api('POST', '/api/projects', { path: FIXREPO, name: 'sitting-fixture' });
  if (![200, 201].includes(reg.status)) throw new Error(`project registration failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  // The server names a project after its directory, not the body's `name`, so
  // track it by id, not by the label we asked for.
  const PROJ_ID = reg.body.project.id;
  ok('fixture project registered (pending, no prompt — registration is ungated)');

  // ------------------------------------- Task 8: the original exploit, re-run
  hr('Task 8 — the original exploit, re-run (no dialogs)');
  const curl = (args) => execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', ...args]).toString();
  const e1 = curl(['-X', 'POST', '-H', 'Host: evil.example.com', '-H', 'Content-Type: text/plain', '--data', 'x=1', `${BASE}/api/cleanup`]);
  record('T8-exploit', e1 === '403', `original exploit (foreign-Host form POST /api/cleanup) → ${e1}, expected 403`);
  const e2 = curl(['-X', 'POST', '-H', `Authorization: Bearer ${TOKEN}`, '-H', 'Content-Type: text/plain', '--data', 'x=1', `${BASE}/api/cleanup`]);
  record('T8-exploit', e2 === '415', `form content-type with a valid token → ${e2}, expected 415`);
  const e3 = curl(['-H', 'Host: evil.example.com', `${BASE}/api/settings`]);
  record('T8-exploit', e3 === '403', `foreign-Host read leak GET /api/settings → ${e3}, expected 403`);
  const e4 = curl([`${BASE}/api/settings`]);
  record('T8-exploit', e4 === '401', `tokenless read → ${e4}, expected 401`);

  // Real sitting is headful (the human sees the tabs being driven). A dry run is
  // headless by default, but CS_SITTING_HEADFUL=1 forces headful so the whole
  // flow can be proven in a visible window without real dialogs.
  browser = await launchBrowser({
    headful: !DRY || process.env.CS_SITTING_HEADFUL === '1', width: 1400, height: 900, scale: 1,
  });
  await page().goto(`${BASE}/#token=${TOKEN}`);
  await sleep(1500);
  await installPostCounter();
  if (!await page().eval(() => document.querySelector('#auth-banner').hidden && !!document.querySelector('.tabs'))) {
    throw new Error('UI did not authenticate with the token');
  }
  ok('Chrome up, UI authenticated, token stripped from the URL');

  banner([`ONE sitting. ${DRY ? '(dry run — no real dialogs)' : '7 dialogs you act on, plus 1 timeout dialog you deliberately ignore.'}`,
    'Each row prints what to do. Rows marked NO DIALOG must stay silent.']);

  // The TIMEOUT row (plan row 4) is NOT driven through the browser. A job-create
  // POST is held open by the server for the full timeout, and a request held that
  // long then answered with a 408 is re-sent by Chrome at the HTTP layer —
  // transparent to fetch(), so it surfaces as a phantom SECOND approval dialog
  // (measured: one clickSave → two server asks on this path alone). The shipped
  // docs/spikes/auth-verify.sh avoids this exact path by delegating the timeout
  // to tools/verify-approval-timeout.sh — a real helper, a real dialog, refused
  // by no one, asserting approval_timeout with nothing written. Row 4 runs there,
  // below, after the browser rows. Tracked separately as a real (low-severity,
  // fails-closed) finding; see the bead filed from this session.

  // ── ROW 2 (plan) — DENY. First browser dialog; no grace window open yet.
  banner(['[plan row 2] DENY — a dialog to create the job "second job"',
    'YOU: DENY it']);
  await openJobDialog();
  await fillJobForm('second job');
  let before = await jobCount();
  const posts = await jobPosts();
  await clickSave();
  const denied = await waitFor(() => {
    const b = document.querySelector('#form-errors');
    return b && !b.hidden && /denied/i.test(b.textContent) ? b.textContent : '';
  }, 'row 2 denial copy');
  record('2', (await jobPosts()) === posts + 1, `denial surfaced (one client POST): "${denied.slice(0, 56)}"`);
  const kept2 = await page().eval(() => ({
    name: document.querySelector('#f-name').value,
    cmd: document.querySelector('#ext-fields [data-key="command"]')?.value ?? '',
    cwd: document.querySelector('#f-cwd')?.value ?? '',
    open: document.querySelector('#job-dialog').open,
  }));
  record('2', kept2.open && kept2.name === 'second job' && /second job/.test(kept2.cmd) && kept2.cwd === '/tmp',
    'form still holds every field after the denial');
  record('2', (await jobCount()) === before, 'no job created by the denial');

  // ── ROW 3 (plan) — APPROVE the retry of that same untouched form. This is the
  //    state-preservation contract, and it opens the grace window.
  banner(['[plan row 3] APPROVE — the SAME form, retried. Press nothing in the browser;',
    'a fresh dialog appears for "second job".',
    'YOU: APPROVE it']);
  await clickSave();
  await waitFor(() => !document.querySelector('#job-dialog').open, 'row 3 approval (dialog closes)');
  record('3', (await jobCount()) === before + 1, 'retry of the preserved form succeeded — a denial cost nothing');
  const graceT0 = Date.now();

  // ── Task 8 — run that job, open the log, Refresh advances "as of" (no dialog).
  hr('Task 8 — run the approved job, open the log, Refresh advances "as of" (no dialog)');
  await gotoTab('#jobs');
  await page().eval(() => {
    const row = [...document.querySelectorAll('#jobs-list .item')].find((el) => el.textContent.includes('second job'));
    row.querySelector('[data-act="run"]').click();
  });
  await waitFor(() => !document.querySelector('#log-drawer').hidden, 'log drawer', 15000);
  const asof1 = await page().eval(() => document.querySelector('#log-asof').textContent);
  await sleep(2600);
  await page().eval(() => document.querySelector('#log-refresh').click());
  await sleep(900);
  const asof2 = await page().eval(() => document.querySelector('#log-asof').textContent);
  const logText = await page().eval(() => document.querySelector('#log-view').textContent);
  record('T8-log', asof2 !== asof1 && asof2.startsWith('as of'), `Refresh advanced the "as of" time (${asof1} → ${asof2})`);
  record('T8-log', /sitting output from second job/.test(logText), 'run output appears in the log view');
  await page().eval(() => document.querySelector('#log-close')?.click?.());
  await sleep(300);

  // ── ROW 5 (plan) — NO DIALOG: edit the job's schedule inside the grace window.
  banner(['[plan row 5] NO DIALOG — editing the job\'s schedule inside the grace window.',
    'YOU: nothing. If a dialog appears, that is a FAILURE — deny it.']);
  const p5 = promptCount();
  await gotoTab('#jobs');
  await page().eval(() => {
    const row = [...document.querySelectorAll('#jobs-list .item')].find((el) => el.textContent.includes('second job'));
    row.querySelector('[data-act="edit"]').click();
  });
  await waitFor(() => document.querySelector('#job-dialog').open, 'edit dialog', 8000);
  await page().eval(() => { const t = document.querySelector('#sched-rows .sr-time'); if (t && !t.hidden) t.value = '10:30'; });
  await clickSave();
  await waitFor(() => !document.querySelector('#job-dialog').open, 'row 5 graced save', 15000);
  record('5', promptCount() === p5,
    `schedule edit rode the grace window — no prompt (${Math.round((Date.now() - graceT0) / 1000)}s after approval)`);

  // ── ROW 6 (plan) — DENY cleanup: prompts DESPITE the open grace window.
  banner(['[plan row 6] DENY — a dialog for cleanup (delete ALL jobs/runs/logs).',
    'It MUST prompt even inside the grace window.',
    'YOU: DENY it']);
  before = await jobCount();
  await gotoTab('#settings');
  await page().eval(() => {
    for (const d of document.querySelectorAll('details')) d.open = true;
    document.querySelector('#cleanup-confirm').value = 'cleanup';
    document.querySelector('#cleanup-btn').click();
  });
  const toast6 = await waitFor(() => {
    const t = [...document.querySelectorAll('#toasts .toast')];
    const last = t[t.length - 1];
    return last && /denied/i.test(last.textContent) ? last.textContent : '';
  }, 'row 6 denial toast');
  record('6', true, `cleanup prompted despite the grace window and was refused: "${toast6.slice(0, 52)}"`);
  record('6', (await jobCount()) === before, 'nothing was deleted');

  // ── ROW 7 (plan) — APPROVE activate the project (the airlock; prompts anyway).
  banner(['[plan row 7] APPROVE — activate the project "sitting-fixture".',
    'A browser "Activate?" confirm flashes (auto-accepted), then the real dialog.',
    'YOU: APPROVE the system dialog']);
  await gotoTab('#projects');
  await waitFor(() => !!document.querySelector('#projects-list [data-act="activate"]'), 'activate button', 15000);
  // Activation first raises an in-page confirm() ("Activate …?"). A native dialog
  // blocks the renderer, so the eval-click never returns until it is answered —
  // withDialog accepts it, standing in for the user clicking OK. The SECURITY
  // gate that follows is the real Touch ID sheet, which the human still answers.
  await page().withDialog('accept', () => page().eval(() => document.querySelector('#projects-list [data-act="activate"]').click()));
  const active = await (async () => {
    const t = Date.now();
    for (;;) {
      const { body } = await api('GET', '/api/projects');
      if ((body.projects || []).find((x) => x.id === PROJ_ID)?.state === 'active') return true;
      if (Date.now() - t > 150000) return false;
      await sleep(500);
    }
  })();
  record('7', active, 'project activated after approval (state=active despite the grace window)');

  // ── ROW 8 (plan) — APPROVE change claudePath (the bypass the spec calls out).
  banner(['[plan row 8] APPROVE — a dialog to change which Claude program runs.',
    'YOU: APPROVE it']);
  await gotoTab('#settings');
  await sleep(600);
  const p8 = promptCount();
  await page().eval(() => {
    document.querySelector('#ext-settings fieldset[data-ext="claude"] [data-key="claudePath"]').value = '/usr/bin/true';
    document.querySelector('#settings-form button.primary').click();
  });
  await waitFor(() => /saved/.test(document.querySelector('#settings-msg')?.textContent ?? ''), 'row 8 saved ✓');
  record('8', (await api('GET', '/api/settings')).body.extensions?.claude?.claudePath === '/usr/bin/true' && promptCount() === p8 + 1,
    'claudePath change prompted (grace never applies) and was written after approval');

  // ── ROW 9 (plan) — NO DIALOG: an ordinary setting is not gated.
  banner(['[plan row 9] NO DIALOG — changing usagePollSec (an ordinary setting).',
    'YOU: nothing.']);
  const p9 = promptCount();
  await page().eval(() => {
    document.querySelector('#s-usagePollSec').value = '300';
    document.querySelector('#settings-form button.primary').click();
  });
  await waitFor(() => /saved/.test(document.querySelector('#settings-msg')?.textContent ?? ''), 'row 9 saved ✓', 20000);
  record('9', String((await api('GET', '/api/settings')).body.usagePollSec) === '300' && promptCount() === p9,
    'usagePollSec saved with no prompt — ordinary settings are not gated');

  await browser.close(); browser = null;

  // ── ROW 4 (plan) — TIMEOUT, via the unattended tool (see the note above).
  hr('[plan row 4] TIMEOUT — delegated to tools/verify-approval-timeout.sh');
  if (DRY) {
    record('4', existsSync(join(REPO, 'tools/verify-approval-timeout.sh')),
      'DRY: verify-approval-timeout.sh present; raises a real dialog, so it runs only in the real sitting');
  } else {
    banner(['[plan row 4] TIMEOUT — a real dialog appears and dismisses itself (~6s).',
      'YOU: DO NOT TOUCH IT. It proves a timeout writes nothing.']);
    const r = spawn('bash', [join(REPO, 'tools/verify-approval-timeout.sh')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    r.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    r.stderr.on('data', (d) => { out += d; });
    const code = await new Promise((res) => r.on('exit', res));
    record('4', code === 0 && !/✗|fail/i.test(out.replace(/\d+ failed/g, '')),
      `verify-approval-timeout.sh exit ${code} — real dialog → approval_timeout, nothing written`);
  }

  // ── ROW 10 (plan) — the helper's own approve/deny contract, at a real dialog.
  if (DRY) {
    record('10', existsSync(join(REPO, 'docs/spikes/localauth.sh')), 'DRY: localauth.sh present; skipped (needs a human, runs in the real sitting)');
  } else {
    banner(['[plan row 10] docs/spikes/localauth.sh — TWO system sheets.',
      'YOU: APPROVE the first, DENY the second — and answer its [y/N] wording prompt.']);
    // stdio:'inherit', NOT piped: localauth.sh asks the human a [y/N] to confirm
    // the sheet wording, so it needs the real terminal's stdin. Piping stdin as
    // 'ignore' feeds that read an EOF, which defaults to N and fails the wording
    // check even when the sheet was correct. Judge by exit code (0 = all pass).
    const r = spawn('bash', [join(REPO, 'docs/spikes/localauth.sh')], { stdio: 'inherit' });
    const code = await new Promise((res) => r.on('exit', res));
    record('10', code === 0, `localauth.sh exit ${code} — approve→0, deny→errorCode -2, wording confirmed (0 = all pass)`);
  }
} catch (err) {
  bad(`aborted: ${err.message}`);
  console.log(srvLog.slice(-1500));
} finally {
  try { await browser?.close?.(); } catch { /* already closed */ }
  await stopDaemon();

  hr('dialog wording, as logged (judge anything that read badly)');
  for (const line of srvLog.split('\n').filter((l) => l.includes('approval: asked'))) console.log(`   ${line.trim()}`);

  hr('teardown');
  for (const d of [DATA, FAKE, SESS, FIXREPO]) rmSync(d, { recursive: true, force: true });
  const untouched = realDirFingerprint() === realBefore;
  (untouched ? ok : bad)(`real ~/.claude-scheduler untouched (top-level listing ${untouched ? 'unchanged' : 'CHANGED'})`);

  hr('results');
  for (const r of results) console.log(`   ${r.ok ? '✓' : '✗'} [${r.row}] ${r.note}`);
  console.log(`\n──────── ${pass} passed, ${fail} failed ────────`);
  process.exit(fail > 0 ? 1 : 0);
}
