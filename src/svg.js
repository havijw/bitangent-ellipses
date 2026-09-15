/**
 * SVG arc export for an ellipse solved by `EllipseFamily`.
 *
 * SVG's `<path>` A command and its "large-arc"/"sweep" flags are defined in a
 * y-down coordinate system where a positive `x-axis-rotation` and a positive
 * sweep both mean "clockwise on screen". This module assumes y-down input by
 * default (matching the SVG canvas it's meant to feed); pass `yUp: true` to
 * flip the rotation angle and sweep flag when the caller's points are in a
 * conventional math (y-up) frame.
 */

import { ellipseParam, ellipseTangent, wrapAngle } from './ellipse.js';

function normalizeTheta(thetaDeg, yUp) {
  return yUp ? -thetaDeg : thetaDeg;
}

/**
 * Mirror an ellipse and a point across the x-axis (y -> -y). Used to view a
 * y-up solution the way it will actually sweep once drawn in SVG's y-down
 * pixel space. Mirroring is only faithful if *everything* — the ellipse's
 * center and rotation, and the query point — is flipped together; flipping
 * just the point while leaving the center in place would silently corrupt
 * the parametric angle for any ellipse not centered on y = 0.
 */
function mirrorY(ellipse, p) {
  return {
    e: { ...ellipse, cy: -ellipse.cy, theta: -ellipse.theta },
    p: { x: p.x, y: -p.y },
  };
}

/**
 * Compute both candidate arcs (sweeping each way) between p0 and p1 along the
 * ellipse. Returns `{ cw, ccw }`, each `{ largeArc, sweep, deltaPhi } `, plus
 * the shared parametric endpoints `phi0`, `phi1`.
 */
export function arcCandidates(ellipse, p0, p1, { yUp = false } = {}) {
  const m0 = yUp ? mirrorY(ellipse, p0) : { e: ellipse, p: p0 };
  const m1 = yUp ? mirrorY(ellipse, p1) : { e: ellipse, p: p1 };
  const phi0 = ellipseParam(m0.e, m0.p);
  const phi1 = ellipseParam(m1.e, m1.p);

  // Sweeping phi upward (increasing) draws the arc clockwise on an SVG canvas
  // because y grows downward there; sweep=1 means clockwise.
  let up = wrapAngle(phi1 - phi0);
  if (up < 0) up += Math.PI * 2;
  const down = up - Math.PI * 2; // negative, the other way around

  const describe = (deltaPhi) => ({
    deltaPhi,
    sweep: deltaPhi > 0 ? 1 : 0,
    largeArc: Math.abs(deltaPhi) > Math.PI ? 1 : 0,
  });

  return { phi0, phi1, cw: describe(up), ccw: describe(down) };
}

/**
 * Pick the arc whose direction of travel at p0 matches the signed tangent, if
 * one was supplied; otherwise fall back to `preferLargeArc`.
 */
export function chooseArc(ellipse, p0, p1, opts = {}) {
  const { yUp = false, tangentAtP0 = null, preferLargeArc = false } = opts;
  const { cw, ccw } = arcCandidates(ellipse, p0, p1, { yUp });
  if (tangentAtP0 && tangentAtP0.signed) {
    const m0 = yUp ? mirrorY(ellipse, p0) : { e: ellipse, p: p0 };
    const phi0 = ellipseParam(m0.e, m0.p);
    const velocity = ellipseTangent(m0.e, phi0); // direction of increasing phi
    const d = yUp ? { x: tangentAtP0.dir.x, y: -tangentAtP0.dir.y } : tangentAtP0.dir;
    const agreesWithIncreasingPhi = velocity.x * d.x + velocity.y * d.y > 0;
    return agreesWithIncreasingPhi ? cw : ccw;
  }
  const large = cw.largeArc ? cw : ccw;
  const small = cw.largeArc ? ccw : cw;
  return preferLargeArc ? large : small;
}

/**
 * Build the `d` attribute of an SVG path drawing the arc from p0 to p1.
 * `arc` is one of the objects returned by `arcCandidates`/`chooseArc`.
 *
 * The arc uses SVG's relative arc command (`a`), so its endpoint is expressed
 * as an offset from the start point rather than an absolute coordinate. The
 * leading move stays absolute (`M`) to anchor the path; a relative `m` in the
 * first position would be treated as absolute anyway.
 *
 * When `yUp` is set, the emitted coordinates are y-flipped so the path
 * renders correctly on a normal (y-down) SVG canvas with no extra transform,
 * matching the convention `ellipseMarkup`/`standaloneSvg` use for the center.
 */
export function arcPath(ellipse, p0, p1, arc, { yUp = false } = {}) {
  const rot = normalizeTheta(ellipse.thetaDeg, yUp);
  const start = yUp ? { x: p0.x, y: -p0.y } : p0;
  const end = yUp ? { x: p1.x, y: -p1.y } : p1;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  // Emit full-precision numbers (JS renders the shortest round-trippable form)
  // so pasted coordinates keep every significant digit the solve produced.
  return [
    `M ${start.x} ${start.y}`,
    `a ${ellipse.rx} ${ellipse.ry} ${rot} ${arc.largeArc} ${arc.sweep} ${dx} ${dy}`,
  ].join(' ');
}

/**
 * Express the arc as an ARC path parameter object: a relative arc given by
 * `rx`/`ry`, the `(dx, dy)` offset from the start point, the x-axis `rotation`
 * in degrees, and enum `direction`/`arc_size`. The numbers mirror `arcPath`
 * exactly (same coordinate handling), so the object and the SVG `a` command
 * always agree.
 *
 * `direction` follows SVG's sweep flag: sweep = 1 sweeps clockwise on a y-down
 * canvas, so 1 -> CLOCKWISE and 0 -> COUNTER_CLOCKWISE. `arc_size` follows the
 * large-arc flag: 1 -> LARGE, 0 -> SMALL.
 */
export function arcPathParameter(ellipse, p0, p1, arc, { yUp = false } = {}) {
  const rot = normalizeTheta(ellipse.thetaDeg, yUp);
  const start = yUp ? { x: p0.x, y: -p0.y } : p0;
  const end = yUp ? { x: p1.x, y: -p1.y } : p1;
  // Full-precision doubles: JSON.stringify renders them losslessly and they
  // round-trip exactly, so no significant digits are dropped on copy/paste.
  return {
    type: 'ARC',
    rx: ellipse.rx,
    ry: ellipse.ry,
    dx: end.x - start.x,
    dy: end.y - start.y,
    rotation: rot,
    direction: arc.sweep === 1 ? 'CLOCKWISE' : 'COUNTER_CLOCKWISE',
    arc_size: arc.largeArc === 1 ? 'LARGE' : 'SMALL',
  };
}

/** `<ellipse>` markup for the full ellipse, for overlay / verification. */
export function ellipseMarkup(ellipse, { yUp = false, attrs = '' } = {}) {
  const rot = normalizeTheta(ellipse.thetaDeg, yUp);
  const cy = yUp ? -ellipse.cy : ellipse.cy;
  return `<ellipse cx="${ellipse.cx}" cy="${cy}" rx="${ellipse.rx}" ry="${
    ellipse.ry
  }" transform="rotate(${rot} ${ellipse.cx} ${cy})"${attrs ? ` ${attrs}` : ''} />`;
}

/** Convenience: full standalone SVG document for eyeballing a solution. */
export function standaloneSvg({ ellipse, p0, p1, arc, yUp = false, width = 480, height = 360, pad = 40 }) {
  const d = arcPath(ellipse, p0, p1, arc, { yUp });
  const markup = ellipseMarkup(ellipse, { yUp, attrs: 'fill="none" stroke="#94a3b8" stroke-dasharray="4 3"' });
  const cy0 = yUp ? -p0.y : p0.y;
  const cy1 = yUp ? -p1.y : p1.y;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${
    ellipse.cx - ellipse.rx - pad
  } ${(yUp ? -ellipse.cy : ellipse.cy) - Math.max(ellipse.rx, ellipse.ry) - pad} ${
    2 * Math.max(ellipse.rx, ellipse.ry) + 2 * pad
  } ${2 * Math.max(ellipse.rx, ellipse.ry) + 2 * pad}">
  ${markup}
  <path d="${d}" fill="none" stroke="#0ea5e9" stroke-width="2" />
  <circle cx="${p0.x}" cy="${cy0}" r="3" fill="#16a34a" />
  <circle cx="${p1.x}" cy="${cy1}" r="3" fill="#dc2626" />
</svg>`;
}
