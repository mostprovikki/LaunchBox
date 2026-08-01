// Jobs tab (claude-scheduler-btv.5 / B1). Two layers:
//  - pure logic (public/v2/pages/jobs-logic.js) — no DOM, the row-grammar/
//    reason-per-state decisions REVIEW.md calls out as the design's single
//    best property.
//  - jsdom render/interaction tests for public/v2/pages/jobs.js against a
//    mocked fetch — the empty/no-match states, the a11y icon-button
//    contract, the data-mutating contract (including the one subtlety this
//    page has to get right: a Run button disabled because the job is
//    ALREADY running must never be swept back to life by the central
//    degraded-state recovery, because that disable is a business fact, not
//    a connectivity one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  fmtDuration, ordinal, scheduleDescribe, reasonText, stopReasonText,
  computeRowState, filterJobs, attentionByJobId, runningByJobId, jobDetailLine, typeBadge,
} from '../public/v2/pages/jobs-logic.js';

// ---------------- pure logic ----------------

test('fmtDuration: minutes+seconds, always two-digit seconds, never bare seconds', () => {
  assert.equal(fmtDuration(41000), '0m 41s');
  assert.equal(fmtDuration(125000), '2m 05s');
  assert.equal(fmtDuration(null), null);
});

test('ordinal: teens are always -th regardless of last digit', () => {
  assert.equal(ordinal(1), '1st');
  assert.equal(ordinal(3), '3rd');
  assert.equal(ordinal(11), '11th');
  assert.equal(ordinal(21), '21st');
});

test('scheduleDescribe: recognises the common cron shapes public/app.js also special-cases', () => {
  assert.equal(scheduleDescribe({ type: 'cron', expr: '15 2 * * *' }), 'daily 02:15');
  assert.equal(scheduleDescribe({ type: 'cron', expr: '0 6 * * 1-5' }), 'weekdays 06:00');
  assert.equal(scheduleDescribe({ type: 'cron', expr: '0 */6 * * *' }), 'every 6h');
  assert.equal(scheduleDescribe({ type: 'afterReset', window: 'five_hour', offsetMin: 3 }), 'after 5-hour reset +3m');
  assert.equal(scheduleDescribe(null), 'no schedule');
});

test('reasonText decodes every /api/v2/overview skip-reason code the mockups show text for', () => {
  assert.equal(reasonText({ code: 'reserve', windowLabel: '5h', usedPct: 82 }), 'would breach 5h reserve');
  assert.equal(reasonText({ code: 'bucket_severity', bucket: 'fable', percent: 90, severity: 'critical' }), 'fable at 90%');
  assert.equal(reasonText({ code: 'job_min_headroom', minHeadroomPct: 40, leftPct: 12 }), 'needs 40% headroom (12% left)');
  assert.equal(reasonText({ code: 'other', message: 'some future sentence' }), 'some future sentence');
  assert.equal(reasonText(null), null);
});

test('stopReasonText: only names "soft pause" when the run\'s own stopReason says so — never invented for a manual stop', () => {
  assert.equal(stopReasonText({ stopReason: 'paused (soft)' }), 'wound down during soft pause');
  assert.equal(stopReasonText({ stopReason: 'stop requested' }), 'stopped — not a failure');
  assert.equal(stopReasonText(null), 'stopped — not a failure');
});

test('jobDetailLine: command jobs show the command, claude jobs show cwd (+model when pinned away from default)', () => {
  assert.equal(jobDetailLine({ type: 'command', params: { command: 'git pull' } }), 'git pull');
  assert.equal(jobDetailLine({ type: 'claude', cwd: '~/proj', params: {} }), '~/proj');
  assert.equal(jobDetailLine({ type: 'claude', cwd: '~/proj', params: { model: 'sonnet' } }), '~/proj · model sonnet');
  assert.equal(jobDetailLine({ type: 'claude', cwd: '~/proj', params: { model: 'default' } }), '~/proj');
});

test('typeBadge: SH for command, CL for claude, extension name feeds the tooltip', () => {
  assert.deepEqual(typeBadge('command', {}), { code: 'SH', info: false, tip: 'Shell command' });
  assert.deepEqual(typeBadge('claude', {}), { code: 'CL', info: true, tip: 'Claude job' });
  assert.equal(typeBadge('claude', { claude: 'Claude Agent' }).tip, 'Claude Agent');
});

test('computeRowState: a live run (from /api/v2/overview running[]) always wins, even over a disabled/queued job flag', () => {
  const job = { id: 'j1', enabled: false, lastRun: { status: 'queued', startedAt: '2026-01-01T00:00:00Z' } };
  const running = runningByJobId({ running: { runs: [{ jobId: 'j1', startedAt: '2026-01-01T00:00:00Z', elapsedMs: 5000 }] } });
  const s = computeRowState(job, { running, attention: new Map() });
  assert.equal(s.stateClass, 'info');
  assert.equal(s.label, 'running');
});

test('computeRowState: disabled job shows "disabled" + last real status, or "has never run" — never the raw lastRun status alone', () => {
  const withHistory = computeRowState(
    { id: 'j2', enabled: false, lastRun: { status: 'ok', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:18.000Z' } },
    { attention: new Map(), running: new Map(), now: new Date('2026-01-01T01:00:00Z').getTime() },
  );
  assert.equal(withHistory.label, 'disabled');
  assert.equal(withHistory.dotForm, 'solid');
  assert.match(withHistory.l2, /ok$/);

  const never = computeRowState({ id: 'j3', enabled: false, lastRun: null }, { attention: new Map(), running: new Map() });
  assert.equal(never.l2, 'has never run');
});

test('computeRowState: timeout streak text only appears when /api/v2/overview attention says streak > 1, and uses the real ordinal', () => {
  const job = { id: 'j4', enabled: true, lastRun: { status: 'timeout', startedAt: '2026-01-01T08:00:00Z', finishedAt: '2026-01-01T08:15:00Z' } };
  const attention = attentionByJobId({ attention: { asOf: '2026-01-01T00:00:00Z', items: [{ jobId: 'j4', kind: 'timeout', reason: { code: 'timeout', streak: 3 } }] } });
  const withStreak = computeRowState(job, { attention, running: new Map(), now: new Date('2026-01-01T09:00:00Z').getTime() });
  assert.match(withStreak.l2, /3rd in a row/);
  assert.equal(withStreak.dotForm, 'ring');

  const noStreak = computeRowState(job, { attention: new Map(), running: new Map(), now: new Date('2026-01-01T09:00:00Z').getTime() });
  assert.doesNotMatch(noStreak.l2, /in a row/);

  // A first-time timeout (streak of exactly 1) is not "in a row" — only a
  // repeat is. Distinct from the no-attention-entry case above: this one DOES
  // carry a real streak value, just not one worth naming.
  const streakOfOne = attentionByJobId({ attention: { asOf: '2026-01-01T00:00:00Z', items: [{ jobId: 'j4', kind: 'timeout', reason: { code: 'timeout', streak: 1 } }] } });
  const single = computeRowState(job, { attention: streakOfOne, running: new Map(), now: new Date('2026-01-01T09:00:00Z').getTime() });
  assert.doesNotMatch(single.l2, /in a row/, 'a streak of 1 is just a timeout, not "in a row"');
});

test('computeRowState: killed never claims a specific cause the API cannot support (no meta reason exists for kill())', () => {
  const job = { id: 'j5', enabled: true, lastRun: { status: 'killed', startedAt: '2026-01-01T03:00:00Z', finishedAt: '2026-01-01T03:00:05Z' } };
  const s = computeRowState(job, { attention: new Map(), running: new Map() });
  assert.equal(s.dotForm, 'square');
  assert.doesNotMatch(s.l2, /hard stop was active/, 'must not invent a cause the run record does not carry');
  assert.match(s.l2, /stopped immediately/);
});

test('computeRowState: skipped renders the decoded reserve/severity reason, not the raw regex-matched sentence', () => {
  const job = { id: 'j6', enabled: true, lastRun: { status: 'skipped', skipReason: 'reserving 5h headroom (82% used)' } };
  const attention = attentionByJobId({ attention: { asOf: '2026-01-01T00:00:00Z', items: [{ jobId: 'j6', kind: 'skipped', reason: { code: 'reserve', windowLabel: '5h', usedPct: 82 } }] } });
  const s = computeRowState(job, { attention, running: new Map() });
  assert.equal(s.l2, 'would breach 5h reserve');
});

test('attentionByJobId: reads the real GET /api/v2/overview wrapper — {attention:{asOf,items:[...]}} — not a bare array', () => {
  // Caught live (not by jsdom): server.js sends `attention: { asOf, items }`;
  // an earlier version of this file assumed `attention` was the array itself
  // and threw "object is not iterable" against the real endpoint.
  const map = attentionByJobId({ attention: { asOf: '2026-01-01T00:00:00Z', items: [{ jobId: 'j9', kind: 'killed', reason: { code: 'killed' } }] } });
  assert.equal(map.get('j9')?.kind, 'killed');
  assert.equal(attentionByJobId(null).size, 0, 'must not throw on a missing overview (additive endpoint unreachable)');
  assert.equal(attentionByJobId({}).size, 0, 'must not throw when attention itself is absent');
});

test('filterJobs: query matches name/cwd/schedule/params; type seg narrows to claude|command', () => {
  const jobs = [
    { id: 'a', type: 'command', name: 'Backup to NAS', cwd: '~', params: { command: 'rsync -a ~/work nas:/backup' }, schedule: { type: 'cron', expr: '15 2 * * *' } },
    { id: 'b', type: 'claude', name: 'Sync tokens', cwd: '~/design-system', params: { prompt: 'sync' }, schedule: { type: 'cron', expr: '0 */6 * * *' } },
  ];
  assert.equal(filterJobs(jobs, { query: 'nas', type: 'all' }).length, 1);
  assert.equal(filterJobs(jobs, { query: 'design-system', type: 'all' })[0].id, 'b');
  assert.equal(filterJobs(jobs, { query: '', type: 'claude' }).length, 1);
  assert.equal(filterJobs(jobs, { query: 'postgres', type: 'all' }).length, 0);
});

// ---------------- jsdom render/interaction ----------------

function freshDom() {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<header class="appbar"><nav id="v2-nav"></nav><div id="v2-chips"></div></header>'
    + '<div id="v2-banner" hidden></div><main><div id="v2-page"></div></main>'
    + '</body></html>', { url: 'http://127.0.0.1:43410/v2', pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.history = dom.window.history;
  globalThis.localStorage = dom.window.localStorage;
  return dom;
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// jobs.js arms a real setInterval poll loop keyed off module-scope state; a
// fresh module per test (via cache-busting the import) means a fresh timer
// every test, and node --test's process would otherwise accumulate live
// (if unref'd, harmless-but-noisy) timers across ~15 tests. Replacing
// setInterval with a fake handle removes the accumulation entirely — jobs.js
// still gets ONE real load (called synchronously before setInterval is
// armed), it just never auto-polls again inside this suite, which is what a
// deterministic test wants anyway.
globalThis.setInterval = () => ({});
globalThis.clearInterval = () => {};

function mockApi({ jobs = [], running = 0, overview = { attention: [], running: { runs: [] } }, extensions = [] } = {}) {
  const calls = [];
  globalThis.fetch = async (path, opts) => {
    calls.push({ path, method: opts?.method ?? 'GET', body: opts?.body ? JSON.parse(opts.body) : undefined });
    if (path === '/api/jobs') return { ok: true, status: 200, text: async () => JSON.stringify({ jobs, running }) };
    if (path === '/api/v2/overview') return { ok: true, status: 200, text: async () => JSON.stringify(overview) };
    if (path === '/api/extensions') return { ok: true, status: 200, text: async () => JSON.stringify({ extensions }) };
    if (/^\/api\/jobs\/[^/]+$/.test(path) && opts?.method === 'DELETE') return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    if (/^\/api\/jobs\/[^/]+$/.test(path) && opts?.method === 'PUT') {
      const id = path.split('/').pop();
      const job = jobs.find((j) => j.id === id) ?? {};
      const patch = opts.body ? JSON.parse(opts.body) : {};
      return { ok: true, status: 200, text: async () => JSON.stringify({ ...job, ...patch }) };
    }
    if (/\/run$/.test(path) && opts?.method === 'POST') return { ok: true, status: 202, text: async () => JSON.stringify({ status: 'ok' }) };
    return { ok: true, status: 200, text: async () => '{}' };
  };
  return calls;
}

const CLAUDE_JOB = {
  id: 'c1', name: 'Sync design tokens', type: 'claude', cwd: '~/design-system', enabled: true,
  params: { prompt: 'sync', model: 'default' }, schedule: { type: 'cron', expr: '0 */6 * * *' },
  nextFire: null, lastRun: { id: 'r1', status: 'ok', startedAt: '2026-01-01T06:00:00Z', finishedAt: '2026-01-01T06:02:00Z' },
};
const SHELL_JOB_RUNNING = {
  id: 's1', name: 'Rotate and ship logs', type: 'command', cwd: '~', enabled: true,
  params: { command: 'logrotate' }, schedule: { type: 'cron', expr: '7 * * * *' },
  nextFire: '2099-01-01T10:07:00Z', lastRun: { id: 'r2', status: 'running', startedAt: '2026-01-01T09:39:00Z', finishedAt: null },
};

test('jobs tab: empty state names what was checked and offers the create action (no "Plan burn-down" chip, per REVIEW.md\'s removed-contradiction fix)', async () => {
  freshDom();
  mockApi({ jobs: [] });
  const { default: jobsPage } = await import(`../public/v2/pages/jobs.js?t=${Date.now()}_empty`);
  jobsPage(new URLSearchParams());
  await tick();

  const page = document.getElementById('v2-page');
  assert.match(page.textContent, /Nothing is scheduled/);
  assert.match(page.textContent, /No jobs yet/);
  assert.equal(page.querySelectorAll('.jobrow').length, 0);
  assert.ok(!/Plan burn-down/.test(page.textContent), 'empty state must not offer/imply an action tied to jobs that do not exist');
  const createBtn = [...page.querySelectorAll('button')].find((b) => /Create the first job/.test(b.textContent));
  assert.ok(createBtn, 'empty state must offer the next action');
  assert.ok(createBtn.hasAttribute('data-mutating'), 'create-first-job action must be swept under daemon-unreachable/token-invalid');
});

test('jobs tab: populated rows carry the right type badges, and every iconbtn has an aria-label (REVIEW #5)', async () => {
  freshDom();
  mockApi({ jobs: [CLAUDE_JOB, SHELL_JOB_RUNNING], running: 1 });
  const { default: jobsPage } = await import(`../public/v2/pages/jobs.js?t=${Date.now()}_rows`);
  jobsPage(new URLSearchParams());
  await tick();

  const page = document.getElementById('v2-page');
  const rows = page.querySelectorAll('.row.jobrow:not(.row--head)');
  assert.equal(rows.length, 2);
  assert.match(page.querySelector('.ftype.ftype--info').textContent, /CL/);
  assert.ok([...page.querySelectorAll('.ftype')].some((f) => f.textContent === 'SH'));

  for (const btn of page.querySelectorAll('button.iconbtn')) {
    assert.ok(btn.getAttribute('aria-label'), `every iconbtn must carry aria-label — found one without: ${btn.outerHTML}`);
  }
});

test('jobs tab: the Run button on an already-running row is disabled WITH a reason, and is NOT data-mutating (REVIEW #2 subtlety)', async () => {
  freshDom();
  mockApi({ jobs: [SHELL_JOB_RUNNING], running: 1 });
  const { default: jobsPage } = await import(`../public/v2/pages/jobs.js?t=${Date.now()}_running`);
  jobsPage(new URLSearchParams());
  await tick();

  const page = document.getElementById('v2-page');
  const runBtn = page.querySelector('button[aria-label^="Already running"]');
  assert.ok(runBtn, 'expected the already-running Run button');
  assert.equal(runBtn.disabled, true);
  assert.equal(runBtn.getAttribute('data-tip'), 'Already running — manage it from Runs');
  assert.equal(runBtn.hasAttribute('data-mutating'), false,
    'a business-state disable must not be swept by the central degraded-state recovery, which would wrongly re-enable it once the daemon is healthy again');
});

test('jobs tab: a runnable (not currently running) row\'s Run/Edit/Clone/Delete/switch are all data-mutating', async () => {
  freshDom();
  mockApi({ jobs: [CLAUDE_JOB] });
  const { default: jobsPage } = await import(`../public/v2/pages/jobs.js?t=${Date.now()}_mutating`);
  jobsPage(new URLSearchParams());
  await tick();

  const page = document.getElementById('v2-page');
  const rowact = page.querySelector('.rowact');
  const mutatingCount = rowact.querySelectorAll('[data-mutating]').length;
  assert.equal(mutatingCount, 5, 'expected run+edit+clone+delete+switch all marked data-mutating');
});

test('jobs tab: typing in the filter narrows the rows and never rebuilds the search input node (focus survives)', async () => {
  freshDom();
  mockApi({ jobs: [CLAUDE_JOB, SHELL_JOB_RUNNING] });
  const { default: jobsPage } = await import(`../public/v2/pages/jobs.js?t=${Date.now()}_filter`);
  jobsPage(new URLSearchParams());
  await tick();

  const page = document.getElementById('v2-page');
  const search = page.querySelector('#jobs-search');
  assert.ok(search);
  search.focus();
  search.value = 'design-system';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));

  assert.equal(page.querySelectorAll('.row.jobrow:not(.row--head)').length, 1);
  assert.equal(document.activeElement, search, 'the search input itself must not be replaced while typing');
});

test('jobs tab: a filter with no matches names the query and the total, and offers to clear it', async () => {
  freshDom();
  mockApi({ jobs: [CLAUDE_JOB, SHELL_JOB_RUNNING] });
  const { default: jobsPage } = await import(`../public/v2/pages/jobs.js?t=${Date.now()}_nomatch`);
  jobsPage(new URLSearchParams());
  await tick();

  const page = document.getElementById('v2-page');
  const search = page.querySelector('#jobs-search');
  search.value = 'postgres';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));

  assert.match(page.textContent, /No job matches "postgres"/);
  assert.match(page.textContent, /all 2 jobs were checked/);
  assert.equal(page.querySelectorAll('.row.jobrow:not(.row--head)').length, 0);
});

test('jobs tab: the enable switch calls PUT /api/jobs/:id with the new enabled value', async () => {
  freshDom();
  const calls = mockApi({ jobs: [CLAUDE_JOB] });
  const { default: jobsPage } = await import(`../public/v2/pages/jobs.js?t=${Date.now()}_toggle`);
  jobsPage(new URLSearchParams());
  await tick();

  const page = document.getElementById('v2-page');
  const sw = page.querySelector('.rowact .switch');
  assert.equal(sw.checked, true);
  sw.checked = false;
  sw.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();

  const put = calls.find((c) => c.method === 'PUT' && c.path === `/api/jobs/${CLAUDE_JOB.id}`);
  assert.ok(put, 'expected a PUT to /api/jobs/:id');
  assert.equal(put.body.enabled, false);
});

test('jobs tab: Delete asks for confirmation (window.confirm) before calling DELETE /api/jobs/:id, and does not call it when refused', async () => {
  freshDom();
  const calls = mockApi({ jobs: [CLAUDE_JOB] });
  const { default: jobsPage } = await import(`../public/v2/pages/jobs.js?t=${Date.now()}_delete`);
  jobsPage(new URLSearchParams());
  await tick();

  const page = document.getElementById('v2-page');
  const delBtn = page.querySelector('button[aria-label^="Delete this job"]');

  window.confirm = () => false;
  delBtn.click();
  await tick();
  assert.ok(!calls.some((c) => c.method === 'DELETE'), 'a refused confirm must not delete');

  window.confirm = () => true;
  delBtn.click();
  await tick();
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === `/api/jobs/${CLAUDE_JOB.id}`), 'a confirmed delete must call DELETE /api/jobs/:id');
});
