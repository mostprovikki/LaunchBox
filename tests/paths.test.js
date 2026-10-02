import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpData } from './helpers.js';
import { homedir } from 'node:os';
import { dataDir, logsDir, dbPath, ensureDirs, env, legacyDataDir, explicitDataDir } from '../lib/paths.js';

test('paths respect CS_DATA and ensureDirs creates logs dir', () => {
  const dir = tmpData();
  assert.equal(dataDir(), dir);
  assert.equal(logsDir(), join(dir, 'logs'));
  assert.equal(dbPath(), join(dir, 'launchbox.db'));
  ensureDirs();
  assert.ok(existsSync(join(dir, 'logs')));
});

test('env() prefers LB_ and falls back to CS_', () => {
  delete process.env.LB_PROBE; process.env.CS_PROBE = 'old';
  assert.equal(env('PROBE'), 'old');
  process.env.LB_PROBE = 'new';
  assert.equal(env('PROBE'), 'new');
  process.env.LB_PROBE = '';
  assert.equal(env('PROBE'), 'old', 'empty LB_ falls through');
  process.env.CS_PROBE = '';
  assert.equal(env('PROBE'), undefined, 'empty both = unset');
  delete process.env.LB_PROBE; delete process.env.CS_PROBE;
});

test('default data dir is ~/.launchbox; the legacy dir is named for migrate', () => {
  const saved = { LB: process.env.LB_DATA, CS: process.env.CS_DATA, HOME: process.env.LB_HOME };
  delete process.env.LB_DATA; delete process.env.CS_DATA; delete process.env.LB_HOME;
  try {
    assert.equal(dataDir(), join(homedir(), '.launchbox'));
    assert.equal(legacyDataDir(), join(homedir(), '.claude-scheduler'));
    assert.equal(explicitDataDir(), false);
    process.env.LB_HOME = '/nowhere';
    assert.equal(dataDir(), join('/nowhere', '.launchbox'));
    assert.equal(legacyDataDir(), join('/nowhere', '.claude-scheduler'));
  } finally {
    if (saved.LB !== undefined) process.env.LB_DATA = saved.LB;
    if (saved.CS !== undefined) process.env.CS_DATA = saved.CS;
    if (saved.HOME !== undefined) process.env.LB_HOME = saved.HOME; else delete process.env.LB_HOME;
  }
  assert.equal(explicitDataDir(), saved.LB !== undefined || saved.CS !== undefined);
});
