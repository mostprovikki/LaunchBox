// Session discovery and JSONL parsing for Claude Code's ~/.claude/projects.
//
// ─── Provenance ──────────────────────────────────────────────────────────────
// Derived from claude-sessions-dashboard (MIT © 2026 wannabemrrobot), copied
// 2026-07-24; see NOTICE and LICENSES/claude-sessions-dashboard-MIT.txt. The
// logic ported is upstream's `parse_ts`, `extract_text`, `extract_images`,
// `looks_like_real_prompt`, `clean_prompt`, `process_image_annotations`,
// `scan_session` and `read_conversation`. Everything upstream knows that is
// hard-won rather than obvious is kept, above all the pasted-image protocol
// (see processImageAnnotations) and the per-line defensiveness: these files are
// appended to *while we read them*, so a truncated final line is normal.
//
// ─── Deliberate deviations, all measured against the real corpus 2026-07-26 ───
// (57 depth-1 files, 122MB, ~27,350 rows — numbers in docs/plans/…-m5-….md §5.0)
//
//  1. TOKENS ARE DEDUPED. Claude Code writes one assistant row per content
//     block and every one of them repeats the *same* usage object. Two distinct
//     ratios, both measured, because it is easy to quote the wrong one: rows per
//     unique `message.id` is 1.60× / 1.98× / 2.13× on the three largest files,
//     but the figure that matters is the resulting **output-token over-count,
//     2.30× / 2.49× / 2.78×** — higher, because the rows that repeat most are
//     the expensive ones. Across 577 duplicate groups, 0 had a differing usage
//     payload, so keeping one row per id is exactly right rather than an
//     approximation. Upstream sums unconditionally, so its token and cost
//     figures — and those of any tool that sums this JSONL the same way — are
//     wrong by that factor.
//     ⚠️ `usage.iterations[]` repeats the same numbers again. Never add it.
//  2. TOKENS ACCUMULATE PER MODEL, so upstream's split-the-total-by-turn-share
//     apportionment is not approximated but removed. A session that delegates
//     to a cheaper model is priced correctly, and `partial` becomes exact:
//     "some model had no rate", not "some share was guessed".
//  3. The model histogram counts *turns*, not content blocks — it increments
//     inside the same dedupe guard, which is why this costs nothing.
//  4. Timestamps are normalised to UTC and compared as instants. Upstream sorts
//     ISO strings lexicographically, which misorders mixed offsets.
//  5. The prompt-noise list is extended (see NOISE_PREFIXES).
//
// Two guards that are honestly guards, not fixes — both measured to change
// nothing today, both kept because the cost is a line and the failure mode is
// silent: the `isSidechain` skip (0 of 20,559 depth-1 rows) and the
// `turn_duration` subtype check on activeMs (durationMs appears on 146/146
// turn_duration rows and 0 of the other 72 system rows).

import { createReadStream, watch as fsWatch, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { appendFile, open, readdir, stat, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve as resolvePath } from 'node:path';
import {
  upsertSession, getSessionRow, listSessionRows, deleteSessionRow, deleteSessionsExcept,
  listRunsWithSessions,
} from './db.js';

// Sessions a human started, as opposed to one the Agent SDK span up per batch
// item. `''` is a member so an unknown *future* entrypoint fails open — and
// note the key is absent on 25% of real rows, which is where `''` comes from;
// no row on this machine carries a literal empty string.
//
// ⚠️ `sdk-cli` is deliberately NOT here, and that is exactly what this app's own
// `claude -p` runs are. The caller must union this with "sessions our own runs
// created" or it hides the very thing the Sessions tab exists to show
// (plan §5.4). This set alone is not the visibility rule.
export const INTERACTIVE_ENTRYPOINTS = new Set(['cli', 'claude-desktop', 'vscode', 'jetbrains', 'web', '']);

// Per-prompt and per-turn caps, upstream's values.
export const PROMPT_CAP = 6000;
const FIRST_PROMPT_CAP = 280;
const TURN_TEXT_CAP = 16000;
const TOOL_CAP = 1200;

// Leading prefixes that mean "Claude Code injected this", not "a human typed
// it". Upstream's seven, plus five more found by counting what is actually in
// the corpus: <task-notification> (39 occurrences — the largest single class),
// <local-command-caveat> (25, caught by the deliberately unterminated
// '<local-command'), <command-message> as a *leading* prefix (3 — /doctor emits
// it before <command-name>), and the bash/◇ shapes the plan guessed at (1/1/2).
//
// Generic markup is NOT rejected: someone pasting '<svg …>' typed that.
const NOISE_PREFIXES = [
  '<local-command',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<system-reminder>',
  '<task-notification>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  'Caveat:',
  '[Request interrupted',
  '◇',
];

// Claude Code logs each pasted image as TWO user rows:
//   1. the real message: "[Image #N] <your text>" + the inline base64 image
//   2. a companion bookkeeping row: "[Image: source: /tmp/.../N.png]" pointing at
//      a transient cache file that gets cleaned up. This companion carries NO
//      image data and duplicates the real row, so we strip it silently — the
//      image already renders inline.
// Separately, some older sessions logged ONLY "[Image: original WxH, displayed
// at ...]" with no inline data anywhere: those images are genuinely gone, so we
// mark them "not stored".
const IMG_SRC_RE = /\[Image:\s*source:\s*[^\]]+\]/g;
const IMG_DIM_RE = /\[Image:\s*(original[^\]]*)\]/g;

// <system-reminder> blocks are embedded *inside* tool_result content on 24 real
// rows and lead only 1, so a prefix test cannot reach them — the transcript
// needs a block strip as well.
const REMINDER_BLOCK_RE = /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g;

// Raw SGR escapes appear in <local-command-stdout> (measured: "Set model to
// ESC[1mFable 5ESC[22m"). The escape prefix is mandatory, and is written as a
// unicode escape rather than pasted in as a raw byte on purpose: a literal ESC
// in source is invisible to whoever reads this next. Without it the pattern
// would also match a bare "[a", which would eat the opening of every markdown
// link in a tool result.
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// Upstream treats a naive timestamp as UTC; JS parses one as *local*, so a
// faithful port has to append the Z rather than replicate a convention — the
// error would otherwise be silent and exactly the size of the local offset
// (5h30m here). Measured: all 21,478 real timestamps already carry Z, so this
// is a guard against a future writer, not a live correction.
export function parseTs(value) {
  if (!value || typeof value !== 'string') return null;
  const hasZone = /(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(value.trim());
  const ms = Date.parse(hasZone ? value : `${value}Z`);
  return Number.isFinite(ms) ? ms : null;
}

export function looksLikeRealPrompt(text) {
  if (!text) return false;
  const t = String(text).trim();
  if (!t) return false;
  return !NOISE_PREFIXES.some((p) => t.startsWith(p));
}

// Returns { text, notes }: `source:` companions vanish silently (the real image
// is inline in a sibling row), `original WxH` becomes a "not stored" marker.
export function processImageAnnotations(text) {
  const notes = [];
  let out = String(text ?? '').replace(IMG_SRC_RE, '');
  out = out.replace(IMG_DIM_RE, (_m, inner) => {
    const dim = /original\s+(\d+)x(\d+)/.exec(inner);
    notes.push(dim ? `${dim[1]}×${dim[2]}` : 'pasted image');
    return '';
  });
  return { text: out.trim(), notes };
}

export function cleanPrompt(text, limit = FIRST_PROMPT_CAP) {
  if (!text) return '';
  let t = String(text).trim();
  if (t.startsWith('<command-name>')) {
    const idx = t.lastIndexOf('>');
    if (idx !== -1) t = t.slice(idx + 1).trim();
  }
  t = t.replace(/\r/g, ' ');
  return t.length > limit ? `${t.slice(0, limit).trimEnd()}…` : t;
}

function cap(s, n) {
  const v = s ?? '';
  if (v.length <= n) return v;
  const more = (v.length - n).toLocaleString('en-US');
  return `${v.slice(0, n)}\n\n… [truncated ${more} more characters]`;
}

// The encoding maps '/', '.' and '_' all to '-', so this is NOT invertible and
// is a last resort only: on this machine it turns
// '-Users-vignesh-5036-mydevelopment-claude-scheduler' into
// '/Users/vignesh/5036/mydevelopment/claude/scheduler'. Only reached when no row
// in the entire file carried a `cwd`.
export function decodeProjectDir(dirName) {
  return `/${String(dirName ?? '').replace(/^-+/, '').replace(/-/g, '/')}`;
}

function extractText(message) {
  if (typeof message === 'string') return message;
  if (!isObj(message)) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (isObj(block) && block.type === 'text') parts.push(block.text ?? '');
  }
  return parts.filter(Boolean).join('\n');
}

function extractImages(message) {
  if (!isObj(message) || !Array.isArray(message.content)) return [];
  const out = [];
  for (const block of message.content) {
    if (!isObj(block) || block.type !== 'image') continue;
    const src = block.source;
    if (!isObj(src) || src.type !== 'base64' || !src.data) continue;
    out.push({ mediaType: src.media_type || 'image/png', data: src.data });
  }
  return out;
}

const flattenToolResult = (rc) => {
  if (typeof rc === 'string') return rc;
  if (!Array.isArray(rc)) return '';
  const out = [];
  for (const b of rc) {
    if (typeof b === 'string') out.push(b);
    else if (isObj(b) && b.type === 'text') out.push(b.text ?? '');
  }
  return out.filter(Boolean).join('\n');
};

const cleanToolText = (s) => String(s ?? '').replace(REMINDER_BLOCK_RE, '').replace(ANSI_RE, '');

// Stream a file line by line, handing each parsed object to `onRow`. Every
// defence here is load-bearing: the file may be appended to mid-read (so the
// last line can be half-written), may contain invalid UTF-8 (decoded with
// replacement characters rather than throwing), and may contain a bare JSON
// scalar on a line.
async function eachRow(filePath, fsx, onRow) {
  const stream = fsx.createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      let row;
      try { row = JSON.parse(t); } catch { continue; }
      if (!isObj(row)) continue;
      onRow(row);
    }
  } finally {
    rl.close();
    stream.destroy?.();
  }
}

const defaultFsx = { createReadStream, stat, readdir, appendFile, open, unlink };

/**
 * Parse one session `.jsonl` into cacheable metadata. Returns null if the file
 * cannot be read at all — a session we can't open is not a session we can show.
 */
export async function parseSessionFile(filePath, { fsx = defaultFsx } = {}) {
  let st;
  try { st = await fsx.stat(filePath); } catch { return null; }

  const id = basename(filePath, extname(filePath));
  // First-wins environment fields. `gitBranch` is the branch at session *start*.
  let cwd = null; let gitBranch = null; let version = null; let entrypoint = null;
  // Last-wins titles: both are append-only rewrite logs (one real file carries
  // the same custom-title 25 times), and they carry no timestamp of their own.
  let customTitle = null; let aiTitle = null; let lastPrompt = null;
  let firstPrompt = null;
  let firstMs = null; let lastMs = null;
  let activeMs = 0;
  let prompts = 0;
  let webSearches = 0; let webFetches = 0;
  const models = new Map();
  const promptList = [];
  const seenPrompts = new Set();
  // The dedupe key set — the single most important thing in this function.
  const seenUsage = new Set();

  await eachRow(filePath, fsx, (d) => {
    // Guard, not a fix: 0 of 20,559 real depth-1 rows have this set, because
    // subagent turns live in their own <uuid>/subagents/*.jsonl which the
    // depth-1 discovery excludes structurally. If that ever changes, their
    // tokens must not silently land on the parent session.
    if (d.isSidechain === true) return;

    if (!cwd && d.cwd) cwd = d.cwd;
    if (!gitBranch && d.gitBranch) gitBranch = d.gitBranch;
    if (!version && d.version) version = d.version;
    if (!entrypoint && d.entrypoint) entrypoint = d.entrypoint;

    const ts = parseTs(d.timestamp);
    if (ts !== null) {
      if (firstMs === null || ts < firstMs) firstMs = ts;
      if (lastMs === null || ts > lastMs) lastMs = ts;
    }

    switch (d.type) {
      case 'custom-title': customTitle = d.customTitle || customTitle; break;
      case 'ai-title': aiTitle = d.aiTitle || aiTitle; break;
      case 'last-prompt': lastPrompt = d.lastPrompt || lastPrompt; break;
      case 'system':
        // Authoritative, not a heuristic: this is Claude Code's own measure of
        // time spent working, and contrasting it with the wall-clock span is
        // the most informative thing on a session card (50s of work inside a
        // 1.2-day span). The subtype check is the guard described up top.
        if (d.subtype === 'turn_duration') activeMs += num(d.durationMs);
        break;
      case 'assistant': {
        const msg = d.message;
        if (!isObj(msg)) break;
        // One API call is written as N rows (one per content block), each
        // repeating the identical usage. Count it once — and increment the
        // model histogram inside the same guard, which is what makes `turns`
        // mean turns rather than blocks.
        const key = msg.id || d.requestId || null;
        if (key !== null) {
          if (seenUsage.has(key)) break;
          seenUsage.add(key);
        }
        const model = msg.model;
        if (!model || model === '<synthetic>') break;
        let bucket = models.get(model);
        if (!bucket) {
          bucket = { turns: 0, tokIn: 0, tokOut: 0, tokCacheCreate: 0, tokCacheRead: 0 };
          models.set(model, bucket);
        }
        bucket.turns += 1;
        const u = msg.usage;
        if (!isObj(u)) break;
        bucket.tokIn += num(u.input_tokens);
        bucket.tokOut += num(u.output_tokens);
        bucket.tokCacheCreate += num(u.cache_creation_input_tokens);
        bucket.tokCacheRead += num(u.cache_read_input_tokens);
        const stu = u.server_tool_use;
        if (isObj(stu)) {
          webSearches += num(stu.web_search_requests);
          webFetches += num(stu.web_fetch_requests);
        }
        break;
      }
      case 'user': {
        const msg = d.message;
        const images = extractImages(msg);
        const { text: body, notes } = processImageAnnotations(extractText(msg).trim());
        if (!looksLikeRealPrompt(body) && !images.length && !notes.length) break;
        const text = cap(body, PROMPT_CAP);
        // Resume and compaction re-inject earlier prompts verbatim, so the
        // same words legitimately appear many times in one file. Keep the
        // first; a list of 30 identical lines tells the reader nothing.
        const dedupeKey = text || `img:${images.length}:${notes.join(',')}`;
        if (seenPrompts.has(dedupeKey)) break;
        seenPrompts.add(dedupeKey);
        prompts += 1;
        const entry = { t: ts === null ? '' : new Date(ts).toISOString(), text };
        if (images.length) entry.images = images;
        if (notes.length) entry.imageRefs = notes.map((note) => ({ note }));
        promptList.push(entry);
        if (firstPrompt === null && body) firstPrompt = body;
        break;
      }
      default: break;
    }
  });

  // A file with no parseable timestamp anywhere and no title or prompt signal
  // at all is dated by its mtime — otherwise it sorts as if it never happened.
  if (firstMs === null && lastMs === null && !(customTitle || aiTitle || lastPrompt || firstPrompt)) {
    firstMs = st.mtimeMs;
    lastMs = st.mtimeMs;
  }

  // Measured: this fires on 3 of 59 real sessions (224-byte stubs with no `cwd`
  // on any row), and on this machine it yields a path that DOES NOT EXIST —
  // '/Users/vignesh-5036/…' decodes to '/Users/vignesh/5036/…' because the home
  // directory name itself contains a hyphen. So the flag is not decoration: a
  // caller that runs `cd <cwd>` for a resume would land nowhere, and a UI that
  // renders it unqualified is lying about where the session lives.
  const cwdGuessed = !cwd;
  if (!cwd) cwd = decodeProjectDir(basename(dirname(filePath)));

  const modelsOut = {};
  let tokIn = 0; let tokOut = 0; let tokCacheCreate = 0; let tokCacheRead = 0;
  for (const [name, b] of models) {
    modelsOut[name] = b;
    tokIn += b.tokIn; tokOut += b.tokOut;
    tokCacheCreate += b.tokCacheCreate; tokCacheRead += b.tokCacheRead;
  }

  return {
    id,
    filePath,
    mtimeMs: st.mtimeMs,
    sizeBytes: st.size,
    cwd,
    cwdGuessed,
    project: basename(cwd.replace(/\/+$/, '')) || cwd,
    gitBranch: gitBranch || '',
    version: version || '',
    // Normalised, so the allowlist's `''` member is reachable: the key is
    // simply absent on a quarter of real rows.
    entrypoint: entrypoint || '',
    customTitle: customTitle || '',
    aiTitle: aiTitle || '',
    firstPrompt: cleanPrompt(firstPrompt || ''),
    promptList,
    firstTs: firstMs === null ? '' : new Date(firstMs).toISOString(),
    lastTs: lastMs === null ? '' : new Date(lastMs).toISOString(),
    spanMs: firstMs !== null && lastMs !== null ? lastMs - firstMs : 0,
    activeMs: Math.round(activeMs),
    prompts,
    models: modelsOut,
    tokIn,
    tokOut,
    tokCacheCreate,
    tokCacheRead,
    webSearches,
    webFetches,
  };
}

/**
 * Parse one session into an ordered transcript. Thinking blocks and injected
 * noise are omitted; tool calls and their results become their own turns.
 */
export async function readConversation(filePath, { fsx = defaultFsx } = {}) {
  const turns = [];
  try {
    await eachRow(filePath, fsx, (d) => {
      const t = typeof d.timestamp === 'string' ? d.timestamp : '';
      if (d.isSidechain === true) return;
      if (d.type === 'user') {
        const msg = d.message;
        const content = isObj(msg) ? msg.content : msg;
        if (typeof content === 'string') {
          const { text } = processImageAnnotations(content.trim());
          if (text && looksLikeRealPrompt(text)) turns.push({ role: 'user', text: cap(text, TURN_TEXT_CAP), t });
          return;
        }
        if (!Array.isArray(content)) return;
        const parts = [];
        let imgs = 0;
        for (const b of content) {
          if (typeof b === 'string') { parts.push(b); continue; }
          if (!isObj(b)) continue;
          if (b.type === 'text') parts.push(b.text ?? '');
          else if (b.type === 'image') imgs += 1;
          else if (b.type === 'tool_result') {
            // Emitted before this row's own user text, matching upstream's
            // order — a result belongs with the call it answers.
            // Uncapped here on purpose: capping moves to the serialise
            // boundary (capTurnsForClient) so the parser keeps full fidelity
            // — toolUseId is the join key back to its tool_use, and
            // toolUseResult carries structuredPatch / oldTodos-newTodos /
            // stdout-stderr, none of which reach the client if flattened here.
            const turn = {
              role: 'tool_result',
              text: cleanToolText(flattenToolResult(b.content)),
              isError: Boolean(b.is_error),
              t,
            };
            if (b.tool_use_id) turn.toolUseId = b.tool_use_id;
            if (d.toolUseResult !== undefined) turn.toolUseResult = d.toolUseResult;
            turns.push(turn);
          }
        }
        const { text } = processImageAnnotations(parts.filter(Boolean).join('\n').trim());
        if (text && looksLikeRealPrompt(text)) turns.push({ role: 'user', text: cap(text, TURN_TEXT_CAP), t });
        else if (imgs && !text) turns.push({ role: 'user', note: `[${imgs} pasted image${imgs === 1 ? '' : 's'}]`, t });
        return;
      }
      if (d.type !== 'assistant') return;
      const msg = d.message;
      const content = isObj(msg) ? msg.content : null;
      let model = isObj(msg) ? msg.model : null;
      if (model === '<synthetic>') model = null;
      if (typeof content === 'string') {
        const tx = content.trim();
        if (tx) turns.push({ role: 'assistant', text: cap(tx, TURN_TEXT_CAP), t, model });
        return;
      }
      if (!Array.isArray(content)) return;
      for (const b of content) {
        if (!isObj(b)) continue;
        if (b.type === 'text') {
          const tx = String(b.text ?? '').trim();
          if (tx) turns.push({ role: 'assistant', text: cap(tx, TURN_TEXT_CAP), t, model });
        } else if (b.type === 'tool_use') {
          // The parsed object survives here, not a stringified/truncated
          // rendering of it — capping moves to the serialise boundary
          // (capTurnsForClient). toolUseId is what a tool_result joins back
          // to (see the tool_result branch above).
          const turn = { role: 'tool_use', tool: b.name || 'tool', input: b.input ?? null, t };
          if (b.id) turn.toolUseId = b.id;
          turns.push(turn);
        }
        // thinking blocks intentionally omitted
      }
    });
  } catch {
    // An unreadable transcript is an empty one, never an exception: the session
    // list already rendered and the file may have been deleted since.
    return turns;
  }
  return turns;
}

// Recursively cap string leaves of a parsed value, leaving objects and arrays
// intact. This is what lets a capped payload still carry `structuredPatch`,
// `oldTodos`/`newTodos`, etc.: only the strings *inside* them are clamped
// (e.g. a very long diff line), never the structure that holds them.
function capDeep(value, limit) {
  if (typeof value === 'string') return cap(value, limit);
  if (Array.isArray(value)) return value.map((v) => capDeep(v, limit));
  if (isObj(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = capDeep(v, limit);
    return out;
  }
  return value;
}

/**
 * The serialise-time clamp: `readConversation` keeps full fidelity (the
 * corpus's `structuredPatch`, `oldTodos`/`newTodos`, `stdout`/`stderr` and
 * uncapped tool input all survive parsing), but the wire payload to a browser
 * still needs a ceiling — the corpus is 122MB and a single `Read` of a large
 * file or a chatty `Bash` result must not go out uncapped. Caps clamp what is
 * *sent* per turn, never what was *parsed*.
 */
export function capTurnForClient(turn, limit = TOOL_CAP) {
  if (turn.role === 'tool_use' && 'input' in turn) {
    return { ...turn, input: capDeep(turn.input, limit) };
  }
  if (turn.role === 'tool_result') {
    const out = { ...turn, text: cap(turn.text, limit) };
    if ('toolUseResult' in out) out.toolUseResult = capDeep(out.toolUseResult, limit);
    return out;
  }
  return turn;
}

export function capTurnsForClient(turns, limit = TOOL_CAP) {
  return turns.map((t) => capTurnForClient(t, limit));
}

/**
 * Discover session files exactly one level below `root` — that is,
 * `root/<projectDir>/<sessionId>.jsonl` and nothing deeper. Depth-1 is what
 * excludes the per-session `subagents/` transcripts (101 files, 66MB on this
 * machine) structurally, rather than by a filter someone could forget.
 */
export async function discoverSessionFiles(root, { fsx = { readdir: null } } = {}) {
  const readdir = fsx.readdir ?? (await import('node:fs/promises')).readdir;
  let dirs;
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files;
    try {
      files = await readdir(join(root, d.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.isFile() && f.name.endsWith('.jsonl') && !f.name.startsWith('.')) {
        out.push(join(root, d.name, f.name));
      }
    }
  }
  return out;
}

export const DEFAULT_ROOT = join(homedir(), '.claude', 'projects');
// How long after its last write a session counts as live. Upstream's value.
export const DEFAULT_ACTIVE_WINDOW_S = 60;

// A subagent transcript that has not been touched in this long is treated as
// abandoned rather than in flight — a crashed run leaves its last transcript
// mid-conversation forever, and without this every later stop would wait out the
// full hold cap on a subagent that will never finish.
export const DEFAULT_SUBAGENT_STALE_MS = 600_000;

// What Claude Code appends to a subagent transcript when its parent is signalled.
const INTERRUPT_MARK = '[Request interrupted by user]';
// Transcripts are tiny (18-30KB measured), but a long tool-using subagent could
// grow, and only the final record matters.
const TAIL_BYTES = 262_144;

const textOf = (blocks) => blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
const blocksOf = (rec) => {
  const c = rec?.message?.content;
  if (Array.isArray(c)) return c;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return [];
};

/**
 * Has this subagent stopped working, judged from its last transcript record?
 *
 * Measured 2026-07-26 by running real fan-out and diffing a completed transcript
 * against an interrupted one:
 *   - finished   → 5 records, last is `assistant` carrying the answer text
 *   - interrupted→ 4 records, last is `user` carrying "[Request interrupted by user]"
 *   - in flight  → last is the prompt, an `attachment`, or a `tool_result`
 *
 * This replaced an mtime check, which is unsound: the ~18KB prompt+attachments
 * are written when the subagent STARTS and nothing is appended until it FINISHES,
 * so a working subagent's file looks idle the whole time it is thinking. A 15s
 * mtime window reported "settled" 16s in and the SIGINT killed both subagents —
 * the interrupted transcript above is that run.
 */
export function subagentFinished(rec) {
  if (!rec) return false;
  const blocks = blocksOf(rec);
  // Already aborted: nothing left to wait for.
  if (textOf(blocks).includes(INTERRUPT_MARK)) return true;
  // A prompt, an attachment, or a tool_result coming back — the subagent has more
  // to do.
  if (rec.type !== 'assistant') return false;
  // Asked for a tool and is waiting on the result.
  if (blocks.some((b) => b?.type === 'tool_use')) return false;
  // A terminal text response is the subagent's answer.
  return blocks.some((b) => b?.type === 'text');
}

// Last parseable JSON record, read from the tail. Walks backwards because these
// files are appended to while being read, so a truncated final line is normal —
// the same defensiveness the rest of this module applies per line.
function lastRecord(path, size, io) {
  const start = Math.max(0, size - TAIL_BYTES);
  const len = size - start;
  if (len <= 0) return null;
  const buf = Buffer.alloc(len);
  let fd;
  try {
    fd = io.openSync(path, 'r');
    io.readSync(fd, buf, 0, len, start);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { io.closeSync(fd); } catch { /* nothing to do */ } }
  }
  const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
  // A tail read that did not start at byte 0 begins mid-record.
  if (start > 0) lines.shift();
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch { /* keep walking back */ }
  }
  return null;
}

/**
 * How many of a run's subagents are still working.
 *
 * Deliberately synchronous and deliberately NOT built on `createSessionIndex`:
 * that index excludes `subagents/` by design (see `discoverSessionFiles`), and
 * the stop ladder needs an answer about one known session in the tick it decides
 * whether to signal.
 *
 * The session id is matched as a DIRECTORY NAME across every project dir rather
 * than by encoding the run's cwd into a slug. That is not laziness: Claude slugs
 * the *resolved* cwd, so a run in a `/var/...` directory lands under
 * `-private-var-...`, and a cwd-derived slug silently watches a path that never
 * appears. Measured 2026-07-26 — it made the first probe of this bug miss an
 * entire fan-out and report a clean stop.
 */
export function liveSubagentCount(sessionId, {
  root = DEFAULT_ROOT,
  staleMs = DEFAULT_SUBAGENT_STALE_MS,
  now = Date.now,
  fs = null,
} = {}) {
  if (!isValidSessionId(sessionId)) return 0;
  const rd = fs?.readdirSync ?? readdirSync;
  const st_ = fs?.statSync ?? statSync;
  const io = {
    openSync: fs?.openSync ?? openSync,
    readSync: fs?.readSync ?? readSync,
    closeSync: fs?.closeSync ?? closeSync,
  };
  let projects;
  try {
    projects = rd(root, { withFileTypes: true });
  } catch {
    return 0; // no session tree here — not an error, just nothing to wait for
  }
  const staleBefore = now() - staleMs;
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = join(root, p.name, sessionId, 'subagents');
    let files;
    try {
      files = rd(dir);
    } catch {
      continue; // this project dir does not hold that session
    }
    let live = 0;
    for (const f of files) {
      if (!f.endsWith('.jsonl') || f.startsWith('.')) continue;
      const full = join(dir, f);
      try {
        const st = st_(full);
        if (st.size === 0) continue;              // created, nothing written yet
        if (st.mtimeMs < staleBefore) continue;   // abandoned by a dead run
        if (!subagentFinished(lastRecord(full, st.size, io))) live += 1;
      } catch { /* vanished between readdir and read — not in flight */ }
    }
    return live; // session ids are unique, so the first match is the only match
  }
  return 0;
}
// A burst of appends to a growing transcript would otherwise mean one full scan
// per line.
const WATCH_DEBOUNCE_MS = 400;
// Nothing writes a file when a session stops being live, so no watcher event can
// announce it — the running set has to be re-derived on a timer as well.
const LIVENESS_TICK_MS = 15_000;

// A session id is a filename stem and reaches us from a URL. Anything outside
// this alphabet is not an id, and refusing it early is what makes path
// construction safe (upstream's guard, kept verbatim in spirit).
export const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
export const isValidSessionId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 200
  && SESSION_ID_RE.test(id) && id !== '.' && id !== '..';

/**
 * The live index over ~/.claude/projects: an mtime/size-keyed cache in front of
 * the parser, a watcher, and the join to this app's own runs.
 *
 * Deviations from upstream, which re-reads and fully re-parses every .jsonl on
 * every request (including after each rename and delete):
 *   - unchanged files are never re-parsed;
 *   - transcripts are parsed on demand and never in the list path;
 *   - a watcher replaces 7s polling;
 *   - our own rename-append does not make a session look live. Upstream's own
 *     rename bumps mtime, so it greys out its own Delete button for 60s.
 */
export function createSessionIndex({
  db,
  root = DEFAULT_ROOT,
  activeWindowS = DEFAULT_ACTIVE_WINDOW_S,
  now = () => Date.now(),
  fsx = defaultFsx,
  watchFn = fsWatch,
} = {}) {
  const events = new EventEmitter();
  events.setMaxListeners(100);
  // EventEmitter *throws* an unhandled 'error' rather than dropping it, so
  // emitting one before the daemon has subscribed would turn a tolerable
  // condition (no ~/.claude/projects — Claude Code may never have run here)
  // into a crash. Found by a test that only asserted start() must not throw.
  const warn = (err) => {
    if (events.listenerCount('error')) events.emit('error', err);
  };
  let watcher = null;
  let debounce = null;
  let ticker = null;
  let scanning = null;
  let lastRunningSig = null;
  // id -> the exact mtimeMs the file had immediately after *we* appended to it.
  // Compared by value rather than by a time window: if anything else writes
  // afterwards the mtime moves and the session is live again, which is the whole
  // point. A window would either mask a real write or expire too early.
  const selfWrites = new Map();

  const liveAt = (id, mtimeMs) => {
    if (selfWrites.get(id) === mtimeMs) return false;
    return mtimeMs > now() - activeWindowS * 1000;
  };

  // For listing: uses the cached mtime, which is what makes the list path free.
  const isRunning = (row) => (row ? liveAt(row.id, row.mtimeMs) : false);

  // For *writing*: re-stats first. Liveness otherwise moves only when a scan
  // runs, so a session that went live inside the liveness tick would still look
  // idle — and the direction that matters is exactly that one, since the whole
  // point of the gate is not to append to a file another process is writing.
  // Falls back to the cached answer if the stat fails: a file we cannot stat is
  // one we should not be mutating either way.
  async function isRunningNow(row) {
    try {
      const st = await fsx.stat(row.filePath);
      return liveAt(row.id, st.mtimeMs);
    } catch {
      return isRunning(row);
    }
  }

  // Refuse to build a path from an id, ever: resolve the one the cache recorded
  // and check it is still under the root. Two independent guards, because the
  // id guard alone would not survive someone storing a crafted row.
  function fileFor(row) {
    if (!row?.filePath) return null;
    const resolved = resolvePath(row.filePath);
    const base = resolvePath(root);
    return resolved === base || resolved.startsWith(base + '/') ? resolved : null;
  }

  async function scan() {
    if (scanning) return scanning;
    scanning = (async () => {
      const files = await discoverSessionFiles(root, { fsx });
      const cached = new Map(listSessionRows(db).map((r) => [r.filePath, r]));
      const ids = [];
      let parsed = 0;
      for (const file of files) {
        let st = null;
        try { st = await fsx.stat(file); } catch { continue; }
        const hit = cached.get(file);
        // The cache key. Size as well as mtime because a same-second append can
        // leave mtimeMs unchanged on some filesystems while the file grows.
        if (hit && hit.mtimeMs === st.mtimeMs && hit.sizeBytes === st.size) {
          ids.push(hit.id);
          continue;
        }
        const meta = await parseSessionFile(file, { fsx });
        if (!meta) continue;
        upsertSession(db, meta);
        ids.push(meta.id);
        parsed += 1;
      }
      const removed = deleteSessionsExcept(db, ids);
      if (parsed || removed) events.emit('change', { parsed, removed });
      return { discovered: files.length, parsed, removed };
    })().finally(() => { scanning = null; });
    return scanning;
  }

  // The §5.4 join, and the visibility rule that depends on it.
  function runsBySession() {
    const map = new Map();
    for (const r of listRunsWithSessions(db)) {
      if (!map.has(r.sessionId)) map.set(r.sessionId, []);
      map.get(r.sessionId).push(r);
    }
    return map;
  }

  function list({ all = false } = {}) {
    const runs = runsBySession();
    const rows = listSessionRows(db);
    const decorated = rows.map((row) => {
      const mine = runs.get(row.id) ?? [];
      return {
        ...row,
        running: isRunning(row),
        // "created by job <name>" — the thing no standalone tool can show.
        runs: mine.map((r) => ({ runId: r.runId, jobId: r.jobId, jobName: r.jobName, status: r.status, createdAt: r.createdAt })),
      };
    });
    // Ours are ours: a session this app started is never noise, whatever its
    // entrypoint. Without this union every scheduled run's transcript is hidden,
    // because `claude -p` writes entrypoint 'sdk-cli' and that is deliberately
    // not in the interactive allowlist (plan §5.4).
    const visible = (s) => INTERACTIVE_ENTRYPOINTS.has(s.entrypoint) || s.runs.length > 0;
    const sessions = all ? decorated : decorated.filter(visible);
    // Running sessions float to the top as a second pass, so the primary
    // recency order is preserved within each group.
    sessions.sort((a, b) => Number(b.running) - Number(a.running));
    return { sessions, hidden: decorated.length - decorated.filter(visible).length };
  }

  function get(id) {
    if (!isValidSessionId(id)) return null;
    const row = getSessionRow(db, id);
    if (!row) return null;
    const mine = runsBySession().get(id) ?? [];
    return { ...row, running: isRunning(row), runs: mine };
  }

  async function conversation(id) {
    const row = get(id);
    if (!row) return null;
    const file = fileFor(row);
    if (!file) return null;
    // This is the payload boundary to the client — see capTurnsForClient for
    // why the clamp lives here and not in readConversation.
    const turns = await readConversation(file, { fsx });
    return { session: row, turns: capTurnsForClient(turns) };
  }

  /**
   * Append a `custom-title` row. Refused while the session is live, because this
   * app spawns `claude` itself: "another process is appending to this exact file
   * right now" is normal operating state here, not an edge case, and a single
   * appendFile is well-formed but not atomic against a concurrent writer.
   * Upstream applies its liveness gate to delete only.
   */
  async function rename(id, name) {
    const row = get(id);
    if (!row) return { ok: false, error: 'not found', status: 404 };
    const title = String(name ?? '').trim();
    if (!title) return { ok: false, error: 'name is required', status: 400 };
    if (title.length > 200) return { ok: false, error: 'name must be 200 characters or fewer', status: 400 };
    if (await isRunningNow(row)) {
      return { ok: false, status: 409, error: 'that session is being written to right now — renaming it could corrupt the transcript. Try again once it has been idle for a minute.' };
    }
    const file = fileFor(row);
    if (!file) return { ok: false, error: 'not found', status: 404 };

    // Ensure the file ends in a newline before appending, so the custom-title row
    // can't get glued onto the last line (which would corrupt both and lose the
    // rename). A file being appended to as we read it can genuinely end
    // mid-line.
    let needNl = false;
    try {
      const st = await fsx.stat(file);
      if (st.size > 0) {
        const fh = await fsx.open(file, 'r');
        try {
          const buf = Buffer.alloc(1);
          await fh.read(buf, 0, 1, st.size - 1);
          needNl = buf[0] !== 0x0a;
        } finally {
          await fh.close();
        }
      }
    } catch {
      // Fail safe: if the probe itself failed, do not inject a newline on a
      // guess. A missing newline is recoverable; a spurious one is a new row.
      needNl = false;
    }

    const entry = JSON.stringify({
      type: 'custom-title',
      customTitle: title,
      timestamp: new Date(now()).toISOString(),
    });
    try {
      await fsx.appendFile(file, `${needNl ? '\n' : ''}${entry}\n`, 'utf8');
    } catch (err) {
      return { ok: false, status: 500, error: `could not write the session file: ${err?.message ?? err}` };
    }
    // Remember the mtime our own write produced, so the liveness check does not
    // read it back as somebody working.
    try {
      const after = await fsx.stat(file);
      selfWrites.set(id, after.mtimeMs);
    } catch { /* the rename landed; the flag is an optimisation */ }
    const meta = await parseSessionFile(file, { fsx });
    if (meta) upsertSession(db, meta);
    events.emit('change', { renamed: id });
    return { ok: true, session: get(id) };
  }

  /** Delete the transcript. Refused while it is being written to. */
  async function remove(id) {
    const row = get(id);
    if (!row) return { ok: false, error: 'not found', status: 404 };
    if (await isRunningNow(row)) {
      return { ok: false, status: 409, error: 'that session is running — stop it before deleting the transcript' };
    }
    const file = fileFor(row);
    if (!file) return { ok: false, error: 'not found', status: 404 };
    try {
      await fsx.unlink(file);
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        return { ok: false, status: 500, error: `could not delete the session file: ${err?.message ?? err}` };
      }
    }
    deleteSessionRow(db, id);
    selfWrites.delete(id);
    events.emit('change', { removed: id });
    return { ok: true, id };
  }

  /**
   * The pieces of a resume, kept apart on purpose. Upstream builds a shell
   * string with shlex.quote, which has no Node equivalent — and a naive
   * `cd "${cwd}"` is a command-injection hazard, since a project path may
   * legitimately contain a quote or a `$`. We spawn with an argv array, so the
   * string is for display only and `cwd` is passed, never interpolated.
   */
  function resumeSpec(id) {
    const row = get(id);
    if (!row) return null;
    // Multiple sessions can share one custom title in one cwd, which makes
    // `claude --resume "<name>"` ambiguous — resume those by id.
    const sameName = row.customTitle
      ? listSessionRows(db).filter((s) => s.customTitle === row.customTitle && s.cwd === row.cwd)
      : [];
    const ambiguous = sameName.length > 1;
    const token = !row.customTitle || ambiguous ? row.id : row.customTitle;
    return {
      id: row.id,
      cwd: row.cwd,
      // A guessed cwd does not exist on disk, so resuming there would fail in a
      // confusing way. Say so instead of trying.
      cwdGuessed: row.cwdGuessed,
      ambiguous,
      args: ['--resume', token],
      display: `claude --resume ${token}`,
    };
  }

  function runningIds() {
    return listSessionRows(db).filter(isRunning).map((r) => r.id).sort();
  }

  // Only emit when the set actually changes: SSE clients redraw on this.
  function pulse() {
    const ids = runningIds();
    const sig = ids.join(',');
    if (sig === lastRunningSig) return;
    lastRunningSig = sig;
    events.emit('running', { ids });
  }

  function start() {
    if (watcher || ticker) return;
    try {
      // eventType is deliberately ignored. Measured on macOS: an append to an
      // existing file arrives as 'rename', never 'change' — so filtering on
      // 'change' would mean never noticing a live session grow, silently.
      watcher = watchFn(root, { recursive: true }, () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          scan().then(pulse).catch(() => {});
        }, WATCH_DEBOUNCE_MS);
        debounce.unref?.();
      });
      watcher.on?.('error', warn);
    } catch (err) {
      // A missing ~/.claude/projects is not an error: Claude Code may simply
      // never have run, and the directory can appear later. The timer still
      // drives rescans, so the tab recovers on its own.
      warn(err);
      watcher = null;
    }
    ticker = setInterval(() => { scan().then(pulse).catch(() => {}); }, LIVENESS_TICK_MS);
    // unref: the daemon is held open by its HTTP listener, not by this.
    ticker.unref?.();
  }

  function stop() {
    clearTimeout(debounce);
    debounce = null;
    if (ticker) clearInterval(ticker);
    ticker = null;
    watcher?.close?.();
    watcher = null;
  }

  return {
    events, start, stop, scan, list, get, conversation, rename, remove, resumeSpec,
    running: runningIds,
    root: () => root,
    activeWindowS: () => activeWindowS,
  };
}
