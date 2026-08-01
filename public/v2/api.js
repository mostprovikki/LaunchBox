// /v2 API client — the ONE place a page gets its bearer token, its JSON fetch,
// and the failure vocabulary. See public/v2/README.md for the frozen contract.
//
// Semantics are copied from public/auth.js + public/util.js — NOT imported.
// /v2 owns its own modules (see index.html's ownership comment / README): at
// cutover public/*.js goes away, and an import here would take /v2 with it.
//
// One deliberate difference from public/auth.js: token *capture* from the URL
// fragment is NOT done here. /v2 needs the fragment for routing too (the same
// channel bin/claude-scheduler.mjs uses to deliver `#token=<hex>`), so
// public/v2/router.js owns stripping it and calls `setToken()` below. This
// module only reads/writes the stored value.

const TOKEN_KEY = 'cs.token'; // same localStorage key as the old UI — same-origin, so a token captured there or here is shared for free.

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (hex) => localStorage.setItem(TOKEN_KEY, hex);

const authHeaders = () => {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
};

// Machine-readable failure vocabulary — wording copied from public/auth.js's
// FAILURE_COPY so the two UIs never say the same failure two different ways.
// `unreachable` is new here: /v2's client has to recognise "the fetch itself
// threw" (daemon down, refused connection) as its own state, because /v2 is
// the surface that stays open across a daemon restart and has to explain that.
export const FAILURE_COPY = {
  token_invalid: 'This session key is no longer valid. Stop the scheduler, start it again, then reopen with: claude-scheduler open',
  approval_denied: 'You denied the approval — nothing was saved. Press Submit again to retry.',
  approval_timeout: 'The approval request timed out — nothing was saved. Press Submit again to retry.',
  approval_unavailable: 'The approval helper is unavailable, so this was refused. Reinstall to rebuild it.',
  approval_busy: 'Another approval is already waiting. Finish that one, then try again.',
  unreachable: 'The daemon is unreachable. Requests are failing; retrying automatically.',
};

// ---- global degraded-state tracking ----------------------------------
// Two states get a persistent appbar banner + disable every mutating control
// (REVIEW #2): 'token_invalid' and 'unreachable'. Approval outcomes are never
// global — they are per-form, via guardedSubmit() below — so they are not in
// this set. chrome.js is the only subscriber in this task; wave-2 pages call
// setDisabledReason()/disableMutatingControls() from public/v2/ui.js, which
// read getAuthState() themselves rather than each maintaining a subscription.
const listeners = new Set();
let authState = null; // null | 'token_invalid' | 'unreachable'

export function onAuthState(fn) {
  listeners.add(fn);
  fn(authState); // fire immediately so a late subscriber doesn't miss the current state
  return () => listeners.delete(fn);
}

export function getAuthState() {
  return authState;
}

// The ONE definition of the two disable-reason strings (REVIEW #2). Every
// consumer — chrome.js's appbar segs, main.js's central sweep, any wave-2
// page that calls setDisabledReason()/disableMutatingControls() directly —
// reads this instead of retyping the copy. A coordinator review (this bead,
// round 2) caught the README asking pages to hand-copy these verbatim, which
// is exactly the "two pages word the same failure differently" failure mode
// FAILURE_COPY above exists to prevent; this closes that gap for good.
export function degradedReason(state = authState) {
  if (state === 'unreachable') return 'Unavailable — daemon unreachable';
  if (state === 'token_invalid') return 'Unavailable — session token rejected; reopen with claude-scheduler open';
  return null;
}

function setAuthState(next) {
  if (next === authState) return;
  authState = next;
  for (const fn of listeners) fn(authState);
}

/**
 * Thin fetch wrapper. Every /v2 page calls this instead of raw `fetch` —
 * tests/frontend-v2-conventions.test.js enforces it the same way the old
 * suite does for public/*.js.
 *
 * Normalises every failure to a thrown Error carrying `{status, code, data}`.
 * A transport failure (fetch() itself rejects — refused connection, DNS, the
 * daemon is down) is given `code: 'unreachable'` and no `status`; callers
 * that only branch on `err.code` handle both cases identically.
 */
export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // Long enough for a 180s Touch ID / password approval to resolve — same
      // bound as public/util.js's api(), for the same reason.
      signal: AbortSignal.timeout(200_000),
    });
  } catch (err) {
    setAuthState('unreachable');
    throw Object.assign(new Error('daemon unreachable'), { code: 'unreachable', transport: true, cause: err });
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const code = data?.code;
    if (code === 'token_invalid') setAuthState('token_invalid');
    throw Object.assign(new Error(data?.error || `api error ${res.status}`), { status: res.status, data, code });
  }
  // A request round-tripped successfully: whatever degraded state was showing
  // (most recently 'unreachable' — a live token_invalid can't reach here,
  // every call would keep 401ing) is over.
  setAuthState(null);
  return data;
}

// Toast copy for a failure, or `null` for the two states that already get a
// persistent banner instead (piling a toast on top of the banner is noise).
export function failureToast(err) {
  const code = err?.code;
  if (code === 'token_invalid' || code === 'unreachable') return null;
  return FAILURE_COPY[code] ?? (err?.data?.errors || [err?.data?.error || err?.message || 'that failed']).join(' · ');
}

/**
 * Wrap any mutating submit. Contract (copied from public/auth.js
 * guardedSubmit): caller state (a filled form, a selection) is cleared by the
 * CALLER and only when this resolves `true`. An approval can be denied or
 * time out, and retyping a whole job is not an acceptable outcome — in some
 * cases the input can't be reconstructed at all.
 *
 * `toastFn(message, kind, ms)` is injected (public/v2/ui.js's `toast`) rather
 * than imported, so this module has no DOM dependency and stays testable by
 * source inspection alone, same as public/auth.js's real DOM dependency on
 * `#toasts` was avoided here on purpose.
 */
export async function guardedSubmit(el, fn, toastFn) {
  const busyTarget = el?.querySelector?.('[type=submit], .btn--primary') ?? el;
  const prev = busyTarget?.textContent;
  if (busyTarget) {
    busyTarget.disabled = true;
    // An approval holds the request open for up to 3 minutes; without this the
    // UI looks hung and the user clicks again.
    busyTarget.textContent = 'waiting for your approval…';
  }
  try {
    await fn();
    return true;
  } catch (err) {
    const msg = failureToast(err);
    if (msg && toastFn) toastFn(msg, err.code ? 'err' : 'err', FAILURE_COPY[err.code] ? 8000 : 3500);
    return false;
  } finally {
    if (busyTarget) {
      busyTarget.disabled = false;
      busyTarget.textContent = prev;
    }
  }
}
