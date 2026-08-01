# /v2 — frozen contract (btv.4 / A2)

This is a reference, not an essay. `public/v2/` owns its own modules — **never
import from `public/*.js`**; at cutover the old UI goes away and an import
would take /v2 with it. Copy semantics, cite the origin in a comment (every
file here does).

Frozen by this task; changing any of it requires re-opening btv.4, not a
drive-by edit in a wave-2/3 bead.

## Register a route

```js
// public/v2/pages/foo.js
import { renderPlaceholder } from './placeholder.js'; // delete once you have real content
export default function foo(params) { /* params: URLSearchParams from the `?query` half of the hash */ }
```

```js
// public/v2/main.js — one line per route, already wired for the 8 routes A2 ships:
// overview, jobs, runs, projects, project, sessions, session, settings
import foo from './pages/foo.js';
registerRoute('foo', foo);
```

- Unknown fragments fall back to `overview` (`router.js` `DEFAULT_ROUTE`) —
  never leave a route unregistered expecting a blank page; register a
  placeholder instead.
- `#token=<64hex>` is delivery, not a route — the router strips it before
  resolving. Don't special-case it in a page.
- Deep-link query params ride in `params` (a `URLSearchParams`). If your page
  needs to apply one to a `<select>`/similar whose `<option>`s don't exist
  yet, build the DOM first, THEN apply the param — writing `.value = x`
  before the option exists silently no-ops (see this repo's memory:
  history-job-filter-set-before-options-exist).

## Call the API

```js
import { api, guardedSubmit } from '../api.js';
const data = await api('GET', '/api/jobs');       // throws on failure — see below
await api('POST', '/api/jobs', { name, cwd, ... });
```

Every failure is a thrown `Error` with `{status, code, data}` (`code` is
`undefined` for a plain non-coded error). Codes you must branch on:

| `err.code` | meaning | UI must do |
|---|---|---|
| `token_invalid` | session key rejected (401) | nothing — `chrome.js` already shows the persistent banner + disables every `data-mutating` control app-wide. Don't also toast it. |
| `unreachable` | `fetch()` itself threw (daemon down) | same as above — global banner + disable, not per-page. |
| `approval_denied` / `approval_timeout` / `approval_unavailable` / `approval_busy` | the four Touch-ID/approval outcomes | per-form, via `guardedSubmit` below. Never a global banner. |
| anything else | a normal validation/conflict error | toast it (`ui.js`'s `toast`, or your own) |

For a mutating form/dialog, wrap the submit:

```js
import { guardedSubmit } from '../api.js';
import { toast } from '../ui.js';
const ok = await guardedSubmit(formEl, () => api('POST', '/api/jobs', body), toast);
if (ok) formEl.reset(); // clear the CALLER's state only on success — a denied/timed-out
                         // approval must leave the form filled; retyping a whole job is not OK.
```

## Disable a control with a reason (REVIEW #2)

Mark any control that writes state with `data-mutating` and **that is the
entire contract** — it is automatically killed under daemon-unreachable /
token-invalid. You don't call anything:

```js
el('button', { class: 'btn', 'data-mutating': true }, 'New job');
```

`main.js` owns one central sweep, subscribed twice — `onAuthState` (an
already-open page must go dead the instant the daemon drops) and
`router.js`'s `onRender` (a route opened WHILE already degraded must render
its controls disabled from the start; an auth-state-change-only sweep misses
this, since no transition happens on a plain route render). Both call the
same `disableMutatingControls(document.body, degradedReason())` over the
whole page — not just the appbar. A page never needs to subscribe, call
`setDisabledReason`, or re-check auth state itself; adding `data-mutating` is
the whole job.

The one exception is a control built and inserted *between* sweeps (e.g. a
dialog opened by user action after the page settled) — call the sweep
primitives directly for that:

```js
import { setDisabledReason, disableMutatingControls } from '../ui.js';
import { degradedReason } from '../api.js';
setDisabledReason(myButton, degradedReason());          // single control
disableMutatingControls(myDialogRoot, degradedReason()); // everything under a root
```

`degradedReason()` is the ONE place the two reason strings are defined
(`api.js`) — import it, never retype the copy; `chrome.js`'s appbar segs use
the same function.

`reason` falsy re-enables and restores whatever `data-tip` the control had
before. Never set `.disabled` directly on a mutating control — you'll lose
the reason tooltip and the restore-on-re-enable behaviour.

## Label an icon button (REVIEW #5)

Never write a bare `<button class="iconbtn">`. Always:

```js
import { iconBtn } from '../ui.js';
iconBtn({ label: 'Open log', svgHtml: '<svg ...>' , onclick: openLog });
```

`iconBtn()` throws if `label` is missing — that's the enforcement mechanism,
not a lint rule someone can ignore. `tip` defaults to `label`; pass it
explicitly only when the tooltip and the accessible name should genuinely
differ.

## Page shell helpers (`ui.js`)

- `el(tag, attrs, children)` / `esc(s)` / `clear(node)` — DOM building, same
  shape as `public/util.js`'s `esc` plus a tiny hyperscript-style builder.
- `pageHead({ title, sub, actions })` — the `.pagehead` block every route uses.
- `asOfEl(date)` / `asOfText(date)` — REVIEW #8's "as of HH:MM:SS" stamp;
  put one in a `card__head` for any card whose data can go stale under a
  degraded state (see `redesign/overview-unreachable.html`'s `.asof` spans).
- `toast(msg, kind, ms)` — minimal, theme-aware, token-based fallback (system
  CSS ships no `.toast` rule — see `ui.js`'s comment). If you need real toast
  styling, report it; don't hand-roll a second version.

## What's frozen vs. what wave 2/3 own

Frozen (this task): `api.js`, `router.js`, `ui.js`, `chrome.js`, `main.js`,
the appbar markup/class names, the banner mechanism, the 8 route names.

Wave 2/3 own: everything under `pages/*.js` except `placeholder.js` (delete
your page's placeholder import once you have real content), plus any new
`pages/*.js` a later bead needs (e.g. a dialog module) — register it in
`main.js` the same way.

## Known gaps / open questions for wave 2 (see A2 session report for detail)

- `GET /api/v2/overview` (btv.2) landed during this session (a wave-0 agent
  was editing `server.js` concurrently) — C1 can use it. `POST /api/v2/
  schedule-preview` (btv.3) had NOT landed as of this session (only the old
  `/api/schedule/preview` exists); verify before D1 depends on it.
- `chrome.js` itself only calls the pre-existing `/api/usage`, `/api/pause`,
  `/api/runs` — it does not depend on `/api/v2/overview`, so it needed no
  update when that endpoint landed mid-session.
- Pause-mode banner copy (`chrome.js` `PAUSE_BANNER`) omits the exact SIGINT
  grace-period seconds the mockups show (e.g. "90s") because the real value
  (`lib/runner.js` `softGraceMs()`) is a setting, not a constant — verify
  against live data if a page needs the exact number.
- Round-2 coordinator review (this bead) caught two contract bugs, both now
  fixed: `data-mutating` wasn't actually swept anywhere but the appbar (fixed
  by `main.js`'s central `disableMutatingControls(document.body, …)` sweep,
  triggered on both `onAuthState` and `router.js`'s `onRender`), and the two
  reason strings had no single definition (fixed by `api.js`'s
  `degradedReason()`, now the only place they're written).
