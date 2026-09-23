// Burn-down + burst planner dialogs (claude-scheduler-btv.12 / D2), and the
// one additive endpoint this bead added.
//
//  - GET /api/v2/plan-candidates against a real createApp, because the whole
//    point of it is to serve numbers as numbers instead of the UI parsing
//    lib/budget.js's English.
//  - pure logic (public/v2/pages/plan-logic.js) — the running projection, the
//    confidence wording, the eligible/excluded split.
//  - jsdom for both dialogs against a mocked fetch — that neither of them
//    computes a plan itself, and that confirm sends the SERVER's slots back.
//  - source gates for the five mockup claims this bead refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  fmtClock, pct, windowLabel, burnDownRows, confidenceText, burnDownConsequence,
  splitCandidates, blockedText, costText, BURST_PRESETS, burstFacts, burstConsequence,
  splitProjects,
} from '../public/v2/pages/plan-logic.js';
import { ASSUMED_COST_PCT, MIN_SAMPLES } from '../lib/budget.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readV2 = (rel) => readFileSync(join(ROOT, 'public', 'v2', rel), 'utf8');

// ------------------------------------------------- the additive endpoint

test('lib/budget.js exports the two constants the endpoint states', () => {
  // Stated rather than re-typed: a UI that hard-codes "assuming 1%" would
  // drift the moment the fallback changes.
  assert.equal(typeof ASSUMED_COST_PCT, 'number');
  assert.equal(typeof MIN_SAMPLES, 'number');
  assert.ok(ASSUMED_COST_PCT > 0);
  assert.ok(MIN_SAMPLES >= 1);
});

test('GET /api/v2/plan-candidates is additive and touches nothing existing', () => {
  // The epic's API policy: nothing the current UI calls may be modified. This
  // checks the new route sits under /api/v2/ and that the old planner routes
  // still exist unchanged beside it.
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8');
  assert.match(src, /app\.get\('\/api\/v2\/plan-candidates'/);
  assert.match(src, /app\.post\('\/api\/budget\/plan'/);
  assert.match(src, /app\.post\('\/api\/budget\/plan\/apply'/);
  assert.match(src, /app\.post\('\/api\/bursts\/plan'/);
  // …and it is a GET that writes nothing.
  const route = /app\.get\('\/api\/v2\/plan-candidates'[\s\S]*?\n  \}\);/.exec(src)[0];
  for (const writer of ['updateJob', 'createJob', 'deleteJob', 'setSetting', 'insertRun']) {
    assert.ok(!route.includes(writer), `the candidates route calls ${writer} — it must write nothing`);
  }
});

test('the endpoint reads the STRUCTURED live reason, and there is only one of each decoder', () => {
  // Two decoders would word one guard reason two ways, which is the defect the
  // shared vocabulary modules exist to prevent. Since claude-scheduler-ddu the
  // shared thing is liveBudgetReason(), which reads the {code,...values} that
  // budget.js now reports BESIDE its sentence. This route must not slide back
  // to regex-parsing that sentence: a reword in budget.js would silently
  // degrade every candidate row to {code:'other'} with nothing going red.
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8');
  const route = /app\.get\('\/api\/v2\/plan-candidates'[\s\S]*?\n  \}\);/.exec(src)[0];
  assert.match(route, /liveBudgetReason\(policy\.explain\(job\)\)/);
  assert.ok(!/decodeReason\(/.test(route),
    'the live path must not call the historical-row decoder');
  // It is handed the whole explain() result, never a field, so no caller can
  // pass it the sentence by mistake.
  assert.ok(!/liveBudgetReason\([^)]*\.blocked\)/.test(route),
    'liveBudgetReason takes the explain() result, not its .blocked sentence');
  assert.equal((src.match(/const SKIP_REASON_PATTERNS =/g) ?? []).length, 1, 'there must be exactly one pattern table');
  assert.equal((src.match(/function liveBudgetReason\(/g) ?? []).length, 1, 'there must be exactly one live decoder');
});

// ---------------------------------------------------------------- pure

test('burnDownRows runs the projection forward from the CURRENT reading', () => {
  const plan = {
    slots: [
      { at: '2030-01-01T10:05:00Z', jobId: 'a', estPct: 6.8 },
      { at: '2030-01-01T10:30:00Z', jobId: 'b', estPct: 4.1 },
    ],
  };
  const jobsById = new Map([['a', { name: 'Docs' }], ['b', { name: 'Flaky hunter' }]]);
  const rows = burnDownRows(plan, { jobsById, startPct: 37 });
  assert.deepEqual(rows.map((r) => r.jobName), ['Docs', 'Flaky hunter']);
  // "Projected total" is where you WILL be, not what this costs.
  assert.equal(Math.round(rows[0].projectedPct * 10) / 10, 43.8);
  assert.equal(Math.round(rows[1].projectedPct * 10) / 10, 47.9);
});

test('burnDownRows leaves the projection blank when there is no reading to project from', () => {
  // A zero here would be a measurement nobody took.
  const rows = burnDownRows({ slots: [{ at: '2030-01-01T10:05:00Z', jobId: 'a', estPct: 6.8 }] }, { startPct: null });
  assert.equal(rows[0].projectedPct, null);
  assert.equal(rows[0].estPct, 6.8);
});

test('confidenceText has exactly two states and never invents a band', () => {
  const high = confidenceText({ confidence: 'high' }, { candidates: [{ chosen: true, samples: 9, source: 'learned', name: 'a' }] });
  assert.equal(high.tone, 'ok');
  assert.match(high.body, /9 samples/);

  const low = confidenceText({ confidence: 'low' }, { candidates: [{ chosen: true, samples: 0, source: 'assumed', name: 'Brand new job' }] });
  assert.equal(low.tone, 'warn');
  assert.match(low.body, /Brand new job/);
  assert.match(low.body, /never been measured/);

  // The refusal: lib/budget.js computes a point estimate and a low/high flag.
  // There is no interval anywhere, so neither state may print one.
  for (const t of [high, low]) {
    assert.ok(!/between .*% and .*%/.test(t.body), `invented a confidence band: ${t.body}`);
    assert.ok(!/medium/i.test(`${t.title} ${t.body}`), 'there is no "medium" — the server says low or high');
  }
});

test('splitCandidates excludes only what the SERVER says cannot be planned', () => {
  const { eligible, excluded } = splitCandidates([
    { id: 'a', name: 'Docs', plannable: true, blocked: null },
    { id: 'b', name: 'Bead job', plannable: false, notPlannable: { code: 'bead_backed', message: 'bead-backed jobs cannot be planned' } },
    { id: 'c', name: 'Blocked now', plannable: true, blocked: { code: 'reserve', windowLabel: '5h', usedPct: 82 } },
  ]);
  assert.deepEqual(excluded.map((j) => j.id), ['b']);
  assert.match(excluded[0].reason, /bead-backed/);
  // A job the guard would block RIGHT NOW is still includable — the guard is
  // checked again at fire time and the situation may have changed by then.
  assert.deepEqual(eligible.map((j) => j.id), ['a', 'c']);
  assert.equal(eligible[0].warning, null);
  assert.match(eligible[1].warning, /holding 5h headroom/);
});

test('blockedText words the four guard codes exactly once each, and passes an unknown through', () => {
  assert.match(blockedText({ code: 'reserve', windowLabel: '5h', usedPct: 82 }), /5h headroom \(82% used\)/);
  assert.match(blockedText({ code: 'bucket_severity', bucket: 'fable', percent: 90, severity: 'critical' }), /fable is at 90%/);
  assert.match(blockedText({ code: 'job_min_headroom', minHeadroomPct: 40, leftPct: 12 }), /40% headroom and 12% is left/);
  assert.match(blockedText({ code: 'paused', mode: 'hold' }), /paused \(hold\)/);
  assert.equal(blockedText({ code: 'other', message: 'some future sentence' }), 'some future sentence');
  assert.equal(blockedText(null), null);
});

test('costText distinguishes a measured average from a placeholder', () => {
  assert.match(costText({ source: 'learned', costPct: 6.8, samples: 9 }), /avg 6\.80% per run over 9 runs/);
  assert.match(costText({ source: 'assumed', costPct: 1, samples: 0 }, { assumedCostPct: 1 }), /never measured — assuming 1\.00% per run/);
});

test('burnDownConsequence counts the server\'s slots and names the window', () => {
  const t = burnDownConsequence({
    slots: [{ at: '2030-01-01T10:05:00Z' }, { at: '2030-01-01T11:30:00Z' }],
    estTotalPct: 28.6,
  }, { window: 'five_hour' });
  assert.match(t, /Creates 2 one-shot fires/);
  assert.match(t, /est\. \+28\.6% of the 5-hour window/);
  assert.match(t, /each fire still passes the guard/);
  assert.match(burnDownConsequence({ slots: [] }), /Nothing to create/);
});

test('burstFacts reports a single attempt count and a two-state confidence', () => {
  const facts = burstFacts({
    ok: true, window: 'five_hour', budgetPct: 10, confidence: 'low',
    slots: ['a', 'b', 'c'],
    estimate: { perRunPct: 4.2, expectedRuns: 3, source: 'learned', samples: 14 },
  }, { startPct: 37 });
  const by = Object.fromEntries(facts.map((f) => [f.k, f]));
  assert.equal(by.Budget.d, 'of 5-hour · 37% → stop at 47%');
  // NOT "2–3": expectedRuns is slots.length, a number the timetable committed to.
  assert.equal(by['Attempts planned'].v, '3');
  assert.ok(!/–|-\s*\d/.test(by['Attempts planned'].v), 'no invented range');
  assert.equal(by.Confidence.v, 'low');
  assert.match(by.Confidence.d, /14 samples/);
  // NOT "wb-221 first": the plan carries counts and no bead list.
  assert.match(by.Order.d, /decided at each attempt/);
  assert.ok(!/wb-\d+/.test(JSON.stringify(facts)));
  // With no usage reading, the stop-at figure is not invented.
  const noRead = burstFacts({ ok: true, window: 'five_hour', budgetPct: 10, slots: [], estimate: {} }, { startPct: null });
  assert.match(noRead[0].d, /current usage unknown/);
});

test('splitProjects keys off state, never readiness — that is the airlock', () => {
  // GET /api/projects/:id/ready deliberately answers for a PENDING project so
  // a human can see what would run before activating it. A planner that keyed
  // off readiness would plan, and then run, work from a repo nobody activated.
  const { eligible, excluded } = splitProjects([
    { id: 'a', name: 'active-one', state: 'active', ready: { count: 4 } },
    { id: 'b', name: 'pending-one', state: 'pending', ready: { count: 9 } },
    { id: 'c', name: 'paused-one', state: 'paused', ready: { count: 2 } },
    { id: 'd', name: 'busy-one', state: 'active', busyStreak: 3, ready: { count: 1 } },
  ]);
  assert.deepEqual(eligible.map((p) => p.id), ['a', 'd']);
  assert.deepEqual(excluded.map((p) => p.id), ['b', 'c']);
  assert.match(excluded[0].reason, /only an activated project/);
  // A busy project is a warning, not an exclusion — and the COUNT, not a time.
  assert.match(eligible[1].warning, /3 polls/);
  assert.ok(!/since \d\d:\d\d/.test(eligible[1].warning));
});

test('burstConsequence states the stop condition and never promises which beads', () => {
  const t = burstConsequence(
    { ok: true, budgetPct: 10, slots: ['a', 'b', 'c'], projects: [{ name: 'webapp-billing' }] },
    { maxRuns: 6, startPct: 37 },
  );
  assert.match(t, /Claims up to 3 beads from webapp-billing, one at a time/);
  assert.match(t, /stops at 47% measured/);
  assert.match(t, /or 6 runs/);
  assert.match(t, /cancel any time/);
  assert.match(burstConsequence(null), /Nothing to start yet/);
});

test('windowLabel and pct never print NaN', () => {
  assert.equal(windowLabel('five_hour'), '5-hour');
  assert.equal(windowLabel('seven_day'), 'week');
  assert.equal(pct(undefined), '—');
  assert.equal(pct('nope'), '—');
  assert.equal(fmtClock('nope'), null);
});

// --------------------------------------------------------- source gates

const REFUSED = [
  { re: /medium/i, why: 'lib/budget.js returns confidence low|high — there is no medium' },
  { re: /could land between/, why: 'nothing computes a confidence interval' },
  { re: /Claude jobs only/, why: 'the server plans any job EXCEPT a bead-backed one — that is a safety rule, not a type filter' },
  { re: /locked (by another process )?since/, why: 'busyStreak is a count, not a start time' },
  { re: /wb-\d+ first/, why: 'the burst plan carries ready counts and no bead list' },
];

test('no planner module states something the plan does not carry', () => {
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const offenders = [];
  for (const f of ['pages/plan-logic.js', 'pages/plan-dialogs.js']) {
    const src = stripComments(readV2(f));
    for (const c of REFUSED) if (c.re.test(src)) offenders.push(`${f}: ${c.re} — ${c.why}`);
  }
  assert.deepEqual(offenders, [], `these render claims the plan does not support:\n${offenders.join('\n')}`);
});

test('neither dialog computes a plan — the server does', () => {
  // The rule that keeps a burst from laying out slots the guard would refuse.
  // A dialog doing its own spacing or reserve arithmetic is the failure mode.
  const src = readV2('pages/plan-dialogs.js') + readV2('pages/plan-logic.js');
  for (const forbidden of [/resetsAt.*-.*Date\.now/, /PLAN_LEAD/, /reservePct\s*-/, /Math\.floor\(\s*usable/]) {
    assert.ok(!forbidden.test(src), `a planner dialog is doing the server's arithmetic: ${forbidden}`);
  }
  // …and both confirm paths send back the slots they were GIVEN.
  const dialogs = readV2('pages/plan-dialogs.js');
  assert.match(dialogs, /slots: state\.plan\.slots\.map/);
  assert.match(dialogs, /slots: state\.plan\.slots,/);
});

// ---------------------------------------------------------------- jsdom

function mountDom() {
  const dom = new JSDOM('<!doctype html><body><main><div id="v2-page"></div></main></body>', { url: 'http://localhost/v2/' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.localStorage = dom.window.localStorage;
  global.location = dom.window.location;
  global.history = dom.window.history;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  return dom;
}

function mockFetch(routes) {
  const calls = [];
  global.fetch = async (path, opts = {}) => {
    const method = opts.method ?? 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path, method, body });
    const hit = routes[`${method} ${path}`] ?? routes[path];
    const res = typeof hit === 'function' ? hit(body) : hit;
    if (res === undefined) return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'no mock' }) };
    if (res?.__status) return { ok: false, status: res.__status, text: async () => JSON.stringify(res.payload) };
    return { ok: true, status: 200, text: async () => JSON.stringify(res) };
  };
  return calls;
}

const settle = () => new Promise((r) => setTimeout(r, 4));
const flush = () => new Promise((r) => setTimeout(r, 360));

const CANDIDATES = {
  window: 'five_hour',
  usage: { percent: 37, resetsAt: '2030-01-01T11:47:00Z', checkedAt: '2030-01-01T09:40:00Z' },
  assumedCostPct: 1,
  minSamples: 3,
  slotMax: 200,
  jobs: [
    { id: 'a', name: 'Burn leftover quota on docs', type: 'claude', enabled: true, plannable: true, notPlannable: null, costPct: 6.8, samples: 9, source: 'learned', lowConfidence: false, blocked: null },
    { id: 'b', name: 'Flaky test hunter', type: 'command', enabled: true, plannable: true, notPlannable: null, costPct: 4.1, samples: 6, source: 'learned', lowConfidence: false, blocked: null },
    { id: 'c', name: 'bead wb-142', type: 'claude', enabled: false, plannable: false, notPlannable: { code: 'bead_backed', beadId: 'wb-142', message: 'bead-backed jobs cannot be planned: the scheduler runs those from their project' }, costPct: 1, samples: 0, source: 'assumed', lowConfidence: true, blocked: null },
  ],
};

const PLAN = {
  ok: true, window: 'five_hour', confidence: 'high', usablePct: 33, estTotalPct: 21.8,
  horizonEnd: '2030-01-01T11:47:00Z',
  slots: [
    { at: '2030-01-01T10:05:00Z', jobId: 'a', estPct: 6.8 },
    { at: '2030-01-01T10:30:00Z', jobId: 'b', estPct: 4.1 },
  ],
  assumptions: ['five_hour is at 37%'],
};

test('jsdom: the burn-down dialog lists eligible jobs with costs and excluded ones with reasons', async () => {
  mountDom();
  mockFetch({ '/api/v2/plan-candidates?window=five_hour': CANDIDATES, 'POST /api/budget/plan': PLAN });
  const { openBurnDownDialog } = await import(`../public/v2/pages/plan-dialogs.js?bd=${Date.now()}`);
  openBurnDownDialog({});
  await settle(); await settle();

  const wrap = document.querySelector('.modalwrap');
  assert.match(wrap.textContent, /avg 6\.80% per run over 9 runs/);
  assert.match(wrap.textContent, /bead-backed jobs cannot be planned/);
  // A shell job is plannable — the mockup's "Claude jobs only" legend is wrong.
  assert.match(wrap.textContent, /Flaky test hunter/);
  assert.ok(!/Claude jobs only/.test(wrap.textContent));
  // Nothing is pre-selected: composing the plan is the reader's decision.
  assert.deepEqual([...wrap.querySelectorAll('.defrow input:not([disabled])')].map((b) => b.checked), [false, false]);
  const confirm = [...wrap.querySelectorAll('.modal__foot button')].pop();
  assert.equal(confirm.disabled, true, 'nothing to confirm before a plan exists');
});

test('jsdom: choosing jobs asks the SERVER for a plan and renders its slots', async () => {
  mountDom();
  const calls = mockFetch({ '/api/v2/plan-candidates?window=five_hour': CANDIDATES, 'POST /api/budget/plan': PLAN });
  const { openBurnDownDialog } = await import(`../public/v2/pages/plan-dialogs.js?bd2=${Date.now()}`);
  openBurnDownDialog({});
  await settle(); await settle();

  document.querySelector('.defrow input:not([disabled])').click();
  await flush(); await settle();

  const planCall = calls.find((c) => c.path === '/api/budget/plan');
  assert.ok(planCall, 'the plan came from the server');
  assert.deepEqual(planCall.body.jobIds, ['a']);
  assert.equal(planCall.body.window, 'five_hour');

  const wrap = document.querySelector('.modalwrap');
  const cells = [...wrap.querySelectorAll('.dtable tbody td')].map((td) => td.textContent);
  assert.ok(cells.includes('Burn leftover quota on docs'), cells.join(' | '));
  // The projection runs forward from the current 37%.
  assert.ok(cells.includes('43.80%'), cells.join(' | '));
  assert.ok(cells.includes('47.90%'), cells.join(' | '));
  assert.match(wrap.querySelector('.modal__consequence').textContent, /Creates 2 one-shot fires/);
});

test('jsdom: confirming sends the server\'s own slots back, unmodified', async () => {
  mountDom();
  const calls = mockFetch({
    '/api/v2/plan-candidates?window=five_hour': CANDIDATES,
    'POST /api/budget/plan': PLAN,
    'POST /api/budget/plan/apply': { ok: true, added: 2, jobs: [], enabled: [] },
  });
  const { openBurnDownDialog } = await import(`../public/v2/pages/plan-dialogs.js?bd3=${Date.now()}`);
  openBurnDownDialog({});
  await settle(); await settle();
  document.querySelector('.defrow input:not([disabled])').click();
  await flush(); await settle();

  [...document.querySelectorAll('.modal__foot button')].pop().click();
  await settle(); await settle(); await settle();

  const apply = calls.find((c) => c.path === '/api/budget/plan/apply');
  assert.ok(apply, 'the confirm went out');
  // Verbatim: the same times and job ids the server planned, no client-side
  // rounding, re-spacing or re-ordering.
  assert.deepEqual(apply.body.slots, [
    { at: '2030-01-01T10:05:00Z', jobId: 'a' },
    { at: '2030-01-01T10:30:00Z', jobId: 'b' },
  ]);
  assert.ok(!document.querySelector('.modalwrap'), 'the dialog closes on success');
});

test('jsdom: a plan the server refuses is shown in the server\'s own words', async () => {
  mountDom();
  mockFetch({
    '/api/v2/plan-candidates?window=five_hour': CANDIDATES,
    'POST /api/budget/plan': { ok: false, reason: 'five_hour is at 99% and the guard reserves everything past 80% — nothing to plan' },
  });
  const { openBurnDownDialog } = await import(`../public/v2/pages/plan-dialogs.js?bd4=${Date.now()}`);
  openBurnDownDialog({});
  await settle(); await settle();
  document.querySelector('.defrow input:not([disabled])').click();
  await flush(); await settle();

  const wrap = document.querySelector('.modalwrap');
  assert.match(wrap.textContent, /the guard reserves everything past 80%/);
  assert.equal([...wrap.querySelectorAll('.modal__foot button')].pop().disabled, true);
});

const PROJECTS = {
  projects: [
    { id: 'p1', name: 'webapp-billing', state: 'active', busyStreak: 0, ready: { count: 4 }, config: { autoLabel: 'scheduler-ok', defaults: { permMode: 'acceptEdits' }, budget: { minHeadroomPct: 15 } } },
    { id: 'p2', name: 'design-system', state: 'paused', busyStreak: 0, ready: { count: 2 }, config: {} },
  ],
  bd: { version: '0.9.4' }, roots: [], pollSec: 60,
};

const BURST_PLAN = {
  ok: true, window: 'five_hour', budgetPct: 10, confidence: 'low',
  slots: ['2030-01-01T10:05:00Z', '2030-01-01T10:20:00Z', '2030-01-01T10:35:00Z'],
  projects: [{ id: 'p1', name: 'webapp-billing', readyCount: 4 }],
  estimate: { perRunPct: 4.2, expectedRuns: 3, source: 'learned', samples: 14 },
  usablePct: 33, estTotalPct: 12.6, horizonEnd: '2030-01-01T11:47:00Z', minGapMin: 8, assumptions: [], excluded: [],
};

const burstRoutes = (over = {}) => ({
  '/api/projects': PROJECTS,
  '/api/bursts': { active: null },
  '/api/v2/plan-candidates?window=five_hour': CANDIDATES,
  'POST /api/bursts/plan': BURST_PLAN,
  ...over,
});

test('jsdom: the burst dialog excludes a non-activated project with the airlock\'s reason', async () => {
  mountDom();
  mockFetch(burstRoutes());
  const { openBurstDialog } = await import(`../public/v2/pages/plan-dialogs.js?bu=${Date.now()}`);
  openBurstDialog({});
  await settle(); await settle();
  await flush();

  const wrap = document.querySelector('.modalwrap');
  assert.match(wrap.textContent, /webapp-billing/);
  assert.match(wrap.textContent, /only an activated project can contribute/);
  // The fail-closed statement is present whether or not a plan exists.
  assert.match(wrap.textContent, /Fails closed/);
  assert.match(wrap.textContent, /refuses to run blind/);
});

test('jsdom: the burst preview reports one attempt count, not a range, and a two-state confidence', async () => {
  mountDom();
  mockFetch(burstRoutes());
  const { openBurstDialog } = await import(`../public/v2/pages/plan-dialogs.js?bu2=${Date.now()}`);
  openBurstDialog({});
  await settle(); await settle();
  await flush(); await settle();

  const wrap = document.querySelector('.modalwrap');
  const facts = [...wrap.querySelectorAll('.fact')].map((f) => `${f.querySelector('.fact__k').textContent}=${f.querySelector('.fact__v').textContent}`);
  assert.ok(facts.includes('Attempts planned=3'), facts.join(' | '));
  assert.ok(facts.includes('Confidence=low'), facts.join(' | '));
  assert.ok(!/medium/i.test(wrap.textContent), 'there is no medium confidence');
  assert.ok(!/2–3|2-3/.test(wrap.textContent), 'no invented run range');
  assert.match(wrap.querySelector('.modal__consequence').textContent, /Claims up to 3 beads from webapp-billing/);
});

test('jsdom: starting a burst sends the server\'s slots, and a live burst blocks the button', async () => {
  mountDom();
  const calls = mockFetch(burstRoutes({ 'POST /api/bursts': { ok: true, burst: { id: 'b1' } } }));
  const { openBurstDialog } = await import(`../public/v2/pages/plan-dialogs.js?bu3=${Date.now()}`);
  openBurstDialog({});
  await settle(); await settle();
  await flush(); await settle();

  [...document.querySelectorAll('.modal__foot button')].pop().click();
  await settle(); await settle(); await settle();
  const post = calls.find((c) => c.path === '/api/bursts' && c.method === 'POST');
  assert.ok(post);
  assert.deepEqual(post.body.slots, BURST_PLAN.slots, 'the server\'s own timetable, verbatim');
  assert.deepEqual(post.body.projectIds, ['p1']);

  // …and with a burst already running, the confirm is dead with the reason.
  mountDom();
  mockFetch(burstRoutes({ '/api/bursts': { active: { id: 'b9', projectIds: [], slots: [] } } }));
  const { openBurstDialog: open2 } = await import(`../public/v2/pages/plan-dialogs.js?bu4=${Date.now()}`);
  open2({});
  await settle(); await settle();
  await flush(); await settle();
  const btn = [...document.querySelectorAll('.modal__foot button')].pop();
  assert.equal(btn.disabled, true);
  assert.match(document.querySelector('.modalwrap').textContent, /A burst is already running/);
});

test('jsdom: both dialogs are labelled modals with a named close control', async () => {
  mountDom();
  mockFetch(burstRoutes());
  const mod = await import(`../public/v2/pages/plan-dialogs.js?a11y=${Date.now()}`);
  for (const [open, label] of [[mod.openBurnDownDialog, 'Plan a burn-down'], [mod.openBurstDialog, 'Start a burst']]) {
    open({});
    await settle(); await settle();
    const modal = document.querySelector('.modalwrap .modal');
    assert.equal(modal.getAttribute('role'), 'dialog');
    assert.equal(modal.getAttribute('aria-modal'), 'true');
    assert.equal(modal.getAttribute('aria-label'), label);
    const close = modal.querySelector('.iconbtn');
    const name = close.getAttribute('aria-label') ?? '';
    // iconBtn() only refuses an EMPTY label, so "truthy" is too weak a check —
    // a mutation to "x" sailed through the first version of this assertion.
    // An accessible name has to say what the control DOES.
    assert.ok(name.trim().split(/\s+/).length >= 2, `"${name}" is not an accessible name`);
    assert.match(name, /close/i);
    assert.ok(close.getAttribute('data-tip'));
    document.querySelector('.modalwrap').remove();
  }
});
