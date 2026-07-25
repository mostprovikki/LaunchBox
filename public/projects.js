// The Projects tab: repos whose beads (`bd`) backlog the scheduler may draw work
// from. Read mostly; the one consequential control is Activate, which is the
// human airlock — nothing else in this module can flip a project to `active`.
//
// Two facts this UI exists to keep visible, because hiding either of them is how
// unattended automation becomes untrustworthy:
//   1. a project that will never contribute work says so, in words (`reasons`);
//   2. a completed bead leaves an audit line in the human's checkout (auditNote).

import { $, api, apiErr, esc, toast, relTime, fullTime } from './util.js';

// Which rows have the ready list expanded, plus the last body fetched for each.
// The list re-renders on a timer, so expansion has to live outside the DOM or a
// tick would silently collapse the panel the user is reading.
const readyOpen = new Set();
const readyCache = new Map(); // projectId -> /ready body, or { error }

// Constraint: the audit line must be stated, not concealed. The server owns the
// wording; this fallback exists only so a snapshot missing the field degrades to
// the same disclosure rather than to silence.
// Plain text, no backticks — this element is filled with textContent, so markdown
// here would render as literal punctuation in the tab's most important sentence.
const AUDIT_FALLBACK = 'When the scheduler closes a bead, bd appends one line to '
  + '.beads/interactions.jsonl in this repo. That file is git-tracked, the append cannot be '
  + 'suppressed, and it lands in your primary checkout even when the run happened in a worktree — '
  + 'so expect one modified file per completed bead. It is an audit trail, not damage.';

const STATE_TITLE = {
  pending: 'Registered but not activated — nothing from this repo runs.',
  active: 'The scheduler starts ready, labelled beads from this repo unattended.',
  paused: 'Left registered, but nothing is started until you activate it again.',
  error: 'The last poll failed — see the reason on this row.',
};

// ---------- rendering ----------
const stateChip = (state) =>
  `<span class="chip pstate pstate-${esc(state)}" title="${esc(STATE_TITLE[state] ?? '')}">${esc(state)}</span>`;

// `ready.count === null` means "never polled", which is a different fact from
// "polled, nothing ready" — a zero there would be a lie about what we know.
function readyText(p) {
  if (p.ready?.count == null) return 'ready unknown';
  return `${p.ready.count} ready`;
}

function lines(cls, items) {
  return (items ?? []).map((t) => `<div class="${cls}">${esc(t)}</div>`).join('');
}

// Busy is not broken: the beads DB being held by a human running `bd` in the
// same repo is the expected collision, so it gets informational styling and the
// consecutive count rather than an alarm on the first miss.
const busyChip = (n) =>
  `<span class="busy-chip" title="Another bd or dolt process holds the beads database. The scheduler backs off and tries again.">`
  + `database busy, will retry${n > 1 ? ` · ${n} polls in a row` : ''}</span>`;

// `lastError` is written only by a poll that genuinely failed and is cleared on
// success (a busy database clears it too), so its presence — not `state` — is the
// honest test for a fault: a bad `.scheduler.json` records one while the project
// is still nominally `active`. Skipped when a reason already says the same thing.
function faultLine(p) {
  if (!p.lastError || (p.reasons ?? []).includes(p.lastError)) return '';
  return `<div class="p-reason p-fault">last poll failed: ${esc(p.lastError)}</div>`;
}

function projectRow(p) {
  const el = document.createElement('div');
  el.className = `item project-item pstate-row-${p.state}`;
  el.dataset.projectId = p.id;
  const held = p.leases?.held ?? 0;
  const canActivate = p.state === 'pending' || p.state === 'paused';
  const canPause = p.state === 'active' || p.state === 'error';
  el.innerHTML = `
    <div class="grow">
      <div class="title">${esc(p.name)}${stateChip(p.state)}</div>
      <div class="sub">
        <span class="ppath" title="${esc(p.path)}">${esc(p.path)}</span>
        <span title="${esc(p.beadsDir ? `beads directory: ${p.beadsDir}` : 'beads directory not resolved yet')}">${esc(p.bdVersion || 'bd version unknown')}</span>
        <span title="${esc(p.lastPollAt ? fullTime(p.lastPollAt) : 'never polled')}">${p.lastPollAt ? `polled ${relTime(p.lastPollAt)}` : 'never polled'}</span>
        <span>${esc(readyText(p))}</span>
        ${held ? `<span title="Beads checked out to a run right now — deleting the project would abandon them.">${held} lease${held === 1 ? '' : 's'} held</span>` : ''}
        ${p.busyStreak > 0 ? busyChip(p.busyStreak) : ''}
      </div>
      ${lines('p-reason p-config-error', p.configErrors)}
      ${lines('p-reason', p.reasons)}
      ${lines('p-reason p-warn', p.warnings)}
      ${faultLine(p)}
      <div class="ready-panel" hidden></div>
    </div>
    <div class="actions">
      ${canActivate ? '<button data-act="activate" class="activate-btn" title="Let the scheduler run this repo\'s ready, labelled beads unattended">Activate</button>' : ''}
      ${canPause ? '<button data-act="pause" title="Stop starting new beads from this repo">Pause</button>' : ''}
      <button data-act="poll" class="icon" title="Poll this project now">↻</button>
      <button data-act="ready" class="icon" title="Show the beads that are ready right now">Ready…</button>
      <button data-act="del" class="icon" title="Remove from the scheduler">🗑</button>
    </div>`;
  el.querySelectorAll('[data-act]').forEach((n) =>
    n.addEventListener('click', () => onProjectAction(p, n.dataset.act)));
  if (readyOpen.has(p.id)) renderReady(el, p);
  return el;
}

// One bead line. `title` and `labels` are repo-authored text, so every field
// goes through esc() — this list is the tab's only untrusted-content surface.
function beadLine(b) {
  const meta = [
    b.priority != null ? `p${b.priority}` : '',
    b.type,
    b.status,
    b.dependencyCount ? `${b.dependencyCount} dep${b.dependencyCount === 1 ? '' : 's'}` : '',
    b.dependentCount ? `blocks ${b.dependentCount}` : '',
    b.commentCount ? `${b.commentCount} comment${b.commentCount === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return `<div class="bead">
    <span class="bead-id">${esc(b.id)}</span>
    <span class="bead-title">${esc(b.title)}</span>
    <span class="bead-meta">${esc(meta.join(' · '))}</span>
    ${(b.labels ?? []).map((l) => `<span class="bead-label">${esc(l)}</span>`).join('')}
  </div>`;
}

function readyBody(p, data) {
  if (!data) return '<div class="note">reading ready work…</div>';
  if (data.error) return `<div class="p-reason p-fault">${esc(data.error)}</div>`;
  const head = data.autoLabel
    ? `Ready beads labelled <code>${esc(data.autoLabel)}</code> with no unmet blockers.`
    : `No <code>autoLabel</code> configured, so nothing here is eligible.`;
  return `<div class="note">${head}</div>`
    // A busy database means "ask again", not "broken" — same rule as the row chip.
    + (data.busy ? `<div class="busy-line">${esc(data.health?.reason || 'beads database is busy')} — the scheduler will retry; this list is what it last managed to read.</div>` : '')
    + lines('p-reason', data.reasons)
    + (data.beads?.length
      ? `<div class="beads">${data.beads.map(beadLine).join('')}</div>`
      : `<div class="note">Nothing ready right now${p.state === 'active' ? '' : ' (and nothing would run — this project is ' + esc(p.state) + ')'}.</div>`);
}

function renderReady(row, p) {
  const panel = row.querySelector('.ready-panel');
  panel.hidden = false;
  panel.innerHTML = readyBody(p, readyCache.get(p.id));
}

function renderRootsLine(data) {
  const el = $('#projects-roots');
  const roots = data.roots ?? [];
  const bits = [];
  if (roots.length) {
    bits.push(`Discover scans ${roots.map((r) => `<code>${esc(r)}</code>`).join(', ')}`);
  } else {
    // An unset root is the single most likely reason Discover looks broken, so
    // say where to fix it rather than reporting "found 0".
    bits.push(`No <code>projectRoots</code> set, so Discover has nothing to scan — set it in <a href="#settings">Settings → Task sources</a>`);
  }
  if (data.pollSec) bits.push(`active projects are polled every ${esc(data.pollSec)}s`);
  if (data.worktreeRoot) bits.push(`runs get a worktree under <code>${esc(data.worktreeRoot)}</code>`);
  el.innerHTML = bits.join(' · ') + '.';

  const bdEl = $('#projects-bd');
  // `bd` missing breaks every project at once, so it is reported for the tab as
  // a whole instead of being repeated as a per-row poll failure.
  bdEl.hidden = !data.bd?.error;
  if (data.bd?.error) {
    bdEl.textContent = `bd is not usable (${data.bd.path || 'bd'}): ${data.bd.error} — no project can be polled until this is fixed.`;
  }
}

function render(data) {
  $('#projects-audit').textContent = data.auditNote || AUDIT_FALLBACK;
  renderRootsLine(data);
  const list = $('#projects-list');
  const projects = data.projects ?? [];
  list.innerHTML = '';
  $('#projects-empty').hidden = projects.length > 0;
  for (const p of projects) list.appendChild(projectRow(p));
  // Drop expansion state for rows that no longer exist, so a re-registered path
  // doesn't inherit a stale ready list.
  for (const id of [...readyOpen]) if (!projects.some((p) => p.id === id)) { readyOpen.delete(id); readyCache.delete(id); }
}

export async function refreshProjects() {
  try {
    render(await api('GET', '/api/projects'));
  } catch { /* daemon briefly down — the next tick redraws */ }
}

// ---------- actions ----------
// The airlock. Deliberately a confirm() with the consequence spelled out: this is
// the only click in the whole UI that lets a repo's backlog start running itself.
function confirmActivate(p) {
  const label = p.config?.autoLabel;
  return confirm(`Activate "${p.name}"?\n\n`
    + `From now on the scheduler will start ready beads from ${p.path} on its own, unattended — `
    + `every bead that is open, unblocked and carries the `
    + `${label ? `"${label}"` : 'configured autoLabel'} label, with no further prompt, `
    + `including while you are away from the machine.\n\n`
    + `Registering and discovering a project run nothing; this is the step that does.\n\n`
    + `Pause stops it again at any time.`);
}

async function loadReady(p) {
  readyCache.delete(p.id);
  try {
    readyCache.set(p.id, await api('GET', `/api/projects/${p.id}/ready`));
  } catch (e) {
    readyCache.set(p.id, { error: e.data?.error || 'could not read ready work' });
  }
  const row = $(`#projects-list .item[data-project-id="${p.id}"]`);
  if (row && readyOpen.has(p.id)) renderReady(row, p);
}

async function deleteProject(p) {
  if (!confirm(`Remove "${p.name}" from the scheduler?\n\n`
    + `The repo and its beads are left exactly as they are — this only stops the scheduler `
    + `looking at them.`)) return;
  try {
    // `removedJobs` are the per-bead job rows that carried this project's learned
    // cost — they vanish from the Jobs tab, so the count is stated, not swallowed.
    const out = await api('DELETE', `/api/projects/${p.id}`);
    toast(`Removed "${p.name}"${out?.removedJobs ? ` · ${out.removedJobs} bead job row${out.removedJobs === 1 ? '' : 's'} dropped` : ''}`);
  } catch (e) {
    // 409 means a bead is checked out to a run right now. Forcing abandons that
    // lease, so the ids are named before asking.
    if (e.status !== 409) return apiErr(e, 'could not remove project');
    const held = e.data?.held ?? [];
    if (!confirm(`${held.length || 'Some'} bead${held.length === 1 ? '' : 's'} from "${p.name}" `
      + `${held.length === 1 ? 'is' : 'are'} still leased to a run: ${held.join(', ')}\n\n`
      + `Removing now abandons ${held.length === 1 ? 'that lease' : 'those leases'} — the run keeps `
      + `going but the scheduler stops tracking the bead.\n\nRemove anyway?`)) return;
    try {
      await api('DELETE', `/api/projects/${p.id}`, { force: true });
      toast(`Removed "${p.name}" — ${held.length} lease${held.length === 1 ? '' : 's'} abandoned`);
    } catch (e2) { apiErr(e2, 'could not remove project'); }
  }
}

function pollSummary(r) {
  // `skipped` is BOTH a boolean (the project wasn't polled at all) and, on a real
  // poll, an array of per-bead refusals. Check the pending case first or a poll
  // that refused one bead would be reported as never having run.
  if (r.skipped === true) return `Not polled — ${r.reasons?.join(' · ') || 'nothing to do'}`;
  if (r.busy) return `Beads database busy${r.consecutive > 1 ? ` (${r.consecutive} polls in a row)` : ''} — will retry`;
  if (!r.ok) return `Poll failed — ${r.reasons?.join(' · ') || 'unknown reason'}`;
  const held = r.held ? ['nothing started: the schedule is paused'] : [];
  // A bead that was ready and still didn't start must say why: "3 ready · started
  // 0" with no reason is exactly the silent nothing this tab exists to prevent.
  const refused = (Array.isArray(r.skipped) ? r.skipped : []).map((s) => `${s.beadId}: ${s.reason}`);
  return [`${r.ready?.length ?? 0} ready · started ${r.started?.length ?? 0}`,
    ...held, ...refused, ...(r.reasons ?? []), ...(r.warnings ?? [])].join(' · ');
}

async function onProjectAction(p, act) {
  try {
    if (act === 'activate') {
      if (!confirmActivate(p)) return;
      const out = await api('PUT', `/api/projects/${p.id}`, { state: 'active' });
      // Activating something that still can't contribute is legal and common
      // (no autoLabel, bd missing) — say so now rather than leaving the user to
      // wonder why an active project never does anything.
      const why = [...(out.reasons ?? []), ...(out.warnings ?? [])];
      toast(why.length ? `Activated, but nothing will run yet — ${why.join(' · ')}` : `"${p.name}" is active`,
        why.length ? '' : 'ok');
    } else if (act === 'pause') {
      await api('PUT', `/api/projects/${p.id}`, { state: 'paused' });
      toast(`"${p.name}" paused — nothing new starts from it`);
    } else if (act === 'poll') {
      toast(pollSummary(await api('POST', `/api/projects/${p.id}/poll`)));
    } else if (act === 'ready') {
      if (readyOpen.has(p.id)) {
        readyOpen.delete(p.id);
        const row = $(`#projects-list .item[data-project-id="${p.id}"]`);
        if (row) row.querySelector('.ready-panel').hidden = true;
        return;
      }
      readyOpen.add(p.id);
      const row = $(`#projects-list .item[data-project-id="${p.id}"]`);
      if (row) renderReady(row, p); // shows the reading… line while the fetch runs
      return loadReady(p);
    } else if (act === 'del') {
      await deleteProject(p);
    }
  } catch (e) {
    apiErr(e, `${act} failed`);
  }
  refreshProjects();
}

async function registerProject() {
  const input = $('#project-path');
  const path = input.value.trim();
  if (!path) return toast('Enter the path of a repo with a .scheduler.json', 'err');
  try {
    const out = await api('POST', '/api/projects', { path });
    input.value = '';
    const errors = out.errors ?? [];
    toast(errors.length
      ? `Registered "${out.project.name}" as pending, but its config has problems — ${errors.join(' · ')}`
      : `Registered "${out.project.name}" — pending. Nothing runs until you activate it.`,
      errors.length ? 'err' : 'ok');
  } catch (e) {
    apiErr(e, 'could not register that path');
  }
  refreshProjects();
}

async function discoverProjects() {
  try {
    const out = await api('POST', '/api/projects/discover');
    const found = out.found ?? [];
    const created = found.filter((f) => f.created).length;
    toast(found.length
      ? `${found.length} project${found.length === 1 ? '' : 's'} found · ${created} newly registered as pending — discovery starts nothing.`
      : `Nothing found under ${(out.roots ?? []).join(', ') || 'the configured roots'}.`);
  } catch (e) {
    apiErr(e, 'discover failed');
  }
  refreshProjects();
}

// ---------- wire up ----------
$('#project-register').addEventListener('click', registerProject);
$('#project-path').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') registerProject(); });
$('#project-discover').addEventListener('click', discoverProjects);

// Gated on visibility, like the history tick: the list is cheap but it is a
// per-project cache read on the daemon, and a hidden tab has no reason to ask.
setInterval(() => { if (!$('#tab-projects').hidden) refreshProjects(); }, 5000);
