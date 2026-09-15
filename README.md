# Ellipse from two tangents

Given two points and the tangent slope of the curve at each one, this computes
an ellipse through both points with those exact tangents — and reports the
numbers you actually need to draw it: **rx, ry, and rotation angle**. It also
exports the connecting arc as an SVG `<path>` with a relative `a` command.

A zero-dependency project: pure JavaScript (Node's built-in test runner, a
~20-line static file server, no bundler, no npm installs).

```
ellipse-tool/
  src/ellipse.js   pure math: the conic family, solvers, ellipse geometry
  src/svg.js       SVG arc-flag computation and path/markup builders
  ui.js            browser UI logic (imports src/ellipse.js and src/svg.js)
  index.html       the UI's page shell
  serve.js         static file server (needed because browsers block ES
                    module imports from file://)
  test/            node:test suites for both modules
```

## Why there's more than one answer

Two points plus two tangent directions is **4 constraints**. A general
ellipse has **5 degrees of freedom** (center x, center y, rx, ry, rotation).
So there's a whole one-parameter *family* of ellipses satisfying the input,
not a single answer — the tool needs a fifth constraint to pick one.

The family has a clean closed form. Write each tangent line as a linear form
`L(x, y) = 0`, and the chord through the two points as `M(x, y) = 0`. Then
every conic tangent to `L0` at P0 and to `L1` at P1 is

```
Q_t(x, y) = L0(x, y) * L1(x, y) + t * M(x, y)^2
```

for some real number `t`. Sweeping `t` sweeps through every conic satisfying
the four constraints — ellipses for some range of `t`, then a parabola at one
value, then hyperbolas beyond it. `src/ellipse.js`'s `EllipseFamily` class
represents exactly this pencil and offers several ways to pick a member:

| Mode | What it does |
|---|---|
| `roundest` (default) | the member with the smallest axis ratio `rx/ry` |
| `apex` | direct position (0–1) along the family; 0.5 is the parabola boundary |
| `rotation` | the member whose axes sit at a given angle |
| `ratio` | the member(s) with a given `rx/ry` ratio |
| `rx` / `ry` | the member(s) with a given semi-major/semi-minor radius |
| `through` | the unique member passing through a third point |

Not every angle/ratio/radius is achievable for a given pair of points and
tangents — the family might only produce hyperbolas at that particular value.
When that happens, the tool says so rather than guessing.

## Coordinate and angle conventions

- Points are `{x, y}`. Tangents accept a bare slope number (`dy/dx`,
  direction-agnostic), `{deg}` or `{rad}` (signed, measured from +x toward
  +y), or `{dx, dy}` (signed).
- `rx` is always the **semi-major** radius; `ry` is always the semi-minor
  radius. `theta`/`thetaDeg` is the angle from +x to the major axis.
- SVG's arc flags are y-down by convention. This tool's math and UI defaults
  assume the input points are already in that frame (matching an SVG canvas or
  normal screen coordinates). Check "Y-axis points up" (UI) if your own points
  use the opposite, mathematical (y-up) convention — this flips the reported
  rotation, the center's y-coordinate, and the sweep flag in the exported
  numbers so they render correctly wherever you paste them.

## Browser UI

```
node serve.js            # http://localhost:8765 (set PORT to use another)
```

Drag the two points and their tangent handles directly on the canvas; pick a
fifth-constraint mode in the sidebar. The dashed curve is the full analytic
ellipse and the solid arc is the same shape built independently through the
SVG path math — if they don't coincide exactly, something's wrong. The
sidebar's export boxes give the arc two ways: as an ARC path parameter object
(JSON matching Benchling's antibody format visualization
`_ARC_PATH_PARAMETER_SCHEMA`, with `rx`/`ry`, the `(dx, dy)` offset,
`rotation`, `direction`, and `arc_size`) and as the raw relative SVG path. The
current configuration is saved in the URL hash, so a specific setup can be
bookmarked or shared as a link. It is also stored in the browser's
localStorage, so reopening the page later restores your last setup even
without the hash; a hash in the URL always takes precedence over the stored
copy, and "Reset to defaults" clears back to the starting configuration.

All reported and exported numbers are full-precision: they are emitted as
their shortest round-trippable form rather than rounded to a fixed number of
decimals, so copying a radius, rotation, or path loses none of the digits the
solve produced (and typed inputs are never re-truncated to fewer decimals).
Note that the `roundest` and `rx`/`ry` modes rely on a numerical search, so
their trailing digits past ~8 significant figures are optimizer noise rather
than exact; the direct modes (`rotation`, `ratio`, `through`, `apex`) are
exact to full double precision.

## Tests

```
node --test        # or: npm test
```

Covers the conic math (round-tripping a known ellipse through two sampled
points and a third, each solver mode, degenerate/parabola/hyperbola
classification, parallel tangents) and the SVG export (arc endpoints,
small-vs-large-arc sidedness, signed-tangent arc selection, the y-up flip).
