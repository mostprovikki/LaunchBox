// /v2 entry point. Registers every route, mounts the appbar chrome, then
// starts the router. See public/v2/README.md for the frozen contract wave-2
// (B1/B2/B3/C1/C2/C3) and wave-3 (D1/D2) agents build against.
import { registerRoute, startRouter, captureTokenFromHash, onRender } from './router.js';
import { mountChrome } from './chrome.js';
import { onAuthState, degradedReason } from './api.js';
import { disableMutatingControls, setDisabledReason } from './ui.js';

import overview from './pages/overview.js';
import jobs from './pages/jobs.js';
import runs from './pages/runs.js';
import projects from './pages/projects.js';
import project from './pages/project.js';
import sessions from './pages/sessions.js';
import session from './pages/session.js';
import settings from './pages/settings.js';
import graph from './pages/graph.js';

registerRoute('overview', overview);
registerRoute('jobs', jobs);
registerRoute('runs', runs);
registerRoute('projects', projects);
registerRoute('project', project);
registerRoute('sessions', sessions);
registerRoute('session', session);
registerRoute('settings', settings);
// The 9th route (claude-scheduler-vo4.5): the per-project bead dependency
// graph, reached from the project detail page rather than the appbar nav.
registerRoute('graph', graph);

// REVIEW #2's central sweep — the ENTIRE contract a wave-2 page needs is the
// `data-mutating` attribute (README.md). Two triggers, both required:
//  - onAuthState: an already-rendered page must go dead the instant the
//    daemon becomes unreachable / the token is rejected, not on next render.
//  - onRender: a route navigated to WHILE already degraded must render its
//    controls disabled from the start — an auth-state-change-only sweep
//    would miss this (no transition happens on a plain route render), which
//    a coordinator review of this bead caught with a live probe.
//  - a MutationObserver: a page that re-renders from its OWN poll (rather
//    than from a route change) rebuilds its controls as brand-new nodes, and
//    neither trigger above fires for that. With the daemon down, jobs.js's 4s
//    poll therefore resurrected every control it had just been swept out of —
//    a banner reading "unavailable" above a page full of live buttons, which
//    is precisely the lie REVIEW #2 exists to prevent. Found by E2's
//    daemon-down gate (claude-scheduler-btv.14), which is what that gate is
//    for.
//
//    Fixed here rather than by adding a sweep call to each page: three pages
//    were missing one, and "remember to call it" is not a contract — the
//    README promises that adding `data-mutating` is the WHOLE job, and this
//    is what makes that promise true. Same lesson as B3's Cleanup button:
//    cover the guarantee, not one instance of it.
// Subscribed before startRouter() so the very first render is covered too.
function sweepMutatingControls() {
  disableMutatingControls(document.body, degradedReason());
}
onAuthState(sweepMutatingControls);
onRender(sweepMutatingControls);

// Only sweeps the subtrees that were ADDED, so a steady page costs nothing;
// the whole-body sweeps above still handle state transitions. Guarded on
// `degradedReason()` so the observer is inert while everything is healthy —
// it must never re-disable a control that is fine.
const mutatingObserver = new MutationObserver((records) => {
  const reason = degradedReason();
  if (!reason) return;
  for (const rec of records) {
    for (const node of rec.addedNodes) {
      if (node.nodeType !== 1) continue;
      disableMutatingControls(node, reason);
      if (node.matches?.('[data-mutating]')) setDisabledReason(node, reason);
    }
  }
});
mutatingObserver.observe(document.body, { childList: true, subtree: true });

// Capture a delivered #token= BEFORE mountChrome(), which fires its first
// api() poll immediately — otherwise a legitimate cold `claude-scheduler
// open` deep link would 401 its very first request (see router.js's comment
// on captureTokenFromHash()). startRouter() calls this again on its own
// render pass; a second, no-op call here is cheap and correct either way.
captureTokenFromHash();
mountChrome();
startRouter();
