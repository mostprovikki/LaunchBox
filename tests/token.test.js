import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
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
  // Same character count, twice the bytes — the case that reaches timingSafeEqual
  // and would throw a 500 out of the middleware rather than returning 401.
  assert.doesNotThrow(() => tokenMatches(t, 'é'.repeat(64)));
  assert.equal(tokenMatches(t, 'é'.repeat(64)), false);
});
