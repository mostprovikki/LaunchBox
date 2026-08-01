import { renderPlaceholder } from './placeholder.js';
// Session transcript route (redesign/session-transcript.html). Expects `?id=<sessionId>`.
export default function session(params) {
  renderPlaceholder({
    title: 'Session transcript',
    bead: 'btv.10 (C3)',
    note: `Transcript for id=${params.get('id') ?? '(none given)'} — content owned by btv.10; coordinate with in-flight M5 (diff first).`,
    params,
  });
}
