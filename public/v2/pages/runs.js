import { renderPlaceholder } from './placeholder.js';
// Wave-2 cross-links land here with `?job=<id>` / `?status=<status>` — e.g.
// Overview's "Read the log" or a Jobs row's run-history link. The router
// carries both through untouched (see router.js parseHash()); btv.6 reads
// them from `params` once its own filter <select>s exist (don't set a
// <select>.value before that — see this project's memory note on the old
// UI's history-job-filter trap).
export default function runs(params) {
  renderPlaceholder({ title: 'Runs', bead: 'btv.6 (B2)', params });
}
