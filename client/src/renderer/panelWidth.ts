// The floating detail panel's width (GitHub#155): dragged by its left edge,
// saved with the view settings, and never wider than the window leaves room
// for (a strip of the board stays visible to click another card).

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { DETAIL_MAX_WIDTH, DETAIL_MIN_WIDTH } from '../shared/viewSettings';
import { api } from './api';

/** Board strip the panel always leaves uncovered on the left. */
export const BOARD_STRIP = 120;

/** The width actually used for `wanted` in a window `windowWidth` wide. */
export function clampWidth(wanted: number, windowWidth: number): number {
  const max = Math.max(DETAIL_MIN_WIDTH, Math.min(DETAIL_MAX_WIDTH, windowWidth - BOARD_STRIP));
  return Math.round(Math.min(max, Math.max(DETAIL_MIN_WIDTH, wanted)));
}

export function usePanelWidth(saved: number) {
  const [winW, setWinW] = useState(() => window.innerWidth);
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
    const on = () => setWinW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const width = clampWidth(dragW ?? saved, winW);

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
        if (last === clampWidth(savedRef.current, window.innerWidth)) {
          setDragW(null);
          return;
        }
        released.current = last;
        // the drawn width stays until the saved one comes back (no flash of the old width)
        void Promise.resolve(api().setView({ detailWidth: last })).catch(() => {
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
  return { width, dragging: held, startDrag };
}
