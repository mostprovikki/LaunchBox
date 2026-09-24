# Scheduler-aware skills and the review queue — design

Date: 2026-09-24. Owner decisions recorded in the session that produced this document.

## Problem

LaunchBox (this repo) can run a project's beads unattended, but nothing upstream of it knows
that. Beads are written for a human who has the plan in their head; none carry the opt-in
label; a live session and a scheduled run can want the same bead; finished scheduled work
sits on a branch nobody is told about. Today's evidence: five projects were registered and
activated, 44 beads were ready across them, and zero were eligible, because none carried
`unattended`.

The owner wants this to hold in every project without re-explaining it each session:
beads written so someone with little context can finish them; the label applied by a rule;
attention asked for at sensible moments; live sessions and scheduled runs not colliding;
finished work surfaced and mergeable on request.

## Decisions

| question | decision |
|---|---|
| Label policy | Rule-based per bead; failed check recorded on the bead. |
| Bead depth | Two depths, `basic` and `detailed`; detailed is default for `unattended` beads. |
| Permission mode for scheduled runs | `auto`, but the work is confined to a per-bead worktree and branch; nothing lands on `main` without the owner. |
| Landing | Branch plus review queue. Merge is a human action, from the queue page or by asking a session. Auto-merge and PRs are out of scope. |
| Communication | Evidence note on the bead, review queue in LaunchBox, a WIP.md entry where the repo keeps one. Session-start briefing lists what finished while the owner was away. |
| Conflicts | The claim is the lock, both ways. A claimed bead leaves `bd ready`, so the scheduler skips it with no code change. |
| Attention | Ask "now or later" at session start and after a planning pass. Later means `bd defer --until`, no re-asking before that date. |
| Approach | Protocol in three global skills; mechanics in the scheduler. |

## Components

### 1. `bead-authoring` (global skill, `~/.claude/skills/bead-authoring/SKILL.md`)

Triggers: writing a plan or spec into beads in any repo with `.beads/`; the owner saying
"file these as beads"; the end of `superpowers:writing-plans`.

Behaviour:

- **Shape.** One epic per plan, children with `--parent`, real prerequisites as `blocks`.
  Every child carries four fields in its description: *why* (one paragraph), *done when*
  (verifiable by a stranger: a test name, a command and its expected output, or a file
  diff), *touches* (files or surface), *do not touch*.
- **Depth.** `basic` is the four fields. `detailed` adds, in the design field: ordered
  steps, the failing test to write first, and the expected diff shape. Default: detailed for
  beads that will carry `unattended`, basic otherwise. The owner overrides per plan ("file
  these basic").
- **Label rule.** A bead gets `unattended` only if every check passes; the first failed
  check is written into the design field as `unattended: no — <check>`:
  1. no decision inside it belongs to the owner (tech choice, scope call, UX judgement);
  2. done-when is checkable by a test, a script, or a diff, not by "looks right";
  3. needs no owner credentials, no live browser, no external account;
  4. it is a leaf, not an epic;
  5. it is not deferred and not flagged `bd human`.
- **Attention pass.** After filing, list unlabelled beads that need the owner and ask now or
  later, once. Later: `bd defer <id> --until=<date>`.
- **Config.** If the repo has `.beads/` but no `.scheduler.json`, copy the shape below, say
  so, and never activate. Registration with LaunchBox is offered, not done, unless asked.

### 2. `registered-repo-session` (global skill)

Triggers: session start in a repo containing `.scheduler.json`; the owner asking "what
happened here", "what needs me", or "merge <bead>".

Behaviour, in order, before other work:

1. **Briefing.** Beads touched by actor `claude-scheduler` since the last session in this
   repo: closed, handed back, and branches `scheduler/*` not merged into `main`, each with
   the bead title and the evidence note's first line. Last-session time comes from the
   newest transcript under `~/.claude/projects/<slug>/` older than the current one.
2. **Attention check.** Count handed-back and `bd human` beads not deferred; ask now or
   later once.
3. **Claim as lock.** `bd update <id> --claim` before touching a bead. If the claim fails
   because the scheduler holds it, refuse and name the holder. Never `--force`.
4. **Land and release.** On finishing a bead: close with evidence. On "merge <bead>": verify
   the branch's evidence note says gates passed, `git merge --ff-only scheduler/<name>`, close
   the bead if still open, note the merge on it. If fast-forward is impossible, say so and
   stop; rebasing scheduled work is a separate decision.
5. **Session end.** Ask before leaving a claimed bead `in_progress`; otherwise hand it back
   with a note.

### 3. `scheduled-bead-run` (global skill, named in the run prompt)

Behaviour inside the worktree:

- `bd -C <primary> show <id>`; if the bead is `detailed`, follow its steps and write its
  named failing test first.
- Do the work; run the repo's gates from `.scheduler.json` `gates` (falls back to `npm test`
  when a `package.json` has a test script, otherwise none, and the note says "no gates").
- Commit on the current branch with `<type>(<scope>): <title> (<beadId>)`. The commit is the
  deliverable; uncommitted edits are snapshotted by the scheduler but flagged as such.
- Write one note on the bead: files changed, gate command and its last lines, branch name,
  anything left open. Append a dated entry to `WIP.md` if the repo has one.
- Emit `TASK-COMPLETE: <id>` only if gates ran and passed. Blocked: no marker, one plain
  paragraph on what stopped it.

### 4. Scheduler changes (this repo)

Each is one bead under a new epic; order is the rollout order.

1. **Prompt names the skill and the gates.** `beadPrompt()` adds "Follow the
   `scheduled-bead-run` skill" and the resolved gates command. `.scheduler.json` gains an
   optional `gates: "<command>"`, validated as a non-empty string. The default is decided by
   the skill, not the scheduler, so the scheduler passes `null` when absent.
2. **Snapshot before reap.** Before `worktrees.remove()`, if the worktree is dirty, commit
   everything as `wip(<beadId>): uncommitted work at run end` on the bead branch, as actor
   `claude-scheduler`. The run row records `snapshotted: true`. Reap then discards nothing.
3. **Review queue.** `GET /api/v2/projects/:id/branches` lists `scheduler/*` branches with
   commits not in `main`: branch, bead id and title, diff stat against `main`, the evidence
   note, whether the last run passed gates, whether a `wip(...)` snapshot is the tip.
   `POST .../branches/:name/merge` runs `git merge --ff-only` in the primary checkout and
   refuses when the primary tree is dirty or the merge is not a fast-forward.
   `DELETE .../branches/:name` deletes the branch. Both mutations go through `approve()`
   (Touch ID), same as project deletion. A `/v2` page `#review?id=<project>` renders the list
   with the two actions; the Overview shows a count.
4. **Concurrency.** Per-bead worktrees already exist, so `maxConcurrent > 1` works today.
   No change; documented.

### `.scheduler.json` shape used by the skills

```json
{
  "enabled": true,
  "autoLabel": "unattended",
  "cwd": ".",
  "maxConcurrent": 1,
  "gates": "npm test",
  "defaults": { "timeoutMin": 180, "model": "default", "notify": "failure", "permMode": "auto" }
}
```

`permMode: auto` is `--dangerously-skip-permissions`. It is acceptable only because the run
is confined to its own worktree and branch and nothing reaches `main` without a human merge.
The existing pin (`pinPermMode`) still refuses widening after activation.

## Data flow

Owner plans → `bead-authoring` files epic and children with fields, depth, label reason →
scheduler polls, picks a labelled ready bead, claims it as `claude-scheduler`, runs it in a
per-bead worktree with `scheduled-bead-run` → run commits, writes note and WIP entry, emits
marker or not → scheduler snapshots leftovers, reaps the worktree, keeps the branch, closes or
hands back → next owner session in that repo: `registered-repo-session` briefs, asks
attention, merges on request.

## Error handling

- Claim fails (someone else holds it): refuse, name the holder. Never force.
- Gates absent: note says so; the marker is still allowed because the bead's done-when is
  the test, and the reviewer sees "no gates" in the queue.
- Gates fail: no marker; note carries the failing lines; the branch stays for inspection.
- Merge not fast-forward or primary tree dirty: refuse with the reason; no partial state.
- `bd` blocked by another process: every scripted `bd` call carries a timeout; a timed-out
  claim is treated as "did not happen" (verified safe in the beads doc).
- Skill missing on the runner machine: the prompt still carries the marker contract, so a
  run without the skill degrades to today's behaviour.

## Testing

- Skills are verified by use on real repos, once each: `bead-authoring` on one real spec in
  `system_migration` (every child has the four fields and a label reason);
  `registered-repo-session` by opening a session here after a scheduled run and checking the
  briefing names it; `scheduled-bead-run` by labelling one small bead in this repo, letting
  the scheduler run it, and finding the branch in the queue.
- Scheduler code: tests red first and mutation-checked; snapshot-before-reap tested against
  a throwaway repo with a dirty worktree; merge and discard exercised against a throwaway
  repo, including the dirty-primary and non-fast-forward refusals; the review page driven in
  a real browser and added to the route walk, parity, and interactions gates.

## Rollout

1. Skills, in this order: `bead-authoring`, `registered-repo-session`, `scheduled-bead-run`.
   They work without any scheduler change.
2. Scheduler beads 1 and 2 (prompt, snapshot).
3. Scheduler bead 3 (review queue).
4. Add `gates` to the five registered repos' configs; the owner commits those files.

## Out of scope

Auto-merge, pull requests, pausing the scheduler while a session is open, idle detection
from transcripts, cross-machine sync, a `bd` formula for the epic shape (candidate follow-up),
a `repo-onboarding` skill and a `review-queue-triage` skill (candidates, not committed to).

## Context cost

Each skill contributes one description line to the session context until invoked. The
beads doc at `~/.claude/docs/beads-task-tracking.md` remains the reference; the skills point
at its sections rather than copying them.
