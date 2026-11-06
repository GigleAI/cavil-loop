// The React side of the shortcuts (GitHub#192): who handles a shortcut, and which layer is on top.
// The decision itself is `resolve` in shortcuts.ts; the single keydown listener is `useKeyboard` (App).
import { useEffect, useRef } from 'react';
import { resolve, typingOf, type Layer, type ShortcutId } from './shortcuts';

/**
 * A handler returns false when the key did nothing it should keep from the page (it is then left
 * to the browser); anything else means "handled". Handlers are the buttons' own actions behind the
 * buttons' own enabled conditions.
 */
type Handler = () => boolean | void;

/** per shortcut id, the handlers of the mounted components; the last mounted one acts */
const handlers = new Map<ShortcutId, Handler[]>();
/** the open layers, the last opened on top */
const layers: { kind: Exclude<Layer, 'none'> }[] = [];

/** Register handlers while the component is mounted (the latest closure is always used). */
export function useShortcuts(map: Partial<Record<ShortcutId, Handler>>): void {
  const ref = useRef(map);
  ref.current = map;
  const ids = Object.keys(map).sort().join(',');
  useEffect(() => {
    const mine = new Map<ShortcutId, Handler>();
    for (const id of ids.split(',').filter(Boolean) as ShortcutId[]) {
      const h: Handler = () => ref.current[id]?.();
      mine.set(id, h);
      const list = handlers.get(id) ?? [];
      list.push(h);
      handlers.set(id, list);
    }
    return () => {
      for (const [id, h] of mine) handlers.set(id, (handlers.get(id) ?? []).filter((x) => x !== h));
    };
  }, [ids]);
}

/** Put a layer on top while the component is mounted: it takes every key until it closes. */
export function useLayer(kind: Exclude<Layer, 'none'>): void {
  useEffect(() => {
    const me = { kind };
    layers.push(me);
    return () => {
      const i = layers.indexOf(me);
      if (i >= 0) layers.splice(i, 1);
    };
  }, [kind]);
}

export function topLayer(): Layer {
  return layers.length ? layers[layers.length - 1].kind : 'none';
}

/** The one keydown listener of the window. `signedIn` decides whether any shortcut acts at all. */
export function useKeyboard(signedIn: boolean): void {
  const on = useRef(signedIn);
  on.current = signedIn;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const id = resolve(e, { signedIn: on.current, layer: topLayer(), typing: typingOf(document.activeElement) });
      if (!id) return;
      const list = handlers.get(id);
      const h = list?.[list.length - 1];
      if (!h) return;
      if (h() !== false) e.preventDefault();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
}
