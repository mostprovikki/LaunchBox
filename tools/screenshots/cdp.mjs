// Minimal Chrome DevTools Protocol client — no dependencies.
// Uses node's built-in WebSocket (unflagged since node 22) and fetch.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveChrome() {
  const candidates = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : CHROME_CANDIDATES;
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error(
    'No Chrome found. Set CHROME_PATH to a Chrome/Chromium binary.\n' +
    `Looked in:\n  ${candidates.join('\n  ')}`,
  );
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForDebugger(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const json = await res.json();
      if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
    } catch (err) { lastErr = err; }
    await sleep(100);
  }
  throw new Error(`Chrome debugger never came up on :${port} — ${lastErr?.message ?? 'timeout'}`);
}

/** Open a CDP connection and attach a flat session to one page target. */
async function connect(wsUrl) {
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      `This script needs node's built-in WebSocket (node 22+). You are on ${process.version}.`,
    );
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  let dead = null; // set to an Error once the socket is gone

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.method ?? 'cdp'}: ${msg.error.message}`));
      else resolve(msg.result);
      return;
    }
    for (const fn of listeners) fn(msg);
  });

  // Without this, a browser that dies mid-run leaves every in-flight command
  // waiting forever and the whole capture hangs with no diagnostic. Fail loudly
  // instead: reject what's outstanding and refuse further sends.
  const die = (why) => {
    dead ??= new Error(`CDP connection lost: ${why}`);
    for (const [, { reject }] of pending) reject(dead);
    pending.clear();
  };
  ws.addEventListener('close', () => die('socket closed (did Chrome crash?)'));
  ws.addEventListener('error', () => die('socket error'));

  const CMD_TIMEOUT_MS = 30_000;
  const rawSend = (method, params, sessionId) => new Promise((resolve, reject) => {
    if (dead) { reject(dead); return; }
    const id = nextId++;
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out after ${CMD_TIMEOUT_MS / 1000}s`));
    }, CMD_TIMEOUT_MS);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    ws.send(JSON.stringify({ id, method, params: params ?? {}, sessionId }));
  });

  const { targetInfos } = await rawSend('Target.getTargets');
  let targetId = targetInfos.find((t) => t.type === 'page')?.targetId;
  if (!targetId) ({ targetId } = await rawSend('Target.createTarget', { url: 'about:blank' }));

  const { sessionId } = await rawSend('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => rawSend(method, params, sessionId);

  await send('Page.enable');
  await send('Runtime.enable');

  return {
    send,
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    close() { ws.close(); },
  };
}

/**
 * Launch Chrome and return a small page-driving API.
 * @param {{headful?: boolean, width: number, height: number, scale?: number}} opts
 */
export async function launchBrowser(opts) {
  const { headful = false, width, height, scale = 2 } = opts;
  const profile = await mkdtemp(join(tmpdir(), 'cs-shots-chrome-'));
  const port = await freePort();
  const bin = resolveChrome();

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    'about:blank',
  ];
  if (!headful) args.unshift('--headless=new');

  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  let conn;
  try {
    conn = await connect(await waitForDebugger(port));
  } catch (err) {
    proc.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    throw new Error(`${err.message}\nchrome stderr:\n${stderr.slice(-1500)}`);
  }

  // Pin the viewport and DPR so output is identical regardless of the host display.
  await conn.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: scale, mobile: false,
  });

  const exited = new Promise((resolve) => proc.once('exit', resolve));

  return { conn, page: makePage(conn), async close() {
    try { conn.close(); } catch { /* already gone */ }
    proc.kill('SIGTERM');
    // Chrome keeps writing to its profile until it has actually exited, so
    // removing the directory before then silently half-fails and leaks one
    // profile per run. Wait it out, then insist.
    const bailed = await Promise.race([exited.then(() => false), sleep(5000).then(() => true)]);
    if (bailed) {
      proc.kill('SIGKILL');
      await Promise.race([exited, sleep(2000)]);
    }
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  } };
}

function makePage(conn) {
  return {
    /**
     * Navigate and wait for the page to settle.
     *
     * A hash-only change is a *same-document* navigation: it fires
     * Page.navigatedWithinDocument and never Page.loadEventFired, so waiting on
     * load alone would hang forever. Accept either, and cap the wait so a
     * missing event can never wedge the whole capture.
     */
    async goto(url, { timeoutMs = 15_000 } = {}) {
      let off;
      const settled = new Promise((resolve) => {
        off = conn.onEvent((msg) => {
          if (msg.method === 'Page.loadEventFired'
            || msg.method === 'Page.navigatedWithinDocument') resolve();
        });
      });
      try {
        await conn.send('Page.navigate', { url });
        await Promise.race([settled, sleep(timeoutMs)]);
      } finally {
        off?.();
      }
    },

    /**
     * Evaluate a function in the page and return its (JSON-serialisable) result.
     * Rejects if the page throws, so a broken selector fails the shot loudly.
     */
    async eval(fn, ...args) {
      const expr = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`;
      const { result, exceptionDetails } = await conn.send('Runtime.evaluate', {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
      });
      if (exceptionDetails) {
        const text = exceptionDetails.exception?.description
          ?? exceptionDetails.text
          ?? 'page threw';
        throw new Error(text.split('\n')[0]);
      }
      return result.value;
    },

    /** Accept or dismiss the next native dialog raised by `trigger`. */
    async withDialog(action, trigger) {
      const off = conn.onEvent(async (msg) => {
        if (msg.method === 'Page.javascriptDialogOpening') {
          await conn.send('Page.handleJavaScriptDialog', { accept: action === 'accept' });
        }
      });
      try { return await trigger(); } finally { off(); }
    },

    async screenshot({ fullPage = false } = {}) {
      const { data } = await conn.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: fullPage,
        ...(fullPage ? { optimizeForSpeed: false } : {}),
      });
      return Buffer.from(data, 'base64');
    },

    async metrics() {
      return this.eval(() => ({
        w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
      }));
    },
  };
}
