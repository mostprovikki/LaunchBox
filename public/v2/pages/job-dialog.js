// New / Edit / Clone job dialog with the full schedule builder
// (claude-scheduler-btv.11 / D1). Replaces B1's deliberately minimal stub.
// Mockups: dialog-new-job.html, dialog-new-job-command.html,
// dialog-validation-errors.html, dialog-approval-waiting.html.
//
// Endpoints reused UNCHANGED, all of them pre-existing:
//   POST/PUT /api/jobs(/:id)   — create and save
//   GET  /api/extensions       — the advanced fields per job type
//   POST /api/schedule/preview — the live "next fires" per row and in the foot
//
// No /api/v2 variant was needed. btv.3 (D1a) investigated whether one was, and
// the answer recorded on this bead is no: POST /api/schedule/preview already
// accepts `{schedules:[…], jobId}` and answers `{next:[ISO…], unknown}` with
// exactly the three states this dialog has to distinguish. Building a v2 twin
// would have been a second schedule parser, which is how "preview said 11:50,
// fired 11:47" bugs are born.
//
// The pure half — presets ↔ cron, rows ↔ entries, the validation that carries
// a FIELD with each message — is public/v2/pages/job-form-logic.js, whose
// header records the three mockup copy bugs this bead fixed.
//
// Only public/v2/pages/jobs.js imports this module.
import { api, guardedSubmit, degradedReason, failureToast } from '../api.js';
import { $$, el, clear, toast, iconBtn, disableMutatingControls } from '../ui.js';
import {
  PRESETS, WEEKDAYS, NOTIFY_OPTIONS, LIMITS, newRow, rowToEntry, jobToForm,
  formToBody, validateForm, firesText, consequenceText,
} from './job-form-logic.js';

const SVG_X = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const SVG_PLUS = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const SVG_WARN = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>';

// How long the platform gives a Touch ID prompt, quoted in the waiting banner.
// lib/approval.js owns the real value; this is the copy the mockup shows and
// it is stated as an approximation rather than read from a constant that is
// not served to the browser.
const APPROVAL_TIMEOUT_TEXT = '180s';

function svgNode(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

// Debounced live preview. One in-flight request per row; a newer edit
// supersedes an older answer, which matters because a cron field is typed
// character by character and the 400s arrive out of order.
function makePreviewer(fetchFn) {
  let seq = 0;
  const timers = new Map();
  return function preview(key, schedules, onResult, { delay = 260 } = {}) {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(async () => {
      const mine = ++seq;
      let result;
      try {
        result = await fetchFn(schedules);
      } catch (err) {
        // A 400 is the schedule being wrong, not the request failing — croner's
        // own sentence is the only accurate description of what it rejected,
        // so it is rendered verbatim (see the header's copy-bug note).
        result = { error: err?.data?.error ?? failureToast(err) ?? 'could not preview this schedule' };
      }
      if (mine !== seq && key === 'foot') return; // superseded
      onResult(result);
    }, delay));
  };
}

/**
 * Open the dialog. `job` is null for New, a job object for Edit/Clone.
 * `clone: true` prefills from a job but creates a new one.
 * `onSaved()` runs after a successful save.
 */
export function openJobDialog({ job = null, clone = false, onSaved } = {}) {
  const isEdit = !!job && !clone;
  const form = jobToForm(job, { clone });
  if (!job) form.type = 'claude';

  let extensions = [];
  let errors = [];          // [{field, message}] — client-side, anchored
  let serverErrors = [];    // sentences the server rejected that we did not
  let waiting = false;      // the approval-waiting state

  const previewRow = makePreviewer((schedules) => api('POST', '/api/schedule/preview', { schedules, jobId: job?.id ?? '' }));

  // ---------------------------------------------------------------- shell
  const body = el('div', { class: 'modal__body' });
  const consequence = el('span', { class: 'modal__consequence' });
  const cancelBtn = el('button', { class: 'btn', type: 'button', style: 'margin-left:auto;' }, 'Cancel');
  const submitBtn = el('button', {
    class: 'btn btn--primary', type: 'submit', style: 'margin-left:0;', 'data-mutating': true,
  }, isEdit ? 'Save job' : 'Create job');
  const foot = el('div', { class: 'modal__foot' }, [consequence, cancelBtn, submitBtn]);

  const closeBtn = iconBtn({
    label: 'Close without saving', tag: 'button', svgHtml: SVG_X, style: 'margin-left:auto;',
  });
  const formEl = el('form', {}, [body, foot]);
  const modal = el('div', {
    class: 'modal modal--wide', role: 'dialog', 'aria-modal': 'true',
    'aria-label': isEdit ? 'Edit job' : clone ? 'Clone into a new job' : 'New job',
  }, [
    el('div', { class: 'modal__head' }, [
      el('h2', {}, isEdit ? 'Edit job' : clone ? 'Clone into a new job' : 'New job'),
      closeBtn,
    ]),
    formEl,
  ]);
  const backdrop = el('div', { class: 'modalwrap', role: 'presentation' }, modal);
  document.body.appendChild(backdrop);

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  // An approval is in flight and the request is already with the server —
  // closing the dialog would not cancel it, and would lose everything typed if
  // it comes back denied. So the exits go dead while waiting, which is exactly
  // what the mockup draws (no Cancel in the approval-waiting foot).
  const onKey = (ev) => { if (ev.key === 'Escape' && !waiting) close(); };
  closeBtn.addEventListener('click', () => { if (!waiting) close(); });
  cancelBtn.addEventListener('click', () => { if (!waiting) close(); });
  backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop && !waiting) close(); });
  document.addEventListener('keydown', onKey);

  // ------------------------------------------------------------- pieces

  const fieldId = (name) => `jd-${String(name).replace(/[^\w-]/g, '_')}`;

  function errorFor(field) {
    return errors.find((e) => e.field === field) ?? null;
  }

  function markInvalid(node, field) {
    const bad = !!errorFor(field);
    if (!node) return node;
    node.classList.toggle('is-invalid', bad);
    if (bad) {
      node.setAttribute('aria-invalid', 'true');
      // The visual treatment the mockup applies inline. Applied here rather
      // than as a stylesheet edit because system.css/launchbox.css are
      // byte-identical copies of the audited spec and must not be touched.
      node.style.borderColor = 'var(--bad)';
      node.style.boxShadow = '0 0 0 3px var(--bad-wash)';
    } else {
      node.removeAttribute('aria-invalid');
      node.style.borderColor = '';
      node.style.boxShadow = '';
    }
    return node;
  }

  function labelled(label, node, { hint, field } = {}) {
    if (field) {
      node.id = fieldId(field);
      markInvalid(node, field);
    }
    return [
      el('span', { class: 'flabel' }, field ? el('label', { for: fieldId(field) }, label) : label),
      hint ? el('div', {}, [node, el('span', { class: 'fhint' }, hint)]) : node,
    ];
  }

  function textField(key, value, attrs = {}) {
    const node = el('input', { type: 'text', class: 'field', value: value ?? '', ...attrs });
    node.addEventListener('input', () => { form[key] = node.value; onFormChange(); });
    return node;
  }

  function numField(key, value, attrs = {}) {
    const node = el('input', { type: 'number', class: 'field', value: value ?? '', ...attrs });
    node.addEventListener('input', () => { form[key] = node.value === '' ? '' : Number(node.value); onFormChange(); });
    return node;
  }

  // ------------------------------------------------------- schedule rows

  function scheduleRow(row, index) {
    const line = el('div', { class: 'schedrow__line' });
    const fires = el('div', { class: 'schedrow__fires' }, 'next fires: …');

    const segs = el('div', { class: 'segs' });
    for (const [kind, label] of [['preset', 'Preset'], ['cron', 'Cron'], ['once', 'Once'], ['afterReset', 'After reset']]) {
      const seg = el('button', {
        class: 'seg', type: 'button',
        'aria-selected': row.kind === kind ? 'true' : null,
      }, label);
      seg.addEventListener('click', () => { row.kind = kind; render(); });
      segs.appendChild(seg);
    }
    line.appendChild(segs);

    if (row.kind === 'preset') {
      const sel = el('select', { style: 'max-width:130px;', 'aria-label': `Schedule ${index + 1} preset` },
        PRESETS.map((p) => el('option', { value: p.id, selected: row.preset === p.id }, p.label)));
      sel.addEventListener('change', () => { row.preset = sel.value; render(); });
      line.appendChild(sel);

      if (row.preset === 'weekly') {
        const day = el('select', { style: 'max-width:130px;', 'aria-label': `Schedule ${index + 1} day` },
          WEEKDAYS.map((d) => el('option', { value: String(d.value), selected: Number(row.weekday) === d.value }, d.label)));
        day.addEventListener('change', () => { row.weekday = Number(day.value); onFormChange(); refreshRow(index); });
        line.appendChild(day);
      }
      if (row.preset !== 'hourly') line.appendChild(el('span', { class: 't-meta' }, 'at'));
      const time = el('input', {
        type: 'time', class: 'field', value: row.time, style: 'max-width:110px;',
        'aria-label': `Schedule ${index + 1} time`,
      });
      time.addEventListener('input', () => { row.time = time.value; onFormChange(); refreshRow(index); });
      line.appendChild(time);
      if (row.preset === 'hourly') line.appendChild(el('span', { class: 't-meta' }, '— the minutes are used, the hour is ignored'));
    } else if (row.kind === 'cron') {
      const expr = el('input', {
        type: 'text', class: 'field field--mono', value: row.expr, style: 'max-width:200px;',
        placeholder: '0 3 * * *', 'aria-label': `Schedule ${index + 1} cron expression`,
      });
      markInvalid(expr, `schedule.${index}`);
      expr.addEventListener('input', () => { row.expr = expr.value; onFormChange(); refreshRow(index); });
      line.appendChild(expr);
      // No field-count hint here on purpose: croner accepts 5 OR 6 fields, and
      // the mockup's "expected 5" sentence is wrong. What a bad expression
      // produces is croner's own error, shown on the fires line below.
      line.appendChild(el('span', { class: 't-meta' }, 'minute hour day month weekday (a 6th field is seconds)'));
    } else if (row.kind === 'once') {
      const at = el('input', {
        type: 'datetime-local', class: 'field', value: row.at, style: 'max-width:220px;',
        'aria-label': `Schedule ${index + 1} date and time`,
      });
      markInvalid(at, `schedule.${index}`);
      at.addEventListener('input', () => { row.at = at.value; onFormChange(); refreshRow(index); });
      line.appendChild(at);
    } else {
      const win = el('select', { style: 'max-width:150px;', 'aria-label': `Schedule ${index + 1} window` }, [
        el('option', { value: 'five_hour', selected: row.window === 'five_hour' }, '5-hour reset'),
        el('option', { value: 'seven_day', selected: row.window === 'seven_day' }, 'Weekly reset'),
      ]);
      win.addEventListener('change', () => { row.window = win.value; onFormChange(); refreshRow(index); });
      line.appendChild(win);

      const off = el('input', {
        type: 'number', class: 'field', value: row.offsetMin, style: 'max-width:64px;',
        min: LIMITS.offsetMin[0], max: LIMITS.offsetMin[1], 'aria-label': `Schedule ${index + 1} offset minutes`,
      });
      off.addEventListener('input', () => { row.offsetMin = off.value === '' ? '' : Number(off.value); onFormChange(); refreshRow(index); });
      markInvalid(off, `schedule.${index}`);
      line.appendChild(el('span', { class: 'frow', style: 'gap:7px;' }, [el('span', { class: 't-meta' }, 'offset'), off, el('span', { class: 't-meta' }, 'min')]));

      const jit = el('input', {
        type: 'number', class: 'field', value: row.jitterMin, style: 'max-width:64px;',
        min: LIMITS.jitterMin[0], max: LIMITS.jitterMin[1], 'aria-label': `Schedule ${index + 1} jitter minutes`,
      });
      jit.addEventListener('input', () => { row.jitterMin = jit.value === '' ? '' : Number(jit.value); onFormChange(); refreshRow(index); });
      line.appendChild(el('span', { class: 'frow', style: 'gap:7px;' }, [el('span', { class: 't-meta' }, 'jitter ±'), jit, el('span', { class: 't-meta' }, 'min')]));
    }

    // Removing the only schedule would produce a job that can never run, which
    // the server rejects anyway — so it is refused here with the reason rather
    // than offered and then failed.
    const only = form.rows.length === 1;
    const rm = iconBtn({
      label: `Remove schedule ${index + 1}`,
      tip: only ? 'A job needs at least one schedule' : 'Remove this schedule',
      tag: 'button', svgHtml: SVG_X,
    });
    rm.type = 'button';
    rm.disabled = only;
    rm.addEventListener('click', () => { form.rows.splice(index, 1); render(); });
    line.appendChild(rm);

    return { node: el('div', { class: 'schedrow' }, [line, fires]), fires };
  }

  const rowFires = [];

  function refreshRow(index) {
    const target = rowFires[index];
    if (!target) return;
    const entry = rowToEntry(form.rows[index]);
    target.textContent = 'next fires: …';
    target.style.color = '';
    previewRow(`row-${index}`, [entry], (result) => {
      const live = rowFires[index];
      if (!live) return;
      const f = firesText(result);
      live.textContent = f.text;
      live.style.color = f.tone === 'bad' ? 'var(--bad)' : '';
    });
  }

  function refreshFoot() {
    consequence.textContent = consequenceText({ isEdit, count: form.rows.length, preview: null });
    previewRow('foot', form.rows.map(rowToEntry), (result) => {
      consequence.textContent = consequenceText({ isEdit, count: form.rows.length, preview: result });
    });
  }

  function onFormChange() {
    // Re-validate only once the reader has already been shown errors — a form
    // that turns red while it is still being filled in is noise.
    if (errors.length) errors = validateForm(form, { fields: activeFields() });
    refreshFoot();
  }

  const activeFields = () => extensions.find((e) => e.id === form.type)?.fields ?? [];

  // ------------------------------------------------------------- render

  function errorBanner() {
    const all = [
      ...errors.map((e) => ({ ...e, anchored: true })),
      ...serverErrors.map((m) => ({ field: null, message: m, anchored: false })),
    ];
    if (!all.length) return null;
    const list = el('ul', { class: 'errlist' });
    for (const e of all) {
      if (e.anchored) {
        // REVIEW #6: every summary line is a link that focuses the field that
        // caused it. An unanchored server sentence stays plain text rather
        // than becoming a link that goes nowhere.
        const a = el('a', { href: '#' }, e.message);
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          const node = document.getElementById(fieldId(e.field));
          node?.scrollIntoView({ block: 'center' });
          node?.focus();
        });
        list.appendChild(el('li', {}, a));
      } else {
        list.appendChild(el('li', {}, e.message));
      }
    }
    const n = all.length;
    return el('div', { class: 'banner banner--bad', style: 'margin-bottom: 16px;', role: 'alert' }, [
      svgNode(SVG_WARN),
      el('div', {}, [
        el('b', {}, `The job wasn't saved — ${n} ${n === 1 ? 'field needs' : 'fields need'} fixing.`),
        ' Everything you typed is still here.',
        list,
      ]),
    ]);
  }

  function waitingBanner() {
    return el('div', { class: 'banner banner--info', style: 'margin-bottom: 16px;', role: 'status' }, [
      el('span', { class: 'spin', style: 'margin-top:2px;' }),
      el('span', {}, [
        el('b', {}, 'Waiting for your approval.'),
        ` macOS is showing a Touch ID (or password) prompt for “${isEdit ? 'save' : 'create'} job `
        + `${form.name || 'untitled'}”. It times out in about ${APPROVAL_TIMEOUT_TEXT}. `
        + 'Denying keeps everything you typed.',
      ]),
    ]);
  }

  function basicsFieldset() {
    const grid = el('div', { class: 'fgrid' });
    grid.append(...labelled('Name', textField('name', form.name, { placeholder: 'What this job is for' }), { field: 'name' }));

    const typeSegs = el('div', { class: 'segs', style: 'max-width:320px;' });
    for (const ext of extensions) {
      const seg = el('button', {
        class: 'seg', type: 'button',
        'aria-selected': form.type === ext.id ? 'true' : null,
        // A job's type decides which extension runs it and therefore which
        // params exist; changing it on an existing job would orphan them.
        'data-tip': isEdit ? 'A job\'s type cannot be changed — clone it instead' : ext.description || ext.name,
      }, ext.name);
      seg.disabled = isEdit;
      seg.addEventListener('click', () => { form.type = ext.id; render(); });
      typeSegs.appendChild(seg);
    }
    grid.append(el('span', { class: 'flabel' }, 'Type'), typeSegs);

    // Required, non-advanced extension fields sit in the basics block; the
    // advanced ones go below. Built from GET /api/extensions, never from a
    // hard-coded list, so a third-party job type gets its own fields.
    for (const f of activeFields().filter((x) => !x.advanced)) {
      grid.append(...labelled(f.label ?? f.key, extField(f), { field: `params.${f.key}` }));
    }
    grid.append(...labelled('Working directory',
      textField('cwd', form.cwd, { class: 'field field--mono', placeholder: '~/path/to/project' }),
      { field: 'cwd' }));
    return el('fieldset', { class: 'fset' }, grid);
  }

  function extField(f) {
    const v = form.params?.[f.key] ?? f.default ?? '';
    let node;
    if (f.type === 'textarea') {
      node = el('textarea', { class: 'field', rows: f.rows ?? 3, placeholder: f.placeholder ?? '' }, String(v ?? ''));
    } else if (f.type === 'select') {
      node = el('select', {}, (f.options ?? []).map((o) => el('option', { value: o.value, selected: v === o.value }, o.label)));
    } else if (f.type === 'number') {
      node = el('input', { type: 'number', class: 'field', value: v, min: f.min, max: f.max });
    } else if (f.type === 'checkbox') {
      node = el('input', { type: 'checkbox', class: 'check', checked: !!v });
    } else {
      node = el('input', { type: 'text', class: `field${f.key === 'extraArgs' ? ' field--mono' : ''}`, value: v, placeholder: f.placeholder ?? '' });
    }
    const read = () => (f.type === 'checkbox' ? node.checked : node.value);
    node.addEventListener(f.type === 'select' || f.type === 'checkbox' ? 'change' : 'input', () => {
      form.params = { ...form.params, [f.key]: read() };
      onFormChange();
    });
    return node;
  }

  function scheduleFieldset() {
    const sched = el('div', { class: 'sched' });
    rowFires.length = 0;
    form.rows.forEach((row, i) => {
      const { node, fires } = scheduleRow(row, i);
      rowFires[i] = fires;
      sched.appendChild(node);
    });
    const add = el('button', { class: 'btn btn--ghost', type: 'button' }, [svgNode(SVG_PLUS), 'Add another schedule']);
    add.addEventListener('click', () => { form.rows.push(newRow()); render(); });
    return el('fieldset', { class: 'fset' }, [
      el('legend', { class: 'fset__t' }, 'Schedule'),
      sched,
      el('div', { style: 'margin-top: 9px;' }, add),
      errorFor('schedule') ? el('div', { class: 'fhint', style: 'color:var(--bad);' }, errorFor('schedule').message) : null,
    ]);
  }

  function advancedFieldset() {
    const grid = el('div', { class: 'fgrid' });
    for (const f of activeFields().filter((x) => x.advanced)) {
      const hint = f.key === 'permMode'
        // Said out loud because it is the single most expensive surprise in
        // unattended running: a code job under acceptEdits cannot run its own
        // tests or commit, so it can never verify or land its work.
        ? 'acceptEdits can edit files but cannot run commands — a job expected to run tests or commit needs auto.'
        : null;
      grid.append(...labelled(f.label ?? f.key, extField(f), { field: `params.${f.key}`, hint }));
    }

    grid.append(...labelled('Timeout',
      el('div', { class: 'frow' }, [
        numField('timeoutMin', form.timeoutMin, { style: 'max-width:90px;', min: LIMITS.timeoutMin[0], max: LIMITS.timeoutMin[1] }),
        el('span', { class: 't-meta' }, 'minutes, then the stop ladder runs: SIGINT → SIGTERM → SIGKILL'),
      ]),
      { field: 'timeoutMin' }));
    markInvalid($$('.field', grid).find((n) => n.id === fieldId('timeoutMin')), 'timeoutMin');

    grid.append(
      el('span', { class: 'flabel' }, 'Retries'),
      el('div', { class: 'frow' }, [
        numField('retryCount', form.retryCount, { style: 'max-width:90px;', min: LIMITS.retryCount[0], max: LIMITS.retryCount[1] }),
        el('span', { class: 't-meta' }, 'retry after'),
        numField('retryDelayMin', form.retryDelayMin, { style: 'max-width:90px;', min: LIMITS.retryDelayMin[0], max: LIMITS.retryDelayMin[1] }),
        el('span', { class: 't-meta' }, 'minutes'),
      ]),
    );

    const notify = el('select', { 'aria-label': 'Notify' },
      NOTIFY_OPTIONS.map((o) => el('option', { value: o.value, selected: form.notify === o.value }, o.label)));
    notify.addEventListener('change', () => { form.notify = notify.value; onFormChange(); });
    grid.append(...labelled('Notify', notify, { field: 'notify' }));

    const guard = el('input', { type: 'checkbox', class: 'check', checked: !form.ignoreGuard });
    guard.addEventListener('change', () => { form.ignoreGuard = !guard.checked; onFormChange(); });
    const headroom = numField('minHeadroomPct', form.minHeadroomPct, {
      style: 'max-width:80px;', min: LIMITS.minHeadroomPct[0], max: LIMITS.minHeadroomPct[1],
      'aria-label': 'Extra headroom percent',
    });
    grid.append(
      el('span', { class: 'flabel' }, 'Budget guard'),
      el('div', { class: 'frow' }, [
        el('label', { class: 'frow', style: 'gap:7px;' }, [guard, el('span', { class: 't-meta' }, 'respect the guard')]),
        el('span', { class: 't-meta' }, '· extra headroom this job needs:'),
        markInvalid(headroom, 'minHeadroomPct'),
        el('span', { class: 't-meta' }, '%'),
      ]),
    );

    const enabled = el('input', { type: 'checkbox', class: 'check', checked: form.enabled !== false });
    enabled.addEventListener('change', () => { form.enabled = enabled.checked; onFormChange(); });
    grid.append(
      el('span', { class: 'flabel' }, 'Enabled'),
      el('label', { class: 'frow', style: 'gap:7px;' }, [enabled, el('span', { class: 't-meta' }, 'off leaves the job configured but unscheduled')]),
    );

    return el('fieldset', { class: 'fset' }, [el('legend', { class: 'fset__t' }, 'Advanced'), grid]);
  }

  function render() {
    const active = document.activeElement;
    const activeId = active && backdrop.contains(active) ? active.id : null;
    const caret = activeId && typeof active.selectionStart === 'number' ? active.selectionStart : null;

    clear(body);
    if (waiting) body.appendChild(waitingBanner());
    const banner = errorBanner();
    if (banner && !waiting) body.appendChild(banner);
    body.appendChild(basicsFieldset());
    if (!waiting) {
      body.appendChild(scheduleFieldset());
      body.appendChild(advancedFieldset());
      form.rows.forEach((_, i) => refreshRow(i));
      refreshFoot();
    }

    // The approval-waiting state FREEZES the form rather than hiding it: the
    // reader needs to see what they are being asked to approve, and the fields
    // must not be editable while a request carrying their old values is still
    // in flight. Only the waiting branch touches `disabled` — the non-waiting
    // branch leaves every control's own state alone, because several are
    // legitimately disabled for their own reasons (the type segs on an edit,
    // the remove button on a sole schedule) and a blanket re-enable would
    // revive them. That is the same trap the degraded-state sweep avoids by
    // only ever touching data-mutating controls.
    if (waiting) {
      for (const node of $$('input, textarea, select, button', backdrop)) {
        if (node !== submitBtn) node.disabled = true;
      }
      clear(foot);
      foot.append(
        el('span', { class: 'modal__consequence' }, 'Approvals are queued one at a time — a second gated action would wait for this one.'),
        submitBtn,
      );
      submitBtn.disabled = true;
      clear(submitBtn);
      submitBtn.append(
        el('span', { class: 'spin', style: 'border-color: rgba(255,255,255,.35); border-top-color: #fff;' }),
        'Waiting for your approval…',
      );
    }

    // Controls built between main.js's sweeps (README's documented exception).
    if (!waiting) disableMutatingControls(backdrop, degradedReason());

    if (activeId) {
      const again = document.getElementById(activeId);
      if (again) {
        again.focus();
        if (caret != null && typeof again.setSelectionRange === 'function') {
          try { again.setSelectionRange(caret, caret); } catch { /* a time/number input refuses */ }
        }
      }
    }
  }

  // ------------------------------------------------------------- submit

  formEl.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    serverErrors = [];
    errors = validateForm(form, { fields: activeFields() });
    if (errors.length) {
      render();
      // The summary is the thing to read, so focus lands there rather than on
      // a field the reader has to hunt for the explanation of.
      body.querySelector('.banner--bad')?.scrollIntoView({ block: 'start' });
      body.querySelector('.errlist a')?.focus();
      return;
    }

    const bodyPayload = formToBody(form);
    waiting = true;
    render();
    const ok = await guardedSubmit(submitBtn, async () => {
      try {
        if (isEdit) await api('PUT', `/api/jobs/${job.id}`, bodyPayload);
        else await api('POST', '/api/jobs', bodyPayload);
      } catch (err) {
        // A 400 from POST/PUT /api/jobs carries `{errors:[sentence…]}`.
        // Captured here rather than re-derived from the toast text, and
        // deliberately NOT matched back to a field: lib/validate.js's messages
        // carry no attribution, and guessing one from the English is the
        // prose-parsing coupling claude-scheduler-ddu exists to stop.
        const list = err?.data?.errors;
        if (Array.isArray(list) && list.length) serverErrors = list;
        throw err;
      }
    }, (msg) => toast(msg, 'err', 8000));
    waiting = false;
    clear(submitBtn);
    submitBtn.append(isEdit ? 'Save job' : 'Create job');
    clear(foot);
    foot.append(consequence, cancelBtn, submitBtn);

    if (ok) {
      toast(isEdit ? `Saved “${bodyPayload.name}”` : `Created “${bodyPayload.name}”`, 'ok');
      close();
      onSaved?.();
      return;
    }
    // A refusal keeps every value. Server sentences that the client-side rules
    // did not predict (a cwd that does not exist, a cron croner rejects, an
    // extension's own validate()) are shown verbatim and unanchored — inventing
    // a field for them would be guessing.
    render();
  });

  // ------------------------------------------------------------- boot

  render();
  (async () => {
    try {
      const { extensions: exts } = await api('GET', '/api/extensions');
      extensions = exts ?? [];
    } catch {
      // Without the manifest the dialog can still edit the core fields; the
      // advanced per-type block is simply absent rather than guessed at.
      extensions = [];
    }
    if (!extensions.some((e) => e.id === form.type) && extensions.length) form.type = extensions[0].id;
    render();
    body.querySelector('.field')?.focus();
  })();

  return { backdrop, close, setServerErrors(list) { serverErrors = list; render(); } };
}
