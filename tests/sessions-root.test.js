// The sessions index ROOT, end to end (claude-scheduler-nc5).
//
// GET /api/sessions returned {sessions, hidden} and never said WHERE it looked,
// so the /v2 empty state could only call it "the Claude Code transcript
// directory". That sentence is the one that matters most on this page: the
// likeliest reason the list is empty is that Claude Code runs under a different
// HOME, or that LaunchBox was started with CS_SESSIONS_ROOT pointing elsewhere.
//
// The honesty rule from claude-scheduler-btv.10 survives unchanged and is
// pinned below: the UI prints the SERVED value or nothing. A daemon that sends
// no root must produce the generic wording, never a built-in ~/.claude/projects
// guess — which would be wrong on exactly the machines where the sentence is
// worth reading.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { tmpData, fakeSpawn, extensions } from './helpers.js';
import { ensureDirs } from '../lib/paths.js';
import { ensureToken } from '../lib/token.js';
import { openDb } from '../lib/db.js';
import { createSessionIndex, DEFAULT_ROOT } from '../lib/sessions.js';
import { createRunner } from '../lib/runner.js';
import { createScheduler } from '../lib/scheduler.js';
import { createApp } from '../server.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------ HTTP

let currentToken = null;

async function req(base, method, path) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentToken}` },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Own boot, same shape as api.test.js's bootWithSessions: a real index over a
// throwaway directory, so nothing here reads the developer's own transcripts.
async function bootWithSessions() {
  const dir = tmpData();
  ensureDirs();
  const db = openDb(join(dir, 'test.db'));
  const runner = createRunner({ db, extensions, spawnFn: fakeSpawn(), notifyFn: () => {} });
  const scheduler = createScheduler({ db, runner });
  const root = mkdtempSync(join(tmpdir(), 'cs-nc5-root-'));
  const sessions = createSessionIndex({ db, root, activeWindowS: 60 });
  currentToken = ensureToken();
  const app = createApp({
    db, runner, scheduler, extensions, awake: null, sessions, token: currentToken,
    execFileFn: (cmd, args, cb) => cb(null),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return {
    sessions, root,
    base: () => `http://127.0.0.1:${server.address().port}`,
    write(id, rows) {
      mkdirSync(join(root, '-Users-me-proj'), { recursive: true });
      writeFileSync(join(root, '-Users-me-proj', `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    },
    close() { sessions.stop(); server.close(); },
  };
}

test('GET /api/sessions reports the index root it actually read', async (t) => {
  const s = await bootWithSessions();
  t.after(() => s.close());
  await s.sessions.scan();

  const r = await req(s.base(), 'GET', '/api/sessions');
  assert.equal(r.status, 200);
  // The SERVED root, not the default one — this boot moved it, and a response
  // that echoed DEFAULT_ROOT would be the exact lie the empty state must not
  // repeat.
  assert.equal(r.body.root, s.root);
  assert.notEqual(r.body.root, DEFAULT_ROOT);
  assert.ok(!r.body.root.startsWith(join(homedir(), '.claude')));
});

test('the root travels with the list, not only with the empty case', async (t) => {
  const s = await bootWithSessions();
  t.after(() => s.close());
  s.write('ours', [{
    type: 'user', timestamp: '2026-07-26T10:00:00.000Z', cwd: '/Users/me/proj',
    entrypoint: 'cli', message: { content: 'hello' },
  }]);
  await s.sessions.scan();

  const r = await req(s.base(), 'GET', '/api/sessions?all=1');
  assert.deepEqual(r.body.sessions.map((x) => x.id), ['ours']);
  assert.equal(r.body.root, s.root);
  // Additive only: the fields the old UI reads are untouched.
  assert.equal(typeof r.body.hidden, 'number');
});

// ------------------------------------------------------------------ jsdom

function mountDom() {
  const dom = new JSDOM('<!doctype html><body><main><div id="v2-page"></div></main></body>', { url: 'http://localhost/v2/' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.localStorage = dom.window.localStorage;
  global.location = dom.window.location;
  global.history = dom.window.history;
}

function mockSessions(payload) {
  global.fetch = async (path) => {
    if (path !== '/api/sessions') return { ok: false, status: 404, text: async () => '{}' };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

async function renderSessions(tag) {
  const { default: sessions } = await import(`../public/v2/pages/sessions.js?${tag}=${Date.now()}`);
  sessions(new URLSearchParams());
  await settle(); await settle();
  return document.querySelector('#v2-page');
}

// The acceptance criterion: the value on screen is the value the server sent.
// The fixture root is deliberately nothing like the default, so a page that
// printed a built-in path would fail this rather than coincidentally pass.
const SERVED_ROOT = '/srv/fixture-home/.config/claude-transcripts';

test('jsdom: the empty state names the root the SERVER served', async () => {
  mountDom();
  mockSessions({ sessions: [], hidden: 0, root: SERVED_ROOT });
  const page = await renderSessions('served');

  assert.match(page.textContent, /No Claude Code sessions on this machine/);
  assert.ok(page.textContent.includes(SERVED_ROOT),
    `the empty state must name the served root; it said: ${page.textContent}`);
  // …and it is the path, not prose about one: the mockup sets it in .mono.
  const mono = [...page.querySelectorAll('.mono')].map((n) => n.textContent);
  assert.ok(mono.includes(SERVED_ROOT), 'the path should be rendered as a path');
  // A hard-coded default would show up alongside the served one.
  assert.ok(!/\.claude\/projects/.test(page.textContent));
});

test('jsdom: a different served root produces a different sentence', async () => {
  mountDom();
  mockSessions({ sessions: [], hidden: 0, root: '/var/tmp/other-root' });
  const page = await renderSessions('other');
  assert.ok(page.textContent.includes('/var/tmp/other-root'));
  assert.ok(!page.textContent.includes(SERVED_ROOT),
    'the page is echoing a value from somewhere other than this response');
});

test('jsdom: a daemon that sends no root degrades to the generic wording', async () => {
  mountDom();
  // An older daemon — the pre-nc5 {sessions, hidden} shape.
  mockSessions({ sessions: [], hidden: 0 });
  const page = await renderSessions('noroot');

  assert.match(page.textContent, /No Claude Code sessions on this machine/);
  assert.match(page.textContent, /The Claude Code transcript directory was read/,
    'with no root served the generic sentence must stand');
  assert.ok(!/~?\/?\.claude\/projects/.test(page.textContent),
    'claude-scheduler-btv.10: never guess a path the server did not send');
  assert.ok(!/\/(?:Users|home|srv|var)\//.test(page.textContent),
    'no path of any shape should appear when none was served');
  // The actionable part survives: it still says what WOULD move the directory.
  assert.match(page.textContent, /CS_SESSIONS_ROOT/);
});

test('jsdom: a root sent as a non-string is treated as not sent', async () => {
  mountDom();
  mockSessions({ sessions: [], hidden: 0, root: null });
  const page = await renderSessions('nullroot');
  assert.match(page.textContent, /The Claude Code transcript directory was read/);
  assert.ok(!/null/.test(page.textContent), 'a null root must never be printed');
});

test('sessions.js carries no built-in transcript path to fall back to', () => {
  const src = readFileSync(join(REPO, 'public', 'v2', 'pages', 'sessions.js'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\.claude/.test(src), 'sessions.js names a Claude directory of its own');
  assert.ok(!/state\.root\s*(?:\?\?|\|\|)\s*['"`]/.test(src),
    'sessions.js defaults state.root to a literal — the whole point is that it must not');
});
