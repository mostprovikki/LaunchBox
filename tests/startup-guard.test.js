import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './helpers.js';
import { legacyInstallBlocks } from '../lib/startup-guard.js';

const legacyInstall = (r) => { mkdirSync(join(r, 'old')); writeFileSync(join(r, 'old', 'scheduler.db'), 'db'); };
const guard = (r, current = 'new', explicit = false) => legacyInstallBlocks({ legacy: join(r, 'old'), current: join(r, current), explicit });

test('blocks start when only the legacy install exists, naming the migrate command', () => {
  const r = tmpDir(); legacyInstall(r);
  assert.match(guard(r), /launchbox migrate/);
});

// F2: `launchbox url|token|open` or install.sh created the new dir before migrate.
test('still blocks when the new dir holds only logs/ and a token (no launchbox.db)', () => {
  const r = tmpDir(); legacyInstall(r);
  mkdirSync(join(r, 'new', 'logs'), { recursive: true });
  writeFileSync(join(r, 'new', 'token'), 't');
  assert.match(guard(r), /launchbox migrate/);
  writeFileSync(join(r, 'new', 'launchbox.db'), '');
  assert.match(guard(r), /launchbox migrate/, 'a 0-byte launchbox.db is not an install');
});

test('does not block when the new install has a real DB, when no legacy DB exists, or when the data dir is explicit', () => {
  const r = tmpDir(); legacyInstall(r);
  mkdirSync(join(r, 'new')); writeFileSync(join(r, 'new', 'launchbox.db'), 'db');
  assert.equal(guard(r), null);
  const e = tmpDir(); mkdirSync(join(e, 'old'));
  assert.equal(guard(e), null, 'legacy dir without scheduler.db (e.g. the post-migrate symlink) is not an install');
  assert.equal(guard(tmpDir()), null);
  assert.equal(guard(r, 'zz', true), null, 'explicit LB_DATA is the recovery path');
});
