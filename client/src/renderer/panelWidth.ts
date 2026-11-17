// The floating detail panel's width (GitHub#155): dragged by its left edge,
// saved with the view settings, and never wider than the window leaves room
// for (a strip of the board stays visible to click another card).
//
// GitHub#582: until it is dragged the panel follows the window, leaving the list behind it about 15 characters of title:
// measured from where the titles start (the board's first column, the table's title column — never a fixed number of
// pixels, the table has the repository list and other columns on its left). Double-clicking the edge goes back to that.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { DETAIL_MAX_WIDTH, DETAIL_MIN_WIDTH } from '../shared/viewSettings';
import { api } from './api';

/** Board strip the panel always leaves uncovered on the left. */
export const BOARD_STRIP = 120;

/** How many characters of a title the list behind the panel keeps in view. */
export const TITLE_CHARS = 15;
/** a little room after those characters (the end of the 15th character, a card's padding) */
export const STRIP_SLACK = 16;
/** what the list keeps when no title can be measured (dependency graph, an empty list): about the board's first column */
export const FALLBACK_STRIP = 240;

/**
 * The width actually used for `wanted` in a window `windowWidth` wide. In this order: never narrower than DETAIL_MIN_WIDTH
 * (it wins below 480 px, the strip on the left is then less than BOARD_STRIP), never wider than the window minus
 * BOARD_STRIP, never wider than DETAIL_MAX_WIDTH.
 */
export function clampWidth(wanted: number, windowWidth: number): number {
  const max = Math.max(DETAIL_MIN_WIDTH, Math.min(DETAIL_MAX_WIDTH, windowWidth - BOARD_STRIP));
  return Math.round(Math.min(max, Math.max(DETAIL_MIN_WIDTH, wanted)));
}

/** The strip the list keeps: from where the titles start, 15 characters of the title's font, a little slack. */
export function stripFor(titleLeft: number | null, fontSize: number | null): number {
  if (titleLeft === null || fontSize === null || !Number.isFinite(titleLeft) || !Number.isFinite(fontSize) || fontSize <= 0) return FALLBACK_STRIP;
  return Math.round(Math.max(0, titleLeft) + TITLE_CHARS * fontSize + STRIP_SLACK);
}

/** The panel's width: the dragged one, or (null) the window minus the strip; both kept within clampWidth's limits. */
export function panelWidthFor(saved: number | null, windowWidth: number, strip: number): number {
  return clampWidth(saved ?? windowWidth - strip, windowWidth);
}

/** the list on the home tab: its board columns, card titles and table row titles */
const FRONT = '.tab-page[data-front="yes"]';

/** left edge as if nothing were scrolled sideways (a board scrolled to its third column still measures from its first) */
function unscrolledLeft(el: Element): number {
  let left = el.getBoundingClientRect().left;
  for (let p = el.parentElement; p; p = p.parentElement) left += p.scrollLeft;
  return left;
}

/**
 * Where the titles of the list start and their font size; null when no title is laid out. On the board: the leftmost
 * column's left edge plus how far into its column a card's title starts — so a first column with no cards in it does not
 * move the measure to the second. In the table: the leftmost row title.
 */
export function measureTitles(root: ParentNode = document): { left: number; fontSize: number } | null {
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };
  const font = (el: Element) => parseFloat(getComputedStyle(el).fontSize);
  const cards = Array.from(root.querySelectorAll(`${FRONT} [data-testid="card-title"]`)).filter(shown);
  if (cards.length) {
    const columns = Array.from(root.querySelectorAll(`${FRONT} [data-testid="column"]`)).filter(shown);
    if (columns.length) {
      const first = Math.min(...columns.map(unscrolledLeft));
      let offset = Infinity;
      let size = NaN;
      for (const el of cards) {
        const col = el.closest('[data-testid="column"]');
        if (!col) continue;
        const o = el.getBoundingClientRect().left - col.getBoundingClientRect().left;
        if (o < offset) [offset, size] = [o, font(el)];
      }
      if (Number.isFinite(first) && Number.isFinite(offset) && Number.isFinite(size)) return { left: first + offset, fontSize: size };
    }
  }
  let best: { left: number; fontSize: number } | null = null;
  for (const el of Array.from(root.querySelectorAll(`${FRONT} [data-testid="row-title"]`)).filter(shown)) {
    const left = unscrolledLeft(el);
    const fontSize = font(el);
    if (!Number.isFinite(left) || !Number.isFinite(fontSize)) continue;
    if (!best || left < best.left) best = { left, fontSize };
  }
  return best;
}

function currentStrip(): number {
  const m = measureTitles();
  return stripFor(m?.left ?? null, m?.fontSize ?? null);
}

/**
 * `saved` is the view's `panelWidth` (null = follow the window); `layoutKey` changes whenever the list behind the panel may
 * lay its titles out somewhere else (board / table / graph, columns, their widths), so the strip is measured again.
 */
export function usePanelWidth(saved: number | null, layoutKey = '') {
  const [winW, setWinW] = useState(() => window.innerWidth);
  const [strip, setStrip] = useState(FALLBACK_STRIP);
  const [dragW, setDragW] = useState<number | null>(null);
  const right = useRef(0);
  /** released at this width, waiting for the saved setting to come back with it */
  const released = useRef<number | null>(null);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  /** the pointer is down on the edge (the timeline frame must not swallow its moves meanwhile) */
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (released.current !== null && saved === released.current) {
      released.current = null;
      setDragW(null);
    }
  }, [saved]);
  useEffect(() => {
    const on = () => {
      setWinW(window.innerWidth);
      setStrip(currentStrip());
    };
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  // measured before paint, and once more on the next frame (a list that lays out after the panel opened)
  useLayoutEffect(() => {
    if (saved !== null) return;
    setStrip(currentStrip());
    const id = requestAnimationFrame(() => setStrip(currentStrip()));
    return () => cancelAnimationFrame(id);
  }, [saved, layoutKey]);
  const width = dragW ?? panelWidthFor(saved, winW, strip);

  /** pointer down on the left edge: follow the pointer until it is released, then save */
  const startDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      e.preventDefault();
      const panel = (e.currentTarget as HTMLElement).parentElement;
      right.current = panel ? panel.getBoundingClientRect().right : window.innerWidth;
      let last = width;
      setDragW(width);
      setHeld(true);
      const move = (ev: PointerEvent) => {
        last = clampWidth(right.current - ev.clientX, window.innerWidth);
        setDragW(last);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        setHeld(false);
        if (last === width) {
          setDragW(null);
          return;
        }
        released.current = last;
        // the drawn width stays until the saved one comes back (no flash of the old width)
        void Promise.resolve(api().setView({ panelWidth: last })).catch(() => {
          released.current = null;
          setDragW(null);
        });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [width],
  );
  /** double click on the edge: back to following the window */
  const resetWidth = useCallback(() => {
    released.current = null;
    setDragW(null);
    if (savedRef.current !== null) void Promise.resolve(api().setView({ panelWidth: null })).catch(() => {});
  }, []);
  return { width, dragging: held, startDrag, resetWidth };
}
