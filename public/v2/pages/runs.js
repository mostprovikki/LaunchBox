// Runs tab (btv.6 / B2) — redesign/runs.html + runs-empty.html. The old UI's
// History tab, renamed; read public/app.js's history section (~line 637) as
// prior art for endpoint usage only — /v2 owns its own modules (README.md),
// nothing here imports it.
import {
  $, el, clear, pageHead, iconBtn, setDisabledReason, disableMutatingControls, toast,
} from '../ui.js';
import { api, degradedReason, failureToast } from '../api.js';
import { onRender } from '../router.js';
import { openLogDrawer, closeDrawer } from './runs-log.js';
import {
  ICON_RESUME, ICON_WINDDOWN, ICON_STOP, ICON_EMPTY,
} from './runs-icons.js';
import {
  triggerLabel, fmtWhen, fmtDuration, shortId, statusBucket,
} from './runs-format.js';
import { statusMeta, ordinal } from '../state-vocab.js';

// ---- module state ----------------------------------------------------
// One Runs page is ever mounted at a time (the router replaces #v2-page's
// content wholesale on navigation) — module-level state mirrors that, same
// pattern chrome.js uses for pauseState/usageState/pollTimer.
let jobsList = [];
let jobsById = new Map();
let extsById = new Map();
let allRuns = []; // already job-filtered (server-side); status bucketing is client-side
let streakByRunId = new Map();
let jobFilter = '';
let statusFilter = 'all';
let pollTimer = null;
let els = null; // {toolbar, card, page}

const STATUS_SEGS = [
  ['all', 'All'],
  ['active', 'Active'],
  ['ok', 'OK'],
  ['fail', 'Failed'],
  ['stopped', 'Stopped'],
  ['skipped', 'Skipped'],
];

function hashFor({ job = jobFilter, status = statusFilter } = {}) {
  const qs = new URLSearchParams();
  if (job) qs.set('job', job);
  if (status && status !== 'all') qs.set('status', status);
  const s = qs.toString();
  return `#runs${s ? `?${s}` : ''}`;
}

// ---- row building ------------------------------------------------------

function lineForRun(run, job) {
  const trig = triggerLabel(run.trigger);
  const sess = run.meta?.sessionId;
  switch (run.status) {
    case 'skipped':
      return [`${trig} · `, run.meta?.skipReason ?? 'skipped by a guard', ' — nothing was started'];
    case 'queued':
      return [`${trig} · queued — waiting for a run slot`];
    case 'running': {
      const parts = [trig];
      parts.push(' · ', el('span', { class: 'mono' }, sess ? shortId(sess) : shortId(run.id)));
      if (run.meta?.stopRung) parts.push(' · winding down');
      return parts;
    }
    case 'ok': {
      const parts = [trig];
      if (sess) parts.push(' · session ', el('span', { class: 'mono' }, shortId(sess)));
      // Burst → transcript links (spec callout): only burst-triggered runs get
      // the cross-link, resolving to the C3-owned `session` route (?id=…), per
      // pages/session.js's own placeholder comment.
      if (run.trigger === 'burst' && sess) {
        parts.push(' · ', el('a', { href: `#session?id=${encodeURIComponent(sess)}` }, 'transcript'));
      }
      return parts;
    }
    case 'fail': {
      const parts = [trig];
      if (run.exitCode != null) parts.push(' · exit ', el('span', { class: 'mono' }, String(run.exitCode)));
      return parts;
    }
    case 'timeout': {
      const parts = [trig, ` · timed out after ${job?.timeoutMin ?? '?'}min`];
      const streak = streakByRunId.get(run.id);
      if (streak > 1) parts.push(` · ${ordinal(streak)} in a row`);
      return parts;
    }
    case 'killed': {
      const parts = [trig, ' · hard stop was active — SIGKILL, no cleanup ran'];
      if (sess) parts.push(' · session ', el('span', { class: 'mono' }, shortId(sess)));
      return parts;
    }
    case 'stopped':
      return [`asked to wind down (${run.meta?.stopReason ?? 'stop requested'}) — finished cleanly, not a failure`];
    default:
      return [trig];
  }
}

async function rowAction(run, action, btn, okMsg) {
  const savedTip = btn.getAttribute('data-tip');
  btn.disabled = true;
  try {
    await api('POST', `/api/runs/${run.id}/${action}`);
    toast(okMsg, 'ok');
    await loadAndRender();
  } catch (err) {
    toast(failureToast(err) ?? `${action} failed`, 'err');
    btn.disabled = false;
    if (savedTip != null) btn.setAttribute('data-tip', savedTip);
  }
}

function buildActions(run, job, ext, jobName) {
  const rowact = el('div', { class: 'rowact' });

  // Log — a read, never a mutation, so it is never data-mutating; it just
  // needs a log to exist (see server.js's GET /api/runs/:id/log comment on
  // why the drawer is a snapshot, not a stream).
  const canLog = run.status !== 'queued' && run.status !== 'skipped';
  if (canLog) {
    const a = el('a', { class: 'btn', href: '#', 'data-tip': 'Open the log snapshot' }, 'Log');
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      openLogDrawer(run, { jobName, jobExists: !!job, triggerEl: a });
    });
    rowact.appendChild(a);
  } else {
    const tip = run.status === 'queued' ? 'Has not started — no log yet' : 'Nothing was started — guard skips have no log';
    rowact.appendChild(el('button', { class: 'btn', disabled: true, 'data-tip': tip }, 'Log'));
  }

  // Resume in Terminal — extension-defined (extensions/claude/index.js is the
  // only one today); a non-claude job simply has no runActions, same as the
  // old UI's renderRunActions().
  const resumeAction = ext?.runActions?.[0] ?? null;
  const resumeLabel = resumeAction?.label ?? 'Resume in Terminal';
  const hasResumeMeta = resumeAction && (!resumeAction.requiresRunMeta || run.meta?.[resumeAction.requiresRunMeta]);
  if (hasResumeMeta) {
    const btn = iconBtn({
      label: resumeLabel, svgHtml: ICON_RESUME, 'data-mutating': true,
    });
    btn.addEventListener('click', async () => {
      try {
        await api('POST', `/api/runs/${run.id}/actions/${resumeAction.id}`);
        toast(`${resumeLabel} opened`, 'ok');
      } catch (err) { toast(failureToast(err) ?? `${resumeLabel} failed`, 'err'); }
    });
    rowact.appendChild(btn);
  } else {
    // Business-disabled, not daemon-disabled — no data-mutating (see
    // runs-log.js's buildFoot() comment: a control the sweep can't correctly
    // re-enable on recovery must never carry the attribute in the first place).
    const btn = iconBtn({ label: resumeLabel, svgHtml: ICON_RESUME });
    setDisabledReason(btn, resumeAction ? `This run has no ${resumeAction.requiresRunMeta} to resume` : 'No Claude session to resume — shell runs have none');
    rowact.appendChild(btn);
  }

  // Wind down (soft stop)
  const windBtn = (() => {
    if (run.status === 'running' && !run.meta?.stopRung) {
      const btn = iconBtn({ label: 'Wind down', tip: 'Wind down — finish the current step, then stop', svgHtml: ICON_WINDDOWN, 'data-mutating': true });
      btn.addEventListener('click', () => rowAction(run, 'stop', btn, 'Winding down at the next safe point'));
      return btn;
    }
    const btn = iconBtn({ label: 'Wind down', svgHtml: ICON_WINDDOWN });
    const tip = run.status === 'queued' ? 'Not started yet — nothing to wind down'
      : (run.status === 'running' && run.meta?.stopRung) ? 'Already asked to wind down'
        : 'Run is over — nothing to wind down';
    setDisabledReason(btn, tip);
    return btn;
  })();
  rowact.appendChild(windBtn);

  // Stop now (running) / cancel (queued)
  const stopBtn = (() => {
    if (run.status === 'running') {
      const btn = iconBtn({ label: 'Stop now', tip: 'Stop now — SIGKILL immediately', svgHtml: ICON_STOP, 'data-mutating': true });
      btn.addEventListener('click', () => rowAction(run, 'kill', btn, 'Run stopped'));
      return btn;
    }
    if (run.status === 'queued') {
      // A queued fire never ran, so cancelling it is a clean stop, not a
      // kill — POST .../stop (lib/runner.js's requestStop() dequeues it and
      // records 'stopped', matching "stopped is explicitly not a failure").
      const btn = iconBtn({ label: 'Cancel', tip: 'Cancel the queued fire before it starts', svgHtml: ICON_STOP, 'data-mutating': true });
      btn.addEventListener('click', () => rowAction(run, 'stop', btn, 'Queued fire cancelled'));
      return btn;
    }
    const btn = iconBtn({ label: 'Stop now', svgHtml: ICON_STOP });
    setDisabledReason(btn, 'Run is over — nothing to stop');
    return btn;
  })();
  rowact.appendChild(stopBtn);

  return rowact;
}

function buildRow(run) {
  const job = jobsById.get(run.jobId) ?? null;
  const ext = job ? extsById.get(job.type) : null;
  const jobName = job ? job.name : `deleted job (${shortId(run.jobId)})`;
  const meta = statusMeta(run.status);

  const rowAttrs = { class: 'row runrow' };
  if (meta.cls !== 'ok') rowAttrs['data-state'] = meta.cls;

  const stateSpan = el('span', { class: `state state--${meta.cls}` }, [
    el('span', { class: `state__dot ${meta.dot}`.trim() }),
    meta.label,
  ]);

  const cell = el('div', { class: 'cell' }, [
    el('div', { class: 'cell__l1' }, el('span', { class: 'row__n' }, jobName)),
    el('div', { class: 'cell__l2' }, lineForRun(run, job)),
  ]);

  const when = run.startedAt || run.createdAt;
  const startedSpan = when ? el('span', { class: 'mono t-body' }, fmtWhen(when)) : el('span', { class: 'dash' }, '—');

  let durMs = run.durationMs;
  if (durMs == null && run.status === 'running' && run.startedAt) durMs = Date.now() - new Date(run.startedAt).getTime();
  const durSpan = durMs != null ? el('span', { class: 'mono t-body' }, fmtDuration(durMs)) : el('span', { class: 'dash' }, '—');

  return el('div', rowAttrs, [stateSpan, cell, startedSpan, durSpan, buildActions(run, job, ext, jobName)]);
}

// ---- empty state ---------------------------------------------------------

function buildEmpty() {
  if (jobFilter) {
    const job = jobsById.get(jobFilter);
    const name = job?.name ?? 'this job';
    return el('div', { class: 'blank', style: 'border:0; background:transparent; padding: 22px 8px;' }, [
      el('span', { class: 'blank__icon', html: ICON_EMPTY }),
      el('div', {}, [
        el('h4', {}, `“${name}” has never run`),
        el('p', {}, job?.enabled === false
          ? 'The job exists but is disabled, so no fire has ever been attempted. Every future run — including guard skips, which never start a process — will be recorded here.'
          : 'No fire has been attempted yet for this job. Every future run — including guard skips, which never start a process — will be recorded here.'),
        el('div', { class: 'blank__act' }, [
          el('a', { class: 'btn', href: '#runs' }, 'Show all jobs instead'),
          el('a', { class: 'btn', href: `#jobs?job=${encodeURIComponent(jobFilter)}` }, 'Open the job'),
        ]),
      ]),
    ]);
  }
  return el('div', { class: 'blank', style: 'border:0; background:transparent; padding: 22px 8px;' }, [
    el('span', { class: 'blank__icon', html: ICON_EMPTY }),
    el('div', {}, [
      el('h4', {}, 'No runs recorded'),
      el('p', {}, `Checked ${jobsList.length} job${jobsList.length === 1 ? '' : 's'} — none has fired yet. Every future run, including guard skips (which never start a process), will be recorded here.`),
      el('div', { class: 'blank__act' }, el('a', { class: 'btn', href: '#jobs' }, 'Open Jobs')),
    ]),
  ]);
}

// ---- toolbar + card rendering --------------------------------------------

function renderToolbar() {
  const { toolbar } = els;
  clear(toolbar);

  const select = el('select', { style: 'max-width: 240px;' });
  select.appendChild(el('option', { value: '' }, 'All jobs'));
  for (const j of jobsList) select.appendChild(el('option', { value: j.id }, j.name));
  toolbar.appendChild(select);
  select.value = jobFilter; // build options THEN set value (README's caution)
  if (select.value !== jobFilter) select.value = ''; // filtered job no longer exists
  select.addEventListener('change', () => { location.hash = hashFor({ job: select.value }); });

  const counts = { all: allRuns.length, active: 0, ok: 0, fail: 0, stopped: 0, skipped: 0 };
  for (const r of allRuns) {
    const b = statusBucket(r.status);
    if (b in counts) counts[b]++;
  }
  const segs = el('div', { class: 'segs' });
  for (const [key, label] of STATUS_SEGS) {
    const attrs = { class: 'seg' };
    if (statusFilter === key) attrs['aria-selected'] = 'true';
    const btn = el('button', attrs, [label, ' ', el('span', { class: 'seg__count' }, String(counts[key]))]);
    btn.addEventListener('click', () => { location.hash = hashFor({ status: key }); });
    segs.appendChild(btn);
  }
  toolbar.appendChild(segs);
}

function renderCard() {
  const { card } = els;
  clear(card);

  if (allRuns.length === 0) {
    card.appendChild(el('div', { class: 'card__body' }, buildEmpty()));
    return;
  }

  const shown = allRuns.filter((r) => statusFilter === 'all' || statusBucket(r.status) === statusFilter);
  if (shown.length === 0) {
    card.appendChild(el('div', { class: 'card__body' }, el('p', { class: 't-meta' }, [
      'No runs match this filter. ',
      el('a', { href: hashFor({ status: 'all' }) }, 'Show all'),
    ])));
    return;
  }

  const rows = el('div', { class: 'rows' }, [
    el('div', { class: 'row row--head runrow' }, [
      el('span', {}, 'Status'), el('span', {}, 'Job · trigger'), el('span', {}, 'Started'),
      el('span', {}, 'Duration'), el('span', { style: 'text-align:right;' }, 'Actions'),
    ]),
    ...shown.map(buildRow),
  ]);
  card.appendChild(rows);
}

async function loadAndRender() {
  try {
    const [jobsRes, extRes, runsRes] = await Promise.all([
      api('GET', '/api/jobs'),
      api('GET', '/api/extensions'),
      api('GET', `/api/runs?limit=100${jobFilter ? `&job=${encodeURIComponent(jobFilter)}` : ''}`),
    ]);
    jobsList = jobsRes.jobs ?? [];
    jobsById = new Map(jobsList.map((j) => [j.id, j]));
    extsById = new Map((extRes.extensions ?? []).map((e) => [e.id, e]));
    allRuns = runsRes.runs ?? [];
  } catch (err) {
    toast(failureToast(err) ?? 'could not load runs', 'err');
    return; // keep whatever was last rendered rather than blanking the page on a transient failure
  }

  // Best-effort only — /api/v2/overview (btv.2) is reused unmodified purely
  // for its already-computed timeout streak (server.js's needs-attention
  // loop); Runs must still render correctly without it, so a failure here is
  // swallowed rather than surfaced.
  try {
    const ov = await api('GET', '/api/v2/overview');
    streakByRunId = new Map((ov?.attention?.items ?? [])
      .filter((i) => i.kind === 'timeout')
      .map((i) => [i.id, i.reason?.streak]));
  } catch {
    streakByRunId = new Map();
  }

  const todaysRuns = allRuns.filter((r) => {
    const t = r.finishedAt || r.startedAt || r.createdAt;
    if (!t) return false;
    const d = new Date(t); const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  });
  const byStatus = {};
  for (const r of todaysRuns) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const subParts = [`Today: `, el('span', { class: 'mono' }, String(todaysRuns.length)), ' runs'];
  for (const [st, label] of [['ok', 'ok'], ['timeout', 'timeout'], ['skipped', 'skipped'], ['killed', 'killed'], ['stopped', 'stopped'], ['fail', 'failed']]) {
    if (byStatus[st]) subParts.push(' · ', el('span', { class: 'mono' }, String(byStatus[st])), ` ${label}`);
  }
  const head = $('#v2-page')?.querySelector('.pagehead__sub');
  if (head) { clear(head); head.append(...subParts); }

  renderToolbar();
  renderCard();
  // Every render pass here happens on a timer, NOT through router.js's
  // onRender — main.js's central sweep only re-fires on an auth-state
  // TRANSITION (api.js's setAuthState() no-ops when the state doesn't
  // change), so a poll tick that rebuilds these rows while ALREADY degraded
  // would otherwise come up with fresh, un-swept (enabled) buttons. This is
  // the same "control built between sweeps" case README.md calls out for the
  // log drawer — applied here because polling, not just user action, inserts
  // new controls after the page's own render pass.
  disableMutatingControls(els.page, degradedReason());
}

export default function runs(params) {
  const page = $('#v2-page');
  if (!page) return;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  closeDrawer();

  jobFilter = params.get('job') ?? '';
  const wantStatus = params.get('status') ?? 'all';
  statusFilter = STATUS_SEGS.some(([k]) => k === wantStatus) ? wantStatus : 'all';

  clear(page);
  page.appendChild(pageHead({ title: 'Runs', sub: 'Loading…' }));
  const toolbar = el('div', { class: 'toolbar' });
  const card = el('section', { class: 'card' });
  page.appendChild(toolbar);
  page.appendChild(card);
  els = { toolbar, card, page };

  loadAndRender();
  pollTimer = setInterval(loadAndRender, 3000);
}

// A route change away from 'runs' must stop the poll — otherwise it keeps
// hitting /api/jobs, /api/extensions, /api/runs and /api/v2/overview forever
// in the background, and (worse) disableMutatingControls(els.page, …) above
// would run against a #v2-page that now belongs to a different route.
onRender((route) => {
  if (route !== 'runs' && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
});
