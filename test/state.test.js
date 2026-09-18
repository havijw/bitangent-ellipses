import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VIEW_W,
  VIEW_H,
  MIN_VIEW_W,
  MAX_VIEW_W,
  DEFAULT_VIEW,
  DEFAULT_STATE,
  defaultState,
  withDefaults,
  serializeState,
  deserializeState,
  encodeHash,
  decodeHash,
  parsePoint,
  parseNumber,
  ellipseHalfExtents,
  contentBounds,
  controlPointsBounds,
  fitView,
  zoomView,
  niceStep,
  handleOffset,
  pointInView,
  clipLineToView,
  resultRows,
  History,
} from '../src/state.js';
import { formatDisplay } from '../src/format.js';

test('defaultState returns an independent deep copy', () => {
  const a = defaultState();
  const b = defaultState();
  assert.deepEqual(a, DEFAULT_STATE);
  a.p0.x = 999;
  assert.notEqual(b.p0.x, 999, 'copies must not share nested objects');
  assert.notEqual(DEFAULT_STATE.p0.x, 999, 'the exported default must be untouched');
});

test('withDefaults overlays a partial state and tolerates null', () => {
  const merged = withDefaults({ mode: 'rotation', param: 42 });
  assert.equal(merged.mode, 'rotation');
  assert.equal(merged.param, 42);
  assert.deepEqual(merged.p0, DEFAULT_STATE.p0, 'unspecified keys fall back to defaults');
  assert.deepEqual(withDefaults(null), DEFAULT_STATE);
  assert.deepEqual(withDefaults(undefined), DEFAULT_STATE);
});

// Restored state is untrusted: the URL hash is hand-editable and localStorage
// can still hold a snapshot from an older schema. Every one of these used to
// pass straight through a shallow merge and take the render cycle down with it.
test('withDefaults drops malformed fields instead of propagating them', () => {
  const bad = withDefaults({
    p0: null,
    p1: { x: 1, y: 'nope' },
    paramPoint: { x: NaN, y: 0 },
    t0Deg: 'twelve',
    t1Deg: Infinity,
    mode: 'not-a-mode',
    param: null,
    yUp: 'yes',
    arcChoice: 'sideways',
    solutionIndex: -1,
  });
  assert.deepEqual(bad, DEFAULT_STATE, 'every unusable field falls back to its default');

  // A non-object (or a JSON scalar that survived parsing) is not a state.
  assert.deepEqual(withDefaults(42), DEFAULT_STATE);
  assert.deepEqual(withDefaults('nope'), DEFAULT_STATE);

  // Valid fields still come through, including ones the defaults don't use.
  const good = withDefaults({
    p0: { x: -3.5, y: 7 },
    mode: 'ratio',
    param: 2.5,
    yUp: true,
    arcChoice: 'large',
    solutionIndex: 1,
  });
  assert.deepEqual(good.p0, { x: -3.5, y: 7 });
  assert.equal(good.mode, 'ratio');
  assert.equal(good.param, 2.5);
  assert.equal(good.yUp, true);
  assert.equal(good.arcChoice, 'large');
  assert.equal(good.solutionIndex, 1);
});

test('withDefaults copies nested points rather than aliasing the input', () => {
  const input = { p0: { x: 1, y: 2 } };
  const s = withDefaults(input);
  input.p0.x = 999;
  assert.equal(s.p0.x, 1, 'mutating the source must not reach into restored state');
});

test('state serialization round-trips and rejects garbage', () => {
  const s = defaultState();
  s.p0 = { x: 12.3456789, y: -4.7654321 };
  const restored = deserializeState(serializeState(s));
  assert.deepEqual(restored, s);
  assert.equal(deserializeState('not json'), null);
  assert.equal(deserializeState('42'), null, 'a bare number is not a state object');
  assert.equal(deserializeState('null'), null);
  assert.equal(deserializeState(null), null);
});

test('hash encode/decode round-trips and tolerates bad input', () => {
  const s = withDefaults({ mode: 'through', paramPoint: { x: 1.5, y: 2.5 } });
  const decoded = decodeHash(encodeHash(s));
  assert.deepEqual(decoded, s);
  assert.equal(decodeHash(''), null, 'empty hash body yields null');
  assert.equal(decodeHash('%%%not-encoded'), null, 'malformed input yields null, not a throw');
});

test('parsePoint reads "x, y" losslessly and rejects bad input', () => {
  assert.deepEqual(parsePoint('160, 380'), { x: 160, y: 380 });
  assert.deepEqual(parsePoint('  12.3456789 , -4.7654321 '), { x: 12.3456789, y: -4.7654321 });
  assert.equal(parsePoint('160'), null, 'one component is not a point');
  assert.equal(parsePoint('160, 380, 5'), null, 'three components is not a point');
  assert.equal(parsePoint('a, b'), null);
  assert.equal(parsePoint('160,'), null);
});

test('parseNumber accepts finite numbers only', () => {
  assert.equal(parseNumber('-35'), -35);
  assert.equal(parseNumber('  31.4159265 '), 31.4159265);
  assert.equal(parseNumber('abc'), null);
  assert.equal(parseNumber(''), null, 'empty string is not a number here');
  assert.equal(parseNumber('Infinity'), null);
});

test('ellipseHalfExtents matches the radii for an axis-aligned ellipse', () => {
  const { hx, hy } = ellipseHalfExtents({ rx: 100, ry: 40, theta: 0 });
  assert.ok(Math.abs(hx - 100) < 1e-9);
  assert.ok(Math.abs(hy - 40) < 1e-9);
  // Rotated 90°: the extents swap.
  const rot = ellipseHalfExtents({ rx: 100, ry: 40, theta: Math.PI / 2 });
  assert.ok(Math.abs(rot.hx - 40) < 1e-9);
  assert.ok(Math.abs(rot.hy - 100) < 1e-9);
});

test('contentBounds covers the points, the third point, and the ellipse extent', () => {
  const base = { mode: 'roundest', p0: { x: 0, y: 0 }, p1: { x: 10, y: 20 }, paramPoint: { x: 999, y: 999 } };
  const pts = contentBounds(base, null);
  assert.deepEqual(pts, { minX: 0, minY: 0, maxX: 10, maxY: 20 });

  // The third point is only included in "through" mode.
  const through = contentBounds({ ...base, mode: 'through' }, null);
  assert.equal(through.maxX, 999);
  assert.equal(through.maxY, 999);

  // An ellipse expands the box to its axis-aligned extent.
  const withEllipse = contentBounds(base, { cx: 5, cy: 10, rx: 100, ry: 40, theta: 0 });
  assert.equal(withEllipse.minX, 5 - 100);
  assert.equal(withEllipse.maxX, 5 + 100);
  assert.equal(withEllipse.minY, 10 - 40);
  assert.equal(withEllipse.maxY, 10 + 40);
});

test('fitView centers the bounds and matches the requested aspect', () => {
  const bounds = { minX: 100, minY: 200, maxX: 300, maxY: 260 };
  const aspect = 2; // width / height
  const v = fitView(bounds, aspect);
  // Center of the view equals the center of the bounds.
  assert.ok(Math.abs(v.x + v.w / 2 - 200) < 1e-9, 'x-center');
  assert.ok(Math.abs(v.y + v.h / 2 - 230) < 1e-9, 'y-center');
  // The view has the requested aspect ratio.
  assert.ok(Math.abs(v.w / v.h - aspect) < 1e-9, 'aspect preserved');
  // The bounds fit inside the padded view.
  assert.ok(v.x <= bounds.minX && v.x + v.w >= bounds.maxX, 'x fully covered');
  assert.ok(v.y <= bounds.minY && v.y + v.h >= bounds.maxY, 'y fully covered');
});

test('fitView falls back to the default view when there is nothing to frame', () => {
  assert.deepEqual(fitView(null, 4 / 3), { ...DEFAULT_VIEW });
});

test('fitView clamps to the zoom limits while preserving aspect', () => {
  // A minuscule box would zoom past MIN_VIEW_W; the view width is clamped.
  const tiny = { minX: 0, minY: 0, maxX: 0.001, maxY: 0.001 };
  const v = fitView(tiny, 1);
  assert.ok(v.w >= MIN_VIEW_W - 1e-9, 'clamped to the closest zoom');
  assert.ok(Math.abs(v.w / v.h - 1) < 1e-9, 'aspect still 1');

  // An enormous box would zoom past MAX_VIEW_W; clamped the other way.
  const huge = { minX: 0, minY: 0, maxX: 1e6, maxY: 1e6 };
  const w = fitView(huge, 1);
  assert.ok(w.w <= MAX_VIEW_W + 1e-9, 'clamped to the farthest zoom');
});

test('controlPointsBounds covers just the draggable points', () => {
  const state = { ...DEFAULT_STATE, p0: { x: 10, y: 20 }, p1: { x: 40, y: 5 }, mode: 'roundest' };
  assert.deepEqual(controlPointsBounds(state), { minX: 10, minY: 5, maxX: 40, maxY: 20 });
  // The third point counts only in "through" mode.
  const thru = { ...state, mode: 'through', paramPoint: { x: 100, y: 200 } };
  assert.deepEqual(controlPointsBounds(thru), { minX: 10, minY: 5, maxX: 100, maxY: 200 });
});

test('fitView keeps the control points visible when a huge ellipse would push them off screen', () => {
  // A very long ellipse whose center sits far from the two points. The content
  // bounds are enormous, so the clamped view centered on that center would
  // leave the points outside the frame.
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 200, y: 40 };
  const focus = { bounds: { minX: 0, minY: 0, maxX: 200, maxY: 40 }, anchor: p0 };
  const bounds = { minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 };
  const v = fitView(bounds, 1, focus);
  assert.ok(v.w <= MAX_VIEW_W + 1e-9, 'still clamped to the farthest zoom');
  // Both control points fall inside the framed view.
  assert.ok(v.x <= focus.bounds.minX && v.x + v.w >= focus.bounds.maxX, 'points x visible');
  assert.ok(v.y <= focus.bounds.minY && v.y + v.h >= focus.bounds.maxY, 'points y visible');
});

test('fitView leaves normal content centered when everything fits', () => {
  const bounds = { minX: 0, minY: 0, maxX: 200, maxY: 150 };
  const focus = { bounds: { minX: 20, minY: 20, maxX: 40, maxY: 40 }, anchor: { x: 20, y: 20 } };
  const withFocus = fitView(bounds, 4 / 3, focus);
  const plain = fitView(bounds, 4 / 3);
  // The focus fits within the content-centered view, so the framing is unchanged.
  assert.deepEqual(withFocus, plain);
});

test('fitView falls back to the anchor point when the control points cannot both fit', () => {
  // Points so far apart that even they exceed the farthest zoom span.
  const p0 = { x: 0, y: 0 };
  const focus = { bounds: { minX: 0, minY: 0, maxX: 1e6, maxY: 1e6 }, anchor: p0 };
  const bounds = { minX: -1e7, minY: -1e7, maxX: 1e7, maxY: 1e7 };
  const v = fitView(bounds, 1, focus);
  // View is centered on the anchor (first point).
  assert.ok(Math.abs(v.x + v.w / 2 - p0.x) < 1e-9, 'x-centered on anchor');
  assert.ok(Math.abs(v.y + v.h / 2 - p0.y) < 1e-9, 'y-centered on anchor');
});

test('zoomView keeps the anchor point fixed on screen', () => {
  const view = { x: 0, y: 0, w: 800, h: 600 };
  // Zoom in about the center; the world point under the center must not move.
  const zoomed = zoomView(view, 0.5, 0.5, 0.5);
  const before = { x: view.x + 0.5 * view.w, y: view.y + 0.5 * view.h };
  const after = { x: zoomed.x + 0.5 * zoomed.w, y: zoomed.y + 0.5 * zoomed.h };
  assert.ok(Math.abs(before.x - after.x) < 1e-9, 'anchor x fixed');
  assert.ok(Math.abs(before.y - after.y) < 1e-9, 'anchor y fixed');
  assert.ok(zoomed.w < view.w, 'factor < 1 zooms in (smaller span)');
  // Aspect ratio is preserved through the zoom.
  assert.ok(Math.abs(zoomed.w / zoomed.h - view.w / view.h) < 1e-9);
});

test('zoomView honors the zoom clamps', () => {
  const near = zoomView({ x: 0, y: 0, w: MIN_VIEW_W, h: MIN_VIEW_W }, 0.1, 0.5, 0.5);
  assert.ok(near.w >= MIN_VIEW_W - 1e-9, 'cannot zoom past the closest limit');
  const far = zoomView({ x: 0, y: 0, w: MAX_VIEW_W, h: MAX_VIEW_W }, 10, 0.5, 0.5);
  assert.ok(far.w <= MAX_VIEW_W + 1e-9, 'cannot zoom past the farthest limit');
});

test('niceStep returns 1/2/5 x 10^n spacings', () => {
  assert.equal(niceStep(800, 16), 50);
  assert.equal(niceStep(16, 16), 1);
  assert.equal(niceStep(1600, 16), 100);
  // The step is always at least span/divisions and a nice multiple.
  const step = niceStep(37, 16);
  assert.ok(step >= 37 / 16);
  assert.ok([1, 2, 5, 10].some((m) => Math.abs(step / (m * Math.pow(10, Math.round(Math.log10(step / m)))) - 1) < 1e-9) || step > 0);
});

// drawGrid steps its loop by this value, so a zero or NaN step would spin
// forever and lock the tab. The step must always be a usable positive number.
test('niceStep never returns a non-positive step', () => {
  for (const span of [0, -5, -0, NaN, Infinity, -Infinity]) {
    const step = niceStep(span);
    assert.ok(step > 0 && Number.isFinite(step), `niceStep(${span}) returned ${step}`);
  }
});

test('view constants are internally consistent', () => {
  assert.equal(DEFAULT_VIEW.w, VIEW_W);
  assert.equal(DEFAULT_VIEW.h, VIEW_H);
  assert.ok(MIN_VIEW_W < MAX_VIEW_W);
});


test('formatDisplay rounds to 3 decimals, drops trailing zeros, and normalizes -0', () => {
  assert.equal(formatDisplay(1.5), '1.5');
  assert.equal(formatDisplay(1.5000004), '1.5');
  assert.equal(formatDisplay(2), '2');
  assert.equal(formatDisplay(1.23456), '1.235');
  assert.equal(formatDisplay(-0), '0');
  assert.equal(formatDisplay(-0.0004), '0'); // rounds to -0, then normalized
});

test('handleOffset places the point len units away along the given angle', () => {
  const p = { x: 10, y: 20 };
  const right = handleOffset(p, 0, 5);
  assert.ok(Math.abs(right.x - 15) < 1e-9 && Math.abs(right.y - 20) < 1e-9);
  const down = handleOffset(p, 90, 5); // +y is "down" in the SVG convention
  assert.ok(Math.abs(down.x - 10) < 1e-9 && Math.abs(down.y - 25) < 1e-9);
});

test('pointInView reports containment inclusive of the edges', () => {
  const v = { x: 0, y: 0, w: 100, h: 50 };
  assert.ok(pointInView({ x: 50, y: 25 }, v));
  assert.ok(pointInView({ x: 0, y: 0 }, v), 'the top-left corner counts as inside');
  assert.ok(pointInView({ x: 100, y: 50 }, v), 'the bottom-right corner counts as inside');
  assert.ok(!pointInView({ x: -1, y: 25 }, v));
  assert.ok(!pointInView({ x: 50, y: 51 }, v));
});

test('clipLineToView returns the span across the view for a diagonal line', () => {
  const v = { x: 0, y: 0, w: 100, h: 100 };
  const seg = clipLineToView({ x: 50, y: 50 }, { x: 1, y: 1 }, v);
  assert.ok(seg, 'diagonal through the center must cross the view');
  const xs = seg.map((q) => q.x).sort((a, b) => a - b);
  const ys = seg.map((q) => q.y).sort((a, b) => a - b);
  assert.ok(Math.abs(xs[0] - 0) < 1e-9 && Math.abs(xs[1] - 100) < 1e-9);
  assert.ok(Math.abs(ys[0] - 0) < 1e-9 && Math.abs(ys[1] - 100) < 1e-9);
});

test('clipLineToView handles axis-aligned directions and misses', () => {
  const v = { x: 0, y: 0, w: 100, h: 100 };
  // Vertical line at x = 40 spans the full height.
  const vert = clipLineToView({ x: 40, y: 10 }, { x: 0, y: 1 }, v);
  assert.ok(vert);
  assert.ok(vert.every((q) => Math.abs(q.x - 40) < 1e-9));
  const yspan = vert.map((q) => q.y).sort((a, b) => a - b);
  assert.ok(Math.abs(yspan[0] - 0) < 1e-9 && Math.abs(yspan[1] - 100) < 1e-9);
  // A vertical line outside the view (x = 200) misses entirely.
  assert.equal(clipLineToView({ x: 200, y: 10 }, { x: 0, y: 1 }, v), null);
});

test('resultRows flips rotation and center-y under the y-up convention', () => {
  const e = { rx: 3, ry: 2, thetaDeg: 30, cx: 10, cy: -4, eccentricity: 0.745 };
  const down = Object.fromEntries(resultRows(e, false));
  assert.equal(down['rotation (deg)'], '30');
  assert.equal(down['center'], '10, -4');
  assert.equal(down['rx (semi-major)'], '3');
  const up = Object.fromEntries(resultRows(e, true));
  assert.equal(up['rotation (deg)'], '-30', 'rotation sign flips');
  assert.equal(up['center'], '10, 4', 'center y flips');
});

test('History records, undoes, and redoes opaque snapshots', () => {
  const h = new History();
  h.init('a');
  assert.ok(!h.canUndo() && !h.canRedo());
  assert.ok(h.commit('b'));
  assert.ok(!h.commit('b'), 'an unchanged snapshot is not recorded');
  assert.ok(h.commit('c'));
  assert.ok(h.canUndo() && !h.canRedo());
  assert.equal(h.undo(), 'b');
  assert.equal(h.undo(), 'a');
  assert.equal(h.undo(), null, 'cannot undo past the start');
  assert.equal(h.redo(), 'b');
  // Committing after an undo drops the stale redo branch ('c').
  assert.ok(h.commit('d'));
  assert.ok(!h.canRedo());
  assert.equal(h.undo(), 'b');
  assert.equal(h.redo(), 'd');
});

test('History caps the stack at maxEntries, dropping the oldest', () => {
  const h = new History(3);
  h.init('0');
  h.commit('1');
  h.commit('2'); // stack now ['0','1','2'], full
  h.commit('3'); // drops '0' -> ['1','2','3']
  assert.equal(h.undo(), '2');
  assert.equal(h.undo(), '1');
  assert.equal(h.undo(), null, "the oldest entry ('0') was dropped");
});
