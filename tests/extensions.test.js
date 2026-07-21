import test from 'node:test';
import assert from 'node:assert/strict';
import { loadExtensions, manifest, validateFields } from '../lib/extensions.js';
import template from '../extensions/_template/index.js';

test('loadExtensions loads command+claude, skips _template', async () => {
  const exts = await loadExtensions();
  assert.deepEqual([...exts.keys()].sort(), ['claude', 'command']);
  assert.ok(!exts.has('my-agent'));
  const claude = exts.get('claude');
  assert.equal(typeof claude.command, 'function');
  assert.equal(typeof claude.createOutputHandler, 'function');
  assert.equal(claude.concurrency.settingKey, 'maxConcurrent');
});

test('manifest is JSON-safe: no functions, runActions reduced to metadata', async () => {
  const exts = await loadExtensions();
  const m = manifest(exts);
  assert.equal(JSON.parse(JSON.stringify(m)).length, m.length); // serializable
  const claude = m.find((e) => e.id === 'claude');
  assert.ok(Array.isArray(claude.fields) && claude.fields.length);
  assert.deepEqual(Object.keys(claude.runActions[0]).sort(), ['id', 'label', 'requiresRunMeta']);
  for (const e of m) for (const v of Object.values(e)) assert.notEqual(typeof v, 'function');
});

test('_template stays a valid extension shape', () => {
  assert.equal(typeof template.command, 'function');
  assert.ok(template.id && template.name && Array.isArray(template.fields));
  const spec = template.command({ params: { task: 'hello' } }, { setting: (k, d) => d });
  assert.equal(spec.cmd, 'my-agent');
  assert.deepEqual(spec.args, ['hello']);
});

test('validateFields: required, defaults, select options, number ranges, unknown keys dropped', () => {
  const fields = [
    { key: 'a', type: 'text', label: 'A', required: true },
    { key: 'b', type: 'select', options: [{ value: 'x' }, { value: 'y' }], default: 'x' },
    { key: 'n', type: 'number', min: 1, max: 5, default: 2 },
    { key: 'c', type: 'checkbox' },
  ];
  let r = validateFields(fields, { a: 'hi', junk: 1 });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.params, { a: 'hi', b: 'x', n: 2, c: false });

  r = validateFields(fields, {});
  assert.ok(r.errors.some((e) => /A required/.test(e)));

  r = validateFields(fields, { a: 'hi', b: 'z' });
  assert.ok(r.errors.some((e) => e.includes('invalid b')));

  r = validateFields(fields, { a: 'hi', n: 9 });
  assert.ok(r.errors.some((e) => e.includes('n must be')));
  r = validateFields(fields, { a: 'hi', n: 1.5 });
  assert.ok(r.errors.length);

  r = validateFields([{ key: 'w', type: 'wat' }], { w: 1 });
  assert.ok(r.errors.some((e) => e.includes('unknown field type')));
});
