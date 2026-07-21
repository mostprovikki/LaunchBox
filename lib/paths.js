import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

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
