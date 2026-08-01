// Per-tool transcript renderers (claude-scheduler-a6o) + the two features
// deferred from the tab build: search-hit expansion, long-prompt
// auto-collapse. Same jsdom-before-import setup as tests/md.test.js — DOM
// APIs (querySelector, classList, event listeners) are exercised for real,
// not mocked, because the whole point of a renderer is what ends up in the
// DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { renderConversation, expandSearchHits } = await import('../public/transcript.js');

function mount(turns) {
  const root = document.createElement('div');
  root.appendChild(renderConversation(turns));
  document.body.appendChild(root);
  return root;
}

function toolBlocks(root) {
  return [...root.querySelectorAll('.t-tool')];
}

// ---------- Bash ----------

test('Bash: command renders as a shell line, with description', () => {
  const root = mount([
    { role: 'tool_use', tool: 'Bash', toolUseId: 'tu1',
      input: { command: 'git log -1 --oneline', description: 'show last commit' } },
    { role: 'tool_result', toolUseId: 'tu1', text: 'abc123 fix: thing\n',
      toolUseResult: { stdout: 'abc123 fix: thing\n', stderr: '' } },
  ]);
  const block = toolBlocks(root)[0];
  assert.match(block.querySelector('.t-summary').textContent, /used Bash · git log -1 --oneline/);
  assert.match(block.querySelector('.t-shell-cmd').textContent, /git log -1 --oneline/);
  assert.match(block.querySelector('.t-cmd-desc').textContent, /show last commit/);
});

test('Bash: stdout and stderr are separated, stderr visually distinct', () => {
  const root = mount([
    { role: 'tool_use', tool: 'Bash', toolUseId: 'tu2', input: { command: 'ls /nope' } },
    { role: 'tool_result', toolUseId: 'tu2', isError: true, text: 'ls: /nope: No such file or directory\n',
      toolUseResult: { stdout: '', stderr: 'ls: /nope: No such file or directory\n' } },
  ]);
  const block = toolBlocks(root)[0];
  assert.equal(block.querySelector('.t-stdout'), null, 'empty stdout must not render a stdout block');
  const stderrEl = block.querySelector('.t-stderr');
  assert.ok(stderrEl, 'stderr must render');
  assert.match(stderrEl.textContent, /No such file or directory/);
  // "visually distinct" = its own class, not shared with stdout/generic result text.
  assert.notEqual(stderrEl.className, 'undefined');
  assert.ok(stderrEl.className.includes('t-stderr'));
  assert.ok(block.querySelector('.t-stream-label.t-stderr-label'), 'stderr gets its own label class');
});

test('Bash: both streams present renders both, in order', () => {
  const root = mount([
    { role: 'tool_use', tool: 'Bash', toolUseId: 'tu3', input: { command: 'build.sh' } },
    { role: 'tool_result', toolUseId: 'tu3', text: 'ok',
      toolUseResult: { stdout: 'compiling...\ndone\n', stderr: 'warning: unused var\n' } },
  ]);
  const block = toolBlocks(root)[0];
  assert.match(block.querySelector('.t-stdout').textContent, /compiling/);
  assert.match(block.querySelector('.t-stderr').textContent, /warning: unused var/);
});

// ---------- Edit / Write diff ----------

test('Edit: structuredPatch hunk renders as a coloured diff, no diffing library', () => {
  const root = mount([
    { role: 'tool_use', tool: 'Edit', toolUseId: 'tu4',
      input: { file_path: 'lib/foo.js', old_string: 'a', new_string: 'b' } },
    { role: 'tool_result', toolUseId: 'tu4', text: '',
      toolUseResult: { structuredPatch: [{
        oldStart: 10, oldLines: 3, newStart: 10, newLines: 3,
        lines: [' context line', '-old line', '+new line', ' another context'],
      }] } },
  ]);
  const block = toolBlocks(root)[0];
  assert.match(block.querySelector('.t-summary').textContent, /lib\/foo\.js · 1 hunk/);
  const add = block.querySelector('.diff-line.diff-add');
  const del = block.querySelector('.diff-line.diff-del');
  const ctx = block.querySelectorAll('.diff-line.diff-ctx');
  assert.equal(add.textContent, '+new line');
  assert.equal(del.textContent, '-old line');
  assert.equal(ctx.length, 2);
  assert.match(block.querySelector('.diff-hunk-header').textContent, /@@ -10,3 \+10,3 @@/);
});

test('Write: multiple hunks are counted in the collapsed summary', () => {
  const root = mount([
    { role: 'tool_use', tool: 'Write', toolUseId: 'tu5', input: { file_path: 'a.txt', content: 'whole file' } },
    { role: 'tool_result', toolUseId: 'tu5', text: '',
      toolUseResult: { structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] },
        { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, lines: ['-p', '+q'] },
      ] } },
  ]);
  const block = toolBlocks(root)[0];
  assert.match(block.querySelector('.t-summary').textContent, /a\.txt · 2 hunks/);
  assert.equal(block.querySelectorAll('.diff-hunk').length, 2);
});

test('Edit: no structuredPatch falls back to the generic result (never breaks)', () => {
  const root = mount([
    { role: 'tool_use', tool: 'Edit', toolUseId: 'tu6', input: { file_path: 'b.txt' } },
    { role: 'tool_result', toolUseId: 'tu6', text: 'ok' },
  ]);
  const block = toolBlocks(root)[0];
  assert.equal(block.querySelector('.t-diff'), null);
  assert.match(block.querySelector('.t-result-text').textContent, /ok/);
});

// ---------- Read ----------

test('Read: file_path + offset/limit summary, result collapsed by default', () => {
  const root = mount([
    { role: 'tool_use', tool: 'Read', toolUseId: 'tu7', input: { file_path: 'lib/bar.js', offset: 100, limit: 50 } },
    { role: 'tool_result', toolUseId: 'tu7', text: 'line 100\nline 101\n...' },
  ]);
  const block = toolBlocks(root)[0];
  assert.match(block.querySelector('.t-file-path').textContent, /lib\/bar\.js/);
  assert.match(block.querySelector('.t-file-range').textContent, /offset 100/);
  assert.match(block.querySelector('.t-file-range').textContent, /limit 50/);
  const nestedBody = block.querySelector('.t-nested-body');
  assert.ok(nestedBody, 'Read result must use the nested collapse');
  assert.equal(nestedBody.hidden, true, 'Read result must be collapsed by default');
  assert.match(nestedBody.textContent, /line 100/);
});

// ---------- TodoWrite ----------

test('TodoWrite: before/after checklist with glyphs, changed items highlighted', () => {
  const oldTodos = [
    { content: 'Write tests', status: 'in_progress' },
    { content: 'Run suite', status: 'pending' },
    { content: 'Ship', status: 'pending' },
  ];
  const newTodos = [
    { content: 'Write tests', status: 'completed' },
    { content: 'Run suite', status: 'in_progress' },
    { content: 'Ship', status: 'pending' },
  ];
  const root = mount([
    { role: 'tool_use', tool: 'TodoWrite', toolUseId: 'tu8', input: { todos: newTodos } },
    { role: 'tool_result', toolUseId: 'tu8', text: '',
      toolUseResult: { oldTodos, newTodos } },
  ]);
  const block = toolBlocks(root)[0];
  assert.match(block.querySelector('.t-summary').textContent, /3 todos · 2 changed/);
  const lists = block.querySelectorAll('.t-todo-list');
  assert.equal(lists.length, 2, 'expects a before list and an after list');
  const afterItems = [...lists[1].querySelectorAll('.t-todo')];
  assert.equal(afterItems.length, 3);
  // "Write tests" and "Run suite" changed status; "Ship" did not.
  const byText = (li) => li.textContent.trim();
  const changed = afterItems.filter((li) => li.className.includes('t-todo-changed'));
  assert.equal(changed.length, 2);
  assert.ok(changed.some((li) => byText(li).includes('Write tests')));
  assert.ok(changed.some((li) => byText(li).includes('Run suite')));
  assert.ok(!changed.some((li) => byText(li).includes('Ship')));
});

// ---------- Grep ----------

test('Grep: pattern + path summary; numFiles/numMatches in the collapsed header', () => {
  const root = mount([
    { role: 'tool_use', tool: 'Grep', toolUseId: 'tu9', input: { pattern: 'TODO', path: 'lib', glob: '*.js' } },
    { role: 'tool_result', toolUseId: 'tu9', text: 'lib/a.js:1:TODO\n',
      toolUseResult: { numFiles: 3, numMatches: 12 } },
  ]);
  const block = toolBlocks(root)[0];
  const header = block.querySelector('.t-summary').textContent;
  assert.match(header, /TODO/);
  assert.match(header, /3 files, 12 matches/, 'counts must be in the COLLAPSED header, not just the body');
  assert.match(block.querySelector('.t-grep-summary').textContent, /pattern "TODO"/);
  assert.match(block.querySelector('.t-grep-summary').textContent, /path lib/);
});

// ---------- unknown-tool fallback ----------

test('an unrecognised tool name still renders as pretty JSON, never throws', () => {
  assert.doesNotThrow(() => mount([
    { role: 'tool_use', tool: 'SomeFutureTool', toolUseId: 'tuX', input: { anything: { nested: [1, 2, 3] } } },
    { role: 'tool_result', toolUseId: 'tuX', text: 'result text', toolUseResult: { weird: true } },
  ]));
  const root = mount([
    { role: 'tool_use', tool: 'SomeFutureTool', toolUseId: 'tuX2', input: { anything: 'goes' } },
    { role: 'tool_result', toolUseId: 'tuX2', text: 'ok' },
  ]);
  const block = toolBlocks(root)[0];
  assert.match(block.querySelector('.t-summary').textContent, /used SomeFutureTool/);
  assert.ok(block.querySelector('.json-hl'), 'unknown tool must fall back to the generic JSON renderer');
  assert.ok(block.querySelector('.jt-key'), 'the JSON fallback must actually be the highlighted walk, not an empty shell');
});

// ---------- search-hit expansion ----------

test('search-hit expansion auto-expands a collapsed block whose content matches', () => {
  const root = mount([
    { role: 'tool_use', tool: 'Bash', toolUseId: 'tuA', input: { command: 'echo one' } },
    { role: 'tool_result', toolUseId: 'tuA', text: 'one', toolUseResult: { stdout: 'one', stderr: '' } },
    { role: 'tool_use', tool: 'Bash', toolUseId: 'tuB', input: { command: 'echo zzrareneedlezz' } },
    { role: 'tool_result', toolUseId: 'tuB', text: 'zzrareneedlezz', toolUseResult: { stdout: 'zzrareneedlezz', stderr: '' } },
  ]);
  const blocks = toolBlocks(root);
  // Both start collapsed.
  assert.equal(blocks[0].querySelector('.t-body').hidden, true);
  assert.equal(blocks[1].querySelector('.t-body').hidden, true);

  expandSearchHits(root, 'zzrareneedlezz');

  assert.equal(blocks[0].querySelector('.t-body').hidden, true, 'a non-matching block must stay collapsed');
  assert.equal(blocks[1].querySelector('.t-body').hidden, false, 'the matching block must auto-expand');
  assert.equal(blocks[1].querySelector('.t-caret').textContent, '▾');
});

test('search-hit expansion with a blank query is a no-op', () => {
  const root = mount([
    { role: 'tool_use', tool: 'Bash', toolUseId: 'tuC', input: { command: 'echo hi' } },
    { role: 'tool_result', toolUseId: 'tuC', text: 'hi' },
  ]);
  expandSearchHits(root, '   ');
  assert.equal(toolBlocks(root)[0].querySelector('.t-body').hidden, true);
});

// ---------- long-prompt auto-collapse ----------

test('a user prompt over ~700 chars renders collapsed with an expand control', () => {
  const longText = 'x'.repeat(750);
  const root = mount([{ role: 'user', text: longText }]);
  const wrap = root.querySelector('.t-prompt-wrap');
  assert.ok(wrap, 'a long prompt must be wrapped for the collapse control');
  const turn = wrap.querySelector('.t-turn.t-user');
  assert.ok(turn.className.includes('t-prompt-clipped'), 'must start clipped');
  const btn = wrap.querySelector('.t-prompt-toggle');
  assert.ok(btn, 'must have an expand control');
  assert.match(btn.textContent, /750/);

  btn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.ok(!turn.className.includes('t-prompt-clipped'), 'clicking the control must expand it');
  assert.match(btn.textContent, /show less/i);
});

test('a short user prompt renders without the collapse wrapper', () => {
  const root = mount([{ role: 'user', text: 'a short prompt' }]);
  assert.equal(root.querySelector('.t-prompt-wrap'), null);
  assert.ok(root.querySelector('.t-turn.t-user'));
});

test('a user note (pasted image placeholder) is plain text, not markdown, and never collapsed', () => {
  const root = mount([{ role: 'user', note: '[2 pasted images]'.repeat(60) }]);
  assert.equal(root.querySelector('.t-prompt-wrap'), null, 'notes are not prompts and must not auto-collapse');
  assert.match(root.querySelector('.t-note').textContent, /pasted images/);
});
