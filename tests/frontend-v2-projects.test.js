// Projects tab + project detail (claude-scheduler-btv.9 / C2). Three layers:
//
//  - pure logic (public/v2/pages/projects-logic.js) — the action set per state,
//    the banner a card may show, the burst arithmetic, claim order.
//  - jsdom render/interaction for projects.js and project.js against a mocked
//    fetch — the airlock (the one and only path that can send
//    {state:'active'}), the stranded-state contract, the a11y icon-button
//    contract, and the data-mutating contract.
//  - source-level gates pinning the refusals: the five mockup strings this
//    bead established it cannot truthfully render. A refusal recorded only in
//    a comment does not propagate — this repo has now watched that happen
//    three times (see FORBIDDEN_CLAIMS in frontend-v2-state-vocab.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  fmtTime, fmtDate, relAgo, readyText, readyIsStale, projectActions, isResume,
  summaryBits, cardBanner, priorityPill, claimOrder, beadAge, beadMeta,
  burstSummary, burstProjectIds, chipFor, filterProjects, listSubline, windowLabel, bdVersionText,
} from '../public/v2/pages/projects-logic.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readV2 = (rel) => readFileSync(join(ROOT, 'public', 'v2', rel), 'utf8');

// ---------------------------------------------------------------- pure logic

test('readyText keeps "never polled" and "polled, nothing ready" apart', () => {
  // lib/projects.js's readyFor() returns count:null for "never successfully
  // polled" precisely so the UI can avoid claiming a zero it has not measured.
  assert.equal(readyText({ ready: { count: null } }), 'ready unknown');
  assert.equal(readyText({ ready: { count: 0 } }), '0 ready');
  assert.equal(readyText({ ready: { count: 4 } }), '4 ready');
  assert.equal(readyText({}), 'ready unknown');
});

test('readyIsStale is true only when the last poll is newer than the last good read', () => {
  assert.equal(readyIsStale({ ready: { at: '2026-08-01T08:58:00Z' }, lastPollAt: '2026-08-01T09:12:00Z' }), true);
  assert.equal(readyIsStale({ ready: { at: '2026-08-01T09:12:00Z' }, lastPollAt: '2026-08-01T09:12:00Z' }), false);
  assert.equal(readyIsStale({ ready: { at: null }, lastPollAt: '2026-08-01T09:12:00Z' }), false);
});

test('projectActions: activate is offered only where activating is the next step', () => {
  const acts = (state) => projectActions({ state }).map((a) => a.act);
  assert.deepEqual(acts('pending'), ['poll', 'activate']);
  assert.deepEqual(acts('paused'), ['poll', 'activate']);
  assert.deepEqual(acts('active'), ['poll', 'pause']);
  // `error` is written by the poller, and pausing is how a human stops it
  // retrying — same call the old UI's canPause makes.
  assert.deepEqual(acts('error'), ['poll', 'pause']);
});

test('projectActions: only a pending project gets the primary Touch ID button', () => {
  const primaryOf = (state) => projectActions({ state }).find((a) => a.act === 'activate')?.primary ?? false;
  assert.equal(primaryOf('pending'), true);
  // Resuming a project the human already activated is not a new grant, so it
  // does not wear the airlock's styling or its wording.
  assert.equal(primaryOf('paused'), false);
  assert.equal(projectActions({ state: 'paused' }).find((a) => a.act === 'activate').label, 'Resume');
  assert.equal(projectActions({ state: 'pending' }).find((a) => a.act === 'activate').label, 'Activate…');
  assert.equal(isResume({ state: 'paused' }), true);
  assert.equal(isResume({ state: 'pending' }), false);
});

test('summaryBits states every clause from a field that exists, and omits the rest', () => {
  const bits = summaryBits({
    ready: { count: 4 },
    config: { autoLabel: 'scheduler-ok' },
    lastPollAt: '2026-08-01T09:40:31',
    leases: { held: 1 },
  }, { pollSec: 60 });
  assert.deepEqual(bits, ['4 ready', 'autoLabel scheduler-ok', 'polled 09:40:31', 'every 60s', '1 lease held']);
  // A never-polled project with no label says so rather than printing blanks.
  assert.deepEqual(summaryBits({ ready: { count: null }, leases: { held: 0 } }), ['ready unknown', 'never polled']);
});

test('cardBanner follows the chip precedence: busy outranks a config error', () => {
  // If these two disagreed, a row chipped "bd busy" could explain its config
  // instead — the same one-chip-many-conditions problem projectStateMeta solves.
  const p = { busyStreak: 3, configErrors: ['autoLabel must be a string'], lastError: 'boom' };
  assert.equal(cardBanner(p).kind, 'busy');
  assert.match(cardBanner(p).title, /3 polls in a row/);
});

test('cardBanner reports a busy streak as a count, never as a start time', () => {
  // The mockup says "locked by another process since 09:12". busyStreak is a
  // consecutive-miss counter (lib/projects.js) — there is no start time to say.
  const b = cardBanner({ busyStreak: 1, ready: { count: 1, at: '2026-08-01T08:58:00' }, lastPollAt: '2026-08-01T09:12:00' });
  assert.match(b.title, /1 poll in a row/);
  assert.ok(!/since \d\d:\d\d/.test(`${b.title} ${b.body}`), 'no invented "since HH:MM"');
  // The stale-count sentence IS supported: ready.at and lastPollAt both exist.
  assert.match(b.body, /last good poll \(08:58\)/);
});

test('cardBanner says "would contribute nothing" only when a poll measured it', () => {
  const base = { config: { autoLabel: 'scheduler-ok' } };
  // Never polled: the claim is unmeasured, so it is not made.
  assert.equal(cardBanner({ ...base, ready: { count: null } }), null);
  // Polled, zero eligible: measured, so it is said.
  const b = cardBanner({ ...base, ready: { count: 0 }, lastPollAt: '2026-08-01T09:40:00' });
  assert.match(b.title, /contribute nothing/);
  // …and it never quotes an open-bead count, which no API exposes.
  assert.ok(!/\d+ open beads?/.test(b.body), 'no invented open-bead count');
  // Polled, something eligible: no banner at all.
  assert.equal(cardBanner({ ...base, ready: { count: 2 }, lastPollAt: '2026-08-01T09:40:00' }), null);
});

test('priorityPill inverts priority into emphasis and clamps P4 rather than emitting pill--0', () => {
  assert.deepEqual(priorityPill(0), { cls: 'pill--4', label: 'P0' });
  assert.deepEqual(priorityPill(1), { cls: 'pill--3', label: 'P1' });
  assert.deepEqual(priorityPill(2), { cls: 'pill--2', label: 'P2' });
  assert.deepEqual(priorityPill(3), { cls: 'pill--1', label: 'P3' });
  // bd accepts P4; the mockups never draw it. pill--0 has no CSS rule, so it
  // would render as an unstyled box.
  assert.equal(priorityPill(4).cls, 'pill--1');
  assert.equal(priorityPill(null), null);
});

test('claimOrder is priority then age, and unprioritised beads sort last', () => {
  const beads = [
    { id: 'c', priority: 2, createdAt: '2026-07-01' },
    { id: 'a', priority: 0, createdAt: '2026-07-20' },
    { id: 'd', priority: null, createdAt: '2026-06-01' },
    { id: 'b', priority: 2, createdAt: '2026-06-15' },
  ];
  assert.deepEqual(claimOrder(beads).map((b) => b.id), ['a', 'b', 'c', 'd']);
  // Non-mutating: the caller's array is the live poll result.
  assert.equal(beads[0].id, 'c');
});

test('beadAge degrades through days, hours, then "new"', () => {
  const now = Date.parse('2026-08-01T12:00:00Z');
  assert.equal(beadAge({ createdAt: '2026-07-30T12:00:00Z' }, now), '2d old');
  assert.equal(beadAge({ createdAt: '2026-08-01T09:00:00Z' }, now), '3h old');
  assert.equal(beadAge({ createdAt: '2026-08-01T11:59:00Z' }, now), 'new');
  assert.equal(beadAge({}, now), null);
});

test('beadMeta pluralises and drops empty counts', () => {
  assert.deepEqual(beadMeta({ type: 'bug', dependencyCount: 1, dependentCount: 3, commentCount: 0 }),
    ['bug', '1 dep', 'blocks 3']);
  assert.deepEqual(beadMeta({}), []);
});

test('burstSummary reports MEASURED spend and clamps the meter', () => {
  const now = Date.parse('2026-08-01T10:00:00Z');
  const b = burstSummary({
    id: 'b1', window: 'five_hour', budgetPct: 10, startPct: 37, currentPct: 42.8, runs: 2,
    slots: ['2026-08-01T09:00:00Z', '2026-08-01T10:12:00Z', '2026-08-01T11:00:00Z'],
    projectIds: ['p1'],
  }, { now });
  // 42.8 - 37 = 5.8 measured, not the 10% the timetable was sized against.
  assert.equal(Math.round(b.spentPct * 10) / 10, 5.8);
  assert.equal(Math.round(b.fillPct), 58);
  assert.equal(b.attemptsLeft, 2, 'a slot already in the past is not an attempt left');
  assert.equal(b.nextAt, '2026-08-01T10:12:00Z');
  assert.equal(b.windowLabel, '5-hour');
  // Overshoot must not render a meter wider than its track.
  assert.equal(burstSummary({ budgetPct: 10, startPct: 0, currentPct: 30, slots: [] }, { now }).fillPct, 100);
  assert.equal(burstSummary(null), null);
});

test('windowLabel names the two real windows and degrades readably', () => {
  assert.equal(windowLabel('five_hour'), '5-hour');
  assert.equal(windowLabel('seven_day'), 'weekly');
  assert.equal(windowLabel('thirty_day'), 'thirty day');
});

test('chipFor sources burst membership from the burst, not the project', () => {
  // burst membership is on the burst payload's projectIds — a project row has
  // no field for it, which is exactly why this wrapper exists.
  const ids = burstProjectIds({ projectIds: ['p1'] });
  assert.equal(chipFor({ id: 'p1', state: 'active' }, ids).label, 'burst');
  assert.equal(chipFor({ id: 'p2', state: 'active' }, ids).label, 'active');
  // bd busy still outranks burst (the documented precedence in state-vocab.js).
  assert.equal(chipFor({ id: 'p1', state: 'active', busyStreak: 2 }, ids).label, 'bd busy');
});

test('filterProjects matches name and path', () => {
  const ps = [{ name: 'webapp-billing', path: '/a/b' }, { name: 'infra', path: '/x/billing-infra' }];
  assert.equal(filterProjects(ps, 'billing').length, 2);
  assert.equal(filterProjects(ps, 'webapp').length, 1);
  assert.equal(filterProjects(ps, '').length, 2);
});

test('listSubline omits the bd version when the probe failed rather than printing "unknown"', () => {
  const withBd = listSubline({ projects: [{ state: 'active' }, { state: 'pending' }], pollSec: 60, bd: { version: '0.9.4' } });
  assert.deepEqual(withBd, ['2 registered', '1 active', 'beads polled every 60s', 'bd 0.9.4']);
  const noBd = listSubline({ projects: [], bd: { error: 'not found', version: null } });
  assert.deepEqual(noBd, ['0 registered', '0 active']);
});

test('time helpers return null rather than "Invalid Date" or "NaN"', () => {
  assert.equal(fmtTime(null), null);
  assert.equal(fmtTime('not a date'), null);
  assert.equal(fmtDate('not a date'), null);
  assert.equal(relAgo(null), null);
  assert.equal(relAgo('2026-08-01T09:59:00Z', Date.parse('2026-08-01T10:00:00Z')), '1m ago');
});

// ------------------------------------------------------- source-level gates
//
// The refusals, encoded. Each of these strings is in the mockup and each is
// unsupported by any field the API exposes; a comment saying so did not stop
// the same claim shipping on a different page three times already.

const UNSUPPORTED_ON_PROJECT_PAGES = [
  { re: /\bof \d+ open\b/, why: 'no open-bead count exists — lib/beads.js only ever calls `bd ready`' },
  { re: /blocked by dependencies/, why: '`bd ready` filters those out server-side; they never reach us to be counted' },
  { re: /missing the .{0,24}label/, why: 'same — a bead without the label is never returned' },
  { re: /activated by you on/, why: 'the projects table has no activation stamp; updatedAt moves on every poll' },
  { re: /[Pp]aused by you on/, why: 'same — no pause stamp exists' },
  { re: /locked by another process since/, why: 'busyStreak is a consecutive-miss count, not a start time' },
  // "closed with TASK-COMPLETE" is NOT listed any more. claude-scheduler-dc9
  // persisted the outcome as runs.beadOutcome ('closed' | 'handed-back' |
  // 'stranded'), so the distinction this rule existed to forbid is now a real
  // field the project page reads — see the handed_back chip in state-vocab.js.
  // The rule was lifted with the limitation, not kept with a stale reason: a
  // gate whose stated why is false is one the next reader deletes for the
  // wrong reason.
];

test('no C2 page states a project fact the API cannot back', () => {
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const offenders = [];
  for (const f of ['pages/projects.js', 'pages/project.js', 'pages/projects-logic.js']) {
    const src = stripComments(readV2(f));
    for (const c of UNSUPPORTED_ON_PROJECT_PAGES) {
      if (c.re.test(src)) offenders.push(`${f}: ${c.re} — ${c.why}`);
    }
  }
  assert.deepEqual(offenders, [], `these render claims the API does not support:\n${offenders.join('\n')}`);
});

test('exactly one line in all of /v2 can send a project to the active state', () => {
  // The airlock is a single call site by construction, not by convention. If a
  // second one appears — a "quick activate" on the detail page, a bulk action —
  // this goes red and the reviewer has to look at it.
  // Comments are stripped first. Without this the gate counts its own
  // explanation — the identical defect the FORBIDDEN_CLAIMS gate hit, caught
  // here by the gate failing on its first run rather than by review.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const sites = [];
  for (const f of ['pages/projects.js', 'pages/project.js']) {
    const src = stripComments(readV2(f));
    for (const m of src.matchAll(/state:\s*'active'/g)) {
      sites.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.equal(sites.length, 2, `expected one activation call site per page, found: ${sites.join(', ')}`);
  for (const f of ['pages/projects.js', 'pages/project.js']) {
    const src = stripComments(readV2(f));
    // …and each of them is preceded by a human confirm in the same function.
    assert.match(src, /window\.confirm\([\s\S]{0,1200}?state:\s*'active'/,
      `${f}: the activation call is not behind a window.confirm() spelling out the consequence`);
  }
});

test('the activation confirm states that runs happen unattended and while away', () => {
  for (const f of ['pages/projects.js', 'pages/project.js']) {
    const src = readV2(f);
    assert.match(src, /unattended/, `${f}: the confirm must say runs are unattended`);
    assert.match(src, /away from the machine/, `${f}: the confirm must say it applies while the human is away`);
  }
});

// ---------------------------------------------------------------- jsdom

function mountDom() {
  const dom = new JSDOM('<!doctype html><body><main><div id="v2-page"></div></main></body>', { url: 'http://localhost/v2/' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.localStorage = dom.window.localStorage;
  // router.js reads bare `location`/`history` (a browser global), so a test
  // that drives the real router has to provide them too.
  global.location = dom.window.location;
  global.history = dom.window.history;
  return dom;
}

function mockFetch(routes) {
  const calls = [];
  global.fetch = async (path, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body ? JSON.parse(opts.body) : null });
    const key = `${method} ${path}`;
    const hit = routes[key] ?? routes[path];
    if (!hit) return { ok: false, status: 404, text: async () => JSON.stringify({ error: `no mock for ${key}` }) };
    if (hit instanceof Error) throw hit;
    return { ok: true, status: 200, text: async () => JSON.stringify(typeof hit === 'function' ? hit() : hit) };
  };
  return calls;
}

const PROJECT = {
  id: 'p1',
  name: 'webapp-billing',
  path: '/Users/x/webapp-billing',
  state: 'pending',
  config: { autoLabel: 'scheduler-ok', defaults: { permMode: 'acceptEdits' }, budget: { minHeadroomPct: 15 } },
  configErrors: [],
  reasons: ['waiting for you to activate it'],
  warnings: [],
  busyStreak: 0,
  ready: { count: 4, at: '2026-08-01T09:40:31' },
  leases: { held: 0 },
  lastPollAt: '2026-08-01T09:40:31',
  createdAt: '2026-07-29T10:00:00',
};

const projectsPayload = (over = {}) => ({
  projects: [{ ...PROJECT, ...over }],
  bd: { version: '0.9.4', error: null, path: 'bd' },
  roots: ['/Users/x'],
  pollSec: 60,
  auditNote: 'AUDIT NOTE FROM SERVER',
});

const settle = () => new Promise((r) => setTimeout(r, 0));

test('jsdom: the Projects list renders a card, the airlock button and the server audit note', async () => {
  mountDom();
  mockFetch({ '/api/projects': projectsPayload(), '/api/bursts': { active: null } });
  const { default: projects } = await import(`../public/v2/pages/projects.js?case=list${Date.now()}`);
  projects(new URLSearchParams());
  await settle(); await settle();

  const page = document.querySelector('#v2-page');
  assert.match(page.textContent, /webapp-billing/);
  assert.match(page.textContent, /AUDIT NOTE FROM SERVER/, 'the server owns the audit wording');
  const activate = page.querySelector('[data-act=activate]');
  assert.ok(activate, 'a pending project offers Activate');
  assert.equal(activate.textContent, 'Activate…');
  assert.match(activate.getAttribute('data-tip'), /Touch ID/);
  assert.equal(activate.getAttribute('data-mutating'), '');
});

test('jsdom: Activate does nothing at all when the confirm is declined', async () => {
  mountDom();
  const calls = mockFetch({ '/api/projects': projectsPayload(), '/api/bursts': { active: null } });
  window.confirm = () => false;
  const { default: projects } = await import(`../public/v2/pages/projects.js?case=deny${Date.now()}`);
  projects(new URLSearchParams());
  await settle(); await settle();

  calls.length = 0;
  document.querySelector('[data-act=activate]').click();
  await settle(); await settle();
  assert.deepEqual(calls.filter((c) => c.method === 'PUT'), [], 'a declined confirm must issue no request at all');
});

test('jsdom: Activate sends exactly {state:"active"} and nothing else', async () => {
  mountDom();
  const calls = mockFetch({
    '/api/projects': projectsPayload(),
    '/api/bursts': { active: null },
    'PUT /api/projects/p1': { project: { ...PROJECT, state: 'active' }, reasons: [], warnings: [] },
  });
  window.confirm = () => true;
  const { default: projects } = await import(`../public/v2/pages/projects.js?case=activate${Date.now()}`);
  projects(new URLSearchParams());
  await settle(); await settle();

  document.querySelector('[data-act=activate]').click();
  await settle(); await settle(); await settle();
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put, 'the confirmed activation reached the server');
  assert.equal(put.path, '/api/projects/p1');
  // The server refuses any other key, but the point is that the UI never even
  // offers to send one — activation is one fact, not a patch.
  assert.deepEqual(put.body, { state: 'active' });
});

test('jsdom: register and discover never send a state, so neither can activate', async () => {
  mountDom();
  const calls = mockFetch({
    '/api/projects': projectsPayload(),
    '/api/bursts': { active: null },
    'POST /api/projects': { project: { ...PROJECT, name: 'newrepo' }, errors: [] },
    'POST /api/projects/discover': { found: [], roots: ['/Users/x'] },
  });
  const { default: projects } = await import(`../public/v2/pages/projects.js?case=reg${Date.now()}`);
  projects(new URLSearchParams());
  await settle(); await settle();

  document.querySelector('#projects-path').value = '/Users/x/newrepo';
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Register').click();
  await settle(); await settle();
  [...document.querySelectorAll('button')].find((b) => /Discover/.test(b.textContent)).click();
  await settle(); await settle();

  const posts = calls.filter((c) => c.method === 'POST');
  assert.ok(posts.length >= 2, 'both actions reached the server');
  for (const p of posts) {
    assert.ok(!('state' in (p.body ?? {})), `${p.path} sent a state — registering and discovering must never activate`);
  }
});

test('jsdom: a first load that fails renders an explained state, never a blank page', async () => {
  mountDom();
  global.fetch = async () => { throw new TypeError('connection refused'); };
  const { default: projects } = await import(`../public/v2/pages/projects.js?case=down${Date.now()}`);
  projects(new URLSearchParams());
  await settle(); await settle();

  const page = document.querySelector('#v2-page');
  assert.ok(page.textContent.trim().length > 0, 'the page is not blank');
  assert.match(page.textContent, /Could not read your projects/);
  assert.match(page.textContent, /Try again/);
  // The heading is still there, so the reader knows which route they are on.
  assert.match(page.querySelector('h1').textContent, /Projects/);
});

test('jsdom: the empty state names the roots problem rather than reporting "found 0"', async () => {
  mountDom();
  mockFetch({ '/api/projects': { projects: [], bd: { version: '0.9.4' }, roots: [], pollSec: 60 }, '/api/bursts': { active: null } });
  const { default: projects } = await import(`../public/v2/pages/projects.js?case=empty${Date.now()}`);
  projects(new URLSearchParams());
  await settle(); await settle();

  const page = document.querySelector('#v2-page');
  assert.match(page.textContent, /No project can be worked on yet/);
  assert.match(page.textContent, /no project roots are configured/i);
  assert.match(page.textContent, /nothing runs until you activate/i);
});

test('jsdom: the burst strip shows measured spend and offers Cancel', async () => {
  mountDom();
  const calls = mockFetch({
    '/api/projects': projectsPayload({ state: 'active', reasons: [] }),
    '/api/bursts': {
      active: {
        id: 'b1', window: 'five_hour', budgetPct: 10, startPct: 37, currentPct: 42.8, runs: 2,
        slots: ['2999-01-01T00:00:00Z'], projectIds: ['p1'],
      },
    },
    'POST /api/bursts/b1/cancel': { ok: true },
  });
  const { default: projects } = await import(`../public/v2/pages/projects.js?case=burst${Date.now()}`);
  projects(new URLSearchParams());
  await settle(); await settle();

  const strip = document.querySelector('.burststrip');
  assert.ok(strip, 'the strip is rendered while a burst is live');
  assert.match(strip.textContent, /5\.80% \/ 10%/, 'measured spend, not the 10% budget');
  // jsdom's CSSOM normalises "58.0%" to "58%", so assert the value, not its spelling.
  assert.equal(Math.round(parseFloat(strip.querySelector('.meter__fill').style.width)), 58);
  // The project in the burst is chipped `burst`, sourced from projectIds.
  assert.match(document.querySelector('.card__head .state').textContent, /burst/);

  calls.length = 0;
  [...strip.querySelectorAll('button')].find((b) => /Cancel burst/.test(b.textContent)).click();
  await settle(); await settle();
  assert.ok(calls.some((c) => c.path === '/api/bursts/b1/cancel' && c.method === 'POST'));
});

test('jsdom: the burst planner opens when idle and is dead — un-revivably — while a burst runs', async () => {
  // This test previously asserted the button was dead because D2 had not
  // landed. D2 (claude-scheduler-btv.12) landed, so the contract changed and
  // the test went red, which is the system working. The rule it now pins is
  // the one that outlives the bead: the button is live when idle, and while a
  // burst is running it is disabled for a BUSINESS reason and therefore must
  // NOT carry data-mutating — the central degraded-state sweep re-enables
  // every data-mutating control when the daemon comes back, and that must not
  // revive a control the running burst is what disables.
  mountDom();
  mockFetch({ '/api/projects': projectsPayload(), '/api/bursts': { active: null } });
  const { default: projects } = await import(`../public/v2/pages/projects.js?case=planner${Date.now()}`);
  projects(new URLSearchParams());
  await settle(); await settle();

  let btn = [...document.querySelectorAll('button')].find((b) => /Start a burst/.test(b.textContent));
  assert.equal(btn.disabled, false, 'with no burst running the planner opens');
  assert.equal(btn.getAttribute('data-mutating'), '', 'and it IS swept by the degraded-state sweep');

  mountDom();
  mockFetch({
    '/api/projects': projectsPayload(),
    '/api/bursts': { active: { id: 'b1', window: 'five_hour', budgetPct: 10, startPct: 1, currentPct: 2, runs: 0, slots: [], projectIds: [] } },
  });
  const { default: projects2 } = await import(`../public/v2/pages/projects.js?case=planner2${Date.now()}`);
  projects2(new URLSearchParams());
  await settle(); await settle();

  btn = [...document.querySelectorAll('button')].find((b) => /Start a burst/.test(b.textContent));
  assert.equal(btn.disabled, true, 'a live burst disables it');
  assert.equal(btn.getAttribute('data-mutating'), null, 'and the sweep must not be able to revive it');
  assert.match(btn.getAttribute('data-tip'), /already running/);
});

test('jsdom: every icon-only control on the list is named for assistive tech', async () => {
  mountDom();
  mockFetch({ '/api/projects': projectsPayload(), '/api/bursts': { active: null } });
  const { default: projects } = await import(`../public/v2/pages/projects.js?case=a11y${Date.now()}`);
  projects(new URLSearchParams());
  await settle(); await settle();

  const icons = [...document.querySelectorAll('.iconbtn')];
  assert.ok(icons.length >= 1, 'there is at least one icon button to check');
  for (const b of icons) {
    assert.ok(b.getAttribute('aria-label'), 'every iconbtn carries an aria-label (REVIEW #5)');
    assert.ok(b.getAttribute('data-tip'), 'every iconbtn carries a focus-visible tooltip');
  }
});

test('jsdom: project detail renders the facts, the ready table in claim order, and the declared config', async () => {
  mountDom();
  mockFetch({
    '/api/projects': projectsPayload({ state: 'active', reasons: [] }),
    '/api/bursts': { active: null },
    '/api/projects/p1/ready': {
      autoLabel: 'scheduler-ok',
      busy: false,
      reasons: [],
      beads: [
        { id: 'wb-224', title: 'Add retry', priority: 2, type: 'feature', labels: ['scheduler-ok'], createdAt: '2026-07-29T00:00:00Z', dependentCount: 0 },
        { id: 'wb-221', title: 'Fix rounding', priority: 0, type: 'bug', labels: ['scheduler-ok'], createdAt: '2026-07-30T00:00:00Z', dependentCount: 3 },
      ],
    },
    '/api/jobs': { jobs: [{ id: 'j1', name: 'bead wb-142', params: { _projectId: 'p1', _beadId: 'wb-142' } }] },
    '/api/runs?limit=200': { runs: [{ id: 'r1', jobId: 'j1', status: 'ok', startedAt: '2026-08-01T09:00:00Z', finishedAt: '2026-08-01T09:14:51Z', meta: {} }] },
  });
  const { default: project } = await import(`../public/v2/pages/project.js?case=detail${Date.now()}`);
  project(new URLSearchParams('id=p1'));
  await settle(); await settle(); await settle();

  const page = document.querySelector('#v2-page');
  assert.match(page.textContent, /webapp-billing/);
  // facts
  assert.match(page.textContent, /acceptEdits/);
  assert.match(page.textContent, /15%/);
  // claim order: P0 first even though it is the newer bead
  const beadIds = [...page.querySelectorAll('.beadrow:not(.row--head) .mono')].map((n) => n.textContent);
  assert.equal(beadIds[0], 'wb-221', 'the P0 bead is claimed first');
  // declared config verbatim
  assert.match(page.querySelector('.snippet').textContent, /"autoLabel": "scheduler-ok"/);
  // activity joined from jobs+runs by params._projectId
  assert.match(page.textContent, /bead wb-142/);
});

test('jsdom: project detail says which project is missing rather than rendering an empty shell', async () => {
  mountDom();
  mockFetch({ '/api/projects': { projects: [], bd: {}, roots: [], pollSec: 60 }, '/api/bursts': { active: null } });
  const { default: project } = await import(`../public/v2/pages/project.js?case=missing${Date.now()}`);
  project(new URLSearchParams('id=nope'));
  await settle(); await settle();

  const page = document.querySelector('#v2-page');
  assert.match(page.textContent, /not registered any more/);
  assert.match(page.textContent, /Back to Projects/);
});

test('jsdom: a busy ready read is reported as busy-not-broken, keeping the last good list', async () => {
  mountDom();
  mockFetch({
    '/api/projects': projectsPayload({ state: 'active', reasons: [], busyStreak: 2 }),
    '/api/bursts': { active: null },
    '/api/projects/p1/ready': { beads: [], busy: true, reasons: ['beads database is busy'], health: { busy: true }, autoLabel: 'scheduler-ok' },
    '/api/jobs': { jobs: [] },
    '/api/runs?limit=200': { runs: [] },
  });
  const { default: project } = await import(`../public/v2/pages/project.js?case=busy${Date.now()}`);
  project(new URLSearchParams('id=p1'));
  await settle(); await settle(); await settle();

  const page = document.querySelector('#v2-page');
  assert.match(page.textContent, /busy, not broken/);
  // The page-level chip agrees with the banner — both come from busyStreak.
  assert.match(page.querySelector('.state').textContent, /bd busy/);
});

// -------------------------------------------------- the stale-render defect
//
// Found by driving C2 in a real browser, not by any test that existed: with a
// slow API, navigating Projects → project detail → Projects rendered the
// DETAIL page under the Projects route, and the reverse in the other
// direction. Clearing a page's poll timer on route change does not fix it —
// the request already in the air still resolves and calls that page's
// render(), which clears #v2-page and rebuilds it for a route the user has
// already left. Every /v2 page that rebuilds #v2-page wholesale had the same
// shape, so all five were fixed, and the gate below stops a sixth reintroducing
// it.

test('bdVersionText strips the word bd rather than printing it twice', () => {
  // `bd --version` stdout is a sentence, not a number (lib/beads.js returns it
  // verbatim). The browser leg rendered "bd bd version 1.1.0 (Homebrew)".
  assert.equal(bdVersionText('bd version 1.1.0 (Homebrew)'), '1.1.0 (Homebrew)');
  assert.equal(bdVersionText('bd 0.9.4'), '0.9.4');
  assert.equal(bdVersionText('0.9.4'), '0.9.4');
  // Anything unexpected passes through rather than being guessed at.
  assert.equal(bdVersionText('some future banner'), 'some future banner');
  assert.equal(bdVersionText(null), '');
});

test('every /v2 page that rebuilds #v2-page refuses to paint a route it no longer owns', () => {
  // A source gate, because this is a defect five pages shared: a comment on
  // one page would not have stopped the other four, and did not.
  const offenders = [];
  for (const f of ['pages/projects.js', 'pages/project.js', 'pages/jobs.js', 'pages/overview.js', 'pages/settings.js']) {
    const src = readV2(f);
    if (!/clear\(page\)/.test(src)) continue; // this page does not rebuild the shell
    const declares = /let mounted = false;/.test(src);
    const guards = /if \(!mounted\) return;/.test(src);
    const clears = /mounted = route === '[a-z]+';/.test(src);
    const sets = /\bmounted = true;/.test(src);
    if (!(declares && guards && clears && sets)) offenders.push(`${f} (declares=${declares} guards=${guards} clearsOnRouteChange=${clears} setsOnMount=${sets})`);
  }
  assert.deepEqual(offenders, [], `these pages can paint over another route's content:\n${offenders.join('\n')}`);
});

test('jsdom: a slow load that resolves after navigation does not paint over the new route', async () => {
  mountDom();
  // /api/projects is held open until we release it, so its render() lands
  // *after* the route has already moved on — exactly the browser timing.
  let release;
  const held = new Promise((r) => { release = r; });
  global.fetch = async (path, opts = {}) => {
    const body = { projects: [PROJECT], bd: { version: 'bd 0.9.4' }, roots: [], pollSec: 60, auditNote: 'AUDIT' };
    if (path === '/api/projects') {
      await held;
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }
    const map = {
      '/api/bursts': { active: null },
      '/api/jobs': { jobs: [] },
      '/api/runs?limit=200': { runs: [] },
      '/api/projects/p1/ready': { beads: [], busy: false, reasons: [], autoLabel: 'scheduler-ok' },
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(map[path] ?? {}) };
  };

  // NOT cache-busted: the page module imports the canonical '../router.js', so
  // a query-string copy here would be a SECOND router instance and the page's
  // onRender subscription would be on the one this test never drives. (That is
  // exactly what the first version of this test did, and it failed — correctly.)
  const { registerRoute, startRouter } = await import('../public/v2/router.js');
  const { default: projects } = await import(`../public/v2/pages/projects.js?stale=${Date.now()}`);
  registerRoute('projects', projects);
  // A stand-in for the route the user navigates TO: it owns #v2-page after the
  // hash change, and must still own it when the held request finally lands.
  registerRoute('overview', () => {
    const p = document.querySelector('#v2-page');
    p.textContent = 'THE OTHER ROUTE';
  });

  window.location.hash = '#projects';
  await startRouter();
  await settle();

  window.location.hash = '#overview';
  await startRouter();
  await settle();
  assert.equal(document.querySelector('#v2-page').textContent, 'THE OTHER ROUTE');

  release();
  await settle(); await settle(); await settle();
  assert.equal(document.querySelector('#v2-page').textContent, 'THE OTHER ROUTE',
    'the Projects load resolved after the user left and repainted the page they are on');
});

// ------------------------------------------- the slow-first-paint defect
//
// Also found in a browser, not by a test: project.js's first load includes
// GET /api/projects/:id/ready, which runs a real blocking `bd ready` against
// the repo — seconds. Until it returned, render() had not run, so #v2-page
// still held whatever page the reader came FROM. Clicking "Open project" left
// the Projects list on screen, unchanged, with nothing to say a navigation had
// happened. runs.js and overview.js already painted a "Loading…" shell first;
// these two did not.

test('jsdom: opening a project paints its own shell before the slow ready call returns', async () => {
  mountDom();
  // The list is on screen first — this is the content that must NOT survive.
  document.querySelector('#v2-page').textContent = 'THE PROJECTS LIST';

  let release;
  const held = new Promise((r) => { release = r; });
  global.fetch = async (path) => {
    // Every call this page makes is held, so nothing has resolved at the
    // moment we assert — exactly the window the reader was stuck in.
    await held;
    return { ok: true, status: 200, text: async () => JSON.stringify({}) };
  };

  const { default: project } = await import(`../public/v2/pages/project.js?shell=${Date.now()}`);
  project(new URLSearchParams('id=p1'));
  await settle();

  const page = document.querySelector('#v2-page');
  assert.ok(!/THE PROJECTS LIST/.test(page.textContent),
    'the previous page is still on screen while this one loads');
  assert.match(page.textContent, /Project/);
  assert.match(page.textContent, /beads/, 'the shell says what it is waiting for');
  assert.ok(page.querySelector('a[href="#projects"]'), 'the way back is available immediately');
  release();
});

test('jsdom: opening Projects paints its own shell before the first load returns', async () => {
  mountDom();
  document.querySelector('#v2-page').textContent = 'SOME OTHER PAGE';
  let release;
  const held = new Promise((r) => { release = r; });
  global.fetch = async () => { await held; return { ok: true, status: 200, text: async () => JSON.stringify({}) }; };

  const { default: projects } = await import(`../public/v2/pages/projects.js?shell=${Date.now()}`);
  projects(new URLSearchParams());
  await settle();

  const page = document.querySelector('#v2-page');
  assert.ok(!/SOME OTHER PAGE/.test(page.textContent), 'the previous page is still on screen while this one loads');
  assert.match(page.querySelector('h1').textContent, /Projects/);
  release();
});

test('every /v2 page paints a shell before its first load, not after it', () => {
  // A source gate, because this is the second defect in this bead that four
  // pages shared and one page's comment would not have propagated.
  const offenders = [];
  for (const f of ['pages/projects.js', 'pages/project.js', 'pages/runs.js', 'pages/overview.js']) {
    const src = readV2(f);
    // The entry function must reach a pageHead() before it reaches its first
    // await/load — i.e. a pageHead call appears in the same function body
    // ahead of the loadAndRender()/load() call.
    const entry = /export default function \w+\(params\)\s*\{[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    // One level of indirection is resolved: a page may paint its shell through
    // a named helper (runs.js's mountShell()) rather than calling pageHead()
    // inline. The first version of this gate only looked for a literal
    // pageHead( and went red when 7j2's fix extracted exactly such a helper —
    // a false positive on a page that had just been made MORE correct.
    const inlined = entry.replace(/\b([a-z]\w*)\(\)/g, (whole, name) => {
      const helper = new RegExp(`function ${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(src)?.[0];
      return helper && /pageHead\(/.test(helper) ? 'pageHead()' : whole;
    });
    const headAt = inlined.search(/pageHead\(/);
    const loadAt = inlined.search(/load(AndRender)?\(\)/);
    if (headAt === -1 || (loadAt !== -1 && headAt > loadAt)) offenders.push(`${f} (head@${headAt} load@${loadAt})`);
  }
  assert.deepEqual(offenders, [], `these pages leave the previous route on screen while they load:\n${offenders.join('\n')}`);
});

test('jsdom: the failed-load card does not also claim to be loading', async () => {
  // Caught in the browser leg: the pagehead read "Loading…" directly above
  // "Could not read your projects".
  mountDom();
  global.fetch = async () => { throw new TypeError('connection refused'); };
  const { default: projects } = await import(`../public/v2/pages/projects.js?sub=${Date.now()}`);
  projects(new URLSearchParams());
  await settle(); await settle();
  const sub = document.querySelector('.pagehead__sub')?.textContent ?? '';
  assert.ok(!/Loading/.test(sub), `the subline still claims to be loading: "${sub}"`);
  assert.match(document.querySelector('#v2-page').textContent, /Could not read your projects/);
});
