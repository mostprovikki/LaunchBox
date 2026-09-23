// Project detail page (claude-scheduler-btv.9 / C2). Mockup:
// redesign/project-detail.html. Route `#project?id=<projectId>`.
//
// Three cards the list cannot afford: the ready-bead table (one blocking `bd`
// call, which server.js's decorateProject explicitly refuses to make per row),
// this project's recent scheduler activity, and the repo's declared config.
//
// Endpoints reused unchanged: GET /api/projects, GET /api/projects/:id/ready,
// POST /api/projects/:id/poll, PUT /api/projects/:id, GET /api/jobs,
// GET /api/runs, GET /api/bursts. Nothing new was needed.
//
// Two claims from the mockup are NOT rendered here and the reasons are in
// projects-logic.js's header: "of 23 open" (no open-bead count exists) and the
// "Not ready: 11 blocked · 8 missing the label" coverage breakdown (the
// adapter never sees a bead that failed either filter). The third refusal, the
// "handed back" run state, is lifted: claude-scheduler-dc9 persisted the
// outcome as runs.beadOutcome, so the activity list draws that chip now.
import { api, failureToast, guardedSubmit } from '../api.js';
import { $, el, clear, pageHead, toast } from '../ui.js';
import { onRender } from '../router.js';
import { statusMeta, beadRunStateKey } from '../state-vocab.js';
import {
  fmtTime, fmtDate, relAgo, readyText, projectActions, isResume, cardBanner,
  burstProjectIds, chipFor, claimOrder, priorityPill, beadAge, beadMeta,
} from './projects-logic.js';

const POLL_MS = 8000;

const SVG_WARN = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>';
const SVG_CLOCK = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>';
const SVG_BEAD = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>';

const state = {
  id: null, project: null, ready: null, jobs: [], runs: [], burst: null, meta: null, failed: false,
};
// True only while this page owns #v2-page. See render()'s guard.
let mounted = false;
let pollTimer = null;
let routeWatcherArmed = false;

function svgNode(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

// ---------------- data ----------------

async function loadAndRender() {
  if (!state.id) { render(); return; }
  try {
    const data = await api('GET', '/api/projects');
    state.meta = data;
    state.project = (data.projects ?? []).find((p) => p.id === state.id) ?? null;
    state.failed = false;
  } catch {
    // Keep whatever was already on screen rather than blanking the page —
    // see projects.js's unreachableCard() comment (claude-scheduler-7j2).
    if (!state.project) state.failed = true;
  }
  if (!state.project) { render(); return; }

  // `bd ready` is a blocking call against the repo's database; it is fetched
  // once per render pass here (and never in the list), which is the whole
  // reason the ready table lives on this page.
  try {
    state.ready = await api('GET', `/api/projects/${state.id}/ready`);
  } catch (err) {
    state.ready = { error: failureToast(err) ?? 'could not read ready work', beads: [] };
  }
  try {
    const [jobsRes, runsRes, burstRes] = await Promise.all([
      api('GET', '/api/jobs'),
      api('GET', '/api/runs?limit=200'),
      api('GET', '/api/bursts').catch(() => ({ active: null })),
    ]);
    state.jobs = jobsRes.jobs ?? [];
    state.runs = runsRes.runs ?? [];
    state.burst = burstRes?.active ?? null;
  } catch { /* activity card degrades to its own empty state */ }
  render();
}

// ---------------- actions ----------------

async function onAction(act, btn) {
  const p = state.project;
  if (!p) return;
  try {
    if (act === 'activate') {
      // The airlock, restated in full on this page too — a reader who arrived
      // by deep link has not seen the list's sentence about it.
      // eslint-disable-next-line no-alert
      if (!isResume(p) && !window.confirm(`Activate "${p.name}"?\n\n`
        + `From now on LaunchBox will start ready beads from ${p.path} on its own, unattended — `
        + `every bead that is open, unblocked and carries the `
        + `${p.config?.autoLabel ? `"${p.config.autoLabel}"` : 'configured autoLabel'} label, with no `
        + `further prompt, including while you are away from the machine.\n\n`
        + `Pause stops it again at any time.`)) return;
      let out = null;
      const ok = await guardedSubmit(btn, async () => {
        out = await api('PUT', `/api/projects/${p.id}`, { state: 'active' });
      }, toast);
      if (!ok) return;
      const why = [...(out?.reasons ?? []), ...(out?.warnings ?? [])];
      toast(why.length ? `Activated, but nothing will run yet — ${why.join(' · ')}` : `"${p.name}" is active`, why.length ? '' : 'ok');
    } else if (act === 'pause') {
      await api('PUT', `/api/projects/${p.id}`, { state: 'paused' });
      toast(`"${p.name}" paused — nothing new starts from it`);
    } else if (act === 'poll') {
      const r = await api('POST', `/api/projects/${p.id}/poll`);
      toast(r.skipped === true
        ? `Not polled — ${r.reasons?.join(' · ') || 'nothing to do'}`
        : `${r.ready?.length ?? 0} ready · started ${r.started?.length ?? 0}`, '', 8000);
    }
  } catch (err) {
    toast(failureToast(err) ?? `${act} failed`, 'err');
  }
  loadAndRender();
}

// ---------------- pieces ----------------

function chipEl(meta, style) {
  return el('span', { class: `state state--${meta.cls}`, style }, [
    el('span', { class: `state__dot ${meta.dot}`.trim() }),
    meta.label,
  ]);
}

function fact(k, v, d) {
  return el('div', { class: 'fact' }, [
    el('div', { class: 'fact__k' }, k),
    el('div', { class: 'fact__v mono' }, v),
    d ? el('div', { class: 'fact__d' }, d) : null,
  ]);
}

function factsCard(p) {
  const cfg = p.config ?? {};
  const held = p.leases?.held ?? 0;
  const pollSec = state.meta?.pollSec;
  const bdVer = p.bdVersion || state.meta?.bd?.version;
  return el('section', { class: 'card', style: 'margin-bottom: 16px;' },
    el('div', { class: 'card__body', style: 'padding: 14px 18px;' },
      el('div', { class: 'facts' }, [
        // "of 23 open" is the mockup's second line here and is not rendered:
        // no open-bead count exists anywhere in the adapter or the API.
        fact('Ready beads', p.ready?.count == null ? '—' : String(p.ready.count),
          p.ready?.count == null ? 'never successfully polled' : `as of ${fmtTime(p.ready.at) ?? 'an earlier poll'}`),
        fact('Auto label', cfg.autoLabel || '—',
          cfg.autoLabel ? 'required on every bead' : 'none declared, so no bead is eligible'),
        fact('Last poll', fmtTime(p.lastPollAt) || 'never',
          [pollSec ? `every ${pollSec}s` : null, bdVer ? `bd ${bdVer}` : null].filter(Boolean).join(' · ') || null),
        fact('Leases held', String(held), held ? 'checked out to a run right now' : 'nothing claimed right now'),
        fact('Permission mode', cfg.defaults?.permMode || '—', 'from .scheduler.json'),
        fact('Min headroom', cfg.budget?.minHeadroomPct != null ? `${cfg.budget.minHeadroomPct}%` : '—',
          'extra, on top of reserves'),
      ])));
}

function beadRow(b, now) {
  const pill = priorityPill(b.priority);
  const meta = beadMeta(b);
  return el('div', { class: 'row beadrow' }, [
    el('span', { class: 'mono t-body' }, b.id),
    el('div', { class: 'cell' }, [
      el('div', { class: 'cell__l1' }, [
        pill ? el('span', { class: `pill ${pill.cls}` }, pill.label) : null,
        el('span', { class: 'row__n' }, b.title || '(no title)'),
      ]),
      el('div', { class: 'cell__l2' }, [
        ...(b.labels ?? []).map((l) => el('span', { class: 'tag' }, l)),
        meta.length ? el('span', { class: 'mono' }, meta.join(' · ')) : null,
      ]),
    ]),
    el('span', { class: 't-meta mono' }, beadAge(b, now) ?? ''),
  ]);
}

function readyCard(p) {
  const r = state.ready;
  const beads = claimOrder(r?.beads ?? []);
  const now = Date.now();

  const body = [];
  if (r?.error) {
    body.push(el('div', { class: 'card__body' }, el('div', { class: 'banner' }, [
      svgNode(SVG_WARN), el('span', {}, [el('b', {}, 'Could not read ready work.'), ` ${r.error}`]),
    ])));
  } else if (r?.busy) {
    body.push(el('div', { class: 'card__body' }, el('div', { class: 'banner' }, [
      svgNode(SVG_CLOCK),
      el('span', {}, [
        el('b', {}, 'Beads database busy.'),
        ' Something else holds the lock — most likely an interactive bd session. This is busy, not '
        + 'broken: LaunchBox backs off and retries. The list below is what it last managed to read.',
      ]),
    ])));
  }
  for (const reason of r?.reasons ?? []) {
    body.push(el('div', { class: 'card__body' }, el('p', { class: 't-meta', style: 'margin:0;' }, reason)));
  }

  if (beads.length) {
    body.push(el('div', { class: 'rows' }, [
      el('div', { class: 'row row--head beadrow' }, [el('span', {}, 'Bead'), el('span', {}, 'Title'), el('span', {}, '')]),
      ...beads.map((b) => beadRow(b, now)),
    ]));
  } else if (!r?.error) {
    body.push(el('div', { class: 'card__body' }, el('div', { class: 'blank', style: 'border:0;background:transparent;padding:18px 8px;' }, [
      el('span', { class: 'blank__icon', html: SVG_BEAD }),
      el('div', {}, [
        el('h4', {}, 'Nothing is ready to be claimed'),
        el('p', {}, r?.autoLabel
          ? `No bead is open, unblocked and carrying the ${r.autoLabel} label right now.`
          : 'No autoLabel is configured in this repo\'s .scheduler.json, so no bead is eligible.'),
      ]),
    ])));
  }

  // The mockup's coverage line also breaks down what is NOT ready ("11 blocked
  // by dependencies · 8 missing the label"). `bd ready` applies both filters
  // server-side, so those beads never reach us to be counted — the half that
  // survives is how a bead run actually behaves, which is true and worth
  // saying on the page that lists them.
  body.push(el('div', { class: 'card__body', style: 'border-top: 1px solid var(--line-2); padding: 11px 18px;' },
    el('span', { class: 'coverage' }, [
      el('span', {}, 'Beads run one at a time in a disposable worktree.'),
      el('span', {}, '· a bead closes only on TASK-COMPLETE, otherwise it is handed back to open with the agent\'s note attached'),
    ])));

  return el('section', { class: 'card', style: 'margin-bottom: 16px;' }, [
    el('div', { class: 'card__head' }, [
      el('h2', {}, 'Ready to be claimed'),
      el('span', { class: 'tab__n' }, String(beads.length)),
      el('span', { class: 't-meta', style: 'margin-left:auto;' }, 'claim order: priority, then age'),
    ]),
    ...body,
  ]);
}

// Runs of this project's per-bead jobs. There is no /api/runs?project= filter
// and the API policy is additive-only, so the join is done here from two calls
// that already exist: a bead job carries `params._projectId` / `params._beadId`
// (lib/db.js's findJobByBead reads the same keys).
function projectRuns(p) {
  const jobById = new Map();
  for (const j of state.jobs) {
    if (j.params?._projectId === p.id) jobById.set(j.id, j);
  }
  return state.runs
    .filter((r) => jobById.has(r.jobId))
    .slice(0, 8)
    .map((r) => ({ run: r, job: jobById.get(r.jobId) }));
}

function activityRow({ run, job }) {
  const m = statusMeta(beadRunStateKey(run));
  const when = run.finishedAt ?? run.startedAt;
  const dur = run.startedAt && run.finishedAt
    ? `${Math.max(0, Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000))}s`
    : null;
  const bead = job.params?._beadId;
  // The chip — not the subline — is where the bead's fate shows. A run that
  // exited ok but never signalled TASK-COMPLETE now reads "handed back"
  // (beadRunStateKey, off runs.beadOutcome; claude-scheduler-dc9), so an ok
  // chip on this list means the bead actually closed.
  //
  // Still NOT rendered: the mockup's "closed with TASK-COMPLETE" / "returned to
  // open with the agent's note attached" sublines. The field would now back the
  // first half, but the note is written by `bd note` and never read back here,
  // so the second would still be a guess.
  return el('div', { class: 'row', style: 'grid-template-columns: 90px minmax(0,1fr) auto;' }, [
    chipEl(m),
    el('div', { class: 'cell' }, [
      el('div', { class: 'cell__l1' }, el('span', { class: 'row__n' }, bead ? `bead ${bead} — ${job.name}` : job.name)),
      el('div', { class: 'cell__l2' }, [
        fmtDate(when) ?? '',
        ' ',
        el('span', { class: 'mono' }, fmtTime(when) ?? ''),
        dur ? ' · ' : null,
        dur ? el('span', { class: 'mono' }, dur) : null,
        ' · ',
        el('a', { href: `#runs?job=${encodeURIComponent(run.jobId)}` }, 'runs'),
      ]),
    ]),
    el('span', {}, ''),
  ]);
}

function activityCard(p) {
  const rows = projectRuns(p);
  return el('section', { class: 'card' }, [
    el('div', { class: 'card__head' }, [
      el('h2', {}, 'Recent scheduler activity here'),
      el('a', { class: 't-meta', style: 'margin-left:auto;', href: '#runs' }, 'all runs'),
    ]),
    rows.length
      ? el('div', { class: 'rows' }, rows.map(activityRow))
      : el('div', { class: 'card__body' }, el('p', { class: 't-meta', style: 'margin:0;' },
        'No bead of this project has been run yet. A run appears here once LaunchBox claims a bead '
        + 'and starts it in a worktree.')),
  ]);
}

function configCard(p) {
  const errors = p.configErrors ?? [];
  return el('section', { class: 'card' }, [
    el('div', { class: 'card__head' }, [
      el('h2', {}, 'Declared config'),
      el('span', { class: 't-meta mono', style: 'margin-left:auto;' }, '.scheduler.json · committed'),
    ]),
    el('div', { class: 'card__body' }, [
      el('pre', { class: 'snippet' }, JSON.stringify(p.config ?? {}, null, 2)),
      errors.length
        ? el('div', { class: 'banner', style: 'margin-top: 10px;' }, [
          svgNode(SVG_WARN),
          el('span', {}, [el('b', {}, 'This file cannot be used as declared.'), ` ${errors.join(' · ')}`]),
        ])
        : null,
      el('p', { class: 't-meta', style: 'margin: 10px 0 0;' },
        'The repo declares what it allows; LaunchBox never exceeds it. Changing this file takes effect '
        + 'on the next poll — no re-activation needed.'),
    ]),
  ]);
}

// ---------------- top-level render ----------------

function missingCard(msg) {
  return el('section', { class: 'card' }, el('div', { class: 'card__body' }, el('div', { class: 'blank', style: 'border:0;background:transparent;padding:24px 8px;' }, [
    el('span', { class: 'blank__icon', html: SVG_WARN }),
    el('div', {}, [
      el('h4', {}, msg),
      el('div', { class: 'blank__act' }, [el('a', { class: 'btn', href: '#projects' }, 'Back to Projects')]),
    ]),
  ])));
}

function render() {
  const page = $('#v2-page');
  if (!page) return;
  // An in-flight load from BEFORE a route change must not paint over the page
  // that now owns #v2-page. Clearing the poll timer on route change does not
  // cover this: the request already in the air still resolves and calls
  // render(), which clears #v2-page and rebuilds it for a route the reader has
  // already left. Measured in a real browser during C2's verification
  // (claude-scheduler-btv.9) — Projects → project detail → Projects rendered
  // the DETAIL page under the Projects route, and the reverse going back.
  if (!mounted) return;
  clear(page);

  if (!state.id) {
    page.appendChild(pageHead({ title: 'Project' }));
    page.appendChild(missingCard('No project id in the link'));
    return;
  }
  const p = state.project;
  if (!p) {
    page.appendChild(pageHead({ title: 'Project' }));
    page.appendChild(missingCard(state.failed
      ? 'Could not reach LaunchBox to load this project'
      : 'That project is not registered any more'));
    return;
  }

  const chip = chipFor(p, burstProjectIds(state.burst));
  const actions = projectActions(p).map((a) => {
    const btn = el('button', {
      class: a.primary ? 'btn btn--primary' : 'btn btn--ghost',
      'data-mutating': true,
      'data-tip': a.tip,
      'data-act': a.act,
    }, a.label);
    btn.addEventListener('click', () => onAction(a.act, btn));
    return btn;
  });

  const head = pageHead({
    title: p.name,
    sub: el('span', {}, [
      chipEl(chip, 'font-size:12.5px;'),
      ' · ',
      el('span', { class: 'mono' }, p.path),
      ' · ',
      // "activated by you on 26 Jul" in the mockup — the projects table has no
      // per-transition stamp, and `updatedAt` moves on every poll, so the only
      // honest date here is when the row was created.
      `registered ${fmtDate(p.createdAt) ?? 'at an unknown date'}`,
      ' · ',
      readyText(p),
      p.lastPollAt ? ` (polled ${relAgo(p.lastPollAt)})` : '',
    ]),
    actions,
  });
  page.appendChild(el('div', { class: 't-meta', style: 'margin-bottom: 4px;' }, el('a', { href: '#projects' }, '← Projects')));
  page.appendChild(head);

  const banner = cardBanner(p);
  if (banner) {
    page.appendChild(el('div', { class: 'banner', style: 'margin-bottom: 16px;' }, [
      svgNode(banner.kind === 'busy' ? SVG_CLOCK : SVG_WARN),
      el('span', {}, [el('b', {}, banner.title), ' ', banner.body]),
    ]));
  }
  for (const w of p.warnings ?? []) {
    page.appendChild(el('p', { class: 't-meta', style: 'margin: 0 0 12px;' }, w));
  }

  page.appendChild(factsCard(p));
  page.appendChild(readyCard(p));
  page.appendChild(el('div', { class: 'ovgrid' }, [
    el('div', {}, activityCard(p)),
    el('div', {}, configCard(p)),
  ]));
}

function ensureRouteWatcher() {
  if (routeWatcherArmed) return;
  routeWatcherArmed = true;
  onRender((route) => {
    mounted = route === 'project';
    if (route !== 'project' && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });
}

export default function project(params) {
  mounted = true;
  ensureRouteWatcher();
  const id = params.get('id');
  const switching = id !== state.id;
  if (switching) {
    // A different project: drop the previous one's data rather than showing it
    // under the new name for one tick.
    Object.assign(state, { id, project: null, ready: null, jobs: [], runs: [], meta: null, failed: false });
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // Paint the shell BEFORE the first load, not after it. This page's load
  // includes GET /api/projects/:id/ready, which runs a real blocking `bd ready`
  // against the repo — seconds, not milliseconds. Without this the reader
  // clicks "Open project" and the PREVIOUS page stays on screen, unchanged,
  // for the whole of that wait, with nothing to say a navigation happened.
  // Measured in a real browser during C2's verification: the Projects list was
  // still up several seconds after the route had changed to #project.
  // runs.js and overview.js already do this; project.js and projects.js did not.
  if (switching || !pollTimer) {
    const page = $('#v2-page');
    if (page) {
      clear(page);
      page.appendChild(el('div', { class: 't-meta', style: 'margin-bottom: 4px;' }, el('a', { href: '#projects' }, '← Projects')));
      page.appendChild(pageHead({ title: 'Project', sub: 'Reading this project\u2019s beads\u2026' }));
    }
  }

  if (!pollTimer) {
    loadAndRender();
    pollTimer = setInterval(loadAndRender, POLL_MS);
    pollTimer.unref?.();
  } else {
    render();
  }
}
