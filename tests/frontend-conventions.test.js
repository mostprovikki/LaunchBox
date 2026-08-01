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
