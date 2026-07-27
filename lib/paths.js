import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

// claude-scheduler's allocated local-dev port block — see
// ~/.claude/docs/port-allocation.md (base 43400: server/dashboard on the base,
// 43401+ for any additional services). This is the single source of truth:
// everything that needs the default port derives it from here, so moving
// blocks is a one-line edit. `CS_PORT` still overrides it explicitly.
export const PORT_BASE = 43400;

export function defaultPort() {
  return PORT_BASE;
}

export function dataDir() {
  return process.env.CS_DATA || join(homedir(), '.claude-scheduler');
}

export function logsDir() {
  return join(dataDir(), 'logs');
}

export function dbPath() {
  return join(dataDir(), 'scheduler.db');
}

export function ensureDirs() {
  mkdirSync(logsDir(), { recursive: true });
}
