// /v2 appbar + degraded-state banner. Mounted once by main.js. Real daemon
// data via api.js — nav, usage chips, running chip, pause segs, theme toggle,
// plus the banner slot (#v2-banner) shared between the pause-mode banners and
// the daemon-unreachable/token-invalid degraded state (REVIEW #2).
//
// Class names below match the mockups exactly (redesign/overview.html et al)
// — wave-2 agents and the E1 QA gate key off them; do not rename.

import {
  api, onAuthState, getAuthState, FAILURE_COPY, degradedReason,
} from './api.js';
import { el, setDisabledReason } from './ui.js';

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

let pauseState = null;
let usageState = null;
let runningCount = 0;
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
  const [usage, pause, runs] = await Promise.allSettled([
    api('GET', '/api/usage'),
    api('GET', '/api/pause'),
    api('GET', '/api/runs?limit=100'),
  ]);
  if (usage.status === 'fulfilled') usageState = usage.value;
  if (pause.status === 'fulfilled') pauseState = pause.value;
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
