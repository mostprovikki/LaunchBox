// Shared renderer for every route whose real content is a later bead. A2's
// job is the route + the chrome around it, not the page — see
// public/v2/README.md "What wave 2/3 build" and CLAUDE.md's scope note:
// "If you find yourself writing a jobs table, stop."
import { $, clear, el, pageHead } from '../ui.js';

export function renderPlaceholder({ title, bead, note, params }) {
  const page = $('#v2-page');
  if (!page) return;
  clear(page);
  page.appendChild(pageHead({ title, sub: `Content owned by ${bead} — this is a placeholder from btv.4 (A2).` }));
  const paramsLine = params && [...params.keys()].length
    ? el('p', { class: 't-meta mono' }, `deep-link params carried through: ${params.toString()}`)
    : null;
  page.appendChild(el('section', { class: 'card' }, el('div', { class: 'card__body' }, [
    el('p', { class: 't-meta' }, note ?? `The route, nav highlighting and API client are live. ${bead} fills this in.`),
    paramsLine,
  ])));
}
