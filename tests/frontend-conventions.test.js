// Conventions the frontend must keep, enforced rather than documented.
//
// The point of every test here is the NEXT page somebody adds. `api()` in
// util.js carries the capability token, raises the persistent banner for an
// invalid key, and normalises approval failure codes into copy — and a page that
// reaches for raw `fetch` silently opts out of all three. That is not the kind of
// mistake a reviewer reliably catches, so it fails the suite instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const pages = () => readdirSync(PUBLIC).filter((n) => n.endsWith('.js'));
const read = (f) => readFileSync(join(PUBLIC, f), 'utf8');

// util.js IS the wrapper; auth.js is the token/banner implementation behind it.
const WRAPPER_FILES = ['util.js', 'auth.js'];

test('no page calls fetch() directly — everything goes through api()', () => {
  const offenders = [];
  for (const f of pages()) {
    if (WRAPPER_FILES.includes(f)) continue;
    for (const m of read(f).matchAll(/\bfetch\s*\(/g)) {
      const line = read(f).slice(0, m.index).split('\n').length;
      offenders.push(`${f}:${line}`);
    }
  }
  assert.deepEqual(offenders, [],
    'use api() from util.js — a raw fetch skips the token, the 401 banner and the approval codes');
});

test('no page uses EventSource, which cannot carry the Authorization header', () => {
  // Deliberately pinned. The live log tail was removed for exactly this reason:
  // `new EventSource(url)` is the entire API, so a stream endpoint would need
  // either a second auth path or the token in a URL.
  for (const f of pages()) {
    assert.ok(!/\bnew\s+EventSource\b/.test(read(f)),
      `${f} uses EventSource; the log drawer is a snapshot with Refresh instead`);
  }
});

test('a page that talks to the API imports util.js rather than reimplementing it', () => {
  for (const f of pages()) {
    if (WRAPPER_FILES.includes(f)) continue;
    const src = read(f);
    if (!/['"`]\/api\//.test(src)) continue;
    assert.match(src, /from\s+'\.\/util\.js'/,
      `${f} references /api/ but does not import util.js`);
  }
});

test('api() attaches the token and surfaces the invalid-key banner', () => {
  // Asserted against the source because there is no DOM here. These two lines
  // are the whole reason every other page can stay ignorant of auth, so losing
  // either of them silently would be the worst possible regression.
  const util = read('util.js');
  assert.match(util, /authHeaders\(\)/, 'api() must spread authHeaders() into its request');
  assert.match(util, /token_invalid/, 'api() must recognise the invalid-key code');
  assert.match(util, /from '\.\/auth\.js'/, 'util.js must import the auth module');
});

test('vendored ESM imports nothing it did not bring with it', () => {
  // jsDelivr /+esm and esm.sh rewrite bare specifiers into origin-absolute
  // imports ("/npm/pkg@1.2.3/+esm"). Such a file works while served from the
  // CDN and breaks the moment it is vendored — and offline is the entire point
  // of vendoring in a local-only daemon. So: no https://, no origin-absolute
  // path, no bare specifier. Relative imports are fine; they ship alongside.
  const VENDOR = join(PUBLIC, 'vendor');
  let files;
  try {
    files = readdirSync(VENDOR, { recursive: true });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return; // nothing vendored yet
  }
  const offenders = [];
  for (const f of files.filter((n) => /\.m?js$/.test(n))) {
    const src = readFileSync(join(VENDOR, f), 'utf8');
    const specifiers = [
      ...src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
      ...src.matchAll(/\bimport\s*\(?\s*['"]([^'"]+)['"]/g),
    ].map((m) => m[1]);
    for (const s of specifiers) {
      if (!s.startsWith('./') && !s.startsWith('../')) offenders.push(`vendor/${f}: "${s}"`);
    }
  }
  assert.deepEqual(offenders, [],
    'vendor only single-file builds, or ones whose imports are relative paths shipped with them');
});

test('vendored library versions are pinned, so a silent swap is visible', () => {
  // docs/specs/2026-07-27-sessions-tab-visual-design.md: marked 18.0.7 (MIT)
  // and DOMPurify 3.4.12 (MPL-2.0/Apache-2.0) were the versions vetted as
  // genuinely single-file, zero-bare-specifier browser-ESM builds. A `npm
  // update` that silently replaces the vendored file with a different
  // version has skipped that check entirely — this only catches it if the
  // version string the library embeds in its own banner/API changes too.
  const marked = readFileSync(join(PUBLIC, 'vendor', 'marked.esm.js'), 'utf8');
  assert.match(marked, /marked v18\.0\.7/, 'public/vendor/marked.esm.js is not pinned to 18.0.7');
  const purify = readFileSync(join(PUBLIC, 'vendor', 'purify.es.mjs'), 'utf8');
  assert.match(purify, /['"]3\.4\.12['"]/, 'public/vendor/purify.es.mjs is not pinned to 3.4.12');
});

test('transcript prose (prompts and assistant replies) reaches the DOM only via md.js', () => {
  // The sanitiser in md.js is the whole safety story for the Sessions tab's
  // transcript viewer (docs/specs/2026-07-27-sessions-tab-visual-design.md:
  // "only ever assign textContent" is a discipline a later edit breaks
  // silently, whereas a sanitiser enforced at the call site is not). This
  // pins that transcript.js never takes a shortcut around it for turn prose.
  const transcript = read('transcript.js');
  assert.match(transcript, /from '\.\/md\.js'/, 'transcript.js must render prose through md.js');

  // Every user/assistant turn's `.text` is rendered through one function
  // (`proseEl`), and that function's own body must call renderMarkdown() —
  // checked directly against its source rather than by a repo-wide grep, so
  // a regression that keeps `renderMarkdown(` somewhere else in the file
  // (e.g. in a comment, or on an unrelated line) can't hide a bypass here.
  const proseElBody = transcript.match(/function proseEl\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(proseElBody, 'transcript.js must define a single proseEl(cls, text) renderer for turn prose');
  assert.match(proseElBody, /el\.innerHTML\s*=\s*renderMarkdown\(text\)/,
    'proseEl must set innerHTML via renderMarkdown(text) — a plain assignment (`el.innerHTML = text`) would bypass the sanitiser entirely');

  // And the two prose turn renderers must actually route through it, rather
  // than building their own HTML for `.text`.
  const userFn = transcript.match(/function renderUserTurn\([\s\S]*?\n\}/)?.[0] ?? '';
  const assistantFn = transcript.match(/function renderAssistantTurn\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(userFn, /proseEl\(/, 'renderUserTurn must render turn.text via proseEl()');
  assert.match(assistantFn, /proseEl\(/, 'renderAssistantTurn must render turn.text via proseEl()');
});

test('the session-delete arm-then-confirm carve-out does not spread to the activation/cleanup/uninstall/hard-pause airlock', () => {
  // docs/specs/2026-07-27-sessions-tab-visual-design.md's carve-out: inline
  // arm-then-confirm replaces window.confirm() for SESSION DELETE ONLY. A
  // later "consistency pass" swapping every confirm() for the lighter
  // inline pattern would silently remove the one deliberate friction point
  // in the whole app — project activation is gated behind Touch ID
  // specifically because a single click must not be enough.
  const projects = read('projects.js');
  // confirmActivate, cleanup and uninstall must still use the real, blocking
  // window.confirm() — not an inline arm-then-confirm widget.
  assert.match(projects, /function confirmActivate\(p\)\s*\{\s*[\s\S]*?\bconfirm\(/,
    'projects.js must still gate activation behind window.confirm()');
  assert.match(read('projects.js'), /deleteProject[\s\S]*?\bconfirm\(/,
    'projects.js must still gate project removal behind window.confirm()');
  // Cleanup and uninstall use a different, deliberately heavier gate — a
  // literal type-to-confirm text match, not window.confirm() — which the
  // inline arm-then-confirm pattern must not casually replace either.
  const app = read('app.js');
  assert.match(app, /cleanup-confirm['"]\)\.value\s*!==\s*'cleanup'/,
    "app.js's cleanup action must still require typing \"cleanup\" to confirm");
  assert.match(app, /uninstall-confirm['"]\)\.value\s*!==\s*'uninstall'/,
    "app.js's uninstall action must still require typing \"uninstall\" to confirm");
  assert.match(app, /mode === 'hard'\)\s*\{[\s\S]{0,200}?\bconfirm\(/,
    "app.js's hard-pause switch must still be gated behind window.confirm()");
  // And the inverse: sessions.js's inline arm-then-confirm must not itself
  // call window.confirm() for delete — that would defeat the point of
  // building it, and a stray confirm() there would be a sign the two
  // patterns got mixed up.
  const sessions = read('sessions.js');
  assert.match(sessions, /armedDelete/, 'sessions.js must use the inline arm-then-confirm set for delete');
  // Real code only — strip `//` line comments first, since the module's own
  // doc-comments legitimately name `window.confirm()` when explaining what
  // this carve-out replaces.
  const sessionsCode = sessions.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.doesNotMatch(sessionsCode, /confirm\(/,
    'sessions.js must not use window.confirm() — session delete is the inline arm-then-confirm carve-out');
});

test('the approval failure vocabulary matches the server exactly', () => {
  // public/auth.js turns a code into a sentence; lib/approval.js decides which
  // codes exist. A code with no copy reaches the user as a bare identifier, and
  // copy for a code that cannot happen is dead text — so the two must agree.
  const auth = read('auth.js');
  const approval = readFileSync(join(PUBLIC, '..', 'lib', 'approval.js'), 'utf8');

  const declared = [...approval.matchAll(/'(approval_[a-z_]+)'/g)].map((m) => m[1]);
  const codes = [...new Set(declared)].sort();
  assert.ok(codes.length >= 4, `expected the real code list, got ${codes.join(', ')}`);

  for (const code of codes) {
    assert.match(auth, new RegExp(`${code}\\s*:`), `public/auth.js has no copy for ${code}`);
  }
  // And the reverse direction: no orphan copy.
  const copy = [...auth.matchAll(/^\s{2}(approval_[a-z_]+):/gm)].map((m) => m[1]);
  for (const c of copy) {
    assert.ok(codes.includes(c), `public/auth.js has copy for ${c}, which lib/approval.js never produces`);
  }
});
