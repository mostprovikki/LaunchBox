// tests/beads-graph.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { localiseGraphHtml, externalOrigins, D3_CDN_SRC, LOCAL_D3_SRC } from '../lib/beads-graph.js';

const page = (src) => `<!doctype html><html><body><svg id="graph"></svg>
<script src="${src}"></script>
<script>const nodes = [{"id":"x"}];</script></body></html>`;

test('the CDN script reference is rewritten to the vendored copy', () => {
  const out = localiseGraphHtml(page(D3_CDN_SRC));
  assert.equal(out.rewrote, 1);
  assert.ok(out.html.includes(`src="${LOCAL_D3_SRC}"`));
  assert.ok(!out.html.includes('d3js.org'), 'no trace of the CDN may survive');
});

test('an external origin the rewrite does not know about is refused, not served', () => {
  // Fail closed: bd could add another CDN in a future version, and quietly
  // serving it would put third-party script in the daemon's origin.
  assert.throws(() => localiseGraphHtml(page('https://evil.example.com/x.js')),
    (e) => e.code === 'graph_external_origin');
});

test('externalOrigins reports hosts from src and href, and ignores inline content', () => {
  assert.deepEqual(externalOrigins(page(D3_CDN_SRC)), ['d3js.org']);
  assert.deepEqual(externalOrigins('<p>see https://example.com in this text</p>'), []);
});

test('an oversized page is refused rather than streamed', () => {
  const big = page(D3_CDN_SRC) + 'x'.repeat(2_000_001);
  assert.throws(() => localiseGraphHtml(big), (e) => e.code === 'graph_too_large');
});
