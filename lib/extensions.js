import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// An extension is a directory under extensions/ with an index.js default-exporting:
//   id, name, icon, description        — identity (id must match nothing else loaded)
//   iconName: 'terminal' | 'claude'    — optional: an icon from public/icons.js,
//        preferred over `icon`. An unknown name falls back to the `icon` glyph.
//   fields: [FieldSpec]                — job form fields, stored in job.params
//   settings: [FieldSpec]              — extension-scoped settings (settings table)
//   concurrency: {settingKey, default} — optional: cap concurrent runs via a setting
//   command(job, ctx) -> {cmd, args, env?}          — spawn spec (required)
//   createOutputHandler({onLine,onProgress,onMeta}) — optional stdout parser;
//        the handler may expose stopping() — called when a graceful stop begins,
//        so an intentional stop isn't rendered as the error the tool reports
//   gracefulStop: 'signal' | false     — optional, default 'signal': SIGINT first
//        and only escalate if ignored. `false` means this job type has no safe
//        stopping point, so go straight to SIGTERM→SIGKILL.
//   runActions: [{id,label,requiresRunMeta, exec({run,job,db,execFileFn})}]
//   validate(params) -> [errors]       — optional custom validation
//   init(ctx)                          — optional one-time boot hook
// Directories starting with '_' or '.' are skipped (templates, scratch).
export async function loadExtensions(dir = join(ROOT, 'extensions')) {
  const map = new Map();
  if (!existsSync(dir)) return map;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('_') || d.name.startsWith('.')) continue;
    const entry = join(dir, d.name, 'index.js');
    if (!existsSync(entry)) continue;
    const ext = (await import(pathToFileURL(entry).href)).default;
    const problem = checkShape(ext);
    if (problem) throw new Error(`extension "${d.name}": ${problem}`);
    if (map.has(ext.id)) throw new Error(`duplicate extension id "${ext.id}"`);
    map.set(ext.id, ext);
  }
  return map;
}

function checkShape(ext) {
  if (!ext || typeof ext !== 'object') return 'default export must be an object';
  if (!ext.id || typeof ext.id !== 'string') return 'id (string) required';
  if (!ext.name) return 'name required';
  if (typeof ext.command !== 'function') return 'command(job, ctx) function required';
  if (!Array.isArray(ext.fields)) return 'fields array required';
  for (const f of ext.fields) {
    if (!f.key || !f.type) return `field needs key+type (got ${JSON.stringify(f)})`;
  }
  return null;
}

// JSON-safe view of extensions for the browser (functions stripped).
export function manifest(extensions) {
  return [...extensions.values()].map((e) => ({
    id: e.id,
    name: e.name,
    icon: e.icon ?? '⚙',
    iconName: e.iconName ?? '',
    description: e.description ?? '',
    fields: e.fields,
    settings: e.settings ?? [],
    runActions: (e.runActions ?? []).map(({ id, label, requiresRunMeta }) => ({ id, label, requiresRunMeta })),
  }));
}

// Validate + normalize params against an extension's field specs.
// Returns {params, errors}: defaults applied, unknown keys dropped.
export function validateFields(fields, raw = {}) {
  const errors = [];
  const params = {};
  for (const f of fields) {
    let v = raw[f.key];
    if (v == null || v === '') v = f.default ?? (f.type === 'checkbox' ? false : null);
    switch (f.type) {
      case 'text':
      case 'textarea':
        if (v != null && typeof v !== 'string') errors.push(`${f.key} must be a string`);
        else if (f.required && !(v && v.trim())) errors.push(`${f.label ?? f.key} required`);
        break;
      case 'select':
        if (f.required && v == null) errors.push(`${f.label ?? f.key} required`);
        else if (v != null && !(f.options ?? []).some((o) => o.value === v)) errors.push(`invalid ${f.key}`);
        break;
      case 'number':
        v = v == null ? null : Number(v);
        if (f.required && v == null) errors.push(`${f.label ?? f.key} required`);
        else if (v != null && (!Number.isFinite(v) || (f.integer !== false && !Number.isInteger(v))
          || (f.min != null && v < f.min) || (f.max != null && v > f.max))) {
          errors.push(`${f.key} must be ${f.min ?? '-∞'}-${f.max ?? '∞'}`);
        }
        break;
      case 'checkbox':
        v = !!v;
        break;
      default:
        errors.push(`unknown field type ${f.type} for ${f.key}`);
    }
    params[f.key] = v;
  }
  return { params, errors };
}
