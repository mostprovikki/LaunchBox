// Project detail page (claude-scheduler-btv.9 / C2). Mockup:
// redesign/project-detail.html. Route `#project?id=<projectId>`.
//
// Three cards the list cannot afford: the ready-bead table (one blocking `bd`
// call, which server.js's decorateProject explicitly refuses to make per row),
// this project's recent scheduler activity, and the repo's declared config.
//
// Since claude-scheduler-btv.24 this is a Workbench (docs/design/launchbox.md
// §5; Option 2 of docs/design/mockups/project-flavours.html): Burst… is the
// primary, activate/pause the one state control, and Poll now / Dependency
// graph / Review queue / Remove project… sit in a ⋯ menu.
//
// Endpoints reused unchanged: GET /api/projects, GET /api/projects/:id/ready,
// POST /api/projects/:id/poll, PUT/DELETE /api/projects/:id, GET /api/jobs,
// GET /api/runs, GET /api/bursts, GET /api/pause,
// GET /api/v2/projects/:id/branches. Nothing new was needed.
//
// Two claims from the mockup are NOT rendered here and the reasons are in
// projects-logic.js's header: "of 23 open" (no open-bead count exists) and the
// "Not ready: 11 blocked · 8 missing the label" coverage breakdown (the
// adapter never sees a bead that failed either filter). The third refusal, the
// "handed back" run state, is lifted: claude-scheduler-dc9 persisted the
// outcome as runs.beadOutcome, so the activity list draws that chip now.
import { api, failureToast, guardedSubmit } from '../api.js';
import { $, el, clear, pageHead, toast, iconBtn } from '../ui.js';
import { onRender } from '../router.js';
import { statusMeta, beadRunStateKey } from '../state-vocab.js';
import {
  fmtDate, fmtHm, relAgo, isResume, cardBanner, burstProjectIds, chipFor, claimOrder, priorityPill,
  shortBeadId, unblocksText, permModeText, stateControl, projectBurst,
} from './projects-logic.js';
import { openBurstDialog } from './plan-dialogs.js';
import { openLogDrawer } from './runs-log.js';

const POLL_MS = 8000;

const SVG_WARN = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>';
const SVG_CLOCK = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>';
const SVG_BEAD = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>';

const state = {
  id: null, project: null, ready: null, jobs: [], runs: [], burst: null, meta: null, failed: false,
  pauseMode: 'off', waiting: null, waitingAt: 0,
};
// True only while this page owns #v2-page. See render()'s guard.
let mounted = false;
let pollTimer = null;
let routeWatcherArmed = false;

function svgNode(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

// ---------------- data ----------------

// The waiting-to-merge count costs a git walk plus a `bd show` per branch
// (server.js's GET /api/v2/projects/:id/branches), so it is not re-read on
// every 8s tick: on open, after a Poll now, and at most once a minute.
const WAITING_MS = 60000;

async function loadAndRender({ forceWaiting = false } = {}) {
  if (!state.id) { paint(); return; }
  try {
    const data = await api('GET', '/api/projects');
    state.meta = data;
    state.project = (data.projects ?? []).find((p) => p.id === state.id) ?? null;
    state.failed = false;
  } catch {
    // Keep whatever was already on screen rather than blanking the page —
    // see projects.js's unreachableCard() comment (claude-scheduler-7j2).
    if (!state.project) state.failed = true;
  }
  if (!state.project) { paint(); return; }

  // `bd ready` is a blocking call against the repo's database; it is fetched
  // once per render pass here (and never in the list), which is the whole
  // reason the ready table lives on this page.
  try {
    state.ready = await api('GET', `/api/projects/${state.id}/ready`);
  } catch (err) {
    state.ready = { error: failureToast(err) ?? 'could not read ready work', beads: [] };
  }
  try {
    const [jobsRes, runsRes, burstRes, pauseRes] = await Promise.all([
      api('GET', '/api/jobs'),
      api('GET', '/api/runs?limit=200'),
      api('GET', '/api/bursts').catch(() => ({ active: null })),
      api('GET', '/api/pause').catch(() => null),
    ]);
    state.jobs = jobsRes.jobs ?? [];
    state.runs = runsRes.runs ?? [];
    state.burst = burstRes?.active ?? null;
    // A burst started while paused plans and then starts nothing, so Burst…
    // says so up front (projectBurst). Unknown mode leaves the last one.
    state.pauseMode = pauseRes?.mode ?? state.pauseMode;
  } catch { /* the runs list degrades to its own empty state */ }
  if (forceWaiting || !state.waitingAt || Date.now() - state.waitingAt > WAITING_MS) {
    try {
      const out = await api('GET', `/api/v2/projects/${encodeURIComponent(state.id)}/branches`);
      state.waiting = (out?.branches ?? []).length;
      state.waitingAt = Date.now();
    } catch {
      // 503 without a branches engine, 502 on a git failure: the strip is
      // simply not drawn — the Inbox owns the full, explained queue.
    }
  }
  paint();
}

// A re-render rebuilds #v2-page, which would snatch an open ⋯ menu out from
// under the reader every 8s. The poll's paint waits until the menu closes.
let deferredPaint = false;
function paint() {
  if (menu.open) { deferredPaint = true; return; }
  deferredPaint = false;
  render();
}

// ---------------- actions ----------------

async function onAction(act, btn) {
  const p = state.project;
  if (!p) return;
  try {
    if (act === 'activate') {
      // The airlock, restated in full on this page too — a reader who arrived
      // by deep link has not seen the list's sentence about it.
      // eslint-disable-next-line no-alert
      if (!isResume(p) && !window.confirm(`Activate "${p.name}"?\n\n`
        + `From now on LaunchBox will start ready beads from ${p.path} on its own, unattended — `
        + `every bead that is open, unblocked and carries the `
        + `${p.config?.autoLabel ? `"${p.config.autoLabel}"` : 'configured autoLabel'} label, with no `
        + `further prompt, including while you are away from the machine.\n\n`
        + `Pause stops it again at any time.`)) return;
      let out = null;
      const ok = await guardedSubmit(btn, async () => {
        out = await api('PUT', `/api/projects/${p.id}`, { state: 'active' });
      }, toast);
      if (!ok) return;
      const why = [...(out?.reasons ?? []), ...(out?.warnings ?? [])];
      toast(why.length ? `Activated, but nothing will run yet — ${why.join(' · ')}` : `"${p.name}" is active`, why.length ? '' : 'ok');
    } else if (act === 'pause') {
      await api('PUT', `/api/projects/${p.id}`, { state: 'paused' });
      toast(`"${p.name}" paused — nothing new starts from it`);
    } else if (act === 'poll') {
      const r = await api('POST', `/api/projects/${p.id}/poll`);
      toast(r.skipped === true
        ? `Not polled — ${r.reasons?.join(' · ') || 'nothing to do'}`
        : `${r.ready?.length ?? 0} ready · started ${r.started?.length ?? 0}`, '', 8000);
    } else if (act === 'remove') {
      if (await removeProject(p)) { location.hash = '#projects'; return; }
    }
  } catch (err) {
    toast(failureToast(err) ?? `${act} failed`, 'err');
  }
  loadAndRender({ forceWaiting: act === 'poll' });
}

// Moved here from the Projects list with its confirms unchanged when that list
// became a Browser (claude-scheduler-btv.20). True when the project is gone.
async function removeProject(p) {
  // eslint-disable-next-line no-alert
  if (!window.confirm(`Stop tracking "${p.name}"?\n\n`
    + 'The repo and its beads are left exactly as they are — this only stops LaunchBox looking at '
    + 'them, and deletes the per-bead job rows (with their run history) it created for this project.')) return false;
  try {
    const out = await api('DELETE', `/api/projects/${p.id}`);
    toast(`Stopped tracking "${p.name}"${out?.removedJobs ? ` · ${out.removedJobs} bead job row${out.removedJobs === 1 ? '' : 's'} dropped` : ''}`);
    return true;
  } catch (err) {
    // 409 means a bead of this project is leased to a live run right now.
    // Forcing abandons that lease, so the ids are named before asking again.
    if (err.status !== 409) {
      toast(failureToast(err) ?? 'could not stop tracking that project', 'err');
      return false;
    }
    const held = err.data?.held ?? [];
    // eslint-disable-next-line no-alert
    if (!window.confirm(`${held.length || 'Some'} bead${held.length === 1 ? '' : 's'} from "${p.name}" `
      + `${held.length === 1 ? 'is' : 'are'} still leased to a run: ${held.join(', ')}\n\n`
      + `Removing now abandons ${held.length === 1 ? 'that lease' : 'those leases'} — the run keeps going, `
      + 'but LaunchBox stops tracking the bead.\n\nRemove anyway?')) return false;
    try {
      await api('DELETE', `/api/projects/${p.id}`, { force: true });
      toast(`Stopped tracking "${p.name}" — ${held.length} lease${held.length === 1 ? '' : 's'} abandoned`);
      return true;
    } catch (err2) {
      toast(failureToast(err2) ?? 'could not stop tracking that project', 'err');
      return false;
    }
  }
}

// ---------------- ⋯ menu ----------------
// The mockup's popover (project-flavours.html Option 2): an iconbtn and a
// .card.menu[role=menu]. Escape and an outside click close it and hand focus
// back to ⋯, so a keyboard reader is never left focused on a hidden item.

const menu = { open: false, btn: null, list: null, wrap: null };

function onMenuKey(e) {
  if (e.key === 'Escape') closeMenu();
}
function onMenuOutside(e) {
  if (menu.wrap && !menu.wrap.contains(e.target)) closeMenu();
}

function openMenu() {
  menu.open = true;
  menu.list.hidden = false;
  menu.btn.setAttribute('aria-expanded', 'true');
  document.addEventListener('keydown', onMenuKey);
  document.addEventListener('click', onMenuOutside);
  menu.list.querySelector('[role=menuitem]')?.focus();
}

function closeMenu({ refocus = true } = {}) {
  if (!menu.open) return;
  menu.open = false;
  document.removeEventListener('keydown', onMenuKey);
  document.removeEventListener('click', onMenuOutside);
  if (menu.list) menu.list.hidden = true;
  menu.btn?.setAttribute('aria-expanded', 'false');
  // A poll that landed while the menu was open paints now — BEFORE the
  // refocus, because the paint rebuilds ⋯ and menu.btn then names the new one.
  // Measured in a real browser: the other order left focus on a detached node.
  if (deferredPaint) paint();
  if (refocus) menu.btn?.focus();
}

function moreMenu(p) {
  const btn = iconBtn({
    label: 'More actions', tip: 'Poll now, review queue, dependency graph, remove',
    'aria-haspopup': 'menu', 'aria-expanded': 'false',
  });
  btn.textContent = '⋯';
  const item = (act, label, cls) => {
    const b = el('button', { role: 'menuitem', class: cls, 'data-act': act, 'data-mutating': true }, label);
    b.addEventListener('click', () => { closeMenu(); onAction(act, b); });
    return b;
  };
  // The graph is a read, so it is a link and not data-mutating: it stays
  // openable while the daemon refuses writes (claude-scheduler-vo4.5).
  const graph = el('a', { role: 'menuitem', href: `#graph?id=${encodeURIComponent(p.id)}` }, 'Dependency graph');
  graph.addEventListener('click', () => closeMenu({ refocus: false }));
  // §7: "Review queue" left the header for this menu (claude-scheduler-1xy). A
  // link, like the graph: navigating is a read; merging asks for Touch ID there.
  const review = el('a', { role: 'menuitem', href: `#review?id=${encodeURIComponent(p.id)}` }, 'Review queue');
  review.addEventListener('click', () => closeMenu({ refocus: false }));
  const list = el('div', { class: 'card menu', role: 'menu', 'aria-label': 'More actions', hidden: true }, [
    item('poll', 'Poll now'),
    review,
    graph,
    item('remove', 'Remove project…', 'danger'),
  ]);
  btn.addEventListener('click', () => (menu.open ? closeMenu() : openMenu()));
  const wrap = el('span', { style: 'position:relative;display:inline-flex;' }, [btn, list]);
  Object.assign(menu, { btn, list, wrap });
  return wrap;
}

// ---------------- pieces ----------------

function chipEl(meta, style) {
  return el('span', { class: `state state--${meta.cls}`, style }, [
    el('span', { class: `state__dot ${meta.dot}`.trim() }),
    meta.label,
  ]);
}

function headerActions(p) {
  const b = projectBurst(p, { pauseMode: state.pauseMode, burstLive: !!state.burst });
  // Disabled for a business reason (pause, a live burst, not active), so it
  // carries no data-mutating: the degraded-state sweep must not revive it.
  const burst = el('button', {
    class: 'btn btn--primary',
    disabled: b.disabled,
    'data-mutating': b.disabled ? null : true,
    'data-tip': b.tip,
  }, 'Burst…');
  if (!b.disabled) burst.addEventListener('click', () => openBurstDialog({ projectId: p.id, onStarted: loadAndRender }));

  const s = stateControl(p);
  const ctl = el('button', { class: 'btn', 'data-mutating': true, 'data-tip': s.tip, 'data-act': s.act }, s.label);
  ctl.addEventListener('click', () => onAction(s.act, ctl));

  return [burst, ctl, moreMenu(p)];
}

// "N waiting to merge" — only when there is something to merge (§5). Merging
// is the Inbox's job, so the strip points there; this project's own queue is
// in the ⋯ menu (claude-scheduler-1xy).
function waitingStrip(p) {
  const n = state.waiting ?? 0;
  if (!(n > 0)) return null;
  return el('div', { class: 'banner banner--info', 'data-waiting': true, style: 'margin: -6px 0 14px;' }, el('span', {}, [
    el('b', {}, `${n} branch${n === 1 ? '' : 'es'} waiting to merge`),
    ' from this project. ',
    el('a', { href: '#inbox' }, 'Review in Inbox →'),
  ]));
}

function factCard(key, label, value, sub, { big = false, foot = null, mono = false } = {}) {
  return el('section', { class: 'card', 'data-fact': key }, el('div', { style: 'padding: 12px 16px;' }, [
    el('div', { class: 't-eyebrow' }, label),
    el('div', {
      class: mono ? 'mono' : null,
      style: `font-size:${big ? 34 : 22}px;font-weight:600;font-variant-numeric:tabular-nums;margin:2px 0;`,
    }, value),
    sub ? el('div', { class: 't-meta' }, sub) : null,
    foot,
  ]));
}

// Three facts (§5): Ready (wider, larger), Running here, Permission mode. Auto
// label, last poll, leases and min headroom were cut on 2026-09-26 (§7); the
// label and timeout live in the Declared config summary instead.
function factsRow(p) {
  const held = p.leases?.held ?? 0;
  const mode = p.config?.defaults?.permMode;
  const pollBtn = el('button', {
    class: 'btn btn--ghost', style: 'margin-left:auto;padding:4px 10px;',
    'data-mutating': true, 'data-tip': 'Re-read bd ready now',
  }, '↻ Poll now');
  pollBtn.addEventListener('click', () => onAction('poll', pollBtn));
  const foot = el('div', {
    class: 't-meta',
    style: 'display:flex;align-items:center;gap:10px;margin-top:10px;padding-top:10px;border-top:1px solid var(--line-2);',
  }, [el('span', {}, p.lastPollAt ? `polled ${relAgo(p.lastPollAt)}` : 'never polled'), pollBtn]);
  return el('div', {
    style: 'display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr) minmax(0,1fr);gap:14px;margin-bottom:16px;',
  }, [
    factCard('ready', 'Ready', p.ready?.count == null ? '—' : String(p.ready.count),
      p.ready?.count == null ? 'never successfully polled' : null, { big: true, foot }),
    factCard('running', 'Running here', String(held),
      held ? `bead${held === 1 ? '' : 's'} checked out to a run right now` : 'no bead claimed right now'),
    factCard('perm', 'Permission mode', mode || '—', permModeText(mode), { mono: true }),
  ]);
}

// Up next and Recent runs share one grid, so short ids and titles start at the
// same x in both lists (§5). The id column is fixed-width for the same reason.
const LIST_COLS = '44px minmax(0,1fr) 104px 96px';
const rowStyle = `grid-template-columns:${LIST_COLS};align-items:center;padding:10px 18px;`;
const SID_STYLE = 'display:inline-block;width:72px;flex:none;font-weight:600;';

function titleLine(id, title) {
  return el('div', { class: 'cell__l1' }, [
    el('span', { class: 'mono', style: SID_STYLE }, shortBeadId(id)),
    el('span', { class: 'row__n' }, title || '(no title)'),
  ]);
}

function beadRow(b) {
  const pill = priorityPill(b.priority);
  return el('div', { class: 'row', 'data-bead': b.id, style: rowStyle }, [
    el('span', {}, pill ? el('span', { class: `pill ${pill.cls}` }, pill.label) : null),
    el('div', { class: 'cell' }, [
      titleLine(b.id, b.title),
      // Type is neutral grey: red and yellow are reserved for run state and
      // priority (launchbox.md §6).
      el('div', { class: 'cell__l2', style: 'padding-left:80px;' },
        b.type ? el('span', { class: 't-meta', 'data-type': true }, b.type) : null),
    ]),
    el('span', { class: 't-meta', style: 'text-align:right;white-space:nowrap;' }, unblocksText(b) ?? ''),
    el('span', { class: 't-meta', style: 'text-align:right;white-space:nowrap;' },
      b.createdAt ? `filed ${relAgo(b.createdAt)}` : ''),
  ]);
}

function upNextCard(p) {
  const r = state.ready;
  const beads = claimOrder(r?.beads ?? []);

  const body = [];
  if (r?.error) {
    body.push(el('div', { class: 'card__body' }, el('div', { class: 'banner' }, [
      svgNode(SVG_WARN), el('span', {}, [el('b', {}, 'Could not read ready work.'), ` ${r.error}`]),
    ])));
  } else if (r?.busy) {
    body.push(el('div', { class: 'card__body' }, el('div', { class: 'banner' }, [
      svgNode(SVG_CLOCK),
      el('span', {}, [
        el('b', {}, 'Beads database busy.'),
        ' Something else holds the lock — most likely an interactive bd session. This is busy, not '
        + 'broken: LaunchBox backs off and retries. The list below is what it last managed to read.',
      ]),
    ])));
  }
  for (const reason of r?.reasons ?? []) {
    body.push(el('div', { class: 'card__body' }, el('p', { class: 't-meta', style: 'margin:0;' }, reason)));
  }

  if (beads.length) {
    body.push(el('div', { class: 'rows' }, beads.map(beadRow)));
  } else if (!r?.error) {
    body.push(el('div', { class: 'card__body' }, el('div', { class: 'blank', style: 'border:0;background:transparent;padding:18px 8px;' }, [
      el('span', { class: 'blank__icon', html: SVG_BEAD }),
      el('div', {}, [
        el('h4', {}, 'Nothing is ready to be claimed'),
        el('p', {}, r?.autoLabel
          ? `No bead is open, unblocked and carrying the ${r.autoLabel} label right now.`
          : 'No autoLabel is configured in this repo\'s .scheduler.json, so no bead is eligible.'),
      ]),
    ])));
  }

  return el('section', { class: 'card', style: 'margin-bottom: 16px;' }, [
    el('div', { class: 'card__head' }, [
      el('h2', {}, 'Up next'),
      el('span', { class: 't-meta' }, String(beads.length)),
      el('a', {
        class: 't-meta', style: 'margin-left:auto;', href: `#graph?id=${encodeURIComponent(p.id)}`,
        'data-tip': 'Every bead in this project and what blocks what',
      }, 'graph →'),
    ]),
    ...body,
  ]);
}

// Runs of this project's per-bead jobs. There is no /api/runs?project= filter
// and the API policy is additive-only, so the join is done here from two calls
// that already exist: a bead job carries `params._projectId` / `params._beadId`
// (lib/db.js's findJobByBead reads the same keys).
function projectRuns(p) {
  const jobById = new Map();
  for (const j of state.jobs) {
    if (j.params?._projectId === p.id) jobById.set(j.id, j);
  }
  return state.runs
    .filter((r) => jobById.has(r.jobId))
    .slice(0, 8)
    .map((r) => ({ run: r, job: jobById.get(r.jobId) }));
}

function runRow(p, { run, job }) {
  // The dot and the status word both come from beadRunStateKey: a run that
  // exited ok but never signalled TASK-COMPLETE reads "handed back" (off
  // runs.beadOutcome; claude-scheduler-dc9), so "ok" here means the bead closed.
  const m = statusMeta(beadRunStateKey(run));
  const when = run.finishedAt ?? run.startedAt;
  const dur = run.startedAt && run.finishedAt
    ? `${Math.max(0, Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000))}s`
    : null;
  // lib/projects.js names a bead job "<project>: <bead title>"; the project is
  // the page title already.
  const prefix = `${p.name}: `;
  const title = job.name?.startsWith(prefix) ? job.name.slice(prefix.length) : job.name;
  const row = el('a', {
    class: 'row row--link', 'data-run': run.id, href: `#runs?job=${encodeURIComponent(run.jobId)}`,
    style: `${rowStyle}text-decoration:none;`, 'data-tip': 'Open the run log',
  }, [
    el('span', { class: `state state--${m.cls}`, 'aria-hidden': 'true', style: 'justify-content:center;' },
      el('span', { class: `state__dot ${m.dot}`.trim() })),
    el('div', { class: 'cell' }, [
      titleLine(job.params?._beadId ?? '', title),
      el('div', { class: 'cell__l2', 'data-line2': true, style: 'padding-left:80px;' }, [
        m.label, dur ? ' · ' : null, dur ? el('span', { class: 'mono' }, dur) : null,
      ].filter(Boolean)),
    ]),
    el('span', { class: 't-meta', style: 'text-align:right;white-space:nowrap;' },
      when ? `${fmtDate(when) ?? ''} ${fmtHm(when) ?? ''}`.trim() : ''),
    el('span', { class: 't-meta', style: 'text-align:right;' }, 'Log →'),
  ]);
  row.addEventListener('click', (e) => {
    e.preventDefault();
    openLogDrawer(run, { jobName: job.name, jobExists: true, triggerEl: row });
  });
  return row;
}

function runsCard(p) {
  const rows = projectRuns(p);
  return el('section', { class: 'card', style: 'margin-bottom: 16px;' }, [
    el('div', { class: 'card__head' }, [
      el('h2', {}, 'Recent runs'),
      el('a', { class: 't-meta', style: 'margin-left:auto;', href: '#runs' }, 'all in Runs →'),
    ]),
    rows.length
      ? el('div', { class: 'rows' }, rows.map((x) => runRow(p, x)))
      : el('div', { class: 'card__body' }, el('p', { class: 't-meta', style: 'margin:0;' },
        'No bead of this project has been run yet. A run appears here once LaunchBox claims a bead '
        + 'and starts it in a worktree.')),
  ]);
}

// Collapsed by default (§5): the config is read when changing it, not at rest.
function configCard(p) {
  const cfg = p.config ?? {};
  const errors = p.configErrors ?? [];
  const bits = [
    cfg.autoLabel ? ['auto label ', el('span', { class: 'mono' }, cfg.autoLabel)] : 'no auto label',
    cfg.defaults?.timeoutMin ? `timeout ${cfg.defaults.timeoutMin} min` : null,
    Array.isArray(cfg.gates) && cfg.gates.length ? `gates ${cfg.gates.join(', ')}` : null,
  ].filter(Boolean);
  return el('section', { class: 'card' }, el('details', {}, [
    el('summary', { class: 't-meta', style: 'cursor:pointer;padding:12px 16px;' },
      ['Declared config', ...bits.flatMap((b) => [' · ', b])]),
    el('div', { style: 'padding: 0 16px 14px;' }, [
      el('pre', { class: 'snippet' }, JSON.stringify(cfg, null, 2)),
      errors.length
        ? el('div', { class: 'banner', style: 'margin-top: 10px;' }, [
          svgNode(SVG_WARN),
          el('span', {}, [el('b', {}, 'This file cannot be used as declared.'), ` ${errors.join(' · ')}`]),
        ])
        : null,
      el('p', { class: 't-meta', style: 'margin: 10px 0 0;' },
        'The repo declares what it allows; LaunchBox never exceeds it. Changing this file takes effect '
        + 'on the next poll — no re-activation needed.'),
    ]),
  ]));
}

// ---------------- top-level render ----------------

function missingCard(msg) {
  return el('section', { class: 'card' }, el('div', { class: 'card__body' }, el('div', { class: 'blank', style: 'border:0;background:transparent;padding:24px 8px;' }, [
    el('span', { class: 'blank__icon', html: SVG_WARN }),
    el('div', {}, [
      el('h4', {}, msg),
      el('div', { class: 'blank__act' }, [el('a', { class: 'btn', href: '#projects' }, 'Back to Projects')]),
    ]),
  ])));
}

function render() {
  const page = $('#v2-page');
  if (!page) return;
  // An in-flight load from BEFORE a route change must not paint over the page
  // that now owns #v2-page. Clearing the poll timer on route change does not
  // cover this: the request already in the air still resolves and calls
  // render(), which clears #v2-page and rebuilds it for a route the reader has
  // already left. Measured in a real browser during C2's verification
  // (claude-scheduler-btv.9) — Projects → project detail → Projects rendered
  // the DETAIL page under the Projects route, and the reverse going back.
  if (!mounted) return;
  deferredPaint = false;
  closeMenu({ refocus: false });
  clear(page);

  if (!state.id) {
    page.appendChild(pageHead({ title: 'Project' }));
    page.appendChild(missingCard('No project id in the link'));
    return;
  }
  const p = state.project;
  if (!p) {
    page.appendChild(pageHead({ title: 'Project' }));
    page.appendChild(missingCard(state.failed
      ? 'Could not reach LaunchBox to load this project'
      : 'That project is not registered any more'));
    return;
  }

  const chip = chipFor(p, burstProjectIds(state.burst));
  const head = pageHead({
    title: p.name,
    sub: el('span', {}, [chipEl(chip, 'font-size:12.5px;'), ' · ', el('span', { class: 'mono' }, p.path)]),
    actions: headerActions(p),
  });
  page.appendChild(el('div', { class: 't-meta', style: 'margin-bottom: 4px;' }, el('a', { href: '#projects' }, '← Projects')));
  page.appendChild(head);

  const banner = cardBanner(p);
  if (banner) {
    page.appendChild(el('div', { class: 'banner', style: 'margin-bottom: 16px;' }, [
      svgNode(banner.kind === 'busy' ? SVG_CLOCK : SVG_WARN),
      el('span', {}, [el('b', {}, banner.title), ' ', banner.body]),
    ]));
  }
  for (const w of p.warnings ?? []) {
    page.appendChild(el('p', { class: 't-meta', style: 'margin: 0 0 12px;' }, w));
  }

  const waiting = waitingStrip(p);
  if (waiting) page.appendChild(waiting);
  page.appendChild(factsRow(p));
  page.appendChild(upNextCard(p));
  page.appendChild(runsCard(p));
  page.appendChild(configCard(p));
}

function ensureRouteWatcher() {
  if (routeWatcherArmed) return;
  routeWatcherArmed = true;
  onRender((route) => {
    mounted = route === 'project';
    if (route !== 'project' && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });
}

export default function project(params) {
  mounted = true;
  ensureRouteWatcher();
  const id = params.get('id');
  const switching = id !== state.id;
  if (switching) {
    // A different project: drop the previous one's data rather than showing it
    // under the new name for one tick.
    Object.assign(state, { id, project: null, ready: null, jobs: [], runs: [], meta: null, failed: false, waiting: null, waitingAt: 0 });
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // Paint the shell BEFORE the first load, not after it. This page's load
  // includes GET /api/projects/:id/ready, which runs a real blocking `bd ready`
  // against the repo — seconds, not milliseconds. Without this the reader
  // clicks "Open project" and the PREVIOUS page stays on screen, unchanged,
  // for the whole of that wait, with nothing to say a navigation happened.
  // Measured in a real browser during C2's verification: the Projects list was
  // still up several seconds after the route had changed to #project.
  // runs.js and overview.js already do this; project.js and projects.js did not.
  if (switching || !pollTimer) {
    const page = $('#v2-page');
    if (page) {
      clear(page);
      page.appendChild(el('div', { class: 't-meta', style: 'margin-bottom: 4px;' }, el('a', { href: '#projects' }, '← Projects')));
      page.appendChild(pageHead({ title: 'Project', sub: 'Reading this project\u2019s beads\u2026' }));
    }
  }

  if (!pollTimer) {
    loadAndRender();
    pollTimer = setInterval(loadAndRender, POLL_MS);
    pollTimer.unref?.();
  } else {
    render();
  }
}
