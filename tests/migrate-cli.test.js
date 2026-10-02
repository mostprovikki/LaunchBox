// Drives the real bin against a fixture via LB_HOME
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fixtureInstall } from './helpers.js';

const BIN = new URL('../bin/launchbox.mjs', import.meta.url).pathname;
const cli = (args, home) => execFileSync(process.execPath, [BIN, 'migrate', ...args], {
  env: { ...process.env, LB_HOME: home, LB_DATA: '', CS_DATA: '', LB_PORT: '43408' }, encoding: 'utf8' });

test('--dry-run reports and writes nothing', () => {
  const { root, newDir } = fixtureInstall();
  const out = cli(['--dry-run'], root);
  assert.match(out, /runs\.logPath\s+1/);
  assert.equal(existsSync(newDir), false);
});
test('migrate moves the fixture install', () => {
  const { root, newDir } = fixtureInstall();
  assert.match(cli([], root), /migrated/);
  assert.ok(existsSync(`${newDir}/launchbox.db`));
});
