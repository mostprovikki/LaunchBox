// The /v2 route-walk gate's own tests (claude-scheduler-btv.13 / E1).
//
// A gate nobody tested is a gate that can quietly stop catching things — this
// repo has already shipped three wrong versions of one source-scan check
// (memory: mutate-lint-gates-in-every-offender-shape), and a walk that reports
// "clean" because its rules are broken is worse than no walk at all.
//
// So the rules live in tools/qa/audit-rules.mjs, pure and DOM-free, and are
// tested here against known-answer cases: WCAG's own published ratios, colours
// taken from the /v2 stylesheets, and the route list read back out of main.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  AA_NORMAL, AA_LARGE, MIN_PAGE_TEXT_LEN,
  isLargeText, requiredRatio, parseColor, luminance, contrastRatio, composite,
  isStrandedLightSurface, isAllowedConsole, isAllowedRequestFailure,
  evaluateRoute, summarise, V2_ROUTES, resolveHash, isWalkable,
  ALLOWED_CONSOLE, ALLOWED_REQUEST_FAILURES,
} from '../tools/qa/audit-rules.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// ------------------------------------------------------------ colour maths

test('contrastRatio reproduces the reference values WCAG itself publishes', () => {
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const black = { r: 0, g: 0, b: 0, a: 1 };
  // Known answers, not self-consistency: black on white is exactly 21:1, and a
  // colour against itself is exactly 1:1.
  assert.equal(Math.round(contrastRatio(black, white) * 100) / 100, 21);
  assert.equal(contrastRatio(white, white), 1);
  // #767676 on white is the canonical "just passes AA at 4.5" grey.
  const grey = { r: 0x76, g: 0x76, b: 0x76, a: 1 };
  const r = contrastRatio(grey, white);
  assert.ok(r >= 4.5 && r < 4.6, `#767676 on white should be just over 4.5:1, got ${r}`);
  // …and one shade lighter fails, which is the property the gate depends on.
  assert.ok(contrastRatio({ r: 0x80, g: 0x80, b: 0x80, a: 1 }, white) < 4.5);
});

test('luminance is monotonic and bounded', () => {
  assert.equal(luminance({ r: 0, g: 0, b: 0 }), 0);
  assert.equal(Math.round(luminance({ r: 255, g: 255, b: 255 }) * 1000) / 1000, 1);
  assert.ok(luminance({ r: 120, g: 120, b: 120 }) > luminance({ r: 60, g: 60, b: 60 }));
  // Green carries most of the weight — a check that the coefficients are the
  // sRGB ones and not three equal thirds.
  assert.ok(luminance({ r: 0, g: 255, b: 0 }) > luminance({ r: 255, g: 0, b: 0 }));
  assert.ok(luminance({ r: 255, g: 0, b: 0 }) > luminance({ r: 0, g: 0, b: 255 }));
});

test('parseColor reads both rgb() and rgba(), and refuses anything else', () => {
  assert.deepEqual(parseColor('rgb(12, 15, 19)'), { r: 12, g: 15, b: 19, a: 1 });
  assert.deepEqual(parseColor('rgba(12, 15, 19, 0.5)'), { r: 12, g: 15, b: 19, a: 0.5 });
  assert.equal(parseColor('transparent'), null);
  assert.equal(parseColor('#0C0F13'), null, 'getComputedStyle never returns hex, so hex is not accepted');
  assert.equal(parseColor(null), null);
});

test('composite flattens a translucent foreground onto its background', () => {
  const out = composite({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 });
  assert.deepEqual(out, { r: 127.5, g: 127.5, b: 127.5, a: 1 });
  // Fully opaque foreground wins outright.
  assert.deepEqual(composite({ r: 10, g: 20, b: 30, a: 1 }, { r: 0, g: 0, b: 0, a: 1 }),
    { r: 10, g: 20, b: 30, a: 1 });
});

test('the large-text threshold is WCAG\'s, both halves of it', () => {
  assert.equal(isLargeText(24, 400), true);
  assert.equal(isLargeText(23.9, 400), false);
  assert.equal(isLargeText(19, 700), true, '>=18.66px at >=700 is large');
  assert.equal(isLargeText(19, 600), false, '…but not at 600');
  assert.equal(isLargeText(18, 700), false, '…and not below 18.66px');
  assert.equal(requiredRatio(14, 400), AA_NORMAL);
  assert.equal(requiredRatio(30, 400), AA_LARGE);
  assert.ok(AA_NORMAL > AA_LARGE, 'small text must demand MORE contrast, not less');
});

test('the stranded-light-surface rule catches a panel and spares a knob', () => {
  const panel = { backgroundColor: 'rgb(251, 252, 253)', width: 300, height: 120, borderRadius: '8px', classList: ['card'] };
  assert.equal(isStrandedLightSurface(panel), true);
  // Dark surfaces are the point of dark mode.
  assert.equal(isStrandedLightSurface({ ...panel, backgroundColor: 'rgb(23, 27, 33)' }), false);
  // Translucent overlays are not stranded surfaces.
  assert.equal(isStrandedLightSurface({ ...panel, backgroundColor: 'rgba(251, 252, 253, 0.4)' }), false);
  // A switch knob and a round avatar are legitimately light.
  assert.equal(isStrandedLightSurface({ ...panel, classList: ['switch'] }), false);
  assert.equal(isStrandedLightSurface({ ...panel, borderRadius: '50%' }), false);
  // Too small to read as a panel.
  assert.equal(isStrandedLightSurface({ ...panel, width: 10, height: 4 }), false);
});

// --------------------------------------------------------------- verdicts

test('evaluateRoute reports each measured problem as its own finding', () => {
  const findings = evaluateRoute({
    route: 'jobs',
    theme: 'dark',
    page: {
      pageTextLen: 500,
      overflowPx: 14,
      contrast: [{ sel: 'span.t-meta', text: 'polled', ratio: 3.1, bg: '12,15,19', need: 4.5 }],
      stranded: [{ sel: 'div.card', bg: 'rgb(251,252,253)', w: 300, h: 120 }],
      unnamedIconButtons: ['button.iconbtn'],
    },
  });
  assert.deepEqual(findings.map((f) => f.kind).sort(),
    ['contrast', 'overflow', 'stranded_surface', 'unnamed_iconbtn']);
  for (const f of findings) {
    assert.equal(f.route, 'jobs');
    assert.equal(f.theme, 'dark');
    assert.ok(f.detail, 'every finding says what is wrong');
  }
});

test('evaluateRoute fails a route that presents an (almost) empty page', () => {
  // The check claude-scheduler-7j2 asked this gate to carry, so that defect
  // cannot recur on any of the pages it was never found on.
  const short = evaluateRoute({ route: 'runs', theme: 'dark', page: { pageTextLen: 0, contrast: [], stranded: [] } });
  assert.equal(short[0].kind, 'stranded_page');
  // A heading alone is still a stranded page.
  const headingOnly = evaluateRoute({ route: 'runs', theme: 'dark', page: { pageTextLen: 4, contrast: [], stranded: [] } });
  assert.equal(headingOnly[0].kind, 'stranded_page');
  // A real page passes.
  const ok = evaluateRoute({ route: 'runs', theme: 'dark', page: { pageTextLen: MIN_PAGE_TEXT_LEN + 1, contrast: [], stranded: [] } });
  assert.deepEqual(ok, []);
});

test('evaluateRoute treats a probe that returned nothing as a failure, not a pass', () => {
  // The precise shape of "the gate did not actually run". Returning [] here
  // would report a clean route the walk never measured.
  const findings = evaluateRoute({ route: 'settings', theme: 'light', page: null });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'probe_failed');
});

test('summarise fails on any console error or failed request', () => {
  assert.equal(summarise({}).ok, true);
  assert.equal(summarise({ consoleErrors: ['TypeError: x is not a function'] }).ok, false);
  assert.equal(summarise({ requestFailures: ['500 /api/jobs'] }).ok, false);
  assert.equal(summarise({ routeFindings: [{ kind: 'contrast' }] }).ok, false);
  const v = summarise({ routeFindings: [{ kind: 'contrast' }, { kind: 'contrast' }], consoleErrors: ['boom'] });
  assert.deepEqual(v.byKind, { contrast: 2, console_error: 1 });
});

test('the allow-lists are EMPTY, and nothing common slips through them', () => {
  // The gate's strength is that it has no exceptions. /favicon.ico used to be
  // the one entry; that bug (claude-scheduler-0ez) was fixed instead, by
  // declaring <link rel="icon"> so the browser never asks.
  assert.deepEqual(ALLOWED_CONSOLE, []);
  assert.deepEqual(ALLOWED_REQUEST_FAILURES, []);
  for (const noise of [
    'Failed to load resource: 404 http://x/favicon.ico',
    'TypeError: cannot read properties of null',
    '500 /api/jobs',
    'Refused to apply style from http://x/v2/assets/system.css',
  ]) {
    assert.equal(isAllowedConsole(noise), false, `"${noise}" must not be waved through`);
    assert.equal(isAllowedRequestFailure(noise), false);
  }
});

test('both UIs declare a favicon, so /favicon.ico is never requested', () => {
  // The fix behind the empty allow-list, pinned so a later edit to either head
  // cannot quietly reintroduce the 404 the walk would then fail on.
  for (const f of ['public/index.html', 'public/v2/index.html']) {
    assert.match(read(f), /<link rel="icon" href="\/favicon\.svg"/, `${f} does not declare an icon`);
  }
  assert.match(read('public/favicon.svg'), /^<svg /, 'the icon file itself must exist');
});

// ------------------------------------------------------------- route list

test('the walk covers every route main.js registers', () => {
  // A route left out of the walk is a route with no gate. Read back from
  // main.js rather than retyped, so adding a ninth route without adding it
  // here goes red.
  const registered = [...read('public/v2/main.js').matchAll(/registerRoute\('([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(registered.length >= 8, `expected main.js to register routes, found ${registered.length}`);
  assert.deepEqual(V2_ROUTES.map((r) => r.name).sort(), registered.sort());
});

test('a deep-link route with no id is SKIPPED, never silently passed', () => {
  const project = V2_ROUTES.find((r) => r.name === 'project');
  const session = V2_ROUTES.find((r) => r.name === 'session');
  assert.equal(isWalkable(project, {}), false);
  assert.equal(isWalkable(project, { projectId: 'p1' }), true);
  assert.equal(isWalkable(session, { projectId: 'p1' }), false);
  assert.equal(isWalkable(session, { sessionId: 's1' }), true);
  // A plain route is always walkable.
  assert.equal(isWalkable(V2_ROUTES.find((r) => r.name === 'jobs'), {}), true);
});

test('resolveHash fills and escapes the ids', () => {
  assert.equal(resolveHash('#project?id=:projectId', { projectId: 'a b/c' }), '#project?id=a%20b%2Fc');
  assert.equal(resolveHash('#jobs', {}), '#jobs');
});

// ----------------------------------------------------- driver source gates

test('the driver never points the walk at the owner\'s daemon by default', () => {
  // 43400 is a foreground process the owner runs, holding their real jobs. A
  // gate that needs it running cannot run on a clean checkout, and one that
  // writes to it is worse.
  const src = read('tools/qa/v2-route-walk.mjs');
  assert.match(src, /const PORT = 43410;/, 'the walk uses the allocated QA slot');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/43400/.test(stripped), 'the driver must not reference the owner\'s port outside comments');
  // …and it isolates its data.
  assert.match(src, /CS_DATA: dataDir/);
  assert.match(src, /mkdtemp/);
});

test('the driver injects the tested thresholds into the probe rather than retyping them', () => {
  // The whole reason the rules were extracted: a probe with its own copy of
  // 4.5 is a probe these tests do not actually cover.
  const src = read('tools/qa/v2-route-walk.mjs');
  assert.match(src, /T\.aaNormal/);
  assert.match(src, /T\.strandedLum/);
  const probe = /function probeSource\([\s\S]*?\n\}/.exec(src)[0];
  for (const literal of ['4.5', '0.75', '18.66']) {
    assert.ok(!probe.includes(literal), `the probe hard-codes ${literal} instead of taking it from audit-rules.mjs`);
  }
});

test('the gate exits non-zero when it finds something', () => {
  // A gate that reports findings and exits 0 is decorative.
  const src = read('tools/qa/v2-route-walk.mjs');
  assert.match(src, /return verdict\.ok \? 0 : 1;/);
  assert.match(src, /process\.exitCode = await main\(\)/);
});
