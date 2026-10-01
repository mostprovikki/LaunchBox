// The declarative shot list.
//
// Every DOM selector the capture uses lives in THIS FILE. The runner reports
// which shots failed and why, and each failure points at the selector that
// moved.
//
// A shot is { file, desc, phase, fullPage?, setup? }.
//   phase 'empty'   — runs before seeding, for zero-state screens
//   phase 'main'    — against seeded data
// setup(page, ctx) prepares the screen; throwing marks that one shot failed and
// the run continues. ctx = { api, ids, baseUrl }.
//
// The populated shots are one per route in V2_ROUTES (the list the qa:v2 walk
// uses), in both themes — so a route added there is captured here without a
// second list to keep in step.

import { V2_ROUTES, resolveHash, isWalkable } from '../qa/audit-rules.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until a predicate evaluated in the page turns true. */
async function until(page, fn, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.eval(fn)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The project and session a `?id=` route deep-links with, looked up once. */
async function routeIds(ctx) {
  if (ctx.routeIds) return ctx.routeIds;
  const ids = {};
  const { projects } = await ctx.api.get('/api/projects');
  ids.projectId = projects[0]?.id;
  const { sessions } = await ctx.api.get('/api/sessions?all=1');
  ids.sessionId = sessions[0]?.id;
  ctx.routeIds = ids;
  return ids;
}

/** Navigate to a v2 hash in a theme, and wait for the route to render. */
async function show(page, ctx, hash, theme) {
  await page.goto(`${ctx.baseUrl}/${hash}`);
  await page.eval((t) => { document.documentElement.setAttribute('data-theme', t); }, theme);
  await until(page, () => document.querySelector('#v2-page')?.children.length > 0, `#v2-page to render ${hash}`);
  // Pages paint a "Loading…" / "Reading this project's beads…" line first;
  // `bd ready` behind the project routes alone takes seconds.
  await until(page, () => !/\b(Loading|Reading)\b[^.]*…/.test(document.querySelector('#v2-page').innerText),
    `${hash} to finish loading`, 30_000);
  await sleep(900); // let async sections (fetches, counts) paint
  await page.eval(() => window.scrollTo(0, 0));
}

const routeShot = (route, theme) => ({
  file: `${route.name}-${theme}`,
  desc: `${route.name} (\`${route.hash}\`), ${theme} theme`,
  phase: 'main',
  async setup(page, ctx) {
    const ids = await routeIds(ctx);
    if (!isWalkable(route, ids)) throw new Error(`no id seeded to deep-link ${route.hash}`);
    await show(page, ctx, resolveHash(route.hash, ids), theme);
  },
});

export const shots = [
  ...['overview', 'jobs', 'projects', 'settings'].map((name) => ({
    file: `${name}-empty`,
    desc: `${name} before anything is seeded`,
    phase: 'empty',
    setup: (page, ctx) => show(page, ctx, `#${name}`, 'dark'),
  })),
  ...V2_ROUTES.flatMap((route) => ['dark', 'light'].map((theme) => routeShot(route, theme))),
];
