// Ports for the QA sandboxes (claude-scheduler-9u2, docs/plans/2026-10-02-qa-port-allocation.md).
//
// Allocated from ~/.claude/ports.json, never chosen: the primary checkout gets
// the QA slots (+10..+12); a scheduler worktree run gets parallel instance k's
// block (+50+10k), with k handed out by the daemon as CS_INSTANCE. A busy port
// is a refusal, never a reason to try the next one — and "something answered
// 200" is not "OUR sandbox answered": the old probe drove another run's server.
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';

const PORT_BASE = 43400; // lib/paths.js; restated so tools stay importable without the daemon's deps
const ROLES = { 'route-walk': 0, interactions: 1, screenshots: 2 };
const MAX_INSTANCE = 4;

/** The allocated port for `role`, in the primary checkout or worktree instance CS_INSTANCE. */
export function qaPort(role, { env = process.env, repo } = {}) {
  if (!(role in ROLES)) throw new Error(`qaPort: unknown role "${role}" (known: ${Object.keys(ROLES).join(', ')})`);
  const raw = env.CS_INSTANCE;
  if (raw === undefined) {
    // A linked worktree's .git is a file. Taking the primary slot from one is
    // exactly the collision this exists to prevent.
    if (statSync(join(repo, '.git'), { throwIfNoEntry: false })?.isFile()) {
      throw new Error('qaPort: running in a git worktree without CS_INSTANCE — the scheduler sets it per run; '
        + 'refusing to share the primary checkout\'s QA ports');
    }
    return PORT_BASE + 10 + ROLES[role];
  }
  if (!/^\d+$/.test(raw) || Number(raw) > MAX_INSTANCE) {
    throw new Error(`qaPort: CS_INSTANCE must be an integer 0-${MAX_INSTANCE}, got "${raw}"`);
  }
  return PORT_BASE + 50 + 10 * Number(raw) + ROLES[role];
}

function holderOf(port) {
  return new Promise((res) => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], (err, out) => {
      if (err || !out) return res('an unidentified process');
      const pid = /^p(\d+)/m.exec(out)?.[1];
      const cmd = /^c(.+)$/m.exec(out)?.[1];
      res(pid ? `pid ${pid} (${cmd ?? '?'})` : 'an unidentified process');
    });
  });
}

/** Rejects if anything is listening on 127.0.0.1:port, naming the holder. */
export async function assertPortFree(port) {
  const busy = await new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
  });
  if (busy) {
    throw new Error(`port ${port} is already in use by ${await holderOf(port)} — refusing to start a sandbox `
      + 'there (another QA run or worktree?). Inspect it before killing anything.');
  }
}

/**
 * Ready means: OUR child is alive, it wrote `port` into OUR sandbox's CS_DATA
 * (server.js does on 'listening'), and the port answers. Rejects at once if the
 * child exits.
 */
export async function waitForOwnSandbox({ child, dataDir, port, timeoutMs = 30_000 }) {
  let exited = null;
  const onExit = (code, sig) => { exited = sig ?? code; };
  child.once('exit', onExit);
  if (child.exitCode !== null) exited = child.exitCode;
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (exited !== null) throw new Error(`sandbox server exited (${exited}) before it was ready`);
      const own = await stat(join(dataDir, 'port')).then(
        () => readFile(join(dataDir, 'port'), 'utf8'), () => null);
      if (own && own.trim() === String(port)) {
        try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return; } catch { /* not yet */ }
      }
      if (Date.now() > deadline) {
        throw new Error(own
          ? `sandbox wrote port ${own.trim()}, expected ${port}`
          : `sandbox never wrote ${join(dataDir, 'port')} within ${timeoutMs}ms — whatever answers on ${port} is not this sandbox`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  } finally {
    child.off('exit', onExit);
  }
}
