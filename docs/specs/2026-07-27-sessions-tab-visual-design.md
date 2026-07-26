# Sessions tab — visual language and transcript rendering

Supersedes the visual half of `docs/plans/2026-07-25-m5-sessions-dashboard.md` §5.7.
Data layer (§5.0–§5.6) is unchanged and still governs.

## Why this exists

M5 §5.7 said to rebuild against the existing design tokens and explicitly listed
upstream's UI under "skip entirely" (§5.3 deviation 6). After using the upstream
dashboard live, that call is reversed for the Sessions tab: its visual language is
better than ours and worth adopting rather than merely referencing.

What changed the decision was seeing it running, not reading it. Three things earn
their keep:

- **Density with legibility.** A card carries ~10 facts — age, absolute date, days
  old, span, active time, model mix, tokens out, branch, cwd — and still scans,
  because every fact is a bordered chip with an icon rather than a run of prose.
  Our job rows carry three facts in more vertical space.
- **Labelled affordances.** `View 14 prompts`, `Conversation`, `Rename`, `Open`,
  `Delete` — words, against our unlabelled pencil/copy/trash glyphs.
- **Sentence tooltips.** "Delete this session permanently", "Open project folder in
  your file manager". This is the instinct `public/style.css:367` already argues
  for: a reason should be readable, not tucked away.

## Scope

**The Sessions tab only.** Jobs, History, Projects and Settings keep the current
styling. This is deliberate: the new language gets proven on one screen built from
scratch in it before anything existing is disturbed. The cost is accepted and named
— for a while LaunchBox has two visual languages side by side, and the Sessions tab
will visibly not match its neighbours.

Out of scope, and each for a stated reason:

- **Light mode.** Already ruled out in `2026-07-26-ui-icons-thresholds-time.md:8`,
  and a theme cannot sensibly be scoped to one tab. The token *structure* below is
  chosen so light mode is a later drop-in, but only the dark values ship.
- **Migrating the 48 existing `title=` attributes.** The tooltip component is built
  for the Sessions tab; converting the other tabs is a follow-up.
- **Restyling the log drawer.** The raw `tail -f` view for Claude jobs is the
  biggest single readability problem in the app, but it is a different surface with
  a different data source. Filed separately.

## What is adopted, and what is fixed rather than copied

Upstream is MIT (`LICENSES/claude-sessions-dashboard-MIT.txt`) and `NOTICE:14-20`
already carries the attribution — M5 §5.1 discharged this. `NOTICE:29` still says
`lib/sessions.js` is "(planned, M5)"; that parenthetical is now stale and gets
corrected.

Adopted:

- **Semantic token layering.** Upstream's three-block structure — `:root` light,
  `@media (prefers-color-scheme: dark)`, `:root[data-theme=…]` — with tokens named
  by role (`--card`, `--card-h`, `--inset`, `--text-2`, `--muted-2`, `--border-2`,
  `--accent-soft`, `--accent-line`, three shadow tiers, three radii, one `--ease`).
  Ours has eight flat colours and one radius; every other spacing, size and radius
  in `public/style.css` is an inline literal. Only the dark block gets values.
- **The chip grid** as the card's information layer: icon + label + bold value,
  bordered, wrapping.
- **Arm-then-confirm inline delete** (`claude-sessions:1512-1519`, six lines): the
  card's action row becomes `⚠ Delete permanently? · Cancel · [Delete]`. Scoped to
  the card, so the armed row is never ambiguous. This replaces `window.confirm()`
  **for session delete only** — see the carve-out below.
- **A themed tooltip component**: one `#tooltip` element plus `data-tip` on any
  element, one delegated listener.

Fixed rather than copied:

- **The tooltip must use the tokens.** Upstream hardcodes `background:#FFFFFF`
  (`claude-sessions:760`), so it stays a white card in dark mode — it opts out of
  its own token system.
- **Tool input must wrap, not clip.** Upstream puts the JSON in a `<pre>` that
  overflows horizontally; a long `Bash` command runs off the card edge and is
  unreadable. Confirmed live.
- **`tool_result` must be paired with the call it answers.** Upstream renders it as
  a sibling row labelled only `tool result`, so in a run with parallel tool calls
  there is no way to tell which result belongs to which call.

## The transcript viewer

The decision is **one generic renderer, done well, now — per-tool renderers later**,
once there is evidence from reading real transcripts in it about which tools matter.
Per-tool rendering (Bash as a shell line, Edit/Write as a diff, TodoWrite as a
checklist) is filed as a follow-up bead, not built here.

The generic renderer must earn the deferral by fixing the three defects above plus:

- A **one-line summary in the collapsed header** — `used Bash · git log -1 …` rather
  than a bare `used Bash` — so a collapsed transcript is still skimmable. This is
  what makes "generic" tolerable, and it is the single most load-bearing detail
  here. It is also exactly what Claude Code's own `renderToolUseMessage` returns.
- **Syntax-highlighted JSON**, hand-rolled: a token-type walk over a value we just
  parsed, not a language.

### Reuse what exists

Investigated rather than assumed, because "someone else maintains the new tools" is
the right instinct and worth spending time on.

**Markdown: take the dependency.** `marked` (18.0.7, MIT) and `DOMPurify` (3.4.12,
MPL-2.0/Apache-2.0) are both single-file, **zero-runtime-dependency, browser-ESM**
builds — `lib/marked.esm.js` and `dist/purify.es.mjs`. They vendor into
`public/vendor/` as plain static files and load with `<script type="module">`; no
bundler, no build step, no change to how `public/` is served. This replaces the
hand-rolled renderer an earlier draft of this spec proposed. DOMPurify is also the
stronger safety answer: "only ever assign `textContent`" is a discipline a later
edit breaks silently, whereas a sanitiser is enforced at the call site.

⚠️ `public/` must contain no symlinks — the daemon refuses to start otherwise (v3
auth hardening). Vendor real files, not links into `node_modules`.

**Tool rendering: nothing importable exists in Anthropic's own artifacts.**
Verified, not assumed:

- The installed `claude` is a **231 MB single-file Bun executable** with no
  `package.json`, no `lib/`, no sourcemaps. The npm package declares `bin` only —
  no `main`, no `exports`. It is a binary shipper, not a library.
- Its rendering *is* per-tool — 105 `renderToolResultMessage` and 86
  `renderToolUseMessage` implementations survive minification — which independently
  validates the per-tool direction and its generic JSON-dump fallback. But it
  returns **Ink JSX bound to a terminal box model and 16 colour names**. It would
  not transplant into a browser even if it were extractable.
- `@anthropic-ai/claude-agent-sdk` exports the runtime `query` API and **zero
  renderers**. Its `./sdk-tools` subpath is **types-only** — no `default` key, no
  `.js` shipped — so it cannot be imported at runtime. Its licence is *not* OSS
  ("SEE LICENSE IN README.md"), so vendoring the `.d.ts` needs a licence read first.
  We are a plain-JS repo with no typecheck step, so the value is documentation, not
  enforcement. **Not taken; noted for whoever revisits per-tool rendering.**

**Still open:** a survey of the third-party ecosystem (transcript viewers on npm and
GitHub — `claude-code-log`, `assistant-ui`, Vercel AI Elements, and others) was
commissioned but had not reported when this was written. It is unlikely to change
the conclusion, because the binding constraint is ours rather than theirs: no build
step, no bundler, no React. Anything React-shaped is out regardless of quality.
Whoever picks up `claude-scheduler-a6o` should re-run that check rather than treat
this paragraph as settled.

So: hand-roll the tool rendering, but do it against Anthropic's own data contract
rather than an invented one, and keep the fallback generic so an unknown future tool
degrades to pretty JSON instead of breaking.

### The parser change that must happen now, not later

**This is the load-bearing finding of this spec.** `lib/sessions.js:473` does:

```js
const rendered = typeof inp === 'string' ? inp : JSON.stringify(inp ?? null, null, 2);
turns.push({ role: 'tool_use', tool: b.name || 'tool', input: cap(rendered, TOOL_CAP), t });
```

It **flattens tool input to a truncated JSON string inside the parser**, and drops
`tool_use_id` and `toolUseResult` entirely (zero occurrences in the file). The
richest data in the transcript never reaches the client:

- `toolUseResult.structuredPatch` — **pre-computed diff hunks** (`{oldStart,
  oldLines, newStart, newLines, lines[]}`). Edit/Write diffs need no diffing
  library at all; just render the hunks.
- `toolUseResult.oldTodos` / `newTodos` — a ready-made before/after for TodoWrite.
- `stdout` / `stderr` separated for Bash, `numFiles` / `numMatches` for Grep.

And `tool_result` blocks carry **no tool name** — only `tool_use_id`. That is *why*
upstream cannot pair a result with its call, and we inherited the same gap. The join
key is being discarded.

Therefore: **deferring the per-tool renderers is fine; deferring the data
preservation is not.** Keeping the structure costs little now. Recovering it later
means reopening the parser, the `sessions` cache table, the API payload and their
tests — all of which M5 step 2/3 already shipped and mutation-checked.

Concretely, before the Sessions tab is built:

- `readConversation` emits `input` as the **parsed object**, plus `toolUseId`, and
  emits `toolUseId` + `toolUseResult` on the `tool_result` turn.
- Truncation moves from parse time to render time, so the cap stops destroying
  structure. Caps still exist — the corpus is 122 MB — but they clamp what is *sent*
  per turn, not what is *parsed*.
- The generic renderer consumes the object and stringifies for display. Same output
  as today; the structure is simply still there when the per-tool bead is picked up.

## The carve-out that must not be lost

Inline arm-then-confirm replaces `window.confirm()` for **session delete only**.

It must **not** be extended to project activation (`public/projects.js:195`),
cleanup, uninstall, or hard pause. Those are the airlock. `projects.js:191` calls
that confirm "deliberately a `confirm()`", and activation additionally sits behind
Touch ID via `lib/approval.js`. A one-click-arm pattern that reads as lighter is
exactly wrong there — the friction is the feature. A test should pin this so a later
consistency pass cannot quietly sweep them all into the same component.

## Components

Each is independently testable and has one job:

| Unit | Responsibility | Depends on |
|---|---|---|
| `public/tooltip.js` | `data-tip` → positioned themed tooltip; one delegated listener | tokens only |
| `public/md.js` | thin wrapper: `marked` → `DOMPurify` → element; one sanitiser config | vendored libs |
| `public/transcript.js` | turn array → rendered conversation; collapse/expand; search-hit expansion; tool dispatch with generic fallback | `md.js` |
| `public/sessions.js` | tab lifecycle, cards, filters, actions | the above, `util.js` |

`public/vendor/` holds `marked.esm.js` and `purify.es.mjs` verbatim, with their
licences recorded in `LICENSES/` and `NOTICE` alongside the existing entries.

`public/style.css` gains the token block; Sessions-tab rules live alongside.

## Testing

- `tests/frontend-conventions.test.js` already fails the build if a page calls
  `fetch` directly or uses `EventSource`. Extend it: **transcript content reaches
  the DOM only via `md.js`** (so no future edit routes around the sanitiser), and
  the confirm carve-out above.
- `md.js` and the JSON highlighter are pure functions over strings — unit-testable
  without a browser. Include real injection cases: a transcript containing
  `<img onerror>`, a `javascript:` link, and a fenced block containing `</script>`.
  Per the repo's own rule, this is settled by running the attack, not by trusting
  that DOMPurify is configured correctly.
- Pin the vendored library versions in a test, so a silent swap of
  `public/vendor/*` is visible.
- Per the repo convention, every guard here is mutation-checked: break it, watch the
  test fail.
- **The tab is not done until it has been driven in Chrome over CDP** against real
  transcripts — including a session with parallel tool calls (to prove the pairing
  fix), a long `Bash` command (to prove wrapping), and a `cwdGuessed` session (M5
  `:77` — rendering that path unqualified is a lie). A passing test is not evidence
  a screen works.

## Open, deliberately

Card visual layout beyond "adopt the chip grid" is left to implementation against
the real corpus. Pinning pixel decisions in a spec before seeing our own data render
would be guessing.
