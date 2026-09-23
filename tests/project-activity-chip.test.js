// The "handed back" chip, rendered (claude-scheduler-dc9).
//
// A new file rather than an addition to tests/frontend-v2-projects.test.js:
// that file is owned by another wave this session. It pins the one thing the
// bead exists for — the project detail page's activity list drawing a bead run
// that exited ok but never signalled TASK-COMPLETE differently from one that
// closed its bead. Before dc9 the two were literally indistinguishable in the
// browser, because nothing on /api/runs carried the outcome.
//
// jsdom + mocked fetch, the same harness shape as frontend-v2-jobs.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

function freshDom() {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<header class="appbar"><nav id="v2-nav"></nav><div id="v2-chips"></div></header>'
    + '<div id="v2-banner" hidden></div><main><div id="v2-page"></div></main>'
    + '</body></html>', { url: 'http://127.0.0.1:43410/v2#project?id=p1', pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.history = dom.window.history;
  globalThis.localStorage = dom.window.localStorage;
  return dom;
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// Same reason as the Jobs suite: project.js arms a real poll interval off
// module-scope state, and a fresh module per test would accumulate timers.
globalThis.setInterval = () => ({});
globalThis.clearInterval = () => {};

const PROJECT = {
  id: 'p1', name: 'webapp-billing', path: '/repos/webapp-billing', state: 'active',
  config: { autoLabel: 'scheduler-ok' }, configErrors: [], busyStreak: 0,
  lastPollAt: '2026-08-01T09:40:00Z', lastPollOk: true, readyCount: 0,
};
const JOB = { id: 'j1', name: 'Migrate invoice templates to v2', type: 'claude', cwd: '/repos/webapp-billing', params: { _projectId: 'p1', _beadId: 'wb-198' } };

// One finished bead run; only its beadOutcome varies between cases.
const runWith = (beadOutcome) => ({
  id: 'r1', jobId: 'j1', status: 'ok', trigger: 'beads',
  startedAt: '2026-07-30T02:10:00Z', finishedAt: '2026-07-30T02:40:00Z', beadOutcome,
});

function mockApi(run) {
  globalThis.fetch = async (path) => {
    const body = path === '/api/projects' ? { projects: [PROJECT], pollSec: 60, bd: { version: '1.1.0' } }
      : path === '/api/projects/p1/ready' ? { beads: [], error: null }
        : path === '/api/jobs' ? { jobs: [JOB] }
          : path.startsWith('/api/runs') ? { runs: [run] }
            : path === '/api/bursts' ? { active: null }
              : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

// The chip in the activity row (the ready table is empty in these fixtures, so
// this is the only state chip the page draws).
async function activityChip(beadOutcome, tag) {
  freshDom();
  mockApi(runWith(beadOutcome));
  const { default: projectPage } = await import(`../public/v2/pages/project.js?t=${Date.now()}_${tag}`);
  projectPage(new URLSearchParams('id=p1'));
  await tick();
  const page = document.getElementById('v2-page');
  const row = [...page.querySelectorAll('.row')].find((r) => /wb-198/.test(r.textContent));
  assert.ok(row, 'the bead run never rendered — the fixture, not the chip, is probably wrong');
  const chip = row.querySelector('.state');
  assert.ok(chip, 'the activity row lost its state chip');
  return chip;
}

test('a bead run that exited ok WITHOUT TASK-COMPLETE renders as "handed back", not as "ok"', async () => {
  const chip = await activityChip('handed-back', 'hb');
  assert.equal(chip.textContent.trim(), 'handed back');
  assert.ok(chip.classList.contains('state--muted'), `expected the muted family, got: ${chip.className}`);
  assert.ok(chip.querySelector('.state__dot--square'), 'the mockup draws this dot square — colour is never the only channel');
});

test('a bead run that closed its bead still renders as "ok"', async () => {
  const chip = await activityChip('closed', 'closed');
  assert.equal(chip.textContent.trim(), 'ok');
  assert.ok(chip.classList.contains('state--ok'));
});

test('a run row from before the outcome was persisted is NOT guessed at in either direction', async () => {
  // NULL is every run written before the column existed, and every ordinary
  // job run. Reading it as "handed back" would accuse the scheduler of
  // returning beads it closed; the page falls back to the plain status.
  const chip = await activityChip(null, 'legacy');
  assert.equal(chip.textContent.trim(), 'ok');
  assert.ok(chip.classList.contains('state--ok'));
});
