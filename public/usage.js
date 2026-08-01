// The usage strip: current 5-hour / weekly / model-scoped utilisation with
// reset countdowns. Read-only — nothing here changes whether a job fires.
//
// Unobtrusive by construction: the container keeps its height whatever state
// the data is in (pending, stale, unavailable), so the page never jumps as
// snapshots arrive, and `off` renders nothing at all.

import { $, esc, relTime, whenText, fullTime } from './util.js';

// Fallbacks only, for the tick that renders before /api/usage lands. The server
// owns both numbers (usageWarnPct / usageCritPct) and these must not disagree
// with its defaults — a strip that recolours a second after load reads as a bug.
const WARN_PCT = 75;
const CRIT_PCT = 85;

// `5h` / `week` / the model's own name — the account's three real limits read
// that way. Anything else falls back to its own key, unprettified rather than
// guessed at.
function bucketLabel(b) {
  if (b.scopeModel) return b.scopeModel;
  if (b.kind === 'session' || b.group === 'session') return '5h';
  if (b.group === 'weekly') return 'week';
  return String(b.kind ?? '?').replace(/_/g, ' ');
}

const WINDOW_LABELS = { five_hour: '5h', seven_day: 'week' };
const windowLabel = (key) => WINDOW_LABELS[key] ?? key.replace(/_/g, ' ');

// The 5-hour window resets in hours, the weekly one in days, so a single unit
// can't serve both — `whenText` picks the scale and this only adds the verb.
const untilText = (iso) => (iso ? `resets ${whenText(iso)}` : '');

// Buckets carry severity and scope, so prefer them; windows are the fallback for
// an account whose payload has no `limits[]`.
function meters(data) {
  if (data.buckets?.length) {
    return data.buckets.map((b) => ({
      label: bucketLabel(b), percent: b.percent, resetsAt: b.resetsAt,
      flagged: b.severity !== 'normal' || b.isActive,
      note: b.severity !== 'normal' ? b.severity : b.isActive ? 'active limit' : '',
    }));
  }
  return Object.entries(data.windows ?? {})
    .filter(([, w]) => typeof w.percent === 'number')
    .map(([k, w]) => ({ label: windowLabel(k), percent: w.percent, resetsAt: w.resetsAt, flagged: false, note: '' }));
}

// Amber past the warn threshold, red past the critical one, and accent for
// anything the API itself flagged — a bucket marked critical or active matters at
// any percent, which is why `flagged` is checked last rather than first.
//
// Both thresholds are settings and the server validates crit > warn, so there is
// no clamping here: an unreachable `warn` band is made impossible upstream
// instead of papered over at render time.
function level(m, t) {
  if (typeof m.percent !== 'number') return '';
  if (m.percent >= t.crit) return 'fail';
  if (m.percent >= t.warn) return 'warn';
  return m.flagged ? 'accent' : '';
}

const meterHtml = (m, t) => {
  const pct = typeof m.percent === 'number' ? Math.max(0, Math.min(100, m.percent)) : 0;
  const title = [m.label, typeof m.percent === 'number' ? `${m.percent}%` : 'unknown', m.note,
    untilText(m.resetsAt), m.resetsAt ? `(${fullTime(m.resetsAt)})` : '']
    .filter(Boolean).join(' · ');
  return `<span class="meter ${level(m, t)}" data-tip="${esc(title)}">
    <span class="m-label">${esc(m.label)}</span>
    <span class="m-bar"><i style="width:${pct}%"></i></span>
    <span class="m-pct">${typeof m.percent === 'number' ? `${m.percent}%` : '—'}</span>
    <span class="m-reset">${esc(untilText(m.resetsAt))}</span>
  </span>`;
};

// One line of prose whenever there are no meters to draw. Never an empty strip:
// "nothing known yet" and "nothing knowable here" are different facts and the
// difference is what the user needs.
function noteFor(data) {
  if (data.available === false) return 'usage unavailable (API-key session)';
  if (data.ok === null) return 'checking usage…';
  return data.error ? 'usage unknown — probe failed' : 'no usage limits reported';
}

const staleTitle = (data) => (data.stale
  ? `stale — last checked ${relTime(data.checkedAt)}${data.error ? `: ${data.error}` : ''}`
  : `updated ${relTime(data.capturedAt)}`);

export function renderUsage(data) {
  const strip = $('#usage-strip');
  const chip = $('#usage-chip');
  if (!strip || !chip) return;

  const mode = data?.display ?? 'banner';
  const t = { warn: data?.warnPct ?? WARN_PCT, crit: data?.critPct ?? CRIT_PCT };
  const list = data ? meters(data) : [];

  strip.hidden = mode !== 'banner';
  chip.hidden = mode !== 'compact' || !list.length;
  if (mode === 'off') { strip.innerHTML = ''; chip.innerHTML = ''; return; }

  if (mode === 'banner') {
    strip.classList.toggle('stale', !!data?.stale);
    if (data) strip.dataset.tip = staleTitle(data); else strip.removeAttribute('data-tip');
    strip.innerHTML = list.length
      ? list.map((m) => meterHtml(m, t)).join('')
      : `<span class="muted">${esc(noteFor(data ?? {}))}</span>`;
    return;
  }

  // Compact: the worst bucket only, with everything else on hover.
  const worst = list.reduce((a, b) => ((b.percent ?? -1) > (a.percent ?? -1) ? b : a), list[0]);
  if (!worst) return;
  chip.className = `pill usage-chip ${level(worst, t)}${data?.stale ? ' stale' : ''}`;
  chip.textContent = `◔ ${worst.label} ${worst.percent}%`;
  chip.dataset.tip = `${list.map((m) => `${m.label} ${m.percent}% · ${untilText(m.resetsAt)}`).join(' · ')} · ${staleTitle(data)}`;
}
