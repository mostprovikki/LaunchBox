// Shared front-end primitives. Everything here is used by more than one module
// — app.js, fields.js, usage.js — and nothing here touches app state.

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => [...document.querySelectorAll(sel)];

export const api = async (method, path, body) => {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw Object.assign(new Error('api error'), { status: res.status, data });
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

export function fullTime(iso) {
  return iso ? new Date(iso).toLocaleString() : '';
}

export function duration(ms) {
  if (ms == null) return '';
  if (ms < 60e3) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms / 60e3) + 'm ' + Math.round((ms % 60e3) / 1000) + 's';
}
