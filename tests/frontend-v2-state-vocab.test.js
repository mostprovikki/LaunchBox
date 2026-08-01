// claude-scheduler-bmn: the /v2 run-state vocabulary has exactly one
// definition, and that definition is the one the audited mockups render.
//
// Background — this file exists because the vocabulary was written twice.
// B1 (Jobs) and B2 (Runs) each independently encoded status -> {colour class,
// dot form, label}. Within hours the copies had drifted: status `fail`
// rendered as "failed" on Jobs and "fail" on Runs, and one of the two
// ordinal() copies got the teens wrong ("11st"). Nothing was testing that the
// two tables agreed, and four more pages (Overview, Projects, Sessions) render
// the same states. The three tests below are the gate that keeps a third copy
// from ever being written.
//
// Note on what is NOT covered: the mockups also render a *project/bead* state
// family ("active", "pending", "bd busy", "handed back", "stopping…") that is
// not a run status. That is a second vocabulary, C2/C3 territory, and it
// should get the same treatment before Projects and Sessions fan out — see
// the follow-up bead rather than quietly folding it into this table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, relative } from 'node:path';
import { JSDOM } from 'jsdom';

import { STATE_VOCAB, statusMeta, dotClass, ordinal } from '../public/v2/state-vocab.js';
import { computeRowState } from '../public/v2/pages/jobs-logic.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V2 = join(ROOT, 'public', 'v2');
const REDESIGN = join(ROOT, 'redesign');
const VOCAB_MODULE = 'state-vocab.js';

// The eight statuses lib/runner.js and lib/db.js actually write to a run row.
// STATE_VOCAB also carries the Jobs pseudo-states (disabled/never), which are
// job facts rather than run statuses and so are not asserted against mockup
// run rows here.
const RUN_STATUSES = ['running', 'queued', 'ok', 'fail', 'timeout', 'killed', 'stopped', 'skipped'];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const jsFiles = () => walk(V2).filter((p) => p.endsWith('.js')).map((p) => relative(V2, p));
const read = (rel) => readFileSync(join(V2, rel), 'utf8');

// ---------------- single source ----------------

test('no /v2 module outside state-vocab.js re-declares the status table', () => {
  // Signature of a copied table: three or more run statuses used as object
  // keys whose VALUE is rendering — a colour family, a dot class, a label.
  //
  // Two earlier versions of this check were wrong and both were caught by
  // mutation, which is the only reason they aren't still here. Anchoring to
  // the start of a line let a one-line `{ running: 1, ok: 2, ... }` through.
  // Counting bare status keys instead flagged runs.js's toolbar counter
  // `{ all, active, ok, fail, stopped, skipped }`, which shares four names
  // with the status set but maps them to integers, not to rendering. Requiring
  // the value to look like rendering separates the two.
  //
  // `case 'ok':` is stripped first so a switch on status is not mistaken for a
  // table; statusBucket()'s `status === 'fail'` carries no colon and never matches.
  // "Rendering" is a colour family, a dot class, a {cls,dot,label} record, or
  // a bare string — `fail: 'failed'` is a label table and must be caught too,
  // since a label is the thing that actually drifted. Integers (the toolbar
  // counter) are not rendering.
  const RENDERING = /^\s*['"]|['"](info|muted|bad|warn|ok)['"]|state__dot|\blabel\s*:|\bcls\s*:|\bdot\s*:/;
  const offenders = [];
  for (const f of jsFiles()) {
    if (f === VOCAB_MODULE) continue;
    const src = read(f).replace(/\bcase\s+['"][^'"]*['"]\s*:/g, '');
    const keyed = new Set();
    for (const m of src.matchAll(/['"]?\b(running|queued|ok|fail|timeout|killed|stopped|skipped)\b['"]?\s*:([^,;\n]{0,100})/g)) {
      if (RENDERING.test(m[2])) keyed.add(m[1]);
    }
    // Threshold is 3, so a two-status snippet still slips through. That is a
    // known and accepted limit — verified by mutation, not assumed: a 2-key
    // `{ fail: 'failed', timeout: 'timed out' }` does NOT fail this test.
    // Three is low enough to catch any real table and high enough to leave the
    // toolbar counter alone.
    if (keyed.size >= 3) offenders.push(`${f} (keys: ${[...keyed].sort().join(', ')})`);
  }
  assert.deepEqual(offenders, [], `import statusMeta from state-vocab.js instead of re-declaring the table:\n${offenders.join('\n')}`);
});

test('no /v2 module outside state-vocab.js hard-codes a dot-form class or declares its own ordinal()', () => {
  const dotOffenders = [];
  const ordinalOffenders = [];
  for (const f of jsFiles()) {
    if (f === VOCAB_MODULE) continue;
    const src = read(f);
    if (/state__dot--/.test(src)) dotOffenders.push(f);
    if (/\b(?:function|const|let|var)\s+ordinal\b/.test(src)) ordinalOffenders.push(f);
  }
  assert.deepEqual(dotOffenders, [], 'build dot classes with dotClass()/statusMeta().dot, never a literal state__dot--*');
  assert.deepEqual(ordinalOffenders, [], 'import ordinal() from state-vocab.js — the second copy is how "11st" shipped');
});

// ---------------- the table is the mockups' table ----------------

test('every run status renders exactly as the audited mockups render it', () => {
  // Parse the mockups rather than restating their values: a golden table
  // retyped here would only prove this file agrees with itself, which is the
  // exact failure that let "failed" ship in the first place.
  const observed = new Map(); // label -> Set("cls|form")
  const sources = new Map(); // label -> file that showed it
  for (const name of readdirSync(REDESIGN).filter((f) => f.endsWith('.html'))) {
    const doc = new JSDOM(readFileSync(join(REDESIGN, name), 'utf8')).window.document;
    for (const chip of doc.querySelectorAll('.state')) {
      const label = chip.textContent.trim();
      const cls = [...chip.classList].find((c) => c.startsWith('state--'))?.slice('state--'.length) ?? '';
      const dot = chip.querySelector('.state__dot');
      if (!dot) continue;
      const form = [...dot.classList].find((c) => c.startsWith('state__dot--'))?.slice('state__dot--'.length) ?? '';
      if (!observed.has(label)) { observed.set(label, new Set()); sources.set(label, name); }
      observed.get(label).add(`${cls}|${form}`);
    }
  }

  assert.ok(observed.size > 5, 'mockup parse found almost nothing — the selector, not the design, is probably wrong');

  for (const status of RUN_STATUSES) {
    const v = STATE_VOCAB[status];
    assert.ok(v, `STATE_VOCAB is missing run status '${status}'`);
    const forLabel = observed.get(v.label);
    assert.ok(forLabel, `no mockup renders a chip labelled '${v.label}' — the label for status '${status}' was invented, not audited`);
    assert.deepEqual(
      [...forLabel], [`${v.cls}|${v.form}`],
      `status '${status}' must render as the mockups do (${sources.get(v.label)})`,
    );
  }
});

test('dotClass()/statusMeta() produce the class strings the CSS actually styles', () => {
  assert.equal(dotClass(''), '');
  assert.equal(dotClass('ring'), 'state__dot--ring');
  assert.equal(statusMeta('killed').dot, 'state__dot--square');
  assert.equal(statusMeta('fail').dot, '', 'fail is the base filled circle, no modifier');
  // An unfamiliar status must read as inert, and must keep its own name rather
  // than being relabelled "unknown" and losing the only clue to what it was.
  assert.deepEqual(statusMeta('teleported'), { cls: 'muted', form: '', label: 'teleported', dot: '' });
});

// ---------------- the two pages can no longer disagree ----------------

test('Jobs and Runs render the same label and dot form for the same status', () => {
  const now = new Date('2026-01-01T09:00:00Z').getTime();
  const empty = { attention: new Map(), running: new Map(), now };
  // 'fail' is the status that had actually drifted ("failed" vs "fail");
  // the rest are here so the next drift is caught the same way.
  for (const status of ['ok', 'fail', 'timeout', 'killed', 'stopped', 'skipped']) {
    const job = { id: 'j', enabled: true, lastRun: { status, startedAt: '2026-01-01T08:00:00Z', finishedAt: '2026-01-01T08:05:00Z' } };
    const jobsRow = computeRowState(job, empty);
    const runsChip = statusMeta(status);
    assert.equal(jobsRow.label, runsChip.label, `Jobs and Runs word status '${status}' differently`);
    assert.equal(jobsRow.dotForm, runsChip.form, `Jobs and Runs draw status '${status}' with different dot forms`);
    assert.equal(jobsRow.stateClass, runsChip.cls, `Jobs and Runs colour status '${status}' differently`);
  }
});

test('ordinal: teens are -th whatever the last digit, and non-finite input does not become "NaNth" arithmetic', () => {
  assert.equal(ordinal(1), '1st');
  assert.equal(ordinal(2), '2nd');
  assert.equal(ordinal(3), '3rd');
  assert.equal(ordinal(4), '4th');
  assert.equal(ordinal(11), '11th');
  assert.equal(ordinal(12), '12th');
  assert.equal(ordinal(13), '13th');
  assert.equal(ordinal(21), '21st');
  assert.equal(ordinal(111), '111th');
  assert.equal(ordinal(NaN), 'NaNth');
});
