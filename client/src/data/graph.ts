// GitHub#350: the dependency graph — which issues go in, which box each sits in, which arrows
// there are — from the items the view shows. Pure; the layout is graphLayout.ts, the drawing
// GraphView.tsx.
//
// The rules (from the design confirmed on #346):
// - the view's sources and search pick the items first; of those, an issue with a parent,
//   sub-issues, a blocker or something it blocks goes in (an "entry"). PRs never do.
// - the other end of an entry's relation is drawn as well: from the source when it is there
//   (faded when the search hides it, so no arrow ends in the air), else from what GitHub said
//   about it while reading the entry ("not in the current sources", dashed).
// - an item whose relations are unknown (a snapshot cached before relations were read) is never
//   drawn as "no relations": it is counted apart and the view says so.
// - the layout depends on which nodes, boxes and arrows there are (`structure`), never on states
//   or labels: a state change redraws a node, it never moves one.

import type { IssueStateReason, Item, ItemState, RelatedIssue } from '../shared/types';

export interface GraphNode {
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: ItemState;
  stateReason: IssueStateReason | null;
  /** the item as the sources hold it; null = in no ticked source (drawn dashed, "不在当前来源中") */
  item: Item | null;
  /** in a source but hidden by the search: drawn faded, so the arrows into it do not break */
  dim: boolean;
  /** key of the node whose box this one sits in; null = top level */
  parent: string | null;
  /** keys of the nodes in this one's box, in GitHub's sub-issue order where known; empty = a plain node */
  children: string[];
  /** open blockers drawn into this node ("被 N 项挡住") */
  blockedByOpen: number;
  /** for an open node no open blocker holds: open nodes reachable along its arrows ("挡住后面 N 项") */
  blockingAhead: number;
  /** everything a node's drawing depends on, as one string: a node whose `look` is unchanged is not redrawn */
  look: string;
}

export interface GraphEdge {
  /** the blocker */
  from: string;
  /** the issue it blocks */
  to: string;
  /** the blocker is still open (amber, bold); false = closed (grey, thin) */
  open: boolean;
}

export interface GraphModel {
  nodes: Map<string, GraphNode>;
  /** top-level node keys, in a stable order */
  roots: string[];
  edges: GraphEdge[];
  /** the items the search picked that went in */
  entries: number;
  /** the items the search picked that have no relation (PRs included): not drawn */
  noRelation: number;
  /** the items the search picked whose relations are unknown: not drawn, never counted as "no relations" */
  unknown: number;
  /** nodes, boxes and arrows (no states, no labels): the layout is computed again only when this changes */
  structure: string;
}

const hasRelations = (i: Item) => {
  const r = i.relations!;
  return r.parent !== null || r.subIssues.length > 0 || r.blockedBy.length > 0 || r.blocking.length > 0;
};

const byNumber = (a: { repo: string; number: number }, b: { repo: string; number: number }) =>
  a.repo.toLowerCase() < b.repo.toLowerCase() ? -1 : a.repo.toLowerCase() > b.repo.toLowerCase() ? 1 : a.number - b.number;

/**
 * The graph of `shown` (the items the view's sources and search picked) within `all` (every item of
 * the ticked sources, searched or not).
 */
export function buildGraph(all: Item[], shown: Item[]): GraphModel {
  const inSource = new Map(all.map((i) => [i.key, i]));
  const picked = new Set(shown.map((i) => i.key));
  let unknown = 0;
  let noRelation = 0;
  const entries: Item[] = [];
  for (const i of shown) {
    if (i.relations === undefined) unknown++;
    else if (i.kind === 'issue' && hasRelations(i)) entries.push(i);
    else noRelation++;
  }

  // the nodes: every entry, and the other end of each of its relations
  const nodes = new Map<string, GraphNode>();
  /** what GitHub said about an end outside the sources, and when that was read (the newest wins) */
  const heardAt = new Map<string, number>();
  const blank = (x: { key: string; repo: string; number: number; title: string; url: string; state: ItemState; stateReason: IssueStateReason | null }, item: Item | null): GraphNode => ({
    key: x.key,
    repo: x.repo,
    number: x.number,
    title: x.title,
    url: x.url,
    state: x.state,
    stateReason: x.stateReason,
    item,
    dim: item !== null && !picked.has(x.key),
    parent: null,
    children: [],
    blockedByOpen: 0,
    blockingAhead: 0,
    look: '',
  });
  for (const e of entries) nodes.set(e.key, blank(e, e));
  for (const e of entries) {
    const r = e.relations!;
    const at = e.relationsAt ?? 0;
    for (const end of [...(r.parent ? [r.parent] : []), ...r.subIssues, ...r.blockedBy, ...r.blocking]) {
      const item = inSource.get(end.key);
      if (item) {
        // a PR never has relations; an end that is one would be a GitHub oddity: leave it out
        if (item.kind === 'issue' && !nodes.has(end.key)) nodes.set(end.key, blank(item, item));
        continue;
      }
      const seen = heardAt.get(end.key);
      if (seen === undefined || at > seen) {
        nodes.set(end.key, blank(end as RelatedIssue, null));
        heardAt.set(end.key, at);
      }
    }
  }

  // boxes: a child's own word on its parent first, then the parents' sub-issue lists
  const parentOf = new Map<string, string>();
  const order = new Map<string, number>();
  const wouldLoop = (child: string, parent: string) => {
    for (let p: string | undefined = parent, n = 0; p !== undefined && n <= nodes.size; p = parentOf.get(p), n++) if (p === child) return true;
    return false;
  };
  const setParent = (child: string, parent: string) => {
    if (child === parent || parentOf.has(child) || !nodes.has(child) || !nodes.has(parent) || wouldLoop(child, parent)) return;
    parentOf.set(child, parent);
  };
  const known = [...nodes.values()].filter((n) => n.item?.relations).sort(byNumber);
  for (const n of known) if (n.item!.relations!.parent) setParent(n.key, n.item!.relations!.parent.key);
  for (const n of known) n.item!.relations!.subIssues.forEach((s, i) => (setParent(s.key, n.key), order.set(s.key, i)));

  // arrows: from each in-source node's own lists, both directions, once each
  const edgeKeys = new Set<string>();
  const pairs: [string, string][] = [];
  const addEdge = (from: string, to: string) => {
    const k = `${from}\u0000${to}`;
    if (from === to || edgeKeys.has(k) || !nodes.has(from) || !nodes.has(to)) return;
    edgeKeys.add(k);
    pairs.push([from, to]);
  };
  for (const n of known) {
    for (const b of n.item!.relations!.blockedBy) addEdge(b.key, n.key);
    for (const x of n.item!.relations!.blocking) addEdge(n.key, x.key);
  }
  pairs.sort(([a, b], [c, d]) => (a === c ? (b < d ? -1 : b > d ? 1 : 0) : a < c ? -1 : 1));
  // an in-source node's state is the fresher one: it is read with the item, not with the other end's relations
  const edges: GraphEdge[] = pairs.map(([from, to]) => ({ from, to, open: nodes.get(from)!.state === 'open' }));

  for (const [child, parent] of parentOf) {
    nodes.get(child)!.parent = parent;
    nodes.get(parent)!.children.push(child);
  }
  for (const n of nodes.values())
    n.children.sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity) || byNumber(nodes.get(a)!, nodes.get(b)!));

  // badges
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (e.open) nodes.get(e.to)!.blockedByOpen++;
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  }
  for (const n of nodes.values()) {
    if (n.state !== 'open' || n.blockedByOpen > 0 || !out.has(n.key)) continue;
    const seen = new Set<string>([n.key]);
    const queue = [...out.get(n.key)!];
    while (queue.length) {
      const k = queue.shift()!;
      if (seen.has(k)) continue;
      seen.add(k);
      if (nodes.get(k)!.state === 'open') n.blockingAhead++;
      queue.push(...(out.get(k) ?? []));
    }
  }

  for (const n of nodes.values()) {
    const it = n.item;
    const sub = it?.subIssues ?? null;
    n.look = JSON.stringify([n.title, n.state, n.stateReason, n.dim, n.item === null, n.blockedByOpen, n.blockingAhead, it?.labels.map((l) => [l.name, l.color]) ?? null, sub, it?.edits?.map((m) => [m.label, m.status]) ?? null]);
  }

  const roots = [...nodes.values()].filter((n) => n.parent === null).sort(byNumber).map((n) => n.key);
  const structure = JSON.stringify([[...nodes.keys()].sort(), [...parentOf].sort(), pairs]);
  return { nodes, roots, edges, entries: entries.length, noRelation, unknown, structure };
}

/** The sub-issue count a box shows: GitHub's own count when the item carries it, else what the graph holds. */
export function boxProgress(model: GraphModel, key: string): { completed: number; total: number } | null {
  const n = model.nodes.get(key)!;
  if (n.item?.subIssues) return n.item.subIssues;
  const subs = n.item?.relations?.subIssues;
  if (subs?.length) return { total: subs.length, completed: subs.filter((s) => s.state === 'closed').length };
  return null;
}
