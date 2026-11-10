// GitHub#350: where each node and box of the dependency graph goes, and the view's pan / zoom
// arithmetic. Pure, written here rather than taken from a drawing library (the installer's size
// gate, the window's content security policy).
//
// - inside a box, children are put in columns by the arrows between them, blockers on the left
//   (longest path; an arrow that would close a loop is set aside for the layering — it is still
//   drawn)
// - at the top level, nodes and boxes joined by arrows form a group laid out the same way; the
//   groups are then put in rows to fill the window's shape, not one long column, groups with open
//   issues first
// - nothing here reads a label; the state is read only to put open groups first, and the caller
//   lays out again only when the graph's `structure` changed (so a state change never moves a node)

import type { GraphModel } from './graph';

export const NODE_W = 236;
export const NODE_H = 84;
/** a box's head: the title row and the labels row (GitHub#350 review round 1: a parent shows its labels too) */
export const BOX_HEAD = 62;
export const BOX_PAD = 14;
export const BOX_MIN_W = 320;
export const GAP_X = 64;
export const GAP_Y = 16;
export const GROUP_GAP = 36;
export const MARGIN = 28;
/** room above the graph for the legend and the zoom buttons */
export const TOP = 64;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface GraphLayout {
  /** every node: a plain node's card, or a parent's whole box */
  rects: Map<string, Rect>;
  /** top-level groups (nodes joined by arrows), in the order they were placed */
  groups: { keys: string[]; rect: Rect; open: boolean }[];
  width: number;
  height: number;
}

interface Placed {
  w: number;
  h: number;
  /** positions relative to the block's top-left */
  at: Map<string, Rect>;
}

/**
 * Lay out `model`. `aspect` = the window's width / height (the shape the top-level groups fill).
 */
export function layoutGraph(model: GraphModel, aspect: number): GraphLayout {
  const { nodes } = model;
  // the ancestor of `key` among `set` (itself included); undefined = none
  const within = (key: string, set: Set<string>) => {
    for (let k: string | null = key, n = 0; k !== null && n <= nodes.size; k = nodes.get(k)!.parent, n++) if (set.has(k)) return k;
    return undefined;
  };
  /** arrows between different members of `keys`, lifted to the members holding their ends */
  const lifted = (keys: string[]) => {
    const set = new Set(keys);
    const out: [string, string][] = [];
    const seen = new Set<string>();
    for (const e of model.edges) {
      const a = within(e.from, set);
      const b = within(e.to, set);
      if (!a || !b || a === b || seen.has(`${a}\u0000${b}`)) continue;
      seen.add(`${a}\u0000${b}`);
      out.push([a, b]);
    }
    return out;
  };

  const sizes = new Map<string, Placed>();
  const block = (key: string): Placed => {
    const done = sizes.get(key);
    if (done) return done;
    const n = nodes.get(key)!;
    let p: Placed;
    if (!n.children.length) p = { w: NODE_W, h: NODE_H, at: new Map() };
    else {
      const inner = columns(n.children);
      const at = new Map<string, Rect>();
      for (const [k, r] of inner.at) at.set(k, { ...r, x: r.x + BOX_PAD, y: r.y + BOX_HEAD + BOX_PAD });
      p = { w: Math.max(BOX_MIN_W, inner.w + 2 * BOX_PAD), h: BOX_HEAD + inner.h + 2 * BOX_PAD, at };
    }
    sizes.set(key, p);
    return p;
  };

  /** members in columns by the arrows between them (blockers left), stacked top-down in each column */
  const columns = (keys: string[]): Placed => {
    const edges = lifted(keys);
    const succ = new Map<string, string[]>(keys.map((k) => [k, []]));
    for (const [a, b] of edges) succ.get(a)!.push(b);
    // set aside arrows that close a loop (GitHub forbids loops; a stale read could still show one)
    const state = new Map<string, 0 | 1 | 2>();
    const kept: [string, string][] = [];
    const visit = (k: string) => {
      state.set(k, 1);
      for (const s of succ.get(k)!) {
        if (state.get(s) === 1) continue;
        kept.push([k, s]);
        if (!state.get(s)) visit(s);
      }
      state.set(k, 2);
    };
    for (const k of keys) if (!state.get(k)) visit(k);
    const layer = new Map<string, number>(keys.map((k) => [k, 0]));
    // longest path; at most keys.length passes on an acyclic set
    for (let pass = 0; pass < keys.length; pass++) {
      let moved = false;
      for (const [a, b] of kept)
        if (layer.get(b)! < layer.get(a)! + 1) {
          layer.set(b, layer.get(a)! + 1);
          moved = true;
        }
      if (!moved) break;
    }
    const cols: string[][] = [];
    for (const k of keys) (cols[layer.get(k)!] ??= []).push(k);
    const at = new Map<string, Rect>();
    const pos = new Map<string, number>();
    let x = 0;
    let h = 0;
    cols.forEach((col, ci) => {
      if (!col) return;
      // order a column by where its blockers sit, then keep the given order
      if (ci > 0) {
        const preds = (k: string) => kept.filter(([, b]) => b === k).map(([a]) => pos.get(a)).filter((v): v is number => v !== undefined);
        const weight = new Map(col.map((k, i) => [k, preds(k).length ? preds(k).reduce((s, v) => s + v, 0) / preds(k).length : 1e9 + i]));
        col.sort((a, b) => weight.get(a)! - weight.get(b)! || col.indexOf(a) - col.indexOf(b));
      }
      let y = 0;
      let w = 0;
      col.forEach((k, i) => {
        const b = block(k);
        at.set(k, { x, y, w: b.w, h: b.h });
        pos.set(k, i);
        y += b.h + GAP_Y;
        w = Math.max(w, b.w);
      });
      h = Math.max(h, y - GAP_Y);
      x += w + GAP_X;
    });
    return { w: Math.max(0, x - GAP_X), h, at };
  };

  // top-level groups: joined by arrows between their members
  const roots = model.roots;
  const group = new Map<string, string>(roots.map((k) => [k, k]));
  const find = (k: string): string => {
    while (group.get(k) !== k) k = group.get(k)!;
    return k;
  };
  for (const [a, b] of lifted(roots)) group.set(find(a), find(b));
  const members = new Map<string, string[]>();
  for (const k of roots) members.set(find(k), [...(members.get(find(k)) ?? []), k]);
  const openIn = (k: string): boolean => nodes.get(k)!.state === 'open' || nodes.get(k)!.children.some(openIn);
  const blocks = [...members.values()].map((keys) => ({ keys, placed: columns(keys), open: keys.some(openIn) }));
  // open groups first, then the bigger ones; the first member's number keeps the rest steady
  blocks.sort((a, b) => Number(b.open) - Number(a.open) || b.keys.length - a.keys.length || roots.indexOf(a.keys[0]) - roots.indexOf(b.keys[0]));

  const area = blocks.reduce((s, b) => s + (b.placed.w + GROUP_GAP) * (b.placed.h + GROUP_GAP), 0);
  const widest = blocks.reduce((s, b) => Math.max(s, b.placed.w), 0);
  const rowW = Math.max(widest, Math.sqrt(area * Math.max(0.2, Math.min(5, aspect || 1))));
  const rects = new Map<string, Rect>();
  const groups: GraphLayout['groups'] = [];
  let x = MARGIN;
  let y = TOP;
  let rowH = 0;
  let width = 0;
  const put = (key: string, r: Rect) => {
    rects.set(key, r);
    const p = sizes.get(key);
    if (p) for (const [k, c] of p.at) put(k, { ...c, x: r.x + c.x, y: r.y + c.y });
  };
  for (const b of blocks) {
    if (x > MARGIN && x - MARGIN + b.placed.w > rowW) {
      x = MARGIN;
      y += rowH + GROUP_GAP;
      rowH = 0;
    }
    for (const [k, r] of b.placed.at) put(k, { ...r, x: x + r.x, y: y + r.y });
    groups.push({ keys: b.keys, rect: { x, y, w: b.placed.w, h: b.placed.h }, open: b.open });
    x += b.placed.w + GROUP_GAP;
    width = Math.max(width, x - GROUP_GAP);
    rowH = Math.max(rowH, b.placed.h);
  }
  return { rects, groups, width: width + MARGIN, height: blocks.length ? y + rowH + MARGIN : 0 };
}

/** Where an arrow runs: from the blocker's right edge to the blocked one's left (a box: its head row). */
export function edgePath(from: Rect, to: Rect, fromBox: boolean, toBox: boolean): { d: string; end: [number, number]; angle: number } {
  const midY = (r: Rect, box: boolean) => r.y + (box ? BOX_HEAD / 2 : r.h / 2);
  if (to.x >= from.x + from.w + 8) {
    const sx = from.x + from.w;
    const sy = midY(from, fromBox);
    const ex = to.x;
    const ey = midY(to, toBox);
    const c = Math.max(24, (ex - sx) / 2);
    return { d: `M${sx},${sy} C${sx + c},${sy} ${ex - c},${ey} ${ex},${ey}`, end: [ex, ey], angle: 0 };
  }
  // the blocked one is not to the right (same column, or a loop set aside): run bottom → top or top → bottom
  const down = to.y >= from.y + from.h;
  const sx = from.x + from.w / 2;
  const sy = down ? from.y + from.h : from.y;
  const ex = to.x + to.w / 2;
  const ey = down ? to.y : to.y + to.h;
  const c = Math.max(20, Math.abs(ey - sy) / 2);
  return { d: `M${sx},${sy} C${sx},${sy + (down ? c : -c)} ${ex},${ey + (down ? -c : c)} ${ex},${ey}`, end: [ex, ey], angle: down ? 90 : -90 };
}

// ---- the view: screen = world × scale + (tx, ty) ----

export interface Viewport {
  tx: number;
  ty: number;
  scale: number;
  /**
   * the smallest scale zooming may reach in this view; absent = MIN_SCALE. A "fit" of a graph that needs
   * less than MIN_SCALE sets it to that fit's scale and it stays put while zooming in and out from there
   * (PR #367 review round 2: taking the current scale as the floor made "+" then "-" a one-way trip)
   */
  floor?: number;
}
export const MIN_SCALE = 0.2;
export const MAX_SCALE = 2;
/** below this the text on the nodes is too small to read: the graph counts as "too big" */
export const READABLE_SCALE = 0.6;
/** where a too-big graph opens: below 100%, still readable */
export const FOCUS_SCALE = 0.85;

/**
 * Keep a zoom within bounds. `floor` lowers the bottom bound below MIN_SCALE: "fit" may need less than
 * MIN_SCALE to put a very wide graph in the window, and zooming from there must not jump back up.
 */
export const clampScale = (s: number, floor: number = MIN_SCALE) => Math.min(MAX_SCALE, Math.max(Math.min(MIN_SCALE, floor), s));

/** The whole graph in the window (never above 100%), and whether that is too small to read. */
export function fitView(layout: Pick<GraphLayout, 'width' | 'height'>, vw: number, vh: number): { view: Viewport; tooBig: boolean } {
  if (!layout.width || !layout.height || vw <= 0 || vh <= 0) return { view: { tx: 0, ty: 0, scale: 1 }, tooBig: false };
  const raw = Math.min(vw / layout.width, vh / layout.height, 1);
  // the scale the whole graph needs, even below the manual zoom's floor: "fit" means every edge is in the window
  const scale = raw;
  const view: Viewport = { scale, tx: (vw - layout.width * scale) / 2, ty: (vh - layout.height * scale) / 2 };
  if (scale < MIN_SCALE) view.floor = scale;
  return { view, tooBig: raw < READABLE_SCALE };
}

/** The open part: the first group holding an open issue (they are placed first), at a readable size. */
export function focusOpen(layout: GraphLayout, vw: number, vh: number): Viewport | null {
  const g = layout.groups.find((x) => x.open);
  if (!g || vw <= 0 || vh <= 0) return null;
  const r = { x: g.rect.x - MARGIN, y: g.rect.y - TOP, w: g.rect.w + 2 * MARGIN, h: g.rect.h + TOP + MARGIN };
  const scale = clampScale(Math.min(FOCUS_SCALE, Math.max(READABLE_SCALE, Math.min(vw / r.w, vh / r.h))));
  // its top-left corner at the window's (it is the first group placed: what follows it is to the right and below)
  const tx = -r.x * scale;
  const ty = -r.y * scale;
  return { tx, ty, scale };
}

/** Zoom by `factor` keeping the world point under (px, py) where it is on screen. */
export function zoomAt(v: Viewport, factor: number, px: number, py: number): Viewport {
  // the view's own floor (a fit below MIN_SCALE): zooming out stops there, it never jumps up to MIN_SCALE
  const scale = clampScale(v.scale * factor, v.floor ?? MIN_SCALE);
  const k = scale / v.scale;
  return { ...v, scale, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
}

/**
 * After the graph was laid out again: the node nearest the middle of the window before stays where
 * it was on screen. Null = no node is in both layouts (keep the view as it is).
 */
export function keepAnchor(before: Map<string, Rect>, after: Map<string, Rect>, v: Viewport, vw: number, vh: number, isBox: (key: string) => boolean): Viewport | null {
  const cx = (vw / 2 - v.tx) / v.scale;
  const cy = (vh / 2 - v.ty) / v.scale;
  let best: string | null = null;
  let bestD = Infinity;
  for (const [k, r] of before) {
    // a plain node pins better than a box (a box grows and shrinks with its children)
    if (!after.has(k) || isBox(k)) continue;
    const d = (r.x + r.w / 2 - cx) ** 2 + (r.y + r.h / 2 - cy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  if (best === null)
    for (const [k, r] of before) {
      if (!after.has(k)) continue;
      const d = (r.x + r.w / 2 - cx) ** 2 + (r.y + r.h / 2 - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
  if (best === null) return null;
  const a = before.get(best)!;
  const b = after.get(best)!;
  return { ...v, tx: v.tx + (a.x - b.x) * v.scale, ty: v.ty + (a.y - b.y) * v.scale };
}
