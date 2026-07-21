import express from 'express';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDirs, dbPath } from './lib/paths.js';
import {
  openDb, createJob, listJobs, getJob, updateJob, deleteJob,
  insertRun, getRun, listRuns, lastRun, failOrphanRuns,
  getSetting, setSetting, cleanupAll,
} from './lib/db.js';
import { validateJob, previewSchedule } from './lib/validate.js';
import { loadExtensions, manifest, validateFields } from './lib/extensions.js';
import { createRunner } from './lib/runner.js';
import { createScheduler } from './lib/scheduler.js';
import { createAwake } from './lib/awake.js';
import { startUninstall } from './lib/uninstall.js';

const ROOT = dirname(fileURLToPath(import.meta.url));

export function createApp({ db, runner, scheduler, extensions, awake, execFileFn = execFile, uninstallFn = startUninstall }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(join(ROOT, 'public')));

  const decorate = (job) => ({
    ...job,
    nextFire: scheduler.nextFire(job.id),
    lastRun: (({ id, status, finishedAt, startedAt } = {}) => (id ? { id, status, finishedAt, startedAt } : null))(lastRun(db, job.id) ?? {}),
  });

  app.get('/api/extensions', (req, res) => {
    res.json({ extensions: manifest(extensions) });
  });

  app.get('/api/jobs', (req, res) => {
    res.json({ jobs: listJobs(db).map(decorate), running: runner.runningCount(), awake: awake?.status() ?? null });
  });

  app.post('/api/jobs', (req, res) => {
    const v = validateJob(req.body, extensions);
    if (!v.ok) return res.status(400).json({ errors: v.errors });
    const job = createJob(db, v.job);
    scheduler.reload(job.id);
    awake?.refresh();
    res.status(201).json(decorate(job));
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = getJob(db, req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    res.json(decorate(job));
  });

  app.put('/api/jobs/:id', (req, res) => {
    const existing = getJob(db, req.params.id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    const merged = { ...existing, ...req.body, params: { ...existing.params, ...(req.body?.params ?? {}) } };
    // Toggling enabled on an existing once-job whose time passed: allow disable, block enable.
    const v = validateJob(merged, extensions);
    if (!v.ok && !(req.body.enabled === false)) return res.status(400).json({ errors: v.errors });
    const job = updateJob(db, req.params.id, v.ok ? v.job : { enabled: false });
    scheduler.reload(job.id);
    awake?.refresh();
    res.json(decorate(job));
  });

  app.delete('/api/jobs/:id', (req, res) => {
    if (!getJob(db, req.params.id)) return res.status(404).json({ error: 'not found' });
    for (const p of deleteJob(db, req.params.id)) {
      try { unlinkSync(p); } catch {}
    }
    scheduler.reload(req.params.id);
    awake?.refresh();
    res.json({ ok: true });
  });

  app.post('/api/jobs/:id/run', (req, res) => {
    const job = getJob(db, req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    res.status(202).json(runner.start(job, 'manual'));
  });

  app.post('/api/runs/:id/kill', (req, res) => {
    const run = getRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    if (!['running', 'queued'].includes(run.status)) return res.status(409).json({ error: 'run is not active' });
    const killed = runner.kill(run.id);
    if (!killed) return res.status(409).json({ error: 'run is not active' });
    res.status(202).json(killed);
  });

  // Extension-defined per-run actions (e.g. claude's "Resume in Terminal").
  app.post('/api/runs/:id/actions/:actionId', async (req, res) => {
    const run = getRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    const job = getJob(db, run.jobId);
    if (!job) return res.status(404).json({ error: 'job gone' });
    const action = extensions.get(job.type)?.runActions?.find((a) => a.id === req.params.actionId);
    if (!action) return res.status(404).json({ error: 'unknown action' });
    if (action.requiresRunMeta && !run.meta?.[action.requiresRunMeta]) {
      return res.status(400).json({ error: `run has no ${action.requiresRunMeta}` });
    }
    try {
      const result = await action.exec({ run, job, db, setting: (k, d) => getSetting(db, k, d), execFileFn });
      res.json(result ?? { ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.get('/api/runs', (req, res) => {
    res.json({ runs: listRuns(db, { jobId: req.query.job, status: req.query.status, limit: Number(req.query.limit) || 100 }) });
  });

  app.get('/api/runs/:id/log', (req, res) => {
    const run = getRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    res.type('text/plain').send(run.logPath && existsSync(run.logPath) ? readFileSync(run.logPath, 'utf8') : '');
  });

  app.get('/api/runs/:id/tail', (req, res) => {
    const run = getRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (event, data) => res.write((event ? `event: ${event}\n` : '') + `data: ${data}\n\n`);

    if (run.logPath && existsSync(run.logPath)) {
      for (const l of readFileSync(run.logPath, 'utf8').split('\n')) if (l) send(null, l);
    }
    if (!['running', 'queued'].includes(run.status)) {
      send('done', run.status);
      return res.end();
    }
    const onLine = (l) => send(null, l);
    const onProgress = (p) => send('progress', JSON.stringify(p));
    const onDone = (status) => { send('done', status); cleanup(); res.end(); };
    const cleanup = () => {
      runner.events.off(`line:${run.id}`, onLine);
      runner.events.off(`progress:${run.id}`, onProgress);
      runner.events.off(`done:${run.id}`, onDone);
    };
    runner.events.on(`line:${run.id}`, onLine);
    runner.events.on(`progress:${run.id}`, onProgress);
    runner.events.on(`done:${run.id}`, onDone);
    req.on('close', cleanup);
  });

  app.post('/api/schedule/preview', (req, res) => {
    try {
      res.json({ next: previewSchedule(req.body?.schedules ?? req.body?.schedule, 3) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/awake', (req, res) => {
    if (!awake) return res.status(501).json({ error: 'awake not available' });
    res.json(awake.status());
  });

  app.put('/api/awake', (req, res) => {
    if (!awake) return res.status(501).json({ error: 'awake not available' });
    try {
      res.json(awake.set({ mode: req.body?.mode, minutes: req.body?.minutes != null ? Number(req.body.minutes) : undefined }));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Settings: core {paused, home} + per-extension blocks from each ext's
  // `settings` field specs (defaults applied on read, validated on write).
  const extSettingsOut = () => Object.fromEntries([...extensions.values()]
    .filter((e) => e.settings?.length)
    .map((e) => [e.id, Object.fromEntries(e.settings.map((s) => {
      const raw = getSetting(db, s.key, null);
      const v = raw == null ? s.default ?? null : s.type === 'number' ? Number(raw) : raw;
      return [s.key, v];
    }))]));

  app.get('/api/settings', (req, res) => {
    res.json({
      paused: getSetting(db, 'paused', '0') === '1',
      home: process.env.HOME || '',
      extensions: extSettingsOut(),
    });
  });

  app.put('/api/settings', (req, res) => {
    const b = req.body || {};
    if ('extensions' in b) {
      for (const [extId, values] of Object.entries(b.extensions || {})) {
        const ext = extensions.get(extId);
        if (!ext?.settings?.length) return res.status(400).json({ error: `unknown extension: ${extId}` });
        const specs = ext.settings.filter((s) => s.key in values);
        const { params, errors } = validateFields(specs, values);
        if (errors.length) return res.status(400).json({ errors });
        for (const s of specs) setSetting(db, s.key, params[s.key]);
      }
    }
    if ('paused' in b) setSetting(db, 'paused', b.paused ? '1' : '0');
    awake?.refresh();
    res.json({ ok: true });
  });

  app.post('/api/cleanup', (req, res) => {
    runner.killAll();
    scheduler.stop();
    for (const p of cleanupAll(db)) {
      try { unlinkSync(p); } catch {}
    }
    scheduler.start(); // no jobs left, but keeps instance consistent
    awake?.refresh();
    res.json({ ok: true });
  });

  app.post('/api/uninstall', (req, res) => {
    res.status(202).json({ ok: true, message: 'uninstalling — daemon will exit' });
    awake?.stop();
    uninstallFn({ runner, server: app.locals.server });
  });

  return app;
}

export async function main() {
  ensureDirs();
  const db = openDb(dbPath());
  failOrphanRuns(db);
  const extensions = await loadExtensions();
  for (const ext of extensions.values()) {
    try {
      ext.init?.({ getSetting: (k, d) => getSetting(db, k, d), setSetting: (k, v) => setSetting(db, k, v) });
    } catch (err) {
      console.error(`extension ${ext.id} init failed:`, err.message);
    }
  }
  const runner = createRunner({ db, extensions });
  const scheduler = createScheduler({ db, runner });
  scheduler.start();
  const awake = createAwake({ db, runner, scheduler });
  awake.refresh();
  const app = createApp({ db, runner, scheduler, extensions, awake });
  const port = Number(process.env.CS_PORT) || 9099;
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`claude-scheduler on http://127.0.0.1:${port} · extensions: ${[...extensions.keys()].join(', ')}`);
  });
  app.locals.server = server;
  return server;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
