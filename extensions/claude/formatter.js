// Parses `claude -p --output-format stream-json --verbose` NDJSON into
// human-readable log lines + live progress. Tolerates partial chunks and
// non-JSON lines (passed through raw).

function short(s, n = 160) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function createFormatter({ onLine, onProgress, onMeta } = {}) {
  let buf = '';
  let toolCalls = 0;
  // Set once the runner has asked this run to wind down. The CLI reports an
  // interrupted turn as `error_during_execution` with is_error: true — correct
  // from its side, misleading in a log the user is reading, because the stop was
  // requested. Verified against the real CLI in the M3 spike.
  let stopRequested = false;

  const line = (s) => onLine?.(s);
  const progress = (activity, extra = {}) =>
    onProgress?.({ text: `${short(activity, 80)} · ${toolCalls} tool calls`, activity: short(activity, 80), toolCalls, ...extra });

  function handle(ev) {
    if (ev.type === 'system' && ev.subtype === 'init') {
      if (ev.session_id) onMeta?.({ sessionId: ev.session_id });
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
      if (stopRequested) {
        line(`⏹ wound down after ${ev.num_turns ?? '?'} turns${cost} — no work was left half-done, and the session can be resumed`);
        progress('stopped', { turns: ev.num_turns ?? null });
        return;
      }
      line(`■ ${ev.subtype ?? 'result'} · ${ev.num_turns ?? '?'} turns${cost}`);
      if (ev.result) line(short(ev.result, 2000));
      progress('done', { turns: ev.num_turns ?? null });
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
    // Called by the runner when it starts the graceful-stop ladder.
    stopping() {
      stopRequested = true;
    },
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
