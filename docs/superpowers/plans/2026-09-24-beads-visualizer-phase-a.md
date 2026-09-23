# Beads Visualizer — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each registered project a read-only dependency-graph page in `/v2`, by serving `bd`'s own `bd graph --all --html` inside a sandboxed iframe with its CDN dependency replaced by a vendored, hash-pinned D3.

**Architecture:** `bd` already renders an interactive D3 **SVG** graph and precomputes node layers, so no layout or rendering code is written here. A new GET endpoint runs `bd graph --all --html` for one project, rewrites the one external script reference to a local vendored copy, and serves it under a restrictive CSP. A new `/v2` route embeds it in `<iframe sandbox="allow-scripts">` — no `allow-same-origin` — so the frame gets an opaque origin and can reach neither the parent DOM nor the API token.

**Tech Stack:** Node 22+, Express 5, vanilla ES modules (`/v2` has zero frontend dependencies), `node --test`, jsdom for DOM tests, vendored D3 v7 (first vendored frontend asset in this repo).

**Spec:** `docs/superpowers/specs/2026-09-24-beads-visualizer-design.md`

## Global Constraints

- **No new npm dependencies.** D3 is vendored as a file under `public/v2/assets/`, never added to `package.json`.
- **No new write path.** The only endpoint added is a GET. The UI never mutates a bead; per the owner's decision, actions are surfaced as commands to copy and run in a terminal (Phase B).
- **`system.css` / `launchbox.css` are byte-pinned to an audited spec and are NOT editable.**
- **Every test is mutation-checked:** break the production code the test covers, watch it go RED, revert. Cap every mutation run with a timeout, report HUNG separately from FAILED, restore in a `finally`, and restore by anchored replacement — never a whole-file rewrite.
- **Vendored D3 v7 SHA-256 (verbatim):** `f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539`, 279706 bytes, from `https://d3js.org/d3.v7.min.js`.
- **The external script reference emitted by `bd graph --html` (verbatim):** `https://d3js.org/d3.v7.min.js`
- **CSP served with the graph document (verbatim):** `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'`
- **Caps:** `BD_TIMEOUT_MS` (15s, already exported by `lib/beads.js`); response capped at 2 MB (`MAX_GRAPH_BYTES = 2_000_000`); graph capped at 750 nodes (Phase B — not enforced in Phase A, which serves bd's page whole or not at all).
- **D3 contains five `http://www.w3.org/...` XML namespace URIs and one `https://d3js.org` homepage string.** Any "no external origin" scan MUST allowlist `www.w3.org` or it will false-red on D3 itself.
- **Phase A deliberately does NOT deliver:** the copy-command panel, the three lenses, theme correctness, or gate visibility inside the frame. The page must SAY this on screen rather than let the gap read as an oversight.

---

## File Structure

| File | Responsibility |
|---|---|
| `public/v2/assets/d3.v7.min.js` (create) | Vendored D3 v7. Never edited. |
| `tools/qa/vendored.json` (create) | `{ "public/v2/assets/d3.v7.min.js": { "sha256": "...", "bytes": 279706, "source": "https://d3js.org/d3.v7.min.js" } }` — the pin, readable by tests and humans. |
| `lib/beads-graph.js` (create) | Pure functions: `localiseGraphHtml()`, `externalOrigins()`. No I/O, so it unit-tests without a daemon. |
| `lib/beads.js` (modify) | Add one method, `graphHtml(project)`. |
| `server.js` (modify) | Add `GET /api/v2/projects/:id/graph.html`. |
| `public/v2/pages/graph.js` (create) | The `#graph` route: chrome, limitation banner, sandboxed iframe. |
| `public/v2/main.js` (modify) | Register the route. |
| `public/v2/pages/projects.js`, `pages/project.js` (modify) | Link to the graph page. |
| `tools/qa/audit-rules.mjs` (modify) | Add the route to `V2_ROUTES`. |

---

### Task 1: Vendor D3 and pin it

**Files:**
- Create: `public/v2/assets/d3.v7.min.js`
- Create: `tools/qa/vendored.json`
- Test: `tests/vendored-assets.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: the served path `/v2/assets/d3.v7.min.js`; the manifest `tools/qa/vendored.json` with key `sha256`.

- [ ] **Step 1: Write the failing test**

```js
// tests/vendored-assets.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'tools/qa/vendored.json'), 'utf8'));

// A vendored asset is third-party code executing in the daemon's origin. The
// pin is what makes "we know exactly what this is" a checkable claim rather
// than a hope, and what would catch a swap during a careless update.
test('every vendored asset matches its recorded hash and size', () => {
  const entries = Object.entries(manifest);
  assert.ok(entries.length > 0, 'the manifest must not be empty');
  for (const [rel, want] of entries) {
    const buf = readFileSync(join(ROOT, rel));
    assert.equal(buf.length, want.bytes, `${rel}: byte length`);
    assert.equal(createHash('sha256').update(buf).digest('hex'), want.sha256, `${rel}: sha256`);
  }
});

test('a vendored asset reaches no network origin of its own', () => {
  // D3 embeds five http://www.w3.org/... XML NAMESPACE URIs (identifiers, never
  // fetched) and one https://d3js.org homepage string. Those are allowlisted by
  // host; anything else in a vendored file would be a real outbound reference.
  const ALLOWED_HOSTS = new Set(['www.w3.org', 'd3js.org']);
  for (const rel of Object.keys(manifest)) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
      assert.ok(ALLOWED_HOSTS.has(m[1]), `${rel} references ${m[1]}`);
    }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/vendored-assets.test.js`
Expected: FAIL — `ENOENT ... tools/qa/vendored.json`

- [ ] **Step 3: Fetch the asset and write the manifest**

```bash
curl -sS --max-time 60 -o public/v2/assets/d3.v7.min.js https://d3js.org/d3.v7.min.js
shasum -a 256 public/v2/assets/d3.v7.min.js   # must print f2094bbf...86539
cat > tools/qa/vendored.json <<'JSON'
{
  "public/v2/assets/d3.v7.min.js": {
    "sha256": "f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539",
    "bytes": 279706,
    "source": "https://d3js.org/d3.v7.min.js",
    "why": "bd graph --html loads D3 from a CDN. This daemon is local-only, so the reference is rewritten to this vendored copy (claude-scheduler beads-visualizer Phase A)."
  }
}
JSON
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/vendored-assets.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Mutation-check**

Flip one byte of the vendored file (e.g. append a space), re-run: expect RED on `sha256`. Restore with `curl` and re-run: expect PASS. Record both outcomes.

- [ ] **Step 6: Commit**

```bash
git add public/v2/assets/d3.v7.min.js tools/qa/vendored.json tests/vendored-assets.test.js
git commit -m "feat(graph): vendor D3 v7 with a hash pin"
```

---

### Task 2: `localiseGraphHtml()` — strip the CDN reference

**Files:**
- Create: `lib/beads-graph.js`
- Test: `tests/beads-graph.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const D3_CDN_SRC = 'https://d3js.org/d3.v7.min.js'`
  - `export const LOCAL_D3_SRC = '/v2/assets/d3.v7.min.js'`
  - `export const MAX_GRAPH_BYTES = 2_000_000`
  - `export function externalOrigins(html): string[]` — hosts referenced by `src=`/`href=` attributes.
  - `export function localiseGraphHtml(html, { maxBytes = MAX_GRAPH_BYTES } = {}): { html, rewrote: number }` — throws `Error` with `.code = 'graph_too_large'` past the cap, `.code = 'graph_external_origin'` if any external host survives.

- [ ] **Step 1: Write the failing test**

```js
// tests/beads-graph.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { localiseGraphHtml, externalOrigins, D3_CDN_SRC, LOCAL_D3_SRC } from '../lib/beads-graph.js';

const page = (src) => `<!doctype html><html><body><svg id="graph"></svg>
<script src="${src}"></script>
<script>const nodes = [{"id":"x"}];</script></body></html>`;

test('the CDN script reference is rewritten to the vendored copy', () => {
  const out = localiseGraphHtml(page(D3_CDN_SRC));
  assert.equal(out.rewrote, 1);
  assert.ok(out.html.includes(`src="${LOCAL_D3_SRC}"`));
  assert.ok(!out.html.includes('d3js.org'), 'no trace of the CDN may survive');
});

test('an external origin the rewrite does not know about is refused, not served', () => {
  // Fail closed: bd could add another CDN in a future version, and quietly
  // serving it would put third-party script in the daemon's origin.
  assert.throws(() => localiseGraphHtml(page('https://evil.example.com/x.js')),
    (e) => e.code === 'graph_external_origin');
});

test('externalOrigins reports hosts from src and href, and ignores inline content', () => {
  assert.deepEqual(externalOrigins(page(D3_CDN_SRC)), ['d3js.org']);
  assert.deepEqual(externalOrigins('<p>see https://example.com in this text</p>'), []);
});

test('an oversized page is refused rather than streamed', () => {
  const big = page(D3_CDN_SRC) + 'x'.repeat(2_000_001);
  assert.throws(() => localiseGraphHtml(big), (e) => e.code === 'graph_too_large');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/beads-graph.test.js`
Expected: FAIL — `Cannot find module '../lib/beads-graph.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// lib/beads-graph.js
// `bd graph --html` calls its own output "self-contained". It is not: the page
// loads D3 from https://d3js.org. This daemon is local-only, so that reference
// is rewritten to a vendored copy before the page is ever served, and anything
// else pointing off-box is refused rather than passed through.
export const D3_CDN_SRC = 'https://d3js.org/d3.v7.min.js';
export const LOCAL_D3_SRC = '/v2/assets/d3.v7.min.js';
export const MAX_GRAPH_BYTES = 2_000_000;

const ATTR_URL = /(?:src|href)\s*=\s*["']https?:\/\/([a-zA-Z0-9.-]+)/g;

export function externalOrigins(html) {
  const hosts = new Set();
  for (const m of String(html).matchAll(ATTR_URL)) hosts.add(m[1]);
  return [...hosts];
}

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function localiseGraphHtml(html, { maxBytes = MAX_GRAPH_BYTES } = {}) {
  const src = String(html ?? '');
  if (Buffer.byteLength(src, 'utf8') > maxBytes) {
    throw fail(`the graph page is larger than ${maxBytes} bytes`, 'graph_too_large');
  }
  const parts = src.split(D3_CDN_SRC);
  const rewrote = parts.length - 1;
  const out = parts.join(LOCAL_D3_SRC);
  const left = externalOrigins(out);
  if (left.length) {
    throw fail(`the graph page references ${left.join(', ')}`, 'graph_external_origin');
  }
  return { html: out, rewrote };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/beads-graph.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Mutation-check (three, all must go RED)**

1. Make `localiseGraphHtml` return `src` unchanged → the rewrite test goes red.
2. Delete the `left.length` throw → the `evil.example.com` test goes red.
3. Raise `maxBytes` to `Infinity` → the oversize test goes red.

Run each with a 120s cap, restore by anchored replacement in a `finally`, and report any mutation that stayed GREEN as a finding.

- [ ] **Step 6: Commit**

```bash
git add lib/beads-graph.js tests/beads-graph.test.js
git commit -m "feat(graph): localise bd's graph page and refuse unknown origins"
```

---

### Task 3: `beads.graphHtml(project)`

**Files:**
- Modify: `lib/beads.js` (add one method to the object returned by `createBeads`)
- Test: `tests/beads-graph-invoke.test.js`

**Interfaces:**
- Consumes: the existing private `call(project, args, ms)` helper inside `createBeads`.
- Produces: `beads.graphHtml(project) → Promise<string>` (raw stdout). Throws `BeadsError` with `.busy === true` when the database is locked, matching `beads.ready()`.

- [ ] **Step 1: Write the failing test**

```js
// tests/beads-graph-invoke.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBeads } from '../lib/beads.js';

function fakeExec(result) {
  const calls = [];
  const fn = (bin, args, opts, cb) => {
    calls.push({ bin, args, opts });
    queueMicrotask(() => cb(result.err ?? null, result.stdout ?? '', result.stderr ?? ''));
  };
  return { fn, calls };
}

test('graphHtml asks bd for the whole project graph as HTML', async () => {
  const { fn, calls } = fakeExec({ stdout: '<html>graph</html>' });
  const beads = createBeads({ execFileFn: fn });
  const html = await beads.graphHtml({ path: '/repo', beadsDir: '/repo/.beads' });
  assert.equal(html, '<html>graph</html>');
  assert.deepEqual(calls[0].args, ['graph', '--all', '--html']);
  // The project's own directory, never a path from the request.
  assert.equal(calls[0].opts.cwd, '/repo');
});

test('a locked database surfaces as busy, not as a broken graph', async () => {
  const err = Object.assign(new Error('x'), { code: 1 });
  const { fn } = fakeExec({ err, stderr: 'database is locked' });
  const beads = createBeads({ execFileFn: fn });
  await assert.rejects(() => beads.graphHtml({ path: '/repo' }), (e) => e.busy === true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/beads-graph-invoke.test.js`
Expected: FAIL — `beads.graphHtml is not a function`

- [ ] **Step 3: Write minimal implementation**

Add inside the object literal returned by `createBeads` in `lib/beads.js`, next to `ready()`:

```js
    // The whole project graph as bd's own interactive page. Read-only: `graph`
    // takes no lock and writes nothing. The page is NOT served as bd emits it
    // — see lib/beads-graph.js for why.
    async graphHtml(project) {
      const res = await call(project, ['graph', '--all', '--html']);
      must(res, 'graph --all --html');
      return res.stdout;
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/beads-graph-invoke.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Mutation-check (two, both RED)**

1. Change the args to `['graph', '--html']` → the args assertion goes red.
2. Replace `must(res, ...)` with `return res.stdout` unconditionally → the busy test goes red.

- [ ] **Step 6: Commit**

```bash
git add lib/beads.js tests/beads-graph-invoke.test.js
git commit -m "feat(graph): beads.graphHtml() reads a project's whole graph"
```

---

### Task 4: `GET /api/v2/projects/:id/graph.html`

**Files:**
- Modify: `server.js` (register next to the other `/api/v2/` routes; the existing `GET /api/projects/:id/ready` at ~line 1082 is the template for the project lookup and busy handling)
- Test: `tests/api-graph.test.js`

**Interfaces:**
- Consumes: `beads.graphHtml()` (Task 3), `localiseGraphHtml()` (Task 2), existing `getProject(db, id)` from `lib/db.js` and the existing `needProjects(res)` guard.
- Produces: `GET /api/v2/projects/:id/graph.html` → `200 text/html` with the CSP header; `404 {error:'not found'}`; `503 {error, busy:true}`; `502 {error}`.

- [ ] **Step 1: Write the failing test**

Follow the existing harness in `tests/api.test.js` for booting a sandboxed app with a token; reuse its helper rather than writing a new one.

```js
// tests/api-graph.test.js  (sketch — use tests/api.test.js's existing boot helper verbatim)
import test from 'node:test';
import assert from 'node:assert/strict';
import { GRAPH_CSP } from '../server.js';

test('the graph page is served with no external origin and a locked-down CSP', async (t) => {
  const { url, token, registerProject } = await bootSandbox(t);   // existing helper
  const id = await registerProject({ graphHtml: '<script src="https://d3js.org/d3.v7.min.js"></script>' });
  const res = await fetch(`${url}/api/v2/projects/${id}/graph.html`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('content-security-policy'), GRAPH_CSP);
  const body = await res.text();
  assert.ok(!body.includes('d3js.org'), 'the CDN reference must not survive');
  assert.ok(body.includes('/v2/assets/d3.v7.min.js'));
});

test('an unknown project is 404, not an empty graph', async (t) => {
  const { url, token } = await bootSandbox(t);
  const res = await fetch(`${url}/api/v2/projects/nope/graph.html`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/api-graph.test.js`
Expected: FAIL — 404 on a registered project (route not registered).

- [ ] **Step 3: Write minimal implementation**

```js
  // Phase A of the beads visualizer. bd renders the graph; this endpoint only
  // makes its page safe to serve from a local-only daemon: the CDN reference
  // becomes a vendored copy, and the CSP means that even if a bead title from
  // someone else's repo injected script, it has nowhere to send anything.
  // `connect-src 'none'` is what makes 'unsafe-inline' survivable here — the
  // page's own script is inline, so it cannot be dropped, only contained.
  app.get('/api/v2/projects/:id/graph.html', async (req, res) => {
    if (!needProjects(res)) return;
    const project = getProject(db, req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });
    try {
      const raw = await beads.graphHtml(project);
      const { html } = localiseGraphHtml(raw);
      res.set('Content-Security-Policy', GRAPH_CSP);
      res.set('X-Content-Type-Options', 'nosniff');
      res.type('html').send(html);
    } catch (err) {
      if (err?.busy) return res.status(503).json({ error: err.message, busy: true });
      res.status(502).json({ error: err?.message ?? String(err) });
    }
  });
```

Export the CSP as a named constant near the top of `server.js` so the test asserts the served value rather than a retyped copy of it:

```js
export const GRAPH_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/api-graph.test.js`
Expected: PASS.

- [ ] **Step 5: Mutation-check (three, all RED)**

1. Remove the `res.set('Content-Security-Policy', ...)` line → the CSP assertion goes red.
2. Send `raw` instead of `html` → the `d3js.org` assertion goes red.
3. Drop the `if (!project)` guard → the 404 test goes red.

- [ ] **Step 6: Commit**

```bash
git add server.js tests/api-graph.test.js
git commit -m "feat(graph): serve a project's graph under a locked-down CSP"
```

---

### Task 5: the `#graph` route

**Files:**
- Create: `public/v2/pages/graph.js`
- Modify: `public/v2/main.js` (import + `registerRoute('graph', graph)`)
- Modify: `public/v2/pages/project.js` (add a link to the graph for the current project)
- Test: `tests/frontend-v2-graph.test.js`

**Interfaces:**
- Consumes: `$`, `el`, `clear`, `pageHead` from `../ui.js`; the route handler signature is `handler(params: URLSearchParams)`, matching `pages/project.js`.
- Produces: default-exported route handler; DOM ids `#graph-frame` (the iframe) and `#graph-phase-note` (the limitation banner).

- [ ] **Step 1: Write the failing test**

```js
// tests/frontend-v2-graph.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'public/v2/pages/graph.js'), 'utf8');

// The sandbox is the whole isolation story. With allow-same-origin the frame
// would share this origin and could read the API token out of the parent —
// so this is asserted at the source, where it cannot be quietly dropped.
test('the frame is sandboxed and never same-origin', () => {
  assert.match(src, /sandbox:\s*'allow-scripts'/);
  assert.ok(!/allow-same-origin/.test(src), 'allow-same-origin would defeat the sandbox');
});

test('the page states what Phase A does not do', () => {
  // Per the spec: the missing lenses and copy-command panel must read as a
  // stated limitation, not as an oversight.
  assert.match(src, /graph-phase-note/);
  assert.match(src, /Phase A/);
});

test('bead text never reaches innerHTML on this page', () => {
  assert.ok(!/innerHTML/.test(src), 'use el()/textContent — bead titles come from other repos');
});
```

Plus one jsdom render test, following the existing pattern in `tests/frontend-v2-sessions.test.js`, asserting the iframe's `src` is `/api/v2/projects/<id>/graph.html` for `?id=<id>` and that a missing id renders an explanation rather than a blank page (the `7j2` rule).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/frontend-v2-graph.test.js`
Expected: FAIL — `ENOENT ... public/v2/pages/graph.js`

- [ ] **Step 3: Write minimal implementation**

```js
// public/v2/pages/graph.js
// Phase A of the beads visualizer. The graph itself is bd's own page
// (`bd graph --all --html`), served by /api/v2/projects/:id/graph.html with its
// CDN reference rewritten to a vendored D3 and a CSP that forbids it calling
// out. It is embedded WITHOUT allow-same-origin, so the frame has an opaque
// origin and cannot read this page's DOM or the API token.
//
// What Phase A does not do — stated on screen, not hidden: bd's hardcoded
// status colours ignore the design tokens, so there is no dark/light
// correctness; the layout is force-directed and drifts; and there is nowhere
// to put the scheduler overlay or the copy-a-command panel. Phase B replaces
// this frame with a /v2-native D3 render over the same node/link data.
import { $, el, clear, pageHead } from '../ui.js';

export default function graph(params) {
  const page = $('#v2-page');
  if (!page) return;
  clear(page);
  const id = params?.get('id') ?? null;

  page.appendChild(pageHead({ title: 'Dependency graph' }));

  if (!id) {
    page.appendChild(el('section', { class: 'card' }, el('div', { class: 'card__body' },
      el('p', { class: 't-meta' }, 'No project id in the link — open a project and choose its graph.'))));
    return;
  }

  page.appendChild(el('section', { class: 'card', id: 'graph-phase-note' },
    el('div', { class: 'card__body' }, [
      el('p', { class: 't-meta' }, 'Phase A: this is bd’s own graph page, embedded read-only. It does not follow the theme, and it has no scheduler overlay or copy-a-command panel yet.'),
    ])));

  page.appendChild(el('section', { class: 'card' }, el('div', { class: 'card__body' },
    el('iframe', {
      id: 'graph-frame',
      src: `/api/v2/projects/${encodeURIComponent(id)}/graph.html`,
      sandbox: 'allow-scripts',
      title: 'Bead dependency graph',
      style: 'width:100%;height:70vh;border:0;',
    }))));
}
```

Register it in `public/v2/main.js`:

```js
import graph from './pages/graph.js';
registerRoute('graph', graph);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/frontend-v2-graph.test.js`
Expected: PASS.

- [ ] **Step 5: Mutation-check (three, all RED)**

1. Add `allow-same-origin` to the sandbox attribute → the sandbox test goes red.
2. Delete the `graph-phase-note` section → the limitation test goes red.
3. Remove the `if (!id)` branch → the missing-id jsdom test goes red.

- [ ] **Step 6: Commit**

```bash
git add public/v2/pages/graph.js public/v2/main.js public/v2/pages/project.js tests/frontend-v2-graph.test.js
git commit -m "feat(graph): #graph route embeds the project graph in a sandboxed frame"
```

---

### Task 6: injection round-trip

**Files:**
- Test: `tests/beads-graph-injection.test.js`

**Interfaces:**
- Consumes: `localiseGraphHtml()` (Task 2), `GRAPH_CSP` (Task 4).

Bead titles come from other people's repositories. Phase A serves bd's generator output, so this repo inherits bd's escaping correctness — which is **untested**. This task measures it rather than assuming it, and pins the containment that holds either way.

- [ ] **Step 1: Write the failing test**

```js
// tests/beads-graph-injection.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { localiseGraphHtml } from '../lib/beads-graph.js';

const HOSTILE = '</script><img src=x onerror="fetch(\'https://evil.example.com\')">';

test('a hostile bead title cannot introduce an external origin', () => {
  // Whether bd escapes the title is bd's business and is recorded by the
  // sibling test below. What THIS daemon guarantees is that nothing carrying an
  // off-box reference is ever served, escaped or not.
  const page = `<script src="https://d3js.org/d3.v7.min.js"></script>
<script>const nodes = [{"id":"a","title":"${HOSTILE}"}];</script>`;
  assert.throws(() => localiseGraphHtml(page), (e) => e.code === 'graph_external_origin');
});

test('RECORD: how bd escapes a hostile title in its own output', async () => {
  // Not an assertion about bd being correct — a recorded observation, so a
  // future bd upgrade that changes it shows up as a diff rather than a surprise.
  // Uses a throwaway beads repo; skipped when `bd` is not on PATH.
  // ... create temp repo, `bd create --title HOSTILE`, run `bd graph --all --html`,
  // assert the raw output either escapes `<` or is refused by localiseGraphHtml.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/beads-graph-injection.test.js`
Expected: FAIL until Task 2 is in place; if Task 2 is already committed, the first test should PASS immediately — that is expected and is the point (the guard was designed for it). Confirm by mutating, not by assuming.

- [ ] **Step 3: Implement the recorded-observation test**

Create the temp beads repo with `bd init` run via `cwd` (NOT `bd -C <dir> init`, which fails with "no beads project found" — a known gotcha in this repo's tooling). Skip the test with a clear message when `bd` is absent.

- [ ] **Step 4: Run tests**

Run: `node --test tests/beads-graph-injection.test.js`
Expected: PASS (or SKIP for the second test where `bd` is unavailable).

- [ ] **Step 5: Mutation-check**

Delete the `graph_external_origin` throw in `lib/beads-graph.js` → this file goes red. Restore.

- [ ] **Step 6: Commit**

```bash
git add tests/beads-graph-injection.test.js
git commit -m "test(graph): a hostile bead title cannot smuggle an origin"
```

---

### Task 7: route-walk coverage

**Files:**
- Modify: `tools/qa/audit-rules.mjs` (`V2_ROUTES`)
- Modify: `tools/qa/v2-route-walk.mjs` only if the seeded ids need it (the walk already resolves `:projectId`)

**Interfaces:**
- Consumes: the `#graph` route (Task 5).
- Produces: a `graph` entry in `V2_ROUTES`.

- [ ] **Step 1: Add the route**

```js
  { name: 'project', hash: '#project?id=:projectId' },
  { name: 'graph', hash: '#graph?id=:projectId' },
```

- [ ] **Step 2: Run the walk**

Run: `npm run qa:v2`
Expected: clean, 9 routes × 2 themes.

**If `graph` reports `stranded_page`:** the check measures `#v2-page`'s text length, and an iframe's content is not part of it. The page's own chrome — heading plus the Phase A note — must carry more than `MIN_PAGE_TEXT_LEN` (60) characters of real text. It does, by design; if it does not, add to the page's own copy rather than weakening the rule. Do not special-case the route in the gate.

- [ ] **Step 3: Mutation-check**

Blank `public/v2/pages/graph.js`'s render body → `npm run qa:v2` must report `stranded_page` for `graph` in both themes and exit non-zero. Restore.

- [ ] **Step 4: Run every gate**

```bash
npm test
npm run qa:v2
npm run qa:v2:interactions   # known red on claude-scheduler-btv.17, unrelated
npm run qa:v2:parity
```

- [ ] **Step 5: Commit**

```bash
git add tools/qa/audit-rules.mjs
git commit -m "test(graph): route-walk covers the graph page"
```

---

## Self-review

**Spec coverage:** owner decisions 1 (full graph, read-only) → Tasks 3–5; 2's prohibition half → enforced by there being no write endpoint anywhere in this plan, 2's affordance half → explicitly Phase B, stated on screen in Task 5; 3 (per-project) → the `:id` route; 4 (three lenses) → Phase B, stated on screen; 5 (A now, B later) → this plan is A. Security model: CDN rewrite Task 2, CSP Task 4, sandbox Task 5, untrusted text Tasks 5–6, caps Task 2, registered-projects-only Task 4. Testing items 1–5 map to Tasks 2, 4, 5, 1, 6, 7.

**Known gap, deliberate:** the spec's 750-node cap is Phase B only — Phase A serves bd's page whole or refuses it at 2 MB, because bd composes the page and there is no node-level seam to truncate at. Recorded in Global Constraints rather than silently dropped.
