# LaunchBox — design identity

Status: **agreed 2026-09-26**. Owner: vigneshwar.mk. Suite grammar: none —
LaunchBox is standalone; `system_migration/docs/design/suite.md` is the media-apps suite and
does not apply here.
Every UI change to `/v2` cites a section of this file (design-gate) or proposes a change to it
(§9 changelog). Revise it; do not work around it.

## 1. Users and modes

| Mode | Who | When | Device / hands | Patience |
|---|---|---|---|---|
| Morning review | owner | once a day, after unattended runs | laptop, trackpad | 5–15 min, focused |
| Glance check | owner | many times a day | laptop, trackpad | seconds |
| Planning / queuing | owner | a few times a week | laptop, trackpad | minutes, deliberate |

Only the owner ever sees a screen. Mouse-first: every job has a click path; keys are a bonus.

**Primary mode:** morning review. When modes conflict, it wins. LaunchBox is worth having
when unattended work lands safely, so reviewing what came back is the payoff.

### Ranked jobs (morning review)

| # | When… | I want… | so I can… | Reach | Surface |
|---|---|---|---|---|---|
| 1 | I sit down | to see whether anything needs me | decide to review now or later | zero clicks | Overview |
| 2 | a bead finished on a branch | merge or discard it | land work on main | one click (Overview → Inbox), then Touch ID | Inbox |
| 3 | a run was handed back | see its reason, then read the log or hold it | fix the bead, or take it myself | one click from Inbox selection | Inbox |
| 4 | a run failed | the log at the failure point | understand why | one click from Inbox or Runs | Run log |
| 5 | I plan today | see headroom and overnight spend | decide whether to burst | zero clicks | Overview |

Jobs of other modes:
- Glance check: jobs 1 and 5 (Overview, zero clicks).
- Planning: activate a project, burst a project's ready beads. Burst is one click from both the
  Projects list row and the Project page. Activation stays on the Project page.

## 2. Surfaces and archetypes

| Surface | Archetype | Top job | Opens from | Leaves to |
|---|---|---|---|---|
| Overview | Monitor | job 1, job 5 | app open | Inbox (needs-me count), Runs (running now) |
| Inbox | Workbench | jobs 2–3 | Overview count, nav | Review (merge), Run log |
| Review (per project) | Workbench | merge/discard one project's branches | Inbox, Project | Inbox |
| Runs → run log | Browser → Workbench | find a run → read why | nav, Inbox | Runs (Esc/back) |
| Projects | Browser | see which repos are tracked; burst one | nav | Project |
| Project | Workbench | ready beads, burst, activate/pause | Projects | Review, Graph |
| Plan dialogs | Guided flow | plan a budget burst | Project, Projects row | the surface it opened from |
| Jobs + job dialog | Admin | create/edit a cron job | nav | — |
| Settings | Admin | budgets, pause modes | nav | — |
| Sessions / session | Browser | find and resume a past session | Settings or footer link (demoted) | — |
| Graph | Browser | read-only bead graph | Project | Project |

Transitions: `Monitor (Overview) --count--> Workbench (Inbox) --select--> detail --Log--> Workbench (run log) --back--> Inbox`.
The Overview carries no merge, log or burst controls. The Inbox carries no filters beyond its
two groups.

## 3. Frequency and session shape

- **Morning review:** opens on Overview. Status light says whether anything needs you. Click
  the needs-me count, work down the Inbox until it is empty. Done = Inbox empty.
- **Glance check:** Overview only. Done = light is green, or you know why it isn't.
- **Planning:** Projects → Project → burst or activate. Done = the burst is scheduled.

## 4. Reach tiers

| Tier | Rule | Contents |
|---|---|---|
| Zero clicks | the page is the answer | Overview: status light + the four numbers (§5) |
| One click | visible at rest | Inbox count on Overview; Inbox items; burst on Projects row and Project page; Review from a selected branch item |
| Two clicks | behind a selection or dialog | merge/discard (Review, then Touch ID); log / hold on a handed-back item |
| Nav / menu | everything else | Jobs, Settings, Sessions, Graph, usage history |

Optional keys on Inbox: ↑↓ move selection, Enter = primary action, L = log, H = hold.

## 5. Density and action stance

- **Overview (Monitor):** status light (ok / warn / bad) with a one-line state ("Nothing needs
  you", "Waiting on you", "Cannot run beads") and why. A daemon fault (e.g. the claude binary is
  missing) is a red banner with one fix link. Below it:
  - **needs-you card**, the largest: the count, what it is made of, and *Open Inbox* (the one
    action on the page) → decides "review now?";
  - **headroom left** (weekly %, 5-hour % beneath, "as of" time) → "can I burst today?";
  - **running now** (count, pause state) → "don't touch that repo"; opens Runs;
  - **LaunchBox spend** card: two large numbers — since last visit, and last 7 days (% of the
    weekly window) — and one thin share bar of the last 7 days by project, **names only, no
    numbers** → "which project is eating headroom, by how big a margin, so I reprioritise".
    Exact figures live on Runs.
  No list at rest. Mockup: `docs/design/mockups/overview-flavours.html` (Option 2).
- **Inbox (Workbench, triage split):** list on the left, grouped *waiting to merge* /
  *handed back*; detail on the right for the selected item. Actions appear **only for the
  selected item**, never per row at rest. Primary action moves with state: branch → *Review*;
  handed back → *Log*, with *Hold* secondary.
- **Projects (Browser):** one action at rest per row: *Burst*. Everything else is on the
  Project page.
- **Project (Workbench):** *Burst* primary; activate/pause as the one state control; *Poll now*,
  *Dependency graph* and *Remove project…* in a ⋯ menu. Poll now and the graph also have
  in-place shortcuts where they act: "polled 25 min ago · ↻ Poll now" (relative time) at the
  foot of the Ready card, "graph →" in the Up next header. A "N waiting to merge → Review in
  Inbox" strip appears only when N > 0. Three facts: **Ready** (wider, larger number), Running
  here, Permission mode. Then **Up next** (ready beads: priority badge, short id, title, type on
  line 2; right: "unblocks N" when N > 0, "filed … ago"), **Recent runs** (status dot, short id,
  bead title; line 2 starts with the status word; right: time, *Log →*, whole row opens the log),
  and a collapsed *Declared config*. Both lists share one grid: ids and titles start at the same
  x. Mockup: `docs/design/mockups/project-flavours.html` (Option 2).
- **Admin surfaces:** one Save per section; destructive edits confirm.

## 6. Vocabulary

| Term | Means | Never called |
|---|---|---|
| bead | a unit of work in a repo's beads graph | task, ticket, issue |
| run | one scheduler execution of a bead or job | job (for bead runs), task |
| job | a cron entry (shell or Claude) the owner defined | run, schedule |
| handed back | a run ended without the completion marker; bead is open again | failed (unless it failed), rejected |
| waiting to merge | a finished bead's `scheduler/*` branch not yet on main | pending, PR |
| headroom | account usage left before the guard stops runs | quota, credits |
| burst | a budgeted batch run over a project's ready beads | batch, sprint |
| activate | the owner's click that lets a project run unattended | enable, approve |

**Bead ids:** where the project is already on screen, show the short id (`85ht.1`, not
`system_migration-85ht.1`), in mono, before the title — it is how sessions and searches name a
bead. Bead type (task / bug / feature) is neutral grey text; red and yellow stay reserved for run
state and priority.

**One number, one place:** the needs-me count lives on Overview and as the Inbox nav badge
(the same number, the Inbox's own size). Headroom lives on Overview; the appbar usage chips
are a glance copy and must show the same reading and "as of" time.

## 7. Refused, and removed

**Refused** (do not propose):
- Activation by an agent — only a human click activates a project; that airlock is the safety model.
- Remote or multi-user access — local-only, single owner.
- Editing beads in the UI — `bd` is the source of truth; the UI reads and acts on beads, it
  does not author them.

**Not yet:** auto-merge (merge still needs the owner + Touch ID).

**Removed, restore if missed:**

| Date | Element | Was on | Why cut | Restore if… |
|---|---|---|---|---|
| 2026-09-26 | Sessions in main nav | appbar | not in the top jobs of any mode | you open Sessions weekly |
| 2026-09-26 | Usage history charts at rest | Overview | no decision depends on history at a glance | you tune budgets from history |
| 2026-09-26 | Poll now, Pause/Resume, delete on each row | Projects | not the row's job; §5 allows one action per row (Burst) | you pause projects often from the list |
| 2026-09-26 | Register form + Discover button at rest | Projects | rare setup job; behind "Add a project…" footer link | you add projects weekly |
| 2026-09-26 | "An active project lets LaunchBox…" explainer | Projects | the Touch ID prompt already explains activation at the moment it matters | a new user is confused |
| 2026-09-26 | Filter box | Projects | 6 rows; filtering has no job at this size | more than ~15 projects |
| 2026-09-26 | Per-row "schedule is paused (soft)" line | Projects | the appbar banner already says it (one fact, one place) | — |
| 2026-09-26 | "Would contribute nothing yet" banner | Projects | restates "0 ready"; problem line kept for real faults only | — |
| 2026-09-26 | active/paused chip on each row | Projects | the Active / Paused group headings already say it | — |
| 2026-09-26 | Needs-attention list | Overview | a list at rest; the needs-you card + Inbox carry it | you triage from Overview, not Inbox |
| 2026-09-26 | Next 24 hours card | Overview | no morning-review decision; lives on Jobs | you check upcoming fires daily |
| 2026-09-26 | Running-now card with stop/kill | Overview | actions on a Monitor; controls live on Runs | you stop runs often from Overview |
| 2026-09-26 | Automation (projects) card | Overview | duplicates Projects | — |
| 2026-09-26 | Three headroom meters + refresh buttons | Overview | one headroom fact is enough at a glance; detail in Settings | you tune reserves daily |
| 2026-09-26 | Auto label, Last poll, Leases held, Min headroom facts | Project | no decision at a glance; auto label + timeout live in the collapsed config line | you change config often |
| 2026-09-26 | Review queue + Poll now + Remove as header buttons | Project | not the page's job at rest; ⋯ menu, with Poll now / graph shortcuts in place | — |

## 8. Reference apps

| App | Steal | Avoid |
|---|---|---|
| GitHub Actions | run list with status marks; click into the log at the failing step | — |
| Linear | calm, dense triage list with a detail pane; keys optional | — |
| Status pages | few facts, big type, freshness stamp | — |
| Grafana | — | panels of charts nobody acts on |
| Jenkins | — | every setting and action visible at once |
| Jira | — | heavy forms, fields everywhere |

## 9. Visual system, and changelog

Stylesheets `public/v2/assets/system.css` + `launchbox.css`; dark default, light supported
(`theme.js`); IBM Plex Sans/Mono. Decided, not inherited: the owner chose on 2026-09-26 to keep
the current `/v2` styles as the visual system.

Mockups (Option 2 chosen in each): `docs/design/mockups/inbox-flavours.html`, `projects-flavours.html`, `overview-flavours.html`, `project-flavours.html`.

| Date | Change | Proposed by | Reason |
|---|---|---|---|
| 2026-09-26 | initial | interview + Inbox mockups (Option 2, triage split, chosen) | |
| 2026-09-26 | handed-back actions are *Log* and *Hold*; *Re-queue* removed | agent, from `lib/projects.js` `handBack`; owner agreed | a handed-back bead is already open and back in `bd ready`, so the scheduler retries it on its own and "Re-queue" would be a no-op. *Hold* stops the retries (defer, or take the bead yourself). |
| 2026-09-26 | marked agreed | owner | smoke test was the Projects design-gate + mockup (Option 2 chosen, cuts in §7), not a full `ux-expert-review` run; no identity changes raised |
| 2026-09-26 | Overview: needs-you hero + spend card with per-project share bar | owner, via Overview mockup | owner wants to see which project consumed the most, by what margin, at a glance; replaces "overnight spend" as a single number |
| 2026-09-26 | Project page: Poll now and graph get in-place shortcuts besides the ⋯ menu; short bead ids everywhere the project is in context | owner, via Project mockup | owner refers to beads by short id; poll/graph are wanted next to what they act on |
