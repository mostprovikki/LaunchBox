// The /v2 interaction gates' own tests (claude-scheduler-btv.14 / E2).
//
// Same argument as tests/qa-route-walk.test.js: a gate whose rules have
// quietly stopped catching things reports clean forever. Every rule here has a
// "could not measure" case, because in this battery the most likely failure is
// not a wrong threshold — it is a check that silently measured nothing. Three
// of E2's first seven findings were exactly that, in my own harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  DIALOG_CONTRACT, V2_DIALOGS, evaluateDialog, evaluateFilter, hasVisibleFocusIndicator,
  evaluateKeyboardWalk, evaluateFocusTooltip, evaluateDegraded, evaluateRecovery, summarise,
} from '../tools/qa/interaction-rules.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const allTrue = () => Object.fromEntries(DIALOG_CONTRACT.map((k) => [k, true]));

test('the dialog contract lists every point, by name', () => {
  // Iterating DIALOG_CONTRACT is not enough on its own: deleting an entry then
  // deletes its test too, and everything stays green. A mutation removing
  // `focusInside` escaped exactly that way.
  assert.deepEqual([...DIALOG_CONTRACT].sort(), [
    'backdropCloses', 'closeButtonCloses', 'escapeCloses', 'focusInside', 'opens', 'role',
  ]);
});

test('every dialog module moves focus into the dialog when it opens', () => {
  // The browser gate measures this, but only when it runs. A source gate makes
  // a regression visible in `npm test` too — and a mutation deleting the
  // planners' focus call escaped the unit suite entirely before this existed.
  for (const m of [...new Set(V2_DIALOGS.map((d) => d.module))]) {
    const src = read(join('public/v2', m));
    assert.match(src, /\.focus\(\)/, `${m} never moves focus — a keyboard user is stranded behind the overlay`);
  }
  // …and specifically: the shared planner shell focuses its close control,
  // because those dialogs build their body asynchronously and have no field to
  // focus at open time.
  assert.match(read('public/v2/pages/plan-dialogs.js'), /closeBtn\.focus\(\);/);
});

// --------------------------------------------------------------- dialogs

test('a dialog satisfying every contract point yields no findings', () => {
  assert.deepEqual(evaluateDialog({ name: 'job', results: allTrue() }), []);
});

test('each dialog contract point fails on its own', () => {
  for (const key of DIALOG_CONTRACT) {
    const results = { ...allTrue(), [key]: false };
    const found = evaluateDialog({ name: 'job', results });
    assert.equal(found.length, 1, `breaking "${key}" produced ${found.length} findings`);
    assert.match(found[0].detail, new RegExp(`"${key}"`));
  }
});

test('a contract point the driver never measured is a FAILURE, not a pass', () => {
  // The shape of a silent skip: the driver forgets to set `escapeCloses`, and
  // a naive loop over what IS present reports the dialog clean.
  const partial = allTrue();
  delete partial.escapeCloses;
  const found = evaluateDialog({ name: 'job', results: partial });
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /was not measured at all/);
});

test('a dialog that never opened fails every downstream point, not just "opens"', () => {
  const found = evaluateDialog({ name: 'burst', results: { opens: false } });
  assert.equal(found.length, DIALOG_CONTRACT.length);
  assert.equal(evaluateDialog({ name: 'burst', results: null }).length, 1);
});

test('every dialog module that exports an opener is covered by the battery', () => {
  // A dialog added without a gate should be a visible omission.
  const modules = new Set(V2_DIALOGS.map((d) => d.module));
  for (const m of modules) assert.ok(read(join('public/v2', m)).includes('export function open'), `${m} has no opener`);
  // plan-dialogs.js exports two openers, and both are listed.
  const openers = [...read('public/v2/pages/plan-dialogs.js').matchAll(/export function (open\w+)/g)].map((x) => x[1]);
  assert.equal(openers.length, 2, openers.join(', '));
  assert.equal(V2_DIALOGS.filter((d) => d.module === 'pages/plan-dialogs.js').length, 2);
});

// --------------------------------------------------------------- filters

test('a filter that narrows the list and keeps the caret passes', () => {
  assert.deepEqual(evaluateFilter({
    surface: '#jobs', before: 4, after: 1, query: 'alpha',
    focusedId: 'jobs-search', expectedId: 'jobs-search', caret: 5, expectedCaret: 5,
  }), []);
});

test('a filter gate fails when it proved nothing, narrowed nothing, or lost the caret', () => {
  const base = { surface: '#jobs', query: 'alpha', focusedId: 'jobs-search', expectedId: 'jobs-search', caret: 5, expectedCaret: 5 };
  // Nothing listed to begin with — the query proved nothing.
  assert.match(evaluateFilter({ ...base, before: 0, after: 0 })[0].detail, /proved nothing/);
  // Did not narrow.
  assert.match(evaluateFilter({ ...base, before: 4, after: 4 })[0].detail, /did not narrow/);
  // Matched nothing — a query that filters everything away is a bad probe.
  assert.match(evaluateFilter({ ...base, before: 4, after: 0 }).map((f) => f.detail).join(' '), /matched nothing/);
  // Focus stolen mid-word: the defect a row-count-only test cannot see.
  assert.match(evaluateFilter({ ...base, before: 4, after: 1, focusedId: 'BODY' })[0].detail, /focus moved/);
  // Caret jumped.
  assert.match(evaluateFilter({ ...base, before: 4, after: 1, caret: 0 })[0].detail, /caret jumped/);
  // Never measured at all.
  assert.match(evaluateFilter({ ...base, before: null, after: null })[0].detail, /never measured/);
});

// ------------------------------------------------------- keyboard / focus

test('a focus indicator counts when it is an outline, a new shadow, or a border change', () => {
  const plain = { outlineWidth: '0px', outlineStyle: 'none', boxShadow: 'none', borderColor: 'rgb(1,1,1)' };
  assert.equal(hasVisibleFocusIndicator({ resting: plain, focused: { ...plain, outlineWidth: '2px', outlineStyle: 'auto' } }), true);
  assert.equal(hasVisibleFocusIndicator({ resting: plain, focused: { ...plain, boxShadow: '0 0 0 3px blue' } }), true);
  assert.equal(hasVisibleFocusIndicator({ resting: plain, focused: { ...plain, borderColor: 'rgb(2,2,2)' } }), true);
  // Nothing changes: the regression this exists to catch.
  assert.equal(hasVisibleFocusIndicator({ resting: plain, focused: plain }), false);
  // An outline declared but zero-width does not count.
  assert.equal(hasVisibleFocusIndicator({ resting: plain, focused: { ...plain, outlineWidth: '0px', outlineStyle: 'solid' } }), false);
});

test('a ring on an ANCESTOR counts — :focus-within is a legitimate pattern', () => {
  // The search box sets `outline: 0` on its input and rings the .search
  // wrapper. Judging the input alone reported a correctly-indicated control as
  // unindicated, and a gate with false reds is one everyone learns to ignore.
  const plain = { outlineWidth: '0px', outlineStyle: 'none', boxShadow: 'none', borderColor: 'rgb(1,1,1)' };
  assert.equal(hasVisibleFocusIndicator({
    resting: plain, focused: plain,
    ancestorResting: plain, ancestorFocused: { ...plain, boxShadow: '0 0 0 3px var(--info-wash)' },
  }), true);
  // …but an unchanged ancestor does not rescue an unindicated control.
  assert.equal(hasVisibleFocusIndicator({
    resting: plain, focused: plain, ancestorResting: plain, ancestorFocused: plain,
  }), false);
});

test('a tab walk that reached almost nothing is reported as not having run', () => {
  const stop = (key) => ({ key, visibleIndicator: true });
  assert.deepEqual(evaluateKeyboardWalk({ stops: Array.from({ length: 12 }, (_, i) => stop(`b${i}`)) }), []);
  const thin = evaluateKeyboardWalk({ stops: [stop('a'), stop('b')] });
  assert.equal(thin.length, 1);
  assert.match(thin[0].detail, /did not really run/);
});

test('the tab walk reports each unindicated control once, not once per visit', () => {
  const stops = [
    { key: 'button.btn', visibleIndicator: false },
    { key: 'button.btn', visibleIndicator: false },
    ...Array.from({ length: 10 }, (_, i) => ({ key: `x${i}`, visibleIndicator: true })),
  ];
  assert.equal(evaluateKeyboardWalk({ stops }).length, 1);
});

// ------------------------------------------------------- focus tooltips

test('a tooltip that is hidden at rest and revealed on focus passes', () => {
  assert.deepEqual(evaluateFocusTooltip({
    surface: '#jobs', selector: 'button.iconbtn',
    restingOpacity: '0', focusedOpacity: '1', content: '"Open log"',
  }), []);
});

test('the tooltip gate catches the three ways it can be broken', () => {
  const base = { surface: '#jobs', selector: 'button.iconbtn', restingOpacity: '0', focusedOpacity: '1', content: '"x"' };
  // Never revealed — keyboard users never see the reason.
  assert.match(evaluateFocusTooltip({ ...base, focusedOpacity: '0' })[0].detail, /does not reveal/);
  // Always visible — not a tooltip.
  assert.match(evaluateFocusTooltip({ ...base, restingOpacity: '1' })[0].detail, /already visible at rest/);
  // No content: exactly what a replaced element (an <input>) produces, because
  // ::after cannot render on one. That found a real defect — a switch whose
  // tooltip nobody had ever seen.
  assert.match(evaluateFocusTooltip({ ...base, content: 'none' })[0].detail, /no content/);
  // Not measured at all.
  assert.match(evaluateFocusTooltip({ ...base, restingOpacity: null })[0].detail, /never measured/);
});

test('the enable switch carries its tooltip on a wrapper, not on the input', () => {
  // The fix for that defect, pinned: ::after does not render on a replaced
  // element, so a data-tip on the <input> is invisible to hover AND keyboard.
  const src = read('public/v2/pages/jobs.js');
  const block = /const sw = el\('input', \{[\s\S]*?\}\);/.exec(src)[0];
  assert.ok(!block.includes('data-tip'), 'the switch input must not carry data-tip — it cannot render one');
  assert.match(block, /aria-label/, 'it keeps its accessible name');
  assert.match(block, /data-mutating/, 'and stays in the degraded sweep');
  const wrap = /const swWrap = el\('span', \{[\s\S]*?\}, sw\);/.exec(src)?.[0] ?? '';
  assert.match(wrap, /'data-tip'/, 'a wrapper carries the visible tooltip');
  // …and the wrapper is swept too, so the tooltip the reader actually SEES
  // becomes the degraded reason rather than staying "turn off to stop
  // scheduling" over a dead control.
  assert.match(wrap, /'data-mutating'/, 'the wrapper must be swept so its visible tooltip stays honest');
});

// -------------------------------------------------- daemon-down disabling

test('every data-mutating control must be disabled AND say why', () => {
  const good = Array.from({ length: 4 }, (_, i) => ({ key: `b${i}`, disabled: true, tip: 'Unavailable — daemon unreachable' }));
  assert.deepEqual(evaluateDegraded({ controls: good }), []);
  // Still live.
  const live = [...good.slice(1), { key: 'b0', disabled: false, tip: null }];
  assert.match(evaluateDegraded({ controls: live })[0].detail, /still live/);
  // Dead but silent — the exact thing REVIEW #2 exists to prevent.
  const silent = [...good.slice(1), { key: 'b0', disabled: true, tip: 'Open log' }];
  assert.match(evaluateDegraded({ controls: silent })[0].detail, /does not say why/);
});

test('a degraded sweep with almost nothing to sweep is reported as vacuous', () => {
  const thin = evaluateDegraded({ controls: [{ key: 'b', disabled: true, tip: 'Unavailable — x' }] });
  assert.equal(thin.length, 1);
  assert.match(thin[0].detail, /nothing to prove/);
});

test('recovery must revive connectivity-disabled controls but not business-disabled ones', () => {
  assert.deepEqual(evaluateRecovery({ controls: [{ key: 'a', disabled: false }] }), []);
  // A control disabled because a burst is running is legitimately still dead.
  assert.deepEqual(evaluateRecovery({ controls: [{ key: 'b', disabled: true, businessDisabled: true }] }), []);
  // One disabled for no reason at all is a stuck sweep.
  assert.match(evaluateRecovery({ controls: [{ key: 'c', disabled: true, businessDisabled: false }] })[0].detail, /still disabled/);
  // Nothing measured.
  assert.match(evaluateRecovery({ controls: [] })[0].detail, /did not run/);
});

test('summarise is clean only when there is nothing at all', () => {
  assert.equal(summarise([]).ok, true);
  const v = summarise([{ kind: 'dialog' }, { kind: 'dialog' }, { kind: 'tooltip' }]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.byKind, { dialog: 2, tooltip: 1 });
});

// ------------------------------------------- the central sweep's guarantee

test('the degraded sweep survives a page re-rendering from its own poll', () => {
  // The defect E2 found: the sweep fired on auth-state change and route
  // render, but a page re-rendering from its OWN 4s poll builds brand-new
  // controls that neither trigger touches — so with the daemon down, jobs.js
  // resurrected every control it had just been swept out of.
  //
  // Fixed centrally rather than by adding a call to each page (three were
  // missing one), because the README promises that adding `data-mutating` is
  // the WHOLE job.
  const src = read('public/v2/main.js');
  assert.match(src, /new MutationObserver/, 'main.js must observe newly added controls');
  assert.match(src, /mutatingObserver\.observe\(document\.body, \{ childList: true, subtree: true \}\)/);
  // Inert while healthy: it must never re-disable a control that is fine.
  assert.match(src, /const reason = degradedReason\(\);\s*\n\s*if \(!reason\) return;/);
  // The two original triggers stay — the observer only covers added nodes.
  assert.match(src, /onAuthState\(sweepMutatingControls\)/);
  assert.match(src, /onRender\(sweepMutatingControls\)/);
});

// ------------------------------------------------------ driver hygiene

test('the interaction driver isolates itself the same way the route walk does', () => {
  const src = read('tools/qa/v2-interactions.mjs');
  assert.match(src, /const PORT = 43410;/);
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/43400/.test(stripped), 'it must not reach for the owner\'s daemon');
  assert.match(src, /CS_DATA: dataDir/);
  assert.match(src, /return verdict\.ok \? 0 : 1;/, 'and it must exit non-zero on findings');
});

test('the driver presses a REAL Tab rather than calling el.focus()', () => {
  // :focus-visible — which is what reveals a tooltip and draws most focus
  // rings — is not applied to a programmatic focus. The first version of both
  // gates used el.focus() and produced nine false findings.
  const src = read('tools/qa/v2-interactions.mjs');
  assert.match(src, /Input\.dispatchKeyEvent/);
  assert.match(src, /async function pressTab/);
  // Anchored on the SECTION markers, not on the words: the first version
  // sliced from the file header's own prose ("the keyboard walk, focus
  // tooltips…") and so examined a few lines of comment, which is why a
  // mutation replacing the real Tab with a programmatic focus escaped it.
  const start = src.indexOf("log('\\n· keyboard walk");
  const end = src.indexOf("log('\\n· focus tooltips");
  assert.ok(start > 0 && end > start, 'the walk section could not be located — this test is measuring nothing');
  const walk = src.slice(start, end);
  assert.match(walk, /pressTab\(conn\)/, 'the walk must advance with a real Tab');
  // Any programmatic focus inside the walk, however it is spelled, defeats the
  // point — :focus-visible is exactly what would not be applied.
  assert.ok(!/\.focus\(\)/.test(walk.replace(/document\.body\.focus\(\)/g, '')),
    'the keyboard walk must not focus anything programmatically (except resetting to body)');
});

test('the driver uses named fixtures, never list[0]', () => {
  // A gate that grabs whatever exists stops asserting the moment the data
  // changes.
  const src = read('tools/qa/v2-interactions.mjs');
  assert.match(src, /const FIXTURE_JOBS = \[/);
  assert.match(src, /QA alpha rotate logs/);
});
