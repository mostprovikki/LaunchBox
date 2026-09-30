// The Inbox (claude-scheduler-btv.19). Route: `#inbox`, in the appbar nav.
// docs/design/launchbox.md §5: Workbench, triage split — list on the left,
// grouped waiting to merge / handed back; detail on the right for the selected
// item. Actions appear ONLY for the selected item, never per row at rest.
// Chosen layout: docs/design/mockups/inbox-flavours.html, Option 2.
//
// Actions: a branch → Review (the per-project review route, which owns the
// Touch ID merge). A hand-back → Log (primary) + Hold (defers the bead 7 days;
// POST .../beads/:beadId/hold). No Re-queue: §9, a handed-back bead is already
// back in `bd ready`.
//
// Bead text comes out of other people's repositories, so every node is built
// with el(); no markup-from-string.
import { api, failureToast } from '../api.js';
import { $, el, clear, pageHead, asOfEl, toast } from '../ui.js';
import { setInboxCount } from '../chrome.js';
import { openLogDrawer } from './runs-log.js';
import { inboxGroups, primaryAction, canHold, moveSelection } from './inbox-logic.js';

const INBOX_PATH = '/api/v2/inbox';
const holdPath = (projectId, beadId) => `/api/v2/projects/${encodeURIComponent(projectId)}/beads/${encodeURIComponent(beadId)}/hold`;

export default async function inbox() {
  const page = $('#v2-page');
  if (!page) return;
  clear(page);

  const sub = el('span', {}, 'Everything waiting on you, across all projects');
  page.appendChild(pageHead({ title: 'Inbox', sub }));
  const body = el('div', { id: 'ibx-body' });
  page.appendChild(body);

  let items = [];
  let selected = -1;
  let list = null;
  let detail = null;

  function options() { return list ? [...list.querySelectorAll('[role=option]')] : []; }

  function select(i, { focus = false } = {}) {
    selected = i;
    options().forEach((o, n) => o.setAttribute('aria-selected', String(n === i)));
    if (focus) options()[i]?.focus();
    renderDetail();
  }

  async function openLog(item, triggerEl) {
    // runs-log.js wants a full /api/runs row. A hand-back older than the recent
    // list still gets its log: the drawer fetches the text by id itself.
    let run = null;
    try {
      run = (await api('GET', '/api/runs?limit=100'))?.runs?.find((r) => r.id === item.runId) ?? null;
    } catch { /* fall through to the id-only row */ }
    openLogDrawer(run ?? { id: item.runId, status: 'ok', trigger: 'bead' }, {
      jobName: item.title, jobExists: !!run?.jobId, triggerEl,
    });
  }

  async function hold(item, btn) {
    if (!canHold(item)) return;
    if (btn) btn.disabled = true;
    try {
      const r = await api('POST', holdPath(item.projectId, item.beadId));
      toast(`Held ${item.facts[1][1]} until ${new Date(r?.until ?? Date.now()).toLocaleDateString()}`, 'ok');
      await load(item.key);
    } catch (err) {
      const msg = failureToast(err);
      if (msg) toast(msg, 'err');
      if (btn) btn.disabled = false;
    }
  }

  function runPrimary(item, triggerEl) {
    const p = primaryAction(item);
    if (p.href) location.hash = p.href;
    else openLog(item, triggerEl);
  }

  function renderDetail() {
    if (!detail) return;
    clear(detail);
    const item = items[selected];
    if (!item) return;
    const p = primaryAction(item);
    const primary = p.href
      ? el('a', { class: 'btn btn--primary', href: p.href }, p.label)
      : el('button', { type: 'button', class: 'btn btn--primary' }, p.label);
    if (!p.href) primary.addEventListener('click', () => openLog(item, primary));
    const acts = [primary];
    if (canHold(item)) {
      const holdBtn = el('button', {
        type: 'button', class: 'btn btn--ghost', 'data-mutating': true,
        'data-tip': 'Defer this bead 7 days so the scheduler stops retrying it',
      }, 'Hold');
      holdBtn.addEventListener('click', () => hold(item, holdBtn));
      acts.push(holdBtn);
    }
    detail.append(
      el('div', { class: 'card__head' }, el('h2', {}, item.title)),
      el('div', { class: 'card__body' }, [
        el('div', { class: 'deflist' }, item.facts.map(([n, v]) => el('div', { class: 'defrow' }, [
          el('span', { class: 'defrow__n t-meta' }, n), ' ', el('span', { class: 'defrow__v' }, v),
        ]))),
        item.reason
          ? el('p', { class: 'snippet ibx-reason' }, `“${item.reason}”`)
          : el('p', { class: 't-meta ibx-reason' }, 'No closing message was recorded for this run.'),
        el('div', { class: 'actionbar' }, acts),
        el('div', { class: 'ibx-keys t-meta' },
          canHold(item) ? 'Keys: ↑↓ move · Enter log · L log · H hold' : 'Keys: ↑↓ move · Enter review'),
      ]),
    );
  }

  function onKey(ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const item = items[selected];
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      select(moveSelection(selected, ev.key === 'ArrowDown' ? 1 : -1, items.length), { focus: true });
    } else if (ev.key === 'Enter' && item) {
      ev.preventDefault();
      runPrimary(item, options()[selected]);
    } else if ((ev.key === 'l' || ev.key === 'L') && item && !primaryAction(item).href) {
      ev.preventDefault();
      openLog(item, options()[selected]);
    } else if ((ev.key === 'h' || ev.key === 'H') && item && canHold(item)) {
      ev.preventDefault();
      hold(item, null);
    }
  }

  function renderList(data) {
    clear(body);
    list = null;
    detail = null;
    sub.replaceChildren('Everything waiting on you, across all projects · ', asOfEl(new Date(data.asOf ?? Date.now())));

    // A project git could not read is named, so a short count is never silent.
    for (const e of data.errors ?? []) {
      body.appendChild(el('p', { class: 't-meta' },
        `Could not read branches in ${e.projectName ?? e.projectId}: ${e.error}. Its waiting branches are not counted.`));
    }

    const groups = inboxGroups(data);
    items = groups.flatMap((g) => g.items);
    if (!items.length) {
      body.appendChild(el('section', { class: 'card' }, el('div', { class: 'card__body' }, [
        el('h2', {}, 'Nothing needs you'),
        el('p', { class: 't-meta', style: 'margin:6px 0 0;' },
          'No scheduler branch is waiting to merge and no bead has been handed back. '
          + 'Finished runs land here for review before main moves.'),
      ])));
      return;
    }

    list = el('section', { class: 'card ibx-list', role: 'listbox', 'aria-label': 'Waiting on you' });
    let n = 0;
    for (const g of groups) {
      const heading = `${g.label} · ${g.items.length}`;
      list.appendChild(el('div', { role: 'group', 'aria-label': heading }, [
        el('div', { class: 'ibx-group t-eyebrow' }, heading),
        g.items.map((item) => {
          const i = n++;
          return el('button', {
            type: 'button', class: 'ibx-item', role: 'option', 'aria-selected': 'false',
            'data-key': item.key, onclick: () => select(i),
          }, [
            el('span', { class: `state state--${item.pill.cls}` }, [el('span', { class: 'state__dot' }), item.pill.label]),
            el('div', {}, el('b', {}, item.title)),
            el('div', { class: 't-meta' }, item.meta),
          ]);
        }),
      ]));
    }
    list.addEventListener('keydown', onKey);
    detail = el('section', { class: 'card ibx-detail', 'aria-live': 'polite' });
    body.appendChild(el('div', { class: 'ibx-split' }, [list, detail]));
  }

  async function load(prevKey = null) {
    let data;
    try {
      data = await api('GET', INBOX_PATH);
    } catch (err) {
      // "Could not read" must never render as "Nothing needs you".
      clear(body);
      list = null;
      detail = null;
      items = [];
      body.appendChild(el('section', { class: 'card' }, el('div', { class: 'card__body' }, [
        el('h2', {}, 'Could not load the Inbox'),
        el('p', { class: 't-meta', style: 'margin:6px 0 0;' },
          `${failureToast(err) ?? err?.message ?? 'The daemon refused the request'}. `
          + 'Nothing was changed. Reopen this page to try again.'),
      ])));
      return;
    }
    setInboxCount(data?.count ?? 0);
    const before = selected;
    renderList(data ?? {});
    if (!items.length) return;
    const same = items.findIndex((it) => it.key === prevKey);
    select(same >= 0 ? same : moveSelection(Math.max(before, 0), 0, items.length));
  }

  await load();
}
