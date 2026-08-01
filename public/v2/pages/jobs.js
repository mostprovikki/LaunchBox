// Jobs tab (claude-scheduler-btv.5 / B1). Row grammar, dot forms and
// reason-per-state lines from redesign/jobs.html — REVIEW.md calls the
// reason-per-state discipline "the single best property of the design";
// public/v2/pages/jobs-logic.js carries the pure state-derivation this file
// only renders. See public/v2/README.md for the frozen /v2 contract this
// page builds against (route registration, api()/guardedSubmit,
// data-mutating, iconBtn).
//
// Endpoints reused unchanged (API policy: additive-only, nothing existing
// is touched): GET/POST/PUT/DELETE /api/jobs(/:id), POST /api/jobs/:id/run,
// GET /api/extensions, and GET /api/v2/overview (claude-scheduler-btv.2,
// already landed) for its decoded timeout-streak/skip/stop reasons.
import { api, failureToast } from '../api.js';
import {
  $, el, clear, pageHead, iconBtn, toast,
} from '../ui.js';
import { onRender } from '../router.js';
import { openJobDialog } from './job-dialog.js';
import {
  typeBadge, jobDetailLine, scheduleDescribe, hasAfterReset, relIn, fmtWhen,
  attentionByJobId, runningByJobId, computeRowState, filterJobs,
} from './jobs-logic.js';
import { dotClass } from '../state-vocab.js';

const POLL_MS = 4000;

const SVG_PLAY = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M7 5v14l11-7z"/></svg>';
const SVG_EDIT = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
const SVG_CLONE = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const SVG_DELETE = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';
const SVG_PLUS = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const SVG_CLOCK = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>';
const SVG_SEARCH_SM = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
const SVG_SEARCH_LG = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';

const state = { jobs: [], running: 0, overview: null, extNames: {}, query: '', type: 'all', listHost: null };
let pollTimer = null;
let routeWatcherArmed = false;

// Mockup `.btn`/search markup puts the `<svg>` as a direct child (not wrapped
// in a span) — a wrapper wouldn't break the flex/gap layout visually, but
// this keeps the built DOM a faithful match of redesign/jobs.html rather
// than an approximation.
function svgNode(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

// ---------------- data ----------------

async function loadExtensionNames() {
  try {
    const { extensions } = await api('GET', '/api/extensions');
    state.extNames = Object.fromEntries((extensions ?? []).map((e) => [e.id, e.name]));
  } catch { /* non-fatal — badge tooltip falls back to a generic label */ }
}

async function loadAndRender() {
  try {
    const jobsRes = await api('GET', '/api/jobs');
    state.jobs = jobsRes.jobs ?? [];
    state.running = jobsRes.running ?? 0;
  } catch {
    // api() already flips the global degraded banner + sweep; nothing else to do.
  }
  // Additive-only (btv.2) and only used for richer reason text (timeout
  // streak, decoded skip/stop reasons) — degrade to the plain lastRun data
  // above if it is ever unreachable while /api/jobs itself is fine.
  try {
    state.overview = await api('GET', '/api/v2/overview');
  } catch {
    state.overview = null;
  }
  render();
}

// ---------------- actions ----------------

const PAUSE_REFUSAL = /^paused \((soft|hard)\)$/;

async function runJob(job) {
  try {
    let run = await api('POST', `/api/jobs/${job.id}/run`);
    if (run.status === 'skipped' && PAUSE_REFUSAL.test(run.meta?.skipReason ?? '')) {
      // eslint-disable-next-line no-alert
      if (!window.confirm(`Everything is ${run.meta.skipReason} — that's why this didn't start.\n\nRun "${job.name}" anyway, just this once?`)) {
        toast(`Not started — ${run.meta.skipReason}`, 'err');
        loadAndRender();
        return;
      }
      run = await api('POST', `/api/jobs/${job.id}/run`, { force: true });
    }
    if (run.status === 'skipped') {
      toast(run.meta?.skipReason ? `Not started — ${run.meta.skipReason}` : `"${job.name}" is already running`, 'err');
    } else {
      toast(`Started "${job.name}"${run.status === 'queued' ? ' (queued)' : ''}`, 'ok');
    }
  } catch (err) {
    toast(failureToast(err) ?? 'run failed', 'err');
  }
  loadAndRender();
}

async function deleteJob(job) {
  // eslint-disable-next-line no-alert
  if (!window.confirm(`Delete job "${job.name}" and its run history?`)) return;
  try {
    await api('DELETE', `/api/jobs/${job.id}`);
    toast(`Deleted "${job.name}"`);
  } catch (err) {
    toast(failureToast(err) ?? 'delete failed', 'err');
  }
  loadAndRender();
}

async function toggleJob(job, sw) {
  const next = sw.checked;
  sw.disabled = true;
  try {
    await api('PUT', `/api/jobs/${job.id}`, { enabled: next });
    toast(`"${job.name}" ${next ? 'enabled' : 'disabled'}`, 'ok');
  } catch (err) {
    sw.checked = !next;
    toast(failureToast(err) ?? 'update failed', 'err');
  } finally {
    sw.disabled = false;
    loadAndRender();
  }
}

// ---------------- row building ----------------

function typeCell(job) {
  const b = typeBadge(job.type, state.extNames);
  return el('span', { class: `ftype ${b.info ? 'ftype--info' : ''}`.trim(), 'data-tip': b.tip }, b.code);
}

function jobCell(job) {
  const guardOff = job.params?.budget?.ignoreGuard
    ? el('span', { class: 'tag', 'data-tip': 'This job intentionally ignores the budget guard' }, 'guard off')
    : null;
  const parts = [jobDetailLine(job)].filter(Boolean);
  if (!job.enabled) parts.push('disabled — will not fire');
  return el('div', { class: 'cell' }, [
    el('div', { class: 'cell__l1' }, [el('span', { class: 'row__n' }, job.name), guardOff]),
    el('div', { class: 'cell__l2' }, parts.length ? el('span', { class: 'mono' }, parts.join(' · ')) : null),
  ]);
}

function scheduleCell(job, now) {
  const dash = () => el('span', { class: 'dash' }, '—');
  let l2;
  if (!job.enabled || (!job.nextFire && hasAfterReset(job.schedule)) || !job.nextFire) {
    l2 = dash();
  } else {
    l2 = el('span', { class: 'mono' }, `next ${fmtWhen(job.nextFire, now)} · ${relIn(job.nextFire, now)}`);
  }
  return el('div', { class: 'cell' }, [
    el('div', { class: 'cell__l1 t-body' }, scheduleDescribe(job.schedule)),
    el('div', { class: 'cell__l2' }, l2),
  ]);
}

function stateCell(job, rowState) {
  const dotCls = `state__dot ${dotClass(rowState.dotForm)}`.trim();
  const labelNode = rowState.link
    ? el('a', { href: `#runs?job=${job.id}`, style: 'color:inherit;', 'data-tip': rowState.label === 'running' ? null : 'Full run history for this job lives in Runs' }, rowState.label)
    : el('span', {}, rowState.label);
  return el('div', { class: 'cell' }, [
    el('div', { class: 'cell__l1' }, el('span', { class: `state ${rowState.stateClass ? `state--${rowState.stateClass}` : ''}`.trim() }, [
      el('span', { class: dotCls }),
      labelNode,
    ])),
    el('div', { class: 'cell__l2' }, rowState.l2 || null),
  ]);
}

function rowActions(job, rowState) {
  const alreadyRunning = rowState.label === 'running';
  const runAttrs = {
    label: alreadyRunning ? 'Already running — manage it from Runs' : 'Run now — asks first if a pause blocks it',
    svgHtml: SVG_PLAY,
    disabled: alreadyRunning,
    onclick: alreadyRunning ? undefined : () => runJob(job),
  };
  // Not data-mutating: this disable is a business-state fact ("it's already
  // running"), not connectivity — the central sweep's re-enable-on-healthy
  // would otherwise wrongly re-arm it while the job is still running.
  if (!alreadyRunning) runAttrs['data-mutating'] = true;
  const runBtn = iconBtn(runAttrs);

  const editBtn = iconBtn({
    label: 'Edit — saving asks for your approval', svgHtml: SVG_EDIT, 'data-mutating': true,
    onclick: () => openJobDialog({ job, onSaved: loadAndRender }),
  });
  const cloneBtn = iconBtn({
    label: 'Clone into a new job', svgHtml: SVG_CLONE, 'data-mutating': true,
    onclick: () => openJobDialog({ job, clone: true, onSaved: loadAndRender }),
  });
  const delBtn = iconBtn({
    label: 'Delete this job — its run history stays', svgHtml: SVG_DELETE, 'data-mutating': true,
    onclick: () => deleteJob(job),
  });

  const sw = el('input', {
    class: 'switch',
    type: 'checkbox',
    checked: job.enabled,
    'data-mutating': true,
    'aria-label': job.enabled ? 'Disable schedule' : 'Enable schedule',
    'data-tip': job.enabled ? 'Enabled — turn off to stop scheduling' : 'Disabled — enabling asks for your approval',
  });
  sw.addEventListener('change', () => toggleJob(job, sw));

  return el('div', { class: 'rowact' }, [runBtn, editBtn, cloneBtn, delBtn, sw]);
}

function buildRow(job, ctx) {
  const rowState = computeRowState(job, ctx);
  const cls = `row jobrow${job.enabled ? '' : ' jobrow--disabled'}`;
  const attrs = { class: cls };
  if (job.enabled && rowState.stateClass && rowState.stateClass !== 'ok') attrs['data-state'] = rowState.stateClass;
  return el('div', attrs, [
    typeCell(job),
    jobCell(job),
    scheduleCell(job, ctx.now),
    stateCell(job, rowState),
    rowActions(job, rowState),
  ]);
}

function headerRow() {
  return el('div', { class: 'row row--head jobrow' }, [
    el('span', {}),
    el('span', {}, 'Job'),
    el('span', {}, 'Schedule · next fire'),
    el('span', {}, 'Last run'),
    el('span', { style: 'text-align:right;' }, 'Actions'),
  ]);
}

function buildTable(jobs) {
  const now = Date.now();
  const ctx = { attention: attentionByJobId(state.overview), running: runningByJobId(state.overview), now };
  const rows = el('div', { class: 'rows' }, [headerRow(), ...jobs.map((j) => buildRow(j, ctx))]);
  return el('section', { class: 'card' }, rows);
}

// ---------------- empty / no-match states ----------------

function emptyCard() {
  return el('section', { class: 'card' }, el('div', { class: 'card__body' }, el('div', { class: 'blank', style: 'border:0;background:transparent;padding:26px 8px;' }, [
    el('span', { class: 'blank__icon', html: SVG_CLOCK }),
    el('div', {}, [
      el('h4', {}, 'Nothing is scheduled'),
      el('p', {}, 'LaunchBox is running and watching your usage, but it has no work to do. A job is a Claude prompt or a shell command on a schedule — cron, one-shot, or anchored to your next usage reset.'),
      el('div', { class: 'blank__act' }, [
        el('button', { class: 'btn btn--primary', 'data-mutating': true, onclick: () => openJobDialog({ onSaved: loadAndRender }) }, 'Create the first job'),
        el('a', { class: 'btn', href: '#projects' }, 'Or point it at a beads backlog'),
      ]),
    ]),
  ])));
}

function noMatchCard(total) {
  return el('section', { class: 'card' }, el('div', { class: 'card__body' }, el('div', { class: 'blank', style: 'border:0;background:transparent;padding:22px 8px;' }, [
    el('span', { class: 'blank__icon', html: SVG_SEARCH_LG }),
    el('div', {}, [
      el('h4', {}, `No job matches "${state.query}"`),
      el('p', {}, `Names, schedule text and commands of all ${total} jobs were checked. The filter matches as you type — clear it to see everything.`),
      el('div', { class: 'blank__act' }, [
        el('button', { class: 'btn', onclick: () => { state.query = ''; renderList(); } }, 'Clear the filter'),
      ]),
    ]),
  ])));
}

// ---------------- toolbar + list (kept separate from pagehead so typing in
// the filter box never rebuilds — and steals focus from — the input itself)
// ----------------

function renderList() {
  const host = state.listHost;
  if (!host) return;
  clear(host);
  const filtered = filterJobs(state.jobs, { query: state.query, type: state.type });
  host.appendChild(filtered.length ? buildTable(filtered) : noMatchCard(state.jobs.length));
}

function toolbar() {
  const counts = { all: state.jobs.length, claude: 0, command: 0 };
  for (const j of state.jobs) counts[j.type] = (counts[j.type] ?? 0) + 1;

  const search = el('input', { type: 'text', id: 'jobs-search', placeholder: 'Filter by name, schedule or command…', value: state.query });
  search.addEventListener('input', () => { state.query = search.value; renderList(); });
  const searchLabel = el('label', { class: 'search' }, [svgNode(SVG_SEARCH_SM), search]);

  const segsEl = el('div', { class: 'segs' });
  for (const [val, label] of [['all', 'All'], ['claude', 'Claude'], ['command', 'Shell']]) {
    const btn = el('button', { class: 'seg', 'aria-selected': state.type === val ? 'true' : null }, [
      `${label} `, el('span', { class: 'seg__count' }, String(counts[val] ?? 0)),
    ]);
    btn.addEventListener('click', () => {
      state.type = val;
      for (const b of segsEl.querySelectorAll('.seg')) b.removeAttribute('aria-selected');
      btn.setAttribute('aria-selected', 'true');
      renderList();
    });
    segsEl.appendChild(btn);
  }

  return el('div', { class: 'toolbar' }, [searchLabel, segsEl]);
}

// ---------------- top-level render ----------------

function render() {
  const page = $('#v2-page');
  if (!page) return;

  const prevSearch = $('#jobs-search');
  const hadFocus = !!prevSearch && document.activeElement === prevSearch;
  const selStart = hadFocus ? prevSearch.selectionStart : null;

  clear(page);
  state.listHost = null;

  const jobs = state.jobs;
  const enabledCount = jobs.filter((j) => j.enabled).length;

  page.appendChild(pageHead({
    title: 'Jobs',
    sub: jobs.length
      ? el('span', {}, [
        el('span', { class: 'mono' }, String(jobs.length)), ' jobs · ',
        el('span', { class: 'mono' }, String(enabledCount)), ' enabled · ',
        el('span', { class: 'mono' }, String(state.running)), ' running',
      ])
      : 'No jobs yet',
    actions: jobs.length ? [
      el('button', {
        class: 'btn', disabled: true,
        'data-tip': 'Burn-down planning ships in a later bead (claude-scheduler-btv.12, D2) — not yet available',
      }, [svgNode(SVG_CLOCK), 'Plan burn-down…']),
      el('button', {
        class: 'btn btn--primary', 'data-mutating': true,
        onclick: () => openJobDialog({ onSaved: loadAndRender }),
      }, [svgNode(SVG_PLUS), 'New job']),
    ] : [
      el('button', {
        class: 'btn btn--primary', 'data-mutating': true,
        onclick: () => openJobDialog({ onSaved: loadAndRender }),
      }, [svgNode(SVG_PLUS), 'New job']),
    ],
  }));

  if (!jobs.length) {
    page.appendChild(emptyCard());
    return;
  }

  page.appendChild(toolbar());
  const listHost = el('div', { id: 'jobs-list-host' });
  page.appendChild(listHost);
  state.listHost = listHost;
  renderList();

  if (hadFocus) {
    const s = $('#jobs-search');
    if (s) {
      s.focus();
      if (selStart != null) s.setSelectionRange(selStart, selStart);
    }
  }
}

function ensureRouteWatcher() {
  if (routeWatcherArmed) return;
  routeWatcherArmed = true;
  onRender((route) => {
    if (route !== 'jobs' && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });
}

export default function jobs(params) {
  void params; // no deep-link query params defined for this route yet
  ensureRouteWatcher();
  if (!pollTimer) {
    loadExtensionNames();
    loadAndRender();
    pollTimer = setInterval(loadAndRender, POLL_MS);
    pollTimer.unref?.();
  } else {
    render(); // already polling (e.g. re-registered route render) — just repaint from current state
  }
}
