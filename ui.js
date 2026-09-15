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

function drawGrid() {
  gridGroup.innerHTML = '';
  const step = niceStep(view.w);
  const x0 = Math.floor(view.x / step) * step;
  const x1 = view.x + view.w;
  const y0 = Math.floor(view.y / step) * step;
  const y1 = view.y + view.h;
  for (let x = x0; x <= x1; x += step) {
    gridGroup.appendChild(el('line', { x1: x, y1: y0, x2: x, y2: y1, stroke: '#1b2537', 'stroke-width': 1 }));
  }
  for (let y = y0; y <= y1; y += step) {
    gridGroup.appendChild(el('line', { x1: x0, y1: y, x2: x1, y2: y, stroke: '#1b2537', 'stroke-width': 1 }));
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
    case 'ratio':
      return family.withAspectRatio(Number(state.param));
    case 'rx':
    case 'ry':
      return family.withRadius(state.mode, Number(state.param));
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

function drawStaticGeometry(family) {
  staticGroup.innerHTML = '';
  if (!family) return;
  const extend = (p, dir, len) => ({ x: p.x + dir.x * len, y: p.y + dir.y * len });
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
  staticGroup.appendChild(
    line(extend(state.p0, family.d0, -1000), extend(state.p0, family.d0, 1000), '#22c55e', '2 4'),
  );
  staticGroup.appendChild(
    line(extend(state.p1, family.d1, -1000), extend(state.p1, family.d1, 1000), '#f87171', '2 4'),
  );
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
  handlesGroup.appendChild(makeDraggable('h0', h0, 6, '#86efac'));
  handlesGroup.appendChild(makeDraggable('h1', h1, 6, '#fca5a5'));
  if (state.mode === 'through') {
    handlesGroup.appendChild(makeDraggable('through', state.paramPoint, 6, '#facc15'));
  }
}

function makeDraggable(id, pos, r, color) {
  const c = el('circle', { cx: pos.x, cy: pos.y, r: r * sizeScale, fill: color, stroke: '#0b1220', 'stroke-width': 2 });
  c.dataset.handle = id;
  return c;
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
    });
  }
}

function renderExports(family, ellipse) {
  const pathBox = document.getElementById('export-path');
  const arcParamBox = document.getElementById('export-arc-param');
  if (!family || !ellipse) {
    pathBox.value = '';
    arcParamBox.value = '';
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
  apex: { label: 'Apex position (0–1)', kind: 'range', min: 0.001, max: 0.999, step: 0.001 },
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
  setField('t0-deg', state.t0Deg);
  setField('t1-deg', state.t1Deg);
  document.getElementById('yup-toggle').checked = state.yUp;

  document.querySelectorAll('#mode-buttons button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === state.mode);
  });

  const meta = MODE_META[state.mode];
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

document.getElementById('p0-xy').addEventListener('change', (e) => {
  const p = parsePoint(e.target.value);
  if (p) state.p0 = p;
  render();
});
document.getElementById('p1-xy').addEventListener('change', (e) => {
  const p = parsePoint(e.target.value);
  if (p) state.p1 = p;
  render();
});
document.getElementById('t0-deg').addEventListener('change', (e) => {
  const v = parseNumber(e.target.value);
  if (v !== null) state.t0Deg = v;
  render();
});
document.getElementById('t1-deg').addEventListener('change', (e) => {
  const v = parseNumber(e.target.value);
  if (v !== null) state.t1Deg = v;
  render();
});

document.getElementById('mode-buttons').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.mode = btn.dataset.mode;
  state.solutionIndex = 0;
  if (state.mode === 'apex' && (typeof state.param !== 'number' || state.param <= 0 || state.param >= 1)) {
    state.param = 0.3;
  }
  render();
});

document.getElementById('param-range').addEventListener('input', (e) => {
  state.param = Number(e.target.value);
  state.solutionIndex = 0;
  render();
});
document.getElementById('param-text').addEventListener('input', (e) => {
  const v = parseNumber(e.target.value);
  if (v !== null) {
    state.param = v;
    state.solutionIndex = 0;
    render();
  }
});

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
  dragging = null;
  panning = null;
  svg.classList.remove('dragging');
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
