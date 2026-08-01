// Formatting helpers shared by runs.js (the list) and runs-log.js (the
// drawer) — kept in their own module so neither page file imports the other
// (both import this one instead). btv.6 (B2).

const pad2 = (n) => String(n).padStart(2, '0');

// `trigger` is whatever lib/runner.js/lib/projects.js recorded on the run row
// (see runs.jobId column comment) — 'schedule'/'once' (scheduler.js),
// 'manual' (server.js POST /api/jobs/:id/run), 'retry' (runner.js's own
// retry reschedule), 'beads'/'burst' (lib/projects.js pollProject, called
// with trigger:'burst' from lib/burst.js). Unknown values pass through as-is
// rather than disappearing — a future trigger kind should read oddly, not vanish.
const TRIGGER_LABEL = {
  schedule: 'scheduled fire',
  once: 'scheduled fire',
  manual: 'manual',
  retry: 'retry',
  beads: 'project poll',
  burst: 'burst attempt',
};
export function triggerLabel(trigger) {
  return TRIGGER_LABEL[trigger] ?? trigger ?? 'trigger unknown';
}

export function fmtClock(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// "09:39:07" for something that started today, "Fri 07:30" otherwise — same
// distinction public/app.js's relTime()/fullTime() drew, reproduced here
// because /v2 owns its own modules (README.md) rather than importing that file.
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function fmtWhen(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? fmtClock(d) : `${DOW[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtDuration(ms) {
  if (ms == null || ms < 0) return null;
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${pad2(r)}s` : `${r}s`;
}

export const shortId = (id) => (id ? `${id.slice(0, 4)}…${id.slice(-2)}` : '');

// The status -> {colour class, dot form, label} table used to live here. It
// now lives in ../state-vocab.js, because B1 had written a second copy of it
// and the two had already drifted (claude-scheduler-bmn). runs.js and
// runs-log.js import statusMeta/ordinal from there directly.

// Partitions every known run status into the toolbar's 6 segments (All is the
// union). Chosen so the 5 non-"All" buckets are a strict partition — their
// counts always sum to All's — rather than the old UI's overlapping
// active/fail groupings.
export function statusBucket(status) {
  if (status === 'running' || status === 'queued') return 'active';
  if (status === 'ok') return 'ok';
  if (status === 'fail' || status === 'timeout' || status === 'killed') return 'fail';
  if (status === 'stopped') return 'stopped';
  if (status === 'skipped') return 'skipped';
  return 'other';
}

// meta.stopRung values written by lib/runner.js's requestStop() ladder.
const STOP_RUNG_TEXT = {
  dequeued: 'cancelled before it started',
  holding: 'waiting for in-flight subagents to settle',
  SIGINT: 'SIGINT sent — winding down at the next safe point',
  SIGTERM: 'still running after the grace window — SIGTERM sent',
  SIGKILL: 'still running — SIGKILL sent',
};
export function stopRungText(rung) {
  return STOP_RUNG_TEXT[rung] ?? (rung ? `stop requested (${rung})` : 'stop requested');
}

// ordinal() ("3rd in a row", from GET /api/v2/overview's own
// attention.items[].reason.streak — never a second streak-counter) also moved
// to ../state-vocab.js; there had been two copies and one had the teens wrong.
