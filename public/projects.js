// The Projects tab: repos whose beads (`bd`) backlog the scheduler may draw work
// from. Read mostly; the one consequential control is Activate, which is the
// human airlock — nothing else in this module can flip a project to `active`.
//
// Two facts this UI exists to keep visible, because hiding either of them is how
// unattended automation becomes untrustworthy:
//   1. a project that will never contribute work says so, in words (`reasons`);
//   2. a completed bead leaves an audit line in the human's checkout (auditNote).

import { guardedSubmit } from './auth.js';
import { $, $$, api, apiErr, esc, toast, relTime, fullTime } from './util.js';

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
  `<span class="chip pstate pstate-${esc(state)}" data-tip="${esc(STATE_TITLE[state] ?? '')}">${esc(state)}</span>`;

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
  `<span class="busy-chip" data-tip="Another bd or dolt process holds the beads database. The scheduler backs off and tries again.">`
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
        <span class="ppath" data-tip="${esc(p.path)}">${esc(p.path)}</span>
        <span data-tip="${esc(p.beadsDir ? `beads directory: ${p.beadsDir}` : 'beads directory not resolved yet')}">${esc(p.bdVersion || 'bd version unknown')}</span>
        <span data-tip="${esc(p.lastPollAt ? fullTime(p.lastPollAt) : 'never polled')}">${p.lastPollAt ? `polled ${relTime(p.lastPollAt)}` : 'never polled'}</span>
        <span>${esc(readyText(p))}</span>
        ${held ? `<span data-tip="Beads checked out to a run right now — deleting the project would abandon them.">${held} lease${held === 1 ? '' : 's'} held</span>` : ''}
        ${p.busyStreak > 0 ? busyChip(p.busyStreak) : ''}
      </div>
      ${lines('p-reason p-config-error', p.configErrors)}
      ${lines('p-reason', p.reasons)}
      ${lines('p-reason p-warn', p.warnings)}
      ${faultLine(p)}
      <div class="ready-panel" hidden></div>
    </div>
    <div class="actions">
      ${canActivate ? '<button data-act="activate" class="activate-btn" data-tip="Let the scheduler run this repo\'s ready, labelled beads unattended">Activate</button>' : ''}
      ${canPause ? '<button data-act="pause" data-tip="Stop starting new beads from this repo">Pause</button>' : ''}
      <button data-act="poll" class="icon" aria-label="Poll this project now" data-tip="Poll this project now">↻</button>
      <button data-act="ready" class="icon" data-tip="Show the beads that are ready right now">Ready…</button>
      <button data-act="del" class="icon" aria-label="Remove from the scheduler" data-tip="Remove from the scheduler">🗑</button>
    </div>`;
  el.querySelectorAll('[data-act]').forEach((n) =>
    n.addEventListener('click', () => onProjectAction(p, n.dataset.act, n)));
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
  // Kept for the burst dialog, which needs to know which projects are activated
  // without a second fetch when it opens.
  lastProjects = data.projects ?? [];
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

// `el` is the button that was clicked; guardedSubmit shows the approval wait on
// it. Passing a button rather than a container matters: guardedSubmit's fallback
// busy-target is the element itself, so a bare <div> would have its markup
// overwritten by the waiting label.
async function onProjectAction(p, act, el) {
  try {
    if (act === 'activate') {
      if (!confirmActivate(p)) return;
      // Activation raises a system approval, which can hold this open for up to
      // three minutes; guardedSubmit shows the wait on the button that was
      // clicked and speaks the shared failure vocabulary on refusal.
      let out = null;
      if (!await guardedSubmit(el, async () => { out = await api('PUT', `/api/projects/${p.id}`, { state: 'active' }); })) return;
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

// ---------- bursts ----------
// "Spend ~15% of this window working through ready beads." Two things this screen
// must not misrepresent:
//   1. the meter is MEASURED spend, not the estimate that sized the timetable;
//   2. WHICH beads run is decided at each attempt, not now — unlike the burn-down
//      planner, a burst cannot name the work it will do, and implying otherwise
//      would be a lie about unattended automation.

// The server's slots, held verbatim for confirm. No arithmetic here that could
// disagree with the policy that produced them.
let plannedBurst = null;
let lastProjects = [];

const PRESETS = [
  { label: '10% of session', window: 'five_hour', pct: 10 },
  { label: '25% of session', window: 'five_hour', pct: 25 },
  { label: '5% of weekly', window: 'seven_day', pct: 5 },
];

const WINDOW_LABELS = { five_hour: '5-hour', seven_day: 'weekly' };
const windowLabel = (k) => WINDOW_LABELS[k] ?? String(k).replace(/_/g, ' ');

function renderBurstStrip(active) {
  const strip = $('#burst-strip');
  if (!active) { strip.hidden = true; return; }
  strip.hidden = false;
  const spent = Math.max(0, (active.currentPct ?? active.startPct) - active.startPct);
  const pctOfBudget = Math.min(100, (spent / active.budgetPct) * 100);
  $('#burst-title').textContent = `Burst running · ${spent.toFixed(2)}% of ${active.budgetPct}% of the ${windowLabel(active.window)} window`;
  $('#burst-fill').style.width = `${pctOfBudget}%`;
  const left = (active.slots ?? []).length;
  const next = left ? (active.slots ?? [])[0] : null;
  $('#burst-detail').textContent = [
    `${active.runs} run${active.runs === 1 ? '' : 's'} started`,
    `${left} attempt${left === 1 ? '' : 's'} left`,
    next ? `next ${relTime(next)}` : 'no attempts left',
    'spend is measured, not estimated',
  ].join(' · ');
}

async function refreshBurst() {
  try {
    const out = await api('GET', '/api/bursts');
    renderBurstStrip(out.active);
  } catch { /* daemon briefly down, or bursts unavailable */ }
}

async function openBurstDialog() {
  plannedBurst = null;
  $('#burst-errors').hidden = true;
  $('#burst-result').hidden = true;
  $('#burst-confirm').hidden = true;
  // Fetch rather than trust the 5s tick. Found by driving it: opening the dialog
  // straight after switching to the tab showed "no activated projects", because the
  // background refresh had not run yet — a dialog that tells you your projects
  // cannot contribute when they can is worse than a slow one. It costs zero `bd`
  // calls by design, and it also means the ready counts are current at the moment
  // the decision is made.
  await refreshProjects();

  const windows = [...new Set([...PRESETS.map((p) => p.window), 'five_hour', 'seven_day'])];
  $('#b-window').innerHTML = windows.map((w) => `<option value="${esc(w)}">${esc(windowLabel(w))} window</option>`).join('');
  $('#burst-presets').innerHTML = PRESETS
    .map((p, i) => `<button type="button" class="preset" data-i="${i}">${esc(p.label)}</button>`).join('');
  $$('#burst-presets .preset').forEach((n) => n.addEventListener('click', () => {
    const p = PRESETS[Number(n.dataset.i)];
    $('#b-window').value = p.window;
    $('#b-budgetPct').value = String(p.pct);
  }));

  // Only activated projects are offered. The airlock is enforced server-side too,
  // but offering a pending repo here would imply a burst could run it.
  const eligible = lastProjects.filter((p) => p.state === 'active');
  const held = lastProjects.length - eligible.length;
  $('#b-projects').innerHTML = eligible.length
    ? eligible.map((p) => `<label><input type="checkbox" value="${esc(p.id)}" checked>${esc(p.name)}`
      + ` <span class="muted">${p.ready?.count == null ? 'ready unknown' : `${p.ready.count} ready`}</span></label>`).join('')
      + (held ? `<p class="muted">${held} project${held === 1 ? '' : 's'} not activated — a burst can only draw from activated ones.</p>` : '')
    : '<p class="muted">No activated projects. Activate one first — a burst cannot run work from a repo you haven\'t activated.</p>';

  $('#burst-dialog').showModal();
}

const burstBody = () => ({
  window: $('#b-window').value,
  budgetPct: Number($('#b-budgetPct').value),
  projectIds: $$('#b-projects input[type=checkbox]').filter((n) => n.checked).map((n) => n.value),
  minGapMin: $('#b-minGapMin').value || null,
  maxRuns: $('#b-maxRuns').value || null,
});

function renderBurstPreview(p) {
  $('#burst-result').hidden = false;
  $('#burst-confirm').hidden = false;
  // The policy labels windows by key, which is for machines. Same swap the
  // burn-down planner does — M2 shipped with `five_hour` leaking into the text and
  // it read like a bug.
  const humanise = (s) => String(s).replaceAll(p.window, windowLabel(p.window));
  const conf = p.confidence === 'low'
    ? ' · confidence <span class="conf-low">low</span> — cost per run is a guess from fewer than 3 measured runs'
    : ' · confidence <span class="conf-high">high</span>';
  $('#burst-summary').innerHTML = `<p><strong>${p.slots.length}</strong> attempt${p.slots.length === 1 ? '' : 's'}`
    + ` · about <strong>${p.estimate.perRunPct}%</strong> per run (${esc(p.estimate.source)}, ${p.estimate.samples} sample${p.estimate.samples === 1 ? '' : 's'})`
    + ` · up to <strong>${p.budgetPct}%</strong> of the ${esc(windowLabel(p.window))} window`
    + ` · ${p.usablePct}% usable under the guard reserve${conf}</p>`
    + '<p class="note">The beads themselves are chosen at each attempt, from whatever is ready and eligible then.</p>';
  $('#burst-assumptions').innerHTML = (p.assumptions ?? []).map((a) => `<li>${esc(humanise(a))}</li>`).join('');
  // Absolute times, one per row, like the burn-down plan. Relative labels rounded
  // two different slots to the same "in 1h", which reads as a duplicate.
  $('#burst-slots').innerHTML = p.slots
    .map((at, i) => `<div><span>#${i + 1}</span><span>${esc(new Date(at).toLocaleString())}</span><span>~${p.estimate.perRunPct}%</span></div>`).join('');
  // Show the spacing that was actually used — the field may have been left blank,
  // in which case the server applied the burstMinGapMin setting.
  if (p.minGapMin != null) $('#b-minGapMin').value = String(p.minGapMin);
}

async function previewBurst() {
  $('#burst-errors').hidden = true;
  const body = burstBody();
  if (!body.projectIds.length) {
    $('#burst-errors').hidden = false;
    $('#burst-errors').textContent = 'Pick at least one activated project.';
    return;
  }
  try {
    plannedBurst = await api('POST', '/api/bursts/plan', body);
    renderBurstPreview(plannedBurst);
  } catch (e) {
    plannedBurst = null;
    $('#burst-result').hidden = true;
    $('#burst-confirm').hidden = true;
    $('#burst-errors').hidden = false;
    $('#burst-errors').textContent = e.data?.reason || (e.data?.errors ?? []).join(' · ') || e.data?.error || 'could not plan that burst';
  }
}

async function confirmBurst() {
  if (!plannedBurst) return;
  const body = burstBody();
  try {
    // The server's own slots, posted back unchanged.
    const out = await api('POST', '/api/bursts', { ...body, slots: plannedBurst.slots });
    $('#burst-dialog').close();
    toast(`Burst started — up to ${out.burst.budgetPct}% of the ${windowLabel(out.burst.window)} window, `
      + `${out.burst.slots.length} attempt${out.burst.slots.length === 1 ? '' : 's'}. It stops on measured spend.`);
    refreshBurst();
  } catch (e) {
    $('#burst-errors').hidden = false;
    $('#burst-errors').textContent = e.data?.reason || (e.data?.errors ?? []).join(' · ') || e.data?.error || 'could not start that burst';
  }
}

async function cancelBurst() {
  const out = await api('GET', '/api/bursts').catch(() => null);
  const active = out?.active;
  if (!active) { refreshBurst(); return; }
  // In-flight runs are deliberately left alone: stopping them is the Pause/stop
  // ladder's job, and a stopped run hands its bead back rather than closing it.
  if (!confirm(`Cancel this burst?\n\nNo further attempts will be made. A run already in progress keeps going — `
    + `use Pause or the run's own stop button for that.`)) return;
  try {
    await api('POST', `/api/bursts/${active.id}/cancel`);
    toast('Burst cancelled — no further attempts.');
  } catch (e) {
    apiErr(e, 'could not cancel the burst');
  }
  refreshBurst();
}

// ---------- wire up ----------
$('#project-register').addEventListener('click', registerProject);
$('#project-path').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') registerProject(); });
$('#project-discover').addEventListener('click', discoverProjects);
$('#project-burst').addEventListener('click', openBurstDialog);
$('#burst-preview').addEventListener('click', previewBurst);
$('#burst-confirm').addEventListener('click', confirmBurst);
$('#burst-close').addEventListener('click', () => $('#burst-dialog').close());
$('#burst-cancel').addEventListener('click', cancelBurst);

// Gated on visibility, like the history tick: the list is cheap but it is a
// per-project cache read on the daemon, and a hidden tab has no reason to ask.
setInterval(() => {
  if ($('#tab-projects').hidden) return;
  refreshProjects();
  refreshBurst();
}, 5000);
