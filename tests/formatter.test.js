import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormatter } from '../extensions/claude/formatter.js';

const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-5', cwd: '/tmp' });
const TOOL = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] } });
const TEXT = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at files now.' }] } });
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', result: 'All done.', num_turns: 4, total_cost_usd: 0.1234 });

function collect() {
  const lines = [];
  const progresses = [];
  const metas = [];
  const f = createFormatter({
    onLine: (l) => lines.push(l),
    onProgress: (p) => progresses.push(p),
    onMeta: (m) => metas.push(m),
  });
  return { f, lines, progresses, metas };
}

test('parses init/tool/text/result events into readable lines', () => {
  const { f, lines, progresses, metas } = collect();
  f.write(INIT + '\n' + TOOL + '\n');
  f.write(TEXT + '\n' + RESULT + '\n');
  f.flush();

  // `resultText` is persisted because exit status does not say whether the task
  // was done — a run can finish `success` while reporting it achieved nothing.
  // The beads poller reads this to decide whether to close a bead.
  assert.deepEqual(metas, [{ sessionId: 'sess-1' }, { resultText: 'All done.' }]);
  assert.ok(lines[0].includes('sess-1'));
  assert.ok(lines[1].startsWith('⚙ Bash'));
  assert.ok(lines[1].includes('ls -la'));
  assert.equal(lines[2], 'Looking at files now.');
  assert.ok(lines[3].includes('success') && lines[3].includes('4 turns') && lines[3].includes('$0.1234'));
  assert.equal(lines[4], 'All done.');

  const last = progresses.at(-1);
  assert.equal(last.activity, 'done');
  assert.equal(last.toolCalls, 1);
  assert.equal(last.turns, 4);
  assert.ok(last.text.includes('done')); // UI-facing display string
});

test('reassembles JSON split mid-line across chunks', () => {
  const { f, lines } = collect();
  const half = Math.floor(TOOL.length / 2);
  f.write(TOOL.slice(0, half));
  f.write(TOOL.slice(half) + '\nnot json at all\n');
  f.flush();
  assert.ok(lines[0].startsWith('⚙ Bash'));
  assert.equal(lines[1], 'not json at all');
});

test('ignores unknown event types', () => {
  const { f, lines } = collect();
  f.write(JSON.stringify({ type: 'user', message: {} }) + '\n');
  assert.equal(lines.length, 0);
});
