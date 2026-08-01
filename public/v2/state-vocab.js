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

  // Not a stored status: a live run whose stop was requested but which has not
  // finished yet (lib/runner.js's `stopping()` — entries with `stopRequested`
  // set; visible per-run as `meta.stopRung`). Derive it with runStateKey()
  // rather than testing `meta.stopRung` at each call site.
  //
  // Audited in redesign/pause-soft.html. It was already being worded three
  // ways before any page that needs it had even been built: the log drawer
  // appended "· stopping…", the runs list said "· winding down", and the
  // mockup drew a chip reading "stopping…". The mockup wins.
  stopping: { cls: 'muted', form: 'square', label: 'stopping…' },
});

// The run state to render, including the derived `stopping` case. Pass the run
// row from /api/runs; anything without a requested stop falls through to its
// stored status.
export function runStateKey(run) {
  if (!run) return 'never';
  if (run.status === 'running' && run.meta?.stopRung) return 'stopping';
  return run.status;
}

// ---------------------------------------------------------------------------
// Projects (claude-scheduler-1ys)
//
// The important structural fact, and the reason this is a function rather than
// a second lookup table: THE PROJECT CHIP IS NOT A PURE FUNCTION OF `state`.
// A project row carries `state` ∈ pending|active|paused|error (lib/db.js's
// PROJECT_STATES), and SEPARATELY a `busyStreak` counter (server.js's
// decorateProject / overview `automation.projects[]`) that is orthogonal to it,
// and it may also be a member of a live burst (the burst payload's
// `projectIds`, not a field on the project itself). The mockups draw one chip,
// so something has to decide which of the three wins. If that decision is left
// to the pages, C1, C2 and C3 will each pick their own — which is the whole
// defect this module exists to prevent.
export const PROJECT_VOCAB = Object.freeze({
  active: { cls: 'ok', form: '', label: 'active' },
  pending: { cls: 'muted', form: 'ring', label: 'pending' },
  paused: { cls: 'muted', form: 'square', label: 'paused' },

  // UNAUDITED — the one entry in this file with no mockup behind it.
  // PROJECT_STATES includes 'error' (lib/db.js) but no redesign/*.html ever
  // draws it, so its colour and label are a choice, not a transcription. `bad`
  // rather than the muted fallback because a project that cannot be polled at
  // all is a failure, not an inert row. Revisit if the design ever covers it.
  error: { cls: 'bad', form: '', label: 'error' },

  // Overlays: conditions, not values of `state`.
  bd_busy: { cls: 'warn', form: '', label: 'bd busy' },
  burst: { cls: 'info', form: '', label: 'burst' },
});

// Precedence when more than one applies. NOT derivable from the mockups — no
// mockup shows a project that is both bursting and bd-busy — so this is a
// documented decision rather than a transcription:
//
//   bd busy  >  burst  >  state
//
// `bd busy` first because it means the project's bead graph could not be read
// at all; every other thing the row claims (ready counts, burst progress) is
// stale while it holds, so masking a warn behind an info would be a lie of
// omission. `burst` second because it is live and transient and outranks the
// steady state underneath it.
export function projectStateMeta({ state, busyStreak = 0, inBurst = false } = {}) {
  const key = busyStreak > 0 ? 'bd_busy' : inBurst ? 'burst' : state;
  const v = PROJECT_VOCAB[key] ?? { ...UNKNOWN, label: state ?? UNKNOWN.label };
  return { cls: v.cls, form: v.form, label: v.label, dot: dotClass(v.form), key: PROJECT_VOCAB[key] ? key : 'unknown' };
}

// Mockup strings that are NOT rendered anywhere, because no field carries them.
// Recorded here so the next agent re-derives the finding instead of the string:
//
// • "handed back" (redesign/project-detail.html) — a bead whose run exited ok
//   WITHOUT signalling TASK-COMPLETE. lib/projects.js does emit 'handed-back'
//   and a `finished` event with `closed:false`, but server.js only console.logs
//   it: no run row column, and nothing on /api/runs, /api/projects/:id or
//   /api/v2/overview distinguishes closed from handed back. A bead row cannot
//   show this until the flag is persisted — see the follow-up bead. Same call
//   B1/B2 made when they dropped "hard stop was active" and "retry 2 of 2".

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
