// Burn-down planner and burst planner dialogs (claude-scheduler-btv.12 / D2).
// Mockups: dialog-plan-burndown.html, dialog-burst.html.
//
// Endpoints:
//   POST /api/budget/plan          — burn-down preview (writes nothing)
//   POST /api/budget/plan/apply    — confirm; gated (Touch ID)
//   POST /api/bursts/plan          — burst preview (writes nothing)
//   POST /api/bursts               — confirm
//   GET  /api/projects             — which projects are activated
//   GET  /api/jobs                 — names for the preview table
//   GET  /api/v2/plan-candidates   — ADDITIVE (this bead): per-job learned cost,
//                                    sample count, and the guard's decoded
//                                    reason, so the reader can choose who may
//                                    spend before asking for a plan
//
// THE RULE BOTH DIALOGS OBEY: the server computes the plan. lib/budget.js owns
// the reserve cap, the never-past-the-reset horizon, the lead time and the
// spacing, and lib/burst.js defers to it so a burst can never lay out slots the
// guard would refuse. Nothing here does that arithmetic — these dialogs collect
// inputs, render what came back, and send the server's own slots back verbatim
// on confirm. A preview left open goes stale, and both confirm routes re-check
// it and reject wholesale rather than part-applying.
//
// The pure half is public/v2/pages/plan-logic.js, whose header records the five
// mockup claims this bead refused.
import { api, guardedSubmit, degradedReason, failureToast } from '../api.js';
import { $$, el, clear, toast, iconBtn, disableMutatingControls } from '../ui.js';
import {
  fmtClock, pct, windowLabel, burnDownRows, confidenceText, burnDownConsequence,
  splitCandidates, costText, BURST_PRESETS, burstFacts, burstConsequence, splitProjects,
} from './plan-logic.js';

const SVG_X = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const SVG_WARN = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>';
const SVG_INFO = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 12v4"/></svg>';

function svgNode(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

// A modal shell both planners share. Returns the pieces each fills in.
function shell({ title, label }) {
  const body = el('div', { class: 'modal__body' });
  const consequence = el('span', { class: 'modal__consequence' });
  const cancelBtn = el('button', { class: 'btn', type: 'button', style: 'margin-left:auto;' }, 'Cancel');
  const confirmBtn = el('button', { class: 'btn btn--primary', type: 'button', style: 'margin-left:0;', 'data-mutating': true }, 'Confirm');
  const foot = el('div', { class: 'modal__foot' }, [consequence, cancelBtn, confirmBtn]);
  const closeBtn = iconBtn({ label: 'Close without changing anything', tag: 'button', svgHtml: SVG_X, style: 'margin-left:auto;' });
  closeBtn.type = 'button';
  const modal = el('div', { class: 'modal modal--wide', role: 'dialog', 'aria-modal': 'true', 'aria-label': label }, [
    el('div', { class: 'modal__head' }, [el('h2', {}, title), closeBtn]),
    body, foot,
  ]);
  const backdrop = el('div', { class: 'modalwrap', role: 'presentation' }, modal);
  document.body.appendChild(backdrop);

  let busy = false;
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  // While a gated confirm is in flight the request is already with the server;
  // closing would not cancel it. Same rule as the job dialog.
  const onKey = (ev) => { if (ev.key === 'Escape' && !busy) close(); };
  document.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click', () => { if (!busy) close(); });
  cancelBtn.addEventListener('click', () => { if (!busy) close(); });
  backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop && !busy) close(); });

  // Opening a modal MUST move focus into it. Without this a keyboard user is
  // left on whatever opened the dialog, behind an aria-modal overlay they
  // cannot tab into — found by E2's dialog gate (claude-scheduler-btv.14),
  // which measured focus still on BODY for both planners. The job dialog
  // already did this by focusing its first field.
  //
  // The close button is the target rather than the first input: these dialogs
  // build their body asynchronously (the candidate list, the project list), so
  // at this point there is no field to focus yet — and the way OUT is the one
  // control that is certainly present.
  closeBtn.focus();

  return {
    backdrop, body, foot, consequence, confirmBtn, cancelBtn, close,
    setBusy(v) { busy = v; },
  };
}

function bannerEl({ tone, title, body }) {
  const cls = tone === 'ok' || tone === 'info' ? 'banner banner--info' : tone === 'bad' ? 'banner banner--bad' : 'banner';
  return el('div', { class: cls }, [
    svgNode(tone === 'ok' || tone === 'info' ? SVG_INFO : SVG_WARN),
    el('span', {}, [el('b', {}, title), ' ', body]),
  ]);
}

function defrow({ name, detail, value, checked, disabled, onToggle, tip }) {
  const box = el('input', { type: 'checkbox', class: 'check', checked: !!checked });
  box.disabled = !!disabled;
  if (onToggle) box.addEventListener('change', () => onToggle(box.checked));
  return el('div', { class: 'defrow', 'data-tip': tip ?? null }, [
    el('div', {}, [
      el('span', { class: 'defrow__n' }, el('label', { class: 'frow', style: 'gap:8px;' }, [box, name])),
      detail ? el('span', { class: 'defrow__d' }, detail) : null,
    ]),
    el('span', { class: 'defrow__v' }, value ?? ''),
  ]);
}

// ============================================================== burn-down

export function openBurnDownDialog({ onApplied } = {}) {
  const ui = shell({ title: 'Plan a burn-down', label: 'Plan a burn-down' });
  const state = {
    window: 'five_hour', targetPct: 70, deadline: '', minGapMin: 10, maxConcurrent: 1,
    candidates: null, chosen: new Set(), jobsById: new Map(),
    plan: null, planError: null, loading: true,
  };

  const usagePct = () => (Number.isFinite(state.candidates?.usage?.percent) ? state.candidates.usage.percent : null);

  async function loadCandidates() {
    try {
      state.candidates = await api('GET', `/api/v2/plan-candidates?window=${encodeURIComponent(state.window)}`);
      for (const j of state.candidates.jobs ?? []) state.jobsById.set(j.id, j);
      // Nothing is pre-selected: choosing who may spend is the point of the
      // screen, and a default selection would have the reader confirming a
      // plan they did not compose.
    } catch (err) {
      state.planError = failureToast(err) ?? 'could not read the plannable jobs';
    }
    state.loading = false;
    render();
    replan();
  }

  let planSeq = 0;
  let planTimer = null;
  function replan() {
    clearTimeout(planTimer);
    planTimer = setTimeout(async () => {
      const mine = ++planSeq;
      if (!state.chosen.size) {
        state.plan = null;
        state.planError = null;
        if (mine === planSeq) render();
        return;
      }
      try {
        const out = await api('POST', '/api/budget/plan', {
          window: state.window,
          targetPct: Number(state.targetPct),
          deadline: state.deadline ? deadlineIso(state.deadline) : null,
          jobIds: [...state.chosen],
          minGapMin: Number(state.minGapMin),
          maxConcurrent: Number(state.maxConcurrent),
        });
        if (mine !== planSeq) return;
        state.plan = out.ok ? out : null;
        // A 200-with-ok:false and a 400 both carry `reason` — lib/budget.js's
        // own sentence for why no plan is possible, shown verbatim.
        state.planError = out.ok ? null : out.reason;
      } catch (err) {
        if (mine !== planSeq) return;
        state.plan = null;
        state.planError = err?.data?.reason ?? failureToast(err) ?? 'could not build a plan';
      }
      render();
    }, 300);
  }

  // A time-only "finish by" means today unless that is already past, in which
  // case it means tomorrow — the server then clamps it to the window reset
  // anyway, so this never has to reason about the boundary itself.
  function deadlineIso(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    const d = new Date();
    d.setHours(h || 0, m || 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }

  function inputsFieldset() {
    const grid = el('div', { class: 'fgrid' });

    const winSegs = el('div', { class: 'segs', style: 'max-width:280px;' });
    for (const [key, label] of [['five_hour', '5-hour'], ['seven_day', 'Week']]) {
      const seg = el('button', { class: 'seg', type: 'button', 'aria-selected': state.window === key ? 'true' : null }, label);
      seg.addEventListener('click', () => {
        state.window = key;
        state.loading = true;
        render();
        loadCandidates();
      });
      winSegs.appendChild(seg);
    }
    grid.append(el('span', { class: 'flabel' }, 'Window'), winSegs);

    const target = el('input', { type: 'number', class: 'field', value: state.targetPct, min: 1, max: 100, style: 'max-width:80px;', id: 'bd-target' });
    target.addEventListener('input', () => { state.targetPct = target.value; renderFoot(); replan(); });
    const at = usagePct();
    grid.append(
      el('span', { class: 'flabel' }, el('label', { for: 'bd-target' }, 'Spend up to')),
      el('div', { class: 'frow' }, [
        target,
        el('span', { class: 't-meta' }, at != null
          // Only stated when a reading exists: "currently at 0%" would be a
          // measurement nobody took.
          ? `% of the ${windowLabel(state.window)} window — currently at ${at.toFixed(0)}%, so about ${Math.max(0, Math.min(Number(state.targetPct) || 0, 100 - at)).toFixed(0)}% to spend`
          : `% of the ${windowLabel(state.window)} window — the current reading is unavailable, so the server will say whether a plan is possible`),
      ]),
    );

    const resets = state.candidates?.usage?.resetsAt;
    const by = el('input', { type: 'time', class: 'field', value: state.deadline, style: 'max-width:110px;', id: 'bd-by' });
    by.addEventListener('input', () => { state.deadline = by.value; replan(); });
    grid.append(
      el('span', { class: 'flabel' }, el('label', { for: 'bd-by' }, 'Finish by')),
      el('div', { class: 'frow' }, [
        by,
        el('span', { class: 't-meta' }, resets
          ? `optional — the window resets at ${fmtClock(resets)}, and the plan never runs past that anyway`
          : 'optional — the plan never runs past the window reset'),
      ]),
    );

    const gap = el('input', { type: 'number', class: 'field', value: state.minGapMin, min: 1, style: 'max-width:80px;', id: 'bd-gap' });
    gap.addEventListener('input', () => { state.minGapMin = gap.value; replan(); });
    grid.append(el('span', { class: 'flabel' }, el('label', { for: 'bd-gap' }, 'Minimum gap')),
      el('div', { class: 'frow' }, [gap, el('span', { class: 't-meta' }, 'minutes between fires')]));

    const conc = el('input', { type: 'number', class: 'field', value: state.maxConcurrent, min: 1, max: 10, style: 'max-width:80px;', id: 'bd-conc' });
    conc.addEventListener('input', () => { state.maxConcurrent = conc.value; replan(); });
    grid.append(el('span', { class: 'flabel' }, el('label', { for: 'bd-conc' }, 'Concurrency')),
      el('div', { class: 'frow' }, [conc, el('span', { class: 't-meta' }, 'runs at a time')]));

    return el('fieldset', { class: 'fset' }, grid);
  }

  function jobsFieldset() {
    const { eligible, excluded } = splitCandidates(state.candidates?.jobs ?? []);
    const card = el('div', { class: 'subcard' });
    for (const j of eligible) {
      const details = [costText(j, { assumedCostPct: state.candidates?.assumedCostPct ?? 1 })];
      if (!j.enabled) details.push('currently disabled — confirming a plan turns it back on');
      if (j.warning) details.push(j.warning);
      card.appendChild(defrow({
        name: j.name,
        detail: details.join(' · '),
        value: `~${pct(j.costPct)}/run`,
        checked: state.chosen.has(j.id),
        onToggle: (on) => {
          if (on) state.chosen.add(j.id); else state.chosen.delete(j.id);
          renderFoot();
          replan();
        },
      }));
    }
    for (const j of excluded) {
      card.appendChild(defrow({ name: j.name, detail: j.reason, value: 'excluded', checked: false, disabled: true }));
    }
    if (!eligible.length && !excluded.length) {
      card.appendChild(el('div', { class: 'card__body' }, el('p', { class: 't-meta', style: 'margin:0;' },
        state.loading ? 'Reading which jobs can spend…' : 'There are no jobs to plan with yet.')));
    }
    return el('fieldset', { class: 'fset' }, [
      // NOT "Claude jobs only" — the server's rule is that ANY job may be
      // planned except a bead-backed one, and that exclusion is a safety rule
      // rather than a type filter.
      el('legend', { class: 'fset__t' }, 'Jobs allowed to spend'),
      card,
    ]);
  }

  function previewFieldset() {
    const parts = [];
    if (state.planError) {
      parts.push(bannerEl({ tone: 'warn', title: 'No plan is possible right now.', body: state.planError }));
    } else if (!state.chosen.size) {
      parts.push(el('p', { class: 't-meta', style: 'margin:0;' }, 'Pick at least one job above and a plan appears here.'));
    } else if (!state.plan) {
      parts.push(el('p', { class: 't-meta', style: 'margin:0;' }, 'Planning…'));
    } else {
      const chosen = [...state.chosen].map((id) => ({ ...state.jobsById.get(id), chosen: true }));
      parts.push(el('div', { style: 'margin-bottom:12px;' }, bannerEl(confidenceText(state.plan, { candidates: chosen }))));

      const rows = burnDownRows(state.plan, { jobsById: state.jobsById, startPct: usagePct() });
      const table = el('table', { class: 'dtable' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'Fire at'), el('th', {}, 'Job'), el('th', {}, 'Est. cost'),
          el('th', {}, usagePct() != null ? 'Projected total' : 'Projected total (no reading)'),
        ])),
        el('tbody', {}, rows.map((r) => el('tr', {}, [
          el('td', { class: 'mono' }, fmtClock(r.at) ?? ''),
          el('td', {}, r.jobName),
          el('td', { class: 'mono' }, pct(r.estPct)),
          // Blank rather than anchored to a zero nobody measured.
          el('td', { class: 'mono' }, r.projectedPct == null ? '—' : pct(r.projectedPct)),
        ]))),
      ]);
      parts.push(el('div', { class: 'subcard' }, el('div', { class: 'dtable__scroll' }, table)));

      if (state.plan.assumptions?.length) {
        parts.push(el('details', { style: 'margin-top:10px;' }, [
          el('summary', { class: 't-meta' }, 'What this plan assumed'),
          el('ul', { class: 'errlist' }, state.plan.assumptions.map((a) => el('li', {}, a))),
        ]));
      }
    }
    return el('fieldset', { class: 'fset' }, [el('legend', { class: 'fset__t' }, 'Preview'), ...parts]);
  }

  function renderFoot() {
    ui.consequence.textContent = state.plan
      ? burnDownConsequence(state.plan, { window: state.window })
      : state.chosen.size ? 'Planning…' : 'Pick the jobs allowed to spend.';
    clear(ui.confirmBtn);
    ui.confirmBtn.append(state.plan ? `Create ${state.plan.slots.length} fire${state.plan.slots.length === 1 ? '' : 's'}` : 'Create fires');
    // COMPOUND disable, and it must be applied after the degraded-state sweep,
    // not before: setDisabledReason(el, null) sets `disabled = false`
    // unconditionally, so a sweep running afterwards re-enables a button whose
    // real reason for being dead is "there is no plan yet". Same trap B3 hit
    // with the Cleanup button — the fix there was a compound disable too.
    ui.confirmBtn.disabled = !state.plan || !!degradedReason();
  }

  function render() {
    clear(ui.body);
    ui.body.append(
      el('p', { class: 't-meta', style: 'margin: 0 0 14px;' },
        'Spend spare capacity on purpose: pick a window, a target, and the jobs allowed to do the spending. '
        + 'LaunchBox schedules one-shot fires and shows you the plan before anything is created.'),
      inputsFieldset(), jobsFieldset(), previewFieldset(),
    );
    disableMutatingControls(ui.backdrop, degradedReason());
    renderFoot();
  }

  ui.confirmBtn.addEventListener('click', async () => {
    if (!state.plan) return;
    ui.setBusy(true);
    for (const n of $$('input, select, button', ui.backdrop)) if (n !== ui.confirmBtn) n.disabled = true;
    // The server's own slots, sent back verbatim. Re-checked there rather than
    // trusted: a preview left open goes stale, and an expired timetable is
    // rejected WHOLESALE rather than part-applied.
    const ok = await guardedSubmit(ui.confirmBtn, () => api('POST', '/api/budget/plan/apply', {
      slots: state.plan.slots.map((s) => ({ at: s.at, jobId: s.jobId })),
    }), (msg) => toast(msg, 'err', 8000));
    ui.setBusy(false);
    if (ok) {
      toast(`Scheduled ${state.plan.slots.length} extra fire${state.plan.slots.length === 1 ? '' : 's'}`, 'ok');
      ui.close();
      onApplied?.();
      return;
    }
    render();
  });

  render();
  loadCandidates();
  return ui;
}

// ================================================================== burst

export function openBurstDialog({ onStarted } = {}) {
  const ui = shell({ title: 'Start a burst', label: 'Start a burst' });
  const state = {
    window: 'five_hour', budgetPct: 10, preset: '10-5h',
    minGapMin: '', maxRuns: '',
    projects: null, chosen: new Set(),
    plan: null, planError: null, active: null, loading: true, usagePct: null,
  };

  async function loadProjects() {
    try {
      const data = await api('GET', '/api/projects');
      state.projects = data.projects ?? [];
      // Every activated project starts selected: unlike the burn-down planner
      // (where choosing who may spend IS the decision), a burst's scope is
      // "the projects you already activated", and the airlock already made
      // that choice a deliberate one.
      for (const p of splitProjects(state.projects).eligible) state.chosen.add(p.id);
    } catch (err) {
      state.planError = failureToast(err) ?? 'could not read your projects';
    }
    try {
      const { active } = await api('GET', '/api/bursts');
      state.active = active ?? null;
    } catch { /* bursts unavailable in this process */ }
    try {
      const c = await api('GET', `/api/v2/plan-candidates?window=${encodeURIComponent(state.window)}`);
      state.usagePct = Number.isFinite(c?.usage?.percent) ? c.usage.percent : null;
    } catch { /* the stop-at figure is simply not stated */ }
    state.loading = false;
    render();
    replan();
  }

  let seq = 0;
  let timer = null;
  function replan() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++seq;
      if (!state.chosen.size) {
        state.plan = null; state.planError = null;
        if (mine === seq) render();
        return;
      }
      try {
        const out = await api('POST', '/api/bursts/plan', {
          window: state.window,
          budgetPct: Number(state.budgetPct),
          projectIds: [...state.chosen],
          maxRuns: state.maxRuns === '' ? null : Number(state.maxRuns),
          minGapMin: state.minGapMin === '' ? null : Number(state.minGapMin),
        });
        if (mine !== seq) return;
        state.plan = out.ok ? out : null;
        state.planError = out.ok ? null : out.reason;
      } catch (err) {
        if (mine !== seq) return;
        state.plan = null;
        state.planError = err?.data?.reason ?? failureToast(err) ?? 'could not build a burst plan';
      }
      render();
    }, 300);
  }

  function budgetFieldset() {
    const segs = el('div', { class: 'segs', style: 'max-width: 520px;' });
    for (const p of BURST_PRESETS) {
      const seg = el('button', { class: 'seg', type: 'button', 'aria-selected': state.preset === p.id ? 'true' : null }, p.label);
      seg.addEventListener('click', () => {
        state.preset = p.id; state.window = p.window; state.budgetPct = p.budgetPct;
        render(); replan();
      });
      segs.appendChild(seg);
    }
    const custom = el('button', { class: 'seg', type: 'button', 'aria-selected': state.preset === 'custom' ? 'true' : null }, 'Custom…');
    custom.addEventListener('click', () => { state.preset = 'custom'; render(); replan(); });
    segs.appendChild(custom);

    const grid = el('div', { class: 'fgrid', style: 'margin-top: 12px;' });
    if (state.preset === 'custom') {
      const pctIn = el('input', { type: 'number', class: 'field', value: state.budgetPct, min: 1, max: 100, style: 'max-width:80px;', id: 'bu-pct' });
      pctIn.addEventListener('input', () => { state.budgetPct = pctIn.value; replan(); });
      const winSel = el('select', { style: 'max-width:150px;', 'aria-label': 'Budget window' }, [
        el('option', { value: 'five_hour', selected: state.window === 'five_hour' }, '5-hour window'),
        el('option', { value: 'seven_day', selected: state.window === 'seven_day' }, 'Week'),
      ]);
      winSel.addEventListener('change', () => { state.window = winSel.value; replan(); });
      grid.append(el('span', { class: 'flabel' }, el('label', { for: 'bu-pct' }, 'Spend')),
        el('div', { class: 'frow' }, [pctIn, el('span', { class: 't-meta' }, '% of'), winSel]));
    }

    const gap = el('input', { type: 'number', class: 'field', value: state.minGapMin, min: 1, style: 'max-width:80px;', placeholder: 'default', id: 'bu-gap' });
    gap.addEventListener('input', () => { state.minGapMin = gap.value; replan(); });
    grid.append(el('span', { class: 'flabel' }, el('label', { for: 'bu-gap' }, 'Minimum gap')),
      el('div', { class: 'frow' }, [gap, el('span', { class: 't-meta' }, 'minutes between attempts — blank uses the configured default')]));

    const max = el('input', { type: 'number', class: 'field', value: state.maxRuns, min: 1, style: 'max-width:80px;', placeholder: 'none', id: 'bu-max' });
    max.addEventListener('input', () => { state.maxRuns = max.value; replan(); });
    grid.append(el('span', { class: 'flabel' }, el('label', { for: 'bu-max' }, 'Max runs')),
      el('div', { class: 'frow' }, [max, el('span', { class: 't-meta' }, 'hard cap, whatever the spend')]));

    return el('fieldset', { class: 'fset' }, [el('legend', { class: 'fset__t' }, 'Budget'), segs, grid]);
  }

  function projectsFieldset() {
    const { eligible, excluded } = splitProjects(state.projects ?? []);
    const card = el('div', { class: 'subcard' });
    for (const p of eligible) {
      const bits = [];
      bits.push(p.ready?.count == null ? 'ready count unknown' : `${p.ready.count} ready bead${p.ready.count === 1 ? '' : 's'}`);
      if (p.config?.autoLabel) bits.push(`autoLabel ${p.config.autoLabel}`);
      if (p.config?.defaults?.permMode) bits.push(`defaults ${p.config.defaults.permMode}`);
      if (p.config?.budget?.minHeadroomPct != null) bits.push(`min headroom ${p.config.budget.minHeadroomPct}%`);
      if (p.warning) bits.push(p.warning);
      card.appendChild(defrow({
        name: p.name,
        detail: bits.join(' · '),
        value: p.ready?.count == null ? 'ready unknown' : `${p.ready.count} ready`,
        checked: state.chosen.has(p.id),
        onToggle: (on) => { if (on) state.chosen.add(p.id); else state.chosen.delete(p.id); replan(); },
      }));
    }
    for (const p of excluded) {
      card.appendChild(defrow({ name: p.name, detail: p.reason, value: 'excluded', checked: false, disabled: true }));
    }
    if (!eligible.length && !excluded.length) {
      card.appendChild(el('div', { class: 'card__body' }, el('p', { class: 't-meta', style: 'margin:0;' },
        state.loading ? 'Reading your projects…' : 'No project is registered yet.')));
    } else if (!eligible.length) {
      card.appendChild(el('div', { class: 'card__body' }, el('p', { class: 't-meta', style: 'margin:0;' },
        'No activated project — activation is your click, on the Projects tab.')));
    }
    return el('fieldset', { class: 'fset' }, [el('legend', { class: 'fset__t' }, 'Projects — activated only'), card]);
  }

  function previewFieldset() {
    const parts = [];
    if (state.active) {
      parts.push(bannerEl({
        tone: 'warn', title: 'A burst is already running.',
        body: 'Cancel it from the Projects tab before starting another — only one may run at a time.',
      }));
    }
    if (state.planError) {
      parts.push(bannerEl({ tone: 'warn', title: 'No burst is possible right now.', body: state.planError }));
    } else if (state.plan) {
      const facts = burstFacts(state.plan, { startPct: state.usagePct });
      parts.push(el('div', { class: 'facts', style: 'margin-bottom: 12px;' }, facts.map((f) => el('div', { class: `fact${f.cls ? ` ${f.cls}` : ''}` }, [
        el('div', { class: 'fact__k' }, f.k),
        el('div', { class: 'fact__v mono' }, f.v),
        el('div', { class: 'fact__d' }, f.d),
      ]))));
    } else if (state.chosen.size) {
      parts.push(el('p', { class: 't-meta', style: 'margin: 0 0 12px;' }, 'Planning…'));
    }
    // Stated whether or not a plan exists: it is the property that makes a
    // burst safe to leave running, and lib/burst.js genuinely behaves this way
    // (tick() finishes the burst when the reading is unusable).
    parts.push(bannerEl({
      tone: 'info', title: 'Fails closed.',
      body: 'If usage cannot be measured mid-burst, the burst stops rather than guessing — the one place '
        + 'LaunchBox refuses to run blind.',
    }));
    return el('fieldset', { class: 'fset' }, [el('legend', { class: 'fset__t' }, 'Preview'), ...parts]);
  }

  function renderFoot() {
    ui.consequence.textContent = burstConsequence(state.plan, {
      projects: (state.projects ?? []).filter((p) => state.chosen.has(p.id)),
      maxRuns: state.maxRuns === '' ? null : state.maxRuns,
      startPct: state.usagePct,
    });
    clear(ui.confirmBtn);
    ui.confirmBtn.append('Start the burst');
    // Compound, and applied after the sweep — see the burn-down foot's comment.
    ui.confirmBtn.disabled = !state.plan || !!state.active || !!degradedReason();
    if (state.active) ui.confirmBtn.setAttribute('data-tip', 'A burst is already running — cancel it first');
    else ui.confirmBtn.removeAttribute('data-tip');
  }

  function render() {
    clear(ui.body);
    ui.body.append(
      el('p', { class: 't-meta', style: 'margin: 0 0 14px;' }, [
        'A burst spends a fixed slice of your limit on ready beads from activated projects, then stops. ',
        'The estimate below sizes the timetable; the ', el('b', {}, 'measured'), ' live percentage is what actually stops it.',
      ]),
      budgetFieldset(), projectsFieldset(), previewFieldset(),
    );
    disableMutatingControls(ui.backdrop, degradedReason());
    renderFoot();
  }

  ui.confirmBtn.addEventListener('click', async () => {
    if (!state.plan) return;
    ui.setBusy(true);
    for (const n of $$('input, select, button', ui.backdrop)) if (n !== ui.confirmBtn) n.disabled = true;
    let ok = false;
    try {
      // The server's own slots, verbatim. It re-validates them and re-checks
      // the airlock: a project could have been paused between preview and
      // confirm.
      await api('POST', '/api/bursts', {
        window: state.plan.window,
        budgetPct: state.plan.budgetPct,
        projectIds: [...state.chosen],
        slots: state.plan.slots,
        maxRuns: state.maxRuns === '' ? null : Number(state.maxRuns),
        minGapMin: state.minGapMin === '' ? null : Number(state.minGapMin),
      });
      ok = true;
    } catch (err) {
      const list = err?.data?.errors ?? [err?.data?.error].filter(Boolean);
      toast(list.length ? list.join(' · ') : (failureToast(err) ?? 'could not start the burst'), 'err', 8000);
    }
    ui.setBusy(false);
    if (ok) {
      toast('Burst started — it stops on measured spend, or when you cancel it', 'ok', 6000);
      ui.close();
      onStarted?.();
      return;
    }
    render();
  });

  render();
  loadProjects();
  return ui;
}
