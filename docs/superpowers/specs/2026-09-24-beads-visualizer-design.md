# Beads dependency visualizer for /v2

**Status:** design, approved in outline 2026-09-24. Not implemented.
**Owner decisions are marked OWNER; nothing below overrides them.**

## What already exists, and what does not

A projects space is already shipped: `/v2` has a Projects tab (`btv.9`) and a project
detail page (`btv.10`) carrying ready beads, recent scheduler activity and the repo's
declared config. **This feature extends that; it does not add a new space.**

What does not exist is graph data. `lib/beads.js` only ever runs
`bd ready --json --label <autoLabel> --limit N`. `normaliseBead()` carries
`dependencyCount` and `dependentCount` — counts, never edges. The beads a graph is
*about* (blocked ones) are precisely what `bd ready` filters out.

## Owner decisions

1. **OWNER: full graph, read-only.** All beads and all dependency edges per project.
   No write path is added.
2. **OWNER: the UI never mutates a bead.** Where an action is wanted, the UI shows a
   **command to copy and run in a terminal** (e.g. `bd update <id> --priority=N`).
   This is the load-bearing security decision: it removes the entire mutation surface,
   needs no approval/Touch ID path, and leaves the activation airlock untouched.
3. **OWNER: per-project, not cross-project.** The unit is one repo's graph.
4. **OWNER: three lenses on one graph** — why a bead is not ready (blocking chains),
   the shape of the work (epics and children), and what the scheduler is about to do
   (autoLabel / claimed / handed-back).
5. **OWNER: ship A now, B later** (see Rendering).

## Do not reinvent: what bd already provides

`bd` ships its own visualizer, and it is the starting point rather than a reference.

| command | output | use |
|---|---|---|
| `bd graph --html` | interactive D3 **SVG** page, `nodes`/`links` embedded as JSON with **`layer` precomputed** | Phase A verbatim; Phase B's data contract |
| `bd graph --dot` | Graphviz DOT | rejected option C |
| `bd list --json --status=all` | every bead with typed `dependencies[]` (`blocks`, `parent-child`) and `parent` | Phase B overlay data |

Layering — the hard part — is computed by `bd`. Neither phase writes a layout algorithm.

### Defect found in `bd graph --html` (report upstream)

Its own `--help` calls the output "Self-contained interactive HTML with D3.js
visualization". **It is not self-contained:** the emitted page loads
`https://d3js.org/d3.v7.min.js`. For a local-only daemon that is both an offline break
and a third-party script executing in the app's origin. Phase A must neutralise this;
see below. Measured 2026-09-24, output 8218 bytes, one external reference.

## Rendering

### Phase A — sandboxed iframe over bd's own page (ship first)

New endpoint `GET /api/v2/projects/:id/graph.html`:

1. Runs `bd graph --all --html` for the project through the existing `lib/beads.js`
   `invoke()` — `execFile` with an args array (no shell), `BD_TIMEOUT_MS`, busy
   detection. The project path comes from the projects table, **never from the request**.
2. **Rewrites the `d3js.org` script src** to a vendored, pinned local
   `/v2/assets/d3.v7.min.js`. The vendored file's SHA-256 is recorded in the repo.
3. Serves it with `Content-Security-Policy: default-src 'none'; script-src 'self'
   'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'`.
4. The /v2 page embeds it in `<iframe sandbox="allow-scripts">` — **without**
   `allow-same-origin`, so the frame gets an opaque origin and cannot read the parent
   DOM or the API token.

`'unsafe-inline'` for scripts is a genuine weakening and is accepted **only** because
it is paired with `connect-src 'none'` and an opaque origin: injected script cannot
call out, cannot reach the parent, and cannot read the token. This is why Phase A is
temporary.

**Accepted Phase A limitations, to be stated in the UI, not hidden:** bd's hardcoded
`statusColors` ignore the design tokens, so there is no dark/light correctness; the
`qa:v2` contrast and stranded-surface gates cannot see inside an iframe; the layout is
force-directed and wobbles; and there is nowhere to put the scheduler overlay or the
copy-command panel.

Against the owner decisions, Phase A delivers **1** (full graph, read-only), **3**
(per-project) and the *prohibition* half of **2** — it mutates nothing, because it can
do nothing. It does not deliver the *affordance* half of 2 (the copy-command panel) or
any of **4** (the three lenses). Those are Phase B, and the UI should say so rather
than let the gap read as an oversight.

### Phase B — vendored D3 rendered inside /v2 (replaces A)

Reuse bd's `nodes`/`links`/`layer` JSON contract, rendered by vendored D3 in a /v2
module styled with `system.css` tokens. Delivers the remaining owner decisions: the
three lenses, the scheduler overlay (from `runs.beadOutcome`, shipped by `dc9`), the
copy-command panel, themes, and gate visibility. Bead text goes through D3 `.text()`,
so the escaping question below disappears by construction.

## Security model

- **No new write path anywhere.** The single new endpoint is a GET.
- **Field projection (Phase B).** The server sends only graph fields — `id, title,
  status, priority, type, labels, assignee, parent, edges[]` — and drops
  `description`, `notes`, `design`, `acceptance_criteria`. These are free text from
  *other people's repositories* and the graph has no use for them. `bd export`'s own
  documentation warns that memories "may contain sensitive agent context"; the same
  caution applies to descriptions.
- **Untrusted bead text.** Titles come from other repos. `/v2`'s `el()` appends
  children via `createTextNode`, so it is safe by default, but `ui.js` has an `html`
  escape hatch and several pages use `tpl.innerHTML` for static templates. **Bead text
  must never go through either.**
- **Phase A inherits bd's escaping correctness, which is untested here.** A bead title
  containing `</script>` may or may not be escaped by bd's generator. The sandbox and
  CSP contain the consequence; the behaviour must still be measured, and reported
  upstream if wrong.
- **Caps, with numbers.** Reuse `BD_TIMEOUT_MS` (15s). Cap the response at **2 MB**
  and the graph at **750 nodes**; past either, serve what fits and set an explicit
  `truncated` flag the UI must render. A silently partial graph is a lie, which this
  repo's conventions forbid. (For scale: this repo's own graph is 50 beads.) The
  numbers are a starting point to be revisited against a real large repo, not a
  measured limit — recorded here so a later reader knows which is which.
- **Registered projects only**, resolved from the projects table.

## Testing

Every test below is mutation-checked — broken deliberately and watched go red.

1. The served HTML contains **zero external origins**. Mutation: remove the rewrite →
   red. This is the gate that keeps the CDN defect from returning.
2. The CSP header and the `sandbox` attribute are present and lack
   `allow-same-origin`. Mutation: add `allow-same-origin` → red.
3. The vendored D3's SHA-256 matches the recorded value. Mutation: alter a byte → red.
4. A bead title containing `</script>` and `<img onerror>` round-trips without
   executing. Mutation: bypass the sandbox → red.
5. Route-walk entry for the new page. The stranded-page check measures `#v2-page`; an
   iframe's content is not that page's text, so the route needs real chrome around the
   frame or the check will false-red — the `9xv` lesson.

## Explicitly not doing

Cross-project graphs; any bead mutation from the UI; Graphviz WASM (option C);
a hand-rolled layout algorithm.
