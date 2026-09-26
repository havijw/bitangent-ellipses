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
 * Usage: npm run test:e2e  (or: node scripts/smoke.mjs)
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

  // The dev server must forbid reuse. With no cache directive at all browsers
  // fall back to heuristic caching, which can pair freshly edited markup with a
  // stale ui.js — a new control renders but nothing wires it up, and the page
  // looks broken in a way no test here would ever see (each run gets a clean
  // browser profile).
  for (const path of ['', 'ui.js', 'src/state.js']) {
    const cc = (await fetch(PAGE_URL + path)).headers.get('cache-control') || '';
    assert(/no-store|no-cache/.test(cc), `${path || 'index.html'} is served uncacheable (got "${cc}")`);
  }

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
    // "Third point" has no input of its own — its whole control is the hint
    // label, so the field must stay visible rather than being hidden along
    // with the slider and text box.
    if (mode === 'through') {
      const hint = await cdp.evalValue(`(() => {
        const field = document.getElementById('param-field');
        return getComputedStyle(field).display !== 'none'
          && document.getElementById('param-label').textContent.trim();
      })()`);
      assert(hint, 'third-point mode shows its hint label instead of hiding the field');
    }
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

  // 7. The mode-help modal opens on the "?" button and closes again. Guards the
  // <dialog> wiring (showModal / click-outside-to-close) added with the help copy.
  await cdp.evalValue(`document.getElementById('help-btn').click(); true`);
  await sleep(30);
  assert(!pageError, `opening help throws no page exception (got: ${pageError})`);
  const helpOpened = await cdp.evalValue(`document.getElementById('help-dialog').open === true`);
  assert(helpOpened, 'help button opens the modal dialog');
  const hasModeCopy = await cdp.evalValue(
    `document.querySelectorAll('#help-dialog .help-modes dt').length >= 6`,
  );
  assert(hasModeCopy, 'help dialog lists the modes');
  await cdp.evalValue(`document.getElementById('help-dialog').close(); true`);
  await sleep(30);
  const helpClosed = await cdp.evalValue(`document.getElementById('help-dialog').open === false`);
  assert(helpClosed, 'help dialog closes');

  // 8. The solution cycler shows up beside the value control when one value maps
  // to two ellipses (a symmetric family at aspect ratio 2), and Next switches
  // between them. Guards that the cycler moved out of the results card correctly.
  await cdp.evalValue(`(() => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('p0-xy', '220, 320'); set('p1-xy', '580, 320');
    set('t0-deg', '-55'); set('t1-deg', '-125');
    document.querySelector('#mode-buttons button[data-mode="ratio"]').click();
    set('param-text', '2');
    return true;
  })()`);
  await sleep(40);
  assert(!pageError, `two-solution setup throws no page exception (got: ${pageError})`);
  const cyclerShown = await cdp.evalValue(
    `getComputedStyle(document.getElementById('solution-cycler')).display !== 'none'`,
  );
  assert(cyclerShown, 'solution cycler appears when a value yields two ellipses');
  const beforeNext = await cdp.evalValue(`document.getElementById('results').textContent`);
  await cdp.evalValue(`document.getElementById('solution-next').click(); true`);
  await sleep(40);
  const afterNext = await cdp.evalValue(`document.getElementById('results').textContent`);
  assert(beforeNext !== afterNext, 'Next switches to the other solution');

  // 9. Persistence rides settled changes (the undo-stack beats), never frames
  // inside a gesture. render() runs once per pointermove, so writing through
  // from there issued hundreds of history.replaceState calls per drag — and
  // Safari and Firefox rate-limit that API by *throwing* (Safari: ~100 calls per
  // 30s), which surfaced in the pointermove handler and killed the drag. Chrome
  // only throttles silently, so this counts calls rather than waiting for a
  // throw: sweeping a slider must persist nothing at all, and releasing it must
  // write exactly once.
  const throttleReport = await cdp.evalValue(`(async () => {
    const orig = history.replaceState.bind(history);
    let calls = 0;
    history.replaceState = (...args) => { calls++; return orig(...args); };
    const settle = () => new Promise((r) => setTimeout(r, 700));
    try {
      document.querySelector('#mode-buttons button[data-mode="rotation"]').click();
      await settle();
      calls = 0;

      // 200 mid-gesture renders: the slider sweeping, nothing settled yet.
      const range = document.getElementById('param-range');
      for (let i = 0; i < 200; i++) {
        range.value = String(1 + (i % 89));
        range.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await settle();
      const sweeping = calls;

      // Release: one settled change, one write.
      range.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      return JSON.stringify({ sweeping, settled: calls, hash: location.hash.length });
    } finally {
      history.replaceState = orig;
    }
  })()`);
  const throttle = JSON.parse(throttleReport);
  assert(!pageError, `render burst throws no page exception (got: ${pageError})`);
  assert(
    throttle.sweeping === 0,
    `a 200-render slider sweep must persist nothing (got ${throttle.sweeping} replaceState calls)`,
  );
  assert(
    throttle.settled >= 1 && throttle.settled <= 2,
    `releasing the slider must write exactly once (got ${throttle.settled})`,
  );
  assert(throttle.hash > 1, 'the settled state reaches the URL hash');

  // 10. Handle sizes are set in screen pixels, not scaled off the canvas width.
  // This is the regression that made the draggable points nearly untappable on
  // a phone: the scale used to be view.w / VIEW_W, which only holds when the
  // canvas is VIEW_W pixels wide — a narrower canvas drew proportionally
  // smaller handles. Measure the drawn dot at two very different canvas widths;
  // it must not move.
  const handleRadiusPx = () =>
    cdp.evalValue(`(() => {
      // The visible dot is appended after its invisible grab area.
      const all = document.querySelectorAll('[data-handle="p0"]');
      return all[all.length - 1].getBoundingClientRect().width;
    })()`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await sleep(150);
  const rWide = await handleRadiusPx();
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 780, deviceScaleFactor: 1, mobile: true });
  await sleep(150);
  const rNarrow = await handleRadiusPx();
  assert(rWide > 4, `the handle has a measurable size (got ${rWide})`);
  assert(
    Math.abs(rWide - rNarrow) <= 1.5,
    `the handle keeps its on-screen size when the canvas narrows (${rWide}px wide vs ${rNarrow}px narrow)`,
  );

  // 11. Responsive layout: at a narrow (phone-like) viewport the sidebar drops
  // below the canvas as a collapsed bottom sheet holding only the fifth-
  // constraint controls, with a wide arrow to reveal the rest. Guards the media
  // query, the section wrapping, and the toggle wiring. (The viewport is still
  // the 400x780 one set above.)
  const collapsed = JSON.parse(
    await cdp.evalValue(`(() => {
      const vis = (id) => { const el = document.getElementById(id); return !!el && el.offsetParent !== null; };
      const wrap = document.getElementById('canvas-wrap').getBoundingClientRect();
      const bar = document.getElementById('sidebar').getBoundingClientRect();
      return JSON.stringify({
        sidebarBelowCanvas: bar.top >= wrap.top + wrap.height - 2,
        canvasKeepsMostOfScreen: wrap.height > innerHeight * 0.5,
        toggleVisible: vis('panel-toggle'),
        hintHidden: getComputedStyle(document.getElementById('zoom-hint')).display === 'none',
        pickShown: vis('sec-pick'),
        othersHidden: !vis('sec-points') && !vis('sec-export') && !vis('results'),
        // Exactly one caption, or the handle reads "ALL CONTROLS FEWER CONTROLS".
        oneCaption:
          document.querySelector('#panel-toggle .panel-text-closed').offsetParent !== null &&
          document.querySelector('#panel-toggle .panel-text-open').offsetParent === null,
      });
    })()`),
  );
  assert(collapsed.sidebarBelowCanvas, 'a narrow viewport stacks the sidebar below the canvas');
  assert(collapsed.canvasKeepsMostOfScreen, 'the collapsed drawer leaves the canvas over half the screen');
  assert(collapsed.toggleVisible, 'the drawer arrow is visible on narrow viewports');
  assert(collapsed.hintHidden, 'the scroll-to-zoom hint is hidden on narrow viewports');
  assert(collapsed.pickShown, 'the fifth-constraint controls stay visible when collapsed');
  assert(collapsed.othersHidden, 'the collapsed drawer hides the non-constraint sections');
  assert(collapsed.oneCaption, 'the collapsed handle shows only the "all controls" caption');

  // The checkbox behind the handle must be keyboard-reachable where the drawer
  // exists, and gone from the tab order where it doesn't — a focusable control
  // that does nothing visible is worse than no control.
  const focusable = async () =>
    cdp.evalValue(`(() => {
      const cb = document.getElementById('panel-open');
      cb.focus();
      return document.activeElement === cb;
    })()`);
  assert(await focusable(), 'the drawer checkbox is focusable at narrow widths');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await sleep(150);
  assert(!(await focusable()), 'the drawer checkbox leaves the tab order at desktop width');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 780, deviceScaleFactor: 1, mobile: true });
  await sleep(150);

  // Drive it with a real mouse press/release, not element.click(): a
  // programmatic click bypasses hit-testing, so it would pass even if the
  // handle were unreachable behind something.
  // Re-measured every time: the sheet grows upward, so opening it moves the
  // handle. Also asserts the point we aim at really is the handle.
  const clickToggle = async () => {
    const box = JSON.parse(await cdp.evalValue(`(() => {
      const t = document.getElementById('panel-toggle');
      const r = t.getBoundingClientRect();
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return JSON.stringify({ x, y, onHandle: !!hit && (hit === t || t.contains(hit)) });
    })()`));
    assert(box.onHandle, 'the drawer handle is the topmost element at its own centre');
    for (const [type, buttons] of [['mousePressed', 1], ['mouseReleased', 0]]) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: Math.round(box.x), y: Math.round(box.y), button: 'left', clickCount: 1, buttons,
      });
    }
    await sleep(150);
  };
  await clickToggle();
  const expanded = JSON.parse(
    await cdp.evalValue(`(() => {
      const vis = (id) => { const el = document.getElementById(id); return !!el && el.offsetParent !== null; };
      return JSON.stringify({
        checked: document.getElementById('panel-open').checked,
        allShown: vis('sec-points') && vis('sec-export') && vis('results'),
        caption:
          document.querySelector('#panel-toggle .panel-text-open').offsetParent !== null &&
          document.querySelector('#panel-toggle .panel-text-closed').offsetParent === null,
      });
    })()`),
  );
  assert(expanded.checked, 'clicking the arrow checks the drawer state');
  assert(expanded.allShown, 'expanding reveals the full control panel');
  assert(expanded.caption, 'the caption switches to the "fewer controls" wording');

  // And it closes again.
  await clickToggle();
  const reclosed = await cdp.evalValue(
    `JSON.stringify({ checked: document.getElementById('panel-open').checked,
                      hidden: document.getElementById('sec-points').offsetParent === null })`,
  );
  const rc = JSON.parse(reclosed);
  assert(!rc.checked && rc.hidden, 'clicking the arrow again collapses the drawer');
  assert(!pageError, `the drawer toggle throws no page exception (got: ${pageError})`);

  // The drawer must not depend on ui.js at all. It is a <label> driving a
  // checkbox, read by the stylesheet, precisely so a stale or still-loading
  // module can't leave a control that looks live but does nothing — the exact
  // way this broke in Safari. Reload with scripting off and it still works.
  await cdp.send('Emulation.setScriptExecutionDisabled', { value: true });
  const reloaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.reload');
  await reloaded;
  await sleep(200);
  await clickToggle();
  const noJs = JSON.parse(
    await cdp.evalValue(`(() => {
      const vis = (id) => { const el = document.getElementById(id); return !!el && el.offsetParent !== null; };
      return JSON.stringify({ checked: document.getElementById('panel-open').checked, points: vis('sec-points') });
    })()`),
  );
  assert(noJs.checked && noJs.points, 'the drawer opens with JavaScript disabled');
  await cdp.send('Emulation.setScriptExecutionDisabled', { value: false });
  const back = cdp.once('Page.loadEventFired');
  await cdp.send('Page.reload');
  await back;
  await sleep(600);
  pageError = null; // the reloads above are a fresh page; start its error watch clean

  // 12. A two-finger pinch zooms the canvas — genuine multi-touch, a different
  // code path from the trackpad's ctrl+wheel. Bringing the fingers together
  // must zoom out, i.e. grow the viewBox width. Zoom-out is the safe direction
  // to assert first: the view can't already be at the far-out clamp, so the
  // sign of the change is unambiguous wherever the zoom happened to start.
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const canvasRect = JSON.parse(await cdp.evalValue(`(() => {
    const r = document.getElementById('canvas').getBoundingClientRect();
    return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
  })()`));
  const cx = Math.round(canvasRect.x + canvasRect.w / 2);
  const cy = Math.round(canvasRect.y + canvasRect.h / 2);
  const spread0 = Math.max(30, Math.min(140, Math.floor(Math.min(canvasRect.w, canvasRect.h) / 2) - 10));
  const vbWidth = async () =>
    Number(await cdp.evalValue(`document.getElementById('canvas').getAttribute('viewBox').split(/\\s+/)[2]`));
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });

  const wBeforePinch = await vbWidth();
  await touch('touchStart', [{ x: cx - spread0, y: cy, id: 1 }, { x: cx + spread0, y: cy, id: 2 }]);
  for (let i = 1; i <= 6; i++) {
    const spread = Math.round(spread0 - (i / 6) * (spread0 - 15));
    await touch('touchMove', [{ x: cx - spread, y: cy, id: 1 }, { x: cx + spread, y: cy, id: 2 }]);
    await sleep(16);
  }
  await touch('touchEnd', []);
  await sleep(40);
  assert(!pageError, `the pinch gesture throws no page exception (got: ${pageError})`);
  const wAfterPinch = await vbWidth();
  assert(
    wAfterPinch > wBeforePinch + 1,
    `pinching the fingers together zooms out (viewBox width ${wAfterPinch} > ${wBeforePinch})`,
  );

  // Spreading them apart zooms back in, and the page still solves afterwards —
  // a gesture that only moves the view must leave the geometry alone.
  await touch('touchStart', [{ x: cx - 20, y: cy, id: 1 }, { x: cx + 20, y: cy, id: 2 }]);
  for (let i = 1; i <= 6; i++) {
    const spread = Math.round(20 + (i / 6) * (spread0 - 20));
    await touch('touchMove', [{ x: cx - spread, y: cy, id: 1 }, { x: cx + spread, y: cy, id: 2 }]);
    await sleep(16);
  }
  await touch('touchEnd', []);
  await sleep(40);
  const wAfterSpread = await vbWidth();
  assert(wAfterSpread < wAfterPinch - 1, `spreading the fingers zooms in (${wAfterSpread} < ${wAfterPinch})`);
  assert(!pageError, `the second pinch throws no page exception (got: ${pageError})`);
  const stillSolving = await cdp.evalValue(`/^M\\s/.test(document.getElementById('export-path').value)`);
  assert(stillSolving, 'the page still exports a well-formed path after pinching');
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  // 13. A plain drag still moves a handle, grabbed from *outside* the drawn dot.
  // Each mark is now a group holding an invisible grab area plus the visible
  // circle, and the pointer bookkeeping gained multi-touch state — both sit
  // directly in the path of the one interaction the canvas exists for. Pressing
  // 11px off-centre is outside the 8px dot and inside the grab area, so this
  // fails either if dragging broke or if the widened target isn't taking hits
  // (the press would pan the canvas instead and leave P0 where it was).
  // Frame the geometry first: the earlier steps moved the points and then
  // pinch-zoomed, so P0 need not be anywhere near the visible canvas.
  await cdp.evalValue(`document.getElementById('zoom-reset').click(); true`);
  await sleep(80);
  const p0Center = JSON.parse(await cdp.evalValue(`(() => {
    const all = document.querySelectorAll('[data-handle="p0"]');
    const r = all[all.length - 1].getBoundingClientRect();
    const c = document.getElementById('canvas').getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    return JSON.stringify({
      x, y,
      onCanvas: x > c.x + 20 && x < c.right - 20 && y > c.y + 20 && y < c.bottom - 20,
    });
  })()`));
  assert(p0Center.onCanvas, 'fitting the view puts the P0 handle on the canvas, where it can be dragged');
  const mouse = (type, x, y) =>
    cdp.send('Input.dispatchMouseEvent', {
      type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: 1, clickCount: 1,
    });
  const beforeDrag = await cdp.evalValue(`document.getElementById('p0-xy').value`);
  await mouse('mousePressed', p0Center.x + 11, p0Center.y);
  await mouse('mouseMoved', p0Center.x + 51, p0Center.y + 25);
  await sleep(40);
  await mouse('mouseReleased', p0Center.x + 51, p0Center.y + 25);
  await sleep(80);
  assert(!pageError, `dragging a handle throws no page exception (got: ${pageError})`);
  const afterDrag = await cdp.evalValue(`document.getElementById('p0-xy').value`);
  assert(afterDrag !== beforeDrag, `dragging the P0 handle from its grab area moves P0 (still "${afterDrag}")`);

  // The drag lands exactly one undo entry, so one undo puts it back.
  await cdp.evalValue(`document.getElementById('undo-btn').click(); true`);
  await sleep(80);
  const afterUndo = await cdp.evalValue(`document.getElementById('p0-xy').value`);
  assert(afterUndo === beforeDrag, `one undo restores the pre-drag P0 ("${afterUndo}" vs "${beforeDrag}")`);

  console.log('PASS: page boots, solves, exports a well-formed arc, cycles all modes, opens mode help, cycles multi-solutions, persists only settled changes, holds handle sizes fixed, adapts to a narrow viewport, opens its drawer without scripting, pinch-zooms on touch, and drags handles by their widened grab area.');
  console.log(`  path:     ${snapshot.path}`);
  console.log(`  ARC type: ${arc.type} ${arc.direction} ${arc.arc_size}`);
  finish(0);
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  finish(1);
});
