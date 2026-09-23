// How `beads.graphHtml()` invokes bd. The subject is the *shape* of the call —
// the argv bd is handed, the directory it runs in, and how a repo that is
// already in use is reported — not the HTML, which is bd's to produce.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeBd } from './helpers.js';
import { createBeads, BeadsError, BD_TIMEOUT_MS } from '../lib/beads.js';

const PROJECT = { id: 'p1', path: '/repo', beadsDir: '/repo/.beads' };

test('graphHtml asks bd for the whole project graph as HTML', async () => {
  const bd = fakeBd({ graph: { stdout: '<html>graph</html>' } });
  const beads = createBeads({ execFileFn: bd });

  const html = await beads.graphHtml(PROJECT);
  assert.equal(html, '<html>graph</html>');
  // `--all` is the difference between the project's graph and whatever subset
  // bd would default to; `--html` is the difference between a page and DOT.
  assert.deepEqual(bd.calls[0].args, ['graph', '--all', '--html']);
  // The project's own row supplies the directory — never a path from a request.
  assert.equal(bd.calls[0].opts.cwd, '/repo');
  assert.equal(bd.calls[0].env.BEADS_DIR, '/repo/.beads', 'must say where the database is');
  assert.equal(bd.calls[0].env.BD_NON_INTERACTIVE, '1');
  // A read that can block on someone else's lock still needs a deadline, or a
  // single graph request wedges the daemon.
  assert.equal(bd.calls[0].opts.timeout, BD_TIMEOUT_MS);
});

test('a locked database surfaces as busy, not as a broken graph', async () => {
  // A held lock does not fail fast: bd waits, our deadline kills it, and node
  // reports killed/signal. Same path `ready()` relies on — "try later", not
  // "beads is broken".
  const bd = fakeBd({ graph: { timeout: true } });
  const beads = createBeads({ execFileFn: bd });

  await assert.rejects(() => beads.graphHtml(PROJECT), (err) => {
    assert.ok(err instanceof BeadsError);
    assert.equal(err.busy, true, 'contention must not latch the project into error');
    return true;
  });
});

test('a failing bd throws rather than returning a half-page as the graph', async () => {
  // Exit 1 with partial stdout: returning it unchecked would render bd's error
  // text inside the frame as if it were a graph.
  const bd = fakeBd({ graph: { code: 1, stdout: '<html>trunc', stderr: 'no beads database found' } });
  const beads = createBeads({ execFileFn: bd });

  await assert.rejects(() => beads.graphHtml(PROJECT), (err) => {
    assert.ok(err instanceof BeadsError);
    assert.equal(err.busy, false, 'a broken repo is not contention');
    assert.match(err.message, /no beads database found/, "bd's own account, not exit 1");
    return true;
  });
});
