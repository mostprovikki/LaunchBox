---
name: scheduled-bead-run
description: Use when the prompt says a beads task was picked up automatically by the scheduler (it names this skill and a bead id). You are inside a per-bead git worktree on your own branch. Do the work test-first, run the repo's gates, commit on the branch, write one evidence note on the bead, and emit the completion marker only if the gates passed.
---

# Running a bead for the scheduler

You are in a git worktree on branch `scheduler/<project>--<bead>`, not the owner's checkout.
Nothing you do reaches `main`; a human merges from LaunchBox's review queue. Uncommitted edits
are snapshotted by the scheduler as a `wip(...)` commit when you exit, but a snapshot is not a
deliverable — commit yourself.

## 1. Read

`bd -C <primary path from the prompt> show <id>`. The `.beads/` here is hollow; always pass `-C`.
If the design field has `Steps:` and `First failing test:`, follow them literally.

## 2. Work, test-first

Write the named failing test (or the smallest one that pins Done-when), watch it fail, make it
pass. Stay inside **Touches**; **Do not touch** is binding.

## 3. Gates

Run the gates command from the prompt. If the prompt says `Gates: none`, run `npm test` when
`package.json` has a `test` script; otherwise there are no gates and your note must say so.
Read the last 30 lines; a hang or a skip is not a pass.

## 4. Commit

```bash
git add <the files you changed — by name, never -A>
git commit -m "<type>(<scope>): <bead title> (<bead id>)"
```

Do not commit `.beads/`; the scheduler owns bead writes here.

## 5. One evidence note, then WIP.md

```bash
bd -C <primary> update <id> --append-notes "run: gates passed — branch scheduler/<name>
changed: <files>
gates: <command> → <last meaningful line>
open: <anything left, or none>"
```

First line is fixed-form (`run: gates passed|gates failed|no gates — branch <name>`); the
review queue reads it. If the repo has `WIP.md`, append a dated `## <bead id> — <title>` entry
of 3–8 lines: what changed, what was measured, what is open.

## 6. Marker

**Your process ends when your final message ends.** Nothing you put in the background
survives it: a backgrounded test battery, a queued follow-up, "I'll report when it lands"
— the scheduler sees a run that stopped without a marker and hands the bead back, and
whatever was still running is killed. So never end a turn waiting on work of your own.
Run the gates in the foreground, read the output, and only then write the final message.
If something genuinely takes longer than the run's timeout, that is a blocked run: say so,
no marker, and let a human size the bead down.

End your final message with exactly `TASK-COMPLETE: <id>` **only if** the gates ran and passed
(or the bead has no gates and Done-when is met by the diff). Otherwise write one plain paragraph
on what stopped you and no marker; the bead is handed back with your message attached.

## Never

- Never `bd close` (the scheduler closes). Never activate anything. Never push.
- Never edit files outside this worktree.
