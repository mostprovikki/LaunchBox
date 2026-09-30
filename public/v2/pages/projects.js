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
// Since claude-scheduler-btv.20 this is a Browser (docs/design/launchbox.md
// §5): one action at rest per row, Burst…, and the row opens the Project page,
// which owns Poll now / Pause / Activate / Remove.
//
// THE ONE THING THIS PAGE MUST NOT GET WRONG: activation is the airlock, and
// this page has no call site for it at all. Nothing here may flip a project to
// `active` — not registering, not discovering, not bursting. The only
// `{ state: 'active' }` in /v2 is on the Project page, behind a confirm, and
// the server raises a Touch ID approval on top of that.
import { api, failureToast, degradedReason } from '../api.js';
import { $, el, clear, pageHead, toast, setDisabledReason, asOfEl } from '../ui.js';
import { onRender } from '../router.js';
import {
  fmtTime, burstSummary, burstProjectIds, listSubline, groupProjects, rowBurst, rowProblem,
} from './projects-logic.js';
import { openBurstDialog } from './plan-dialogs.js';

const POLL_MS = 5000;

const SVG_DISCOVER = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
const SVG_BOLT = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>';
const SVG_WARN = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>';
const SVG_FOLDER = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7L10 5H5a2 2 0 0 0-2 2Z"/></svg>';

// The audit disclosure is a constraint, not a nicety: a completed bead appends
// a line to the repo's git-tracked .beads/interactions.jsonl and that cannot
// be suppressed. The server owns the wording (`auditNote`); this fallback
// exists only so a response missing the field degrades to the same disclosure
// rather than to silence. Copied in spirit from public/projects.js's
// AUDIT_FALLBACK — /v2 owns its own modules, so it is not imported.
const AUDIT_FALLBACK = 'When the scheduler closes a bead, bd appends one line to '
  + '.beads/interactions.jsonl in that repo. That file is git-tracked and the append cannot be '
  + 'suppressed, so expect one modified file per completed bead. It is an audit trail, not damage.';

const state = { data: null, burst: null, pauseMode: 'off', asOf: null, adding: false };
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
  try {
    // A burst started while paused would plan and then start nothing, so the
    // Burst buttons say so up front (rowBurst). Unknown mode leaves the last.
    state.pauseMode = (await api('GET', '/api/pause'))?.mode ?? state.pauseMode;
  } catch {
    // leave whatever we had
  }
  render();
}

// ---------------- actions ----------------

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

// One row per project (Option 2 of docs/design/mockups/projects-flavours.html):
// name + one meta line, the ready count, and at most one action — Burst…. The
// whole row opens the Project page, where Poll now / Pause / Remove now live.
function burstCell(p, ctx) {
  const b = rowBurst(p, ctx);
  if (!b) return el('span', { class: 'p2-act' });
  // Disabled for a business reason (pause, a live burst), so it carries no
  // data-mutating: the degraded-state sweep must not revive it.
  const btn = el('button', {
    class: 'btn',
    disabled: b.disabled,
    'data-mutating': b.disabled ? null : true,
    'data-tip': b.tip,
  }, [svgNode(SVG_BOLT), 'Burst…']);
  if (!b.disabled) btn.addEventListener('click', () => openBurstDialog({ projectId: p.id, onStarted: loadAndRender }));
  return el('span', { class: 'p2-act' }, btn);
}

function readyCell(p) {
  if (p.state === 'paused') return el('span', { class: 'p2-ready t-meta' }, 'not polled');
  if (p.state === 'pending') return el('span', { class: 'p2-ready t-meta' }, 'not activated');
  const count = p.ready?.count;
  return el('span', { class: 'p2-ready' }, count == null
    ? el('span', { class: 't-meta' }, 'ready unknown')
    : [el('b', {}, String(count)), ' ', el('span', { class: 't-meta' }, 'ready')]);
}

function projectRow(p, ctx) {
  const href = `#project?id=${encodeURIComponent(p.id)}`;
  const problem = rowProblem(p);
  const meta = [
    problem ? el('span', { class: 'p2-issue' }, problem) : null,
    problem ? ' · ' : null,
    el('span', { class: 'mono' }, p.path),
    ctx.burstIds.has(p.id) ? ' · in burst' : null,
  ];
  const row = el('div', { class: 'p2-row', 'data-project-id': p.id, style: 'cursor:pointer;' }, [
    el('span', { class: 'p2-row__name' }, [
      el('a', { href, style: 'color:inherit;' }, el('b', {}, p.name)),
      el('div', { class: 't-meta' }, meta),
    ]),
    readyCell(p),
    burstCell(p, ctx),
  ]);
  // The name is the real link (keyboard, middle-click); the rest of the row is
  // a pointer convenience. The Burst button handles its own click.
  row.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    location.hash = href;
  });
  return row;
}

function projectGroups(projects) {
  const ctx = {
    burstIds: burstProjectIds(state.burst),
    burstLive: !!state.burst,
    pauseMode: state.pauseMode,
  };
  const nodes = [];
  for (const g of groupProjects(projects)) {
    nodes.push(el('div', { class: 'p2-group t-eyebrow' }, g.label));
    nodes.push(el('section', { class: 'card p2-list' }, g.projects.map((p) => projectRow(p, ctx))));
  }
  return nodes;
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

// Register + Discover sit behind one footer link (launchbox.md §7, 2026-09-26):
// adding a project is rare, reading the list is the job.
function addSection() {
  if (!state.adding) {
    const link = el('a', { href: '#projects' }, 'Add a project…');
    link.addEventListener('click', (e) => { e.preventDefault(); state.adding = true; render(); });
    return el('div', { class: 'p2-foot t-meta' }, [link, ' — register a repo by path, or discover in project roots']);
  }
  const input = el('input', {
    type: 'text', id: 'projects-path',
    placeholder: 'Register a repo by path — it needs a committed .scheduler.json',
  });
  const register = el('button', { class: 'btn', 'data-mutating': true }, 'Register');
  register.addEventListener('click', () => registerProject(input));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') registerProject(input); });
  const discoverBtn = el('button', { class: 'btn', 'data-mutating': true }, [svgNode(SVG_DISCOVER), 'Discover in project roots']);
  discoverBtn.addEventListener('click', discoverProjects);
  setDisabledReason(discoverBtn, degradedReason());
  return el('div', { class: 'p2-foot' }, [
    el('div', { class: 'toolbar' }, [
      el('label', { class: 'search', style: 'max-width: 480px;' }, [svgNode(SVG_FOLDER), input]),
      register,
      discoverBtn,
    ]),
    el('p', { class: 't-meta', style: 'margin: 6px 0 0;' },
      'Registering and discovering run nothing; activation is a separate click on the project\'s page.'),
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

  clear(page);

  const data = state.data;
  const projects = data?.projects ?? [];

  // "Burst all active…" keeps the all-projects scope of the planner; each
  // row's Burst… scopes it to one. Disabled only for business reasons (a live
  // burst, a global pause), so it carries no data-mutating while disabled: the
  // degraded-state sweep must not revive it.
  const all = state.burst
    ? { disabled: true, tip: 'A burst is already running — cancel it first' }
    : state.pauseMode && state.pauseMode !== 'off'
      ? { disabled: true, tip: `The schedule is paused (${state.pauseMode}). Set pause to Off to burst.` }
      : { disabled: false, tip: 'Spend a fixed slice of your limit on every active project\'s ready beads, then stop' };
  const burstBtn = el('button', {
    class: 'btn',
    disabled: all.disabled,
    'data-mutating': all.disabled ? null : true,
    'data-tip': all.tip,
  }, [svgNode(SVG_BOLT), 'Burst all active…']);
  if (!all.disabled) burstBtn.addEventListener('click', () => openBurstDialog({ onStarted: loadAndRender }));

  page.appendChild(pageHead({
    title: 'Projects',
    // Never "Loading…" once a load has already failed — the browser leg caught
    // this card reading "Loading…" directly above "Could not read your
    // projects", which contradicts itself.
    sub: data ? listSubline(data).join(' · ') : 'Not loaded',
    actions: [burstBtn],
  }));

  if (!data) {
    page.appendChild(unreachableCard());
    return;
  }

  const bd = bdBanner(data);
  if (bd) page.appendChild(bd);

  const strip = burstStrip();
  if (strip) page.appendChild(strip);

  if (!projects.length) page.appendChild(emptyCard(data));
  else for (const n of projectGroups(projects)) page.appendChild(n);

  page.appendChild(addSection());

  page.appendChild(el('p', { class: 'pagefoot' }, [
    data.auditNote || AUDIT_FALLBACK,
    state.asOf ? ' · ' : null,
    state.asOf ? asOfEl(state.asOf) : null,
  ]));
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
