/**
 * Sidebar rendering for the browser UI: the results readout, the SVG export
 * boxes, and syncing the input controls to the current state.
 *
 * These write into the fixed sidebar DOM (looked up by id) from the state and
 * solutions passed in. Anything that mutates state or re-solves is handed back
 * to `ui.js` through callbacks rather than reached for directly.
 */

import { formatDisplay } from '../format.js';
import { resultRows } from '../state.js';
import { arcPath, arcPathParameter } from '../svg.js';
import { autoSizeTextarea } from './dom.js';

// Per-mode control metadata: the field label, which input kind to show, and
// (for sliders) the range bounds and end labels. `label: null` hides the field
// entirely (the "roundest" mode has no parameter).
export const MODE_META = {
  roundest: { label: null },
  apex: { label: 'Apex position (parabola at 0.5)', kind: 'range', min: 0.001, max: 0.499, step: 0.001, ends: ['0', '0.5'] },
  rotation: { label: 'Axis angle (deg)', kind: 'range', min: 0, max: 90, step: 1, ends: ['0', '90'] },
  ratio: { label: 'Major / minor ratio (≥ 1)', kind: 'text' },
  rx: { label: 'rx (semi-major)', kind: 'text' },
  ry: { label: 'ry (semi-minor)', kind: 'text' },
  through: { label: 'Drag the yellow point on the canvas', kind: 'none' },
};

/** Fill the results panel with the solved ellipse's parameters. */
export function renderResults(state, solutions, index) {
  const box = document.getElementById('results');
  if (solutions.length === 0) {
    box.innerHTML = '<div class="result-row"><span class="label">No solution</span></div>';
    return;
  }
  const rows = resultRows(solutions[index].ellipse, state.yUp);
  box.innerHTML = rows
    .map(
      ([label, value], i) =>
        `<div class="result-row${i < 3 ? ' big' : ''}"><span class="label">${label}</span><span class="value">${value}</span></div>`,
    )
    .join('');
}

/**
 * Show or hide the solution cycler sitting beside the parameter control. The
 * value modes (aspect ratio, rx, ry) can yield two ellipses for one value, so
 * this surfaces "Solution i of n" and a Next button right where the value was
 * entered — far more discoverable than tucked in the results card. Hidden
 * entirely for single-solution results; `onCycle(nextIndex)` re-solves.
 */
export function renderSolutionCycler(solutions, index, onCycle) {
  const box = document.getElementById('solution-cycler');
  if (!box) return;
  if (!solutions || solutions.length <= 1) {
    box.style.display = 'none';
    return;
  }
  box.style.display = 'flex';
  document.getElementById('solution-status').textContent =
    `Solution ${index + 1} of ${solutions.length}`;
  // Reassign rather than addEventListener so repeated renders don't stack handlers.
  document.getElementById('solution-next').onclick = () =>
    onCycle((index + 1) % solutions.length);
}

/**
 * Fill the SVG export boxes and highlight the active small/large arc button.
 * `exportArc` is the arc in the user's chosen export convention (its sweep flag
 * differs from the canvas under y-up); `canvasArc` is the y-down arc actually
 * drawn, whose large/small classification drives the toggle highlight.
 */
export function renderExports(state, family, ellipse, exportArc, canvasArc) {
  const pathBox = document.getElementById('export-path');
  const arcParamBox = document.getElementById('export-arc-param');
  if (!family || !ellipse) {
    pathBox.value = '';
    arcParamBox.value = '';
    autoSizeTextarea(pathBox);
    autoSizeTextarea(arcParamBox);
    return;
  }
  pathBox.value = arcPath(ellipse, family.p0, family.p1, exportArc, { yUp: state.yUp });
  arcParamBox.value = JSON.stringify(
    arcPathParameter(ellipse, family.p0, family.p1, exportArc, { yUp: state.yUp }),
    null,
    2,
  );
  autoSizeTextarea(pathBox);
  autoSizeTextarea(arcParamBox);
  const small = canvasArc.largeArc ? 'large' : 'small';
  document.querySelectorAll('#arc-toggle button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.arc === small);
  });
}

/** Mirror the current state into the input controls (points, tangents, mode). */
export function syncControlsFromState(state) {
  // Write the full-precision value, but never clobber a field mid-edit, so a
  // typed value with many decimals survives intact instead of being repainted
  // to a rounded form the next time we render.
  const setField = (id, value) => {
    const field = document.getElementById(id);
    if (document.activeElement !== field) field.value = value;
  };
  setField('p0-xy', `${state.p0.x}, ${state.p0.y}`);
  setField('p1-xy', `${state.p1.x}, ${state.p1.y}`);
  setField('through-xy', `${state.paramPoint.x}, ${state.paramPoint.y}`);
  setField('t0-deg', state.t0Deg);
  setField('t1-deg', state.t1Deg);
  document.getElementById('yup-toggle').checked = state.yUp;

  document.querySelectorAll('#mode-buttons button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === state.mode);
  });

  const meta = MODE_META[state.mode];
  document.getElementById('through-field').style.display =
    state.mode === 'through' ? 'block' : 'none';
  const field = document.getElementById('param-field');
  const rangeInput = document.getElementById('param-range');
  const textInput = document.getElementById('param-text');
  const label = document.getElementById('param-label');
  if (!meta.label) {
    field.style.display = 'none';
  } else {
    field.style.display = 'block';
    label.textContent = meta.label;
    rangeInput.style.display = meta.kind === 'range' ? 'block' : 'none';
    document.getElementById('range-ends').style.display = meta.kind === 'range' ? 'flex' : 'none';
    textInput.style.display = meta.kind === 'text' ? 'block' : 'none';
    if (meta.kind === 'range') {
      rangeInput.min = meta.min;
      rangeInput.max = meta.max;
      rangeInput.step = meta.step;
      rangeInput.value = state.param;
      const spans = document.querySelectorAll('#range-ends span');
      spans[0].textContent = meta.ends[0];
      spans[1].textContent = meta.ends[1];
      // Live readout of the slider's current value next to the label.
      document.getElementById('param-value').textContent =
        typeof state.param === 'number' ? formatDisplay(state.param) : '';
    } else if (meta.kind === 'text') {
      document.getElementById('param-value').textContent = '';
      if (document.activeElement !== textInput) textInput.value = state.param;
    } else {
      field.style.display = 'none';
    }
  }
}
