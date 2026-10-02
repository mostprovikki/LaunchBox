import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

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

export function dbPath() {
  return join(dataDir(), 'launchbox.db');
}

export function ensureDirs() {
  mkdirSync(logsDir(), { recursive: true });
}
