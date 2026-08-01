// Settings tab (claude-scheduler-btv.7 / B3). Two layers, same split as
// tests/frontend-v2-jobs.test.js:
//  - pure logic (public/v2/pages/settings-logic.js) — unit conversion,
//    dirty-field counting, the type-to-arm phrase check.
//  - jsdom tests for public/v2/pages/settings.js against a mocked fetch,
//    covering the danger-zone type-to-arm gate and its interaction with the
//    central degraded-state sweep (the exact bug class jobs.js's runBtn
//    comment calls out: a business-reason disable must not be wiped out by
//    a healthy sweep re-enabling anything with `data-mutating`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  msToSec, secToMs, armPhraseMatches, countDirty, parseExtField, USAGE_SHOW_OPTIONS,
} from '../public/v2/pages/settings-logic.js';

// ---------------- pure logic ----------------

test('msToSec/secToMs: round-trip, softGraceMs is the one field stored in ms but shown in seconds', () => {
  assert.equal(msToSec(90000), 90);
  assert.equal(secToMs(90), 90000);
  assert.equal(secToMs(msToSec(600000)), 600000);
  assert.equal(msToSec(null), null);
});

test('USAGE_SHOW_OPTIONS: covers exactly lib/usage.js\'s three machine keys with the mockup\'s own words', () => {
  const values = USAGE_SHOW_OPTIONS.map((o) => o.value);
  assert.deepEqual(values, ['banner', 'compact', 'off']);
  assert.equal(USAGE_SHOW_OPTIONS.find((o) => o.value === 'banner').label, 'Meters + chips');
});

test('armPhraseMatches: exact match after trimming, but NOT case-insensitive', () => {
  assert.equal(armPhraseMatches('cleanup', 'cleanup'), true);
  assert.equal(armPhraseMatches('  cleanup  ', 'cleanup'), true);
  assert.equal(armPhraseMatches('Cleanup', 'cleanup'), false);
  assert.equal(armPhraseMatches('cleanupx', 'cleanup'), false);
  assert.equal(armPhraseMatches('', 'cleanup'), false);
  assert.equal(armPhraseMatches(undefined, 'cleanup'), false);
});

test('countDirty: compares by string so a numeric wire value and a text-input value never spuriously differ', () => {
  assert.equal(countDirty({ a: 80 }, { a: '80' }, ['a']), 0, '80 (number) vs "80" (input.value) must not count as dirty');
  assert.equal(countDirty({ a: 80 }, { a: '81' }, ['a']), 1);
  assert.equal(countDirty({ a: 80, b: 'x' }, { a: '80', b: 'y' }, ['a', 'b']), 1);
  assert.equal(countDirty({}, {}, []), 0);
});

test('parseExtField: number spec enforces min/max and rejects non-numeric without throwing', () => {
  const spec = { key: 'maxConcurrent', label: 'Max concurrent Claude runs', type: 'number', min: 1, max: 8 };
  assert.deepEqual(parseExtField(spec, '2'), { value: 2, error: null });
  assert.equal(parseExtField(spec, '0').value, null);
  assert.match(parseExtField(spec, '0').error, /at least 1/);
  assert.match(parseExtField(spec, '9').error, /at most 8/);
  assert.match(parseExtField(spec, 'abc').error, /must be a number/);
});

test('parseExtField: text spec passes the string through untouched', () => {
  const spec = { key: 'claudePath', type: 'text' };
  assert.deepEqual(parseExtField(spec, '/opt/homebrew/bin/claude'), { value: '/opt/homebrew/bin/claude', error: null });
});

// ---------------- jsdom: danger-zone arm gate + degraded-sweep interaction ----------------

function freshDom(url = 'http://127.0.0.1:43413/v2') {
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

const SETTINGS_FIXTURE = {
  paused: false,
  pauseMode: 'off',
  softGraceMs: 90000,
  home: '/Users/x',
  usagePollSec: 300,
  usageShow: 'banner',
  usageWarnPct: 70,
  usageCritPct: 85,
  awakeResetLeadMin: 10,
  projectRoots: '/Users/x/dev',
  beadsPollSec: 60,
  bdPath: '/opt/homebrew/bin/bd',
  worktreeRoot: '/Users/x/.claude-scheduler/worktrees',
  burstMinGapMin: 20,
  approvalDegraded: false,
  approvalDegradedReason: null,
  budgetGuard: true,
  reserveFiveHourPct: 80,
  reserveWeeklyPct: 95,
  pauseOnWarning: false,
  extensions: { claude: { claudePath: '/opt/homebrew/bin/claude', maxConcurrent: 2 } },
};
const EXTENSIONS_FIXTURE = {
  extensions: [{
    id: 'claude',
    name: 'Claude prompt',
    settings: [
      { key: 'claudePath', label: 'claude binary path', type: 'text', default: 'claude', required: true },
      { key: 'maxConcurrent', label: 'Max concurrent Claude runs', type: 'number', min: 1, max: 8, default: 2 },
    ],
  }],
};

function mockFetch(getMode) {
  return async (path) => {
    const mode = getMode();
    if (mode === 'reject') throw new Error('simulated daemon-unreachable');
    if (path.startsWith('/api/settings')) return { ok: true, status: 200, text: async () => JSON.stringify(SETTINGS_FIXTURE) };
    if (path.startsWith('/api/extensions')) return { ok: true, status: 200, text: async () => JSON.stringify(EXTENSIONS_FIXTURE) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
}

test('settings page: Cleanup/Uninstall buttons start disabled, and only arm once the exact phrase is typed', async () => {
  freshDom();
  let mode = 'ok';
  globalThis.fetch = mockFetch(() => mode);
  const settings = (await import(`../public/v2/pages/settings.js?t=${Date.now()}_arm`)).default;
  settings(new URLSearchParams());
  await tick(30);

  const page = document.getElementById('v2-page');
  const openBtn = [...page.querySelectorAll('button')].find((b) => b.textContent === 'Open…');
  assert.ok(openBtn, 'danger zone must start collapsed with an Open… control');
  openBtn.click();

  const cleanupInput = page.querySelector('input[placeholder="type cleanup"]');
  const wipeBtn = [...page.querySelectorAll('button')].find((b) => b.textContent === 'Wipe everything');
  assert.ok(cleanupInput && wipeBtn);
  assert.equal(wipeBtn.disabled, true, 'must start disabled — unarmed');

  cleanupInput.value = 'clean';
  cleanupInput.dispatchEvent(new window.Event('input'));
  assert.equal(wipeBtn.disabled, true, 'a partial phrase must not arm the button');

  cleanupInput.value = 'cleanup';
  cleanupInput.dispatchEvent(new window.Event('input'));
  assert.equal(wipeBtn.disabled, false, 'the exact phrase must arm the button');
});

test('settings page: a business-armed danger button is NOT wrongly re-armed by an unrelated healthy sweep, and IS disabled again the instant the daemon goes unreachable', async () => {
  freshDom();
  let mode = 'ok';
  globalThis.fetch = mockFetch(() => mode);
  const settings = (await import(`../public/v2/pages/settings.js?t=${Date.now()}_sweep`)).default;
  settings(new URLSearchParams());
  await tick(30);

  const page = document.getElementById('v2-page');
  [...page.querySelectorAll('button')].find((b) => b.textContent === 'Open…').click();
  const uninstallInput = page.querySelector('input[placeholder="type uninstall"]');
  const uninstallBtn = [...page.querySelectorAll('button')].find((b) => b.textContent.startsWith('Uninstall'));

  // Never armed — main.js's central sweep firing a healthy transition must
  // not flip this on (it carries no data-mutating; that's the point).
  const api = await import('../public/v2/api.js');
  mode = 'ok';
  await api.api('GET', '/api/probe').catch(() => {});
  assert.equal(uninstallBtn.disabled, true, 'an unarmed danger button must stay disabled through a healthy sweep');

  // Now arm it, then take the daemon down — the connectivity reason must win.
  uninstallInput.value = 'uninstall';
  uninstallInput.dispatchEvent(new window.Event('input'));
  assert.equal(uninstallBtn.disabled, false, 'armed + healthy must enable it');

  mode = 'reject';
  await api.api('GET', '/api/probe').catch(() => {});
  assert.equal(uninstallBtn.disabled, true, 'daemon-unreachable must disable it even though it is armed');
  assert.equal(uninstallBtn.getAttribute('data-tip'), 'Unavailable — daemon unreachable');
});

test('settings page: Save starts disabled (nothing dirty) and arms the instant a field changes', async () => {
  freshDom();
  let mode = 'ok';
  globalThis.fetch = mockFetch(() => mode);
  const settings = (await import(`../public/v2/pages/settings.js?t=${Date.now()}_dirty`)).default;
  settings(new URLSearchParams());
  await tick(30);

  const page = document.getElementById('v2-page');
  const saveBtn = [...page.querySelectorAll('button')].find((b) => b.textContent === 'Save settings');
  assert.equal(saveBtn.disabled, true, 'nothing edited yet — Save must start disabled');

  const pollInput = [...page.querySelectorAll('input.field--sm.mono')][0];
  pollInput.value = String(Number(pollInput.value) + 1);
  pollInput.dispatchEvent(new window.Event('input'));
  assert.equal(saveBtn.disabled, false, 'an edited field must arm Save');
  assert.match(page.querySelector('.actionbar__l').textContent, /1 field differs/);
});

test('settings page: "Default model" is NOT rendered — extensions/claude/index.js has no such daemon-wide setting', async () => {
  freshDom();
  globalThis.fetch = mockFetch(() => 'ok');
  const settings = (await import(`../public/v2/pages/settings.js?t=${Date.now()}_nomodel`)).default;
  settings(new URLSearchParams());
  await tick(30);
  const page = document.getElementById('v2-page');
  assert.ok(![...page.querySelectorAll('.setrow__n')].some((n) => n.textContent === 'Default model'),
    'a fabricated "Default model" setting must never be rendered — see settings.js top comment');
});

// ---------------- the fail-OPEN approval notice ----------------
//
// Added at the merge bar, not by the page author: the banner shipped with no
// test because the build host is macOS with the helper merely uninstalled,
// which is the fail-CLOSED path and never renders it. lib/approval.js draws a
// sharp distinction the UI must not blur — a non-darwin host returns
// `{degraded:true}` and gated actions RUN WITHOUT AN APPROVAL (available()'s
// "approvals are not implemented on ${platform} yet" branch), whereas a
// missing helper on darwin returns `{degraded:false}` and gated actions are
// REFUSED. Only the first is a silent loss of the safety model, and it is the
// one condition a browser user cannot otherwise see. A promise this page makes
// about safety gets exercised, not assumed.

test('settings page: a fail-OPEN approval platform is announced, and says actions proceed WITHOUT a prompt', async () => {
  freshDom();
  const degraded = {
    ...SETTINGS_FIXTURE,
    approvalDegraded: true,
    approvalDegradedReason: 'approvals are not implemented on linux yet — gated actions run without one',
  };
  globalThis.fetch = async (path) => {
    if (path.startsWith('/api/settings')) return { ok: true, status: 200, text: async () => JSON.stringify(degraded) };
    if (path.startsWith('/api/extensions')) return { ok: true, status: 200, text: async () => JSON.stringify(EXTENSIONS_FIXTURE) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
  const settings = (await import(`../public/v2/pages/settings.js?t=${Date.now()}_degraded`)).default;
  settings(new URLSearchParams());
  await tick(30);

  const text = document.getElementById('v2-page').textContent;
  assert.match(text, /WITHOUT/, 'the notice must state that gated actions proceed without a confirmation — the whole point of surfacing it');
  assert.match(text, /not implemented on linux/, 'it must carry the daemon\'s own reason, not a retyped guess');
});

test('settings page: the fail-OPEN notice does NOT appear when approvals are enforceable', async () => {
  // The other half, and the one that catches a banner wired to always render:
  // an uninstalled helper on darwin fails CLOSED (actions refused), which must
  // not be announced as "proceeding without a prompt".
  freshDom();
  let mode = 'ok';
  globalThis.fetch = mockFetch(() => mode);
  const settings = (await import(`../public/v2/pages/settings.js?t=${Date.now()}_ok`)).default;
  settings(new URLSearchParams());
  await tick(30);

  const text = document.getElementById('v2-page').textContent;
  assert.doesNotMatch(text, /WITHOUT a confirmation/, 'no fail-open notice when approvals can actually be enforced');
});

// ---------------- every gated control, not one instance of it ----------------
//
// Added at the merge bar. The page author tested the degraded sweep against
// the Uninstall button only, and mutation showed the gap was real: removing
// `degradedReason()` from the CLEANUP button's compound disable failed no
// test, leaving "Wipe everything" clickable against an unreachable daemon.
// Three controls fold connectivity into their own disable (Save, Cleanup,
// Uninstall) because none can carry data-mutating — a central sweep would
// wrongly re-enable them on a healthy transition. Whatever the mechanism, the
// guarantee has to hold for ALL of them, so this drives each rather than
// trusting that one implies the others. Same lesson as A2's README promise:
// exercise the contract from the consumer position, for every equivalent path.

const GATED_CONTROLS = [
  { label: 'Save settings', arm: null },
  { label: 'Wipe everything', arm: { placeholder: 'type cleanup', phrase: 'cleanup' } },
  { label: 'Uninstall', arm: { placeholder: 'type uninstall', phrase: 'uninstall' } },
];

for (const ctl of GATED_CONTROLS) {
  test(`settings page: "${ctl.label}" goes dead when the daemon is unreachable, even when business rules would enable it`, async () => {
    freshDom();
    let mode = 'ok';
    globalThis.fetch = mockFetch(() => mode);
    const settings = (await import(`../public/v2/pages/settings.js?t=${Date.now()}_gated_${ctl.phrase ?? ctl.label.replace(/\W/g, '')}`)).default;
    settings(new URLSearchParams());
    await tick(30);

    const page = document.getElementById('v2-page');
    [...page.querySelectorAll('button')].find((b) => b.textContent === 'Open…')?.click();
    const btn = [...page.querySelectorAll('button')].find((b) => b.textContent.startsWith(ctl.label));
    assert.ok(btn, `no control labelled ${ctl.label} — update this list if the page renamed it`);

    // Satisfy whatever business rule normally enables it.
    if (ctl.arm) {
      const input = page.querySelector(`input[placeholder="${ctl.arm.placeholder}"]`);
      input.value = ctl.arm.phrase;
      input.dispatchEvent(new window.Event('input'));
    } else {
      const field = [...page.querySelectorAll('input.field--sm.mono')][0];
      field.value = String(Number(field.value) + 1);
      field.dispatchEvent(new window.Event('input'));
    }
    assert.equal(btn.disabled, false, `${ctl.label} must be enabled once its business rule is satisfied — otherwise this test proves nothing`);

    const api = await import('../public/v2/api.js');
    mode = 'reject';
    await api.api('GET', '/api/probe').catch(() => {});
    assert.equal(btn.disabled, true, `${ctl.label} must be disabled while the daemon is unreachable`);
    assert.equal(btn.getAttribute('data-tip'), 'Unavailable — daemon unreachable',
      `${ctl.label} must say WHY it is dead, not just be dead`);
  });
}

test('settings page: a route opened while ALREADY degraded comes up dead, not just one degraded mid-session', async () => {
  // A2's finding, re-checked here: a change-only subscription misses the page
  // that mounts into an already-failing daemon, because no transition fires.
  freshDom();
  const api = await import('../public/v2/api.js');
  let mode = 'reject';
  globalThis.fetch = mockFetch(() => mode);
  await api.api('GET', '/api/probe').catch(() => {});   // degrade BEFORE mounting

  const settings = (await import(`../public/v2/pages/settings.js?t=${Date.now()}_colddegraded`)).default;
  settings(new URLSearchParams());
  await tick(30);

  // Before the fix this left #v2-page completely empty — a blank rectangle
  // under the global banner, with nothing naming what failed and no retry.
  const page = document.getElementById('v2-page');
  assert.ok(page.textContent.trim().length > 0, 'the route must not strand the user on an empty page');
  assert.match(page.textContent, /could not be read/, 'it must say what failed');
  assert.match(page.textContent, /api\/settings/, 'and name the request it tried');
  const retry = [...page.querySelectorAll('button')].find((b) => b.textContent === 'Try again');
  assert.ok(retry, 'a stranded page must offer a way out');

  // And it must NOT render an editable form: with no payload every field would
  // be blank, and saving would write those blanks over real settings.
  const save = [...page.querySelectorAll('button')].find((b) => b.textContent === 'Save settings');
  assert.equal(save, undefined, 'no Save control may exist when there is nothing loaded to save');
});
