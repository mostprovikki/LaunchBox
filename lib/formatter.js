// Parses `claude -p --output-format stream-json --verbose` NDJSON into
// human-readable log lines + live progress. Tolerates partial chunks and
// non-JSON lines (passed through raw).

function short(s, n = 160) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function createFormatter({ onLine, onProgress, onSession } = {}) {
  let buf = '';
  let toolCalls = 0;

  const line = (s) => onLine?.(s);
  const progress = (activity) => onProgress?.({ activity: short(activity, 80), toolCalls });

  function handle(ev) {
    if (ev.type === 'system' && ev.subtype === 'init') {
      if (ev.session_id) onSession?.(ev.session_id);
      line(`▶ session ${ev.session_id ?? '?'} · model ${ev.model ?? '?'} · cwd ${ev.cwd ?? '?'}`);
      progress('starting');
    } else if (ev.type === 'assistant') {
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'text' && c.text?.trim()) {
          line(c.text.trim());
          progress('writing');
        } else if (c.type === 'tool_use') {
          toolCalls++;
          line(`⚙ ${c.name} ${short(JSON.stringify(c.input ?? {}))}`);
          progress(c.name);
        }
      }
    } else if (ev.type === 'result') {
      const cost = ev.total_cost_usd != null ? ` · $${ev.total_cost_usd.toFixed(4)}` : '';
      line(`■ ${ev.subtype ?? 'result'} · ${ev.num_turns ?? '?'} turns${cost}`);
      if (ev.result) line(short(ev.result, 2000));
      onProgress?.({ activity: 'done', toolCalls, turns: ev.num_turns ?? null });
    }
    // other event types (user/tool_result etc.) are noise — skip
  }

  function dispatch(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    try {
      handle(JSON.parse(trimmed));
    } catch {
      line(trimmed); // stderr-ish / non-JSON output
    }
  }

  return {
    write(chunk) {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        dispatch(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    },
    flush() {
      dispatch(buf);
      buf = '';
    },
  };
}
