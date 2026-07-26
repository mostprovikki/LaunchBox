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

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, dirname, extname, join } from 'node:path';

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

const defaultFsx = { createReadStream, stat };

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
            turns.push({
              role: 'tool_result',
              text: cap(cleanToolText(flattenToolResult(b.content)), TOOL_CAP),
              isError: Boolean(b.is_error),
              t,
            });
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
          const inp = b.input;
          const rendered = typeof inp === 'string' ? inp : JSON.stringify(inp ?? null, null, 2);
          turns.push({ role: 'tool_use', tool: b.name || 'tool', input: cap(rendered, TOOL_CAP), t });
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
