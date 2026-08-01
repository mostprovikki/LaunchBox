// Pure (DOM-free) helpers for the Overview tab (claude-scheduler-btv.8 / C1).
// Same split jobs-logic.js established: row-grammar/reason-per-state
// decisions live here so they are unit-testable without jsdom; only
// public/v2/pages/overview.js imports this module.
//
// Every shape consumed here is GET /api/v2/overview's real response
// (server.js's "v2: overview" block, pinned by tests/v2-overview.test.js) —
// built by reading that response shape directly, not by guessing one. Two
// prior pages (B1's Jobs) shipped a defect from hand-built fixtures in the
// wrong shape; see this repo's memory note on the same failure mode.
//
// The status->{colour,dot,label} table lives in ../state-vocab.js, never
// re-declared here (tests/frontend-v2-state-vocab.test.js enforces this for
// every page). reasonText()/stopReasonText() (the skip/stop reason decoders)
// and typeBadge() already exist in jobs-logic.js for the exact same
// /api/v2/overview attention shape and job-type badge — reused here rather
// than duplicated, so a future reword of either only has one call site to fix.
import {
  reasonText, stopReasonText, typeBadge, relIn,
} from './jobs-logic.js';
import { ordinal, statusMeta, TODAY_ORDER } from '../state-vocab.js';

const pad2 = (n) => String(n).padStart(2, '0');

// "HH:MM" in local time — same rule jobs-logic.js's fmtClock uses, duplicated
// here (not imported) because it takes an ISO string directly rather than a
// Date, matching how every timestamp arrives from /api/v2/overview.
export function fmtHM(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// "HH:MM:SS" — the headroom card's "checked …" stamp. Distinct wording from
// ui.js's asOfEl()/asOfText() ("as of …", used for the stale-state per-card
// stamps below) — the headroom card always shows its own reading time,
// healthy or not, per redesign/overview.html; asOfEl's "as of" phrasing is
// reserved for the degraded-state case (README.md / REVIEW #8).
export function fmtCheckedAt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return `checked ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// "Sat 1 Aug" / "Sun 02:15" — same day-or-date branch runs-format.js's
// fmtWhen draws, reproduced here (not imported) because next24h/beyond entries
// need the weekday form even for a time later TODAY (a 24h-horizon list can
// still be "tomorrow" relative to a fire past midnight), which runs-format's
// version does not distinguish from "today".
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function fmtDayTime(iso, now = Date.now()) {
  if (!iso) return null;
  const d = new Date(iso);
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : `${DOW[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// relIn() ("in 26m" / "in 4h 19m" / "due now") is jobs-logic.js's — reused
// here rather than a second copy (imported above); only the Next-24h list's
// countdown needs it and jobs-logic.js already owns it for the Jobs tab's
// own next-fire countdown.

// "in 2h 06m" — the headroom reset countdown. Distinct padding rule from
// relIn() above (jobs.html's Next-24h list never pads minutes; overview.html's
// meter resets always do — "2h 06m", not "2h 6m") so this is its own function
// rather than a shared one with a flag.
export function relInPadded(iso, now = Date.now()) {
  if (!iso) return null;
  const diff = new Date(iso).getTime() - now;
  if (!Number.isFinite(diff) || diff <= 0) return null;
  const mins = Math.round(diff / 60000);
  const hrs = Math.floor(mins / 60);
  const remM = mins % 60;
  return hrs > 0 ? `${hrs}h ${pad2(remM)}m` : `${remM}m`;
}

// ---- page head ---------------------------------------------------------

const WEEKDAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "Saturday 1 August · 09:41" — redesign/overview.html's pagehead__sub date
// half, day-before-month (not Intl's locale-dependent order) so it matches
// the audited mockup exactly regardless of the browser's locale.
export function fmtHeadDate(now = Date.now()) {
  const d = new Date(now);
  return `${WEEKDAY_FULL[d.getDay()]} ${d.getDate()} ${MONTH_FULL[d.getMonth()]} · ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// The connectivity half of the pagehead__sub line. `authState` is api.js's
// getAuthState() value (null | 'unreachable' | 'token_invalid') — the three
// wordings match redesign/overview.html, overview-unreachable.html and
// auth-invalid.html verbatim; 'hold since 09:12'-style timestamps are NOT
// reproduced here because lib/pause.js's status() carries no pause-start
// time (only an optional expiry `until`) — inventing one would be exactly the
// kind of unsupported mockup detail this task's brief calls out to drop.
export function connectivityPhrase(authState, pauseMode) {
  const base = authState === 'unreachable' ? 'daemon unreachable'
    : authState === 'token_invalid' ? 'showing the last state this page received'
      : 'daemon healthy';
  if (pauseMode && pauseMode !== 'off') return `${base} · ${pauseModeLabel(pauseMode)} is on`;
  return base;
}

// ---- headroom -------------------------------------------------------------

// A named window (five_hour/seven_day) carries its own warnPct/critPct but no
// severity field — modelWindows (buckets) carry `severity` instead but no
// thresholds. Two small functions rather than one "guess which shape" one.
export function windowMeterClass(w) {
  if (!w || w.unknown || typeof w.percent !== 'number') return null;
  if (w.percent >= w.critPct) return 'crit';
  if (w.percent >= w.warnPct) return 'warn';
  return '';
}
export function bucketMeterClass(severity) {
  if (severity === 'critical') return 'crit';
  if (severity === 'warning') return 'warn';
  return '';
}

// "resets 11:47 · in 2h 06m" (five_hour — the reset is imminent enough that a
// countdown is useful) vs "resets Wed 09:17" (seven_day and model buckets —
// day-scale resets, per redesign/overview.html; the mockup never shows a
// countdown for these).
export function fmtResetLine(resetsAt, { relative = false, now = Date.now() } = {}) {
  if (!resetsAt) return 'resets —';
  if (relative) {
    const rel = relInPadded(resetsAt, now);
    return rel ? `resets ${fmtHM(resetsAt)} · in ${rel}` : `resets ${fmtHM(resetsAt)}`;
  }
  return `resets ${fmtDayTime(resetsAt, now)}`;
}

// A model-scoped bucket has no fixed display name in the payload — build one
// from what it does carry. Only "scopeModel · week"/"scopeModel · 5h" are
// derivable; anything else falls back to the raw kind/group rather than
// guessing a nicer label the data doesn't back.
export function modelWindowLabel(w) {
  const scope = w?.scopeModel ?? w?.kind ?? 'model';
  const span = w?.group === 'weekly' ? 'week' : w?.kind === 'session' ? '5h' : (w?.group ?? w?.kind ?? '');
  return span ? `${scope} · ${span}` : scope;
}

// "Budget guard is on — scheduled fires stop at 80% of the 5-hour window and
// 95% of the week" / "Budget guard is off — <why>" — guard.why is always
// populated (server.js never omits it, even for the enforcing case) so the
// fail-open reason is never silently dropped when the guard IS off.
export function guardSummary(guard) {
  if (!guard) return '';
  if (!guard.enforcing) return `Budget guard is off — ${guard.why ?? 'not enforcing'}`;
  return `Budget guard is on — scheduled fires stop at ${guard.reserveFiveHourPct}% of the 5-hour window `
    + `and ${guard.reserveWeeklyPct}% of the week`;
}

// One line per model bucket past its OWN reported severity of 'critical' —
// never a fixed "85%" (modelWindows carries no threshold field, only
// `severity`, so a literal critical-percent number would be invented).
export function criticalModelNotes(modelWindows = [], now = Date.now()) {
  return modelWindows
    .filter((w) => w.severity === 'critical' && typeof w.percent === 'number')
    .map((w) => {
      const label = modelWindowLabel(w);
      const until = w.resetsAt ? ` until it resets ${fmtDayTime(w.resetsAt, now)}` : '';
      return `${label} is past critical (${w.percent}%) — jobs pinned to it will be skipped by the guard${until}. Jobs on other models are unaffected.`;
    });
}

// ---- needs attention --------------------------------------------------------

// One prose line per attention item, matching the "every state carries its
// reason inline" property REVIEW.md calls the design's best (README.md /
// jobs-logic.js's reasonText/stopReasonText do the same decoding for Jobs;
// reused here rather than re-worded for Overview).
export function attentionLine(item) {
  const at = fmtHM(item.occurredAt);
  switch (item.kind) {
    case 'timeout': {
      const { timeoutMin, streak } = item.reason ?? {};
      let s = `Hit its ${timeoutMin ?? '?'}m limit at ${at ?? '?'} — SIGTERM sent.`;
      if (Number.isFinite(streak) && streak > 1) s += ` The last ${streak} runs all timed out (${ordinal(streak)} in a row).`;
      return s;
    }
    case 'skipped':
      return `Skipped at ${at ?? '?'}: ${reasonText(item.reason) ?? item.reason?.message ?? 'a guard blocked it'}.`;
    case 'killed':
      // No meta reason exists for a manual kill vs. a hard-pause killAll
      // (lib/runner.js records none) — never claim a specific cause here,
      // same rule jobs-logic.js's killed branch already follows. That applies
      // to the SIGNAL too, which an earlier version of this line still
      // asserted: kill() sends SIGTERM first and only escalates to SIGKILL
      // after KILL_GRACE_MS, and a queued run is dequeued with no signal at
      // all — so neither "SIGKILL" nor "no cleanup ran" is knowable here.
      return `Killed at ${at ?? '?'} — stopped immediately.`;
    case 'stopped':
      return `Asked to wind down at ${at ?? '?'} (${stopReasonText(item.reason) ?? 'stop requested'}).`;
    case 'project_issue': {
      const r = item.reason ?? {};
      if (r.code === 'project_error') return r.lastError ? `Polling failed: ${r.lastError}` : 'This project is in an error state.';
      if (r.code === 'bd_busy') return `Beads database locked by another process — polling is paused, not broken (${r.busyStreak} consecutive poll${r.busyStreak === 1 ? '' : 's'}).`;
      return (r.warnings ?? []).join('; ') || 'This project needs attention.';
    }
    default:
      return item.reason?.message ?? '';
  }
}

// Which link(s) an attention row offers, and where they go — every href is a
// route this bead can actually resolve (Runs/Jobs are real; Projects/#project
// are registered routes even though C2 hasn't built their content yet, same
// as jobs.js already links forward to #projects from its empty state).
export function attentionActions(item) {
  if (item.kind === 'project_issue') return [{ label: 'Open project', href: '#projects' }];
  if (item.kind === 'timeout') {
    return [
      { label: 'Read the log', href: `#runs?job=${encodeURIComponent(item.jobId)}` },
      { label: 'Edit job', href: '#jobs', ghost: true },
    ];
  }
  return [{ label: 'Run history', href: `#runs?job=${encodeURIComponent(item.jobId)}`, ghost: true }];
}

// ---- next 24 hours ----------------------------------------------------------

export function fireTimeParts(entry, now = Date.now()) {
  if (!entry.at) return { time: '—', rel: entry.anchoredToReset ? 'after reset' : 'unknown' };
  const time = entry.anchoredToReset ? `≈${fmtHM(entry.at)}` : fmtDayTime(entry.at, now);
  return { time, rel: relIn(entry.at, now) ?? '' };
}

const PAUSE_MODE_LABEL = { hold: 'Hold', soft: 'Soft drain', hard: 'Hard stop' };
export const pauseModeLabel = (mode) => PAUSE_MODE_LABEL[mode] ?? mode;

// Per-fire admission (REVIEW #1): read straight off the payload's own
// admitted/blockedBy, never re-derived — a fire the server already computed
// as blocked-by-pause or blocked-by-budget says so verbatim.
export function fireAnnotation(entry) {
  if (entry.admitted) return null;
  if (entry.blockedBy?.pause) return `dropped while ${pauseModeLabel(entry.blockedBy.pause.mode)} is on`;
  if (entry.blockedBy?.budget) return `guard will skip it — ${reasonText(entry.blockedBy.budget) ?? 'blocked'}`;
  return 'not admitted';
}

export { typeBadge };

// ---- today / running --------------------------------------------------------

// Order is editorial; the WORDS come from the shared vocabulary. This list
// originally carried its own labels with `fail` spelled "failed" — copied from
// runs.js, which had carried it since B2 and slipped through
// claude-scheduler-bmn because a tuple array is not a keyed table. Both sites
// now derive from statusMeta(), and a test forbids the retyped spelling.
export function todayCounts(today) {
  const by = today?.byStatus ?? {};
  return TODAY_ORDER.filter((k) => by[k]).map((k) => [statusMeta(k).label, by[k]]);
}

// ---- automation / burst -----------------------------------------------------

// lib/db.js's burst row shape (createBurst/activeBurst) — window/budgetPct are
// the plan, currentPct/runs are progress. Kept to fields that row actually
// carries; no invented "stops at N% measured" framing (that phrasing needs a
// confidence band this endpoint does not compute).
export function burstSummary(burst) {
  if (!burst?.active) return 'No burst running.';
  const b = burst.active;
  const projectCount = (b.projectIds ?? []).length;
  return `Burst running on the ${b.window ?? '?'} window — ${b.currentPct ?? '?'}% of a ${b.budgetPct ?? '?'}% budget, `
    + `${b.runs ?? 0} run${b.runs === 1 ? '' : 's'} across ${projectCount} project${projectCount === 1 ? '' : 's'}.`;
}
