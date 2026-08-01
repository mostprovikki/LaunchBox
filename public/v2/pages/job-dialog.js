// Minimal New/Edit/Clone job dialog for the Jobs tab (claude-scheduler-btv.5
// / B1). Deliberately basic: a plain cron-expression field and no live
// next-fire preview. The full schedule builder with live preview (via
// POST /api/v2/schedule-preview, claude-scheduler-btv.3) is a separate,
// already-planned bead — claude-scheduler-btv.11 (D1), which the wave plan
// (redesign/IMPLEMENTATION-PLAN.md) lists as blocked BY this one. Without
// this stub the Jobs tab's New job/Edit/Clone buttons would be dead ends
// until D1 lands; this makes them genuinely functional (reuses
// POST/PUT /api/jobs unchanged) while staying out of D1's scope — it does
// not attempt the schedule builder, live preview, or the validation-summary
// links REVIEW.md's recommendation #6 asks D1 for.
//
// Only public/v2/pages/jobs.js imports this module.
import { api, guardedSubmit, degradedReason } from '../api.js';
import { el, toast, disableMutatingControls } from '../ui.js';

const MODELS = ['default', 'opus', 'sonnet', 'haiku'];

function fieldRow(label, inputEl) {
  return el('label', { class: 't-meta', style: 'display:block;margin:10px 0;' }, [
    el('div', { style: 'margin-bottom:4px;' }, label),
    inputEl,
  ]);
}

/**
 * Open the dialog. `job` is null for New, a job object for Edit/Clone.
 * `clone: true` opens a prefilled job with no id (Submit creates a new one).
 * `onSaved()` is called after a successful save so the caller can refresh.
 */
export function openJobDialog({ job = null, clone = false, onSaved } = {}) {
  const isEdit = !!job && !clone;
  const initial = job ?? { type: 'command', enabled: true, timeoutMin: 60, retryCount: 0, params: {} };

  const nameInput = el('input', { type: 'text', class: 'input', required: true, value: clone ? `${initial.name} (copy)` : (initial.name ?? '') });
  const typeSelect = el('select', { class: 'input', disabled: isEdit }, [
    el('option', { value: 'command', selected: initial.type !== 'claude' }, 'Shell command'),
    el('option', { value: 'claude', selected: initial.type === 'claude' }, 'Claude job'),
  ]);
  const cwdInput = el('input', { type: 'text', class: 'input mono', value: initial.cwd ?? '', placeholder: '~/path/to/project' });
  const commandInput = el('textarea', { class: 'input mono', rows: 2, placeholder: 'e.g. git -C ~/repo pull' }, initial.params?.command ?? '');
  const promptInput = el('textarea', { class: 'input', rows: 4, placeholder: 'What should Claude do?' }, initial.params?.prompt ?? '');
  const modelSelect = el('select', { class: 'input' }, MODELS.map((m) => el('option', { value: m, selected: (initial.params?.model ?? 'default') === m }, m)));
  const firstEntry = Array.isArray(initial.schedule) ? initial.schedule[0] : initial.schedule;
  const cronInput = el('input', {
    type: 'text', class: 'input mono',
    value: firstEntry?.type === 'cron' ? (firstEntry.expr ?? '') : (firstEntry ? '' : '0 * * * *'),
    placeholder: '0 * * * *',
  });
  const enabledInput = el('input', { type: 'checkbox', checked: initial.enabled !== false });
  const timeoutInput = el('input', { type: 'number', class: 'input', min: 1, value: initial.timeoutMin ?? 60 });
  const retryInput = el('input', { type: 'number', class: 'input', min: 0, value: initial.retryCount ?? 0 });
  const errBox = el('div', { class: 't-meta', style: 'color:var(--bad);display:none;margin-top:8px;' });

  const claudeFields = el('div', {}, [fieldRow('Goal prompt', promptInput), fieldRow('Model', modelSelect)]);
  const commandFields = el('div', {}, [fieldRow('Command', commandInput)]);
  const syncTypeFields = () => {
    const claude = typeSelect.value === 'claude';
    claudeFields.style.display = claude ? '' : 'none';
    commandFields.style.display = claude ? 'none' : '';
  };
  typeSelect.addEventListener('change', syncTypeFields);
  syncTypeFields();

  const form = el('form', { class: 'modal__body' }, [
    fieldRow('Name', nameInput),
    fieldRow('Type', typeSelect),
    fieldRow('Working directory', cwdInput),
    claudeFields,
    commandFields,
    fieldRow('Cron schedule (D1 will add the full builder + live preview)', cronInput),
    fieldRow('Timeout (minutes)', timeoutInput),
    fieldRow('Retry count', retryInput),
    el('label', { class: 't-meta', style: 'display:flex;align-items:center;gap:6px;margin-top:10px;' }, [enabledInput, 'Enabled']),
    errBox,
  ]);

  const cancelBtn = el('button', { class: 'btn', type: 'button' }, 'Cancel');
  const submitBtn = el('button', { class: 'btn btn--primary', type: 'submit', 'data-mutating': true }, isEdit ? 'Save' : 'Create');
  form.appendChild(el('div', { class: 'modal__foot' }, [cancelBtn, submitBtn]));

  const backdrop = el('div', { class: 'modalwrap', role: 'presentation' });
  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': isEdit ? 'Edit job' : clone ? 'Clone job' : 'New job' }, [
    el('div', { class: 'modal__head' }, [el('h2', {}, isEdit ? 'Edit job' : clone ? 'Clone into a new job' : 'New job')]),
    form,
  ]);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  // Inserted after main.js's initial render sweep (README's documented
  // exception) — apply the current degraded reason directly rather than
  // waiting for the next auth-state transition to notice this dialog exists.
  disableMutatingControls(backdrop, degradedReason());

  const close = () => backdrop.remove();
  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) close(); });
  const onKey = (ev) => { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  nameInput.focus();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errBox.style.display = 'none';
    const body = {
      name: nameInput.value.trim(),
      type: typeSelect.value,
      cwd: cwdInput.value.trim(),
      schedule: { type: 'cron', expr: cronInput.value.trim() || '0 * * * *' },
      enabled: enabledInput.checked,
      timeoutMin: Number(timeoutInput.value) || 60,
      retryCount: Number(retryInput.value) || 0,
      params: typeSelect.value === 'claude'
        ? { prompt: promptInput.value, model: modelSelect.value }
        : { command: commandInput.value },
    };
    const ok = await guardedSubmit(form, async () => {
      if (isEdit) await api('PUT', `/api/jobs/${job.id}`, body);
      else await api('POST', '/api/jobs', body);
    }, (msg, kind) => {
      errBox.textContent = msg;
      errBox.style.display = '';
      toast(msg, kind);
    });
    if (ok) {
      toast(isEdit ? `Saved "${body.name}"` : `Created "${body.name}"`, 'ok');
      close();
      onSaved?.();
    }
  });

  return backdrop;
}
