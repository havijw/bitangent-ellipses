import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EllipseFamily,
  EllipseInputError,
  conicToEllipse,
  classifyConic,
  evalConic,
  ellipsePoint,
  ellipseTangent,
  tangentDirection,
  solveEllipse,
} from '../src/ellipse.js';

const EPS = 1e-6;

function assertOnConic(coeffs, p, tol = 1e-6) {
  assert.ok(Math.abs(evalConic(coeffs, p)) < tol, `point not on conic: residual ${evalConic(coeffs, p)}`);
}

// A solved family member should always satisfy the four original constraints:
// pass through both points, and match both tangent directions there.
function assertSatisfiesConstraints(family, solution, tol = 1e-6) {
  const { coeffs } = solution;
  assertOnConic(coeffs, family.p0, tol);
  assertOnConic(coeffs, family.p1, tol);
  assertTangentMatches(coeffs, family.p0, family.d0, tol);
  assertTangentMatches(coeffs, family.p1, family.d1, tol);
}

// Gradient of the conic at p must be perpendicular to the tangent direction.
function assertTangentMatches(coeffs, p, dir, tol) {
  const gx = 2 * coeffs.A * p.x + coeffs.B * p.y + coeffs.D;
  const gy = coeffs.B * p.x + 2 * coeffs.C * p.y + coeffs.E;
  const gradDotDir = gx * dir.x + gy * dir.y;
  const scale = Math.hypot(gx, gy) || 1;
  assert.ok(Math.abs(gradDotDir) / scale < tol, `tangent mismatch: ${gradDotDir / scale}`);
}

test('symmetric case: roundest ellipse is an exact circle', () => {
  const family = new EllipseFamily({ x: 0, y: 0 }, { deg: 45 }, { x: 100, y: 0 }, { deg: -45 });
  const s = family.roundest();
  assert.equal(s.kind, 'ellipse');
  assert.ok(Math.abs(s.ellipse.rx - s.ellipse.ry) < EPS);
  assert.ok(Math.abs(s.ellipse.cx - 50) < EPS);
  assert.ok(Math.abs(s.ellipse.cy - -50) < EPS);
  assertSatisfiesConstraints(family, s);
});

test('roundest ellipse satisfies all four constraints for an asymmetric case', () => {
  const family = new EllipseFamily({ x: 0, y: 0 }, { deg: 30 }, { x: 120, y: 40 }, -0.5);
  const s = family.roundest();
  assert.equal(s.kind, 'ellipse');
  assertSatisfiesConstraints(family, s);
});

test('every ellipse point satisfies the solved conic equation', () => {
  const family = new EllipseFamily({ x: 0, y: 0 }, { deg: 20 }, { x: 80, y: 30 }, { deg: 100 });
  const s = family.roundest();
  for (let i = 0; i < 12; i++) {
    const phi = (i / 12) * Math.PI * 2;
    assertOnConic(s.coeffs, ellipsePoint(s.ellipse, phi));
  }
});

test('round-trip: recovering a known ellipse via a third point', () => {
  const truth = { cx: 12, cy: -7, rx: 30, ry: 18, theta: (25 * Math.PI) / 180 };
  const phi0 = 0.4;
  const phi1 = 2.1;
  const phi2 = 4.0; // third point, distinct from the other two
  const p0 = ellipsePoint(truth, phi0);
  const p1 = ellipsePoint(truth, phi1);
  const p2 = ellipsePoint(truth, phi2);
  const d0 = ellipseTangent(truth, phi0);
  const d1 = ellipseTangent(truth, phi1);

  const family = new EllipseFamily(p0, { dx: d0.x, dy: d0.y }, p1, { dx: d1.x, dy: d1.y });
  const s = family.throughPoint(p2);
  assert.equal(s.kind, 'ellipse');
  assert.ok(Math.abs(s.ellipse.rx - truth.rx) < 1e-6, `rx: ${s.ellipse.rx} vs ${truth.rx}`);
  assert.ok(Math.abs(s.ellipse.ry - truth.ry) < 1e-6, `ry: ${s.ellipse.ry} vs ${truth.ry}`);
  assert.ok(Math.abs(s.ellipse.cx - truth.cx) < 1e-6);
  assert.ok(Math.abs(s.ellipse.cy - truth.cy) < 1e-6);
});

// Not every rotation angle or aspect ratio corresponds to a real ellipse for
// an arbitrary pair of points/tangents (the family may only ever produce a
// hyperbola at that particular angle). Building the two points and tangents
// from a known ellipse guarantees at least that ellipse's own angle/ratio is
// achievable, which is what these two tests check.
function familyFromKnownEllipse(truth, phi0, phi1) {
  const p0 = ellipsePoint(truth, phi0);
  const p1 = ellipsePoint(truth, phi1);
  const d0 = ellipseTangent(truth, phi0);
  const d1 = ellipseTangent(truth, phi1);
  return new EllipseFamily(p0, { dx: d0.x, dy: d0.y }, p1, { dx: d1.x, dy: d1.y });
}

test('withRotation returns an ellipse whose axes sit at the requested angle', () => {
  const truth = { cx: 5, cy: 8, rx: 40, ry: 22, theta: (37 * Math.PI) / 180 };
  const family = familyFromKnownEllipse(truth, 0.6, 2.4);
  const s = family.withRotation(37);
  assert.equal(s.kind, 'ellipse');
  const normalized = ((s.ellipse.thetaDeg % 180) + 180) % 180;
  const target = ((37 % 180) + 180) % 180;
  const diff = Math.min(Math.abs(normalized - target), 180 - Math.abs(normalized - target));
  assert.ok(diff < 1e-4, `theta ${s.ellipse.thetaDeg} vs requested 37`);
  assertSatisfiesConstraints(family, s);
});

test('withAspectRatio returns ellipses matching the requested ratio, including the known one', () => {
  const truth = { cx: -3, cy: 4, rx: 50, ry: 20, theta: (12 * Math.PI) / 180 };
  const family = familyFromKnownEllipse(truth, 0.5, 3.0);
  const solutions = family.withAspectRatio(truth.rx / truth.ry);
  assert.ok(solutions.length >= 1);
  for (const s of solutions) {
    const ratio = s.ellipse.rx / s.ellipse.ry;
    assert.ok(Math.abs(ratio - truth.rx / truth.ry) < 1e-6, `ratio ${ratio}`);
    assertSatisfiesConstraints(family, s);
  }
  assert.ok(
    solutions.some((s) => Math.abs(s.ellipse.rx - truth.rx) < 1e-4 && Math.abs(s.ellipse.ry - truth.ry) < 1e-4),
    'expected the known ellipse to be among the solutions',
  );
});

test('withRadius(rx, value) returns ellipses with that semi-major radius', () => {
  const family = new EllipseFamily({ x: 0, y: 0 }, { deg: 20 }, { x: 90, y: 10 }, { deg: 210 });
  const solutions = family.withRadius('rx', 80);
  assert.ok(solutions.length >= 1, 'expected at least one solution');
  for (const s of solutions) {
    assert.ok(Math.abs(s.ellipse.rx - 80) < 1e-4);
    assertSatisfiesConstraints(family, s, 1e-4);
  }
});

test('apex = 1/2 is exactly the parabola boundary; beyond it is a hyperbola', () => {
  const family = new EllipseFamily({ x: 0, y: 0 }, { deg: 25 }, { x: 90, y: 15 }, { deg: 200 });
  const atHalf = family.atApex(0.5);
  assert.equal(atHalf.kind, 'parabola');
  const beyond = family.atApex(0.75);
  assert.equal(beyond.kind, 'hyperbola');
  const before = family.atApex(0.25);
  assert.equal(before.kind, 'ellipse');
});

test('parallel tangents: chord is a diameter of every ellipse in the family', () => {
  const family = new EllipseFamily({ x: 0, y: 0 }, { deg: 90 }, { x: 40, y: 0 }, { deg: 90 });
  assert.ok(family.parallel);
  const s = family.atApex(0.3);
  assert.equal(s.kind, 'ellipse');
  assert.ok(Math.abs(s.ellipse.cx - 20) < EPS);
  assert.ok(Math.abs(s.ellipse.cy - 0) < EPS);
  assertSatisfiesConstraints(family, s);
});

test('coincident points are rejected', () => {
  assert.throws(() => new EllipseFamily({ x: 5, y: 5 }, 1, { x: 5, y: 5 }, -1), EllipseInputError);
});

test('a tangent parallel to the chord is rejected', () => {
  // chord along the x-axis; tangent at P0 also along the x-axis
  assert.throws(() => new EllipseFamily({ x: 0, y: 0 }, 0, { x: 10, y: 0 }, 1), EllipseInputError);
});

test('tangentDirection accepts slope, degrees, and vectors', () => {
  assert.ok(Math.abs(tangentDirection(1).dir.x - tangentDirection(1).dir.y) < EPS);
  assert.equal(tangentDirection(1).signed, false);
  const byDeg = tangentDirection({ deg: 90 });
  assert.ok(Math.abs(byDeg.dir.x) < EPS);
  assert.equal(byDeg.signed, true);
  const byVec = tangentDirection({ dx: 0, dy: -5 });
  assert.ok(Math.abs(byVec.dir.y - -1) < EPS);
});

test('solveEllipse: high-level entry point exercises every mode', () => {
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 100, y: 30 };
  const t0 = { deg: 20 };
  const t1 = { deg: 190 };
  assert.equal(solveEllipse({ p0, p1, t0, t1, mode: 'roundest' }).solutions.length, 1);
  assert.equal(solveEllipse({ p0, p1, t0, t1, mode: 'apex', param: 0.2 }).solutions.length, 1);
  // The roundest member of this family already has an axis ratio of ~8.9, so
  // any ratio below that is unreachable; 10 is comfortably on the ellipse side.
  assert.ok(solveEllipse({ p0, p1, t0, t1, mode: 'ratio', param: 10 }).solutions.length >= 1);
  assert.ok(solveEllipse({ p0, p1, t0, t1, mode: 'rx', param: 90 }).solutions.length >= 1);
  assert.equal(
    solveEllipse({ p0, p1, t0, t1, mode: 'through', param: { x: 50, y: -40 } }).solutions.length,
    1,
  );
  assert.throws(() => solveEllipse({ p0, p1, t0, t1, mode: 'bogus' }));
});

test('classifyConic distinguishes ellipse, parabola, and hyperbola', () => {
  assert.equal(classifyConic({ A: 1, B: 0, C: 1, D: 0, E: 0, F: -1 }), 'ellipse');
  assert.equal(classifyConic({ A: 1, B: 0, C: 0, D: 0, E: -1, F: 0 }), 'parabola');
  assert.equal(classifyConic({ A: 1, B: 0, C: -1, D: 0, E: 0, F: -1 }), 'hyperbola');
});

test('conicToEllipse always reports rx as the semi-major radius', () => {
  // A conic written with an overall-negative scale exercises the
  // both-eigenvalues-negative branch that previously mixed up rx/ry.
  const scaled = { A: -1, B: 0, C: -4, D: 0, E: 0, F: 4 }; // -(x^2 + 4y^2 - 4) = 0 => x^2/4 + y^2 = 1
  const e = conicToEllipse(scaled);
  assert.ok(e, 'expected a valid ellipse');
  assert.ok(e.rx >= e.ry);
  assert.ok(Math.abs(e.rx - 2) < EPS);
  assert.ok(Math.abs(e.ry - 1) < EPS);
});
