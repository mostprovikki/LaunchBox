import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSessionFile, readConversation, discoverSessionFiles, parseTs,
  looksLikeRealPrompt, processImageAnnotations, cleanPrompt, decodeProjectDir,
  INTERACTIVE_ENTRYPOINTS,
} from '../lib/sessions.js';

// Every fixture is synthetic and lives in a tmpdir. Nothing here reads the real
// ~/.claude — a test that did would leak whatever the human happens to have
// typed into Claude Code into CI output.
function fixture(rows, { dir = '-Users-me-proj', id = 'sess-1', raw = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cs-sessions-'));
  mkdirSync(join(root, dir), { recursive: true });
  const file = join(root, dir, `${id}.jsonl`);
  writeFileSync(file, raw ?? rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { root, file };
}

const asstRow = (over = {}) => ({
  type: 'assistant',
  timestamp: '2026-07-26T10:00:00.000Z',
  cwd: '/Users/me/proj',
  message: { id: 'msg_1', model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 100 } },
  ...over,
});

test('the id comes from the filename, and cwd prefers the in-row value', async () => {
  const { file } = fixture([
    { type: 'user', timestamp: '2026-07-26T10:00:00.000Z', cwd: '/Users/me/real/path', message: { content: 'hello' } },
    // A later row disagreeing must not win: cwd is first-wins.
    { type: 'user', timestamp: '2026-07-26T10:01:00.000Z', cwd: '/somewhere/else', message: { content: 'again' } },
  ], { id: 'abc-123' });
  const s = await parseSessionFile(file);
  assert.equal(s.id, 'abc-123', 'not any in-row sessionId — file-history rows carry none');
  assert.equal(s.cwd, '/Users/me/real/path');
  assert.equal(s.project, 'path');
  assert.equal(s.cwdGuessed, false);
});

test('a guessed cwd is flagged, because on this machine it decodes to a path that does not exist', async () => {
  // Not hypothetical: 3 of 59 real sessions are 224-byte stubs with no `cwd` on
  // any row, and the home directory name contains a hyphen — so the decode
  // turns /Users/vignesh-5036/x into /Users/vignesh/5036/x. Anything that runs
  // `cd <cwd>` to resume would land nowhere, so callers need to know.
  const { file } = fixture([{ type: 'mode', mode: 'default' }], { dir: '-Users-vignesh-5036-mydevelopment-proj' });
  const s = await parseSessionFile(file);
  assert.equal(s.cwdGuessed, true);
  assert.equal(s.cwd, '/Users/vignesh/5036/mydevelopment/proj');
});

test('the folder-name cwd fallback is used only when no row carries one, and is lossy', async () => {
  // The real directory name for /Users/me/my_project.v2 — the encoder has
  // ALREADY collapsed '_' and '.' into '-' by the time we see it, which is
  // precisely why decoding cannot recover them.
  const { file } = fixture([{ type: 'ai-title', aiTitle: 'no cwd anywhere' }], { dir: '-Users-me-my-project-v2' });
  const s = await parseSessionFile(file);
  // Asserting the mangling explicitly, so nobody "fixes" this into a promise
  // the data cannot keep: the true path was /Users/me/my_project.v2.
  assert.equal(s.cwd, '/Users/me/my/project/v2');
  assert.equal(decodeProjectDir('-Users-me-mydevelopment-claude-scheduler'), '/Users/me/mydevelopment/claude/scheduler');
});

test('first-wins env fields vs last-wins titles', async () => {
  const { file } = fixture([
    { type: 'user', timestamp: '2026-07-26T10:00:00.000Z', cwd: '/p', gitBranch: 'feature-x', version: '2.1.206', entrypoint: 'cli', message: { content: 'hi' } },
    // gitBranch is the branch at session *start*; a later row must not move it.
    { type: 'assistant', timestamp: '2026-07-26T10:01:00.000Z', gitBranch: 'main', version: '2.1.211', entrypoint: 'sdk-cli', message: { id: 'm', model: 'x' } },
    { type: 'ai-title', aiTitle: 'first ai title' },
    { type: 'custom-title', customTitle: 'first custom' },
    { type: 'ai-title', aiTitle: 'second ai title' },
    { type: 'custom-title', customTitle: 'second custom' },
    // An empty value must not clear a title that was already set.
    { type: 'custom-title', customTitle: '' },
  ]);
  const s = await parseSessionFile(file);
  assert.equal(s.gitBranch, 'feature-x');
  assert.equal(s.version, '2.1.206');
  assert.equal(s.entrypoint, 'cli');
  assert.equal(s.aiTitle, 'second ai title', 'titles are append-only rewrite logs: last wins');
  assert.equal(s.customTitle, 'second custom');
});

test('usage is deduped on message.id: one API call written as N rows counts once', async () => {
  // This is the regression guard for the measured 1.6-2.1x inflation. Claude
  // Code writes one assistant row per content block, each repeating the SAME
  // usage object — measured across 577 duplicate groups, zero had a differing
  // payload. The worst real group was 15 rows at 2,267 output tokens: 34,005
  // instead of 2,267.
  const usage = { input_tokens: 2, output_tokens: 2267, cache_creation_input_tokens: 7620, cache_read_input_tokens: 49344 };
  const rows = [];
  for (const blockType of ['thinking', 'text', 'tool_use', 'tool_use', 'tool_use']) {
    rows.push(asstRow({
      requestId: 'req_same',
      message: { id: 'msg_dup', model: 'claude-opus-4-8', usage, content: [{ type: blockType }] },
    }));
  }
  const s = await parseSessionFile(fixture(rows).file);
  assert.equal(s.tokOut, 2267, 'five rows, one call');
  assert.equal(s.tokIn, 2);
  assert.equal(s.tokCacheCreate, 7620);
  assert.equal(s.tokCacheRead, 49344);
  // Same guard, same line: the histogram counts turns, not content blocks.
  assert.deepEqual(Object.keys(s.models), ['claude-opus-4-8']);
  assert.equal(s.models['claude-opus-4-8'].turns, 1);
});

test('a row with no message.id falls back to requestId, and a row with neither still counts', async () => {
  const s = await parseSessionFile(fixture([
    asstRow({ requestId: 'req_a', message: { model: 'm1', usage: { output_tokens: 5 } } }),
    asstRow({ requestId: 'req_a', message: { model: 'm1', usage: { output_tokens: 5 } } }),
    // Neither key: measured on 3 real rows, all <synthetic>. Cannot be deduped,
    // so it must not be silently dropped either.
    asstRow({ message: { model: 'm1', usage: { output_tokens: 7 } } }),
  ]).file);
  assert.equal(s.tokOut, 12, '5 (deduped) + 7');
});

test('tokens accumulate per model, so no turn-share apportionment is needed', async () => {
  // Upstream splits a session's TOTAL tokens across models by turn share, which
  // prices any mixed-model session wrong — and delegating to a cheaper model is
  // routine. Per-model accumulation removes the problem instead of approximating.
  const s = await parseSessionFile(fixture([
    asstRow({ message: { id: 'a', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 1000 } } }),
    asstRow({ message: { id: 'b', model: 'claude-haiku-4-5', usage: { input_tokens: 1, output_tokens: 2 } } }),
    asstRow({ message: { id: 'c', model: 'claude-haiku-4-5', usage: { input_tokens: 3, output_tokens: 4 } } }),
  ]).file);
  assert.deepEqual(s.models['claude-opus-4-8'], { turns: 1, tokIn: 100, tokOut: 1000, tokCacheCreate: 0, tokCacheRead: 0 });
  assert.deepEqual(s.models['claude-haiku-4-5'], { turns: 2, tokIn: 4, tokOut: 6, tokCacheCreate: 0, tokCacheRead: 0 });
  // Totals are derived by summing the buckets, so they cannot disagree with them.
  assert.equal(s.tokIn, 104);
  assert.equal(s.tokOut, 1006);
});

test('a <synthetic> model is excluded from the histogram', async () => {
  const s = await parseSessionFile(fixture([
    asstRow({ message: { id: 'real', model: 'claude-opus-4-8', usage: { output_tokens: 9 } } }),
    asstRow({ message: { id: 'syn', model: '<synthetic>', usage: { output_tokens: 0 } } }),
  ]).file);
  assert.deepEqual(Object.keys(s.models), ['claude-opus-4-8']);
});

test('usage.iterations[] is never added — it repeats the same numbers', async () => {
  // Measured trap: the real payload nests a second copy of the figures.
  const s = await parseSessionFile(fixture([asstRow({
    message: {
      id: 'm',
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 2, output_tokens: 2267,
        iterations: [{ input_tokens: 2, output_tokens: 2267, type: 'message' }],
      },
    },
  })]).file);
  assert.equal(s.tokOut, 2267, 'not 4534');
});

test('activeMs sums turn_duration rows only; spanMs is wall clock', async () => {
  const s = await parseSessionFile(fixture([
    { type: 'user', timestamp: '2026-07-26T10:00:00.000Z', cwd: '/p', message: { content: 'go' } },
    { type: 'system', subtype: 'turn_duration', durationMs: 28571, timestamp: '2026-07-26T10:00:30.000Z' },
    { type: 'system', subtype: 'turn_duration', durationMs: 103925, timestamp: '2026-07-26T10:02:00.000Z' },
    // Guard, measured to change nothing today: durationMs appears on 146/146
    // turn_duration rows and 0 of the other 72 system rows. If a future subtype
    // starts carrying one with a different meaning, it must not land here.
    { type: 'system', subtype: 'local_command', durationMs: 999999, timestamp: '2026-07-26T10:03:00.000Z' },
    { type: 'system', subtype: 'away_summary', durationMs: 888888, timestamp: '2026-07-26T11:00:00.000Z' },
  ]).file);
  assert.equal(s.activeMs, 132496, 'not 2,021,383');
  assert.equal(s.spanMs, 60 * 60 * 1000, 'first to last timestamp');
  // The contrast is the point: an hour of wall clock, ~2m of work.
  assert.ok(s.activeMs < s.spanMs);
});

test('a truncated final line, a non-dict row and invalid UTF-8 are all skipped without throwing', async () => {
  // These files are appended to while we read them, so a half-written last line
  // is normal operation rather than corruption.
  const good = JSON.stringify({ type: 'user', timestamp: '2026-07-26T10:00:00.000Z', cwd: '/p', message: { content: 'kept' } });
  const raw = [
    good,
    '42',                       // bare scalar
    '"a string"',               // bare string
    '[1,2,3]',                  // bare array
    '{"type":"user","mess',     // truncated mid-write
  ].join('\n');
  const { file } = fixture([], { raw });
  // Append a lone continuation byte: invalid UTF-8, decoded with a replacement
  // character rather than throwing.
  appendFileSync(file, Buffer.from([0x80, 0x0a]));
  const s = await parseSessionFile(file);
  assert.equal(s.prompts, 1);
  assert.equal(s.promptList[0].text, 'kept');
});

test('an unreadable file is null, not an exception', async () => {
  assert.equal(await parseSessionFile('/nope/does/not/exist.jsonl'), null);
});

test('image annotations: source companions vanish, original WxH becomes a marker', async () => {
  assert.deepEqual(
    processImageAnnotations('[Image #1] look at this [Image: source: /tmp/x/1.png]'),
    { text: '[Image #1] look at this', notes: [] },
  );
  const dim = processImageAnnotations('[Image: original 3024x1612, displayed at 2000x1066.]');
  assert.equal(dim.text, '');
  assert.deepEqual(dim.notes, ['3024×1612'], 'U+00D7, not an ASCII x');
  assert.deepEqual(processImageAnnotations('[Image: original size unknown]').notes, ['pasted image']);

  // A row that was ONLY a companion ref collapses to nothing and is dropped;
  // a dimension-only row survives as a "not stored" marker with no text.
  const s = await parseSessionFile(fixture([
    { type: 'user', timestamp: '2026-07-26T10:00:00.000Z', cwd: '/p', message: { content: '[Image: source: /tmp/a/1.png]' } },
    { type: 'user', timestamp: '2026-07-26T10:01:00.000Z', cwd: '/p', message: { content: '[Image: original 800x600]' } },
  ]).file);
  assert.equal(s.prompts, 1);
  assert.deepEqual(s.promptList[0].imageRefs, [{ note: '800×600' }]);
  assert.equal(s.promptList[0].text, '');
});

test('an inline base64 image is kept even with no text', async () => {
  const s = await parseSessionFile(fixture([{
    type: 'user',
    timestamp: '2026-07-26T10:00:00.000Z',
    cwd: '/p',
    message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
  }]).file);
  assert.equal(s.prompts, 1);
  assert.deepEqual(s.promptList[0].images, [{ mediaType: 'image/png', data: 'AAAA' }]);
});

test('the prompt filter drops every noise shape actually present in the corpus', async () => {
  // Counts are the measured occurrences across 331 text-bearing user rows.
  for (const noise of [
    '<task-notification>\n<task-id>x</task-id>',          // 39 — largest class
    '<local-command-caveat>Caveat: the messages below…',   // 25
    '<command-name>/clear</command-name>',                 // 25
    '<local-command-stdout>Set model…</local-command-stdout>', // 8
    '<command-message>clear</command-message>',            // 3, leads for /doctor
    '◇ ultraplan\nStarting Claude Code on the web…',       // 2
    '<bash-input>subl fetch.js</bash-input>',              // 1
    '<bash-stdout>ok</bash-stdout>',                       // 1
    '<system-reminder>\nThe user named this session…',     // 1 leading
    'Caveat: The messages below were generated…',
    '[Request interrupted by user]',
    '[Request interrupted by user for tool use]',
  ]) {
    assert.equal(looksLikeRealPrompt(noise), false, noise.slice(0, 40));
  }
  // Markup a human typed is NOT noise. This is why the filter is a prefix list
  // and not a "starts with <" test.
  for (const real of ['fix the bug', '<svg viewBox="0 0 1 1"/> why is this broken?', 'why does [1] fail?']) {
    assert.equal(looksLikeRealPrompt(real), true, real);
  }
});

test('repeated identical prompts are collapsed — resume and compaction re-inject them', async () => {
  const one = (t) => ({ type: 'user', timestamp: t, cwd: '/p', message: { content: 'run the tests' } });
  const s = await parseSessionFile(fixture([
    one('2026-07-26T10:00:00.000Z'),
    one('2026-07-26T10:05:00.000Z'),
    one('2026-07-26T10:09:00.000Z'),
    { type: 'user', timestamp: '2026-07-26T10:10:00.000Z', cwd: '/p', message: { content: 'now ship it' } },
  ]).file);
  assert.equal(s.prompts, 2);
  assert.deepEqual(s.promptList.map((p) => p.text), ['run the tests', 'now ship it']);
  assert.equal(s.firstPrompt, 'run the tests');
});

test('tool_result rows are not prompts: 95% of real user rows are these', async () => {
  const s = await parseSessionFile(fixture([{
    type: 'user',
    timestamp: '2026-07-26T10:00:00.000Z',
    cwd: '/p',
    message: { content: [{ type: 'tool_result', content: 'file written', is_error: false }] },
  }]).file);
  assert.equal(s.prompts, 0);
  assert.equal(s.firstPrompt, '');
});

test('firstPrompt is clamped to 280 chars and a long prompt to PROMPT_CAP', async () => {
  const long = 'x'.repeat(7000);
  const s = await parseSessionFile(fixture([
    { type: 'user', timestamp: '2026-07-26T10:00:00.000Z', cwd: '/p', message: { content: long } },
  ]).file);
  assert.equal(s.firstPrompt.length, 281, '280 + the ellipsis');
  assert.ok(s.firstPrompt.endsWith('…'));
  assert.ok(s.promptList[0].text.startsWith('x'.repeat(6000)));
  assert.match(s.promptList[0].text, /truncated 1,000 more characters/);
  assert.equal(cleanPrompt('<command-name>/clear</command-name>\nrest'), 'rest');
});

test('sidechain rows are skipped — a guard, since 0 of 20,559 real depth-1 rows set it', async () => {
  const s = await parseSessionFile(fixture([
    asstRow({ message: { id: 'parent', model: 'claude-opus-4-8', usage: { output_tokens: 100 } } }),
    asstRow({ isSidechain: true, message: { id: 'sub', model: 'claude-haiku-4-5', usage: { output_tokens: 5000 } } }),
  ]).file);
  assert.equal(s.tokOut, 100, "a subagent's tokens must not land on the parent session");
  assert.deepEqual(Object.keys(s.models), ['claude-opus-4-8']);
});

test('a naive timestamp is read as UTC, not local', async () => {
  // All 21,478 real timestamps carry Z, so this is a guard against a future
  // writer — but the failure would be silent and exactly the size of the local
  // offset, which is why it is pinned.
  assert.equal(parseTs('2026-07-26T10:00:00.000'), Date.parse('2026-07-26T10:00:00.000Z'));
  assert.equal(parseTs('2026-07-26T10:00:00.000Z'), Date.parse('2026-07-26T10:00:00.000Z'));
  assert.equal(parseTs('2026-07-26T10:00:00.000+05:30'), Date.parse('2026-07-26T04:30:00.000Z'));
  for (const bad of [null, undefined, '', 0, 42, {}, 'not a date']) assert.equal(parseTs(bad), null, String(bad));
});

test('21% of real rows carry no timestamp; a title-only file is dated by mtime', async () => {
  // The title sidecars are exactly the undated types, so a title cannot be
  // dated from its own row — but a file of nothing else must still sort.
  const { file } = fixture([{ type: 'ai-title', aiTitle: 'untimed' }]);
  const s = await parseSessionFile(file);
  assert.equal(s.aiTitle, 'untimed');
  assert.equal(s.firstTs, '', 'a title is signal, so the mtime fallback does NOT fire');
  assert.equal(s.spanMs, 0);

  // With no signal at all, the mtime fallback fires so it does not sort as if
  // it never happened.
  const empty = fixture([{ type: 'mode', mode: 'default' }]);
  const e = await parseSessionFile(empty.file);
  assert.notEqual(e.firstTs, '');
  assert.equal(e.firstTs, e.lastTs);
});

test('entrypoint is normalised so the allowlist gate is reachable', async () => {
  // No real row carries a literal '' — the key is simply absent on 25% of them,
  // which is where the allowlist's '' member comes from.
  const absent = await parseSessionFile(fixture([{ type: 'mode', mode: 'x' }]).file);
  assert.equal(absent.entrypoint, '');
  assert.ok(INTERACTIVE_ENTRYPOINTS.has(absent.entrypoint), 'an unknown future shape fails open');
  // And the one that matters: our own runs are sdk-cli, which is NOT interactive.
  const ours = await parseSessionFile(fixture([asstRow({ entrypoint: 'sdk-cli' })]).file);
  assert.equal(ours.entrypoint, 'sdk-cli');
  assert.equal(INTERACTIVE_ENTRYPOINTS.has('sdk-cli'), false,
    'so the list route MUST union this with our own runs, or it hides exactly what M5 §5.4 exists to show');
});

test('discovery is depth-1 only, which excludes subagent transcripts structurally', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cs-disc-'));
  mkdirSync(join(root, '-p-one', 'abc', 'subagents'), { recursive: true });
  mkdirSync(join(root, '-p-two'), { recursive: true });
  writeFileSync(join(root, '-p-one', 'abc.jsonl'), '');
  writeFileSync(join(root, '-p-one', 'abc', 'subagents', 'agent-1.jsonl'), '');
  writeFileSync(join(root, '-p-two', 'def.jsonl'), '');
  writeFileSync(join(root, '-p-two', 'notes.txt'), '');
  writeFileSync(join(root, 'stray.jsonl'), '');  // directly in root, not a session
  const found = (await discoverSessionFiles(root)).map((p) => p.replace(root, '')).sort();
  assert.deepEqual(found, ['/-p-one/abc.jsonl', '/-p-two/def.jsonl']);
  assert.deepEqual(await discoverSessionFiles('/nope/missing'), [], 'a missing root is empty, not an error');
});

// ---------------- transcripts

test('the transcript maps each row type to turns, and drops thinking', async () => {
  const { file } = fixture([
    { type: 'user', timestamp: 't1', cwd: '/p', message: { content: 'do the thing' } },
    {
      type: 'assistant',
      timestamp: 't2',
      message: {
        model: 'claude-opus-4-8',
        content: [
          { type: 'thinking', thinking: 'private reasoning that must not be shown' },
          { type: 'text', text: 'on it' },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/a.js', old: 1 } },
        ],
      },
    },
    { type: 'user', timestamp: 't3', message: { content: [{ type: 'tool_result', content: 'done', is_error: false }] } },
    { type: 'user', timestamp: 't4', message: { content: [{ type: 'tool_result', content: 'boom', is_error: true }] } },
    // Non-message rows never become turns.
    { type: 'system', subtype: 'turn_duration', durationMs: 5, timestamp: 't5' },
    { type: 'custom-title', customTitle: 'x' },
  ]);
  const turns = await readConversation(file);
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'tool_use', 'tool_result', 'tool_result']);
  assert.equal(turns[1].text, 'on it');
  assert.equal(turns[1].model, 'claude-opus-4-8');
  assert.equal(turns[2].tool, 'Edit');
  assert.equal(turns[2].input, '{\n  "file_path": "/a.js",\n  "old": 1\n}', 'pretty-printed at indent 2');
  assert.equal(turns[3].isError, false);
  assert.equal(turns[4].isError, true);
  assert.ok(!JSON.stringify(turns).includes('private reasoning'));
});

test('a system-reminder embedded in a tool_result is stripped, and ANSI escapes go', async () => {
  // Measured: <system-reminder> LEADS only 1 real row but is embedded inside
  // tool_result content on 24 — so a prefix test cannot reach it.
  const esc = String.fromCharCode(27);
  const { file } = fixture([{
    type: 'user',
    timestamp: 't',
    message: {
      content: [{
        type: 'tool_result',
        content: `real output here\n<system-reminder>\nnagging text\n</system-reminder>${esc}[1mbold${esc}[22m`,
      }],
    },
  }]);
  const turns = await readConversation(file);
  assert.equal(turns.length, 1);
  assert.ok(!turns[0].text.includes('nagging text'), 'the reminder block is gone');
  assert.ok(!turns[0].text.includes(esc), 'and so are the raw SGR escapes');
  // The newline that preceded the reminder block survives: the strip removes the
  // block and its trailing whitespace, not the real output's own formatting.
  assert.equal(turns[0].text, 'real output here\nbold');
});

test('an image-only user turn becomes a note, and a pluralised one', async () => {
  const img = (n) => ({
    type: 'user', timestamp: 't',
    message: { content: Array.from({ length: n }, () => ({ type: 'image', source: { type: 'base64', data: 'A' } })) },
  });
  const turns = await readConversation(fixture([img(1), img(3)]).file);
  assert.deepEqual(turns.map((t) => t.note), ['[1 pasted image]', '[3 pasted images]']);
});

test('an unreadable transcript is empty, never an exception', async () => {
  assert.deepEqual(await readConversation('/nope/gone.jsonl'), []);
});

// ---------------- the index: cache, liveness, watcher, mutations

import { openDb, createJob, insertRun, updateRun, cleanupAll } from '../lib/db.js';
import { createSessionIndex } from '../lib/sessions.js';
import { tmpData, validJob, sleep } from './helpers.js';
import { ensureDirs } from '../lib/paths.js';
import { statSync, utimesSync, readFileSync } from 'node:fs';

// The injected clock is anchored to real wall time on purpose: liveness compares
// now() against real file mtimes, so a frozen fake date would make every fixture
// either eternally live or eternally stale depending on the hour the suite ran.
// Tests move `nowRef.v` by explicit deltas instead.
function bootIndex({ activeWindowS = 60, nowRef = { v: Date.now() } } = {}) {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const root = mkdtempSync(join(tmpdir(), 'cs-root-'));
  const index = createSessionIndex({ db, root, activeWindowS, now: () => nowRef.v });
  const write = (id, rows, { project = '-Users-me-proj' } = {}) => {
    mkdirSync(join(root, project), { recursive: true });
    const file = join(root, project, `${id}.jsonl`);
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return file;
  };
  return { db, root, index, write, nowRef };
}

const activeWindow = (index) => index.activeWindowS() * 1000;

// rename/delete are refused on a live session, and a just-written fixture is by
// definition live. Backdate it so the test exercises the path it means to.
function makeIdle(file, nowRef) {
  const t = new Date(nowRef.v - 3600_000);
  utimesSync(file, t, t);
}

const userRow = (text, t = '2026-07-26T10:00:00.000Z') => ({ type: 'user', timestamp: t, cwd: '/Users/me/proj', entrypoint: 'cli', message: { content: text } });

test('an unchanged file is not re-parsed; a changed mtime or size re-parses it', async () => {
  const { index, write } = bootIndex();
  const file = write('s1', [userRow('first')]);

  let r = await index.scan();
  assert.equal(r.parsed, 1);

  r = await index.scan();
  assert.equal(r.parsed, 0, 'the cache key held: nothing re-read');
  assert.equal(r.discovered, 1);

  // Growing the file must invalidate it — this is the normal case, a live
  // session being appended to.
  appendFileSync(file, JSON.stringify(userRow('second', '2026-07-26T10:05:00.000Z')) + '\n');
  r = await index.scan();
  assert.equal(r.parsed, 1);
  assert.equal(index.get('s1').prompts, 2);

  // The size half of the cache key, isolated. Pinning mtime to a whole
  // millisecond first matters: macOS reports mtimeMs with sub-millisecond
  // precision, but utimesSync takes a ms-precision Date — so setting the mtime
  // "back to what it was" actually truncates it and moves the key. With an
  // integer mtime the write is idempotent, and only the size differs.
  const fixed = new Date(Math.floor(statSync(file).mtimeMs));
  utimesSync(file, fixed, fixed);
  await index.scan();
  assert.equal(statSync(file).mtimeMs, fixed.getTime(), 'the mtime write is now idempotent');

  appendFileSync(file, JSON.stringify(userRow('third', '2026-07-26T10:09:00.000Z')) + '\n');
  utimesSync(file, fixed, fixed);
  assert.equal(statSync(file).mtimeMs, fixed.getTime(), 'same mtime as the cached row');
  r = await index.scan();
  assert.equal(r.parsed, 1, 'a grown file is re-read on size alone — otherwise a live transcript reads stale forever');
  assert.equal(index.get('s1').prompts, 3);
});

test('a deleted file leaves the index, so it stops being listed', async () => {
  const { index, write, root } = bootIndex();
  write('gone', [userRow('bye')]);
  write('stays', [userRow('hi')]);
  await index.scan();
  assert.equal(index.list().sessions.length, 2);

  await (await import('node:fs/promises')).unlink(join(root, '-Users-me-proj', 'gone.jsonl'));
  const r = await index.scan();
  assert.equal(r.removed, 1);
  assert.deepEqual(index.list().sessions.map((s) => s.id), ['stays']);
  assert.equal(index.get('gone'), null);
});

test('our own sdk-cli sessions stay visible via the runs join — the §5.4 trap', async () => {
  const { db, index, write } = bootIndex();
  // Exactly what `claude -p` writes, and what upstream's allowlist excludes.
  write('ours', [{ type: 'assistant', timestamp: '2026-07-26T10:00:00.000Z', cwd: '/Users/me/proj', entrypoint: 'sdk-cli', message: { id: 'm', model: 'claude-opus-5', usage: { output_tokens: 5 } } }]);
  write('theirs', [{ type: 'assistant', timestamp: '2026-07-26T10:00:00.000Z', cwd: '/Users/me/proj', entrypoint: 'sdk-cli', message: { id: 'n', model: 'claude-opus-5', usage: { output_tokens: 5 } } }]);
  write('human', [userRow('hello')]);
  await index.scan();

  // Before any run claims it, an sdk-cli session is correctly treated as noise.
  let shown = index.list().sessions.map((s) => s.id);
  assert.deepEqual(shown, ['human']);
  assert.equal(index.list().hidden, 2);

  // Now record a run that produced 'ours', exactly as the claude formatter does.
  const job = createJob(db, { ...validJob({ name: 'nightly' }) });
  const run = insertRun(db, { jobId: job.id, status: 'ok', trigger: 'schedule' });
  updateRun(db, run.id, { meta: JSON.stringify({ sessionId: 'ours' }) });

  const list = index.list();
  shown = list.sessions.map((s) => s.id).sort();
  assert.deepEqual(shown, ['human', 'ours'],
    'a session this app started is never noise, whatever its entrypoint');
  assert.equal(list.hidden, 1, 'the genuinely foreign sdk-cli session is still hidden, and counted');

  // And the cross-link is populated both ways round.
  const ours = list.sessions.find((s) => s.id === 'ours');
  assert.equal(ours.runs.length, 1);
  assert.equal(ours.runs[0].jobName, 'nightly');
  assert.equal(ours.runs[0].runId, run.id);

  // ?all=1 reveals everything, so nothing is unreachable.
  assert.equal(index.list({ all: true }).sessions.length, 3);
});

test('liveness: fresh mtime means running, and running sessions float to the top', async () => {
  const nowRef = { v: Date.parse('2026-07-26T12:00:00.000Z') };
  const { index, write, root } = bootIndex({ activeWindowS: 60, nowRef });
  write('old', [userRow('ages ago')]);
  const liveFile = write('live', [userRow('just now')]);
  // 'old' is stale, 'live' was touched 5s ago.
  const stale = new Date(nowRef.v - 3600_000);
  utimesSync(join(root, '-Users-me-proj', 'old.jsonl'), stale, stale);
  const fresh = new Date(nowRef.v - 5000);
  utimesSync(liveFile, fresh, fresh);
  await index.scan();

  assert.deepEqual(index.running(), ['live']);
  assert.deepEqual(index.list().sessions.map((s) => s.id), ['live', 'old'], 'running floats up');
  assert.equal(index.list().sessions[0].running, true);

  // Move time past the window: liveness lapses with no file event, which is why
  // there is a timer as well as a watcher.
  nowRef.v += 120_000;
  assert.deepEqual(index.running(), []);
});

test('our own rename does NOT make a session look running — upstream greys out its own Delete', async () => {
  // Real-time-anchored: rename() stamps the file with the real clock, so a
  // frozen fake now() would make the comparison meaningless.
  const { index, write, nowRef } = bootIndex();
  const file = write('s1', [userRow('hello')]);
  makeIdle(file, nowRef);
  await index.scan();
  assert.equal(index.get('s1').running, false);

  const mtimeBefore = statSync(file).mtimeMs;
  const r = await index.rename('s1', 'my session');
  assert.equal(r.ok, true);
  assert.equal(r.session.customTitle, 'my session');

  // The append necessarily bumped mtime into the liveness window. Upstream reads
  // that back as activity and disables its own Delete button for 60s.
  assert.ok(statSync(file).mtimeMs > mtimeBefore, 'the write really did bump mtime');
  assert.ok(statSync(file).mtimeMs > nowRef.v - activeWindow(index), 'and into the live window');
  assert.equal(index.get('s1').running, false, 'but we know it was us');
  assert.deepEqual(index.running(), []);

  // A write by anyone else moves mtime off the value we recorded, and the
  // session is live again — the flag must not be a blanket exemption.
  appendFileSync(file, JSON.stringify(userRow('someone else typing')) + '\n');
  await index.scan();
  assert.equal(index.get('s1').running, true);
});

test('rename appends exactly one 3-key custom-title row, with a newline first if needed', async () => {
  const { index, root, nowRef } = bootIndex();
  const file = join(root, '-Users-me-proj', 's1.jsonl');
  mkdirSync(join(root, '-Users-me-proj'), { recursive: true });
  // No trailing newline: the hazard the probe exists for. Without it the new row
  // glues onto the last line and corrupts both.
  writeFileSync(file, JSON.stringify(userRow('hello')));
  makeIdle(file, nowRef);
  await index.scan();

  assert.equal((await index.rename('s1', 'renamed')).ok, true);
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'the original line survived intact');
  const added = JSON.parse(lines[1]);
  assert.deepEqual(Object.keys(added).sort(), ['customTitle', 'timestamp', 'type']);
  assert.equal(added.type, 'custom-title');
  assert.equal(added.customTitle, 'renamed');
  assert.equal(JSON.parse(lines[0]).message.content, 'hello');

  // Renaming again is allowed even though we just wrote the file a millisecond
  // ago: the self-write flag is what makes a second rename possible at all.
  assert.equal((await index.rename('s1', 'renamed twice')).ok, true);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 3);
  assert.equal(index.get('s1').customTitle, 'renamed twice');
});

test('rename is refused while the session is being written to', async () => {
  const { index, write, nowRef } = bootIndex();
  const file = write('s1', [userRow('hello')]);
  const fresh = new Date(nowRef.v - 2000);
  utimesSync(file, fresh, fresh);
  await index.scan();

  // This app spawns claude itself, so "another process is appending to this file
  // right now" is normal operating state, not an edge case.
  const r = await index.rename('s1', 'nope');
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.match(r.error, /written to right now/);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1, 'nothing was appended');
});

test('delete is refused while running, and removes both file and row when idle', async () => {
  const { index, write, nowRef } = bootIndex();
  const file = write('s1', [userRow('hello')]);
  const fresh = new Date(nowRef.v - 1000);
  utimesSync(file, fresh, fresh);
  await index.scan();

  let r = await index.remove('s1');
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.ok(statSync(file).size > 0, 'the transcript is untouched');

  makeIdle(file, nowRef);
  r = await index.remove('s1');
  assert.equal(r.ok, true);
  assert.throws(() => statSync(file), 'the file is gone');
  assert.equal(index.get('s1'), null);
});

test('an invalid or traversing session id never reaches the filesystem', async () => {
  const { index, write } = bootIndex();
  write('s1', [userRow('hello')]);
  await index.scan();
  for (const bad of ['../../etc/passwd', '/etc/passwd', 'a/b', '..', '.', '', 'a b', 'x'.repeat(201)]) {
    assert.equal(index.get(bad), null, JSON.stringify(bad));
    assert.equal((await index.rename(bad, 'x')).status, 404, JSON.stringify(bad));
    assert.equal((await index.remove(bad)).status, 404, JSON.stringify(bad));
  }
});

test('resume keeps the pieces apart, and says when the cwd was guessed', async () => {
  const { index, write, nowRef } = bootIndex();
  const plainFile = write('plain', [userRow('hello')]);
  makeIdle(plainFile, nowRef);
  await index.scan();
  let spec = index.resumeSpec('plain');
  assert.deepEqual(spec.args, ['--resume', 'plain']);
  assert.equal(spec.cwd, '/Users/me/proj');
  assert.equal(spec.cwdGuessed, false);
  assert.equal(spec.ambiguous, false);

  // A named session resumes by name...
  await index.rename('plain', 'my work');
  spec = index.resumeSpec('plain');
  assert.deepEqual(spec.args, ['--resume', 'my work']);

  // ...unless the (cwd, title) pair is ambiguous, which makes
  // `claude --resume "<name>"` pick arbitrarily.
  const twinFile = write('twin', [userRow('hello there')]);
  makeIdle(twinFile, nowRef);
  await index.scan();
  assert.equal((await index.rename('twin', 'my work')).ok, true);
  assert.equal(index.resumeSpec('plain').ambiguous, true);
  assert.deepEqual(index.resumeSpec('plain').args, ['--resume', 'plain'], 'falls back to the unique id');
  assert.deepEqual(index.resumeSpec('twin').args, ['--resume', 'twin']);

  // A path containing a quote and a $ must survive as data, never as shell text.
  write('odd', [{ type: 'user', timestamp: '2026-07-26T10:00:00.000Z', cwd: '/Users/me/it\'s $HOME', entrypoint: 'cli', message: { content: 'hi' } }]);
  await index.scan();
  assert.equal(index.resumeSpec('odd').cwd, '/Users/me/it\'s $HOME');
});

test('cleanupAll clears the cache rows and never touches a session file', async () => {
  const { db, index, write } = bootIndex();
  const file = write('s1', [userRow('hello')]);
  await index.scan();
  assert.equal(index.list().sessions.length, 1);

  cleanupAll(db);
  assert.equal(index.list().sessions.length, 0, 'the cache is cleared');
  assert.ok(statSync(file).size > 0, 'but the transcript this app does not own is still there');
  // And the cache rebuilds itself, which is what makes clearing it free.
  assert.equal((await index.scan()).parsed, 1);
  assert.equal(index.list().sessions.length, 1);
});

test('the watcher rescans on any event type, since macOS reports appends as rename', async () => {
  const { index, write } = bootIndex();
  const file = write('s1', [userRow('one')]);
  await index.scan();
  assert.equal(index.get('s1').prompts, 1);

  const seen = [];
  index.events.on('change', (e) => seen.push(e));
  index.start();
  try {
    // FSEvents takes a moment to arm after fs.watch returns; appending
    // immediately made this test pass alone and flake in the full run.
    await sleep(300);
    appendFileSync(file, JSON.stringify(userRow('two', '2026-07-26T10:05:00.000Z')) + '\n');

    // Wait on the condition rather than on a fixed sleep. The debounce is 400ms,
    // but the point of the assertion is "no poll was needed", not "it happened
    // within exactly N ms" — a wall-clock guess is what makes watcher tests
    // flaky on a loaded machine.
    const deadline = Date.now() + 8000;
    while (index.get('s1').prompts !== 2 && Date.now() < deadline) await sleep(100);

    assert.equal(index.get('s1').prompts, 2, 'the append was picked up without a poll');
    assert.ok(seen.length >= 1, 'and a change event was emitted');
  } finally {
    index.stop();
  }
});

test('a missing root is not an error: Claude Code may never have run', async () => {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'db.db'));
  const index = createSessionIndex({ db, root: join(dir, 'no-such-dir') });
  const r = await index.scan();
  assert.deepEqual(r, { discovered: 0, parsed: 0, removed: 0 });
  assert.deepEqual(index.list().sessions, []);
  index.start();   // must not throw
  index.stop();
});
