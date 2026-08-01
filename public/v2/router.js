// /v2 hash router. See public/v2/README.md for how a page registers a route.
//
// Two properties carried over from public/app.js's prior art (lines ~68-110),
// preserved deliberately (bd note on claude-scheduler-btv.4):
//
//  1. An unrecognised fragment falls back to the default route rather than
//     hiding every section with no way back (public/app.js:72's hashParts()).
//  2. `#token=<hex>` is a DELIVERY MECHANISM, never a route. bin/claude-
//     scheduler.mjs opens `http://127.0.0.1:PORT/#token=<64hex>` — the same
//     channel this router uses for navigation. public/auth.js's
//     captureFromFragment() handles this by wiping the ENTIRE hash via
//     history.replaceState(null,'',location.pathname+location.search), which
//     would destroy a route for a hash-routed app. This router strips ONLY
//     the `token=<hex>` segment and preserves whatever route/query hash was
//     there — see stripToken() below.
//
// Unlike public/app.js's hashchange handler (which does a full
// location.reload() after capturing the token, because its boot already ran
// keyless), /v2's api.js reads the token fresh from localStorage on every
// call — so no reload is needed here. Stripping happens inline inside the
// same render pass that resolves the route.

import { setToken } from './api.js';

export const DEFAULT_ROUTE = 'overview';

const routes = new Map(); // name -> async (params: URLSearchParams) => void
let currentRoute = null;

// Fires after EVERY render — including the first one and a route navigated
// to while already degraded — not just on auth-state changes. main.js uses
// this to re-run the disable-with-reason sweep after a page's own content
// lands, which a change-triggered-only sweep would miss (a page rendered
// while the daemon is already unreachable must come up disabled, not wait
// for the NEXT transition to notice it).
const renderListeners = new Set();
export function onRender(fn) {
  renderListeners.add(fn);
  return () => renderListeners.delete(fn);
}

/** Register a route handler. Call before startRouter(); see README.md. */
export function registerRoute(name, handler) {
  routes.set(name, handler);
}

export function currentRouteName() {
  return currentRoute;
}

// Strip a `token=<64hex>` segment out of the raw (leading-`#`-stripped) hash,
// wherever it appears among `&`-joined top-level segments, leaving every
// other segment untouched. Returns true if a token was found and captured.
//
// Exported (not just called from render() below) so main.js can capture the
// token BEFORE mounting the chrome: chrome.js's first poll() fires an api()
// call immediately, and if that happens before this has run, it goes out
// with no Authorization header and 401s even on a legitimate cold
// `#token=` deep link — measured during this task's own browser verification.
export function captureTokenFromHash() {
  const raw = (location.hash || '').replace(/^#/, '');
  if (!raw) return false;
  const segs = raw.split('&');
  const idx = segs.findIndex((s) => /^token=[0-9a-f]{64}$/.test(s));
  if (idx === -1) return false;
  setToken(segs[idx].slice('token='.length));
  segs.splice(idx, 1);
  const rest = segs.join('&');
  // history.replaceState does NOT fire hashchange — render() below continues
  // in the same pass using the now-stripped hash, so no reload/recursion.
  history.replaceState(null, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
  return true;
}

/** Parse a hash into {route, params}. Exported for tests and for pages that want to read the current query without waiting for a render. */
export function parseHash(hash = location.hash) {
  const raw = (hash || '').replace(/^#/, '');
  const [route, query] = raw.split('?');
  return { route: routes.has(route) ? route : DEFAULT_ROUTE, params: new URLSearchParams(query || '') };
}

function setActiveNav(route) {
  for (const a of document.querySelectorAll('#v2-nav a[data-route]')) {
    if (a.dataset.route === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

async function render() {
  captureTokenFromHash();
  const { route, params } = parseHash();
  currentRoute = route;
  setActiveNav(route);
  const handler = routes.get(route) ?? routes.get(DEFAULT_ROUTE);
  if (handler) await handler(params);
  for (const fn of renderListeners) fn(route);
}

window.addEventListener('hashchange', render);

/** Boot: resolve whatever hash the page loaded with (including a cold #token= deep link) and render it. Call once, after registerRoute() for every route. */
export function startRouter() {
  return render();
}
