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
    // Exit codes mirror what the real CLI does, measured in the M3 spike: SIGINT
    // is handled — the process winds down and exits 0 — while SIGTERM is not,
    // giving the shell's 128+15.
    const codeFor = { SIGKILL: 137, SIGTERM: 143, SIGINT: 0 };
    // Every signal is recorded, in order, so a test can assert the ladder walked
    // the rungs it should have. `child.deaf = true` models a child that ignores
    // everything it's asked; `child.deaf = ['SIGINT']` one that ignores only some
    // — which is the interesting case for escalation.
    child.signals = [];
    const ignores = (sig) => sig !== 'SIGKILL' // nothing survives SIGKILL
      && (child.deaf === true || (Array.isArray(child.deaf) && child.deaf.includes(sig)));
    child.kill = (sig = 'SIGTERM') => {
      child.killedWith = sig;
      child.signals.push(sig);
      if (ignores(sig)) return;
      const code = codeFor[sig] ?? 143;
      child.emit('close', code);
      child.emit('exit', code);
    };
    calls.push({ cmd, args, opts, child });
    return child;
  };
  fn.calls = calls;
  return fn;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
