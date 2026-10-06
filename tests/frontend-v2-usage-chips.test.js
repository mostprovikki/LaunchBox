// The appbar usage chips (public/v2/usage-chips.js). launchbox.md §6: the chips
// are a glance copy of the Overview headroom and must show the same reading —
// so they colour by the app's Warn at / guard line, exactly like the meters,
// never by Claude's own bucket severity (claude-scheduler-5v2.5: Fable chip red
// while the Fable meter was amber).
import test from 'node:test';
import assert from 'node:assert/strict';
import { usageChips } from '../public/v2/usage-chips.js';

const bucket = (scopeModel, percent, severity = 'normal') => ({
  kind: 'weekly_scoped', group: 'weekly', scopeModel, percent, severity,
});

test('chips tone by the app thresholds: under Warn at plain, at Warn at warn, at the guard line crit', () => {
  const u = { ok: true, warnPct: 90, critPct: 95, buckets: [bucket('A', 89), bucket('B', 90), bucket('C', 95)] };
  assert.deepEqual(usageChips(u).map((c) => [c.k, c.v, c.tone]), [['A', '89%', ''], ['B', '90%', 'warn'], ['C', '95%', 'crit']]);
});

test("Claude's own 'critical' severity does not override the app thresholds", () => {
  const u = { ok: true, warnPct: 90, critPct: 95, buckets: [bucket('Fable', 90, 'critical')] };
  assert.equal(usageChips(u)[0].tone, 'warn', 'the Fable meter is amber at 90% with Warn at 90, so the chip is too');
});

test('the windows fallback tones the same way, and an unread snapshot is two dashes', () => {
  const u = { ok: true, warnPct: 70, critPct: 85, windows: { five_hour: { percent: 72 }, seven_day: { percent: 86 } } };
  assert.deepEqual(usageChips(u).map((c) => [c.k, c.tone]), [['5h', 'warn'], ['wk', 'crit']]);
  assert.deepEqual(usageChips({ ok: null }).map((c) => c.v), ['—', '—']);
});
