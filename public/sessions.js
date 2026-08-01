// The Sessions tab: ~/.claude/projects transcripts, read mostly, with rename/
// delete/resume as the only writes. Shape follows public/projects.js — its own
// listeners, a 5s visibility-gated tick — per the M5 design note.
//
// Visual language is deliberately NOT the rest of the app: see
// docs/specs/2026-07-27-sessions-tab-visual-design.md. Adopted from the
// upstream claude-sessions-dashboard (MIT, NOTICE) and scoped to this tab only
// — the chip grid, labelled actions, sentence tooltips, inline arm-then-
// confirm delete.
//
// The one thing this tab must never do: render a *guessed* cwd as if it were
// a fact. 3 of 59 real sessions have no in-row cwd and fall back to a lossy
// folder-name decode that, on this machine, produces a path that doesn't
// exist (M5 acceptance criterion). Every cwd chip below checks cwdGuessed.
import { $, $$, api, apiErr, esc, toast, relTime, fullTime, duration } from './util.js';
import { renderConversation } from './transcript.js';

let sessions = []; // last /api/sessions body's `sessions`, post-filter is done at render time
let hiddenCount = 0;
let showAll = false;
let search = '';
const armedDelete = new Set(); // session ids with the inline confirm open
let pendingOpenId = null; // consumed once, from a run row's cross-link
let currentConvoId = null; // which session the transcript dialog is showing
let convoMode = 'full'; // 'full' | 'prompts'

// ---------- formatting ----------
// 4187 -> "4.2k". Kept from upstream's fmtTok (M5 plan §5.7) because a raw
// token count is unreadable at these magnitudes and every card carries one.
function fmtTok(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 10000) return `${(v / 1000).toFixed(1)}k`;
  if (v < 1e6) return `${Math.round(v / 1000)}k`;
  return `${(v / 1e6).toFixed(1)}M`;
}

function daysOld(iso) {
  if (!iso) return null;
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400e3);
  return days;
}

function sessionTitle(s) {
  return s.customTitle || s.aiTitle || s.firstPrompt || '(untitled session)';
}

function modelMix(models) {
  const names = Object.keys(models || {});
  if (!names.length) return '—';
  // Shorten "claude-opus-4-8" style ids to their family name — the full id is
  // still one hover away via the tooltip.
  return names.map((n) => n.replace(/^claude-/, '').replace(/-\d.*$/, '')).join(', ');
}

// ---------- chip grid ----------
// icon + label + bold value, bordered, wrapping — the card's information
// layer, per the spec. `tip` is a full sentence, not a repeat of the label.
function chip(icon, label, value, tip) {
  return `<span class="s-chip"${tip ? ` data-tip="${esc(tip)}"` : ''}>`
    + `<span class="s-chip-ic" aria-hidden="true">${icon}</span>`
    + `<span class="s-chip-label">${esc(label)}</span>`
    + `<span class="s-chip-val">${value}</span></span>`;
}

function chipsFor(s) {
  const days = daysOld(s.firstTs);
  const cwdVal = s.cwdGuessed
    ? `<span class="s-guessed">${esc(s.cwd)} <span class="s-guessed-flag">guessed</span></span>`
    : esc(s.cwd || '—');
  return [
    chip('⏱', 'active', s.lastTs ? relTime(s.lastTs) : '—', s.lastTs ? `Last activity ${fullTime(s.lastTs)}` : 'No activity recorded'),
    chip('📅', 'started', s.firstTs ? fullTime(s.firstTs) : '—', 'When this session began, exact timestamp'),
    chip('🗓', 'age', days == null ? '—' : `${days}d`, days == null ? '' : `Started ${days} day${days === 1 ? '' : 's'} ago`),
    chip('↔', 'span', duration(s.spanMs), 'Wall-clock time from first message to last'),
    chip('⚡', 'active time', duration(s.activeMs), 'Sum of time Claude was actually working — always ≤ span, and the two are worth comparing: a big gap means the session sat idle between turns'),
    chip('🤖', 'models', esc(modelMix(s.models)), Object.keys(s.models || {}).join(', ') || 'No model usage recorded'),
    chip('↑', 'tokens out', fmtTok(s.tokOut), `${(s.tokOut || 0).toLocaleString()} output tokens, deduped by message id — see lib/sessions.js for why a naive sum over-counts`),
    chip('⎇', 'branch', esc(s.gitBranch || '—'), s.gitBranch ? `Git branch at session start: ${s.gitBranch}` : 'No git branch recorded'),
    chip('📁', 'cwd', cwdVal, s.cwdGuessed
      ? `This session's transcript never recorded a working directory. "${s.cwd}" was decoded from the project folder name and is a GUESS — it may not exist on disk, and --resume would fail here.`
      : `Working directory: ${s.cwd}`),
  ].join('');
}

// ---------- runs cross-link (session -> the run that created it) ----------
function runsLine(s) {
  const runs = s.runs ?? [];
  if (!runs.length) return '';
  const links = runs.map((r) => `<a href="#history?job=${esc(r.jobId)}" class="s-run-link" `
    + `data-tip="Open ${esc(r.jobName || r.jobId)}'s run history">${esc(r.jobName || r.jobId)}</a> `
    + `<span class="muted">(${esc(r.status)})</span>`).join(', ');
  return `<div class="s-runs">created by job ${links}</div>`;
}

// ---------- card ----------
function sessionCard(s) {
  const el = document.createElement('div');
  el.className = `s-card${s.running ? ' s-running' : ''}`;
  el.dataset.sessionId = s.id;
  const promptCount = s.prompts ?? 0;
  el.innerHTML = `
    <div class="s-head">
      <div class="s-title">
        ${esc(sessionTitle(s))}
        ${s.running ? '<span class="s-running-dot" data-tip="Claude Code is writing to this transcript right now">● live</span>' : ''}
      </div>
      <div class="s-sub">
        <span>${esc(s.project || '')}</span>
        ${s.entrypoint ? `<span class="s-entrypoint" data-tip="How this session was started">${esc(s.entrypoint)}</span>` : ''}
      </div>
    </div>
    <div class="s-chips">${chipsFor(s)}</div>
    ${runsLine(s)}
    <div class="s-actions">
      <button type="button" data-act="prompts">View ${promptCount} prompt${promptCount === 1 ? '' : 's'}</button>
      <button type="button" data-act="convo">Conversation</button>
      <button type="button" data-act="rename" data-tip="Give this session a name of your choosing">Rename</button>
      <button type="button" data-act="open"
        ${s.cwdGuessed ? 'disabled' : ''}
        data-tip="${esc(s.cwdGuessed
          ? 'Cannot resume: the working directory for this session is a guess and does not exist on disk'
          : 'Resume this session in Terminal (claude --resume)')}">Open</button>
      <button type="button" data-act="delete" class="danger-btn" data-tip="Delete this session permanently">Delete</button>
    </div>
    <div class="s-armed" ${armedDelete.has(s.id) ? '' : 'hidden'}>
      <span class="s-armed-warn">⚠ Delete permanently?</span>
      <button type="button" data-act="cancel-del">Cancel</button>
      <button type="button" data-act="confirm-del" class="danger-btn">Delete</button>
    </div>`;
  el.querySelectorAll('[data-act]').forEach((btn) =>
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); onAction(s, btn.dataset.act, btn); }));
  return el;
}

// ---------- list render ----------
function matches(s, q) {
  if (!q) return true;
  const hay = [sessionTitle(s), s.project, s.cwd, s.gitBranch, s.entrypoint].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

function render() {
  const list = $('#sessions-list');
  const q = search.trim().toLowerCase();
  const shown = sessions.filter((s) => matches(s, q));
  list.innerHTML = '';
  $('#sessions-empty').hidden = shown.length > 0;
  for (const s of shown) list.appendChild(sessionCard(s));

  $('#sessions-hidden-note').hidden = hiddenCount === 0;
  if (hiddenCount > 0) {
    $('#sessions-hidden-note').innerHTML = showAll
      ? `Showing every session, including ${hiddenCount} non-interactive (<code>sdk-cli</code>) one${hiddenCount === 1 ? '' : 's'} this app didn't start.`
      : `${hiddenCount} non-interactive session${hiddenCount === 1 ? '' : 's'} hidden. `
        + `<button type="button" id="sessions-show-all" class="linklike">Show all</button>`;
    $('#sessions-show-all')?.addEventListener('click', () => { showAll = true; refreshSessions(); });
  }
  $('#sessions-all-toggle').textContent = showAll ? 'Hide non-interactive' : 'Show all';

  // Drop stale armed/expanded state for sessions no longer in the list, so a
  // deleted-elsewhere session can't leave an orphaned confirm row.
  for (const id of [...armedDelete]) if (!sessions.some((s) => s.id === id)) armedDelete.delete(id);
}

export async function refreshSessions() {
  consumeHashOpen();
  try {
    const out = await api('GET', `/api/sessions${showAll ? '?all=1' : ''}`);
    sessions = out.sessions ?? [];
    hiddenCount = out.hidden ?? 0;
    render();
  } catch { /* daemon briefly down — the next tick redraws */ }
  if (pendingOpenId) {
    const id = pendingOpenId;
    pendingOpenId = null;
    const s = sessions.find((x) => x.id === id);
    if (s) openTranscript(s, 'full');
  }
}

// A run row's cross-link lands here as `#sessions?open=<id>`. Consumed once
// and stripped from the URL immediately, so the 5s tick doesn't reopen the
// dialog after the user closes it, and a reload doesn't replay it either —
// same pattern app.js already uses for `#history?job=…`.
function consumeHashOpen() {
  const [tab, q] = (location.hash || '').slice(1).split('?');
  if (tab !== 'sessions' || !q) return;
  const id = new URLSearchParams(q).get('open');
  if (id) {
    pendingOpenId = id;
    history.replaceState(null, '', '#sessions');
  }
}

// ---------- actions ----------
async function onAction(s, act, el) {
  if (act === 'prompts') return openTranscript(s, 'prompts');
  if (act === 'convo') return openTranscript(s, 'full');
  if (act === 'rename') return renameSession(s);
  if (act === 'open') return resumeSession(s, el);
  if (act === 'delete') { armedDelete.add(s.id); render(); return; }
  if (act === 'cancel-del') { armedDelete.delete(s.id); render(); return; }
  if (act === 'confirm-del') return deleteSession(s);
}

async function renameSession(s) {
  const name = prompt(`Rename session`, s.customTitle || sessionTitle(s));
  if (name == null) return; // cancelled
  const trimmed = name.trim();
  if (!trimmed) return toast('Name cannot be empty', 'err');
  try {
    await api('POST', `/api/sessions/${s.id}/rename`, { name: trimmed });
    toast('Renamed', 'ok');
    refreshSessions();
  } catch (e) { apiErr(e, 'rename failed'); }
}

async function resumeSession(s, el) {
  try {
    const out = await api('POST', `/api/sessions/${s.id}/resume`);
    toast(out?.display ? `Opened Terminal — ${out.display}` : 'Resumed in Terminal', 'ok');
  } catch (e) { apiErr(e, 'could not resume this session'); }
}

// Inline arm-then-confirm, scoped to this one card — replaces window.confirm()
// FOR SESSION DELETE ONLY. This must never be extended to project activation,
// cleanup, uninstall or hard pause: those keep window.confirm() on purpose
// (see public/projects.js's confirmActivate and the carve-out note in
// docs/specs/2026-07-27-sessions-tab-visual-design.md). Pinned by
// tests/frontend-conventions.test.js.
async function deleteSession(s) {
  armedDelete.delete(s.id);
  try {
    await api('DELETE', `/api/sessions/${s.id}`);
    toast('Session deleted', 'ok');
    refreshSessions();
  } catch (e) {
    apiErr(e, 'delete failed');
    render();
  }
}

// ---------- transcript dialog ----------
function closeTranscript() {
  currentConvoId = null;
  $('#session-dialog').close();
}

async function openTranscript(s, mode) {
  currentConvoId = s.id;
  convoMode = mode;
  $('#session-dialog-title').textContent = sessionTitle(s);
  $('#session-dialog-sub').textContent = `${s.project || ''}${s.cwdGuessed ? ' · cwd is a guess' : ''}`;
  $('#session-mode-prompts').classList.toggle('active', mode === 'prompts');
  $('#session-mode-full').classList.toggle('active', mode === 'full');
  const body = $('#session-transcript');
  body.innerHTML = '<p class="note">Loading…</p>';
  $('#session-dialog').showModal();
  try {
    const { turns } = await api('GET', `/api/sessions/${s.id}/conversation`);
    renderTranscriptInto(body, turns ?? [], mode);
  } catch (e) {
    body.innerHTML = `<p class="p-reason p-fault">${esc(e.data?.error || 'could not load this transcript')}</p>`;
  }
}

function renderTranscriptInto(body, turns, mode) {
  const filtered = mode === 'prompts' ? turns.filter((t) => t.role === 'user' && t.text) : turns;
  body.innerHTML = '';
  if (!filtered.length) {
    body.innerHTML = '<p class="note">Nothing to show in this view.</p>';
    return;
  }
  body.appendChild(renderConversation(filtered));
}

function switchMode(mode) {
  if (!currentConvoId) return;
  const s = sessions.find((x) => x.id === currentConvoId);
  if (s) openTranscript(s, mode);
}

// ---------- wire up ----------
$('#session-search').addEventListener('input', (ev) => { search = ev.target.value; render(); });
$('#sessions-all-toggle').addEventListener('click', () => { showAll = !showAll; refreshSessions(); });
$('#session-dialog-close').addEventListener('click', closeTranscript);
$('#session-mode-prompts').addEventListener('click', () => switchMode('prompts'));
$('#session-mode-full').addEventListener('click', () => switchMode('full'));

setInterval(() => {
  if ($('#tab-sessions').hidden) return;
  refreshSessions();
}, 5000);
