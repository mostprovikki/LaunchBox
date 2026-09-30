// Project page as Workbench (claude-scheduler-btv.24). docs/design/launchbox.md
// §5 "Project (Workbench)": Burst primary; activate/pause as the one state
// control; Poll now / Dependency graph / Remove project… in a ⋯ menu; three
// facts; Up next + Recent runs on one grid; a collapsed Declared config. Owner
// chose Option 2 of docs/design/mockups/project-flavours.html on 2026-09-26.
//
// jsdom + mocked fetch, the harness shape of tests/frontend-v2-projects.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  shortBeadId, permModeText, projectBurst, stateControl, unblocksText,
} from '../public/v2/pages/projects-logic.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// project.js arms a real poll interval off module-scope state; a fresh module
// per test would accumulate timers and keep the process alive.
// The last armed poll callback is kept so a test can fire one tick by hand.
let pollTick = null;
globalThis.setInterval = (fn) => { pollTick = fn; return {}; };
globalThis.clearInterval = () => {};

function mountDom() {
  const dom = new JSDOM('<!doctype html><body><main><div id="v2-page"></div></main></body>',
    { url: 'http://localhost/v2/#project?id=p1', pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.localStorage = dom.window.localStorage;
  global.location = dom.window.location;
  global.history = dom.window.history;
  return dom;
}

const PROJECT = {
  id: 'p1',
  name: 'webapp-billing',
  path: '/Users/x/webapp-billing',
  state: 'active',
  config: { autoLabel: 'scheduler-ok', defaults: { permMode: 'auto', timeoutMin: 180 }, budget: { minHeadroomPct: 15 } },
  configErrors: [],
  reasons: [],
  warnings: [],
  busyStreak: 0,
  ready: { count: 2, at: '2026-08-01T09:40:31Z' },
  leases: { held: 1 },
  lastPollAt: new Date(Date.now() - 25 * 60000).toISOString(),
  createdAt: '2026-07-29T10:00:00Z',
};

const BEADS = [
  { id: 'webapp-billing-a1b2.3', title: 'Add retry', priority: 2, type: 'feature', labels: ['scheduler-ok'], createdAt: new Date(Date.now() - 2 * 86400000).toISOString(), dependentCount: 0 },
  { id: 'webapp-billing-c9d8', title: 'Fix rounding', priority: 0, type: 'bug', labels: ['scheduler-ok'], createdAt: new Date(Date.now() - 3 * 3600000).toISOString(), dependentCount: 3 },
];
const JOB = { id: 'j1', name: 'webapp-billing: Migrate invoice templates', params: { _projectId: 'p1', _beadId: 'webapp-billing-e5f6.1' } };
const RUN = { id: 'r1', jobId: 'j1', status: 'ok', beadOutcome: 'handed-back', startedAt: '2026-08-01T09:00:00Z', finishedAt: '2026-08-01T09:14:51Z' };

function mockFetch(over = {}) {
  const calls = [];
  const routes = {
    'GET /api/projects': { projects: [{ ...PROJECT, ...(over.project ?? {}) }], bd: { version: '1.1.0' }, roots: [], pollSec: 60 },
    'GET /api/projects/p1/ready': { autoLabel: 'scheduler-ok', busy: false, reasons: [], beads: BEADS },
    'GET /api/jobs': { jobs: [JOB] },
    'GET /api/runs?limit=200': { runs: [RUN] },
    'GET /api/bursts': { active: over.burst ?? null },
    'GET /api/pause': { mode: over.pause ?? 'off' },
    'GET /api/v2/projects/p1/branches': { branches: over.branches ?? [] },
    'GET /api/runs/r1/log': 'LOG TEXT',
    'POST /api/projects/p1/poll': { ready: [], started: [] },
    'DELETE /api/projects/p1': { removedJobs: 0 },
    'PUT /api/projects/p1': { project: PROJECT, reasons: [], warnings: [] },
    ...over.routes,
  };
  global.fetch = async (path, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body ? JSON.parse(opts.body) : null });
    const hit = routes[`${method} ${path}`];
    if (hit === undefined) return { ok: false, status: 404, text: async () => JSON.stringify({ error: `no mock for ${method} ${path}` }) };
    return { ok: true, status: 200, text: async () => (typeof hit === 'string' ? hit : JSON.stringify(hit)) };
  };
  return calls;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

async function mount(tag, over) {
  mountDom();
  const calls = mockFetch(over);
  const mod = await import(`../public/v2/pages/project.js?b24=${tag}${Date.now()}`);
  mod.default(new URLSearchParams('id=p1'));
  for (let i = 0; i < 6; i += 1) await settle();
  return { calls, page: document.querySelector('#v2-page') };
}

const head = () => document.querySelector('.pagehead__actions');
const more = () => head().querySelector('[aria-haspopup=menu]');
const menu = () => head().querySelector('[role=menu]');
const outsideMenu = (root) => [...root.querySelectorAll('button, a')].filter((n) => !n.closest('[role=menu]'));

// ---------------------------------------------------------------- pure logic

test('shortBeadId drops the project prefix, keeping the hash (launchbox.md §6)', () => {
  assert.equal(shortBeadId('system_migration-85ht.1'), '85ht.1');
  // A hyphenated prefix: the id is what follows the LAST hyphen.
  assert.equal(shortBeadId('claude-scheduler-btv.24'), 'btv.24');
  assert.equal(shortBeadId('nohyphen'), 'nohyphen');
  assert.equal(shortBeadId(null), '');
});

test('unblocksText only when something is actually unblocked', () => {
  assert.equal(unblocksText({ dependentCount: 0 }), null);
  assert.equal(unblocksText({}), null);
  assert.equal(unblocksText({ dependentCount: 3 }), 'unblocks 3');
});

test('permModeText says what the mode lets an unattended agent do, and never guesses an unknown one', () => {
  assert.match(permModeText('auto'), /without asking/);
  assert.equal(permModeText('something-new'), 'from .scheduler.json');
  assert.equal(permModeText(null), 'none declared');
});

test('stateControl: exactly one state action per project state', () => {
  assert.deepEqual(stateControl({ state: 'pending' }), { act: 'activate', label: 'Activate…', tip: 'Asks for Touch ID — this is the airlock' });
  assert.equal(stateControl({ state: 'paused' }).label, 'Resume');
  assert.equal(stateControl({ state: 'active' }).label, 'Pause');
  assert.equal(stateControl({ state: 'error' }).act, 'pause');
  // The airlock's styling belongs to Burst now; the state control is never primary.
  for (const s of ['pending', 'paused', 'active']) assert.ok(!stateControl({ state: s }).primary);
});

test('projectBurst: always a button, disabled with a reason whenever it cannot run', () => {
  assert.equal(projectBurst(PROJECT, { pauseMode: 'off' }).disabled, false);
  assert.match(projectBurst({ ...PROJECT, state: 'pending' }).tip, /Activate/);
  assert.match(projectBurst({ ...PROJECT, state: 'paused' }).tip, /Resume/);
  assert.match(projectBurst({ ...PROJECT, ready: { count: 0 } }).tip, /Nothing is ready/);
  assert.match(projectBurst(PROJECT, { pauseMode: 'soft' }).tip, /paused \(soft\)/);
  assert.match(projectBurst(PROJECT, { burstLive: true }).tip, /already running/);
});

// ---------------------------------------------------------------- header

test('Project header: Burst… is the one primary, Poll now/Graph/Remove live in the ⋯ menu', async () => {
  await mount('head');
  const primaries = head().querySelectorAll('.btn--primary');
  assert.equal(primaries.length, 1, 'exactly one primary');
  assert.match(primaries[0].textContent, /^\s*Burst…\s*$/);
  const atRest = outsideMenu(head()).map((b) => b.getAttribute('aria-label') || b.textContent.trim());
  assert.deepEqual(atRest, ['Burst…', 'Pause', 'More actions'], 'header at rest: Burst, the state control, ⋯');
  assert.ok(menu().hidden, 'the menu is closed at rest');
  const items = [...menu().querySelectorAll('[role=menuitem]')].map((n) => n.textContent.trim());
  assert.deepEqual(items, ['Poll now', 'Dependency graph', 'Remove project…']);
  assert.equal(menu().querySelector('a[role=menuitem]').getAttribute('href'), '#graph?id=p1');
  // The retired header buttons are gone from the page head entirely.
  assert.ok(!/Review queue/.test(document.querySelector('.pagehead').textContent));
});

test('Burst… opens the burst dialog scoped to this project', async () => {
  await mount('burst');
  head().querySelector('.btn--primary').click();
  for (let i = 0; i < 6; i += 1) await settle();
  assert.ok(document.querySelector('.modalwrap'), 'the burst dialog opened');
  const checked = [...document.querySelectorAll('.modalwrap input[type=checkbox]')].filter((c) => c.checked);
  assert.equal(checked.length, 1, 'only this project is chosen');
});

test('Burst… while globally paused is disabled with the reason, and not revivable by the sweep', async () => {
  await mount('bpause', { pause: 'soft' });
  const b = head().querySelector('.btn--primary');
  assert.equal(b.disabled, true);
  assert.match(b.getAttribute('data-tip'), /paused \(soft\)/);
  assert.equal(b.getAttribute('data-mutating'), null);
});

for (const [state, label] of [['pending', 'Activate…'], ['paused', 'Resume'], ['active', 'Pause']]) {
  test(`one state control for a ${state} project: ${label}`, async () => {
    await mount(`st-${state}`, { project: { state } });
    const ctl = [...head().querySelectorAll('[data-act=activate], [data-act=pause]')];
    assert.equal(ctl.length, 1);
    assert.equal(ctl[0].textContent.trim(), label);
    assert.ok(!ctl[0].closest('[role=menu]'));
  });
}

// ---------------------------------------------------------------- ⋯ menu

test('⋯ toggles the menu and aria-expanded', async () => {
  await mount('toggle');
  assert.equal(more().getAttribute('aria-expanded'), 'false');
  assert.ok(more().getAttribute('aria-label'));
  assert.ok(more().getAttribute('data-tip'), 'iconbtn carries a tooltip');
  more().click();
  assert.equal(menu().hidden, false);
  assert.equal(more().getAttribute('aria-expanded'), 'true');
  more().click();
  assert.equal(menu().hidden, true);
  assert.equal(more().getAttribute('aria-expanded'), 'false');
});

test('Escape closes the menu and returns focus to ⋯', async () => {
  await mount('esc');
  more().click();
  menu().querySelector('[role=menuitem]').focus();
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(menu().hidden, true);
  assert.equal(more().getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, more());
});

test('a poll tick while the menu is open does not snatch it, and Escape still lands focus on ⋯', async () => {
  // Found in a real browser: the deferred repaint ran AFTER the refocus, so
  // focus went to a ⋯ that was then thrown away and rebuilt.
  const { calls } = await mount('tick');
  more().click();
  const before = calls.length;
  pollTick();
  for (let i = 0; i < 6; i += 1) await settle();
  assert.ok(calls.length > before, 'the tick really re-read the API');
  assert.equal(menu().hidden, false, 'the poll did not close the open menu');
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(menu().hidden, true);
  assert.equal(document.activeElement, more(), 'focus is on the live ⋯, not a detached one');
});

test('an outside click closes the menu and returns focus to ⋯', async () => {
  await mount('outside');
  more().click();
  document.querySelector('.pagehead h1').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(menu().hidden, true);
  assert.equal(document.activeElement, more());
});

test('menu Poll now posts a poll', async () => {
  const { calls } = await mount('mpoll');
  more().click();
  menu().querySelector('[data-act=poll]').click();
  await settle(); await settle();
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/projects/p1/poll'));
});

test('Remove project… keeps its confirm: declined sends nothing, confirmed DELETEs and returns to Projects', async () => {
  const { calls } = await mount('rm');
  window.confirm = () => false;
  more().click();
  menu().querySelector('[data-act=remove]').click();
  await settle(); await settle();
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE'), []);

  let asked = '';
  window.confirm = (m) => { asked = m; return true; };
  more().click();
  menu().querySelector('[data-act=remove]').click();
  await settle(); await settle(); await settle();
  assert.match(asked, /Stop tracking "webapp-billing"/);
  assert.match(asked, /left exactly as they are/);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/api/projects/p1'));
  assert.equal(location.hash, '#projects');
});

// ---------------------------------------------------------------- body

test('three facts only — Ready (wider), Running here, Permission mode', async () => {
  const { page } = await mount('facts');
  const facts = [...page.querySelectorAll('[data-fact]')];
  assert.deepEqual(facts.map((f) => f.querySelector('.t-eyebrow').textContent), ['Ready', 'Running here', 'Permission mode']);
  assert.match(facts[0].parentElement.getAttribute('style'), /1\.5fr/, 'Ready takes the wider track');
  const value = (f) => f.querySelector('.t-eyebrow').nextElementSibling.textContent;
  assert.deepEqual(facts.map(value), ['2', '1', 'auto']);
  // Cut on 2026-09-26 (launchbox.md §7); auto label lives in the config summary.
  for (const gone of [/Min headroom/, /Leases held/, /Last poll/, /Auto label/]) {
    assert.ok(!gone.test(page.textContent), `${gone} is still on the page`);
  }
  assert.equal(page.querySelector('.facts'), null, 'the six-fact strip is gone');
});

test('the Ready card foot says "polled … ago" with an in-place ↻ Poll now', async () => {
  const { calls, page } = await mount('foot');
  const ready = page.querySelector('[data-fact=ready]');
  assert.match(ready.textContent, /polled 25m ago/);
  const btn = [...ready.querySelectorAll('button')].find((b) => /↻ Poll now/.test(b.textContent));
  assert.ok(btn, 'in-place Poll now');
  btn.click();
  await settle(); await settle();
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/projects/p1/poll'));
});

test('"N waiting to merge → Review in Inbox" appears only when N > 0', async () => {
  let { page } = await mount('wait0');
  assert.equal(page.querySelector('[data-waiting]'), null);
  ({ page } = await mount('wait2', { branches: [{ branch: 'scheduler/a--x' }, { branch: 'scheduler/a--y' }] }));
  const strip = page.querySelector('[data-waiting]');
  assert.ok(strip);
  assert.match(strip.textContent, /2 branches waiting to merge/);
  const link = strip.querySelector('a');
  assert.match(link.textContent, /Review in Inbox →/);
  assert.equal(link.getAttribute('href'), '#review?id=p1');
});

test('Up next rows: priority badge, short mono id, title, grey type, unblocks only when > 0, filed … ago', async () => {
  const { page } = await mount('upnext');
  const rows = [...page.querySelectorAll('[data-bead]')];
  assert.equal(rows.length, 2);
  const [first, second] = rows;
  // claim order: P0 first
  assert.equal(first.querySelector('.pill').textContent, 'P0');
  const sid = first.querySelector('.mono');
  assert.equal(sid.textContent, 'c9d8', 'short id, project prefix dropped');
  assert.match(first.textContent, /Fix rounding/);
  const type = first.querySelector('[data-type]');
  assert.equal(type.textContent, 'bug');
  assert.ok(type.classList.contains('t-meta'), 'neutral grey');
  assert.ok(!/state--|pill|bad|warn/.test(type.className), 'no run-state or priority colour on type');
  assert.match(first.textContent, /unblocks 3/);
  assert.ok(!/unblocks/.test(second.textContent), 'no "unblocks 0"');
  assert.match(first.textContent, /filed 3h ago/);
  assert.match(second.textContent, /filed 2d ago/);
  // "graph →" shortcut in the Up next header
  const graph = [...page.querySelectorAll('.card__head a')].find((a) => /graph →/.test(a.textContent));
  assert.equal(graph?.getAttribute('href'), '#graph?id=p1');
});

test('Recent runs rows start line 2 with the status word and open the log', async () => {
  const { page } = await mount('runs');
  const row = page.querySelector('[data-run]');
  assert.ok(row, 'a run row rendered');
  assert.equal(row.querySelector('.mono').textContent, 'e5f6.1');
  assert.match(row.textContent, /Migrate invoice templates/);
  assert.ok(!/webapp-billing: /.test(row.textContent), 'project name not repeated in the title');
  const line2 = row.querySelector('[data-line2]');
  assert.match(line2.textContent, /^handed back/);
  assert.match(row.textContent, /Log →/);
  row.click();
  for (let i = 0; i < 4; i += 1) await settle();
  assert.ok(document.querySelector('.drawer--log'), 'the log drawer opened');
});

test('Up next and Recent runs share one grid: same column template', async () => {
  const { page } = await mount('grid');
  const b = page.querySelector('[data-bead]').getAttribute('style');
  const r = page.querySelector('[data-run]').getAttribute('style');
  const cols = (s) => /grid-template-columns:\s*([^;]+)/.exec(s)[1].trim();
  assert.equal(cols(b), cols(r));
});

test('Declared config is collapsed by default and names the auto label in its summary', async () => {
  const { page } = await mount('cfg');
  const d = page.querySelector('details');
  assert.ok(d);
  assert.equal(d.open, false);
  assert.match(d.querySelector('summary').textContent, /Declared config/);
  assert.match(d.querySelector('summary').textContent, /scheduler-ok/);
  assert.match(d.querySelector('pre').textContent, /"autoLabel": "scheduler-ok"/);
});

// ---------------------------------------------------------------- CSS

test('.menu rules are in both launchbox.css copies, which stay byte-identical', () => {
  const a = readFileSync(join(ROOT, 'public/v2/assets/launchbox.css'), 'utf8');
  const b = readFileSync(join(ROOT, 'redesign/assets/launchbox.css'), 'utf8');
  assert.equal(a, b);
  for (const sel of ['.menu {', '.menu button, .menu a {', '.menu button:hover, .menu a:hover {', '.menu .danger {']) {
    assert.ok(a.includes(sel), `missing ${sel}`);
  }
});
