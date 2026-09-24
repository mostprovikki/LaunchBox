#!/usr/bin/env node
// bin/install-skills.mjs — symlink skills/<name> into ~/.claude/skills/<name>.
// Symlink, not copy, so an edit here is live in the next session without a reinstall.
// Refuses to replace a real directory it did not create (someone's hand-written skill).
import { readdirSync, lstatSync, symlinkSync, unlinkSync, mkdirSync, readlinkSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'skills');
const DEST = process.env.CLAUDE_SKILLS_DIR || join(homedir(), '.claude', 'skills');
mkdirSync(DEST, { recursive: true });

let installed = 0;
for (const d of readdirSync(SRC, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const from = join(SRC, d.name);
  const to = join(DEST, d.name);
  if (existsSync(to) || isLink(to)) {
    const st = lstatSync(to);
    if (!st.isSymbolicLink()) {
      console.error(`skip ${d.name}: ${to} is a real directory, not ours — remove it by hand if you want this one`);
      continue;
    }
    if (readlinkSync(to) === from) { console.log(`ok   ${d.name} (already linked)`); installed++; continue; }
    unlinkSync(to);
  }
  symlinkSync(from, to, 'dir');
  console.log(`link ${d.name} -> ${to}`);
  installed++;
}
function isLink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
console.log(`${installed} skill(s) installed in ${DEST}`);
