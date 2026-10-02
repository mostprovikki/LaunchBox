// Pure (DOM-free) models for the Overview tab — the Monitor of
// docs/design/launchbox.md §5 (claude-scheduler-btv.21): a status light and
// four cards, no list at rest. Mockup: docs/design/mockups/overview-flavours.html
// Option 2. Only public/v2/pages/overview.js imports this module.
//
// Shapes consumed are the real responses: GET /api/v2/overview (server.js
// "v2: overview"; `spend` from btv.25) and GET /api/v2/inbox (lib/inbox.js,
// btv.22) — read from those, not guessed (see this repo's memory note on
// B1's fixture-shape bug).

const pad2 = (n) => String(n).padStart(2, '0');

// "HH:MM" in local time.
export function fmtHM(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// "HH:MM:SS" — the same format chrome.js's usage-chip tooltip uses for the
// same checkedAt, so the card and the chips show one "as of" (§6).
export function fmtHMS(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// A share of the weekly window. A small non-zero spend reads "<1%", never a
// rounded-down "0%" that would look like nothing was spent; null is unknown.
export function fmtPct(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n > 0 && n < 1) return '<1%';
  return `${Math.round(n)}%`;
}

const PAUSE_MODE_LABEL = { hold: 'Hold', soft: 'Soft drain', hard: 'Hard stop' };
export const pauseModeLabel = (mode) => PAUSE_MODE_LABEL[mode] ?? mode;

// lib/runner.js's DEFAULT_SPAWN_FAULT_COOLDOWN_MS: past this the runner itself
// forgets a spawn fault and retries for real, so an older skip is history.
const SPAWN_FAULT_MEMORY_MS = 5 * 60_000;
const PROJECT_FAULT_RE = /claude is not spawnable \(([^)]+)\)/;
const RUN_FAULT_RE = /^daemon fault: "(.+?)" is not spawnable \(([^)]+)\)/;

// The claude binary cannot be started (claude-scheduler-8ry). Live source: the
// poller's per-project reasons, which read the runner's remembered fault on
// every request. A recent runner skip adds the exact path it tried.
export function daemonFault(data, now = Date.now()) {
  let code = null;
  let cmd = null;
  for (const p of data?.automation?.projects ?? []) {
    for (const r of p.reasons ?? []) {
      const m = PROJECT_FAULT_RE.exec(r);
      if (m) code = m[1];
    }
  }
  for (const item of data?.attention?.items ?? []) {
    if (item.kind !== 'skipped') continue;
    const m = RUN_FAULT_RE.exec(item.reason?.message ?? '');
    if (!m) continue;
    if (now - new Date(item.occurredAt).getTime() > SPAWN_FAULT_MEMORY_MS) continue;
    cmd = m[1];
    code ??= m[2];
  }
  if (!code) return null;
  return { code, cmd, why: `the claude binary cannot be started (${code})` };
}

// ---- status light -----------------------------------------------------------

const weekWindow = (h) => h?.windows?.find((w) => w.key === 'seven_day');
const fiveWindow = (h) => h?.windows?.find((w) => w.key === 'five_hour');
const isLow = (w) => w && !w.unknown && typeof w.percent === 'number' && w.percent >= w.warnPct;

// ok / warn / bad plus the one-line state and why (§5). `needs` is the Inbox
// count, or null when the Inbox could not be read.
export function statusLight({ data, needs, now = Date.now() }) {
  const fault = daemonFault(data, now);
  if (fault) return { light: 'bad', title: 'Cannot run beads', why: fault.why };

  const why = [];
  const mode = data?.pause?.mode ?? 'off';
  if (mode !== 'off') why.push(`paused (${pauseModeLabel(mode)})`);
  const h = data?.headroom;
  if (h && !h.available) why.push('usage could not be read');
  if (isLow(weekWindow(h))) why.push('weekly headroom is low');
  if (isLow(fiveWindow(h))) why.push('5-hour headroom is low');

  if (needs == null) {
    return { light: 'warn', title: 'Inbox unreadable', why: ['the Inbox could not be read', ...why].join(' · ') };
  }
  if (needs > 0) return { light: 'warn', title: 'Waiting on you', why: why.join(' · ') || 'open the Inbox' };
  return { light: why.length ? 'warn' : 'ok', title: 'Nothing needs you', why: why.join(' · ') || 'running normally' };
}

// ---- cards ------------------------------------------------------------------

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The needs-you card: /api/v2/inbox's count (the one needs-me number, §6) and
// what it is made of.
export function needsModel(inbox) {
  if (!inbox || typeof inbox.count !== 'number') {
    return { count: null, parts: 'the Inbox could not be read' };
  }
  const w = inbox.waiting?.length ?? 0;
  const hb = inbox.handedBack?.length ?? 0;
  const parts = [
    w ? `${plural(w, 'branch', 'branches')} waiting to merge` : 'no branches waiting',
    hb ? `${hb} handed back` : 'nothing handed back',
  ];
  const errs = inbox.errors?.length ?? 0;
  if (errs) parts.push(`${plural(errs, 'project', 'projects')} could not be read`);
  return { count: inbox.count, parts: parts.join(' · ') };
}

const leftOf = (w) => (w && !w.unknown && typeof w.percent === 'number' ? Math.max(0, 100 - w.percent) : null);

// Headroom left: weekly large, 5-hour beneath, the usage poll's own as-of.
export function headroomModel(h) {
  const wk = weekWindow(h);
  const five = fiveWindow(h);
  const wkLeft = leftOf(wk);
  const fiveLeft = leftOf(five);
  const asOf = fmtHMS(h?.asOf);
  let cls = '';
  if (wk && !wk.unknown && typeof wk.percent === 'number') {
    if (wk.percent >= wk.critPct) cls = 'bad';
    else if (wk.percent >= wk.warnPct) cls = 'warn';
  }
  return {
    v: wkLeft == null ? '—' : `${wkLeft}%`,
    d: `${fiveLeft == null ? '—' : `${fiveLeft}%`} of the 5-hour window · ${asOf ? `as of ${asOf}` : 'never checked'}`,
    asOf: asOf ? `as of ${asOf}` : 'never checked',
    cls,
    href: '#settings',
  };
}

// ---- headroom meters (bead 5v2.1) -------------------------------------------
// Settings → "Overview headroom": stored usageShow `banner` = Meters; `compact`
// and a legacy `off` = Numbers only (lib/usage.js still accepts all three, no
// migration). A headroom with no `display` came from a server that predates
// it, whose default is banner.
export function showMeters(h) {
  if (!h) return false;
  return (h.display ?? 'banner') === 'banner';
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const validDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

// "Sat 17:30" — local weekday + time, for weekly windows.
export function fmtResetWeek(iso) {
  const d = validDate(iso);
  return d ? `${WEEKDAY[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : null;
}

// "00:30 · in 1h 09m" — for the 5-hour window; `now` injected for tests.
// Already past: just the time (the next poll will move it).
export function fmtResetIn(iso, now = Date.now()) {
  const d = validDate(iso);
  if (!d) return null;
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const mins = Math.round((d.getTime() - now) / 60_000);
  if (mins <= 0) return hm;
  const h = Math.floor(mins / 60);
  return `${hm} · in ${h ? `${h}h ${pad2(mins % 60)}m` : `${mins}m`}`;
}

const hasPct = (w) => !!w && !w.unknown && typeof w.percent === 'number' && Number.isFinite(w.percent);

// One meter. Fill = percent USED, the same reading as the appbar chips (§6:
// one reading), printed the way chrome.js prints it. `limits` carries the
// Warn at / Critical at lines (critical is where the guard stops runs).
function meter(k, w, limits, reset) {
  if (!hasPct(w)) return { k, pct: '—', width: 0, reset: 'no reading', cls: '', ticks: [] };
  const { warnPct, critPct } = limits;
  let cls = '';
  if (typeof critPct === 'number' && w.percent >= critPct) cls = 'crit';
  else if (typeof warnPct === 'number' && w.percent >= warnPct) cls = 'warn';
  const ticks = [];
  if (typeof warnPct === 'number') ticks.push({ left: warnPct, crit: false, title: `warn ${warnPct}%` });
  if (typeof critPct === 'number') ticks.push({ left: critPct, crit: true, title: `guard stops runs ${critPct}%` });
  return {
    k, pct: `${w.percent}%`, width: Math.min(100, Math.max(0, w.percent)), reset: reset ? `resets ${reset}` : '', cls, ticks,
  };
}

// Week, 5-hour, then one line per model-scoped weekly limit — only when that
// model is tighter than the account week (or the week has no reading).
export function headroomMetersModel(h, now = Date.now()) {
  const wk = weekWindow(h);
  const five = fiveWindow(h);
  const limits = { warnPct: wk?.warnPct ?? five?.warnPct, critPct: wk?.critPct ?? five?.critPct };
  const out = [
    meter('Week', wk, wk ?? limits, fmtResetWeek(wk?.resetsAt)),
    meter('5-hour window', five, five ?? limits, fmtResetIn(five?.resetsAt, now)),
  ];
  for (const m of h?.modelWindows ?? []) {
    if (m.kind !== 'weekly_scoped' || !m.scopeModel || !hasPct(m)) continue;
    if (hasPct(wk) && !(m.percent > wk.percent)) continue;
    out.push(meter(`${m.scopeModel} · week`, m, limits, fmtResetWeek(m.resetsAt)));
  }
  return out;
}

// Running now: a count and the pause state — no rows, no controls.
export function runningModel(running, pause) {
  const n = running?.runs?.length ?? 0;
  const mode = pause?.mode ?? 'off';
  const d = mode !== 'off' ? `paused (${pauseModeLabel(mode)}) · nothing new starts`
    : n ? 'open Runs to see them' : 'nothing running';
  return { v: String(n), d, href: '#runs' };
}

const SHARE_LABEL_MIN = 0.12;
const SHARE_OPACITY = [0.95, 0.65, 0.42, 0.25];

// LaunchBox spend: since last visit and last 7 days as % of the weekly window,
// and one share bar of the last 7 days by project — names only.
export function spendModel(spend) {
  const since = spend?.sinceVisit?.pct;
  const rows = (spend?.last7?.byProject ?? []).filter((r) => r.pct > 0);
  const total = rows.reduce((s, r) => s + r.pct, 0);
  return {
    sinceVisit: typeof since === 'number' ? `+${fmtPct(since)}` : '—',
    sinceNote: spend?.sinceVisit?.from ? `since last visit (${fmtHM(spend.sinceVisit.from)})` : 'since last visit — first visit, nothing to compare yet',
    last7: fmtPct(spend?.last7?.pct),
    share: rows.map((r, i) => {
      const name = r.name ?? r.projectId;
      const share = r.pct / total;
      return {
        name, basis: share * 100, opacity: SHARE_OPACITY[i] ?? SHARE_OPACITY[SHARE_OPACITY.length - 1], label: share >= SHARE_LABEL_MIN ? name : '',
      };
    }),
  };
}
