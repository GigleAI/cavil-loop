// GitHub#256: a fully successful notice puts itself away after a while. The count starts when the
// notice is on screen and pauses while the pointer is on it, the keyboard focus is inside it, or
// the window is in the background / hidden; once none of that holds any more it starts again from
// zero (someone who just came back to read it is not cut short).
//
// Whether a notice may go at all is decided elsewhere (shared/ops.ts for operation notices, the
// note's kind for result bars); this only counts.

import { useEffect, useRef, useState, type FocusEvent } from 'react';

/** whether the app window is in the foreground and visible; starts as "yes" (a blur / hide event says otherwise) */
function useWindowActive(): boolean {
  const [active, setActive] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    let focused = true;
    const update = () => setActive(focused && !document.hidden);
    const onBlur = () => ((focused = false), update());
    const onFocus = () => ((focused = true), update());
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return active;
}

/**
 * Counts `ms` while `enabled`, then calls `onExpire` once. `resetKey` restarts the count when it
 * changes (a new note in the same bar). Spread the returned handlers on the notice's root element.
 */
export function useAutoDismiss(enabled: boolean, ms: number, onExpire: () => void, resetKey?: unknown) {
  const [hover, setHover] = useState(false);
  const [focusIn, setFocusIn] = useState(false);
  const active = useWindowActive();
  const expire = useRef(onExpire);
  expire.current = onExpire;
  const counting = enabled && !hover && !focusIn && active;
  useEffect(() => {
    if (!counting) return;
    const t = setTimeout(() => expire.current(), ms);
    return () => clearTimeout(t);
  }, [counting, ms, resetKey]);
  return {
    'data-auto-dismiss': enabled ? (counting ? 'counting' : 'paused') : undefined,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onFocus: () => setFocusIn(true),
    onBlur: (e: FocusEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusIn(false);
    },
  };
}
