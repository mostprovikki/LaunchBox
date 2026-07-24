import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

// Core job columns are type-agnostic; extension-specific fields live in
// `params` (JSON). Run `meta` (JSON) holds extension output-handler data
// (e.g. claude sessionId) that drives runActions.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'command',
  params TEXT NOT NULL DEFAULT '{}',
  cwd TEXT NOT NULL,
  schedule TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  timeoutMin INTEGER NOT NULL DEFAULT 60,
  retryCount INTEGER NOT NULL DEFAULT 0,
  retryDelayMin INTEGER NOT NULL DEFAULT 5,
  notify TEXT NOT NULL DEFAULT 'failure',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  jobId TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  startedAt TEXT,
  finishedAt TEXT,
  exitCode INTEGER,
  durationMs INTEGER,
  logPath TEXT,
  meta TEXT,
  progress TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(jobId, createdAt);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capturedAt TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  available INTEGER NOT NULL DEFAULT 0,
  subscriptionType TEXT,
  windows TEXT NOT NULL DEFAULT '{}',
  buckets TEXT NOT NULL DEFAULT '[]',
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_captured ON usage_snapshots(capturedAt);
CREATE TABLE IF NOT EXISTS run_usage (
  runId TEXT PRIMARY KEY,
  jobId TEXT NOT NULL,
  beforePct TEXT,
  afterPct TEXT,
  deltaPct TEXT,
  sampledAt TEXT NOT NULL
);
`;

const JOB_COLS = [
  'name', 'type', 'params', 'cwd', 'schedule', 'enabled',
  'timeoutMin', 'retryCount', 'retryDelayMin', 'notify',
];
const RUN_COLS = [
  'status', 'startedAt', 'finishedAt', 'exitCode', 'durationMs', 'logPath',
  'meta', 'progress',
];

// v1 dbs stored claude/command fields as flat columns; fold them into params
// (and runs.sessionId into meta). Legacy columns are left in place — harmless.
function migrate(db) {
  const jcols = db.pragma('table_info(jobs)').map((c) => c.name);
  if (jcols.length && !jcols.includes('params')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN params TEXT NOT NULL DEFAULT '{}'`);
    const upd = db.prepare('UPDATE jobs SET params = ? WHERE id = ?');
    for (const row of db.prepare('SELECT * FROM jobs').all()) {
      const p = row.type === 'claude'
        ? { prompt: row.prompt, model: row.model, permMode: row.permMode, extraArgs: row.extraArgs }
        : { command: row.command };
      upd.run(JSON.stringify(p), row.id);
    }
  }
  const rcols = db.pragma('table_info(runs)').map((c) => c.name);
  if (rcols.length && !rcols.includes('meta')) {
    db.exec('ALTER TABLE runs ADD COLUMN meta TEXT');
    if (rcols.includes('sessionId')) {
      db.exec(`UPDATE runs SET meta = json_object('sessionId', sessionId) WHERE sessionId IS NOT NULL`);
    }
  }
}

export function openDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  migrate(db);
  db.exec(SCHEMA);
  return db;
}

function now() {
  return new Date().toISOString();
}

function jobToRow(job) {
  const row = { ...job };
  if ('schedule' in row) row.schedule = JSON.stringify(row.schedule);
  if ('params' in row) row.params = JSON.stringify(row.params ?? {});
  if ('enabled' in row) row.enabled = row.enabled ? 1 : 0;
  return row;
}

function rowToJob(row) {
  if (!row) return null;
  return { ...row, schedule: JSON.parse(row.schedule), params: JSON.parse(row.params || '{}'), enabled: !!row.enabled };
}

function rowToRun(row) {
  if (!row) return null;
  return {
    ...row,
    progress: row.progress ? JSON.parse(row.progress) : null,
    meta: row.meta ? JSON.parse(row.meta) : null,
  };
}

const JOB_DEFAULTS = {
  type: 'command', params: '{}', enabled: 1, timeoutMin: 60, retryCount: 0,
  retryDelayMin: 5, notify: 'failure',
};

export function createJob(db, job) {
  const id = randomUUID();
  const ts = now();
  const row = { ...JOB_DEFAULTS, ...jobToRow(job) };
  db.prepare(`INSERT INTO jobs (id, ${JOB_COLS.join(', ')}, createdAt, updatedAt)
    VALUES (@id, ${JOB_COLS.map((c) => '@' + c).join(', ')}, @createdAt, @updatedAt)`)
    .run({ id, createdAt: ts, updatedAt: ts, ...Object.fromEntries(JOB_COLS.map((c) => [c, row[c] ?? null])) });
  return getJob(db, id);
}

export function listJobs(db) {
  return db.prepare('SELECT * FROM jobs ORDER BY createdAt').all().map(rowToJob);
}

export function getJob(db, id) {
  return rowToJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
}

export function updateJob(db, id, patch) {
  const row = jobToRow(patch);
  const cols = JOB_COLS.filter((c) => c in row);
  if (cols.length) {
    db.prepare(`UPDATE jobs SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updatedAt = @updatedAt WHERE id = @id`)
      .run({ id, updatedAt: now(), ...Object.fromEntries(cols.map((c) => [c, row[c]])) });
  }
  return getJob(db, id);
}

// Deletes job + its runs; returns logPaths of deleted runs for the caller to unlink.
export function deleteJob(db, id) {
  const paths = db.prepare('SELECT logPath FROM runs WHERE jobId = ? AND logPath IS NOT NULL').all(id).map((r) => r.logPath);
  db.prepare('DELETE FROM runs WHERE jobId = ?').run(id);
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  return paths;
}

export function insertRun(db, { jobId, status, trigger }) {
  const id = randomUUID();
  db.prepare('INSERT INTO runs (id, jobId, status, trigger, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run(id, jobId, status, trigger, now());
  return getRun(db, id);
}

export function updateRun(db, id, patch) {
  const cols = RUN_COLS.filter((c) => c in patch);
  if (cols.length) {
    db.prepare(`UPDATE runs SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`)
      .run({ id, ...Object.fromEntries(cols.map((c) => [c, patch[c]])) });
  }
  return getRun(db, id);
}

export function getRun(db, id) {
  return rowToRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(id));
}

export function listRuns(db, { jobId, status, limit = 100 } = {}) {
  const where = [];
  const params = { limit };
  if (jobId) { where.push('jobId = @jobId'); params.jobId = jobId; }
  if (status) { where.push('status = @status'); params.status = status; }
  const sql = `SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY createdAt DESC LIMIT @limit`;
  return db.prepare(sql).all(params).map(rowToRun);
}

export function lastRun(db, jobId) {
  return rowToRun(db.prepare('SELECT * FROM runs WHERE jobId = ? ORDER BY createdAt DESC LIMIT 1').get(jobId));
}

// Keep newest `keep` runs per job; only finished runs are pruned. Returns removed logPaths.
export function pruneRuns(db, jobId, keep = 50) {
  const stale = db.prepare(`
    SELECT id, logPath FROM runs
    WHERE jobId = ? AND status NOT IN ('running', 'queued')
      AND id NOT IN (SELECT id FROM runs WHERE jobId = ? ORDER BY createdAt DESC LIMIT ?)
  `).all(jobId, jobId, keep);
  const del = db.prepare('DELETE FROM runs WHERE id = ?');
  for (const r of stale) del.run(r.id);
  return stale.map((r) => r.logPath).filter(Boolean);
}

// Mark runs orphaned by a daemon crash as failed. Call at boot.
export function failOrphanRuns(db) {
  return db.prepare(`UPDATE runs SET status = 'fail', finishedAt = ? WHERE status IN ('running', 'queued')`)
    .run(now()).changes;
}

export function getSetting(db, key, dflt = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : dflt;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

// --- usage ---------------------------------------------------------------
// Snapshots are an append-only log of what `get_usage` reported, failures
// included: a gap in the series is itself the signal that monitoring broke.
// Only the flattened fields are stored — the raw payload is experimental and
// too large to keep 2000 of.

function rowToSnapshot(row) {
  if (!row) return null;
  return {
    ...row,
    ok: !!row.ok,
    available: !!row.available,
    windows: JSON.parse(row.windows || '{}'),
    buckets: JSON.parse(row.buckets || '[]'),
  };
}

export function insertUsageSnapshot(db, snap) {
  const info = db.prepare(`INSERT INTO usage_snapshots
      (capturedAt, ok, available, subscriptionType, windows, buckets, error)
    VALUES (@capturedAt, @ok, @available, @subscriptionType, @windows, @buckets, @error)`)
    .run({
      capturedAt: snap.capturedAt ?? now(),
      ok: snap.ok ? 1 : 0,
      available: snap.available ? 1 : 0,
      subscriptionType: snap.subscriptionType ?? null,
      windows: JSON.stringify(snap.windows ?? {}),
      buckets: JSON.stringify(snap.buckets ?? []),
      error: snap.error ?? null,
    });
  return rowToSnapshot(db.prepare('SELECT * FROM usage_snapshots WHERE id = ?').get(info.lastInsertRowid));
}

// Newest first. `okOnly` skips failed probes — what the sparkline wants.
export function listUsageSnapshots(db, { limit = 100, okOnly = false } = {}) {
  const sql = `SELECT * FROM usage_snapshots ${okOnly ? 'WHERE ok = 1' : ''} ORDER BY id DESC LIMIT @limit`;
  return db.prepare(sql).all({ limit }).map(rowToSnapshot);
}

export function latestUsageSnapshot(db, { okOnly = false } = {}) {
  return listUsageSnapshots(db, { limit: 1, okOnly })[0] ?? null;
}

// Ordered by id, not capturedAt: two probes in the same millisecond would tie.
export function pruneUsageSnapshots(db, keep = 2000) {
  return db.prepare(`DELETE FROM usage_snapshots WHERE id NOT IN
    (SELECT id FROM usage_snapshots ORDER BY id DESC LIMIT ?)`).run(keep).changes;
}

// Per-run calibration: the API reports percent, not tokens, so what a job costs
// has to be learned by sampling before/after. Deltas are noisy (concurrent runs,
// interactive use, other devices) — store raw, aggregate later.
export function recordRunUsage(db, { runId, jobId, beforePct, afterPct }) {
  const delta = {};
  for (const w of Object.keys(afterPct ?? {})) {
    if (typeof afterPct[w] === 'number' && typeof beforePct?.[w] === 'number') {
      delta[w] = Number((afterPct[w] - beforePct[w]).toFixed(4));
    }
  }
  db.prepare(`INSERT INTO run_usage (runId, jobId, beforePct, afterPct, deltaPct, sampledAt)
      VALUES (@runId, @jobId, @beforePct, @afterPct, @deltaPct, @sampledAt)
    ON CONFLICT(runId) DO UPDATE SET
      afterPct = excluded.afterPct, deltaPct = excluded.deltaPct, sampledAt = excluded.sampledAt`)
    .run({
      runId, jobId,
      beforePct: JSON.stringify(beforePct ?? {}),
      afterPct: JSON.stringify(afterPct ?? {}),
      deltaPct: JSON.stringify(delta),
      sampledAt: now(),
    });
  return getRunUsage(db, runId);
}

export function getRunUsage(db, runId) {
  const row = db.prepare('SELECT * FROM run_usage WHERE runId = ?').get(runId);
  if (!row) return null;
  return {
    ...row,
    beforePct: JSON.parse(row.beforePct || '{}'),
    afterPct: JSON.parse(row.afterPct || '{}'),
    deltaPct: JSON.parse(row.deltaPct || '{}'),
  };
}

// Per-window central tendency of a job's observed cost, plus the sample count so
// callers can weigh it. Median, not mean: one delta polluted by a concurrent run
// or another device would otherwise dominate a small sample.
export function avgDeltaForJob(db, jobId) {
  const rows = db.prepare('SELECT deltaPct FROM run_usage WHERE jobId = ?').all(jobId);
  const byWindow = {};
  for (const r of rows) {
    for (const [w, v] of Object.entries(JSON.parse(r.deltaPct || '{}'))) {
      if (typeof v === 'number') (byWindow[w] ??= []).push(v);
    }
  }
  const median = {};
  for (const [w, vals] of Object.entries(byWindow)) {
    vals.sort((a, b) => a - b);
    const m = vals.length >> 1;
    median[w] = vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
  }
  return { samples: rows.length, median };
}

// Wipe all jobs + runs + usage history (settings survive). Returns all logPaths
// for unlinking.
export function cleanupAll(db) {
  const paths = db.prepare('SELECT logPath FROM runs WHERE logPath IS NOT NULL').all().map((r) => r.logPath);
  db.prepare('DELETE FROM runs').run();
  db.prepare('DELETE FROM jobs').run();
  db.prepare('DELETE FROM run_usage').run();
  db.prepare('DELETE FROM usage_snapshots').run();
  return paths;
}
