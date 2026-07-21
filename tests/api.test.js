import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpData, jobPayload, fakeSpawn, sleep, extensions } from './helpers.js';
import { ensureDirs } from '../lib/paths.js';
import { openDb, listRuns, getSetting } from '../lib/db.js';
import { createRunner } from '../lib/runner.js';
import { createScheduler } from '../lib/scheduler.js';
import { createAwake } from '../lib/awake.js';
import { createApp } from '../server.js';
import { removalScript } from '../lib/uninstall.js';

async function boot() {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const spawnFn = fakeSpawn();
  const caffSpawn = fakeSpawn();
  const runner = createRunner({ db, extensions, spawnFn, notifyFn: () => {} });
  const scheduler = createScheduler({ db, runner });
  const awake = createAwake({ db, runner, scheduler, spawnFn: caffSpawn });
  const osaCalls = [];
  const uninstalls = [];
  const app = createApp({
    db, runner, scheduler, extensions, awake,
    execFileFn: (cmd, args, cb) => { osaCalls.push({ cmd, args }); cb(null); },
    uninstallFn: (opts) => uninstalls.push(opts),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = () => `http://127.0.0.1:${server.address().port}`;
  return { db, spawnFn, caffSpawn, runner, scheduler, awake, server, base, osaCalls, uninstalls };
}

async function req(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* plaintext (log) responses */ }
  return { status: res.status, body: parsed, raw: text };
}

test('extensions manifest lists claude+command, functions stripped', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());

  const r = await req(base(), 'GET', '/api/extensions');
  const ids = r.body.extensions.map((e) => e.id).sort();
  assert.deepEqual(ids, ['claude', 'command']);
  const claude = r.body.extensions.find((e) => e.id === 'claude');
  assert.ok(claude.fields.some((f) => f.key === 'prompt' && f.required));
  assert.deepEqual(claude.runActions, [{ id: 'resume', label: 'Resume in Terminal', requiresRunMeta: 'sessionId' }]);
  assert.ok(!('command' in claude) && !('exec' in claude.runActions[0]));
});

test('jobs CRUD + validation + decoration + params fold-in', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());

  let r = await req(base(), 'POST', '/api/jobs', jobPayload({ name: 'daily' }));
  assert.equal(r.status, 201);
  const id = r.body.id;
  assert.ok(r.body.nextFire); // decorated
  assert.equal(r.body.lastRun, null);
  assert.equal(r.body.params.prompt, 'do the thing'); // flat key folded into params

  r = await req(base(), 'POST', '/api/jobs', jobPayload({ cwd: '/nope' }));
  assert.equal(r.status, 400);
  assert.ok(r.body.errors.length);

  r = await req(base(), 'POST', '/api/jobs', jobPayload({ type: 'nope' }));
  assert.equal(r.status, 400);

  r = await req(base(), 'GET', '/api/jobs');
  assert.equal(r.body.jobs.length, 1);
  assert.equal(r.body.running, 0);
  assert.equal(r.body.awake.mode, 'off');

  r = await req(base(), 'PUT', `/api/jobs/${id}`, { name: 'renamed', enabled: false, params: { model: 'opus' } });
  assert.equal(r.body.name, 'renamed');
  assert.equal(r.body.enabled, false);
  assert.equal(r.body.params.model, 'opus');
  assert.equal(r.body.params.prompt, 'do the thing'); // params merge, not replace
  assert.equal(r.body.nextFire, null); // disabled → unscheduled

  r = await req(base(), 'DELETE', `/api/jobs/${id}`);
  assert.equal(r.body.ok, true);
  r = await req(base(), 'GET', `/api/jobs/${id}`);
  assert.equal(r.status, 404);
});

test('run-now, runs list, log, resume action', async (t) => {
  const { spawnFn, server, base, osaCalls } = await boot();
  t.after(() => server.close());

  const { body: job } = await req(base(), 'POST', '/api/jobs', jobPayload());
  let r = await req(base(), 'POST', `/api/jobs/${job.id}/run`);
  assert.equal(r.status, 202);
  const runId = r.body.id;
  assert.equal(r.body.status, 'running');

  // resume before session id lands → 400
  r = await req(base(), 'POST', `/api/runs/${runId}/actions/resume`);
  assert.equal(r.status, 400);

  const child = spawnFn.calls[0].child;
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-x', model: 'm' }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', result: 'yo', num_turns: 1 }) + '\n'));
  child.emit('close', 0);
  await sleep(30);

  r = await req(base(), 'GET', `/api/runs?job=${job.id}`);
  assert.equal(r.body.runs.length, 1);
  assert.equal(r.body.runs[0].status, 'ok');
  assert.equal(r.body.runs[0].meta.sessionId, 'sess-x');

  r = await req(base(), 'GET', `/api/runs/${runId}/log`);
  assert.ok(r.raw.includes('sess-x') && r.raw.includes('yo'));

  r = await req(base(), 'POST', `/api/runs/${runId}/actions/resume`);
  assert.equal(r.status, 200);
  assert.equal(osaCalls[0].cmd, 'osascript');
  assert.ok(osaCalls[0].args[1].includes('--resume sess-x'));
  assert.ok(osaCalls[0].args[1].includes(job.cwd));

  r = await req(base(), 'POST', `/api/runs/${runId}/actions/nope`);
  assert.equal(r.status, 404);
});

test('kill endpoint: 202 active, 409 finished, 404 unknown', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());

  const { body: job } = await req(base(), 'POST', '/api/jobs', jobPayload());
  const { body: run } = await req(base(), 'POST', `/api/jobs/${job.id}/run`);

  let r = await req(base(), 'POST', `/api/runs/${run.id}/kill`);
  assert.equal(r.status, 202);
  assert.equal(r.body.status, 'killed');

  r = await req(base(), 'POST', `/api/runs/${run.id}/kill`);
  assert.equal(r.status, 409);
  r = await req(base(), 'POST', '/api/runs/nope/kill');
  assert.equal(r.status, 404);
});

test('SSE tail streams history + done for finished run', async (t) => {
  const { spawnFn, server, base } = await boot();
  t.after(() => server.close());

  const { body: job } = await req(base(), 'POST', '/api/jobs', jobPayload({ type: 'command', prompt: null, command: 'echo hi' }));
  const { body: run } = await req(base(), 'POST', `/api/jobs/${job.id}/run`);
  spawnFn.calls[0].child.stdout.emit('data', Buffer.from('hello world\n'));
  spawnFn.calls[0].child.emit('close', 0);
  await sleep(30);

  const res = await fetch(`${base()}/api/runs/${run.id}/tail`);
  const text = await res.text(); // finished run → server ends stream
  assert.ok(text.includes('data: hello world'));
  assert.ok(text.includes('event: done'));
});

test('schedule preview + settings round-trip (per-extension)', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());

  let r = await req(base(), 'POST', '/api/schedule/preview', { schedule: { type: 'cron', expr: '0 9 * * *' } });
  assert.equal(r.body.next.length, 3);
  r = await req(base(), 'POST', '/api/schedule/preview', { schedule: { type: 'cron', expr: 'junk' } });
  assert.equal(r.status, 400);

  r = await req(base(), 'GET', '/api/settings');
  assert.equal(r.body.paused, false);
  assert.deepEqual(r.body.extensions.claude, { claudePath: 'claude', maxConcurrent: 2 });

  r = await req(base(), 'PUT', '/api/settings', { paused: true, extensions: { claude: { claudePath: '/opt/claude', maxConcurrent: 4 } } });
  assert.equal(r.body.ok, true);
  r = await req(base(), 'GET', '/api/settings');
  assert.deepEqual(r.body, {
    paused: true,
    home: process.env.HOME || '',
    extensions: { claude: { claudePath: '/opt/claude', maxConcurrent: 4 } },
  });

  r = await req(base(), 'PUT', '/api/settings', { extensions: { claude: { maxConcurrent: 99 } } });
  assert.equal(r.status, 400);
  r = await req(base(), 'PUT', '/api/settings', { extensions: { nope: { x: 1 } } });
  assert.equal(r.status, 400);
});

test('awake endpoints: modes, timed validation, caffeinate lifecycle', async (t) => {
  const { server, base, caffSpawn } = await boot();
  t.after(() => server.close());

  let r = await req(base(), 'GET', '/api/awake');
  assert.deepEqual(r.body, { mode: 'off', until: null, active: false });

  r = await req(base(), 'PUT', '/api/awake', { mode: 'on' });
  assert.deepEqual(r.body, { mode: 'on', until: null, active: true });
  assert.equal(caffSpawn.calls[0].cmd, 'caffeinate');
  assert.deepEqual(caffSpawn.calls[0].args, ['-i', '-w', String(process.pid)]);

  r = await req(base(), 'PUT', '/api/awake', { mode: 'off' });
  assert.deepEqual(r.body, { mode: 'off', until: null, active: false });
  assert.equal(caffSpawn.calls[0].child.killedWith, 'SIGTERM');

  r = await req(base(), 'PUT', '/api/awake', { mode: 'timed', minutes: 60 });
  assert.equal(r.body.mode, 'timed');
  assert.ok(new Date(r.body.until) > new Date());
  assert.equal(r.body.active, true);

  r = await req(base(), 'PUT', '/api/awake', { mode: 'timed' }); // minutes required
  assert.equal(r.status, 400);
  r = await req(base(), 'PUT', '/api/awake', { mode: 'bogus' });
  assert.equal(r.status, 400);

  // auto: no enabled jobs+no runs → inactive; job with future fire → active
  r = await req(base(), 'PUT', '/api/awake', { mode: 'auto' });
  assert.equal(r.body.active, false);
  await req(base(), 'POST', '/api/jobs', jobPayload());
  r = await req(base(), 'GET', '/api/awake');
  assert.equal(r.body.active, true);
});

test('cleanup wipes jobs+runs, keeps settings; uninstall fires hook', async (t) => {
  const { db, spawnFn, server, base, uninstalls } = await boot();
  t.after(() => server.close());

  await req(base(), 'PUT', '/api/settings', { extensions: { claude: { maxConcurrent: 3 } } });
  const { body: job } = await req(base(), 'POST', '/api/jobs', jobPayload());
  await req(base(), 'POST', `/api/jobs/${job.id}/run`);
  spawnFn.calls[0].child.emit('close', 0);
  await sleep(30);

  let r = await req(base(), 'POST', '/api/cleanup');
  assert.equal(r.body.ok, true);
  r = await req(base(), 'GET', '/api/jobs');
  assert.equal(r.body.jobs.length, 0);
  assert.equal(listRuns(db).length, 0);
  assert.equal(getSetting(db, 'maxConcurrent'), '3');

  r = await req(base(), 'POST', '/api/uninstall');
  assert.equal(r.status, 202);
  assert.equal(uninstalls.length, 1);
});

test('removalScript removes plist + data but NEVER deletes the tool dir', () => {
  const s = removalScript({ toolDir: '/x/tool', data: '/y/data' });
  assert.ok(s.includes('launchctl bootout'));
  assert.ok(s.includes('com.claude-scheduler.plist'));
  assert.ok(s.includes('rm -rf "/y/data"'));
  // Source tree must be preserved — the tool dir is only mentioned, not rm -rf'd.
  assert.ok(!/rm -rf "?\/x\/tool"?/.test(s), 'must not rm -rf the tool dir');
  assert.ok(s.includes('/x/tool'), 'should print the tool dir for manual removal');
});
