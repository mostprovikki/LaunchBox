// /v2 appbar + degraded-state banner. Mounted once by main.js. Real daemon
// data via api.js — nav, usage chips, running chip, pause segs, theme toggle,
// plus the banner slot (#v2-banner) shared between the pause-mode banners and
// the daemon-unreachable/token-invalid degraded state (REVIEW #2).
//
// Class names below match the mockups exactly (redesign/overview.html et al)
// — wave-2 agents and the E1 QA gate key off them; do not rename.

import {
  api, onAuthState, getAuthState, FAILURE_COPY, failureToast, degradedReason,
} from './api.js';
import { el, iconBtn, setDisabledReason, toast } from './ui.js';

const NAV = [
  ['overview', 'Overview'],
  ['jobs', 'Jobs'],
  ['runs', 'Runs'],
  ['projects', 'Projects'],
  ['sessions', 'Sessions'],
  ['settings', 'Settings'],
];

const PAUSE_SEGS = [
  ['off', 'Off'],
  ['hold', 'Hold'],
  ['soft', 'Soft'],
  ['hard', 'Hard'],
];

// Copy verbatim from the reviewed mockups (redesign/pause-{hold,soft,hard}.html)
// — REVIEW.md's adopted recommendations, not re-worded here. `stopping` is the
// live count from /api/pause's own `stopping` array; the mockups' "2 live
// runs"/"2 runs were recorded as killed" phrasing is reproduced with the real
// number rather than a hardcoded 2.
const PAUSE_BANNER = {
  hold: () => ({
    cls: 'appbanner--muted',
    pill: 'pill--1',
    pillText: 'HOLD',
    text: 'Hold. Scheduled fires are dropped and recorded as skipped with this reason. '
      + 'Runs already in flight continue, and manual "Run now" still works. '
      + 'Scheduling resumes the moment you switch back to Off.',
  }),
  soft: (p) => ({
    cls: 'appbanner--warn',
    pill: 'pill--2',
    pillText: 'SOFT',
    text: 'Soft drain. Nothing new starts — scheduled or manual. '
      + `${p.stopping?.length ?? 0} live run(s) were sent SIGINT and get a grace window to finish their step; `
      + 'they will be recorded as stopped, not failed.',
  }),
  hard: () => ({
    cls: 'appbanner--bad',
    pill: 'pill--4',
    pillText: 'HARD',
    text: 'Hard stop. Everything in flight was killed with SIGKILL — including manual runs, with no cleanup. '
      + 'Nothing will start, scheduled or manual, until you leave Hard.',
  }),
};

// ------------------------------------------------------------- keep awake
// claude-scheduler-btv.16. OWNER DECISION 2026-09-23: the keep-awake
// capability is KEPT in the redesign, so /v2 grows the control the existing UI
// has at public/index.html:23-33 / public/app.js:289-303. The server half
// (server.js's GET+PUT /api/awake, lib/awake.js) is untouched — this is a
// UI-only gap being closed.
//
// The modes mirror the old menu EXACTLY (off / auto / timed 30m,1h,4h,8h / on):
// a redesign that silently drops one of them is the capability loss the parity
// gate exists to catch.
export const AWAKE_CHOICES = Object.freeze([
  { mode: 'off', label: 'Off — allow sleep' },
  { mode: 'auto', label: 'While jobs are scheduled' },
  { mode: 'timed', minutes: 30, label: 'For 30 minutes' },
  { mode: 'timed', minutes: 60, label: 'For 1 hour' },
  { mode: 'timed', minutes: 240, label: 'For 4 hours' },
  { mode: 'timed', minutes: 480, label: 'For 8 hours' },
  { mode: 'on', label: 'Indefinitely' },
]);

const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?');

/**
 * The appbar label, and whether the Mac is ACTUALLY being held awake right
 * now. Ported from public/app.js's awakeLabel() rather than re-invented: the
 * distinction between "auto is selected" and "auto is currently holding" is
 * the whole point of the `active` flag lib/awake.js returns.
 */
export function awakeLabel(a) {
  if (!a || a.mode === 'off') return { text: 'sleep ok', on: false };
  if (a.mode === 'on') return { text: 'awake', on: true };
  if (a.mode === 'timed') return { text: `awake until ${hhmm(a.until)}`, on: !!a.active };
  return { text: a.active ? 'auto · awake' : 'auto', on: !!a.active }; // auto
}

/** Confirmation copy, one per served mode — same wording as the old UI's toast. */
export function awakeToast(a) {
  return {
    off: 'Mac may sleep normally',
    auto: 'Staying awake while jobs are scheduled',
    timed: `Staying awake until ${hhmm(a?.until)}`,
    on: 'Staying awake indefinitely',
  }[a?.mode] ?? 'Keep-awake updated';
}

/** True when this choice is the one the daemon is currently serving. */
export function isCurrentChoice(choice, a) {
  const mode = a?.mode ?? 'off';
  if (choice.mode !== mode) return false;
  // Every timed preset highlights: the served state is a deadline, not the
  // preset that produced it, so claiming "30 minutes" is the live one would be
  // a guess. Same compromise the old UI made, kept deliberately.
  return true;
}

const SVG_COFFEE = '<svg class="ic ic--s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 8h1a4 4 0 0 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><path d="M6 2v3M10 2v3M14 2v3"/></svg>';
const SVG_X = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

const AWAKE_TIP = 'Keep this Mac awake so schedules fire';

// `<svg>` written as markup has to go through the HTML parser to land in the
// SVG namespace — the same helper pages/plan-dialogs.js uses, for the same
// reason (document.createElement('svg') would render nothing).
function svgNode(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

let pauseState = null;
let usageState = null;
let runningCount = 0;
let awakeState = null;
// The daemon can be built without a keep-awake controller (server.js answers
// 501 then). Showing a live control that can only fail is the "dead button
// that lies" this codebase keeps refusing to ship, so it is left out entirely.
let awakeUnsupported = false;
let pollTimer = null;

export function mountNav() {
  const nav = document.getElementById('v2-nav');
  if (!nav) return;
  nav.innerHTML = '';
  for (const [route, label] of NAV) {
    nav.appendChild(el('a', { href: `#${route}`, 'data-route': route }, label));
  }
}

function usageChips(u) {
  const crit = (pct) => typeof pct === 'number' && pct >= (u?.critPct ?? 85);
  if (!u || u.ok === null) return [{ k: '5h', v: '—' }, { k: 'wk', v: '—' }];
  if (u.buckets?.length) {
    return u.buckets.map((b) => ({
      k: b.scopeModel ?? (b.group === 'weekly' ? 'wk' : (b.kind === 'session' ? '5h' : String(b.kind ?? '?'))),
      v: typeof b.percent === 'number' ? `${b.percent}%` : '—',
      crit: crit(b.percent) || b.severity === 'critical',
    }));
  }
  const WL = { five_hour: '5h', seven_day: 'wk' };
  return Object.entries(u.windows ?? {})
    .filter(([, w]) => typeof w?.percent === 'number')
    .map(([k, w]) => ({ k: WL[k] ?? k, v: `${w.percent}%`, crit: crit(w.percent) }));
}

function fmtTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

async function setPauseMode(mode, toastFn) {
  try {
    pauseState = await api('PUT', '/api/pause', { mode });
    renderChips();
    renderBanner();
  } catch (err) {
    toastFn?.(FAILURE_COPY[err.code] ?? err.message ?? 'could not change pause mode', 'err');
  }
}

async function setAwakeMode(choice, close) {
  try {
    awakeState = await api('PUT', '/api/awake', { mode: choice.mode, minutes: choice.minutes });
    renderChips();
    toast(awakeToast(awakeState), 'ok');
    close();
  } catch (err) {
    // Left OPEN on failure: the reader's choice is still on screen to retry.
    // failureToast() returns null for the two states that already own a
    // persistent banner, so this never piles a toast on top of one.
    const msg = failureToast(err);
    if (msg) toast(msg, 'err');
  }
}

/**
 * The mode picker. Built on the SAME overlay pattern the job and planner
 * dialogs use (`.modalwrap` > `.modal[role=dialog]`) rather than a new
 * appbar-only popover: that pattern is already audited, already carries the
 * Escape/backdrop/close-button contract E2's dialog gate measures, and adding
 * a second overlay vocabulary for one control is exactly the drift the
 * redesign is trying to end. No mockup draws this control, so nothing here is
 * pinned by redesign/*.html — every class and token is an existing one.
 */
export function openAwakeMenu() {
  if (document.querySelector('.modalwrap[data-awake]')) return null;

  const closeBtn = iconBtn({ label: 'Close without changing anything', svgHtml: SVG_X, style: 'margin-left:auto;' });
  closeBtn.type = 'button';

  const choices = el('div', { class: 'stack' });
  const body = el('div', { class: 'modal__body' }, choices);
  const modal = el('div', {
    class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keep Mac awake',
  }, [
    el('div', { class: 'modal__head' }, [el('h2', {}, 'Keep Mac awake'), closeBtn]),
    body,
    el('div', { class: 'modal__foot' }, el('span', { class: 'modal__consequence' }, [
      'The daemon holds the Mac awake with ', el('b', {}, 'caffeinate'),
      ' and releases it the moment the daemon stops. The display is never kept on.',
    ])),
  ]);
  const wrap = el('div', { class: 'modalwrap', role: 'presentation', 'data-awake': 'true' }, modal);

  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };

  for (const choice of AWAKE_CHOICES) {
    const current = isCurrentChoice(choice, awakeState);
    const btn = el('button', {
      type: 'button',
      class: current ? 'btn btn--primary' : 'btn',
      style: 'justify-content:flex-start;',
      'aria-pressed': current ? 'true' : 'false',
      'data-mutating': true,
      'data-awake-mode': choice.mode,
      'data-awake-minutes': choice.minutes != null ? String(choice.minutes) : null,
    }, choice.label);
    btn.addEventListener('click', () => setAwakeMode(choice, close));
    choices.appendChild(btn);
  }

  document.body.appendChild(wrap);
  document.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click', close);
  wrap.addEventListener('click', (ev) => { if (ev.target === wrap) close(); });

  // Focus moves to the CLOSE button, not the first choice: every choice here
  // writes state, and landing a keyboard user on a live mutating control is
  // how a stray Enter changes the machine's sleep behaviour. The way out is
  // also the one control that certainly exists (plan-dialogs.js's rule).
  closeBtn.focus();
  return { wrap, close };
}

function awakeChip() {
  if (awakeUnsupported) return null;
  const { text, on } = awakeLabel(awakeState);
  return el('button', {
    type: 'button',
    id: 'v2-awake',
    class: 'runchip',
    'aria-haspopup': 'dialog',
    'aria-label': `Keep Mac awake — ${text}`,
    // A plain <button> on purpose: `::after` (which is what paints a data-tip)
    // does not render on a replaced element, so a select/input here would ship
    // a tooltip nobody can ever see — the defect E2 found on the enable switch.
    'data-tip': AWAKE_TIP,
    // The WHOLE contract (README.md): main.js's central sweep disables and
    // explains this under daemon-unreachable / token-invalid. No per-control
    // disable logic here — that is the guarantee, not an instance of it.
    'data-mutating': true,
    onclick: () => openAwakeMenu(),
  }, [
    svgNode(SVG_COFFEE),
    el('span', {}, text),
    on ? el('span', { class: 'state__dot' }) : null,
  ]);
}

function renderChips() {
  const host = document.getElementById('v2-chips');
  if (!host) return;
  // index.html (A1) wraps the chips slot in a bare `<div id="v2-chips">` so it
  // has something to target; the mockups have uchips/runchip/segs as direct
  // flex-item siblings of .appbar itself (system.css's `.appbar { gap: 16px }`
  // relies on that flatness). Without this, the wrapper's children stack as
  // ordinary block content and blow out the fixed-height appbar — measured:
  // the usage chips rendered as a second row clipped above the viewport.
  // `display: contents` (set here, not in the frozen CSS files) makes the
  // wrapper's own box disappear so its children become real appbar flex
  // items, matching the mockup layout exactly.
  host.style.display = 'contents';
  host.innerHTML = '';

  const checked = fmtTime(usageState?.checkedAt);
  const uchips = el('div', {
    class: 'uchips',
    'data-tip': checked ? `Claude usage — checked ${checked}` : 'Claude usage — not yet checked',
  }, usageChips(usageState).map((b) => el('span', { class: b.crit ? 'uchip uchip--crit' : 'uchip' }, [
    el('span', { class: 'uchip__k' }, b.k),
    el('span', { class: 'uchip__v' }, b.v),
  ])));
  host.appendChild(uchips);

  host.appendChild(el('a', { class: 'runchip', href: '#runs' }, [
    el('span', { class: 'state__dot' }),
    el('span', { class: 'num' }, String(runningCount)),
    ' running',
  ]));

  // Keep-awake sits between the running chip and the pause segs, the same
  // order the existing UI uses (public/index.html:20-33).
  const awake = awakeChip();
  if (awake) host.appendChild(awake);

  const reason = degradedReason();
  const segsAttrs = { class: 'segs segs--bar', role: 'radiogroup', 'aria-label': 'Pause mode' };
  if (reason) segsAttrs['data-tip'] = reason;
  const segs = el('div', segsAttrs);
  for (const [mode, label] of PAUSE_SEGS) {
    const attrs = { class: 'seg' };
    if (pauseState?.mode === mode) attrs['aria-selected'] = 'true';
    const btn = el('button', attrs, label);
    btn.addEventListener('click', () => setPauseMode(mode));
    setDisabledReason(btn, reason);
    segs.appendChild(btn);
  }
  host.appendChild(segs);
}

function renderBanner() {
  const banner = document.getElementById('v2-banner');
  if (!banner) return;
  const reason = getAuthState();

  if (reason === 'unreachable') {
    banner.className = 'appbanner appbanner--bad';
    banner.innerHTML = '';
    banner.appendChild(el('span', {}, [
      el('b', {}, 'Daemon unreachable.'),
      ' Requests are failing; retrying automatically. Check: ',
      el('span', { class: 'mono' }, 'launchctl list | grep claude-scheduler'),
    ]));
    banner.hidden = false;
    return;
  }
  if (reason === 'token_invalid') {
    banner.className = 'appbanner appbanner--bad';
    banner.innerHTML = '';
    banner.appendChild(el('span', {}, [
      el('b', {}, 'This page can no longer talk to the daemon — its session token was rejected.'),
      ' That happens after the daemon restarts or the token is rotated. Buttons will fail until you reopen. In a terminal: ',
      el('span', { class: 'mono' }, 'claude-scheduler open'),
    ]));
    banner.hidden = false;
    return;
  }

  const mode = pauseState?.mode;
  if (mode && mode !== 'off' && PAUSE_BANNER[mode]) {
    const b = PAUSE_BANNER[mode](pauseState ?? {});
    banner.className = `appbanner ${b.cls}`;
    banner.innerHTML = '';
    banner.appendChild(el('span', {}, b.text));
    banner.appendChild(el('span', { class: 'appbanner__act' }, el('span', { class: `pill ${b.pill}` }, b.pillText)));
    banner.hidden = false;
    return;
  }

  banner.hidden = true;
}

async function poll() {
  const [usage, pause, runs, awake] = await Promise.allSettled([
    api('GET', '/api/usage'),
    api('GET', '/api/pause'),
    api('GET', '/api/runs?limit=100'),
    api('GET', '/api/awake'),
  ]);
  if (usage.status === 'fulfilled') usageState = usage.value;
  if (pause.status === 'fulfilled') pauseState = pause.value;
  if (awake.status === 'fulfilled') {
    awakeState = awake.value;
    awakeUnsupported = false;
  } else if (awake.reason?.status === 501) {
    // Not a transport failure — this daemon genuinely has no keep-awake
    // controller, and the chip is dropped rather than left to fail on click.
    awakeUnsupported = true;
  }
  if (runs.status === 'fulfilled') {
    runningCount = (runs.value?.runs ?? []).filter((r) => ['running', 'queued'].includes(r.status)).length;
  }
  renderChips();
  renderBanner();
}

/** Mount the appbar chrome and start polling. Call once from main.js. */
export function mountChrome() {
  mountNav();
  renderChips(); // pre-fetch shape: chips show '—', 0 running, no seg selected — never a blank appbar
  onAuthState(() => { renderChips(); renderBanner(); });
  poll();
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, 15_000);
}
