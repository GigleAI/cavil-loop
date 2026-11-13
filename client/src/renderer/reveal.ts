// GitHub#522: bring the item the floating detail opened into view on the board / in the table — once per
// opening, never again on a later render (a sync round must not pull back a board the user scrolled).
// The panel covers the right of the board: "in view" means left of the panel, not merely on screen.

/** room kept between the item and the panel's edge */
export const PANEL_GAP = 16;

/** Drawn at all: not in a folded lane / group, not hidden by `display: none` somewhere above. */
export function isShown(el: Element): boolean {
  return el.getClientRects().length > 0;
}

/** The nearest box above `el` that scrolls sideways (null = none does). */
function sidewaysScroller(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const x = getComputedStyle(p).overflowX;
    if ((x === 'auto' || x === 'scroll') && p.scrollWidth > p.clientWidth) return p;
  }
  return null;
}

/**
 * How far to scroll sideways so that a box spanning `left`…`right` ends `PANEL_GAP` left of the panel's
 * edge `cover` — never so far that its own left edge comes closer than `PANEL_GAP` to `boxLeft` (the
 * scrolling box's left edge). 0 = already clear of the panel. All in the same (viewport) coordinates.
 */
export function sidewaysShift(left: number, right: number, cover: number, boxLeft: number): number {
  const over = right - (cover - PANEL_GAP);
  if (over <= 0) return 0;
  return Math.max(0, Math.min(over, left - boxLeft - PANEL_GAP));
}

/**
 * Scroll `el` into view in the boxes that hold it (nothing moves when it is in view already), then
 * sideways out from under a panel whose left edge is at `cover` (viewport x; null = nothing covers).
 */
export function revealBeside(el: HTMLElement, cover: number | null): void {
  // the item's own `scroll-margin` (styles.css) keeps a little room around it
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (cover === null) return;
  const box = sidewaysScroller(el);
  if (!box) return;
  const r = el.getBoundingClientRect();
  const shift = sidewaysShift(r.left, r.right, cover, box.getBoundingClientRect().left);
  if (shift > 0) box.scrollLeft += shift;
}
