// Settings tab (claude-scheduler-btv.7 / B3). setrow grammar, sticky
// actionbar, danger zone (type-to-arm + Touch ID) — redesign/settings.html +
// redesign/settings-danger.html. public/v2/pages/settings-logic.js carries
// the pure diff-count/unit-conversion/arm-phrase helpers this file only
// wires to inputs. See public/v2/README.md for the frozen /v2 contract this
// page builds against (route registration, api()/guardedSubmit,
// data-mutating, iconBtn).
//
// Endpoints: GET/PUT /api/settings, GET /api/extensions (for the per-
// extension settings SPECS — labels/types/min/max; GET /api/settings only
// carries the current values, per server.js's extSettingsOut()), POST
// /api/cleanup, POST /api/uninstall.
//
// Two mockup details this page deliberately does NOT reproduce:
//  - redesign/settings.html's "Claude jobs" card has a "Default model"
//    <select>. There is no setting behind it: extensions/claude/index.js's
//    `settings` array is only [claudePath, maxConcurrent] — `model` is a
//    per-JOB field (that extension's `fields`), not a daemon-wide default
//    anything reads or writes. Inventing one here would be a fabricated
//    control that saves nothing; dropped rather than shipped as a lie.
//  - redesign/settings-danger.html's Uninstall row ships its confirm field
//    PRE-FILLED with the word "uninstall" (already armed). Both confirm
//    fields start EMPTY here instead — pre-arming would pre-satisfy the one
//    speed bump this page adds on top of the Touch ID prompt the server
//    still requires for every click (server.js's `grace: false` on both
//    /api/cleanup and /api/uninstall).
import {
  api, guardedSubmit, degradedReason, onAuthState,
} from '../api.js';
import {
  $, el, clear, pageHead, toast, setDisabledReason,
} from '../ui.js';
import { onRender } from '../router.js';
// Shared with the Runs page's blank states rather than a second copy of the
// same glyph — runs-icons.js is the /v2 icon module, not a runs-only one.
import { ICON_EMPTY } from './runs-icons.js';
import {
  msToSec, secToMs, USAGE_SHOW_OPTIONS, armPhraseMatches, countDirty, parseExtField,
} from './settings-logic.js';

// Core numeric keys — everything else read off a form control is either a
// string (usageShow/projectRoots/bdPath/worktreeRoot) or already the right
// type (the two switches read as booleans, softGraceMs's own reader already
// converts seconds->ms before this set is even consulted).
const NUMERIC_CORE_KEYS = new Set([
  'usagePollSec', 'usageWarnPct', 'usageCritPct',
  'reserveFiveHourPct', 'reserveWeeklyPct', 'awakeResetLeadMin', 'beadsPollSec',
]);

const state = {
  raw: null, // last GET /api/settings response
  extSpecs: [], // GET /api/extensions entries that declare settings
  coreReaders: {}, // key -> () => current form value (wire units/types)
  extReaders: {}, // extId -> { key -> () => current raw form value }
  dangerOpen: false, // persists across a Save/Discard within one visit; see settings() for reset-on-entry
};

let dangerHost = null;
let actionbarLine = null;
let saveBtn = null;
let discardBtn = null;
let cleanupInput = null;
let cleanupBtn = null;
let uninstallInput = null;
let uninstallBtn = null;
let authUnsub = null;
let routeWatcherArmed = false;

// ---------------- data ----------------

async function load() {
  let settings;
  let extRes;
  try {
    [settings, extRes] = await Promise.all([
      api('GET', '/api/settings'),
      api('GET', '/api/extensions'),
    ]);
  } catch {
    // api() already flips the global degraded banner, so a page that HAS
    // content just keeps it and lets the banner explain the staleness — the
    // overview-unreachable.html grammar.
    //
    // But on a FIRST load there is nothing to keep, and returning here left
    // #v2-page completely empty: a blank rectangle under a banner, with no
    // statement of what failed and no way to retry. Caught at the merge bar by
    // mounting this route into an already-unreachable daemon. Render the
    // stranded case explicitly instead.
    if (!state.raw) renderUnreachable();
    return;
  }
  state.raw = settings;
  state.extSpecs = (extRes.extensions ?? []).filter((e) => e.settings?.length);
  render();
}

// ---------------- row builders ----------------

function setRow(name, desc, control) {
  return el('div', { class: 'setrow' }, [
    el('div', {}, [
      el('span', { class: 'setrow__n' }, name),
      el('span', { class: 'setrow__d' }, desc),
    ]),
    el('div', { class: 'setrow__c' }, control),
  ]);
}

// Small mono numeric field with a trailing unit span (sec/%/min) — the
// mockup's `.field--sm.mono` + `.t-meta` pairing. `readers` is whichever
// registry (core or one extension's) this key belongs to.
function numField(readers, key, value, unit) {
  const input = el('input', { type: 'text', class: 'field field--sm mono', value: String(value ?? '') });
  readers[key] = () => input.value;
  input.addEventListener('input', updateActionbar);
  return unit ? [input, el('span', { class: 't-meta' }, unit)] : input;
}

// Wide mono path field — bdPath/worktreeRoot/claudePath's shape in the
// mockup (`.field--mono`, narrower font, capped width).
function pathField(readers, key, value) {
  const input = el('input', {
    type: 'text', class: 'field field--mono', style: 'max-width: 220px; font-size: 12px;', value: String(value ?? ''),
  });
  readers[key] = () => input.value;
  input.addEventListener('input', updateActionbar);
  return input;
}

function switchField(readers, key, checked, label) {
  const input = el('input', {
    class: 'switch', type: 'checkbox', checked, 'aria-label': label,
  });
  readers[key] = () => input.checked;
  input.addEventListener('change', updateActionbar);
  return input;
}

function selectField(readers, key, options, current) {
  const select = el('select', {}, options.map((o) => el('option', {
    value: o.value, selected: o.value === current ? true : undefined,
  }, o.label)));
  readers[key] = () => select.value;
  select.addEventListener('change', updateActionbar);
  return select;
}

function textareaField(readers, key, value) {
  // el()'s children are appended via document.createTextNode (see ui.js) —
  // never innerHTML — so a stored path containing "<" or "&" round-trips
  // safely with no escaping needed here.
  const ta = el('textarea', { class: 'field', style: 'min-height: 56px; max-width: 220px; font-size: 12px;' }, value ?? '');
  readers[key] = () => ta.value;
  ta.addEventListener('input', updateActionbar);
  return ta;
}

// ---------------- sections (core settings) ----------------

function usageSection(s) {
  const r = state.coreReaders;
  return el('section', { class: 'card', style: 'margin-bottom:16px;' }, [
    el('div', { class: 'card__head' }, el('h2', {}, 'Usage monitor')),
    el('div', { class: 'rows' }, [
      setRow('Show usage as', 'Meters on the Overview; the compact chips in the bar are always on.',
        selectField(r, 'usageShow', USAGE_SHOW_OPTIONS, s.usageShow)),
      setRow('Poll every', ['How often the daemon asks ', el('span', { class: 'mono' }, 'claude'), ' for usage. Checks are free but not instant.'],
        numField(r, 'usagePollSec', s.usagePollSec, 'sec')),
      setRow('Warn at', 'Meters turn amber. Nothing is blocked by this line — it only signals.',
        numField(r, 'usageWarnPct', s.usageWarnPct, '%')),
      setRow('Critical at', 'Meters turn red, and model-pinned jobs whose model is past this line are guard-skipped.',
        numField(r, 'usageCritPct', s.usageCritPct, '%')),
    ]),
  ]);
}

function budgetSection(s) {
  const r = state.coreReaders;
  return el('section', { class: 'card', style: 'margin-bottom:16px;' }, [
    el('div', { class: 'card__head' }, el('h2', {}, 'Budget & reserve')),
    el('div', { class: 'rows' }, [
      setRow('Budget guard', 'Scheduled fires that would eat into your reserve are skipped — recorded with the reason, never queued. Manual runs ask instead of refusing.',
        switchField(r, 'budgetGuard', !!s.budgetGuard, s.budgetGuard ? 'Turn budget guard off' : 'Turn budget guard on')),
      setRow('5-hour reserve', 'Scheduled work stops at this line, keeping the rest for your interactive use.',
        numField(r, 'reserveFiveHourPct', s.reserveFiveHourPct, '%')),
      setRow('Weekly reserve', 'The same line for the 7-day window.',
        numField(r, 'reserveWeeklyPct', s.reserveWeeklyPct, '%')),
      setRow('Hold on warning', 'When any window crosses the warn line, switch pause mode to Hold automatically.',
        switchField(r, 'pauseOnWarning', !!s.pauseOnWarning, s.pauseOnWarning ? 'Turn hold-on-warning off' : 'Turn hold-on-warning on')),
    ]),
  ]);
}

function pausingSection(s) {
  const r = state.coreReaders;
  // softGraceMs is stored/sent in ms but shown/typed in seconds — the reader
  // does the ms->sec->ms round trip so every other key can stay 1:1 with the
  // wire shape (see settings-logic.js's msToSec/secToMs).
  const graceInput = el('input', { type: 'text', class: 'field field--sm mono', value: String(msToSec(s.softGraceMs) ?? '') });
  r.softGraceMs = () => secToMs(Number(graceInput.value));
  graceInput.addEventListener('input', updateActionbar);
  return el('section', { class: 'card', style: 'margin-bottom:16px;' }, [
    el('div', { class: 'card__head' }, el('h2', {}, 'Pausing & stopping')),
    el('div', { class: 'rows' }, [
      setRow('Wind-down grace', 'After SIGINT, how long a run gets to finish its step before SIGTERM. The full ladder is SIGINT → SIGTERM → SIGKILL.',
        [graceInput, el('span', { class: 't-meta' }, 'sec')]),
      setRow('Wake before reset', 'Keep the Mac awake this long before a usage reset so after-reset jobs actually fire.',
        numField(r, 'awakeResetLeadMin', s.awakeResetLeadMin, 'min')),
    ]),
  ]);
}

function taskSourcesSection(s) {
  const r = state.coreReaders;
  return el('section', { class: 'card', style: 'margin-bottom:16px;' }, [
    el('div', { class: 'card__head' }, el('h2', {}, 'Task sources — beads')),
    el('div', { class: 'rows' }, [
      setRow('Project roots', ['Discover scans these folders for repos with a committed ', el('span', { class: 'mono' }, '.scheduler.json'), '. One path per line.'],
        textareaField(r, 'projectRoots', s.projectRoots)),
      setRow('Poll beads every', ['How often active projects re-read ', el('span', { class: 'mono' }, 'bd ready'), '.'],
        numField(r, 'beadsPollSec', s.beadsPollSec, 'sec')),
      setRow('bd binary', 'Changing this asks for your approval — it is the one way to swap what LaunchBox executes.',
        pathField(r, 'bdPath', s.bdPath)),
      setRow('Worktree root', 'Where per-bead worktrees live. Reaped after every run; orphans are swept.',
        pathField(r, 'worktreeRoot', s.worktreeRoot)),
    ]),
  ]);
}

// One card per extension that declares `settings` (today: just `claude`).
// Titled "Claude jobs" for that one specifically, matching the mockup;
// any future extension with settings gets a generic "<name> settings"
// title rather than a second hard-coded special case.
function extensionSection(ext, values) {
  const r = {};
  state.extReaders[ext.id] = r;
  const title = ext.id === 'claude' ? 'Claude jobs' : `${ext.name} settings`;
  const rows = ext.settings.map((spec) => {
    const v = values?.[spec.key] ?? spec.default ?? null;
    const control = spec.type === 'number' ? numField(r, spec.key, v, null) : pathField(r, spec.key, v);
    const desc = spec.key === 'claudePath' || spec.key === 'bdPath'
      ? 'Changing this asks for your approval, same as the task-source binary above.'
      : (spec.hint ?? '');
    return setRow(spec.label ?? spec.key, desc, control);
  });
  return el('section', { class: 'card', style: 'margin-bottom:16px;' }, [
    el('div', { class: 'card__head' }, el('h2', {}, title)),
    el('div', { class: 'rows' }, rows),
  ]);
}

// ---------------- actionbar ----------------

function readCore() {
  const out = {};
  for (const [k, read] of Object.entries(state.coreReaders)) {
    const v = read();
    out[k] = NUMERIC_CORE_KEYS.has(k) ? Number(v) : v;
  }
  return out;
}

function readExtensions() {
  const out = {};
  for (const ext of state.extSpecs) {
    const r = state.extReaders[ext.id] ?? {};
    const vals = {};
    for (const spec of ext.settings) {
      const raw = r[spec.key]?.() ?? '';
      const { value } = parseExtField(spec, raw);
      // A field that failed to parse (e.g. non-numeric maxConcurrent) still
      // rides along as whatever the user typed, raw — the server's own
      // validateFields() is the real gate and returns a 400 with a message
      // this page surfaces via guardedSubmit's failureToast; this client
      // never silently drops or invents a value to dodge that round trip.
      vals[spec.key] = value ?? raw;
    }
    out[ext.id] = vals;
  }
  return out;
}

function dirtyCount() {
  const core = readCore();
  let n = countDirty(state.raw, core, Object.keys(core));
  const ext = readExtensions();
  for (const [extId, vals] of Object.entries(ext)) {
    n += countDirty(state.raw?.extensions?.[extId] ?? {}, vals, Object.keys(vals));
  }
  return n;
}

// Save/Discard/Cleanup/Uninstall are each disabled for a BUSINESS reason
// (nothing to save; not armed) that must survive a healthy central sweep —
// exactly the case README.md/jobs.js's runBtn comment calls out: none of
// these four carry `data-mutating`, so main.js's blanket
// disableMutatingControls() never touches them and can't wrongly re-arm a
// button whose disable reason isn't connectivity. Each one folds
// degradedReason() into its OWN setDisabledReason() call instead, via the
// onAuthState subscription armed in ensureRouteWatcher() below.
function updateActionbar() {
  if (!actionbarLine) return;
  const n = dirtyCount();
  clear(actionbarLine);
  actionbarLine.append(
    'Changes apply as soon as you save — no restart. ',
    el('b', {}, String(n)),
    ` field${n === 1 ? '' : 's'} ${n === 1 ? 'differs' : 'differ'} from what is on disk.`,
  );
  const reason = degradedReason();
  setDisabledReason(saveBtn, reason || (n === 0 ? 'Nothing to save — every field matches what is on disk' : null));
}

function updateDangerArm() {
  const reason = degradedReason();
  if (cleanupBtn) {
    const armed = armPhraseMatches(cleanupInput.value, 'cleanup');
    setDisabledReason(cleanupBtn, reason || (armed ? null : 'Type "cleanup" (below) to arm this button'));
  }
  if (uninstallBtn) {
    const armed = armPhraseMatches(uninstallInput.value, 'uninstall');
    setDisabledReason(uninstallBtn, reason || (armed ? null : 'Type "uninstall" (below) to arm this button'));
  }
}

// ---------------- actions ----------------

async function onSave() {
  const body = { ...readCore(), extensions: readExtensions() };
  const ok = await guardedSubmit(saveBtn, () => api('PUT', '/api/settings', body), toast);
  if (ok) {
    toast('Settings saved', 'ok');
    await load(); // re-fetch so the form reflects exactly what is stored (rounding, clamping)
  }
}

function onDiscard() {
  render(); // rebuilds every input from state.raw — no network round trip needed
  toast('Discarded — reverted to what is on disk');
}

async function onCleanup() {
  if (!armPhraseMatches(cleanupInput.value, 'cleanup')) return; // belt-and-braces; button is disabled until armed
  const ok = await guardedSubmit(cleanupBtn, () => api('POST', '/api/cleanup'), toast);
  if (ok) {
    toast('Wiped — every job, run and log file is gone', 'ok');
    cleanupInput.value = '';
    updateDangerArm();
  }
}

async function onUninstall() {
  if (!armPhraseMatches(uninstallInput.value, 'uninstall')) return;
  const ok = await guardedSubmit(uninstallBtn, () => api('POST', '/api/uninstall'), toast);
  if (ok) toast('Uninstalling — the daemon will exit', 'ok');
}

// ---------------- danger zone (collapsed <-> expanded; redesign/settings.html vs settings-danger.html) ----------------

function renderDangerBody() {
  clear(dangerHost);
  if (!state.dangerOpen) {
    dangerHost.appendChild(el('section', { class: 'card' }, [
      el('div', { class: 'card__head' }, [
        el('h2', { style: 'color: var(--bad);' }, 'Danger zone'),
        el('button', {
          class: 'btn btn--danger',
          style: 'margin-left:auto;',
          onclick: () => { state.dangerOpen = true; renderDangerBody(); },
        }, 'Open…'),
      ]),
      el('div', { class: 'card__body' }, el('span', { class: 't-meta' },
        'Cleanup (wipe all jobs, runs and logs) and Uninstall (remove the daemon, its data and the binary). Both require typing a confirmation and your Touch ID — no grace window applies here.')),
    ]));
    cleanupBtn = null; uninstallBtn = null; cleanupInput = null; uninstallInput = null;
    return;
  }

  cleanupInput = el('input', { type: 'text', class: 'field field--mono', placeholder: 'type cleanup', style: 'max-width: 150px;' });
  cleanupBtn = el('button', { class: 'btn btn--danger', disabled: true }, 'Wipe everything');
  cleanupInput.addEventListener('input', updateDangerArm);
  cleanupBtn.addEventListener('click', onCleanup);

  uninstallInput = el('input', { type: 'text', class: 'field field--mono', placeholder: 'type uninstall', style: 'max-width: 150px;' });
  uninstallBtn = el('button', { class: 'btn btn--danger', disabled: true }, 'Uninstall — asks for Touch ID');
  uninstallInput.addEventListener('input', updateDangerArm);
  uninstallBtn.addEventListener('click', onUninstall);

  dangerHost.appendChild(el('section', { class: 'card' }, [
    el('div', { class: 'card__head' }, el('h2', { style: 'color: var(--bad);' }, 'Danger zone')),
    el('div', { class: 'rows' }, [
      setRow('Cleanup — wipe all jobs, runs and logs',
        ['Every job definition, the entire run history and all log files are deleted. Settings, projects and sessions stay. There is no undo. Type ',
          el('span', { class: 'mono' }, 'cleanup'), ' to arm the button, then approve with Touch ID.'],
        [cleanupInput, cleanupBtn]),
      setRow('Uninstall LaunchBox',
        ['Stops and removes the launchd agent, deletes ', el('span', { class: 'mono' }, '~/.claude-scheduler'),
          ' including this UI, and removes the binary. Your repos, beads and Claude sessions are untouched. Type ',
          el('span', { class: 'mono' }, 'uninstall'), ' to arm, then approve with Touch ID.'],
        [uninstallInput, uninstallBtn]),
    ]),
    el('div', { class: 'card__body', style: 'border-top: 1px solid var(--line-2);' },
      el('span', { class: 't-meta' }, 'The 5-minute approval grace window never applies to these two actions — every click re-asks.')),
  ]));
  updateDangerArm();
}

// ---------------- top-level render ----------------

// The first-load-failed state. Deliberately does NOT offer to edit anything:
// with no payload there is nothing to show the current value of, and a form
// pre-filled with blanks would invite saving empty settings over real ones.
// Naming what was attempted matters more than a generic "something broke" —
// this page reads two endpoints, and which one is unreachable is the daemon's
// business, so it says what it tried rather than diagnosing.
function renderUnreachable() {
  const page = $('#v2-page');
  if (!page) return;
  clear(page);
  const wrap = el('div', { style: 'max-width: 980px;' });
  wrap.appendChild(pageHead({ title: 'Settings' }));
  wrap.appendChild(el('div', { class: 'blank' }, [
    el('span', { class: 'blank__icon', html: ICON_EMPTY }),
    el('div', {}, [
      el('h4', {}, 'Settings could not be read'),
      el('p', {}, ['The daemon did not answer ', el('span', { class: 'mono' }, 'GET /api/settings'),
        '. Nothing is shown rather than a form full of blanks, because saving one would write those blanks over your real settings.']),
      el('div', { class: 'blank__act' }, [
        el('button', { class: 'btn', onclick: () => load() }, 'Try again'),
      ]),
    ]),
  ]));
  page.appendChild(wrap);
}

function render() {
  const page = $('#v2-page');
  if (!page) return;
  clear(page);
  state.coreReaders = {};
  state.extReaders = {};
  const s = state.raw;

  const wrap = el('div', { style: 'max-width: 980px;' });

  wrap.appendChild(pageHead({
    title: 'Settings',
    sub: ['Data in ', el('span', { class: 'mono' }, '~/.claude-scheduler'), ' · daemon via launchd ',
      el('span', { class: 'mono' }, 'com.claude-scheduler'), ' · UI theme follows the toggle in the bar'],
  }));

  if (s.approvalDegraded) {
    // Non-macOS host: lib/approval.js's available() fails the Touch ID gate
    // OPEN there (its own comment), so job create/edit, executable-path
    // changes and both danger-zone actions all proceed with NO prompt at
    // all. public/app.js (the old UI) already surfaces this — real,
    // already-fetched fields (approvalDegraded/approvalDegradedReason), not
    // new API surface — carried forward here so /v2 doesn't regress it.
    wrap.appendChild(el('p', { style: 'color: var(--warn); font-size: 13px; margin: -4px 0 16px;' },
      `⚠ Touch ID approval is unavailable on this platform, so gated actions proceed WITHOUT a confirmation prompt. ${s.approvalDegradedReason ?? ''}`.trim()));
  }

  wrap.appendChild(usageSection(s));
  wrap.appendChild(budgetSection(s));
  wrap.appendChild(pausingSection(s));
  wrap.appendChild(taskSourcesSection(s));
  for (const ext of state.extSpecs) wrap.appendChild(extensionSection(ext, s.extensions?.[ext.id]));

  actionbarLine = el('span', { class: 'actionbar__l' });
  discardBtn = el('button', { class: 'btn', onclick: onDiscard }, 'Discard changes');
  saveBtn = el('button', { class: 'btn btn--primary', onclick: onSave }, 'Save settings');
  wrap.appendChild(el('div', { class: 'actionbar', style: 'margin-bottom:16px;' }, [
    actionbarLine, el('span', { class: 'actionbar__spacer' }), discardBtn, saveBtn,
  ]));

  dangerHost = el('div', {});
  wrap.appendChild(dangerHost);
  renderDangerBody();

  page.appendChild(wrap);
  updateActionbar();
}

// ---------------- route lifecycle ----------------

function ensureRouteWatcher() {
  if (routeWatcherArmed) return;
  routeWatcherArmed = true;
  authUnsub = onAuthState(() => { updateActionbar(); updateDangerArm(); });
  onRender((route) => {
    if (route !== 'settings' && authUnsub) { authUnsub(); authUnsub = null; routeWatcherArmed = false; }
  });
}

export default function settings(params) {
  void params; // no deep-link query params defined for this route
  ensureRouteWatcher();
  load();
}
