// The /v2 interaction gates' RULES, pure and DOM-free so they can be unit
// tested and mutation-checked without a browser (claude-scheduler-btv.14 / E2).
// tools/qa/v2-interactions.mjs is the driver that collects measurements from a
// real Chrome and feeds them through these.
//
// Same split, and the same reason, as tools/qa/audit-rules.mjs: a rule you
// cannot unit test is a rule you cannot mutation-check, and a gate whose rules
// have quietly stopped catching things reports "clean" forever.
//
// THE RULE THAT SHAPES ALL OF THESE: a silent skip reads exactly like a pass.
// Every check below has an explicit "I could not measure this" outcome that is
// a FAILURE, not an absence — `notFound`, `neverOpened`, `noCandidates`. Two
// gates in the project this method came from printed green while measuring
// nothing at all.

// ------------------------------------------------------------- dialogs

/**
 * Every dialog must satisfy all of these. They are listed as data rather than
 * prose so the driver cannot quietly test three of five and still print ok.
 */
export const DIALOG_CONTRACT = Object.freeze([
  'opens',           // the real affordance opens it
  'role',            // role=dialog + aria-modal=true + a non-empty aria-label
  'focusInside',     // focus lands inside, not left behind on the opener
  'escapeCloses',
  'backdropCloses',
  'closeButtonCloses',
]);

export function evaluateDialog({ name, results }) {
  const findings = [];
  const at = (detail) => findings.push({ kind: 'dialog', surface: name, detail });
  if (!results) {
    at('the dialog was never measured — the driver could not reach it');
    return findings;
  }
  for (const key of DIALOG_CONTRACT) {
    if (!(key in results)) {
      // Missing is a failure, not a pass: a contract point the driver forgot
      // to measure must not read as satisfied.
      at(`"${key}" was not measured at all`);
      continue;
    }
    if (results[key] !== true) at(`"${key}" failed: ${describe(key, results[key])}`);
  }
  return findings;
}

function describe(key, value) {
  if (value === false) return 'did not hold';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// -------------------------------------------------------------- filters

/**
 * A filter box must narrow the list AND keep the caret where the reader left
 * it. Losing focus mid-word is the defect that makes a live filter unusable,
 * and it is invisible to any test that only checks the row count.
 *
 * `before`/`after` are row counts; `focusedId`/`caret` are read back from the
 * document after typing.
 */
export function evaluateFilter({ surface, before, after, query, focusedId, expectedId, caret, expectedCaret }) {
  const findings = [];
  const at = (detail) => findings.push({ kind: 'filter', surface, detail });
  if (before == null || after == null) {
    at('the row counts were never measured');
    return findings;
  }
  if (!(before > 0)) at(`nothing was listed before filtering, so "${query}" proved nothing`);
  else if (!(after < before)) at(`"${query}" did not narrow the list (${before} → ${after})`);
  if (after === 0) at(`"${query}" matched nothing — pick a query that exercises a match`);
  if (focusedId !== expectedId) at(`focus moved to ${focusedId || '(nothing)'} while typing; it must stay on ${expectedId}`);
  if (expectedCaret != null && caret !== expectedCaret) {
    at(`the caret jumped to ${caret} (expected ${expectedCaret}) — a re-render moved it mid-word`);
  }
  return findings;
}

// ------------------------------------------------------- keyboard / focus

/**
 * A focus indicator has to be VISIBLE, not merely present in the stylesheet.
 * Measured as a change between the element's resting and focused computed
 * style: an outline with a real width, or a box-shadow that appears.
 *
 * The UA default `outline: auto` counts — it is visible — but `outline: none`
 * with nothing replacing it does not, which is the common regression.
 */
export function hasVisibleFocusIndicator({ resting, focused, ancestorResting, ancestorFocused }) {
  const changed = (a, b) => {
    if (!a || !b) return false;
    const outlineW = parseFloat(b.outlineWidth) || 0;
    if (outlineW > 0 && b.outlineStyle !== 'none') return true;
    if ((b.boxShadow || 'none') !== (a.boxShadow || 'none') && (b.boxShadow || 'none') !== 'none') return true;
    return (b.borderColor || '') !== (a.borderColor || '');
  };
  // The ring may legitimately live on an ANCESTOR via :focus-within — the
  // search box rings its `.search` wrapper and sets `outline: 0` on the input
  // itself. Judging the input alone reported a correctly-indicated control as
  // unindicated, which is a false red, and a gate with false reds is a gate
  // everyone learns to ignore.
  return changed(resting, focused) || changed(ancestorResting, ancestorFocused);
}

export function evaluateKeyboardWalk({ stops = [], minStops = 8 }) {
  const findings = [];
  const at = (detail) => findings.push({ kind: 'keyboard', surface: 'tab-walk', detail });
  if (stops.length < minStops) {
    // A walk that found almost nothing is a walk that did not run.
    at(`the tab walk reached only ${stops.length} focusable controls (expected at least ${minStops}) — the walk did not really run`);
    return findings;
  }
  const seen = new Set();
  for (const s of stops) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    if (!s.visibleIndicator) at(`${s.key} takes focus with no visible focus indicator`);
  }
  return findings;
}

/**
 * REVIEW #5's other half: a `[data-tip]` control must show its tooltip to a
 * KEYBOARD user, not only on hover. Measured as the ::after pseudo-element's
 * opacity going to 1 under :focus-visible.
 */
export function evaluateFocusTooltip({ surface, selector, restingOpacity, focusedOpacity, content }) {
  const findings = [];
  const at = (detail) => findings.push({ kind: 'tooltip', surface, detail });
  if (restingOpacity == null || focusedOpacity == null) {
    at(`${selector}: the tooltip pseudo-element was never measured`);
    return findings;
  }
  if (!content || content === 'none' || content === '""') {
    at(`${selector}: the tooltip has no content — data-tip is empty or not rendered`);
  }
  if (!(Number(restingOpacity) < 0.5)) at(`${selector}: the tooltip is already visible at rest (opacity ${restingOpacity})`);
  if (!(Number(focusedOpacity) > 0.9)) {
    at(`${selector}: focusing it does not reveal the tooltip (opacity ${focusedOpacity}) — keyboard users never see the reason`);
  }
  return findings;
}

// --------------------------------------------------- daemon-down disabling

/**
 * REVIEW #2's contract, exercised from the consumer position: with the daemon
 * unreachable, EVERY control marked `data-mutating` must be disabled AND say
 * why. A disabled control with no reason is the thing the contract exists to
 * prevent — "a dead button that explains itself beats a live one that lies".
 *
 * `controls` are `{key, disabled, tip}` read after the API was blocked.
 */
export function evaluateDegraded({ controls = [], reasonPattern = /unavailable/i, minControls = 3 }) {
  const findings = [];
  const at = (detail) => findings.push({ kind: 'degraded', surface: 'daemon-down', detail });
  if (controls.length < minControls) {
    at(`only ${controls.length} data-mutating controls were found (expected at least ${minControls}) — the sweep had nothing to prove`);
    return findings;
  }
  for (const c of controls) {
    if (!c.disabled) at(`${c.key} is still live with the daemon unreachable`);
    else if (!reasonPattern.test(c.tip ?? '')) {
      at(`${c.key} is disabled but its tooltip does not say why ("${c.tip ?? ''}")`);
    }
  }
  return findings;
}

/** …and recovery: the same controls must come back, or the page is stuck dead. */
export function evaluateRecovery({ controls = [] }) {
  const findings = [];
  const at = (detail) => findings.push({ kind: 'recovery', surface: 'daemon-back', detail });
  if (!controls.length) {
    at('no controls were measured after recovery — the check did not run');
    return findings;
  }
  for (const c of controls) {
    if (c.disabled && !c.businessDisabled) {
      at(`${c.key} is still disabled after the daemon came back — the sweep does not recover`);
    }
  }
  return findings;
}

/** One verdict for the whole battery. Mirrors audit-rules.mjs's summarise(). */
export function summarise(findings = []) {
  const byKind = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  return { ok: findings.length === 0, findings, byKind };
}

/**
 * The dialogs this battery covers, and how to reach each. Listed here so a
 * dialog added without a gate is a visible omission rather than an invisible
 * one — `tests/qa-interactions.test.js` checks this list against the modules
 * that actually export an opener.
 */
export const V2_DIALOGS = Object.freeze([
  { name: 'job', route: '#jobs', openerText: /New job|Create the first job/, module: 'pages/job-dialog.js' },
  { name: 'burn-down', route: '#jobs', openerText: /Plan burn-down/, module: 'pages/plan-dialogs.js' },
  { name: 'burst', route: '#projects', openerText: /Start a burst/, module: 'pages/plan-dialogs.js' },
]);
