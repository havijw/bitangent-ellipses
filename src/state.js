/**
 * Pure, DOM-free logic backing the browser UI: the default configuration,
 * state (de)serialization for the URL hash and localStorage, text-input
 * parsing, and the viewBox framing/zoom math.
 *
 * None of this touches the DOM, `location`, or `localStorage` — `ui.js` owns
 * that wiring and calls in here for the arithmetic. Keeping it separate is
 * what makes it testable under `node:test` without a browser, and every bug
 * this module has hosted (state restore, fit-to-content framing, input
 * truncation) is a pure-function bug that a unit test can pin down.
 */

// Canvas design size, in world units, at the default (unzoomed) view. Screen
// sizes for points/handles are scaled by view.w / VIEW_W so they stay constant
// on screen at any zoom.
export const VIEW_W = 800;
export const VIEW_H = 600;

// Zoom clamps, expressed as the world-units span across the viewBox width.
export const MIN_VIEW_W = 25; // closest zoom
export const MAX_VIEW_W = 40000; // farthest zoom

// Fraction of the content span added as margin on each side when fitting.
export const FIT_PAD = 0.12;

export const DEFAULT_VIEW = { x: 0, y: 0, w: VIEW_W, h: VIEW_H };

export const DEFAULT_STATE = {
  p0: { x: 160, y: 380 },
  p1: { x: 560, y: 220 },
  t0Deg: -35,
  t1Deg: 20,
  mode: 'roundest',
  param: 0.3,
  paramPoint: { x: 380, y: 420 },
  yUp: false,
  arcChoice: null, // 'small' | 'large' | null (null = follow the signed tangent)
  solutionIndex: 0,
};

/** A fresh deep copy of the defaults, safe to mutate. */
export function defaultState() {
  return structuredClone(DEFAULT_STATE);
}

/** Overlay a restored (possibly partial or null) state on top of the defaults. */
export function withDefaults(partial) {
  return { ...structuredClone(DEFAULT_STATE), ...(partial ?? {}) };
}

// ---------------------------------------------------------------------------
// Serialization for the URL hash and localStorage
// ---------------------------------------------------------------------------

/** Serialize state to the JSON stored in the hash and localStorage. */
export function serializeState(state) {
  return JSON.stringify(state);
}

/** Parse stored JSON back to a state object, or null if it isn't usable. */
export function deserializeState(json) {
  try {
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/** Encode state as the body of a URL hash (without the leading '#'). */
export function encodeHash(state) {
  return encodeURIComponent(serializeState(state));
}

/** Decode a URL hash body (no leading '#') to a state object, or null. */
export function decodeHash(hashBody) {
  if (!hashBody) return null;
  try {
    return deserializeState(decodeURIComponent(hashBody));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Text-input parsing (lossless: Number keeps every digit the user types)
// ---------------------------------------------------------------------------

/**
 * Parse a numeric text field to a finite number, or null. Unlike bare
 * `Number`, an empty or whitespace-only string is rejected rather than
 * silently becoming 0.
 */
export function parseNumber(text) {
  const trimmed = String(text).trim();
  if (trimmed === '') return null;
  const v = Number(trimmed);
  return Number.isFinite(v) ? v : null;
}

/** Parse a `"x, y"` text field to `{x, y}`, or null if it isn't two finite numbers. */
export function parsePoint(text) {
  const parts = String(text).split(',');
  if (parts.length !== 2) return null;
  const x = parseNumber(parts[0]);
  const y = parseNumber(parts[1]);
  return x !== null && y !== null ? { x, y } : null;
}

// ---------------------------------------------------------------------------
// View framing and zoom math
// ---------------------------------------------------------------------------

/**
 * Axis-aligned half-extents `(hx, hy)` of a rotated ellipse's bounding box.
 * `e.theta` is the major-axis angle in radians.
 */
export function ellipseHalfExtents(e) {
  return {
    hx: Math.hypot(e.rx * Math.cos(e.theta), e.ry * Math.sin(e.theta)),
    hy: Math.hypot(e.rx * Math.sin(e.theta), e.ry * Math.cos(e.theta)),
  };
}

/** A mutable bounding-box accumulator; `result()` yields null if nothing was added. */
function makeBounds() {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  return {
    add(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    },
    result() {
      return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
    },
  };
}

/**
 * Bounding box (world coordinates) of just the draggable control points: both
 * points, plus the third point in "through" mode. Returns null if none are
 * finite. This is the "must stay visible" set when framing a huge ellipse.
 */
export function controlPointsBounds(state) {
  const b = makeBounds();
  b.add(state.p0.x, state.p0.y);
  b.add(state.p1.x, state.p1.y);
  if (state.mode === 'through') b.add(state.paramPoint.x, state.paramPoint.y);
  return b.result();
}

/**
 * Bounding box (world coordinates) of everything worth showing: the control
 * points and the ellipse's axis-aligned extent when one is supplied. Returns
 * null if nothing finite is present.
 */
export function contentBounds(state, ellipse) {
  const b = makeBounds();
  b.add(state.p0.x, state.p0.y);
  b.add(state.p1.x, state.p1.y);
  if (state.mode === 'through') b.add(state.paramPoint.x, state.paramPoint.y);
  if (ellipse) {
    const { hx, hy } = ellipseHalfExtents(ellipse);
    b.add(ellipse.cx - hx, ellipse.cy - hy);
    b.add(ellipse.cx + hx, ellipse.cy + hy);
  }
  return b.result();
}

/** Whether `box` fits entirely inside a `w`×`h` window centered at `(cx, cy)`. */
function boxFitsAt(cx, cy, w, h, box) {
  return (
    box.minX >= cx - w / 2 &&
    box.maxX <= cx + w / 2 &&
    box.minY >= cy - h / 2 &&
    box.maxY <= cy + h / 2
  );
}

/**
 * Compute a viewBox `{x, y, w, h}` that frames `bounds` centered and padded at
 * the given canvas `aspect` (width / height), respecting the zoom clamps.
 * Falls back to the default view when there is nothing to frame.
 *
 * `focus` (optional) marks the geometry that must stay visible — the control
 * points. Normally the view is centered on `bounds`, but when `bounds` is too
 * big to fit at the farthest zoom, that center can push the control points off
 * screen (a very long/large ellipse whose center is far from the points). In
 * that case the view re-centers on the focus points, or, if even they can't
 * both fit, on `focus.anchor` (the first point).
 */
export function fitView(bounds, aspect, focus = null) {
  if (!bounds) return { ...DEFAULT_VIEW };
  // Pad, and guard against a zero-area box (e.g. coincident points).
  const cw = (bounds.maxX - bounds.minX) * (1 + 2 * FIT_PAD) || VIEW_W;
  const ch = (bounds.maxY - bounds.minY) * (1 + 2 * FIT_PAD) || VIEW_H;
  const a = aspect > 0 ? aspect : VIEW_W / VIEW_H;

  // Grow the shorter dimension so the box matches the canvas aspect ratio;
  // this keeps the content centered and fully visible without letterboxing.
  let w;
  let h;
  if (cw / ch > a) {
    w = cw;
    h = cw / a;
  } else {
    h = ch;
    w = ch * a;
  }

  // Respect the zoom clamps, scaling both axes together to preserve aspect.
  const clamped = Math.min(MAX_VIEW_W, Math.max(MIN_VIEW_W, w));
  if (clamped !== w) {
    h *= clamped / w;
    w = clamped;
  }

  // Default: center on the content.
  let cx = (bounds.minX + bounds.maxX) / 2;
  let cy = (bounds.minY + bounds.maxY) / 2;

  // If the content didn't fit and that left the control points outside the
  // frame, re-center to keep them visible.
  if (focus && focus.bounds && !boxFitsAt(cx, cy, w, h, focus.bounds)) {
    const fcx = (focus.bounds.minX + focus.bounds.maxX) / 2;
    const fcy = (focus.bounds.minY + focus.bounds.maxY) / 2;
    if (boxFitsAt(fcx, fcy, w, h, focus.bounds)) {
      cx = fcx;
      cy = fcy;
    } else if (focus.anchor) {
      cx = focus.anchor.x;
      cy = focus.anchor.y;
    } else {
      cx = fcx;
      cy = fcy;
    }
  }

  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * Zoom `view` by `factor` (>1 zooms out) about a fixed screen fraction
 * `(fx, fy)` in [0, 1], honoring the zoom clamps. Returns a new view object.
 */
export function zoomView(view, factor, fx, fy) {
  const anchorX = view.x + fx * view.w;
  const anchorY = view.y + fy * view.h;
  const newW = Math.min(MAX_VIEW_W, Math.max(MIN_VIEW_W, view.w * factor));
  const newH = view.h * (newW / view.w);
  return { x: anchorX - fx * newW, y: anchorY - fy * newH, w: newW, h: newH };
}

/** A "nice" grid spacing (1/2/5 × 10^n) giving roughly `divisions` lines across a span. */
export function niceStep(span, divisions = 16) {
  const target = span / divisions;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= target) return m * pow;
  return 10 * pow;
}
