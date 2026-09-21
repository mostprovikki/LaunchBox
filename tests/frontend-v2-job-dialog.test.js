// New/Edit/Clone job dialog + schedule builder (claude-scheduler-btv.11 / D1).
//
//  - pure logic (public/v2/pages/job-form-logic.js) — presets ↔ cron, rows ↔
//    entries, the three distinct preview states, and the validation that
//    carries a FIELD with each message (REVIEW #6's anchors).
//  - jsdom for public/v2/pages/job-dialog.js against a mocked fetch — the
//    validation summary's focus anchors, the approval-waiting freeze, and the
//    property that matters most: a refused save keeps every value.
//  - a bounds test that reads lib/validate.js rather than re-typing its
//    numbers, because one of this bead's three mockup copy bugs was a limit
//    quoted from the wrong field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  LIMITS, NOTIFY_OPTIONS, PRESETS, presetToCron, cronToPreset, entryToRow, rowToEntry,
  newRow, localInputToIso, isoToLocalInput, firesText, fmtFire, consequenceText,
  validateForm, formToBody, jobToForm,
} from '../public/v2/pages/job-form-logic.js';
import { OFFSET_MAX_MIN, JITTER_MAX_MIN, previewSchedule } from '../lib/validate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readV2 = (rel) => readFileSync(join(ROOT, 'public', 'v2', rel), 'utf8');

// ---------------------------------------------------------------- bounds

test('the dialog\'s limits are the server\'s limits, not a second opinion', () => {
  // The mockup said a 600-minute timeout was "above the maximum of 240" — 240
  // is OFFSET_MAX_MIN, a different field entirely. These are parsed from
  // lib/validate.js rather than re-typed, so the two cannot drift apart
  // silently the way the mockup did.
  const src = readFileSync(join(ROOT, 'lib', 'validate.js'), 'utf8');
  const bound = (name) => {
    const m = new RegExp(`intIn\\(job\\.${name},\\s*(\\d+),\\s*(\\d+)\\)`).exec(src);
    assert.ok(m, `lib/validate.js no longer bounds ${name} with intIn() — re-read it`);
    return [Number(m[1]), Number(m[2])];
  };
  assert.deepEqual(LIMITS.timeoutMin, bound('timeoutMin'));
  assert.deepEqual(LIMITS.retryCount, bound('retryCount'));
  assert.deepEqual(LIMITS.retryDelayMin, bound('retryDelayMin'));
  // These two come from exported constants, so they are compared directly.
  assert.deepEqual(LIMITS.offsetMin, [0, OFFSET_MAX_MIN]);
  assert.deepEqual(LIMITS.jitterMin, [0, JITTER_MAX_MIN]);
  // …and the timeout maximum is emphatically not 240.
  assert.equal(LIMITS.timeoutMin[1], 1440);
});

test('the notify options are exactly the three the server accepts', () => {
  const src = readFileSync(join(ROOT, 'lib', 'validate.js'), 'utf8');
  const m = /const NOTIFY = \[([^\]]*)\]/.exec(src);
  const server = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean).sort();
  assert.deepEqual(NOTIFY_OPTIONS.map((o) => o.value).sort(), server);
});

// -------------------------------------------------------------- presets

test('presetToCron produces the five-field expressions the server stores', () => {
  assert.equal(presetToCron({ preset: 'daily', time: '03:30' }), '30 3 * * *');
  assert.equal(presetToCron({ preset: 'weekdays', time: '06:00' }), '0 6 * * 1-5');
  assert.equal(presetToCron({ preset: 'weekly', time: '09:15', weekday: 3 }), '15 9 * * 3');
  assert.equal(presetToCron({ preset: 'hourly', time: '00:07' }), '7 * * * *');
});

test('cronToPreset round-trips every preset and refuses to nearly-match', () => {
  for (const p of PRESETS) {
    const expr = presetToCron({ preset: p.id, time: '03:30', weekday: 2 });
    const back = cronToPreset(expr);
    assert.equal(back?.preset, p.id, `${p.id} did not round-trip (${expr})`);
  }
  assert.equal(cronToPreset('30 3 * * 1,3,5'), null, 'a multi-day list is not a preset');
  assert.equal(cronToPreset('*/5 * * * *'), null, 'a step expression is not a preset');
  // A six-field expression is valid cron (the 6th is seconds) and is NOT a
  // preset — it must open on the Cron tab with its text intact, never be
  // "nearly" matched onto daily and silently rewritten on save.
  assert.equal(cronToPreset('0 1 * * * 6'), null);
});

test('entryToRow opens an unrepresentable cron on the Cron tab with its text intact', () => {
  const row = entryToRow({ type: 'cron', expr: '*/5 9-17 * * 1-5' });
  assert.equal(row.kind, 'cron');
  assert.equal(row.expr, '*/5 9-17 * * 1-5');
  // …and a representable one opens on Preset.
  assert.equal(entryToRow({ type: 'cron', expr: '30 3 * * *' }).kind, 'preset');
  assert.equal(entryToRow({ type: 'afterReset', window: 'seven_day', offsetMin: 9, jitterMin: 4 }).kind, 'afterReset');
  assert.equal(entryToRow({ type: 'once', at: '2030-01-01T03:30:00.000Z' }).kind, 'once');
});

test('rowToEntry produces exactly the shapes lib/validate.js accepts', () => {
  assert.deepEqual(rowToEntry({ kind: 'cron', expr: ' 0 3 * * * ' }), { type: 'cron', expr: '0 3 * * *' });
  assert.deepEqual(rowToEntry({ kind: 'preset', preset: 'daily', time: '03:30' }), { type: 'cron', expr: '30 3 * * *' });
  assert.deepEqual(
    rowToEntry({ kind: 'afterReset', window: 'five_hour', offsetMin: 3, jitterMin: 2 }),
    { type: 'afterReset', window: 'five_hour', offsetMin: 3, jitterMin: 2 },
  );
});

test('a schedule survives a round-trip through the dialog unchanged', () => {
  // The property that stops an edit from silently rewriting a schedule the
  // reader never touched. previewSchedule() is the server's own parser, so
  // asserting it gives the same answer for both is stronger than comparing
  // two strings.
  for (const entry of [
    { type: 'cron', expr: '30 3 * * *' },
    { type: 'cron', expr: '*/5 9-17 * * 1-5' },
    { type: 'cron', expr: '0 6 * * 1-5' },
    { type: 'afterReset', window: 'five_hour', offsetMin: 3, jitterMin: 2 },
  ]) {
    const back = rowToEntry(entryToRow(entry));
    assert.deepEqual(back, entry, `${JSON.stringify(entry)} did not round-trip`);
  }
  // And a five-field cron the builder produced is genuinely parseable by the
  // scheduler, not merely string-equal to something.
  const { next } = previewSchedule({ type: 'cron', expr: presetToCron({ preset: 'weekly', time: '09:15', weekday: 3 }) }, 3);
  assert.equal(next.length, 3);
});

test('datetime-local round-trips through local wall-clock, not string surgery', () => {
  // The ISO is UTC, so its DATE half legitimately differs from the local one
  // in any zone east of Greenwich — asserting the literal string would be
  // asserting the test machine's offset. What must hold is the round-trip.
  const iso = localInputToIso('2030-06-01T03:30');
  assert.match(iso, /^\d{4}-\d\d-\d\dT\d\d:\d\d/);
  assert.equal(isoToLocalInput(iso), '2030-06-01T03:30');
  assert.equal(localInputToIso(''), '');
  assert.equal(isoToLocalInput('nonsense'), '');
});

// -------------------------------------------------------------- preview

test('firesText keeps the three preview states apart', () => {
  // The distinction the bead's live probe established: an EMPTY next[] with
  // unknown:false is a final answer (a spent once-entry), while unknown:true
  // means no time is knowable yet. Collapsing them tells a reader their
  // reset-anchored job is dead when it is merely unmeasured.
  const listed = firesText({ next: ['2030-01-01T03:30:00.000Z'], unknown: false });
  assert.match(listed.text, /^next fires: /);
  assert.equal(listed.tone, 'ok');

  const spent = firesText({ next: [], unknown: false });
  assert.match(spent.text, /will not fire again/);
  assert.equal(spent.spent, true);
  assert.ok(!spent.unknown);

  const unknown = firesText({ next: [], unknown: true });
  assert.match(unknown.text, /unknown/);
  assert.equal(unknown.unknown, true);
  assert.ok(!unknown.spent);
  assert.notEqual(spent.text, unknown.text, 'the two empty cases must not read the same');

  // A 400 renders croner's own sentence, never a hand-authored one.
  const bad = firesText({ error: 'CronPattern: invalid configuration format' });
  assert.equal(bad.tone, 'bad');
  assert.match(bad.text, /CronPattern/);
});

test('fmtFire switches to a date beyond the coming week', () => {
  const now = Date.parse('2026-08-01T12:00:00');
  assert.match(fmtFire('2026-08-02T03:30:00', now), /^Sun 03:30$/);
  assert.match(fmtFire('2026-09-14T03:30:00', now), /^14 Sep 03:30$/);
});

test('consequenceText counts schedules client-side and names the approval', () => {
  const t = consequenceText({ isEdit: false, count: 2, preview: { next: ['2030-01-01T03:30:00.000Z'], unknown: false } });
  assert.match(t, /Creating a job asks for your approval \(Touch ID\)/);
  assert.match(t, /2 schedules/);
  assert.match(t, /next fire/);
  assert.match(consequenceText({ isEdit: true, count: 1, preview: null }), /^Saving a job/);
  assert.match(consequenceText({ isEdit: false, count: 1, preview: { next: [], unknown: true } }), /unknown until the reset time is read/);
  assert.match(consequenceText({ isEdit: false, count: 1, preview: { next: [], unknown: false } }), /nothing will fire/);
});

// ----------------------------------------------------------- validation

const baseForm = () => ({
  type: 'claude', name: 'Nightly changelog', cwd: '~/proj',
  params: { prompt: 'do the thing' },
  rows: [newRow()],
  enabled: true, timeoutMin: 30, retryCount: 1, retryDelayMin: 10,
  notify: 'failure', ignoreGuard: false, minHeadroomPct: '',
});
const FIELDS = [{ key: 'prompt', label: 'Goal prompt', type: 'textarea', required: true }];

test('a well-formed job validates clean', () => {
  assert.deepEqual(validateForm(baseForm(), { fields: FIELDS }), []);
  // 600 minutes is VALID — the mockup called it "above the maximum of 240",
  // quoting OFFSET_MAX_MIN, a different field's limit entirely.
  assert.deepEqual(validateForm({ ...baseForm(), timeoutMin: 600 }, { fields: FIELDS }), []);
});

test('every validation message carries the field it belongs to (REVIEW #6)', () => {
  const f = baseForm();
  f.name = '   ';
  f.cwd = '';
  f.params.prompt = '';
  // NOT 600 — that is the mockup's example, and it is only out of range under
  // the mockup's WRONG maximum of 240. The real bound is 1..1440, so 600 is a
  // perfectly good timeout. Using the mockup's number here made this test pass
  // for the wrong reason until the assertion below caught it.
  f.timeoutMin = 2000;
  const errs = validateForm(f, { fields: FIELDS });
  const byField = Object.fromEntries(errs.map((e) => [e.field, e.message]));
  assert.ok(byField.name, 'the empty name is anchored to `name`');
  assert.ok(byField.cwd);
  assert.ok(byField['params.prompt'], 'a required extension field is anchored to params.<key>');
  assert.ok(byField.timeoutMin);
  // The number quoted is the server's, not the mockup's 240.
  assert.match(byField.timeoutMin, /1–1440/);
  for (const e of errs) assert.ok(e.field, `"${e.message}" has no field to anchor to`);
});

test('validation never guesses whether a cron expression is valid', () => {
  // croner accepts 5 OR 6 fields; the mockup's "6 fields — expected 5" is
  // wrong, and any client-side cron opinion would re-introduce it. A
  // non-empty expression is accepted here and judged by the server.
  const f = baseForm();
  f.rows = [{ kind: 'cron', expr: '0 1 * * * 6' }];
  assert.deepEqual(validateForm(f, { fields: FIELDS }), []);
  // …and the server agrees it is valid, which is the whole point.
  assert.equal(previewSchedule({ type: 'cron', expr: '0 1 * * * 6' }, 3).next.length, 3);
  // An EMPTY expression is checkable without an opinion about cron, so it is.
  f.rows = [{ kind: 'cron', expr: '   ' }];
  assert.equal(validateForm(f, { fields: FIELDS }).length, 1);
});

test('afterReset offsets and jitter are bounded exactly as the server bounds them', () => {
  const f = baseForm();
  f.rows = [{ kind: 'afterReset', window: 'five_hour', offsetMin: OFFSET_MAX_MIN + 1, jitterMin: 2 }];
  assert.equal(validateForm(f, { fields: FIELDS }).length, 1);
  f.rows = [{ kind: 'afterReset', window: 'five_hour', offsetMin: 3, jitterMin: JITTER_MAX_MIN + 1 }];
  assert.equal(validateForm(f, { fields: FIELDS }).length, 1);
  f.rows = [{ kind: 'afterReset', window: 'five_hour', offsetMin: OFFSET_MAX_MIN, jitterMin: JITTER_MAX_MIN }];
  assert.deepEqual(validateForm(f, { fields: FIELDS }), []);
});

test('formToBody keeps a single schedule an object, matching normalizeSchedule', () => {
  const f = baseForm();
  const one = formToBody(f);
  assert.ok(!Array.isArray(one.schedule), 'a one-schedule job must not be promoted to an array');
  f.rows = [newRow(), { kind: 'preset', preset: 'daily', time: '06:00' }];
  assert.equal(formToBody(f).schedule.length, 2);
});

test('formToBody omits an empty budget block rather than sending an empty object', () => {
  const f = baseForm();
  assert.equal(formToBody(f).params.budget, undefined);
  f.minHeadroomPct = 10;
  assert.deepEqual(formToBody(f).params.budget, { minHeadroomPct: 10 });
  f.ignoreGuard = true;
  assert.deepEqual(formToBody(f).params.budget, { ignoreGuard: true, minHeadroomPct: 10 });
});

test('jobToForm lifts params.budget out and clone renames without carrying an id', () => {
  const job = {
    id: 'j1', name: 'Nightly', type: 'claude', cwd: '~/p',
    schedule: { type: 'cron', expr: '30 3 * * *' },
    params: { prompt: 'x', budget: { ignoreGuard: true, minHeadroomPct: 12 } },
    timeoutMin: 45, retryCount: 2, retryDelayMin: 7, notify: 'always', enabled: false,
  };
  const f = jobToForm(job);
  assert.equal(f.ignoreGuard, true);
  assert.equal(f.minHeadroomPct, 12);
  assert.equal(f.params.budget, undefined, 'budget must not stay inside params or it round-trips twice');
  assert.equal(f.rows[0].kind, 'preset');
  assert.equal(f.enabled, false);
  assert.equal(jobToForm(job, { clone: true }).name, 'Nightly (copy)');
});

// --------------------------------------------------------- source gates

test('the dialog builds its fields from GET /api/extensions, never a hard-coded list', () => {
  // The mockup's Permission-mode options ("plan — read-only", "auto — full
  // autonomy") are not the ones extensions/claude declares. Anything typed
  // here would be an option the server rejects.
  const src = readV2('pages/job-dialog.js');
  assert.match(src, /\/api\/extensions/);
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const invented of ['plan — read-only', 'full autonomy', "'fable'", '"fable"']) {
    assert.ok(!stripped.includes(invented), `job-dialog.js hard-codes "${invented}", which no extension declares`);
  }
});

test('no /v2 module claims cron must have five fields', () => {
  // The precise wording the mockup got wrong, encoded so it cannot be typed
  // back in by a later bead.
  const bad = [/expected 5/, /5-field cron/, /must have (five|5) fields/i];
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['pages/job-dialog.js', 'pages/job-form-logic.js', 'pages/jobs-logic.js', 'pages/jobs.js']) {
    const src = stripComments(readV2(f));
    for (const re of bad) {
      assert.ok(!re.test(src), `${f} says ${re} — croner accepts 5 OR 6 fields (the 6th is seconds)`);
    }
  }
});

// ---------------------------------------------------------------- jsdom

function mountDom() {
  const dom = new JSDOM('<!doctype html><body><main><div id="v2-page"></div></main></body>', { url: 'http://localhost/v2/' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.localStorage = dom.window.localStorage;
  global.location = dom.window.location;
  global.history = dom.window.history;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  return dom;
}

const EXTENSIONS = [
  {
    id: 'claude',
    name: 'Claude prompt',
    fields: [
      { key: 'prompt', label: 'Goal prompt', type: 'textarea', rows: 4, required: true },
      { key: 'model', label: 'Model', type: 'select', default: 'default', advanced: true, options: [{ value: 'default', label: 'default' }, { value: 'sonnet', label: 'sonnet' }] },
      { key: 'permMode', label: 'Permissions', type: 'select', default: 'auto', advanced: true, options: [{ value: 'auto', label: 'auto — skip all prompts' }, { value: 'acceptEdits', label: 'accept edits' }] },
    ],
  },
  { id: 'command', name: 'Shell command', fields: [{ key: 'command', label: 'Command', type: 'textarea', rows: 2, required: true }] },
];

function mockFetch(routes) {
  const calls = [];
  global.fetch = async (path, opts = {}) => {
    const method = opts.method ?? 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path, method, body });
    const hit = routes[`${method} ${path}`] ?? routes[path];
    const res = typeof hit === 'function' ? hit(body) : hit;
    if (res === undefined) return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'no mock' }) };
    if (res?.__status) return { ok: false, status: res.__status, text: async () => JSON.stringify(res.payload) };
    return { ok: true, status: 200, text: async () => JSON.stringify(res) };
  };
  return calls;
}

const settle = (n = 3) => new Promise((r) => setTimeout(r, n));
const flushPreview = () => new Promise((r) => setTimeout(r, 320));

const baseRoutes = (over = {}) => ({
  '/api/extensions': { extensions: EXTENSIONS },
  'POST /api/schedule/preview': { next: ['2030-01-01T03:30:00.000Z'], unknown: false },
  ...over,
});

test('jsdom: the dialog opens with a schedule row, the advanced block and a consequence line', async () => {
  mountDom();
  mockFetch(baseRoutes());
  const { openJobDialog } = await import(`../public/v2/pages/job-dialog.js?open=${Date.now()}`);
  openJobDialog({});
  await settle(); await settle();

  const wrap = document.querySelector('.modalwrap');
  assert.ok(wrap, 'the dialog is mounted');
  assert.equal(wrap.querySelectorAll('.schedrow').length, 1);
  assert.ok(wrap.querySelector('.fset__t'), 'the Schedule fieldset has its legend');
  assert.match(wrap.querySelector('.modal__consequence').textContent, /asks for your approval/);
  // Advanced fields come from the manifest.
  const labels = [...wrap.querySelectorAll('.flabel')].map((n) => n.textContent);
  assert.ok(labels.includes('Permissions'), labels.join(' | '));
  assert.ok(labels.includes('Timeout'));
  // The close control is a real named icon button (REVIEW #5).
  const close = wrap.querySelector('.iconbtn');
  assert.equal(close.getAttribute('aria-label'), 'Close without saving');
});

test('jsdom: adding and removing schedules, and the last one cannot be removed', async () => {
  mountDom();
  mockFetch(baseRoutes());
  const { openJobDialog } = await import(`../public/v2/pages/job-dialog.js?rows=${Date.now()}`);
  openJobDialog({});
  await settle(); await settle();

  const wrap = document.querySelector('.modalwrap');
  const soleRemove = wrap.querySelector('.schedrow .iconbtn');
  assert.equal(soleRemove.disabled, true, 'a job needs at least one schedule');
  assert.match(soleRemove.getAttribute('data-tip'), /at least one schedule/);

  [...wrap.querySelectorAll('button')].find((b) => /Add another schedule/.test(b.textContent)).click();
  await settle();
  assert.equal(document.querySelectorAll('.schedrow').length, 2);
  assert.equal(document.querySelector('.schedrow .iconbtn').disabled, false, 'with two, either can go');

  document.querySelector('.schedrow .iconbtn').click();
  await settle();
  assert.equal(document.querySelectorAll('.schedrow').length, 1);
});

test('jsdom: the live preview fills each row and the footer, and renders croner\'s own error', async () => {
  mountDom();
  mockFetch(baseRoutes({
    'POST /api/schedule/preview': (body) => (
      body.schedules?.[0]?.expr === 'junk'
        ? { __status: 400, payload: { error: 'CronPattern: invalid configuration format' } }
        : { next: ['2030-01-01T03:30:00.000Z', '2030-01-02T03:30:00.000Z'], unknown: false }
    ),
  }));
  const { openJobDialog } = await import(`../public/v2/pages/job-dialog.js?prev=${Date.now()}`);
  openJobDialog({});
  await settle(); await settle();
  await flushPreview();

  assert.match(document.querySelector('.schedrow__fires').textContent, /next fires: /);
  assert.match(document.querySelector('.modal__consequence').textContent, /next fire/);

  // Switch the row to Cron and type something croner rejects.
  const segs = [...document.querySelectorAll('.schedrow .seg')];
  segs.find((s) => s.textContent === 'Cron').click();
  await settle();
  const expr = document.querySelector('.schedrow input[type=text]');
  expr.value = 'junk';
  expr.dispatchEvent(new window.Event('input', { bubbles: true }));
  await flushPreview();

  const fires = document.querySelector('.schedrow__fires');
  assert.match(fires.textContent, /CronPattern/, 'the server\'s own sentence, not a field count');
  assert.ok(!/expected 5/.test(fires.textContent));
});

test('jsdom: an invalid form shows an anchored summary and sends nothing', async () => {
  mountDom();
  const calls = mockFetch(baseRoutes());
  const { openJobDialog } = await import(`../public/v2/pages/job-dialog.js?invalid=${Date.now()}`);
  openJobDialog({});
  await settle(); await settle();

  calls.length = 0;
  document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(); await settle();

  assert.deepEqual(calls.filter((c) => c.path === '/api/jobs'), [], 'an invalid form is never submitted');
  const banner = document.querySelector('.banner--bad');
  assert.ok(banner, 'the summary appears');
  assert.match(banner.textContent, /wasn't saved/);
  assert.match(banner.textContent, /Everything you typed is still here/);
  assert.ok(banner.querySelectorAll('.errlist a').length >= 2, 'each message is a link');
});

test('jsdom: clicking a summary line focuses the field that caused it (REVIEW #6)', async () => {
  mountDom();
  mockFetch(baseRoutes());
  const { openJobDialog } = await import(`../public/v2/pages/job-dialog.js?anchor=${Date.now()}`);
  openJobDialog({});
  await settle(); await settle();

  document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(); await settle();

  const links = [...document.querySelectorAll('.errlist a')];
  const nameLink = links.find((a) => /needs a name/.test(a.textContent));
  assert.ok(nameLink, links.map((a) => a.textContent).join(' | '));
  nameLink.click();
  await settle();
  assert.equal(document.activeElement.id, 'jd-name', 'focus lands on the named field, not the summary');
  // …and that field is visibly marked, not merely listed.
  assert.equal(document.getElementById('jd-name').getAttribute('aria-invalid'), 'true');
});

test('jsdom: a valid form sends exactly the body the server expects', async () => {
  mountDom();
  const calls = mockFetch(baseRoutes({ 'POST /api/jobs': { id: 'j9' } }));
  const { openJobDialog } = await import(`../public/v2/pages/job-dialog.js?valid=${Date.now()}`);
  openJobDialog({
    job: {
      name: 'Nightly changelog', type: 'claude', cwd: '~/proj',
      schedule: { type: 'cron', expr: '30 3 * * *' },
      params: { prompt: 'draft it' }, timeoutMin: 30, retryCount: 1, retryDelayMin: 10, notify: 'failure',
    },
    clone: true,
  });
  await settle(); await settle();

  document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(); await settle(); await settle();

  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/jobs');
  assert.ok(post, 'the create request went out');
  assert.equal(post.body.name, 'Nightly changelog (copy)');
  assert.deepEqual(post.body.schedule, { type: 'cron', expr: '30 3 * * *' });
  assert.equal(post.body.params.prompt, 'draft it');
  assert.equal(post.body.timeoutMin, 30);
  // A clone creates; it never PUTs over the job it was cloned from.
  assert.deepEqual(calls.filter((c) => c.method === 'PUT'), []);
});

test('jsdom: the approval-waiting state freezes the form and removes the exits', async () => {
  mountDom();
  let release;
  const held = new Promise((r) => { release = r; });
  mockFetch(baseRoutes({
    'POST /api/jobs': () => held.then(() => ({ id: 'j9' })),
  }));
  // The held promise is returned from the route fn, so fetch resolves only
  // once we release it — the window in which the Touch ID prompt is up.
  global.fetch = (function wrap(orig) {
    return async (path, opts = {}) => {
      if (path === '/api/jobs' && (opts.method ?? 'GET') === 'POST') {
        await held;
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'j9' }) };
      }
      return orig(path, opts);
    };
  }(global.fetch));

  const { openJobDialog } = await import(`../public/v2/pages/job-dialog.js?wait=${Date.now()}`);
  openJobDialog({
    job: {
      name: 'Nightly', type: 'claude', cwd: '~/p', schedule: { type: 'cron', expr: '30 3 * * *' },
      params: { prompt: 'x' }, timeoutMin: 30, retryCount: 0, retryDelayMin: 5, notify: 'failure',
    },
    clone: true,
  });
  await settle(); await settle();

  document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(); await settle();

  const wrap = document.querySelector('.modalwrap');
  assert.match(wrap.textContent, /Waiting for your approval/);
  assert.match(wrap.textContent, /Denying keeps everything you typed/);
  assert.match(wrap.textContent, /Approvals are queued one at a time/);
  // The form is visible but frozen — the reader must see what they approve.
  const nameInput = document.getElementById('jd-name');
  assert.ok(nameInput, 'the fields are still on screen');
  assert.equal(nameInput.disabled, true, 'and are not editable while the request is in flight');
  // No exit: closing would not cancel the approval, and would lose the form.
  assert.equal([...wrap.querySelectorAll('button')].filter((b) => b.textContent === 'Cancel').length, 0);
  release();
  await settle(); await settle(); await settle();
});

test('jsdom: a refused save keeps every value and shows the server\'s own sentences', async () => {
  mountDom();
  mockFetch(baseRoutes({
    'POST /api/jobs': { __status: 400, payload: { errors: ['cwd must be an existing directory', 'invalid cron expression: junk'] } },
  }));
  const { openJobDialog } = await import(`../public/v2/pages/job-dialog.js?refused=${Date.now()}`);
  openJobDialog({
    job: {
      name: 'Nightly', type: 'claude', cwd: '~/nope', schedule: { type: 'cron', expr: '30 3 * * *' },
      params: { prompt: 'a prompt worth not retyping' }, timeoutMin: 30, retryCount: 0, retryDelayMin: 5, notify: 'failure',
    },
    clone: true,
  });
  await settle(); await settle();

  document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(); await settle(); await settle();

  const wrap = document.querySelector('.modalwrap');
  assert.ok(wrap, 'the dialog stays open on a refusal');
  // Everything typed survives — retyping a whole job is not an acceptable
  // outcome of a denied approval or a rejected field.
  assert.equal(document.getElementById('jd-name').value, 'Nightly (copy)');
  assert.match(wrap.textContent, /a prompt worth not retyping/);
  // The server's sentences are shown verbatim, and NOT turned into links to
  // fields they were never attributed to.
  assert.match(wrap.textContent, /cwd must be an existing directory/);
  const linkTexts = [...wrap.querySelectorAll('.errlist a')].map((a) => a.textContent);
  assert.ok(!linkTexts.some((t) => /cwd must be an existing directory/.test(t)),
    'an unanchored server sentence must not become a link that goes nowhere');
  // …and the form is editable again.
  assert.equal(document.getElementById('jd-name').disabled, false);
});

test('jsdom: a job\'s type cannot be changed on edit, and says why', async () => {
  mountDom();
  mockFetch(baseRoutes());
  const { openJobDialog } = await import(`../public/v2/pages/job-dialog.js?edit=${Date.now()}`);
  openJobDialog({
    job: {
      id: 'j1', name: 'Nightly', type: 'claude', cwd: '~/p',
      schedule: { type: 'cron', expr: '30 3 * * *' }, params: { prompt: 'x' },
    },
  });
  await settle(); await settle();

  const typeSegs = [...document.querySelectorAll('.modal .segs')][0].querySelectorAll('.seg');
  for (const seg of typeSegs) {
    assert.equal(seg.disabled, true);
    assert.match(seg.getAttribute('data-tip'), /cannot be changed/);
  }
});
