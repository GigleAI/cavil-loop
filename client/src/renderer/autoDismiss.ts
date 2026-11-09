// GitHub#256: a fully successful notice puts itself away after a while. The count starts when the
// notice is on screen and pauses while the pointer is on it, the keyboard focus is inside it, or
// the window is in the background / hidden; once none of that holds any more it starts again from
// zero (someone who just came back to read it is not cut short).
//
// GitHub#296: the three pauses are first followed by their events (an instant answer), but an
// event can be missed — the pointer leaves while the window is in the background, the focused
// button goes away, the webview never says it got the focus back — and a missed "leave" used to
// keep a notice paused for hours. So while a notice is paused it looks at the real state once a
// second (the pointer really on it, the focus really in it, the window really in front and
// visible) and resumes from that; losing the window also forgets "the pointer is on it".
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
    /** GitHub#296: the window's real state now, in case a blur / focus / visibilitychange was missed */
    recheck() {
      if (typeof document === 'undefined') return;
      const f = document.hasFocus();
      const h = document.hidden;
      if (f === focused && h === hidden) return;
      focused = f;
      hidden = h;
      emit();
    },
  };
})();

/** how often a paused notice looks at the real state (GitHub#296) */
export const PAUSE_RECHECK_MS = 1_000;

/** the pointer really is on `el` now (the browser's own hover state) */
function pointerOn(el: HTMLElement | null): boolean {
  try {
    return !!el && el.matches(':hover');
  } catch {
    return false;
  }
}

/** the keyboard focus really is inside `el` now */
function focusInside(el: HTMLElement | null): boolean {
  const a = typeof document === 'undefined' ? null : document.activeElement;
  return !!el && !!a && a !== document.body && el.contains(a);
}

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
  const el = useRef<HTMLElement | null>(null);
  const expire = useRef(onExpire);
  expire.current = onExpire;
  const counting = enabled && !hover && !focusIn && active;
  useEffect(() => {
    if (!counting) return;
    const t = setTimeout(() => expire.current(), ms);
    return () => clearTimeout(t);
  }, [counting, ms, resetKey]);
  // GitHub#296: the window gone to the background forgets the pointer (its "leave" may never come);
  // back in front, the browser's own hover state says whether it is still there
  useEffect(() => {
    setHover(active ? pointerOn(el.current) : false);
  }, [active]);
  // GitHub#296: while paused, the real state once a second — a missed event never keeps it paused
  const paused = enabled && !counting;
  useEffect(() => {
    if (!paused) return;
    const t = setInterval(() => {
      windowState.recheck();
      setHover(pointerOn(el.current));
      setFocusIn(focusInside(el.current));
    }, PAUSE_RECHECK_MS);
    return () => clearInterval(t);
  }, [paused]);
  return {
    ref: (node: HTMLElement | null) => void (el.current = node),
    'data-auto-dismiss': enabled ? (counting ? 'counting' : 'paused') : undefined,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onFocus: () => setFocusIn(true),
    onBlur: (e: FocusEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusIn(false);
    },
  };
}
