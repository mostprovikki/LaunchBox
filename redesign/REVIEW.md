# Redesign review — neutral UI/UX audit · Sat 1 Aug 2026

**Verdict: build it.** The IA (Overview + Jobs/Runs/Projects/Sessions/Settings), the state
vocabulary, and the consequence-first copy are better than most commercial ops tools. Nothing
here needs a redesign-of-the-redesign. I fixed every *measurable* defect in place (all
token-level; visual character unchanged) and list the judgement calls below for your decision.

**How it was reviewed.** All 32 pages driven in real Chromium at 1280×900, dark **and** light
(scope agreed: desktop only, mockup-level — no keyboard/SR/phone testing; that moves to
implementation gates). Measured, not eyeballed: exact WCAG contrast on every text node,
horizontal overflow, stranded light surfaces in dark mode, console errors, and link resolution
across all 64 page×theme views; every screenshot then reviewed by eye. Re-run any time:
`node redesign/qa/audit.mjs` (green across all 64 views as of this commit).

---

## What is genuinely good — keep, and don't let implementation water it down

- **Every state carries its reason inline.** Skips name the reserve that would be breached,
  killed names the hard stop, timeouts count the streak ("3rd in a row"), stopped is explicitly
  "not a failure". This is the single best property of the design.
- **Consequence lines before commitment.** Job dialog footer ("2 schedules → next fire ≈ 11:50
  today"), burn-down ("Creates 5 one-shot fires… each fire still passes the guard"), burst
  ("stops at 47% measured or 6 runs · cancel any time"), danger zone (what survives each action).
- **The planning dialogs** (burn-down, burst) are best-in-class: learned per-run cost with
  sample counts, a confidence band that admits uncertainty, excluded items that say *why*, and
  the fail-closed rule stated up front.
- **Validation dialog**: summary + ringed fields + "everything you typed is still here".
- **The escalation ladder** Off/Hold/Soft/Hard permanently in the bar, each mode's banner
  stating its exact promise (what continues, what stops, how it's recorded).
- **The acceptEdits warning** in the job dialog ("cannot run tests or commit — if this job is
  expected to verify or land its work, it needs auto") encodes a real operational lesson.
- **Disabled ≠ missing**: disabled run buttons keep a tooltip with the reason.
- **Red-state dot forms** (solid fail / ring timeout / square killed) are always backed by text
  labels — the encoding is a bonus, never the only channel. Colour-vision-safe.
- **Empty states** name what was checked (directory, filter, 14 jobs) and offer the next action.
- Calm quiet state ("Nothing needs you" + what was checked) instead of blank space.

## Fixed in place — objective defects, measured before and after

| Defect | Where | Measured | Fix |
|---|---|---|---|
| Hidden tooltip widened every page: 48px horizontal scroll (scrollWidth 1328 vs 1280) — `opacity:0` boxes still occupy scrollable area | all 32 pages | breadth gate | `.appbar .themebtn::after` right-aligned (launchbox.css); hover re-verified on-screen, no overflow |
| UA-default yellow `<mark>` on log error lines — stranded light surface in dark, unstyled in light | runs-log-failed | stranded gate (lum .93 box) | `.logview mark` → `--bad-wash` / `--bad` |
| `input[type=number]`/`[type=time]` fields unthemed (UA white in dark) — system.css selector only covered text/search/date | dialog-new-job schedule rows, timeout/retries | stranded gate | widened the shared field selector in system.css |
| **AA contrast: 388 raw failures across the 64 views → 0.** Worst: light `--ink-3` meta text 2.42:1, dark seg counts 3.03:1, links 4.14:1, P1 pill 2.89:1 | every page, both themes | WCAG engine (exact sRGB, composited backgrounds) | token layer only — see table below |
| Sample-moment contradiction: "2 running" chip on a page claiming zero jobs exist | jobs-empty | eyeball | chip removed |

Token changes (light in `system.css`, dark in `launchbox.css`) — hue jobs unchanged, everything
stays on its declared slot:

| Token | Before | After | Ratio before → after (worst legit surface) |
|---|---|---|---|
| light `--ink-2` | `#67717E` | `#5F6975` | 4.45 → 5.02 (on surface-3) |
| light `--ink-3` | `#98A2AD` | `#666F7D` | 2.33 → 4.57 (on surface-3) |
| light `--info` | `#2C7BE5` | `#2368C9` | links 3.86 → 5.03; white-on-primary 4.14 → 5.39 |
| light `--ok` / `--warn` / `--muted` | `#2A8F45` / `#B0701A` / `#7B8794` | `#25803D` / `#9A6217` / `#68737F` | 4.11 / 4.06 / 3.66 → all ≥ 4.6 |
| light `.dash` | `#C7CDD4` | `#6B7683` | 1.60 → 4.62 |
| `--deg-3` (P1 pill bg) | `#B8933C` | `#8A6D1F` | white text 2.89 → 4.90 |
| `--deg-2-ink` | `#8A6D1F` | `#7E641C` | 4.42 → 5.09 |
| dark `--ink-3` | `#68737F` | `#87919D` | 3.03 → 4.57 (on surface-3) |
| dark `.dash` | `#454F5B` | `#7E8994` | 2.08 → 4.85 |
| dark `--deg-3` | `#A5843A` | `#7A621F` | 2.95 → 4.89 |

> ✓ Backported upstream (1 Aug): the same ten changes are applied to the **dense-product-ui**
> skill — `assets/system.css` (9 token/value subs + the widened field selector),
> `references/rules.md` (8 hex mentions), and the kitchen-sink swatch labels.

## Recommendations — reviewed with owner 1 Aug, **all nine adopted and applied to the mockups**

1. **Pause modes contradict the Next-24h panel.** Banner says fires are dropped; the panel
   still lists nine fires with no hint. Add a header note while Hold/Soft/Hard is active
   ("listed, but dropped while Hold is on").
2. **Unreachable/token-invalid pages leave every button armed.** The banner says "buttons will
   fail until you reopen", yet New job / Refresh / row actions render fully enabled. Disable
   mutating controls with reason tooltips while the daemon is unreachable — a dead button that
   explains itself beats a live one that lies.
3. **Modals have no explicit Cancel** — only ✕ and (presumably) Esc. Add a plain Cancel button
   in the footer; cheap, conventional, reduces exit anxiety in a dialog that asks for Touch ID.
4. **Sessions compact view shows 8 red "Delete" links at once** — alarm noise for the rarest
   action on the page. Mute to ink-3, red on hover/focus; keep the arm-then-confirm.
5. **CSS-only tooltips are invisible to keyboard and screen readers.** At implementation:
   every `iconbtn` gets `aria-label`, and `[data-tip]` also shows on `:focus-visible`.
6. **Validation summary items should be links** that focus the offending field (3 errors → 3
   anchors). Mockup shows the right content; wire the behaviour.
7. **Approval-waiting says the form is frozen but doesn't look frozen.** Dim/disable the
   fields while the Touch ID prompt is pending so sight matches copy.
8. `is-stale` dimming (opacity .58) is barely perceptible in dark — consider a per-card
   "as of 09:40" stamp or stale chip in addition. Minor.
9. `uchip__k` at 10px is the smallest text in the app; 10.5px (`t-eyebrow` size) would close
   the scale. Minor.

**How each landed** (1–4, 6–9 visible in the mockups; 5 partly a build-time contract):
suppression note in all three pause pages' Next-24h header (1); every mutating control on the
unreachable/token pages is now `disabled` with the reason in its tooltip, planner links muted
(2); Cancel added to all five committing dialog footers — approval-waiting deliberately left
alone (3); session Delete buttons quiet (`ink-3`, red on hover/focus), armed confirm still red
(4); `[data-tip]:focus-visible` shows tooltips, theme toggle has `aria-label` on all pages,
jobs.html carries the full aria-label exemplar on 56 icon buttons — repo-wide labels are an
implementation task (5); validation summary items are links (behaviour wired at build) (6);
disabled fields now render at .55 opacity so the frozen approval form looks frozen (7);
"as of 09:40:58" stamps on every stale card head (8); `uchip__k` 10.5px (9).

## Considered and deliberately *not* flagged (pushback withheld, with reasons)

- **Trash icon on every row** next to the enable switch — normally a misclick hazard, but
  deletion here is confirm-gated and this is a single-operator tool. Fine.
- **Always-visible action icons** (vs hover-reveal) — right call for an ops surface; hover-only
  actions are a discoverability tax.
- **Mono-heavy typography** — consistent with the "machine output is mono" rule; it's a
  scheduler, nearly everything is machine output.
- **1120px pillar-box** and **dark default** — both right for an always-open local dashboard.
- **Run ▶ on running rows** — already disabled with a reason tooltip. Verified in markup.

## Not tested (moves to implementation gates)

Keyboard navigation, screen-reader semantics, real interaction flows (dialogs open/close,
filter behaviour — static mockups have no JS beyond the theme toggle), phone/tablet widths,
RTL. The breadth/contrast/stranded gates in `qa/audit.mjs` are ready to be pointed at the
implemented app; interaction gates get built per the ui-verify method during implementation.
