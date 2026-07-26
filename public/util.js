// Shared front-end primitives. Everything here is used by more than one module
// — app.js, fields.js, usage.js — and nothing here touches app state.

// auth.js imports `$`/`toast` from here while we import from it: a deliberate
// cycle. ES modules tolerate it only because neither side calls the other during
// module evaluation, so nothing below this line may run at load time.
import { authHeaders, showTokenBanner, FAILURE_COPY } from './auth.js';

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => [...document.querySelectorAll(sel)];

// Upgraded in place rather than offered as an opt-in wrapper: every page already
// calls this, so they all inherit the token, the invalid-key banner and the
// failure codes without changing a line — and so will the next page somebody adds.
export const api = async (method, path, body) => {
  const res = await fetch(path, {
    method,
    // The Content-Type is not decoration: the server rejects any mutation that
    // doesn't declare application/json, which is what makes a cross-origin form
    // post impossible.
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
    // Long enough for a 180s Touch ID / password approval to resolve. Without a
    // bound a denied approval that never answers would hang the request forever.
    signal: AbortSignal.timeout(200_000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    // Raised here, once, so no page can forget it: an invalid key needs an action
    // at a terminal, not a toast that vanishes in 3.5 seconds.
    if (res.status === 401 && data?.code === 'token_invalid') showTokenBanner(FAILURE_COPY.token_invalid);
    throw Object.assign(new Error('api error'), { status: res.status, data, code: data?.code });
  }
  return data;
};

export function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function toast(msg, kind = '', ms = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export const apiErr = (e, fallback) => toast((e.data?.errors || [e.data?.error || fallback]).join(' · '), 'err');

export function relTime(iso) {
  if (!iso) return '—';
  const diff = new Date(iso) - Date.now();
  const abs = Math.abs(diff);
  const units = [[86400e3, 'd'], [3600e3, 'h'], [60e3, 'm'], [1e3, 's']];
  for (const [ms, u] of units) {
    if (abs >= ms) {
      const v = Math.round(abs / ms);
      return diff > 0 ? `in ${v}${u}` : `${v}${u} ago`;
    }
  }
  return 'now';
}

// Names the timezone, because `whenText` below deliberately drops it from the
// visible label: a reset six days out is shown as "Sat 11:30 PM", and hover is
// where "GMT+5:30" belongs.
export function fullTime(iso) {
  return iso ? new Date(iso).toLocaleString([], { timeZoneName: 'short' }) : '';
}

const CLOCK = { hour: 'numeric', minute: '2-digit' };
const clock = (d) => d.toLocaleTimeString([], CLOCK);

// A future moment at whatever scale is actually useful, which changes with
// distance. A countdown only answers a question while it's short; past a day what
// you want to know is *when*, so name the day and stop counting.
//
//   past / <1m         now / in under a minute
//   <1h                in 43m
//   <24h               in 3h 20m
//   next calendar day  tomorrow 11:30 PM
//   <7d                Sat 11:30 PM
//   else               Sat 2 Aug, 11:30 PM
//
// Callers pair this with `fullTime` in a title attribute — the exact moment is
// always one hover away, so this is free to be coarse.
export function whenText(iso, now = Date.now()) {
  if (!iso) return '';
  const then = new Date(iso);
  const ms = then - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'now';
  if (ms < 60e3) return 'in under a minute';
  if (ms < 3600e3) return `in ${Math.floor(ms / 60e3)}m`;
  if (ms < 86400e3) {
    // Carry, don't round: `Math.round` on the remainder renders 3h59m40s as
    // "3h 60m", which is what the old usage-strip formatter did.
    const total = Math.floor(ms / 60e3);
    const m = total % 60;
    return m ? `in ${Math.floor(total / 60)}h ${m}m` : `in ${Math.floor(total / 60)}h`;
  }
  // Calendar days apart, not 24h multiples — 11pm to 7am is "tomorrow", and a
  // 26-hour gap can span one calendar day or two depending on when it starts.
  const days = dayDelta(new Date(now), then);
  if (days === 1) return `tomorrow ${clock(then)}`;
  if (days < 7) return `${then.toLocaleDateString([], { weekday: 'short' })} ${clock(then)}`;
  return `${then.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${clock(then)}`;
}

// Whole days between two local calendar dates, ignoring the clock. Built from
// y/m/d rather than dividing a ms difference so a DST shift can't make two
// consecutive days read as 0 or 2 apart.
function dayDelta(a, b) {
  const midnight = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((midnight(b) - midnight(a)) / 86400e3);
}

export function duration(ms) {
  if (ms == null) return '';
  if (ms < 60e3) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms / 60e3) + 'm ' + Math.round((ms % 60e3) / 1000) + 's';
}
