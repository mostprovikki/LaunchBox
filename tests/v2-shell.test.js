// A1 (claude-scheduler-btv.1): the /v2 static route + skeleton shell.
//
// Scope is deliberately narrow — no router, no API client, no page content
// live under /v2 yet (that's A2/btv.4 and wave 2). These tests only pin:
// the shell loads, its stylesheets/dark-theme attribute are present, the old
// UI is untouched, and /v2 is reachable without the /api bearer token while
// /api itself still gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpData, extensions } from './helpers.js';
import { ensureDirs } from '../lib/paths.js';
import { ensureToken } from '../lib/token.js';
import { openDb } from '../lib/db.js';
import { createRunner } from '../lib/runner.js';
import { createScheduler } from '../lib/scheduler.js';
import { createAwake } from '../lib/awake.js';
import { createApp } from '../server.js';

// Minimal boot — this suite never exercises jobs/runs/scheduling, only static
// serving and the auth layering around it, so the collaborators are the real
// (cheap) constructors wired with a fake spawn, not full fakes of their own.
async function boot() {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const spawnFn = () => { throw new Error('no run should be spawned in this suite'); };
  const runner = createRunner({ db, extensions, spawnFn, notifyFn: () => {}, admit: () => null });
  const scheduler = createScheduler({ db, runner, pause: null });
  const awake = createAwake({ db, runner, scheduler, pause: null, spawnFn });
  const token = ensureToken();
  const app = createApp({ db, runner, scheduler, extensions, awake, token });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = () => `http://127.0.0.1:${server.address().port}`;
  return { server, base, token };
}

test('GET /v2 returns the skeleton shell', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());

  // redirect: 'manual' — fetch follows redirects by default, which would
  // silently paper over the exact failure mode the explicit /v2 route exists
  // to prevent (express.static 301-redirecting a bare /v2 to /v2/).
  const res = await fetch(base() + '/v2', { redirect: 'manual' });
  assert.equal(res.status, 200, 'GET /v2 must render directly, not via a 301 to /v2/');
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const body = await res.text();
  assert.match(body, /data-theme="dark"/, 'shell must set the dark theme attribute before first paint');
  assert.match(body, /href="\/v2\/assets\/system\.css"/, 'shell must link system.css root-absolutely');
  assert.match(body, /href="\/v2\/assets\/launchbox\.css"/, 'shell must link launchbox.css root-absolutely');
  assert.match(body, /<title>LaunchBox<\/title>/);
  // Stable ids A2 (btv.4) targets to fill in the nav, chips, banner and
  // routed-page mount — renaming any of these silently strands that task.
  for (const id of ['v2-nav', 'v2-chips', 'v2-banner', 'v2-page']) {
    assert.match(body, new RegExp(`id="${id}"`), `shell must expose #${id} for A2 to target`);
  }
  assert.match(body, /class="appbar"/, 'shell must keep the appbar chrome class');
  assert.match(body, /class="mainnav"/, 'shell nav slot must keep the mainnav class from the mockups');
  assert.match(body, /aria-label="Switch between dark and light"/, 'theme toggle must carry its aria-label verbatim');
});

test('every asset href/src in the /v2 document resolves to a real, correctly-typed file — not markup, actual resolution', async (t) => {
  // This is the test that a plain string-match on the markup cannot be: a
  // document served at /v2 (no trailing slash) resolves a *relative*
  // `href="assets/system.css"` against `/` (the URL one level up), landing on
  // `/assets/system.css` — a 404 whose body is the SPA fallback / error page,
  // served with content-type text/html. A test that only checks the HTML
  // *contains* the right-looking <link> tag is blind to that; this one parses
  // the actual attribute value out of the response and resolves it exactly as
  // a browser would against the document's own URL, then fetches whatever
  // that resolves to.
  const { server, base } = await boot();
  t.after(() => server.close());

  const res = await fetch(base() + '/v2', { redirect: 'manual' });
  assert.equal(res.status, 200);
  const body = await res.text();

  const hrefs = [...body.matchAll(/<link[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["']/g)]
    .map((m) => m[1])
    .filter((h) => !h.startsWith('http')); // the Google Fonts CDN link is out of scope here
  const srcs = [...body.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)].map((m) => m[1]);

  assert.ok(hrefs.length >= 2, 'expected at least system.css and launchbox.css stylesheet links');
  assert.ok(srcs.length >= 1, 'expected at least theme.js script tag');

  // Resolve exactly the way a browser resolves a relative URL against the
  // document it was loaded into: against the *document's own request URL*,
  // not against the site root and not against some other page.
  const documentUrl = base() + '/v2';
  for (const attr of [...hrefs, ...srcs]) {
    const resolved = new URL(attr, documentUrl);
    const assetRes = await fetch(resolved);
    const ct = assetRes.headers.get('content-type') || '';
    assert.equal(assetRes.status, 200, `${attr} -> ${resolved} must resolve to a real file (got ${assetRes.status})`);
    assert.doesNotMatch(ct, /text\/html/,
      `${attr} -> ${resolved} came back as ${ct} — that is the exact signature of a relative path resolving one level too high`);
    if (attr.endsWith('.css')) assert.match(ct, /text\/css/, `${attr} -> ${resolved} must be served as css`);
    if (attr.endsWith('.js')) assert.match(ct, /javascript/, `${attr} -> ${resolved} must be served as js`);
  }
});

test('GET /v2/assets/system.css is served as css', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());

  const res = await fetch(base() + '/v2/assets/system.css');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/css/);
});

test('GET / still serves the old UI, untouched', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());

  const res = await fetch(base() + '/');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<title>Scheduler<\/title>/, 'old UI title must still be served at /');
  assert.match(body, /id="usage-chip"/, 'old UI markup must still be intact at /');
});

test('/v2 is not behind the /api bearer-token gate, but /api itself still is', async (t) => {
  const { server, base } = await boot();
  t.after(() => server.close());

  // No Authorization header at all — /v2 must still render so it can explain
  // a missing/invalid token, same reasoning as index.html. redirect: 'manual'
  // for the same reason as above: a follow would hide a gate placed on /v2/
  // itself (as opposed to bare /v2) behind an apparently-successful 200.
  const shell = await fetch(base() + '/v2', { redirect: 'manual' });
  assert.equal(shell.status, 200);

  // But /api/jobs with no bearer token must still 401 — nobody should be able
  // to "fix" the shell later by routing it through the same gate.
  const api = await fetch(base() + '/api/jobs');
  assert.equal(api.status, 401);
  const apiBody = await api.json();
  assert.equal(apiBody.code, 'token_invalid');
});
