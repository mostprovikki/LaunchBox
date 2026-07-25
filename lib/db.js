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
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  beadsDir TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  config TEXT NOT NULL DEFAULT '{}',
  bdVersion TEXT,
  lastPollAt TEXT,
  lastPollOk INTEGER,
  lastError TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_leases (
  projectId TEXT NOT NULL,
  beadId TEXT NOT NULL,
  runId TEXT,
  state TEXT NOT NULL,
  acquiredAt TEXT NOT NULL,
  releasedAt TEXT,
  PRIMARY KEY (projectId, beadId)
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

// --- projects (M4a) ------------------------------------------------------
// A registered repo whose tasks live in its own `.beads/`. We store no task
// rows: beads is the source of truth and `bd ready` is the query (see the M4a
// plan §4a.1). `state` is the airlock — discovery may only ever write
// 'pending', and nothing polls or runs until a human moves it to 'active'.

const PROJECT_COLS = [
  'name', 'path', 'beadsDir', 'state', 'config', 'bdVersion',
  'lastPollAt', 'lastPollOk', 'lastError',
];

export const PROJECT_STATES = ['pending', 'active', 'paused', 'error'];

function rowToProject(row) {
  if (!row) return null;
  return { ...row, config: JSON.parse(row.config || '{}'), lastPollOk: row.lastPollOk == null ? null : !!row.lastPollOk };
}

function projectToRow(p) {
  const row = { ...p };
  if ('config' in row) row.config = JSON.stringify(row.config ?? {});
  if ('lastPollOk' in row && row.lastPollOk != null) row.lastPollOk = row.lastPollOk ? 1 : 0;
  return row;
}

// `beadsDir` is deliberately nullable and is only ever filled from
// `bd where --json` — never by concatenating '.beads' onto `path`. The M4a
// spike (§4a.6 item 1) found a git worktree carries a *hollow* `.beads/`, so a
// derived path can point at a directory that exists and holds no database.
export function createProject(db, project) {
  const id = randomUUID();
  const ts = now();
  const row = { state: 'pending', config: '{}', ...projectToRow(project) };
  db.prepare(`INSERT INTO projects (id, ${PROJECT_COLS.join(', ')}, createdAt, updatedAt)
    VALUES (@id, ${PROJECT_COLS.map((c) => '@' + c).join(', ')}, @createdAt, @updatedAt)`)
    .run({ id, createdAt: ts, updatedAt: ts, ...Object.fromEntries(PROJECT_COLS.map((c) => [c, row[c] ?? null])) });
  return getProject(db, id);
}

export function listProjects(db, { state } = {}) {
  const sql = `SELECT * FROM projects ${state ? 'WHERE state = @state' : ''} ORDER BY createdAt`;
  return db.prepare(sql).all(state ? { state } : {}).map(rowToProject);
}

export function getProject(db, id) {
  return rowToProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
}

export function getProjectByPath(db, path) {
  return rowToProject(db.prepare('SELECT * FROM projects WHERE path = ?').get(path));
}

export function updateProject(db, id, patch) {
  const row = projectToRow(patch);
  const cols = PROJECT_COLS.filter((c) => c in row);
  if (cols.length) {
    db.prepare(`UPDATE projects SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updatedAt = @updatedAt WHERE id = @id`)
      .run({ id, updatedAt: now(), ...Object.fromEntries(cols.map((c) => [c, row[c] ?? null])) });
  }
  return getProject(db, id);
}

export function deleteProject(db, id) {
  db.prepare('DELETE FROM task_leases WHERE projectId = ?').run(id);
  return db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes;
}

// A bead's materialised job, found by the identity we stamped into params.
//
// This is also the answer to §4a.7's cost-attribution problem: because one bead
// keeps ONE job row across every run, `run_usage.jobId` already accumulates that
// bead's observed cost and `avgDeltaForJob` already returns its median. Reaping
// the row after each run — the original design — is what would have thrown the
// learned cost away. Keeping it costs a few hundred bytes per bead.
export function findJobByBead(db, projectId, beadId) {
  return rowToJob(db.prepare(`SELECT * FROM jobs
    WHERE json_extract(params, '$._projectId') = ? AND json_extract(params, '$._beadId') = ?
    LIMIT 1`).get(projectId, beadId));
}

// --- task leases (M4a) ---------------------------------------------------
// OUR lock, not beads'. Single daemon + one SQL statement = airtight against
// double-running a bead. `bd update --claim` is written separately as a notice
// board; the M4a spike measured it as genuinely compare-and-set, but it stays
// advisory because this lease covers the window *before* a claim lands and is
// transactional with the rest of our state (§4a.5).

// Atomic acquire. The `WHERE state != 'held'` on the upsert is what makes this
// safe: a second caller racing for the same bead updates zero rows and gets
// false, rather than both readers seeing "no lease" and both proceeding. A
// released or done lease may be re-acquired — a bead that failed should be
// retryable on a later poll.
export function acquireLease(db, { projectId, beadId, runId = null }) {
  const changes = db.prepare(`
    INSERT INTO task_leases (projectId, beadId, runId, state, acquiredAt)
    VALUES (@projectId, @beadId, @runId, 'held', @acquiredAt)
    ON CONFLICT(projectId, beadId) DO UPDATE SET
      state = 'held', runId = excluded.runId, acquiredAt = excluded.acquiredAt, releasedAt = NULL
    WHERE task_leases.state != 'held'
  `).run({ projectId, beadId, runId, acquiredAt: now() }).changes;
  return changes > 0;
}

export function getLease(db, projectId, beadId) {
  return db.prepare('SELECT * FROM task_leases WHERE projectId = ? AND beadId = ?').get(projectId, beadId) ?? null;
}

export function listLeases(db, { projectId, state } = {}) {
  const where = [];
  const params = {};
  if (projectId) { where.push('projectId = @projectId'); params.projectId = projectId; }
  if (state) { where.push('state = @state'); params.state = state; }
  return db.prepare(`SELECT * FROM task_leases ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY acquiredAt`).all(params);
}

// `released` means "eligible again" (the run failed, was stopped, or never
// launched); `done` means the bead was seen through to a close. Both free the
// lease for re-acquisition — the distinction is for humans reading the table.
function setLeaseState(db, projectId, beadId, state, patch = {}) {
  const cols = ['state = @state', 'releasedAt = @releasedAt'];
  const params = { projectId, beadId, state, releasedAt: now(), ...patch };
  if ('runId' in patch) cols.push('runId = @runId');
  db.prepare(`UPDATE task_leases SET ${cols.join(', ')} WHERE projectId = @projectId AND beadId = @beadId`).run(params);
  return getLease(db, projectId, beadId);
}

export function releaseLease(db, projectId, beadId, patch = {}) {
  return setLeaseState(db, projectId, beadId, 'released', patch);
}

export function completeLease(db, projectId, beadId, patch = {}) {
  return setLeaseState(db, projectId, beadId, 'done', patch);
}

// Attach the run once it exists — the lease is taken *before* launching, so the
// runId isn't known at acquire time.
export function attachLeaseRun(db, projectId, beadId, runId) {
  db.prepare('UPDATE task_leases SET runId = ? WHERE projectId = ? AND beadId = ?').run(runId, projectId, beadId);
  return getLease(db, projectId, beadId);
}

// A daemon crash leaves held leases with no live run. Same role as
// failOrphanRuns: call at boot so the beads become eligible again.
export function releaseOrphanLeases(db) {
  return db.prepare(`UPDATE task_leases SET state = 'released', releasedAt = ? WHERE state = 'held'`)
    .run(now()).changes;
}

// Wipe all jobs + runs + usage history + projects/leases (settings survive).
// Returns all logPaths for unlinking.
export function cleanupAll(db) {
  const paths = db.prepare('SELECT logPath FROM runs WHERE logPath IS NOT NULL').all().map((r) => r.logPath);
  db.prepare('DELETE FROM runs').run();
  db.prepare('DELETE FROM jobs').run();
  db.prepare('DELETE FROM run_usage').run();
  db.prepare('DELETE FROM usage_snapshots').run();
  db.prepare('DELETE FROM task_leases').run();
  db.prepare('DELETE FROM projects').run();
  return paths;
}
