// A2 (claude-scheduler-btv.4): conventions + runtime contract for public/v2/.
//
// Mirrors tests/frontend-conventions.test.js's source-level checks (extended
// honestly to walk public/v2/ recursively — that file still only walks
// public/ non-recursively, unchanged) plus jsdom runtime tests for the three
// mechanisms wave-2 pages are told to rely on: the a11y icon-button
// contract, the disable-with-reason contract, and the hash router's
// token-vs-route handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, relative } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V2 = join(ROOT, 'public', 'v2');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const jsFiles = () => walk(V2).filter((p) => p.endsWith('.js')).map((p) => relative(V2, p));
const read = (rel) => readFileSync(join(V2, rel), 'utf8');

test('no /v2 module calls fetch() directly except api.js', () => {
  const offenders = [];
  for (const f of jsFiles()) {
    if (f === 'api.js') continue;
    const src = read(f);
    for (const m of src.matchAll(/\bfetch\s*\(/g)) {
      offenders.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(offenders, [], 'use api() from public/v2/api.js — a raw fetch skips the token, the degraded-state banner and the approval codes');
});

test('no /v2 module uses EventSource', () => {
  for (const f of jsFiles()) {
    assert.ok(!/\bnew\s+EventSource\b/.test(read(f)), `${f} uses EventSource — see public/util.js's comment on why the log drawer is a snapshot instead`);
  }
});

test('a /v2 module that references /api/ imports api.js rather than reimplementing it', () => {
  for (const f of jsFiles()) {
    if (f === 'api.js') continue;
    const src = read(f);
    if (!/['"`]\/api\//.test(src)) continue;
    assert.match(src, /from\s+['"](\.\.?\/)*api\.js['"]/, `${f} references /api/ but does not import api.js`);
  }
});

test('api.js recognises token_invalid, unreachable, and every approval_* code lib/approval.js declares', () => {
  const api = read('api.js');
  assert.match(api, /token_invalid/, "api.js must recognise 'token_invalid'");
  assert.match(api, /unreachable/, "api.js must recognise 'unreachable' — the transport-failure code");

  const approval = readFileSync(join(ROOT, 'lib', 'approval.js'), 'utf8');
  const declared = [...new Set([...approval.matchAll(/'(approval_[a-z_]+)'/g)].map((m) => m[1]))].sort();
  assert.ok(declared.length >= 4, `expected the real approval code list, got ${declared.join(', ')}`);
  for (const code of declared) {
    assert.match(api, new RegExp(`${code}\\s*:`), `public/v2/api.js has no copy for ${code}`);
  }
});

test('no /v2 module imports from public/*.js (ownership rule — /v2 owns its own modules)', () => {
  for (const f of jsFiles()) {
    const src = read(f);
    const fileDir = dirname(join(V2, f));
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const spec = m[1];
      const resolved = join(fileDir, spec);
      const rel = relative(V2, resolved);
      assert.ok(!rel.startsWith('..'),
        `${f} imports "${spec}" -> resolves outside public/v2/ (${rel}) — /v2 must not import public/*.js (see README.md's ownership rule)`);
    }
  }
});

test('the three v2 asset copies are byte-identical to redesign/assets (do not edit)', () => {
  for (const name of ['system.css', 'launchbox.css', 'theme.js']) {
    const a = readFileSync(join(V2, 'assets', name));
    const b = readFileSync(join(ROOT, 'redesign', 'assets', name));
    assert.ok(a.equals(b), `public/v2/assets/${name} has drifted from redesign/assets/${name} — it must stay a byte-identical copy of the audited spec`);
  }
});

// ---------------- runtime (jsdom) ----------------

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
  return dom;
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('iconBtn() throws without a label, and wires aria-label + data-tip when given one (REVIEW #5)', async () => {
  freshDom();
  const { iconBtn } = await import('../public/v2/ui.js?t=' + Date.now());
  assert.throws(() => iconBtn({ svgHtml: '<svg></svg>' }), /aria-label is required/,
    'a missing label must throw at build time, not ship an unlabeled iconbtn');
  const btn = iconBtn({ label: 'Open log', svgHtml: '<svg></svg>' });
  assert.equal(btn.getAttribute('aria-label'), 'Open log');
  assert.equal(btn.getAttribute('data-tip'), 'Open log', 'tip defaults to label');
  assert.ok(btn.classList.contains('iconbtn'));
});

test('setDisabledReason() disables with a reason tooltip, then restores the original tooltip on re-enable (REVIEW #2)', async () => {
  const dom = freshDom();
  const { setDisabledReason } = await import('../public/v2/ui.js?t=' + Date.now());
  const btn = dom.window.document.createElement('button');
  btn.setAttribute('data-tip', 'Open log');

  setDisabledReason(btn, 'Unavailable — daemon unreachable');
  assert.equal(btn.disabled, true);
  assert.equal(btn.getAttribute('data-tip'), 'Unavailable — daemon unreachable');

  setDisabledReason(btn, null);
  assert.equal(btn.disabled, false);
  assert.equal(btn.getAttribute('data-tip'), 'Open log', 're-enabling must restore the control\'s own tooltip, not just clear it');
});

test('setDisabledReason() on a control with no prior tooltip clears data-tip on re-enable, rather than leaving the reason behind', async () => {
  const dom = freshDom();
  const { setDisabledReason } = await import('../public/v2/ui.js?t=' + Date.now() + '_b');
  const btn = dom.window.document.createElement('button');
  setDisabledReason(btn, 'Unavailable — daemon unreachable');
  setDisabledReason(btn, null);
  assert.equal(btn.disabled, false);
  assert.equal(btn.hasAttribute('data-tip'), false, 'a control with no tooltip before disabling must have none after re-enabling — the reason must not linger');
});

test('disableMutatingControls() sweeps every [data-mutating] element under a root, and only those', async () => {
  const dom = freshDom();
  const { disableMutatingControls } = await import('../public/v2/ui.js?t=' + Date.now() + '_c');
  const root = dom.window.document.createElement('div');
  root.innerHTML = '<button data-mutating>New job</button><button>Not mutating</button>';
  disableMutatingControls(root, 'Unavailable — daemon unreachable');
  assert.equal(root.querySelector('[data-mutating]').disabled, true);
  assert.equal(root.querySelectorAll('button')[1].disabled, false, 'a control without data-mutating must be left alone');
});

test('router: an unrecognised fragment falls back to the default route (public/app.js prior art, preserved)', async () => {
  freshDom('http://127.0.0.1:43410/v2#something-nobody-registered');
  const { registerRoute, parseHash, DEFAULT_ROUTE } = await import('../public/v2/router.js?t=' + Date.now());
  registerRoute('overview', () => {});
  const { route } = parseHash('#something-nobody-registered');
  assert.equal(route, DEFAULT_ROUTE, 'an unregistered fragment must fall back, not resolve to nothing');
});

test('router: query params in the fragment are parsed and handed to the route handler (cross-link support)', async () => {
  freshDom('http://127.0.0.1:43410/v2');
  const mod = await import('../public/v2/router.js?t=' + Date.now() + '_q');
  let seen = null;
  mod.registerRoute('runs', (params) => { seen = params; });
  const { route, params } = mod.parseHash('#runs?job=abc123&status=failed');
  assert.equal(route, 'runs');
  assert.equal(params.get('job'), 'abc123');
  assert.equal(params.get('status'), 'failed');
});

test('router: a #token=<hex> fragment is captured into localStorage and stripped, never resolved as a route', async () => {
  const dom = freshDom('http://127.0.0.1:43410/v2');
  dom.window.location.hash = '#token=' + 'a'.repeat(64);
  const mod = await import('../public/v2/router.js?t=' + Date.now() + '_tok');
  let rendered = null;
  mod.registerRoute('overview', () => { rendered = 'overview'; });
  mod.registerRoute('token', () => { rendered = 'WRONG — token must never be a route'; });
  await mod.startRouter();
  assert.equal(localStorage.getItem('cs.token'), 'a'.repeat(64), 'the token must be captured into localStorage under cs.token');
  assert.equal(dom.window.location.hash, '', 'the token fragment must be stripped from the address bar');
  assert.equal(rendered, 'overview', 'a bare token fragment must fall back to the default route, never a route literally named "token"');
});

test('router: a token fragment riding alongside a route hash preserves the route (bd note, point 2)', async () => {
  const dom = freshDom('http://127.0.0.1:43410/v2');
  dom.window.location.hash = '#jobs&token=' + 'b'.repeat(64);
  const mod = await import('../public/v2/router.js?t=' + Date.now() + '_tok2');
  let rendered = null;
  mod.registerRoute('jobs', () => { rendered = 'jobs'; });
  mod.registerRoute('overview', () => { rendered = 'overview (wrong — route was dropped)'; });
  await mod.startRouter();
  assert.equal(localStorage.getItem('cs.token'), 'b'.repeat(64));
  assert.equal(dom.window.location.hash, '#jobs', 'the route must survive stripping — only the token segment is removed');
  assert.equal(rendered, 'jobs');
});

// ---------------- round-2 coordinator review: the central sweep + single reason definition ----------------
// Both tests below import the REAL public/v2/main.js (not a copy of its
// wiring) precisely so that removing main.js's actual subscription lines is
// what makes them fail — a test that re-implements the wiring itself would
// pass regardless of what main.js does, which is exactly the "decorative
// test" trap.

// chrome.js's mountChrome() (imported transitively via main.js) arms a real
// 15s setInterval for its poll loop — harmless in a browser tab, but it keeps
// the test-runner process alive with nothing left to test, hanging `node
// --test` indefinitely. .unref() tells Node not to count it as a reason to
// stay alive; the interval itself is untouched (and irrelevant here, since
// these tests drive state through api.js directly rather than waiting 15s).
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const t = realSetInterval(fn, ms, ...rest);
  t?.unref?.();
  return t;
};

function mockFetch(getMode) {
  return async () => {
    const mode = getMode();
    if (mode === 'reject') throw new Error('simulated daemon-unreachable');
    if (mode === '401') {
      return { ok: false, status: 401, text: async () => JSON.stringify({ error: 'nope', code: 'token_invalid' }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({}) };
  };
}

test('central sweep (main.js): a data-mutating control anywhere on the page is disabled under unreachable AND token_invalid, and re-enabled when healthy', async () => {
  freshDom();
  let mode = 'ok';
  globalThis.fetch = mockFetch(() => mode);

  const main = await import('../public/v2/main.js?t=' + Date.now() + '_sweepA');
  await tick(80); // let the initial (healthy) poll settle without tripping anything

  const probe = document.createElement('button');
  probe.setAttribute('data-mutating', 'true');
  probe.setAttribute('data-tip', 'Create a new job');
  document.getElementById('v2-page').appendChild(probe);
  assert.equal(probe.disabled, false, 'sanity: probe starts enabled');

  const api = await import('../public/v2/api.js');

  mode = 'reject';
  await api.api('GET', '/api/probe').catch(() => {});
  assert.equal(probe.disabled, true, 'daemon-unreachable must disable a data-mutating control OUTSIDE the appbar, via main.js\'s central sweep');
  assert.equal(probe.getAttribute('data-tip'), 'Unavailable — daemon unreachable');

  mode = '401';
  await api.api('GET', '/api/probe').catch(() => {});
  assert.equal(probe.disabled, true, 'token_invalid must also disable it');
  assert.equal(probe.getAttribute('data-tip'), 'Unavailable — session token rejected; reopen with claude-scheduler open');

  mode = 'ok';
  await api.api('GET', '/api/probe').catch(() => {});
  assert.equal(probe.disabled, false, 'a healthy round-trip must re-enable it');
  assert.equal(probe.getAttribute('data-tip'), 'Create a new job', 're-enabling must restore the control\'s OWN tooltip, not leave the reason behind');
  void main;
});

test('central sweep (main.js): a route rendered WHILE already degraded comes up disabled from the start (onRender, not just onAuthState)', async () => {
  freshDom();
  let mode = 'ok';
  globalThis.fetch = mockFetch(() => mode);

  await import('../public/v2/main.js?t=' + Date.now() + '_sweepB');
  await tick(80);

  const router = await import('../public/v2/router.js');
  const api = await import('../public/v2/api.js');

  // A wave-2 page registering its own route, exactly as README.md instructs —
  // its handler renders a mutating control with no sweep call of its own.
  router.registerRoute('probe-route', () => {
    const btn = document.createElement('button');
    btn.id = 'probe-route-btn';
    btn.setAttribute('data-mutating', 'true');
    document.getElementById('v2-page').appendChild(btn);
  });

  // Go degraded BEFORE this route ever renders.
  mode = 'reject';
  await api.api('GET', '/api/probe').catch(() => {});

  // Navigate to it. router.js's singleton `window.addEventListener('hashchange', …)`
  // was bound the first time it loaded, against THAT test's `window` — a fresh
  // freshDom() in a later test swaps in a new `window`/`location`, so relying on
  // the event here would silently listen on a stale object. Calling
  // startRouter() directly re-resolves the (now-fresh) `location.hash` exactly
  // the way a hashchange would, without depending on jsdom event/window identity.
  location.hash = '#probe-route';
  await router.startRouter();
  await tick(40);

  const btn = document.getElementById('probe-route-btn');
  assert.ok(btn, 'the route must have rendered its control');
  assert.equal(btn.disabled, true,
    'a control rendered while ALREADY degraded must come up disabled — an onAuthState-only sweep (no onRender) would miss this, since no NEW transition happens on a plain route render');
});

test('the two disable-reason strings have exactly one definition (api.js degradedReason) — chrome.js imports it rather than retyping it', () => {
  const chrome = read('chrome.js');
  assert.doesNotMatch(chrome, /function\s+degradedReason\s*\(/,
    'chrome.js must not define its own copy of the reason strings — that is the exact "two pages word the same failure differently" bug this fix closes');
  assert.match(chrome, /degradedReason/, 'chrome.js must reference the shared degradedReason');
  assert.match(chrome, /from\s+['"]\.\/api\.js['"]/, 'chrome.js must import from api.js');
  const apiSrc = read('api.js');
  assert.match(apiSrc, /export function degradedReason/, 'api.js must be the one place degradedReason is defined');
});
