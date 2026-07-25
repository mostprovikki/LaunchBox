import { Cron } from 'croner';
import { existsSync, statSync } from 'node:fs';
import { validateFields } from './extensions.js';

const NOTIFY = ['always', 'failure', 'never'];

// Windows an `afterReset` entry may anchor to when the live snapshot can't say.
// Kept as a fallback only: the real list is whatever `get_usage` reports, so a
// bucket that ships next week is usable without a code change.
export const RESET_WINDOWS = ['five_hour', 'seven_day'];
export const OFFSET_MAX_MIN = 240;
export const JITTER_MAX_MIN = 60;

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

// Jitter for a reset-anchored fire, in ms within [0, jitterMin]. Deterministic
// in (jobId, window) — FNV-1a over the pair — so a preview shown in the UI is
// the time that actually fires, and re-arming after every usage poll doesn't
// walk the fire time forward. Spreading reset-anchored jobs at all matters
// because every client on the plan learns the same `resets_at`.
export function resetJitterMs(jobId, window, jitterMin) {
  if (!jitterMin) return 0;
  const s = `${jobId}|${window}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % (jitterMin * 60_000 + 1);
}

// When an `afterReset` entry anchored to `resetsAt` should fire, or null if the
// reset time isn't a date. The offset exists because `resets_at` is the server's
// boundary: firing exactly on it risks landing in the window that just closed.
export function afterResetFireAt(entry, resetsAt, jobId = '') {
  const t = new Date(resetsAt ?? '').getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t + (entry.offsetMin ?? 0) * 60_000
    + resetJitterMs(jobId, entry.window, entry.jitterMin ?? 0)).toISOString();
}

export const hasAfterReset = (schedule) => scheduleEntries(schedule).some((e) => e?.type === 'afterReset');

// Returns true if the entry can fire in the future (assumes format-valid).
function entryFires(entry) {
  // An afterReset entry always has a next occurrence — the window it tracks
  // resets forever. Saying otherwise would auto-disable a job whose only entry
  // is this one, every time usage happened to be unreadable.
  if (entry.type === 'afterReset') return true;
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

function validSchedule(schedule, errors, windows) {
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
    } else if (entry.type === 'afterReset') {
      // Prefer the live window list; fall back to the known two when usage is
      // unreadable, so a job stays editable while the monitor is down.
      const live = Object.keys(windows ?? {});
      const allowed = live.length ? live : RESET_WINDOWS;
      if (!allowed.includes(entry.window)) errors.push(`schedule.window must be one of ${allowed.join('|')}`);
      if (!intIn(entry.offsetMin, 0, OFFSET_MAX_MIN)) errors.push(`offsetMin must be 0-${OFFSET_MAX_MIN}`);
      if (!intIn(entry.jitterMin, 0, JITTER_MAX_MIN)) errors.push(`jitterMin must be 0-${JITTER_MAX_MIN}`);
    } else {
      errors.push('schedule.type must be cron, once or afterReset');
    }
  }
  // At least one entry must fire in the future (past once-entries are dead weight
  // but tolerated when a live entry exists).
  if (!errors.length && !entries.some(entryFires)) errors.push('schedule never fires in the future');
}

function intIn(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

// Per-job budget overrides live at `params.budget`. They're validated here rather
// than as extension fields because the guard that reads them is core — every job
// type has the same relationship to the account's limits. Returns undefined when
// there's nothing to store, so a job without overrides has no empty block.
function budgetParams(raw, errors) {
  const b = raw?.budget;
  if (b == null) return undefined;
  if (typeof b !== 'object' || Array.isArray(b)) {
    errors.push('params.budget must be an object');
    return undefined;
  }
  const out = {};
  if (b.ignoreGuard) out.ignoreGuard = true;
  if (b.minHeadroomPct != null && b.minHeadroomPct !== '') {
    const n = Number(b.minHeadroomPct);
    if (!intIn(n, 1, 99)) errors.push('budget.minHeadroomPct must be 1-99');
    else out.minHeadroomPct = n;
  }
  return Object.keys(out).length ? out : undefined;
}

// afterReset entries are stored with their offset/jitter explicit: what fires is
// then readable from the row, and a later default change can't silently move an
// existing job's fire time.
const DEFAULT_OFFSET_MIN = 3;
const DEFAULT_JITTER_MIN = 2;

function normalizeEntry(entry) {
  if (entry?.type !== 'afterReset') return entry;
  return {
    type: 'afterReset',
    window: entry.window,
    offsetMin: entry.offsetMin ?? DEFAULT_OFFSET_MIN,
    jitterMin: entry.jitterMin ?? DEFAULT_JITTER_MIN,
  };
}

// Single entry keeps legacy object shape; 2+ entries stored as array.
function normalizeSchedule(schedule) {
  const entries = scheduleEntries(schedule).map(normalizeEntry);
  return entries.length === 1 ? entries[0] : entries.length ? entries : schedule;
}

// Returns {ok:true, job:<normalized>} or {ok:false, errors:[...]}.
// `extensions` (Map id → ext) supplies per-type field specs; extension fields
// may arrive under `params` or flat on the payload (legacy shape) — both fold
// into job.params. `windows` (the live snapshot's) constrains which window an
// afterReset entry may anchor to; omitting it falls back to RESET_WINDOWS.
export function validateJob(payload, extensions, { windows = null } = {}) {
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
    const budget = budgetParams(raw, errors);
    if (budget) job.params.budget = budget;
  }
  if (typeof job.cwd !== 'string' || !existsSync(job.cwd) || !statSync(job.cwd).isDirectory()) errors.push('cwd must be an existing directory');
  validSchedule(job.schedule, errors, windows);
  if (!intIn(job.timeoutMin, 1, 1440)) errors.push('timeoutMin must be 1-1440');
  if (!intIn(job.retryCount, 0, 3)) errors.push('retryCount must be 0-3');
  if (!intIn(job.retryDelayMin, 1, 1440)) errors.push('retryDelayMin must be 1-1440');
  if (!NOTIFY.includes(job.notify)) errors.push('invalid notify');

  return errors.length ? { ok: false, errors } : { ok: true, job };
}

// `{next: [ISO…], unknown}` — the next n fire times across all entries, with
// `unknown: true` when an afterReset entry couldn't be resolved because the reset
// time isn't known. Unknown is not an error: the entry will fire, we just can't
// say when yet, and the UI must say that rather than show a wrong time.
// Throws on an invalid schedule.
export function previewSchedule(schedule, n = 3, { windows = null, jobId = '' } = {}) {
  const entries = scheduleEntries(schedule);
  if (!entries.length) throw new Error('schedule required');
  const all = [];
  let unknown = false;
  for (const entry of entries) {
    if (entry?.type === 'once') {
      const d = new Date(entry.at);
      if (Number.isNaN(d.getTime())) throw new Error('invalid datetime');
      if (d > new Date()) all.push(d.toISOString());
    } else if (entry?.type === 'cron') {
      const c = new Cron(entry.expr);
      all.push(...c.nextRuns(n).map((d) => d.toISOString()));
      c.stop();
    } else if (entry?.type === 'afterReset') {
      const at = afterResetFireAt(entry, windows?.[entry.window]?.resetsAt, jobId);
      // A computed time already past means this window instance is spent; the
      // next one is a reset away and its time isn't knowable from here.
      if (at && new Date(at) > new Date()) all.push(at);
      else unknown = true;
    } else {
      throw new Error('schedule.type must be cron, once or afterReset');
    }
  }
  return { next: [...new Set(all)].sort().slice(0, n), unknown };
}
