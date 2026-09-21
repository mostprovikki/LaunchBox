// Session transcript page (claude-scheduler-btv.10 / C3). Mockup:
// redesign/session-transcript.html. Route `#session?id=<sessionId>`.
//
// Endpoints reused unchanged: GET /api/sessions, GET /api/sessions/:id/
// conversation, GET /api/jobs (to name the bead a run was for), plus the
// rename/resume/delete trio the list also uses.
//
// The transcript is a SNAPSHOT, not a live tail — same constraint the log
// drawer has, and for the same reason (server.js's comment on why there is no
// SSE route: EventSource cannot carry an Authorization header).
//
// What this page may claim about the outcome, and what it may not: the
// TASK-COMPLETE marker is literally text in the last assistant turn, so it is
// read out of the transcript and shown. Whether the SCHEDULER then closed the
// bead or handed it back is not persisted anywhere (claude-scheduler-dc9), so
// the mockup's "bead wb-142 closed by the scheduler after the marker was seen"
// is not rendered. See sessions-logic.js's header for the full list.
import { api, failureToast } from '../api.js';
import { $, el, clear, pageHead, toast } from '../ui.js';
import { onRender } from '../router.js';
import {
  fmtWhen, fmtDur, fmtCount, fmtBytes, modelText, turnCount, sessionTitle, shortId,
  pairTurns, toolSummary, toolOpensByDefault, diffLines, taskCompleteMarker, transcriptCounts,
  truncate,
} from './sessions-logic.js';

const SVG_WARN = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>';
const SVG_CHEV = '<svg class="tooluse__chev ic--s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="12" height="12"><path d="m9 6 6 6-6 6"/></svg>';

// True only while this page owns #v2-page. See render()'s guard.
let mounted = false;
let routeWatcherArmed = false;

const state = { id: null, session: null, turns: null, jobs: [], failed: false, armed: false };

function svgNode(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

// ---------------- data ----------------

async function load() {
  if (!state.id) { render(); return; }
  try {
    const { session } = await api('GET', `/api/sessions/${state.id}`);
    state.session = session;
    state.failed = false;
  } catch (err) {
    state.failed = err.status === 404 ? 'missing' : true;
    render();
    return;
  }
  try {
    const convo = await api('GET', `/api/sessions/${state.id}/conversation`);
    state.turns = convo?.turns ?? [];
  } catch {
    state.turns = null; // the header still renders; the body says why it cannot
  }
  try {
    const { jobs } = await api('GET', '/api/jobs');
    state.jobs = jobs ?? [];
  } catch { /* the bead name is a nicety, not a requirement */ }
  render();
}

// ---------------- actions ----------------

async function onRename() {
  // eslint-disable-next-line no-alert
  const name = window.prompt('Name this session', sessionTitle(state.session));
  if (name == null) return;
  try {
    await api('POST', `/api/sessions/${state.id}/rename`, { name });
    toast('Renamed', 'ok');
  } catch (err) {
    toast(failureToast(err) ?? 'could not rename that session', 'err', 8000);
  }
  load();
}

async function onResume() {
  try {
    await api('POST', `/api/sessions/${state.id}/resume`);
    toast('Opening Terminal…', 'ok');
  } catch (err) {
    toast(failureToast(err) ?? 'could not resume that session', 'err', 8000);
  }
}

async function onDelete() {
  try {
    await api('DELETE', `/api/sessions/${state.id}`);
    toast('Transcript deleted', 'ok');
    location.hash = '#sessions';
  } catch (err) {
    toast(failureToast(err) ?? 'could not delete that transcript', 'err', 8000);
    state.armed = false;
    render();
  }
}

// ---------------- transcript rendering ----------------

function toolDetail(turn, result) {
  const sects = [];
  const input = turn.input && typeof turn.input === 'object' ? turn.input : {};

  // A Bash call's command is the thing worth reading first, above its output.
  if (turn.tool === 'Bash' && input.command) {
    sects.push(['command', el('pre', {}, `$ ${input.command}`)]);
  }
  if ((turn.tool === 'Read' || turn.tool === 'Write' || turn.tool === 'Edit' || turn.tool === 'MultiEdit') && input.file_path) {
    sects.push(['file', el('pre', {}, String(input.file_path))]);
  }

  // A pre-computed structuredPatch renders as a diff; there is no diffing
  // here, only classification (lib/sessions.js passes the CLI's hunks through
  // verbatim).
  const patch = result?.toolUseResult?.structuredPatch;
  if (Array.isArray(patch) && patch.length) {
    const pre = el('pre', { class: 'diff' });
    for (const hunk of patch) {
      const { header, lines } = diffLines(hunk);
      pre.appendChild(el('span', { class: 'ctx' }, header));
      pre.appendChild(document.createTextNode('\n'));
      for (const l of lines) {
        pre.appendChild(el('span', { class: l.cls }, l.text));
        pre.appendChild(document.createTextNode('\n'));
      }
    }
    sects.push(['Change', pre]);
  }

  // stdout and stderr stay separate, and an empty-but-present stream stays
  // visually distinct from "no result recorded at all" — M5's finding.
  const tur = result?.toolUseResult;
  if (tur && typeof tur === 'object' && (tur.stdout !== undefined || tur.stderr !== undefined)) {
    if (tur.stdout) sects.push(['stdout', el('pre', {}, tur.stdout)]);
    if (tur.stderr) sects.push(['stderr', el('pre', { style: 'color: var(--bad);' }, tur.stderr)]);
    if (!tur.stdout && !tur.stderr) sects.push(['Result', el('pre', {}, '(ran with no output)')]);
  } else if (result?.text) {
    sects.push([result.isError ? 'Error' : 'Result', el('pre', { style: result.isError ? 'color: var(--bad);' : null }, result.text)]);
  } else if (result && tur && typeof tur === 'object') {
    sects.push(['Result', el('pre', {}, JSON.stringify(tur, null, 2))]);
  } else if (!result) {
    sects.push(['Result', el('pre', {}, '(no result recorded)')]);
  }

  // Anything left over on the input that the sections above did not show.
  const shown = new Set(['command', 'file_path']);
  const rest = Object.fromEntries(Object.entries(input).filter(([k]) => !shown.has(k)));
  if (Object.keys(rest).length) sects.push(['input', el('pre', {}, JSON.stringify(rest, null, 2))]);

  return el('div', { class: 'tooldetail' }, sects.map(([k, body]) => el('div', { class: 'tooldetail__sect' }, [
    el('div', { class: 'tooldetail__k' }, k),
    body,
  ])));
}

function toolBlock(turn, result) {
  const open = toolOpensByDefault(turn.tool, result);
  const summary = toolSummary(turn.tool, turn.input, result);
  const chev = svgNode(SVG_CHEV);
  if (open) chev.setAttribute('style', 'transform: rotate(90deg);');

  const header = el('div', {
    class: `tooluse${open ? ' tooluse--open' : ''}`,
    role: 'button',
    tabindex: '0',
    'aria-expanded': open ? 'true' : 'false',
    // The accessible name has to say WHICH call this is, not just "tool call" —
    // a transcript can hold forty of them (REVIEW #5's contract, applied to a
    // control that is a div rather than an .iconbtn).
    'aria-label': `${turn.tool}${summary ? ` — ${summary}` : ''}`,
  }, [
    el('span', { class: 'tooluse__name' }, turn.tool || 'tool'),
    el('span', { class: 'tooluse__sum' }, summary),
    result?.isError ? el('span', { class: 'state state--bad' }, [el('span', { class: 'state__dot' }), 'error']) : null,
    chev,
  ]);

  const detail = toolDetail(turn, result);
  detail.hidden = !open;

  const toggle = () => {
    const nowOpen = detail.hidden;
    detail.hidden = !nowOpen;
    header.classList.toggle('tooluse--open', nowOpen);
    header.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
    chev.setAttribute('style', nowOpen ? 'transform: rotate(90deg);' : '');
  };
  header.addEventListener('click', toggle);
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });

  return [header, detail];
}

// Paragraph splitting only — this is NOT a markdown renderer. Transcript text
// is agent-authored and goes through textContent, never innerHTML, so a turn
// containing HTML renders as the characters the agent wrote.
function proseNodes(text) {
  return String(text ?? '')
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => el('p', {}, p));
}

function messageBlock(who, isUser, children) {
  return el('div', { class: `msg${isUser ? ' msg--user' : ''}` }, [
    el('span', { class: 'msg__who' }, who),
    el('div', { class: 'msg__body' }, children),
  ]);
}

function renderTurns(turns) {
  const { resultFor, consumed } = pairTurns(turns);
  const out = [];
  // Consecutive assistant text and its tool calls belong in ONE bubble, the way
  // the mockup draws them — an assistant turn followed by three Greps is one
  // stretch of work, not four messages.
  let openAssistant = null;
  const closeAssistant = () => { openAssistant = null; };

  for (const turn of turns) {
    if (turn.role === 'user') {
      closeAssistant();
      const body = turn.text ? proseNodes(turn.text) : [el('p', { class: 't-meta' }, turn.note ?? '(empty turn)')];
      out.push(messageBlock('You', true, body));
      continue;
    }
    if (turn.role === 'assistant') {
      const nodes = proseNodes(turn.text);
      if (openAssistant) openAssistant.append(...nodes);
      else {
        const block = messageBlock('Claude', false, nodes);
        openAssistant = block.querySelector('.msg__body');
        out.push(block);
      }
      continue;
    }
    if (turn.role === 'tool_use') {
      const result = turn.toolUseId ? resultFor.get(turn.toolUseId) : null;
      const nodes = toolBlock(turn, result);
      if (openAssistant) openAssistant.append(...nodes);
      else {
        const block = messageBlock('Claude', false, nodes);
        openAssistant = block.querySelector('.msg__body');
        out.push(block);
      }
      continue;
    }
    if (turn.role === 'tool_result') {
      if (consumed.has(turn)) continue; // already rendered inside its own call
      closeAssistant();
      out.push(messageBlock('tool result (unpaired)', false, [el('pre', {}, turn.text ?? '(empty)')]));
      continue;
    }
    // An unknown future role is shown as JSON rather than dropped silently.
    closeAssistant();
    out.push(messageBlock(turn.role ?? 'unknown', false, [el('pre', {}, JSON.stringify(turn, null, 2))]));
  }
  return out;
}

// ---------------- page ----------------

function fact(k, v, d, cls) {
  return el('div', { class: `fact${cls ? ` ${cls}` : ''}` }, [
    el('div', { class: 'fact__k' }, k),
    el('div', { class: 'fact__v mono' }, v),
    el('div', { class: 'fact__d' }, d ?? '—'),
  ]);
}

// The bead a run was for, via the same params._beadId join the project detail
// page uses. Absent for an interactive session, which is not a fault.
function beadFor(session) {
  const jobId = session?.runs?.[0]?.jobId;
  if (!jobId) return null;
  return state.jobs.find((j) => j.id === jobId)?.params?._beadId ?? null;
}

function factsCard(s, marker) {
  const counts = state.turns ? transcriptCounts(state.turns) : null;
  const bead = beadFor(s);
  return el('section', { class: 'card', style: 'margin-bottom: 16px;' },
    el('div', { class: 'card__body', style: 'padding: 14px 18px;' },
      el('div', { class: 'facts', style: 'grid-template-columns: repeat(4, minmax(0, 1fr));' }, [
        fact('Session', shortId(s.id), `${fmtBytes(s.sizeBytes)} on disk`),
        fact('Span / active', fmtDur(s.spanMs) ?? '—',
          s.activeMs != null ? `active ${fmtDur(s.activeMs) ?? '—'}` : 'active time not recorded'),
        // Tool calls ARE countable here — the turns are already parsed — which
        // is exactly why the list card does not try.
        fact('Turns', String(turnCount(s.models) || counts?.turns || 0),
          counts ? `${counts.toolCalls} tool call${counts.toolCalls === 1 ? '' : 's'}` : 'transcript not read'),
        fact('Models', modelText(s.models), null),
        fact('Tokens', `${fmtCount(s.tokIn)} in · ${fmtCount(s.tokOut)} out`, 'deduplicated'),
        // "worktree" in the mockup — nothing records whether the branch is one.
        fact('Branch', s.gitBranch || '—', s.gitBranch ? 'from transcript' : 'none recorded'),
        fact('Cwd', s.cwd ? truncate(s.cwd, 34) : '—',
          s.cwdGuessed ? 'decoded from the path — may not exist' : 'from transcript'),
        marker
          ? fact('Outcome', 'TASK-COMPLETE',
            // Says what was OBSERVED (the marker in the final message), never
            // what the scheduler did about it — that is not persisted (dc9).
            bead ? `marker for ${bead} in the final message` : 'marker in the final message', 'fact--ok')
          : fact('Outcome', '—', s.runs?.length ? 'no TASK-COMPLETE marker in the final message' : 'interactive'),
      ])));
}

function missingCard(msg, detail) {
  return el('section', { class: 'card' }, el('div', { class: 'card__body' }, el('div', { class: 'blank', style: 'border:0;background:transparent;padding:24px 8px;' }, [
    el('span', { class: 'blank__icon', html: SVG_WARN }),
    el('div', {}, [
      el('h4', {}, msg),
      detail ? el('p', {}, detail) : null,
      el('div', { class: 'blank__act' }, [el('a', { class: 'btn', href: '#sessions' }, 'Back to Sessions')]),
    ]),
  ])));
}

function render() {
  if (!mounted) return;
  const page = $('#v2-page');
  if (!page) return;
  clear(page);
  page.appendChild(el('div', { class: 't-meta', style: 'margin-bottom: 4px;' }, el('a', { href: '#sessions' }, '← Sessions')));

  if (!state.id) {
    page.appendChild(pageHead({ title: 'Session transcript' }));
    page.appendChild(missingCard('No session id in the link'));
    return;
  }
  const s = state.session;
  if (!s) {
    page.appendChild(pageHead({ title: 'Session transcript', sub: state.failed ? 'Not loaded' : 'Reading the transcript…' }));
    if (state.failed === 'missing') page.appendChild(missingCard('That transcript no longer exists', 'It may have been deleted since the list was loaded.'));
    else if (state.failed) page.appendChild(missingCard('Could not reach LaunchBox to load this transcript'));
    return;
  }

  const marker = state.turns ? taskCompleteMarker(state.turns) : null;

  const resume = el('button', { class: 'btn', 'data-mutating': true, 'data-act': 'resume' }, 'Resume in Terminal');
  resume.addEventListener('click', onResume);
  const rename = el('button', { class: 'btn btn--ghost', 'data-mutating': true, 'data-act': 'rename' }, 'Rename');
  rename.addEventListener('click', onRename);

  // REVIEW #4's arm-then-confirm, same contract as the list's rows: the first
  // click only states the consequence, and the second is the only one that
  // sends anything.
  let deleteControls;
  if (state.armed) {
    const cancel = el('button', { class: 'btn btn--ghost', 'data-act': 'cancel' }, 'Cancel');
    cancel.addEventListener('click', () => { state.armed = false; render(); });
    const confirm = el('button', { class: 'btn btn--danger', 'data-mutating': true, 'data-act': 'delete-confirm' }, 'Delete permanently');
    confirm.addEventListener('click', onDelete);
    deleteControls = [cancel, confirm];
  } else {
    const arm = el('button', {
      class: 'btn btn--ghost btn--danger', 'data-mutating': true, 'data-act': 'delete',
      'data-tip': 'Deletes the transcript permanently — the session can no longer be resumed',
    }, 'Delete');
    arm.addEventListener('click', () => { state.armed = true; render(); });
    deleteControls = [arm];
  }

  const bead = beadFor(s);
  page.appendChild(pageHead({
    title: sessionTitle(s),
    sub: el('span', { class: 'mono' }, [
      shortId(s.id),
      s.firstTs ? ` · ${fmtWhen(s.firstTs)} → ${fmtWhen(s.lastTs)}` : '',
      s.models ? ` · ${modelText(s.models)}` : '',
      s.runs?.[0]?.jobName ? ` · ${s.runs[0].jobName}` : '',
      bead ? ` · bead ${bead}` : '',
    ].join('')),
    actions: [resume, rename, ...deleteControls],
  }));

  if (state.armed) {
    page.appendChild(el('div', { class: 'banner', style: 'margin-bottom: 16px;' }, [
      svgNode(SVG_WARN),
      el('span', {}, [
        el('b', {}, 'Delete this transcript permanently?'),
        ' The file is removed from disk and the session can never be resumed again. '
        + 'Nothing has been deleted yet.',
      ]),
    ]));
  }

  page.appendChild(factsCard(s, marker));

  const card = el('section', { class: 'card' });
  if (!state.turns) {
    card.appendChild(el('div', { class: 'card__body' }, el('p', { class: 't-meta', style: 'margin:0;' },
      'The transcript file could not be read. The summary above comes from the index, which was '
      + 'written when the file was last scanned.')));
  } else if (!state.turns.length) {
    card.appendChild(el('div', { class: 'card__body' }, el('p', { class: 't-meta', style: 'margin:0;' },
      'No turns in this transcript.')));
  } else {
    card.appendChild(el('div', { class: 'rows' }, renderTurns(state.turns)));
    const counts = transcriptCounts(state.turns);
    card.appendChild(el('div', { class: 'card__body', style: 'border-top: 1px solid var(--line); padding: 12px 18px;' },
      el('span', { class: 'coverage' }, [
        el('span', {}, `${counts.turns} turns · ${counts.toolCalls} tool calls (${counts.collapsed} collapsed above)`),
        el('span', {}, `· tokens ${fmtCount(s.tokIn)} in · ${fmtCount(s.tokOut)} out, deduplicated`),
        // A snapshot, not a tail — the same honesty the log drawer needs.
        el('span', {}, '· this is a snapshot of the file as it was read, not a live tail'),
      ])));
  }
  page.appendChild(card);
}

function ensureRouteWatcher() {
  if (routeWatcherArmed) return;
  routeWatcherArmed = true;
  onRender((route) => {
    mounted = route === 'session';
    // Leaving disarms the delete — a primed destructive control must not
    // survive a navigation.
    if (route !== 'session') state.armed = false;
  });
}

export default function session(params) {
  mounted = true;
  ensureRouteWatcher();
  const id = params.get('id');
  if (id !== state.id) {
    Object.assign(state, { id, session: null, turns: null, jobs: [], failed: false, armed: false });
  }
  // The shell first: reading a transcript is a file parse that can take a
  // moment, and the previous page must not stay on screen for it.
  const page = $('#v2-page');
  if (page && !state.session) {
    clear(page);
    page.appendChild(el('div', { class: 't-meta', style: 'margin-bottom: 4px;' }, el('a', { href: '#sessions' }, '← Sessions')));
    page.appendChild(pageHead({ title: 'Session transcript', sub: 'Reading the transcript…' }));
  }
  load();
}
