// Sessions tab (claude-scheduler-btv.10 / C3). Mockups: redesign/sessions.html,
// sessions-compact.html, sessions-empty.html. The pure decisions — the model
// mix, the filter/sort, what a card may claim — live in
// public/v2/pages/sessions-logic.js, whose header records the five mockup
// strings this page deliberately does NOT render and why.
//
// Endpoints reused unchanged (API policy: additive-only): GET /api/sessions,
// POST /api/sessions/:id/rename, POST /api/sessions/:id/resume,
// DELETE /api/sessions/:id. No new endpoint was needed.
//
// REVIEW #4 — QUIET DELETE. Deleting a transcript is irreversible and the
// session can never be resumed again, but it is also a routine tidying action
// on a machine with hundreds of them. So it is neither a bare button nor a
// modal: the row ARMS in place, showing the consequence as a sentence next to
// a Cancel and a danger-styled Delete. Nothing is sent until the second click,
// and navigating away or re-rendering disarms it.
import { api, failureToast, degradedReason } from '../api.js';
import { $, el, clear, pageHead, toast, setDisabledReason } from '../ui.js';
import { onRender } from '../router.js';
import {
  fmtWhen, relAgo, fmtDur, fmtCount, modelText, modelTextCompact, turnCount,
  sessionTitle, isFromJob, jobTag, filterSessions, scopeCounts, SORTS,
} from './sessions-logic.js';

const POLL_MS = 8000;
const DENSITY_KEY = 'cs.v2.sessions.density';

const SVG_SEARCH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
const SVG_TRANSCRIPT = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h13a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3Z"/><path d="M8 8h8M8 12h6"/></svg>';
const SVG_WARN = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>';

// True only while this page owns #v2-page. See render()'s guard.
let mounted = false;
let pollTimer = null;
let routeWatcherArmed = false;

const state = {
  sessions: null, hidden: 0, failed: false,
  query: '', scope: 'all', sort: 'newest', density: 'detailed',
  // The id of the row currently armed for deletion, or null. Deliberately ONE
  // id, not a Set: arming a second row disarms the first, so there is never
  // more than one primed destructive control on screen.
  armed: null,
  listHost: null,
};

function svgNode(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

// Density is a per-viewer reading preference, not shared state — localStorage
// is the right home for it, and a browser that refuses storage must still
// render (private windows, blocked site data).
function loadDensity() {
  try {
    const v = localStorage.getItem(DENSITY_KEY);
    if (v === 'compact' || v === 'detailed') state.density = v;
  } catch { /* storage unavailable — the default stands */ }
}
function saveDensity(v) {
  state.density = v;
  try { localStorage.setItem(DENSITY_KEY, v); } catch { /* not worth a toast */ }
}

// ---------------- data ----------------

async function loadAndRender() {
  try {
    const data = await api('GET', '/api/sessions');
    state.sessions = data.sessions ?? [];
    state.hidden = data.hidden ?? 0;
    state.failed = false;
  } catch (err) {
    // 501 is "this instance has no sessions index" — a different fact from
    // "the daemon is down", and it must not read as a transient failure.
    state.failed = err.status === 501 ? 'unavailable' : true;
  }
  render();
}

// ---------------- actions ----------------

async function renameSession(s) {
  // eslint-disable-next-line no-alert
  const name = window.prompt('Name this session', sessionTitle(s));
  if (name == null) return;
  try {
    await api('POST', `/api/sessions/${s.id}/rename`, { name });
    toast('Renamed', 'ok');
  } catch (err) {
    // 409 means the file is being written to right now; the server's own
    // sentence explains why renaming then could corrupt it, so it is shown
    // rather than replaced with a generic failure.
    toast(failureToast(err) ?? 'could not rename that session', 'err', 8000);
  }
  loadAndRender();
}

async function resumeSession(s) {
  try {
    await api('POST', `/api/sessions/${s.id}/resume`);
    toast('Opening Terminal…', 'ok');
  } catch (err) {
    // 400 is the guessed-cwd refusal — resuming would land nowhere, and the
    // server says so in a sentence worth showing verbatim.
    toast(failureToast(err) ?? 'could not resume that session', 'err', 8000);
  }
}

async function deleteSession(s) {
  try {
    await api('DELETE', `/api/sessions/${s.id}`);
    toast('Transcript deleted', 'ok');
  } catch (err) {
    // 409 means the session is running.
    toast(failureToast(err) ?? 'could not delete that transcript', 'err', 8000);
  }
  state.armed = null;
  loadAndRender();
}

// ---------------- cards ----------------

function actionRow(s) {
  const open = el('a', { class: 'btn', href: `#session?id=${encodeURIComponent(s.id)}` }, 'Open transcript');
  const resume = el('button', { class: 'btn', 'data-mutating': true, 'data-act': 'resume' }, 'Resume in Terminal');
  resume.addEventListener('click', () => resumeSession(s));
  const rename = el('button', { class: 'btn btn--ghost', 'data-mutating': true, 'data-act': 'rename' }, 'Rename');
  rename.addEventListener('click', () => renameSession(s));

  if (state.armed === s.id) {
    // ARMED (REVIEW #4). The consequence is stated in full — this is the one
    // place a reader learns that deleting the transcript is what makes the
    // session unresumable — and the confirming button is the only
    // danger-styled control on the page.
    const cancel = el('button', { class: 'btn btn--ghost', 'data-act': 'cancel' }, 'Cancel');
    cancel.addEventListener('click', () => { state.armed = null; renderList(); });
    const confirm = el('button', { class: 'btn btn--danger', 'data-mutating': true, 'data-act': 'delete-confirm' }, 'Delete');
    confirm.addEventListener('click', () => deleteSession(s));
    return el('div', { class: 'rowline', style: 'margin-top: 12px;' }, [
      open, resume, rename,
      el('span', { class: 'rowline', style: 'margin-left:auto; gap: 8px;' }, [
        el('span', { class: 't-meta', style: 'color: var(--bad);' },
          'Delete this transcript permanently? The session cannot be resumed afterwards.'),
        cancel, confirm,
      ]),
    ]);
  }

  const arm = el('button', {
    class: 'btn btn--ghost btn--del', style: 'margin-left:auto;',
    'data-mutating': true, 'data-act': 'delete',
    'data-tip': 'Delete this transcript — asks once more before anything is removed',
  }, 'Delete');
  arm.addEventListener('click', () => { state.armed = s.id; renderList(); });
  return el('div', { class: 'rowline', style: 'margin-top: 12px;' }, [open, resume, rename, arm]);
}

function fact(k, v, d) {
  return el('div', { class: 'fact' }, [
    el('div', { class: 'fact__k' }, k),
    el('div', { class: 'fact__v mono' }, v),
    el('div', { class: 'fact__d' }, d ?? '—'),
  ]);
}

function detailedCard(s, now) {
  const tag = jobTag(s);
  const turns = turnCount(s.models);
  return el('section', { class: 'card', 'data-session-id': s.id }, [
    el('div', { class: 'card__head' }, [
      el('h2', { style: 'font-weight: 500; font-size: 13.5px;' },
        el('a', { class: 'mono', href: `#session?id=${encodeURIComponent(s.id)}`, style: 'color:inherit;' }, sessionTitle(s))),
      // "burst · webapp-billing" in the mockup; `runs[]` carries the job name
      // and no trigger, so only the job name is claimed.
      tag ? el('span', { class: 'tag', 'data-tip': 'Started by a LaunchBox job' }, tag) : null,
      s.runs?.[0]?.jobId
        ? el('a', { class: 't-meta', href: `#runs?job=${encodeURIComponent(s.runs[0].jobId)}` }, 'run history')
        : null,
      s.running ? el('span', { class: 'state state--info' }, [el('span', { class: 'state__dot' }), 'running']) : null,
      el('span', { class: 't-meta', style: 'margin-left:auto;' },
        [fmtWhen(s.lastTs, now), relAgo(s.lastTs, now)].filter(Boolean).join(' · ')),
    ]),
    el('div', { class: 'card__body', style: 'padding: 14px 18px;' }, [
      el('div', { class: 'facts', style: 'grid-template-columns: repeat(4, minmax(0, 1fr));' }, [
        fact('Span / active', fmtDur(s.spanMs) ?? '—',
          s.activeMs != null ? `active ${fmtDur(s.activeMs) ?? '—'}` : 'active time not recorded'),
        // The mockup's second line here is "38 tool calls", which no column
        // carries — the transcript page counts them, this card cannot.
        fact('Turns', turns ? String(turns) : '—', s.prompts != null ? `${s.prompts} prompts` : null),
        fact('Tokens', `${fmtCount(s.tokIn)} in · ${fmtCount(s.tokOut)} out`, 'deduplicated'),
        fact('Models', modelText(s.models), null),
      ]),
      actionRow(s),
    ]),
  ]);
}

function compactCard(s, now) {
  const tag = jobTag(s);
  const turns = turnCount(s.models);
  const open = el('a', { class: 'btn', href: `#session?id=${encodeURIComponent(s.id)}` }, 'Transcript');
  const resume = el('button', { class: 'btn', 'data-mutating': true, 'data-act': 'resume' }, 'Resume');
  resume.addEventListener('click', () => resumeSession(s));

  let last;
  if (state.armed === s.id) {
    const cancel = el('button', { class: 'btn btn--ghost', 'data-act': 'cancel' }, 'Cancel');
    cancel.addEventListener('click', () => { state.armed = null; renderList(); });
    const confirm = el('button', { class: 'btn btn--danger', 'data-mutating': true, 'data-act': 'delete-confirm' }, 'Delete permanently');
    confirm.addEventListener('click', () => deleteSession(s));
    last = el('span', { class: 'rowline', style: 'margin-left:auto; gap: 8px;' }, [cancel, confirm]);
  } else {
    last = el('button', {
      class: 'btn btn--ghost btn--del', style: 'margin-left:auto;',
      'data-mutating': true, 'data-act': 'delete',
      'data-tip': 'Delete this transcript — asks once more before anything is removed',
    }, 'Delete');
    last.addEventListener('click', () => { state.armed = s.id; renderList(); });
  }

  return el('div', { class: 'sescard', 'data-session-id': s.id }, [
    el('span', { class: 'sescard__t' }, sessionTitle(s)),
    tag ? el('span', { class: 'tag', style: 'justify-self:start;' }, tag) : el('span', {}),
    el('span', { class: 'sescard__m' }, [
      relAgo(s.lastTs, now), ' · ', turns ? `${turns} turns` : 'no turns recorded',
      ' · ', `${fmtCount(s.tokOut)} out`, ' · ', modelTextCompact(s.models),
    ].filter(Boolean).join('')),
    el('div', { class: 'sescard__a' }, [open, resume, last]),
    state.armed === s.id
      ? el('span', { class: 't-meta', style: 'color: var(--bad); grid-column: 1 / -1;' },
        'Delete this transcript permanently? The session cannot be resumed afterwards.')
      : null,
  ]);
}

// ---------------- toolbar / states ----------------

function toolbar() {
  const counts = scopeCounts(state.sessions ?? []);

  const search = el('input', {
    type: 'text', id: 'sessions-search',
    placeholder: 'Search titles, cwd, branch or session id…', value: state.query,
  });
  search.addEventListener('input', () => { state.query = search.value; renderList(); });

  const scopeSegs = el('div', { class: 'segs' });
  for (const [val, label] of [['all', 'All'], ['jobs', 'From jobs'], ['interactive', 'Interactive']]) {
    const btn = el('button', { class: 'seg', 'aria-selected': state.scope === val ? 'true' : null }, [
      `${label} `, el('span', { class: 'seg__count' }, String(counts[val] ?? 0)),
    ]);
    btn.addEventListener('click', () => {
      state.scope = val;
      for (const b of scopeSegs.querySelectorAll('.seg')) b.removeAttribute('aria-selected');
      btn.setAttribute('aria-selected', 'true');
      renderList();
    });
    scopeSegs.appendChild(btn);
  }

  const sortSel = el('select', { style: 'max-width: 170px;', 'aria-label': 'Sort sessions' });
  for (const [key, { label }] of Object.entries(SORTS)) {
    sortSel.appendChild(el('option', { value: key, selected: state.sort === key }, label));
  }
  sortSel.addEventListener('change', () => { state.sort = sortSel.value; renderList(); });

  // Density is a VIEW control, not a filter — the tooltip says so, because
  // "Compact" next to three filtering segs otherwise reads as a fourth filter.
  const densitySegs = el('div', { class: 'segs', 'data-tip': 'How much each card shows — same sessions either way' });
  for (const [val, label] of [['detailed', 'Detailed'], ['compact', 'Compact']]) {
    const btn = el('button', { class: 'seg', 'aria-selected': state.density === val ? 'true' : null }, label);
    btn.addEventListener('click', () => {
      saveDensity(val);
      for (const b of densitySegs.querySelectorAll('.seg')) b.removeAttribute('aria-selected');
      btn.setAttribute('aria-selected', 'true');
      renderList();
    });
    densitySegs.appendChild(btn);
  }

  return el('div', { class: 'toolbar' }, [
    el('label', { class: 'search' }, [svgNode(SVG_SEARCH), search]),
    scopeSegs, sortSel, densitySegs,
  ]);
}

function emptyCard() {
  return el('section', { class: 'card' }, el('div', { class: 'card__body' }, el('div', { class: 'blank', style: 'border:0;background:transparent;padding:24px 8px;' }, [
    el('span', { class: 'blank__icon', html: SVG_TRANSCRIPT }),
    el('div', {}, [
      el('h4', {}, 'No Claude Code sessions on this machine'),
      // The mockup names ~/.claude/projects here. The index root is real but is
      // never sent to the browser (GET /api/sessions returns {sessions,hidden}),
      // and CS_SESSIONS_ROOT can move it — so naming a path would be wrong on
      // exactly the machines where this sentence matters.
      el('p', {}, 'The Claude Code transcript directory was read and contains nothing. Sessions appear '
        + 'here after any Claude Code conversation — interactive, or started by a LaunchBox job.'),
      el('p', {}, 'If Claude Code runs under a different HOME, or LaunchBox was started with '
        + 'CS_SESSIONS_ROOT pointing elsewhere, it is reading a different directory from the one you '
        + 'are thinking of.'),
    ]),
  ])));
}

function noMatchCard(total) {
  const clearBtn = el('button', { class: 'btn' }, 'Clear the filter');
  clearBtn.addEventListener('click', () => { state.query = ''; state.scope = 'all'; render(); });
  return el('section', { class: 'card' }, el('div', { class: 'card__body' }, el('div', { class: 'blank', style: 'border:0;background:transparent;padding:22px 8px;' }, [
    el('span', { class: 'blank__icon', html: SVG_SEARCH }),
    el('div', {}, [
      el('h4', {}, state.query ? `No session matches "${state.query}"` : 'No session in this view'),
      el('p', {}, `Titles, working directories, branches and ids of all ${total} sessions were checked.`),
      el('div', { class: 'blank__act' }, [clearBtn]),
    ]),
  ])));
}

function unavailableCard(kind) {
  const retry = el('button', { class: 'btn btn--primary' }, 'Try again');
  retry.addEventListener('click', loadAndRender);
  const isUnavailable = kind === 'unavailable';
  return el('section', { class: 'card' }, el('div', { class: 'card__body' }, el('div', { class: 'blank', style: 'border:0;background:transparent;padding:24px 8px;' }, [
    el('span', { class: 'blank__icon', html: SVG_WARN }),
    el('div', {}, [
      el('h4', {}, isUnavailable ? 'The sessions index is not running' : 'Could not read your sessions'),
      el('p', {}, isUnavailable
        ? 'This LaunchBox process was started without a sessions index, so there is nothing to list. '
          + 'That is a configuration of the daemon, not a failure — restarting it with the index enabled '
          + 'is what makes this page work.'
        : 'GET /api/sessions did not answer, so this list has nothing to show — not even an empty one. '
          + 'Nothing has changed; LaunchBox is simply not reachable from this page right now.'),
      isUnavailable ? null : el('div', { class: 'blank__act' }, [retry]),
    ]),
  ])));
}

function renderList() {
  const host = state.listHost;
  if (!host) return;
  clear(host);
  const all = state.sessions ?? [];
  const now = Date.now();
  const shown = filterSessions(all, { query: state.query, scope: state.scope, sort: state.sort });
  if (!shown.length) {
    host.appendChild(noMatchCard(all.length));
    return;
  }
  if (state.density === 'compact') {
    host.appendChild(el('div', { class: 'sesgrid' }, shown.map((s) => compactCard(s, now))));
  } else {
    host.appendChild(el('div', { class: 'stack', style: 'gap: 14px;' }, shown.map((s) => detailedCard(s, now))));
  }
  // Arm/confirm controls are built here, between main.js's sweeps, so they get
  // the degraded reason applied directly (README.md's documented exception).
  for (const elm of host.querySelectorAll('[data-mutating]')) setDisabledReason(elm, degradedReason());
}

function render() {
  // An in-flight load from BEFORE a route change must not paint over the page
  // that now owns #v2-page — see the same guard on every other /v2 page
  // (claude-scheduler-btv.9's browser leg found the defect).
  if (!mounted) return;
  const page = $('#v2-page');
  if (!page) return;

  const prevSearch = $('#sessions-search');
  const hadFocus = !!prevSearch && document.activeElement === prevSearch;
  const selStart = hadFocus ? prevSearch.selectionStart : null;

  clear(page);
  state.listHost = null;

  const all = state.sessions;
  const counts = scopeCounts(all ?? []);

  page.appendChild(pageHead({
    title: 'Sessions',
    sub: all
      ? [
        `${counts.all} Claude Code transcript${counts.all === 1 ? '' : 's'}`,
        `${counts.jobs} started by LaunchBox jobs`,
        state.hidden ? `${state.hidden} hidden as non-interactive` : null,
      ].filter(Boolean).join(' · ')
      : state.failed ? 'Not loaded' : 'Loading…',
  }));

  if (state.failed) {
    page.appendChild(unavailableCard(state.failed));
    return;
  }
  if (!all) return; // first paint: the head is up, the list follows
  if (!all.length) {
    page.appendChild(emptyCard());
    return;
  }

  page.appendChild(toolbar());
  const listHost = el('div', { id: 'sessions-list-host' });
  page.appendChild(listHost);
  state.listHost = listHost;
  renderList();

  if (hadFocus) {
    const s = $('#sessions-search');
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
    mounted = route === 'sessions';
    if (route !== 'sessions') {
      // Leaving the page disarms any primed delete. A destructive control that
      // survives a navigation is one the reader has forgotten about.
      state.armed = null;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }
  });
}

export default function sessions(params) {
  void params; // no deep-link query params defined for this route
  mounted = true;
  loadDensity();
  ensureRouteWatcher();
  if (!pollTimer) {
    // Paint the shell before the first load, so the previous route's content
    // does not stay on screen while /api/sessions is in flight.
    const page = $('#v2-page');
    if (page && !state.sessions) {
      clear(page);
      page.appendChild(pageHead({ title: 'Sessions', sub: 'Loading…' }));
    }
    loadAndRender();
    pollTimer = setInterval(loadAndRender, POLL_MS);
    pollTimer.unref?.();
  } else {
    render();
  }
}
