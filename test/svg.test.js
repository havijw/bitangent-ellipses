import test from 'node:test';
import assert from 'node:assert/strict';
import { EllipseFamily } from '../src/ellipse.js';
import { arcCandidates, chooseArc, arcPath, arcPathParameter } from '../src/svg.js';
import { ellipsePoint, ellipseParam } from '../src/ellipse.js';

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
