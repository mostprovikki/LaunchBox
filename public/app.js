import { renderFields, collectFields } from './fields.js';
import { $, $$, api, apiErr, esc, toast, relTime, fullTime, duration } from './util.js';
import { renderUsage } from './usage.js';
import { iconFor } from './icons.js';
import { refreshProjects } from './projects.js';
// Only for the fragment hand-off below; ordinary calls get the token via api().
import { getToken, guardedSubmit, FAILURE_COPY } from './auth.js';

let exts = []; // extension manifests from /api/extensions
let jobs = [];
let editingId = null;
let logRun = null;
let logJobName = ''; // kept so Refresh can rebuild the title without re-parsing it
let home = '';
let jobSearch = '';
let runStatusFilter = '';
let usageData = null; // last /api/usage body — the window list the pickers offer
let pauseState = null; // last /api/pause body (rides the jobs tick)

const extById = (id) => exts.find((e) => e.id === id);

// Windows an afterReset entry can anchor to: whatever the live snapshot reports,
// falling back to the two every plan has so the builder still works before the
// first probe lands.
const RESET_WINDOW_LABELS = { five_hour: '5-hour', seven_day: 'weekly' };
const resetWindows = () => {
  const live = Object.keys(usageData?.windows ?? {});
  return live.length ? live : ['five_hour', 'seven_day'];
};
const resetWindowLabel = (k) => RESET_WINDOW_LABELS[k] ?? k.replace(/_/g, ' ');

// ---------- schedule text ----------
function cronToPreset(expr) {
  let m;
  const t = (h, mi) => `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  if ((m = expr.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/))) return { preset: 'daily', time: t(m[2], m[1]) };
  if ((m = expr.match(/^(\d{1,2}) (\d{1,2}) \* \* 1-5$/))) return { preset: 'weekdays', time: t(m[2], m[1]) };
  if ((m = expr.match(/^0 \*\/(\d+) \* \* \*$/))) return { preset: 'hours', n: +m[1] };
  if ((m = expr.match(/^\*\/(\d+) \* \* \* \*$/))) return { preset: 'minutes', n: +m[1] };
  return { preset: 'custom', cron: expr };
}
function entryText(s) {
  if (s.type === 'once') return `once, ${new Date(s.at).toLocaleString()}`;
  if (s.type === 'afterReset') {
    return `after ${resetWindowLabel(s.window)} reset +${s.offsetMin}m${s.jitterMin ? `±${s.jitterMin}` : ''}`;
  }
  const p = cronToPreset(s.expr);
  return {
    daily: `daily ${p.time}`,
    weekdays: `weekdays ${p.time}`,
    hours: `every ${p.n}h`,
    minutes: `every ${p.n}m`,
    custom: `cron ${s.expr}`,
  }[p.preset];
}
function scheduleText(s) {
  const parts = (Array.isArray(s) ? s : [s]).map(entryText);
  return parts.length > 2 ? `${parts.slice(0, 2).join(' · ')} +${parts.length - 2} more` : parts.join(' · ');
}

// ---------- tabs ----------
const TABS = ['jobs', 'history', 'projects', 'settings'];
function hashParts() {
  const [tab, query] = (location.hash || '#jobs').slice(1).split('?');
  // Anything that isn't a tab name falls back to Jobs. Without this, one
  // unrecognised fragment hides every section and the page looks broken with no
  // way back — which is exactly what `#token=…` did before it was handled below.
  return { tab: TABS.includes(tab) ? tab : 'jobs', query: new URLSearchParams(query || '') };
}
function showTab() {
  const { tab, query } = hashParts();
  for (const s of TABS) {
    $(`#tab-${s}`).hidden = s !== tab;
    document.querySelector(`.tabs a[data-tab="${s}"]`).classList.toggle('active', s === tab);
  }
  if (tab === 'history') {
    if (query.has('job')) $('#history-job').value = query.get('job');
    if (query.has('status')) setStatusChip(query.get('status'));
    if (query.toString()) history.replaceState(null, '', '#history');
    refreshRuns();
  }
  if (tab === 'projects') refreshProjects();
  if (tab === 'settings') loadSettings();
}
window.addEventListener('hashchange', () => {
  // The session key arrives as a fragment, which is a delivery mechanism and not
  // a route. It lands here when the tab is already open — pasting the URL, or
  // `claude-scheduler open` reusing this tab — and by then boot has already run
  // without a key, so the page is empty and showing the banner. Capture it (which
  // also strips it from the address bar) and reload, so the whole boot re-runs
  // with the key rather than leaving half the UI unpopulated.
  if (/(?:^|[#&])token=/.test(location.hash)) {
    getToken();
    return location.reload();
  }
  showTab();
});

// ---------- jobs ----------
const statusHtml = (st) => `<span class="status st-${st}"><span class="dot ${st}"></span>${st}</span>`;

function renderJobs() {
  const q = jobSearch.trim().toLowerCase();
  const shown = q
    ? jobs.filter((j) => [j.name, j.cwd, ...Object.values(j.params ?? {})].some((f) => String(f ?? '').toLowerCase().includes(q)))
    : jobs;
  const list = $('#jobs-list');
  list.innerHTML = '';
  $('#jobs-empty').hidden = jobs.length > 0;
  if (jobs.length && !shown.length) {
    list.innerHTML = '<p class="empty">No jobs match your filter.</p>';
    return;
  }
  for (const j of shown) {
    const live = j.lastRun && ['running', 'queued'].includes(j.lastRun.status);
    const el = document.createElement('div');
    el.className = 'item' + (j.enabled ? '' : ' disabled');
    el.innerHTML = `
      <div class="grow">
        <div class="title"><span class="type-ico" title="${esc(extById(j.type)?.name ?? j.type)}">${iconFor(extById(j.type))}</span>${esc(j.name)}</div>
        <div class="sub">
          <span>${esc(scheduleText(j.schedule))}</span>
          <span title="${esc(fullTime(j.nextFire))}">${j.nextFire ? 'next ' + relTime(j.nextFire) : j.enabled ? '' : 'disabled'}</span>
          ${j.lastRun ? `<span class="linkish" data-act="last" title="${esc(fullTime(j.lastRun.finishedAt || j.lastRun.startedAt))}">last: ${statusHtml(j.lastRun.status)}</span>` : ''}
          ${j.lastRun?.skipReason ? `<span class="skip-chip" title="${esc(j.lastRun.skipReason)}">⛔ skipped</span>` : ''}
        </div>
      </div>
      <div class="actions">
        ${live
          // ⤓ not ⏹: next to ■ the two squares are indistinguishable at 12px,
          // and these two buttons do very different things to your work.
          ? `<button class="icon soft-stop-btn" data-act="stop" title="Wind down — let this run stop at its next safe point">⤓</button>
             <button class="icon stop-btn" data-act="kill" title="Stop this run now">■</button>`
          : '<button class="icon run-btn" data-act="run" title="Run once now (even if disabled)">▶</button>'}
        <label class="switch" title="${j.enabled ? 'Disable schedule' : 'Enable schedule'}"><input type="checkbox" data-act="toggle" ${j.enabled ? 'checked' : ''}><i></i></label>
        <button class="icon" data-act="edit" title="Edit">✎</button>
        <button class="icon" data-act="clone" title="Clone">⧉</button>
        <button class="icon" data-act="del" title="Delete">🗑</button>
      </div>`;
    el.querySelectorAll('[data-act]').forEach((n) => {
      n.addEventListener(n.dataset.act === 'toggle' ? 'change' : 'click', () => onJobAction(j, n.dataset.act, n));
    });
    list.appendChild(el);
  }
}

async function refreshJobs() {
  try {
    const data = await api('GET', '/api/jobs');
    jobs = data.jobs;
    const badge = $('#running-badge');
    badge.hidden = data.running === 0;
    badge.textContent = `◐ ${data.running} running`;
    renderAwake(data.awake);
    renderPause(data.pause);
    renderJobs();
  } catch { /* daemon briefly down — next poll retries */ }
  refreshUsage();
}

// Rides the jobs tick rather than adding a timer: this reads a cached snapshot,
// so its cost is a local request and the strip is never more than a tick stale.
// Polled even when the display is `off` — M2 wants the state regardless.
async function refreshUsage() {
  try {
    usageData = await api('GET', '/api/usage');
    renderUsage(usageData);
  } catch { /* 501 without a monitor, or the daemon blinked — leave the last render */ }
}

// A soft/hard pause refuses manual runs too, and the reason it gives is the
// exact string lib/pause.js produces. Matched precisely rather than by prefix:
// the budget guard's reasons also begin with "paused", and offering to override
// the wrong one would be a lie about what the click does.
const PAUSE_REFUSAL = /^paused \((soft|hard)\)$/;

async function onJobAction(job, act, el) {
  try {
    if (act === 'run') {
      let run = await api('POST', `/api/jobs/${job.id}/run`);
      if (run.status === 'skipped' && PAUSE_REFUSAL.test(run.meta?.skipReason ?? '')) {
        if (!confirm(`Everything is ${run.meta.skipReason} — that's why this didn't start.\n\n`
          + `Run "${job.name}" anyway, just this once?`)) {
          return toast(`Not started — ${run.meta.skipReason}`, 'err');
        }
        run = await api('POST', `/api/jobs/${job.id}/run`, { force: true });
      }
      if (run.status === 'skipped') {
        return toast(run.meta?.skipReason ? `Not started — ${run.meta.skipReason}` : `"${job.name}" is already running`, 'err');
      }
      toast(`Started "${job.name}"${run.status === 'queued' ? ' (queued)' : ''}`, 'ok');
      location.hash = `#history?job=${job.id}`;
      openLog(run, job.name);
    } else if (act === 'kill') {
      await api('POST', `/api/runs/${job.lastRun.id}/kill`);
      toast(`Stopped "${job.name}"`, 'ok');
    } else if (act === 'stop') {
      await api('POST', `/api/runs/${job.lastRun.id}/stop`);
      toast(`"${job.name}" will stop at its next safe point`, 'ok');
    } else if (act === 'toggle') {
      await api('PUT', `/api/jobs/${job.id}`, { enabled: el.checked });
    } else if (act === 'edit') {
      return openDialog(job);
    } else if (act === 'clone') {
      return openDialog(job, true);
    } else if (act === 'del') {
      if (!confirm(`Delete job "${job.name}" and its run history?`)) return;
      await api('DELETE', `/api/jobs/${job.id}`);
      toast(`Deleted "${job.name}"`);
    } else if (act === 'last') {
      location.hash = `#history?job=${job.id}`;
      return;
    }
  } catch (e) {
    apiErr(e, `${act} failed`);
  }
  refreshJobs();
}

// ---------- pause modes ----------
// Four modes because the old `paused` behaviour had to survive under a name:
// `hold` is exactly it. The banner says what is actually blocked rather than
// leaving the user to infer it from a mode name.
const PAUSE_TEXT = {
  hold: 'Schedules are on hold — nothing fires automatically, but you can still run jobs by hand.',
  soft: 'Paused — nothing new starts, and running jobs are winding down at their next safe point.',
  hard: 'Hard paused — nothing runs, and anything that was in flight was stopped immediately.',
};
const PAUSE_TOAST = {
  off: 'Schedules resumed',
  hold: 'Schedules on hold — manual runs still work',
  soft: 'Soft pause — nothing new will start',
  hard: 'Hard pause — everything stopped',
};

function renderPause(p) {
  if (!p) return;
  pauseState = p;
  $$('#pause-seg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === p.mode));
  const banner = $('#paused-banner');
  banner.hidden = p.mode === 'off';
  banner.classList.toggle('hard', p.mode === 'hard');
  if (p.mode === 'off') return;
  const n = p.stopping?.length ?? 0;
  banner.textContent = `⏸ ${PAUSE_TEXT[p.mode]}`
    + (n ? ` ${n} run${n === 1 ? '' : 's'} still winding down.` : '')
    + (p.until ? ` Until ${new Date(p.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : '');
}

async function setPauseMode(mode) {
  if (mode === pauseState?.mode) return;
  // Hard pause destroys in-flight work — the one mode that needs asking first.
  if (mode === 'hard') {
    const n = pauseState?.stopping?.length ?? 0;
    if (!confirm('Hard pause kills every running job immediately — work in progress is lost, '
      + 'and Claude sessions stop wherever they happen to be.\n\nUse Soft to let them finish cleanly instead.'
      + (n ? `\n\n${n} run(s) are already winding down gracefully; hard pause will cut them short.` : '')
      + '\n\nStop everything now?')) return;
  }
  try {
    const out = await api('PUT', '/api/pause', { mode });
    renderPause(out);
    // ' · ' rather than a second em-dash: the mode line already contains one,
    // and "wind down — 1 winding down" read as a stutter.
    const extra = [
      out.stopped?.length ? `${out.stopped.length} run${out.stopped.length === 1 ? '' : 's'} winding down` : '',
      out.clearedQueue?.length ? `${out.clearedQueue.length} queued dropped` : '',
    ].filter(Boolean).join(' · ');
    toast(PAUSE_TOAST[mode] + (extra ? ` · ${extra}` : ''), mode === 'off' ? 'ok' : '');
    refreshJobs();
  } catch (e) {
    apiErr(e, 'could not change pause mode');
  }
}

// ---------- keep awake ----------
function awakeLabel(a) {
  if (!a || a.mode === 'off') return { text: 'sleep ok', on: false };
  if (a.mode === 'on') return { text: 'awake', on: true };
  if (a.mode === 'timed') {
    const t = a.until ? new Date(a.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?';
    return { text: `awake until ${t}`, on: a.active };
  }
  return { text: a.active ? 'auto · awake' : 'auto', on: a.active }; // auto
}
function renderAwake(a) {
  const { text, on } = awakeLabel(a);
  $('#awake-label').textContent = text;
  $('#awake-btn').classList.toggle('on', !!on);
  $$('#awake-menu button[data-mode]').forEach((b) => {
    const match = b.dataset.mode === (a?.mode ?? 'off')
      && (b.dataset.mode !== 'timed' || !a?.until || true); // timed presets all highlight
    b.classList.toggle('active', match);
  });
}

// ---------- job dialog: schedule builder ----------
const PRESETS = {
  daily: { time: true }, weekdays: { time: true },
  hours: { n: true }, minutes: { n: true },
  once: { once: true }, custom: { cron: true },
  reset: { reset: true },
};
const PRESET_OPTS = `
  <option value="daily">Daily at…</option>
  <option value="weekdays">Weekdays at…</option>
  <option value="hours">Every N hours</option>
  <option value="minutes">Every N minutes</option>
  <option value="once">Once at…</option>
  <option value="reset">After limit reset…</option>
  <option value="custom">Custom cron</option>`;

function addSchedRow(entry = null) {
  const row = document.createElement('div');
  row.className = 'row sched-row';
  row.innerHTML = `
    <select class="sr-preset">${PRESET_OPTS}</select>
    <input class="sr-time" type="time" value="09:00">
    <input class="sr-n" type="number" min="1" value="2" hidden>
    <input class="sr-once" type="datetime-local" hidden>
    <input class="sr-cron" placeholder="0 9 * * *" hidden>
    <select class="sr-window" hidden>${resetWindows().map((w) => `<option value="${esc(w)}">${esc(resetWindowLabel(w))} window</option>`).join('')}</select>
    <input class="sr-offset" type="number" min="0" max="240" value="3" title="Minutes after the reset" hidden>
    <input class="sr-jitter" type="number" min="0" max="60" value="2" title="Spread: up to this many extra minutes (same every time for this job)" hidden>
    <button type="button" class="icon sr-del" title="Remove this time">✕</button>`;
  const sel = row.querySelector('.sr-preset');

  if (entry?.type === 'once') {
    sel.value = 'once';
    const d = new Date(entry.at);
    row.querySelector('.sr-once').value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  } else if (entry?.type === 'afterReset') {
    sel.value = 'reset';
    // A window the live snapshot no longer reports still has to be shown, or
    // editing the job would silently retarget it.
    const wsel = row.querySelector('.sr-window');
    if (![...wsel.options].some((o) => o.value === entry.window)) {
      wsel.insertAdjacentHTML('beforeend', `<option value="${esc(entry.window)}">${esc(resetWindowLabel(entry.window))} window</option>`);
    }
    wsel.value = entry.window;
    row.querySelector('.sr-offset').value = entry.offsetMin ?? 3;
    row.querySelector('.sr-jitter').value = entry.jitterMin ?? 2;
  } else if (entry) {
    const p = cronToPreset(entry.expr);
    sel.value = p.preset;
    if (p.time) row.querySelector('.sr-time').value = p.time;
    if (p.n) row.querySelector('.sr-n').value = p.n;
    if (p.cron) row.querySelector('.sr-cron').value = p.cron;
  }

  const sync = () => {
    const p = PRESETS[sel.value] || {};
    row.querySelector('.sr-time').hidden = !p.time;
    row.querySelector('.sr-n').hidden = !p.n;
    row.querySelector('.sr-once').hidden = !p.once;
    row.querySelector('.sr-cron').hidden = !p.cron;
    for (const c of ['.sr-window', '.sr-offset', '.sr-jitter']) row.querySelector(c).hidden = !p.reset;
  };
  sel.addEventListener('change', () => { sync(); updatePreview(); });
  row.querySelectorAll('input, select.sr-window').forEach((i) => i.addEventListener('input', updatePreview));
  row.querySelector('.sr-del').addEventListener('click', () => { row.remove(); syncSchedDels(); updatePreview(); });
  sync();
  $('#sched-rows').appendChild(row);
  syncSchedDels();
}

function syncSchedDels() {
  const rows = $$('.sched-row');
  rows.forEach((r) => { r.querySelector('.sr-del').style.visibility = rows.length > 1 ? 'visible' : 'hidden'; });
}

function rowSchedule(row) {
  const preset = row.querySelector('.sr-preset').value;
  const [hh, mm] = (row.querySelector('.sr-time').value || '09:00').split(':').map(Number);
  const n = Math.max(1, Number(row.querySelector('.sr-n').value) || 1);
  switch (preset) {
    case 'daily': return { type: 'cron', expr: `${mm} ${hh} * * *` };
    case 'weekdays': return { type: 'cron', expr: `${mm} ${hh} * * 1-5` };
    case 'hours': return { type: 'cron', expr: `0 */${n} * * *` };
    case 'minutes': return { type: 'cron', expr: `*/${n} * * * *` };
    case 'once': {
      const v = row.querySelector('.sr-once').value;
      return { type: 'once', at: v ? new Date(v).toISOString() : '' };
    }
    case 'reset': return {
      type: 'afterReset',
      window: row.querySelector('.sr-window').value,
      offsetMin: Number(row.querySelector('.sr-offset').value),
      jitterMin: Number(row.querySelector('.sr-jitter').value),
    };
    default: return { type: 'cron', expr: row.querySelector('.sr-cron').value.trim() };
  }
}

function buildSchedules() {
  return $$('.sched-row').map(rowSchedule);
}

let previewTimer = null;
function updatePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const schedules = buildSchedules();
    try {
      // The jitter is a hash of the job's id, so an existing job previews its
      // exact fire time. A job that doesn't exist yet has no id to hash — say
      // the spread is coming rather than show a time it won't fire at.
      const { next, unknown } = await api('POST', '/api/schedule/preview', { schedules, jobId: editingId ?? '' });
      const parts = next.map((d) => new Date(d).toLocaleString());
      // An unresolved afterReset entry is a state, not a failure: it will fire,
      // we just can't say when until usage reports the next reset.
      if (unknown) parts.push('after the next limit reset (depends on live usage)');
      const spread = editingId ? 0 : Math.max(0, ...schedules.filter((s) => s.type === 'afterReset').map((s) => s.jitterMin || 0));
      $('#f-preview').textContent = (parts.length ? 'Next: ' + parts.join('  ·  ') : 'Never fires')
        + (spread ? ` — reset fires get a fixed spread of up to ${spread}m once saved` : '');
    } catch (e) {
      $('#f-preview').textContent = e.data?.error || 'Invalid schedule';
    }
  }, 250);
}

// ---------- job dialog: extension-driven fields ----------
function jobType() {
  return $('#f-type').dataset.value;
}
function setJobType(v, params = {}) {
  $('#f-type').dataset.value = v;
  $$('#f-type button').forEach((b) => b.classList.toggle('active', b.dataset.value === v));
  const ext = extById(v);
  $('#f-type-desc').textContent = ext?.description ?? '';
  renderFields($('#ext-fields'), (ext?.fields ?? []).filter((f) => !f.advanced), params);
  renderFields($('#ext-fields-adv'), (ext?.fields ?? []).filter((f) => f.advanced), params);
}

function buildTypeSeg() {
  $('#f-type').innerHTML = exts
    .map((e) => `<button type="button" data-value="${esc(e.id)}">${iconFor(e, { size: 14 })} ${esc(e.name)}</button>`)
    .join('');
  $$('#f-type button').forEach((b) => b.addEventListener('click', () => setJobType(b.dataset.value, collectParams())));
}

// `budget` is a core block inside params (the guard is core, not per-type), so it
// is collected here rather than by an extension's field specs. Always sent, even
// empty: that's how unticking the opt-out clears a stored override.
function collectParams() {
  const budget = {};
  if ($('#f-ignoreGuard').checked) budget.ignoreGuard = true;
  const head = $('#f-minHeadroomPct').value;
  if (head !== '') budget.minHeadroomPct = Number(head);
  return { ...collectFields($('#ext-fields')), ...collectFields($('#ext-fields-adv')), budget };
}

function advancedSummary(job) {
  const parts = [];
  const ext = extById(jobType());
  // Surface advanced ext fields that differ from their default.
  for (const f of (ext?.fields ?? []).filter((f) => f.advanced)) {
    const v = job?.params?.[f.key];
    if (v != null && v !== '' && v !== (f.default ?? '')) parts.push(String(v));
  }
  parts.push(`${job?.timeoutMin ?? 60}m timeout`);
  if (job?.retryCount) parts.push(`${job.retryCount} retries`);
  // Worth surfacing on the collapsed summary: it opts out of the guard.
  if (job?.params?.budget?.ignoreGuard) parts.push('ignores budget guard');
  if (job?.params?.budget?.minHeadroomPct) parts.push(`needs ${job.params.budget.minHeadroomPct}% headroom`);
  $('#advanced-summary').textContent = '— ' + parts.join(' · ');
}

function openDialog(job = null, clone = false) {
  editingId = clone ? null : job?.id ?? null;
  $('#dialog-title').textContent = clone ? `Clone: ${job.name}` : job ? `Edit: ${job.name}` : 'New job';
  $('#form-errors').hidden = true;
  $('#f-name').value = job ? (clone ? `${job.name} (copy)` : job.name) : '';
  setJobType(job?.type ?? exts[0]?.id ?? 'command', job?.params ?? {});
  $('#f-cwd').value = job?.cwd ?? home;
  $('#f-timeoutMin').value = job?.timeoutMin ?? 60;
  $('#f-retryCount').value = job?.retryCount ?? 0;
  $('#f-retryDelayMin').value = job?.retryDelayMin ?? 5;
  $('#f-notify').value = job?.notify ?? 'failure';
  $('#f-ignoreGuard').checked = !!job?.params?.budget?.ignoreGuard;
  $('#f-minHeadroomPct').value = job?.params?.budget?.minHeadroomPct ?? '';
  $('#advanced').open = false;
  advancedSummary(job);

  $('#sched-rows').innerHTML = '';
  const entries = job ? (Array.isArray(job.schedule) ? job.schedule : [job.schedule]) : [null];
  for (const e of entries) addSchedRow(e);
  updatePreview();
  $('#job-dialog').showModal();
  $('#f-name').focus();
}

async function saveJob(ev) {
  ev.preventDefault();
  const payload = {
    name: $('#f-name').value,
    type: jobType(),
    params: collectParams(),
    cwd: $('#f-cwd').value.trim().replace(/^~(?=\/|$)/, home),
    schedules: buildSchedules(),
    timeoutMin: Number($('#f-timeoutMin').value),
    retryCount: Number($('#f-retryCount').value),
    retryDelayMin: Number($('#f-retryDelayMin').value),
    notify: $('#f-notify').value,
  };
  // Creating or editing a job is gated by a system approval, which can hold this
  // request open for up to three minutes. Without a visible waiting state the
  // dialog looks hung and the natural response is to press Submit again.
  // #dialog-save, not `button[type=submit]`: inside a method="dialog" form the
  // save button carries no explicit type, so the attribute selector matches
  // nothing and the waiting state would silently never appear. Found by driving
  // the dialog rather than by reading it.
  const btn = $('#dialog-save');
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'waiting for your approval…'; }
  try {
    if (editingId) await api('PUT', `/api/jobs/${editingId}`, payload);
    else await api('POST', '/api/jobs', payload);
    // Only past this point is anything cleared. A denied or timed-out approval
    // must leave every field exactly as typed — in some cases the input cannot
    // reasonably be reconstructed, so losing it is not an acceptable outcome.
    $('#job-dialog').close();
    toast(editingId ? 'Job updated' : 'Job created', 'ok');
    refreshJobs();
  } catch (e) {
    const box = $('#form-errors');
    box.hidden = false;
    // An approval refusal gets the shared wording, which says plainly that
    // nothing was saved and that pressing Submit again is the way forward.
    // Validation errors keep their own inline list.
    box.textContent = FAILURE_COPY[e.code]
      ?? (e.data?.errors || [e.data?.error || 'save failed']).join(' · ');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

// ---------- burn-down planner ----------
// A preview the user confirms. The server plans and re-checks on confirm; this
// only ever displays what came back — no client-side arithmetic that could
// disagree with the policy that produced the slots.
let planned = null;

function openPlanDialog() {
  planned = null;
  $('#plan-errors').hidden = true;
  $('#plan-result').hidden = true;
  $('#plan-confirm').hidden = true;
  $('#p-window').innerHTML = resetWindows()
    .map((w) => `<option value="${esc(w)}">${esc(resetWindowLabel(w))} window</option>`).join('');
  const soon = new Date(Date.now() + 6 * 3600e3);
  $('#p-deadline').value = new Date(soon.getTime() - soon.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  // Bead-backed rows are deliberately not offered. Confirming a plan enables
  // every job in it, and a bead's row is disabled on purpose so only its project
  // can launch it — with a lease, a claim and a close. Arming one here would skip
  // all three and could double-run the bead. The server enforces this too.
  const plannable = jobs.filter((j) => !j.params?._beadId);
  const beadCount = jobs.length - plannable.length;
  $('#p-jobs').innerHTML = plannable.length
    ? plannable.map((j) => `<label><input type="checkbox" value="${esc(j.id)}">${esc(j.name)}${j.enabled ? '' : ' (disabled)'}</label>`).join('')
      + (beadCount ? `<p class="muted">${beadCount} bead task${beadCount === 1 ? '' : 's'} hidden — those are run by their project, not planned here.</p>` : '')
    : '<p class="muted">No jobs to plan with yet.</p>';
  $('#plan-dialog').showModal();
}

function planBody() {
  return {
    window: $('#p-window').value,
    targetPct: Number($('#p-targetPct').value),
    deadline: $('#p-deadline').value ? new Date($('#p-deadline').value).toISOString() : null,
    minGapMin: Number($('#p-minGapMin').value),
    maxConcurrent: Number($('#p-maxConcurrent').value),
    jobIds: $$('#p-jobs input:checked').map((i) => i.value),
  };
}

function renderPlan(p) {
  const name = (id) => jobs.find((j) => j.id === id)?.name ?? id.slice(0, 8);
  // The policy labels jobs by id prefix (it has no reason to know names) and
  // windows by key. Both are for machines; swap in what the user calls them.
  const humanise = (s) => jobs.reduce((t, j) => t.replaceAll(j.id.slice(0, 8), j.name), s)
    .replaceAll(p.window, resetWindowLabel(p.window));
  $('#plan-result').hidden = false;
  $('#plan-confirm').hidden = false;
  $('#plan-summary').innerHTML = `<strong>${p.slots.length}</strong> fire${p.slots.length === 1 ? '' : 's'}`
    + ` · about <strong>${p.estTotalPct}%</strong> of the ${esc(resetWindowLabel(p.window))} window (of ${p.usablePct}% usable)`
    + ` · confidence <span class="conf-${p.confidence}">${p.confidence}</span>`
    + (p.confidence === 'low' ? ' — cost per run is an estimate from fewer than 3 measured runs, so treat the count as a guess.' : '');
  $('#plan-assumptions').innerHTML = p.assumptions.map((a) => `<li>${esc(humanise(a))}</li>`).join('');
  $('#plan-slots').innerHTML = p.slots
    .map((s) => `<div><span>${esc(new Date(s.at).toLocaleString())}</span><span>${esc(name(s.jobId))}</span><span>~${s.estPct}%</span></div>`).join('');
}

async function previewPlan() {
  const errors = $('#plan-errors');
  errors.hidden = true;
  $('#plan-result').hidden = true;
  $('#plan-confirm').hidden = true;
  planned = null;
  try {
    planned = await api('POST', '/api/budget/plan', planBody());
    renderPlan(planned);
  } catch (e) {
    errors.hidden = false;
    errors.textContent = e.data?.reason || (e.data?.errors || []).join(' · ') || e.data?.error || 'could not plan';
  }
}

async function confirmPlan() {
  if (!planned?.slots?.length) return;
  try {
    const r = await api('POST', '/api/budget/plan/apply', { slots: planned.slots });
    $('#plan-dialog').close();
    toast(`Scheduled ${r.added} fire${r.added === 1 ? '' : 's'}`
      + (r.enabled.length ? ` · enabled ${r.enabled.join(', ')}` : ''), 'ok');
    refreshJobs();
  } catch (e) {
    const errors = $('#plan-errors');
    errors.hidden = false;
    errors.textContent = (e.data?.errors || [e.data?.error || 'could not schedule']).join(' · ');
  }
}

// ---------- history ----------
function setStatusChip(status) {
  runStatusFilter = status;
  $$('#status-chips .chip').forEach((c) => c.classList.toggle('active', c.dataset.status === status));
}

function matchesStatusFilter(r) {
  if (!runStatusFilter) return true;
  if (runStatusFilter === 'active') return ['running', 'queued'].includes(r.status);
  if (runStatusFilter === 'fail') return ['fail', 'timeout'].includes(r.status);
  return r.status === runStatusFilter;
}

function syncHistoryJobOptions() {
  const sel = $('#history-job');
  const prev = sel.value;
  const want = '<option value="">All jobs</option>' + jobs.map((j) => `<option value="${j.id}">${esc(j.name)}</option>`).join('');
  if (sel.dataset.opts !== want) {
    sel.innerHTML = want;
    sel.dataset.opts = want;
  }
  sel.value = prev;
  if (sel.value !== prev) sel.value = ''; // selected job was deleted
}

async function refreshRuns() {
  syncHistoryJobOptions();
  const jobId = $('#history-job').value;
  try {
    const { runs } = await api('GET', `/api/runs?limit=100${jobId ? `&job=${jobId}` : ''}`);
    const shown = runs.filter(matchesStatusFilter);
    const name = (id) => jobs.find((j) => j.id === id)?.name ?? id.slice(0, 8);
    const list = $('#runs-list');
    list.innerHTML = '';
    $('#runs-empty').hidden = shown.length > 0;
    for (const r of shown) {
      const live = ['running', 'queued'].includes(r.status);
      const el = document.createElement('div');
      el.className = 'item clickable';
      el.innerHTML = `
        ${statusHtml(r.status)}
        <div class="grow">
          <div class="title">${esc(name(r.jobId))}</div>
          <div class="sub">
            <span>${r.trigger}</span>
            <span title="${esc(fullTime(r.startedAt || r.createdAt))}">${relTime(r.startedAt || r.createdAt)}</span>
            <span>${duration(r.durationMs)}</span>
            ${r.meta?.skipReason ? `<span class="skip-chip" title="Why this fire didn't run">${esc(r.meta.skipReason)}</span>` : ''}
            ${live && r.meta?.stopRung ? `<span class="stopping-chip" title="${esc(r.meta.stopReason ?? 'stopping')} — currently at ${esc(r.meta.stopRung)}">stopping…</span>` : ''}
          </div>
        </div>
        <div class="actions">
          ${live && !r.meta?.stopRung ? '<button class="icon soft-stop-btn" data-act="stop" title="Wind down at the next safe point">⤓</button>' : ''}
          ${live ? '<button class="icon stop-btn" data-act="kill" title="Stop now">■</button>' : ''}
          <button class="icon" data-act="log" title="View log">☰</button>
        </div>`;
      el.addEventListener('click', () => openLog(r, name(r.jobId)));
      el.querySelector('[data-act="log"]').addEventListener('click', (ev) => { ev.stopPropagation(); openLog(r, name(r.jobId)); });
      el.querySelector('[data-act="kill"]')?.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          await api('POST', `/api/runs/${r.id}/kill`);
          toast('Run stopped', 'ok');
          refreshRuns();
        } catch (e) { apiErr(e, 'kill failed'); }
      });
      el.querySelector('[data-act="stop"]')?.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          await api('POST', `/api/runs/${r.id}/stop`);
          toast('Winding down at the next safe point', 'ok');
          refreshRuns();
        } catch (e) { apiErr(e, 'stop failed'); }
      });
      list.appendChild(el);
    }
  } catch { /* daemon briefly down */ }
}

// ---------- log drawer ----------
function setLogKill(run) {
  const live = ['running', 'queued'].includes(run.status);
  const btn = $('#log-kill');
  btn.hidden = !live;
  btn.onclick = async () => {
    try {
      await api('POST', `/api/runs/${run.id}/kill`);
      btn.hidden = true;
      toast('Run stopped', 'ok');
    } catch (e) { apiErr(e, 'kill failed'); }
  };
  // Only offered while the ladder hasn't started — asking twice does nothing.
  const soft = $('#log-stop');
  soft.hidden = !live || !!run.meta?.stopRung;
  soft.onclick = async () => {
    try {
      await api('POST', `/api/runs/${run.id}/stop`);
      soft.hidden = true;
      toast('Winding down at the next safe point', 'ok');
    } catch (e) { apiErr(e, 'stop failed'); }
  };
}

// Extension-defined run actions (e.g. claude's "Resume in Terminal") — shown
// when run.meta carries the field the action requires.
function renderRunActions(run) {
  const wrap = $('#run-actions');
  wrap.innerHTML = '';
  const job = jobs.find((j) => j.id === run.jobId);
  for (const a of extById(job?.type)?.runActions ?? []) {
    if (a.requiresRunMeta && !run.meta?.[a.requiresRunMeta]) continue;
    const btn = document.createElement('button');
    btn.textContent = a.label;
    btn.addEventListener('click', () =>
      api('POST', `/api/runs/${run.id}/actions/${a.id}`).catch((e) => apiErr(e, `${a.label} failed`)));
    wrap.appendChild(btn);
  }
}

// The drawer is a snapshot, not a stream. There is no SSE tail any more:
// `EventSource` cannot send an Authorization header, so a live tail would have
// meant a second auth path with the token in the URL. What replaces it is this
// plus Refresh, plus the `tail -f` line for anyone who wants output as it lands.
async function loadLogSnapshot(run) {
  const view = $('#log-view');
  try {
    // api() returns the parsed body, or the raw text when it isn't JSON — a log
    // is text/plain, so this is the log itself.
    const text = await api('GET', `/api/runs/${run.id}/log`);
    view.textContent = typeof text === 'string' ? text : '';
    view.scrollTop = view.scrollHeight;
    $('#log-asof').textContent = `as of ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    apiErr(e, 'could not load the log');
  }
  // Progress used to arrive as a stream event; it now rides on the run row, which
  // /api/runs already returns, so it is only as fresh as the last read.
  const p = run.progress;
  $('#log-progress').textContent = p
    ? `⚙ ${p.text ?? p.activity ?? ''}${p.turns ? ` · ${p.turns} turns` : ''}`
    : '';
  $('#log-follow').textContent = run.logPath ? `tail -f ${run.logPath}` : '';
}

function openLog(run, jobName = '') {
  logRun = run;
  logJobName = jobName;
  $('#log-drawer').hidden = false;
  $('#log-title').textContent = `${jobName || 'run'} · ${run.status}`;
  // Cleared before the fetch, not after: loadLogSnapshot fills these in once the
  // request resolves, and until then the previous run's log path and progress
  // would still be sitting in the header describing a different run.
  $('#log-view').textContent = '';
  $('#log-asof').textContent = '';
  $('#log-progress').textContent = '';
  $('#log-follow').textContent = '';
  setLogKill(run);
  renderRunActions(run);
  loadLogSnapshot(run);
}

function closeLog() {
  logRun = null;
  $('#log-drawer').hidden = true;
}

// Refresh re-reads the run row before the log, so status, progress, the stop
// buttons and any extension run action (which can appear only once the run has
// written its meta) all move together rather than drifting apart.
async function refreshLog() {
  if (!logRun) return;
  try {
    const fresh = (await api('GET', '/api/runs?limit=100')).runs.find((r) => r.id === logRun.id);
    if (fresh) {
      logRun = fresh;
      $('#log-title').textContent = `${logJobName || 'run'} · ${fresh.status}`;
      setLogKill(fresh);
      renderRunActions(fresh);
    }
  } catch { /* the snapshot below is the point of the click — still fetch it */ }
  await loadLogSnapshot(logRun);
}

// ---------- settings ----------
function renderExtSettings(values) {
  const wrap = $('#ext-settings');
  wrap.innerHTML = '';
  for (const e of exts) {
    if (!e.settings.length) continue;
    const fs = document.createElement('fieldset');
    fs.dataset.ext = e.id;
    fs.innerHTML = `<legend>${iconFor(e, { size: 13 })} ${esc(e.name)}</legend>`;
    const box = document.createElement('div');
    fs.appendChild(box);
    renderFields(box, e.settings, values?.[e.id] ?? {});
    wrap.appendChild(fs);
  }
  if (!wrap.children.length) wrap.innerHTML = '<p class="muted">No extension settings.</p>';
}

// Whether the guard is actually enforcing right now — it fails open, so
// "not enforcing" is normal and has to be said out loud rather than implied.
async function renderBudgetState() {
  const el = $('#budget-state');
  if (!el) return;
  try {
    const b = await api('GET', '/api/budget');
    el.classList.toggle('warn', !b.enforcing);
    el.textContent = b.enforcing
      ? `Enforcing. A scheduled fire right now would ${b.blocked ? `be skipped — ${b.blocked}` : 'be allowed'}.`
      : `Not enforcing — ${b.why}. Every scheduled fire is being allowed through.`;
  } catch {
    el.textContent = '';
  }
}

async function loadSettings() {
  try {
    const s = await api('GET', '/api/settings');
    home = s.home || '';
    renderExtSettings(s.extensions);
    $('#s-usageShow').value = s.usageShow;
    $('#s-usagePollSec').value = s.usagePollSec;
    $('#s-usageWarnPct').value = s.usageWarnPct;
    $('#s-usageCritPct').value = s.usageCritPct;
    $('#s-budgetGuard').checked = !!s.budgetGuard;
    $('#s-reserveFiveHourPct').value = s.reserveFiveHourPct;
    $('#s-reserveWeeklyPct').value = s.reserveWeeklyPct;
    $('#s-pauseOnWarning').checked = !!s.pauseOnWarning;
    $('#s-awakeResetLeadMin').value = s.awakeResetLeadMin;
    $('#s-softGraceSec').value = Math.round(s.softGraceMs / 1000);
    // Stored as one string; the textarea is just a friendlier editor for it, so
    // commas from an older value are shown as the lines they mean.
    $('#s-projectRoots').value = (s.projectRoots ?? '').split(/[,\n]/).map((r) => r.trim()).filter(Boolean).join('\n');
    $('#s-beadsPollSec').value = s.beadsPollSec;
    $('#s-bdPath').value = s.bdPath ?? '';
    $('#s-worktreeRoot').value = s.worktreeRoot ?? '';
    $('#s-burstMinGapMin').value = s.burstMinGapMin ?? 15;
    renderBudgetState();
  } catch { /* daemon briefly down */ }
}

// One timer for the transient 'saved ✓': a second save inside the 2s window must
// cancel the first save's wipe, or its own confirmation vanishes almost instantly.
let settingsMsgTimer;

async function saveSettings(ev) {
  ev.preventDefault();
  const extensions = {};
  for (const fs of $$('#ext-settings fieldset')) extensions[fs.dataset.ext] = collectFields(fs);
  try {
    await api('PUT', '/api/settings', {
      extensions,
      usageShow: $('#s-usageShow').value,
      usagePollSec: Number($('#s-usagePollSec').value),
      usageWarnPct: Number($('#s-usageWarnPct').value),
      usageCritPct: Number($('#s-usageCritPct').value),
      budgetGuard: $('#s-budgetGuard').checked,
      reserveFiveHourPct: Number($('#s-reserveFiveHourPct').value),
      reserveWeeklyPct: Number($('#s-reserveWeeklyPct').value),
      pauseOnWarning: $('#s-pauseOnWarning').checked,
      awakeResetLeadMin: Number($('#s-awakeResetLeadMin').value),
      softGraceMs: Number($('#s-softGraceSec').value) * 1000,
      projectRoots: $('#s-projectRoots').value.trim(),
      beadsPollSec: Number($('#s-beadsPollSec').value),
      bdPath: $('#s-bdPath').value.trim(),
      worktreeRoot: $('#s-worktreeRoot').value.trim(),
      burstMinGapMin: Number($('#s-burstMinGapMin').value),
    });
    clearTimeout(settingsMsgTimer);
    $('#settings-msg').textContent = 'saved ✓';
    settingsMsgTimer = setTimeout(() => { $('#settings-msg').textContent = ''; }, 2000);
    refreshUsage(); // a display-mode change should be visible without a reload
    renderBudgetState();

  } catch (e) {
    // An error must outlive any pending wipe from an earlier success.
    clearTimeout(settingsMsgTimer);
    $('#settings-msg').textContent = (e.data?.errors || [e.data?.error || 'save failed']).join(' · ');
  }
}

// ---------- wire up ----------
$('#new-job').addEventListener('click', () => openDialog());
$('#job-form').addEventListener('submit', saveJob);
$('#dialog-cancel').addEventListener('click', () => $('#job-dialog').close());
$('#add-sched').addEventListener('click', () => { addSchedRow(); updatePreview(); });
$('#job-search').addEventListener('input', (ev) => { jobSearch = ev.target.value; renderJobs(); });
$('#plan-burndown').addEventListener('click', openPlanDialog);
$('#plan-preview').addEventListener('click', previewPlan);
$('#plan-confirm').addEventListener('click', confirmPlan);
$('#plan-cancel').addEventListener('click', () => $('#plan-dialog').close());
$('#history-job').addEventListener('change', refreshRuns);
$$('#status-chips .chip').forEach((c) => c.addEventListener('click', () => { setStatusChip(c.dataset.status); refreshRuns(); }));
$('#log-close').addEventListener('click', closeLog);
$('#log-refresh').addEventListener('click', refreshLog);
$('#settings-form').addEventListener('submit', saveSettings);
// Clicking the strip or the chip forces a probe; the floor throttle answers 429
// with the current reading, so the click is never a dead end.
for (const sel of ['#usage-strip', '#usage-chip']) {
  $(sel).addEventListener('click', async () => {
    try {
      renderUsage(await api('POST', '/api/usage/refresh'));
      toast('Usage refreshed', 'ok');
    } catch (e) {
      if (e.status === 429) {
        renderUsage(e.data);
        toast(`Just checked — try again in ${e.data.retryAfterSec}s`);
      } else apiErr(e, 'usage refresh failed');
    }
  });
}

$('#running-badge').addEventListener('click', () => {
  location.hash = '#history?status=active';
  if (hashParts().tab === 'history') { setStatusChip('active'); refreshRuns(); }
});

// awake menu
$('#awake-btn').addEventListener('click', (ev) => {
  ev.stopPropagation();
  $('#awake-menu').hidden = !$('#awake-menu').hidden;
});
document.addEventListener('click', () => { $('#awake-menu').hidden = true; });
$$('#awake-menu button[data-mode]').forEach((b) => b.addEventListener('click', async () => {
  try {
    const a = await api('PUT', '/api/awake', { mode: b.dataset.mode, minutes: b.dataset.minutes ? Number(b.dataset.minutes) : undefined });
    renderAwake(a);
    toast({ off: 'Mac may sleep normally', auto: 'Staying awake while jobs are scheduled', timed: `Staying awake until ${new Date(a.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, on: 'Staying awake indefinitely' }[a.mode], 'ok');
  } catch (e) { apiErr(e, 'failed to set'); }
}));

$$('#pause-seg button').forEach((b) => b.addEventListener('click', () => setPauseMode(b.dataset.mode)));

$('#cleanup-btn').addEventListener('click', async (ev) => {
  if ($('#cleanup-confirm').value !== 'cleanup') return toast('Type "cleanup" to confirm.', 'err');
  if (!await guardedSubmit(ev.currentTarget, () => api('POST', '/api/cleanup'))) return;
  $('#cleanup-confirm').value = '';
  toast('All jobs, runs and logs removed.', 'ok');
  location.hash = '#jobs';
  refreshJobs();
});

$('#uninstall-btn').addEventListener('click', async (ev) => {
  if ($('#uninstall-confirm').value !== 'uninstall') return toast('Type "uninstall" to confirm.', 'err');
  if (!await guardedSubmit(ev.currentTarget, () => api('POST', '/api/uninstall'))) return;
  document.body.innerHTML = '<main><h2>Uninstalling…</h2><p>The daemon is shutting down and removing itself. You can close this tab.</p></main>';
});

// boot
(async () => {
  try {
    exts = (await api('GET', '/api/extensions')).extensions;
  } catch { exts = []; }
  buildTypeSeg();
  await refreshJobs();
  await loadSettings();
  showTab();
  setInterval(refreshJobs, 2500);
  setInterval(() => { if (!$('#tab-history').hidden) refreshRuns(); }, 2500);
})();
