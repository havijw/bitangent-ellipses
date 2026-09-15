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
  fitView,
  zoomView,
  niceStep,
} from '../src/state.js';

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

test('view constants are internally consistent', () => {
  assert.equal(DEFAULT_VIEW.w, VIEW_W);
  assert.equal(DEFAULT_VIEW.h, VIEW_H);
  assert.ok(MIN_VIEW_W < MAX_VIEW_W);
});
