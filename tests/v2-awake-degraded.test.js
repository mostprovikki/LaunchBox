// /v2 keep-awake control — the failure paths (claude-scheduler-btv.16).
//
// Split out of tests/v2-awake.test.js on purpose, not for tidiness: public/v2's
// modules hold process-wide state (api.js's auth-state listener set, ui.js's
// toast host), and every cache-busted import in one file ADDS to it. Two of
// these assertions were measuring a previous test's document before the split.
// `node --test` gives each FILE its own process, which is the only clean
// isolation available here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const t = realSetInterval(fn, ms, ...rest);
  t?.unref?.();
  return t;
};

function freshDom(url = 'http://127.0.0.1:43410/v2') {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<header class="appbar"><nav id="v2-nav"></nav><div id="v2-chips"></div></header>'
    + '<div id="v2-banner" hidden></div><main><div id="v2-page"></div></main>'
    + '</body></html>', { url, pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.history = dom.window.history;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  return dom;
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
const loadChrome = () => import(`../public/v2/chrome.js?awake=${++seq}`);

test('a failed write leaves the menu OPEN, so the choice is still there to retry', async () => {
  freshDom();
  globalThis.fetch = async (path, init = {}) => {
    if (path.startsWith('/api/awake') && (init.method ?? 'GET') === 'PUT') {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: 'minutes must be 1-10080' }) };
    }
    if (path.startsWith('/api/runs')) return { ok: true, status: 200, text: async () => JSON.stringify({ runs: [] }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ mode: 'off', until: null, active: false }) };
  };
  const chrome = await loadChrome();
  chrome.mountChrome();
  await tick(60);

  document.getElementById('v2-awake').click();
  document.querySelector('.modalwrap[data-awake] button[data-awake-mode="on"]').click();
  await tick(60);

  assert.ok(document.querySelector('.modalwrap[data-awake]'), 'a rejected write must not discard the menu');
  assert.match(document.getElementById('v2-toasts')?.textContent ?? '', /minutes must be/, 'and it must say what went wrong');
});

test('the chip is swept by main.js\'s CENTRAL degraded sweep, with no per-control logic of its own', async () => {
  // btv.14's lesson: adding `data-mutating` is the WHOLE job (README.md).
  // This imports the real main.js so that removing the attribute — or the
  // central sweep — is what makes it fail.
  freshDom();
  let mode = 'ok';
  globalThis.fetch = async (path) => {
    if (mode === 'reject') throw new Error('simulated daemon-unreachable');
    if (path.startsWith('/api/runs')) return { ok: true, status: 200, text: async () => JSON.stringify({ runs: [] }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ mode: 'off', until: null, active: false }) };
  };
  await import('../public/v2/main.js');
  await tick(120);

  // Re-queried every time, never held as a reference: an auth-state change
  // makes chrome.js re-render the appbar, so the chip that ends up on screen is
  // a BRAND NEW node the whole-body sweep never saw. Holding the old node would
  // test a detached element and quietly pass while the visible chip stayed live
  // — which is the very defect btv.14's MutationObserver exists to close.
  const chip = () => document.getElementById('v2-awake');
  assert.ok(chip(), 'sanity: the chip is on the appbar');
  assert.ok(chip().hasAttribute('data-mutating'), 'the chip writes state — it must be in the sweep');
  assert.equal(chip().disabled, false, 'sanity: it starts live');

  const api = await import('../public/v2/api.js');
  mode = 'reject';
  await api.api('GET', '/api/probe').catch(() => {});
  await tick(40);
  assert.equal(chip().disabled, true, 'with the daemon unreachable the chip must go dead');
  assert.match(chip().getAttribute('data-tip'), /Unavailable/, 'a dead control that explains itself beats a live one that lies');

  mode = 'ok';
  await api.api('GET', '/api/probe').catch(() => {});
  await tick(40);
  assert.equal(chip().disabled, false, 'and it must come back — a stuck sweep is its own defect');
  assert.match(chip().getAttribute('data-tip'), /Keep this Mac awake/, 're-enabling must restore the chip\'s own tooltip');
});
