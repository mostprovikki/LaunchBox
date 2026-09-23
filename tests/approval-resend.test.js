// claude-scheduler-tki — the phantom second approval sheet.
//
// Chrome resends a request verbatim on a fresh connection when the response is
// 408 and the connection it went out on came from its idle socket pool (RFC 7231
// §6.5.7 reads a 408 on a persistent connection as "I am closing this idle
// connection", so the request is presumed unprocessed). Confirmed at the byte
// level against a real Chrome through a logging TCP proxy: identical setup,
// 408 → two POSTs on the wire and two dialogs; 409 → one of each; 408 on a socket
// opened for that request → one of each; 408 with `Connection: close` → still two.
//
// What the user saw was ONE Submit and TWO Touch ID sheets, six seconds apart.
// server.js therefore arms a timed-out refusal to answer one identical resend
// with the same 408 and no dialog.
//
// These tests do not drive Chrome — they send the resend the way Chrome sends it
// (byte-identical, immediately after the 408) and assert on the number of times
// the approval layer was ASKED, which is the thing the user experiences as a
// dialog. The browser half is pinned by the harness in the bead's notes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { tmpData, jobPayload, fakeSpawn, extensions, sleep } from './helpers.js';
import { ensureDirs } from '../lib/paths.js';
import { ensureToken } from '../lib/token.js';
import { openDb, listJobs } from '../lib/db.js';
import { createRunner } from '../lib/runner.js';
import { createScheduler } from '../lib/scheduler.js';
import { createPauseController } from '../lib/pause.js';
import { createApp, APPROVAL_RESEND_WINDOW_MS } from '../server.js';

let currentToken = null;

// Records every request reaching the approval layer. One entry = one system
// dialog the user would have been shown.
function recordingApprover(answer) {
  const asked = [];
  return {
    asked,
    available: () => ({ ok: true, degraded: false, platform: 'darwin' }),
    request: async (spec) => {
      asked.push(spec);
      return typeof answer === 'function' ? answer(spec, asked.length) : answer;
    },
    events: new EventEmitter(),
  };
}

async function boot(answer, { approvalResendWindowMs } = {}) {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const approval = recordingApprover(answer);
  let pause = null;
  const runner = createRunner({
    db, extensions, spawnFn: fakeSpawn(), notifyFn: () => {}, admit: (j, t, o) => pause?.gate(j, t, o) ?? null,
  });
  pause = createPauseController({ db, runner });
  const scheduler = createScheduler({ db, runner, pause });
  currentToken = ensureToken();
  const app = createApp({
    db, runner, scheduler, extensions, awake: null, pause, approval, token: currentToken,
    ...(approvalResendWindowMs === undefined ? {} : { approvalResendWindowMs }),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { db, server, approval, base: () => `http://127.0.0.1:${server.address().port}` };
}

// Deliberately NOT a shared body object: Chrome resends the same BYTES, and the
// guard must key on those rather than on object identity.
async function post(base, path, body, { token = currentToken } = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const TIMEOUT = { ok: false, code: 'approval_timeout' };
const PAYLOAD = () => jobPayload({ name: 'timeout probe' });

test('tki: the resend of a timed-out POST is refused without a second dialog', async (t) => {
  const { server, base, approval, db } = await boot(TIMEOUT);
  t.after(() => server.close());

  const first = await post(base(), '/api/jobs', PAYLOAD());
  assert.equal(first.status, 408);
  assert.equal(first.body.code, 'approval_timeout');
  assert.equal(approval.asked.length, 1, 'the user was asked once');

  // Chrome's resend: same method, same URL, same bytes, immediately after.
  const resent = await post(base(), '/api/jobs', PAYLOAD());
  assert.equal(resent.status, 408, 'the resend gets the same refusal');
  assert.equal(resent.body.code, 'approval_timeout');
  assert.equal(approval.asked.length, 1, 'and NO second system dialog was raised');

  assert.equal(listJobs(db).length, 0, 'still fails closed — nothing was written');
});

test('tki: the arm is single-shot — a second retry is prompted, not silently refused', async (t) => {
  const { server, base, approval } = await boot(TIMEOUT);
  t.after(() => server.close());

  await post(base(), '/api/jobs', PAYLOAD());
  await post(base(), '/api/jobs', PAYLOAD()); // consumes the arm
  assert.equal(approval.asked.length, 1);

  // A client that keeps retrying must not be refused invisibly forever: the
  // second retry is a fresh intent as far as this server can tell.
  const third = await post(base(), '/api/jobs', PAYLOAD());
  assert.equal(third.status, 408);
  assert.equal(approval.asked.length, 2, 'the third attempt raised its own dialog');
});

test('tki: the arm expires, so a human pressing Submit again is prompted', async (t) => {
  const { server, base, approval } = await boot(TIMEOUT, { approvalResendWindowMs: 30 });
  t.after(() => server.close());

  await post(base(), '/api/jobs', PAYLOAD());
  assert.equal(approval.asked.length, 1);
  await sleep(80);

  const again = await post(base(), '/api/jobs', PAYLOAD());
  assert.equal(again.status, 408);
  assert.equal(approval.asked.length, 2, 'a later identical submit is asked about again');
});

test('tki: a DIFFERENT request after a timeout is never swallowed', async (t) => {
  const { server, base, approval } = await boot(TIMEOUT);
  t.after(() => server.close());

  await post(base(), '/api/jobs', PAYLOAD());
  assert.equal(approval.asked.length, 1);

  // One character of difference in the body is a different action, and every
  // action gets its own dialog. This is the guard's blast radius: it must be
  // exactly one request, not "job creation for the next second".
  const other = await post(base(), '/api/jobs', jobPayload({ name: 'a different job' }));
  assert.equal(other.status, 408);
  assert.equal(approval.asked.length, 2);
  assert.match(approval.asked[1].detail, /a different job/);
});

test('tki: only a TIMEOUT arms a replay — a denial does not', async (t) => {
  // 403 is not a status Chrome resends, so a denial must keep prompting: the
  // guard exists for the transport retry, not as a general throttle on dialogs.
  const { server, base, approval } = await boot({ ok: false, code: 'approval_denied' });
  t.after(() => server.close());

  const first = await post(base(), '/api/jobs', PAYLOAD());
  assert.equal(first.status, 403);
  const second = await post(base(), '/api/jobs', PAYLOAD());
  assert.equal(second.status, 403);
  assert.equal(approval.asked.length, 2, 'pressing Submit after a denial still asks');
});

test('tki: an armed replay never turns into a grant', async (t) => {
  // The guard can only ever refuse. If the approval layer would now say yes, the
  // resend must still be refused (it is the SAME action that was already answered
  // "no one was there") — and, decisively, no job may appear.
  let n = 0;
  const { server, base, db, approval } = await boot(() => {
    n += 1;
    return n === 1 ? TIMEOUT : { ok: true };
  });
  t.after(() => server.close());

  assert.equal((await post(base(), '/api/jobs', PAYLOAD())).status, 408);
  const resent = await post(base(), '/api/jobs', PAYLOAD());
  assert.equal(resent.status, 408, 'the resend is refused, never approved');
  assert.equal(approval.asked.length, 1);
  assert.equal(listJobs(db).length, 0, 'no job was created by the resend');
});

test('tki: the window is short enough to be a transport retry and no more', async (t) => {
  // Measured resend latency was 1–3ms. A window that crept up into seconds would
  // start swallowing deliberate re-submits, so it is pinned here rather than left
  // to drift with an edit.
  assert.ok(APPROVAL_RESEND_WINDOW_MS >= 100, 'must outlast a slow resend');
  assert.ok(APPROVAL_RESEND_WINDOW_MS <= 2000, 'must not reach into human re-submit time');
});
