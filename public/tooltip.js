// One themed tooltip for the whole app: `data-tip="a full sentence"` on any
// element, anywhere. A single element (`#tooltip`) plus delegated listeners,
// rather than one tooltip node and one pair of listeners per element —
// load-bearing here specifically because the Sessions tab's cards (and the
// Projects list before it, WIP.md:101) re-render wholesale on a timer, so
// per-node listeners would be re-attached, and leaked, every tick.
//
// Keyboard focus shows it too (focusin/focusout), not just mouseover/mouseout
// — a `data-tip` button reachable only by hover is not reachable by keyboard.
//
// Styling lives in style.css and uses the Sessions-tab token block
// (--card/--border-2/--text-2/--shadow-2/--radius-sm/--ease), never a
// hardcoded colour — the upstream tooltip this is adapted from hardcodes
// `background:#FFFFFF`, which is why it stays a white card in dark mode.

let tipEl = null;

function tooltipEl() {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.id = 'tooltip';
  tipEl.hidden = true;
  tipEl.setAttribute('role', 'tooltip');
  document.body.appendChild(tipEl);
  return tipEl;
}

function place(target, el) {
  const r = target.getBoundingClientRect();
  // Measure after making it visible-but-transparent would require an extra
  // frame; instead measure post-hidden-toggle, which the caller already did.
  const tr = el.getBoundingClientRect();
  let top = r.top - tr.height - 8;
  let left = r.left + r.width / 2 - tr.width / 2;
  if (top < 4) top = r.bottom + 8; // flip below when it would clip the viewport top
  left = Math.max(4, Math.min(left, window.innerWidth - tr.width - 4));
  el.style.top = `${Math.round(top + window.scrollY)}px`;
  el.style.left = `${Math.round(left + window.scrollX)}px`;
}

function findTarget(ev) {
  return ev.target?.closest?.('[data-tip]') ?? null;
}

function show(target) {
  const text = target.getAttribute('data-tip');
  if (!text) return;
  const el = tooltipEl();
  el.textContent = text;
  el.hidden = false;
  place(target, el);
}

function hide() {
  if (tipEl) tipEl.hidden = true;
}

document.addEventListener('mouseover', (ev) => { const t = findTarget(ev); if (t) show(t); });
document.addEventListener('mouseout', (ev) => { if (findTarget(ev)) hide(); });
document.addEventListener('focusin', (ev) => { const t = findTarget(ev); if (t) show(t); });
document.addEventListener('focusout', (ev) => { if (findTarget(ev)) hide(); });
// A tooltip pinned to a hover position must not survive a scroll — it would
// drift from the element it was pointing at.
window.addEventListener('scroll', hide, true);
