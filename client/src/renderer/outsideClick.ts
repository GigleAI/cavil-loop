// A click outside the detail panel puts it away (GitHub#191). One rule, here; the panel only
// collects what the pointer did and asks.
//
// A press is recorded when the button goes down (capture phase, before anything else reacts):
// a dialog that this very click is about to close was still open then, so cancelling a dialog
// by its backdrop never also puts the panel away.

/** Marks an element whose click opens an item (a card, a table row's title): it switches, never hides. */
export const OPENS_ITEM = 'data-opens-item';
/** Marks the backdrop of a modal dialog (every dialog in the window goes through ConfirmDialog). */
export const MODAL = 'data-modal';
/** A press that moved further than this before the click was a drag (scrollbar, selection), not a click. */
export const MOVE_SLOP = 4;

export type Press = {
  button: number;
  x: number;
  y: number;
  inPanel: boolean;
  opensItem: boolean;
  onScrollbar: boolean;
  /** a dialog was open when the button went down */
  dialogOpen: boolean;
};

export type Release = {
  x: number;
  y: number;
  inPanel: boolean;
  opensItem: boolean;
};

/**
 * Does this click put the panel away? `press` is the last button-down this window saw and
 * `release` the last button-up (null: none, e.g. it went into the isolated discussion frame);
 * `draft` is the reply box's text.
 *
 * The release is the button-up event's own target, never the click's: when press and release land
 * on different elements the browser sends the click to their common ancestor, so a press just
 * outside the panel and a release just inside it would look like "outside" (PR #199 review round 1).
 */
export function hidesPanel(press: Press | null, release: Release | null, draft: string): boolean {
  if (!press || !release) return false;
  if (press.button !== 0) return false;
  if (press.inPanel || release.inPanel) return false;
  if (press.opensItem || release.opensItem) return false;
  if (press.onScrollbar) return false;
  if (press.dialogOpen) return false;
  if (Math.abs(release.x - press.x) > MOVE_SLOP || Math.abs(release.y - press.y) > MOVE_SLOP) return false;
  // putting the panel away would throw the typed reply away
  if (draft !== '') return false;
  return true;
}

const within = (t: EventTarget | null, panel: Element | null) => t instanceof Node && panel !== null && panel.contains(t);
const opens = (t: EventTarget | null) => t instanceof Element && t.closest(`[${OPENS_ITEM}]`) !== null;

/** What a button-down in the window was: read from the page as it is at that moment. */
export function pressAt(e: PointerEvent, panel: Element | null): Press {
  const t = e.target;
  // a press past the element's content box (its client size) lands on its scrollbar
  const onScrollbar =
    t instanceof HTMLElement &&
    ((t.clientWidth > 0 && e.offsetX > t.clientWidth) || (t.clientHeight > 0 && e.offsetY > t.clientHeight));
  return {
    button: e.button,
    x: e.clientX,
    y: e.clientY,
    inPanel: within(t, panel),
    opensItem: opens(t),
    onScrollbar,
    dialogOpen: document.querySelector(`[${MODAL}]`) !== null,
  };
}

/** What a button-up in the window was (its own target: where the pointer really was let go). */
export function releaseAt(e: PointerEvent, panel: Element | null): Release {
  return { x: e.clientX, y: e.clientY, inPanel: within(e.target, panel), opensItem: opens(e.target) };
}

/**
 * The release a click stands for: the recorded button-up. A click from the keyboard (Enter / Space
 * on a button, `detail` 0) has none, whatever button-up came before: it never puts the panel away.
 */
export function releaseOfClick(e: MouseEvent, up: Release | null): Release | null {
  if (e.detail === 0) return null;
  return up;
}
