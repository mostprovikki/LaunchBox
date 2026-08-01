// /v2 entry point. Registers every route, mounts the appbar chrome, then
// starts the router. See public/v2/README.md for the frozen contract wave-2
// (B1/B2/B3/C1/C2/C3) and wave-3 (D1/D2) agents build against.
import { registerRoute, startRouter, captureTokenFromHash, onRender } from './router.js';
import { mountChrome } from './chrome.js';
import { onAuthState, degradedReason } from './api.js';
import { disableMutatingControls } from './ui.js';

import overview from './pages/overview.js';
import jobs from './pages/jobs.js';
import runs from './pages/runs.js';
import projects from './pages/projects.js';
import project from './pages/project.js';
import sessions from './pages/sessions.js';
import session from './pages/session.js';
import settings from './pages/settings.js';

registerRoute('overview', overview);
registerRoute('jobs', jobs);
registerRoute('runs', runs);
registerRoute('projects', projects);
registerRoute('project', project);
registerRoute('sessions', sessions);
registerRoute('session', session);
registerRoute('settings', settings);

// REVIEW #2's central sweep — the ENTIRE contract a wave-2 page needs is the
// `data-mutating` attribute (README.md). Two triggers, both required:
//  - onAuthState: an already-rendered page must go dead the instant the
//    daemon becomes unreachable / the token is rejected, not on next render.
//  - onRender: a route navigated to WHILE already degraded must render its
//    controls disabled from the start — an auth-state-change-only sweep
//    would miss this (no transition happens on a plain route render), which
//    a coordinator review of this bead caught with a live probe.
// Subscribed before startRouter() so the very first render is covered too.
function sweepMutatingControls() {
  disableMutatingControls(document.body, degradedReason());
}
onAuthState(sweepMutatingControls);
onRender(sweepMutatingControls);

// Capture a delivered #token= BEFORE mountChrome(), which fires its first
// api() poll immediately — otherwise a legitimate cold `claude-scheduler
// open` deep link would 401 its very first request (see router.js's comment
// on captureTokenFromHash()). startRouter() calls this again on its own
// render pass; a second, no-op call here is cheap and correct either way.
captureTokenFromHash();
mountChrome();
startRouter();
