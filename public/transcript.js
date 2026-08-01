// The Sessions tab's transcript viewer: a turn array -> a rendered
// conversation. Originally one generic renderer (docs/specs/2026-07-27-
// sessions-tab-visual-design.md); claude-scheduler-a6o adds per-tool
// dispatch on top of it (Bash as a shell line, Edit/Write as a diff,
// TodoWrite as a checklist, Read/Grep with tool-specific summaries), plus
// search-hit expansion and long-prompt auto-collapse — the two features that
// spec deferred alongside per-tool rendering. The three defects that earlier
// bead's generic renderer already fixed still hold and are unchanged:
//   1. a one-line summary in the collapsed header, so a collapsed tool call
//      is still skimmable ("used Bash · git log -1 …", not a bare "used Bash");
//   2. tool_result paired with the tool_use it answers, via toolUseId — the
//      join key upstream discards, which is why it can't do this;
//   3. tool input WRAPS, never clips horizontally.
//
// Per-tool rendering here follows the same discipline as the generic
// renderer it extends: every dynamic string reaches innerHTML only through
// esc() (attribute/text-safe escaping) or highlightJson() (which itself
// escapes every leaf) — never a raw template interpolation of transcript-
// derived text. Pinned by tests/frontend-conventions.test.js for turn prose;
// tests/transcript.test.js covers the per-tool bodies added here.
import { esc } from './util.js';
import { renderMarkdown } from './md.js';

function asObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

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

// A structuredPatch hunk count or a Grep count is result-derived, not
// input-derived — SUMMARIZERS entries take (input, result) so the collapsed
// header can carry "· 2 hunks" / "· 3 files, 12 matches" without the reader
// having to expand the block first. Every entry still tolerates a missing
// or malformed result (optional chaining throughout); a summarizer must
// never be why a turn fails to render.
function fileEditSummary(i, result) {
  const base = i.file_path;
  const hunks = result?.toolUseResult?.structuredPatch;
  if (Array.isArray(hunks) && hunks.length) return `${base} · ${hunks.length} hunk${hunks.length === 1 ? '' : 's'}`;
  return base;
}

function todoStatusMap(todos) {
  const m = new Map();
  for (const t of Array.isArray(todos) ? todos : []) {
    if (t && typeof t === 'object') m.set(t.content ?? JSON.stringify(t), t.status);
  }
  return m;
}

// The keys (by todo content) whose status differs between old and new — used
// both for the collapsed-header "· N changed" count and for highlighting
// those rows in the expanded before/after checklist.
function changedTodoKeys(oldTodos, newTodos) {
  const oldMap = todoStatusMap(oldTodos);
  const keys = new Set();
  for (const t of Array.isArray(newTodos) ? newTodos : []) {
    const key = t && typeof t === 'object' ? (t.content ?? JSON.stringify(t)) : JSON.stringify(t);
    if (oldMap.get(key) !== t?.status) keys.add(key);
  }
  return keys;
}

const SUMMARIZERS = {
  Bash: (i) => firstLine(i.command),
  Read: (i) => i.file_path,
  Write: (i, result) => fileEditSummary(i, result),
  Edit: (i, result) => fileEditSummary(i, result),
  MultiEdit: (i, result) => fileEditSummary(i, result),
  Grep: (i, result) => {
    const bits = [i.pattern];
    const tur = result?.toolUseResult;
    if (tur && typeof tur === 'object') {
      const counts = [];
      if (tur.numFiles !== undefined) counts.push(`${tur.numFiles} file${tur.numFiles === 1 ? '' : 's'}`);
      if (tur.numMatches !== undefined) counts.push(`${tur.numMatches} match${tur.numMatches === 1 ? '' : 'es'}`);
      if (counts.length) bits.push(counts.join(', '));
    }
    return bits.filter(Boolean).join(' · ');
  },
  Glob: (i) => i.pattern,
  WebFetch: (i) => i.url,
  WebSearch: (i) => i.query,
  Task: (i) => i.description || firstLine(i.prompt),
  TodoWrite: (i, result) => {
    const todos = Array.isArray(i.todos) ? i.todos
      : (Array.isArray(result?.toolUseResult?.newTodos) ? result.toolUseResult.newTodos : null);
    if (!todos) return '';
    const base = `${todos.length} todo${todos.length === 1 ? '' : 's'}`;
    const oldTodos = result?.toolUseResult?.oldTodos;
    if (Array.isArray(oldTodos)) {
      const changed = changedTodoKeys(oldTodos, todos).size;
      if (changed) return `${base} · ${changed} changed`;
    }
    return base;
  },
};

function oneLineSummary(tool, input, result) {
  const i = asObj(input);
  let detail = (SUMMARIZERS[tool] || (() => ''))(i, result);
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

// A second, lighter collapse used INSIDE a tool block's body — e.g. Read's
// file content, which should stay collapsed even after the surrounding tool
// block itself is expanded to show the file path. Returns an HTML string
// (for splicing into a body built as a string), not an element; wireNested-
// Toggles() below wires up the resulting buttons once the whole block is in
// the DOM, the same two-phase build/wire split collapsible() uses.
function nestedToggleHtml(label, innerHtml, { collapsed = true } = {}) {
  return `<div class="t-nested">
    <button type="button" class="t-nested-toggle"><span class="t-nested-caret">${collapsed ? '▸' : '▾'}</span> ${esc(label)}</button>
    <div class="t-nested-body"${collapsed ? ' hidden' : ''}>${innerHtml}</div>
  </div>`;
}

function wireNestedToggles(root) {
  root.querySelectorAll('.t-nested-toggle').forEach((btn) => {
    const body = btn.parentElement.querySelector('.t-nested-body');
    const caret = btn.querySelector('.t-nested-caret');
    btn.addEventListener('click', () => {
      body.hidden = !body.hidden;
      caret.textContent = body.hidden ? '▸' : '▾';
    });
  });
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

// Long-prompt auto-collapse: a pasted file or long spec dwarfs the
// conversation around it. proseEl() still renders the full markdown (the
// sanitiser contract tests/frontend-conventions.test.js pins is unchanged —
// renderUserTurn still calls proseEl(text) with the WHOLE text, unmodified);
// only the presentation is clipped, via a max-height + fade that a plain
// text/expand button lifts. Never touches turn.text before it reaches
// proseEl, so nothing here can become a second, competing sanitisation path.
const LONG_PROMPT_CHARS = 700;

function renderUserTurn(turn) {
  if (turn.note) {
    const el = document.createElement('div');
    el.className = 't-turn t-user t-note';
    el.textContent = turn.note; // "[2 pasted images]" — plain text, not markdown
    return el;
  }
  const el = proseEl('t-turn t-user', turn.text);
  const text = String(turn.text ?? '');
  if (text.length <= LONG_PROMPT_CHARS) return el;

  el.classList.add('t-prompt-clipped');
  const wrap = document.createElement('div');
  wrap.className = 't-prompt-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 't-prompt-toggle';
  btn.textContent = `Show full prompt (${text.length.toLocaleString()} chars)`;
  btn.addEventListener('click', () => {
    const clipped = el.classList.toggle('t-prompt-clipped');
    btn.textContent = clipped ? `Show full prompt (${text.length.toLocaleString()} chars)` : 'Show less';
  });
  wrap.appendChild(el);
  wrap.appendChild(btn);
  return wrap;
}

function renderAssistantTurn(turn) {
  const el = proseEl('t-turn t-assistant', turn.text);
  if (turn.model) el.dataset.model = turn.model;
  return el;
}

// The generic fallback body: highlighted JSON rather than dropping the
// richer toolUseResult shape (structuredPatch / oldTodos-newTodos /
// stdout-stderr etc). Used directly for any tool with no dedicated
// renderer below, and as the tail element inside several of them.
function resultBody(result) {
  if (!result) return '<p class="t-empty note">(no result recorded)</p>';
  const parts = [];
  if (result.text) parts.push(`<div class="t-result-text${result.isError ? ' t-error' : ''}">${esc(result.text)}</div>`);
  if (result.toolUseResult && typeof result.toolUseResult === 'object') {
    parts.push(highlightJson(result.toolUseResult));
  }
  return parts.join('') || '<p class="t-empty note">(empty result)</p>';
}

function resultLabel(result) {
  return `result${result?.toolUseId ? '' : ' (unpaired)'}`;
}

// ---------- per-tool bodies ----------
// Each takes (turn, result) and returns a body HTML string, same contract as
// genericBody() below. A renderer may return '' / null / throw on a shape it
// doesn't recognise (e.g. a Bash call whose result was truncated before
// toolUseResult existed) — renderToolTurn() falls back to genericBody() in
// every one of those cases, so a surprising real-world shape degrades to
// pretty JSON rather than an unrendered turn.

function bashBody(turn, result) {
  const input = asObj(turn.input);
  const parts = [];
  parts.push(`<div class="t-input-label">command</div><pre class="t-shell-cmd">$ ${esc(input.command ?? '')}</pre>`);
  if (input.description) parts.push(`<div class="t-cmd-desc">${esc(input.description)}</div>`);
  parts.push(`<div class="t-result-label">${esc(resultLabel(result))}</div>${bashResultBody(result)}`);
  return parts.join('');
}

// stdout/stderr separated and visually distinct — stderr keeps its own class
// even when both streams are empty, so "ran with no output" (empty pre) and
// "no result recorded at all" stay visually different states.
function bashResultBody(result) {
  if (!result) return '<p class="t-empty note">(no result recorded)</p>';
  const tur = result.toolUseResult;
  if (!tur || typeof tur !== 'object' || (tur.stdout === undefined && tur.stderr === undefined)) {
    return resultBody(result);
  }
  const stdout = tur.stdout || '';
  const stderr = tur.stderr || '';
  const parts = [];
  if (stdout) parts.push(`<div class="t-stream-label">stdout</div><pre class="t-stdout">${esc(stdout)}</pre>`);
  if (stderr) parts.push(`<div class="t-stream-label t-stderr-label">stderr</div><pre class="t-stderr">${esc(stderr)}</pre>`);
  if (!stdout && !stderr) parts.push('<p class="t-empty note">(no output)</p>');
  return parts.join('');
}

// No diffing library — structuredPatch hunks are pre-computed by the CLI
// (lib/sessions.js passes them through verbatim). +/- lines get their own
// token classes; a line's own first character (the diff library's sign, ' '
// / '+' / '-') decides which, so a hunk with mixed signs never mis-colours.
function renderDiffHunks(structuredPatch) {
  const hunks = structuredPatch.map((h) => {
    const header = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
    const lines = (Array.isArray(h.lines) ? h.lines : []).map((line) => {
      const sign = line[0];
      const cls = sign === '+' ? 'diff-add' : sign === '-' ? 'diff-del' : 'diff-ctx';
      return `<div class="diff-line ${cls}">${esc(line)}</div>`;
    }).join('');
    return `<div class="diff-hunk"><div class="diff-hunk-header">${esc(header)}</div>${lines}</div>`;
  }).join('');
  return `<div class="t-diff">${hunks}</div>`;
}

function editWriteBody(turn, result) {
  const input = asObj(turn.input);
  const parts = [];
  parts.push(`<div class="t-input-label">file</div><div class="t-file-path">${esc(input.file_path ?? '')}</div>`);
  const patch = result?.toolUseResult?.structuredPatch;
  parts.push(`<div class="t-result-label">${esc(resultLabel(result))}</div>`);
  parts.push(Array.isArray(patch) && patch.length ? renderDiffHunks(patch) : resultBody(result));
  return parts.join('');
}

function readBody(turn, result) {
  const input = asObj(turn.input);
  const bits = [];
  if (input.offset !== undefined) bits.push(`offset ${input.offset}`);
  if (input.limit !== undefined) bits.push(`limit ${input.limit}`);
  const range = bits.length ? ` <span class="t-file-range">(${esc(bits.join(', '))})</span>` : '';
  const parts = [`<div class="t-input-label">file</div><div class="t-file-path">${esc(input.file_path ?? '')}${range}</div>`];
  // Result collapsed by default even once the surrounding tool block is
  // opened — a Read's file content is usually the least interesting part of
  // a transcript to have staring back at you.
  parts.push(nestedToggleHtml(resultLabel(result), resultBody(result), { collapsed: true }));
  return parts.join('');
}

function grepBody(turn, result) {
  const input = asObj(turn.input);
  const bits = [];
  if (input.pattern !== undefined) bits.push(`pattern ${JSON.stringify(input.pattern)}`);
  if (input.path) bits.push(`path ${input.path}`);
  if (input.glob) bits.push(`glob ${input.glob}`);
  const parts = [`<div class="t-input-label">grep</div><div class="t-grep-summary">${esc(bits.join(' · '))}</div>`];
  const tur = result?.toolUseResult;
  const counts = [];
  if (tur && typeof tur === 'object') {
    if (tur.numFiles !== undefined) counts.push(`${tur.numFiles} file${tur.numFiles === 1 ? '' : 's'}`);
    if (tur.numMatches !== undefined) counts.push(`${tur.numMatches} match${tur.numMatches === 1 ? '' : 'es'}`);
  }
  const label = resultLabel(result) + (counts.length ? ` · ${counts.join(', ')}` : '');
  parts.push(`<div class="t-result-label">${esc(label)}</div>${resultBody(result)}`);
  return parts.join('');
}

const TODO_GLYPH = { completed: '✓', in_progress: '▸', pending: '○' };

function todoListHtml(todos, changedKeys) {
  if (!Array.isArray(todos) || todos.length === 0) return '<p class="t-empty note">(none)</p>';
  const items = todos.map((t) => {
    const status = t && typeof t === 'object' ? t.status : undefined;
    const key = t && typeof t === 'object' ? (t.content ?? JSON.stringify(t)) : JSON.stringify(t);
    const cls = changedKeys.has(key) ? ' t-todo-changed' : '';
    return `<li class="t-todo t-todo-${esc(status || 'unknown')}${cls}">`
      + `<span class="t-todo-glyph">${esc(TODO_GLYPH[status] || '?')}</span> ${esc(t?.content ?? '')}</li>`;
  });
  return `<ul class="t-todo-list">${items.join('')}</ul>`;
}

function todoWriteBody(turn, result) {
  const input = asObj(turn.input);
  const newTodos = Array.isArray(input.todos) ? input.todos
    : (Array.isArray(result?.toolUseResult?.newTodos) ? result.toolUseResult.newTodos : []);
  const oldTodos = Array.isArray(result?.toolUseResult?.oldTodos) ? result.toolUseResult.oldTodos : [];
  const changed = changedTodoKeys(oldTodos, newTodos);
  const parts = [];
  if (oldTodos.length) parts.push('<div class="t-input-label">before</div>' + todoListHtml(oldTodos, changed));
  parts.push(`<div class="t-input-label">${oldTodos.length ? 'after' : 'todos'}</div>` + todoListHtml(newTodos, changed));
  parts.push(`<div class="t-result-label">${esc(resultLabel(result))}</div>${resultBody(result)}`);
  return parts.join('');
}

function genericBody(turn, result) {
  const parts = [];
  parts.push(`<div class="t-input-label">input</div>${highlightJson(turn.input ?? null)}`);
  parts.push(`<div class="t-result-label">${esc(resultLabel(result))}</div>${resultBody(result)}`);
  return parts.join('');
}

const TOOL_BODY_RENDERERS = {
  Bash: bashBody,
  Edit: editWriteBody,
  Write: editWriteBody,
  Read: readBody,
  Grep: grepBody,
  TodoWrite: todoWriteBody,
};

function renderToolTurn(turn, result) {
  const header = `${esc(oneLineSummary(turn.tool, turn.input, result))}`
    + (result?.isError ? ' <span class="t-err-flag">error</span>' : '');
  const renderer = TOOL_BODY_RENDERERS[turn.tool];
  let bodyHtml = null;
  if (renderer) {
    try {
      bodyHtml = renderer(turn, result);
    } catch {
      bodyHtml = null; // an unexpected real-world shape — fall through, never break the turn
    }
  }
  if (!bodyHtml) bodyHtml = genericBody(turn, result);
  const el = collapsible(header, bodyHtml, { collapsed: true, cls: `t-tool${result?.isError ? ' t-tool-error' : ''}` });
  wireNestedToggles(el);
  return el;
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

/**
 * Search/filter-hit expansion (component table row for transcript.js in
 * docs/specs/2026-07-27-sessions-tab-visual-design.md). A separate,
 * additive export rather than a new parameter on renderConversation():
 * that function's signature is relied on elsewhere already, so a match query
 * is applied as a second pass over the rendered DOM instead of threaded
 * through construction. Call after appending renderConversation()'s
 * fragment into the document (or into any root that has it) — auto-expands
 * every collapsed .t-block whose rendered text contains the query, so a
 * search hit inside a collapsed tool call is never hidden from the result
 * it matched. A blank query is a no-op and touches nothing.
 */
export function expandSearchHits(root, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q || !root) return;
  for (const block of root.querySelectorAll('.t-block')) {
    const body = block.querySelector('.t-body');
    if (!body || !body.hidden) continue; // not collapsed — nothing to expand
    if (!block.textContent.toLowerCase().includes(q)) continue;
    body.hidden = false;
    const caret = block.querySelector(':scope > .t-head > .t-caret');
    if (caret) caret.textContent = '▾';
  }
}
