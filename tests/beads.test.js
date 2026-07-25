import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeBd, bdReadyRow } from './helpers.js';
import { createBeads, normaliseBead, BeadsError, BD_TIMEOUT_MS } from '../lib/beads.js';

// Every test here asserts a behaviour that was measured against real bd 1.1.0 in
// docs/spikes/. Nothing shells out to the real binary.

const PROJECT = { id: 'p1', path: '/repo', beadsDir: '/repo/.beads' };
const ready = (rows) => ({ stdout: JSON.stringify(rows) });

test('every DB-touching call carries a timeout and the explicit beads env', async () => {
  const bd = fakeBd({
    ready: ready([]),
    where: { stdout: JSON.stringify({ path: '/repo/.beads', database_path: '/repo/.beads/embeddeddolt' }) },
    show: { stdout: JSON.stringify([bdReadyRow()]) },
    update: { stdout: JSON.stringify([bdReadyRow({ assignee: 'me' })]) },
    close: { stdout: '' },
  });
  const beads = createBeads({ execFileFn: bd });

  await beads.ready(PROJECT, { label: 'unattended' });
  await beads.healthy(PROJECT);
  await beads.get(PROJECT, 'sp-abc');
  await beads.claim(PROJECT, 'sp-abc');
  await beads.close(PROJECT, 'sp-abc');

  assert.equal(bd.calls.length, 5);
  for (const c of bd.calls) {
    // Contention produces an unbounded wait, not an error — a call without a
    // deadline is a call that can wedge the daemon forever.
    assert.equal(c.opts.timeout, BD_TIMEOUT_MS, `${c.sub} must pass a timeout`);
    assert.equal(c.opts.killSignal, 'SIGTERM');
    assert.equal(c.env.BD_NON_INTERACTIVE, '1', `${c.sub} must be non-interactive`);
    assert.equal(c.env.BEADS_DIR, '/repo/.beads', `${c.sub} must say where the database is`);
  }
});

test('version is cached, and is the one call exempt from the contention deadline', async () => {
  const bd = fakeBd({ '--version': { stdout: 'bd version 1.1.0 (Homebrew)\n' } });
  const beads = createBeads({ execFileFn: bd });

  assert.equal(await beads.version(), 'bd version 1.1.0 (Homebrew)');
  assert.equal(await beads.version(), 'bd version 1.1.0 (Homebrew)');
  assert.equal(bd.calls.length, 1, 'version must be cached');
  // It never opens the DB, so it cannot be blocked by a lock — but it still gets
  // a deadline, because a bdPath pointing at something that reads stdin would
  // hang with the same symptom.
  assert.ok(bd.calls[0].opts.timeout > 0);
  assert.equal(bd.calls[0].env.BEADS_DIR, undefined, 'version needs no project');

  beads.resetVersion();
  await beads.version();
  assert.equal(bd.calls.length, 2);
});

test('an unlabelled bead omits `labels` entirely and must not throw', async () => {
  // The measured 1.1.0 shape: no `labels` key at all — not [], not null. A naive
  // b.labels.includes() throws here, and this filter is the safety gate.
  const bd = fakeBd({
    ready: ready([
      bdReadyRow({ id: 'sp-labelled', labels: ['unattended'] }),
      bdReadyRow({ id: 'sp-bare' }),
    ]),
  });
  const beads = createBeads({ execFileFn: bd });

  const out = await beads.ready(PROJECT, { label: 'unattended' });
  assert.deepEqual(out.map((b) => b.id), ['sp-labelled'], 'unlabelled bead is ineligible, not fatal');
  assert.deepEqual(normaliseBead(bdReadyRow()).labels, [], 'missing labels normalise to []');
});

test('ready filters by label in JS as well as via --label', async () => {
  // Belt and braces: if --label semantics ever change, the consequence must be
  // "we run nothing", never "we run someone's design spike".
  const bd = fakeBd({ ready: ready([bdReadyRow({ id: 'sp-other', labels: ['someone-elses'] })]) });
  const beads = createBeads({ execFileFn: bd });

  assert.deepEqual(await beads.ready(PROJECT, { label: 'unattended' }), []);
  const args = bd.calls[0].args;
  assert.ok(args.includes('--label') && args.includes('unattended'), 'still asks bd to filter');
});

test('no autoLabel means no eligible work, and bd is never even called', async () => {
  const bd = fakeBd({ ready: ready([bdReadyRow({ labels: ['unattended'] })]) });
  const beads = createBeads({ execFileFn: bd });

  assert.deepEqual(await beads.ready(PROJECT, {}), []);
  assert.equal(bd.calls.length, 0, 'absent label must not degrade to "everything"');
});

test('ready normalises issue_type -> type and tolerates an empty array', async () => {
  const bd = fakeBd({ ready: ready([bdReadyRow({ labels: ['x'], issue_type: 'bug', priority: 0 })]) });
  const beads = createBeads({ execFileFn: bd });

  const [b] = await beads.ready(PROJECT, { label: 'x' });
  assert.equal(b.type, 'bug', 'the field is issue_type upstream');
  assert.equal(b.priority, 0, '0 = critical must survive, not become null');

  const empty = createBeads({ execFileFn: fakeBd({ ready: { stdout: '[]' } }) });
  assert.deepEqual(await empty.ready(PROJECT, { label: 'x' }), []);
});

test('exit 0 with non-empty stderr is success, not failure', async () => {
  // Real bd warns on stderr during perfectly good runs (beads.role not
  // configured, .beads perms 0755). Keying off stderr would fail every call.
  const bd = fakeBd({
    ready: { stdout: JSON.stringify([bdReadyRow({ labels: ['x'] })]), stderr: 'warning: beads.role not configured (GH#2950)\n' },
  });
  const beads = createBeads({ execFileFn: bd });

  const out = await beads.ready(PROJECT, { label: 'x' });
  assert.equal(out.length, 1);
});

test('get uses show (the only source of assignee) and unwraps the one-element array', async () => {
  const bd = fakeBd({
    show: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', status: 'in_progress', assignee: 'someone', started_at: '2026-07-25T01:00:00Z' })]) },
  });
  const beads = createBeads({ execFileFn: bd });

  const b = await beads.get(PROJECT, 'sp-1');
  assert.equal(bd.calls[0].sub, 'show', 'ready carries no assignee, so the re-read must use show');
  assert.equal(b.assignee, 'someone');
  assert.equal(b.startedAt, '2026-07-25T01:00:00Z');
  assert.equal(b.status, 'in_progress');
});

test('get returns null for a missing bead rather than escalating', async () => {
  const bd = fakeBd({ show: { code: 1, stderr: 'Error: issue not found: sp-nope\n' } });
  const beads = createBeads({ execFileFn: bd });
  assert.equal(await beads.get(PROJECT, 'sp-nope'), null);
});

test('a lost claim race reports the winner by name and is not an exception', async () => {
  const bd = fakeBd({ update: { code: 1, stderr: 'Error claiming sp-1: issue already claimed by racer1\n' } });
  const beads = createBeads({ execFileFn: bd });

  const r = await beads.claim(PROJECT, 'sp-1');
  assert.equal(r.ok, false);
  assert.equal(r.busy, false);
  assert.equal(r.claimedBy, 'racer1', 'the winner is nameable — a better log line than "claim failed"');
});

test('a successful claim returns the bead with assignee and started_at', async () => {
  const bd = fakeBd({
    update: { stdout: JSON.stringify([bdReadyRow({ id: 'sp-1', status: 'in_progress', assignee: 'scheduler', started_at: '2026-07-25T02:00:00Z' })]) },
  });
  const beads = createBeads({ execFileFn: bd });

  const r = await beads.claim(PROJECT, 'sp-1');
  assert.equal(r.ok, true);
  assert.equal(r.claimedBy, 'scheduler');
  assert.equal(r.bead.startedAt, '2026-07-25T02:00:00Z');
  assert.ok(bd.calls[0].args.includes('--claim'));
});

// --- contention: the whole reason timeouts exist -------------------------

test('a timed-out claim reports busy, not failure — and "definitely did not happen"', async () => {
  const bd = fakeBd({ update: { timeout: true } });
  const beads = createBeads({ execFileFn: bd });

  const r = await beads.claim(PROJECT, 'sp-1');
  assert.equal(r.ok, false);
  assert.equal(r.busy, true, 'contention is "try later", not "beads is broken"');
  // Measured: killing a blocked bd leaves no phantom write, so the caller may
  // safely release the lease and retry on the next poll.
  assert.match(r.reason, /timed out/);
});

test('a timed-out close reports busy so the bead is retried, not silently lost', async () => {
  const bd = fakeBd({ close: { timeout: true } });
  const beads = createBeads({ execFileFn: bd });

  const r = await beads.close(PROJECT, 'sp-1');
  assert.equal(r.ok, false);
  assert.equal(r.busy, true);
});

test('a timed-out ready throws a busy BeadsError the poller can distinguish', async () => {
  const bd = fakeBd({ ready: { timeout: true } });
  const beads = createBeads({ execFileFn: bd });

  await assert.rejects(() => beads.ready(PROJECT, { label: 'x' }), (err) => {
    assert.ok(err instanceof BeadsError);
    assert.equal(err.busy, true, 'a hung poll must not latch the project into error');
    return true;
  });
});

test('a timed-out healthy() reports busy without flapping the project to broken', async () => {
  const bd = fakeBd({ where: { timeout: true } });
  const beads = createBeads({ execFileFn: bd });

  const h = await beads.healthy(PROJECT);
  assert.equal(h.ok, false);
  assert.equal(h.busy, true);
  assert.match(h.reason, /busy/i);
});

// --- health and beadsDir discovery --------------------------------------

test('healthy() requires database_path — a hollow .beads/ is unhealthy with a reason', async () => {
  // A git worktree carries `.beads/` (committed config) without the gitignored
  // database, so existsSync would pass. `bd where` omits database_path there.
  const bd = fakeBd({ where: { stdout: JSON.stringify({ path: '/wt/.beads', prefix: 'sp' }) } });
  const beads = createBeads({ execFileFn: bd });

  const h = await beads.healthy(PROJECT);
  assert.equal(h.ok, false);
  assert.equal(h.busy, false);
  assert.match(h.reason, /hollow|no database/i);
});

test('healthy() is bd where, never bd ready, and never a probe that writes', async () => {
  const bd = fakeBd({ where: { stdout: JSON.stringify({ path: '/repo/.beads', database_path: '/repo/.beads/embeddeddolt', prefix: 'sp' }) } });
  const beads = createBeads({ execFileFn: bd });

  const h = await beads.healthy(PROJECT);
  assert.equal(h.ok, true);
  assert.equal(h.databasePath, '/repo/.beads/embeddeddolt');
  assert.deepEqual(bd.calls.map((c) => c.sub), ['where']);
});

test('beadsDir comes from bd where, never from concatenating .beads onto path', async () => {
  // The stored column exists precisely because the derived path can be wrong.
  const bd = fakeBd({ where: { stdout: JSON.stringify({ path: '/elsewhere/.beads', database_path: '/elsewhere/.beads/embeddeddolt' }) } });
  const beads = createBeads({ execFileFn: bd });

  const w = await beads.where({ path: '/repo' });
  assert.equal(w.beadsDir, '/elsewhere/.beads', 'reported location wins over the obvious guess');
  assert.notEqual(w.beadsDir, '/repo/.beads');
});

test('a missing bd binary is a hard error, distinct from contention', async () => {
  const bd = fakeBd({ default: { spawnError: 'ENOENT' } });
  const beads = createBeads({ execFileFn: bd, bdPath: '/nope/bd' });

  await assert.rejects(() => beads.ready(PROJECT, { label: 'x' }), (err) => {
    assert.ok(err instanceof BeadsError);
    assert.equal(err.busy, false, 'a missing binary is not "busy"');
    assert.match(err.message, /ENOENT/);
    return true;
  });
});

test('unparseable JSON is reported as such rather than crashing the poll', async () => {
  const bd = fakeBd({ ready: { stdout: 'not json at all' } });
  const beads = createBeads({ execFileFn: bd });
  await assert.rejects(() => beads.ready(PROJECT, { label: 'x' }), /unparseable JSON/);
});

test('close passes a reason through when given', async () => {
  const bd = fakeBd({ close: { stdout: '' } });
  const beads = createBeads({ execFileFn: bd });

  await beads.close(PROJECT, 'sp-1', { reason: 'done by scheduler run r1' });
  assert.deepEqual(bd.calls[0].args, ['close', 'sp-1', '--reason', 'done by scheduler run r1']);
});
