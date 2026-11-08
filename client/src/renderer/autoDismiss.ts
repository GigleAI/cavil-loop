// GitHub#256: a fully successful notice puts itself away after a while. The count starts when the
// notice is on screen and pauses while the pointer is on it, the keyboard focus is inside it, or
// the window is in the background / hidden; once none of that holds any more it starts again from
// zero (someone who just came back to read it is not cut short).
//
// Whether a notice may go at all is decided elsewhere (shared/ops.ts for operation notices, the
// note's kind for result bars); this only counts.

import { useEffect, useRef, useState, useSyncExternalStore, type FocusEvent } from 'react';

/**
 * Whether the app window is in the foreground and visible — one store for the whole window, so a
 * notice that mounts while the window is already in the background starts paused like the ones
 * already shown (PR #259 review round 1: each notice used to start out believing it had focus).
 * It starts from the window's real state (`document.hasFocus()`, `document.hidden`) and follows
 * the blur / focus / visibilitychange events from then on.
 */
const windowState = (() => {
  let focused = typeof document === 'undefined' ? true : document.hasFocus();
  let hidden = typeof document === 'undefined' ? false : document.hidden;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((f) => f());
  if (typeof window !== 'undefined') {
    window.addEventListener('blur', () => ((focused = false), emit()));
    window.addEventListener('focus', () => ((focused = true), emit()));
    document.addEventListener('visibilitychange', () => ((hidden = document.hidden), emit()));
  }
  return {
    subscribe(f: () => void) {
      listeners.add(f);
      return () => void listeners.delete(f);
    },
    active: () => focused && !hidden,
  };
})();

function useWindowActive(): boolean {
  return useSyncExternalStore(windowState.subscribe, windowState.active);
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
