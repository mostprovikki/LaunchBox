// The appbar usage chips: one per bucket (or per window on an older snapshot).
// Toned by the app's Warn at / guard line — the same thresholds the Overview
// meters draw — and never by Claude's own bucket severity, so a chip and its
// meter can never disagree (launchbox.md §6; claude-scheduler-5v2.5).
export function usageChips(u) {
  if (!u || u.ok === null) return [{ k: '5h', v: '—', tone: '' }, { k: 'wk', v: '—', tone: '' }];
  const critPct = u.critPct ?? 85;
  const tone = (pct) => {
    if (typeof pct !== 'number') return '';
    if (pct >= critPct) return 'crit';
    if (typeof u.warnPct === 'number' && pct >= u.warnPct) return 'warn';
    return '';
  };
  if (u.buckets?.length) {
    return u.buckets.map((b) => ({
      k: b.scopeModel ?? (b.group === 'weekly' ? 'wk' : (b.kind === 'session' ? '5h' : String(b.kind ?? '?'))),
      v: typeof b.percent === 'number' ? `${b.percent}%` : '—',
      tone: tone(b.percent),
    }));
  }
  const WL = { five_hour: '5h', seven_day: 'wk' };
  return Object.entries(u.windows ?? {})
    .filter(([, w]) => typeof w?.percent === 'number')
    .map(([k, w]) => ({ k: WL[k] ?? k, v: `${w.percent}%`, tone: tone(w.percent) }));
}
