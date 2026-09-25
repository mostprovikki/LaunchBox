// The review queue (Task 8 of .superpowers/sdd/2026-09-24-scheduler-skills).
// Route: `#review?id=<projectId>`, reached from the project detail page.
//
// What it is for: a scheduled run never touches main. It leaves its work on a
// `scheduler/<repo>--<beadId>` branch, and this page is where a human decides
// what main absorbs. Two actions, both Touch ID-gated SERVER-side (the buttons
// here are a convenience, not the gate): merge (fast-forward only) and discard.
//
// WHY A MERGE CAN BE REFUSED BEFORE THE SERVER EVER SEES IT. Three facts make a
// branch mergeable, and all three must hold:
//   * the evidence note says `run: gates passed` — Task 4's skill writes that
//     first line, and anything else (failed, no gates, prose, no note at all)
//     means nobody has evidence the work is sound;
//   * the tip is not Task 6's `wip(<bead>): uncommitted work at run end`
//     snapshot — that commit is leftovers swept up when a run was cut short,
//     never a finished change;
//   * the branch is not behind main, because the server only fast-forwards.
// The disabled button carries the reason in `data-tip`; the row carries it in
// prose too, so the answer to "why can't I merge this" is on screen either way.
//
// WHY THE DISABLED MERGE IS NOT `data-mutating`. main.js sweeps the whole body
// after every render and calls setDisabledReason(elm, null) on each
// `data-mutating` control when the daemon is healthy — which sets
// `disabled = false`. A permanently-refused Merge marked that way would be
// handed back to the reader milliseconds after this page disabled it. So the
// attribute goes on only the controls that really are live, and
// tests/frontend-v2-review.test.js runs the real sweep to keep it that way.
//
// No markup-from-string anywhere: branch names, bead titles and evidence notes
// all come out of other people's repositories, and every node here is built
// with el() from ../ui.js, whose children go through createTextNode.
import { api, failureToast } from '../api.js';
import { $, el, clear, pageHead, toast } from '../ui.js';

// Written out in full rather than composed from `branchesPath(id)` — the parity
// gate (tools/qa/v2-parity.mjs) reads each UI's surface out of its source by
// matching string literals that START with /api/, so a path built by
// concatenating a helper's return value is a call it cannot see. An endpoint
// invisible to the parity gate is an undeclared difference nobody is told about.
const branchesPath = (id) => `/api/v2/projects/${encodeURIComponent(id)}/branches`;
const mergePath = (id, name) => `/api/v2/projects/${encodeURIComponent(id)}/branches/${encodeURIComponent(name)}/merge`;
const branchPath = (id, name) => `/api/v2/projects/${encodeURIComponent(id)}/branches/${encodeURIComponent(name)}`;
// The prefix is the server's to add, and only the server's — see the
// containment note above the routes in server.js.
const shortName = (branch) => branch.replace(/^scheduler\//, '');

// claude-scheduler-7j2's rule: a link that arrives without what it needs
// explains itself and offers a way on. It never renders an empty shell.
function missingIdPage(page) {
  page.appendChild(pageHead({ title: 'Review queue' }));
  page.appendChild(el('section', { class: 'card' }, [
    el('div', { class: 'card__head' }, el('h2', {}, 'No project id in the link')),
    el('div', { class: 'card__body' }, [
      el('p', { class: 't-meta', style: 'margin:0 0 8px;' },
        'This page lists one registered project’s finished scheduler branches, so it needs to be told '
        + 'which project. The link that brought you here carried no id.'),
      el('p', { class: 't-meta', style: 'margin:0 0 10px;' },
        'Pick a project from Projects and use its "Review queue" action — that link carries the id.'),
      el('a', { class: 'btn', href: '#projects' }, 'Back to Projects'),
    ]),
  ]));
}

export default async function review(params) {
  const page = $('#v2-page');
  if (!page) return;
  clear(page);

  const id = params?.get('id') ?? null;
  if (!id) { missingIdPage(page); return; }

  page.appendChild(pageHead({
    title: 'Review queue',
    sub: el('span', {}, [
      'Scheduler branches in ',
      el('span', { class: 'mono' }, id),
      ' that main has not absorbed. Merging is fast-forward only, and both actions ask for Touch ID.',
    ]),
    actions: [el('a', {
      class: 'btn btn--ghost',
      href: `#project?id=${encodeURIComponent(id)}`,
    }, '← Project')],
  }));

  const host = el('div', { class: 'list', id: 'review-list' });
  page.appendChild(host);

  function why(r) {
    if (r.snapshotTip) return 'The tip is an unreviewed snapshot (wip) of work a run left behind — inspect it before merging';
    if (r.note?.gates !== 'passed') {
      return r.note?.gates
        ? `The run’s evidence note says gates ${r.note.gates === 'none' ? 'did not run' : r.note.gates} — inspect it before merging`
        : 'Evidence note says nothing about gates — inspect before merging';
    }
    if (r.behind > 0) return `${r.behind} commit(s) behind main, so this is not a fast-forward — rebase it first`;
    return 'Fast-forward main to this branch';
  }

  function row(r) {
    const name = shortName(r.branch);
    const mergeable = r.note?.gates === 'passed' && !r.snapshotTip && r.behind === 0;
    const reason = why(r);

    const merge = el('button', {
      class: 'btn',
      'data-tip': reason,
      // Only a live control is swept — see the header note.
      ...(mergeable ? { 'data-mutating': true } : { disabled: true }),
    }, 'Merge');
    if (mergeable) {
      merge.addEventListener('click', () => act(
        'POST', mergePath(id, name), {}, `Merged ${r.beadId ?? name} into main`,
      ));
    }

    const discard = el('button', {
      class: 'btn btn--ghost',
      'data-mutating': true,
      'data-tip': 'Delete this branch and any commits main does not already have',
    }, 'Discard');
    discard.addEventListener('click', () => act(
      'DELETE', branchPath(id, name), { force: true }, `Discarded ${name}`,
    ));

    return el('div', { class: 'row reviewrow', 'data-branch': r.branch }, [
      el('div', { class: 'reviewrow__main' }, [
        el('div', {}, [
          el('b', {}, r.title ?? r.beadId ?? name),
          el('span', { class: 't-meta mono', style: 'margin-left:8px;' }, r.branch),
        ]),
        el('div', { class: 't-meta' },
          `${r.shortstat || 'no diff against main'} · ${r.ahead} ahead / ${r.behind} behind · ${r.tipSha}`),
        el('div', { class: 't-meta' }, r.snapshotTip
          ? `unreviewed leftovers: ${r.tipSubject}`
          : (r.note?.first ?? r.tipSubject)),
        mergeable ? null : el('div', { class: 't-meta' }, reason),
      ]),
      el('div', { class: 'reviewrow__actions' }, [merge, discard]),
    ]);
  }

  async function load() {
    clear(host);
    let rows;
    try {
      rows = (await api('GET', branchesPath(id)))?.branches ?? [];
    } catch (err) {
      // "Could not read" must never render as "nothing to do": an empty queue
      // and an unreachable daemon are opposite claims about the same screen.
      host.appendChild(el('p', { class: 't-meta' },
        `Could not list branches: ${err?.message ?? 'the daemon refused the request'}. `
        + 'Nothing has been merged or deleted. Reopen this page to try again.'));
      return;
    }
    if (!rows.length) {
      host.appendChild(el('p', { class: 't-meta' },
        'Nothing waiting. Every scheduler branch in this project is already in main, and any run '
        + 'that finishes from now on will appear here for review before main moves.'));
      return;
    }
    for (const r of rows) host.appendChild(row(r));
  }

  async function act(method, path, body, okText) {
    try {
      await api(method, path, body);
      toast(okText, 'ok');
      await load();
    } catch (err) {
      // failureToast() decodes the approval codes (denied / timed out / helper
      // unavailable) into the copy the rest of /v2 uses, and returns null for
      // the two states that already own a persistent banner.
      const msg = failureToast(err);
      if (msg) toast(msg, 'err');
    }
  }

  await load();
}
