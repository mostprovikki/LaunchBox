// Sessions tab + transcript page (claude-scheduler-btv.10 / C3). Three layers,
// same shape as C2's suite:
//
//  - pure logic (public/v2/pages/sessions-logic.js) — the model mix, the
//    filter/sort, the tool summaries, the TASK-COMPLETE marker.
//  - jsdom render/interaction for sessions.js and session.js against a mocked
//    fetch — REVIEW #4's arm-then-confirm delete (the property that matters:
//    the FIRST click sends nothing), the collapsed/expanded tool blocks, the
//    stranded and unavailable states.
//  - source-level gates pinning the five mockup claims this bead established
//    it cannot truthfully render.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  fmtWhen, relAgo, fmtDur, fmtCount, fmtBytes, modelShortName, modelMix, modelText,
  modelTextCompact, turnCount, sessionTitle, shortId, isFromJob, jobTag,
  filterSessions, scopeCounts, pairTurns, toolSummary, toolOpensByDefault,
  diffLines, taskCompleteMarker, transcriptCounts, truncate,
} from '../public/v2/pages/sessions-logic.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readV2 = (rel) => readFileSync(join(ROOT, 'public', 'v2', rel), 'utf8');

// ---------------------------------------------------------------- pure logic

test('fmtDur changes precision with magnitude, as the mockups do', () => {
  assert.equal(fmtDur(41_000), '0m 41s');
  assert.equal(fmtDur(891_000), '14m 51s');
  assert.equal(fmtDur(7_560_000), '2h 06m');
  assert.equal(fmtDur(100_000_000), '1d 3h');
  assert.equal(fmtDur(null), null);
  assert.equal(fmtDur(-5), null);
});

test('fmtCount and fmtBytes match the mockups and never print NaN', () => {
  assert.equal(fmtCount(1_900_000), '1.9M');
  assert.equal(fmtCount(31_200), '31.2k');
  assert.equal(fmtCount(204), '204');
  assert.equal(fmtCount(null), '—');
  assert.equal(fmtBytes(42_000_000), '42 MB');
  assert.equal(fmtBytes(812_000), '812 kB');
  assert.equal(fmtBytes(undefined), '—');
});

test('fmtWhen switches to a date once a session is over a week old', () => {
  const now = Date.parse('2026-08-01T12:00:00');
  assert.equal(fmtWhen('2026-07-31T23:12:00', now), 'Fri 23:12');
  assert.equal(fmtWhen('2026-07-01T09:05:00', now), '1 Jul 09:05');
  assert.equal(fmtWhen(null, now), null);
  assert.equal(relAgo('2026-08-01T02:00:00', now), '10h ago');
});

test('modelShortName reduces a full model id to its family, and keeps an unknown id whole', () => {
  assert.equal(modelShortName('claude-sonnet-4-5-20250929'), 'sonnet');
  assert.equal(modelShortName('claude-opus-5'), 'opus');
  assert.equal(modelShortName('claude-haiku-4-5-20251001'), 'haiku');
  // Never bucketed into a guess: an id we do not recognise is shown as itself.
  assert.equal(modelShortName('some-future-model'), 'some-future-model');
});

test('modelMix folds ids into families, weights by turns, and sorts biggest first', () => {
  const models = {
    'claude-opus-5': { turns: 71 },
    'claude-sonnet-4-5-20250929': { turns: 20 },
    'claude-sonnet-4-5-old': { turns: 9 },
  };
  const { total, parts } = modelMix(models);
  assert.equal(total, 100);
  assert.deepEqual(parts.map((p) => [p.name, p.pct]), [['opus', 71], ['sonnet', 29]]);
  assert.equal(modelText(models), 'opus 71% · sonnet 29%');
  assert.equal(modelTextCompact(models), 'opus+sonnet');
  assert.equal(turnCount(models), 100);
  // A session with nothing recorded says so rather than printing "0%".
  assert.equal(modelText({}), '—');
  assert.equal(modelText(null), '—');
  assert.equal(turnCount(undefined), 0);
});

test('sessionTitle prefers the human name, then the AI one, then the first prompt', () => {
  assert.equal(sessionTitle({ customTitle: 'mine', aiTitle: 'ai', firstPrompt: 'p' }), 'mine');
  assert.equal(sessionTitle({ aiTitle: 'ai', firstPrompt: 'p' }), 'ai');
  assert.equal(sessionTitle({ firstPrompt: 'line one\nline two' }), 'line one');
  assert.equal(sessionTitle({ id: '7c02aaaaaaaaaa4e' }), '7c02…4e');
  assert.equal(sessionTitle({}), 'untitled session');
});

test('shortId abbreviates only when there is something to abbreviate', () => {
  assert.equal(shortId('7c02aaaaaaaaaa4e'), '7c02…4e');
  assert.equal(shortId('short'), 'short');
});

test('isFromJob and jobTag read provenance off runs[], and never claim a trigger', () => {
  const s = { runs: [{ runId: 'r1', jobId: 'j1', jobName: 'nightly billing' }] };
  assert.equal(isFromJob(s), true);
  assert.equal(jobTag(s), 'nightly billing');
  // The mockup's tag is "burst · webapp-billing"; runs[] carries no trigger, so
  // only the job name survives.
  assert.ok(!/burst/.test(jobTag(s)));
  assert.equal(isFromJob({ runs: [] }), false);
  assert.equal(jobTag({ runs: [] }), null);
});

test('filterSessions scopes, searches and sorts independently', () => {
  const sessions = [
    { id: 'a', customTitle: 'alpha', lastTs: '2026-08-01T10:00:00Z', sizeBytes: 10, activeMs: 300, runs: [{ jobName: 'nightly' }] },
    { id: 'b', customTitle: 'beta', lastTs: '2026-08-02T10:00:00Z', sizeBytes: 500, activeMs: 100, runs: [] },
    { id: 'c', customTitle: 'gamma', lastTs: '2026-07-30T10:00:00Z', sizeBytes: 900, activeMs: 900, runs: [] },
  ];
  assert.deepEqual(filterSessions(sessions, { scope: 'jobs' }).map((s) => s.id), ['a']);
  assert.deepEqual(filterSessions(sessions, { scope: 'interactive' }).map((s) => s.id), ['b', 'c']);
  assert.deepEqual(filterSessions(sessions, { sort: 'newest' }).map((s) => s.id), ['b', 'a', 'c']);
  assert.deepEqual(filterSessions(sessions, { sort: 'largest' }).map((s) => s.id), ['c', 'b', 'a']);
  assert.deepEqual(filterSessions(sessions, { sort: 'active' }).map((s) => s.id), ['c', 'a', 'b']);
  assert.deepEqual(filterSessions(sessions, { query: 'gam' }).map((s) => s.id), ['c']);
  // The job name is searchable — it is how you find "that nightly run".
  assert.deepEqual(filterSessions(sessions, { query: 'nightly' }).map((s) => s.id), ['a']);
  assert.deepEqual(scopeCounts(sessions), { all: 3, jobs: 1, interactive: 2 });
});

test('pairTurns indexes results by toolUseId in a first pass', () => {
  // A tool_use precedes its result chronologically, so a single forward pass
  // would render the result again later as an unpaired sibling.
  const turns = [
    { role: 'tool_use', tool: 'Bash', toolUseId: 't1' },
    { role: 'tool_result', toolUseId: 't1', text: 'ok' },
    { role: 'tool_result', toolUseId: 'orphan', text: 'nobody called me' },
  ];
  const { resultFor, consumed } = pairTurns(turns);
  assert.equal(resultFor.get('t1').text, 'ok');
  assert.equal(consumed.has(turns[1]), true);
  assert.equal(consumed.has(turns[2]), false, 'an unpaired result must still be rendered');
});

test('toolSummary uses each tool\'s real result fields, and degrades instead of throwing', () => {
  assert.equal(toolSummary('Bash', { command: 'npm test\n--watch' }), 'npm test…');
  assert.equal(toolSummary('Read', { file_path: 'src/a.js' }), 'src/a.js');
  assert.equal(
    toolSummary('Edit', { file_path: 'src/a.js' }, { toolUseResult: { structuredPatch: [{}, {}] } }),
    'src/a.js · 2 hunks',
  );
  assert.equal(
    toolSummary('Grep', { pattern: 'Math.round' }, { toolUseResult: { numFiles: 3, numMatches: 12 } }),
    'Math.round · 3 files, 12 matches',
  );
  assert.equal(toolSummary('TodoWrite', { todos: [1, 2, 3] }), '3 todos');
  // An unknown tool falls through to its first input key rather than nothing.
  assert.equal(toolSummary('FutureTool', { thing: 'x' }), 'thing: "x"');
  // A summariser must never be why a turn fails to render. `null` input is
  // not enough to prove that — asObj() turns it into {} and every summariser
  // then reads undefined fields safely, so the guard stayed unexercised and a
  // mutation removing it went unnoticed. This input actually throws.
  assert.equal(toolSummary('Grep', null, null), '');
  const explodes = { get pattern() { throw new Error('malformed turn'); } };
  assert.equal(toolSummary('Grep', explodes), '', 'a throwing summariser degrades to the bare tool name');
  assert.equal(toolSummary('Bash', { command: 'x'.repeat(200) }).length, 90);
});

test('toolOpensByDefault opens what changed something, and always opens an error', () => {
  assert.equal(toolOpensByDefault('Edit'), true);
  assert.equal(toolOpensByDefault('Write'), true);
  assert.equal(toolOpensByDefault('Bash'), true);
  assert.equal(toolOpensByDefault('Read'), false);
  assert.equal(toolOpensByDefault('Grep'), false);
  // A failure the reader has to go hunting for is what this page exists to
  // prevent, so an errored result opens whatever the tool.
  assert.equal(toolOpensByDefault('Read', { isError: true }), true);
});

test('diffLines classifies by each line\'s own sign, never by position', () => {
  const { header, lines } = diffLines({
    oldStart: 87, oldLines: 9, newStart: 88, newLines: 7,
    lines: ['   const rate = 1;', '-  return Math.round(x);', '+  return roundMoney(x);'],
  });
  assert.equal(header, '@@ -87,9 +88,7 @@');
  assert.deepEqual(lines.map((l) => l.cls), ['ctx', 'del', 'add']);
  assert.deepEqual(diffLines({}).lines, []);
});

test('taskCompleteMarker reads only the FINAL assistant message', () => {
  const finished = [
    { role: 'user', text: 'end with TASK-COMPLETE: wb-142 when done' },
    { role: 'assistant', text: 'Working on it.' },
    { role: 'assistant', text: 'Fixed.\n\nTASK-COMPLETE: wb-142' },
  ];
  assert.deepEqual(taskCompleteMarker(finished), { beadId: 'wb-142' });

  // An agent that QUOTED the instruction mid-run, then stopped without
  // finishing, has not finished — reading any assistant turn would call this
  // done, which is the difference between a closed bead and a handed-back one.
  const quotedButUnfinished = [
    { role: 'assistant', text: 'I will end with TASK-COMPLETE: wb-142 once the tests pass.' },
    { role: 'assistant', text: 'The tests still fail; stopping here.' },
  ];
  assert.equal(taskCompleteMarker(quotedButUnfinished), null);
  assert.equal(taskCompleteMarker([]), null);
});

test('transcriptCounts counts tool calls and how many stay collapsed', () => {
  const turns = [
    { role: 'user', text: 'go' },
    { role: 'assistant', text: 'ok' },
    { role: 'tool_use', tool: 'Read', toolUseId: 't1' },
    { role: 'tool_result', toolUseId: 't1', text: 'contents' },
    { role: 'tool_use', tool: 'Edit', toolUseId: 't2' },
    { role: 'tool_result', toolUseId: 't2', text: 'edited' },
    { role: 'tool_use', tool: 'Grep', toolUseId: 't3' },
    { role: 'tool_result', toolUseId: 't3', isError: true, text: 'boom' },
  ];
  const c = transcriptCounts(turns);
  assert.equal(c.turns, 2);
  assert.equal(c.toolCalls, 3);
  // Read collapses; Edit opens because it changed something; Grep opens
  // because its result errored.
  assert.equal(c.collapsed, 1);
});

test('truncate keeps the cap inclusive of the ellipsis', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('ab', 4), 'ab');
});

// ------------------------------------------------------- source-level gates

const UNSUPPORTED_ON_SESSION_PAGES = [
  { re: /closed by the scheduler/, why: 'nothing persists whether the bead was closed or handed back (dc9)' },
  { re: /bead \$\{[^}]+\} closed/, why: 'same — the marker is observable, the scheduler\'s action is not' },
  { re: /~\/\.claude\/projects/, why: 'the index root is never sent to the browser and CS_SESSIONS_ROOT can move it' },
  { re: /['"`]burst · /, why: 'runs[] carries the job name, not the trigger that fired it' },
  { re: /worktree['"`]/, why: 'gitBranch is recorded; whether it is a worktree branch is not' },
];

test('no C3 page states a session fact the API cannot back', () => {
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const offenders = [];
  for (const f of ['pages/sessions.js', 'pages/session.js', 'pages/sessions-logic.js']) {
    const src = stripComments(readV2(f));
    for (const c of UNSUPPORTED_ON_SESSION_PAGES) {
      if (c.re.test(src)) offenders.push(`${f}: ${c.re} — ${c.why}`);
    }
  }
  assert.deepEqual(offenders, [], `these render claims the API does not support:\n${offenders.join('\n')}`);
});

test('the list card never tries to count tool calls', () => {
  // The distinction that makes the refusal coherent: the transcript page DOES
  // count them, because it already holds the parsed turns. If sessions.js ever
  // imports the counter, it is about to pay one file parse per card.
  const src = readV2('pages/sessions.js');
  assert.ok(!/transcriptCounts/.test(src),
    'sessions.js imports transcriptCounts — the list has no turns to count, and fetching them is one parse per card');
  assert.match(readV2('pages/session.js'), /transcriptCounts/, 'the transcript page should count them');
});

test('transcript text is never routed through innerHTML', () => {
  // Turn text is agent-authored and comes straight off disk. `el()`'s `html`
  // key is an innerHTML write; using it on transcript content would make a
  // transcript containing markup an injection.
  const src = readV2('pages/session.js');
  for (const m of src.matchAll(/html:\s*([A-Za-z_$][\w$]*)/g)) {
    assert.match(m[1], /^SVG_/, `session.js passes html: ${m[1]} — only the literal SVG constants may use innerHTML`);
  }
  assert.ok(!/innerHTML\s*=/.test(src.replace(/tpl\.innerHTML = html\.trim\(\);/, '')),
    'session.js assigns innerHTML outside the SVG template helper');
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
  return dom;
}

function mockFetch(routes) {
  const calls = [];
  global.fetch = async (path, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body ? JSON.parse(opts.body) : null });
    const hit = routes[`${method} ${path}`] ?? routes[path];
    if (!hit) return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'no mock' }) };
    if (typeof hit === 'number') return { ok: false, status: hit, text: async () => JSON.stringify({ error: 'err' }) };
    return { ok: true, status: 200, text: async () => JSON.stringify(typeof hit === 'function' ? hit() : hit) };
  };
  return calls;
}

const SESSION = {
  id: '7c02aaaaaaaaaa4e',
  customTitle: 'Fix rounding on multi-currency credit notes',
  cwd: '/Users/x/webapp-billing',
  gitBranch: 'scheduler/wb--wb-142',
  sizeBytes: 42_000_000,
  spanMs: 891_000,
  activeMs: 782_000,
  prompts: 12,
  models: { 'claude-sonnet-4-5': { turns: 61 } },
  tokIn: 1_900_000,
  tokOut: 31_200,
  lastTs: '2026-08-01T23:27:00',
  firstTs: '2026-08-01T23:12:00',
  runs: [{ runId: 'r1', jobId: 'j1', jobName: 'bead wb-142', status: 'ok' }],
};

const settle = () => new Promise((r) => setTimeout(r, 0));

test('jsdom: the sessions list renders a card per session with its facts', async () => {
  mountDom();
  mockFetch({ '/api/sessions': { sessions: [SESSION], hidden: 3 } });
  const { default: sessions } = await import(`../public/v2/pages/sessions.js?list=${Date.now()}`);
  sessions(new URLSearchParams());
  await settle(); await settle();

  const page = document.querySelector('#v2-page');
  assert.match(page.textContent, /Fix rounding on multi-currency credit notes/);
  assert.match(page.textContent, /14m 51s/);
  assert.match(page.textContent, /1\.9M in · 31\.2k out/);
  assert.match(page.textContent, /sonnet 100%/);
  assert.match(page.querySelector('.pagehead__sub').textContent, /1 started by LaunchBox jobs/);
  assert.match(page.querySelector('.pagehead__sub').textContent, /3 hidden/);
  // The tag names the job, never a trigger.
  assert.equal(page.querySelector('.tag').textContent, 'bead wb-142');
});

test('jsdom: REVIEW #4 — the first Delete click sends nothing and states the consequence', async () => {
  mountDom();
  const calls = mockFetch({ '/api/sessions': { sessions: [SESSION], hidden: 0 } });
  const { default: sessions } = await import(`../public/v2/pages/sessions.js?arm=${Date.now()}`);
  sessions(new URLSearchParams());
  await settle(); await settle();

  calls.length = 0;
  document.querySelector('[data-act=delete]').click();
  await settle();
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE'), [],
    'arming must not send anything — the whole point of arm-then-confirm');
  const page = document.querySelector('#v2-page');
  assert.match(page.textContent, /cannot be resumed afterwards/);
  assert.ok(page.querySelector('[data-act=delete-confirm]'), 'a confirming control appears');
  assert.ok(page.querySelector('[data-act=cancel]'), 'so does a way out');
  // …and the confirming control is the only danger-styled one on the page.
  assert.deepEqual([...page.querySelectorAll('.btn--danger')].map((b) => b.dataset.act), ['delete-confirm']);
});

test('jsdom: Cancel disarms without sending anything; only the second click deletes', async () => {
  mountDom();
  const calls = mockFetch({
    '/api/sessions': { sessions: [SESSION], hidden: 0 },
    [`DELETE /api/sessions/${SESSION.id}`]: { ok: true },
  });
  const { default: sessions } = await import(`../public/v2/pages/sessions.js?confirm=${Date.now()}`);
  sessions(new URLSearchParams());
  await settle(); await settle();

  document.querySelector('[data-act=delete]').click();
  await settle();
  calls.length = 0;
  document.querySelector('[data-act=cancel]').click();
  await settle();
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE'), [], 'cancelling sends nothing');
  assert.ok(!document.querySelector('[data-act=delete-confirm]'), 'and disarms the row');

  document.querySelector('[data-act=delete]').click();
  await settle();
  document.querySelector('[data-act=delete-confirm]').click();
  await settle(); await settle();
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === `/api/sessions/${SESSION.id}`),
    'the second click is the one that deletes');
});

test('jsdom: arming one row disarms any other, so only one destructive control is ever primed', async () => {
  mountDom();
  const second = { ...SESSION, id: 'bbbb2222bbbb2222', customTitle: 'other', runs: [] };
  mockFetch({ '/api/sessions': { sessions: [SESSION, second], hidden: 0 } });
  const { default: sessions } = await import(`../public/v2/pages/sessions.js?one=${Date.now()}`);
  sessions(new URLSearchParams());
  await settle(); await settle();

  document.querySelectorAll('[data-act=delete]')[0].click();
  await settle();
  document.querySelectorAll('[data-act=delete]')[0].click(); // now the OTHER row's arm button
  await settle();
  assert.equal(document.querySelectorAll('[data-act=delete-confirm]').length, 1);
});

test('jsdom: the 501 "no sessions index" state is not reported as a transient failure', async () => {
  mountDom();
  mockFetch({ '/api/sessions': 501 });
  const { default: sessions } = await import(`../public/v2/pages/sessions.js?501=${Date.now()}`);
  sessions(new URLSearchParams());
  await settle(); await settle();

  const page = document.querySelector('#v2-page');
  assert.match(page.textContent, /sessions index is not running/);
  // No "Try again": retrying a daemon started without the index never helps.
  assert.ok(!/Try again/.test(page.textContent));
});

test('jsdom: a first load that fails explains itself and offers a retry', async () => {
  mountDom();
  global.fetch = async () => { throw new TypeError('refused'); };
  const { default: sessions } = await import(`../public/v2/pages/sessions.js?down=${Date.now()}`);
  sessions(new URLSearchParams());
  await settle(); await settle();

  const page = document.querySelector('#v2-page');
  assert.match(page.textContent, /Could not read your sessions/);
  assert.match(page.textContent, /Try again/);
  assert.ok(!/Loading/.test(page.querySelector('.pagehead__sub').textContent));
});

test('jsdom: the empty state does not name a directory the API never reported', async () => {
  mountDom();
  mockFetch({ '/api/sessions': { sessions: [], hidden: 0 } });
  const { default: sessions } = await import(`../public/v2/pages/sessions.js?empty=${Date.now()}`);
  sessions(new URLSearchParams());
  await settle(); await settle();

  const page = document.querySelector('#v2-page');
  assert.match(page.textContent, /No Claude Code sessions on this machine/);
  assert.ok(!/~\/\.claude\/projects/.test(page.textContent),
    'the root is not sent to the browser, so naming it would be a guess');
  assert.match(page.textContent, /CS_SESSIONS_ROOT/, 'but it says what WOULD move it');
});

// ---------------- transcript page ----------------

const TURNS = [
  { role: 'user', text: 'Work on bead wb-142: fix rounding.' },
  { role: 'assistant', text: 'I will look at the rounding first.' },
  { role: 'tool_use', tool: 'Grep', toolUseId: 't1', input: { pattern: 'Math.round' } },
  { role: 'tool_result', toolUseId: 't1', toolUseResult: { numFiles: 3, numMatches: 12 } },
  {
    role: 'tool_use',
    tool: 'Edit',
    toolUseId: 't2',
    input: { file_path: 'src/billing/creditNote.js' },
  },
  {
    role: 'tool_result',
    toolUseId: 't2',
    toolUseResult: {
      structuredPatch: [{
        oldStart: 87, oldLines: 9, newStart: 88, newLines: 7,
        lines: ['   const rate = getRate();', '-  return Math.round(x);', '+  return roundMoney(x);'],
      }],
    },
  },
  { role: 'assistant', text: 'Fixed.\n\nTASK-COMPLETE: wb-142' },
];

const transcriptRoutes = (over = {}) => ({
  [`/api/sessions/${SESSION.id}`]: { session: SESSION },
  [`/api/sessions/${SESSION.id}/conversation`]: { session: SESSION, turns: TURNS },
  '/api/jobs': { jobs: [{ id: 'j1', name: 'bead wb-142', params: { _projectId: 'p1', _beadId: 'wb-142' } }] },
  ...over,
});

test('jsdom: the transcript renders messages, collapses lookups and opens changes', async () => {
  mountDom();
  mockFetch(transcriptRoutes());
  const { default: session } = await import(`../public/v2/pages/session.js?t=${Date.now()}`);
  session(new URLSearchParams(`id=${SESSION.id}`));
  await settle(); await settle(); await settle();

  const page = document.querySelector('#v2-page');
  const blocks = [...page.querySelectorAll('.tooluse')];
  assert.equal(blocks.length, 2);
  const [grep, edit] = blocks;
  assert.match(grep.textContent, /Math\.round · 3 files, 12 matches/);
  assert.equal(grep.getAttribute('aria-expanded'), 'false', 'a lookup stays collapsed');
  assert.equal(edit.getAttribute('aria-expanded'), 'true', 'a change opens');
  // Every collapsed block names WHICH call it is for assistive tech.
  for (const b of blocks) assert.match(b.getAttribute('aria-label'), /^(Grep|Edit) — /);

  // The diff is rendered from the pre-computed hunks, classified per line.
  const diff = page.querySelector('pre.diff');
  assert.ok(diff, 'the structuredPatch renders as a diff');
  assert.equal(diff.querySelectorAll('.add').length, 1);
  assert.equal(diff.querySelectorAll('.del').length, 1);
  assert.match(diff.querySelector('.ctx').textContent, /@@ -87,9 \+88,7 @@/);
});

test('jsdom: a collapsed tool block opens on click and on Enter', async () => {
  mountDom();
  mockFetch(transcriptRoutes());
  const { default: session } = await import(`../public/v2/pages/session.js?toggle=${Date.now()}`);
  session(new URLSearchParams(`id=${SESSION.id}`));
  await settle(); await settle(); await settle();

  const grep = document.querySelector('.tooluse');
  const detail = grep.nextElementSibling;
  assert.equal(detail.hidden, true);
  grep.click();
  assert.equal(detail.hidden, false);
  assert.equal(grep.getAttribute('aria-expanded'), 'true');
  // Keyboard-reachable, because it is a div wearing role=button.
  grep.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(detail.hidden, true);
  assert.equal(grep.getAttribute('tabindex'), '0');
});

test('jsdom: the outcome fact states the marker was seen, never what the scheduler did', async () => {
  mountDom();
  mockFetch(transcriptRoutes());
  const { default: session } = await import(`../public/v2/pages/session.js?marker=${Date.now()}`);
  session(new URLSearchParams(`id=${SESSION.id}`));
  await settle(); await settle(); await settle();

  const page = document.querySelector('#v2-page');
  assert.match(page.textContent, /TASK-COMPLETE/);
  assert.match(page.textContent, /marker for wb-142 in the final message/);
  // The claim the data cannot back.
  assert.ok(!/closed by the scheduler/.test(page.textContent));
  assert.ok(!/bead wb-142 closed/.test(page.textContent));
  // And the footer says what it is.
  assert.match(page.textContent, /snapshot of the file as it was read, not a live tail/);
});

test('jsdom: a transcript whose file cannot be read still shows the indexed summary', async () => {
  mountDom();
  mockFetch(transcriptRoutes({ [`/api/sessions/${SESSION.id}/conversation`]: 404 }));
  const { default: session } = await import(`../public/v2/pages/session.js?noconvo=${Date.now()}`);
  session(new URLSearchParams(`id=${SESSION.id}`));
  await settle(); await settle(); await settle();

  const page = document.querySelector('#v2-page');
  assert.match(page.textContent, /transcript file could not be read/);
  assert.match(page.textContent, /42 MB on disk/, 'the indexed facts are still shown');
  assert.match(page.textContent, /transcript not read/, 'and the tool-call count says it is unknown');
});

test('jsdom: transcript text containing markup renders as characters, not as HTML', async () => {
  mountDom();
  const evil = [{ role: 'assistant', text: '<img src=x onerror=alert(1)> and <b>bold</b>' }];
  mockFetch(transcriptRoutes({
    [`/api/sessions/${SESSION.id}/conversation`]: { session: SESSION, turns: evil },
  }));
  const { default: session } = await import(`../public/v2/pages/session.js?xss=${Date.now()}`);
  session(new URLSearchParams(`id=${SESSION.id}`));
  await settle(); await settle(); await settle();

  const body = document.querySelector('.msg__body');
  assert.equal(body.querySelectorAll('img, b').length, 0, 'agent-authored text must not become elements');
  assert.match(body.textContent, /<img src=x onerror=alert\(1\)>/);
});

test('jsdom: the transcript delete also arms before it sends', async () => {
  mountDom();
  const calls = mockFetch(transcriptRoutes({ [`DELETE /api/sessions/${SESSION.id}`]: { ok: true } }));
  const { default: session } = await import(`../public/v2/pages/session.js?del=${Date.now()}`);
  session(new URLSearchParams(`id=${SESSION.id}`));
  await settle(); await settle(); await settle();

  calls.length = 0;
  document.querySelector('[data-act=delete]').click();
  await settle();
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE'), []);
  assert.match(document.querySelector('#v2-page').textContent, /Nothing has been deleted yet/);

  document.querySelector('[data-act=delete-confirm]').click();
  await settle(); await settle();
  assert.ok(calls.some((c) => c.method === 'DELETE'));
});

test('jsdom: a missing transcript says so instead of rendering an empty shell', async () => {
  mountDom();
  mockFetch({ [`/api/sessions/${SESSION.id}`]: 404 });
  const { default: session } = await import(`../public/v2/pages/session.js?gone=${Date.now()}`);
  session(new URLSearchParams(`id=${SESSION.id}`));
  await settle(); await settle();

  const page = document.querySelector('#v2-page');
  assert.match(page.textContent, /no longer exists/);
  assert.match(page.textContent, /Back to Sessions/);
});
