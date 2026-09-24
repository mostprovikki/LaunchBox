# Scheduler-Aware Skills + Review Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three global skills that make every registered repo write, claim, run and report beads the way the scheduler expects, plus the scheduler mechanics they need: gates in the run prompt, snapshot-before-reap, and a review queue for finished branches.

**Architecture:** Skills live in this repo under `skills/<name>/SKILL.md` (versioned, tested) and are installed into `~/.claude/skills/` by symlink, so they load in every project. The scheduler side is three small changes in `lib/projects.js`, `lib/worktree.js`, `server.js` and one new `/v2` page, each red-first and mutation-checked, following the patterns already in the repo.

**Tech Stack:** Node 26 ESM, `node --test`, jsdom for page tests, `bd` 1.x CLI (flags verified 2026-09-24), git worktrees, the existing `/v2` chrome (`el()`, `api()`, `registerRoute`).

**Spec:** `docs/superpowers/specs/2026-09-24-scheduler-skills-design.md`

## Global Constraints

- Skills mention only `bd` flags verified in this session: `--claim`, `--add-label`, `--design`, `--append-notes`, `--defer`, `--parent`, `--json`, `--status=open`, `-C`, `--until`, `--all`, `-l/--label`. `tests/skills.test.js` enforces the allowlist.
- An agent may prepare `.scheduler.json`, file beads, and add labels only after the owner approves the batch. It never activates a project (the airlock, `CLAUDE.md`).
- `bd show --json` and `bd update --json` return a one-element array; `bd ready --json` and `bd list --json` return a bare array. Fields are omitted when empty (`labels`, `notes`, `design`, `assignee`).
- Scheduler claims and commits use actor `claude-scheduler` (`BEADS_ACTOR`, and `-c user.name=claude-scheduler` for git).
- Every test is watched red before the code, and every gate is mutation-checked (`CLAUDE.md`).
- Conservative git profile: commit at the end of each task; do not push.

---

## Part A — the skills

### Task 1: Skills directory, installer, and lint test

**Files:**
- Create: `skills/README.md`
- Create: `bin/install-skills.mjs`
- Create: `tests/skills.test.js`
- Modify: `package.json` (add `"install:skills": "node bin/install-skills.mjs"`)

**Interfaces:**
- Produces: `skills/<name>/SKILL.md` layout that Tasks 2–4 fill; `tests/skills.test.js` that they must keep green.

- [ ] **Step 1: Write the failing lint test**

```js
// tests/skills.test.js
// The skills are product surface (CLAUDE.md: "part of the claude-scheduler suite"), so they
// are versioned here and linted here. Two things rot silently in a SKILL.md: a bd flag that
// no longer exists (the CLI moves fast — see ~/.claude/docs/beads-task-tracking.md), and a
// description too vague to trigger. Both are caught here, not in someone's session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(ROOT, 'skills');
export const EXPECTED_SKILLS = ['bead-authoring', 'registered-repo-session', 'scheduled-bead-run'];

// Verified against `bd --help` output on 2026-09-24. Add here only after running the
// command and reading the resulting state (memory: verify-inferred-cli-semantics).
export const VERIFIED_BD_FLAGS = new Set([
  '--claim', '--add-label', '--remove-label', '--design', '--design-file', '--append-notes', '--notes',
  '--defer', '--parent', '--json', '--status', '--all', '--label', '-l', '-C', '--until',
  '--title', '--description', '--type', '--priority', '--reason', '--suggest-next', '--assignee',
]);

const skillDirs = () => existsSync(SKILLS)
  ? readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];

function frontmatter(src) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(src);
  assert.ok(m, 'SKILL.md must start with YAML frontmatter');
  const fm = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return fm;
}

test('the three skills exist, by name', () => {
  assert.deepEqual(skillDirs().sort(), [...EXPECTED_SKILLS].sort());
});

for (const name of EXPECTED_SKILLS) {
  test(`${name}: frontmatter names itself and has a trigger-worthy description`, () => {
    const src = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
    const fm = frontmatter(src);
    assert.equal(fm.name, name);
    assert.ok((fm.description ?? '').length >= 80, 'description must say WHEN to use it, not just what it is');
    assert.match(fm.description, /Use when|use when|Load when/, 'description must carry a "Use when" clause');
  });

  test(`${name}: every bd flag it mentions is one we verified`, () => {
    const src = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
    const seen = new Set();
    for (const m of src.matchAll(/\bbd\b[^\n`]*/g)) {
      for (const f of m[0].matchAll(/(?<=\s)(--?[a-z][a-z-]*)/g)) seen.add(f[1]);
    }
    const unknown = [...seen].filter((f) => !VERIFIED_BD_FLAGS.has(f));
    assert.deepEqual(unknown, [], `unverified bd flags in ${name}: ${unknown.join(' ')}`);
  });

  test(`${name}: never activates a project`, () => {
    const src = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
    // Any instruction to set a project active is the one thing a skill must not carry.
    assert.doesNotMatch(src, /state['"]?\s*:\s*['"]active|--state[= ]active|activate the project for/i);
  });
}
```

- [ ] **Step 2: Run it, expect red**

Run: `node --test tests/skills.test.js`
Expected: FAIL — `the three skills exist, by name` (skills dir absent), and nothing else runs.

- [ ] **Step 3: Create the directory scaffold and installer**

```markdown
<!-- skills/README.md -->
# Skills shipped with claude-scheduler

Global Claude Code skills that make a registered repo write, claim, run and report beads the
way the scheduler expects. Spec: `docs/superpowers/specs/2026-09-24-scheduler-skills-design.md`.

Install (symlinks into `~/.claude/skills/`, idempotent):

    npm run install:skills

Each skill costs one description line of session context until it is invoked.
```

```js
#!/usr/bin/env node
// bin/install-skills.mjs — symlink skills/<name> into ~/.claude/skills/<name>.
// Symlink, not copy, so an edit here is live in the next session without a reinstall.
// Refuses to replace a real directory it did not create (someone's hand-written skill).
import { readdirSync, lstatSync, symlinkSync, unlinkSync, mkdirSync, readlinkSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'skills');
const DEST = process.env.CLAUDE_SKILLS_DIR || join(homedir(), '.claude', 'skills');
mkdirSync(DEST, { recursive: true });

let installed = 0;
for (const d of readdirSync(SRC, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const from = join(SRC, d.name);
  const to = join(DEST, d.name);
  if (existsSync(to) || isLink(to)) {
    const st = lstatSync(to);
    if (!st.isSymbolicLink()) {
      console.error(`skip ${d.name}: ${to} is a real directory, not ours — remove it by hand if you want this one`);
      continue;
    }
    if (readlinkSync(to) === from) { console.log(`ok   ${d.name} (already linked)`); installed++; continue; }
    unlinkSync(to);
  }
  symlinkSync(from, to, 'dir');
  console.log(`link ${d.name} -> ${to}`);
  installed++;
}
function isLink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
console.log(`${installed} skill(s) installed in ${DEST}`);
```

Create empty placeholders so the directory test passes and the frontmatter tests go red for the right reason: `skills/bead-authoring/SKILL.md`, `skills/registered-repo-session/SKILL.md`, `skills/scheduled-bead-run/SKILL.md`, each containing only `---\nname: <name>\ndescription: TODO\n---\n`.

Add to `package.json` scripts: `"install:skills": "node bin/install-skills.mjs"`.

- [ ] **Step 4: Run the test**

Run: `node --test tests/skills.test.js`
Expected: `the three skills exist` PASS; each `frontmatter` test FAIL on description length. Flags and activation tests PASS (nothing to scan yet).

- [ ] **Step 5: Mutation-check the flag allowlist**

Append `bd update x --frobnicate` to `skills/bead-authoring/SKILL.md`, run the test, expect `unverified bd flags in bead-authoring: --frobnicate`. Remove the line. Run again.

- [ ] **Step 6: Commit**

```bash
git add skills bin/install-skills.mjs tests/skills.test.js package.json
git commit -m "feat(skills): skills dir, symlink installer, lint test (flags allowlist)"
```

---

### Task 2: `bead-authoring` skill

**Files:**
- Modify: `skills/bead-authoring/SKILL.md` (replace the placeholder)

**Interfaces:**
- Consumes: `.scheduler.json` shape from the spec; `bd create --parent`, `bd dep add`, `bd update --add-label/--design/--defer`.
- Produces: the four description fields (`Why`, `Done when`, `Touches`, `Do not touch`) and the design-field line `unattended: yes|no — <check>` that Task 3's briefing and Task 4's run read.

- [ ] **Step 1: Write the skill**

````markdown
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
````

- [ ] **Step 2: Run the lint**

Run: `node --test tests/skills.test.js`
Expected: `bead-authoring` frontmatter, flags and activation tests PASS. (`--defer` and `--design` are in the allowlist; `--parent`, `--type`, `--priority`, `--title`, `--description` too.)

- [ ] **Step 3: Install and verify the description triggers**

Run: `npm run install:skills`, then in a **new** Claude Code session in `~/mydevelopment/system_migration`: type "analyse this project's beads for the scheduler". Expected: the session announces `bead-authoring`, prints a proposal table for the open beads, and writes nothing. If the skill does not load from a symlink, replace the symlink with a copy and record that in `skills/README.md` (UNVERIFIED as of this plan).

- [ ] **Step 4: Commit**

```bash
git add skills/bead-authoring/SKILL.md
git commit -m "feat(skills): bead-authoring — shape, label rule, attention pass, backfill"
```

---

### Task 3: `registered-repo-session` skill and its session-start nudge

**Files:**
- Modify: `skills/registered-repo-session/SKILL.md`
- Modify: `~/.claude/settings.json` (user-level `SessionStart` hook, via the `update-config` skill)

**Interfaces:**
- Consumes: `.beads/interactions.jsonl` lines `{created_at, actor, issue_id, kind:"field_change", extra:{field,new_value,old_value,reason}}`; branches named `scheduler/<project>-<id8>--<bead>` from `lib/worktree.js branchFor()`.
- Produces: the merge-on-request procedure the review queue (Task 8) mirrors.

- [ ] **Step 1: Write the skill**

````markdown
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
````

- [ ] **Step 2: Run the lint**

Run: `node --test tests/skills.test.js`
Expected: `registered-repo-session` tests PASS. (`--status`, `--assignee`, `--reason`, `--append-notes`, `-l` are allowlisted.)

- [ ] **Step 3: Add the session-start nudge (user-level hook)**

Invoke the `update-config` skill to add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "test -f .scheduler.json && echo 'This repo is registered with the LaunchBox scheduler (.scheduler.json present). Invoke the registered-repo-session skill before other work.' || true"
          }
        ]
      }
    ]
  }
}
```

Merge into the existing `hooks` object; do not replace other SessionStart entries.

- [ ] **Step 4: Verify by use**

Start a new session in `~/mydevelopment/claude-scheduler`. Expected: the hook line appears, the skill announces itself, and the briefing names the scheduler's actions since the last session (at least "0 finished, 0 handed back" and the count of `scheduler/*` branches). Then in the same session, try `bd update claude-scheduler-btv.18 --claim` and confirm the skill's claim step ran before any edit.

- [ ] **Step 5: Commit**

```bash
git add skills/registered-repo-session/SKILL.md
git commit -m "feat(skills): registered-repo-session — briefing, attention, claim-as-lock, merge on request"
```

---

### Task 4: `scheduled-bead-run` skill

**Files:**
- Modify: `skills/scheduled-bead-run/SKILL.md`

**Interfaces:**
- Consumes: the run prompt from Task 6 (`Follow the scheduled-bead-run skill. Gates: <cmd|none>`), `bd -C <primary> show <id>`.
- Produces: the note format Task 8's review queue parses — a note whose first line is `run: gates passed|gates failed|no gates — branch <name>`.

- [ ] **Step 1: Write the skill**

````markdown
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

End your final message with exactly `TASK-COMPLETE: <id>` **only if** the gates ran and passed
(or the bead has no gates and Done-when is met by the diff). Otherwise write one plain paragraph
on what stopped you and no marker; the bead is handed back with your message attached.

## Never

- Never `bd close` (the scheduler closes). Never activate anything. Never push.
- Never edit files outside this worktree.
````

- [ ] **Step 2: Run the lint**

Run: `node --test tests/skills.test.js`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add skills/scheduled-bead-run/SKILL.md
git commit -m "feat(skills): scheduled-bead-run — test-first, gates, commit, evidence note, marker"
```

---

## Part B — the scheduler

### Task 5: `gates` in `.scheduler.json`, and the run prompt names the skill

**Files:**
- Modify: `lib/projects.js:90-153` (`parseProjectConfig`), `lib/projects.js:157-200` (`beadPrompt`), `lib/projects.js:706-720` (`materialise`, pass `gates`)
- Test: `tests/projects.test.js` (near line 74 for config, near line 947 for the prompt)

**Interfaces:**
- Produces: `config.gates: string|null`; `beadPrompt(project, bead, { autoLabel, gates })` whose text contains `Follow the scheduled-bead-run skill` and `Gates: <cmd>` or `Gates: none`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/projects.test.js — add near the existing parseProjectConfig tests (~line 74)
test('gates: optional, must be a non-empty string when present', () => {
  const base = { autoLabel: 'unattended' };
  assert.equal(parseProjectConfig(base).config.gates, null, 'absent → null, the skill decides the fallback');
  assert.equal(parseProjectConfig({ ...base, gates: 'npm test' }).config.gates, 'npm test');
  assert.equal(parseProjectConfig({ ...base, gates: '  ' }).ok, false, 'blank is a typo, not "no gates"');
  assert.match(parseProjectConfig({ ...base, gates: 42 }).errors.join('\n'), /gates must be a non-empty string/);
});

// near the existing beadPrompt test (~line 947)
test('the run prompt names the scheduled-bead-run skill and carries the gates command', () => {
  const withGates = beadPrompt({ name: 'repo', path: '/r' }, { id: 'sp-1', title: 't' }, { autoLabel: 'unattended', gates: 'npm test' });
  assert.match(withGates, /Follow the `scheduled-bead-run` skill/);
  assert.match(withGates, /^Gates: npm test$/m);
  const without = beadPrompt({ name: 'repo', path: '/r' }, { id: 'sp-1', title: 't' }, { autoLabel: 'unattended', gates: null });
  assert.match(without, /^Gates: none$/m);
  // The marker contract must survive the addition — a run without the skill degrades to today.
  assert.match(without, /TASK-COMPLETE: sp-1/);
});
```

- [ ] **Step 2: Run, expect red**

Run: `node --test tests/projects.test.js`
Expected: FAIL — `config.gates` is `undefined`; prompt lacks the skill line.

- [ ] **Step 3: Implement**

In `parseProjectConfig`, after the `permMode` check:

```js
  // Optional. The command the scheduled agent runs before it may claim completion.
  // Absent means "the skill decides" (it falls back to `npm test` when a test script
  // exists) — but a blank string is a typo, and a typo here must not read as "no gates".
  let gates = null;
  if (obj.gates != null) {
    if (typeof obj.gates !== 'string' || !obj.gates.trim()) {
      errors.push(`${CONFIG_FILE}: gates must be a non-empty string (the test command), or omitted`);
    } else {
      gates = obj.gates.trim();
    }
  }
```

and add `gates,` to the `config` object after `maxConcurrent`.

In `beadPrompt`, change the signature to `{ autoLabel, gates = null }` and insert after the "It is already claimed for you" line:

```js
    '',
    // The protocol lives in a skill so it can change without a daemon release; the
    // marker contract below stays in the prompt so a runner without the skill still
    // behaves like today.
    'Follow the `scheduled-bead-run` skill: test-first, run the gates, commit on this branch,',
    'write one evidence note on the bead (`bd -C <path> update <id> --append-notes`), then the marker.',
    `Gates: ${gates ?? 'none'}`,
```

In `materialise`, pass `gates: config.gates` into the `beadPrompt` options.

- [ ] **Step 4: Run, expect green; run the whole suite**

Run: `node --test tests/projects.test.js` then `npm test`. Expected: all PASS.

- [ ] **Step 5: Mutation check**

Change `Gates: ${gates ?? 'none'}` to `Gates: ${gates}` → the `none` test fails. Revert.

- [ ] **Step 6: Commit**

```bash
git add lib/projects.js tests/projects.test.js
git commit -m "feat(projects): optional gates in .scheduler.json; run prompt names scheduled-bead-run"
```

---

### Task 6: Snapshot uncommitted work before reaping the worktree

**Files:**
- Modify: `lib/worktree.js:133-146` (add `snapshot()` next to `remove()`)
- Modify: `lib/projects.js:765-775` (`reap()` calls snapshot first and records it on the run)
- Test: `tests/worktree.test.js`, `tests/projects.test.js`

**Interfaces:**
- Produces: `worktrees.snapshot(project, { root, beadId }) → Promise<{ path, committed: boolean, sha: string|null }>`; run `meta.snapshotted: true` when a `wip(...)` commit was made.

- [ ] **Step 1: Write the failing tests**

```js
// tests/worktree.test.js
test('snapshot commits a dirty worktree as wip(<bead>) with the scheduler identity, and skips a clean one', async () => {
  const dirty = fakeGit({
    status: { stdout: ' M lib/a.js\n?? new.txt\n' },
    add: { stdout: '' },
    commit: { stdout: '' },
    'rev-parse': { stdout: 'abc1234\n' },
  });
  const wt = createWorktrees({ execFileFn: dirty });
  const r = await wt.snapshot(PROJECT, { root: '/outside', beadId: 'sp-1' });
  assert.equal(r.committed, true);
  assert.equal(r.sha, 'abc1234');
  const commit = dirty.calls.find((c) => c.args[0] === '-c' || c.args[0] === 'commit');
  assert.ok(commit, 'a commit was made');
  assert.ok(commit.args.includes('user.name=claude-scheduler'), 'committed as the scheduler, not as the owner');
  assert.ok(commit.args.some((a) => /^wip\(sp-1\): uncommitted work at run end$/.test(a)), 'fixed-form message the review queue recognises');
  assert.equal(commit.opts.cwd, join('/outside', worktreeName(PROJECT, 'sp-1')), 'runs IN the bead worktree');
  // -A on purpose here and nowhere else: the point is to lose nothing.
  const add = dirty.calls.find((c) => c.args[0] === 'add');
  assert.deepEqual(add.args, ['add', '-A']);

  const clean = fakeGit({ status: { stdout: '' } });
  const wt2 = createWorktrees({ execFileFn: clean });
  const r2 = await wt2.snapshot(PROJECT, { root: '/outside', beadId: 'sp-1' });
  assert.equal(r2.committed, false);
  assert.ok(!clean.calls.some((c) => c.args.includes('commit')), 'nothing to commit → no commit');
});

test('snapshot never touches .beads/ — the scheduler owns bead writes, and a stray audit line must not ride along', async () => {
  const git = fakeGit({
    status: { stdout: ' M .beads/interactions.jsonl\n M src/x.js\n' },
    add: { stdout: '' }, commit: { stdout: '' }, 'rev-parse': { stdout: 'def5678\n' },
  });
  const wt = createWorktrees({ execFileFn: git });
  await wt.snapshot(PROJECT, { root: '/outside', beadId: 'sp-1' });
  const add = git.calls.find((c) => c.args[0] === 'add');
  assert.deepEqual(add.args, ['add', '-A', '--', '.', ':(exclude).beads']);
});
```

(Adjust the first test's `add` assertion to the exclude form too once the second passes; the exclude pathspec is the final shape.)

```js
// tests/projects.test.js — alongside the existing reap tests
test('reap snapshots first and records meta.snapshotted on the run', async () => {
  // Use the file's existing harness that runs a bead to completion with a fake worktrees
  // object (search for `worktrees:` in this file); extend the fake with:
  //   snapshot: async () => ({ path: '/wt', committed: true, sha: 'abc1234' })
  // and assert after the run's done event:
  const run = getRun(db, runId);
  assert.equal(run.meta.snapshotted, true);
  assert.equal(run.meta.snapshotSha, 'abc1234');
  assert.ok(fakeWorktrees.calls.indexOf('snapshot') < fakeWorktrees.calls.indexOf('remove'), 'snapshot BEFORE remove');
});
```

- [ ] **Step 2: Run, expect red**

Run: `node --test tests/worktree.test.js tests/projects.test.js`
Expected: FAIL — `wt.snapshot is not a function`; `run.meta.snapshotted` undefined.

- [ ] **Step 3: Implement `snapshot()` in `lib/worktree.js`** (before `remove`)

```js
    // Snapshot. `remove --force` below discards whatever the agent left uncommitted,
    // and an agent that forgot to commit has still done work a human may want to
    // see. So: if the bead worktree is dirty, commit everything on the bead branch
    // as the scheduler, with a fixed-form message the review queue recognises as
    // "unreviewed leftovers", so it never reads as a deliberate deliverable.
    // `.beads/` is excluded: bead writes are the scheduler's, and a worktree's
    // `.beads/` is hollow anyway (see the beads doc).
    async snapshot(project, { root, beadId }) {
      const path = join(root, worktreeName(project, beadId));
      const st = await git(path, ['status', '--porcelain']);
      if (!st.ok) throw new WorktreeError(`could not read status of ${path}: ${st.stderr.trim()}`, { stderr: st.stderr });
      if (!st.stdout.trim()) return { path, committed: false, sha: null };
      const add = await git(path, ['add', '-A', '--', '.', ':(exclude).beads']);
      if (!add.ok) throw new WorktreeError(`could not stage leftovers in ${path}: ${add.stderr.trim()}`, { stderr: add.stderr });
      const msg = `wip(${beadId}): uncommitted work at run end`;
      const commit = await git(path, [
        '-c', 'user.name=claude-scheduler', '-c', 'user.email=claude-scheduler@localhost',
        'commit', '--no-verify', '-q', '-m', msg,
      ]);
      if (!commit.ok) throw new WorktreeError(`could not snapshot ${path}: ${commit.stderr.trim()}`, { stderr: commit.stderr });
      const sha = await git(path, ['rev-parse', '--short', 'HEAD']);
      return { path, committed: true, sha: sha.ok ? sha.stdout.trim() : null };
    },
```

Note `fakeGit` keys on `args[0]`; with the `-c` prefix the commit call's `args[0]` is `-c`. Extend `fakeGit` in the test file to match the first non-`-c`/value token (`args.find((a, i) => !a.startsWith('-c') && (i === 0 || args[i-1] !== '-c'))`), or key the fake on `args.includes('commit')`. Keep the fake's change minimal and commit it with this task.

- [ ] **Step 4: Call it from `reap()` in `lib/projects.js`**

```js
  async function reap(project, beadId, runId = null) {
    const root = setting('worktreeRoot', '') || null;
    if (!worktrees || !root) return false;
    // Snapshot before remove, and failure to snapshot must NOT block the reap — an
    // un-reaped worktree grows without bound (the comment above), while a lost
    // snapshot is one branch's leftovers. Both are reported.
    if (typeof worktrees.snapshot === 'function') {
      try {
        const snap = await worktrees.snapshot(project, { root, beadId });
        if (snap.committed && runId) {
          const cur = getRun(db, runId)?.meta ?? {};
          updateRun(db, runId, { meta: JSON.stringify({ ...cur, snapshotted: true, snapshotSha: snap.sha }) });
        }
      } catch (err) {
        events.emit('snapshot-failed', { projectId: project.id, beadId, reason: err?.message ?? String(err) });
      }
    }
    try {
      await worktrees.remove(project, { root, beadId });
      return true;
    } catch (err) {
      events.emit('reap-failed', { projectId: project.id, beadId, reason: err?.message ?? String(err) });
      return false;
    }
  }
```

Change the `finally` at `lib/projects.js:866` to `await reap(project, bead.id, runId);`. Import `getRun` if not already imported.

- [ ] **Step 5: Run, expect green; run `npm test`**

- [ ] **Step 6: Mutation checks**

Swap the order (remove, then snapshot) → the ordering assertion fails. Remove `':(exclude).beads'` → the second test fails. Revert both.

- [ ] **Step 7: Commit**

```bash
git add lib/worktree.js lib/projects.js tests/worktree.test.js tests/projects.test.js
git commit -m "feat(worktree): snapshot uncommitted work as wip(<bead>) before reap; record on the run"
```

---

### Task 7: Branches library — list, merge fast-forward, delete

**Files:**
- Create: `lib/branches.js`
- Test: `tests/branches.test.js` (real temporary git repos, not fakes — merge semantics are the point)

**Interfaces:**
- Produces:
  - `createBranches({ execFileFn = execFile, timeoutMs = 20_000 })` →
    - `list(repoPath) → Promise<Array<{ branch, beadId, ahead, behind, shortstat: string, tipSubject: string, tipSha: string, snapshotTip: boolean }>>` — `scheduler/*` branches with commits not in `main`; `beadId` is the segment after the last `--`, or `null`.
    - `mergeFastForward(repoPath, branch) → Promise<{ ok: true, sha }>`; throws `BranchError` with `.code` in `'dirty' | 'not-ff' | 'unknown-branch' | 'git'`.
    - `remove(repoPath, branch) → Promise<{ ok: true }>`; refuses (`code: 'unmerged'`) if the branch has commits not in `main`, unless `{ force: true }`.
  - `parseBeadId(branch) → string|null` (pure).

- [ ] **Step 1: Write the failing tests**

```js
// tests/branches.test.js
// Real git in a temp dir: fast-forward vs. not, dirty vs. clean, are git's semantics, and a
// fake that agrees with my reading of them proves only that I can type my reading twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBranches, parseBeadId, BranchError } from '../lib/branches.js';

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'cs-branches-'));
  g(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a\n'); g(dir, 'add', 'a.txt'); g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
function branchWithCommit(dir, name, file, msg) {
  g(dir, 'checkout', '-q', '-b', name);
  writeFileSync(join(dir, file), `${msg}\n`); g(dir, 'add', file); g(dir, 'commit', '-q', '-m', msg);
  g(dir, 'checkout', '-q', 'main');
}

test('parseBeadId reads the segment after the last "--", or null', () => {
  assert.equal(parseBeadId('scheduler/my-repo-abcdef12--sp-1'), 'sp-1');
  assert.equal(parseBeadId('scheduler/my-repo-abcdef12--sp-1-x9k2q1'), 'sp-1-x9k2q1');
  assert.equal(parseBeadId('scheduler/my-repo-abcdef12'), null);
  assert.equal(parseBeadId('feature/x'), null);
});

test('list: only scheduler/* branches with commits not in main, with counts, shortstat and snapshot flag', async () => {
  const dir = repo();
  try {
    branchWithCommit(dir, 'scheduler/p-1--sp-1', 'b.txt', 'feat: b (sp-1)');
    branchWithCommit(dir, 'scheduler/p-1--sp-2', 'c.txt', 'wip(sp-2): uncommitted work at run end');
    branchWithCommit(dir, 'feature/not-ours', 'd.txt', 'x');
    g(dir, 'branch', 'scheduler/p-1--sp-3'); // no commits beyond main → merged, must not appear
    const b = createBranches();
    const rows = await b.list(dir);
    assert.deepEqual(rows.map((r) => r.branch).sort(), ['scheduler/p-1--sp-1', 'scheduler/p-1--sp-2']);
    const sp1 = rows.find((r) => r.beadId === 'sp-1');
    assert.equal(sp1.ahead, 1); assert.equal(sp1.behind, 0);
    assert.match(sp1.shortstat, /1 file changed/);
    assert.equal(sp1.snapshotTip, false);
    assert.equal(rows.find((r) => r.beadId === 'sp-2').snapshotTip, true, 'a wip(...) tip is flagged');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mergeFastForward: merges when ff is possible, refuses dirty tree and non-ff, leaves no partial state', async () => {
  const dir = repo();
  try {
    const b = createBranches();
    branchWithCommit(dir, 'scheduler/p-1--sp-1', 'b.txt', 'feat (sp-1)');
    // dirty primary → refuse before touching anything
    writeFileSync(join(dir, 'a.txt'), 'edited\n');
    await assert.rejects(b.mergeFastForward(dir, 'scheduler/p-1--sp-1'), (e) => e instanceof BranchError && e.code === 'dirty');
    assert.equal(g(dir, 'rev-list', '--count', 'main'), '1\n', 'nothing merged');
    g(dir, 'checkout', '-q', '--', 'a.txt');
    // non-ff: main moves on
    writeFileSync(join(dir, 'e.txt'), 'e\n'); g(dir, 'add', 'e.txt'); g(dir, 'commit', '-q', '-m', 'main moves');
    await assert.rejects(b.mergeFastForward(dir, 'scheduler/p-1--sp-1'), (e) => e.code === 'not-ff');
    assert.equal(g(dir, 'rev-list', '--count', 'main'), '2\n', 'still nothing merged');
    // ff possible: a fresh branch off the new main
    branchWithCommit(dir, 'scheduler/p-1--sp-9', 'f.txt', 'feat (sp-9)');
    const r = await b.mergeFastForward(dir, 'scheduler/p-1--sp-9');
    assert.equal(g(dir, 'rev-parse', '--short', 'main').trim(), r.sha);
    assert.equal(g(dir, 'rev-list', '--count', 'main'), '3\n');
    await assert.rejects(b.mergeFastForward(dir, 'scheduler/nope'), (e) => e.code === 'unknown-branch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('remove: deletes a merged branch, refuses an unmerged one without force', async () => {
  const dir = repo();
  try {
    const b = createBranches();
    branchWithCommit(dir, 'scheduler/p-1--sp-1', 'b.txt', 'feat (sp-1)');
    await assert.rejects(b.remove(dir, 'scheduler/p-1--sp-1'), (e) => e.code === 'unmerged');
    await b.mergeFastForward(dir, 'scheduler/p-1--sp-1');
    await b.remove(dir, 'scheduler/p-1--sp-1');
    assert.doesNotMatch(g(dir, 'branch', '--list'), /sp-1/);
    branchWithCommit(dir, 'scheduler/p-1--sp-2', 'c.txt', 'discard me');
    await b.remove(dir, 'scheduler/p-1--sp-2', { force: true });
    assert.doesNotMatch(g(dir, 'branch', '--list'), /sp-2/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run, expect red**

Run: `node --test tests/branches.test.js` — FAIL: cannot find `../lib/branches.js`.

- [ ] **Step 3: Implement `lib/branches.js`**

```js
// lib/branches.js — the review queue's git half. Lists the scheduler's bead branches that
// main has not absorbed, fast-forwards one into main, deletes one. Every mutation refuses
// rather than leaving partial state: a dirty primary checkout and a non-fast-forward both
// stop before git moves anything (validate → authorize → write, CLAUDE.md).
import { execFile } from 'node:child_process';

export class BranchError extends Error {
  constructor(message, { code = 'git', stderr = '' } = {}) {
    super(message); this.name = 'BranchError'; this.code = code; this.stderr = stderr;
  }
}

const PREFIX = 'scheduler/';
const SNAPSHOT_RE = /^wip\([^)]+\): uncommitted work at run end/;

/** The bead id is the segment after the LAST `--` (lib/worktree.js worktreeName). */
export function parseBeadId(branch) {
  const name = branch.startsWith(PREFIX) ? branch.slice(PREFIX.length) : null;
  if (!name) return null;
  const i = name.lastIndexOf('--');
  return i === -1 ? null : name.slice(i + 2) || null;
}

export function createBranches({ execFileFn = execFile, timeoutMs = 20_000 } = {}) {
  function git(cwd, args) {
    return new Promise((resolve) => {
      execFileFn('git', args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, exitCode: err?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    });
  }
  const must = async (cwd, args, what) => {
    const r = await git(cwd, args);
    if (!r.ok) throw new BranchError(`${what}: ${r.stderr.trim() || `git exited ${r.exitCode}`}`, { stderr: r.stderr });
    return r.stdout;
  };

  async function exists(repoPath, branch) {
    return (await git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
  }
  async function aheadBehind(repoPath, branch) {
    const out = await must(repoPath, ['rev-list', '--left-right', '--count', `main...${branch}`], 'could not count commits');
    const [behind, ahead] = out.trim().split(/\s+/).map(Number);
    return { ahead, behind };
  }

  return {
    async list(repoPath) {
      const out = await must(repoPath, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${PREFIX}`], 'could not list branches');
      const rows = [];
      for (const branch of out.split('\n').map((s) => s.trim()).filter(Boolean)) {
        const { ahead, behind } = await aheadBehind(repoPath, branch);
        if (ahead === 0) continue; // main already has everything on it
        const tip = await must(repoPath, ['log', '-1', '--format=%h%x00%s', branch], 'could not read tip');
        const [tipSha, tipSubject] = tip.trim().split('\0');
        const shortstat = (await must(repoPath, ['diff', '--shortstat', `main...${branch}`], 'could not diff')).trim();
        rows.push({ branch, beadId: parseBeadId(branch), ahead, behind, shortstat, tipSha, tipSubject, snapshotTip: SNAPSHOT_RE.test(tipSubject) });
      }
      return rows;
    },

    async mergeFastForward(repoPath, branch) {
      if (!await exists(repoPath, branch)) throw new BranchError(`no branch ${branch}`, { code: 'unknown-branch' });
      const status = await must(repoPath, ['status', '--porcelain'], 'could not read status');
      if (status.trim()) throw new BranchError('the primary checkout has uncommitted changes; commit or stash them first', { code: 'dirty' });
      const { behind } = await aheadBehind(repoPath, branch);
      if (behind > 0) throw new BranchError(`${branch} is ${behind} commit(s) behind main — not a fast-forward; rebase it first`, { code: 'not-ff' });
      const head = (await must(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], 'could not read HEAD')).trim();
      if (head !== 'main') throw new BranchError(`the primary checkout is on ${head}, not main`, { code: 'dirty' });
      await must(repoPath, ['merge', '--ff-only', '-q', branch], 'merge refused');
      const sha = (await must(repoPath, ['rev-parse', '--short', 'HEAD'], 'could not read HEAD')).trim();
      return { ok: true, sha };
    },

    async remove(repoPath, branch, { force = false } = {}) {
      if (!await exists(repoPath, branch)) throw new BranchError(`no branch ${branch}`, { code: 'unknown-branch' });
      if (!force) {
        const { ahead } = await aheadBehind(repoPath, branch);
        if (ahead > 0) throw new BranchError(`${branch} has ${ahead} commit(s) main does not — pass force to discard them`, { code: 'unmerged' });
      }
      await must(repoPath, ['branch', force ? '-D' : '-d', branch], 'could not delete branch');
      return { ok: true };
    },
  };
}
```

- [ ] **Step 4: Run, expect green**

Run: `node --test tests/branches.test.js`. If `git init -b main` is unsupported by the installed git, use `git init -q && git symbolic-ref HEAD refs/heads/main`.

- [ ] **Step 5: Mutation checks**

Drop the `status --porcelain` check → the `dirty` assertion fails. Drop `if (ahead === 0) continue;` → `sp-3` appears in `list`. Revert both.

- [ ] **Step 6: Commit**

```bash
git add lib/branches.js tests/branches.test.js
git commit -m "feat(branches): list/ff-merge/delete scheduler bead branches, refusing dirty and non-ff"
```

---

### Task 8: Review queue API, `/v2` page, and gate declarations

**Files:**
- Modify: `server.js` (three routes after the `graph.html` route at ~1764; wire `createBranches()` near `server.js:2163`)
- Create: `public/v2/pages/review.js`
- Modify: `public/v2/main.js:19-29` (`registerRoute('review', review)`), `public/v2/pages/project.js:385-388` (add a "Review queue" action next to "Dependency graph")
- Modify: `tools/qa/v2-parity.mjs` (declare three v2-only endpoints), `tools/qa/audit-rules.mjs:162-171` (`{ name: 'review', hash: '#review?id=:projectId' }`)
- Test: `tests/review-api.test.js` (server routes with a temp repo), `tests/frontend-v2-review.test.js` (jsdom), `tests/qa-parity.test.js` or the existing parity test if present (declaration pinned)

**Interfaces:**
- Consumes: `createBranches()` from Task 7; `approve()` at `server.js:562`; `needProjects(res)`; `getProject(db, id)`; `beads.get(...)` for the bead title and latest note (see `lib/beads.js` `get`).
- Produces:
  - `GET /api/v2/projects/:id/branches` → `{ branches: [{ branch, beadId, title, ahead, behind, shortstat, tipSha, tipSubject, snapshotTip, note: { first: string|null, gates: 'passed'|'failed'|'none'|null } }] }`
  - `POST /api/v2/projects/:id/branches/:name/merge` → `{ ok, sha }`; 409 `{ error, code }` on `dirty`/`not-ff`; 404 on unknown; Touch ID via `approve()` with `action: 'branch.merge'`.
  - `DELETE /api/v2/projects/:id/branches/:name` (body `{ force?: boolean }`) → `{ ok }`; 409 `code: 'unmerged'` without force; `approve()` with `action: 'branch.discard'`.
  - `:name` is the branch WITHOUT the `scheduler/` prefix, URL-encoded; the server prepends the prefix so nothing outside `scheduler/*` is ever merged or deleted.

- [ ] **Step 1: Write the failing API tests**

```js
// tests/review-api.test.js — follow the harness the graph tests use (tests/frontend-v2-graph.test.js
// boots server.js with CS_DATA in a temp dir and a token); register a temp git repo as a project.
test('GET branches lists scheduler branches with bead title and the fixed-form note verdict', async () => {
  // temp repo with .scheduler.json + .beads via `bd init` is heavy; instead register the repo with a
  // stubbed `beads.get` returning { title: 'T', notes: 'run: gates passed — branch scheduler/x\n...' }.
  // Assert: 200, one row, row.title === 'T', row.note.gates === 'passed', row.note.first starts with 'run:'.
});
test('merge: requires approval, refuses dirty (409 dirty) and non-ff (409 not-ff), merges otherwise', async () => {
  // Use the approval test double the DELETE /api/projects tests use (grep 'approval' in tests/server*.test.js).
});
test('routes never touch a branch outside scheduler/*', async () => {
  // POST .../branches/..%2Fmain/merge → 404, and `git rev-list --count main` unchanged.
});
```

Write these fully using the existing server test harness (grep `CS_DATA` in `tests/*.test.js` for the boot helper and `approval` for the Touch ID double). Each `it` must fail before Step 3.

- [ ] **Step 2: Write the failing page test**

```js
// tests/frontend-v2-review.test.js (jsdom, same shape as tests/frontend-v2-graph.test.js)
test('#review lists branches, flags snapshot tips, and disables merge when the note is not "gates passed"', async () => {
  // fetch stub answering GET /api/v2/projects/p1/branches with two rows: one gates passed, one snapshotTip.
  // Assert: two .row elements; the snapshot row shows text /unreviewed leftovers/; its Merge button is
  // disabled with data-tip /gates|snapshot/; the passed row's Merge button is enabled and data-mutating.
});
test('#review with no id renders the stated empty state, not a blank page', async () => { /* text /Pick a project/ */ });
```

- [ ] **Step 3: Implement the routes in `server.js`**

```js
  const noteVerdict = (notes) => {
    const first = (notes ?? '').split('\n').find((l) => l.trim()) ?? null;
    const m = /^run:\s*(gates passed|gates failed|no gates)/i.exec(first ?? '');
    return { first, gates: m ? { 'gates passed': 'passed', 'gates failed': 'failed', 'no gates': 'none' }[m[1].toLowerCase()] : null };
  };
  const branchName = (req) => {
    const name = String(req.params.name ?? '');
    // Prefix added here and only here: nothing outside scheduler/* is reachable.
    if (!name || name.includes('/') || name.includes('..')) return null;
    return `scheduler/${name}`;
  };

  app.get('/api/v2/projects/:id/branches', async (req, res) => {
    if (!needProjects(res)) return;
    const project = getProject(db, req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });
    try {
      const rows = await branches.list(project.path);
      const out = [];
      for (const r of rows) {
        let title = null, note = { first: null, gates: null };
        if (r.beadId) {
          const bead = await beads.get(project, r.beadId).catch(() => null);
          title = bead?.title ?? null;
          note = noteVerdict(bead?.notes);
        }
        out.push({ ...r, title, note });
      }
      res.json({ branches: out });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/v2/projects/:id/branches/:name/merge', async (req, res) => {
    if (!needProjects(res)) return;
    const project = getProject(db, req.params.id);
    const branch = branchName(req);
    if (!project || !branch) return res.status(404).json({ error: 'not found' });
    if (!await approve(req, res, {
      action: 'branch.merge',
      detail: `merge ${branch} into main in “${clampName(project.name)}”`,
      grace: false,
    })) return;
    try {
      res.json(await branches.mergeFastForward(project.path, branch));
    } catch (err) {
      const status = err.code === 'unknown-branch' ? 404 : (err.code === 'dirty' || err.code === 'not-ff') ? 409 : 502;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  app.delete('/api/v2/projects/:id/branches/:name', async (req, res) => {
    if (!needProjects(res)) return;
    const project = getProject(db, req.params.id);
    const branch = branchName(req);
    if (!project || !branch) return res.status(404).json({ error: 'not found' });
    if (!await approve(req, res, {
      action: 'branch.discard',
      detail: `delete ${branch} in “${clampName(project.name)}”${req.body?.force ? ' and discard its unmerged commits' : ''}`,
      grace: false,
    })) return;
    try {
      res.json(await branches.remove(project.path, branch, { force: !!req.body?.force }));
    } catch (err) {
      const status = err.code === 'unknown-branch' ? 404 : err.code === 'unmerged' ? 409 : 502;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });
```

Wire near `server.js:2163`: `import { createBranches } from './lib/branches.js';` and `const branches = createBranches();`. Confirm `beads.get(project, id)` is the real signature in `lib/beads.js` (the Explore map did not cover it) and that the returned object carries `notes`; if `get` normalises through `normaliseBead()` (which drops `notes`), add `notes: b.notes ?? null` to `normaliseBead` and pin it in `tests/beads.test.js`.

- [ ] **Step 4: Implement `public/v2/pages/review.js`**

```js
// public/v2/pages/review.js — the review queue: scheduler branches main has not absorbed.
// Route: `#review?id=<projectId>`, reached from the project detail page. Two actions, both
// Touch ID-gated server-side: merge (fast-forward only) and discard.
import { api, degradedReason } from '../api.js';
import { $, el, clear, pageHead, iconBtn, toast } from '../ui.js';

export default async function review(params) {
  const page = $('#v2-page');
  clear(page);
  const id = params?.get('id') ?? null;
  if (!id) {
    page.appendChild(pageHead({ title: 'Review queue' }));
    page.appendChild(el('p', { class: 'empty' }, 'Pick a project from Projects to see its finished scheduler branches.'));
    return;
  }
  page.appendChild(pageHead({ title: 'Review queue', back: `#project?id=${encodeURIComponent(id)}` }));
  const host = el('div', { class: 'list', id: 'review-list' });
  page.appendChild(host);

  async function load() {
    clear(host);
    let rows;
    try {
      rows = (await api('GET', `/api/v2/projects/${encodeURIComponent(id)}/branches`)).branches;
    } catch (err) {
      host.appendChild(el('p', { class: 'error' }, `Could not list branches: ${err.message}`));
      return;
    }
    if (!rows.length) {
      host.appendChild(el('p', { class: 'empty' }, 'Nothing waiting. Every scheduler branch is merged into main.'));
      return;
    }
    for (const r of rows) host.appendChild(row(r));
  }

  function row(r) {
    const name = r.branch.replace(/^scheduler\//, '');
    const mergeable = r.note.gates === 'passed' && !r.snapshotTip && r.behind === 0;
    const why = r.snapshotTip ? 'Tip is an unreviewed snapshot (wip) — inspect before merging'
      : r.note.gates !== 'passed' ? `Evidence note says ${r.note.gates ?? 'nothing about gates'} — inspect before merging`
        : r.behind > 0 ? `${r.behind} commit(s) behind main — not a fast-forward` : 'Fast-forward main to this branch';
    const merge = el('button', { class: 'btn', 'data-mutating': true, 'data-tip': why, disabled: !mergeable }, 'Merge');
    merge.addEventListener('click', () => act('POST', `/api/v2/projects/${encodeURIComponent(id)}/branches/${encodeURIComponent(name)}/merge`, {}, `Merged ${r.beadId ?? name}`));
    const discard = el('button', { class: 'btn btn--ghost', 'data-mutating': true, 'data-tip': 'Delete this branch and its unmerged commits' }, 'Discard');
    discard.addEventListener('click', () => act('DELETE', `/api/v2/projects/${encodeURIComponent(id)}/branches/${encodeURIComponent(name)}`, { force: true }, `Discarded ${name}`));
    return el('div', { class: 'row reviewrow', 'data-branch': r.branch }, [
      el('div', { class: 'reviewrow__main' }, [
        el('b', {}, r.title ?? r.beadId ?? name),
        el('span', { class: 'muted' }, ` ${r.branch} · ${r.shortstat || 'no diff'} · +${r.ahead}/−${r.behind}`),
        el('div', { class: 'muted' }, r.snapshotTip ? 'unreviewed leftovers: ' + r.tipSubject : r.note.first ?? r.tipSubject),
      ]),
      el('div', { class: 'reviewrow__actions' }, [merge, discard]),
    ]);
  }

  async function act(method, path, body, okText) {
    try {
      await api(method, path, body);
      toast(okText);
      await load();
    } catch (err) {
      toast(err.message ?? 'refused', { error: true });
    }
  }

  await load();
}
```

Check `pageHead`, `toast` and `iconBtn` exist in `public/v2/ui.js` with those signatures before using them (grep `export function`); match whatever the graph page uses. Add a "Review queue" ghost button next to "Dependency graph" in `project.js`. Register the route in `main.js`.

- [ ] **Step 5: Declare the endpoints and the route for the gates**

In `tools/qa/v2-parity.mjs`, after the graph-ticket entry, add three entries with `side: 'v2-only'`, `status: 'additive by design'` and this `why`: "review queue for scheduled work (spec 2026-09-24-scheduler-skills-design). The existing UI has no notion of scheduler branches; merge and discard are Touch ID-gated and fast-forward only." In `tools/qa/audit-rules.mjs` add `{ name: 'review', hash: '#review?id=:projectId' }` after `graph`. The route walk's fixture project has no scheduler branches, so the walk must render the empty state, not a blank page.

- [ ] **Step 6: Run everything**

Run: `npm test`, then `npm run qa:v2`, `npm run qa:v2:parity`, `npm run qa:v2:interactions`. Expected: all clean; parity lists the three new endpoints as declared.

- [ ] **Step 7: Verify in a real browser against a throwaway repo**

Boot the daemon with `CS_DATA` in a temp dir, register a temp git repo that has one `scheduler/p--sp-1` branch with a passing note and one `wip(...)` branch. Open `#review?id=…`: the snapshot row's Merge is disabled with the tooltip; click Merge on the good row, approve, and confirm `git log main` in the temp repo has the commit. Then Discard the snapshot row. Record both in WIP.md.

- [ ] **Step 8: Mutation checks**

Remove the `name.includes('/')` guard → the `outside scheduler/*` test fails. Remove `disabled: !mergeable` → the page test fails. Revert both.

- [ ] **Step 9: Commit**

```bash
git add server.js lib/branches.js public/v2/pages/review.js public/v2/main.js public/v2/pages/project.js tools/qa/v2-parity.mjs tools/qa/audit-rules.mjs tests/review-api.test.js tests/frontend-v2-review.test.js
git commit -m "feat(v2): review queue — list, ff-merge and discard scheduler bead branches behind Touch ID"
```

---

### Task 9: Docs, configs, and verification by use

**Files:**
- Modify: `~/.claude/docs/beads-task-tracking.md` §3 (add "The skills" subsection pointing at the three skills, the `gates` key, the note format, the review queue)
- Modify: `public/v2/README.md` (route table: `#review`), `README.md` (one paragraph: skills + `npm run install:skills`)
- Modify: the five repos' `.scheduler.json` (`gates`), left uncommitted for the owner

- [ ] **Step 1: Docs**

Add to the beads doc, after "Running alongside a live session": the three skill names with one line each, the `gates` field, the fixed-form note first line `run: gates passed|gates failed|no gates — branch <name>`, the `wip(<bead>)` snapshot convention, and "merge is a human action: review queue or 'merge <bead>' in a session".

- [ ] **Step 2: Configs**

Set `gates` per repo after reading each `package.json`: claude-scheduler `npm test`; for trip-planner, runcoach, splitease, system_migration, torquery use their test script or omit the key. Report the five diffs; the owner commits them.

- [ ] **Step 3: Verification by use (needs the owner's hands, one sitting)**

1. New session in `system_migration`: "analyse this project's beads for the scheduler" → proposal table, nothing written. Approve a batch of at most three safe beads → labels applied with reasons.
2. In LaunchBox, watch one of them run. When done: `git branch --list 'scheduler/*'` in that repo shows the branch; the bead's note starts with `run: gates …`; the review queue lists it.
3. New session in that repo → `registered-repo-session` briefs on it; say "merge <id>" → fast-forward, note appended, bead closed.

- [ ] **Step 4: Commit the repo's docs**

```bash
git add README.md public/v2/README.md
git commit -m "docs: scheduler skills, gates, note format, review queue"
```

---

## Self-review (done while writing)

- **Spec coverage:** Components 1–3 → Tasks 2–4; scheduler change 1 → Task 5; 2 → Task 6; 3 → Tasks 7–8; 4 (concurrency) → documented in Task 9; backfill → Task 2 §5 and Task 9 step 3; session-start briefing and merge-on-request → Task 3; attention now-or-later → Tasks 2 §3 and 3 §2; context cost → Task 1 README.
- **Placeholders:** Task 8 Step 1 sketches three API tests in comments and tells the implementer which existing harness to copy; Step 3 flags one unverified signature (`beads.get` and whether `notes` survives normalisation) and says what to do in each case. Everything else is literal.
- **Type consistency:** `branches.list()` rows `{ branch, beadId, ahead, behind, shortstat, tipSha, tipSubject, snapshotTip }` are what Task 8's route spreads and what `review.js` reads; `mergeFastForward` returns `{ ok, sha }` in both the lib test and the route; `BranchError.code` values `dirty | not-ff | unknown-branch | unmerged | git` are the same set in Task 7 and Task 8's status mapping; the note's first line `run: gates passed|gates failed|no gates — branch <name>` is identical in Task 4's skill and Task 8's `noteVerdict`.
