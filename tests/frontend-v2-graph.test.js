// The #graph route (claude-scheduler-vo4.5 / Task 5 of
// docs/superpowers/plans/2026-09-24-beads-visualizer-phase-a.md).
//
// Two layers, same shape as the other /v2 page suites:
//
//  - source-level gates for the properties that cannot be observed from
//    outside the frame at runtime. The sandbox list is the whole isolation
//    story of Phase A, and an opaque-origin frame is by definition unreadable
//    from a test, so the attribute is pinned where it is written.
//  - jsdom render tests for the frame's src, the stated limitation, and the
//    no-id case (claude-scheduler-7j2: never a blank page).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readV2 = (rel) => readFileSync(join(ROOT, 'public', 'v2', rel), 'utf8');
const src = readV2('pages/graph.js');
// The same file with its comments stripped. Two of the gates below are about
// what the CODE does — this module's header prose names `srcdoc` and
// `Authorization` precisely in order to explain why neither is used, and a
// gate that reads its own explanation as a violation is a gate that punishes
// documenting the decision.
const code = src.replace(/^\s*\/\/.*$/gm, '');

// ---------------------------------------------------------------- source

// The sandbox is the whole isolation story. Granted this page's origin as
// well as script, the frame could read #v2-page and the API session key out of
// localStorage — and could strip its own sandbox attribute. Asserted at the
// source, where it cannot be quietly dropped: from outside, an opaque-origin
// frame is unreadable, so no runtime test can tell the two apart.
test('the frame is sandboxed and never same-origin', () => {
  assert.match(src, /sandbox:\s*'allow-scripts'/);
  assert.ok(!/allow-same-origin/.test(src), 'allow-same-origin would defeat the sandbox');
});

// claude-scheduler-vo4.8. The frame must stay a real URL. `srcdoc` would also
// have solved the auth problem — and would silently throw the response away
// with it. Measured in Chrome: delivered as srcdoc with no in-band policy, an
// off-origin <script> RAN inside the frame and a fetch() from inside it read a
// secret back out; delivered as a URL under the served CSP both were refused.
// A <meta> policy can restore the CSP but cannot express nosniff at all.
test('the frame is a real URL, never srcdoc', () => {
  assert.ok(!/srcdoc/i.test(code), 'srcdoc discards the response headers the CSP and nosniff live in');
});

// The whole point of the ticket: the API session key stays in this document.
test('the API token is never put in a URL', () => {
  assert.ok(!/getToken|cs\.token|Authorization/.test(code),
    'this page reads the token nowhere — api() attaches it as a header');
  assert.match(code, /ticket/, 'the frame is let in by a ticket, not by a key in the URL');
});

test('the page states what Phase A does not do', () => {
  // Per the spec: the missing theme correctness, scheduler overlay and
  // copy-command panel must read as a stated limitation, not as an oversight.
  assert.match(src, /graph-phase-note/);
  assert.match(src, /Phase A/);
});

test('bead text never reaches innerHTML on this page', () => {
  assert.ok(!/innerHTML/.test(src), 'use el()/textContent — bead titles come from other repos');
  assert.ok(!/\bhtml:\s/.test(src), "el()'s `html:` attribute parses markup — not on this page");
});

test('the route is registered and the project page links to it', () => {
  const main = readV2('main.js');
  assert.match(main, /import graph from '\.\/pages\/graph\.js'/);
  assert.match(main, /registerRoute\('graph', graph\)/);
  assert.match(readV2('pages/project.js'), /#graph\?id=\$\{encodeURIComponent\(p\.id\)\}/);
});

// ---------------------------------------------------------------- jsdom

// The token this document holds. Distinctive on purpose: the frame's URL is
// asserted NOT to contain it.
const STORED_TOKEN = 'deadbeefcafef00ddeadbeefcafef00d';
const MINTED_TICKET = 'ticket0123456789';

// api() is the only network this page does, and what it must do is mint a
// ticket. The stub records the call so the test can pin the method and path
// rather than only the effect.
function mountDom({ ticketResponse = { ticket: MINTED_TICKET, ttlMs: 30000 }, status = 200 } = {}) {
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
    calls.push({ path, method: init?.method, auth: init?.headers?.Authorization ?? null });
    // node's Response, not jsdom's — jsdom does not implement one, and a
    // stub that throws would put api() into its 'unreachable' state, which is
    // module-level and would then leak into every later test in this file.
    return new Response(JSON.stringify(ticketResponse), {
      status, headers: { 'Content-Type': 'application/json' },
    });
  };
  return { dom, calls };
}

const load = async (tag) => (await import(`../public/v2/pages/graph.js?case=${tag}${Date.now()}`)).default;

test('jsdom: the frame is let in by a minted ticket, sandboxed with script only', async () => {
  const { calls } = mountDom();
  const graph = await load('frame');
  await graph(new URLSearchParams('id=p1'));

  // The authenticated call that buys the frame its entry.
  assert.deepEqual(calls.map((c) => [c.method, c.path]),
    [['POST', '/api/v2/projects/p1/graph-ticket']]);
  assert.equal(calls[0].auth, `Bearer ${STORED_TOKEN}`, 'the token travels as a header');

  const frame = document.querySelector('#graph-frame');
  assert.ok(frame, 'the iframe must be present for a project that has an id');
  assert.equal(frame.tagName, 'IFRAME');
  const srcAttr = frame.getAttribute('src');
  assert.equal(srcAttr, `/api/v2/projects/p1/graph.html?ticket=${MINTED_TICKET}`);
  // The defect this bead exists for, from the consumer's position: a document
  // navigation sends no header, so the URL has to carry something — and the
  // something must not be the key.
  assert.ok(!srcAttr.includes(STORED_TOKEN), 'the API token must never appear in a URL');
  assert.ok(!frame.hasAttribute('srcdoc'), 'the response headers are the containment');
  // Exactly one token — not a list that happens to contain allow-scripts.
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
});

test('jsdom: a refused ticket says the graph is not there, instead of framing an error page', async () => {
  mountDom({ ticketResponse: { error: 'not found' }, status: 404 });
  const graph = await load('noticket');
  await graph(new URLSearchParams('id=p1'));
  const page = document.querySelector('#v2-page');
  assert.equal(page.querySelector('#graph-frame'), null, 'no ticket means no frame');
  assert.match(page.textContent, /The graph cannot be loaded/);
  assert.match(page.textContent, /no project registered under that id/);
});

test('jsdom: a ticketless 200 is still not a graph', async () => {
  mountDom({ ticketResponse: { ttlMs: 30000 } });
  const graph = await load('empty');
  await graph(new URLSearchParams('id=p1'));
  const page = document.querySelector('#v2-page');
  assert.equal(page.querySelector('#graph-frame'), null);
  assert.match(page.textContent, /The graph cannot be loaded/);
});

test('jsdom: the limitation is on screen, not only in a comment', async () => {
  mountDom();
  const graph = await load('note');
  await graph(new URLSearchParams('id=p1'));

  const note = document.querySelector('#graph-phase-note');
  assert.ok(note, 'the phase note section must render');
  assert.match(note.textContent, /Phase A/);
  assert.match(note.textContent, /theme/i);
  assert.match(note.textContent, /scheduler state|scheduler overlay/i);
  assert.match(note.textContent, /command/i);
});

test('jsdom: a missing id explains itself instead of rendering a blank page (7j2)', async () => {
  mountDom();
  const graph = await load('noid');
  await graph(new URLSearchParams());

  const page = document.querySelector('#v2-page');
  assert.equal(page.querySelector('#graph-frame'), null, 'no id means no frame to point anywhere');
  assert.match(page.textContent, /No project id in the link/);
  assert.match(page.textContent, /Back to Projects/);
});

// The route walk's stranded_page check measures #v2-page's own text, and an
// iframe's document is not part of it. A page whose entire content is a frame
// therefore reads as stranded — the chrome has to carry real prose of its own.
test('jsdom: the page’s own chrome carries more than 60 characters of text', async () => {
  mountDom();
  const graph = await load('text');
  await graph(new URLSearchParams('id=p1'));
  const page = document.querySelector('#v2-page');
  assert.ok(page.textContent.trim().length > 60, `only ${page.textContent.trim().length} chars of page text`);
});

test('jsdom: a project id is encoded into the frame src, never concatenated raw', async () => {
  mountDom();
  const graph = await load('enc');
  await graph(new URLSearchParams([['id', 'a b"&<../x']]));
  const frame = document.querySelector('#graph-frame');
  assert.equal(frame.getAttribute('src'),
    `/api/v2/projects/a%20b%22%26%3C..%2Fx/graph.html?ticket=${MINTED_TICKET}`);
});
