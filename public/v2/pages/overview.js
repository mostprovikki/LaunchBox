// Overview tab (claude-scheduler-btv.8 / C1) — redesign/overview.html +
// overview-quiet.html/overview-unreachable.html/auth-invalid.html +
// pause-{hold,soft,hard}.html. See public/v2/README.md for the frozen /v2
// contract this page builds against (route registration, api()/
// guardedSubmit, data-mutating, iconBtn, state-vocab).
//
// Data: GET /api/v2/overview (claude-scheduler-btv.2, already landed) — the
// ONE fetch this page needs. Every fixture used while building this page was
// read from tests/v2-overview.test.js and a live instance, not hand-invented
// (see this repo's memory note on B1's fixture-shape bug — a hand-built
// {attention:[...]} instead of the real {attention:{asOf,items}} shipped a
// page that threw "object is not iterable" against the real endpoint).
import {
  $, el, clear, pageHead, iconBtn, disableMutatingControls, toast, asOfEl,
} from '../ui.js';
import {
  api, degradedReason, getAuthState, onAuthState, failureToast,
} from '../api.js';
import { onRender } from '../router.js';
import { openJobDialog } from './job-dialog.js';
import { openLogDrawer, closeDrawer } from './runs-log.js';
import {
  ICON_WINDDOWN, ICON_STOP, ICON_REFRESH, ICON_EMPTY as ICON_LOG,
} from './runs-icons.js';
import { triggerLabel, fmtWhen as fmtRunWhen, fmtDuration } from './runs-format.js';
import {
  statusMeta, projectStateMeta, PROJECT_VOCAB, dotClass,
} from '../state-vocab.js';
import {
  fmtHM, fmtCheckedAt, fmtHeadDate, connectivityPhrase,
  windowMeterClass, bucketMeterClass, fmtResetLine, modelWindowLabel,
  guardSummary, criticalModelNotes, attentionLine, attentionActions,
  fireTimeParts, fireAnnotation, pauseModeLabel, typeBadge, todayCounts,
  burstSummary,
} from './overview-logic.js';

const SVG_PLUS = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const SVG_CHECK = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>';

const NOT_YET_TIP = 'Ships in a later bead (claude-scheduler-btv.12, D2) — not yet available';

// Mockup `.btn` markup puts the `<svg>` as a direct child (not wrapped in a
// span) — same convention jobs.js's svgNode() follows, reproduced here (not
// imported — only jobs.js/overview.js need it and README.md's ownership rule
// is about not importing public/*.js, not about a two-line DOM helper).
function svgNode(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

let data = null; // last successful GET /api/v2/overview payload
let pollTimer = null;

// ---------------- data ----------------

// The minimum shape every render function below assumes. Guarded explicitly
// rather than trusting any 200 response: an endpoint returning something
// other than the real /api/v2/overview shape (a stub, a future breaking
// change) must degrade to "nothing to show yet", never throw partway through
// a render — caught live by tests/frontend-v2-conventions.test.js's central-
// sweep tests, whose mock fetch returns a bare `{}` for every path.
function isWellFormed(res) {
  return !!(res && res.headroom && res.attention && res.next24h && res.running && res.today);
}

async function loadAndRender() {
  try {
    const res = await api('GET', '/api/v2/overview');
    if (isWellFormed(res)) data = res;
    // else: leave `data` as whatever it was (null on first load, last-good
    // otherwise) — same "keep the last good render" rule the catch below uses.
  } catch (err) {
    // api.js already flips the global degraded banner + central data-mutating
    // sweep for 'unreachable'/'token_invalid' (README.md's failure table) —
    // nothing to add here, and no toast (piling one on top of the persistent
    // banner is noise, same rule failureToast() already encodes). Anything
    // else is a genuine failure of this one endpoint, worth a toast; the page
    // keeps rendering whatever it last had rather than going blank.
    if (err?.code !== 'unreachable' && err?.code !== 'token_invalid') {
      toast(failureToast(err) ?? 'could not load overview', 'err');
    }
  }
  render();
}

// ---------------- actions ----------------

async function refreshUsage(btn) {
  const savedTip = btn.getAttribute('data-tip');
  btn.disabled = true;
  try {
    await api('POST', '/api/usage/refresh');
    toast('Usage refreshed', 'ok');
  } catch (err) {
    if (err?.status === 429) {
      toast(`Just checked — try again in ${err.data?.retryAfterSec ?? '?'}s`);
    } else if (err?.code !== 'unreachable' && err?.code !== 'token_invalid') {
      toast(failureToast(err) ?? 'usage refresh failed', 'err');
    }
  } finally {
    btn.disabled = false;
    if (savedTip != null) btn.setAttribute('data-tip', savedTip);
  }
  loadAndRender();
}

// runs-log.js expects a full /api/runs row (logPath, exitCode, meta.stopRung,
// etc.) — running.runs[] (from /api/v2/overview) is a slimmer projection
// (server.js's `running` block only sends runId/jobId/jobName/type/trigger/
// startedAt/elapsedMs/sessionId). Rather than hand-build a partial run object
// (which would show "No log file for this run" until the drawer's own
// Refresh button happened to re-fetch the real row), fetch the real row once
// here and hand runs-log.js exactly the shape it already knows how to render.
async function openRunningLog(r, triggerEl) {
  try {
    const { runs } = await api('GET', '/api/runs?limit=100');
    const run = runs.find((x) => x.id === r.runId);
    if (!run) { toast('That run is no longer in the recent list', 'err'); return; }
    openLogDrawer(run, { jobName: r.jobName, jobExists: true, triggerEl });
  } catch (err) {
    toast(failureToast(err) ?? 'could not open the log', 'err');
  }
}

async function runRowAction(runId, action, btn, okMsg) {
  btn.disabled = true;
  try {
    await api('POST', `/api/runs/${runId}/${action}`);
    toast(okMsg, 'ok');
  } catch (err) {
    toast(failureToast(err) ?? `${action} failed`, 'err');
  }
  loadAndRender();
}

// ---------------- headroom ----------------

function meterNode({
  label, percent, unknown, resetsAt, relative, cls,
}) {
  const track = [el('span', { class: 'meter__fill', style: `width:${unknown ? 0 : percent}%` })];
  const pctText = unknown || percent == null ? 'unknown' : `${percent}%`;
  return el('div', { class: `meter${cls ? ` meter--${cls}` : ''}` }, [
    el('div', { class: 'meter__head' }, [
      el('span', { class: 'meter__k' }, label),
      el('span', { class: 'meter__pct' }, pctText),
      el('span', { class: 'meter__reset' }, unknown ? 'no reading yet' : fmtResetLine(resetsAt, { relative })),
    ]),
    el('div', { class: 'meter__track' }, track),
  ]);
}

// Ticks (warn/crit thresholds) only apply to the two named windows — a
// modelWindow (bucket) carries a `severity` but no threshold percentages of
// its own, so drawing a tick there would invent a number the data does not
// carry.
function namedMeter(w) {
  const node = meterNode({
    label: w.label, percent: w.percent, unknown: w.unknown, resetsAt: w.resetsAt, relative: w.key === 'five_hour', cls: windowMeterClass(w),
  });
  if (!w.unknown) {
    const track = node.querySelector('.meter__track');
    track.appendChild(el('span', { class: 'meter__tick', style: `left:${w.warnPct}%`, 'data-tip': `warn ${w.warnPct}%` }));
    track.appendChild(el('span', { class: 'meter__tick meter__tick--crit', style: `left:${w.critPct}%`, 'data-tip': `critical ${w.critPct}%` }));
  }
  return node;
}

function modelMeter(w) {
  return meterNode({
    label: modelWindowLabel(w), percent: w.percent, unknown: w.unknown, resetsAt: w.resetsAt, relative: false, cls: bucketMeterClass(w.severity),
  });
}

function buildHeadroom() {
  const h = data.headroom;
  const head = el('div', { class: 'card__head' }, [
    el('h2', {}, 'Headroom'),
    el('span', { class: 't-meta' }, guardSummary(h.guard)),
    el('span', { style: 'margin-left:auto; display:flex; gap:14px; align-items:center;' }, [
      el('button', {
        class: 'btn', disabled: true, style: 'font-size:12.5px;', 'data-tip': NOT_YET_TIP,
      }, 'Plan a burn-down…'),
      el('button', {
        class: 'btn', disabled: true, style: 'font-size:12.5px;', 'data-tip': NOT_YET_TIP,
      }, 'Start a burst…'),
      h.asOf ? el('span', { class: 'asof' }, fmtCheckedAt(h.asOf)) : el('span', { class: 'asof' }, 'never checked'),
    ]),
  ]);

  // `isActive` (usage.js) means "the bucket the guard currently keys off of",
  // not "this model matters" — a real snapshot carries a `session`/`weekly_all`
  // bucket with no scopeModel that duplicates the two named windows above,
  // and its `isActive` can be true while the one bucket actually worth a
  // third meter (a model PIN, e.g. Fable) sits at isActive:false. Filtering
  // on scopeModel (present only for a genuinely model-scoped bucket) is what
  // matches redesign/overview.html's "Fable · week" meter; isActive doesn't.
  // Caught by driving this page against a real usage snapshot, not a fixture.
  const active = (h.modelWindows ?? []).filter((w) => w.scopeModel);
  const meters = el('div', { class: 'meters3' }, [
    ...h.windows.map((w) => namedMeter(w)),
    ...active.map((w) => modelMeter(w)),
  ]);

  const body = el('div', { class: 'card__body' }, [meters]);
  const notes = criticalModelNotes(active);
  for (const n of notes) body.appendChild(el('div', { class: 'rowline', style: 'margin-top:14px;' }, el('span', { class: 't-meta' }, n)));
  if (!h.available) {
    body.appendChild(el('div', { class: 'rowline', style: 'margin-top:14px;' }, el('span', { class: 't-meta' }, 'Usage could not be read — the guard is failing open until the next successful check.')));
  }

  return el('section', { class: 'card', style: 'margin-bottom: 18px;' }, [head, body]);
}

// ---------------- needs attention ----------------

// project_issue is not a run status (state-vocab's STATE_VOCAB) — it is a
// server.js-only classification of the same three project overlays
// PROJECT_VOCAB already covers for the Automation card below (bd_busy/error).
// Reused directly here rather than a second table; 'project_warning' is the
// one code neither PROJECT_VOCAB nor STATE_VOCAB names (a project with
// warnings but not busy/errored), so that one case only borrows the 'warn'
// colour class already used everywhere else for the same meaning.
function attentionChip(item) {
  if (item.kind === 'project_issue') {
    const code = item.reason?.code;
    if (code === 'bd_busy') return { cls: PROJECT_VOCAB.bd_busy.cls, dot: dotClass(PROJECT_VOCAB.bd_busy.form), label: PROJECT_VOCAB.bd_busy.label };
    if (code === 'project_error') return { cls: PROJECT_VOCAB.error.cls, dot: dotClass(PROJECT_VOCAB.error.form), label: PROJECT_VOCAB.error.label };
    return { cls: 'warn', dot: '', label: 'warning' };
  }
  const m = statusMeta(item.kind);
  return { cls: m.cls, dot: m.dot, label: m.label };
}

function attentionRow(item) {
  const { cls: chipCls, dot: chipDot, label: chipLabel } = attentionChip(item);
  const actions = attentionActions(item).map((a) => el('a', { class: a.ghost ? 'btn btn--ghost' : 'btn', href: a.href }, a.label));
  return el('div', { class: 'row attn', 'data-state': chipCls }, [
    el('div', { class: 'cell' }, [
      el('div', { class: 'cell__l1' }, [
        el('span', { class: `state state--${chipCls}` }, [el('span', { class: `state__dot ${chipDot}`.trim() }), chipLabel]),
        el('span', { class: 'row__n' }, item.jobName ?? '(unknown)'),
      ]),
      el('div', { class: 'cell__l2' }, attentionLine(item)),
    ]),
    el('div', { class: 'rowline' }, actions),
  ]);
}

function buildAttention() {
  const items = data.attention.items ?? [];
  const head = el('div', { class: 'card__head' }, [
    el('h2', {}, 'Needs attention'),
    el('span', { class: 'tab__n' }, String(items.length)),
    degradedReason() ? el('span', { class: 'asof', style: 'margin-left:auto;' }, asOfEl(new Date(data.attention.asOf)).textContent) : null,
  ]);

  if (items.length === 0) {
    return el('section', { class: 'card' }, [head, el('div', { class: 'card__body' }, el('div', {
      class: 'blank', style: 'border:0; background:transparent; padding: 10px 2px;',
    }, [
      el('span', { class: 'blank__icon', html: SVG_CHECK }),
      el('div', {}, [
        el('h4', {}, 'Nothing needs you'),
        el('p', {}, 'The last 48 hours: every finished run ended ok, no guard skips, no kills or stops. '
          + 'Checked: run outcomes (timeouts, skips, kills, stops) and project polling health.'),
      ]),
    ]))]);
  }

  return el('section', { class: 'card' }, [head, el('div', { class: 'rows' }, items.map(attentionRow))]);
}

// ---------------- next 24 hours ----------------

function fireRow(entry, now) {
  const { time, rel } = fireTimeParts(entry, now);
  const badge = typeBadge(entry.type, {});
  const note = fireAnnotation(entry);
  const l2Parts = [scheduleHint(entry)].filter(Boolean);
  if (note) l2Parts.push(note);
  return el('div', { class: 'row nextrow' }, [
    el('div', {}, [el('span', { class: 'next__t' }, time), el('div', { class: 'next__rel' }, rel)]),
    el('span', { class: `ftype ${badge.info ? 'ftype--info' : ''}`.trim(), 'data-tip': badge.tip }, badge.code),
    el('div', { class: 'cell' }, [
      el('div', { class: 'cell__l1' }, el('span', { class: 'row__n' }, entry.jobName)),
      el('div', { class: 'cell__l2' }, l2Parts.join(' · ')),
    ]),
    el('span', { class: 't-meta' }),
  ]);
}

// A minimal, honest schedule hint — full cron-preset prose lives in
// jobs-logic.js's scheduleDescribe(schedule); next24h entries carry the raw
// `schedule` field so the same function would work, but Overview only needs
// enough to tell one fire from the next, and importing scheduleDescribe here
// too would pull its whole cron-preset table into a page that only ever
// shows the type, not the full schedule — so this stays a one-line fallback.
function scheduleHint(entry) {
  return entry.anchoredToReset ? 'fires relative to the usage reset — exact time follows live usage' : '';
}

function buildNext24h() {
  const n = data.next24h;
  const modeLabel = n.pauseMode !== 'off' ? pauseModeLabel(n.pauseMode) : null;
  const sub = modeLabel
    ? `${n.fires.length} scheduled fire${n.fires.length === 1 ? '' : 's'} · listed, but dropped while ${modeLabel} is on`
    : `${n.fires.length} scheduled fire${n.fires.length === 1 ? '' : 's'} · guard decides at fire time`;
  const head = el('div', { class: 'card__head' }, [
    el('h2', {}, 'Next 24 hours'),
    el('span', { class: 't-meta' }, sub),
    degradedReason() ? el('span', { class: 'asof', style: 'margin-left:auto;' }, asOfEl(new Date(n.asOf)).textContent) : null,
  ]);

  if (n.fires.length === 0) {
    return el('section', { class: 'card' }, [head, el('div', { class: 'card__body' }, el('p', { class: 't-meta' }, 'Nothing scheduled in the next 24 hours.'))]);
  }

  const now = Date.now();
  const rows = el('div', { class: 'rows' }, n.fires.map((e) => fireRow(e, now)));
  const beyondText = (n.beyond ?? []).slice(0, 4).map((e) => `${e.jobName} (${fireTimeParts(e, now).time})`).join(' · ');
  const foot = el('div', { class: 'card__body', style: 'border-top:1px solid var(--line-2); padding: 12px 18px;' }, el('span', { class: 'coverage' }, [
    beyondText ? el('span', {}, `Beyond 24h: ${beyondText}`) : null,
    n.disabledNeverFireCount ? el('span', {}, `· ${n.disabledNeverFireCount} disabled job${n.disabledNeverFireCount === 1 ? '' : 's'} never fire`) : null,
  ]));

  return el('section', { class: 'card' }, [head, rows, foot]);
}

// ---------------- running now ----------------

function runningRow(r, stopping) {
  const key = stopping ? 'stopping' : 'running';
  const meta = statusMeta(key);
  const logBtn = iconBtn({ label: 'Open log', tag: 'a', href: '#', svgHtml: ICON_LOG });
  logBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    openRunningLog(r, logBtn);
  });

  const actions = [logBtn];
  if (!stopping) {
    const windBtn = iconBtn({ label: 'Wind down', tip: 'Wind down — finish the current step, then stop', svgHtml: ICON_WINDDOWN, 'data-mutating': true });
    windBtn.addEventListener('click', () => runRowAction(r.runId, 'stop', windBtn, 'Winding down at the next safe point'));
    actions.push(windBtn);
  }
  const stopBtn = iconBtn({ label: 'Stop now', tip: 'Stop now — SIGKILL immediately', svgHtml: ICON_STOP, 'data-mutating': true });
  stopBtn.addEventListener('click', () => runRowAction(r.runId, 'kill', stopBtn, 'Run stopped'));
  actions.push(stopBtn);

  return el('div', { class: 'row', 'data-state': meta.cls, style: 'grid-template-columns: minmax(0,1fr) auto;' }, [
    el('div', { class: 'cell' }, [
      el('div', { class: 'cell__l1' }, [
        el('span', { class: `state state--${meta.cls}` }, [el('span', { class: `state__dot ${meta.dot}`.trim() }), stopping ? meta.label : null]),
        el('span', { class: 'row__n' }, r.jobName),
      ]),
      el('div', { class: 'cell__l2' }, [
        'started ', el('span', { class: 'mono' }, fmtRunWhen(r.startedAt) ?? '—'),
        ' · ', el('span', { class: 'mono' }, fmtDuration(r.elapsedMs) ?? '—'),
        ' · ', triggerLabel(r.trigger),
      ]),
    ]),
    el('div', { class: 'rowline' }, actions),
  ]);
}

function buildRunning() {
  const r = data.running;
  const stoppingIds = new Set(data.pause?.stopping ?? []);
  const head = el('div', { class: 'card__head' }, [
    el('h2', {}, 'Running now'),
    el('span', { class: 'tab__n' }, String(r.runs.length)),
    degradedReason() ? el('span', { class: 'asof', style: 'margin-left:auto;' }, asOfEl(new Date(r.asOf)).textContent) : null,
  ]);

  if (r.runs.length === 0) {
    const t = data.today;
    const next = data.next24h.fires[0];
    const counts = todayCounts(t);
    const summary = counts.length ? counts.map(([label, n]) => `${n} ${label}`).join(', ') : 'none yet';
    const parts = [
      'Nothing is running. ',
      next ? el('span', {}, ['Next fire: ', el('b', {}, next.jobName), ' at ', el('span', { class: 'mono' }, fireTimeParts(next, Date.now()).time), '. ']) : null,
      `Today so far: `, el('span', { class: 'mono' }, String(t.total)), ` run${t.total === 1 ? '' : 's'} (${summary}) — `,
      el('a', { href: '#runs' }, 'full history'), '.',
    ];
    return el('section', { class: 'card' }, [head, el('div', { class: 'card__body' }, el('span', { class: 't-meta' }, parts))]);
  }

  const rows = el('div', { class: 'rows' }, r.runs.map((run) => runningRow(run, stoppingIds.has(run.runId))));
  const t = data.today;
  const counts = todayCounts(t);
  const summary = counts.map(([label, n]) => [' · ', el('span', { class: 'mono' }, String(n)), ` ${label}`]);
  const foot = el('div', { class: 'card__body', style: 'border-top:1px solid var(--line-2); padding: 12px 18px;' }, el('span', { class: 't-meta' }, [
    'Today so far: ', el('span', { class: 'mono' }, String(t.total)), ' runs',
    ...summary.flat(),
    ' — ', el('a', { href: '#runs' }, 'full history'),
  ]));

  return el('section', { class: 'card' }, [head, rows, foot]);
}

// ---------------- automation ----------------

function automationRow(p, inBurstIds) {
  const meta = projectStateMeta({ state: p.state, busyStreak: p.busyStreak, inBurst: inBurstIds.has(p.id) });
  const l2 = p.reasons?.length ? p.reasons.join(' · ')
    : p.state === 'active' ? `${p.ready?.count ?? '—'} ready bead${p.ready?.count === 1 ? '' : 's'} · polled ${fmtHM(p.lastPollAt) ?? '—'}`
      : `${p.ready?.count ?? 0} ready bead${p.ready?.count === 1 ? '' : 's'} waiting`;
  return el('div', { class: 'row', 'data-state': meta.cls, style: 'grid-template-columns: minmax(0,1fr) auto;' }, [
    el('div', { class: 'cell' }, [
      el('div', { class: 'cell__l1' }, [
        el('span', { class: `state state--${meta.cls}` }, [el('span', { class: `state__dot ${meta.dot}`.trim() }), meta.label]),
        el('span', { class: 'row__n' }, p.name),
      ]),
      el('div', { class: 'cell__l2' }, l2),
    ]),
    el('span'),
  ]);
}

function buildAutomation() {
  const a = data.automation;
  const head = el('div', { class: 'card__head' }, [
    el('h2', {}, 'Automation'),
    el('a', { class: 't-meta', style: 'margin-left:auto;', href: '#projects' }, 'all projects'),
    degradedReason() && a.asOf ? el('span', { class: 'asof' }, asOfEl(new Date(a.asOf)).textContent) : null,
  ]);

  if (!a.available) {
    return el('section', { class: 'card' }, [head, el('div', { class: 'card__body' }, el('p', { class: 't-meta' }, 'Project task sources are not configured for this instance.'))]);
  }

  const inBurstIds = new Set(a.burst?.active?.projectIds ?? []);
  const rows = (a.projects ?? []).length
    ? el('div', { class: 'rows' }, a.projects.map((p) => automationRow(p, inBurstIds)))
    : el('div', { class: 'card__body' }, el('p', { class: 't-meta' }, 'No projects registered yet.'));

  const foot = el('div', { class: 'card__body', style: 'border-top:1px solid var(--line-2); padding: 12px 18px;' }, el('div', { class: 'rowline' }, [
    el('span', { class: 't-meta' }, burstSummary(a.burst)),
    el('button', {
      class: 'btn', style: 'margin-left:auto;', disabled: true, 'data-tip': NOT_YET_TIP,
    }, 'Start a burst…'),
  ]));

  return el('section', { class: 'card' }, [head, rows, foot]);
}

// ---------------- top-level render ----------------

function render() {
  const page = $('#v2-page');
  if (!page) return;

  const stale = !!getAuthState();
  document.querySelector('main.shell')?.classList.toggle('is-stale', stale);

  clear(page);

  if (!data) {
    page.appendChild(pageHead({ title: 'Overview', sub: 'Loading…' }));
    return;
  }

  const pauseMode = data.pause?.mode ?? 'off';
  const refreshBtn = el('button', {
    class: 'btn', 'data-mutating': true, 'data-tip': 'Force a usage check now (throttled)',
  }, [svgNode(ICON_REFRESH), 'Refresh usage']);
  refreshBtn.addEventListener('click', () => refreshUsage(refreshBtn));

  page.appendChild(pageHead({
    title: 'Overview',
    sub: `${fmtHeadDate(Date.now())} · ${connectivityPhrase(getAuthState(), pauseMode)}`,
    actions: [
      refreshBtn,
      el('button', {
        class: 'btn btn--primary', 'data-mutating': true, onclick: () => openJobDialog({ onSaved: loadAndRender }),
      }, [svgNode(SVG_PLUS), 'New job']),
    ],
  }));

  page.appendChild(buildHeadroom());

  const left = el('div', {}, [buildAttention(), buildNext24h()]);
  const right = el('div', {}, [buildRunning(), buildAutomation()]);
  page.appendChild(el('div', { class: 'ovgrid' }, [left, right]));

  disableMutatingControls(page, degradedReason());
}

export default function overview(params) {
  void params; // no deep-link query params defined for this route
  const page = $('#v2-page');
  if (!page) return;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  closeDrawer();

  clear(page);
  page.appendChild(pageHead({ title: 'Overview', sub: 'Loading…' }));

  loadAndRender();
  pollTimer = setInterval(loadAndRender, 5000);
  pollTimer.unref?.();
}

// Stop polling (and the reactive is-stale toggle below) on navigation away —
// same reason runs.js/jobs.js do this: otherwise this keeps hitting
// /api/v2/overview forever in the background against a #v2-page that now
// belongs to a different route.
onRender((route) => {
  if (route !== 'overview' && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
});
// The is-stale dimming and per-card "as of" stamps must react the instant the
// daemon drops/recovers, not wait for the next 5s poll tick — same
// "already-rendered page must go dead immediately" property README.md
// requires for data-mutating controls, applied here to presentation instead.
onAuthState(() => { if ($('#v2-page') && data) render(); });
