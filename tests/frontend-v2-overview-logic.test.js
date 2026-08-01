// Overview tab (claude-scheduler-btv.8 / C1) — pure logic
// (public/v2/pages/overview-logic.js). Same split jobs-logic.js established:
// no DOM, no jsdom, so the row-grammar/reason-per-state decisions are
// unit-testable directly. Fixtures here are drawn straight from
// tests/v2-overview.test.js's real /api/v2/overview response shapes, not
// hand-invented — the exact defect ("attention:{asOf,items}", not a bare
// array) that bit B1's jobs-logic.js fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtHM, fmtCheckedAt, fmtHeadDate, connectivityPhrase,
  windowMeterClass, bucketMeterClass, fmtResetLine, modelWindowLabel,
  guardSummary, criticalModelNotes, attentionLine, attentionActions,
  fireTimeParts, fireAnnotation, pauseModeLabel, todayCounts, burstSummary,
  relInPadded, fmtDayTime,
} from '../public/v2/pages/overview-logic.js';
import { ordinal, statusMeta } from '../public/v2/state-vocab.js';

test('fmtHM / fmtCheckedAt: HH:MM and HH:MM:SS in local time, null-safe', () => {
  const iso = '2026-08-01T09:41:07.000Z';
  assert.match(fmtHM(iso), /^\d{2}:\d{2}$/);
  assert.match(fmtCheckedAt(iso), /^checked \d{2}:\d{2}:\d{2}$/);
  assert.equal(fmtHM(null), null);
  assert.equal(fmtCheckedAt(null), null);
});

test('fmtHeadDate: weekday, day, month, then time — day before month regardless of locale', () => {
  const d = new Date('2026-08-01T09:41:00.000Z').getTime();
  assert.match(fmtHeadDate(d), /^Saturday 1 August · \d{2}:\d{2}$/);
});

test('connectivityPhrase: the three wordings match the audited mockups verbatim, and never invents a pause "since" timestamp', () => {
  assert.equal(connectivityPhrase(null, 'off'), 'daemon healthy');
  assert.equal(connectivityPhrase('unreachable', 'off'), 'daemon unreachable');
  assert.equal(connectivityPhrase('token_invalid', 'off'), 'showing the last state this page received');
  const withPause = connectivityPhrase(null, 'hold');
  assert.equal(withPause, 'daemon healthy · Hold is on');
  assert.ok(!/since \d/.test(withPause), 'must not invent a "since HH:MM" pause-start time — lib/pause.js status() carries none');
});

test('windowMeterClass: crit/warn/ok from percent vs. the window\'s OWN thresholds, unknown never reads as a healthy 0', () => {
  assert.equal(windowMeterClass({ percent: 90, warnPct: 70, critPct: 85, unknown: false }), 'crit');
  assert.equal(windowMeterClass({ percent: 75, warnPct: 70, critPct: 85, unknown: false }), 'warn');
  assert.equal(windowMeterClass({ percent: 37, warnPct: 70, critPct: 85, unknown: false }), '');
  assert.equal(windowMeterClass({ percent: null, warnPct: 70, critPct: 85, unknown: true }), null);
});

test('bucketMeterClass: reads the bucket\'s own severity field, never recomputed from a percent it does not carry a threshold for', () => {
  assert.equal(bucketMeterClass('critical'), 'crit');
  assert.equal(bucketMeterClass('warning'), 'warn');
  assert.equal(bucketMeterClass('normal'), '');
  assert.equal(bucketMeterClass(undefined), '');
});

test('fmtResetLine: five-hour-style window gets a padded countdown, week-style gets day+time only', () => {
  const soon = new Date(Date.now() + (2 * 3600_000 + 6 * 60_000)).toISOString();
  assert.match(fmtResetLine(soon, { relative: true }), /^resets \d{2}:\d{2} · in 2h 06m$/);
  const far = new Date(Date.now() + 5 * 86_400_000).toISOString();
  assert.doesNotMatch(fmtResetLine(far, { relative: false }), /in \d/, 'a day-scale reset must not show a countdown');
  assert.equal(fmtResetLine(null), 'resets —');
});

test('relInPadded: minutes are always two digits ("2h 06m", not "2h 6m") — distinct rule from jobs-logic.js\'s relIn', () => {
  assert.equal(relInPadded(new Date(Date.now() + (2 * 3600_000 + 6 * 60_000)).toISOString()), '2h 06m');
  assert.equal(relInPadded(new Date(Date.now() - 1000).toISOString()), null, 'a past instant has no countdown');
});

test('modelWindowLabel: builds "Scope · week"/"Scope · 5h" from what the bucket actually carries, never a fixed name', () => {
  assert.equal(modelWindowLabel({ scopeModel: 'Fable', group: 'weekly', kind: 'model_scoped' }), 'Fable · week');
  assert.equal(modelWindowLabel({ scopeModel: 'Fable', kind: 'session' }), 'Fable · 5h');
});

test('guardSummary: names the two real reserve percentages when enforcing, and the fail-open reason (never silent) when not', () => {
  assert.equal(
    guardSummary({ enforcing: true, reserveFiveHourPct: 80, reserveWeeklyPct: 95 }),
    'Budget guard is on — scheduled fires stop at 80% of the 5-hour window and 95% of the week',
  );
  assert.match(guardSummary({ enforcing: false, why: 'usage could not be read' }), /off — usage could not be read/);
});

test('criticalModelNotes: never invents a fixed critical percent (modelWindows carries no threshold, only severity+percent)', () => {
  const notes = criticalModelNotes([{
    scopeModel: 'Fable', group: 'weekly', kind: 'model_scoped', percent: 90, severity: 'critical', resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  }]);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Fable · week is past critical \(90%\)/);
  assert.ok(!/85%/.test(notes[0]), 'must not state a fixed critical threshold the bucket payload does not carry');
  const none = criticalModelNotes([{ scopeModel: 'Fable', severity: 'warning', percent: 72 }]);
  assert.equal(none.length, 0, 'only severity===critical gets a callout');
});

test('attentionLine: timeout names the real limit/time/SIGTERM (always sent — lib/runner.js), and only mentions a streak > 1', () => {
  const occurredAt = '2026-08-01T08:12:00.000Z';
  const hm = fmtHM(occurredAt); // local-time rendering, same as the implementation — never assume UTC==local
  const item = { kind: 'timeout', occurredAt, reason: { timeoutMin: 15, streak: 3 } };
  const line = attentionLine(item);
  assert.match(line, new RegExp(`Hit its 15m limit at ${hm}`));
  assert.match(line, /SIGTERM sent/);
  assert.match(line, new RegExp(`${ordinal(3)} in a row`));

  const single = attentionLine({ kind: 'timeout', occurredAt, reason: { timeoutMin: 15, streak: 1 } });
  assert.doesNotMatch(single, /in a row/, 'a streak of 1 is not "in a row"');
});

test('attentionLine: killed never claims a specific cause the run record cannot back (no meta reason exists for kill())', () => {
  // This test used to assert the very thing its name forbids: it checked that
  // "hard stop was active" was absent, then pinned "SIGKILL, no cleanup ran".
  // Both clauses are equally unsupportable. lib/runner.js's kill() sends
  // SIGTERM and only escalates to SIGKILL after KILL_GRACE_MS, and a QUEUED
  // run is dequeued with no signal at all — so cleanup may well have run and
  // SIGKILL may never have been sent. Only the immediacy is always true.
  const line = attentionLine({ kind: 'killed', occurredAt: '2026-08-01T03:00:00.000Z', reason: { code: 'killed' } });
  assert.doesNotMatch(line, /hard stop was active/, 'must not invent a cause kill() does not record');
  assert.doesNotMatch(line, /SIGKILL/, 'must not name a signal that may never have been sent');
  assert.doesNotMatch(line, /no cleanup ran/, 'must not claim cleanup was skipped — SIGTERM comes first');
  assert.match(line, /stopped immediately/, 'the one thing that is always true');
});

test('attentionLine: skipped/stopped reuse jobs-logic.js\'s reasonText/stopReasonText rather than re-wording the same decoded reason', () => {
  const skipped = attentionLine({
    kind: 'skipped', occurredAt: '2026-08-01T02:15:00.000Z', reason: { code: 'reserve', windowLabel: '5h', usedPct: 82 },
  });
  assert.match(skipped, /would breach 5h reserve/);
  const stopped = attentionLine({ kind: 'stopped', occurredAt: '2026-08-01T09:00:00.000Z', reason: { stopReason: 'paused (soft)' } });
  assert.match(stopped, /wound down during soft pause/);
});

test('attentionLine: project_issue names the real busyStreak/lastError rather than a generic "needs attention"', () => {
  const busy = attentionLine({ kind: 'project_issue', reason: { code: 'bd_busy', busyStreak: 4 } });
  assert.match(busy, /4 consecutive polls/);
  const err = attentionLine({ kind: 'project_issue', reason: { code: 'project_error', lastError: 'ENOENT: bd not found' } });
  assert.match(err, /ENOENT: bd not found/);
});

test('attentionActions: every href is a route this bead can resolve — Runs filtered by job, Jobs, or Projects', () => {
  const t = attentionActions({ kind: 'timeout', jobId: 'j1' });
  assert.deepEqual(t.map((a) => a.href), ['#runs?job=j1', '#jobs']);
  const p = attentionActions({ kind: 'project_issue' });
  assert.deepEqual(p, [{ label: 'Open project', href: '#projects' }]);
});

test('fireTimeParts: an unresolved afterReset fire reads "after reset", never a fabricated clock time', () => {
  const parts = fireTimeParts({ at: null, anchoredToReset: true });
  assert.equal(parts.time, '—');
  assert.equal(parts.rel, 'after reset');
});

test('fireTimeParts: an anchored (but resolved) fire is prefixed ≈, an ordinary fire is not', () => {
  const soon = new Date(Date.now() + 30 * 60_000).toISOString();
  const anchored = fireTimeParts({ at: soon, anchoredToReset: true });
  assert.match(anchored.time, /^≈\d{2}:\d{2}$/);
  const plain = fireTimeParts({ at: soon, anchoredToReset: false });
  assert.doesNotMatch(plain.time, /≈/);
});

test('fireAnnotation: reads admitted/blockedBy straight off the payload — never re-derives pause/budget admission (REVIEW #1)', () => {
  assert.equal(fireAnnotation({ admitted: true }), null);
  assert.equal(fireAnnotation({ admitted: false, blockedBy: { pause: { mode: 'hold' }, budget: null } }), 'dropped while Hold is on');
  assert.match(
    fireAnnotation({ admitted: false, blockedBy: { pause: null, budget: { code: 'reserve', windowLabel: '5h', usedPct: 82 } } }),
    /guard will skip it — would breach 5h reserve/,
  );
});

test('pauseModeLabel: matches the mockups\' exact mode wording ("Soft drain"/"Hard stop", not the raw mode string)', () => {
  assert.equal(pauseModeLabel('hold'), 'Hold');
  assert.equal(pauseModeLabel('soft'), 'Soft drain');
  assert.equal(pauseModeLabel('hard'), 'Hard stop');
});

test('todayCounts: fixed status order, zero counts omitted, and labels come from the shared vocabulary', () => {
  const counts = todayCounts({ total: 14, byStatus: { ok: 11, timeout: 1, skipped: 1, killed: 1, stopped: 0, fail: 0 } });
  assert.deepEqual(counts, [['ok', 11], ['timeout', 1], ['skipped', 1], ['killed', 1]]);

  // The label is NOT this module's to choose. This strip used to carry its own
  // tuple list spelling `fail` as "failed" — copied from runs.js, which had
  // carried it since B2 — which is how that word survived the bmn
  // consolidation: a tuple array is not a keyed table, so the single-source
  // check never looked at it. Assert against statusMeta(), not a retyped word.
  const withFail = todayCounts({ total: 2, byStatus: { ok: 1, fail: 1 } });
  assert.deepEqual(withFail, [['ok', 1], [statusMeta('fail').label, 1]]);
  assert.equal(statusMeta('fail').label, 'fail', 'the mockups spell it "fail" — see redesign/runs.html');
});

test('burstSummary: "No burst running." when inactive, and only reports fields the burst row actually carries when active', () => {
  assert.equal(burstSummary({ active: null }), 'No burst running.');
  assert.equal(burstSummary(null), 'No burst running.');
  const s = burstSummary({ active: { window: 'five_hour', currentPct: 12, budgetPct: 10, runs: 3, projectIds: ['a', 'b'] } });
  assert.match(s, /five_hour window/);
  assert.match(s, /12% of a 10% budget/);
  assert.match(s, /3 runs across 2 projects/);
});

test('fmtDayTime: today reads as bare HH:MM, any other day carries the weekday', () => {
  const now = Date.now();
  assert.doesNotMatch(fmtDayTime(new Date(now + 60_000).toISOString(), now), /[A-Za-z]/, 'today must not carry a weekday name');
  assert.match(fmtDayTime(new Date(now + 5 * 86_400_000).toISOString(), now), /^[A-Z][a-z]{2} \d{2}:\d{2}$/);
});
