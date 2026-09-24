---
name: bead-authoring
description: Use when turning a plan or spec into beads, when asked to "file these as beads", at the end of superpowers:writing-plans, or when asked to analyse or label a project's existing beads for the scheduler. Shapes each bead so a stranger can finish it, decides the `unattended` label by a five-check rule, and asks the owner "now or later" for beads that need them.
---

# Bead authoring for scheduler-aware repos

The scheduler (LaunchBox, `~/mydevelopment/claude-scheduler`) runs beads unattended only if they
carry the repo's `autoLabel` (`unattended` everywhere here) and are written so an agent with no
context can finish them. This skill is how beads get written that way. Reference for the tracker
itself: `~/.claude/docs/beads-task-tracking.md` (read §2 "Dependency direction" before chaining).

## 0. Which depth?

Ask once per plan unless the owner already said: **basic** (four fields) or **detailed** (four
fields plus steps, first test, expected diff). Default: detailed for beads that will be labelled
`unattended`, basic for the rest. "File these basic" overrides for the whole plan.

## 1. Shape — every child bead carries four fields

Description (all four, in this order, as bold labels):

- **Why** — one paragraph. What is wrong or missing, and what it costs.
- **Done when** — verifiable by a stranger: a test name, a command with its expected output, or
  a file diff. "Looks right" is not done-when.
- **Touches** — files or surface.
- **Do not touch** — what stays out of scope, named.

Detailed depth adds to the design field (`--design`):

```
Steps:
1. ...
First failing test: <file>::<name> — asserts <what>
Expected diff: <files, roughly how many lines, what moves>
```

One epic per plan; children with `--parent=<epic>`; real prerequisites with `bd dep add <child>
<prereq>` (child depends on prereq — verify the direction with `bd show` afterwards, a reversed
chain is silent). `related`/`discovered-from` do not block.

```bash
bd create --title="<epic title>" --description="<why the plan exists>" --type=epic --priority=1
bd create --title="<child>" --description="**Why** ... **Done when** ... **Touches** ... **Do not touch** ..." --type=task --priority=2 --parent=<epic>
bd dep add <child2> <child1>      # child2 waits for child1
```

Pass long descriptions through a file or heredoc, never inline backticks (memory:
backticks command-substitute in CLI args).

## 2. Label rule — five checks, all must pass

A bead gets `unattended` only if:

1. **No owner decision inside it** — no tech choice, scope call, or UX judgement.
2. **Done-when is mechanical** — a test, a script, or a diff can confirm it.
3. **No owner-only access** — no credentials, no live browser session, no external account.
4. **Leaf** — not an epic, has no children.
5. **Not deferred, not flagged human.**

Record the verdict in the design field, first line: `unattended: yes` or
`unattended: no — <the first failed check, in words>`. Then apply:

```bash
bd update <id> --add-label unattended
```

A labelled bead on an **activated** project runs on the next poll. When filing a new plan the
owner has just approved, apply labels directly. For existing beads, see §5.

## 3. Attention pass — once, at the end

List the beads that stay unlabelled because they need the owner (check 1 or 3 failed). Ask
one question: **now or later?**
- Now: go through them one at a time; a decision becomes a note on the bead and may flip the
  label.
- Later: `bd update <id> --defer <date>` for each, one date, and do not ask again before it.

## 4. Config — prepare, never activate

If the repo has `.beads/` but no `.scheduler.json`, write this and say so:

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

Set `gates` to the repo's real test command, or remove the key if there is none. Offer
registration with LaunchBox; do not register or activate unless asked. Activation is the
owner's click in the UI.

## 5. Backfill — analyse and label existing beads

Trigger: "label the existing beads", "analyse this project's beads", or a first plan in a repo
whose open beads carry no `unattended:` verdict.

1. Read every open, non-deferred bead: `bd list --status=open --json`, then `bd show <id> --json`
   for each (fields are omitted when empty — a missing `labels` means none).
2. Apply §2 to each. Where the description supports it, derive the four fields.
3. Print a **proposal table** and stop: `id | depth now | proposed label (yes / no — check) |
   fields to add | needs rewrite?`. A bead too thin to judge is "needs rewrite" and is left alone.
4. **Write nothing until the owner approves the batch.** On an activated project the label is
   what makes the bead run.
5. On approval, in one pass per bead: `bd update <id> --design "<verdict + derived design>"`,
   `bd update <id> --add-label unattended` for the yeses, `--append-notes` for derived fields.
   Print what changed. Then run §3 on the leftovers.

## Never

- Never activate a project, never set its state.
- Never label a bead the owner has not seen in a proposal or a plan they approved.
- Never `--claim` here; claiming is the session skill's job when work starts.
