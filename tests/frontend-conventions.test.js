// Conventions the frontend must keep, enforced rather than documented.
//
// The old UI's rules lived here; cutover C3 (claude-scheduler-axg.6) deleted
// that UI. Its fetch/EventSource/api()/approval-vocabulary rules have /v2
// equivalents in frontend-v2-conventions.test.js, the airlock confirm is pinned
// in frontend-v2-projects.test.js, and vendored files are pinned by
// vendored-assets.test.js. The one rule with no /v2 copy is the native title=
// ban, kept below and re-scoped to public/v2/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const V2 = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'v2');

// Own sources only — assets/ holds the vendored D3 and byte-copies of
// redesign/assets, neither of which is ours to edit.
const sources = () => readdirSync(V2, { recursive: true })
  .filter((n) => /\.(m?js|html)$/.test(n) && !n.startsWith('assets'))
  .map((n) => [n, readFileSync(join(V2, n), 'utf8')]);

function nativeTitleOffenders(files) {
  // Two shapes put a native title on a control: markup (`<button title=…>`)
  // and ui.js's el() builder (`el('button', { title: … })`), which
  // setAttribute()s every key it is given.
  const MARKUP = /<(button|a|input|select)\b([^>]*)>/gi;
  const BUILDER = /\bel\(\s*['"](button|a|input|select)['"]\s*,\s*\{([^}]*)\}/g;
  const offenders = [];
  for (const [name, src] of files) {
    for (const [re, attr] of [[MARKUP, /\btitle\s*=/], [BUILDER, /(^|[\s,{])['"]?title['"]?\s*:/]]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        if (!attr.test(m[2])) continue;
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${name}:${line} <${m[1]}> ${m[0].slice(0, 80)}`);
      }
    }
  }
  return offenders;
}

test('the title= scan catches both offender shapes and passes data-tip', () => {
  // Known answers, so a broken regex cannot report the real tree as clean.
  assert.equal(nativeTitleOffenders([['a.js', '`<button class="x" title="Run">`']]).length, 1);
  assert.equal(nativeTitleOffenders([['a.html', '<a href="#" title="Go">']]).length, 1);
  assert.equal(nativeTitleOffenders([['a.js', "el('button', { class: 'b', title: 'Run' })"]]).length, 1);
  assert.equal(nativeTitleOffenders([['a.js', "el('input', {'title': t})"]]).length, 1);
  assert.deepEqual(nativeTitleOffenders([['a.js', "el('button', { 'data-tip': 'Run' })"]]), []);
  assert.deepEqual(nativeTitleOffenders([['a.js', "el('div', { title: 'x' }); pageHead({ title: 'Runs' })"]]), []);
});

test('no native title= remains on an interactive control in public/v2/', () => {
  // claude-scheduler-25h: native title= is slow to appear, unstyled, and
  // unreachable by keyboard — data-tip (one delegated listener, focusin
  // support, token-themed) replaces it. iconBtn() wiring data-tip is pinned
  // in frontend-v2-conventions.test.js; this catches a control built by hand.
  const files = sources();
  assert.ok(files.length >= 10, `expected the /v2 sources, found ${files.length}`);
  const offenders = nativeTitleOffenders(files);
  assert.deepEqual(offenders, [],
    'interactive control carries a native title= — use data-tip instead:\n' + offenders.join('\n'));
});
