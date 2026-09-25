# Skills shipped with claude-scheduler

Global Claude Code skills that make a registered repo write, claim, run and report beads the
way the scheduler expects. Spec: `docs/superpowers/specs/2026-09-24-scheduler-skills-design.md`.

Install (symlinks into `~/.claude/skills/`, idempotent):

    npm run install:skills

Each skill costs one description line of session context until it is invoked.
