// GitHub#502: find text on the page (⌘F) — the one place that holds the find state.
//
// The find bar (FindBar.tsx) draws it; the shortcuts (App.tsx) and the window's keydown listener (keyboard.ts,
// Esc) call into it; every discussion frame on screen is one "frame host" (DetailPanel.tsx registers it).
//
// Matches in the window are found by findMatches (findCore.ts). The discussion frame is a separate document
// the window cannot read: the window sends it the query and which of its matches is the current one, the
// frame's own script finds, highlights, unfolds and scrolls, and reports back how many it found. Its matches
// are placed in the order where the frame sits on the page.
//
// Esc: while the bar is open, Esc closes it first wherever the keyboard is (the bar, the page, the discussion
// frame — the frame hands Esc over only while it was told find is open), unless a dialog / picker / the
// shortcut list is on top; a second Esc then does what it always did. A frame's Esc arriving after the bar
// closed is dropped: it never becomes "back to the home tab".
import { findMatches, shown } from './findCore';

/** what the window tells a frame */
export type FrameFind = { open: boolean; q: string; cur: number; scroll: boolean };
/** one discussion frame on screen */
export type FrameHost = { el: () => HTMLIFrameElement | null; post: (m: FrameFind) => void };

type HostState = { n: number | null; q: string };
type Entry = { kind: 'win'; range: Range } | { kind: 'frame'; host: FrameHost; k: number };

export type FindView = {
  open: boolean;
  query: string;
  /** 1-based number of the current match (0 = none) */
  pos: number;
  total: number;
  /** a frame on screen has not answered yet for this query */
  pending: boolean;
  /** bumps when the bar should take the keyboard (and select its text) */
  focusSeq: number;
};

const HL = 'cavil-find';
const HL_CUR = 'cavil-find-cur';

let view: FindView = { open: false, query: '', pos: 0, total: 0, pending: false, focusSeq: 0 };
const listeners = new Set<() => void>();
const hosts = new Map<FrameHost, HostState>();
let entries: Entry[] = [];
let cur = -1;
let before: Element | null = null;
let observer: MutationObserver | null = null;
let redoTimer: ReturnType<typeof setTimeout> | null = null;

function emit(patch: Partial<FindView>): void {
  view = { ...view, ...patch };
  for (const l of listeners) l();
}

export function subscribeFind(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function findView(): FindView {
  return view;
}
export function findOpen(): boolean {
  return view.open;
}

function highlights(): { set: (k: string, v: unknown) => void; delete: (k: string) => void } | null {
  const c = (globalThis as { CSS?: { highlights?: { set: (k: string, v: unknown) => void; delete: (k: string) => void } } }).CSS;
  return c?.highlights && typeof (globalThis as { Highlight?: unknown }).Highlight === 'function' ? c.highlights : null;
}

function hostVisible(h: FrameHost): boolean {
  const el = h.el();
  return !!el && el.isConnected && shown(el);
}

/** the frame's matches go where the frame sits among the window's matches */
function build(win: Range[]): Entry[] {
  const out: Entry[] = win.map((range) => ({ kind: 'win', range }) as Entry);
  const fr = [...hosts].filter(([h, s]) => hostVisible(h) && s.q === view.query && typeof s.n === 'number' && s.n > 0);
  for (const [h, s] of fr) {
    const el = h.el()!;
    let at = out.findIndex((e) => e.kind === 'win' && (el.compareDocumentPosition(e.range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    if (at < 0) at = out.length;
    // after any matches of frames already placed before the same window match
    while (at > 0 && out[at - 1].kind === 'frame' && (out[at - 1] as { host: FrameHost }).host.el()!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) at--;
    const mine: Entry[] = Array.from({ length: s.n! }, (_, k) => ({ kind: 'frame', host: h, k }));
    out.splice(at, 0, ...mine);
  }
  return out;
}

/** the index in `next` closest after the old current match (it moved, or the list changed around it) */
function keepPlace(next: Entry[], old: Entry | null, oldIndex: number): number {
  if (!next.length) return -1;
  if (!old) return 0;
  if (old.kind === 'frame') {
    const same = next.findIndex((e) => e.kind === 'frame' && e.host === old.host && e.k === old.k);
    if (same >= 0) return same;
  } else if (old.range.startContainer.isConnected) {
    const at = next.findIndex((e) => {
      if (e.kind === 'win') return e.range.compareBoundaryPoints(Range.START_TO_START, old.range) >= 0;
      const el = e.host.el();
      return !!el && (old.range.startContainer.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    if (at >= 0) return at;
  }
  return Math.min(Math.max(oldIndex, 0), next.length - 1);
}

/**
 * Without highlight support the current match is shown as the selection. Find remembers the selection it made
 * (where it starts and ends) and takes it away again — on close, when nothing matches, when the current match
 * moves into a frame — but only while the selection is still exactly that one: text the person selected
 * afterwards is left alone (code review round 1 on PR #508).
 */
let ownSel: { sc: Node; so: number; ec: Node; eo: number } | null = null;
function selectOwn(r: Range): void {
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(r);
  ownSel = { sc: r.startContainer, so: r.startOffset, ec: r.endContainer, eo: r.endOffset };
}
function dropOwnSelection(): void {
  const mine = ownSel;
  ownSel = null;
  const sel = window.getSelection();
  if (!mine || !sel || sel.rangeCount !== 1) return;
  const r = sel.getRangeAt(0);
  if (r.startContainer === mine.sc && r.startOffset === mine.so && r.endContainer === mine.ec && r.endOffset === mine.eo) sel.removeAllRanges();
}

/** look again (query changed, page changed, a frame answered); `scroll`: bring the current match into view */
function redo(scroll: boolean, fresh: boolean): void {
  if (!view.open) return;
  const win = findMatches(document.body, view.query).map((m) => {
    const r = document.createRange();
    r.setStart(m.sn, m.so);
    r.setEnd(m.en, m.eo);
    return r;
  });
  const old = cur >= 0 ? entries[cur] ?? null : null;
  const next = build(win);
  cur = fresh ? keepPlace(next, old, 0) : keepPlace(next, old, cur);
  entries = next;
  paint(scroll);
}

function paint(scroll: boolean): void {
  const hl = highlights();
  const now = cur >= 0 ? entries[cur] : null;
  const win = entries.filter((e): e is Extract<Entry, { kind: 'win' }> => e.kind === 'win');
  if (hl) {
    const H = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
    hl.set(HL, new H(...win.filter((e) => e !== now).map((e) => e.range)));
    if (now?.kind === 'win') hl.set(HL_CUR, new H(now.range));
    else hl.delete(HL_CUR);
  } else if (now?.kind !== 'win') {
    // no highlight support and the current match is not in the window (none, or in a frame): the selection find made goes
    dropOwnSelection();
  } else if (scroll) {
    // no highlight support (WebKit before macOS 14.2): the current match is selected instead
    selectOwn(now.range);
  }
  if (now?.kind === 'win') {
    const d = now.range.startContainer.parentElement;
    for (let x = d?.closest('details:not([open])'); x; x = x.parentElement?.closest('details:not([open])') ?? null) (x as HTMLDetailsElement).open = true;
    if (scroll) d?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
  for (const [h, s] of hosts) {
    if (!hostVisible(h)) continue;
    const mine = now?.kind === 'frame' && now.host === h ? now.k : -1;
    if (mine >= 0 && scroll) h.el()?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // a frame that has not answered for this query is asked (cur -1 until it has)
    h.post({ open: true, q: view.query, cur: s.q === view.query ? mine : -1, scroll: scroll && mine >= 0 });
  }
  const pending = [...hosts].some(([h, s]) => hostVisible(h) && (s.q !== view.query || s.n === null)) && view.query !== '';
  emit({ pos: cur >= 0 ? cur + 1 : 0, total: entries.length, pending });
}

function clearPaint(): void {
  dropOwnSelection();
  const hl = highlights();
  hl?.delete(HL);
  hl?.delete(HL_CUR);
  for (const [h] of hosts) h.post({ open: false, q: '', cur: -1, scroll: false });
}

function watch(): void {
  observer?.disconnect();
  observer = new MutationObserver((list) => {
    // the bar's own text (its count) is not the page changing
    if (list.every((m) => (m.target instanceof Element ? m.target : m.target.parentElement)?.closest('[data-find-skip]'))) return;
    if (redoTimer) clearTimeout(redoTimer);
    redoTimer = setTimeout(() => {
      redoTimer = null;
      redo(false, false);
    }, 200);
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['open', 'hidden', 'class', 'style', 'data-front'] });
}

/** ⌘F: open the bar, or — when it is open — give it the keyboard again with its text selected */
export function openFind(): void {
  if (!view.open) {
    const a = document.activeElement;
    before = a && a !== document.body ? a : null;
    for (const s of hosts.values()) s.q = '\u0000';
    emit({ open: true, focusSeq: view.focusSeq + 1 });
    watch();
    redo(true, true);
  } else {
    // pressed again from somewhere else on the page: that is where the keyboard goes back to
    const a = document.activeElement;
    if (a && a !== document.body && !a.closest('[data-find-skip]')) before = a;
    emit({ focusSeq: view.focusSeq + 1 });
  }
}

/** what is typed in the bar */
export function setFindQuery(q: string): void {
  if (!view.open || q === view.query) return;
  emit({ query: q });
  redo(true, true);
}

/** next (1) / previous (-1) match, wrapping around */
export function stepFind(dir: 1 | -1): boolean {
  if (!view.open) return false;
  if (!entries.length) return true;
  cur = (cur + dir + entries.length) % entries.length;
  paint(true);
  return true;
}

/**
 * Close the bar: highlights go, the frames are told. The keyboard goes back to where it was before ⌘F — but only
 * when it is still in the bar (Esc pressed somewhere else, e.g. in the discussion: it stays there).
 */
export function closeFind(): boolean {
  if (!view.open) return false;
  const inBar = !!document.activeElement?.closest?.('[data-find-skip]');
  observer?.disconnect();
  observer = null;
  if (redoTimer) clearTimeout(redoTimer);
  redoTimer = null;
  clearPaint();
  entries = [];
  cur = -1;
  emit({ open: false, pos: 0, total: 0, pending: false });
  const back = before;
  before = null;
  if (inBar) {
    if (back && back.isConnected && typeof (back as HTMLElement).focus === 'function') (back as HTMLElement).focus();
    else (document.activeElement as HTMLElement | null)?.blur?.();
  }
  return true;
}

/** a plain Esc in the window: closes the bar when it is open and nothing is on top of the page */
export function findEscape(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, layerOnTop: boolean): boolean {
  if (!view.open || layerOnTop || e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  return closeFind();
}

/** Esc handed over by a discussion frame: only ever closes find (dropped when it is already closed) */
export function findEscapeFromFrame(layerOnTop: boolean): void {
  if (view.open && !layerOnTop) closeFind();
}

// ---- discussion frames ----

export function addFindFrame(h: FrameHost): () => void {
  hosts.set(h, { n: null, q: '\u0000' });
  return () => {
    hosts.delete(h);
    if (view.open) redo(false, false);
  };
}

/** the frame drew a new rendering and its script is ready: tell it where find stands */
export function findFrameReady(h: FrameHost): void {
  const s = hosts.get(h);
  if (!s) return;
  s.n = null;
  s.q = '\u0000';
  if (view.open) paint(false);
  else h.post({ open: false, q: '', cur: -1, scroll: false });
}

/** the frame's answer: how many matches of `q` it has */
export function findFrameFound(h: FrameHost, q: unknown, n: unknown): void {
  const s = hosts.get(h);
  if (!s || typeof q !== 'string' || typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100000) return;
  if (!view.open || q !== view.query) return;
  const changed = s.q !== q || s.n !== n;
  s.q = q;
  s.n = n;
  // no current match yet (nothing in the window): the frame's first one becomes current and is shown
  if (changed) redo(cur < 0, false);
}
