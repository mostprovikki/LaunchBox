// Projects tab (claude-scheduler-btv.9 / C2). Mockups: redesign/projects.html,
// projects-empty.html, projects-burst-live.html. The pure decisions —
// which actions a row offers, what a card may claim, the burst arithmetic —
// live in public/v2/pages/projects-logic.js, whose header records the five
// mockup strings this page deliberately does NOT render and why.
//
// Endpoints reused unchanged (API policy: additive-only): GET/POST
// /api/projects, POST /api/projects/discover, PUT/DELETE /api/projects/:id,
// POST /api/projects/:id/poll, GET /api/bursts, POST /api/bursts/:id/cancel.
// No new endpoint was needed for this page.
//
// THE ONE THING THIS PAGE MUST NOT GET WRONG: activation is the airlock.
// Nothing here may flip a project to `active` as a side effect of anything
// else — not registering, not discovering, not polling. There is exactly one
// call site for `{ state: 'active' }` below, it is behind an explicit confirm
// that spells out the consequence, and the server raises a Touch ID approval
// on top of that. See server.js's PUT /api/projects/:id comment.
import { api, failureToast, degradedReason, guardedSubmit } from '../api.js';
import { $, el, clear, pageHead, iconBtn, toast, setDisabledReason, asOfEl } from '../ui.js';
import { onRender } from '../router.js';
import {
  fmtTime, fmtDate, projectActions, summaryBits, cardBanner,
  burstSummary, burstProjectIds, chipFor, filterProjects, listSubline,
} from './projects-logic.js';

const POLL_MS = 5000;

const SVG_SEARCH_SM = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7L10 5H5a2 2 0 0 0-2 2Z"/></svg>';
const SVG_DISCOVER = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
const SVG_BOLT = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>';
const SVG_WARN = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>';
const SVG_CLOCK = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>';
const SVG_FOLDER = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7L10 5H5a2 2 0 0 0-2 2Z"/></svg>';
const SVG_TRASH = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';

// The audit disclosure is a constraint, not a nicety: a completed bead appends
// a line to the repo's git-tracked .beads/interactions.jsonl and that cannot
// be suppressed. The server owns the wording (`auditNote`); this fallback
// exists only so a response missing the field degrades to the same disclosure
// rather than to silence. Copied in spirit from public/projects.js's
// AUDIT_FALLBACK — /v2 owns its own modules, so it is not imported.
const AUDIT_FALLBACK = 'When the scheduler closes a bead, bd appends one line to '
  + '.beads/interactions.jsonl in that repo. That file is git-tracked and the append cannot be '
  + 'suppressed, so expect one modified file per completed bead. It is an audit trail, not damage.';

const state = { data: null, burst: null, query: '', asOf: null, listHost: null };
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

async function loadAndRender() {
  try {
    state.data = await api('GET', '/api/projects');
    state.asOf = new Date();
  } catch {
    // api() has already flipped the global degraded banner and the sweep.
    // Deliberately NOT clearing state.data: a page that blanks itself on a
    // failed refresh strands the reader with nothing (claude-scheduler-7j2).
  }
  try {
    const { active } = await api('GET', '/api/bursts');
    state.burst = active ?? null;
  } catch {
    // 503 when this process has no burst engine; leave whatever we had.
  }
  render();
}

// ---------------- actions ----------------

// The airlock's confirm. Spelled out rather than "Are you sure?" because this
// is the only click in /v2 that lets a repo's backlog start running itself.
function confirmActivate(p) {
  const label = p.config?.autoLabel;
  // eslint-disable-next-line no-alert
  return window.confirm(`Activate "${p.name}"?\n\n`
    + `From now on LaunchBox will start ready beads from ${p.path} on its own, unattended — `
    + `every bead that is open, unblocked and carries the ${label ? `"${label}"` : 'configured autoLabel'} `
    + `label, with no further prompt, including while you are away from the machine.\n\n`
    + `Registering and discovering a project run nothing; this is the step that does.\n\n`
    + `Pause stops it again at any time.`);
}

async function activateProject(p, btn) {
  if (!confirmActivate(p)) return;
  let out = null;
  const ok = await guardedSubmit(btn, async () => {
    out = await api('PUT', `/api/projects/${p.id}`, { state: 'active' });
  }, toast);
  if (!ok) return;
  // Activating something that still cannot contribute is legal and common (no
  // autoLabel, bd missing). Say so now rather than leaving the reader to
  // wonder later why an active project never does anything.
  const why = [...(out?.reasons ?? []), ...(out?.warnings ?? [])];
  toast(why.length ? `Activated, but nothing will run yet — ${why.join(' · ')}` : `"${p.name}" is active`, why.length ? '' : 'ok');
}

async function deleteProject(p) {
  // eslint-disable-next-line no-alert
  if (!window.confirm(`Stop tracking "${p.name}"?\n\n`
    + 'The repo and its beads are left exactly as they are — this only stops LaunchBox looking at '
    + 'them, and deletes the per-bead job rows (with their run history) it created for this project.')) return;
  try {
    const out = await api('DELETE', `/api/projects/${p.id}`);
    toast(`Stopped tracking "${p.name}"${out?.removedJobs ? ` · ${out.removedJobs} bead job row${out.removedJobs === 1 ? '' : 's'} dropped` : ''}`);
  } catch (err) {
    // 409 means a bead of this project is leased to a live run right now.
    // Forcing abandons that lease, so the ids are named before asking again.
    if (err.status !== 409) {
      toast(failureToast(err) ?? 'could not stop tracking that project', 'err');
      return;
    }
    const held = err.data?.held ?? [];
    // eslint-disable-next-line no-alert
    if (!window.confirm(`${held.length || 'Some'} bead${held.length === 1 ? '' : 's'} from "${p.name}" `
      + `${held.length === 1 ? 'is' : 'are'} still leased to a run: ${held.join(', ')}\n\n`
      + `Removing now abandons ${held.length === 1 ? 'that lease' : 'those leases'} — the run keeps going, `
      + 'but LaunchBox stops tracking the bead.\n\nRemove anyway?')) return;
    try {
      await api('DELETE', `/api/projects/${p.id}`, { force: true });
      toast(`Stopped tracking "${p.name}" — ${held.length} lease${held.length === 1 ? '' : 's'} abandoned`);
    } catch (err2) {
      toast(failureToast(err2) ?? 'could not stop tracking that project', 'err');
    }
  }
}

// A poll can start runs on an ACTIVE project — that is what active means — but
// it changes no state, so it is not a way around the airlock: a pending project
// answers `skipped` with the reason. Reported verbatim rather than summarised
// to "done", because "3 ready · started 0" with no reason is exactly the silent
// nothing this tab exists to prevent.
function pollSummary(r) {
  if (r.skipped === true) return `Not polled — ${r.reasons?.join(' · ') || 'nothing to do'}`;
  if (r.busy) return `Beads database busy${r.consecutive > 1 ? ` (${r.consecutive} polls in a row)` : ''} — will retry`;
  if (!r.ok) return `Poll failed — ${r.reasons?.join(' · ') || 'unknown reason'}`;
  const held = r.held ? ['nothing started: the schedule is paused'] : [];
  const refused = (Array.isArray(r.skipped) ? r.skipped : []).map((s) => `${s.beadId}: ${s.reason}`);
  return [`${r.ready?.length ?? 0} ready · started ${r.started?.length ?? 0}`,
    ...held, ...refused, ...(r.reasons ?? []), ...(r.warnings ?? [])].join(' · ');
}

async function onAction(p, act, btn) {
  try {
    if (act === 'activate') {
      await activateProject(p, btn);
    } else if (act === 'pause') {
      await api('PUT', `/api/projects/${p.id}`, { state: 'paused' });
      toast(`"${p.name}" paused — nothing new starts from it`);
    } else if (act === 'poll') {
      toast(pollSummary(await api('POST', `/api/projects/${p.id}/poll`)), '', 8000);
    } else if (act === 'delete') {
      await deleteProject(p);
    }
  } catch (err) {
    toast(failureToast(err) ?? `${act} failed`, 'err');
  }
  loadAndRender();
}

async function registerProject(input) {
  const path = input.value.trim();
  if (!path) {
    toast('Enter the path of a repo with a committed .scheduler.json', 'err');
    return;
  }
  try {
    const out = await api('POST', '/api/projects', { path });
    input.value = '';
    const errors = out.errors ?? [];
    toast(errors.length
      ? `Registered "${out.project.name}" as pending, but its config has problems — ${errors.join(' · ')}`
      : `Registered "${out.project.name}" — pending. Nothing runs until you activate it.`,
    errors.length ? 'err' : 'ok', 8000);
  } catch (err) {
    toast(failureToast(err) ?? 'could not register that path', 'err', 8000);
  }
  loadAndRender();
}

async function discoverProjects() {
  try {
    const out = await api('POST', '/api/projects/discover');
    const found = out.found ?? [];
    const created = found.filter((f) => f.created).length;
    toast(found.length
      ? `${found.length} project${found.length === 1 ? '' : 's'} found · ${created} newly registered as pending — discovery starts nothing.`
      : `Nothing found under ${(out.roots ?? []).join(', ') || 'the configured roots'}.`, '', 8000);
  } catch (err) {
    toast(failureToast(err) ?? 'discover failed', 'err', 8000);
  }
  loadAndRender();
}

async function cancelBurst(id) {
  try {
    await api('POST', `/api/bursts/${id}/cancel`);
    toast('Burst cancelled — no further attempts', 'ok');
  } catch (err) {
    toast(failureToast(err) ?? 'could not cancel the burst', 'err');
  }
  loadAndRender();
}

// ---------------- pieces ----------------

function chipEl(meta) {
  return el('span', { class: `state state--${meta.cls}` }, [
    el('span', { class: `state__dot ${meta.dot}`.trim() }),
    meta.label,
  ]);
}

const BANNER_ICON = { busy: SVG_CLOCK, error: SVG_WARN, warn: SVG_WARN };

function bannerEl(banner) {
  return el('div', { class: 'banner' }, [
    svgNode(BANNER_ICON[banner.kind] ?? SVG_WARN),
    el('span', {}, [el('b', {}, banner.title), ' ', banner.body]),
  ]);
}

function actionButtons(p) {
  const nodes = [];
  for (const a of projectActions(p)) {
    const btn = el('button', {
      class: a.primary ? 'btn btn--primary' : 'btn btn--ghost',
      'data-mutating': true,
      'data-tip': a.tip,
      'data-act': a.act,
    }, a.label);
    btn.addEventListener('click', () => onAction(p, a.act, btn));
    nodes.push(btn);
  }
  nodes.push(el('a', { class: 'btn btn--ghost', href: `#project?id=${encodeURIComponent(p.id)}` }, 'Open project'));
  const del = iconBtn({
    label: `Stop tracking ${p.name}`,
    tip: 'Stop tracking this repo — the repo and its beads are left alone',
    svgHtml: SVG_TRASH,
    'data-mutating': true,
  });
  del.addEventListener('click', () => onAction(p, 'delete', del));
  nodes.push(del);
  return el('div', { class: 'pagehead__actions' }, nodes);
}

function projectCard(p, { burstIds, pollSec }) {
  const banner = cardBanner(p);
  const bodyParts = [];

  if (p.state === 'pending') {
    const registered = fmtDate(p.createdAt);
    bodyParts.push(el('p', { class: 't-meta', style: 'margin: 0 0 10px;' },
      // "Discovered on 29 Jul" in the mockup — but discovery and hand
      // registration both just create the row, and nothing records which did
      // it, so this says the half that is true.
      `${registered ? `Registered on ${registered} ` : 'Registered '}with a committed .scheduler.json. `
      + 'LaunchBox will not touch it until you activate it.'));
  } else {
    bodyParts.push(el('span', { class: 't-meta' }, summaryBits(p, { pollSec }).join(' · ')));
  }

  for (const r of p.reasons ?? []) {
    // explain()'s sentences are already plain-language and non-duplicating;
    // the banner above covers config/poll faults, so these are the remaining
    // "why this contributes nothing" lines.
    if (banner && banner.body.includes(r)) continue;
    bodyParts.push(el('div', { class: 't-meta' }, r));
  }
  for (const w of p.warnings ?? []) bodyParts.push(el('div', { class: 't-meta' }, w));
  if (banner) bodyParts.push(bannerEl(banner));

  return el('section', { class: 'card', style: 'margin-bottom: 16px;', 'data-project-id': p.id }, [
    el('div', { class: 'card__head' }, [
      chipEl(chipFor(p, burstIds)),
      el('h2', {}, el('a', { href: `#project?id=${encodeURIComponent(p.id)}`, style: 'color:inherit;' }, p.name)),
      el('span', { class: 't-meta mono' }, p.path),
      actionButtons(p),
    ]),
    el('div', { class: 'card__body', style: p.state === 'pending' ? null : 'padding: 12px 18px;' }, bodyParts),
  ]);
}

function burstStrip() {
  const b = burstSummary(state.burst);
  if (!b) return null;
  const cancel = el('button', { class: 'btn', style: 'margin-left:auto;', 'data-mutating': true }, 'Cancel burst');
  cancel.addEventListener('click', () => cancelBurst(b.id));
  return el('section', { class: 'burststrip', style: 'margin-bottom: 16px;' }, [
    el('span', { class: 'state state--info', style: 'flex:none;' }, [el('span', { class: 'state__dot' }), 'burst']),
    el('span', {}, [
      el('b', {}, `Spending ${b.budgetPct}% of the ${b.windowLabel} window`),
      ` over ready beads · `,
      el('b', {}, String(b.runs)),
      ` run${b.runs === 1 ? '' : 's'} started · `,
      el('b', {}, String(b.attemptsLeft)),
      ` attempt${b.attemptsLeft === 1 ? '' : 's'} left`,
    ]),
    el('div', { class: 'meter__track' }, el('span', { class: 'meter__fill', style: `width:${b.fillPct.toFixed(1)}%` })),
    // "measured" is load-bearing: this is spend that has happened, not the
    // estimate that sized the timetable.
    el('span', { class: 'mono', style: 'font-size:12px;', 'data-tip': 'Measured spend, not the estimate that sized the timetable' },
      `${b.spentPct.toFixed(2)}% / ${b.budgetPct}%`),
    el('span', { class: 't-meta', style: 'color:inherit;' },
      b.nextAt ? `next attempt no sooner than ${fmtTime(b.nextAt)}` : 'no attempts left'),
    cancel,
  ]);
}

function toolbar() {
  const input = el('input', {
    type: 'text', id: 'projects-path',
    placeholder: 'Register a repo by path — it needs a committed .scheduler.json',
  });
  const register = el('button', { class: 'btn', 'data-mutating': true }, 'Register');
  register.addEventListener('click', () => registerProject(input));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') registerProject(input); });
  return el('div', { class: 'toolbar' }, [
    el('label', { class: 'search', style: 'max-width: 480px;' }, [svgNode(SVG_FOLDER), input]),
    register,
  ]);
}

function filterBar() {
  const search = el('input', { type: 'text', id: 'projects-search', placeholder: 'Filter by name or path…', value: state.query });
  search.addEventListener('input', () => { state.query = search.value; renderList(); });
  return el('div', { class: 'toolbar' }, [
    el('label', { class: 'search', style: 'max-width: 360px;' }, [svgNode(SVG_SEARCH_SM), search]),
  ]);
}

function emptyCard(data) {
  const roots = data?.roots ?? [];
  return el('section', { class: 'card' }, el('div', { class: 'card__body' }, el('div', { class: 'blank', style: 'border:0;background:transparent;padding:24px 8px;' }, [
    el('span', { class: 'blank__icon', html: SVG_FOLDER }),
    el('div', {}, [
      el('h4', {}, 'No project can be worked on yet'),
      el('p', {}, 'A project is a repo that tracks its tasks with beads and opts in by committing a '
        + '.scheduler.json declaring an autoLabel.'),
      el('p', {}, roots.length
        ? `Discover scans ${roots.join(', ')}.`
        : 'No project roots are configured either, so Discover has nowhere to look — set roots in Settings.'),
      el('p', {}, 'Even after registering, nothing runs until you activate the project — that click is always yours.'),
      el('div', { class: 'blank__act' }, [
        el('a', { class: 'btn', href: '#settings' }, roots.length ? 'Change project roots' : 'Set project roots'),
      ]),
    ]),
  ])));
}

function noMatchCard(total) {
  const clearBtn = el('button', { class: 'btn' }, 'Clear the filter');
  clearBtn.addEventListener('click', () => { state.query = ''; render(); });
  return el('section', { class: 'card' }, el('div', { class: 'card__body' }, el('div', { class: 'blank', style: 'border:0;background:transparent;padding:22px 8px;' }, [
    el('span', { class: 'blank__icon', html: SVG_DISCOVER }),
    el('div', {}, [
      el('h4', {}, `No project matches "${state.query}"`),
      el('p', {}, `Names and paths of all ${total} registered projects were checked.`),
      el('div', { class: 'blank__act' }, [clearBtn]),
    ]),
  ])));
}

// The whole-tab failure banner. `bd` missing breaks every project at once, so
// it is reported once for the tab rather than repeated as a per-row poll
// failure on every card.
function bdBanner(data) {
  if (!data?.bd?.error) return null;
  return el('div', { class: 'banner', style: 'margin-bottom: 14px;' }, [
    svgNode(SVG_WARN),
    el('span', {}, [
      el('b', {}, `bd is not usable (${data.bd.path || 'bd'}).`),
      ` ${data.bd.error} — no project can be polled until this is fixed.`,
    ]),
  ]);
}

function renderList() {
  const host = state.listHost;
  if (!host) return;
  clear(host);
  const projects = state.data?.projects ?? [];
  const filtered = filterProjects(projects, state.query);
  if (!filtered.length) {
    host.appendChild(noMatchCard(projects.length));
    return;
  }
  const burstIds = burstProjectIds(state.burst);
  const pollSec = state.data?.pollSec ?? null;
  for (const p of filtered) host.appendChild(projectCard(p, { burstIds, pollSec }));
}

// ---------------- top-level render ----------------

// First-load failure has to render SOMETHING: a page that clears itself and
// then throws away the render strands the reader under the global banner with
// a blank rectangle. Same defect A2 found on Settings and btv.7 fixed there;
// filed for Runs as claude-scheduler-7j2.
function unreachableCard() {
  const retry = el('button', { class: 'btn btn--primary' }, 'Try again');
  retry.addEventListener('click', loadAndRender);
  return el('section', { class: 'card' }, el('div', { class: 'card__body' }, el('div', { class: 'blank', style: 'border:0;background:transparent;padding:24px 8px;' }, [
    el('span', { class: 'blank__icon', html: SVG_WARN }),
    el('div', {}, [
      el('h4', {}, 'Could not read your projects'),
      el('p', {}, 'GET /api/projects did not answer, so this list has nothing to show — not even an empty one. '
        + 'Nothing has changed; LaunchBox is simply not reachable from this page right now.'),
      el('div', { class: 'blank__act' }, [retry]),
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

  const prevSearch = $('#projects-search');
  const hadFocus = !!prevSearch && document.activeElement === prevSearch;
  const selStart = hadFocus ? prevSearch.selectionStart : null;

  clear(page);
  state.listHost = null;

  const data = state.data;
  const projects = data?.projects ?? [];

  // D2 (claude-scheduler-btv.12) owns the burst planner dialog. Until it
  // lands the button is present and honestly dead rather than absent —
  // the same treatment jobs.js gives "Plan burn-down…".
  const burstBtn = el('button', {
    class: 'btn',
    disabled: true,
    'data-tip': state.burst
      ? 'A burst is already running — cancel it first'
      : 'The burst planner ships in a later bead (claude-scheduler-btv.12, D2) — not yet available',
  }, [svgNode(SVG_BOLT), 'Start a burst…']);
  const discoverBtn = el('button', { class: 'btn', 'data-mutating': true }, [svgNode(SVG_DISCOVER), 'Discover in project roots']);
  discoverBtn.addEventListener('click', discoverProjects);

  page.appendChild(pageHead({
    title: 'Projects',
    // Never "Loading…" once a load has already failed — the browser leg caught
    // this card reading "Loading…" directly above "Could not read your
    // projects", which contradicts itself.
    sub: data ? listSubline(data).join(' · ') : 'Not loaded',
    actions: [burstBtn, discoverBtn],
  }));

  if (!data) {
    page.appendChild(unreachableCard());
    return;
  }

  const bd = bdBanner(data);
  if (bd) page.appendChild(bd);

  page.appendChild(toolbar());

  const strip = burstStrip();
  if (strip) page.appendChild(strip);

  page.appendChild(el('p', { class: 't-meta', style: 'margin: 0 0 14px;' }, [
    'An ', el('b', {}, 'active'), ' project lets LaunchBox claim ready beads, run them in disposable '
      + 'worktrees, and write results back to that repo\'s tracker. Registering and configuring can be '
      + 'automated; ', el('b', {}, 'activation is always your click'), ' and asks for Touch ID.',
  ]));

  if (!projects.length) {
    page.appendChild(emptyCard(data));
  } else {
    if (projects.length > 4) page.appendChild(filterBar());
    const listHost = el('div', { id: 'projects-list-host' });
    page.appendChild(listHost);
    state.listHost = listHost;
    renderList();
  }

  page.appendChild(el('p', { class: 'pagefoot' }, [
    data.auditNote || AUDIT_FALLBACK,
    state.asOf ? ' · ' : null,
    state.asOf ? asOfEl(state.asOf) : null,
  ]));

  // The delete iconbtn and every action button carry data-mutating, so
  // main.js's central sweep covers them on render. The burst-planner button
  // is disabled for a reason of its own and must NOT be revived by that
  // sweep, which is why it carries no data-mutating attribute.
  setDisabledReason(discoverBtn, degradedReason());

  if (hadFocus) {
    const s = $('#projects-search');
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
    mounted = route === 'projects';
    if (route !== 'projects' && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });
}

export default function projects(params) {
  void params; // no deep-link query params defined for this route
  mounted = true;
  ensureRouteWatcher();
  if (!pollTimer) {
    // Same reason as project.js: paint the shell before the first load rather
    // than leaving whichever page was here before on screen while GET
    // /api/projects and GET /api/bursts are in flight.
    const page = $('#v2-page');
    if (page && !state.data) {
      clear(page);
      page.appendChild(pageHead({ title: 'Projects', sub: 'Loading\u2026' }));
    }
    loadAndRender();
    pollTimer = setInterval(loadAndRender, POLL_MS);
    pollTimer.unref?.();
  } else {
    render();
  }
}
