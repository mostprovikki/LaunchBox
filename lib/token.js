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
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  // Byte length, not string length: one multibyte character makes a 64-char
  // header 128 bytes, and timingSafeEqual throws on a length mismatch. Without
  // this the middleware would 500 on a crafted Authorization header instead of
  // returning a clean 401.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
