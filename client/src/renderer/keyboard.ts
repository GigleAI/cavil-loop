// The React side of the shortcuts (GitHub#192): who handles a shortcut, and which layer is on top.
// The decision itself is `resolve` in shortcuts.ts; the single keydown listener is `useKeyboard` (App).
import { useEffect, useRef } from 'react';
import { FRAME_IDS, resolve, typingOf, type KeyLike, type Layer, type Page, type ShortcutId, type Typing } from './shortcuts';

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

/** whether a shortcut may act at all: set by the window's listener (App), read by forwarded keys too */
let signedInNow = false;
/** the page showing (GitHub#369): set by App together with signedInNow */
let pageNow: Page = 'board';

/**
 * One key press, decided by `resolve` and run by the mounted handler: the id that acted, or null.
 * Both the window's own keydown listener and a key forwarded by the discussion frame go through here.
 */
function press(e: KeyLike, typing: Typing, only?: readonly ShortcutId[]): ShortcutId | null {
  const id = resolve(e, { signedIn: signedInNow, layer: topLayer(), typing, page: pageNow });
  if (!id || (only && !only.includes(id))) return null;
  const list = handlers.get(id);
  const h = list?.[list.length - 1];
  if (!h) return null;
  return h() !== false ? id : null;
}

/**
 * A key the isolated discussion frame reported (GitHub#322 / #433): one single key with whether
 * ⌘/Ctrl and Shift were held. It is judged exactly like a key pressed outside any text field, and only
 * the shortcuts of FRAME_IDS (go to the reply box, 关闭 issue / 交给 agent / 托管) may act — every
 * other key stays inside the frame (PR #171: the maintainer chose to keep it isolated).
 */
export function frameKey(key: unknown, mod: unknown = false, shift: unknown = false): boolean {
  if (typeof key !== 'string' || key.length !== 1 || typeof mod !== 'boolean' || typeof shift !== 'boolean') return false;
  return press({ key, metaKey: mod, ctrlKey: false, altKey: false, shiftKey: shift }, 'none', FRAME_IDS) !== null;
}

/**
 * The one keydown listener of the window. `signedIn` decides whether any shortcut acts at all;
 * `page` which page's own keys act (GitHub#369: the settings page's Esc).
 */
export function useKeyboard(signedIn: boolean, page: Page = 'board'): void {
  signedInNow = signedIn;
  pageNow = page;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (press(e, typingOf(document.activeElement))) e.preventDefault();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
}
