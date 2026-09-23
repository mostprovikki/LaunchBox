// Dependency graph page (claude-scheduler-vo4.5 / Task 5 of
// docs/superpowers/plans/2026-09-24-beads-visualizer-phase-a.md).
// Route: `#graph?id=<projectId>`, reached from the project detail page.
//
// Nothing here draws a graph. `bd graph --all --html` renders one, and
// GET /api/v2/projects/:id/graph.html serves that document with its CDN
// reference rewritten to the vendored D3 and a CSP that forbids it calling
// out. This module is only the chrome around that document.
//
// HOW THE FRAME IS LET IN (claude-scheduler-vo4.8). The frame is a DOCUMENT
// navigation, and a document navigation carries no Authorization header — so
// pointing it straight at the endpoint got it 401 JSON where the graph should
// be, observed in a browser. It is fixed here rather than by loosening the
// endpoint: this module first makes an ordinary authenticated call for a
// single-use, 30-second ticket bound to this project, and the frame's URL
// carries that ticket. The API token never enters a URL, a referrer or a log.
// The alternative — fetching the HTML and assigning `iframe.srcdoc` — was
// measured and rejected: srcdoc discards the response, and the response is
// where the CSP and nosniff live. Delivered that way an off-origin <script>
// ran inside the frame and an XHR from inside it read a secret back out.
//
// THE ISOLATION CONTRACT — read this before touching the iframe below.
// The frame is sandboxed with `allow-scripts` and nothing else. bd's page
// needs script to draw its SVG, but it must not ALSO be handed this document's
// origin: a frame given both can read #v2-page and lift the API session key
// out of localStorage, and can remove its own sandbox attribute outright. So
// the sandbox list is exactly one token, and tests/frontend-v2-graph.test.js
// reads this source to keep it that way — the assertion is at the source
// because an attribute is easy to widen quietly and impossible to observe
// from outside an opaque-origin frame.
//
// No markup-from-string anywhere in this file — no `html:` attributes, no
// <template>, no assignment of markup to a node. Every node is built with
// el() from ../ui.js, whose children go through createTextNode. Bead titles
// rendered inside the frame come from other people's repositories; nothing
// from them is ever parsed as markup by THIS document.
//
// WHAT PHASE A DOES NOT DO — stated on screen (#graph-phase-note) rather than
// left to read as an oversight: bd hardcodes its own status colours, so the
// frame ignores the design tokens and stays light in dark mode; there is no
// scheduler overlay, so a bead that is claimed, running or handed back looks
// like every other bead; and there is no copy-a-command panel. Phase B
// replaces this frame with a /v2-native render over the same node/link data.
import { api, degradedReason } from '../api.js';
import { $, el, clear, pageHead } from '../ui.js';

// The ticket, not the token, is what travels in the URL.
const graphSrc = (id, ticket) => `/api/v2/projects/${encodeURIComponent(id)}/graph.html`
  + `?ticket=${encodeURIComponent(ticket)}`;
const ticketPath = (id) => `/api/v2/projects/${encodeURIComponent(id)}/graph-ticket`;

function noteCard(id, title, lines, actions = []) {
  return el('section', { class: 'card', id, style: 'margin-bottom: 16px;' }, [
    title ? el('div', { class: 'card__head' }, el('h2', {}, title)) : null,
    el('div', { class: 'card__body' }, [
      ...lines.map((t) => el('p', { class: 't-meta', style: 'margin: 0 0 8px;' }, t)),
      actions.length ? el('div', { style: 'margin-top: 4px;' }, actions) : null,
    ]),
  ]);
}

// claude-scheduler-7j2's rule: a link that arrives without what it needs
// explains itself and offers a way on. It never renders an empty shell.
function missingIdPage(page) {
  page.appendChild(pageHead({ title: 'Dependency graph' }));
  page.appendChild(noteCard(null, 'No project id in the link', [
    'This page draws one registered project’s bead graph, so it needs to be told which project. '
    + 'The link that brought you here carried no id.',
    'Open a project from the Projects list and use its "Dependency graph" action — that link carries the id.',
  ], [el('a', { class: 'btn', href: '#projects' }, 'Back to Projects')]));
}

export default async function graph(params) {
  const page = $('#v2-page');
  if (!page) return;
  clear(page);

  const id = params?.get('id') ?? null;
  if (!id) { missingIdPage(page); return; }

  page.appendChild(el('div', { class: 't-meta', style: 'margin-bottom: 4px;' },
    el('a', { href: `#project?id=${encodeURIComponent(id)}` }, '← Project')));
  page.appendChild(pageHead({
    title: 'Dependency graph',
    sub: el('span', {}, [
      'Every bead in ',
      el('span', { class: 'mono' }, id),
      ' and what blocks what. Read-only.',
    ]),
  }));

  page.appendChild(noteCard('graph-phase-note', 'Phase A: what this view does not do yet', [
    'The graph below is bd’s own page (bd graph --all --html), embedded read-only in a sandboxed '
    + 'frame. It is the real dependency graph, and it is deliberately unfinished as a LaunchBox view.',
    'It does not follow the theme: bd hardcodes its status colours, so the frame stays light even in '
    + 'dark mode. It shows no scheduler state, so a bead that is claimed, running or handed back looks '
    + 'like any other. And there is nowhere yet to copy a bd command from.',
    'Phase B draws the same node and link data natively, which is what those three need.',
  ]));

  // The frame loads the endpoint as a document in its own right. With the
  // daemon unreachable or the session key rejected there is nothing to load,
  // and an empty frame would read as "this project has no beads" — which is a
  // different and much worse claim. Say which it is instead.
  const reason = degradedReason();
  if (reason) {
    page.appendChild(noteCard(null, 'The graph cannot be loaded', [
      reason,
      'This frame is fetched from the daemon every time it is opened — there is no cached copy to '
      + 'show. Nothing is wrong with the project’s beads; LaunchBox simply cannot read them right now.',
    ]));
    return;
  }

  // The one authenticated call this page makes. It buys the frame its entry;
  // a failure here is reported the same way a failed load would be, because
  // from the reader's position it is the same event — the graph is not there.
  let ticket = null;
  try {
    ticket = (await api('POST', ticketPath(id)))?.ticket ?? null;
  } catch (err) {
    const why = err?.status === 404
      ? 'LaunchBox has no project registered under that id, so there is no repository to read beads from.'
      : (err?.message ?? 'the daemon refused the request');
    page.appendChild(noteCard(null, 'The graph cannot be loaded', [
      why,
      'The frame is fetched from the daemon every time it is opened — there is no cached copy to show. '
      + 'Reopen this page to try again.',
    ], [el('a', { class: 'btn', href: '#projects' }, 'Back to Projects')]));
    return;
  }
  if (!ticket) {
    page.appendChild(noteCard(null, 'The graph cannot be loaded', [
      'The daemon answered without a frame ticket, so there is nothing to point the frame at.',
    ], [el('a', { class: 'btn', href: '#projects' }, 'Back to Projects')]));
    return;
  }

  page.appendChild(el('section', { class: 'card' }, [
    el('div', { class: 'card__head' }, [
      el('h2', {}, 'bd’s graph'),
      el('span', { class: 't-meta mono', style: 'margin-left:auto;' }, 'sandboxed frame'),
    ]),
    el('div', { class: 'card__body' }, [
      el('iframe', {
        id: 'graph-frame',
        src: graphSrc(id, ticket),
        sandbox: 'allow-scripts',
        referrerpolicy: 'no-referrer',
        title: `Bead dependency graph for ${id}`,
        // The frame's OWN background, visible only before bd's document paints.
        // It was #fff, which is wrong in both themes: bd's page is dark
        // (background:#1a1a2e), so white was a flash on load in light mode and a
        // stranded light surface in dark mode — which is what qa:v2's
        // stranded_surface rule caught. A token tracks the theme either way.
        style: 'width:100%;height:70vh;border:1px solid var(--line);border-radius:var(--r);background:var(--surface-2);',
      }),
      el('p', { class: 't-meta', style: 'margin: 10px 0 0;' },
        'The frame runs with script but without this page’s origin, so it can neither read this '
        + 'window nor reach the network. If it shows an error rather than a graph, that error is the '
        + 'daemon’s answer for this project — most often that bd could not read its database.'),
    ]),
  ]));
}
