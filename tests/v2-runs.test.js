// btv.6 (B2): Runs tab + log drawer. jsdom runtime tests over the real
// public/v2/pages/runs.js + runs-log.js + runs-format.js modules — no DOM
// dump, the actual render/click/keydown code paths run. Style follows
// tests/frontend-v2-conventions.test.js's freshDom()/mockFetch() pattern.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

function freshDom(url = 'http://127.0.0.1:43410/v2#runs') {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<header class="appbar"><nav id="v2-nav"></nav><div id="v2-chips"></div></header>'
    + '<div id="v2-banner" hidden></div><main><div id="v2-page"></div></main>'
    + '</body></html>', { url, pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.history = dom.window.history;
  globalThis.localStorage = dom.window.localStorage;
  return dom;
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// runs.js arms a real 3s setInterval poll per mounted instance (several are
// mounted across this file's tests). .unref() (same trick
// tests/frontend-v2-conventions.test.js uses for chrome.js's 15s poll) stops
// a leftover timer from keeping `node --test` alive — the interval itself is
// untouched and irrelevant here since every assertion awaits a short tick()
// rather than the real 3s cadence.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const t = realSetInterval(fn, ms, ...rest);
  t?.unref?.();
  return t;
};

const JOB_A = { id: 'job-a', name: 'Rotate and ship logs', type: 'claude', timeoutMin: 60, enabled: true };
const JOB_B = { id: 'job-b', name: 'Backup to NAS', type: 'command', timeoutMin: 30, enabled: true };
const EXT_CLAUDE = { id: 'claude', runActions: [{ id: 'resume', label: 'Resume in Terminal', requiresRunMeta: 'sessionId' }] };
const EXT_COMMAND = { id: 'command', runActions: [] };

function baseRuns() {
  return [
    { id: 'run-run', jobId: 'job-a', status: 'running', trigger: 'schedule', startedAt: new Date().toISOString(), meta: { sessionId: 'sess-live' }, logPath: '/tmp/run-run.log' },
    { id: 'run-queued', jobId: 'job-a', status: 'queued', trigger: 'manual', createdAt: new Date().toISOString(), meta: null },
    { id: 'run-ok', jobId: 'job-a', status: 'ok', trigger: 'schedule', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 71_000, meta: null, logPath: '/tmp/run-ok.log' },
    { id: 'run-fail', jobId: 'job-b', status: 'fail', trigger: 'manual', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 5000, exitCode: 23, meta: null, logPath: '/tmp/run-fail.log' },
    { id: 'run-timeout', jobId: 'job-a', status: 'timeout', trigger: 'schedule', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 900_000, meta: { sessionId: 'sess-to' }, logPath: '/tmp/run-timeout.log' },
    { id: 'run-killed', jobId: 'job-b', status: 'killed', trigger: 'schedule', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 9000, meta: null, logPath: '/tmp/run-killed.log' },
    { id: 'run-stopped', jobId: 'job-a', status: 'stopped', trigger: 'schedule', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 220_000, meta: { stopReason: 'soft pause', stopRung: 'SIGINT' }, logPath: '/tmp/run-stopped.log' },
    { id: 'run-skipped', jobId: 'job-b', status: 'skipped', trigger: 'schedule', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), meta: { skipReason: 'reserving 5h headroom (82% used)' } },
  ];
}

function mockFetch({ runs = baseRuns(), overview = { attention: { items: [{ id: 'run-timeout', kind: 'timeout', reason: { streak: 3 } }] } }, logText = '09:00:00 line one\n09:00:01 Error: permission denied\n', settings = { softGraceMs: 120_000 } } = {}) {
  return async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method ?? 'GET';
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (u.startsWith('/api/jobs')) return json({ jobs: [JOB_A, JOB_B] });
    if (u.startsWith('/api/extensions')) return json({ extensions: [EXT_CLAUDE, EXT_COMMAND] });
    if (u.startsWith('/api/v2/overview')) return overview ? json(overview) : { ok: false, status: 404, text: async () => '{}' };
    if (/^\/api\/runs\/[^/]+\/log/.test(u)) return { ok: true, status: 200, text: async () => logText };
    if (/^\/api\/runs\/[^/]+\/(kill|stop|actions)/.test(u) && method === 'POST') return json({ ok: true });
    if (u.startsWith('/api/settings')) return json(settings);
    if (u.startsWith('/api/runs')) return json({ runs });
    if (/^\/api\/jobs\/[^/]+\/run/.test(u) && method === 'POST') return json({ ok: true });
    throw new Error(`unmocked fetch: ${method} ${u}`);
  };
}

async function mountRuns(fetchImpl) {
  freshDom();
  globalThis.fetch = fetchImpl;
  const mod = await import(`../public/v2/pages/runs.js?t=${Date.now()}_${Math.random()}`);
  mod.default(new URLSearchParams());
  await tick(60);
  return mod;
}

test('renders one row per run with the right dot form + state label per status', async () => {
  await mountRuns(mockFetch());
  const rows = [...document.querySelectorAll('.row.runrow:not(.row--head)')];
  assert.equal(rows.length, 8, 'one row per seeded run');

  const byStatusText = (txt) => rows.find((r) => r.querySelector('.state')?.textContent.includes(txt));
  assert.ok(byStatusText('running').querySelector('.state--info'));
  assert.ok(byStatusText('queued').querySelector('.state--muted .state__dot--ring'), 'queued: muted + ring dot');
  assert.ok(byStatusText('timeout').querySelector('.state--bad .state__dot--ring'), 'timeout: bad + ring dot (REVIEW.md dot-form table)');
  assert.ok(byStatusText('killed').querySelector('.state--bad .state__dot--square'), 'killed: bad + square dot');
  assert.ok(byStatusText('stopped').querySelector('.state--muted .state__dot--square'), 'stopped: muted + square dot');
  const failRow = rows.find((r) => r.querySelector('.state')?.textContent.trim() === 'fail');
  assert.ok(failRow, 'fail row present');
  assert.ok(failRow.querySelector('.state--bad'));
  assert.equal(failRow.querySelector('.state__dot').className.trim(), 'state__dot', 'fail dot is the plain/solid form, no ring or square modifier');
});

test('every state names its reason inline — REVIEW.md\'s called-out property, not just a colour', async () => {
  await mountRuns(mockFetch());
  const rows = [...document.querySelectorAll('.row.runrow:not(.row--head)')];
  const line2 = (id) => document.querySelector(`[data-run-probe="${id}"]`);
  // Rows aren't tagged with the run id in markup, so match on distinctive copy instead.
  const text = rows.map((r) => r.querySelector('.cell__l2').textContent);
  assert.ok(text.some((t) => t.includes('reserving 5h headroom (82% used)')), 'skipped row must show the real skip reason');
  assert.ok(text.some((t) => t.includes('3rd in a row')), 'timeout streak from /api/v2/overview must be surfaced as "Nth in a row"');
  assert.ok(text.some((t) => t.includes('exit') && t.includes('23')), 'fail row must show the real exit code');
  assert.ok(text.some((t) => t.includes('not a failure') || t.includes('soft pause')), 'stopped row must say it is not a failure');
  void line2;
});

test('finished-run action buttons are disabled with a reason and carry NO data-mutating (business-disabled, not daemon-disabled)', async () => {
  await mountRuns(mockFetch());
  const okRow = [...document.querySelectorAll('.row.runrow')].find((r) => r.querySelector('.state--ok'));
  const stopBtn = okRow.querySelectorAll('.iconbtn')[2]; // resume, wind-down, stop
  assert.equal(stopBtn.disabled, true);
  assert.equal(stopBtn.getAttribute('data-tip'), 'Run is over — nothing to stop');
  assert.equal(stopBtn.hasAttribute('data-mutating'), false,
    'a control the sweep can never correctly re-enable (finished run) must not carry data-mutating, or main.js\'s recovery sweep would wrongly re-enable it');
});

test('a live run\'s Wind down / Stop now buttons ARE data-mutating and wired to the real endpoints', async () => {
  const calls = [];
  const fx = mockFetch();
  await mountRuns(async (url, opts) => { if (opts?.method === 'POST') calls.push(String(url)); return fx(url, opts); });
  const runningRow = [...document.querySelectorAll('.row.runrow')].find((r) => r.querySelector('.state--info'));
  const [, windBtn, stopBtn] = runningRow.querySelectorAll('.iconbtn');
  assert.equal(windBtn.hasAttribute('data-mutating'), true);
  assert.equal(stopBtn.hasAttribute('data-mutating'), true);
  stopBtn.click();
  await tick(40);
  assert.ok(calls.some((c) => c.includes('/api/runs/run-run/kill')), 'Stop now must POST .../kill');
});

test('queued row\'s stop icon cancels via POST .../stop (not kill) — cancelling a queued fire is a clean stop', async () => {
  const calls = [];
  const fx = mockFetch();
  await mountRuns(async (url, opts) => { if (opts?.method === 'POST') calls.push(String(url)); return fx(url, opts); });
  const queuedRow = [...document.querySelectorAll('.row.runrow')].find((r) => r.querySelector('.state--muted')?.textContent.includes('queued'));
  const [, , cancelBtn] = queuedRow.querySelectorAll('.iconbtn');
  cancelBtn.click();
  await tick(40);
  assert.ok(calls.some((c) => c.includes('/api/runs/run-queued/stop')));
});

test('Resume in Terminal is enabled only when the run actually carries the required meta key', async () => {
  await mountRuns(mockFetch());
  const rows = [...document.querySelectorAll('.row.runrow')];
  const liveRow = rows.find((r) => r.querySelector('.state--info')); // run-run has sessionId
  const failRow = rows.find((r) => r.querySelector('.state')?.textContent.trim() === 'fail'); // job-b/command, no runActions at all
  assert.equal(liveRow.querySelectorAll('.iconbtn')[0].disabled, false, 'has sessionId -> resume enabled');
  const commandResume = failRow.querySelectorAll('.iconbtn')[0];
  assert.equal(commandResume.disabled, true, 'command job has no runActions -> resume stays disabled');
  assert.match(commandResume.getAttribute('data-tip'), /No Claude session to resume/);
});

test('a burst-triggered ok run links to the C3-owned session route (#session?id=…), not shown for an ordinary scheduled ok run with the same sessionId', async () => {
  const runs = baseRuns();
  runs.push({ id: 'run-burst', jobId: 'job-a', status: 'ok', trigger: 'burst', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 4000, meta: { sessionId: 'sess-burst' }, logPath: '/tmp/burst.log' });
  await mountRuns(mockFetch({ runs }));
  const rows = [...document.querySelectorAll('.row.runrow')];
  const burstRow = rows.find((r) => r.querySelector('.cell__l2')?.textContent.includes('burst attempt'));
  assert.ok(burstRow, 'burst attempt trigger label must render');
  const link = burstRow.querySelector('a[href^="#session?id="]');
  assert.ok(link, 'a burst run must link to the session transcript route');
  assert.equal(link.getAttribute('href'), '#session?id=sess-burst');

  // The plain scheduled ok run (run-ok) has no sessionId at all in this fixture,
  // so it must show neither a session mono span nor a transcript link.
  const okRow = rows.find((r) => r.querySelector('.cell__l2')?.textContent.trim() === triggerLabelText());
  function triggerLabelText() { return 'scheduled fire'; }
  assert.ok(okRow, 'plain scheduled ok row must render with just its trigger label, no session/transcript');
  assert.equal(okRow.querySelector('a[href^="#session?id="]'), null);
});

test('status segs partition every status exactly once and counts sum to All', async () => {
  await mountRuns(mockFetch());
  const segs = [...document.querySelectorAll('.segs .seg')];
  const countOf = (label) => Number(segs.find((s) => s.textContent.trim().startsWith(label)).querySelector('.seg__count').textContent);
  const all = countOf('All');
  const sum = ['Active', 'OK', 'Failed', 'Stopped', 'Skipped'].reduce((a, l) => a + countOf(l), 0);
  assert.equal(all, 8);
  assert.equal(sum, all, 'the 5 buckets must be a strict partition of All, not an overlapping grouping');
  assert.equal(countOf('Failed'), 3, 'Failed = fail + timeout + killed (1 each seeded)');
});

test('clicking a status seg updates location.hash, and re-rendering with that hash filters the rows', async () => {
  await mountRuns(mockFetch());
  const okSeg = [...document.querySelectorAll('.segs .seg')].find((s) => s.textContent.trim().startsWith('OK'));
  okSeg.click();
  assert.equal(location.hash, '#runs?status=ok');
  const mod = await import(`../public/v2/pages/runs.js?t=${Date.now()}_${Math.random()}`);
  mod.default(new URLSearchParams('status=ok'));
  await tick(60);
  const rows = [...document.querySelectorAll('.row.runrow:not(.row--head)')];
  assert.equal(rows.length, 1);
  assert.ok(rows[0].querySelector('.state--ok'));
});

test('empty state (no runs at all) names what was checked and offers Jobs as the next action', async () => {
  await mountRuns(mockFetch({ runs: [] }));
  const blank = document.querySelector('.blank');
  assert.ok(blank, 'empty state must render');
  assert.match(blank.textContent, /No runs recorded/);
  assert.match(blank.textContent, /2 jobs/, 'must name how many jobs were checked, not just say "empty"');
  assert.ok(blank.querySelector('a[href="#jobs"]'));
});

test('job-filtered empty state names the specific job and offers "show all" + "open the job"', async () => {
  freshDom();
  globalThis.fetch = mockFetch({ runs: [] });
  const mod = await import(`../public/v2/pages/runs.js?t=${Date.now()}_${Math.random()}`);
  mod.default(new URLSearchParams('job=job-a'));
  await tick(60);
  const blank = document.querySelector('.blank');
  assert.match(blank.textContent, /Rotate and ship logs/);
  assert.ok(blank.querySelector('a[href="#runs"]'));
  assert.ok(blank.querySelector('a[href="#jobs?job=job-a"]'));
});

// ---------------- log drawer ----------------

test('opening the log drawer on a FAILED run: banner explains it, log uses .logview mark on the error line, footer offers Run again', async () => {
  await mountRuns(mockFetch());
  const failRow = [...document.querySelectorAll('.row.runrow')].find((r) => r.querySelector('.state')?.textContent.trim() === 'fail');
  failRow.querySelector('a.btn').click(); // "Log"
  await tick(60);

  const drawer = document.querySelector('.drawer--log');
  assert.ok(drawer, 'drawer must be inserted');
  assert.equal(drawer.getAttribute('data-open'), '');
  assert.ok(document.querySelector('.scrim[data-open]'));
  assert.ok(drawer.querySelector('.banner--bad'), 'failed drawer must show the bad banner');
  assert.match(drawer.querySelector('.rowline').textContent, /run has finished — this log is final/);
  const mark = drawer.querySelector('.logview mark');
  assert.ok(mark, 'an error-looking log line must be wrapped in <mark> — the CSS-fixed regression (REVIEW.md) keys off this exact element');
  assert.match(mark.textContent, /permission denied/i);
  assert.ok(drawer.querySelector('.drawer__foot .btn--primary')?.textContent.includes('Run again now'));
});

test('opening the log drawer on a LIVE run shows the snapshot disclaimer (not a stream) and both stop controls, marked data-mutating', async () => {
  await mountRuns(mockFetch({ logText: '09:00:00 starting\n' }));
  const liveRow = [...document.querySelectorAll('.row.runrow')].find((r) => r.querySelector('.state--info'));
  liveRow.querySelector('a.btn').click();
  await tick(60);
  const drawer = document.querySelector('.drawer--log');
  assert.match(drawer.querySelector('.rowline').textContent, /does not stream; refresh to re-read it/);
  const footBtns = [...drawer.querySelectorAll('.drawer__foot .btn')];
  assert.equal(footBtns.length, 2, 'live, not-yet-stopped run gets Wind down + Stop now');
  assert.ok(footBtns.every((b) => b.hasAttribute('data-mutating')));
});

test('opening the log drawer on a run already winding down shows the winding-down banner and only "Stop now instead"', async () => {
  const runs = baseRuns();
  runs.push({ id: 'run-winding', jobId: 'job-a', status: 'running', trigger: 'schedule', startedAt: new Date().toISOString(), meta: { stopReason: 'soft pause', stopRung: 'SIGINT' }, logPath: '/tmp/w.log' });
  await mountRuns(mockFetch({ runs }));
  const row = [...document.querySelectorAll('.row.runrow')].find((r) => r.querySelector('.cell__l2')?.textContent.includes('winding down'));
  assert.ok(row, 'a live run with stopRung set must say "winding down" inline');
  row.querySelector('a.btn').click();
  await tick(60);
  const drawer = document.querySelector('.drawer--log');
  assert.match(drawer.querySelector('.banner').textContent, /Winding down/);
  assert.match(drawer.querySelector('.banner').textContent, /120s/, 'grace period must come from the real /api/settings softGraceMs, not a hardcoded guess');
  const footBtns = [...drawer.querySelectorAll('.drawer__foot .btn')];
  assert.equal(footBtns.length, 1);
  assert.match(footBtns[0].textContent, /Stop now instead/);
});

test('Escape closes the drawer and restores focus to the row\'s Log control', async () => {
  await mountRuns(mockFetch());
  const failRow = [...document.querySelectorAll('.row.runrow')].find((r) => r.querySelector('.state')?.textContent.trim() === 'fail');
  const logLink = failRow.querySelector('a.btn');
  logLink.click();
  await tick(60);
  assert.ok(document.querySelector('.drawer--log'));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick(20);
  assert.equal(document.querySelector('.drawer--log'), null, 'Escape must close the drawer');
  assert.equal(document.activeElement, logLink, 'focus must return to the control that opened it');
});

test('clicking the scrim closes the drawer', async () => {
  await mountRuns(mockFetch());
  const failRow = [...document.querySelectorAll('.row.runrow')].find((r) => r.querySelector('.state')?.textContent.trim() === 'fail');
  failRow.querySelector('a.btn').click();
  await tick(60);
  document.querySelector('.scrim').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(20);
  assert.equal(document.querySelector('.drawer--log'), null);
});

test('navigating away from the runs route closes an open drawer', async () => {
  const mod = await mountRuns(mockFetch());
  const failRow = [...document.querySelectorAll('.row.runrow')].find((r) => r.querySelector('.state')?.textContent.trim() === 'fail');
  failRow.querySelector('a.btn').click();
  await tick(60);
  assert.ok(document.querySelector('.drawer--log'));
  const router = await import('../public/v2/router.js');
  router.registerRoute('elsewhere', () => {});
  location.hash = '#elsewhere';
  await router.startRouter();
  await tick(20);
  assert.equal(document.querySelector('.drawer--log'), null, 'a route change away from runs must not leave the drawer floating over the new page');
  void mod;
});

test('the OWN end-of-render sweep catches degraded state even when it arrives AFTER the row data already loaded (the /api/v2/overview call, awaited separately, 401s)', async () => {
  // api.js's api() resets authState to null on EVERY successful round-trip
  // (see its own comment: "whatever degraded state was showing is over") —
  // so a page whose OWN main fetch fails can never reach its render step at
  // all (loadAndRender's try/catch returns early, see runs.js). The one real
  // window where rows get built from good data AND the sweep still needs to
  // catch a degraded state is exactly this: /api/jobs, /api/extensions and
  // /api/runs all succeed (rows are real), but the separate, best-effort
  // /api/v2/overview call (awaited afterwards, its own try/catch) 401s —
  // leaving authState degraded by the time disableMutatingControls(els.page,
  // degradedReason()) runs. main.js is not imported in this test, so this can
  // only pass via runs.js's own sweep call.
  freshDom();
  const fx = mockFetch();
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('/api/v2/overview')) return { ok: false, status: 401, text: async () => JSON.stringify({ error: 'nope', code: 'token_invalid' }) };
    return fx(url, opts);
  };

  const mod = await import(`../public/v2/pages/runs.js?t=${Date.now()}_${Math.random()}`);
  mod.default(new URLSearchParams());
  await tick(80);

  const api = await import('../public/v2/api.js');
  assert.equal(api.getAuthState(), 'token_invalid', 'sanity: the overview 401 must have left the client degraded');

  const rows = document.querySelectorAll('.row.runrow:not(.row--head)');
  assert.ok(rows.length > 0, 'sanity: the main run data must still have rendered — only the streak lookup failed');
  const anyMutating = document.querySelector('[data-mutating]');
  assert.ok(anyMutating, 'sanity: some data-mutating control must have rendered');
  assert.equal(anyMutating.disabled, true, 'a control built while the app is (now) degraded must render disabled, even though the row DATA itself loaded fine');
});
