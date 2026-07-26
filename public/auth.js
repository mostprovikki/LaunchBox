// The one place the token, the failure vocabulary and the "don't lose the user's
// work" rule live. Pages do not import this directly for ordinary calls —
// util.js's api() does, so every page inherits it by doing nothing.
//
// util.js imports from here while this imports `$`/`toast` back from util.js.
// That cycle is deliberate and safe only because every use is at call time; keep
// this module free of top-level code that reaches into util.js.
import { $, toast } from './util.js';

// localStorage, not a cookie: the server compares a bearer header, so the token
// must be readable by JS to be attached — and a cookie would be sent by any
// page on 127.0.0.1, which is a wider blast radius than we want.
const KEY = 'cs.token';

// Delivered by `claude-scheduler open` as a URL fragment. Captured once and
// stripped, so a copied URL does not carry the key.
function captureFromFragment() {
  const m = /(?:^|[#&])token=([0-9a-f]{64})/.exec(location.hash || '');
  if (!m) return;
  localStorage.setItem(KEY, m[1]);
  history.replaceState(null, '', location.pathname + location.search);
}

export function getToken() {
  captureFromFragment();
  return localStorage.getItem(KEY);
}

export const authHeaders = () => {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
};

// Every user-visible reason lives here so two pages cannot word the same
// failure differently.
export const FAILURE_COPY = {
  token_invalid: 'This session key is no longer valid. Stop the scheduler, start it again, then reopen with: claude-scheduler open',
  approval_denied: 'You denied the approval — nothing was saved. Press Submit again to retry.',
  approval_timeout: 'The approval request timed out — nothing was saved. Press Submit again to retry.',
  approval_unavailable: 'The approval helper is unavailable, so this was refused. Reinstall to rebuild it.',
  approval_busy: 'Another approval is already waiting. Finish that one, then try again.',
};

// Persistent, not a toast: an invalid key names an action the user has to take at
// a terminal, which is not something to read in 3.5 seconds. Tolerates a missing
// element — this module ships before the markup does.
export function showTokenBanner(message) {
  const el = $('#auth-banner');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

export function explainFailure(err) {
  const code = err?.data?.code;
  if (code === 'token_invalid') return showTokenBanner(FAILURE_COPY.token_invalid);
  const copy = FAILURE_COPY[code];
  toast(copy ?? (err?.data?.errors || [err?.data?.error || 'that failed']).join(' · '), 'err', copy ? 8000 : 3500);
}

/**
 * Wrap any mutating submit. The contract: caller state (a filled form, a
 * selection) is cleared by the CALLER and only when this resolves true. An
 * approval can be denied or time out, and retyping the whole job is not an
 * acceptable outcome — in some cases the input cannot be reconstructed at all.
 */
export async function guardedSubmit(el, fn) {
  const busyTarget = el?.querySelector?.('[type=submit], .primary') ?? el;
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
    explainFailure(err);
    return false;
  } finally {
    if (busyTarget) {
      busyTarget.disabled = false;
      busyTarget.textContent = prev;
    }
  }
}
