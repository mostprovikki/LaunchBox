// /v2 page-shell + a11y helpers. Small and obvious on purpose — nine wave-2/3
// agents read this file's exports as the contract. See public/v2/README.md.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * Element builder. `class`/`html` are special-cased; `on*` handlers attach a
 * listener instead of an attribute; `true`/`false`/`null`/`undefined` values
 * toggle a boolean attribute (or skip it) rather than stringifying to
 * "true"/"false"/"null". Children may be strings, nodes, or nested arrays.
 *
 * `html` is the caller's responsibility to sanitise (esc() above, or nothing
 * if the string is a literal SVG you wrote) — never interpolate untrusted
 * data into it.
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  const flat = Array.isArray(children) ? children.flat(Infinity) : [children];
  for (const c of flat) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node?.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * REVIEW #5 — the a11y contract. Build every icon-only button through this,
 * never a bare `el('button', {class:'iconbtn'})`: a missing `label` throws at
 * build time instead of shipping a button assistive tech can't name.
 *
 * `tip` defaults to `label` (the visible data-tip tooltip and the accessible
 * name say the same thing, per the mockups' iconbtn convention) — pass `tip`
 * explicitly only when they should genuinely differ.
 *
 * The CSS half is already done (launchbox.css:42 `[data-tip]:focus-visible`);
 * this is the other half — the tooltip text has to actually be attached to
 * something a screen reader announces, which `aria-label` is and a
 * CSS `content: attr(data-tip)` pseudo-element is not.
 */
export function iconBtn({ label, tip, cls = '', tag = 'button', href, svgHtml, ...rest }) {
  if (!label) throw new Error('iconBtn(): aria-label is required (REVIEW #5) — every iconbtn must be reachable by assistive tech');
  const attrs = {
    ...rest,
    class: `iconbtn ${cls}`.trim(),
    'aria-label': label,
    'data-tip': tip ?? label,
  };
  if (tag === 'a') attrs.href = href ?? '#';
  const node = el(tag, attrs);
  if (svgHtml) node.innerHTML = svgHtml;
  return node;
}

/**
 * REVIEW #2 — the disable-with-reason contract. Every mutating control
 * (button/a/select/segmented seg) that must go dead under daemon-unreachable
 * or token-invalid calls this — never ad-hoc `el.disabled = true`. A dead
 * button that explains itself beats a live one that lies.
 *
 * `reason` falsy re-enables and restores whatever data-tip the control had
 * before it was disabled (its own real tooltip, e.g. "Open log") — so
 * re-enabling never silently drops a control's normal tooltip.
 *
 * Relies on launchbox.css:54 `[data-tip]:disabled { pointer-events: auto }` —
 * do not wrap this in an extra element to "fix" hover; that rule is exactly
 * what makes the tooltip show on a disabled native control.
 */
export function setDisabledReason(elm, reason) {
  if (!elm) return;
  if (reason) {
    if (elm.dataset.lbTipSaved === undefined) {
      elm.dataset.lbTipSaved = elm.getAttribute('data-tip') ?? '';
    }
    elm.disabled = true;
    if (elm.getAttribute('aria-selected') != null) elm.setAttribute('aria-disabled', 'true');
    elm.setAttribute('data-tip', reason);
  } else {
    elm.disabled = false;
    elm.removeAttribute('aria-disabled');
    const saved = elm.dataset.lbTipSaved;
    if (saved) elm.setAttribute('data-tip', saved);
    else elm.removeAttribute('data-tip');
    delete elm.dataset.lbTipSaved;
  }
}

/**
 * Batch form of setDisabledReason(): every element under `root` carrying
 * `data-mutating` (a page's own convention for "this control writes state")
 * gets disabled/re-enabled together. Pages opt controls in by adding the
 * attribute; nothing is swept up implicitly.
 */
export function disableMutatingControls(root, reason) {
  for (const elm of $$('[data-mutating]', root)) setDisabledReason(elm, reason);
}

// ---------------- page shell ----------------

/** `<div class="pagehead">` — title, optional subline, right-aligned actions. */
export function pageHead({ title, sub, actions = [] }) {
  return el('div', { class: 'pagehead' }, [
    el('div', {}, [el('h1', {}, title), sub != null ? el('div', { class: 'pagehead__sub' }, sub) : null]),
    actions.length ? el('div', { class: 'pagehead__actions' }, actions) : null,
  ]);
}

const pad2 = (n) => String(n).padStart(2, '0');

/** "as of HH:MM:SS" — REVIEW #8's per-card stale stamp, one place so the format can't drift card to card. */
export function asOfText(date = new Date()) {
  return `as of ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** `<span class="asof">as of HH:MM:SS</span>` for a card__head, per REVIEW #8. */
export function asOfEl(date) {
  return el('span', { class: 'asof' }, asOfText(date));
}

// ---------------- toast ----------------
// system.css/launchbox.css (byte-identical copies of the audited spec — do not
// edit) ship no .toast rule; the mockups use inline appbanner/dim states for
// errors instead of toasts. This is a minimal, theme-aware fallback built from
// the same design tokens (var(--surface)/var(--ink)/var(--bad)/var(--ok)) so a
// page has somewhere to put a transient failure message without a new
// stylesheet rule. If wave-2 pages find they need real toast styling,
// report it — don't hand-roll a second version of this.
let toastHost = null;
export function toast(msg, kind = '', ms = 3500) {
  if (!toastHost) {
    toastHost = el('div', {
      id: 'v2-toasts',
      style: 'position:fixed;right:16px;bottom:16px;z-index:80;display:flex;flex-direction:column;gap:8px;max-width:360px;',
    });
    document.body.appendChild(toastHost);
  }
  const color = kind === 'err' ? 'var(--bad)' : kind === 'ok' ? 'var(--ok)' : 'var(--line)';
  const node = el('div', {
    role: 'status',
    style: `background:var(--surface);color:var(--ink);border-left:3px solid ${color};`
      + 'box-shadow:var(--shadow-2);border-radius:var(--r);padding:10px 14px;font:13px/1.4 var(--sans);',
  }, msg);
  toastHost.appendChild(node);
  setTimeout(() => node.remove(), ms);
}
