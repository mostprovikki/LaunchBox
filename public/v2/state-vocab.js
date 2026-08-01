// The ONE definition of how a run state is rendered across /v2
// (claude-scheduler-bmn). Every page that shows a run state — Jobs, Runs, and
// the Overview/Projects/Sessions tabs still to come — imports this. Do not
// re-declare the table, the dot forms, or ordinal() in a page module;
// tests/frontend-v2-state-vocab.test.js fails the build if you do.
//
// Why this module exists: B1 (Jobs) and B2 (Runs) each independently wrote
// this encoding, and within hours the two copies had already diverged — status
// `fail` rendered as "failed" on one page and "fail" on the other, and one of
// the two ordinal() copies got the teens wrong ("11st"). Four more pages
// render these same states. One definition, imported, never retyped — the same
// argument that produced degradedReason() in A2.
//
// The encoding is REVIEW.md's colour-vision-safe rule: colour is never the
// only channel. Every entry carries a dot FORM (round / ring / square / solid)
// and a text LABEL as well as a colour class, and callers must render the
// label — the form is a bonus channel, not a replacement for words.
//
// Dot forms are the audited spec (redesign/jobs.html, redesign/runs.html) and
// their CSS lives in assets/system.css (.state__dot base) and
// assets/launchbox.css (.state__dot--ring/--square/--solid modifiers, which
// are only styled under .state--bad and .state--muted). '' means the base
// filled circle — what the mockups' prose calls "solid" for a bad-coloured
// state. The explicit 'solid' form is a different thing: a muted filled dot,
// used for a disabled job, distinguishing it from muted's default dashed ring.

// status -> { cls, form, label }.
//
//   cls   the `state--*` colour family (also used as the row's data-state rail)
//   form  the `state__dot--*` modifier suffix; '' = base filled circle
//   label the visible text; resolved against the mockups, never invented
//
// The eight run statuses below are the closed set lib/runner.js and lib/db.js
// actually write. `disabled` and `never` are Jobs-tab pseudo-states (a job, not
// a run, has those) and live here because Projects and Sessions will render
// them too.
export const STATE_VOCAB = Object.freeze({
  running: { cls: 'info', form: '', label: 'running' },
  queued: { cls: 'muted', form: 'ring', label: 'queued' },
  ok: { cls: 'ok', form: '', label: 'ok' },
  // 'fail', not 'failed' — redesign/runs.html:222 and every runs-log-*.html
  // mockup render the chip as "fail". jobs.html has no failing row at all, so
  // B1's "failed" had no mockup behind it.
  fail: { cls: 'bad', form: '', label: 'fail' },
  timeout: { cls: 'bad', form: 'ring', label: 'timeout' },
  killed: { cls: 'bad', form: 'square', label: 'killed' },
  stopped: { cls: 'muted', form: 'square', label: 'stopped' },
  skipped: { cls: 'muted', form: '', label: 'skipped' },

  disabled: { cls: 'muted', form: 'solid', label: 'disabled' },
  never: { cls: '', form: '', label: 'no runs yet' },
});

// A status outside the table is muted, not default-ink: "we do not know what
// this is" should read as inert rather than as an ordinary healthy row. Runs
// already did this; Jobs used '' (no colour, no rail). Unified on muted here.
// Unreachable with today's closed status set — this is the branch a future
// status lands in, and it should look unfamiliar rather than fine.
const UNKNOWN = { cls: 'muted', form: '', label: 'unknown' };

// The full `state__dot--*` class for a form, or '' for the base circle.
// Callers render `state__dot ${dotClass(form)}`.trim().
export const dotClass = (form) => (form ? `state__dot--${form}` : '');

// The single lookup. Returns { cls, form, label, dot } — `dot` is dotClass(form),
// pre-derived so a caller never rebuilds the class string by hand.
export function statusMeta(status) {
  const v = STATE_VOCAB[status] ?? { ...UNKNOWN, label: status ?? UNKNOWN.label };
  return { cls: v.cls, form: v.form, label: v.label, dot: dotClass(v.form) };
}

// "1st" / "3rd" / "11th" / "21st". Teens are always -th regardless of the last
// digit; this is the half that one of the two former copies got wrong. Guards
// non-finite input rather than emitting "NaNth" arithmetic.
export function ordinal(n) {
  if (!Number.isFinite(n)) return `${n}th`;
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
}
