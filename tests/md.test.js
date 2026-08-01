// public/md.js (marked -> DOMPurify -> string) and the hand-rolled JSON
// highlighter in public/transcript.js, as pure functions. Per the repo's own
// rule (docs/specs/2026-07-27-sessions-tab-visual-design.md's Testing
// section): settled by RUNNING the attack against the real sanitiser config,
// not by trusting that DOMPurify is configured correctly.
//
// A jsdom window is installed before md.js is imported, because DOMPurify's
// default export is a factory bound to whatever `window` existed at import
// time (public/md.js: `createDOMPurify(typeof window !== 'undefined' ? window
// : undefined)`) — this is the browser build, unmodified, so the test has to
// give it a real DOM rather than a mock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { renderMarkdown } = await import('../public/md.js');
const { highlightJson } = await import('../public/transcript.js');

test('plain markdown renders as expected HTML', () => {
  const out = renderMarkdown('**bold** and _em_ and a [link](https://example.com)');
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>em<\/em>/);
  assert.match(out, /<a href="https:\/\/example\.com">link<\/a>/);
});

test('ATTACK: <img onerror=…> is stripped, not merely escaped-and-kept', () => {
  const out = renderMarkdown('before <img src=x onerror="alert(document.cookie)"> after');
  assert.doesNotMatch(out, /onerror/i, `sanitiser let an event handler through: ${out}`);
  // The image tag itself may legitimately survive (src only) — what matters is
  // that no attribute on it can execute script.
  assert.doesNotMatch(out, /<script/i);
});

test('ATTACK: a javascript: link is neutralised', () => {
  const out = renderMarkdown('[click me](javascript:alert(document.cookie))');
  assert.doesNotMatch(out, /javascript:/i, `a javascript: URL survived sanitisation: ${out}`);
});

test('ATTACK: a fenced code block containing </script> cannot close the real tag', () => {
  const src = ['```js', 'console.log("</script><script>alert(1)</script>")', '```'].join('\n');
  const out = renderMarkdown(src);
  // The literal text must be HTML-escaped (part of a <code> block's text
  // content), never emitted as a real, parseable </script> boundary.
  assert.doesNotMatch(out, /<\/script>/i, `a literal </script> reached the output unescaped: ${out}`);
  assert.match(out, /&lt;\/script&gt;/);
});

test('a <script> tag anywhere in the source is removed entirely', () => {
  const out = renderMarkdown('hello <script>alert(1)</script> world');
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /alert\(1\)/);
});

test('an inline onclick handler on any allowed tag is stripped', () => {
  const out = renderMarkdown('<a href="https://example.com" onclick="alert(1)">go</a>');
  assert.doesNotMatch(out, /onclick/i);
});

// ---------- JSON syntax highlighter (public/transcript.js) ----------

test('highlightJson walks the parsed value by type, not by re-stringifying text', () => {
  const html = highlightJson({ tool: 'Bash', ok: true, count: 3, note: null });
  // esc() HTML-escapes the quotes JSON.stringify puts around a key/string, so
  // a rendered key reads as &quot;tool&quot; — this is what makes the leaf
  // safe to drop straight into innerHTML.
  assert.match(html, /<span class="jt-key">&quot;tool&quot;<\/span>/);
  assert.match(html, /<span class="jt-str">&quot;Bash&quot;<\/span>/);
  assert.match(html, /<span class="jt-bool">true<\/span>/);
  assert.match(html, /<span class="jt-num">3<\/span>/);
  assert.match(html, /<span class="jt-null">null<\/span>/);
});

test('ATTACK: a string leaf containing markup is escaped, not injected', () => {
  const html = highlightJson({ command: '<img src=x onerror=alert(1)>' });
  // The whole point: an unescaped "<img ... onerror=...>" would be a live tag
  // if dropped into innerHTML. Escaped, it is inert text inside a <pre> — the
  // characters "onerror=alert(1)" surviving as visible text is fine and
  // expected; what must never survive is the actual tag delimiters.
  assert.doesNotMatch(html, /<img\b/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('highlightJson renders nested arrays and objects without throwing', () => {
  const html = highlightJson({ list: [1, 'two', { three: 3 }], empty: [], nothing: {} });
  assert.match(html, /<span class="jt-punc">\[<\/span>/);
  assert.match(html, /<span class="jt-punc">\{\}<\/span>/);
  assert.match(html, /<span class="jt-punc">\[\]<\/span>/);
});

test('highlightJson handles a bare null/primitive input without throwing', () => {
  assert.doesNotThrow(() => highlightJson(null));
  assert.doesNotThrow(() => highlightJson('a plain string'));
  assert.doesNotThrow(() => highlightJson(42));
});
