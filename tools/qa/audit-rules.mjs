// The /v2 route-walk gate's RULES, kept pure and DOM-free so they can be unit
// tested and mutation-checked without a browser (claude-scheduler-btv.13 / E1).
// tools/qa/v2-route-walk.mjs is the driver that collects measurements from a
// real Chrome and feeds them through these.
//
// The colour maths is ported from redesign/qa/audit.mjs, the tool that produced
// the audit the redesign was built from. Two deliberate changes:
//
//  1. That tool requires `playwright-core` through a hard-coded path into
//     ANOTHER project's node_modules. A gate that only runs on one machine is
//     not a gate, so the driver uses this repo's own dependency-free CDP client
//     (tools/screenshots/cdp.mjs) instead.
//  2. The thresholds and the verdict live here rather than inline in a
//     template string, because a rule you cannot unit test is a rule you cannot
//     mutation-check — and this repo has already shipped three wrong versions
//     of one source-scan gate (memory: mutate-lint-gates-in-every-offender-shape).

// WCAG 2.1 AA. Large text is >= 24px, or >= 18.66px at weight >= 700.
export const AA_NORMAL = 4.5;
export const AA_LARGE = 3.0;
export const LARGE_PX = 24;
export const LARGE_BOLD_PX = 18.66;
export const LARGE_BOLD_WEIGHT = 700;

export function isLargeText(px, weight) {
  const p = Number(px);
  const w = Number(weight) || 400;
  return p >= LARGE_PX || (p >= LARGE_BOLD_PX && w >= LARGE_BOLD_WEIGHT);
}

export function requiredRatio(px, weight) {
  return isLargeText(px, weight) ? AA_LARGE : AA_NORMAL;
}

export function parseColor(css) {
  const m = String(css ?? '').match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
}

export function luminance({ r, g, b }) {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Composite a translucent foreground over an opaque background. */
export function composite(fg, bg) {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

// A light surface stranded in dark mode: an element painted nearly-opaque and
// bright, big enough to read as a panel rather than a dot. The size floor and
// the round-shape exemption come from the original audit — a switch knob and a
// circular avatar are legitimately light.
export const STRANDED_MIN_ALPHA = 0.9;
export const STRANDED_MIN_LUM = 0.75;
export const STRANDED_MIN_W = 24;
export const STRANDED_MIN_H = 8;

export function isStrandedLightSurface({ backgroundColor, width, height, borderRadius, classList = [] }) {
  const c = parseColor(backgroundColor);
  if (!c || c.a < STRANDED_MIN_ALPHA) return false;
  if (luminance(c) <= STRANDED_MIN_LUM) return false;
  if (!(width > STRANDED_MIN_W && height > STRANDED_MIN_H)) return false;
  if (borderRadius === '50%') return false;
  if (classList.includes('switch')) return false;
  return true;
}

/**
 * Console noise the gate accepts: NOTHING.
 *
 * The first run of this walk had exactly one entry — the `/favicon.ico` 404
 * that both UIs produced (claude-scheduler-0ez). Rather than carry a permanent
 * exception, that bug was fixed: both index.html files now declare
 * `<link rel="icon">`, so the browser never asks for `/favicon.ico` at all.
 * An empty allow-list is the strongest form of this gate, and every exception
 * added here weakens it for every future route — "ignore anything with /api/
 * in it" would have hidden every failure this walk exists to find.
 *
 * If something genuinely unavoidable appears, add the NARROWEST pattern that
 * covers it and file the bug, rather than widening an existing one.
 */
export const ALLOWED_CONSOLE = [];
export const ALLOWED_REQUEST_FAILURES = [];

export const isAllowedConsole = (text) => ALLOWED_CONSOLE.some((re) => re.test(String(text ?? '')));
export const isAllowedRequestFailure = (text) => ALLOWED_REQUEST_FAILURES.some((re) => re.test(String(text ?? '')));

/**
 * Turn one route's measurements into findings. `page` is what the in-page
 * probe returned; `route`/`theme` only label the output.
 *
 * `minTextLen` is the stranded-page check that claude-scheduler-7j2 asked this
 * gate to carry: no route may present an empty #v2-page, whatever the daemon's
 * state. A page that renders only its heading is still a failure — the number
 * is deliberately above "Runs" plus whitespace.
 */
export const MIN_PAGE_TEXT_LEN = 60;

export function evaluateRoute({ route, theme, page }) {
  const findings = [];
  const at = (kind, detail) => findings.push({ route, theme, kind, detail });

  if (!page) {
    at('probe_failed', 'the in-page probe returned nothing');
    return findings;
  }

  if ((page.pageTextLen ?? 0) < MIN_PAGE_TEXT_LEN) {
    at('stranded_page', `#v2-page has ${page.pageTextLen} characters — a route must never present an empty page (claude-scheduler-7j2)`);
  }
  if ((page.overflowPx ?? 0) > 0) {
    at('overflow', `the document scrolls ${page.overflowPx}px horizontally`);
  }
  for (const c of page.contrast ?? []) {
    at('contrast', `${c.sel} "${c.text}" is ${c.ratio}:1 on ${c.bg} (needs ${c.need}:1)`);
  }
  for (const s of page.stranded ?? []) {
    at('stranded_surface', `${s.sel} is a ${s.w}x${s.h} light surface (${s.bg}) in dark mode`);
  }
  for (const b of page.unnamedIconButtons ?? []) {
    at('unnamed_iconbtn', `${b} has no aria-label (REVIEW #5)`);
  }
  return findings;
}

/** The whole walk's verdict. Console/request noise is judged once, globally. */
export function summarise({ routeFindings = [], consoleErrors = [], requestFailures = [] }) {
  const console_ = consoleErrors.filter((e) => !isAllowedConsole(e));
  const requests = requestFailures.filter((e) => !isAllowedRequestFailure(e));
  const findings = [
    ...routeFindings,
    ...console_.map((detail) => ({ route: '(any)', theme: '(any)', kind: 'console_error', detail })),
    ...requests.map((detail) => ({ route: '(any)', theme: '(any)', kind: 'request_failed', detail })),
  ];
  const byKind = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  return { ok: findings.length === 0, findings, byKind };
}

/**
 * The routes the walk covers. Every route main.js registers, because a route
 * left out of the walk is a route with no gate — and `?id=` routes are listed
 * separately from their lists, since a detail page is where the stranded-page
 * and contrast risks actually concentrate.
 */
export const V2_ROUTES = Object.freeze([
  { name: 'overview', hash: '#overview' },
  { name: 'jobs', hash: '#jobs' },
  { name: 'runs', hash: '#runs' },
  { name: 'projects', hash: '#projects' },
  { name: 'project', hash: '#project?id=:projectId' },
  { name: 'graph', hash: '#graph?id=:projectId' },
  { name: 'sessions', hash: '#sessions' },
  { name: 'session', hash: '#session?id=:sessionId' },
  { name: 'settings', hash: '#settings' },
]);

/** Fill `:projectId` / `:sessionId` from what the seeded instance actually has. */
export function resolveHash(hash, ids = {}) {
  return hash
    .replace(':projectId', encodeURIComponent(ids.projectId ?? ''))
    .replace(':sessionId', encodeURIComponent(ids.sessionId ?? ''));
}

/**
 * Whether a route can be walked with the ids available. A `?id=` route with no
 * id is SKIPPED, and the skip is reported — silently passing a route the walk
 * never visited is the "gate that can mean didn't run" failure this repo has
 * already been bitten by (claude-scheduler-2wf).
 */
export function isWalkable(route, ids = {}) {
  if (route.hash.includes(':projectId')) return !!ids.projectId;
  if (route.hash.includes(':sessionId')) return !!ids.sessionId;
  return true;
}
