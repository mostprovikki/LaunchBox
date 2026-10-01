// Pure decisions for the #inbox page (claude-scheduler-btv.19): grouping,
// per-item wording, the one primary action per kind, selection movement.
// No DOM here — tests/frontend-v2-inbox.test.js drives it directly.
//
// Input is GET /api/v2/inbox (lib/inbox.js): `waiting` rows are unmerged
// scheduler branches (lib/branches.js list() + projectId/projectName);
// `handedBack` rows are beads whose latest run came back handed-back or
// stranded. Both carry `title` from the bead's job row (btv.26); it is null
// for a bead the scheduler never minted a job for, and only then does a
// waiting item fall back to its tip commit and a handed-back one to its short id.
import { statusMeta } from '../state-vocab.js';

const pad2 = (n) => String(n).padStart(2, '0');
const commits = (n) => `${n} commit${n === 1 ? '' : 's'}`;

/** `system_migration-85ht.1` → `85ht.1` (launchbox.md §6: the project is on screen). */
export function shortBeadId(id) {
  if (!id) return '';
  return String(id).replace(/^.*-(?=[^-]+$)/, '');
}

export function clock(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// A tip subject ends "(<beadId>)" by the scheduled-bead-run commit convention;
// the id is already its own fact, so it is not repeated in the title.
const titleFromTip = (subject, beadId) => (subject ?? '')
  .replace(new RegExp(`\\s*\\(${String(beadId ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\s*$`), '').trim();

// The inbox pills are the inbox mockup's (docs/design/mockups/inbox-flavours.html
// Option 2), not run statuses: "merge" and "handed back". A stranded bead is
// bad — it is stuck in_progress and the scheduler will not retry it by itself.
function pillFor(kind, status) {
  if (kind === 'waiting') return { cls: 'ok', label: 'merge' };
  if (kind === 'stranded') return { cls: 'bad', label: 'stranded' };
  if (status && status !== 'ok') return { cls: 'bad', label: statusMeta(status).label };
  return { cls: 'warn', label: 'handed back' };
}

function whyFor(kind, row) {
  if (kind === 'waiting') {
    return row.behind > 0 ? `${commits(row.behind)} behind main — rebase before merging` : 'finished, not yet on main';
  }
  if (kind === 'stranded') return 'stuck in progress';
  if (row.status && row.status !== 'ok') return `run ended ${statusMeta(row.status).label}`;
  return 'no completion marker';
}

/** One API row → the item the page renders. `from` is 'waiting' | 'handedBack'. */
export function toItem(row, from, waitingRows = []) {
  const kind = from === 'waiting' ? 'waiting' : (row.kind === 'stranded' ? 'stranded' : 'handed-back');
  const project = row.projectName ?? row.projectId;
  const time = clock(row.finishedAt);
  let branch;
  let reason;
  let title;
  if (kind === 'waiting') {
    branch = [row.branch, commits(row.ahead), row.shortstat || null].filter(Boolean).join(' · ');
    reason = row.tipSubject ?? null;
    title = row.title ?? (titleFromTip(row.tipSubject, row.beadId) || shortBeadId(row.beadId) || row.branch);
  } else {
    const kept = waitingRows.find((w) => w.projectId === row.projectId && w.beadId === row.beadId);
    branch = kept ? `kept · ${commits(kept.ahead)}` : 'none unmerged';
    reason = row.reason ?? null;
    title = row.title ?? shortBeadId(row.beadId);
  }
  return {
    key: kind === 'waiting' ? `w:${row.projectId}:${row.branch}` : `h:${row.projectId}:${row.beadId}`,
    kind,
    projectId: row.projectId,
    beadId: row.beadId ?? null,
    runId: row.runId ?? null,
    title,
    meta: [project, time ?? (kind === 'waiting' ? commits(row.ahead) : null)].filter(Boolean).join(' · '),
    pill: pillFor(kind, row.status),
    facts: [
      ['Project', project],
      ['Bead', shortBeadId(row.beadId) || '—'],
      ['Branch', branch],
      ['Why', whyFor(kind, row)],
    ],
    why: whyFor(kind, row),
    reason,
  };
}

/** The two eyebrow groups, waiting first; an empty group is left out. */
export function inboxGroups(inbox) {
  const waitingRows = inbox?.waiting ?? [];
  const groups = [
    { label: 'Waiting to merge', items: waitingRows.map((r) => toItem(r, 'waiting')) },
    { label: 'Handed back', items: (inbox?.handedBack ?? []).map((r) => toItem(r, 'handedBack', waitingRows)) },
  ];
  return groups.filter((g) => g.items.length);
}

/** The one primary action for an item: Review for a branch, Log for a hand-back. */
export function primaryAction(item) {
  if (item.kind === 'waiting') return { label: 'Review', href: `#review?id=${encodeURIComponent(item.projectId)}` };
  return { label: 'Log', log: true };
}

/** Only a hand-back can be held; a branch is decided on the Review page. */
export const canHold = (item) => item.kind !== 'waiting';

export function moveSelection(index, delta, count) {
  if (count <= 0) return -1;
  return Math.min(count - 1, Math.max(0, index + delta));
}
