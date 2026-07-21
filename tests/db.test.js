import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { tmpData, validJob } from './helpers.js';
import {
  openDb, createJob, listJobs, getJob, updateJob, deleteJob,
  insertRun, updateRun, getRun, listRuns, lastRun, pruneRuns, failOrphanRuns,
  getSetting, setSetting, cleanupAll,
} from '../lib/db.js';

function freshDb() {
  const dir = tmpData();
  return openDb(join(dir, 'test.db'));
}

test('job CRUD round-trip: schedule + params parsed, defaults applied', () => {
  const db = freshDb();
  const job = createJob(db, validJob());
  assert.ok(job.id);
  assert.equal(job.name, 'test job');
  assert.deepEqual(job.schedule, { type: 'cron', expr: '0 9 * * *' });
  assert.equal(job.params.prompt, 'do the thing');
  assert.equal(job.enabled, true);
  assert.equal(job.timeoutMin, 60);
  assert.equal(job.notify, 'failure');

  assert.equal(listJobs(db).length, 1);
  const upd = updateJob(db, job.id, {
    name: 'renamed', enabled: false,
    schedule: { type: 'once', at: '2030-01-01T00:00:00.000Z' },
    params: { ...job.params, model: 'opus' },
  });
  assert.equal(upd.name, 'renamed');
  assert.equal(upd.enabled, false);
  assert.equal(upd.schedule.type, 'once');
  assert.equal(upd.params.model, 'opus');

  deleteJob(db, job.id);
  assert.equal(getJob(db, job.id), null);
});

test('runs lifecycle: meta + progress round-trip, listing, lastRun, delete cascade', () => {
  const db = freshDb();
  const job = createJob(db, validJob());
  const r1 = insertRun(db, { jobId: job.id, status: 'running', trigger: 'schedule' });
  insertRun(db, { jobId: job.id, status: 'queued', trigger: 'manual' });

  updateRun(db, r1.id, {
    status: 'ok', exitCode: 0, durationMs: 12, logPath: '/tmp/x.log',
    meta: JSON.stringify({ sessionId: 'sess-1' }),
    progress: JSON.stringify({ activity: 'done', toolCalls: 2 }),
  });
  const got = getRun(db, r1.id);
  assert.equal(got.status, 'ok');
  assert.deepEqual(got.meta, { sessionId: 'sess-1' });
  assert.deepEqual(got.progress, { activity: 'done', toolCalls: 2 });

  assert.equal(listRuns(db, { jobId: job.id }).length, 2);
  assert.equal(listRuns(db, { status: 'queued' }).length, 1);
  assert.equal(lastRun(db, job.id).trigger, 'manual');

  const paths = deleteJob(db, job.id);
  assert.deepEqual(paths, ['/tmp/x.log']);
  assert.equal(listRuns(db).length, 0);
});

test('pruneRuns keeps newest N, never active runs', () => {
  const db = freshDb();
  const job = createJob(db, validJob());
  for (let i = 0; i < 5; i++) {
    const r = insertRun(db, { jobId: job.id, status: 'ok', trigger: 'schedule' });
    updateRun(db, r.id, { logPath: `/tmp/${i}.log` });
  }
  const active = insertRun(db, { jobId: job.id, status: 'running', trigger: 'schedule' });
  const pruned = pruneRuns(db, job.id, 3);
  assert.equal(pruned.length, 3); // 6 total, keep 3 newest, active among kept
  assert.ok(getRun(db, active.id));
});

test('failOrphanRuns marks running/queued as fail', () => {
  const db = freshDb();
  const job = createJob(db, validJob());
  insertRun(db, { jobId: job.id, status: 'running', trigger: 'schedule' });
  insertRun(db, { jobId: job.id, status: 'queued', trigger: 'schedule' });
  const r = insertRun(db, { jobId: job.id, status: 'running', trigger: 'schedule' });
  updateRun(db, r.id, { status: 'ok' });
  assert.equal(failOrphanRuns(db), 2);
  assert.equal(listRuns(db, { status: 'fail' }).length, 2);
});

test('settings + cleanupAll', () => {
  const db = freshDb();
  assert.equal(getSetting(db, 'maxConcurrent', '2'), '2');
  setSetting(db, 'maxConcurrent', 3);
  assert.equal(getSetting(db, 'maxConcurrent'), '3');

  const job = createJob(db, validJob());
  const r = insertRun(db, { jobId: job.id, status: 'running', trigger: 'manual' });
  updateRun(db, r.id, { logPath: '/tmp/a.log' });
  const paths = cleanupAll(db);
  assert.deepEqual(paths, ['/tmp/a.log']);
  assert.equal(listJobs(db).length, 0);
  assert.equal(listRuns(db).length, 0);
  assert.equal(getSetting(db, 'maxConcurrent'), '3'); // settings survive
});

test('migration: v1 flat-column db folds into params + meta', () => {
  const dir = tmpData();
  const path = join(dir, 'legacy.db');
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'claude',
      prompt TEXT, command TEXT, cwd TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'default', permMode TEXT NOT NULL DEFAULT 'default',
      extraArgs TEXT NOT NULL DEFAULT '', schedule TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, timeoutMin INTEGER NOT NULL DEFAULT 60,
      retryCount INTEGER NOT NULL DEFAULT 0, retryDelayMin INTEGER NOT NULL DEFAULT 5,
      notify TEXT NOT NULL DEFAULT 'failure', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, jobId TEXT NOT NULL, status TEXT NOT NULL, trigger TEXT NOT NULL,
      startedAt TEXT, finishedAt TEXT, exitCode INTEGER, durationMs INTEGER,
      logPath TEXT, sessionId TEXT, progress TEXT, createdAt TEXT NOT NULL
    );
    INSERT INTO jobs (id, name, type, prompt, model, permMode, extraArgs, cwd, schedule, createdAt, updatedAt)
      VALUES ('j1', 'old claude', 'claude', 'fix bugs', 'sonnet', 'auto', '-x', '/tmp', '{"type":"cron","expr":"0 9 * * *"}', 't', 't');
    INSERT INTO jobs (id, name, type, command, cwd, schedule, createdAt, updatedAt)
      VALUES ('j2', 'old cmd', 'command', 'echo hi', '/tmp', '{"type":"cron","expr":"0 9 * * *"}', 't', 't');
    INSERT INTO runs (id, jobId, status, trigger, sessionId, createdAt) VALUES ('r1', 'j1', 'ok', 'manual', 'sess-old', 't');
    INSERT INTO runs (id, jobId, status, trigger, createdAt) VALUES ('r2', 'j2', 'ok', 'manual', 't');
  `);
  raw.close();

  const db = openDb(path);
  const j1 = getJob(db, 'j1');
  assert.deepEqual(j1.params, { prompt: 'fix bugs', model: 'sonnet', permMode: 'auto', extraArgs: '-x' });
  assert.deepEqual(getJob(db, 'j2').params, { command: 'echo hi' });
  assert.deepEqual(getRun(db, 'r1').meta, { sessionId: 'sess-old' });
  assert.equal(getRun(db, 'r2').meta, null);
  // reopening doesn't double-migrate
  db.close();
  const again = openDb(path);
  assert.deepEqual(getJob(again, 'j1').params.model, 'sonnet');
});
