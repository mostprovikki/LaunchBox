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

// Fake `child_process.execFile` standing in for the `bd` binary. No test may
// shell out to the real thing — same rule as "no test spawns the real claude" —
// so every measured bd behaviour is reproduced here instead.
//
// `handlers` is keyed by subcommand (`ready`, `close`, `where`, `update`,
// `--version`), with a `default` fallback. A handler is either a reply object or
// a function of `{args, opts, calls}` returning one:
//
//   { stdout, stderr, code }   code defaults to 0 (success)
//   { timeout: true }          the contention case: node kills the child, so the
//                              error carries killed/signal and no exit code
//   { spawnError: 'ENOENT' }   binary missing — a string `code`, not a number
export function fakeBd(handlers = {}) {
  const calls = [];
  const fn = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts, env: opts?.env ?? {}, sub: args[0] });
    const h = handlers[args[0]] ?? handlers.default ?? { stdout: '' };
    const reply = typeof h === 'function' ? h({ args, opts, calls }) : h;
    const stdout = reply.stdout ?? '';
    const stderr = reply.stderr ?? '';
    process.nextTick(() => {
      if (reply.timeout) {
        // What node reports when `options.timeout` fires: the child was killed,
        // so there is a signal and no useful exit status.
        const err = new Error('spawnSync ETIMEDOUT');
        err.killed = true;
        err.signal = 'SIGTERM';
        err.code = null;
        cb(err, stdout, stderr);
        return;
      }
      if (reply.spawnError) {
        const err = new Error(`spawn ${reply.spawnError}`);
        err.code = reply.spawnError; // string code = spawn failure
        cb(err, '', '');
        return;
      }
      const code = reply.code ?? 0;
      if (code !== 0) {
        const err = new Error(`Command failed: bd ${args.join(' ')}`);
        err.code = code; // number code = exit status
        cb(err, stdout, stderr);
        return;
      }
      cb(null, stdout, stderr);
    });
    return { on() {} };
  };
  fn.calls = calls;
  return fn;
}

// A `bd ready --json` row in bd 1.1.0's real shape: snake_case, `issue_type`
// rather than `type`, and — unless labels are given — NO `labels` key at all.
export function bdReadyRow(overrides = {}) {
  const { labels, ...rest } = overrides;
  const row = {
    id: 'sp-abc',
    title: 'a ready bead',
    status: 'open',
    priority: 2,
    issue_type: 'task',
    created_at: '2026-07-25T00:00:00Z',
    updated_at: '2026-07-25T00:00:00Z',
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
    ...rest,
  };
  // Deliberately omit the key when there are no labels — the measured trap.
  if (labels !== undefined) row.labels = labels;
  return row;
}
