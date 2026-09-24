// tests/frontend-v2-review.test.js — the #review page (the review queue).
//
// Same two layers as tests/frontend-v2-graph.test.js: source gates for the
// things that cannot be observed from a render, and jsdom renders for what the
// reader actually sees.
//
// The load-bearing render property is the DISABLED Merge button. A branch whose
// evidence note does not say "gates passed", or whose tip is Task 6's
// `wip(...)` snapshot, is work nobody has reviewed — offering a one-click
// fast-forward for it is the whole failure mode this page exists to prevent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readV2 = (rel) => readFileSync(join(ROOT, 'public', 'v2', rel), 'utf8');
const src = readV2('pages/review.js');

// ---------------------------------------------------------------- source

test('bead text never reaches innerHTML on this page', () => {
  // Branch names, bead titles and evidence notes all come out of other
  // people's repositories.
  assert.ok(!/innerHTML/.test(src), 'use el()/textContent');
  assert.ok(!/\bhtml:\s/.test(src), "el()'s `html:` attribute parses markup — not on this page");
});

test('the route is registered and the project page links to it', () => {
  const main = readV2('main.js');
  assert.match(main, /import review from '\.\/pages\/review\.js'/);
  assert.match(main, /registerRoute\('review', review\)/);
  assert.match(readV2('pages/project.js'), /#review\?id=\$\{encodeURIComponent\(p\.id\)\}/);
});

// ----------------------------------------------------------------- jsdom

const STORED_TOKEN = 'deadbeefcafef00ddeadbeefcafef00d';

const PASSED = {
  branch: 'scheduler/repo--sp-1', beadId: 'sp-1', title: 'Teach the runner to snapshot',
  ahead: 3, behind: 0, shortstat: '4 files changed, 120 insertions(+)', tipSha: 'abc1234',
  tipSubject: 'feat: snapshot before reap (sp-1)', snapshotTip: false,
  note: { first: 'run: gates passed — branch scheduler/repo--sp-1', gates: 'passed' },
};
const SNAPSHOT = {
  branch: 'scheduler/repo--sp-2', beadId: 'sp-2', title: 'Rewrite the admission rule',
  ahead: 1, behind: 0, shortstat: '1 file changed, 9 insertions(+)', tipSha: 'def5678',
  tipSubject: 'wip(sp-2): uncommitted work at run end', snapshotTip: true,
  note: { first: 'run: gates failed — branch scheduler/repo--sp-2', gates: 'failed' },
};

// jsdom + a fetch stub that records what the page asked for and answers with
// node's Response (jsdom implements none, and a throwing stub would put api()
// into its module-level 'unreachable' state and leak into later tests).
function mountDom({ rows = [PASSED, SNAPSHOT], status = 200, answers = null } = {}) {
  const dom = new JSDOM('<!doctype html><body><main><div id="v2-page"></div></main></body>', { url: 'http://localhost/v2/' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.localStorage = dom.window.localStorage;
  global.location = dom.window.location;
  global.history = dom.window.history;
  global.localStorage.setItem('cs.token', STORED_TOKEN);
  const calls = [];
  global.fetch = async (path, init) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
    const scripted = answers?.(calls.length, path, init);
    if (scripted) return new Response(JSON.stringify(scripted.body), {
      status: scripted.status ?? 200, headers: { 'Content-Type': 'application/json' },
    });
    return new Response(JSON.stringify({ branches: rows }), {
      status, headers: { 'Content-Type': 'application/json' },
    });
  };
  return { dom, calls };
}

const load = async (tag) => (await import(`../public/v2/pages/review.js?case=${tag}${Date.now()}`)).default;
const rowFor = (branch) => document.querySelector(`.reviewrow[data-branch="${branch}"]`);
const mergeBtn = (branch) => [...rowFor(branch).querySelectorAll('button')].find((b) => /Merge/.test(b.textContent));

test('jsdom: #review lists branches, flags snapshot tips and refuses to offer an unreviewed merge', async () => {
  const { calls } = mountDom();
  const review = await load('list');
  await review(new URLSearchParams('id=p1'));

  assert.deepEqual(calls.map((c) => [c.method, c.path]), [['GET', '/api/v2/projects/p1/branches']]);
  assert.equal(document.querySelectorAll('.reviewrow').length, 2);

  // The row that passed its gates: mergeable, and swept by the degraded-state
  // sweep like every other control that writes.
  const good = mergeBtn('scheduler/repo--sp-1');
  assert.equal(good.disabled, false);
  assert.ok(good.hasAttribute('data-mutating'), 'a live merge must go dead when the daemon does');
  assert.match(rowFor('scheduler/repo--sp-1').textContent, /Teach the runner to snapshot/);
  assert.match(rowFor('scheduler/repo--sp-1').textContent, /run: gates passed/);

  // The snapshot row: leftovers nobody reviewed.
  const snap = rowFor('scheduler/repo--sp-2');
  assert.match(snap.textContent, /unreviewed leftovers/);
  const bad = mergeBtn('scheduler/repo--sp-2');
  assert.equal(bad.disabled, true, 'an unreviewed snapshot must not be one click from main');
  assert.match(bad.getAttribute('data-tip'), /snapshot|gates/i, 'and it says why it is disabled');
});

test('jsdom: a failed-gates branch with a real commit tip is still not mergeable', async () => {
  mountDom({ rows: [{ ...SNAPSHOT, snapshotTip: false, tipSubject: 'feat: half of it' }] });
  const review = await load('failed');
  await review(new URLSearchParams('id=p1'));
  const btn = mergeBtn('scheduler/repo--sp-2');
  assert.equal(btn.disabled, true);
  assert.match(btn.getAttribute('data-tip'), /failed/i);
});

test('jsdom: a branch behind main is not offered as a fast-forward', async () => {
  mountDom({ rows: [{ ...PASSED, behind: 2 }] });
  const review = await load('behind');
  await review(new URLSearchParams('id=p1'));
  const btn = mergeBtn('scheduler/repo--sp-1');
  assert.equal(btn.disabled, true);
  assert.match(btn.getAttribute('data-tip'), /behind|fast-forward/i);
});

// The sweep in main.js re-enables every `data-mutating` control on each render
// once the daemon is healthy (setDisabledReason(elm, null) sets disabled=false).
// A permanently-disabled Merge marked data-mutating would therefore be handed
// back to the reader a few milliseconds after this page disabled it — the exact
// "README promised it, one instance of it was tested" trap. Driven from the
// consumer's position: run the real sweep and look again.
test('jsdom: the healthy-state sweep does not resurrect a merge the page disabled', async () => {
  mountDom();
  const review = await load('sweep');
  await review(new URLSearchParams('id=p1'));
  const { disableMutatingControls } = await import('../public/v2/ui.js');

  disableMutatingControls(document.body, null); // what main.js does on every render
  assert.equal(mergeBtn('scheduler/repo--sp-2').disabled, true, 'still refused after the sweep');
  assert.equal(mergeBtn('scheduler/repo--sp-1').disabled, false, 'and the mergeable one is still live');

  disableMutatingControls(document.body, 'the daemon is unreachable');
  assert.equal(mergeBtn('scheduler/repo--sp-1').disabled, true, 'a degraded daemon takes the live one away');
});

// Placed before the two tests that toast on SUCCESS on purpose: ui.js caches its
// toast host in a module-level variable, and the module is shared across every
// jsdom document this file builds — so whichever test toasts first owns the
// host, and a later document cannot see it. Order is the cheapest fix; the
// alternative is a reset hook in shipped code that only tests would use.
test('jsdom: a refused merge says so and leaves the row alone', async () => {
  mountDom({
    answers: (n) => (n === 2
      ? { status: 409, body: { error: 'the primary checkout has uncommitted changes', code: 'dirty' } }
      : null),
  });
  const review = await load('refused');
  await review(new URLSearchParams('id=p1'));
  mergeBtn('scheduler/repo--sp-1').click();
  await new Promise((r) => setTimeout(r, 10));

  assert.match(document.body.textContent, /uncommitted changes/, 'the refusal is shown, not swallowed');
  assert.ok(rowFor('scheduler/repo--sp-1'), 'the row is still there');
});

test('jsdom: Merge posts to the branch without its prefix, and reloads the queue', async () => {
  const { calls } = mountDom({
    answers: (n) => (n === 2 ? { body: { ok: true, sha: 'abc1234' } } : null),
  });
  const review = await load('merge');
  await review(new URLSearchParams('id=p1'));
  mergeBtn('scheduler/repo--sp-1').click();
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(calls.map((c) => [c.method, c.path]), [
    ['GET', '/api/v2/projects/p1/branches'],
    ['POST', '/api/v2/projects/p1/branches/repo--sp-1/merge'],
    ['GET', '/api/v2/projects/p1/branches'],
  ], 'the prefix is the server’s to add — the page never sends scheduler/');
});

test('jsdom: Discard sends force and names the branch without its prefix', async () => {
  const { calls } = mountDom({ answers: (n) => (n === 2 ? { body: { ok: true } } : null) });
  const review = await load('discard');
  await review(new URLSearchParams('id=p1'));
  const btn = [...rowFor('scheduler/repo--sp-2').querySelectorAll('button')].find((b) => /Discard/.test(b.textContent));
  btn.click();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(calls[1].method, 'DELETE');
  assert.equal(calls[1].path, '/api/v2/projects/p1/branches/repo--sp-2');
  assert.deepEqual(calls[1].body, { force: true });
});

test('jsdom: an empty queue says so, rather than rendering nothing', async () => {
  mountDom({ rows: [] });
  const review = await load('empty');
  await review(new URLSearchParams('id=p1'));
  const page = document.querySelector('#v2-page');
  assert.equal(page.querySelectorAll('.reviewrow').length, 0);
  assert.match(page.textContent, /Nothing waiting/);
  // The route walk's stranded_page rule measures #v2-page's own text.
  assert.ok(page.textContent.trim().length > 60, `only ${page.textContent.trim().length} chars`);
});

test('jsdom: #review with no id renders the stated empty state, not a blank page', async () => {
  const { calls } = mountDom();
  const review = await load('noid');
  await review(new URLSearchParams());
  const page = document.querySelector('#v2-page');
  assert.match(page.textContent, /Pick a project/);
  assert.equal(calls.length, 0, 'with no id there is nothing to ask the daemon for');
  assert.ok(page.textContent.trim().length > 60);
});

test('jsdom: a failed listing explains itself instead of showing an empty queue', async () => {
  mountDom({ status: 502, rows: [] });
  const review = await load('err');
  await review(new URLSearchParams('id=p1'));
  const page = document.querySelector('#v2-page');
  assert.doesNotMatch(page.textContent, /Nothing waiting/, '"could not read" must never read as "nothing to do"');
  assert.match(page.textContent, /Could not list branches/);
});

test('jsdom: a project id is encoded into every path, never concatenated raw', async () => {
  const { calls } = mountDom({ rows: [] });
  const review = await load('enc');
  await review(new URLSearchParams([['id', 'a b/c']]));
  assert.equal(calls[0].path, '/api/v2/projects/a%20b%2Fc/branches');
});
