/**
 * Display formatting shared by the UI and the solver's user-facing messages.
 *
 * Kept dependency-free and separate from both the math core and the browser
 * wiring so either can round a number for display the same way without a
 * circular import.
 */

/**
 * Round `n` to at most 3 decimals for display, dropping trailing zeros
 * (1.5, not 1.500) and normalizing -0 to 0. This is display-only: the URL
 * hash, text inputs, and export boxes stay full-precision.
 */
export function formatDisplay(n) {
  return String(Number(n.toFixed(3)) + 0);
}
