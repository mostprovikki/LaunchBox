// Overview tab — the Monitor (docs/design/launchbox.md §5;
// claude-scheduler-btv.21). Status light + one-line state, a red banner for a daemon fault,
// then four cards: needs-you (largest, the page's one action "Open Inbox"),
// headroom left, running now, LaunchBox spend. No list, meter or control at
// rest — §7 records what was cut and where each now lives. Mockup:
// docs/design/mockups/overview-flavours.html Option 2.
//
// Data: GET /api/v2/overview (headroom, pause, running, spend, fault sources)
// and GET /api/v2/inbox (the needs-me count, §6 "one number, one place").
// POST /api/v2/visits once per page load — before the first read, so "since
// last visit" is measured from the previous visit, not this one.
import { $, el, clear, toast } from '../ui.js';
import { api, getAuthState, onAuthState, failureToast } from '../api.js';
import { onRender } from '../router.js';
import {
  statusLight, daemonFault, needsModel, headroomModel, runningModel, spendModel,
} from './overview-logic.js';

const POLL_MS = 15_000; // same cadence as the appbar chips' poll (chrome.js)

let data = null; // last well-formed GET /api/v2/overview
let inbox = null; // last GET /api/v2/inbox, or null when it cannot be read
// True only while this page owns #v2-page — an in-flight load from before a
// route change must not paint over the page that now owns it (btv.9).
let mounted = false;
let pollTimer = null;

// A 200 in some other shape (a stub, a future change) degrades to "nothing to
// show yet" rather than throwing partway through a render.
const isWellFormed = (res) => !!(res && res.headroom && res.running && res.spend);

const quiet = (err) => err?.code === 'unreachable' || err?.code === 'token_invalid';

async function loadAndRender() {
  const [ov, ib] = await Promise.allSettled([api('GET', '/api/v2/overview'), api('GET', '/api/v2/inbox')]);
  if (ov.status === 'fulfilled') {
    if (isWellFormed(ov.value)) data = ov.value;
  } else if (!quiet(ov.reason)) {
    toast(failureToast(ov.reason) ?? 'could not load overview', 'err');
  }
  if (ib.status === 'fulfilled') inbox = ib.value;
  // A transport failure keeps the last reading (the page goes stale, not
  // blank); a real refusal (e.g. 501, no branches engine) is "unknown".
  else if (!quiet(ib.reason)) inbox = null;
  render();
}

// ---------------- pieces ----------------

function statusBlock(s) {
  return el('div', { class: 'status' }, [
    el('span', { class: `light light--${s.light}` }),
    el('div', {}, [
      el('div', { class: 'status__t' }, s.title),
      el('div', { class: 'status__why t-meta' }, s.why),
    ]),
  ]);
}

function faultBanner(f) {
  const what = f.cmd ? [el('span', { class: 'mono' }, f.cmd), ` cannot be started (${f.code})`] : [`The claude binary cannot be started (${f.code})`];
  return el('div', { class: 'appbanner appbanner--bad ov-fault' }, [
    el('span', {}, [
      el('b', {}, 'LaunchBox cannot start Claude.'), ' ',
      ...what, ', so every bead run fails on start. Bead pickup is stopped until this is fixed.',
    ]),
    el('span', { class: 'appbanner__act' }, el('a', { class: 'btn', href: '#settings' }, 'Fix in Settings')),
  ]);
}

function heroCard(n) {
  const has = typeof n.count === 'number' && n.count > 0;
  return el('a', { class: 'card hero', href: '#inbox' }, [
    el('div', { class: `hero__v${has ? ' hero__v--warn' : ''}` }, n.count == null ? '—' : String(n.count)),
    el('div', {}, [
      el('div', { class: 't-card' }, n.count == null ? 'Inbox unreadable' : has ? 'need you' : 'Nothing needs you'),
      el('div', { class: 't-meta' }, n.parts),
    ]),
    has ? el('span', { class: 'btn btn--primary hero__go' }, 'Open Inbox') : null,
  ]);
}

function factCard(k, m, v) {
  return el('a', { class: `card fact3${m.cls ? ` fact3--${m.cls}` : ''}`, href: m.href }, [
    el('div', { class: 't-eyebrow' }, k),
    el('div', { class: 'fact3__v' }, v ?? m.v),
    el('div', { class: 't-meta' }, m.d),
  ]);
}

function spendCard(s) {
  const bar = s.share.length
    ? el('div', { class: 'share', 'aria-label': 'Last 7 days by project' }, s.share.map((seg) => el('div', {
      class: 'share__seg', style: `flex-basis:${seg.basis}%`, 'data-tip': seg.name,
    }, [
      el('span', { class: 'share__bar', style: `opacity:${seg.opacity}` }),
      el('span', { class: 'share__n t-meta' }, seg.label),
    ])))
    : el('div', { class: 't-meta share' }, 'no LaunchBox runs in the last seven days');
  return el('a', { class: 'card fact3 fact3--spend', href: '#runs' }, [
    el('div', { class: 't-eyebrow' }, ['LaunchBox spend ', el('span', { class: 't-meta' }, '· % of weekly window')]),
    el('div', { class: 'spend2' }, [
      el('div', {}, [el('div', { class: 'spend__v' }, s.sinceVisit), el('div', { class: 't-meta' }, s.sinceNote)]),
      el('div', {}, [el('div', { class: 'spend__v' }, s.last7), el('div', { class: 't-meta' }, 'last 7 days')]),
    ]),
    bar,
  ]);
}

// ---------------- top-level render ----------------

function render() {
  const page = $('#v2-page');
  if (!page) return;
  if (!mounted) return;

  document.querySelector('main.shell')?.classList.toggle('is-stale', !!getAuthState());
  clear(page);
  const root = page.appendChild(el('div', { class: 'ov' }));

  if (!data) {
    root.appendChild(el('div', { class: 'status' }, el('div', { class: 'status__t t-meta' }, 'Loading…')));
    return;
  }

  const needs = needsModel(inbox);
  root.appendChild(statusBlock(statusLight({ data, needs: needs.count })));
  const fault = daemonFault(data);
  if (fault) root.appendChild(faultBanner(fault));

  root.appendChild(heroCard(needs));
  const head = headroomModel(data.headroom);
  root.appendChild(el('div', { class: 'facts3' }, [
    factCard('Headroom left', head, [head.v, el('small', {}, ' week')]),
    factCard('Running now', runningModel(data.running, data.pause)),
    spendCard(spendModel(data.spend)),
  ]));
}

export default function overview(params) {
  void params; // no deep-link query params defined for this route
  mounted = true;
  const page = $('#v2-page');
  if (!page) return;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  render();
  // One visit per load; a failed stamp only costs the since-visit number.
  api('POST', '/api/v2/visits').catch(() => {}).finally(loadAndRender);
  pollTimer = setInterval(loadAndRender, POLL_MS);
  pollTimer.unref?.();
}

onRender((route) => {
  mounted = route === 'overview';
  if (route !== 'overview' && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
});
// Dim the page the instant the daemon drops/recovers, not on the next poll.
onAuthState(() => { if ($('#v2-page') && data) render(); });
