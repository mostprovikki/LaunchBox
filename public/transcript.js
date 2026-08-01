// The Sessions tab's transcript viewer: a turn array -> a rendered
// conversation. Per docs/specs/2026-07-27-sessions-tab-visual-design.md, this
// is deliberately ONE GENERIC renderer — per-tool renderers (Bash as a shell
// line, Edit as a diff, TodoWrite as a checklist) are claude-scheduler-a6o,
// not this bead. What earns the deferral is fixing three defects the spec
// found in the upstream dashboard this tab's visual language is adopted from:
//   1. a one-line summary in the collapsed header, so a collapsed tool call
//      is still skimmable ("used Bash · git log -1 …", not a bare "used Bash");
//   2. tool_result paired with the tool_use it answers, via toolUseId — the
//      join key upstream discards, which is why it can't do this;
//   3. tool input WRAPS, never clips horizontally.
import { esc } from './util.js';
import { renderMarkdown } from './md.js';

// ---------- one-line collapsed summaries ----------
// Not per-tool RENDERING (that's the deferred bead) — just enough of a peek at
// well-known shapes that a collapsed call reads as more than its name. An
// unrecognised tool falls through to the first input key, and a tool with no
// usable input falls through to nothing rather than throwing.
function truncate(s, n = 90) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function firstLine(s) {
  const str = String(s ?? '');
  const nl = str.indexOf('\n');
  return nl === -1 ? str : `${str.slice(0, nl)}…`;
}

const SUMMARIZERS = {
  Bash: (i) => firstLine(i.command),
  Read: (i) => i.file_path,
  Write: (i) => i.file_path,
  Edit: (i) => i.file_path,
  MultiEdit: (i) => i.file_path,
  Grep: (i) => i.pattern,
  Glob: (i) => i.pattern,
  WebFetch: (i) => i.url,
  WebSearch: (i) => i.query,
  Task: (i) => i.description || firstLine(i.prompt),
  TodoWrite: (i) => (Array.isArray(i.todos) ? `${i.todos.length} todo${i.todos.length === 1 ? '' : 's'}` : ''),
};

function oneLineSummary(tool, input) {
  const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  let detail = (SUMMARIZERS[tool] || (() => ''))(i);
  if (!detail) {
    const key = Object.keys(i)[0];
    if (key !== undefined) detail = `${key}: ${JSON.stringify(i[key])}`;
  }
  detail = truncate(detail, 90);
  return detail ? `used ${tool} · ${detail}` : `used ${tool}`;
}

// ---------- hand-rolled JSON syntax highlighter ----------
// A token-type walk over a value we already parsed — not a language, not a
// regex pass over text. Every leaf is escaped individually via esc(), so a
// string leaf containing HTML-looking text (a Bash command with a `<`, say)
// can never inject a tag; only the wrapping <span class="jt-*"> markup here is
// trusted.
function indent(depth) {
  return '  '.repeat(depth);
}

function highlightValue(v, depth = 0) {
  if (v === null) return '<span class="jt-null">null</span>';
  if (v === undefined) return '<span class="jt-null">undefined</span>';
  const t = typeof v;
  if (t === 'string') return `<span class="jt-str">${esc(JSON.stringify(v))}</span>`;
  if (t === 'number') return `<span class="jt-num">${esc(String(v))}</span>`;
  if (t === 'boolean') return `<span class="jt-bool">${esc(String(v))}</span>`;
  if (Array.isArray(v)) {
    if (v.length === 0) return '<span class="jt-punc">[]</span>';
    const items = v.map((item) => `${indent(depth + 1)}${highlightValue(item, depth + 1)}`);
    return `<span class="jt-punc">[</span>\n${items.join(',\n')}\n${indent(depth)}<span class="jt-punc">]</span>`;
  }
  if (t === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 0) return '<span class="jt-punc">{}</span>';
    const rows = keys.map((k) => `${indent(depth + 1)}<span class="jt-key">${esc(JSON.stringify(k))}</span>`
      + `<span class="jt-punc">: </span>${highlightValue(v[k], depth + 1)}`);
    return `<span class="jt-punc">{</span>\n${rows.join(',\n')}\n${indent(depth)}<span class="jt-punc">}</span>`;
  }
  return esc(String(v));
}

/** Exported for tests/transcript-json.test.js — a pure function over a value. */
export function highlightJson(value) {
  return `<pre class="json-hl">${highlightValue(value, 0)}</pre>`;
}

// ---------- collapse/expand ----------
function collapsible(headerHtml, bodyHtml, { collapsed = true, cls = '' } = {}) {
  const el = document.createElement('div');
  el.className = `t-block ${cls}`;
  el.innerHTML = `
    <button type="button" class="t-head">
      <span class="t-caret">${collapsed ? '▸' : '▾'}</span>
      <span class="t-summary">${headerHtml}</span>
    </button>
    <div class="t-body"${collapsed ? ' hidden' : ''}>${bodyHtml}</div>`;
  const btn = el.querySelector('.t-head');
  const body = el.querySelector('.t-body');
  const caret = el.querySelector('.t-caret');
  btn.addEventListener('click', () => {
    body.hidden = !body.hidden;
    caret.textContent = body.hidden ? '▸' : '▾';
  });
  return el;
}

// ---------- per-role rendering ----------
function proseEl(cls, text) {
  const el = document.createElement('div');
  el.className = cls;
  // The one path transcript prose takes to the DOM: renderMarkdown() ->
  // DOMPurify, from md.js — never a raw template string. Pinned by
  // tests/frontend-conventions.test.js.
  el.innerHTML = renderMarkdown(text);
  return el;
}

function renderUserTurn(turn) {
  if (turn.note) {
    const el = document.createElement('div');
    el.className = 't-turn t-user t-note';
    el.textContent = turn.note; // "[2 pasted images]" — plain text, not markdown
    return el;
  }
  const el = proseEl('t-turn t-user', turn.text);
  return el;
}

function renderAssistantTurn(turn) {
  const el = proseEl('t-turn t-assistant', turn.text);
  if (turn.model) el.dataset.model = turn.model;
  return el;
}

function resultBody(result) {
  if (!result) return '<p class="t-empty note">(no result recorded)</p>';
  const parts = [];
  if (result.text) parts.push(`<div class="t-result-text${result.isError ? ' t-error' : ''}">${esc(result.text)}</div>`);
  // structuredPatch / oldTodos-newTodos / stdout-stderr etc. — the richer
  // shape the spec's parser change preserved. The generic fallback shows it
  // as highlighted JSON rather than dropping it; per-tool rendering of it
  // (a diff view, a checklist) is the deferred bead.
  if (result.toolUseResult && typeof result.toolUseResult === 'object') {
    parts.push(highlightJson(result.toolUseResult));
  }
  return parts.join('') || '<p class="t-empty note">(empty result)</p>';
}

function renderToolTurn(turn, result) {
  const header = `${esc(oneLineSummary(turn.tool, turn.input))}`
    + (result?.isError ? ' <span class="t-err-flag">error</span>' : '');
  const bodyParts = [];
  bodyParts.push(`<div class="t-input-label">input</div>${highlightJson(turn.input ?? null)}`);
  bodyParts.push(`<div class="t-result-label">result${result?.toolUseId ? '' : ' (unpaired)'}</div>${resultBody(result)}`);
  return collapsible(header, bodyParts.join(''), { collapsed: true, cls: `t-tool${result?.isError ? ' t-tool-error' : ''}` });
}

function renderUnpairedResult(turn) {
  const header = `tool result${turn.isError ? ' <span class="t-err-flag">error</span>' : ''} (no matching call in this window)`;
  return collapsible(header, resultBody(turn), { collapsed: true, cls: 't-tool t-tool-unpaired' });
}

/**
 * turns: the array from GET /api/sessions/:id/conversation, verbatim.
 * Returns a DocumentFragment ready to append into the conversation panel.
 */
export function renderConversation(turns) {
  const frag = document.createDocumentFragment();
  if (!Array.isArray(turns) || turns.length === 0) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = 'No turns in this transcript.';
    frag.appendChild(p);
    return frag;
  }

  // Index tool_result by toolUseId first so a tool_use turn (which precedes
  // its result chronologically — see lib/sessions.js's readConversation) can
  // pull its own result inline, rather than the result rendering again later
  // as an unpaired sibling.
  const resultByToolUseId = new Map();
  for (const t of turns) {
    if (t.role === 'tool_result' && t.toolUseId) resultByToolUseId.set(t.toolUseId, t);
  }
  const consumed = new Set();

  for (const turn of turns) {
    if (turn.role === 'user') { frag.appendChild(renderUserTurn(turn)); continue; }
    if (turn.role === 'assistant') { frag.appendChild(renderAssistantTurn(turn)); continue; }
    if (turn.role === 'tool_use') {
      const result = turn.toolUseId ? resultByToolUseId.get(turn.toolUseId) : null;
      if (result) consumed.add(result);
      frag.appendChild(renderToolTurn(turn, result));
      continue;
    }
    if (turn.role === 'tool_result') {
      if (consumed.has(turn)) continue; // already rendered inline with its call
      frag.appendChild(renderUnpairedResult(turn));
      continue;
    }
    // Unknown future role: render as JSON rather than dropping it silently.
    const el = document.createElement('div');
    el.className = 't-turn t-unknown';
    el.innerHTML = highlightJson(turn);
    frag.appendChild(el);
  }
  return frag;
}
