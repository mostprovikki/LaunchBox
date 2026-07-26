# Local API auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No website, LAN device, browser extension, or accidentally-exposed port can drive this
API; and the six high-power actions additionally require a Touch ID / password approval.

**Architecture:** Two independent layers. A capability token gates every `/api/*` route (Phase 1,
no native code, fully portable). A macOS `LocalAuthentication` helper gates six specific actions
(Phase 2). Live SSE log streaming is deleted rather than authenticated, because `EventSource`
cannot send headers.

**Tech Stack:** Node 22+ ESM, Express 5, better-sqlite3, `node:test`, vanilla ES-module frontend,
Swift 6 (`swiftc`, compiled at install) for Phase 2 only. **Zero new npm dependencies.**

Spec: [`docs/specs/2026-07-26-local-api-auth-design.md`](../specs/2026-07-26-local-api-auth-design.md).

## Global Constraints

- **No new npm dependencies.** The repo is dependency-light on purpose.
- **Token:** 32 random bytes as 64 hex chars, file `~/.claude-scheduler/token`, mode **`0600`**,
  compared with `timingSafeEqual`.
- **Approval timeout: 180000 ms.** Measured: a password approval took 67.6s against a 120s bound.
- **Grace window: 300000 ms (5 min)**, job create/edit/enable **only**, bound to one token.
  **No grace** for cleanup, uninstall, project activation, or `claudePath`/`bdPath`.
- **LAPolicy is `.deviceOwnerAuthentication`** (biometry OR password), never `...WithBiometrics`.
- **Helper binary filename is `LaunchBox`** — the filename is the dialog title, verified by spike.
- **Reason strings must complete the sentence "`LaunchBox` is trying to …"** and name the object
  in typographic quotes, e.g. `create the scheduled job “nightly sweep”, which can run commands on this Mac`.
- **Never post-process the helper binary.** `swiftc`'s adhoc signature is mandatory on Apple
  Silicon; stripping it causes SIGKILL (137).
- **Audit/log wording may never claim "approved by fingerprint"** — the factor is not reported.
- **Fail closed everywhere except non-macOS platforms**, where gated actions are allowed with a
  visible notice.
- **State preservation is a hard requirement:** the approval gate runs before any write, and the
  client clears form state only on 2xx.
- House test rule: **no test shells out to the real `claude`, real `bd`, or the real helper.**
- **No task except Task 13 may trigger a system approval prompt.** Automated tests inject a
  `fakeApprover`; the only real helper call permitted elsewhere is `--check`, which never prompts.
  Every human-interaction step is batched into Task 13 so the user is asked once, not repeatedly.
- `CS_APPROVAL_TIMEOUT_MS` overrides the 180s bound. Exists so Task 13's timeout checks take
  seconds; the real default is covered by an automated test with an injected clock.

## File ownership — how to parallelise safely

Three disjoint zones. **One owner per zone at a time**; never assign two agents the same zone.

| Zone | Files | Notes |
|---|---|---|
| **A — new standalone files** | `lib/token.js`, `lib/approval.js`, `public/auth.js`, `bin/claude-scheduler.mjs`, `helper/LaunchBox.swift`, `tests/token.test.js`, `tests/approval.test.js`, `tests/frontend-conventions.test.js`, `docs/spikes/localauth.sh` | Creations only. Fully parallel — no two touch the same file. |
| **B — server + its tests** | `server.js`, `tests/api.test.js`, `lib/paths.js`, `lib/install.js` | Sequential, single owner. Both Phase 1 and Phase 2 edit these. |
| **C — existing frontend** | `public/util.js`, `public/app.js`, `public/index.html`, `public/style.css` | Sequential, single owner. |

`package.json` is touched once (Task 3, `bin` field) — treat as part of Zone A for that task only.

---

# Phase 1 — token layer (no native code)

### Task 1: `lib/token.js` — generate, persist, compare

**Files:**
- Create: `lib/token.js`
- Test: `tests/token.test.js`

**Interfaces:**
- Consumes: `lib/paths.js` → `dataDir()` (existing, reads `process.env.CS_DATA` on every call).
- Produces:
  - `ensureToken(): string` — returns the hex token, creating the file `0600` if absent.
  - `readToken(): string | null` — no side effects.
  - `tokenMatches(expected: string, provided: unknown): boolean` — constant-time, length-safe.
  - `TOKEN_FILENAME = 'token'`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpData } from './helpers.js';
import { ensureToken, readToken, tokenMatches } from '../lib/token.js';

test('ensureToken creates a 64-hex 0600 token and is idempotent', () => {
  const dir = tmpData();
  assert.equal(readToken(), null, 'no token before first use');

  const t = ensureToken();
  assert.match(t, /^[0-9a-f]{64}$/);
  // 0600: readable by nobody but the owner. Asserted because a 0644 token is
  // readable by every other account on a shared machine.
  assert.equal(statSync(join(dir, 'token')).mode & 0o777, 0o600);

  assert.equal(ensureToken(), t, 'second call reuses the stored token');
  assert.equal(readToken(), t);
});

test('a whitespace-padded stored token still matches', () => {
  const dir = tmpData();
  const t = ensureToken();
  // An editor or `echo` adds a trailing newline; that must not lock the user out.
  writeFileSync(join(dir, 'token'), `${t}\n`);
  assert.equal(readToken(), t);
});

test('tokenMatches is length-safe and rejects the obvious', () => {
  const t = 'a'.repeat(64);
  assert.equal(tokenMatches(t, t), true);
  for (const bad of [null, undefined, '', 'a'.repeat(63), 'a'.repeat(65), 'b'.repeat(64), 42, {}, []]) {
    assert.equal(tokenMatches(t, bad), false, JSON.stringify(bad));
  }
  // timingSafeEqual throws on unequal lengths; tokenMatches must not.
  assert.doesNotThrow(() => tokenMatches(t, 'short'));
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/token.test.js`
Expected: FAIL — `Cannot find module '../lib/token.js'`.

- [ ] **Step 3: Implement**

```js
// The capability token. Layer 1 of docs/specs/2026-07-26-local-api-auth-design.md.
//
// Why a token at all, when the Host/Content-Type guards already stop websites:
// it holds if a header check ever regresses, it shuts out browser extensions,
// and it protects the user if the port becomes reachable by accident (container
// forward, `ssh -R`, VPN misconfig, a future remote feature).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.js';

export const TOKEN_FILENAME = 'token';
const tokenPath = () => join(dataDir(), TOKEN_FILENAME);

export function readToken() {
  const p = tokenPath();
  if (!existsSync(p)) return null;
  // Trimmed: an editor or a stray `echo` leaves a newline, and locking the user
  // out of their own scheduler over invisible whitespace would be absurd.
  const raw = readFileSync(p, 'utf8').trim();
  return raw || null;
}

export function ensureToken() {
  const existing = readToken();
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  // mode on write AND an explicit chmod: the mode argument is masked by the
  // process umask, so it alone does not guarantee 0600.
  writeFileSync(tokenPath(), `${token}\n`, { mode: 0o600 });
  chmodSync(tokenPath(), 0o600);
  return token;
}

export function tokenMatches(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  if (expected.length === 0 || expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/token.test.js` → 3 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/token.js tests/token.test.js
git commit -m "feat: capability token generation and constant-time comparison"
```

---

### Task 2: token required on every `/api/*` route

**Files:**
- Modify: `server.js` — add middleware after the existing Content-Type guard (currently ends at
  the `app.use(express.json…)` line); accept a `token` option on `createApp`.
- Modify: `tests/api.test.js` — `boot()` returns the token; `req()` sends it.

**Interfaces:**
- Consumes: `ensureToken`, `tokenMatches` from Task 1.
- Produces: `createApp({ ..., token })`; all `/api/*` return `401 {error, code:'token_invalid'}`
  without a valid `Authorization: Bearer <token>`.

⚠️ **The highest-risk step in Phase 1** is that all 324 existing tests call `req()`. Teaching
`req()` to send the header keeps them green; forgetting to means ~200 spurious failures that
look like a broken middleware.

- [ ] **Step 1: Write the failing tests** (append to `tests/api.test.js`)

```js
test('every /api route requires the token, and static assets do not', async (t) => {
  const { server, base, token } = await boot();
  t.after(() => server.close());

  // Enumerated from the source rather than hand-listed: a route added later
  // cannot silently ship unauthenticated.
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const routes = [...src.matchAll(/app\.(get|post|put|patch|delete)\('(\/api[^']*)'/g)]
    .map((m) => ({ method: m[1].toUpperCase(), path: m[2] }));
  assert.ok(routes.length >= 39, `expected the real route table, got ${routes.length}`);

  for (const r of routes) {
    // Substitute any :param with a value that will 404 *after* auth, never before.
    const path = r.path.replace(/:[A-Za-z]+/g, 'nonexistent');
    const res = await fetch(base() + path, {
      method: r.method,
      headers: { 'Content-Type': 'application/json' },
      body: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) ? '{}' : undefined,
    });
    assert.equal(res.status, 401, `${r.method} ${path} must require the token`);
    assert.equal((await res.json()).code, 'token_invalid', `${r.method} ${path} code`);
  }

  // The UI shell carries no data and must load so it can ask for the token.
  assert.equal((await fetch(base() + '/')).status, 200);
  assert.equal((await fetch(base() + '/app.js')).status, 200);
});

test('a wrong, absent, or malformed token is refused; the right one works', async (t) => {
  const { server, base, token } = await boot();
  t.after(() => server.close());
  const get = (headers) => fetch(base() + '/api/settings', { headers });

  assert.equal((await get({})).status, 401);
  assert.equal((await get({ Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await get({ Authorization: token })).status, 401, 'missing the Bearer prefix');
  assert.equal((await get({ Authorization: `Bearer ${token}x` })).status, 401);
  assert.equal((await get({ Authorization: `Bearer ${token}` })).status, 200);
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `node --test tests/api.test.js`
Expected: the two new tests FAIL (200 where 401 expected). Existing tests still pass.

- [ ] **Step 3: Add the middleware to `server.js`**

Insert immediately **after** the Content-Type guard and **before** `app.use(express.json…)`,
and add `token = null` to the `createApp` destructured options:

```js
  // Layer 1. Mounted on /api only: index.html and the ES modules carry no data
  // and must load so the page can present the token it was given.
  const expectedToken = token ?? ensureToken();
  app.use('/api', (req, res, next) => {
    const header = String(req.headers.authorization || '');
    const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!tokenMatches(expectedToken, provided)) {
      // A distinct code, not just prose: the frontend shows a persistent banner
      // for this one and must never confuse it with an approval refusal.
      return res.status(401).json({
        error: 'this session key is not valid — stop the scheduler, start it again, then reopen from the CLI',
        code: 'token_invalid',
      });
    }
    return next();
  });
```

Add the import: `import { ensureToken, tokenMatches } from './lib/token.js';`

- [ ] **Step 4: Teach the test harness the header**

In `tests/api.test.js`, `boot()` and `bootWithUsage()` must capture the token and pass it to
`createApp`, then return it; and `req()` must send it:

```js
// in boot(): before createApp
const token = ensureToken();
// ...pass `token` into createApp({ ... , token })
// ...and add `token` to the returned object.

// req() gains the header. Unconditional, exactly like the Content-Type it
// already always sends.
async function req(base, method, path, body, { token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // ...unchanged
}
```

Because `req(base(), ...)` is called ~200 times without a token argument, the simplest safe
change is a module-level `let currentToken` that `boot()` sets and `req()` reads by default.
Do that rather than editing 200 call sites.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: **all previous tests still pass**, plus the 2 new ones. If dozens fail with 401, the
harness change in Step 4 is incomplete — fix that, do not weaken the middleware.

- [ ] **Step 6: Mutation-check that the test bites**

Temporarily make `tokenMatches` in the middleware always return `true`; run `npm test`; the two
new tests must fail. Revert.

- [ ] **Step 7: Commit**

```bash
git add server.js tests/api.test.js
git commit -m "feat: require the capability token on every /api route"
```

---

### Task 3: `bin/claude-scheduler.mjs` — the only supported way in

**Files:**
- Create: `bin/claude-scheduler.mjs`
- Modify: `package.json` (add `bin`)

**Interfaces:**
- Consumes: `readToken`/`ensureToken` (Task 1), `getSetting` for the port.
- Produces: CLI `claude-scheduler open|token|url`.

Once Task 2 lands there is **no way into the UI without this**, so it is not optional.

- [ ] **Step 1: Write the CLI**

```js
#!/usr/bin/env node
// The token delivery mechanism. The token rides in the URL *fragment*: fragments
// are never sent to the server, so unlike a query string they cannot land in a
// log. The page stores it and strips it immediately.
import { execFile } from 'node:child_process';
import { ensureToken } from '../lib/token.js';
import { openDb, getSetting } from '../lib/db.js';
import { dbPath, ensureDirs } from '../lib/paths.js';

const cmd = process.argv[2] ?? 'open';
ensureDirs();
const token = ensureToken();

function port() {
  if (process.env.CS_PORT) return Number(process.env.CS_PORT);
  try {
    const db = openDb(dbPath());
    const p = Number(getSetting(db, 'port', 0)) || 9099;
    db.close();
    return p;
  } catch {
    return 9099;
  }
}

const url = `http://127.0.0.1:${port()}/#token=${token}`;

if (cmd === 'token') {
  console.log(token);
} else if (cmd === 'url') {
  console.log(url);
} else if (cmd === 'open') {
  console.log(url);
  // `open` is macOS; on other platforms print the URL and let the user click it.
  if (process.platform === 'darwin') execFile('open', [url], () => {});
  else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
  else execFile('xdg-open', [url], () => {});
} else {
  console.error('usage: claude-scheduler [open|url|token]');
  process.exit(2);
}
```

- [ ] **Step 2: Register it**

In `package.json` add:

```json
  "bin": { "claude-scheduler": "./bin/claude-scheduler.mjs" },
```

- [ ] **Step 3: Make it executable and verify by hand**

```bash
chmod +x bin/claude-scheduler.mjs
CS_DATA=$(mktemp -d) node bin/claude-scheduler.mjs url
```
Expected: a `http://127.0.0.1:9099/#token=<64 hex>` line. Run `token` and confirm the same value.

- [ ] **Step 4: Commit**

```bash
git add bin/claude-scheduler.mjs package.json
git commit -m "feat: claude-scheduler CLI for token delivery"
```

---

### Task 4: `public/auth.js` — the single front-end auth surface

**Files:**
- Create: `public/auth.js`

**Interfaces:**
- Produces:
  - `getToken(): string | null` — reads `localStorage`, first capturing `#token=` if present.
  - `authHeaders(): object`
  - `showTokenBanner(message: string): void` — persistent, not a toast.
  - `explainFailure(err): void` — maps a `code` to the right toast, and is the single place
    that wording lives.
  - `guardedSubmit(el: HTMLElement, fn: () => Promise<any>): Promise<boolean>` — returns true
    only on success; **never** clears caller state on failure; sets a busy/"waiting" state.
  - `FAILURE_COPY: Record<string, string>`

- [ ] **Step 1: Write it**

```js
// The one place the token, the failure vocabulary and the "don't lose the user's
// work" rule live. Pages do not import this directly for ordinary calls —
// util.js's api() does, so every page inherits it by doing nothing.
import { $, toast } from './util.js';

const KEY = 'cs.token';

// Delivered by `claude-scheduler open` as a URL fragment. Captured once and
// stripped, so a copied URL does not carry the key.
function captureFromFragment() {
  const m = /(?:^|[#&])token=([0-9a-f]{64})/.exec(location.hash || '');
  if (!m) return;
  localStorage.setItem(KEY, m[1]);
  history.replaceState(null, '', location.pathname + location.search);
}

export function getToken() {
  captureFromFragment();
  return localStorage.getItem(KEY);
}

export const authHeaders = () => {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
};

// Every user-visible reason lives here so two pages cannot word the same
// failure differently.
export const FAILURE_COPY = {
  token_invalid: 'This session key is no longer valid. Stop the scheduler, start it again, then reopen with: claude-scheduler open',
  approval_denied: 'You denied the approval — nothing was saved. Press Submit again to retry.',
  approval_timeout: 'The approval request timed out — nothing was saved. Press Submit again to retry.',
  approval_unavailable: 'The approval helper is unavailable, so this was refused. Reinstall to rebuild it.',
  approval_busy: 'Another approval is already waiting. Finish that one, then try again.',
};

export function showTokenBanner(message) {
  const el = $('#auth-banner');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

export function explainFailure(err) {
  const code = err?.data?.code;
  if (code === 'token_invalid') return showTokenBanner(FAILURE_COPY.token_invalid);
  const copy = FAILURE_COPY[code];
  toast(copy ?? (err?.data?.errors || [err?.data?.error || 'that failed']).join(' · '), 'err', copy ? 8000 : 3500);
}

/**
 * Wrap any mutating submit. The contract: caller state (a filled form, a
 * selection) is cleared by the CALLER and only when this resolves true. An
 * approval can be denied or time out, and retyping the whole job is not an
 * acceptable outcome — in some cases the input cannot be reconstructed at all.
 */
export async function guardedSubmit(el, fn) {
  const busyTarget = el?.querySelector?.('[type=submit], .primary') ?? el;
  const prev = busyTarget?.textContent;
  if (busyTarget) {
    busyTarget.disabled = true;
    // An approval holds the request open for up to 3 minutes; without this the
    // UI looks hung and the user clicks again.
    busyTarget.textContent = 'waiting for your approval…';
  }
  try {
    await fn();
    return true;
  } catch (err) {
    explainFailure(err);
    return false;
  } finally {
    if (busyTarget) {
      busyTarget.disabled = false;
      busyTarget.textContent = prev;
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add public/auth.js
git commit -m "feat: public/auth.js — token, failure vocabulary, guardedSubmit"
```

---

### Task 5: upgrade `api()` in place, add the banner (Zone C)

**Files:**
- Modify: `public/util.js:7-18` (`api`)
- Modify: `public/index.html` — banner element inside `<body>`, before `<main>`
- Modify: `public/style.css` — `.auth-banner`

**Interfaces:**
- Consumes: `authHeaders`, `showTokenBanner`, `FAILURE_COPY` (Task 4).
- Produces: unchanged `api(method, path, body)` signature, so **no call site changes**.

Upgrading `api()` rather than adding an opt-in module is the whole point: `app.js`,
`projects.js`, `usage.js` and `fields.js` already use it, so present and future pages inherit
the token, the banner and the codes without doing anything.

- [ ] **Step 1: Modify `api()`**

```js
import { authHeaders, showTokenBanner, FAILURE_COPY } from './auth.js';

export const api = async (method, path, body) => {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
    // Long enough for a 180s approval to resolve.
    signal: AbortSignal.timeout(200_000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    // Surfaced here, once, so no page can forget: an invalid key needs an
    // action, not a toast that vanishes in 3.5s.
    if (res.status === 401 && data?.code === 'token_invalid') showTokenBanner(FAILURE_COPY.token_invalid);
    throw Object.assign(new Error('api error'), { status: res.status, data, code: data?.code });
  }
  return data;
};
```

⚠️ `util.js` importing `auth.js` while `auth.js` imports `$`/`toast` from `util.js` is a
**cycle**. ES modules tolerate it because both are used at call time, not module-evaluation
time — but keep `auth.js` free of top-level code that calls into `util.js`.

- [ ] **Step 2: Add the banner markup** (`public/index.html`, immediately before `<main>`)

```html
    <div id="auth-banner" class="auth-banner" hidden></div>
```

- [ ] **Step 3: Style it** (`public/style.css`)

```css
/* Persistent, not a toast: it names an action the user must take. */
.auth-banner {
  background: var(--danger-bg, #3a1113);
  color: var(--danger-fg, #ffb4b4);
  border-bottom: 1px solid var(--danger, #a33);
  padding: 10px 14px;
  font-size: 12.5px;
  line-height: 1.45;
}
```

- [ ] **Step 4: Verify by hand**

```bash
CS_DATA=$(mktemp -d) CS_PORT=18990 CS_NO_NOTIFY=1 node server.js &
node bin/claude-scheduler.mjs url   # note the token
```
Open the plain `http://127.0.0.1:18990/` with **no** fragment: the page must show the banner and
no data. Then open the `#token=…` URL: data loads, and the address bar no longer shows the token.

- [ ] **Step 5: Commit**

```bash
git add public/util.js public/index.html public/style.css
git commit -m "feat: api() carries the token; persistent banner for an invalid key"
```

---

### Task 6: delete the SSE tail; log becomes a snapshot with Refresh

**Files:**
- Modify: `server.js` — delete `app.get('/api/runs/:id/tail')` (starts line 282) entirely
- Modify: `public/app.js:706-742` (`openLog`, `closeLog`) and `public/app.js:10` (`logSource`)
- Modify: `public/index.html` — Refresh button + "as of" label in the log drawer
- Modify: `tests/api.test.js:255-265` and `:354-367` — the two SSE tests

`GET /api/runs/:id/log` already exists (`server.js:276`) and returns the whole log as
`text/plain`, so **no new route is needed**.

- [ ] **Step 1: Replace the two SSE tests**

```js
test('the log route returns a snapshot of the whole log', async (t) => {
  const { spawnFn, server, base } = await boot();
  t.after(() => server.close());

  const { body: job } = await req(base(), 'POST', '/api/jobs',
    jobPayload({ type: 'command', prompt: null, command: 'echo hi' }));
  const { body: run } = await req(base(), 'POST', `/api/jobs/${job.id}/run`);
  spawnFn.calls[0].child.stdout.emit('data', Buffer.from('hello world\n'));
  spawnFn.calls[0].child.emit('close', 0);
  await sleep(30);

  const r = await req(base(), 'GET', `/api/runs/${run.id}/log`);
  assert.equal(r.status, 200);
  assert.match(r.raw, /hello world/);
});

test('the SSE tail route is gone — EventSource cannot carry the token', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());
  // Deliberately pinned: reintroducing it would create a second auth path and
  // an unauthenticated hole, since EventSource cannot set a header.
  const r = await req(base(), 'GET', '/api/runs/anything/tail');
  assert.equal(r.status, 404);
});
```

- [ ] **Step 2: Run and confirm the second fails**

Run: `node --test tests/api.test.js` — the "tail route is gone" test fails (it still exists).

- [ ] **Step 3: Delete the route from `server.js`**

Remove the whole `app.get('/api/runs/:id/tail', …)` block beginning at line 282 (through its
closing `});`, immediately before `app.post('/api/schedule/preview'…)`).

- [ ] **Step 4: Rewrite the drawer** (`public/app.js`)

Delete `let logSource = null;` (line 10) and replace `openLog`/`closeLog`:

```js
async function loadLogSnapshot(run, jobName) {
  const view = $('#log-view');
  try {
    // api() returns the parsed body, or the raw text when it is not JSON —
    // a log is text/plain, so this is the raw log.
    const text = await api('GET', `/api/runs/${run.id}/log`);
    view.textContent = typeof text === 'string' ? text : '';
    view.scrollTop = view.scrollHeight;
    $('#log-asof').textContent = `as of ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    apiErr(e, 'could not load the log');
  }
  // Progress now comes from the run row rather than a stream event.
  const p = run.progress;
  $('#log-progress').textContent = p
    ? `⚙ ${p.text ?? p.activity ?? ''}${p.turns ? ` · ${p.turns} turns` : ''}`
    : '';
  $('#log-follow').textContent = run.logPath ? `tail -f ${run.logPath}` : '';
}

function openLog(run, jobName = '') {
  logRun = run;
  $('#log-drawer').hidden = false;
  $('#log-title').textContent = `${jobName || 'run'} · ${run.status}`;
  $('#log-view').textContent = '';
  setLogKill(run);
  renderRunActions(run);
  loadLogSnapshot(run, jobName);
}

function closeLog() {
  logRun = null;
  $('#log-drawer').hidden = true;
}
```

Wire the Refresh button once, near the other listeners:

```js
$('#log-refresh').addEventListener('click', async () => {
  if (!logRun) return;
  // Re-read the run first so status, progress and actions are current too.
  try {
    const fresh = (await api('GET', '/api/runs?limit=100')).runs.find((r) => r.id === logRun.id);
    if (fresh) { logRun = fresh; setLogKill(fresh); renderRunActions(fresh); $('#log-title').textContent = `${$('#log-title').textContent.split(' · ')[0]} · ${fresh.status}`; }
  } catch { /* the snapshot below still refreshes */ }
  loadLogSnapshot(logRun, '');
});
```

- [ ] **Step 5: Add the controls** (`public/index.html`, in the log drawer header)

```html
        <span id="log-asof" class="muted small"></span>
        <button id="log-refresh" class="icon" title="Reload the log">⟳</button>
```
and near the log view, a copyable follow hint:
```html
      <code id="log-follow" class="follow-hint"></code>
```

- [ ] **Step 6: Run the suite**

Run: `npm test` → all pass, including the two rewritten tests.

- [ ] **Step 7: Commit**

```bash
git add server.js public/app.js public/index.html tests/api.test.js
git commit -m "refactor: log drawer is a snapshot with Refresh; delete the SSE tail"
```

---

### Task 7: the self-policing frontend test

**Files:**
- Create: `tests/frontend-conventions.test.js`

Must run **after** Tasks 5 and 6, since it asserts the end state.

- [ ] **Step 1: Write it**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

test('no page calls fetch() against /api directly — everything goes through api()', () => {
  // The point of this test is the NEXT page somebody adds. api() in util.js
  // carries the token, raises the invalid-key banner and normalises failure
  // codes; a raw fetch silently opts out of all three.
  const offenders = [];
  for (const f of readdirSync(PUBLIC).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(join(PUBLIC, f), 'utf8');
    for (const m of src.matchAll(/fetch\s*\(\s*[`'"]([^`'"]*)/g)) {
      // util.js and auth.js are the wrapper itself.
      if (['util.js', 'auth.js'].includes(f)) continue;
      offenders.push(`${f}: fetch('${m[1]}')`);
    }
    assert.ok(!/new EventSource/.test(src),
      `${f} uses EventSource, which cannot carry the Authorization header`);
  }
  assert.deepEqual(offenders, [], 'use api() from util.js instead of fetch()');
});

test('every page module imports from util.js rather than reimplementing helpers', () => {
  for (const f of readdirSync(PUBLIC).filter((n) => n.endsWith('.js'))) {
    if (['util.js', 'auth.js', 'icons.js', 'fields.js'].includes(f)) continue;
    const src = readFileSync(join(PUBLIC, f), 'utf8');
    if (!/\/api\//.test(src)) continue;
    assert.match(src, /from '\.\/util\.js'/, `${f} talks to the API but does not import util.js`);
  }
});
```

- [ ] **Step 2: Run it**

Run: `node --test tests/frontend-conventions.test.js` → passes.

- [ ] **Step 3: Prove it bites**

Add `fetch('/api/jobs')` to `public/projects.js` temporarily; the test must fail naming the file.
Revert.

- [ ] **Step 4: Commit**

```bash
git add tests/frontend-conventions.test.js
git commit -m "test: fail if a page bypasses api() or uses EventSource"
```

---

### Task 8: Phase 1 live verification

Not optional, and not a test run. Drive the real UI over CDP.

- [ ] Start a sandboxed daemon: `CS_DATA=$(mktemp -d) CS_PORT=18990 CS_NO_NOTIFY=1 node server.js`
- [ ] Confirm `http://127.0.0.1:18990/` with **no** token shows the banner and no data
- [ ] Confirm the `#token=…` URL loads, and the fragment is stripped from the address bar
- [ ] Create a `command` job through the real form, run it, open the log, press **Refresh**, and
      confirm new output appears and the "as of" time advances
- [ ] Re-run the original exploit and confirm it still 403/415s
- [ ] Confirm a wrong token in `localStorage` produces the banner, not a silent empty UI
- [ ] `npm test` green; `npm run screenshots` produces a new baseline
- [ ] Commit any fixes found, then update `WIP.md`

---

# Phase 2 — the approval layer (macOS)

### Task 9: the Swift helper, compiled at install

**Files:**
- Create: `helper/LaunchBox.swift` (source of truth; the spike copy is in the scratchpad)
- Create: `docs/spikes/localauth.sh` (re-runnable, outside `npm test` — needs a human finger)
- Modify: `lib/install.js` — compile step + verify

**Interfaces:**
- Produces: `~/.claude-scheduler/bin/LaunchBox`, with CLI `--check` and `--auth <reason>`;
  exit 0 = approved, exit 1 = refused (stdout JSON carries `errorCode`, `-2` = user denied),
  exit 137 = tampered binary.

- [ ] **Step 1: Add the Swift source** — the spike file verbatim, with the 120s wait raised to
      **180s** per the measurement, and `.deviceOwnerAuthentication` unchanged.
- [ ] **Step 2: Compile in `install`**: `swiftc -O -o ~/.claude-scheduler/bin/LaunchBox helper/LaunchBox.swift`
      — the filename **is** the dialog title, so it must be exactly `LaunchBox`.
- [ ] **Step 3: Verify after compiling**: run `LaunchBox --check`, require exit 0. A tampered or
      unsigned binary is SIGKILLed (137), so this doubles as tamper detection. Never `codesign`
      or otherwise post-process the output.
- [ ] **Step 4: Write `docs/spikes/localauth.sh`** asserting: `--check` exits 0; `--auth` from a
      launchd agent prompts and exits 0 on approval, 1 with `errorCode: -2` on denial.
      **Write it, do not run the interactive half** — it is executed once, in Task 13, as part of
      the single batched human session. Only `--check` (which never prompts) may be run here.
- [ ] **Step 5: Commit**

---

### Task 10: `lib/approval.js`

**Files:**
- Create: `lib/approval.js`
- Test: `tests/approval.test.js`

**Interfaces:**
- Produces: `createApproval({ spawnFn, helperPath, now, timeoutMs = 180_000, graceMs = 300_000, platform })`
  → `{ request({ action, detail, token, grace }), available(), events }`.
  `request` resolves `{ ok: true }` or `{ ok: false, code: 'approval_denied' | 'approval_timeout' | 'approval_unavailable' | 'approval_busy' }`.

- [ ] **Step 1: Write failing tests** — approve, deny (`-2`), timeout, missing helper, SIGKILL
      (137) → `approval_unavailable`, queue serialises (second call waits), full queue → busy,
      grace suppresses a second prompt **only** when `grace: true`, grace is per-token, grace
      expires after `graceMs`, non-`darwin` platform returns `{ ok: true, degraded: true }`.
- [ ] **Step 2** run them, confirm failure. **Step 3** implement. **Step 4** run green.
- [ ] **Step 5: Mutation-check** — make grace ignore the token; the per-token test must fail.
- [ ] **Step 6: Commit**

---

### Task 11: wire the gates into `server.js`

**Files:** Modify `server.js`, `tests/api.test.js`

- [ ] **Step 1: Write failing tests** with a `fakeApprover`, covering each gated action —
      `POST/PUT /api/jobs` (and enable-only via `PUT`), `PUT /api/projects/:id` to `active`,
      `permMode: auto`, **`PUT /api/settings` changing `claudePath` or `bdPath`**,
      `POST /api/cleanup`, `POST /api/uninstall` — asserting for each: approved → succeeds;
      denied → `403 approval_denied` **and nothing written**; timeout → `408 approval_timeout`
      and nothing written.
- [ ] **Step 2: Assert the NOT-gated set is not gated** — `POST /api/jobs/:id/run`, disabling a
      job, `POST /api/projects` (register), `POST /api/bursts`, other settings keys.
- [ ] **Step 3: Assert grace** applies to job edits and **never** to cleanup / uninstall /
      activation / `claudePath`.
- [ ] **Step 4: Implement** — the gate runs **before any write** in each handler.
- [ ] **Step 5: Mutation-check the ordering** — move one gate after its write; the
      "nothing written" assertion must fail.
- [ ] **Step 6: Commit**

---

### Task 12: approval UX (Zone C)

**Files:** Modify `public/app.js`, `public/projects.js`, `public/index.html`

- [ ] Adopt `guardedSubmit` for the job dialog, project activation, cleanup and uninstall
- [ ] Confirm the job form keeps its values after a denial and after a timeout
- [ ] Show a non-macOS degradation notice when the server reports it
- [ ] Commit

---

### Task 13: Human-in-the-loop verification — the ONE batched session

**Everything requiring the user's finger or password happens here and nowhere else.** Tasks 1–12
must be completable without a single system prompt: automated tests use `fakeApprover`, and the
only helper call permitted outside this task is `--check`, which never prompts.

**Why batched:** each approval is a modal system sheet. Sprinkling them through twelve tasks
would interrupt the user repeatedly and train exactly the reflexive approval the design is meant
to prevent.

**Preparation before involving the user** — all of this is set up first, so the session is a
continuous run of prompts rather than waiting on builds:

- [ ] Compile the helper and confirm `LaunchBox --check` exits 0 (no prompt)
- [ ] Boot a sandboxed daemon on a spare port with `CS_DATA=$(mktemp -d)` and a fake `claude`, so
      **no quota is spent and no real job or project is touched**
- [ ] Seed one command job and one registered-but-inactive project, so the activation and
      settings prompts have real targets
- [ ] Set `CS_APPROVAL_TIMEOUT_MS=8000` for this session only. **Rationale:** the real bound is
      180s, and asking the user to sit through a 3-minute timeout — twice — is unreasonable. The
      180s default is already covered by an automated test with a fake clock.
- [ ] Drive the UI over CDP up to the point of each prompt, then hand over

**The prompt sequence, in one sitting.** Tell the user up front exactly how many prompts to
expect and what to do with each:

| # | Action driven | User does | Expected |
|---|---|---|---|
| 1 | Create job “nightly sweep” | **Approve** | dialog title reads **LaunchBox**; sentence names the job; job is created |
| 2 | Create job “second job” | **Deny** | `403 approval_denied` toast; **form still holds every field**; no job created |
| 3 | Press Submit again on that same untouched form | **Approve** | job created from the preserved state — proves a denial costs nothing |
| 4 | Create job “third job” | **ignore it** (~8s) | `408 approval_timeout` toast; form intact; no job created |
| 5 | Edit job 1's schedule, within 5 min of #3 | *nothing* | **no prompt** — the grace window works |
| 6 | `POST /api/cleanup` in that same window | **Deny** | **does** prompt — no grace for destructive actions — and nothing is deleted |
| 7 | Activate the seeded project | **Approve** | prompts despite the grace window; project becomes `active` |
| 8 | Change `claudePath` in Settings | **Approve** | prompts — this is the bypass the spec calls out |
| 9 | Change `usagePollSec` in Settings | *nothing* | **no prompt** — ordinary settings are not gated |
| 10 | Run `docs/spikes/localauth.sh` | **Approve, then Deny** when asked | script asserts exit 0 then exit 1 with `errorCode: -2` |

- [ ] Record what actually happened against each row, including any wording that read badly
- [ ] Tear the sandbox down; confirm the user's real `~/.claude-scheduler` was never touched
- [ ] `npm test` green; `npm run screenshots` for a fresh baseline; update `WIP.md`

---

## Self-review

**Spec coverage:** threat model → Task 2/11; token file/mode/comparison → Task 1; delivery →
Task 3; localStorage rationale → Task 4; gated set incl. `claudePath`/`bdPath` → Task 11;
not-gated set → Task 11 Step 2; grace policy → Tasks 10, 11, 13; queue → Task 10; 180s → Global
Constraints + Task 9; state preservation → Tasks 4, 11, 12, 13; codes table → Task 4; core auth
module + lint → Tasks 5, 7; SSE removal → Task 6; portability → Task 10; helper/adhoc/tamper →
Task 9; audit wording → Global Constraints; testing → each task.

**Known gap, deliberate:** the spec's `GET /api/sessions/stream` removal is recorded in Task 6's
commit rationale, but M5 steps 4–5 are not yet built, so there is nothing to delete there. The
M5 plan already carries the note.

**Type consistency:** `ensureToken`/`readToken`/`tokenMatches`/`TOKEN_FILENAME` (Task 1) are used
under those names in Tasks 2 and 3. `authHeaders`/`showTokenBanner`/`FAILURE_COPY`/`guardedSubmit`
(Task 4) are used under those names in Tasks 5 and 12. `createApproval(...).request()` returning
`{ ok, code }` (Task 10) matches the codes in Task 4's `FAILURE_COPY` and Task 11's assertions.
