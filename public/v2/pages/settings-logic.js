// Pure (DOM-free) helpers for the Settings tab (claude-scheduler-btv.7 / B3).
// Split out of settings.js for the same reason jobs-logic.js is split from
// jobs.js (see its top comment): unit-testable without jsdom.
//
// GET/PUT settings shapes are server.js's (search "Settings:" — the comment
// above its app.get for the settings route), captured from a running
// instance, not hand-built (see this repo's memory:
// extract-shared-vocabulary-before-fanning-out and WIP.md's "shape-invention"
// note on B1's fixtures).

// `softGraceMs` is stored/sent in milliseconds but the mockup (and every
// human) thinks in seconds — the one field on this page with a unit
// mismatch between wire and display.
export const msToSec = (ms) => (Number.isFinite(ms) ? Math.round(ms / 1000) : null);
export const secToMs = (sec) => (Number.isFinite(sec) ? Math.round(sec * 1000) : null);

// server.js's USAGE_SHOW_MODES (lib/usage.js) are machine keys; these are the
// mockup's own words for them (redesign/settings.html's <select>). Kept here,
// not retyped in settings.js, so the value<->label pairing has one home.
export const USAGE_SHOW_OPTIONS = [
  { value: 'banner', label: 'Meters + chips' },
  { value: 'compact', label: 'Chips only' },
  { value: 'off', label: 'Off' },
];

// Type-to-arm: the input must match the phrase exactly once trimmed — no
// case-folding. Cleanup/uninstall are the two actions the spec says the
// 5-minute approval grace never applies to (server.js's `grace: false`); the
// typed phrase is this page's own extra speed bump, not a substitute for the
// Touch ID prompt PUT/POST still requires server-side. Never call this with
// a pre-filled default value — that would pre-satisfy the speed bump the
// phrase exists to enforce (see settings.js's danger-zone builder comment).
export function armPhraseMatches(input, phrase) {
  return String(input ?? '').trim() === phrase;
}

// How many of `keys` differ between the loaded settings and the live form
// values — the actionbar's "N fields differ from what is on disk" count.
// Compared as strings so `"80"` (a form field's value) and `80` (the server's
// number) never count as a spurious diff.
export function countDirty(original, current, keys) {
  let n = 0;
  for (const k of keys) {
    const a = original?.[k];
    const b = current?.[k];
    if (String(a ?? '') !== String(b ?? '')) n += 1;
  }
  return n;
}

// Parse one extension setting field's raw form value against its spec
// (lib/extensions.js's field shape: {key, type, min, max}) into the type
// PUT /api/settings expects. Returns {value, error} — error is a string the
// caller can show, never thrown, so one bad field doesn't stop the rest of
// the form from being read.
export function parseExtField(spec, raw) {
  if (spec.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { value: null, error: `${spec.label ?? spec.key} must be a number` };
    if (spec.min != null && n < spec.min) return { value: null, error: `${spec.label ?? spec.key} must be at least ${spec.min}` };
    if (spec.max != null && n > spec.max) return { value: null, error: `${spec.label ?? spec.key} must be at most ${spec.max}` };
    return { value: n, error: null };
  }
  return { value: String(raw ?? ''), error: null };
}
