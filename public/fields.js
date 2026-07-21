// Renders extension FieldSpec arrays ({key,label,type,…}) into form controls
// and reads them back. Shared by the job dialog and the settings tab.

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function control(f, value) {
  const v = value ?? f.default ?? '';
  const attrs = `data-key="${esc(f.key)}" data-ftype="${esc(f.type)}"${f.required ? ' required' : ''}`;
  switch (f.type) {
    case 'textarea':
      return `<textarea ${attrs} rows="${f.rows ?? 3}" placeholder="${esc(f.placeholder ?? '')}">${esc(v)}</textarea>`;
    case 'select':
      return `<select ${attrs}>${(f.options ?? [])
        .map((o) => `<option value="${esc(o.value)}"${o.value === v ? ' selected' : ''}>${esc(o.label ?? o.value)}</option>`)
        .join('')}</select>`;
    case 'number':
      return `<input ${attrs} type="number" value="${esc(v)}"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''}>`;
    case 'checkbox':
      return `<input ${attrs} type="checkbox"${v ? ' checked' : ''}>`;
    default: // text
      return `<input ${attrs} type="text" value="${esc(v)}" placeholder="${esc(f.placeholder ?? '')}">`;
  }
}

// Render `fields` into `container`, prefilled from `values`.
export function renderFields(container, fields, values = {}) {
  container.innerHTML = fields
    .map((f) => `<label class="ext-field">${esc(f.label ?? f.key)} ${control(f, values[f.key])}</label>`)
    .join('');
}

// Read values back out of a container previously filled by renderFields.
export function collectFields(container) {
  const out = {};
  for (const el of container.querySelectorAll('[data-key]')) {
    const t = el.dataset.ftype;
    out[el.dataset.key] = t === 'checkbox' ? el.checked : t === 'number' ? Number(el.value) : el.value;
  }
  return out;
}
