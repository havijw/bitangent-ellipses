/**
 * Browser UI for the two-tangent ellipse tool.
 *
 * The canvas is a plain SVG element using the browser's native (y-down)
 * coordinate convention, and all solving happens directly in those same
 * coordinates — so the dashed "full ellipse" polyline and the solid arc path
 * drawn on top of it are produced by the exact same math the CLI and SVG
 * export use, with `yUp: false`. That overlay coinciding pixel-for-pixel is
 * the tool's own correctness check. The "Y-axis points up" toggle only
 * affects the text in the export boxes, for pasting into a renderer that
 * uses the opposite convention; it does not change what's drawn here.
 */

import { EllipseFamily, EllipseInputError, ellipsePolyline } from './src/ellipse.js';
import { chooseArc, arcPath, arcPathParameter } from './src/svg.js';
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
  niceStep,
} from './src/state.js';

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
const NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

const gridGroup = el('g');
const staticGroup = el('g'); // tangent lines, chord
const ellipseGroup = el('g'); // dashed full ellipse
const arcGroup = el('g'); // solid arc overlay
const handlesGroup = el('g'); // draggable points/handles
svg.append(gridGroup, staticGroup, ellipseGroup, arcGroup, handlesGroup);

/** Current value of a CSS custom property on :root (drives themed canvas colors). */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawGrid() {
  gridGroup.innerHTML = '';
  const gridColor = cssVar('--grid') || '#1b2537';
  const step = niceStep(view.w);
  const x0 = Math.floor(view.x / step) * step;
  const x1 = view.x + view.w;
  const y0 = Math.floor(view.y / step) * step;
  const y1 = view.y + view.h;
  for (let x = x0; x <= x1; x += step) {
    gridGroup.appendChild(el('line', { x1: x, y1: y0, x2: x, y2: y1, stroke: gridColor, 'stroke-width': 1 }));
  }
  for (let y = y0; y <= y1; y += step) {
    gridGroup.appendChild(el('line', { x1: x0, y1: y, x2: x1, y2: y, stroke: gridColor, 'stroke-width': 1 }));
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers tying UI state to the math module
// ---------------------------------------------------------------------------

function handlePos(p, deg) {
  const rad = (deg * Math.PI) / 180;
  const len = HANDLE_LEN * sizeScale;
  return { x: p.x + len * Math.cos(rad), y: p.y + len * Math.sin(rad) };
}

function buildFamily() {
  return new EllipseFamily(state.p0, { deg: state.t0Deg }, state.p1, { deg: state.t1Deg });
}

function currentSolutions(family) {
  switch (state.mode) {
    case 'roundest':
      return [family.roundest()];
    case 'apex':
      return [family.atApex(Number(state.param))];
    case 'rotation':
      return [family.withRotation(Number(state.param))];
    case 'ratio': {
      // rx is fixed as the semi-major and ry as the semi-minor axis, so the
      // major/minor ratio is always >= 1; reject sub-1 values rather than
      // silently inverting the axes (which withAspectRatio would otherwise do).
      const k = Number(state.param);
      if (!(k >= 1)) {
        throw new EllipseInputError('Aspect ratio (major / minor) must be at least 1.');
      }
      return family.withAspectRatio(k);
    }
    case 'rx':
    case 'ry': {
      const value = Number(state.param);
      // Both points are chords of the ellipse, and a chord can never exceed the
      // major axis (2*rx), so any ellipse through P0 and P1 has rx >= half the
      // distance between them. Reject a smaller rx outright with that bound
      // rather than falling through to the generic "no ellipse" message.
      if (state.mode === 'rx' && value < family.halfChord) {
        const min = String(Number(family.halfChord.toFixed(3)) + 0);
        throw new EllipseInputError(
          `rx must be at least ${min} (half the distance between P0 and P1) — no ellipse through both points can have a shorter semi-major axis.`,
        );
      }
      return family.withRadius(state.mode, value);
    }
    case 'through':
      return [family.throughPoint(state.paramPoint)];
    default:
      throw new EllipseInputError(`Unknown mode '${state.mode}'`);
  }
}

// ---------------------------------------------------------------------------
// Main render/solve cycle
// ---------------------------------------------------------------------------

function render() {
  saveState();
  syncControlsFromState();
  applyView();
  drawGrid();

  // Reset each cycle; set again below only when an ellipse is actually solved.
  lastEllipse = null;

  const errorBox = document.getElementById('error-box');
  let family;
  try {
    family = buildFamily();
  } catch (err) {
    showError(err);
    drawStaticGeometry(null);
    ellipseGroup.innerHTML = '';
    arcGroup.innerHTML = '';
    renderResults([]);
    renderExports(null, null);
    drawHandles();
    return;
  }

  drawStaticGeometry(family);

  let solutions;
  let rejected;
  try {
    const raw = currentSolutions(family);
    solutions = raw.filter((s) => s.ellipse);
    rejected = raw.filter((s) => !s.ellipse);
  } catch (err) {
    showError(err);
    ellipseGroup.innerHTML = '';
    arcGroup.innerHTML = '';
    renderResults([]);
    renderExports(family, null);
    drawHandles();
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
    renderResults([]);
    renderExports(family, null);
    drawHandles();
    return;
  }

  const index = Math.min(state.solutionIndex, solutions.length - 1);
  const solution = solutions[index];
  lastEllipse = solution.ellipse;

  drawEllipseOverlay(solution.ellipse);
  drawArc(family, solution.ellipse);
  renderResults(solutions, index);
  renderExports(family, solution.ellipse);
  drawHandles();
}

function showError(err) {
  const box = document.getElementById('error-box');
  box.textContent = err instanceof EllipseInputError || err.message ? err.message : String(err);
  box.style.display = 'block';
}

/**
 * Clip the infinite line through `p` with unit direction `dir` to the current
 * view rectangle (Liang–Barsky). Returns the two edge intersection points, or
 * null if the line misses the view entirely. Handles axis-aligned (vertical or
 * horizontal) directions.
 */
function clipLineToView(p, dir) {
  const xmin = view.x;
  const xmax = view.x + view.w;
  const ymin = view.y;
  const ymax = view.y + view.h;
  const ps = [-dir.x, dir.x, -dir.y, dir.y];
  const qs = [p.x - xmin, xmax - p.x, p.y - ymin, ymax - p.y];
  let tmin = -Infinity;
  let tmax = Infinity;
  for (let i = 0; i < 4; i++) {
    if (ps[i] === 0) {
      if (qs[i] < 0) return null; // parallel to this edge and outside it
    } else {
      const t = qs[i] / ps[i];
      if (ps[i] < 0) tmin = Math.max(tmin, t);
      else tmax = Math.min(tmax, t);
    }
  }
  if (tmin > tmax) return null;
  return [
    { x: p.x + dir.x * tmin, y: p.y + dir.y * tmin },
    { x: p.x + dir.x * tmax, y: p.y + dir.y * tmax },
  ];
}

function drawStaticGeometry(family) {
  staticGroup.innerHTML = '';
  if (!family) return;
  const line = (a, b, color, dash) =>
    el('line', {
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      stroke: color,
      'stroke-width': 1.5,
      'stroke-dasharray': dash,
    });
  staticGroup.appendChild(line(state.p0, state.p1, '#475569', '3 3'));
  // Draw each tangent as the segment where its infinite line crosses the
  // current view, so it always spans the whole canvas at any zoom or pan
  // rather than being a fixed (and eventually too-short) length.
  const t0 = clipLineToView(state.p0, family.d0);
  if (t0) staticGroup.appendChild(line(t0[0], t0[1], '#22c55e', '2 4'));
  const t1 = clipLineToView(state.p1, family.d1);
  if (t1) staticGroup.appendChild(line(t1[0], t1[1], '#f87171', '2 4'));
  if (state.mode === 'through') {
    staticGroup.appendChild(el('circle', { cx: state.paramPoint.x, cy: state.paramPoint.y, r: 5 * sizeScale, fill: '#facc15' }));
  }
}

function drawEllipseOverlay(ellipse) {
  ellipseGroup.innerHTML = '';
  const pts = ellipsePolyline(ellipse, 180);
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(' ') + ' Z';
  ellipseGroup.appendChild(el('path', { d, fill: 'none', stroke: '#64748b', 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }));
  ellipseGroup.appendChild(el('circle', { cx: ellipse.cx, cy: ellipse.cy, r: 2.5 * sizeScale, fill: '#64748b' }));
}

function pickArc(family, ellipse, yUp = false) {
  if (state.arcChoice === 'small' || state.arcChoice === 'large') {
    return chooseArc(ellipse, family.p0, family.p1, { yUp, preferLargeArc: state.arcChoice === 'large' });
  }
  return chooseArc(ellipse, family.p0, family.p1, {
    yUp,
    tangentAtP0: { dir: family.d0, signed: true },
  });
}

function drawArc(family, ellipse) {
  arcGroup.innerHTML = '';
  // The canvas is always y-down, so draw with yUp = false regardless of the
  // export convention chosen for the copy boxes.
  const arc = pickArc(family, ellipse, false);
  const d = arcPath(ellipse, family.p0, family.p1, arc, { yUp: false });
  arcGroup.appendChild(el('path', { d, fill: 'none', stroke: '#0ea5e9', 'stroke-width': 3, 'stroke-linecap': 'round' }));
  return arc;
}

function drawHandles() {
  handlesGroup.innerHTML = '';
  const h0 = handlePos(state.p0, state.t0Deg);
  const h1 = handlePos(state.p1, state.t1Deg);

  const stalk = (p, h, color) =>
    el('line', { x1: p.x, y1: p.y, x2: h.x, y2: h.y, stroke: color, 'stroke-width': 1.5, opacity: 0.6 });
  handlesGroup.appendChild(stalk(state.p0, h0, '#22c55e'));
  handlesGroup.appendChild(stalk(state.p1, h1, '#f87171'));

  handlesGroup.appendChild(makeDraggable('p0', state.p0, 8, '#22c55e'));
  handlesGroup.appendChild(makeDraggable('p1', state.p1, 8, '#f87171'));
  handlesGroup.appendChild(makeArrowHandle('h0', h0, state.t0Deg, 9, '#22c55e'));
  handlesGroup.appendChild(makeArrowHandle('h1', h1, state.t1Deg, 9, '#f87171'));
  if (state.mode === 'through') {
    handlesGroup.appendChild(makeDraggable('through', state.paramPoint, 6, '#facc15'));
  }
}

function makeDraggable(id, pos, r, color) {
  const c = el('circle', { cx: pos.x, cy: pos.y, r: r * sizeScale, fill: color, stroke: '#0b1220', 'stroke-width': 2 });
  c.dataset.handle = id;
  return c;
}

/**
 * A draggable arrowhead marker centered at `pos`, pointing along `deg` (the
 * tangent direction). Behaves exactly like `makeDraggable` for hit-testing —
 * it carries `data-handle` so the same pointer logic drives it — it just draws
 * a triangle instead of a circle. `size` is the tip length in screen units.
 */
function makeArrowHandle(id, pos, deg, size, color) {
  const s = size * sizeScale;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // Triangle in local space pointing along +x, then rotated to `deg`.
  const local = [
    [s, 0],
    [-s * 0.7, s * 0.85],
    [-s * 0.7, -s * 0.85],
  ];
  const points = local
    .map(([lx, ly]) => `${pos.x + lx * cos - ly * sin},${pos.y + lx * sin + ly * cos}`)
    .join(' ');
  const tri = el('polygon', {
    points,
    fill: color,
    stroke: '#0b1220',
    'stroke-width': 2,
    'stroke-linejoin': 'round',
    'vector-effect': 'non-scaling-stroke',
  });
  tri.dataset.handle = id;
  return tri;
}

// ---------------------------------------------------------------------------
// Results / export panels
// ---------------------------------------------------------------------------

function renderResults(solutions, index = 0) {
  const box = document.getElementById('results');
  if (solutions.length === 0) {
    box.innerHTML = '<div class="result-row"><span class="label">No solution</span></div>';
    return;
  }
  const e = solutions[index].ellipse;
  // Match the export boxes' convention: when the user says their y-axis
  // points up, both the rotation sign and the center's y-coordinate flip
  // together (same origin, mirrored y), not just the rotation alone.
  const rot = state.yUp ? -e.thetaDeg : e.thetaDeg;
  const cy = state.yUp ? -e.cy : e.cy;
  // Display values are rounded to at most 3 decimals to keep the result pane
  // readable; trailing zeros are dropped (1.5, not 1.500). This is display-only
  // — the URL hash, inputs, and export boxes stay lossless.
  const show = (n) => String(Number(n.toFixed(3)) + 0);
  const rows = [
    ['rx (semi-major)', show(e.rx)],
    ['ry (semi-minor)', show(e.ry)],
    ['rotation (deg)', show(rot)],
    ['center', `${show(e.cx)}, ${show(cy)}`],
    ['eccentricity', show(e.eccentricity)],
  ];
  box.innerHTML = rows
    .map(
      ([label, value], i) =>
        `<div class="result-row${i < 2 ? ' big' : ''}"><span class="label">${label}</span><span class="value">${value}</span></div>`,
    )
    .join('');
  if (solutions.length > 1) {
    box.innerHTML += `<div class="result-row"><span class="label">Solution ${index + 1} of ${solutions.length}</span><button class="copy-btn" id="cycle-solution">Next</button></div>`;
    document.getElementById('cycle-solution').addEventListener('click', () => {
      state.solutionIndex = (index + 1) % solutions.length;
      render();
      commitHistory();
    });
  }
}

/**
 * Grow a readonly export textarea to fit its content so nothing is clipped
 * behind an inner scrollbar. Resetting to 'auto' first lets it shrink back
 * when the content gets shorter; the +2 covers the 1px top/bottom border
 * under box-sizing: border-box. The CSS min-height keeps an empty box sane.
 */
function autoSizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 2}px`;
}

function renderExports(family, ellipse) {
  const pathBox = document.getElementById('export-path');
  const arcParamBox = document.getElementById('export-arc-param');
  if (!family || !ellipse) {
    pathBox.value = '';
    arcParamBox.value = '';
    autoSizeTextarea(pathBox);
    autoSizeTextarea(arcParamBox);
    return;
  }
  // Recompute the arc in the export's coordinate convention: the sweep flag
  // (and thus ARC `direction`) flips between y-down and y-up, so exports must
  // not reuse the y-down arc drawn on the canvas.
  const exportArc = pickArc(family, ellipse, state.yUp);
  pathBox.value = arcPath(ellipse, family.p0, family.p1, exportArc, { yUp: state.yUp });
  arcParamBox.value = JSON.stringify(
    arcPathParameter(ellipse, family.p0, family.p1, exportArc, { yUp: state.yUp }),
    null,
    2,
  );
  autoSizeTextarea(pathBox);
  autoSizeTextarea(arcParamBox);
  const { small } = arcSummary(family, ellipse);
  document.querySelectorAll('#arc-toggle button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.arc === small);
  });
}

function arcSummary(family, ellipse) {
  const arc = pickArc(family, ellipse);
  return { small: arc.largeArc ? 'large' : 'small' };
}

// ---------------------------------------------------------------------------
// Controls: text inputs, mode buttons, arc toggle, y-up toggle
// ---------------------------------------------------------------------------

const MODE_META = {
  roundest: { label: null },
  apex: { label: 'Apex position (parabola at 0.5)', kind: 'range', min: 0.001, max: 0.499, step: 0.001 },
  rotation: { label: 'Axis angle (deg)', kind: 'text' },
  ratio: { label: 'Major / minor ratio (≥ 1)', kind: 'text' },
  rx: { label: 'rx (semi-major)', kind: 'text' },
  ry: { label: 'ry (semi-minor)', kind: 'text' },
  through: { label: 'Drag the yellow point on the canvas', kind: 'none' },
};

function syncControlsFromState() {
  // Write the full-precision value, but never clobber a field mid-edit, so a
  // typed value with many decimals survives intact instead of being repainted
  // to a rounded form the next time we render.
  const setField = (id, value) => {
    const field = document.getElementById(id);
    if (document.activeElement !== field) field.value = value;
  };
  setField('p0-xy', `${state.p0.x}, ${state.p0.y}`);
  setField('p1-xy', `${state.p1.x}, ${state.p1.y}`);
  setField('through-xy', `${state.paramPoint.x}, ${state.paramPoint.y}`);
  setField('t0-deg', state.t0Deg);
  setField('t1-deg', state.t1Deg);
  document.getElementById('yup-toggle').checked = state.yUp;

  document.querySelectorAll('#mode-buttons button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === state.mode);
  });

  const meta = MODE_META[state.mode];
  document.getElementById('through-field').style.display =
    state.mode === 'through' ? 'block' : 'none';
  const field = document.getElementById('param-field');
  const rangeInput = document.getElementById('param-range');
  const textInput = document.getElementById('param-text');
  const label = document.getElementById('param-label');
  if (!meta.label) {
    field.style.display = 'none';
  } else {
    field.style.display = 'block';
    label.textContent = meta.label;
    rangeInput.style.display = meta.kind === 'range' ? 'block' : 'none';
    document.getElementById('range-ends').style.display = meta.kind === 'range' ? 'flex' : 'none';
    textInput.style.display = meta.kind === 'text' ? 'block' : 'none';
    if (meta.kind === 'range') {
      rangeInput.min = meta.min;
      rangeInput.max = meta.max;
      rangeInput.step = meta.step;
      rangeInput.value = state.param;
    } else if (meta.kind === 'text') {
      if (document.activeElement !== textInput) textInput.value = state.param;
    } else {
      field.style.display = 'none';
    }
  }
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
// on every step but commit a single history entry when the gesture ends, so
// one drag is one undo — not hundreds.

const TRACKED_KEYS = ['p0', 'p1', 't0Deg', 't1Deg', 'mode', 'param', 'paramPoint', 'solutionIndex'];
let historyStack = [];
let historyIndex = -1;
const MAX_HISTORY = 200;

/** Serialize just the tracked slice of state (used as a history snapshot). */
function trackedSnapshot() {
  const slice = {};
  for (const k of TRACKED_KEYS) slice[k] = state[k];
  return JSON.stringify(slice);
}

function initHistory() {
  historyStack = [trackedSnapshot()];
  historyIndex = 0;
  updateHistoryButtons();
}

/** Record the current tracked state as a new history entry, if it changed. */
function commitHistory() {
  const snap = trackedSnapshot();
  if (snap === historyStack[historyIndex]) return; // nothing tracked changed
  // Drop any redo branch, then append.
  historyStack.length = historyIndex + 1;
  historyStack.push(snap);
  if (historyStack.length > MAX_HISTORY) historyStack.shift();
  historyIndex = historyStack.length - 1;
  updateHistoryButtons();
}

/** Overlay the tracked slice at `historyIndex` onto the live state and redraw. */
function applyHistoryEntry() {
  Object.assign(state, JSON.parse(historyStack[historyIndex]));
  render();
  updateHistoryButtons();
}

function undo() {
  if (historyIndex <= 0) return;
  historyIndex--;
  applyHistoryEntry();
}

function redo() {
  if (historyIndex >= historyStack.length - 1) return;
  historyIndex++;
  applyHistoryEntry();
}

function updateHistoryButtons() {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  if (undoBtn) undoBtn.disabled = historyIndex <= 0;
  if (redoBtn) redoBtn.disabled = historyIndex >= historyStack.length - 1;
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

document.getElementById('p0-xy').addEventListener('change', (e) => {
  const p = parsePoint(e.target.value);
  if (p) state.p0 = p;
  render();
  commitHistory();
});
document.getElementById('p1-xy').addEventListener('change', (e) => {
  const p = parsePoint(e.target.value);
  if (p) state.p1 = p;
  render();
  commitHistory();
});
document.getElementById('through-xy').addEventListener('change', (e) => {
  const p = parsePoint(e.target.value);
  if (p) state.paramPoint = p;
  render();
  commitHistory();
});
document.getElementById('t0-deg').addEventListener('change', (e) => {
  const v = parseNumber(e.target.value);
  if (v !== null) state.t0Deg = v;
  render();
  commitHistory();
});
document.getElementById('t1-deg').addEventListener('change', (e) => {
  const v = parseNumber(e.target.value);
  if (v !== null) state.t1Deg = v;
  render();
  commitHistory();
});

document.getElementById('mode-buttons').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.mode = btn.dataset.mode;
  state.solutionIndex = 0;
  if (state.mode === 'apex' && (typeof state.param !== 'number' || state.param <= 0 || state.param >= 0.5)) {
    state.param = 0.3;
  }
  render();
  // Reveal the third point when entering "through" mode (render() first so the
  // through-mode solution is in lastEllipse before we frame it).
  if (state.mode === 'through' && ensureThroughPointVisible()) render();
  commitHistory();
});

document.getElementById('param-range').addEventListener('input', (e) => {
  state.param = Number(e.target.value);
  state.solutionIndex = 0;
  render();
});
// Commit one history entry when the slider is released, not per step.
document.getElementById('param-range').addEventListener('change', commitHistory);
document.getElementById('param-text').addEventListener('input', (e) => {
  const v = parseNumber(e.target.value);
  if (v !== null) {
    state.param = v;
    state.solutionIndex = 0;
    render();
  }
});
document.getElementById('param-text').addEventListener('change', commitHistory);

document.getElementById('yup-toggle').addEventListener('change', (e) => {
  state.yUp = e.target.checked;
  render();
});

document.getElementById('arc-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.arcChoice = btn.dataset.arc;
  render();
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

document.getElementById('reset-btn').addEventListener('click', () => {
  state = defaultState();
  render(); // solve the defaults so fitToContent has geometry to frame
  fitToContent();
  commitHistory();
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
  if (wasDragging) commitHistory();
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

/** Whether world point `pt` lies within the given viewBox `v`. */
function pointInView(pt, v) {
  return pt.x >= v.x && pt.x <= v.x + v.w && pt.y >= v.y && pt.y <= v.y + v.h;
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

function saveState() {
  const json = serializeState(state);
  history.replaceState(null, '', `#${encodeURIComponent(json)}`);
  try {
    localStorage.setItem(STORAGE_KEY, json);
  } catch {
    // localStorage may be unavailable (private mode, disabled); ignore.
  }
}

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
