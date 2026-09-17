import test from 'node:test';
import assert from 'node:assert/strict';
import { EllipseFamily } from '../src/ellipse.js';
import { arcCandidates, chooseArc, arcPath, arcPathParameter } from '../src/svg.js';
import { ellipsePoint, ellipseParam, evalConic } from '../src/ellipse.js';

function pointsOnPath(d, count = 40) {
  // Sample the arc path by walking the M/a command analytically instead of a
  // browser DOM: parse the command and reuse ellipsePoint/ellipseParam. The
  // arc is relative (lowercase `a`), so its endpoint is an offset from the
  // absolute start point; add the start back to recover the absolute p1.
  const [, mx, my, , rx, ry, rot, largeArc, sweep, dx, dy] = d.match(
    /M ([\deE.+-]+) ([\deE.+-]+) (a) ([\deE.+-]+) ([\deE.+-]+) ([\deE.+-]+) (\d) (\d) ([\deE.+-]+) ([\deE.+-]+)/,
  );
  return {
    p0: { x: Number(mx), y: Number(my) },
    p1: { x: Number(mx) + Number(dx), y: Number(my) + Number(dy) },
    rx: Number(rx),
    ry: Number(ry),
    rot: Number(rot),
    largeArc: Number(largeArc),
    sweep: Number(sweep),
  };
}

function sideOfChord(p0, p1, p) {
  return (p1.x - p0.x) * (p.y - p0.y) - (p1.y - p0.y) * (p.x - p0.x);
}

/**
 * Reconstruct the ellipse center and swept-angle range from an SVG endpoint
 * arc (SVG 1.1 spec F.6.5), using *only* the numbers in the path string: the
 * two endpoints, the radii, the rotation, and the large-arc/sweep flags. The
 * center is derived from the endpoints and flags, not copied from the analytic
 * ellipse — so sampling this arc and checking the points against the analytic
 * conic is an independent cross-check that the exported path draws the exact
 * curve the solver computed (the visual "arc sits on the dashed ellipse" test,
 * made numerical). Returns null when the flags don't disambiguate a center.
 */
function svgArcCenter({ p0, p1, rx, ry, rot }, largeArc, sweep) {
  const phi = (rot * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2;
  const dy = (p0.y - p1.y) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  let rxA = Math.abs(rx);
  let ryA = Math.abs(ry);
  // Scale radii up if the endpoints are too far apart for them (should not be
  // needed here: if the endpoints really lie on this ellipse, lambda <= 1).
  const lambda = (x1p * x1p) / (rxA * rxA) + (y1p * y1p) / (ryA * ryA);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rxA *= s;
    ryA *= s;
  }
  const num = rxA * rxA * ryA * ryA - rxA * rxA * y1p * y1p - ryA * ryA * x1p * x1p;
  const den = rxA * rxA * y1p * y1p + ryA * ryA * x1p * x1p;
  const sign = largeArc !== sweep ? 1 : -1;
  const coef = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * (rxA * y1p)) / ryA;
  const cyp = (-coef * (ryA * x1p)) / rxA;
  const cx = cosP * cxp - sinP * cyp + (p0.x + p1.x) / 2;
  const cy = sinP * cxp + cosP * cyp + (p0.y + p1.y) / 2;

  const ang = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const ux = (x1p - cxp) / rxA;
  const uy = (y1p - cyp) / ryA;
  const vx = (-x1p - cxp) / rxA;
  const vy = (-y1p - cyp) / ryA;
  const theta1 = ang(1, 0, ux, uy);
  let dtheta = ang(ux, uy, vx, vy);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
  return { cx, cy, rxA, ryA, phi, theta1, dtheta, lambda };
}

/** Sample `n` points along the reconstructed SVG arc. */
function sampleSvgArc(arc, n = 32) {
  const { cx, cy, rxA, ryA, phi, theta1, dtheta } = arc;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = theta1 + (i / n) * dtheta;
    const ex = rxA * Math.cos(a);
    const ey = ryA * Math.sin(a);
    pts.push({ x: cx + cosP * ex - sinP * ey, y: cy + sinP * ex + cosP * ey });
  }
  return pts;
}

/** Approximate distance from a point to the conic, via value / |gradient|. */
function conicDistance(coeffs, p) {
  const { A, B, C, D, E } = coeffs;
  const value = evalConic(coeffs, p);
  const gx = 2 * A * p.x + B * p.y + D;
  const gy = B * p.x + 2 * C * p.y + E;
  return Math.abs(value) / Math.max(Math.hypot(gx, gy), 1e-12);
}

test('arc endpoints computed from the parsed path match the requested points', () => {
  const family = new EllipseFamily({ x: 10, y: 5 }, { deg: 40 }, { x: 90, y: 60 }, { deg: 170 });
  const s = family.roundest();
  const arc = chooseArc(s.ellipse, family.p0, family.p1, { yUp: false });
  const d = arcPath(s.ellipse, family.p0, family.p1, arc, { yUp: false });
  const parsed = pointsOnPath(d);
  assert.ok(Math.abs(parsed.p0.x - family.p0.x) < 1e-4 && Math.abs(parsed.p0.y - family.p0.y) < 1e-4);
  assert.ok(Math.abs(parsed.p1.x - family.p1.x) < 1e-4 && Math.abs(parsed.p1.y - family.p1.y) < 1e-4);
});

test('arcPathParameter agrees with the SVG a command and maps the flags to enums', () => {
  const family = new EllipseFamily({ x: 10, y: 5 }, { deg: 40 }, { x: 90, y: 60 }, { deg: 170 });
  const s = family.roundest();
  const arc = chooseArc(s.ellipse, family.p0, family.p1, { yUp: false });
  const param = arcPathParameter(s.ellipse, family.p0, family.p1, arc, { yUp: false });
  const parsed = pointsOnPath(arcPath(s.ellipse, family.p0, family.p1, arc, { yUp: false }));

  assert.equal(param.type, 'ARC');
  // rx/ry/rotation and the (dx, dy) offset must match the a command exactly.
  assert.ok(Math.abs(param.rx - parsed.rx) < 1e-6);
  assert.ok(Math.abs(param.ry - parsed.ry) < 1e-6);
  assert.ok(Math.abs(param.rotation - parsed.rot) < 1e-6);
  assert.ok(Math.abs(param.dx - (parsed.p1.x - parsed.p0.x)) < 1e-6);
  assert.ok(Math.abs(param.dy - (parsed.p1.y - parsed.p0.y)) < 1e-6);
  // Flags map to enums: sweep 1 -> CLOCKWISE, large-arc 1 -> LARGE.
  assert.equal(param.direction, arc.sweep === 1 ? 'CLOCKWISE' : 'COUNTER_CLOCKWISE');
  assert.equal(param.arc_size, arc.largeArc === 1 ? 'LARGE' : 'SMALL');
});

test('arcPathParameter flips direction under the y-up convention', () => {
  const family = new EllipseFamily({ x: 0, y: 0 }, { deg: 20 }, { x: 100, y: 10 }, { deg: 170 });
  const s = family.roundest();
  const down = chooseArc(s.ellipse, family.p0, family.p1, { yUp: false, preferLargeArc: true });
  const up = chooseArc(s.ellipse, family.p0, family.p1, { yUp: true, preferLargeArc: true });
  const paramDown = arcPathParameter(s.ellipse, family.p0, family.p1, down, { yUp: false });
  const paramUp = arcPathParameter(s.ellipse, family.p0, family.p1, up, { yUp: true });
  assert.notEqual(paramDown.direction, paramUp.direction);
  // The same geometric arc keeps its size (small/large) across the flip.
  assert.equal(paramDown.arc_size, paramUp.arc_size);
});

test('small-arc and large-arc candidates sample to opposite sides of the chord', () => {
  const family = new EllipseFamily({ x: 0, y: 0 }, { deg: 20 }, { x: 100, y: 10 }, { deg: 170 });
  const s = family.roundest();
  const { cw, ccw } = arcCandidates(s.ellipse, family.p0, family.p1, { yUp: false });
  const small = cw.largeArc ? ccw : cw;
  const large = cw.largeArc ? cw : ccw;
  assert.equal(small.largeArc, 0);
  assert.equal(large.largeArc, 1);

  const phi0 = ellipseParam(s.ellipse, family.p0);
  const midPhiSmall = phi0 + small.deltaPhi / 2;
  const midPhiLarge = phi0 + large.deltaPhi / 2;
  const midSmall = ellipsePoint(s.ellipse, midPhiSmall);
  const midLarge = ellipsePoint(s.ellipse, midPhiLarge);
  const sideSmall = sideOfChord(family.p0, family.p1, midSmall);
  const sideLarge = sideOfChord(family.p0, family.p1, midLarge);
  assert.ok(sideSmall * sideLarge < 0, 'small and large arc midpoints should be on opposite sides of the chord');
});

test('chooseArc honors a signed tangent at P0 over the large-arc preference', () => {
  const family = new EllipseFamily({ x: 0, y: 0 }, { deg: 20 }, { x: 100, y: 10 }, { deg: 170 });
  const s = family.roundest();
  const arcUp = chooseArc(s.ellipse, family.p0, family.p1, {
    tangentAtP0: { dir: { x: 1, y: 0.5 }, signed: true },
  });
  const arcDown = chooseArc(s.ellipse, family.p0, family.p1, {
    tangentAtP0: { dir: { x: -1, y: -0.5 }, signed: true },
  });
  // Opposite signed directions at the same point must select opposite sweeps.
  assert.notEqual(arcUp.sweep, arcDown.sweep);
});

test('yUp flips the reported sweep relative to the y-down (SVG) convention', () => {
  const family = new EllipseFamily({ x: 0, y: 0 }, { deg: 20 }, { x: 100, y: 10 }, { deg: 170 });
  const s = family.roundest();
  const preferLarge = true;
  const down = chooseArc(s.ellipse, family.p0, family.p1, { yUp: false, preferLargeArc: preferLarge });
  const up = chooseArc(s.ellipse, family.p0, family.p1, { yUp: true, preferLargeArc: preferLarge });
  // Flipping the vertical axis reverses the sense of travel for the same
  // geometric arc, so the sweep flag should flip too.
  assert.notEqual(down.sweep, up.sweep);
});

test('exported arc lies on the analytic ellipse for every solver mode', () => {
  // The core self-check: the SVG arc drawn from the exported path and
  // the analytic ellipse the solver computed must be the same curve. Here we
  // reconstruct the arc's ellipse purely from the path string and verify every
  // sampled point satisfies the analytic conic, across each fifth-constraint
  // mode and both arc directions.
  const families = [
    new EllipseFamily({ x: 10, y: 5 }, { deg: 40 }, { x: 90, y: 60 }, { deg: 170 }),
    new EllipseFamily({ x: -30, y: 20 }, { deg: -10 }, { x: 140, y: -25 }, { deg: 120 }),
    new EllipseFamily({ x: 0, y: 0 }, { deg: 20 }, { x: 100, y: 10 }, { deg: 170 }),
  ];

  for (const family of families) {
    const modes = [
      ['roundest', () => [family.roundest()]],
      ['rotation', () => [family.withRotation(25)]],
      ['ratio', () => family.withAspectRatio(1.6)],
      ['rx', () => family.withRadius('rx', 90)],
      ['ry', () => family.withRadius('ry', 35)],
      ['apex', () => [family.atApex(0.3)]],
      ['through', () => [family.throughPoint({ x: 55, y: 55 })]],
    ];

    for (const [name, solve] of modes) {
      const solutions = solve().filter((s) => s && s.ellipse);
      for (const s of solutions) {
        for (const preferLargeArc of [false, true]) {
          const arc = chooseArc(s.ellipse, family.p0, family.p1, { yUp: false, preferLargeArc });
          const d = arcPath(s.ellipse, family.p0, family.p1, arc, { yUp: false });
          const parsed = pointsOnPath(d);
          const rebuilt = svgArcCenter(parsed, parsed.largeArc, parsed.sweep);

          // Endpoints on this ellipse => no radii correction was necessary.
          assert.ok(
            rebuilt.lambda <= 1 + 1e-6,
            `${name}: endpoints fit the exported radii (lambda=${rebuilt.lambda})`,
          );
          // The independently reconstructed center matches the analytic one.
          const scale = Math.max(s.ellipse.rx, 1);
          assert.ok(
            Math.hypot(rebuilt.cx - s.ellipse.cx, rebuilt.cy - s.ellipse.cy) / scale < 1e-6,
            `${name}: reconstructed arc center matches the ellipse center`,
          );
          // Every sampled point on the exported arc lies on the analytic conic.
          for (const p of sampleSvgArc(rebuilt)) {
            assert.ok(
              conicDistance(s.ellipse.coeffs, p) / scale < 1e-6,
              `${name}: sampled arc point lies on the analytic ellipse`,
            );
          }
        }
      }
    }
  }
});
