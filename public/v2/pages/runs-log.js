// Run log drawer — redesign/runs-log-{live,failed,winding-down}.html. Owned
// by btv.6 (B2), imported only by runs.js. See public/v2/README.md:
//
//   "A control inserted *between* sweeps (a dialog opened by user action
//    after the page settled) is the documented exception — call the sweep
//    primitives directly." That is exactly this drawer: it is built long
//    after runs.js's own render() (and router.js's onRender sweep) already
//    ran, so disableMutatingControls() is called on it explicitly, once,
//    right after it is inserted (see openLogDrawer() below). Every LATER
//    daemon-down/token-invalid transition is still covered for free, because
//    main.js's onAuthState sweep runs disableMutatingControls(document.body,
//    …) and this drawer is a child of document.body for as long as it's open.
//
// Snapshot semantics (server.js's own comment on GET /api/runs/:id/log):
// there is deliberately no SSE tail — EventSource cannot carry the bearer
// token — so this is an honest one-shot read plus a Refresh button and a
// `tail -f` hint, never a fake "live" indicator.

import {
  el, clear, iconBtn, asOfEl, setDisabledReason, disableMutatingControls, toast,
} from '../ui.js';
import { api, degradedReason, failureToast } from '../api.js';
import { onRender } from '../router.js';
import {
  ICON_CLOSE, ICON_REFRESH, ICON_WINDDOWN, ICON_STOP, ICON_WARN,
} from './runs-icons.js';
import {
  triggerLabel, fmtClock, shortId, statusMeta, stopRungText,
} from './runs-format.js';

let scrim = null;
let drawer = null;
let openRun = null;
let openCtx = null;
let restoreFocusTo = null;
let softGraceMsCache = null;

async function softGraceSeconds() {
  if (softGraceMsCache != null) return Math.round(softGraceMsCache / 1000);
  try {
    const s = await api('GET', '/api/settings');
    softGraceMsCache = s?.softGraceMs ?? 120_000;
  } catch {
    softGraceMsCache = 120_000; // same default as lib/runner.js's DEFAULT_SOFT_GRACE_MS — a display fallback only, never sent anywhere
  }
  return Math.round(softGraceMsCache / 1000);
}

function onKeydown(ev) {
  if (ev.key === 'Escape') closeDrawer();
}

export function closeDrawer() {
  if (!drawer) return;
  document.removeEventListener('keydown', onKeydown);
  scrim.remove();
  drawer.remove();
  scrim = null; drawer = null; openRun = null; openCtx = null;
  restoreFocusTo?.focus?.();
  restoreFocusTo = null;
}

// A route change away from 'runs' must not leave the drawer floating over
// whatever page comes up next — it is appended to document.body, not #v2-page,
// so a plain page re-render would never clear it on its own.
onRender((route) => { if (route !== 'runs') closeDrawer(); });

function isLive(run) { return run.status === 'running' || run.status === 'queued'; }
function isWindingDown(run) { return isLive(run) && !!run.meta?.stopRung; }
function isFinalBad(run) { return ['fail', 'timeout', 'killed'].includes(run.status); }

function buildLines(text) {
  const pre = el('pre', { class: 'logview' });
  const lines = (text ?? '').split('\n');
  lines.forEach((line, i) => {
    let wrap = null;
    if (/error|denied|not found|exception/i.test(line)) wrap = 'mark';
    else if (/SIGINT|SIGTERM|SIGKILL/.test(line)) wrap = 'sig';
    else if (/^…|…$/.test(line.trim())) wrap = 'g';
    if (wrap) pre.appendChild(el(wrap === 'mark' ? 'mark' : 'span', wrap === 'sig' ? { class: 'sig' } : wrap === 'g' ? { class: 'g' } : {}, line));
    else pre.appendChild(document.createTextNode(line));
    if (i < lines.length - 1) pre.appendChild(document.createTextNode('\n'));
  });
  return pre;
}

function stateChip(run) {
  const m = statusMeta(run.status);
  const parts = [el('span', { class: `state__dot ${m.dot}`.trim() }), ` ${m.label}`];
  if (isWindingDown(run)) parts.push(' · stopping…');
  else if (run.status === 'fail' && run.exitCode != null) parts.push([' · exit ', el('span', { class: 'mono' }, String(run.exitCode))]);
  return el('span', { class: `state state--${m.cls}`, style: 'margin-left:auto;' }, parts);
}

async function buildBody(run, logText) {
  const body = el('div', { class: 'drawer__body' });

  if (isWindingDown(run)) {
    const graceS = await softGraceSeconds();
    body.appendChild(el('div', { class: 'banner', style: 'margin: 12px 0;' }, [
      el('span', { html: ICON_WINDDOWN }),
      el('span', {}, [
        el('b', {}, 'Winding down. '),
        stopRungText(run.meta?.stopRung), run.meta?.stopReason ? ` (${run.meta.stopReason})` : '',
        ` — up to ${graceS}s to finish its current step before SIGTERM. `,
        el('b', {}, 'It will be recorded as stopped, not failed.'),
      ]),
    ]));
  } else if (isFinalBad(run)) {
    const detail = run.status === 'killed'
      ? 'Hard stop was active — SIGKILL, no cleanup ran.'
      : run.status === 'timeout'
        ? 'The run did not finish inside its timeout and was signalled to stop.'
        : `Exited with code ${run.exitCode ?? '?'}.`;
    body.appendChild(el('div', { class: 'banner banner--bad', style: 'margin: 12px 0;' }, [
      el('span', { html: ICON_WARN }),
      el('span', {}, [el('b', {}, detail), run.meta?.sessionId ? ` Session ${shortId(run.meta.sessionId)} is resumable.` : '']),
    ]));
  }

  const asofRow = el('div', { class: 'rowline', style: 'padding: 12px 0 10px;' }, [
    el('span', { class: 't-meta' }, [
      'Snapshot ', asOfEl(new Date()), ' — ',
      isLive(run) ? 'the log does not stream; refresh to re-read it.' : 'the run has finished — this log is final.',
    ]),
  ]);
  const refreshBtn = el('button', { class: 'btn btn--ghost', style: 'margin-left:auto;', html: ICON_REFRESH, onclick: () => refreshDrawer() });
  refreshBtn.append(' Refresh');
  asofRow.appendChild(refreshBtn);
  body.appendChild(asofRow);

  body.appendChild(buildLines(logText));

  body.appendChild(el('p', { class: 't-meta', style: 'margin-top: 10px;' },
    isLive(run) && run.logPath
      ? ['Follow it live in a terminal: ', el('span', { class: 'mono' }, `tail -f ${run.logPath}`)]
      : run.logPath
        ? ['Full file: ', el('span', { class: 'mono' }, run.logPath)]
        : 'No log file for this run.'));

  return body;
}

function buildFoot(run, ctx) {
  if (isWindingDown(run)) {
    const btn = el('button', { class: 'btn btn--danger', 'data-mutating': true, 'data-tip': 'SIGKILL immediately — skips the grace period' }, 'Stop now instead');
    btn.addEventListener('click', () => doAction(run, 'kill', btn));
    return el('div', { class: 'drawer__foot' }, btn);
  }
  if (isLive(run)) {
    const wind = el('button', { class: 'btn', 'data-mutating': true, 'data-tip': 'SIGINT, then SIGTERM after the grace period' }, 'Wind down after current step');
    wind.addEventListener('click', () => doAction(run, 'stop', wind));
    const stop = el('button', { class: 'btn btn--danger', 'data-mutating': true, 'data-tip': 'SIGKILL immediately — no cleanup will run' }, 'Stop now');
    stop.addEventListener('click', () => doAction(run, 'kill', stop));
    return el('div', { class: 'drawer__foot' }, [wind, stop]);
  }
  if (isFinalBad(run)) {
    // data-mutating only when the button is actually clickable right now — a
    // control disabled for a BUSINESS reason (job deleted) must never carry
    // it, or main.js's central sweep would wrongly re-enable it the next time
    // the daemon round-trips healthy (disableMutatingControls(..., null) sweeps
    // every data-mutating element unconditionally; see runs.js's own note).
    const attrs = ctx.jobExists
      ? { class: 'btn btn--primary', 'data-mutating': true }
      : { class: 'btn btn--primary', disabled: true, 'data-tip': 'The job that made this run was deleted' };
    const again = el('button', attrs, 'Run again now');
    if (ctx.jobExists) {
      again.addEventListener('click', async () => {
        try {
          await api('POST', `/api/jobs/${run.jobId}/run`);
          toast('Run started', 'ok');
          closeDrawer();
        } catch (err) { toast(failureToast(err) ?? 'could not start the run', 'err'); }
      });
    }
    return el('div', { class: 'drawer__foot' }, again);
  }
  return null;
}

async function doAction(run, action, btn) {
  const prevLabel = btn.textContent;
  btn.disabled = true;
  try {
    await api('POST', `/api/runs/${run.id}/${action}`);
    toast(action === 'kill' ? 'Run stopped' : 'Winding down at the next safe point', 'ok');
    await refreshDrawer();
  } catch (err) {
    toast(failureToast(err) ?? `${action} failed`, 'err');
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
}

async function loadRunAndLog(runId) {
  const [{ runs: fresh }, logText] = await Promise.all([
    api('GET', '/api/runs?limit=100'),
    api('GET', `/api/runs/${runId}/log`).catch(() => ''),
  ]);
  const run = fresh.find((r) => r.id === runId) ?? openRun;
  return { run, logText: typeof logText === 'string' ? logText : '' };
}

async function renderDrawer(run, ctx, logText) {
  clear(drawer);
  const head = el('div', { class: 'drawer__head' }, [
    el('div', {}, [
      el('div', { class: 't-card' }, ctx.jobName),
      el('div', { class: 't-meta' }, [
        el('span', { class: 'mono' }, shortId(run.id)), ` · ${triggerLabel(run.trigger)} · `,
        run.startedAt ? ['started ', el('span', { class: 'mono' }, fmtClock(new Date(run.startedAt)))] : 'not started',
      ]),
    ]),
    stateChip(run),
    iconBtn({ label: 'Close', tag: 'a', href: '#runs', svgHtml: ICON_CLOSE, onclick: (ev) => { ev.preventDefault(); closeDrawer(); } }),
  ]);
  drawer.appendChild(head);
  drawer.appendChild(await buildBody(run, logText));
  const foot = buildFoot(run, ctx);
  if (foot) drawer.appendChild(foot);
  disableMutatingControls(drawer, degradedReason());
  return head.querySelector('.iconbtn');
}

async function refreshDrawer() {
  if (!openRun) return;
  try {
    const { run, logText } = await loadRunAndLog(openRun.id);
    openRun = run;
    await renderDrawer(run, openCtx, logText);
  } catch (err) {
    toast(failureToast(err) ?? 'could not refresh the log', 'err');
  }
}

/**
 * ctx: { jobName, jobExists, triggerEl } — triggerEl is the element that
 * opened the drawer (a row's "Log" link), refocused on close.
 */
export async function openLogDrawer(run, ctx) {
  closeDrawer();
  openRun = run;
  openCtx = ctx;
  restoreFocusTo = ctx.triggerEl ?? null;

  scrim = el('div', { class: 'scrim', 'data-open': true, onclick: () => closeDrawer() });
  drawer = el('aside', { class: 'drawer drawer--log', 'data-open': true, 'aria-label': 'Run log' });
  document.body.append(scrim, drawer);
  document.addEventListener('keydown', onKeydown);

  let logText = '';
  try {
    logText = await api('GET', `/api/runs/${run.id}/log`);
    if (typeof logText !== 'string') logText = '';
  } catch (err) {
    toast(failureToast(err) ?? 'could not load the log', 'err');
  }
  const closeBtn = await renderDrawer(run, ctx, logText);
  closeBtn?.focus();
}
