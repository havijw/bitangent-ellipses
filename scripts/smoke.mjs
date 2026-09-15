/**
 * Headless-browser smoke test: the one thing the node:test unit suites can't
 * check — that the page actually boots in a browser and produces output.
 *
 * It boots the static server, drives a headless Chromium over the DevTools
 * Protocol (no dependencies: Node's global `fetch` and `WebSocket`), loads the
 * page, and asserts the export boxes are populated and the exported arc path
 * and ARC-parameter JSON are well-formed. This is exactly the class of bug
 * (a module-init crash like the localStorage TDZ) that leaves every unit test
 * green while the app is dead on load.
 *
 * Opt-in and self-skipping: run with `npm run test:e2e`. If no Chromium binary
 * is found it prints a notice and exits 0, so environments without a browser
 * don't fail the build.
 *
 * Usage: node test/smoke.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVE_PORT = Number(process.env.SMOKE_PORT || 8790);
const CDP_PORT = Number(process.env.SMOKE_CDP_PORT || 9333);
const PAGE_URL = `http://127.0.0.1:${SERVE_PORT}/`;

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChromium() {
  return CHROMIUM_CANDIDATES.find((p) => existsSync(p)) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { tries = 50, delay = 100, label = 'condition' } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // keep polling
    }
    await sleep(delay);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Minimal DevTools Protocol client over a single page target's WebSocket. */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        (this.events.get(msg.method) || []).forEach((cb) => cb(msg.params));
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  once(method) {
    return new Promise((resolve) => {
      const list = this.events.get(method) || [];
      const cb = (params) => {
        this.events.set(method, (this.events.get(method) || []).filter((f) => f !== cb));
        resolve(params);
      };
      this.events.set(method, [...list, cb]);
    });
  }

  async evalValue(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text || 'evaluate threw');
    return result.value;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// Teardown callbacks (kill server/browser, remove temp profile), run on every
// exit path so a failure never leaks a spawned process.
const cleanup = [];
function finish(code) {
  for (const fn of cleanup.reverse()) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
  process.exit(code);
}

async function main() {
  const chromium = findChromium();
  if (!chromium) {
    console.log('SKIP: no Chromium binary found (set CHROMIUM_PATH to run the smoke test).');
    process.exit(0);
  }

  // 1. Static server.
  const server = spawn(process.execPath, [join(ROOT, 'serve.js')], {
    env: { ...process.env, PORT: String(SERVE_PORT) },
    stdio: 'ignore',
  });
  cleanup.push(() => server.kill());
  await waitFor(async () => (await fetch(PAGE_URL)).ok, { label: 'static server' });

  // 2. Headless Chromium with remote debugging.
  const profile = mkdtempSync(join(tmpdir(), 'ellipse-smoke-'));
  cleanup.push(() => rmSync(profile, { recursive: true, force: true }));
  const browser = spawn(chromium, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });
  cleanup.push(() => browser.kill());

  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  }, { label: 'Chromium DevTools endpoint', tries: 80 });

  // 3. Connect and load the page.
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  cleanup.push(() => ws.close());
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // Fail loudly on an uncaught page exception (e.g. a module-init crash).
  let pageError = null;
  cdp.events.set('Runtime.exceptionThrown', [
    (p) => (pageError = p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || 'page exception'),
  ]);

  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: PAGE_URL });
  await loaded;

  // 4. Wait for the module to solve and populate the export box, then read state.
  const snapshot = await waitFor(async () => {
    const s = await cdp.evalValue(`JSON.stringify({
      path: document.getElementById('export-path').value,
      arcParam: document.getElementById('export-arc-param').value,
      results: document.getElementById('results').textContent,
      error: (document.getElementById('error-box').style.display !== 'none')
        ? document.getElementById('error-box').textContent : null,
      viewBox: document.getElementById('canvas').getAttribute('viewBox'),
    })`);
    const parsed = JSON.parse(s);
    return parsed.path ? parsed : null;
  }, { label: 'populated export box', tries: 50 });

  // 5. Assertions.
  assert(!pageError, `no uncaught page exception (got: ${pageError})`);
  assert(!snapshot.error, `default inputs solve without error (got: ${snapshot.error})`);
  assert(/^M\s/.test(snapshot.path), 'path starts with an absolute move (M)');
  assert(/\sa\s/.test(snapshot.path), 'path uses a relative arc (a) command');

  const arc = JSON.parse(snapshot.arcParam);
  assert(arc.type === 'ARC', 'ARC param has type ARC');
  assert(Number.isFinite(arc.rx) && Number.isFinite(arc.ry), 'ARC param radii are numbers');
  assert(['CLOCKWISE', 'COUNTER_CLOCKWISE'].includes(arc.direction), 'ARC direction is a valid enum');
  assert(['LARGE', 'SMALL'].includes(arc.arc_size), 'ARC arc_size is a valid enum');

  assert(/rx/.test(snapshot.results), 'results panel shows rx');
  // fitToContent must frame the geometry, not sit at the raw default viewBox.
  const vb = (snapshot.viewBox || '').split(/\s+/).map(Number);
  assert(vb.length === 4 && vb.every(Number.isFinite), 'viewBox is four finite numbers');

  // 6. Click through every fifth-constraint mode. The default page only ever
  // exercises "roundest", so this is the one guard that the mode-switch,
  // control-sync (slider/text/none field kinds), and per-mode drawing/panel
  // wiring all survive \u2014 the class of regression the module split could
  // introduce. Each click must not throw and must leave the page responsive
  // (an unsolvable value shows the error box, which is fine); the final
  // "roundest" click must land back on a solved ellipse with a fresh arc.
  const modes = await cdp.evalValue(
    `Array.from(document.querySelectorAll('#mode-buttons button')).map((b) => b.dataset.mode)`,
  );
  assert(Array.isArray(modes) && modes.length >= 6, 'mode buttons are present');
  for (const mode of [...modes, 'roundest']) {
    await cdp.evalValue(`document.querySelector('#mode-buttons button[data-mode="${mode}"]').click(); true`);
    await sleep(30);
    assert(!pageError, `mode "${mode}" click throws no page exception (got: ${pageError})`);
    const responsive = await cdp.evalValue(
      `!!document.getElementById('results') && !!document.getElementById('canvas').getAttribute('viewBox')`,
    );
    assert(responsive, `mode "${mode}" leaves the page responsive`);
  }
  const afterCycle = JSON.parse(
    await cdp.evalValue(`JSON.stringify({
      path: document.getElementById('export-path').value,
      results: document.getElementById('results').textContent,
      error: (document.getElementById('error-box').style.display !== 'none')
        ? document.getElementById('error-box').textContent : null,
    })`),
  );
  assert(!afterCycle.error, `back on "roundest" solves without error (got: ${afterCycle.error})`);
  assert(/^M\s/.test(afterCycle.path), 'roundest re-exports a well-formed path after cycling modes');

  console.log('PASS: page boots, solves, exports a well-formed arc, and cycles all modes.');
  console.log(`  path:     ${snapshot.path}`);
  console.log(`  ARC type: ${arc.type} ${arc.direction} ${arc.arc_size}`);
  finish(0);
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  finish(1);
});
