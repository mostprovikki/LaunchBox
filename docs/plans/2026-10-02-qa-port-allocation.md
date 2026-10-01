# QA sandbox port allocation (claude-scheduler-9u2)

Owner decision 2026-10-02: registry slots + instance k (from `~/.claude/ports.json`).

## Scheme

| where | route-walk | interactions | screenshots |
|---|---|---|---|
| primary checkout | 43410 | 43411 | 43412 |
| worktree instance k (0-4) | 43450+10k | 43451+10k | 43452+10k |

- k arrives as `CS_INSTANCE`. The daemon assigns it: the lowest slot 0-4 not held by
  another live bead run (any project), freed when the run's `done` fires. Carried on
  the job as `params._qaInstance`; the claude extension exports it as env.
- No free slot → no `CS_INSTANCE`. A QA tool inside a linked worktree (`.git` is a
  file) without `CS_INSTANCE` refuses to start. It never falls back to the primary slots.
- Busy port → exit 1 naming the listener's PID/command (`lsof`). Never auto-increments.
- Readiness = the child is alive AND `$CS_DATA/port` (written by server.js on
  `listening`, inside the sandbox's own mkdtemp dir) matches the port, AND `/` is 200.
  Any 200 alone is not readiness.

## Steps

1. `tools/qa/sandbox-port.mjs`: `qaPort(role, {env, repo})`, `assertPortFree(port)`,
   `waitForOwnSandbox({child, dataDir, port})`. Unit test, mutation-checked.
2. Wire v2-route-walk, v2-interactions, screenshots/capture into it.
3. `lib/projects.js` slot allocator + `extensions/claude` env. Tests.
4. `~/.claude/ports.json` services entries.
5. Live: occupy 43411, run `qa:v2:interactions` → fast fail naming the PID; free run green.
   Daemon restart (owner, no run in flight) to pick up step 3.

Out of scope: the daemon's own port handling.
