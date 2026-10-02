import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, statSync } from 'node:fs';

// LaunchBox's allocated local-dev port block — see
// ~/.claude/docs/port-allocation.md (base 43400: server/dashboard on the base,
// 43401+ for any additional services). This is the single source of truth:
// everything that needs the default port derives it from here, so moving
// blocks is a one-line edit. `LB_PORT` still overrides it explicitly.
export const PORT_BASE = 43400;

export function defaultPort() {
  return PORT_BASE;
}

// LB_* is the name; CS_* (the legacy claude-scheduler names) still works so
// existing shells, scripts and the test helpers keep running across the M6
// rename. An empty string counts as unset, so `LB_DATA=` in a test env cannot
// shadow anything.
export function env(name) {
  return process.env[`LB_${name}`] || process.env[`CS_${name}`] || undefined;
}

export function explicitDataDir() {
  return env('DATA') !== undefined;
}

// LB_HOME is a test seam (tests/migrate-cli.test.js); never set in production.
const home = () => process.env.LB_HOME || homedir();

export function dataDir() {
  return env('DATA') || join(home(), '.launchbox');
}

// Where installs before M6 kept everything (legacy). Read only by migrate and
// the startup guard.
export function legacyDataDir() {
  return join(home(), '.claude-scheduler');
}

export function logsDir() {
  return join(dataDir(), 'logs');
}

// A dir in the pre-M6 layout (scheduler.db, no real launchbox.db) opened with an
// explicit LB_DATA is the recovery path for an install migrate refuses: booting
// it fails orphaned runs and hands back their leases. A 0-byte launchbox.db
// there is the known stray, not data.
export function dbPath() {
  const dir = dataDir();
  const current = join(dir, 'launchbox.db');
  const legacy = join(dir, 'scheduler.db');
  if (!nonEmptyFile(current) && existsSync(legacy)) return legacy;
  return current;
}

export function nonEmptyFile(p) {
  try { return statSync(p).size > 0; } catch { return false; }
}

export function ensureDirs() {
  mkdirSync(logsDir(), { recursive: true });
}
