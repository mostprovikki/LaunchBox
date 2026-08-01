// LaunchBox redesign mockup audit — contrast, overflow, drift, console, links.
// Runs every redesign/*.html at 1280x900 in dark + light, screenshots each.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';

const require = createRequire('/Users/vignesh-5036/mydevelopment/tripper/trip-planner/package.json');
const { chromium } = require('playwright-core');

const REDESIGN = '/Users/vignesh-5036/mydevelopment/claude-scheduler/redesign';
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), 'shots');
const RESULTS = path.join(path.dirname(new URL(import.meta.url).pathname), 'results.json');

// newest cached headless shell
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const shells = fs.readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort();
const shellDir = shells[shells.length - 1];
const exe = path.join(cache, shellDir, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
if (!fs.existsSync(exe)) { console.error('no headless shell at ' + exe); process.exit(2); }

const pages = fs.readdirSync(REDESIGN).filter(f => f.endsWith('.html')).sort();
fs.mkdirSync(path.join(OUT, 'dark'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'light'), { recursive: true });

// Allowed palette per theme = every colour literal in the two CSS files.
// (Hardcoded hexes there are intentional per the file's own comments.)
const cssText = fs.readFileSync(path.join(REDESIGN, 'assets/system.css'), 'utf8')
  + fs.readFileSync(path.join(REDESIGN, 'assets/launchbox.css'), 'utf8');

const AUDIT_SRC = `(() => {
  const vis = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05;
  };
  const parse = c => {
    const m = c.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  };
  const lum = ({ r, g, b }) => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const comp = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const effBg = el => {
    let n = el, stack = [];
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
      n = n.parentElement;
    }
    if (!stack.length || stack[stack.length - 1].a < 1) stack.push(parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 });
    let bg = stack.pop();
    while (stack.length) bg = comp(stack.pop(), bg);
    return bg;
  };
  const sel = el => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cl = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/).slice(0, 2) : [];
    if (cl.length) s += '.' + cl.join('.');
    return s;
  };

  const out = { contrast: [], stranded: [], fontSizes: {}, radii: {}, colors: {}, overflowPx: 0, textLen: 0, tips: [] };
  out.textLen = (document.body.innerText || '').trim().length;
  out.overflowPx = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  const isDark = document.documentElement.dataset.theme === 'dark';

  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el)) continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    if (el.tagName === 'SVG' || el.closest('svg')) continue;
    const cs = getComputedStyle(el);

    // font sizes (non-icon)
    const fsz = Math.round(parseFloat(cs.fontSize) * 2) / 2;
    out.fontSizes[fsz] = (out.fontSizes[fsz] || 0) + 1;
    // radii
    const rad = cs.borderTopLeftRadius;
    if (rad && rad !== '0px') out.radii[rad] = (out.radii[rad] || 0) + 1;
    // painted colours
    for (const p of ['color', 'backgroundColor', 'borderTopColor']) {
      const c = parse(cs[p]);
      if (!c || c.a < 1) continue;
      if (p === 'borderTopColor' && parseFloat(cs.borderTopWidth) === 0) continue;
      const key = Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b);
      out.colors[key] = (out.colors[key] || 0) + 1;
    }

    // stranded light surface in dark mode
    if (isDark) {
      const bgc = parse(cs.backgroundColor);
      const r = el.getBoundingClientRect();
      if (bgc && bgc.a >= 0.9 && lum(bgc) > 0.75 && r.width > 24 && r.height > 8
          && !el.classList.contains('switch') && cs.borderRadius !== '50%') {
        const k = sel(el);
        if (!seen.has('st:' + k)) { seen.add('st:' + k); out.stranded.push({ sel: k, bg: cs.backgroundColor, w: Math.round(r.width), h: Math.round(r.height) }); }
      }
    }

    // contrast: only elements owning direct text
    let hasText = false;
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) { hasText = true; break; }
    if (!hasText) continue;
    const fg0 = parse(cs.color); if (!fg0) continue;
    const bg = effBg(el);
    const fg = fg0.a < 1 ? comp(fg0, bg) : fg0;
    const rt = ratio(fg, bg);
    const px = parseFloat(cs.fontSize), w = parseInt(cs.fontWeight) || 400;
    const large = px >= 24 || (px >= 18.66 && w >= 700);
    const need = large ? 3.0 : 4.5;
    if (rt < need) {
      const k = sel(el) + '|' + cs.color + '|' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b);
      if (!seen.has(k)) {
        seen.add(k);
        out.contrast.push({ sel: sel(el), text: (el.textContent || '').trim().slice(0, 40), fg: cs.color, bg: Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b), ratio: Math.round(rt * 100) / 100, px, w, need });
      }
    }
  }
  out.contrast.sort((a, b) => a.ratio - b.ratio);
  out.contrast = out.contrast.slice(0, 14);
  // tooltip presence (measured later interactively)
  out.tips = [...document.querySelectorAll('[data-tip]')].length;
  return out;
})()`;

(async () => {
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-proxy-server', '--proxy-bypass-list=*'] });
  const results = {};
  const allLinks = new Set();

  for (const theme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    for (const pg of pages) {
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(String(e)));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto('file://' + path.join(REDESIGN, pg), { waitUntil: 'networkidle' });
      await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      const audit = await page.evaluate(AUDIT_SRC);
      const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => h && !h.startsWith('http') && !h.startsWith('#') && !h.startsWith('mailto')));
      links.forEach(l => allLinks.add(pg + ' -> ' + l));
      await page.screenshot({ path: path.join(OUT, theme, pg.replace('.html', '.png')), fullPage: true });
      results[theme + '/' + pg] = { ...audit, errors, links: [...new Set(links)] };
      await page.close();
      process.stdout.write('.');
    }
    await ctx.close();
  }
  await browser.close();

  // link resolution
  const broken = [];
  for (const entry of allLinks) {
    const [, target] = entry.split(' -> ');
    const t = target.split('#')[0].split('?')[0];
    if (t && !fs.existsSync(path.join(REDESIGN, t))) broken.push(entry);
  }

  // palette check: colours painted that never appear in CSS text (rough heuristic via hex forms)
  fs.writeFileSync(RESULTS, JSON.stringify({ results, broken }, null, 1));
  console.log('\nWROTE ' + RESULTS);

  // summary to stdout
  for (const [k, v] of Object.entries(results)) {
    const flags = [];
    if (v.overflowPx > 1) flags.push('OVERFLOW ' + v.overflowPx + 'px');
    if (v.errors.length) flags.push('CONSOLE ' + v.errors.length);
    if (v.contrast.length) flags.push('CONTRAST ' + v.contrast.length);
    if (v.stranded.length) flags.push('STRANDED ' + v.stranded.length);
    if (v.textLen < 25) flags.push('EMPTY');
    if (flags.length) console.log(k + ': ' + flags.join(' · '));
  }
  console.log('BROKEN LINKS: ' + (broken.length ? '\n  ' + broken.join('\n  ') : 'none'));
})();
