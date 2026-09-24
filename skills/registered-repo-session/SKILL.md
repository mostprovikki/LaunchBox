---
name: registered-repo-session
description: Use when a session starts in a repo that contains .scheduler.json (a repo the LaunchBox scheduler tracks), and whenever the owner asks "what happened here", "what needs me", "what did the scheduler do", or "merge <bead>". Briefs on scheduled work since the last session, asks now-or-later for beads needing the owner, claims beads before touching them, and merges finished scheduler branches on request.
---

# Working in a scheduler-registered repo

The scheduler may have run beads here while nobody was looking, and may be running one now in a
worktree under `~/.claude-scheduler/worktrees/`. Four steps, in this order, before other work.
Reference: `~/.claude/docs/beads-task-tracking.md` §3 "Running alongside a live session".

## 1. Briefing — what the scheduler did

Last session time: the newest transcript under `~/.claude/projects/<slug-of-this-repo>/`
that is not the current one (its mtime). If none, use 7 days ago.

Read `.beads/interactions.jsonl`, keep lines with `actor == "claude-scheduler"` and
`created_at > last`. Group by `issue_id`:
- `status → closed` = **finished**;
- `status → open` after `in_progress` = **handed back** (its `reason` is the agent's closing message);
- anything else = touched.

Branches waiting: `git branch --list 'scheduler/*' --no-merged main`. For each, the bead id is
the segment after `--`; `bd show <id>` for the title and the first line of its latest note.

Report as one list, at most five lines, then the rest on request:

```
Since <date>: 2 finished (branch waiting), 1 handed back, 0 running.
  finished   <id> <title> — scheduler/<name>, +120 −8, gates: passed
  handed back <id> <title> — "<first line of reason>"
```

## 2. Attention check — once

Count handed-back beads plus `bd list --status=open -l human --json` minus deferred ones. If
more than zero, ask **now or later?** once. Later: `bd update <id> --defer <date>`.

## 3. Claim is the lock

Before editing anything for a bead: `bd update <id> --claim`. If it fails with `already claimed
by claude-scheduler`, stop: that bead is running in a worktree right now. Say so and pick
another. Never force a claim, never edit that bead's files on main meanwhile.

Beads you claim leave `bd ready`, so the scheduler will not take them. When you stop working on
one without finishing, hand it back: `bd update <id> --status open --assignee ""` and
`--append-notes` with where you stopped.

## 4. Land and release

- Finishing your own bead: `bd close <id> --reason "<evidence: tests, commit range>"`.
- **Merge on request** ("merge <bead>", "merge what finished"): for each branch,
  1. `git status --porcelain` on the primary checkout must be empty; otherwise stop and say what
     is dirty.
  2. Read the bead's latest note: it must say gates passed. If it says "no gates" or the tip
     commit starts with `wip(`, say so and ask before merging.
  3. `git merge --ff-only scheduler/<name>`. If refused (not a fast-forward), stop: rebasing
     scheduled work is a separate decision. Do not `--no-ff`, do not rebase silently.
  4. `bd update <id> --append-notes "merged <short sha> into main on <date>"`; close the bead
     if it is still open.
  5. `git branch -d scheduler/<name>` only after the merge succeeded.
- **Session end**: if you hold a claimed bead, ask before leaving it `in_progress`.

## Never

- Never activate a project or change its state.
- Never merge a branch whose note does not say gates passed, without asking.
- Never touch `~/.claude-scheduler/worktrees/*` by hand.
