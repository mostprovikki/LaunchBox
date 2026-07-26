// Inline SVG icons.
//
// Until now every icon in this app was an inline unicode glyph and there was no
// helper — which was fine for `▶` and `✕`, and not fine for job types: a
// fullwidth `＄` next to a colour emoji `🤖` renders at two completely different
// optical weights, in whatever the system font happens to resolve them to.
//
// Glyphs still work. An extension declaring only `icon: '🧩'` keeps rendering it;
// this set is opt-in per extension via `iconName`. Attribution lives in `NOTICE`:
//   * terminal — Lucide `square-terminal`, ISC
//   * claude   — the sunburst from claude-sessions-dashboard (MIT ©
//                wannabemrrobot), the author's own mark echoing Claude's. Not the
//                official Anthropic asset, on purpose — see NOTICE.

// Path data only. Every icon shares one 24×24 stroked frame, so a new icon is one
// line here and nothing else.
const PATHS = {
  // Chosen over Lucide's bare `terminal` (a naked `❯_`): the ask was "like the
  // Terminal icon on mac", and that is a rounded *window* with a prompt inside.
  terminal: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/>',
  claude: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="3" x2="12" y2="21"/>'
    + '<line x1="4.21" y1="7.5" x2="19.79" y2="16.5"/><line x1="7.5" y1="4.21" x2="16.5" y2="19.79"/>'
    + '<line x1="16.5" y1="4.21" x2="7.5" y2="19.79"/><line x1="19.79" y1="7.5" x2="4.21" y2="16.5"/>',
};

export const hasIcon = (name) => Object.hasOwn(PATHS, name);

// `currentColor` throughout, so an icon inherits whatever the surrounding text or
// a `button.icon.<name>` rule already sets — the same way the glyphs did.
export function icon(name, { size = 15, stroke = 1.85, cls = '' } = {}) {
  const paths = PATHS[name];
  if (!paths) return '';
  return `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"`
    + ` stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"`
    + ` aria-hidden="true">${paths}</svg>`;
}

// Resolution order is `iconName` → the extension's own glyph → `⚙`.
//
// An *unknown* `iconName` deliberately falls through to the glyph rather than
// rendering nothing: an icon is decoration, and a third-party extension naming an
// icon we don't ship must not silently lose its label. Lookup is a map read, so a
// manifest value is never interpolated into markup — it cannot inject anything.
export function iconFor(ext, opts) {
  return hasIcon(ext?.iconName)
    ? icon(ext.iconName, opts)
    : escGlyph(ext?.icon ?? '⚙');
}

// Local, because importing esc for one call would make util.js a dependency of
// the icon set and this file is meant to be leaf.
const escGlyph = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
