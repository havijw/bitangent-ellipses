/**
 * Ellipses through two points with prescribed tangent directions.
 *
 * Pure geometry: no DOM, no Node APIs. Points are plain `{x, y}` objects and
 * all computation happens in the coordinate system of the inputs.
 *
 * Two points plus two tangent directions fix only four of an ellipse's five
 * degrees of freedom, so the answer is a one-parameter family. With `L0`, `L1`
 * the tangent lines (as linear forms) and `M` the chord line through P0 and
 * P1, every conic tangent to L0 at P0 and to L1 at P1 is
 *
 *     Q_t(x, y) = L0(x, y) * L1(x, y) + t * M(x, y)^2
 *
 * `EllipseFamily` exposes that pencil and a set of solvers that pick one
 * member using a fifth constraint (roundest, rotation, aspect ratio, a radius,
 * or a third point).
 */

import { formatDisplay } from './format.js';

export class EllipseInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EllipseInputError';
  }
}

const TAU = Math.PI * 2;
const PARALLEL_TOL = 1e-9;

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const norm = (a) => Math.hypot(a.x, a.y);
export const unit = (a) => {
  const n = norm(a);
  return { x: a.x / n, y: a.y / n };
};
export const degToRad = (d) => (d * Math.PI) / 180;
export const radToDeg = (r) => (r * 180) / Math.PI;

/** Wrap an angle into (-pi, pi]. */
export function wrapAngle(t) {
  let r = ((((t + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  if (r <= -Math.PI) r += TAU;
  return r;
}

/** Wrap an axis angle into (-pi/2, pi/2]. */
export function wrapHalfAngle(t) {
  let r = ((((t + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI) - Math.PI / 2;
  if (r <= -Math.PI / 2 + 1e-15) r += Math.PI;
  return r;
}

// ---------------------------------------------------------------------------
// Tangent specs
// ---------------------------------------------------------------------------

/**
 * Normalize a tangent specification to a unit direction.
 *
 * Accepted forms:
 *   - a number: slope dy/dx (Infinity for vertical). Slopes carry no orientation.
 *   - {slope}                same as a bare number
 *   - {deg} or {rad}         angle of the tangent, measured from +x toward +y
 *   - {dx, dy}               direction vector
 *
 * Angles and vectors are *signed*: they say which way the curve travels through
 * the point, which is enough to pick between the two arcs of the ellipse.
 * Returns `{ dir, signed }`.
 */
export function tangentDirection(spec) {
  if (typeof spec === 'number') {
    if (Number.isNaN(spec)) throw new EllipseInputError('Tangent slope is NaN');
    if (!Number.isFinite(spec)) return { dir: { x: 0, y: 1 }, signed: false };
    return { dir: unit({ x: 1, y: spec }), signed: false };
  }
  if (spec && typeof spec === 'object') {
    if ('dir' in spec && 'signed' in spec) return spec;
    if ('slope' in spec) return tangentDirection(spec.slope);
    if ('deg' in spec) return tangentDirection({ rad: degToRad(spec.deg) });
    if ('rad' in spec) {
      return { dir: { x: Math.cos(spec.rad), y: Math.sin(spec.rad) }, signed: true };
    }
    if ('dx' in spec && 'dy' in spec) {
      if (Math.hypot(spec.dx, spec.dy) === 0) {
        throw new EllipseInputError('Tangent vector must be non-zero');
      }
      return { dir: unit({ x: spec.dx, y: spec.dy }), signed: true };
    }
  }
  throw new EllipseInputError('Tangent must be a slope number, {deg}, {rad}, or {dx, dy}');
}

// ---------------------------------------------------------------------------
// Linear forms and conics
// ---------------------------------------------------------------------------

/** Line through `p` with direction `d`, as the linear form a*x + b*y + c with a unit normal. */
function lineThrough(p, d) {
  const a = -d.y;
  const b = d.x;
  return { a, b, c: -(a * p.x + b * p.y) };
}

const evalLine = (l, p) => l.a * p.x + l.b * p.y + l.c;

/** Product of two linear forms as conic coefficients {A, B, C, D, E, F}. */
function mulForms(l, m) {
  return {
    A: l.a * m.a,
    B: l.a * m.b + l.b * m.a,
    C: l.b * m.b,
    D: l.a * m.c + l.c * m.a,
    E: l.b * m.c + l.c * m.b,
    F: l.c * m.c,
  };
}

export const conicDiscriminant = (c) => c.B * c.B - 4 * c.A * c.C;

/** Evaluate A x^2 + B x y + C y^2 + D x + E y + F. */
export function evalConic(c, p) {
  return c.A * p.x * p.x + c.B * p.x * p.y + c.C * p.y * p.y + c.D * p.x + c.E * p.y + c.F;
}

function centerAndConstant(c) {
  const det = 4 * c.A * c.C - c.B * c.B;
  const cx = (-2 * c.C * c.D + c.B * c.E) / det;
  const cy = (-2 * c.A * c.E + c.B * c.D) / det;
  // Value of the conic at its center; the quadratic part contributes -(D cx + E cy)/2.
  const Fp = c.F + (c.D * cx + c.E * cy) / 2;
  return { cx, cy, Fp };
}

/**
 * Convert conic coefficients to ellipse parameters, or return null when the
 * conic is not a real, non-degenerate ellipse.
 *
 * `rx` is the semi-major radius and lies along `theta`; `ry` is the semi-minor
 * radius. `theta` is in (-pi/2, pi/2], measured from +x toward +y, so it is
 * directly usable as the SVG arc `x-axis-rotation` when inputs are SVG coords.
 */
export function conicToEllipse(c) {
  const disc = conicDiscriminant(c);
  if (!(disc < 0)) return null;
  const { cx, cy, Fp } = centerAndConstant(c);
  const R = Math.hypot(c.A - c.C, c.B);
  const lHigh = (c.A + c.C + R) / 2;
  const lLow = (c.A + c.C - R) / 2;
  let rx2 = -Fp / lLow;
  let ry2 = -Fp / lHigh;
  if (!(rx2 > 0 && ry2 > 0)) return null;
  const isCircle = R <= 1e-12 * (Math.abs(c.A) + Math.abs(c.C));
  // The eigenvector for lHigh sits at psi = atan2(B, A-C)/2 and, when both
  // eigenvalues share the sign of A+C's dominant term, carries the smaller
  // radius (major axis perpendicular to it). But when A and C are both
  // negative (the conic written with an overall negative scale) the relation
  // between "larger eigenvalue" and "smaller radius" flips. Rather than track
  // that sign case, just compare the two computed radii directly and swap so
  // `rx` is always the semi-major radius and `theta` always points along it.
  let theta = isCircle ? 0 : wrapHalfAngle(0.5 * Math.atan2(c.B, c.A - c.C) + Math.PI / 2);
  if (rx2 < ry2) {
    [rx2, ry2] = [ry2, rx2];
    theta = wrapHalfAngle(theta + Math.PI / 2);
  }
  const rx = Math.sqrt(rx2);
  const ry = Math.sqrt(ry2);
  return {
    cx,
    cy,
    rx,
    ry,
    theta,
    thetaDeg: radToDeg(theta),
    eccentricity: Math.sqrt(Math.max(0, 1 - ry2 / rx2)),
    coeffs: c,
  };
}

/** Classify conic coefficients: ellipse | parabola | hyperbola | degenerate | imaginary. */
export function classifyConic(c) {
  const q = Math.max(Math.abs(c.A), Math.abs(c.B), Math.abs(c.C));
  if (q === 0) return 'degenerate';
  const disc = conicDiscriminant(c);
  if (Math.abs(disc) <= 1e-9 * q * q) return 'parabola';
  if (disc > 0) return 'hyperbola';
  if (conicToEllipse(c)) return 'ellipse';
  const { cx, cy, Fp } = centerAndConstant(c);
  const ref = Math.abs(c.D * cx) + Math.abs(c.E * cy) + Math.abs(c.F);
  return Math.abs(Fp) <= 1e-9 * (ref || 1) ? 'degenerate' : 'imaginary';
}

// ---------------------------------------------------------------------------
// Ellipse geometry helpers
// ---------------------------------------------------------------------------

/** Point on the ellipse at parametric angle `phi`. */
export function ellipsePoint(e, phi) {
  const c = Math.cos(e.theta);
  const s = Math.sin(e.theta);
  const x = e.rx * Math.cos(phi);
  const y = e.ry * Math.sin(phi);
  return { x: e.cx + c * x - s * y, y: e.cy + s * x + c * y };
}

/** Derivative of `ellipsePoint` with respect to `phi`. */
export function ellipseTangent(e, phi) {
  const c = Math.cos(e.theta);
  const s = Math.sin(e.theta);
  const x = -e.rx * Math.sin(phi);
  const y = e.ry * Math.cos(phi);
  return { x: c * x - s * y, y: s * x + c * y };
}

/** Parametric angle of a point (assumed on or near the ellipse). */
export function ellipseParam(e, p) {
  const c = Math.cos(e.theta);
  const s = Math.sin(e.theta);
  const dx = p.x - e.cx;
  const dy = p.y - e.cy;
  const u = c * dx + s * dy;
  const v = -s * dx + c * dy;
  return Math.atan2(v / e.ry, u / e.rx);
}

/** Axis-aligned bounding box of the ellipse. */
export function ellipseBounds(e) {
  const c = Math.cos(e.theta);
  const s = Math.sin(e.theta);
  const hw = Math.sqrt(e.rx * e.rx * c * c + e.ry * e.ry * s * s);
  const hh = Math.sqrt(e.rx * e.rx * s * s + e.ry * e.ry * c * c);
  return { minX: e.cx - hw, maxX: e.cx + hw, minY: e.cy - hh, maxY: e.cy + hh };
}

/** Sample `n + 1` points around the full ellipse. */
export function ellipsePolyline(e, n = 180) {
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(ellipsePoint(e, (TAU * i) / n));
  return pts;
}

// ---------------------------------------------------------------------------
// The family
// ---------------------------------------------------------------------------

// Slider parameter `a` in (0, 1/2) maps to u in R through a logistic curve so
// that numeric searches spend effort near both ends of the range.
const A_LIMIT = 0.5;
const U_RANGE = 14;
const aFromU = (u) => A_LIMIT / (1 + Math.exp(-u));
const uFromA = (a) => Math.log(a / (A_LIMIT - a));

export class EllipseFamily {
  /**
   * @param {{x:number,y:number}} p0
   * @param {*} tangent0  see `tangentDirection`
   * @param {{x:number,y:number}} p1
   * @param {*} tangent1
   */
  constructor(p0, tangent0, p1, tangent1) {
    const t0 = tangentDirection(tangent0);
    const t1 = tangentDirection(tangent1);
    const chord = sub(p1, p0);
    const chordLength = norm(chord);
    const scaleRef = Math.max(chordLength, norm(p0), norm(p1), 1e-300);
    if (chordLength <= 1e-12 * scaleRef) {
      throw new EllipseInputError('P0 and P1 coincide; two distinct points are required');
    }
    const chordDir = unit(chord);
    if (Math.abs(cross(t0.dir, chordDir)) < PARALLEL_TOL) {
      throw new EllipseInputError(
        'The tangent at P0 points along the chord P0P1; no ellipse can be tangent there and also pass through P1',
      );
    }
    if (Math.abs(cross(t1.dir, chordDir)) < PARALLEL_TOL) {
      throw new EllipseInputError(
        'The tangent at P1 points along the chord P0P1; no ellipse can be tangent there and also pass through P0',
      );
    }

    this.p0 = { x: p0.x, y: p0.y };
    this.p1 = { x: p1.x, y: p1.y };
    this.d0 = t0.dir;
    this.d1 = t1.dir;
    this.signed0 = t0.signed;
    this.signed1 = t1.signed;
    this.chordLength = chordLength;
    this.halfChord = chordLength / 2;
    this.mid = scale(add(p0, p1), 0.5);

    this.L0 = lineThrough(p0, this.d0);
    this.L1 = lineThrough(p1, this.d1);
    this.M = lineThrough(p0, chordDir);
    this.P = mulForms(this.L0, this.L1);
    this.S = mulForms(this.M, this.M);

    this.parallel = Math.abs(cross(this.d0, this.d1)) < PARALLEL_TOL;
    // L0*L1 at the chord midpoint; never zero once the checks above pass.
    this._k0 = evalLine(this.L0, this.mid) * evalLine(this.L1, this.mid);

    if (this.parallel) {
      this.vertex = null;
      const md = evalLine(this.M, add(this.p0, this.d0)); // = nM . d0
      this._md2 = md * md;
    } else {
      const s = cross(chord, this.d1) / cross(this.d0, this.d1);
      this.vertex = add(p0, scale(this.d0, s));
      const mV = evalLine(this.M, this.vertex);
      this._mV2 = mV * mV;
    }
  }

  /** Conic coefficients of Q_t = L0*L1 + t*M^2. */
  coeffsAt(t) {
    const { P, S } = this;
    return {
      A: P.A + t * S.A,
      B: P.B + t * S.B,
      C: P.C + t * S.C,
      D: P.D + t * S.D,
      E: P.E + t * S.E,
      F: P.F + t * S.F,
    };
  }

  /** The unique family parameter whose conic passes through `r`. */
  tThroughPoint(r) {
    const m = evalLine(this.M, r);
    if (Math.abs(m) <= 1e-12 * this.chordLength) {
      throw new EllipseInputError('The third point lies on the line through P0 and P1');
    }
    return -(evalLine(this.L0, r) * evalLine(this.L1, r)) / (m * m);
  }

  /**
   * Point the "apex" parameter `a` refers to. With intersecting tangents it is
   * the point a fraction `a` of the way from the chord midpoint to the tangent
   * intersection; a = 1/2 gives the parabola, a in (0, 1/2) gives ellipses.
   * With parallel tangents the chord is a diameter and `a` maps to the half
   * length of the conjugate diameter, b = h * a / (1/2 - a).
   */
  apexPoint(a) {
    if (this.parallel) {
      const b = (this.halfChord * a) / (A_LIMIT - a);
      return add(this.mid, scale(this.d0, b));
    }
    return add(this.mid, scale(sub(this.vertex, this.mid), a));
  }

  tFromApex(a) {
    if (!(a > 0 && a < 1)) throw new EllipseInputError('Apex parameter must be in (0, 1)');
    if (this.parallel) {
      const b = (this.halfChord * a) / (A_LIMIT - a);
      return -this._k0 / (b * b * this._md2);
    }
    const r = (1 - a) / a;
    return (-this._k0 * r * r) / this._mV2;
  }

  /** Inverse of `tFromApex`; null when `t` has no apex on the segment (imaginary members). */
  apexFromT(t) {
    if (this.parallel) {
      const b2 = -this._k0 / (t * this._md2);
      if (!(b2 > 0)) return null;
      const b = Math.sqrt(b2);
      return (A_LIMIT * b) / (this.halfChord + b);
    }
    const K = (-t * this._mV2) / this._k0;
    if (!(K > 0)) return null;
    return 1 / (1 + Math.sqrt(K));
  }

  /** Full description of the family member at parameter `t`. */
  solve(t) {
    const coeffs = this.coeffsAt(t);
    const ellipse = conicToEllipse(coeffs);
    const kind = ellipse ? 'ellipse' : classifyConic(coeffs);
    return { t, a: this.apexFromT(t), coeffs, kind, ellipse };
  }

  atApex(a) {
    return this.solve(this.tFromApex(a));
  }

  throughPoint(r) {
    return this.solve(this.tThroughPoint(r));
  }

  /** The member with the smallest rx/ry ratio (a circle when one exists). */
  roundest() {
    const ratioAtU = (u) => {
      const s = this.atApex(aFromU(u));
      return s.ellipse ? s.ellipse.rx / s.ellipse.ry : Infinity;
    };
    const N = 256;
    let bestU = 0;
    let bestV = Infinity;
    for (let i = 0; i <= N; i++) {
      const u = -U_RANGE + (2 * U_RANGE * i) / N;
      const v = ratioAtU(u);
      if (v < bestV) {
        bestV = v;
        bestU = u;
      }
    }
    const step = (2 * U_RANGE) / N;
    let lo = bestU - step;
    let hi = bestU + step;
    const g = (Math.sqrt(5) - 1) / 2;
    let x1 = hi - g * (hi - lo);
    let x2 = lo + g * (hi - lo);
    let f1 = ratioAtU(x1);
    let f2 = ratioAtU(x2);
    for (let i = 0; i < 120 && hi - lo > 1e-13; i++) {
      if (f1 < f2) {
        hi = x2;
        x2 = x1;
        f2 = f1;
        x1 = hi - g * (hi - lo);
        f1 = ratioAtU(x1);
      } else {
        lo = x1;
        x1 = x2;
        f1 = f2;
        x2 = lo + g * (hi - lo);
        f2 = ratioAtU(x2);
      }
    }
    return this.atApex(aFromU((lo + hi) / 2));
  }

  /**
   * The member whose axes are aligned with angle `deg` (degrees from +x).
   * Axis alignment is a linear condition in `t`, so there is exactly one
   * candidate; it may turn out not to be an ellipse.
   */
  withRotation(deg) {
    const th = degToRad(deg);
    const c2 = Math.cos(2 * th);
    const s2 = Math.sin(2 * th);
    const g = (c) => c.B * c2 - (c.A - c.C) * s2;
    const g0 = g(this.P);
    const g1 = g(this.S);
    if (Math.abs(g1) < 1e-12) {
      if (Math.abs(g0) < 1e-12) {
        throw new EllipseInputError(
          'Every ellipse in this family already has its axes at that angle; pick a different constraint',
        );
      }
      throw new EllipseInputError('No conic in this family has its axes at that angle');
    }
    return this.solve(-g0 / g1);
  }

  /**
   * Members with semi-major / semi-minor ratio `k` (values below 1 are inverted).
   * The condition is quadratic in `t`, so there are 0, 1, or 2 solutions.
   */
  withAspectRatio(k) {
    if (!(k > 0) || !Number.isFinite(k)) throw new EllipseInputError('Aspect ratio must be a positive number');
    if (k < 1) k = 1 / k;
    const { P, S } = this;
    const k2 = k * k;
    const w = (k2 + 1) * (k2 + 1);
    const s0 = P.A + P.C;
    const s1 = S.A + S.C;
    const q0 = P.A * P.C - (P.B * P.B) / 4;
    const q1 = P.A * S.C + S.A * P.C - (P.B * S.B) / 2;
    const qa = k2 * s1 * s1;
    const qb = 2 * k2 * s0 * s1 - w * q1;
    const qc = k2 * s0 * s0 - w * q0;
    const roots = solveQuadratic(qa, qb, qc);
    const out = roots.map((t) => this.solve(t)).filter((s) => s.ellipse);
    return sortByApex(out);
  }

  /**
   * Members whose `rx` (semi-major) or `ry` (semi-minor) equals `value`.
   * Solved numerically over the apex parameter; returns 0, 1, or 2 solutions.
   */
  withRadius(which, value) {
    if (which !== 'rx' && which !== 'ry') throw new EllipseInputError("Radius must be 'rx' or 'ry'");
    if (!(value > 0) || !Number.isFinite(value)) throw new EllipseInputError('Radius must be a positive number');
    const f = (u) => {
      const s = this.atApex(aFromU(u));
      return s.ellipse ? s.ellipse[which] - value : NaN;
    };
    const N = 600;
    const us = [];
    const fs = [];
    for (let i = 0; i <= N; i++) {
      const u = -U_RANGE + (2 * U_RANGE * i) / N;
      us.push(u);
      fs.push(f(u));
    }
    // A sign change of `rx(u) - value` is only a genuine root where `rx` is a
    // continuous, well-conditioned function of `u`. Near the parabola boundary
    // `rx` diverges, and near the chord-collapse end the ellipse degenerates
    // (ry -> 0) and the computed radius jitters, so a bracket can straddle a
    // pole or numerical noise rather than a real crossing. Bisection would then
    // converge to that artifact and hand back an ellipse whose radius isn't the
    // requested value. Accept a candidate only if it actually hits the target.
    const accept = (s) =>
      s.ellipse && Math.abs(s.ellipse[which] - value) <= 1e-6 * value ? out.push(s) : null;
    const out = [];
    for (let i = 0; i < N; i++) {
      const f0 = fs[i];
      const f1 = fs[i + 1];
      if (Number.isNaN(f0) || Number.isNaN(f1)) continue;
      if (f0 === 0) {
        accept(this.atApex(aFromU(us[i])));
        continue;
      }
      if (f0 * f1 < 0) {
        let lo = us[i];
        let hi = us[i + 1];
        let flo = f0;
        for (let it = 0; it < 100; it++) {
          const mid = (lo + hi) / 2;
          const fm = f(mid);
          if (fm === 0 || hi - lo < 1e-14) {
            lo = hi = mid;
            break;
          }
          if (flo * fm < 0) hi = mid;
          else {
            lo = mid;
            flo = fm;
          }
        }
        accept(this.atApex(aFromU((lo + hi) / 2)));
      }
    }
    return sortByApex(dedupeByApex(out));
  }
}

function sortByApex(solutions) {
  return solutions.sort((x, y) => (x.a ?? 0) - (y.a ?? 0));
}

/** Drop solutions with a near-identical apex parameter (the same ellipse found twice). */
function dedupeByApex(solutions) {
  const sorted = sortByApex([...solutions]);
  const out = [];
  for (const s of sorted) {
    const prev = out[out.length - 1];
    if (!prev || Math.abs((s.a ?? 0) - (prev.a ?? 0)) > 1e-6) out.push(s);
  }
  return out;
}

function solveQuadratic(a, b, c) {
  if (Math.abs(a) < 1e-300) {
    if (Math.abs(b) < 1e-300) return [];
    return [-c / b];
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) {
    // A discriminant that is negative only within rounding error of zero is a
    // double root at a numerically flat extremum, not a genuine "no real
    // solution". This is what "aspect ratio" hits when its target is carried
    // over from "roundest": that value sits exactly at the family's minimum
    // ratio, where the two roots coincide and disc(k) crosses zero, so
    // floating-point noise can push the computed disc just below zero. Return
    // the coincident root there; a truly out-of-range request (a ratio below
    // the achievable minimum) stays negative by far more than rounding and
    // still yields no solution.
    if (-disc <= 1e-12 * (b * b + Math.abs(4 * a * c))) return [-b / (2 * a)];
    return [];
  }
  const sq = Math.sqrt(disc);
  // Stable form: avoid cancellation in the smaller root.
  const q = -(b + Math.sign(b || 1) * sq) / 2;
  const r1 = q / a;
  if (q === 0) return [r1];
  const r2 = c / q;
  return Math.abs(r1 - r2) < 1e-15 * Math.max(1, Math.abs(r1)) ? [r1] : [r1, r2];
}

// ---------------------------------------------------------------------------
// Convenience entry point shared by the CLI and the UI
// ---------------------------------------------------------------------------

export const MODES = ['roundest', 'apex', 'rotation', 'ratio', 'rx', 'ry', 'through'];

/**
 * Build the family and apply one fifth-constraint mode.
 *
 * @param {object} input
 * @param {{x,y}} input.p0
 * @param {{x,y}} input.p1
 * @param {*} input.t0   tangent spec at p0
 * @param {*} input.t1   tangent spec at p1
 * @param {string} input.mode   one of MODES (default 'roundest')
 * @param {*} input.param  number for apex/rotation/ratio/rx/ry; {x,y} for 'through'
 * @returns {{ family: EllipseFamily, solutions: Array }}
 *   `solutions` holds only real ellipses; `rejected` (if present) holds the
 *   non-ellipse candidate so callers can explain why nothing came back.
 */
export function solveEllipse({ p0, p1, t0, t1, mode = 'roundest', param }) {
  const family = new EllipseFamily(p0, t0, p1, t1);
  return { family, ...familySolutions(family, mode, param) };
}

/**
 * Apply one fifth-constraint `mode` to an already-built `family`, returning
 * `{ solutions, rejected }` (real ellipses and the discarded non-ellipse
 * candidates, respectively). `param` is a number for apex/rotation/ratio/rx/ry
 * and a `{x, y}` point for 'through'.
 *
 * This is the single source of truth for the mode dispatch and its app-level
 * guards; both `solveEllipse` and the browser UI call through here so their
 * behavior can never drift apart. The guards reject inputs that would be
 * geometrically meaningless given the "rx is the semi-major axis" invariant:
 * an aspect ratio below 1 (which would swap the axis roles) and an rx shorter
 * than half the chord P0P1 (no ellipse through both points can have a
 * semi-major axis shorter than half of one of its chords).
 */
export function familySolutions(family, mode, param) {
  let candidates;
  switch (mode) {
    case 'roundest':
      candidates = [family.roundest()];
      break;
    case 'apex':
      candidates = [family.atApex(Number(param))];
      break;
    case 'rotation':
      candidates = [family.withRotation(Number(param))];
      break;
    case 'ratio': {
      const k = Number(param);
      if (!(k >= 1)) {
        throw new EllipseInputError('Aspect ratio (major / minor) must be at least 1.');
      }
      candidates = family.withAspectRatio(k);
      break;
    }
    case 'rx':
    case 'ry': {
      const value = Number(param);
      if (mode === 'rx' && value < family.halfChord) {
        const min = formatDisplay(family.halfChord);
        throw new EllipseInputError(
          `rx must be at least ${min} (half the distance between P0 and P1) \u2014 no ellipse through both points can have a shorter semi-major axis.`,
        );
      }
      candidates = family.withRadius(mode, value);
      break;
    }
    case 'through':
      candidates = [family.throughPoint(param)];
      break;
    default:
      throw new EllipseInputError(`Unknown mode '${mode}'; expected one of ${MODES.join(', ')}`);
  }
  return {
    solutions: candidates.filter((s) => s.ellipse),
    rejected: candidates.filter((s) => !s.ellipse),
  };
}

/** Midpoint (by parametric angle) of the small arc of `e` between `p0` and `p1`. */
export function smallArcMidpoint(e, p0, p1) {
  const phi0 = ellipseParam(e, p0);
  const phi1 = ellipseParam(e, p1);
  const delta = wrapAngle(phi1 - phi0); // shortest signed sweep, |delta| <= PI
  return ellipsePoint(e, phi0 + delta / 2);
}

/**
 * The control value for `mode` that reproduces `prev` (a solved solution, i.e.
 * `{ ellipse, a }`), so switching modes keeps the displayed shape put. Returns
 * `{ param }` for the value modes, `{ paramPoint }` for 'through', and `{}`
 * when there is nothing to carry ('roundest', or apex without a family
 * position). `p0`/`p1` are the chord endpoints, needed for 'through'.
 */
export function continuityParam(mode, prev, p0, p1) {
  const e = prev.ellipse;
  switch (mode) {
    case 'apex':
      return typeof prev.a === 'number' ? { param: prev.a } : {};
    case 'rotation':
      // The rotation solve is 90-degree periodic, so fold the ellipse's axis
      // angle into the slider's [0, 90) window; it reproduces the same member.
      return { param: ((e.thetaDeg % 90) + 90) % 90 };
    case 'ratio':
      return { param: e.rx / e.ry };
    case 'rx':
      return { param: e.rx };
    case 'ry':
      return { param: e.ry };
    case 'through':
      return { paramPoint: smallArcMidpoint(e, p0, p1) };
    default:
      return {};
  }
}

/**
 * Index of the solution whose family position (apex `a`) is closest to
 * `targetA`. Used to keep the displayed member fixed when a value mode
 * (ratio/rx/ry) offers two ellipses for the same value.
 */
export function matchSolutionIndex(solutions, targetA) {
  let bestIdx = 0;
  let bestD = Infinity;
  solutions.forEach((sol, i) => {
    const d = Math.abs((sol.a ?? 0) - targetA);
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
    }
  });
  return bestIdx;
}
