// lib/beads-graph.js
// `bd graph --html` calls its own output "self-contained". It is not: the page
// loads D3 from https://d3js.org. This daemon is local-only, so that reference
// is rewritten to a vendored copy before the page is ever served, and anything
// else pointing off-box is refused rather than passed through.
//
// The refusal path matters as much as the rewrite. A future `bd` version could
// swap in a different CDN; quietly serving that page would put third-party
// script inside the daemon's own origin, next to its API token. So this fails
// closed: an origin the rewrite does not recognise is an error, never output.
//
// Pure and I/O-free on purpose — it unit-tests without a daemon, a repo, or bd.
export const D3_CDN_SRC = 'https://d3js.org/d3.v7.min.js';
export const LOCAL_D3_SRC = '/v2/assets/d3.v7.min.js';
export const MAX_GRAPH_BYTES = 2_000_000;

// Only attribute URLs count as references the browser would actually fetch;
// a URL sitting in prose or in inline script data reaches nothing by itself.
const ATTR_URL = /(?:src|href)\s*=\s*["']https?:\/\/([a-zA-Z0-9.-]+)/g;

export function externalOrigins(html) {
  const hosts = new Set();
  for (const m of String(html).matchAll(ATTR_URL)) hosts.add(m[1]);
  return [...hosts];
}

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function localiseGraphHtml(html, { maxBytes = MAX_GRAPH_BYTES } = {}) {
  const src = String(html ?? '');
  // Cap before any work: a runaway graph should be refused, not buffered.
  if (Buffer.byteLength(src, 'utf8') > maxBytes) {
    throw fail(`the graph page is larger than ${maxBytes} bytes`, 'graph_too_large');
  }
  const parts = src.split(D3_CDN_SRC);
  const rewrote = parts.length - 1;
  const out = parts.join(LOCAL_D3_SRC);
  // Checked on the OUTPUT, after rewriting: whatever survives here is an origin
  // this module does not know how to make local, so the page is not served.
  const left = externalOrigins(out);
  if (left.length) {
    throw fail(`the graph page references ${left.join(', ')}`, 'graph_external_origin');
  }
  return { html: out, rewrote };
}
