import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'tools/qa/vendored.json'), 'utf8'));

// A vendored asset is third-party code executing in the daemon's origin. The
// pin is what makes "we know exactly what this is" a checkable claim rather
// than a hope, and what would catch a swap during a careless update.
test('every vendored asset matches its recorded hash and size', () => {
  const entries = Object.entries(manifest);
  assert.ok(entries.length > 0, 'the manifest must not be empty');
  for (const [rel, want] of entries) {
    const buf = readFileSync(join(ROOT, rel));
    assert.equal(buf.length, want.bytes, `${rel}: byte length`);
    assert.equal(createHash('sha256').update(buf).digest('hex'), want.sha256, `${rel}: sha256`);
  }
});

test('a vendored asset reaches no network origin of its own', () => {
  // D3 embeds five http://www.w3.org/... XML NAMESPACE URIs (identifiers, never
  // fetched) and one https://d3js.org homepage string. Those are allowlisted by
  // host; anything else in a vendored file would be a real outbound reference.
  const ALLOWED_HOSTS = new Set(['www.w3.org', 'd3js.org']);
  for (const rel of Object.keys(manifest)) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
      assert.ok(ALLOWED_HOSTS.has(m[1]), `${rel} references ${m[1]}`);
    }
  }
});
