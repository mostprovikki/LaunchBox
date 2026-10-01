// Overview as Monitor (claude-scheduler-btv.21) — docs/design/launchbox.md §5,
// mockup docs/design/mockups/overview-flavours.html Option 2. Two halves:
//   1. pure card models (public/v2/pages/overview-logic.js), no DOM;
//   2. jsdom over the real overview.js — the render, the one action, the
//      §7 cuts, and the once-per-load visit POST.
// Fixture shapes are the real responses: /api/v2/overview (server.js "v2:
// overview", spend from btv.25) and /api/v2/inbox (lib/inbox.js, btv.22).
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  fmtPct, pauseModeLabel, daemonFault, statusLight,
  needsModel, headroomModel, runningModel, spendModel,
} from '../public/v2/pages/overview-logic.js';

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

function win(key, percent, extra = {}) {
  return { key, label: key, reservePct: 80, warnPct: 70, critPct: 85, percent, resetsAt: null, unknown: percent == null, ...extra };
}

function overviewPayload({
  pauseMode = 'off', week = 30, five = 12, running = [], projects = [], attention = [], spend,
} = {}) {
  return {
    generatedAt: iso(),
    pause: { mode: pauseMode, until: null, blocking: { schedule: pauseMode !== 'off', manual: false }, stopping: [] },
    headroom: {
      asOf: '2026-09-26T10:10:07.000Z', available: true, stale: false,
      guard: { enforcing: true, why: null, reserveFiveHourPct: 80, reserveWeeklyPct: 95 },
      windows: [win('five_hour', five), win('seven_day', week)],
      modelWindows: [],
    },
    attention: { asOf: iso(), items: attention },
    next24h: { asOf: iso(), pauseMode, fires: [{ jobId: 'j1', jobName: 'Nightly fire', at: iso(-3600_000), admitted: true }], beyond: [], disabledNeverFireCount: 0 },
    running: { asOf: iso(), runs: running },
    today: { asOf: iso(), total: 0, byStatus: {} },
    automation: { available: true, asOf: iso(), pollSec: 60, bd: null, projects, burst: null },
    spend: spend ?? {
      asOf: iso(),
      sinceVisit: { pct: 4.2, from: '2026-09-26T01:19:00.000Z' },
      last7: {
        pct: 34.5,
        byProject: [
          { projectId: 'p1', name: 'system_migration', pct: 19 },
          { projectId: 'p2', name: 'trip-planner', pct: 8 },
          { projectId: 'p3', name: 'claude-scheduler', pct: 5 },
          { projectId: 'p4', name: 'tiny', pct: 2 },
        ],
      },
    },
  };
}

function inboxPayload({ waiting = 1, handedBack = 2, errors = [] } = {}) {
  return {
    asOf: iso(),
    count: waiting + handedBack,
    waiting: Array.from({ length: waiting }, (_, i) => ({ projectId: 'p1', projectName: 'system_migration', branch: `scheduler/x--b${i}` })),
    handedBack: Array.from({ length: handedBack }, (_, i) => ({ kind: 'handed-back', projectId: 'p2', beadId: `b${i}`, runId: `r${i}` })),
    errors,
  };
}

const FAULT_REASON = 'claude is not spawnable (ENOENT) — a daemon fault, not a bead problem; fix settings.claudePath and it will resume on its own';

// ======================================================= 1. pure models

test('fmtPct: rounds, keeps a real 0, never rounds a small spend down to a healthy-looking 0, null is "—"', () => {
  assert.equal(fmtPct(34.5), '35%');
  assert.equal(fmtPct(0), '0%');
  assert.equal(fmtPct(0.3), '<1%');
  assert.equal(fmtPct(null), '—');
  assert.equal(fmtPct(undefined), '—');
});

test('pauseModeLabel: the mockups\' exact wording', () => {
  assert.equal(pauseModeLabel('hold'), 'Hold');
  assert.equal(pauseModeLabel('soft'), 'Soft drain');
  assert.equal(pauseModeLabel('hard'), 'Hard stop');
});

test('daemonFault: read from the poller\'s live project reason; null when every project is healthy', () => {
  assert.equal(daemonFault(overviewPayload()), null);
  const f = daemonFault(overviewPayload({ projects: [{ id: 'p1', name: 'a', state: 'active', reasons: [FAULT_REASON] }] }));
  assert.ok(f, 'a project reason naming a daemon fault must raise the fault');
  assert.equal(f.code, 'ENOENT');
  assert.match(f.why, /claude binary/);
});

test('daemonFault: a runner "daemon fault" skip names the path, but only while the runner still remembers it', () => {
  const skip = (msAgo) => ({
    id: 'r1', jobId: 'j1', jobName: 'x', kind: 'skipped', occurredAt: iso(msAgo),
    reason: { code: 'other', message: 'daemon fault: "/opt/homebrew/bin/claude" is not spawnable (ENOENT) — this is not a bead/job failure; fix the executable path in settings' },
  });
  const fresh = daemonFault(overviewPayload({ attention: [skip(60_000)] }));
  assert.equal(fresh?.cmd, '/opt/homebrew/bin/claude');
  assert.equal(daemonFault(overviewPayload({ attention: [skip(30 * 60_000)] })), null,
    'a 30-minute-old skip is history — the runner forgets a spawn fault after 5 minutes, so must the banner');
});

test('statusLight: ok / warn / bad with the three §5 one-liners and a why', () => {
  const ok = statusLight({ data: overviewPayload(), needs: 0 });
  assert.deepEqual([ok.light, ok.title], ['ok', 'Nothing needs you']);
  assert.ok(ok.why);

  const waiting = statusLight({ data: overviewPayload(), needs: 3 });
  assert.deepEqual([waiting.light, waiting.title], ['warn', 'Waiting on you']);

  const paused = statusLight({ data: overviewPayload({ pauseMode: 'soft', week: 89 }), needs: 0 });
  assert.deepEqual([paused.light, paused.title], ['warn', 'Nothing needs you'], 'a pause or low headroom is amber even with an empty Inbox');
  assert.equal(paused.why, 'paused (Soft drain) · weekly headroom is low');

  const bad = statusLight({ data: overviewPayload({ projects: [{ id: 'p1', reasons: [FAULT_REASON] }] }), needs: 3 });
  assert.deepEqual([bad.light, bad.title], ['bad', 'Cannot run beads'], 'a daemon fault outranks a waiting Inbox');
  assert.match(bad.why, /claude binary/);
});

test('statusLight: an unreadable Inbox never reads as "Nothing needs you"', () => {
  const s = statusLight({ data: overviewPayload(), needs: null });
  assert.notEqual(s.title, 'Nothing needs you');
  assert.equal(s.light, 'warn');
});

test('needsModel: count and what it is made of, from /api/v2/inbox', () => {
  const m = needsModel(inboxPayload({ waiting: 1, handedBack: 2 }));
  assert.equal(m.count, 3);
  assert.equal(m.parts, '1 branch waiting to merge · 2 handed back');
  assert.equal(needsModel(inboxPayload({ waiting: 0, handedBack: 0 })).parts, 'no branches waiting · nothing handed back');
  assert.match(needsModel(inboxPayload({ errors: [{ projectName: 'x' }] })).parts, /1 project could not be read/);
  assert.equal(needsModel(null).count, null, 'no inbox reading is unknown, not 0');
});

test('headroomModel: weekly left large, 5-hour left beneath, same as-of stamp as the appbar chips\' "checked HH:MM:SS"', () => {
  const d = overviewPayload({ week: 89, five: 11 });
  const m = headroomModel(d.headroom);
  assert.equal(m.v, '11%');
  assert.match(m.d, /^89% of the 5-hour window · as of \d{2}:\d{2}:\d{2}$/);
  const t = new Date(d.headroom.asOf);
  const hms = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  assert.ok(m.d.endsWith(hms), 'the stamp is the usage poll\'s own checkedAt, formatted like chrome.js\'s chip tooltip');
  assert.equal(m.cls, 'bad', 'week at 89% used is past critical (85)');
  const unknown = headroomModel(overviewPayload({ week: null, five: null }).headroom);
  assert.equal(unknown.v, '—');
});

test('runningModel: count + pause state, links to Runs', () => {
  assert.deepEqual(runningModel({ runs: [] }, { mode: 'off' }), { v: '0', d: 'nothing running', href: '#runs' });
  const r = runningModel({ runs: [{ runId: 'a' }, { runId: 'b' }] }, { mode: 'hold' });
  assert.equal(r.v, '2');
  assert.equal(r.d, 'paused (Hold) · nothing new starts');
});

test('spendModel: two large numbers and a share bar — names only, label at ≥12% share', () => {
  const m = spendModel(overviewPayload().spend);
  assert.equal(m.sinceVisit, '+4%');
  assert.equal(m.last7, '35%');
  assert.deepEqual(m.share.map((s) => s.label), ['system_migration', 'trip-planner', 'claude-scheduler', ''],
    'tiny is 2/34 = 5.9% of the bar — below 12%, so no label');
  const first = spendModel({ asOf: iso(), sinceVisit: { pct: null, from: null }, last7: { pct: 0, byProject: [] } });
  assert.equal(first.sinceVisit, '—', 'before a second visit there is nothing to compare, not a 0');
  assert.deepEqual(first.share, []);
  const zero = spendModel({ sinceVisit: { pct: 0 }, last7: { pct: 3, byProject: [{ projectId: 'a', name: 'a', pct: 3 }, { projectId: 'z', name: 'idle', pct: 0 }] } });
  assert.deepEqual(zero.share.map((s) => s.name), ['a'], 'a project that spent nothing gets no segment');
});

// ======================================================= 2. the real page

function freshDom() {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<header class="appbar"><nav id="v2-nav"></nav><div id="v2-chips"></div></header>'
    + '<div id="v2-banner" hidden></div><main class="shell"><div id="v2-page"></div></main>'
    + '</body></html>', { url: 'http://127.0.0.1:43410/v2#overview', pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.history = dom.window.history;
  globalThis.localStorage = dom.window.localStorage;
  return dom;
}

// The page arms a real poll interval; unref so a leftover timer cannot keep
// `node --test` alive (same reason tests/v2-runs.test.js does this).
const realSetInterval = globalThis.setInterval;
const intervals = [];
globalThis.setInterval = (fn, ms, ...rest) => {
  const t = realSetInterval(fn, ms, ...rest);
  t?.unref?.();
  intervals.push(fn);
  return t;
};
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
  const t = realSetTimeout(fn, ms, ...rest);
  t?.unref?.();
  return t;
};
const tick = (ms = 40) => new Promise((r) => realSetTimeout(r, ms));

function mockFetch({ overview = overviewPayload(), inbox = inboxPayload() } = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method ?? 'GET';
    calls.push(`${method} ${u}`);
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (u === '/api/v2/overview') return json(overview);
    if (u === '/api/v2/inbox') return inbox ? json(inbox) : { ok: false, status: 501, text: async () => '{"error":"no branches"}' };
    if (u === '/api/v2/visits' && method === 'POST') return json({ lastVisitAt: iso() });
    throw new Error(`unmocked fetch: ${method} ${u}`);
  };
  fn.calls = calls;
  return fn;
}

async function mountOverview(fetchImpl) {
  freshDom();
  globalThis.fetch = fetchImpl;
  intervals.length = 0;
  const router = await import('../public/v2/router.js');
  const mod = await import(`../public/v2/pages/overview.js?t=${Date.now()}_${Math.random()}`);
  void router;
  mod.default(new URLSearchParams());
  await tick(80);
  return mod;
}

const page = () => document.getElementById('v2-page');

test('Monitor: Open Inbox is the only action on the page', async () => {
  await mountOverview(mockFetch());
  const p = page();
  assert.equal(p.querySelectorAll('button').length, 0, 'no buttons at all on a Monitor — no refresh, no stop, no new job');
  assert.equal(p.querySelectorAll('[data-mutating]').length, 0);
  const actions = [...p.querySelectorAll('.btn')];
  assert.deepEqual(actions.map((a) => a.textContent.trim()), ['Open Inbox']);
  const hero = actions[0].closest('a');
  assert.equal(hero.getAttribute('href'), '#inbox', 'Open Inbox goes to #inbox');
  const hrefs = new Set([...p.querySelectorAll('a')].map((a) => a.getAttribute('href')));
  for (const h of hrefs) assert.ok(['#inbox', '#runs', '#settings'].includes(h), `unexpected link ${h}`);
});

test('Monitor: status light + one-line state, then the needs-you card largest', async () => {
  await mountOverview(mockFetch({ overview: overviewPayload({ pauseMode: 'soft', week: 89, five: 11 }) }));
  const p = page();
  assert.ok(p.querySelector('.light.light--warn'), 'amber light');
  assert.equal(p.querySelector('.status__t').textContent, 'Waiting on you');
  assert.equal(p.querySelector('.status__why').textContent, 'paused (Soft drain) · weekly headroom is low');
  const hero = p.querySelector('a.hero');
  assert.equal(hero.querySelector('.hero__v').textContent, '3');
  assert.match(hero.textContent, /1 branch waiting to merge · 2 handed back/);
  assert.equal(p.querySelector('.ov-fault'), null, 'no fault banner without a fault');
});

test('Monitor: a daemon fault is a red banner with one fix link to Settings', async () => {
  const overview = overviewPayload({ projects: [{ id: 'p1', name: 'a', state: 'active', reasons: [FAULT_REASON] }] });
  await mountOverview(mockFetch({ overview }));
  const p = page();
  assert.ok(p.querySelector('.light.light--bad'));
  assert.equal(p.querySelector('.status__t').textContent, 'Cannot run beads');
  const banner = p.querySelector('.ov-fault');
  assert.ok(banner, 'fault banner present');
  assert.ok(banner.classList.contains('appbanner--bad'));
  const links = [...banner.querySelectorAll('a')];
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), '#settings');
  assert.equal(links[0].textContent, 'Fix in Settings');
});

test('Monitor: headroom, running and spend cards carry their facts', async () => {
  const running = [{ runId: 'r1', jobId: 'j', jobName: 'Busy job', startedAt: iso(), elapsedMs: 1000, trigger: 'schedule' }];
  await mountOverview(mockFetch({ overview: overviewPayload({ week: 89, five: 11, running, pauseMode: 'hold' }) }));
  const p = page();
  const head = p.querySelector('a.fact3[href="#settings"]');
  assert.equal(head.querySelector('.fact3__v').textContent, '11% week');
  assert.match(head.textContent, /89% of the 5-hour window · as of \d{2}:\d{2}:\d{2}/);

  const run = p.querySelector('a.fact3[href="#runs"]:not(.fact3--spend)');
  assert.equal(run.querySelector('.fact3__v').textContent, '1');
  assert.match(run.textContent, /paused \(Hold\)/);
  assert.equal(run.querySelectorAll('button, .iconbtn').length, 0, 'no stop/kill controls');
  assert.doesNotMatch(p.textContent, /Busy job/, 'running card is a count, not a list');

  const spend = p.querySelector('.fact3--spend');
  assert.deepEqual([...spend.querySelectorAll('.spend__v')].map((n) => n.textContent), ['+4%', '35%']);
  const segs = [...spend.querySelectorAll('.share__seg')];
  assert.equal(segs.length, 4);
  assert.deepEqual(segs.map((s) => s.querySelector('.share__n').textContent), ['system_migration', 'trip-planner', 'claude-scheduler', '']);
  assert.doesNotMatch(spend.querySelector('.share').textContent, /\d/, 'no numbers on the share bar');
});

test('Monitor: NONE of the §7 cuts — attention list, next 24h, history charts, automation, meters, refresh', async () => {
  const attention = [{ id: 'x', jobId: 'j', jobName: 'Timed out job', kind: 'timeout', occurredAt: iso(), reason: { code: 'timeout', timeoutMin: 60, streak: 1 } }];
  await mountOverview(mockFetch({ overview: overviewPayload({ attention, projects: [{ id: 'p', name: 'proj-in-automation', state: 'active', reasons: [] }] }) }));
  const p = page();
  const text = p.textContent;
  for (const gone of ['Needs attention', 'Timed out job', 'Next 24 hours', 'Nightly fire', 'Automation', 'proj-in-automation', 'Refresh usage', 'New job', 'Start a burst']) {
    assert.ok(!text.includes(gone), `§7 cut "${gone}" is back on the page`);
  }
  assert.equal(p.querySelectorAll('.meter, .meters3, .rows, .row, canvas, svg.chart').length, 0, 'no meters, lists or charts at rest');
});

test('Monitor: POSTs /api/v2/visits once per load, before the first read, never on a poll', async () => {
  const f = mockFetch();
  await mountOverview(f);
  const visits = () => f.calls.filter((c) => c === 'POST /api/v2/visits').length;
  assert.equal(visits(), 1);
  const firstGet = f.calls.indexOf('GET /api/v2/overview');
  assert.ok(f.calls.indexOf('POST /api/v2/visits') < firstGet, 'the visit is stamped before the spend read, so "since last visit" is since the previous one');
  assert.ok(intervals.length >= 1, 'a poll is armed');
  for (const fn of intervals) fn();
  for (const fn of intervals) fn();
  await tick(60);
  assert.ok(f.calls.filter((c) => c === 'GET /api/v2/overview').length >= 3, 'the poll re-reads');
  assert.equal(visits(), 1, 'polls must not count as visits');
});

test('Monitor: an Inbox the daemon cannot read shows "—", not a healthy 0', async () => {
  await mountOverview(mockFetch({ inbox: null }));
  const p = page();
  assert.equal(p.querySelector('.hero__v').textContent, '—');
  assert.notEqual(p.querySelector('.status__t').textContent, 'Nothing needs you');
});

test('Monitor: paints its own shell before the first load returns — the previous route never lingers', async () => {
  freshDom();
  page().textContent = 'SOME OTHER PAGE';
  let release;
  const held = new Promise((r) => { release = r; });
  const inner = mockFetch();
  globalThis.fetch = async (url, opts) => { await held; return inner(url, opts); };
  const mod = await import(`../public/v2/pages/overview.js?shell=${Date.now()}`);
  mod.default(new URLSearchParams());
  await tick(20);
  assert.doesNotMatch(page().textContent, /SOME OTHER PAGE/);
  assert.match(page().textContent, /Loading/);
  release();
  await tick(60);
  assert.ok(page().querySelector('.status .light'), 'then the real status paints');
});
