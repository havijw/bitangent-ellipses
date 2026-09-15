/**
 * Generic SVG/DOM builders for the browser UI.
 *
 * These are the lowest layer of the view: they take everything they need as
 * arguments (no module-level app state), so they can be reasoned about and
 * reused without knowing anything about the current ellipse, view, or state.
 */

export const NS = 'http://www.w3.org/2000/svg';

/** Create an SVG element of `tag` with the given attributes. */
export function el(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** Current value of a CSS custom property on :root (drives themed canvas colors). */
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Grow a readonly export textarea to fit its content so nothing is clipped
 * behind an inner scrollbar. Resetting to 'auto' first lets it shrink back
 * when the content gets shorter; the +2 covers the 1px top/bottom border
 * under box-sizing: border-box. The CSS min-height keeps an empty box sane.
 */
export function autoSizeTextarea(node) {
  node.style.height = 'auto';
  node.style.height = `${node.scrollHeight + 2}px`;
}

/** A draggable circle handle at `pos`, carrying `data-handle=id` for hit-testing. */
export function makeDraggable(id, pos, r, color, sizeScale) {
  const c = el('circle', { cx: pos.x, cy: pos.y, r: r * sizeScale, fill: color, stroke: '#0b1220', 'stroke-width': 2 });
  c.dataset.handle = id;
  return c;
}

/**
 * A draggable arrowhead marker centered at `pos`, pointing along `deg` (the
 * tangent direction). Behaves exactly like `makeDraggable` for hit-testing —
 * it carries `data-handle` so the same pointer logic drives it — it just draws
 * a triangle instead of a circle. `size` is the tip length in screen units.
 */
export function makeArrowHandle(id, pos, deg, size, color, sizeScale) {
  const s = size * sizeScale;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // Triangle in local space pointing along +x, then rotated to `deg`.
  const local = [
    [s, 0],
    [-s * 0.7, s * 0.85],
    [-s * 0.7, -s * 0.85],
  ];
  const points = local
    .map(([lx, ly]) => `${pos.x + lx * cos - ly * sin},${pos.y + lx * sin + ly * cos}`)
    .join(' ');
  const tri = el('polygon', {
    points,
    fill: color,
    stroke: '#0b1220',
    'stroke-width': 2,
    'stroke-linejoin': 'round',
    'vector-effect': 'non-scaling-stroke',
  });
  tri.dataset.handle = id;
  return tri;
}
