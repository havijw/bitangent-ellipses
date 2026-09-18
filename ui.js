/**
 * Browser UI for the two-tangent ellipse tool — the orchestrator.
 *
 * This file owns the mutable app state, the view (pan/zoom), the single
 * render/solve cycle, event wiring, and persistence. The pieces it drives are
 * modular: pure logic lives in `src/*.js` (math, state, formatting) and the
 * view layer lives in `src/ui/*.js` (generic DOM builders, canvas drawing,
 * sidebar panels). Everything here reads as "gather the current state, solve,
 * and hand the result to the drawing/panel functions".
 *
 * The canvas is a plain SVG element using the browser's native (y-down)
 * coordinate convention, and all solving happens directly in those same
 * coordinates — so the dashed "full ellipse" polyline and the solid arc path
 * drawn on top of it are produced by the exact same math the SVG export uses,
 * with `yUp: false`. That overlay coinciding pixel-for-pixel is the built-in
 * correctness check. The "Y-axis points up" toggle only affects the text in
 * the export boxes, for pasting into a renderer that uses the opposite
 * convention; it does not change what's drawn here.
 */

import { EllipseFamily, familySolutions, continuityParam, matchSolutionIndex } from './src/ellipse.js';
import { chooseArc } from './src/svg.js';
import {
  VIEW_W,
  VIEW_H,
  DEFAULT_VIEW,
  defaultState,
  withDefaults,
  serializeState,
  deserializeState,
  decodeHash,
  parsePoint,
  parseNumber,
  contentBounds,
  controlPointsBounds,
  fitView,
  zoomView,
  pointInView,
  History,
} from './src/state.js';
import { el } from './src/ui/dom.js';
import { drawGrid, drawStaticGeometry, drawEllipseOverlay, drawArcOverlay, drawHandles } from './src/ui/scene.js';
import { renderResults, renderSolutionCycler, renderExports, syncControlsFromState } from './src/ui/panels.js';

const svg = document.getElementById('canvas');
const HANDLE_LEN = 70;

// The visible window into world space, as an SVG viewBox. Panning shifts x/y;
// zooming scales w/h about the cursor. It is deliberately kept out of `state`
// (and the URL hash) so a shared configuration link doesn't pin the viewer to
// whatever zoom the author happened to leave it at.
let view = { ...DEFAULT_VIEW };

// World units per default unit; used to keep point/handle sizes and the
// tangent-handle offset constant on screen regardless of zoom.
let sizeScale = 1;

// The most recently solved ellipse, or null when the inputs have no ellipse.
// `fitToContent` reads it to frame the view around the actual geometry.
let lastEllipse = null;
let lastSolution = null; // full solution object of the displayed ellipse (carries apex `a`)

function applyView() {
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  sizeScale = view.w / VIEW_W;
}

/** Zoom by `factor` (>1 zooms out) about a fixed screen fraction (fx, fy) in [0,1]. */
function zoomAbout(factor, fx, fy) {
  view = zoomView(view, factor, fx, fy);
  render();
}

// Last observed pixel size of the canvas element, so a resize can preserve the
// current world-units-per-pixel scale.
let canvasPixels = null;

/**
 * Keep the viewBox's aspect ratio matched to the canvas element's pixel aspect
 * ratio. The SVG has no explicit preserveAspectRatio, so a mismatch letterboxes
 * the viewBox (uniform scale + centering) and leaves the grid cut off along one
 * pair of edges. Recompute view.w/view.h from the element's size — holding
 * world-units-per-pixel constant and the view centered — so the grid always
 * fills the element and content keeps its on-screen scale across a resize.
 */
function syncViewToCanvas() {
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const upp = canvasPixels && canvasPixels.w ? view.w / canvasPixels.w : view.w / rect.width;
  const cx = view.x + view.w / 2;
  const cy = view.y + view.h / 2;
  view.w = rect.width * upp;
  view.h = rect.height * upp;
  view.x = cx - view.w / 2;
  view.y = cy - view.h / 2;
  canvasPixels = { w: rect.width, h: rect.height };
  render();
}

if (typeof ResizeObserver !== 'undefined') {
  // Fires once immediately (a no-op given the scale is already consistent) and
  // then on every subsequent canvas resize.
  new ResizeObserver(syncViewToCanvas).observe(svg);
}

// Re-render on a live OS light/dark switch so the canvas grid (whose color is
// read from the --grid CSS variable) tracks the theme without a reload. The
// panel chrome updates on its own via the CSS variables.
if (typeof matchMedia === 'function') {
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => render());
}

// Key for the persisted configuration.
const STORAGE_KEY = 'ellipse-tool:state';

// Restore the last configuration on load. A URL hash wins (so a shared link
// pins its own state), then the browser's localStorage (so reopening the bare
// page picks up where you left off), and finally the built-in defaults.
let state = withDefaults(loadStateFromHash() ?? loadStateFromStorage());

// ---------------------------------------------------------------------------
// SVG scaffolding (built once; contents of the dynamic groups get replaced)
// ---------------------------------------------------------------------------

applyView();
const gridGroup = el('g');
const staticGroup = el('g'); // tangent lines, chord
const ellipseGroup = el('g'); // dashed full ellipse
const arcGroup = el('g'); // solid arc overlay
const handlesGroup = el('g'); // draggable points/handles
svg.append(gridGroup, staticGroup, ellipseGroup, arcGroup, handlesGroup);

// ---------------------------------------------------------------------------
// Solving: build the family and pick the member for the current mode
// ---------------------------------------------------------------------------

function buildFamily() {
  return new EllipseFamily(state.p0, { deg: state.t0Deg }, state.p1, { deg: state.t1Deg });
}

/**
 * Solve the current mode, returning `{ solutions, rejected }` — the real
 * ellipses, and the non-ellipse candidates the constraint produced instead.
 * `rejected` is what lets the error message name the shape actually hit ("got
 * a parabola instead") rather than a bare "no ellipse", so it has to be
 * carried through here rather than dropped.
 */
function currentSolutions(family) {
  // The mode dispatch and its guards live in ellipse.js so this and the
  // headless solveEllipse entry point can never diverge. 'through' takes the
  // third point; every other mode takes the numeric slider/field value.
  const param = state.mode === 'through' ? state.paramPoint : state.param;
  return familySolutions(family, state.mode, param);
}

/**
 * The arc to draw/export for `ellipse`: honor an explicit small/large choice
 * if the user made one, otherwise follow the signed tangent leaving P0. `yUp`
 * flips the sweep for the export convention; the canvas always passes false.
 */
function pickArc(family, ellipse, yUp = false) {
  if (state.arcChoice === 'small' || state.arcChoice === 'large') {
    return chooseArc(ellipse, family.p0, family.p1, { yUp, preferLargeArc: state.arcChoice === 'large' });
  }
  return chooseArc(ellipse, family.p0, family.p1, {
    yUp,
    tangentAtP0: { dir: family.d0, signed: true },
  });
}

// ---------------------------------------------------------------------------
// Main render/solve cycle
// ---------------------------------------------------------------------------

function showError(err) {
  const box = document.getElementById('error-box');
  // Solver problems arrive as EllipseInputError and the "no solution" notes as
  // plain `{ message }`; anything else is a bug leaking through, so fall back
  // to its string form rather than showing an empty box.
  box.textContent = err?.message || String(err);
  box.style.display = 'block';
}

// Re-solve when the user cycles to another solution of a multi-valued mode.
function onCycleSolution(nextIndex) {
  state.solutionIndex = nextIndex;
  render();
  commitChange();
}

function render() {
  syncControlsFromState(state);
  applyView();
  drawGrid(gridGroup, view);

  // Reset each cycle; set again below only when an ellipse is actually solved.
  lastEllipse = null;
  lastSolution = null;

  const errorBox = document.getElementById('error-box');
  let family;
  try {
    family = buildFamily();
  } catch (err) {
    showError(err);
    drawStaticGeometry(staticGroup, state, null, view, sizeScale);
    ellipseGroup.innerHTML = '';
    arcGroup.innerHTML = '';
    renderResults(state, [], 0);
    renderSolutionCycler([], 0, onCycleSolution);
    renderExports(state, null, null);
    drawHandles(handlesGroup, state, sizeScale, HANDLE_LEN);
    return;
  }

  drawStaticGeometry(staticGroup, state, family, view, sizeScale);

  let solutions;
  let rejected;
  try {
    ({ solutions, rejected } = currentSolutions(family));
  } catch (err) {
    showError(err);
    ellipseGroup.innerHTML = '';
    arcGroup.innerHTML = '';
    renderResults(state, [], 0);
    renderSolutionCycler([], 0, onCycleSolution);
    renderExports(state, family, null);
    drawHandles(handlesGroup, state, sizeScale, HANDLE_LEN);
    return;
  }

  errorBox.style.display = 'none';

  if (solutions.length === 0) {
    const note = rejected.length
      ? `No ellipse satisfies this constraint (got a ${rejected[0].kind} instead). Try a different value.`
      : 'No ellipse satisfies this constraint. Try a different value.';
    showError({ message: note });
    ellipseGroup.innerHTML = '';
    arcGroup.innerHTML = '';
    renderResults(state, [], 0);
    renderSolutionCycler([], 0, onCycleSolution);
    renderExports(state, family, null);
    drawHandles(handlesGroup, state, sizeScale, HANDLE_LEN);
    return;
  }

  // Clamp at both ends: `solutionIndex` is restored from the URL hash and
  // localStorage, and a negative one would index past the start of the array
  // and throw below, outside any try/catch — a blank page. `withDefaults`
  // screens the restored value too; this is the runtime backstop.
  const index = Math.min(Math.max(0, state.solutionIndex), solutions.length - 1);
  const solution = solutions[index];
  lastEllipse = solution.ellipse;
  lastSolution = solution;

  drawEllipseOverlay(ellipseGroup, solution.ellipse, sizeScale);
  // The canvas is always y-down; the export boxes may use the opposite
  // convention, whose sweep flag differs, so recompute the arc per convention.
  const canvasArc = pickArc(family, solution.ellipse, false);
  const exportArc = pickArc(family, solution.ellipse, state.yUp);
  drawArcOverlay(arcGroup, family, solution.ellipse, canvasArc);
  renderResults(state, solutions, index);
  renderSolutionCycler(solutions, index, onCycleSolution);
  renderExports(state, family, solution.ellipse, exportArc, canvasArc);
  drawHandles(handlesGroup, state, sizeScale, HANDLE_LEN);
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------
// Tracks the geometry and fifth-constraint controls: the two points, the two
// tangent angles, the constraint mode, its parameter (slider/text or third
// point), and which solution is selected. The SVG-export controls (y-up and
// the small/large arc toggle) are intentionally excluded, so undoing a point
// move never quietly flips your export settings.
//
// Continuous gestures (dragging a handle, sliding the apex range) fire render
// on every step but commit a single entry when the gesture ends, so one drag is
// one undo — not hundreds. Persistence hangs off those same commit points via
// `commitChange()`, which is why mid-gesture state is never stored: what gets
// written is exactly what you could undo back to. The two excluded export
// controls persist on their own, without touching the stack.
//
// The stack logic itself is the pure History class; this file only supplies
// snapshots and applies what comes back.

const TRACKED_KEYS = ['p0', 'p1', 't0Deg', 't1Deg', 'mode', 'param', 'paramPoint', 'solutionIndex'];
const undoHistory = new History(200);

/** Serialize just the tracked slice of state (used as a history snapshot). */
function trackedSnapshot() {
  const slice = {};
  for (const k of TRACKED_KEYS) slice[k] = state[k];
  return JSON.stringify(slice);
}

function initHistory() {
  undoHistory.init(trackedSnapshot());
  updateHistoryButtons();
}

/** Record the current tracked state as a new history entry, if it changed. */
function commitHistory() {
  if (undoHistory.commit(trackedSnapshot())) updateHistoryButtons();
}

/**
 * A change is finished: record it for undo and write it out.
 *
 * Persistence rides the same beats as the undo stack — the end of a gesture,
 * never a frame inside one. A drag or a slider sweep re-renders continuously
 * but only lands here on release, so the stored state is exactly the state you
 * could undo back to, and an in-progress gesture costs nothing to persist.
 */
function commitChange() {
  commitHistory();
  persist();
}

/** Overlay a restored snapshot onto the live state and redraw. */
function applySnapshot(snap) {
  Object.assign(state, JSON.parse(snap));
  render();
  updateHistoryButtons();
  persist();
}

function undo() {
  const snap = undoHistory.undo();
  if (snap !== null) applySnapshot(snap);
}

function redo() {
  const snap = undoHistory.redo();
  if (snap !== null) applySnapshot(snap);
}

function updateHistoryButtons() {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  if (undoBtn) undoBtn.disabled = !undoHistory.canUndo();
  if (redoBtn) redoBtn.disabled = !undoHistory.canRedo();
}

document.getElementById('undo-btn').addEventListener('click', undo);
document.getElementById('redo-btn').addEventListener('click', redo);

document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key.toLowerCase() !== 'z' && e.key.toLowerCase() !== 'y') return;
  // Leave native text-editing undo alone while a field is focused.
  const t = document.activeElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  e.preventDefault();
  const isRedo = e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey);
  if (isRedo) redo();
  else undo();
});

// ---------------------------------------------------------------------------
// Controls: text inputs, mode buttons, arc toggle, y-up toggle
// ---------------------------------------------------------------------------

document.getElementById('p0-xy').addEventListener('change', (e) => {
  const p = parsePoint(e.target.value);
  if (p) state.p0 = p;
  render();
  commitChange();
});
document.getElementById('p1-xy').addEventListener('change', (e) => {
  const p = parsePoint(e.target.value);
  if (p) state.p1 = p;
  render();
  commitChange();
});
document.getElementById('through-xy').addEventListener('change', (e) => {
  const p = parsePoint(e.target.value);
  if (p) state.paramPoint = p;
  render();
  commitChange();
});
document.getElementById('t0-deg').addEventListener('change', (e) => {
  const v = parseNumber(e.target.value);
  if (v !== null) state.t0Deg = v;
  render();
  commitChange();
});
document.getElementById('t1-deg').addEventListener('change', (e) => {
  const v = parseNumber(e.target.value);
  if (v !== null) state.t1Deg = v;
  render();
  commitChange();
});

// ---------------------------------------------------------------------------
// Fifth-constraint continuity: switching modes keeps the same ellipse
// ---------------------------------------------------------------------------
// When the user switches to a different fifth-constraint mode, we don't hold
// the raw control value constant (rx and a ratio aren't comparable). Instead we
// set the new mode's value to whatever reproduces the currently displayed
// ellipse, so the shape doesn't jump. "Roundest" is the exception: it has no
// value to carry and deliberately overrides the current ellipse.

/**
 * Set the new mode's control value so solving it reproduces `prev` (the
 * currently displayed solution), and pick the matching solution index for the
 * value modes that can yield two members. The value/point derivation and the
 * index match are pure geometry (continuityParam / matchSolutionIndex in
 * ellipse.js); this only wires the result into `state`.
 */
function applyModeContinuity(mode, prev) {
  const carried = continuityParam(mode, prev, state.p0, state.p1);
  if ('param' in carried) state.param = carried.param;
  if ('paramPoint' in carried) state.paramPoint = carried.paramPoint;

  // ratio/rx/ry can produce two ellipses for one value; select the one whose
  // family position (apex `a`) matches the previous ellipse so it stays put.
  if (typeof prev.a === 'number') {
    let sols;
    try {
      sols = currentSolutions(buildFamily()).solutions;
    } catch {
      return;
    }
    if (sols.length > 1) state.solutionIndex = matchSolutionIndex(sols, prev.a);
  }
}

document.getElementById('mode-buttons').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const prevMode = state.mode;
  const prev = lastSolution;
  state.mode = btn.dataset.mode;
  state.solutionIndex = 0;
  // Carry the current ellipse across the switch. Skipped for "roundest" (which
  // intentionally overrides) and when there's no ellipse to carry or the mode
  // didn't actually change.
  if (prev && prev.ellipse && state.mode !== 'roundest' && state.mode !== prevMode) {
    applyModeContinuity(state.mode, prev);
  }
  // Safety net: apex needs a value in (0, 0.5); fall back if we couldn't derive one.
  if (state.mode === 'apex' && (typeof state.param !== 'number' || state.param <= 0 || state.param >= 0.5)) {
    state.param = 0.3;
  }
  render();
  // Reveal the third point when entering "through" mode (render() first so the
  // through-mode solution is in lastEllipse before we frame it).
  if (state.mode === 'through' && ensureThroughPointVisible()) render();
  commitChange();
});

document.getElementById('param-range').addEventListener('input', (e) => {
  state.param = Number(e.target.value);
  state.solutionIndex = 0;
  render();
});
// Commit one history entry when the slider is released, not per step.
document.getElementById('param-range').addEventListener('change', commitChange);
document.getElementById('param-text').addEventListener('input', (e) => {
  const v = parseNumber(e.target.value);
  if (v !== null) {
    state.param = v;
    state.solutionIndex = 0;
    render();
  }
});
document.getElementById('param-text').addEventListener('change', commitChange);

// The two export toggles persist but are deliberately left out of the undo
// stack (see TRACKED_KEYS), so they call `persist()` directly rather than going
// through `commitChange()` — otherwise undoing a point move would quietly flip
// your export settings back.
document.getElementById('yup-toggle').addEventListener('change', (e) => {
  state.yUp = e.target.checked;
  render();
  persist();
});

document.getElementById('arc-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.arcChoice = btn.dataset.arc;
  render();
  persist();
});

document.querySelectorAll('.copy-btn[data-copy]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const text = document.getElementById(btn.dataset.copy).value;
    navigator.clipboard?.writeText(text).catch(() => {});
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = original), 900);
  });
});

// Mode help modal. The native <dialog> handles the backdrop, Esc-to-close, and
// focus trapping; the close button submits its `method="dialog"` form. We only
// wire the opener and a click-outside-to-close.
const helpDialog = document.getElementById('help-dialog');
const helpBtn = document.getElementById('help-btn');
if (helpDialog && helpBtn) {
  helpBtn.addEventListener('click', () => helpDialog.showModal());
  helpDialog.addEventListener('click', (e) => {
    if (e.target === helpDialog) helpDialog.close();
  });
}

document.getElementById('reset-btn').addEventListener('click', () => {
  state = defaultState();
  render(); // solve the defaults so fitToContent has geometry to frame
  fitToContent();
  commitChange();
});

// ---------------------------------------------------------------------------
// Dragging, panning, and zooming
// ---------------------------------------------------------------------------

/** Screen-relative fractions [0,1] of the cursor within the canvas. */
function screenFraction(evt) {
  const rect = svg.getBoundingClientRect();
  return { fx: (evt.clientX - rect.left) / rect.width, fy: (evt.clientY - rect.top) / rect.height };
}

/** World coordinates under the cursor, accounting for the current pan/zoom. */
function svgPoint(evt) {
  const { fx, fy } = screenFraction(evt);
  return { x: view.x + fx * view.w, y: view.y + fy * view.h };
}

let dragging = null; // a handle id while dragging a point/handle
let panning = null; // { sx, sy, vx, vy } while panning the canvas

svg.addEventListener('pointerdown', (e) => {
  const handle = e.target.dataset?.handle;
  if (handle) {
    dragging = handle;
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('dragging');
    return;
  }
  // Empty canvas: start a pan.
  panning = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
  svg.setPointerCapture(e.pointerId);
  svg.classList.add('dragging');
});

svg.addEventListener('pointermove', (e) => {
  if (dragging) {
    const p = svgPoint(e);
    if (dragging === 'p0') state.p0 = p;
    else if (dragging === 'p1') state.p1 = p;
    else if (dragging === 'h0') state.t0Deg = (Math.atan2(p.y - state.p0.y, p.x - state.p0.x) * 180) / Math.PI;
    else if (dragging === 'h1') state.t1Deg = (Math.atan2(p.y - state.p1.y, p.x - state.p1.x) * 180) / Math.PI;
    else if (dragging === 'through') state.paramPoint = p;
    render();
    return;
  }
  if (panning) {
    const rect = svg.getBoundingClientRect();
    view.x = panning.vx - ((e.clientX - panning.sx) / rect.width) * view.w;
    view.y = panning.vy - ((e.clientY - panning.sy) / rect.height) * view.h;
    render();
  }
});

function endPointer() {
  const wasDragging = dragging !== null;
  dragging = null;
  panning = null;
  svg.classList.remove('dragging');
  // One history entry per completed handle drag (panning doesn't touch state).
  if (wasDragging) commitChange();
}
svg.addEventListener('pointerup', endPointer);
svg.addEventListener('pointercancel', endPointer);

// Wheel zoom, centered on the cursor.
svg.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const { fx, fy } = screenFraction(e);
    // Positive deltaY (scroll down) zooms out; the exponent keeps it smooth.
    zoomAbout(Math.exp(e.deltaY * 0.0015), fx, fy);
  },
  { passive: false },
);

/** Frame the current geometry: centered, padded, at the canvas aspect ratio. */
function fitToContent() {
  const rect = svg.getBoundingClientRect();
  const aspect = rect.width && rect.height ? rect.width / rect.height : VIEW_W / VIEW_H;
  const focus = { bounds: controlPointsBounds(state), anchor: state.p0 };
  view = fitView(contentBounds(state, lastEllipse), aspect, focus);
  render();
}

/**
 * When switching into "third point" mode, make sure the yellow third point is
 * on screen: if it's already visible, leave the view alone; otherwise fit to
 * the content (points + ellipse) so it comes into frame. Bails out without
 * changing the view if even that fit can't show the point — e.g. the ellipse
 * is so large the fit clamps and pushes the third point off screen. Returns
 * true if the view was changed. Call after a render() so `lastEllipse` is the
 * through-mode solution.
 */
function ensureThroughPointVisible() {
  const pt = state.paramPoint;
  if (pointInView(pt, view)) return false;
  const rect = svg.getBoundingClientRect();
  const aspect = rect.width && rect.height ? rect.width / rect.height : VIEW_W / VIEW_H;
  const focus = { bounds: controlPointsBounds(state), anchor: state.p0 };
  const candidate = fitView(contentBounds(state, lastEllipse), aspect, focus);
  if (!pointInView(pt, candidate)) return false;
  view = candidate;
  return true;
}

// Button controls zoom about the canvas center.
document.getElementById('zoom-in').addEventListener('click', () => zoomAbout(1 / 1.3, 0.5, 0.5));
document.getElementById('zoom-out').addEventListener('click', () => zoomAbout(1.3, 0.5, 0.5));
document.getElementById('zoom-reset').addEventListener('click', fitToContent);

// ---------------------------------------------------------------------------
// Persistence: URL hash (for sharing) + localStorage (across sessions).
// The (de)serialization is pure and lives in src/state.js; this is only the
// browser wiring (history, location, localStorage) around it.
// ---------------------------------------------------------------------------

// Persisting is driven by `commitChange()` — the same settled-change beats that
// feed the undo stack — not by `render()`. `render()` runs once per pointermove,
// so writing through from there issued hundreds of `history.replaceState` calls
// per drag, and Safari and Firefox rate-limit that API by *throwing* (Safari
// allows ~100 calls per 30s). The exception surfaced inside the pointermove
// handler and killed the drag mid-gesture, which is what made the tool feel
// broken in Safari and on mobile. Mid-gesture state isn't worth storing anyway:
// what gets written is exactly what you could undo back to.
//
// The trailing debounce below stays as a burst guard. Commit points are usually
// sparse, but held Cmd+Z repeats at the OS key rate (~30/s), which would spend
// Safari's budget in a few seconds. The debounce caps writes at
// 1 / PERSIST_DELAY_MS, and both writes are wrapped so a throttle rejection can
// never break interaction again.
const PERSIST_DELAY_MS = 500;
let persistTimer = null;

/** Write the current state to the URL hash and localStorage immediately. */
function persistNow() {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const json = serializeState(state);
  try {
    history.replaceState(null, '', `#${encodeURIComponent(json)}`);
  } catch {
    // Rate-limited by the browser. Dropping this write is harmless: the next
    // one carries the whole state, not a delta.
  }
  try {
    localStorage.setItem(STORAGE_KEY, json);
  } catch {
    // localStorage may be unavailable (private mode, disabled); ignore.
  }
}

/** Queue a persist, coalescing everything that happens within the delay. */
function persist() {
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, PERSIST_DELAY_MS);
}

// Write the live state before the page goes away. This is unconditional, not
// just a flush of a pending timer: it also catches a change that never reached
// a commit point, such as text typed into a field and then abandoned by closing
// the tab rather than blurring it.
addEventListener('pagehide', persistNow);

function loadStateFromHash() {
  return decodeHash(location.hash.slice(1));
}

function loadStateFromStorage() {
  try {
    return deserializeState(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

render(); // solve first so the initial fit has geometry to frame
fitToContent();
initHistory(); // seed the undo stack with the starting configuration
// One write on load, now that `render()` no longer persists: it gives a bare
// page a shareable hash without waiting for a first edit, and it writes back
// the *validated* state, so a malformed stored snapshot is repaired in place
// rather than lingering to be re-read on every future load.
persist();
