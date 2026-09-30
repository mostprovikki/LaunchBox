// tests/frontend-v2-inbox.test.js — the #inbox page and its nav badge
// (claude-scheduler-btv.19). docs/design/launchbox.md §5: Workbench, triage
// split. List left (grouped waiting to merge / handed back), detail right, and
// actions ONLY for the selected item — never per row at rest.
//
// Same layers as tests/frontend-v2-review.test.js: pure logic, source gates,
// then jsdom renders for what the reader actually sees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readV2 = (rel) => readFileSync(join(ROOT, 'public', 'v2', rel), 'utf8');

// chrome.js arms a real 15s poll; unref it so the suite cannot hang on it.
const realSetInterval = globalThis.setInterval;
let lastIntervalFn = null;
globalThis.setInterval = (fn, ms, ...rest) => {
  lastIntervalFn = fn;
  const t = realSetInterval(fn, ms, ...rest);
  t?.unref?.();
  return t;
};

const WAITING = {
  projectId: 'p1', projectName: 'claude-scheduler', branch: 'scheduler/claude-scheduler--claude-scheduler-k3p.2',
  beadId: 'claude-scheduler-k3p.2', ahead: 2, behind: 0, shortstat: '3 files changed, 84 insertions(+), 12 deletions(-)',
  tipSha: 'abc1234', tipSubject: 'feat(review): sort by oldest waiting (claude-scheduler-k3p.2)', snapshotTip: false,
};
const HANDED = {
  kind: 'handed-back', projectId: 'p2', projectName: 'system_migration', beadId: 'system_migration-gy70.4',
  runId: 'run-hb-1', finishedAt: '2026-09-30T01:15:00.000Z', status: 'ok',
  reason: 'Queued. Two background jobs now: the browser e2e battery, then a clean-tree baseline.',
};
const STRANDED = {
  kind: 'stranded', projectId: 'p3', projectName: 'trip-planner', beadId: 'trip-planner-8fd',
  runId: 'run-st-1', finishedAt: '2026-09-29T23:50:00.000Z', status: 'ok', reason: null,
};
const INBOX = { asOf: '2026-09-30T09:12:00.000Z', count: 3, waiting: [WAITING], handedBack: [HANDED, STRANDED], errors: [] };
const EMPTY = { asOf: '2026-09-30T09:12:00.000Z', count: 0, waiting: [], handedBack: [], errors: [] };

const logic = () => import('../public/v2/pages/inbox-logic.js');

// ------------------------------------------------------------------ logic

test('inbox-logic: short ids drop the repo prefix, keep the rest', async () => {
  const { shortBeadId } = await logic();
  assert.equal(shortBeadId('system_migration-85ht.1'), '85ht.1');
  assert.equal(shortBeadId('claude-scheduler-btv.19'), 'btv.19');
  assert.equal(shortBeadId('trip-planner-8fd'), '8fd');
  assert.equal(shortBeadId(null), '');
});

test('inbox-logic: items are grouped waiting first, each with one primary action by kind', async () => {
  const { inboxGroups, primaryAction } = await logic();
  const groups = inboxGroups(INBOX);
  assert.deepEqual(groups.map((g) => [g.label, g.items.length]), [['Waiting to merge', 1], ['Handed back', 2]]);
  const [w] = groups[0].items;
  const [h, s] = groups[1].items;
  assert.equal(w.kind, 'waiting');
  assert.equal(primaryAction(w).label, 'Review');
  assert.equal(primaryAction(w).href, '#review?id=p1');
  assert.equal(primaryAction(h).label, 'Log');
  assert.equal(primaryAction(s).label, 'Log');
  assert.equal(s.pill.cls, 'bad', 'a stranded bead is bad, not a quiet hand-back');
  assert.equal(s.why, 'stuck in progress');
  assert.equal(h.why, 'no completion marker');
  // An empty group is left out rather than drawn as "· 0".
  assert.deepEqual(inboxGroups({ ...EMPTY, waiting: [WAITING] }).map((g) => g.label), ['Waiting to merge']);
});

test('inbox-logic: a handed-back run that did not exit ok says how it ended, not "no marker"', async () => {
  const { toItem } = await logic();
  const it = toItem({ ...HANDED, status: 'timeout' }, 'handedBack');
  assert.match(it.why, /timeout/);
  assert.doesNotMatch(it.why, /marker/);
});

test('inbox-logic: moving selection clamps at both ends', async () => {
  const { moveSelection } = await logic();
  assert.equal(moveSelection(0, -1, 3), 0);
  assert.equal(moveSelection(0, 1, 3), 1);
  assert.equal(moveSelection(2, 1, 3), 2);
  assert.equal(moveSelection(-1, 1, 0), -1);
});

// ----------------------------------------------------------------- source

test('the #inbox route is registered and Inbox sits in the appbar nav', () => {
  const main = readV2('main.js');
  assert.match(main, /import inbox from '\.\/pages\/inbox\.js'/);
  assert.match(main, /registerRoute\('inbox', inbox\)/);
  assert.match(readV2('chrome.js'), /\['inbox', 'Inbox'\]/);
});

test('bead text never reaches innerHTML on the inbox page', () => {
  for (const f of ['pages/inbox.js', 'pages/inbox-logic.js']) {
    const src = readV2(f);
    assert.ok(!/innerHTML/.test(src), `${f}: use el()/textContent`);
    assert.ok(!/\bhtml:\s/.test(src), `${f}: el()'s html: attribute parses markup`);
  }
});

test('the qa route walk covers #inbox', async () => {
  const { V2_ROUTES } = await import('../tools/qa/audit-rules.mjs');
  assert.ok(V2_ROUTES.some((r) => r.name === 'inbox' && r.hash === '#inbox'));
});

// ------------------------------------------------------------------ jsdom

const STORED_TOKEN = 'deadbeefcafef00ddeadbeefcafef00d';

function mountDom({ inbox = INBOX, inboxStatus = 200, runs = [] } = {}) {
  const dom = new JSDOM('<!doctype html><body>'
    + '<header class="appbar"><nav id="v2-nav"></nav><div id="v2-chips"></div></header>'
    + '<div id="v2-banner" hidden></div><main><div id="v2-page"></div></main></body>',
  { url: 'http://localhost/v2/', pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.localStorage = dom.window.localStorage;
  global.location = dom.window.location;
  global.history = dom.window.history;
  global.MutationObserver = dom.window.MutationObserver;
  global.KeyboardEvent = dom.window.KeyboardEvent;
  global.localStorage.setItem('cs.token', STORED_TOKEN);
  const calls = [];
  const state = { inbox, inboxStatus, holdStatus: 200 };
  global.fetch = async (path, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ path, method });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === '/api/v2/inbox') return json(state.inboxStatus === 200 ? state.inbox : { error: 'boom' }, state.inboxStatus);
    if (/\/hold$/.test(path) && method === 'POST') {
      return state.holdStatus === 200 ? json({ ok: true, until: '2026-10-07T00:00:00.000Z' })
        : json({ error: 'no issue found matching "system_migration-gy70.4"', busy: false }, state.holdStatus);
    }
    if (path.startsWith('/api/runs?')) return json({ runs });
    if (/^\/api\/runs\/[^/]+\/log$/.test(path)) return new Response('log text', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    return json({});
  };
  return { dom, calls, state };
}

let seq = 0;
const loadPage = async () => (await import(`../public/v2/pages/inbox.js?case=${++seq}`)).default;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const options = () => [...document.querySelectorAll('[role=listbox] [role=option]')];
const detail = () => document.querySelector('.ibx-detail');
const actionButtons = () => [...detail().querySelectorAll('.actionbar .btn')];
const key = (target, k) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));

test('Inbox: actions appear only for the selected item', async () => {
  mountDom();
  const inbox = await loadPage();
  await inbox(new URLSearchParams());

  // No row carries an action at rest.
  for (const o of options()) {
    assert.equal(o.querySelectorAll('button, a, .btn').length, 0, `row "${o.textContent}" has its own action`);
  }
  // The first item is selected on arrival and the detail shows ITS actions only.
  assert.equal(options()[0].getAttribute('aria-selected'), 'true');
  assert.deepEqual(actionButtons().map((b) => b.textContent), ['Review']);
  assert.match(actionButtons()[0].className, /btn--primary/);
  assert.equal(actionButtons()[0].getAttribute('href'), '#review?id=p1');

  options()[1].click();
  assert.equal(options()[0].getAttribute('aria-selected'), 'false');
  assert.equal(options()[1].getAttribute('aria-selected'), 'true');
  const acts = actionButtons();
  assert.deepEqual(acts.map((b) => b.textContent), ['Log', 'Hold']);
  assert.match(acts[0].className, /btn--primary/);
  assert.match(acts[1].className, /btn--ghost/);
  assert.ok(acts[1].hasAttribute('data-mutating'), 'Hold writes, so the degraded sweep must cover it');
});

test('Inbox: list is grouped under counted eyebrows with pill, title and project · time', async () => {
  mountDom();
  const inbox = await loadPage();
  await inbox(new URLSearchParams());

  const list = document.querySelector('[role=listbox]');
  assert.ok(list);
  const eyebrows = [...list.querySelectorAll('.t-eyebrow')].map((e) => e.textContent);
  assert.deepEqual(eyebrows, ['Waiting to merge · 1', 'Handed back · 2']);
  assert.equal(options().length, 3);

  const [w, h, s] = options();
  assert.match(w.querySelector('.state').className, /state--ok/);
  assert.match(w.textContent, /sort by oldest waiting/);
  assert.match(w.querySelector('.t-meta').textContent, /^claude-scheduler · /);
  assert.match(h.querySelector('.state').className, /state--warn/);
  assert.match(h.querySelector('.state').textContent, /handed back/);
  assert.match(h.querySelector('.t-meta').textContent, /^system_migration · \d{2}:\d{2}$/);
  assert.match(s.querySelector('.state').className, /state--bad/);
});

test('Inbox: the detail pane carries title, Project / Bead / Branch / Why and the quoted reason', async () => {
  mountDom();
  const inbox = await loadPage();
  await inbox(new URLSearchParams());
  options()[1].click();

  assert.ok(detail().querySelector('h2').textContent.length > 0);
  const facts = Object.fromEntries([...detail().querySelectorAll('.deflist .defrow')].map((r) => [
    r.querySelector('.defrow__n').textContent, r.querySelector('.defrow__v').textContent,
  ]));
  assert.deepEqual(Object.keys(facts), ['Project', 'Bead', 'Branch', 'Why']);
  assert.equal(facts.Project, 'system_migration');
  assert.equal(facts.Bead, 'gy70.4', 'the project is on screen, so the short id (§6)');
  assert.equal(facts.Why, 'no completion marker');
  assert.match(detail().querySelector('.snippet').textContent, /Two background jobs now/);

  options()[2].click();
  const why = [...detail().querySelectorAll('.defrow')].find((r) => /Why/.test(r.textContent));
  assert.match(why.textContent, /stuck in progress/);
});

test('Inbox: Hold calls the hold endpoint and the item leaves the list; the badge follows', async () => {
  const { calls, state } = mountDom();
  const chrome = await import(`../public/v2/chrome.js?ibx=${++seq}`);
  chrome.mountNav();
  const inbox = await loadPage();
  await inbox(new URLSearchParams());
  options()[1].click();

  state.inbox = { ...INBOX, count: 2, handedBack: [STRANDED] };
  actionButtons().find((b) => b.textContent === 'Hold').click();
  await tick(40);

  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/v2/projects/p2/beads/system_migration-gy70.4/hold'));
  assert.equal(options().length, 2);
  assert.ok(!options().some((o) => /system_migration/.test(o.textContent)), 'the held item is gone');
  assert.equal(document.querySelector('#v2-nav a[data-route=inbox] .tab__n').textContent, '2');
});

test('Inbox: a refused Hold keeps the item and says why', async () => {
  const { state } = mountDom();
  const inbox = await loadPage();
  await inbox(new URLSearchParams());
  options()[1].click();
  state.holdStatus = 502;
  const btn = actionButtons().find((b) => b.textContent === 'Hold');
  btn.click();
  await tick(40);
  assert.equal(options().length, 3, 'nothing was held, so nothing leaves');
  const toasts = [...document.querySelectorAll('#v2-toasts [role=status]')].map((t) => t.textContent);
  assert.ok(toasts.some((t) => /no issue found/.test(t)), `toasts: ${JSON.stringify(toasts)}`);
  assert.equal(btn.disabled, false, 'and Hold can be tried again');
});

test('Inbox: ↑↓ move selection, Enter runs the primary, L opens the log, H holds', async () => {
  const { calls } = mountDom({ runs: [{ id: 'run-hb-1', status: 'ok', trigger: 'bead', startedAt: HANDED.finishedAt }] });
  const inbox = await loadPage();
  await inbox(new URLSearchParams());
  const list = document.querySelector('[role=listbox]');

  key(list, 'ArrowDown');
  assert.equal(options()[1].getAttribute('aria-selected'), 'true');
  assert.equal(document.activeElement, options()[1], 'focus follows selection');
  key(list, 'ArrowUp');
  assert.equal(options()[0].getAttribute('aria-selected'), 'true');

  key(list, 'Enter');
  assert.equal(location.hash, '#review?id=p1', 'Enter on a waiting item is Review');

  key(list, 'ArrowDown');
  key(list, 'l');
  await tick(40);
  assert.ok(document.querySelector('.drawer--log'), 'L opens the log drawer');
  assert.ok(calls.some((c) => c.path === '/api/runs/run-hb-1/log'));
  document.querySelector('.drawer--log .iconbtn')?.click();

  key(list, 'H');
  await tick(40);
  assert.ok(calls.some((c) => c.method === 'POST' && /\/beads\/system_migration-gy70\.4\/hold$/.test(c.path)));
});

test('Inbox: L and H do nothing on a waiting item — it has neither action', async () => {
  const { calls } = mountDom();
  const inbox = await loadPage();
  await inbox(new URLSearchParams());
  const list = document.querySelector('[role=listbox]');
  key(list, 'h');
  key(list, 'l');
  await tick(30);
  assert.ok(!calls.some((c) => /hold|\/log$/.test(c.path)));
  assert.ok(!document.querySelector('.drawer--log'));
});

test('Inbox: empty state says "Nothing needs you" and draws no list', async () => {
  mountDom({ inbox: EMPTY });
  const inbox = await loadPage();
  await inbox(new URLSearchParams());
  assert.match(document.getElementById('v2-page').textContent, /Nothing needs you/);
  assert.equal(options().length, 0);
});

test('Inbox: a failed fetch is an error, never "Nothing needs you"', async () => {
  mountDom({ inboxStatus: 500 });
  const inbox = await loadPage();
  await inbox(new URLSearchParams());
  const text = document.getElementById('v2-page').textContent;
  assert.doesNotMatch(text, /Nothing needs you/);
  assert.match(text, /Could not load the Inbox/);
});

test('nav badge: equals /api/v2/inbox count, hidden at 0, and the link is updated in place', async () => {
  const { state } = mountDom();
  const chrome = await import(`../public/v2/chrome.js?badge=${++seq}`);
  chrome.mountChrome();
  await tick(60);
  const link = document.querySelector('#v2-nav a[data-route=inbox]');
  assert.ok(link, 'Inbox is in the nav');
  assert.match(link.textContent, /^Inbox/);
  const badge = link.querySelector('.tab__n');
  assert.equal(badge.textContent, '3');
  assert.equal(badge.hidden, false);

  link.focus();
  state.inbox = EMPTY;
  await lastIntervalFn(); await tick(20);
  assert.equal(document.querySelector('#v2-nav a[data-route=inbox]'), link, 'same node after a poll');
  assert.equal(document.activeElement, link, 'focus survives the poll');
  assert.equal(badge.hidden, true, 'hidden at 0');
});
