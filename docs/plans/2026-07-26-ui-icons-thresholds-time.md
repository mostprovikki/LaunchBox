# UI polish — real icons, honest thresholds, human reset times

Small, user-requested, ahead of [M5](2026-07-25-m5-sessions-dashboard.md). Verify: `npm test` +
live CDP drive + `npm run screenshots`.

Scope is deliberately narrow. Three asks, taken verbatim: a terminal mark instead of `＄` and
Claude's mark for claude jobs; a reset countdown that changes unit with distance; amber at 75%
and red at 85%. Explicitly **out** of scope: light mode, mobile, and every other UI wart —
including the two filed from the v0 screenshot session.

## 1. An icon set, because the app has none

Today every icon in the app is an inline unicode glyph and there is no helper: `extensions/command`
declares `icon: '＄'` (U+FF04 **fullwidth** dollar), `extensions/claude` declares `'🤖'`, and
`lib/extensions.js:60` defaults to `'⚙'`. A fullwidth ASCII-art glyph next to a colour emoji is
the actual complaint — they render at completely different optical weights and neither is
sized, because `.type-ico` (`style.css:128`) sets only `opacity`.

**`public/icons.js`** — new: a name→inline-SVG map plus `icon(name, opts)` and `iconFor(ext)`.
Two icons is enough to start; the Sessions tab (M5 §5.7) is the next consumer.

- `terminal` — Lucide `square-terminal` (**ISC**). Chosen over Lucide's `terminal` (a bare
  `❯_`) because the ask was "like the Terminal icon on mac", and that is a rounded window
  *frame* with a prompt inside.
- `claude` — the 12-ray stroke sunburst from `claude-sessions-dashboard` (**MIT ©
  wannabemrrobot**, `claude-sessions:984`), whose author marks it as bespoke and describes it as
  echoing Claude's mark. Deliberately **not** the official Anthropic asset: that is a
  trademarked logo file, and vendoring a trademark into a repo is a different decision from
  vendoring MIT code. This is a mark that reads as Claude, under a licence we can satisfy.

**Extension contract, additive:** a manifest may declare `iconName: 'terminal' | 'claude'`.
Resolution is `iconName` → our SVG set, else the existing `icon` glyph, else `⚙`. An
*unknown* `iconName` falls back to the glyph rather than rendering nothing — an icon is
decoration, and a third-party extension pinned to a future name must not lose its label.
`icon` stays supported and documented; `_template` keeps its `🧩`.

Name lookup is a map read, so a manifest can never inject markup — the value is never
interpolated into HTML.

Three render sites, all `public/app.js`: jobs-list row title (`:101`), the job-dialog type
segmented control (`:416-421`), the Settings per-extension legend (`:751`). Plus `.type-ico svg`
sizing in CSS so the mark aligns to the text baseline instead of inheriting `font-size`.

## 2. Reset countdown: change unit with distance

`untilText` (`public/usage.js:26-34`) is h+m forever, so a weekly reset six days out reads
`in 148h 12m`. It also has a live rounding bug: `Math.round` on the minutes remainder renders
3h 59m 40s as **`3h 60m`**.

Replaces it with `whenText(iso)` in `public/util.js` — shared, because M5's session cards want
the same scale:

| Distance | Renders |
|---|---|
| past / <1m | `now` / `in under a minute` |
| < 1h | `in 43m` |
| < 24h | `in 3h 20m` (floor + carry, so never `3h 60m`) |
| next calendar day | `tomorrow 11:30 PM` |
| < 7d | `Sat 11:30 PM` |
| ≥ 7d | `Sat 2 Aug, 11:30 PM` |

**Deviation from the ask, stated so it can be overruled:** the request was "1 or 2 days if
short". `tomorrow 11:30 PM` and `Sat 11:30 PM` carry strictly more information than `in 2 days`
in the same width — the question a reset countdown answers is *"does it land before I stop
working"*, and a day count can't answer it. Day-scale relative wording is dropped in favour of
naming the day.

"Tomorrow" is decided by **calendar date**, not a 24h offset, so 11pm→7am next day is
"tomorrow" and not "in 8h". Both bands can be right at once; the 24h rule wins first because at
that distance the countdown is still actionable.

Timezone stays implicit-local (the browser's), which is already true everywhere in the app —
but `fullTime` gains `timeZoneName: 'short'`, so every tooltip that already carried an absolute
time now names the zone. That is where "IST" belongs: on hover, not in a 11.5px label.

## 3. Amber 75, red 85 — display only

The display thresholds and the budget guard's policy numbers are **separate by design** and
coincidentally share the values 80/95. Only display changes here; `lib/budget.js`'s
`reserveFiveHourPct`/`reserveWeeklyPct` decide whether a run *fires* and are untouched.

- `usageWarnPct` default **80 → 75** (`server.js:284`, and the frontend's own fallback at
  `public/usage.js:91`, which must not disagree).
- `FAIL_PCT = 95` hardcoded at `public/usage.js:10` becomes a setting, `usageCritPct`, default
  **85**, validated `1-99` **and** `> usageWarnPct`.

Why promote it to a setting rather than edit the constant: with warn a knob (1-99) and crit
fixed, any warn above the constant made **warn unreachable** — `fail` won every comparison.
Clamping hides that; a validated pair makes it impossible. Rejected `Math.min`/`Math.max`
patching for the same reason.

An existing install has `usageWarnPct: 80` persisted (the settings form submits every field, so
the old default was written out). 80 sits inside the new 75/85 pair, so **no migration** — it
stays whatever it was, and only fresh installs see 75.

`m.flagged` (severity from the CLI's own payload) keeps outranking neither threshold: order
stays crit → warn → flagged, so a bucket the API marked `critical` still colours at any percent.

## 4. Tests

`public/` has no unit coverage in this repo, so:

- `usageCritPct` gets API tests beside the existing `usageWarnPct` ones: round-trip, out of
  range rejected, and **`crit <= warn` rejected without storing** (the partial-write trap M4a
  already hit once in the settings PUT).
- Everything else is verified by driving the live UI and by a `npm run screenshots` diff against
  `v1` — which is the whole reason that harness exists.
</content>
