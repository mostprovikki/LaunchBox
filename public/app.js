import { renderFields, collectFields } from './fields.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const api = async (method, path, body) => {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw Object.assign(new Error('api error'), { status: res.status, data });
  return data;
};

let exts = []; // extension manifests from /api/extensions
let jobs = [];
let editingId = null;
let logSource = null;
let logRun = null;
let home = '';
let jobSearch = '';
let runStatusFilter = '';

const extById = (id) => exts.find((e) => e.id === id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- toasts ----------
function toast(msg, kind = '', ms = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
const apiErr = (e, fallback) => toast((e.data?.errors || [e.data?.error || fallback]).join(' · '), 'err');

// ---------- time helpers ----------
function relTime(iso) {
  if (!iso) return '—';
  const diff = new Date(iso) - Date.now();
  const abs = Math.abs(diff);
  const units = [[86400e3, 'd'], [3600e3, 'h'], [60e3, 'm'], [1e3, 's']];
  for (const [ms, u] of units) {
    if (abs >= ms) {
      const v = Math.round(abs / ms);
      return diff > 0 ? `in ${v}${u}` : `${v}${u} ago`;
    }
  }
  return 'now';
}
function fullTime(iso) {
  return iso ? new Date(iso).toLocaleString() : '';
}
function duration(ms) {
  if (ms == null) return '';
  if (ms < 60e3) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms / 60e3) + 'm ' + Math.round((ms % 60e3) / 1000) + 's';
}

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
function hashParts() {
  const [tab, query] = (location.hash || '#jobs').slice(1).split('?');
  return { tab: tab || 'jobs', query: new URLSearchParams(query || '') };
}
function showTab() {
  const { tab, query } = hashParts();
  for (const s of ['jobs', 'history', 'settings']) {
    $(`#tab-${s}`).hidden = s !== tab;
    document.querySelector(`.tabs a[data-tab="${s}"]`).classList.toggle('active', s === tab);
  }
  if (tab === 'history') {
    if (query.has('job')) $('#history-job').value = query.get('job');
    if (query.has('status')) setStatusChip(query.get('status'));
    if (query.toString()) history.replaceState(null, '', '#history');
    refreshRuns();
  }
  if (tab === 'settings') loadSettings();
}
window.addEventListener('hashchange', showTab);

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
        <div class="title"><span class="type-ico" title="${esc(extById(j.type)?.name ?? j.type)}">${esc(extById(j.type)?.icon ?? '⚙')}</span>${esc(j.name)}</div>
        <div class="sub">
          <span>${esc(scheduleText(j.schedule))}</span>
          <span title="${esc(fullTime(j.nextFire))}">${j.nextFire ? 'next ' + relTime(j.nextFire) : j.enabled ? '' : 'disabled'}</span>
          ${j.lastRun ? `<span class="linkish" data-act="last" title="${esc(fullTime(j.lastRun.finishedAt || j.lastRun.startedAt))}">last: ${statusHtml(j.lastRun.status)}</span>` : ''}
        </div>
      </div>
      <div class="actions">
        ${live
          ? '<button class="icon stop-btn" data-act="kill" title="Stop this run">■</button>'
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
    renderJobs();
  } catch { /* daemon briefly down — next poll retries */ }
}

async function onJobAction(job, act, el) {
  try {
    if (act === 'run') {
      const run = await api('POST', `/api/jobs/${job.id}/run`);
      if (run.status === 'skipped') return toast(`"${job.name}" is already running`, 'err');
      toast(`Started "${job.name}"${run.status === 'queued' ? ' (queued)' : ''}`, 'ok');
      location.hash = `#history?job=${job.id}`;
      openLog(run, job.name);
    } else if (act === 'kill') {
      await api('POST', `/api/runs/${job.lastRun.id}/kill`);
      toast(`Stopped "${job.name}"`, 'ok');
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
};
const PRESET_OPTS = `
  <option value="daily">Daily at…</option>
  <option value="weekdays">Weekdays at…</option>
  <option value="hours">Every N hours</option>
  <option value="minutes">Every N minutes</option>
  <option value="once">Once at…</option>
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
    <button type="button" class="icon sr-del" title="Remove this time">✕</button>`;
  const sel = row.querySelector('.sr-preset');

  if (entry?.type === 'once') {
    sel.value = 'once';
    const d = new Date(entry.at);
    row.querySelector('.sr-once').value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
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
  };
  sel.addEventListener('change', () => { sync(); updatePreview(); });
  row.querySelectorAll('input').forEach((i) => i.addEventListener('input', updatePreview));
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
    try {
      const { next } = await api('POST', '/api/schedule/preview', { schedules: buildSchedules() });
      $('#f-preview').textContent = next.length
        ? 'Next: ' + next.map((d) => new Date(d).toLocaleString()).join('  ·  ')
        : 'Never fires';
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
    .map((e) => `<button type="button" data-value="${esc(e.id)}">${esc(e.icon)} ${esc(e.name)}</button>`)
    .join('');
  $$('#f-type button').forEach((b) => b.addEventListener('click', () => setJobType(b.dataset.value, collectParams())));
}

function collectParams() {
  return { ...collectFields($('#ext-fields')), ...collectFields($('#ext-fields-adv')) };
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
  try {
    if (editingId) await api('PUT', `/api/jobs/${editingId}`, payload);
    else await api('POST', '/api/jobs', payload);
    $('#job-dialog').close();
    toast(editingId ? 'Job updated' : 'Job created', 'ok');
    refreshJobs();
  } catch (e) {
    const box = $('#form-errors');
    box.hidden = false;
    box.textContent = (e.data?.errors || [e.data?.error || 'save failed']).join(' · ');
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
          </div>
        </div>
        <div class="actions">
          ${live ? '<button class="icon stop-btn" data-act="kill" title="Stop">■</button>' : ''}
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
      list.appendChild(el);
    }
  } catch { /* daemon briefly down */ }
}

// ---------- log drawer ----------
function setLogKill(run) {
  const btn = $('#log-kill');
  btn.hidden = !['running', 'queued'].includes(run.status);
  btn.onclick = async () => {
    try {
      await api('POST', `/api/runs/${run.id}/kill`);
      btn.hidden = true;
      toast('Run stopped', 'ok');
    } catch (e) { apiErr(e, 'kill failed'); }
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

function openLog(run, jobName = '') {
  logSource?.close();
  logRun = run;
  $('#log-drawer').hidden = false;
  $('#log-title').textContent = `${jobName || 'run'} · ${run.status}`;
  $('#log-progress').textContent = '';
  $('#log-view').textContent = '';
  setLogKill(run);
  renderRunActions(run);

  logSource = new EventSource(`/api/runs/${run.id}/tail`);
  const view = $('#log-view');
  logSource.onmessage = (ev) => {
    view.textContent += ev.data + '\n';
    view.scrollTop = view.scrollHeight;
  };
  logSource.addEventListener('progress', (ev) => {
    const p = JSON.parse(ev.data);
    $('#log-progress').textContent = `⚙ ${p.text ?? p.activity ?? ''}${p.turns ? ` · ${p.turns} turns` : ''}`;
  });
  logSource.addEventListener('done', async (ev) => {
    $('#log-title').textContent = `${jobName || 'run'} · ${ev.data}`;
    $('#log-kill').hidden = true;
    logSource.close();
    // meta (e.g. sessionId) may have landed during the run — re-check actions
    try { renderRunActions(await api('GET', `/api/runs?limit=100`).then((d) => d.runs.find((r) => r.id === run.id)) ?? run); } catch {}
    if (!$('#tab-history').hidden) refreshRuns();
  });
  logSource.onerror = () => logSource.close();
}

function closeLog() {
  logSource?.close();
  logRun = null;
  $('#log-drawer').hidden = true;
}

// ---------- settings ----------
function renderExtSettings(values) {
  const wrap = $('#ext-settings');
  wrap.innerHTML = '';
  for (const e of exts) {
    if (!e.settings.length) continue;
    const fs = document.createElement('fieldset');
    fs.dataset.ext = e.id;
    fs.innerHTML = `<legend>${esc(e.icon)} ${esc(e.name)}</legend>`;
    const box = document.createElement('div');
    fs.appendChild(box);
    renderFields(box, e.settings, values?.[e.id] ?? {});
    wrap.appendChild(fs);
  }
  if (!wrap.children.length) wrap.innerHTML = '<p class="muted">No extension settings.</p>';
}

async function loadSettings() {
  try {
    const s = await api('GET', '/api/settings');
    home = s.home || '';
    renderExtSettings(s.extensions);
    $('#pause-all').checked = s.paused;
    $('#paused-banner').hidden = !s.paused;
  } catch { /* daemon briefly down */ }
}

async function saveSettings(ev) {
  ev.preventDefault();
  const extensions = {};
  for (const fs of $$('#ext-settings fieldset')) extensions[fs.dataset.ext] = collectFields(fs);
  try {
    await api('PUT', '/api/settings', { extensions });
    $('#settings-msg').textContent = 'saved ✓';
    setTimeout(() => { $('#settings-msg').textContent = ''; }, 2000);
  } catch (e) {
    $('#settings-msg').textContent = (e.data?.errors || [e.data?.error || 'save failed']).join(' · ');
  }
}

// ---------- wire up ----------
$('#new-job').addEventListener('click', () => openDialog());
$('#job-form').addEventListener('submit', saveJob);
$('#dialog-cancel').addEventListener('click', () => $('#job-dialog').close());
$('#add-sched').addEventListener('click', () => { addSchedRow(); updatePreview(); });
$('#job-search').addEventListener('input', (ev) => { jobSearch = ev.target.value; renderJobs(); });
$('#history-job').addEventListener('change', refreshRuns);
$$('#status-chips .chip').forEach((c) => c.addEventListener('click', () => { setStatusChip(c.dataset.status); refreshRuns(); }));
$('#log-close').addEventListener('click', closeLog);
$('#settings-form').addEventListener('submit', saveSettings);
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

$('#pause-all').addEventListener('change', async (ev) => {
  await api('PUT', '/api/settings', { paused: ev.target.checked });
  $('#paused-banner').hidden = !ev.target.checked;
  toast(ev.target.checked ? 'All schedules paused' : 'Schedules resumed');
});

$('#cleanup-btn').addEventListener('click', async () => {
  if ($('#cleanup-confirm').value !== 'cleanup') return toast('Type "cleanup" to confirm.', 'err');
  await api('POST', '/api/cleanup');
  $('#cleanup-confirm').value = '';
  toast('All jobs, runs and logs removed.', 'ok');
  location.hash = '#jobs';
  refreshJobs();
});

$('#uninstall-btn').addEventListener('click', async () => {
  if ($('#uninstall-confirm').value !== 'uninstall') return toast('Type "uninstall" to confirm.', 'err');
  await api('POST', '/api/uninstall');
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
