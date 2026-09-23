// Pure (DOM-free) helpers for the Projects tab and project detail page
// (claude-scheduler-btv.9 / C2). Split out of projects.js/project.js the same
// way jobs-logic.js is split out of jobs.js, so the decisions worth testing —
// which action a project row offers, what a card is allowed to claim, how a
// burst's measured spend is expressed — are unit testable with no jsdom.
//
// The project state CHIP is not decided here: it comes from
// ../state-vocab.js's projectStateMeta(), the one place that owns the
// bd-busy > burst > state precedence (claude-scheduler-1ys). What stays local
// is what is genuinely C2's: the actions, the prose, and the refusals below.
//
// ---------------------------------------------------------------------------
// MOCKUP STRINGS THIS MODULE REFUSES TO RENDER, and why. Recorded here rather
// than in a comment on the site that wanted them, because this repo has now
// watched a refusal written in one page's comments fail to stop a second page
// making the same claim three times (see tests/frontend-v2-state-vocab.test.js'
// FORBIDDEN_CLAIMS, which this bead extends rather than repeating the mistake).
//
// • "4 ready of 23 open" (projects.html, project-detail.html's Ready-beads
//   fact). There is no open-bead count anywhere. lib/beads.js calls
//   `bd ready --json --label <autoLabel> --limit N` and nothing else that
//   counts issues; `readyFor()` returns `{count, at}` for the READY set only.
//   The ready half is real and is rendered; the "of N open" half is not.
//
// • "Not ready: 11 blocked by dependencies · 8 missing the scheduler-ok
//   label" (project-detail.html's coverage line). Same root cause — the
//   adapter never sees a bead that failed either filter, because `bd ready`
//   applies both server-side. The coverage line keeps only the half that is
//   true: how bead runs work (one at a time, disposable worktree,
//   TASK-COMPLETE or handed back).
//
// • "activated by you on 26 Jul" / "Paused by you on 28 Jul" / "Discovered on
//   29 Jul". The projects table (lib/db.js) has `createdAt` and `updatedAt`
//   and no per-transition stamp: `updatedAt` moves on every poll, so dating a
//   state change from it would be fiction. Registration date IS `createdAt`
//   and is rendered as "registered"; discovery and hand registration are not
//   distinguishable, so neither word is used for the other.
//
// • "Beads database locked by another process since 09:12". `busyStreak` is a
//   consecutive-miss COUNT, not a start time (lib/projects.js's busyStreak
//   Map). The count is rendered; the clock time is not.
//
// • "handed back" as a run state — REFUSAL LIFTED (claude-scheduler-dc9).
//   lib/projects.js's onDone now writes the bead's fate to runs.beadOutcome
//   (lib/db.js's BEAD_OUTCOMES), so /api/runs carries it and project.js draws
//   the chip via state-vocab.js's beadRunStateKey(). The mockup's SUBLINES
//   ("closed with TASK-COMPLETE", "returned to open with the agent's note
//   attached") are still not rendered: the note is written with `bd note` and
//   never read back.
//
// • "top priority P0 wb-221" on the LIST card. Not a data refusal — a cost
//   one. server.js's decorateProject is explicitly built to render a list
//   "WITHOUT touching the beads database", because one blocking `bd` call per
//   row is what makes a project list slow. The detail page fetches
//   /api/projects/:id/ready and shows the top bead there, where one call is
//   already being paid for.

import { projectStateMeta } from '../state-vocab.js';

export const pad2 = (n) => String(n).padStart(2, '0');

/** "09:40:31" — the poll stamps the mockups render in mono. */
export function fmtTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** "08:58" — minute precision, for a prose reference to an earlier poll. */
export function fmtHm(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "29 Jul" — a calendar date, for things that happened on a day rather than at a moment. */
export function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "4m ago" / "2h ago" / "3d ago" — relative, for a poll stamp next to a live count. */
export function relAgo(iso, now = Date.now()) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const secs = Math.round((now - then) / 1000);
  if (secs < 0) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * The ready count as words. `null` means "never successfully polled" — a
 * different fact from a real zero, and lib/projects.js's readyFor() keeps them
 * apart deliberately, so this must too. The old UI's readyText() draws the
 * same distinction; the wording here is the mockups' ("4 ready").
 */
export function readyText(project) {
  const count = project?.ready?.count;
  if (count == null) return 'ready unknown';
  return `${count} ready`;
}

/**
 * Whether a project's ready count is stale relative to its last poll — i.e.
 * the poll ran but did not manage to read the database, so the count on screen
 * is from an earlier one. Drives the mockups' "Ready count is from the last
 * good poll (08:58)" sentence, minus the invented "since" time.
 */
export function readyIsStale(project) {
  const readyAt = project?.ready?.at;
  const polledAt = project?.lastPollAt;
  if (!readyAt || !polledAt) return false;
  return new Date(readyAt).getTime() < new Date(polledAt).getTime();
}

/**
 * Which buttons a project row offers, and the tooltip each carries. The
 * mockups draw four different action sets across four cards; deriving them
 * from `state` in one place is what stops the list and the detail page
 * disagreeing about whether an `error` project can be paused.
 *
 * Mirrors the old UI's canActivate/canPause (public/projects.js) — an `error`
 * project is pausable, because `error` is written by the poller and pausing is
 * how you stop it retrying.
 *
 * `activate` is ALWAYS the primary, never-automatic action: it is the airlock
 * (server.js's PUT /api/projects/:id), and it is the only action here that
 * raises a system approval.
 */
export function projectActions(project) {
  const state = project?.state;
  const out = [{ act: 'poll', label: 'Poll now', tip: 'Re-read bd ready now' }];
  if (state === 'pending') {
    out.push({ act: 'activate', label: 'Activate…', primary: true, tip: 'Asks for Touch ID — this is the airlock' });
  } else if (state === 'paused') {
    out.push({ act: 'activate', label: 'Resume', tip: 'Start claiming its ready beads again' });
  } else {
    out.push({ act: 'pause', label: 'Pause', tip: 'Stop claiming beads; resuming later needs no approval' });
  }
  return out;
}

/**
 * True when resuming this project needs no approval. A project that has never
 * been activated must ask; one the human already activated and then paused must
 * not be made to authenticate again to undo their own pause.
 *
 * NOTE this is a UI *expectation*, not the enforcement — server.js's
 * PUT /api/projects/:id gates `state === 'active'` unconditionally. Kept
 * honest by only being used for the copy on the button, never to skip a step.
 */
export const isResume = (project) => project?.state === 'paused';

/**
 * The single-line summary under an active/paused project's name. Every clause
 * is a field that exists; nothing here is inferred.
 */
export function summaryBits(project, { pollSec = null } = {}) {
  const bits = [readyText(project)];
  const label = project?.config?.autoLabel;
  if (label) bits.push(`autoLabel ${label}`);
  const polled = fmtTime(project?.lastPollAt);
  bits.push(polled ? `polled ${polled}` : 'never polled');
  if (pollSec) bits.push(`every ${pollSec}s`);
  const held = project?.leases?.held ?? 0;
  if (held) bits.push(`${held} lease${held === 1 ? '' : 's'} held`);
  return bits;
}

/**
 * The banner a card shows, or null. One banner per card, chosen in the same
 * precedence order the chip uses, so the two can never contradict each other:
 * a row chipped `bd busy` explains busy, not its config.
 *
 * `kind` is the caller's icon/colour selector; `title`/`body` are the two
 * halves the mockups bold and unbold.
 */
export function cardBanner(project) {
  if (!project) return null;
  const streak = project.busyStreak ?? 0;
  if (streak > 0) {
    const stale = readyIsStale(project);
    const at = fmtHm(project.ready?.at);
    return {
      kind: 'busy',
      title: `Beads database busy — ${streak} poll${streak === 1 ? '' : 's'} in a row could not read it.`,
      body: 'Something else — most likely an interactive bd session — holds the lock. This is busy, not broken: '
        + 'LaunchBox backs off and retries on its own.'
        + (stale && at ? ` The ready count below is from the last good poll (${at}).` : ''),
    };
  }
  const configErrors = project.configErrors ?? [];
  if (configErrors.length) {
    return {
      kind: 'error',
      title: 'Its .scheduler.json cannot be used.',
      body: `${configErrors.join(' · ')} — nothing from this repo is eligible until the file parses.`,
    };
  }
  if (project.lastError) {
    return { kind: 'error', title: 'The last poll failed.', body: project.lastError };
  }
  // "Would contribute nothing yet" — but only said when it is *measured*, not
  // guessed. The mockup backs this claim with "none of its 11 open beads
  // carries that label", a count that does not exist (see the refusals at the
  // top of this file); a poll that completed and found zero ready beads is the
  // same conclusion from data we actually have.
  if (project.config?.autoLabel && project.ready?.count === 0 && project.lastPollAt) {
    return {
      kind: 'warn',
      title: 'Would contribute nothing yet.',
      body: `Its config declares autoLabel ${project.config.autoLabel}, and the last poll found no bead `
        + 'that is open, unblocked and carries that label. Label the beads you want automated, or '
        + 'activating this buys you nothing.',
    };
  }
  return null;
}

/**
 * The bd-priority pill class. The mockups map P0→pill--4 … P3→pill--1, i.e.
 * the pill number is the EMPHASIS, inverted from the priority number. bd
 * accepts P4 as well, which the mockups never draw — it clamps onto the same
 * lowest-emphasis pill as P3 rather than producing a `pill--0` that has no CSS.
 */
export function priorityPill(priority) {
  if (!Number.isFinite(priority)) return null;
  return { cls: `pill--${Math.min(4, Math.max(1, 4 - priority))}`, label: `P${priority}` };
}

/**
 * Sort ready beads into the order they would actually be claimed. The mockups
 * label this "claim order: priority, then age" — and that is genuinely what
 * lib/projects.js does with the `bd ready` result, so the label is safe to
 * render. Beads with no priority sort last; ties break oldest-first.
 */
export function claimOrder(beads = []) {
  return [...beads].sort((a, b) => {
    const pa = Number.isFinite(a?.priority) ? a.priority : Number.POSITIVE_INFINITY;
    const pb = Number.isFinite(b?.priority) ? b.priority : Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    const ta = new Date(a?.createdAt ?? 0).getTime() || 0;
    const tb = new Date(b?.createdAt ?? 0).getTime() || 0;
    return ta - tb;
  });
}

/** "2d old" — a bead's age, the right-hand column of the ready table. */
export function beadAge(bead, now = Date.now()) {
  const created = new Date(bead?.createdAt ?? 0).getTime();
  if (!created) return null;
  const days = Math.floor((now - created) / 86400000);
  if (days >= 1) return `${days}d old`;
  const hrs = Math.floor((now - created) / 3600000);
  if (hrs >= 1) return `${hrs}h old`;
  return 'new';
}

/** The meta line under a bead title: type, dependency counts, comments. */
export function beadMeta(bead) {
  return [
    bead?.type,
    bead?.dependencyCount ? `${bead.dependencyCount} dep${bead.dependencyCount === 1 ? '' : 's'}` : null,
    bead?.dependentCount ? `blocks ${bead.dependentCount}` : null,
    bead?.commentCount ? `${bead.commentCount} comment${bead.commentCount === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
}

// ---------------------------------------------------------------- bursts

const WINDOW_LABELS = { five_hour: '5-hour', seven_day: 'weekly' };
export const windowLabel = (k) => WINDOW_LABELS[k] ?? String(k ?? '').replace(/_/g, ' ');

/**
 * The burst strip's numbers. Two properties this must not misrepresent, both
 * inherited from the old UI's comment on the same screen:
 *
 *  1. the meter is MEASURED spend (`currentPct - startPct`), never the estimate
 *     that sized the timetable;
 *  2. WHICH bead runs is decided at each attempt, so the strip may never name
 *     the work it is about to do.
 *
 * Returns null for no active burst, so a caller can hide the strip in one test.
 */
export function burstSummary(active, { now = Date.now() } = {}) {
  if (!active) return null;
  const budgetPct = Number(active.budgetPct) || 0;
  const spent = Math.max(0, (active.currentPct ?? active.startPct ?? 0) - (active.startPct ?? 0));
  const slots = Array.isArray(active.slots) ? active.slots : [];
  const upcoming = slots.filter((s) => new Date(s).getTime() > now);
  return {
    id: active.id,
    budgetPct,
    spentPct: spent,
    // Clamped: a burst that overshoots its budget by a hair must not render a
    // meter wider than its track.
    fillPct: budgetPct > 0 ? Math.min(100, (spent / budgetPct) * 100) : 0,
    window: active.window,
    windowLabel: windowLabel(active.window),
    runs: active.runs ?? 0,
    attemptsLeft: upcoming.length,
    nextAt: upcoming[0] ?? null,
    projectIds: Array.isArray(active.projectIds) ? active.projectIds : [],
  };
}

/** Project ids in the live burst — what projectStateMeta()'s `inBurst` needs. */
export function burstProjectIds(active) {
  return new Set(Array.isArray(active?.projectIds) ? active.projectIds : []);
}

/**
 * The chip for one project row. Thin wrapper over the shared vocabulary that
 * supplies the `inBurst` term from the burst payload, so no page has to
 * remember that burst membership lives on the burst rather than the project.
 */
export function chipFor(project, burstIds) {
  return projectStateMeta({
    state: project?.state,
    busyStreak: project?.busyStreak ?? 0,
    inBurst: !!burstIds?.has?.(project?.id),
  });
}

/** Filter for the list's search box: name and path, the two things a human types. */
export function filterProjects(projects, query = '') {
  const q = query.trim().toLowerCase();
  if (!q) return projects;
  return projects.filter((p) => `${p.name ?? ''} ${p.path ?? ''}`.toLowerCase().includes(q));
}

/**
 * The page subline: "4 registered · 1 active · beads polled every 60s · bd 0.9.4".
 * `bd` version is omitted rather than guessed when the probe failed — the tab
 * reports that failure in its own banner instead of printing "bd unknown" next
 * to a healthy-looking count.
 */
export function listSubline(data) {
  const projects = data?.projects ?? [];
  const bits = [
    `${projects.length} registered`,
    `${projects.filter((p) => p.state === 'active').length} active`,
  ];
  if (data?.pollSec) bits.push(`beads polled every ${data.pollSec}s`);
  if (data?.bd?.version) bits.push(`bd ${bdVersionText(data.bd.version)}`);
  return bits;
}

/**
 * `bd --version` stdout is a whole sentence ("bd version 1.1.0 (Homebrew)"),
 * not a bare number — lib/beads.js's version() returns `res.stdout.trim()`
 * verbatim. The mockups show "bd 0.9.4", so the word is stripped rather than
 * printed twice ("bd bd version 1.1.0…", which is what the browser leg
 * actually showed). Reformatting only: anything that does not match the
 * expected shape is passed through untouched rather than guessed at.
 */
export function bdVersionText(raw) {
  const s = String(raw ?? '').trim();
  const m = /^bd\s+(?:version\s+)?(.+)$/i.exec(s);
  return m ? m[1] : s;
}
