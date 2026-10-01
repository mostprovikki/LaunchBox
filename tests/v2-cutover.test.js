// Cutover prep (claude-scheduler-btv.15 / E3): the parity gate, and the flag
// that decides which UI the root path serves.
//
// The flag SHIPS OFF and flipping it is the owner's click — the same airlock
// principle project activation uses. These tests exist mostly to prove that:
// that the default is off, that nothing in the repo turns it on, and that the
// existing UI stays reachable in both states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { apiCalls, covers, compare, loadCalls, ACCEPTED, RESOLVED } from '../tools/qa/v2-parity.mjs';
import { tmpData, extensions } from './helpers.js';
import { ensureDirs } from '../lib/paths.js';
import { ensureToken } from '../lib/token.js';
import { openDb, setSetting } from '../lib/db.js';
import { createRunner } from '../lib/runner.js';
import { createScheduler } from '../lib/scheduler.js';
import { createApp } from '../server.js';
import { request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// A minimal boot, the same shape tests/api.test.js uses: a real listening
// server, because the thing under test is which FILE a path serves — which
// express.static and route ordering decide, not any function we could call.
async function boot({ approval } = {}) {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const runner = createRunner({ db, extensions, spawnFn: () => {}, notifyFn: () => {} });
  const scheduler = createScheduler({ db, runner });
  const token = ensureToken();
  const app = createApp({ db, runner, scheduler, extensions, awake: null, token, ...(approval ? { approval } : {}) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { db, server, token, port: server.address().port };
}

// One entry per system dialog the owner would have been shown.
function recordingApprover(answer) {
  const asked = [];
  return {
    asked,
    available: () => ({ ok: true, degraded: false, platform: 'darwin' }),
    request: async (spec) => { asked.push(spec); return answer; },
    events: new EventEmitter(),
  };
}

async function api(port, token, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, raw: text }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------- the flag

test('the cutover flag ships OFF, and only the Touch ID-gated route can turn it on', () => {
  const src = read('server.js');
  assert.match(src, /getSetting\(db, 'v2Default', '0'\)/, 'the default must be off');
  // One reader and one writer, both spelled literally so this scan can see them.
  // (A constant would make the writer regex below pass vacuously.)
  assert.equal((src.match(/'v2Default'/g) ?? []).length, 2, 'exactly one read and one write of v2Default');
  // The one writer is the cutover route, and Touch ID comes BEFORE the write:
  // an agent may prepare the switch, only the owner may throw it (2026-10-01
  // cutover plan, phase A). Before that plan nothing wrote it at all.
  const route = src.slice(src.indexOf("app.put('/api/ui-default'"));
  assert.ok(route.length < src.length, 'the PUT /api/ui-default route exists');
  const body = route.slice(0, route.indexOf('\n  });'));
  const ask = body.indexOf('await approve(');
  const write = body.search(/setSetting\(db, 'v2Default'/);
  assert.ok(ask > 0 && write > ask, 'approve() must run before the setting is written');
  const writers = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      // `tests/` is excluded on purpose: this very file flips the setting in a
      // throwaway DB to test the flipped state. What must never write it outside
      // the gated route is PRODUCTION code — lib/, bin/, tools/, public/.
      if (['node_modules', '.git', '.beads', 'tests', 'redesign', 'working_prototype_screenshots'].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs)$/.test(name)) continue;
      const s2 = readFileSync(p, 'utf8');
      const n = (s2.match(/setSetting\([^)]*v2Default/g) ?? []).length;
      if (n) writers.push(`${p.slice(ROOT.length + 1)}×${n}`);
    }
  };
  walk(ROOT);
  assert.deepEqual(writers, ['server.js×1'], `v2Default writers: ${writers.join(', ')}`);
});

test('with the flag OFF (the default), / serves the existing UI and /v2 serves v2', async (t) => {
  const { server, port } = await boot();
  t.after(() => server.close());
  const root = await get(port, '/');
  assert.equal(root.status, 200);
  assert.match(root.raw, /<title>Scheduler<\/title>/, '/ must still be the existing UI by default');
  const v2 = await get(port, '/v2');
  assert.equal(v2.status, 200);
  assert.match(v2.raw, /<title>LaunchBox<\/title>/);
});

test('/v1 serves the existing UI in BOTH states, so a link written today survives the flip', async (t) => {
  const { db, server, port } = await boot();
  t.after(() => server.close());

  const before = await get(port, '/v1');
  assert.equal(before.status, 200);
  assert.match(before.raw, /<title>Scheduler<\/title>/);

  setSetting(db, 'v2Default', '1');

  const root = await get(port, '/');
  assert.match(root.raw, /<title>LaunchBox<\/title>/, 'with the flag on, / is v2');
  const after = await get(port, '/v1');
  assert.match(after.raw, /<title>Scheduler<\/title>/, 'and /v1 is still the way back');
  const v2 = await get(port, '/v2');
  assert.match(v2.raw, /<title>LaunchBox<\/title>/, '/v2 keeps working either way');
});

// ------------------------------------------- the switch (cutover phase A)
// docs/plans/2026-10-01-v2-cutover.md: PUT /api/ui-default, validate -> Touch ID
// -> write, and `claude-scheduler ui [v1|v2]` as the only control (the design
// gate refused an on-screen toggle: the flip serves no ranked job).

const OK = { ok: true };
const DENIED = { ok: false, code: 'approval_denied' };

test('ui-default: a bad value is refused before Touch ID is asked, and nothing is written', async (t) => {
  const approval = recordingApprover(OK);
  const { db, server, token, port } = await boot({ approval });
  t.after(() => server.close());
  for (const body of [{ ui: 'v3' }, {}, { ui: 2 }, { ui: 'V2' }]) {
    const r = await api(port, token, 'PUT', '/api/ui-default', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(approval.asked.length, 0, 'validate comes before authorize');
  assert.match((await get(port, '/')).raw, /<title>Scheduler<\/title>/);
});

test('ui-default: a denied Touch ID leaves / on the existing UI', async (t) => {
  const approval = recordingApprover(DENIED);
  const { server, token, port } = await boot({ approval });
  t.after(() => server.close());
  const r = await api(port, token, 'PUT', '/api/ui-default', { ui: 'v2' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'approval_denied');
  assert.equal(approval.asked.length, 1);
  assert.equal(approval.asked[0].action, 'settings.uiDefault');
  assert.match(approval.asked[0].detail, /open the new LaunchBox UI/);
  assert.match((await get(port, '/')).raw, /<title>Scheduler<\/title>/, 'denied = unchanged');
});

test('ui-default: approved, v2 makes / the new UI and v1 switches back; GET /api/settings reports it', async (t) => {
  const approval = recordingApprover(OK);
  const { server, token, port } = await boot({ approval });
  t.after(() => server.close());
  assert.equal((await api(port, token, 'GET', '/api/settings')).body.uiDefault, 'v1', 'ships OFF');
  const on = await api(port, token, 'PUT', '/api/ui-default', { ui: 'v2' });
  assert.equal(on.status, 200);
  assert.deepEqual(on.body, { ui: 'v2' });
  assert.match((await get(port, '/')).raw, /<title>LaunchBox<\/title>/);
  assert.equal((await api(port, token, 'GET', '/api/settings')).body.uiDefault, 'v2');
  const off = await api(port, token, 'PUT', '/api/ui-default', { ui: 'v1' });
  assert.deepEqual(off.body, { ui: 'v1' });
  assert.match((await get(port, '/')).raw, /<title>Scheduler<\/title>/, 'and back');
});

test('ui-default: no bearer token, no switch — and no Touch ID sheet either', async (t) => {
  const approval = recordingApprover(OK);
  const { server, port } = await boot({ approval });
  t.after(() => server.close());
  assert.equal((await api(port, '', 'PUT', '/api/ui-default', { ui: 'v2' })).status, 401);
  assert.equal(approval.asked.length, 0);
});

function cli(port, ...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(ROOT, 'bin', 'claude-scheduler.mjs'), ...args],
      { env: { ...process.env, CS_PORT: String(port) }, timeout: 15000 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}

test('CLI: `ui` prints the default, `ui v2` switches it through the gated route, junk is a usage error', async (t) => {
  const approval = recordingApprover(OK);
  const { server, port } = await boot({ approval });
  t.after(() => server.close());
  const show = await cli(port, 'ui');
  assert.equal(show.code, 0, show.stderr);
  assert.match(show.stdout, /^v1\b/);
  const flip = await cli(port, 'ui', 'v2');
  assert.equal(flip.code, 0, flip.stderr);
  assert.match(flip.stdout, /now opens v2/);
  assert.equal(approval.asked.length, 1, 'the CLI goes through Touch ID, not around it');
  assert.match((await get(port, '/')).raw, /<title>LaunchBox<\/title>/);
  const bad = await cli(port, 'ui', 'v9');
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /usage: claude-scheduler ui \[v1\|v2\]/);
});

test('CLI: a denied Touch ID is reported as a failure, not a switch', async (t) => {
  const approval = recordingApprover(DENIED);
  const { server, port } = await boot({ approval });
  t.after(() => server.close());
  const r = await cli(port, 'ui', 'v2');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not switched/i);
  assert.match((await get(port, '/')).raw, /<title>Scheduler<\/title>/);
});

// --------------------------------------------------------- the parity gate

test('apiCalls normalises template holes so the two UIs are comparable', () => {
  // `/api/jobs/${job.id}` and `/api/jobs/:id` are the same endpoint; a naive
  // string diff reports every parameterised call as a difference.
  const tmp = join(ROOT, 'tests', 'fixtures');
  void tmp;
  const found = apiCalls([join(ROOT, 'public', 'v2', 'pages', 'jobs.js')]);
  assert.ok([...found].some((p) => p === '/api/jobs'), [...found].join(' '));
  assert.ok([...found].some((p) => p === '/api/jobs/:id'), [...found].join(' '));
  // No half-parsed template survives into the surface.
  for (const p of found) assert.ok(!p.includes('${'), `unparsed template leaked: ${p}`);
});

test('covers() treats :id as a wildcard on EITHER side', () => {
  // v2 builds `/api/runs/${id}/${action}` → `/api/runs/:id/:id`, and the
  // existing UI calls the two concrete forms. A one-directional wildcard
  // reported that as an undeclared v2-only endpoint — a false positive, and a
  // parity gate that cries wolf is one nobody reads before a cutover.
  assert.equal(covers('/api/runs/:id/:id', '/api/runs/:id/kill'), true);
  assert.equal(covers('/api/runs/:id/kill', '/api/runs/:id/:id'), true);
  assert.equal(covers('/api/runs/:id', '/api/runs/:id/kill'), false, 'different depths never match');
  assert.equal(covers('/api/jobs/:id', '/api/runs/:id'), false, 'a literal segment still has to match');
});

test('the parity gate is clean, and every difference is declared with a reason', () => {
  const r = compare(loadCalls());
  assert.equal(r.ok, true, r.findings.map((f) => `${f.side}: ${f.endpoint} — ${f.detail}`).join('\n'));
  assert.ok(r.shared > 20, `only ${r.shared} shared endpoints — the comparison is probably not working`);
  for (const a of ACCEPTED) {
    assert.ok(a.why && a.why.length > 40, `${a.endpoint} is declared without a real reason`);
    assert.ok(a.status, `${a.endpoint} has no status`);
  }
});

test('an undeclared difference fails the gate, in either direction', () => {
  // The gate's whole job. Simulated rather than by editing a page, so this
  // stays a unit test.
  const oldCalls = new Set(['/api/jobs', '/api/secret-old-thing']);
  const v2Calls = new Set(['/api/jobs']);
  assert.equal(compare({ oldCalls, v2Calls, accepted: [], resolved: [] }).ok, false);
  assert.equal(compare({ oldCalls: new Set(['/api/jobs']), v2Calls: new Set(['/api/jobs', '/api/new-v2-thing']), accepted: [], resolved: [] }).ok, false);
  // …and declaring it makes it pass.
  assert.equal(compare({
    oldCalls, v2Calls, resolved: [],
    accepted: [{ endpoint: '/api/secret-old-thing', side: 'old-only', status: 'x', why: 'y' }],
  }).ok, true);
});

test('a declared difference that is no longer a difference fails as stale', () => {
  // A stale exemption is how a real gap later slips through unnoticed.
  const both = new Set(['/api/jobs']);
  const r = compare({
    oldCalls: both, v2Calls: both, resolved: [],
    accepted: [{ endpoint: '/api/gone', side: 'old-only', status: 'x', why: 'y' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.findings[0].detail, /no longer one/);
});

test('the keep-awake gap is recorded as CLOSED by the owner\'s 2026-09-23 decision, with /v2 really calling it', () => {
  // btv.15 declared this the one real capability difference the review found:
  // the existing UI could hold the Mac awake on demand (PUT /api/awake) and
  // /v2 could not, because no redesign mockup draws the control. It was pinned
  // as a GAP so it could not be quietly downgraded to "covered" without a
  // human.
  //
  // btv.16: the human decided — 2026-09-23, keep the capability — and /v2 grew
  // the appbar control. So the pin moves rather than disappearing: the record
  // must name the decision, and the CLAIM behind it ("/v2 really calls it") is
  // re-asserted here rather than taken on trust.
  assert.equal(ACCEPTED.find((a) => a.endpoint === '/api/awake'), undefined,
    '/api/awake is no longer a difference, so it must not sit in the exemption list — a dead exemption is how a real gap slips through later');

  const rec = RESOLVED.find((r) => r.endpoint === '/api/awake');
  assert.ok(rec, 'the closed gap must stay on the record, not be deleted');
  assert.equal(rec.status, 'covered');
  assert.equal(rec.decided, '2026-09-23', 'the owner\'s decision date is the whole justification');
  assert.match(rec.why, /keep-awake/i);
  assert.ok(rec.why.length > 40, '/api/awake is recorded without a real reason');

  // The claim, checked against the source: /v2 reads the state AND writes it.
  // A control that only GETs would satisfy a naive "does /v2 mention
  // /api/awake" check while still being unable to hold the Mac awake.
  const v2Src = ['pages/settings.js', 'chrome.js', 'main.js']
    .map((f) => read(join('public/v2', f))).join('\n');
  assert.match(v2Src, /api\('GET', '\/api\/awake'\)/, '/v2 must read the served keep-awake state');
  assert.match(v2Src, /api\('PUT', '\/api\/awake'/, '/v2 must be able to SET the mode, not just read it');

  // …and every mode the old menu offers is still reachable. Dropping one is a
  // capability loss that the endpoint-level parity gate cannot see.
  // Sliced to the menu's OWN closing tag — which is the one on a line of its
  // own; `<div class="menu-head">…</div>` closes inline, and a lazy match to
  // the first `</div>` stopped there and found zero modes (caught by the
  // "measuring nothing" floor below, which is what that floor is for).
  const menu = /id="awake-menu"[\s\S]*?\n\s*<\/div>/.exec(read('public/index.html'))?.[0];
  assert.ok(menu, 'the existing keep-awake menu could not be located — this check is measuring nothing');
  const oldModes = new Set([...menu.matchAll(/data-mode="(\w+)"(?:\s+data-minutes="(\d+)")?/g)]
    .map((m) => (m[2] ? `timed:${m[2]}` : m[1])));
  assert.ok(oldModes.size >= 7, `only found ${oldModes.size} modes in the old menu — this check is measuring nothing`);
  const chrome = read('public/v2/chrome.js');
  const block = /export const AWAKE_CHOICES = Object\.freeze\(\[[\s\S]*?\]\);/.exec(chrome)?.[0];
  assert.ok(block, 'chrome.js must declare its modes as one readable list');
  const v2Modes = new Set([...block.matchAll(/mode: '(\w+)'(?:, minutes: (\d+))?/g)]
    .map((m) => (m[2] ? `timed:${m[2]}` : m[1])));
  assert.deepEqual([...v2Modes].sort(), [...oldModes].sort(),
    '/v2 must offer exactly the modes the existing menu does — no silent drop, no silent addition');
});

test('a closed gap that reopens fails the gate (the mirror of the stale-exemption rule)', () => {
  // The failure this guards: /v2 stops calling /api/awake (a refactor, a
  // deleted control) and the record still reads "covered". A note claiming a
  // capability is covered over a capability that is gone is worse than no note.
  const resolved = [{ endpoint: '/api/awake', was: 'old-only', status: 'covered', decided: '2026-09-23', why: 'y' }];
  const both = new Set(['/api/jobs', '/api/awake']);
  assert.equal(compare({ oldCalls: both, v2Calls: both, accepted: [], resolved }).ok, true);

  const v2Dropped = compare({ oldCalls: both, v2Calls: new Set(['/api/jobs']), accepted: [], resolved });
  assert.equal(v2Dropped.ok, false);
  assert.match(v2Dropped.findings.find((f) => f.endpoint === '/api/awake').detail, /\/v2 no longer calls it/);

  const oldDropped = compare({ oldCalls: new Set(['/api/jobs']), v2Calls: both, accepted: [], resolved });
  assert.equal(oldDropped.ok, false);
  assert.match(oldDropped.findings.find((f) => f.endpoint === '/api/awake').detail, /existing UI no longer calls it/);
});
