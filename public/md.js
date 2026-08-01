// Thin wrapper: marked -> DOMPurify -> element. One sanitiser config, so a
// later edit cannot route transcript text around it (pinned by
// tests/frontend-conventions.test.js: "transcript content reaches the DOM
// only via md.js").
//
// Both dependencies are vendored verbatim in public/vendor/ — see NOTICE and
// docs/specs/2026-07-27-sessions-tab-visual-design.md for why they were safe
// to vendor (single-file, zero-bare-specifier browser-ESM builds) and what a
// CDN build of the same libraries would have broken.
import { marked } from './vendor/marked.esm.js';
import createDOMPurify from './vendor/purify.es.mjs';

// DOMPurify's default export is a factory over a `window`. In the browser
// this is `window` itself; tests (tests/md.test.js) pass a jsdom window so the
// same sanitiser config runs without a browser.
const DOMPurify = createDOMPurify(typeof window !== 'undefined' ? window : undefined);

marked.setOptions({ gfm: true, breaks: true });

// The one sanitiser config every render goes through. Kept narrow — a
// transcript is Claude Code's own prompts and tool text, not a page that needs
// forms, iframes or media embeds. `FORBID_ATTR` names the specific attack
// classes settled by tests/md.test.js (`onerror` et al.); DOMPurify already
// strips `javascript:`/`data:` hrefs and `<script>` by default, but naming a
// few here keeps the intent readable at the call site.
export const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'img',
  ],
  ALLOWED_ATTR: ['href', 'title', 'alt', 'src', 'class'],
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'style'],
};

/** Markdown source -> sanitised HTML string. Pure; no DOM writes. */
export function renderMarkdown(src) {
  const html = marked.parse(String(src ?? ''), { async: false });
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

/** Render into an element via the one sanitiser config, in one call. */
export function renderMarkdownInto(el, src) {
  el.innerHTML = renderMarkdown(src);
}
