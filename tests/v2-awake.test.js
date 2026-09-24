// /v2 keep-awake appbar control (claude-scheduler-btv.16).
//
// The owner decided on 2026-09-23 that the keep-awake capability is NOT being
// dropped in the redesign, so /v2 grew the control the existing UI has at
// public/index.html:23-33. These tests pin the three things that can silently
// rot: the label maths (which is the only place "auto is selected" and "auto is
// currently holding" are told apart), the write path (every mode the old menu
// offers must actually reach PUT /api/awake with the right body), and the
// contracts the appbar is already under — data-mutating, a tooltip on a
// non-replaced element, and focus moving to a control that certainly exists.
//
// jsdom rather than source inspection: the defects this is guarding against
// (a menu that never opens, a PUT with no `minutes`, focus stranded on the
// opener) are all invisible to a regex over the file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// chrome.js's mountChrome() arms a real 15s poll interval. Harmless in a tab;
// in `node --test` it keeps the process alive with nothing left to run, which
// is a HANG, not a failure — and a hanging suite reports nothing at all.
const realSetInterval = globalThis.setInterval;
// The most recent interval callback, so a test can fire the appbar poll on
// demand instead of waiting 15s for it.
let lastIntervalFn = null;
globalThis.setInterval = (fn, ms, ...rest) => {
  lastIntervalFn = fn;
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

// `toLocaleTimeString` follows the RUNNER's locale — 12-hour with an AM/PM
// suffix here, 24-hour on a machine set to en-GB. Pinning one of them would
// make this suite fail on the other developer's laptop and prove nothing about
// the product, so the assertion is "a real clock time", not one rendering.
const HHMM_TEXT = (prefix) => new RegExp(`^${prefix} \\d{1,2}:\\d{2}(\\s?[AP]M)?$`, 'i');

/**
 * A fetch stand-in that records writes and answers each endpoint from `state`.
 * Deliberately NOT a blanket `{}` responder: the keep-awake chip reads its
 * label from the served shape, so a responder that returns the same thing for
 * every path would let a chip that reads the wrong endpoint pass.
 */
function mockFetch({ awake = { mode: 'off', until: null, active: false }, awakeStatus = 200 } = {}) {
  const calls = [];
  let current = awake;
  const fn = async (path, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
    if (path.startsWith('/api/awake')) {
      if (awakeStatus !== 200) {
        return { ok: false, status: awakeStatus, text: async () => JSON.stringify({ error: 'awake not available' }) };
      }
      if (method === 'PUT') {
        const { mode, minutes } = JSON.parse(init.body);
        current = {
          mode,
          until: mode === 'timed' ? new Date(Date.UTC(2026, 8, 23, 14, 30)).toISOString() : null,
          active: mode !== 'off',
          minutes,
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(current) };
    }
    if (path.startsWith('/api/runs')) return { ok: true, status: 200, text: async () => JSON.stringify({ runs: [] }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({}) };
  };
  return { fn, calls, served: () => current };
}

let seq = 0;
const loadChrome = () => import(`../public/v2/chrome.js?awake=${++seq}`);

// ------------------------------------------------------------ label maths

test('awakeLabel: the appbar text, and whether the Mac is ACTUALLY held awake', async () => {
  const { awakeLabel } = await loadChrome();
  assert.deepEqual(awakeLabel(null), { text: 'sleep ok', on: false });
  assert.deepEqual(awakeLabel({ mode: 'off', active: false }), { text: 'sleep ok', on: false });
  assert.deepEqual(awakeLabel({ mode: 'on', active: true }), { text: 'awake', on: true });

  // `auto` is the whole reason lib/awake.js returns `active` separately: the
  // mode is selected either way, but it only HOLDS while something is due.
  assert.deepEqual(awakeLabel({ mode: 'auto', active: false }), { text: 'auto', on: false });
  assert.deepEqual(awakeLabel({ mode: 'auto', active: true }), { text: 'auto · awake', on: true });

  const timed = awakeLabel({ mode: 'timed', until: '2026-09-23T14:30:00.000Z', active: true });
  assert.match(timed.text, HHMM_TEXT('awake until'));
  assert.equal(timed.on, true);
  // A timed hold whose deadline the daemon has not reported must not claim one.
  assert.equal(awakeLabel({ mode: 'timed', until: null, active: false }).text, 'awake until ?');
});

test('awakeToast: one confirmation per served mode, never a bare "ok"', async () => {
  const { awakeToast } = await loadChrome();
  assert.match(awakeToast({ mode: 'off' }), /sleep normally/);
  assert.match(awakeToast({ mode: 'auto' }), /while jobs are scheduled/);
  assert.match(awakeToast({ mode: 'on' }), /indefinitely/);
  assert.match(awakeToast({ mode: 'timed', until: '2026-09-23T14:30:00.000Z' }), HHMM_TEXT('Staying awake until'));
});

test('AWAKE_CHOICES is the old menu exactly — seven modes, four timed presets', async () => {
  const { AWAKE_CHOICES, isCurrentChoice } = await loadChrome();
  assert.equal(AWAKE_CHOICES.length, 7);
  assert.deepEqual(AWAKE_CHOICES.filter((c) => c.mode === 'timed').map((c) => c.minutes), [30, 60, 240, 480]);
  // A `timed` choice with no minutes is rejected by lib/awake.js's set() — it
  // would be a button that can only 400.
  for (const c of AWAKE_CHOICES) {
    assert.equal(c.mode === 'timed', c.minutes != null, `${c.label} has the wrong minutes shape`);
  }
  assert.equal(isCurrentChoice({ mode: 'off' }, null), true, 'no served state means off');
  assert.equal(isCurrentChoice({ mode: 'auto' }, { mode: 'off' }), false);
  assert.equal(isCurrentChoice({ mode: 'timed', minutes: 240 }, { mode: 'timed' }), true);
});

// ------------------------------------------------------------- the control

test('the chip renders the served state and opens the mode menu', async () => {
  freshDom();
  const m = mockFetch({ awake: { mode: 'auto', until: null, active: true } });
  globalThis.fetch = m.fn;
  const chrome = await loadChrome();
  chrome.mountChrome();
  await tick(60);

  const chip = document.getElementById('v2-awake');
  assert.ok(chip, 'the appbar must carry a keep-awake control');
  assert.match(chip.textContent, /auto · awake/, 'the label must reflect what the daemon serves, not a local guess');
  assert.ok(m.calls.some((c) => c.method === 'GET' && c.path === '/api/awake'), 'the state must come from GET /api/awake on the appbar poll');

  chip.click();
  const modal = document.querySelector('.modalwrap[data-awake] .modal');
  assert.ok(modal, 'clicking must open the mode menu');
  assert.equal(modal.getAttribute('role'), 'dialog');
  assert.equal(modal.getAttribute('aria-modal'), 'true');
  assert.ok((modal.getAttribute('aria-label') ?? '').length > 2);
  assert.equal(modal.querySelectorAll('button[data-awake-mode]').length, 7);
});

test('every mode the old menu offers reaches PUT /api/awake with the right body', async () => {
  const expected = [
    ['off', undefined],
    ['auto', undefined],
    ['timed', 30], ['timed', 60], ['timed', 240], ['timed', 480],
    ['on', undefined],
  ];
  for (const [mode, minutes] of expected) {
    freshDom();
    const m = mockFetch();
    globalThis.fetch = m.fn;
    const chrome = await loadChrome();
    chrome.mountChrome();
    await tick(60);

    document.getElementById('v2-awake').click();
    const sel = minutes == null
      ? `button[data-awake-mode="${mode}"]:not([data-awake-minutes])`
      : `button[data-awake-mode="${mode}"][data-awake-minutes="${minutes}"]`;
    const btn = document.querySelector(`.modalwrap[data-awake] ${sel}`);
    assert.ok(btn, `no button for ${mode}${minutes ? `/${minutes}` : ''}`);
    btn.click();
    await tick(60);

    const put = m.calls.filter((c) => c.method === 'PUT' && c.path === '/api/awake').at(-1);
    assert.ok(put, `${mode} did not write`);
    assert.equal(put.body.mode, mode);
    assert.equal(put.body.minutes, minutes);
    assert.equal(document.querySelector('.modalwrap[data-awake]'), null, 'a successful write must close the menu');
  }
});

test('the label updates from the RESPONSE, not from what was clicked', async () => {
  // The daemon is the authority: `auto` may or may not actually be holding,
  // and a timed deadline is computed server-side. Echoing the click would
  // paint a label the daemon disagrees with.
  freshDom();
  const m = mockFetch();
  globalThis.fetch = m.fn;
  const chrome = await loadChrome();
  chrome.mountChrome();
  await tick(60);

  document.getElementById('v2-awake').click();
  document.querySelector('.modalwrap[data-awake] button[data-awake-minutes="60"]').click();
  await tick(60);

  assert.match(document.getElementById('v2-awake').textContent, HHMM_TEXT('awake until'));
  // …and the "currently holding" dot appears only because the response said active.
  assert.ok(document.querySelector('#v2-awake .state__dot'), 'an active hold must be visible at a glance');
});

test('the menu closes by Escape, by the backdrop and by its close button, and focus lands inside', async () => {
  freshDom();
  globalThis.fetch = mockFetch().fn;
  const chrome = await loadChrome();
  chrome.mountChrome();
  await tick(60);
  const chip = () => document.getElementById('v2-awake');

  chip().click();
  const closeBtn = document.querySelector('.modalwrap[data-awake] .modal__head .iconbtn');
  assert.ok(closeBtn, 'the menu needs a close control');
  // Focus must move OFF the opener and onto a control that certainly exists —
  // and specifically not onto a live mutating choice, where a stray Enter
  // would change how the machine sleeps.
  assert.equal(document.activeElement, closeBtn);
  assert.ok(!closeBtn.hasAttribute('data-mutating'), 'the focused control must not itself write state');

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.querySelector('.modalwrap[data-awake]'), null, 'Escape must close it');

  chip().click();
  document.querySelector('.modalwrap[data-awake]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.equal(document.querySelector('.modalwrap[data-awake]'), null, 'a backdrop click must close it');

  chip().click();
  document.querySelector('.modalwrap[data-awake] .modal__head .iconbtn').click();
  assert.equal(document.querySelector('.modalwrap[data-awake]'), null, 'the close button must close it');

  // Escape after it is closed must not throw — the listener has to come off.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});

test('a daemon with no keep-awake controller (501) gets no chip at all', async () => {
  // server.js answers 501 when it was built without one. A live control that
  // can only fail is the "dead button that lies" this codebase keeps refusing
  // to ship.
  freshDom();
  globalThis.fetch = mockFetch({ awakeStatus: 501 }).fn;
  const chrome = await loadChrome();
  chrome.mountChrome();
  await tick(80);
  assert.equal(document.getElementById('v2-awake'), null);
});

test('the chip carries its tooltip on a plain <button>, never a replaced element', () => {
  // `::after` — which is what paints a data-tip — does not render on an
  // <input>/<select>. That shipped a tooltip nobody could ever see once
  // already (E2, the enable switch), so it is pinned rather than remembered.
  const src = read('public/v2/chrome.js');
  const block = /function awakeChip\(\) \{[\s\S]*?\n\}/.exec(src)?.[0];
  assert.ok(block, 'awakeChip() could not be located — this test is measuring nothing');
  assert.match(block, /el\('button'/, 'the keep-awake trigger must be a real <button>');
  assert.ok(!/el\('(input|select|textarea)'/.test(block), 'a replaced element cannot render the tooltip it is given');
  assert.match(block, /'data-tip'/);
  assert.match(block, /'data-mutating'/);
  // And no hand-rolled disable: the central sweep owns that (btv.14's lesson).
  assert.ok(!/setDisabledReason/.test(block), 'the chip must not re-implement the sweep it is already covered by');
});

test('keyboard focus on the chip survives the appbar poll — the chip is updated in place, not rebuilt', async () => {
  // btv.17: renderChips() used to do host.innerHTML = '' on every 15s poll.
  // A focusable control inside a container wiped every 15 seconds loses
  // keyboard focus every 15 seconds, and an open tooltip vanishes mid-read.
  // jsdom drops focus on removal the way a browser does (measured), so this
  // is a real assertion, not a DOM-dump one. The label still has to follow
  // the served state across the same poll — "in place" must not mean "stale".
  freshDom();
  const m = mockFetch({ awake: { mode: 'off', until: null, active: false } });
  globalThis.fetch = m.fn;
  const chrome = await loadChrome();
  chrome.mountChrome();
  await tick(60);
  const poll = lastIntervalFn;
  assert.equal(typeof poll, 'function', 'sanity: mountChrome armed the poll');

  const chip = document.getElementById('v2-awake');
  assert.match(chip.textContent, /sleep ok/);
  chip.focus();
  assert.equal(document.activeElement, chip, 'sanity: the chip can take focus');

  // Flip the served state between polls so the in-place update is proven to
  // actually re-render the label and the dot, not just leave the node alone.
  await m.fn('/api/awake', { method: 'PUT', body: JSON.stringify({ mode: 'on' }) });
  await poll(); await tick(20);
  await poll(); await tick(20);

  const after = document.getElementById('v2-awake');
  assert.equal(after, chip, 'two polls later it must be the SAME node');
  assert.equal(document.activeElement, chip, 'focus must survive two poll cycles');
  assert.match(chip.textContent, /^awake$/, 'and the label must follow the served state');
  assert.ok(chip.querySelector('.state__dot'), 'an active hold must show its dot after the in-place update');
  assert.equal(chip.getAttribute('aria-label'), 'Keep Mac awake — awake');
  assert.equal(chip.getAttribute('data-tip'), 'Keep this Mac awake so schedules fire', 'its own tooltip is untouched by the poll');

  // The rest of the appbar still refreshes: the running count is a rebuilt
  // sibling, and the chip keeps its place between it and the pause segs.
  const kids = [...document.getElementById('v2-chips').children].map((c) => c.className.split(' ')[0]);
  assert.deepEqual(kids, ['uchips', 'runchip', 'runchip', 'segs']);
  assert.equal(document.getElementById('v2-chips').children[2], chip);
});
