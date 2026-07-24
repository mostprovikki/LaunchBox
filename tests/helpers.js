import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { loadExtensions } from '../lib/extensions.js';
import { validateJob } from '../lib/validate.js';

// Real extensions (claude, command) loaded once for all tests.
export const extensions = await loadExtensions();

// Point CS_DATA at a fresh tmpdir; call before importing/using paths-dependent code.
export function tmpData() {
  const dir = mkdtempSync(join(tmpdir(), 'cs-test-'));
  process.env.CS_DATA = dir;
  process.env.CS_NO_NOTIFY = '1';
  return dir;
}

// Valid job payload (API shape — extension fields flat, they fold into params);
// cwd defaults to the tmp data dir (exists).
export function jobPayload(overrides = {}) {
  return {
    name: 'test job',
    type: 'claude',
    prompt: 'do the thing',
    cwd: process.env.CS_DATA || tmpdir(),
    schedule: { type: 'cron', expr: '0 9 * * *' },
    ...overrides,
  };
}

// Validated/normalized job (what createJob expects) — throws on invalid payload.
export function validJob(overrides = {}) {
  const r = validateJob(jobPayload(overrides), extensions);
  if (!r.ok) throw new Error('validJob: ' + r.errors.join('; '));
  return r.job;
}

// Fake child_process.spawn: records calls, exposes controllable children.
export function fakeSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // Recording stdin: children driven over a control channel (the usage probe)
    // write to it, and what they wrote is the thing worth asserting on.
    child.stdin = {
      chunks: [],
      write(c) { this.chunks.push(String(c)); return true; },
      end(c) { if (c != null) this.write(c); this.ended = true; },
      on() {}, once() {}, destroy() {},
      get written() { return this.chunks.join(''); },
    };
    child.pid = 4242;
    child.unref = () => {};
    child.kill = (sig = 'SIGTERM') => {
      child.killedWith = sig;
      child.emit('close', sig === 'SIGKILL' ? 137 : 143);
      child.emit('exit', sig === 'SIGKILL' ? 137 : 143);
    };
    calls.push({ cmd, args, opts, child });
    return child;
  };
  fn.calls = calls;
  return fn;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
