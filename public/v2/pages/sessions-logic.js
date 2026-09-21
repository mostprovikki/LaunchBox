// Pure (DOM-free) helpers for the Sessions tab and the transcript page
// (claude-scheduler-btv.10 / C3). Same split as jobs-logic.js and
// projects-logic.js: the decisions worth testing live here, the DOM lives in
// sessions.js / session.js.
//
// Semantics for the collapsed tool summaries and the diff rendering are copied
// IN SPIRIT from public/transcript.js (M5's work) — not imported, because /v2
// owns its own modules (README.md). The markup is different on purpose: the
// mockups use `.tooluse` / `.tooldetail` / `.diff`, not M5's `<details>`-based
// `.t-block`. What is carried over is the part M5 learned from the real corpus
// — which fields a Grep/Edit/TodoWrite result actually carries, and that a
// summariser must never be the reason a turn fails to render.
//
// ---------------------------------------------------------------------------
// MOCKUP CLAIMS THIS MODULE REFUSES, and why. Encoded as gates in
// tests/frontend-v2-sessions.test.js, not left as prose — three earlier beads
// watched a refusal in one file's comments fail to stop another page making
// the same claim.
//
// • "38 tool calls" on a LIST card (sessions.html's Turns fact). The sessions
//   table (lib/db.js) has `prompts`, `models`, `spanMs`, `activeMs` and the
//   token columns — and no tool-call count. Counting them means parsing the
//   transcript, which is one file read per card. The TRANSCRIPT page does have
//   the parsed turns, so it counts them there, where the read is already paid
//   for.
//
// • "Outcome: TASK-COMPLETE · bead wb-142 closed" on a LIST card. Same cost
//   problem, plus the same data problem as claude-scheduler-dc9: nothing
//   persists whether the scheduler closed the bead or handed it back. On the
//   transcript page the MARKER ITSELF is observable — it is text in the last
//   assistant turn — so that is rendered, and only that. "closed by the
//   scheduler after the marker was seen" is not.
//
// • "142 Claude Code transcripts under ~/.claude/projects" and the empty
//   state's same sentence. The index root is real (server.js passes
//   `CS_SESSIONS_ROOT || undefined` to createSessionIndex) but it is never
//   sent to the browser — GET /api/sessions returns `{sessions, hidden}`.
//   Hard-coding the default path would be wrong on exactly the machines where
//   it matters most. Recovering it is an additive field away; see the
//   follow-up bead rather than guessing here.
//
// • "burst · webapp-billing" as a card tag. `list()` decorates each session
//   with `runs: [{runId, jobId, jobName, status, createdAt}]` — the job's
//   NAME, not the trigger that fired it. The job name is rendered; "burst" is
//   not, because nothing on the row says a burst started it.
//
// • "Branch … worktree" on the transcript facts grid. `gitBranch` is recorded;
//   whether that branch lives in a worktree is not. The value is shown with
//   the descriptor the data supports ("from transcript"), not the one the
//   mockup guessed.

export const pad2 = (n) => String(n).padStart(2, '0');

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Fri 23:12" for something inside the last week, else "1 Aug 23:12". */
export function fmtWhen(iso, now = Date.now()) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const ageDays = (now - d.getTime()) / 86400000;
  return ageDays < 7 && ageDays >= 0
    ? `${DAYS[d.getDay()]} ${clock}`
    : `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock}`;
}

/** "10h ago" / "1d ago" — the second half of a card's timestamp line. */
export function relAgo(iso, now = Date.now()) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const mins = Math.round((now - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * "14m 51s" / "2h 06m" / "1d 4h" — a duration at the precision the mockups
 * use, which changes with magnitude rather than always being mm:ss.
 */
export function fmtDur(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `0m ${pad2(secs)}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${pad2(secs % 60)}s`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${pad2(mins % 60)}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

/** "1.9M" / "31.2k" / "204" — token counts at the mockups' precision. */
export function fmtCount(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/** "42 MB" / "812 kB" — `sizeBytes` on the transcript's Session fact. */
export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${n} B`;
}

/**
 * `models` is `{ "<full model id>": {turns, tokIn, tokOut, …} }` — lib/
 * sessions.js builds it, keyed by the id the transcript carries
 * ("claude-sonnet-4-5-20250929"), and increments `turns` once per API call
 * rather than once per content block (its `seenUsage` dedupe).
 *
 * Returns `{ total, parts: [{ name, turns, pct }] }`, biggest first. The short
 * name is the family — the mockups say "sonnet 100%", never the full id — and
 * anything that does not parse as a known family keeps its id rather than
 * being bucketed into a guess.
 */
const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];
export function modelShortName(id) {
  const s = String(id ?? '');
  const hit = FAMILIES.find((f) => s.includes(f));
  return hit ?? s;
}

export function modelMix(models) {
  const entries = Object.entries(models && typeof models === 'object' ? models : {});
  const byFamily = new Map();
  let total = 0;
  for (const [id, bucket] of entries) {
    const turns = Number(bucket?.turns) || 0;
    if (!turns) continue;
    const name = modelShortName(id);
    byFamily.set(name, (byFamily.get(name) ?? 0) + turns);
    total += turns;
  }
  const parts = [...byFamily.entries()]
    .map(([name, turns]) => ({ name, turns, pct: total ? Math.round((turns / total) * 100) : 0 }))
    .sort((a, b) => b.turns - a.turns || a.name.localeCompare(b.name));
  return { total, parts };
}

/** "sonnet 100%" / "opus 71% · sonnet 29%" / "—" when nothing was recorded. */
export function modelText(models) {
  const { parts } = modelMix(models);
  if (!parts.length) return '—';
  return parts.map((p) => `${p.name} ${p.pct}%`).join(' · ');
}

/** "opus+sonnet" — the compact card's shorter form. */
export function modelTextCompact(models) {
  const { parts } = modelMix(models);
  if (!parts.length) return '—';
  return parts.map((p) => p.name).join('+');
}

/** Total assistant turns across every model — the Turns fact. */
export function turnCount(models) {
  return modelMix(models).total;
}

/**
 * A session's display title, in the order the transcript itself prefers: a
 * name the human set, then one Claude generated, then the first prompt, then
 * the bare id. Mirrors what M5's list does, so the two UIs never disagree
 * about what a session is called.
 */
export function sessionTitle(s) {
  const t = s?.customTitle || s?.aiTitle || s?.firstPrompt;
  if (t) return String(t).split('\n')[0].slice(0, 160);
  return s?.id ? shortId(s.id) : 'untitled session';
}

/** "7c02…4e" — the mockups' abbreviated session id. */
export function shortId(id) {
  const s = String(id ?? '');
  return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-2)}` : s;
}

/**
 * Was this session started by a LaunchBox job? `runs` is the decoration
 * lib/sessions.js's list() adds; a non-empty array is the only thing that
 * makes a session "ours", and it is also why an `sdk-cli` session is visible
 * at all (its own comment on INTERACTIVE_ENTRYPOINTS).
 */
export const isFromJob = (s) => (s?.runs?.length ?? 0) > 0;

/**
 * The card's provenance tag, or null. The mockup reads "burst · webapp-billing";
 * `runs[]` carries the job NAME and no trigger, so only the half that exists is
 * rendered.
 */
export function jobTag(s) {
  const run = s?.runs?.[0];
  if (!run) return null;
  return run.jobName || `job ${run.jobId ?? ''}`.trim();
}

export const SORTS = Object.freeze({
  newest: { label: 'Newest first', key: (s) => new Date(s.lastTs ?? 0).getTime() || 0 },
  largest: { label: 'Largest first', key: (s) => Number(s.sizeBytes) || 0 },
  active: { label: 'Most active time', key: (s) => Number(s.activeMs) || 0 },
});

/**
 * Filter + sort for the toolbar. `scope` is 'all' | 'jobs' | 'interactive'.
 *
 * Running sessions are NOT re-floated to the top here: lib/sessions.js's
 * list() already does that, and doing it twice would silently override an
 * explicit "Largest first" the reader chose.
 */
export function filterSessions(sessions, { query = '', scope = 'all', sort = 'newest' } = {}) {
  const q = query.trim().toLowerCase();
  const picked = (sessions ?? []).filter((s) => {
    if (scope === 'jobs' && !isFromJob(s)) return false;
    if (scope === 'interactive' && isFromJob(s)) return false;
    if (!q) return true;
    const hay = [sessionTitle(s), s.cwd, s.gitBranch, s.id, jobTag(s)]
      .map((v) => String(v ?? '').toLowerCase());
    return hay.some((h) => h.includes(q));
  });
  const keyOf = (SORTS[sort] ?? SORTS.newest).key;
  return picked.sort((a, b) => keyOf(b) - keyOf(a));
}

export function scopeCounts(sessions = []) {
  const jobs = sessions.filter(isFromJob).length;
  return { all: sessions.length, jobs, interactive: sessions.length - jobs };
}

// ------------------------------------------------------------- transcript

/**
 * Pair `tool_result` turns to the `tool_use` that produced them, and report
 * which results were consumed. Copied in spirit from public/transcript.js's
 * renderConversation(): a tool_use precedes its result chronologically
 * (lib/sessions.js's readConversation), so the index has to be built in a
 * first pass or the result renders again later as an unpaired sibling.
 */
export function pairTurns(turns = []) {
  const resultFor = new Map();
  for (const t of turns) {
    if (t?.role === 'tool_result' && t.toolUseId) resultFor.set(t.toolUseId, t);
  }
  const consumed = new Set();
  for (const t of turns) {
    if (t?.role === 'tool_use' && t.toolUseId && resultFor.has(t.toolUseId)) {
      consumed.add(resultFor.get(t.toolUseId));
    }
  }
  return { resultFor, consumed };
}

const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

export function truncate(s, n = 90) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

const firstLine = (s) => {
  const str = String(s ?? '');
  const nl = str.indexOf('\n');
  return nl === -1 ? str : `${str.slice(0, nl)}…`;
};

function fileEditSummary(i, result) {
  const hunks = result?.toolUseResult?.structuredPatch;
  if (Array.isArray(hunks) && hunks.length) {
    return `${i.file_path} · ${hunks.length} hunk${hunks.length === 1 ? '' : 's'}`;
  }
  return i.file_path;
}

// Which fields each well-known tool's result actually carries is the part of
// M5's work worth keeping verbatim — it came from reading the real corpus, not
// from the API docs. Every entry tolerates a missing or malformed result: a
// summariser must never be the reason a turn fails to render.
const SUMMARIZERS = {
  Bash: (i) => firstLine(i.command),
  Read: (i) => i.file_path,
  Write: fileEditSummary,
  Edit: fileEditSummary,
  MultiEdit: fileEditSummary,
  Glob: (i) => i.pattern,
  WebFetch: (i) => i.url,
  WebSearch: (i) => i.query,
  Task: (i) => i.description || firstLine(i.prompt),
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
  TodoWrite: (i, result) => {
    const todos = Array.isArray(i.todos) ? i.todos
      : (Array.isArray(result?.toolUseResult?.newTodos) ? result.toolUseResult.newTodos : null);
    if (!todos) return '';
    return `${todos.length} todo${todos.length === 1 ? '' : 's'}`;
  },
};

/**
 * The collapsed header's right-hand summary for one tool call. Returns '' when
 * nothing useful is known, which the caller renders as a bare tool name rather
 * than an empty separator.
 */
export function toolSummary(tool, input, result) {
  const i = asObj(input);
  let detail = '';
  // The guard covers the FALLBACK too, not just the summariser. The first
  // version wrapped only the summariser call, and a test proved that was not
  // enough: a turn whose input throws on property access threw again in
  // `JSON.stringify(i[key])` one line later, so the whole page still failed to
  // render on the exact shape the guard existed for.
  try {
    detail = (SUMMARIZERS[tool] ?? (() => ''))(i, result) ?? '';
    if (!detail) {
      const key = Object.keys(i)[0];
      if (key !== undefined) detail = `${key}: ${JSON.stringify(i[key])}`;
    }
  } catch {
    detail = ''; // a surprising shape degrades to the bare tool name
  }
  return truncate(detail, 90);
}

/**
 * Which tool calls open by default. The mockup shows Edit and Bash expanded
 * and Read/Grep/Glob collapsed, and the reason generalises: a call that
 * CHANGED something, or whose output is the point, is worth reading; a call
 * that merely looked something up is noise until asked for. An errored result
 * always opens, whatever the tool — a failure the reader has to go hunting for
 * is the thing a transcript page exists to prevent.
 */
const OPEN_BY_DEFAULT = new Set(['Edit', 'Write', 'MultiEdit', 'Bash', 'NotebookEdit']);
export function toolOpensByDefault(tool, result) {
  if (result?.isError) return true;
  return OPEN_BY_DEFAULT.has(tool);
}

/**
 * Split a `structuredPatch` hunk's lines into {sign, text} for rendering. The
 * CLI pre-computes these (lib/sessions.js passes them through verbatim), so
 * there is no diffing here — only classification, and it uses the line's own
 * first character so a hunk with mixed signs never mis-colours.
 */
export function diffLines(hunk) {
  const header = `@@ -${hunk?.oldStart},${hunk?.oldLines} +${hunk?.newStart},${hunk?.newLines} @@`;
  const lines = (Array.isArray(hunk?.lines) ? hunk.lines : []).map((line) => {
    const sign = String(line)[0];
    return { cls: sign === '+' ? 'add' : sign === '-' ? 'del' : 'ctx', text: String(line) };
  });
  return { header, lines };
}

/**
 * The TASK-COMPLETE marker, read out of the transcript's own text — the one
 * outcome fact this page can state, because it is the literal contract the
 * scheduler's prompt asks the agent to honour ("end your final message with
 * TASK-COMPLETE: <beadId>").
 *
 * Deliberately says nothing about what the SCHEDULER then did. Whether the
 * bead was closed or handed back is not persisted anywhere
 * (claude-scheduler-dc9) — lib/projects.js emits the event and server.js only
 * console.logs it. "bead wb-142 closed by the scheduler after the marker was
 * seen", which the mockup's coverage line claims, is exactly that missing
 * fact.
 *
 * Only the LAST assistant turn is inspected: the marker is a contract about
 * the final message, and an agent quoting the instruction mid-run (as this
 * very session's prompts do) must not be read as having finished.
 */
const MARKER = /TASK-COMPLETE:\s*([A-Za-z0-9._-]+)/;
export function taskCompleteMarker(turns = []) {
  const assistant = [...turns].reverse().find((t) => t?.role === 'assistant' && t.text);
  if (!assistant) return null;
  const m = MARKER.exec(assistant.text);
  return m ? { beadId: m[1] } : null;
}

/** Counts for the transcript's coverage footer. */
export function transcriptCounts(turns = []) {
  // pairTurns() is built ONCE here, not per row: it is a full pass over the
  // turn list, and a transcript can carry thousands of them.
  const { resultFor } = pairTurns(turns);
  const toolUses = turns.filter((t) => t?.role === 'tool_use');
  const collapsed = toolUses.filter(
    (t) => !toolOpensByDefault(t.tool, t.toolUseId ? resultFor.get(t.toolUseId) : null),
  ).length;
  const toolCalls = toolUses.length;
  return {
    turns: turns.filter((t) => t?.role === 'assistant' || t?.role === 'user').length,
    toolCalls,
    collapsed,
  };
}
