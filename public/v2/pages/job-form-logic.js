// Pure (DOM-free) helpers for the new/edit job dialog and its schedule builder
// (claude-scheduler-btv.11 / D1). Same split as the other /v2 pages: the
// decisions worth testing live here, the DOM lives in job-dialog.js.
//
// The single most important property in this file: EVERY RULE IS MIRRORED FROM
// lib/validate.js, and the server stays the authority. Client-side validation
// exists for one reason — REVIEW #6 asks the error summary to anchor each
// message to the field that caused it, and the server answers with a flat
// `errors: [sentence]` array that carries no field attribution. Re-deriving the
// field by matching the server's English would be the prose-parsing coupling
// this repo has already been bitten by (see claude-scheduler-ddu). So the
// client validates to know WHICH field, and anything the server rejects that
// the client did not catch is still shown verbatim, unanchored, rather than
// swallowed.
//
// ---------------------------------------------------------------------------
// TWO MOCKUP COPY BUGS FIXED HERE, both verified against the real code:
//
// • dialog-validation-errors.html renders a cron error as
//   "0 1 * * * 6 has 6 fields — LaunchBox uses 5-field cron". It does not:
//   BOTH previewSchedule and validateJob construct `new Cron(expr)` (croner),
//   which accepts 5 OR 6 fields — the sixth is seconds. The bead's own live
//   check recorded `0 1 * * * 6` returning 200 with three future fires. A cron
//   error must therefore be rendered from whatever croner actually rejected
//   (the sentence the 400 carries), never from a hand-authored field count.
//
// • The same mockup says a timeout of 600 "is above the maximum of 240
//   minutes". lib/validate.js's bound is `intIn(job.timeoutMin, 1, 1440)`.
//   240 is OFFSET_MAX_MIN — a different field's limit. The bounds below are
//   read from the same constants the server uses, and a test asserts they
//   match rather than re-typing them.
//
// • The mockup's Permission-mode options ("plan — read-only", "auto — full
//   autonomy") are not the ones the claude extension declares
//   (auto | acceptEdits | default). The dialog builds its advanced fields from
//   GET /api/extensions rather than from the mockup, so a third-party
//   extension gets its own fields and nothing invents an option the server
//   would reject.

// Mirrors of lib/validate.js's bounds. Named after their server-side
// counterparts so a drift is findable by grep, and asserted equal in the test.
export const LIMITS = Object.freeze({
  timeoutMin: [1, 1440],
  retryCount: [0, 3],
  retryDelayMin: [1, 1440],
  offsetMin: [0, 240], // OFFSET_MAX_MIN
  jitterMin: [0, 60], // JITTER_MAX_MIN
  minHeadroomPct: [1, 99],
});

export const NOTIFY_OPTIONS = Object.freeze([
  { value: 'failure', label: 'On failure only' },
  { value: 'always', label: 'On every run' },
  { value: 'never', label: 'Never' },
]);

export const DEFAULT_OFFSET_MIN = 3;
export const DEFAULT_JITTER_MIN = 2;

export const pad2 = (n) => String(n).padStart(2, '0');

// ------------------------------------------------------------- presets

// The four shapes the mockup's Preset row offers. "Weekly" needs a day, which
// the mockup's single select cannot express — a day picker is shown for that
// preset rather than silently choosing Sunday for the reader.
export const PRESETS = Object.freeze([
  { id: 'daily', label: 'Daily' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'hourly', label: 'Hourly' },
]);

export const WEEKDAYS = Object.freeze([
  { value: 0, label: 'Sunday' }, { value: 1, label: 'Monday' }, { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' }, { value: 4, label: 'Thursday' }, { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
]);

/** A preset + its fields -> the 5-field cron expression the server stores. */
export function presetToCron({ preset, time = '03:30', weekday = 0 }) {
  const [hh, mm] = String(time || '00:00').split(':').map((n) => Number(n) || 0);
  switch (preset) {
    case 'daily': return `${mm} ${hh} * * *`;
    case 'weekdays': return `${mm} ${hh} * * 1-5`;
    case 'weekly': return `${mm} ${hh} * * ${weekday}`;
    case 'hourly': return `${mm} * * * *`;
    default: return `${mm} ${hh} * * *`;
  }
}

/**
 * The inverse, for opening an existing job in the builder: a cron expression
 * that one of the presets would have produced comes back as that preset, and
 * anything else returns null so the row opens on the Cron tab showing the real
 * expression. Never "nearly" matches — a nearly-matching preset would silently
 * rewrite a schedule on save.
 */
export function cronToPreset(expr) {
  const s = String(expr ?? '').trim();
  let m;
  if ((m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(s))) {
    return { preset: 'daily', time: `${pad2(+m[2])}:${pad2(+m[1])}`, weekday: 0 };
  }
  if ((m = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/.exec(s))) {
    return { preset: 'weekdays', time: `${pad2(+m[2])}:${pad2(+m[1])}`, weekday: 0 };
  }
  if ((m = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/.exec(s))) {
    return { preset: 'weekly', time: `${pad2(+m[2])}:${pad2(+m[1])}`, weekday: +m[3] };
  }
  if ((m = /^(\d{1,2}) \* \* \* \*$/.exec(s))) {
    return { preset: 'hourly', time: `00:${pad2(+m[1])}`, weekday: 0 };
  }
  return null;
}

// ------------------------------------------------------- rows <-> entries

/**
 * A stored schedule entry -> the builder row that edits it. An entry that
 * cannot be represented by a preset opens on `cron` with its expression
 * intact, so round-tripping a job through the dialog never rewrites a schedule
 * the reader did not touch.
 */
export function entryToRow(entry) {
  if (entry?.type === 'once') {
    return { kind: 'once', at: isoToLocalInput(entry.at), expr: '', preset: 'daily', time: '03:30', weekday: 0, window: 'five_hour', offsetMin: DEFAULT_OFFSET_MIN, jitterMin: DEFAULT_JITTER_MIN };
  }
  if (entry?.type === 'afterReset') {
    return {
      kind: 'afterReset', window: entry.window ?? 'five_hour',
      offsetMin: entry.offsetMin ?? DEFAULT_OFFSET_MIN,
      jitterMin: entry.jitterMin ?? DEFAULT_JITTER_MIN,
      expr: '', preset: 'daily', time: '03:30', weekday: 0, at: '',
    };
  }
  const expr = entry?.expr ?? '';
  const hit = cronToPreset(expr);
  if (hit) return { kind: 'preset', ...hit, expr, at: '', window: 'five_hour', offsetMin: DEFAULT_OFFSET_MIN, jitterMin: DEFAULT_JITTER_MIN };
  return { kind: 'cron', expr, preset: 'daily', time: '03:30', weekday: 0, at: '', window: 'five_hour', offsetMin: DEFAULT_OFFSET_MIN, jitterMin: DEFAULT_JITTER_MIN };
}

/** The builder row -> the entry the server stores. */
export function rowToEntry(row) {
  switch (row.kind) {
    case 'cron': return { type: 'cron', expr: String(row.expr ?? '').trim() };
    case 'once': return { type: 'once', at: localInputToIso(row.at) };
    case 'afterReset': return {
      type: 'afterReset',
      window: row.window,
      offsetMin: numOrNull(row.offsetMin),
      jitterMin: numOrNull(row.jitterMin),
    };
    case 'preset':
    default: return { type: 'cron', expr: presetToCron(row) };
  }
}

export const newRow = () => entryToRow({ type: 'cron', expr: '0 3 * * *' });

const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

/**
 * `<input type="datetime-local">` speaks local wall-clock with no zone; the
 * server stores ISO. Converting through the Date constructor (rather than
 * string surgery) is what keeps "03:30 tomorrow" meaning 03:30 where the
 * reader is, across a DST boundary.
 */
export function localInputToIso(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

export function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// --------------------------------------------------------------- preview

/**
 * The per-row "next fires" line. THREE distinct states, and the bead's own
 * live probe is why they are separate:
 *
 *   next[] non-empty                 -> up to three times
 *   next[] empty, unknown === false  -> it will never fire again (a spent
 *                                       once-entry) — a real, final answer
 *   unknown === true                 -> no time is knowable yet (an afterReset
 *                                       whose window has not been read)
 *
 * Collapsing the last two into one "no upcoming fires" would tell a reader
 * their reset-anchored job is dead when it is simply unmeasured.
 */
export function firesText(preview, { prefix = 'next fires' } = {}) {
  if (!preview) return { text: `${prefix}: …`, tone: 'muted' };
  if (preview.error) return { text: preview.error, tone: 'bad' };
  const next = preview.next ?? [];
  if (next.length) {
    return { text: `${prefix}: ${next.map(fmtFire).join(' · ')}`, tone: 'ok', first: next[0] };
  }
  if (preview.unknown) {
    return {
      text: 'next fire: ≈ unknown — follows the live reset time, which has not been read yet',
      tone: 'muted',
      unknown: true,
    };
  }
  return { text: 'will not fire again — this time is in the past', tone: 'muted', spent: true };
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sun 03:30" for this week, "14 Sep 03:30" beyond it. */
export function fmtFire(iso, now = Date.now()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const days = (d.getTime() - now) / 86400000;
  return days < 7 ? `${DAYS[d.getDay()]} ${clock}` : `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock}`;
}

/**
 * The footer's consequence line. The schedule COUNT is client-side (the array
 * length — no round-trip), and the next fire is `next[0]` of one call made
 * with every entry at once; per-entry attribution is not needed and is not
 * asked for.
 */
export function consequenceText({ isEdit, count, preview }) {
  const action = isEdit ? 'Saving a job' : 'Creating a job';
  const bits = [`${action} asks for your approval (Touch ID)`];
  if (count) bits.push(`${count} schedule${count === 1 ? '' : 's'}`);
  const f = firesText(preview, { prefix: 'next fire' });
  if (f.first) bits.push(`next fire ${fmtFire(f.first)}`);
  else if (f.unknown) bits.push('next fire ≈ unknown until the reset time is read');
  else if (f.spent) bits.push('nothing will fire — every schedule is in the past');
  return bits.join(' · ');
}

// ------------------------------------------------------------ validation

/**
 * Client-side validation, mirroring lib/validate.js. Returns
 * `[{ field, message }]` — `field` is the anchor REVIEW #6 needs and the
 * server cannot supply.
 *
 * Deliberately does NOT check the cron expression: croner is the only thing
 * that knows what croner accepts, and guessing here is exactly how the
 * mockup's "6 fields — expected 5" came to be wrong. An invalid expression is
 * caught by the live preview call (a 400 whose sentence is rendered verbatim
 * on that row) and again by the server at save time.
 *
 * Also does NOT check `cwd` existence — that is an fs stat only the server can
 * do. An empty cwd is checkable and is checked.
 */
export function validateForm(form, { fields = [] } = {}) {
  const out = [];
  const add = (field, message) => out.push({ field, message });

  if (!String(form.name ?? '').trim()) add('name', 'A job needs a name.');
  if (!String(form.cwd ?? '').trim()) add('cwd', 'A working directory is required — the job runs there.');

  for (const f of fields) {
    if (!f.required) continue;
    const v = form.params?.[f.key];
    if (f.type === 'text' || f.type === 'textarea') {
      if (!String(v ?? '').trim()) add(`params.${f.key}`, `${f.label ?? f.key} is required — the field is empty.`);
    }
  }

  const rows = form.rows ?? [];
  if (!rows.length) add('schedule', 'A job needs at least one schedule.');
  rows.forEach((row, i) => {
    if (row.kind === 'once') {
      if (!row.at) add(`schedule.${i}`, `Schedule ${i + 1} is a one-off with no date and time.`);
      else if (Number.isNaN(new Date(row.at).getTime())) add(`schedule.${i}`, `Schedule ${i + 1} has a date that cannot be read.`);
    }
    if (row.kind === 'cron' && !String(row.expr ?? '').trim()) {
      add(`schedule.${i}`, `Schedule ${i + 1} is a cron schedule with no expression.`);
    }
    if (row.kind === 'afterReset') {
      if (!intIn(row.offsetMin, ...LIMITS.offsetMin)) {
        add(`schedule.${i}`, `Schedule ${i + 1}: offset must be ${LIMITS.offsetMin[0]}–${LIMITS.offsetMin[1]} minutes.`);
      }
      if (!intIn(row.jitterMin, ...LIMITS.jitterMin)) {
        add(`schedule.${i}`, `Schedule ${i + 1}: jitter must be ${LIMITS.jitterMin[0]}–${LIMITS.jitterMin[1]} minutes.`);
      }
    }
  });

  const num = (k, label) => {
    if (!intIn(form[k], ...LIMITS[k])) add(k, `${label} must be ${LIMITS[k][0]}–${LIMITS[k][1]}.`);
  };
  num('timeoutMin', 'Timeout');
  num('retryCount', 'Retries');
  num('retryDelayMin', 'Retry delay');

  if (form.minHeadroomPct !== '' && form.minHeadroomPct != null
    && !intIn(form.minHeadroomPct, ...LIMITS.minHeadroomPct)) {
    add('minHeadroomPct', `Extra headroom must be ${LIMITS.minHeadroomPct[0]}–${LIMITS.minHeadroomPct[1]}%.`);
  }

  if (!NOTIFY_OPTIONS.some((o) => o.value === form.notify)) add('notify', 'Pick when to be notified.');

  return out;
}

function intIn(v, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max;
}

/** The form state -> the POST/PUT body. */
export function formToBody(form) {
  const entries = (form.rows ?? []).map(rowToEntry);
  const params = { ...(form.params ?? {}) };
  const budget = {};
  if (form.ignoreGuard) budget.ignoreGuard = true;
  if (form.minHeadroomPct !== '' && form.minHeadroomPct != null) budget.minHeadroomPct = Number(form.minHeadroomPct);
  if (Object.keys(budget).length) params.budget = budget;

  return {
    name: String(form.name ?? '').trim(),
    type: form.type,
    cwd: String(form.cwd ?? '').trim(),
    // One entry stays an object, matching lib/validate.js's normalizeSchedule,
    // so a single-schedule job round-trips through the dialog byte-identically
    // instead of being promoted to a one-element array.
    schedule: entries.length === 1 ? entries[0] : entries,
    enabled: form.enabled !== false,
    timeoutMin: Number(form.timeoutMin),
    retryCount: Number(form.retryCount),
    retryDelayMin: Number(form.retryDelayMin),
    notify: form.notify,
    params,
  };
}

/** An existing job -> the form state the dialog edits. */
export function jobToForm(job, { clone = false } = {}) {
  const entries = Array.isArray(job?.schedule) ? job.schedule : job?.schedule ? [job.schedule] : [];
  const params = { ...(job?.params ?? {}) };
  const budget = params.budget ?? {};
  delete params.budget;
  return {
    type: job?.type ?? 'claude',
    name: clone && job?.name ? `${job.name} (copy)` : (job?.name ?? ''),
    cwd: job?.cwd ?? '',
    params,
    rows: entries.length ? entries.map(entryToRow) : [newRow()],
    enabled: job?.enabled !== false,
    timeoutMin: job?.timeoutMin ?? 60,
    retryCount: job?.retryCount ?? 0,
    retryDelayMin: job?.retryDelayMin ?? 5,
    notify: job?.notify ?? 'failure',
    ignoreGuard: !!budget.ignoreGuard,
    minHeadroomPct: budget.minHeadroomPct ?? '',
  };
}
