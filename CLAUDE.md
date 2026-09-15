# Ellipse-from-two-tangents — working notes

A standalone, **zero-dependency** local tool: given two points and the tangent
slope at each, it computes an ellipse through both points with those tangents
and reports the drawing parameters (rx, ry, rotation, center, eccentricity),
plus an SVG arc export. It has a browser UI and a Node test suite.

## Hard constraints (do not violate)

- **Zero dependencies.** No npm installs, no bundler, no framework. Pure ES
  modules run directly by Node and the browser. `package.json` has no
  `dependencies`/`devDependencies` and must stay that way.
- **Fully self-contained.** This project stands alone: it must not import from
  or reference any other codebase. The ARC path parameter export uses a plain,
  self-defined shape (`type`, `rx`, `ry`, `dx`, `dy`, `rotation`, `direction`,
  `arc_size`).
- **Node 22+** (the smoke test uses the global `fetch` and `WebSocket`).

## Layout

```
src/ellipse.js   pure math: the conic pencil, solvers, ellipse geometry
src/svg.js       SVG arc-flag computation and path/markup builders
src/state.js     pure UI logic: state (de)serialization, input parsing, view math
ui.js            browser wiring (DOM + events); pure logic lives in src/state.js
index.html       the UI's page shell
serve.js         ~20-line static file server (browsers block ES imports over file://)
scripts/smoke.mjs  headless-browser smoke test (opt-in; not run by `node --test`)
test/            node:test suites (everything here IS auto-run by `node --test`)
```

Keep `ui.js` thin: DOM reads/writes and event listeners only. Any logic that
can be expressed as a pure function (parsing, serialization, geometry, framing)
belongs in `src/state.js` (or the math modules) where it can be unit-tested
without a browser. Do not put files that aren't node:test suites under `test/`
— Node's runner auto-executes everything in a `test/` directory.

## Key invariants

- **The exported arc must lie exactly on the analytic ellipse.** The dashed
  full ellipse and the solid arc in the UI are drawn from independent math and
  must coincide; the numerical version of this check is the "exported arc lies
  on the analytic ellipse for every solver mode" test in `test/svg.test.js`.
  If you touch the solvers or `svg.js`, that test is the safety net.
- **rx is always the semi-major radius, ry the semi-minor; `theta`/`thetaDeg`
  is the major-axis angle.**
- **Coordinate convention is y-down (SVG) by default.** The `yUp` option (UI
  checkbox / `yUp: true`) flips the rotation sign, the center's y, and the
  sweep flag for pasting into a y-up renderer; it does not change what the
  canvas draws.
- **All reported/exported numbers are full precision** (shortest
  round-trippable form, no `toFixed`). Inputs parse losslessly and are never
  re-truncated on display.

## Solver precision (be honest about this)

- Direct modes — `rotation`, `ratio`, `through`, `apex` — are exact to full
  double precision (~12+ significant figures).
- Search modes — `roundest`, `rx`, `ry` — use a numerical search, so digits
  past ~8 significant figures are optimizer noise, not exact.
- `withRadius` (rx/ry) validates each bracketed root against the requested
  value before accepting it, because near the parabola boundary and the
  chord-collapse (ry→0) end the radius is ill-conditioned and sign-change
  brackets can otherwise converge to poles/noise and hand back degenerate
  slivers. Preserve that guard.

## Verifying a change

1. `node --test` — the unit suites (fast, no browser). Must stay green.
2. `npm run test:e2e` — the headless smoke test: boots the page in Chromium via
   the DevTools Protocol and asserts it solves and exports without a page
   error. Self-skips (exit 0) if no Chromium binary is found; set
   `CHROMIUM_PATH` to point at one.
3. `node serve.js` then open the URL and confirm the solid arc sits exactly on
   the dashed ellipse in every mode — the built-in visual self-check.

## Git / workflow

Branch names are prefixed `jackhaviland-`. The human handles all pushing — do
not take remote write actions; just say when something is ready to push.
