import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './helpers.js';
import { legacyInstallBlocks } from '../lib/startup-guard.js';

test('blocks start when only the legacy dir exists, naming the migrate command', () => {
  const r = tmpDir(); mkdirSync(join(r, 'old'));
  assert.match(legacyInstallBlocks({ legacy: join(r, 'old'), current: join(r, 'new'), explicit: false }), /launchbox migrate/);
});
test('does not block when the new dir exists, when none exists, or when the data dir is explicit', () => {
  const r = tmpDir(); mkdirSync(join(r, 'old')); mkdirSync(join(r, 'new'));
  assert.equal(legacyInstallBlocks({ legacy: join(r, 'old'), current: join(r, 'new'), explicit: false }), null);
  assert.equal(legacyInstallBlocks({ legacy: join(r, 'x'), current: join(r, 'y'), explicit: false }), null);
  assert.equal(legacyInstallBlocks({ legacy: join(r, 'old'), current: join(r, 'zz'), explicit: true }), null);
});
