import { renderPlaceholder } from './placeholder.js';
// Project detail route (redesign/project-detail.html). Expects `?id=<projectId>`.
export default function project(params) {
  renderPlaceholder({
    title: 'Project detail',
    bead: 'btv.9 (C2)',
    note: `Project detail for id=${params.get('id') ?? '(none given)'} — content owned by btv.9.`,
    params,
  });
}
