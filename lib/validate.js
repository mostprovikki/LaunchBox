import { Cron } from 'croner';
import { existsSync, statSync } from 'node:fs';
import { validateFields } from './extensions.js';

const NOTIFY = ['always', 'failure', 'never'];

// Quote-aware tokenizer for extraArgs-style fields — split, not shell-interpreted.
export function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// A job's schedule is one entry or an array of entries; normalize to array.
export function scheduleEntries(schedule) {
  return Array.isArray(schedule) ? schedule : schedule ? [schedule] : [];
}

// Returns true if the entry can fire in the future (assumes format-valid).
function entryFires(entry) {
  if (entry.type === 'cron') {
    try {
      const c = new Cron(entry.expr);
      const next = c.nextRun();
      c.stop();
      return !!next;
    } catch { return false; }
  }
  return new Date(entry.at) > new Date();
}

function validSchedule(schedule, errors) {
  const entries = scheduleEntries(schedule);
  if (!entries.length) return errors.push('schedule required');
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') { errors.push('schedule entry must be an object'); continue; }
    if (entry.type === 'cron') {
      try {
        new Cron(entry.expr).stop();
      } catch {
        errors.push(`invalid cron expression: ${entry.expr}`);
      }
    } else if (entry.type === 'once') {
      if (Number.isNaN(new Date(entry.at).getTime())) errors.push('invalid once datetime');
    } else {
      errors.push('schedule.type must be cron or once');
    }
  }
  // At least one entry must fire in the future (past once-entries are dead weight
  // but tolerated when a live entry exists).
  if (!errors.length && !entries.some(entryFires)) errors.push('schedule never fires in the future');
}

function intIn(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

// Single entry keeps legacy object shape; 2+ entries stored as array.
function normalizeSchedule(schedule) {
  const entries = scheduleEntries(schedule);
  return entries.length === 1 ? entries[0] : entries.length ? entries : schedule;
}

// Returns {ok:true, job:<normalized>} or {ok:false, errors:[...]}.
// `extensions` (Map id → ext) supplies per-type field specs; extension fields
// may arrive under `params` or flat on the payload (legacy shape) — both fold
// into job.params.
export function validateJob(payload, extensions) {
  const errors = [];
  const p = payload || {};
  const job = {
    name: typeof p.name === 'string' ? p.name.trim() : '',
    type: p.type ?? 'command',
    cwd: p.cwd,
    schedule: normalizeSchedule(p.schedules ?? p.schedule),
    enabled: p.enabled ?? true,
    timeoutMin: p.timeoutMin ?? 60,
    retryCount: p.retryCount ?? 0,
    retryDelayMin: p.retryDelayMin ?? 5,
    notify: p.notify ?? 'failure',
  };

  if (!job.name) errors.push('name required');
  const ext = extensions?.get(job.type);
  if (!ext) {
    errors.push(`unknown job type: ${job.type}`);
  } else {
    const raw = { ...(typeof p.params === 'object' && p.params ? p.params : {}) };
    for (const f of ext.fields) if (!(f.key in raw) && f.key in p) raw[f.key] = p[f.key];
    const { params, errors: fieldErrors } = validateFields(ext.fields, raw);
    errors.push(...fieldErrors);
    if (!fieldErrors.length && typeof ext.validate === 'function') errors.push(...(ext.validate(params) || []));
    job.params = params;
  }
  if (typeof job.cwd !== 'string' || !existsSync(job.cwd) || !statSync(job.cwd).isDirectory()) errors.push('cwd must be an existing directory');
  validSchedule(job.schedule, errors);
  if (!intIn(job.timeoutMin, 1, 1440)) errors.push('timeoutMin must be 1-1440');
  if (!intIn(job.retryCount, 0, 3)) errors.push('retryCount must be 0-3');
  if (!intIn(job.retryDelayMin, 1, 1440)) errors.push('retryDelayMin must be 1-1440');
  if (!NOTIFY.includes(job.notify)) errors.push('invalid notify');

  return errors.length ? { ok: false, errors } : { ok: true, job };
}

// Next n fire times as ISO strings across all entries; throws on invalid schedule.
export function previewSchedule(schedule, n = 3) {
  const entries = scheduleEntries(schedule);
  if (!entries.length) throw new Error('schedule required');
  const all = [];
  for (const entry of entries) {
    if (entry?.type === 'once') {
      const d = new Date(entry.at);
      if (Number.isNaN(d.getTime())) throw new Error('invalid datetime');
      if (d > new Date()) all.push(d.toISOString());
    } else if (entry?.type === 'cron') {
      const c = new Cron(entry.expr);
      all.push(...c.nextRuns(n).map((d) => d.toISOString()));
      c.stop();
    } else {
      throw new Error('schedule.type must be cron or once');
    }
  }
  return [...new Set(all)].sort().slice(0, n);
}
