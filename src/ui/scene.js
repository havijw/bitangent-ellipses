/**
 * Canvas drawing for the browser UI: grid, tangent/chord geometry, the dashed
 * analytic ellipse, the solid arc overlay, and the draggable handles.
 *
 * Every function draws into an SVG group passed in by the caller and takes the
 * state/view/scale it needs as explicit arguments, so nothing here reaches for
 * hidden module globals. `ui.js` owns those and threads them in on each render.
 */

import { ellipsePolyline } from '../ellipse.js';
import { clipLineToView, handleOffset, niceStep } from '../state.js';
import { arcPath } from '../svg.js';
import { el, cssVar, makeDraggable, makeArrowHandle } from './dom.js';

/** Background grid at a "nice" spacing, themed via the --grid CSS variable. */
export function drawGrid(group, view) {
  group.innerHTML = '';
  const gridColor = cssVar('--grid') || '#1b2537';
  const step = niceStep(view.w);
  const x0 = Math.floor(view.x / step) * step;
  const x1 = view.x + view.w;
  const y0 = Math.floor(view.y / step) * step;
  const y1 = view.y + view.h;
  for (let x = x0; x <= x1; x += step) {
    group.appendChild(el('line', { x1: x, y1: y0, x2: x, y2: y1, stroke: gridColor, 'stroke-width': 1 }));
  }
  for (let y = y0; y <= y1; y += step) {
    group.appendChild(el('line', { x1: x0, y1: y, x2: x1, y2: y, stroke: gridColor, 'stroke-width': 1 }));
  }
}

/** The chord, both tangent lines (clipped to the view), and the third point. */
export function drawStaticGeometry(group, state, family, view, sizeScale) {
  group.innerHTML = '';
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
  group.appendChild(line(state.p0, state.p1, '#475569', '3 3'));
  // Draw each tangent as the segment where its infinite line crosses the
  // current view, so it always spans the whole canvas at any zoom or pan
  // rather than being a fixed (and eventually too-short) length.
  const t0 = clipLineToView(state.p0, family.d0, view);
  if (t0) group.appendChild(line(t0[0], t0[1], '#22c55e', '2 4'));
  const t1 = clipLineToView(state.p1, family.d1, view);
  if (t1) group.appendChild(line(t1[0], t1[1], '#f87171', '2 4'));
  if (state.mode === 'through') {
    group.appendChild(el('circle', { cx: state.paramPoint.x, cy: state.paramPoint.y, r: 5 * sizeScale, fill: '#facc15' }));
  }
}

/** The dashed full analytic ellipse plus its center dot. */
export function drawEllipseOverlay(group, ellipse, sizeScale) {
  group.innerHTML = '';
  const pts = ellipsePolyline(ellipse, 180);
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(' ') + ' Z';
  group.appendChild(el('path', { d, fill: 'none', stroke: '#64748b', 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }));
  group.appendChild(el('circle', { cx: ellipse.cx, cy: ellipse.cy, r: 2.5 * sizeScale, fill: '#64748b' }));
}

/** The solid arc overlay, drawn from the already-chosen `arc` (y-down canvas). */
export function drawArcOverlay(group, family, ellipse, arc) {
  group.innerHTML = '';
  const d = arcPath(ellipse, family.p0, family.p1, arc, { yUp: false });
  group.appendChild(el('path', { d, fill: 'none', stroke: '#0ea5e9', 'stroke-width': 3, 'stroke-linecap': 'round' }));
}

/** The draggable points, their tangent stalks/arrowheads, and the third point. */
export function drawHandles(group, state, sizeScale, handleLen) {
  group.innerHTML = '';
  const h0 = handleOffset(state.p0, state.t0Deg, handleLen * sizeScale);
  const h1 = handleOffset(state.p1, state.t1Deg, handleLen * sizeScale);

  const stalk = (p, h, color) =>
    el('line', { x1: p.x, y1: p.y, x2: h.x, y2: h.y, stroke: color, 'stroke-width': 1.5, opacity: 0.6 });
  group.appendChild(stalk(state.p0, h0, '#22c55e'));
  group.appendChild(stalk(state.p1, h1, '#f87171'));

  group.appendChild(makeDraggable('p0', state.p0, 8, '#22c55e', sizeScale));
  group.appendChild(makeDraggable('p1', state.p1, 8, '#f87171', sizeScale));
  group.appendChild(makeArrowHandle('h0', h0, state.t0Deg, 9, '#22c55e', sizeScale));
  group.appendChild(makeArrowHandle('h1', h1, state.t1Deg, 9, '#f87171', sizeScale));
  if (state.mode === 'through') {
    group.appendChild(makeDraggable('through', state.paramPoint, 6, '#facc15', sizeScale));
  }
}
