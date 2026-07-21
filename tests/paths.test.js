import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpData } from './helpers.js';
import { dataDir, logsDir, dbPath, ensureDirs } from '../lib/paths.js';

test('paths respect CS_DATA and ensureDirs creates logs dir', () => {
  const dir = tmpData();
  assert.equal(dataDir(), dir);
  assert.equal(logsDir(), join(dir, 'logs'));
  assert.equal(dbPath(), join(dir, 'scheduler.db'));
  ensureDirs();
  assert.ok(existsSync(join(dir, 'logs')));
});
