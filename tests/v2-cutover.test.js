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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// A minimal boot, the same shape tests/api.test.js uses: a real listening
// server, because the thing under test is which FILE a path serves — which
// express.static and route ordering decide, not any function we could call.
async function boot() {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const runner = createRunner({ db, extensions, spawnFn: () => {}, notifyFn: () => {} });
  const scheduler = createScheduler({ db, runner });
  const app = createApp({ db, runner, scheduler, extensions, awake: null, token: ensureToken() });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { db, server, port: server.address().port };
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

test('the cutover flag ships OFF, and nothing in the repo turns it on', () => {
  const src = read('server.js');
  assert.match(src, /getSetting\(db, 'v2Default', '0'\)/, 'the default must be off');
  // The only place the value is READ. A second reader could disagree with this
  // one about what "on" means.
  assert.equal((src.match(/'v2Default'/g) ?? []).length, 1);
  // …and nothing anywhere WRITES it. The flip is a human action against a
  // running instance, not something the repo can do to itself — the same rule
  // as "an agent may prepare, but never activate".
  const writers = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      // `tests/` is excluded on purpose: this very file flips the setting in a
      // throwaway DB to test the flipped state, which is how the flipped state
      // gets tested at all. What must never write it is PRODUCTION code —
      // server.js, lib/, bin/, tools/, public/ — because the flip is the
      // owner's click against a running instance.
      if (['node_modules', '.git', '.beads', 'tests', 'redesign', 'working_prototype_screenshots'].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs)$/.test(name)) continue;
      const s2 = readFileSync(p, 'utf8');
      if (/setSetting\([^)]*v2Default/.test(s2)) writers.push(p);
    }
  };
  walk(ROOT);
  assert.deepEqual(writers, [], `these files set v2Default: ${writers.join(', ')}`);
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
