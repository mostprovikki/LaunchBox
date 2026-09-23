#!/usr/bin/env node
// The /v2 ↔ existing-UI parity gate (claude-scheduler-btv.15 / E3).
//
//   npm run qa:v2:parity
//
// A hand-written parity checklist goes stale the day after it is written. This
// derives the comparison mechanically — every `/api/` path each UI actually
// calls — and holds it against a DECLARED list of accepted differences, each
// with a reason. A new divergence in either direction fails the gate.
//
// What it is NOT: proof that the two UIs behave identically. It proves the
// surfaces match, and names the places they deliberately do not. The
// behavioural half is E1's route walk and E2's interaction battery.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const log = (m) => process.stdout.write(m + '\n');

/**
 * Differences that are DELIBERATE, each with the reason and who decided it.
 * The gate fails on anything not listed here, in either direction — so the
 * cost of a silent divergence is a red build rather than a discovery after
 * cutover.
 */
export const ACCEPTED = Object.freeze([
  {
    endpoint: '/api/budget',
    side: 'old-only',
    status: 'covered differently',
    why: 'The existing UI reads GET /api/budget for its budget-state line. /v2 gets the same '
      + 'facts through GET /api/v2/overview (which calls policy.explain() server-side) for the '
      + 'Overview meters, and edits the reserve/warn/critical values on Settings. No capability '
      + 'is lost; the call is simply not made from the browser.',
  },
  {
    endpoint: '/api/v2/overview',
    side: 'v2-only',
    status: 'additive by design',
    why: 'btv.2 (C1a). One aggregation endpoint for the Overview tab; nothing existing reads it.',
  },
  {
    endpoint: '/api/v2/projects/:id/graph.html',
    side: 'v2-only',
    status: 'additive by design',
    why: 'claude-scheduler-vo4 (beads visualizer Phase A). Serves bd\'s own `bd graph --all --html` '
      + 'page for one project, with its CDN reference rewritten to the vendored D3 and a CSP that '
      + 'forbids it calling out. Read-only and additive: the existing UI has no dependency-graph '
      + 'view at all, so there is nothing for it to lose at cutover.',
  },
  {
    endpoint: '/api/v2/projects/:id/graph-ticket',
    side: 'v2-only',
    status: 'additive by design',
    why: 'claude-scheduler-vo4.8. The graph frame above is a DOCUMENT navigation, which carries '
      + 'no Authorization header — so pointing an iframe at it got 401 JSON where the graph '
      + 'should be. This mints the single-use, 30-second, project-bound ticket the frame\'s URL '
      + 'carries instead, so the API token never enters a URL. Additive and paired with the '
      + 'graph page: the existing UI has no dependency-graph view, so it needs neither.',
  },
  {
    endpoint: '/api/v2/plan-candidates',
    side: 'v2-only',
    status: 'additive by design',
    why: 'btv.12 (D2). Per-job learned cost and the guard\'s decoded reason, so the burn-down '
      + 'planner does not have to parse lib/budget.js\'s English.',
  },
]);

/**
 * Differences that WERE declared and have since been CLOSED — the endpoint is
 * now called by both UIs. Kept as a record rather than deleted, so the review
 * that decided it is still readable at cutover.
 *
 * Why these are not simply left in ACCEPTED with the status reworded: an
 * ACCEPTED entry that is no longer a difference is reported as STALE (below),
 * on purpose — a dead exemption is how a real gap later slips through. So a
 * closed gap has to move out of the exemption list, and it gets the mirror-image
 * check instead: a RESOLVED endpoint that stops being called by BOTH UIs fails
 * the gate, because that means the gap quietly reopened.
 */
export const RESOLVED = Object.freeze([
  {
    endpoint: '/api/awake',
    was: 'old-only',
    status: 'covered',
    decided: '2026-09-23',
    why: 'Declared a GAP by btv.15: the existing UI could hold the Mac awake on demand '
      + '(PUT /api/awake) and /v2 could not, because no redesign mockup draws that control. '
      + 'The OWNER DECIDED on 2026-09-23 that the keep-awake capability is NOT being dropped in '
      + 'the redesign, so btv.16 built the appbar control in public/v2/chrome.js — the same '
      + 'modes as the old menu (off / while jobs are scheduled / timed 30m, 1h, 4h, 8h / '
      + 'indefinitely), reading GET /api/awake on the appbar poll and writing PUT /api/awake. '
      + 'No capability is lost at cutover; the Settings page keeps `awakeResetLeadMin` as before.',
  },
]);

/**
 * Pull the `/api/...` paths a set of modules calls. Template placeholders
 * collapse to `:id` so `/api/jobs/${job.id}` and `/api/jobs/:id` compare equal,
 * and a path built with a VARIABLE trailing segment (runs-log.js's
 * `/api/runs/${id}/${action}`) collapses the same way — that one is why the
 * comparison cannot be a naive string diff.
 */
export function apiCalls(files) {
  const out = new Set();
  for (const f of files) {
    const raw = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const m of raw.matchAll(/['"`](\/api\/[^'"`\s]*)/g)) {
      let p = m[1]
        .replace(/\$\{[^}]*\}/g, ':id')   // template holes
        .split('?')[0]                     // query strings are not surface
        .replace(/\/+$/, '');
      // A path that still holds a partial template (an unbalanced `${`) is a
      // parse artefact, not an endpoint — dropping it silently would be a hole,
      // so it is normalised to its literal prefix instead.
      p = p.split('${')[0].replace(/\/+$/, '');
      if (p.length > '/api'.length) out.add(p);
    }
  }
  return out;
}

const jsUnder = (dir, { recursive = false } = {}) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (recursive) out.push(...jsUnder(p, { recursive }));
      continue;
    }
    if (name.endsWith('.js')) out.push(p);
  }
  return out;
};

/**
 * `:id` segments make two different endpoints look alike in one direction:
 * `/api/runs/:id/:id` (v2's variable action) covers `/api/runs/:id/kill` and
 * `/api/runs/:id/stop`. Treated as covered when the shapes match segment for
 * segment with `:id` as a wildcard.
 */
export function covers(candidate, target) {
  const a = candidate.split('/');
  const b = target.split('/');
  if (a.length !== b.length) return false;
  // `:id` is a wildcard on EITHER side. The first version only honoured it on
  // the candidate, so v2's variable action segment (`/api/runs/:id/:id`, built
  // as `/api/runs/${id}/${action}`) was reported as an undeclared v2-only
  // endpoint even though the existing UI calls both concrete forms it stands
  // for. A one-directional wildcard is a false positive generator, and a
  // parity gate that cries wolf is one nobody reads before a cutover.
  return a.every((seg, i) => seg === b[i] || seg === ':id' || b[i] === ':id');
}

export function compare({ oldCalls, v2Calls, accepted = ACCEPTED, resolved = RESOLVED }) {
  const acceptedFor = (endpoint, side) => accepted.find((a) => a.endpoint === endpoint && a.side === side);
  const oldOnly = [...oldCalls].filter((e) => ![...v2Calls].some((c) => covers(c, e))).sort();
  const v2Only = [...v2Calls].filter((e) => ![...oldCalls].some((c) => covers(c, e))).sort();

  const findings = [];
  const known = [];
  // An endpoint on the CLOSED-gap record gets its own, more precise finding
  // below ("the gap has reopened") rather than the generic undeclared one —
  // two findings for one cause reads like two problems.
  const resolvedEndpoints = new Set(resolved.map((r) => r.endpoint));
  for (const e of oldOnly) {
    const a = acceptedFor(e, 'old-only');
    if (a) known.push(a);
    else if (!resolvedEndpoints.has(e)) findings.push({ endpoint: e, side: 'old-only', detail: 'the existing UI calls this and /v2 does not — undeclared' });
  }
  for (const e of v2Only) {
    const a = acceptedFor(e, 'v2-only');
    if (a) known.push(a);
    else if (!resolvedEndpoints.has(e)) findings.push({ endpoint: e, side: 'v2-only', detail: '/v2 calls this and the existing UI does not — undeclared' });
  }
  // An accepted entry whose endpoint is no longer a difference is stale, and a
  // stale exemption is how a real gap later slips through unnoticed.
  for (const a of accepted) {
    const stillDiffers = a.side === 'old-only' ? oldOnly.includes(a.endpoint) : v2Only.includes(a.endpoint);
    if (!stillDiffers) findings.push({ endpoint: a.endpoint, side: a.side, detail: 'declared as a difference but is no longer one — remove it from ACCEPTED' });
  }
  // The mirror image: a gap recorded as CLOSED must stay closed. If either UI
  // stops calling the endpoint, the capability difference is back — and a
  // record saying "covered" over a reopened gap is worse than no record.
  for (const r of resolved) {
    const inOld = [...oldCalls].some((c) => covers(c, r.endpoint));
    const inV2 = [...v2Calls].some((c) => covers(c, r.endpoint));
    if (inOld && inV2) continue;
    const who = !inV2 ? '/v2 no longer calls it' : 'the existing UI no longer calls it';
    findings.push({
      endpoint: r.endpoint,
      side: r.was,
      detail: `recorded as resolved (${r.decided}) but ${who} — the gap has reopened`,
    });
  }
  return { ok: findings.length === 0, findings, known, resolved: [...resolved], oldOnly, v2Only, shared: [...oldCalls].filter((e) => v2Calls.has(e)).length };
}

export function loadCalls() {
  return {
    oldCalls: apiCalls(jsUnder(join(REPO, 'public'))),
    v2Calls: apiCalls(jsUnder(join(REPO, 'public', 'v2'), { recursive: true })),
  };
}

function main() {
  const { oldCalls, v2Calls } = loadCalls();
  const r = compare({ oldCalls, v2Calls });

  log(`· ${r.shared} endpoints called by both UIs`);
  log('\n· declared differences');
  for (const k of r.known) {
    log(`  [${k.status}] ${k.endpoint} (${k.side})`);
    log(`      ${k.why.replace(/\s+/g, ' ')}`);
  }
  if (r.resolved?.length) {
    log('\n· closed gaps (recorded, and re-checked every run)');
    for (const k of r.resolved) {
      log(`  [${k.status}] ${k.endpoint} (was ${k.was}) — decided ${k.decided}`);
      log(`      ${k.why.replace(/\s+/g, ' ')}`);
    }
  }
  log('');
  if (r.ok) {
    log('parity gate clean — every difference between the two UIs is declared');
    const gaps = r.known.filter((k) => k.status.startsWith('GAP'));
    if (gaps.length) {
      log('');
      log(`⚠ ${gaps.length} declared difference(s) still need the owner's decision before cutover:`);
      for (const g of gaps) log(`   · ${g.endpoint}`);
    }
  } else {
    log(`parity gate FAILED — ${r.findings.length} undeclared difference(s):`);
    for (const f of r.findings) log(`  ${f.side}: ${f.endpoint} — ${f.detail}`);
  }
  return r.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
