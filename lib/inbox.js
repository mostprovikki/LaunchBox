// lib/inbox.js — the ONE definition of "needs me" (claude-scheduler-btv.22).
// docs/design/launchbox.md §6 "one number, one place": the Inbox list, its nav
// badge and Overview's needs-me count all read inboxItems(), so they cannot drift.
//
//   waiting     unmerged scheduler/* branches in every registered project
//               (lib/branches.js list(), which already drops merged ones).
//   handedBack  beads whose LATEST run came back 'handed-back' or 'stranded'.
//               A later 'closed' run — or a run in flight (outcome still NULL)
//               — takes the bead out; any earlier failure does not count.
import { listProjects } from './db.js';

const REASON_CHARS = 600;
const INBOX_OUTCOMES = new Set(['handed-back', 'stranded']);

// Latest run per (projectId, beadId), across however many job rows carry that
// identity. rowid breaks createdAt ties (two runs inside one millisecond).
const LATEST_BEAD_RUNS = `
  SELECT * FROM (
    SELECT r.id AS runId, r.status, r.finishedAt, r.meta, r.beadOutcome,
           json_extract(j.params, '$._projectId') AS projectId,
           json_extract(j.params, '$._beadId') AS beadId,
           ROW_NUMBER() OVER (
             PARTITION BY json_extract(j.params, '$._projectId'), json_extract(j.params, '$._beadId')
             ORDER BY r.createdAt DESC, r.rowid DESC
           ) AS rn
    FROM runs r JOIN jobs j ON j.id = r.jobId
    WHERE json_extract(j.params, '$._beadId') IS NOT NULL
  ) WHERE rn = 1`;

function reasonOf(meta) {
  let text = null;
  try { text = meta ? JSON.parse(meta)?.resultText : null; } catch { /* unreadable meta reads as absent */ }
  return typeof text === 'string' && text ? text.slice(-REASON_CHARS) : null;
}

export function handedBackItems(db, projects = listProjects(db)) {
  const names = new Map(projects.map((p) => [p.id, p.name]));
  return db.prepare(LATEST_BEAD_RUNS).all()
    .filter((r) => INBOX_OUTCOMES.has(r.beadOutcome))
    .map((r) => ({
      kind: r.beadOutcome,
      projectId: r.projectId,
      projectName: names.get(r.projectId) ?? null,
      beadId: r.beadId,
      runId: r.runId,
      finishedAt: r.finishedAt,
      status: r.status,
      reason: reasonOf(r.meta),
    }));
}

// A project whose repo git cannot read loses its branches, not the whole
// Inbox — and is named in `errors` so a short count is never silent.
export async function inboxItems(db, { branches, projects = listProjects(db) } = {}) {
  const waiting = [];
  const errors = [];
  if (branches) {
    const lists = await Promise.all(projects.map((p) => branches.list(p.path)
      .then((rows) => ({ p, rows }), (err) => ({ p, err }))));
    for (const { p, rows, err } of lists) {
      if (err) { errors.push({ projectId: p.id, projectName: p.name, error: err?.message ?? String(err) }); continue; }
      for (const r of rows) waiting.push({ projectId: p.id, projectName: p.name, ...r });
    }
  }
  const handedBack = handedBackItems(db, projects);
  return { asOf: new Date().toISOString(), count: waiting.length + handedBack.length, waiting, handedBack, errors };
}
