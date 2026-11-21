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
// - GitHub#429: an arrow also comes from the loop's own registration (the hidden comment the daemon
//   waits by), read only for open issues carrying the "waiting for a prerequisite" label; merged with
//   GitHub's "Blocked by" (one arrow per pair). Its prerequisite may be a pull request: that node is
//   drawn too (only as such an end — PRs still never go in as entries). A registration read under
//   another label setting, or not yet read, makes the issue "unknown", never "waits for nothing".
// - GitHub#526: the daemon takes a registration on a pull request too (an open PR carrying the label):
//   such a PR goes in as an entry of its own, its prerequisites drawn into it, and it sits in the box
//   of the issue it is linked to (the board's "a PR goes under its issue" rule, `prHosts`) — top level
//   when that issue is not drawn or sits at the top. It is the only way a PR goes in as an entry.
// - GitHub#636: a dashed link joins a PR node to every issue node it is linked to (the issue's linked
//   PRs, or the PR's description naming the issue — the same relation the summary's "linked PRs" list
//   shows). It is not an arrow: "被 N 项挡住" never counts it. "挡住后面 N 项" crosses it only on a walk
//   that reached the PR along arrows through open nodes alone (so a blocker whose path to the PR runs
//   through a finished item, or the PR itself as the start, never counts the issue behind it); an issue
//   with no open blocker of its own whose PR is held shows "它的 PR 被挡住" instead.

import type { IssueStateReason, Item, ItemKind, ItemState, RelatedIssue } from '../shared/types';
import { labelAt, loopCandidate, type LabelFor } from './loopBlocked';
import { issuePrLinks, prHosts } from './prNest';
import { badgeText, stateTone, type StateTone } from '../shared/stateTone';

export interface GraphNode {
  key: string;
  repo: string;
  number: number;
  /** GitHub#429: 'pr' only for a pull request named by a loop registration (GitHub#526: or carrying one) */
  kind: ItemKind;
  title: string;
  url: string;
  state: ItemState;
  stateReason: IssueStateReason | null;
  /** GitHub#429: a pull request's draft mark (the item's when it is in a source, else what the registration read said); null = not a PR / not known */
  isDraft: boolean | null;
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
  /**
   * GitHub#636: for an open issue with no open blocker of its own, the open PRs linked to it that an open
   * blocker holds ("它的 PR 被挡住"), sorted; empty otherwise
   */
  prBlocked: string[];
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

/** GitHub#636: a PR joined to an issue it is linked to (dashed) — not a blocking arrow */
export interface GraphLink {
  /** the pull request */
  from: string;
  /** the issue */
  to: string;
  /** both ends are open (teal); false = either is closed / merged (grey, never crossed when counting) */
  open: boolean;
}

export interface GraphModel {
  nodes: Map<string, GraphNode>;
  /** top-level node keys, in a stable order */
  roots: string[];
  edges: GraphEdge[];
  /** GitHub#636: PR → linked issue, both drawn; sorted */
  links: GraphLink[];
  /** the items the search picked that went in (GitHub#429: or are drawn as the other end of one that did) */
  entries: number;
  /** the items the search picked that have no relation (PRs included): not drawn */
  noRelation: number;
  /** the items the search picked whose relations are unknown: not drawn, never counted as "no relations" */
  unknown: number;
  /** nodes, boxes and arrows (no states, no labels): the layout is computed again only when this changes */
  structure: string;
}

/** GitHub#429: the loop registration's prerequisites under the current setting ('' = off: none taken) */
const loopEnds = (i: Item, loopFor: LabelFor): RelatedIssue[] => {
  const loopLabel = labelAt(loopFor, i.repo);
  return loopLabel && i.loopBlocked?.label === loopLabel ? i.loopBlocked.ends : [];
};
/** GitHub#429: an issue whose registration should be there but was not read under the current setting */
const loopUnknown = (i: Item, loopFor: LabelFor) => {
  const loopLabel = labelAt(loopFor, i.repo);
  return loopCandidate(i, loopLabel) && i.loopBlocked?.label !== loopLabel;
};

const hasRelations = (i: Item, loopLabel: LabelFor) => {
  const r = i.relations!;
  return r.parent !== null || r.subIssues.length > 0 || r.blockedBy.length > 0 || r.blocking.length > 0 || loopEnds(i, loopLabel).length > 0;
};

const byNumber = (a: { repo: string; number: number }, b: { repo: string; number: number }) =>
  a.repo.toLowerCase() < b.repo.toLowerCase() ? -1 : a.repo.toLowerCase() > b.repo.toLowerCase() ? 1 : a.number - b.number;

/**
 * The graph of `shown` (the items the view's sources and search picked) within `all` (every item of
 * the ticked sources, searched or not).
 */
export function buildGraph(
  all: Item[],
  shown: Item[],
  /** GitHub#429: the "waiting for a prerequisite" label setting; '' = only GitHub's own relations (GitHub#569: per repository when a function) */
  loopLabel: LabelFor = '',
): GraphModel {
  const inSource = new Map(all.map((i) => [i.key, i]));
  const picked = new Set(shown.map((i) => i.key));
  let unknown = 0;
  let noRelation = 0;
  const entries: Item[] = [];
  /** picked, known, with no relation of its own — not drawn unless another entry names it */
  const rest: Item[] = [];
  for (const i of shown) {
    if (i.relations === undefined || loopUnknown(i, loopLabel)) unknown++;
    else if (i.kind === 'issue' ? hasRelations(i, loopLabel) : loopEnds(i, loopLabel).length > 0) entries.push(i);
    else rest.push(i);
  }

  // the nodes: every entry, and the other end of each of its relations
  const nodes = new Map<string, GraphNode>();
  /** what GitHub said about an end outside the sources, and when that was read (the newest wins) */
  const heardAt = new Map<string, number>();
  const blank = (
    x: { key: string; repo: string; number: number; title: string; url: string; state: ItemState; stateReason: IssueStateReason | null; kind?: ItemKind; isDraft?: boolean | null },
    item: Item | null,
  ): GraphNode => ({
    key: x.key,
    repo: x.repo,
    number: x.number,
    kind: x.kind === 'pr' ? 'pr' : 'issue',
    isDraft: x.kind === 'pr' && typeof x.isDraft === 'boolean' ? x.isDraft : null,
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
    prBlocked: [],
    look: '',
  });
  for (const e of entries) nodes.set(e.key, blank(e, e));
  for (const e of entries) {
    const r = e.relations!;
    const at = e.relationsAt ?? 0;
    const loop = new Set(loopEnds(e, loopLabel).map((x) => x.key));
    for (const end of [...(r.parent ? [r.parent] : []), ...r.subIssues, ...r.blockedBy, ...r.blocking, ...loopEnds(e, loopLabel)]) {
      const item = inSource.get(end.key);
      if (item) {
        // a PR never has GitHub relations; one named there would be a GitHub oddity: leave it out —
        // but a loop registration may wait for a PR (GitHub#429): that one is drawn
        if ((item.kind === 'issue' || loop.has(end.key)) && !nodes.has(end.key)) nodes.set(end.key, blank(item, item));
        continue;
      }
      const seen = heardAt.get(end.key);
      if (seen === undefined || at > seen) {
        nodes.set(end.key, blank(end as RelatedIssue, null));
        heardAt.set(end.key, at);
      }
    }
  }

  // GitHub#429: a picked item with no relation of its own that an entry names (a loop registration
  // waits for it; GitHub records no reverse side for that) is drawn: it counts as shown, not hidden
  let drawnEnds = 0;
  for (const i of rest) if (nodes.has(i.key)) drawnEnds++;
  else noRelation++;

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
  // GitHub#526: a PR that went in with a registration of its own sits in the box its linked issue sits in
  const prEntries = entries.filter((e) => e.kind === 'pr');
  if (prEntries.length) {
    const hosts = prHosts(all);
    for (const e of prEntries) {
      const host = hosts.get(e.key);
      const box = host !== undefined && nodes.has(host) ? parentOf.get(host) : undefined;
      if (box !== undefined) setParent(e.key, box);
    }
  }

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
    // GitHub#429: the loop's registration, the same direction as "Blocked by" (same pair: one arrow)
    for (const b of loopEnds(n.item!, loopLabel)) addEdge(b.key, n.key);
  }
  pairs.sort(([a, b], [c, d]) => (a === c ? (b < d ? -1 : b > d ? 1 : 0) : a < c ? -1 : 1));
  // an in-source node's state is the fresher one: it is read with the item, not with the other end's relations
  const edges: GraphEdge[] = pairs.map(([from, to]) => ({ from, to, open: nodes.get(from)!.state === 'open' }));

  // GitHub#636: PR ⇢ issue links, both ends drawn, from either side's word (never from the order of `all`)
  const linkKeys = new Set<string>();
  const addLink = (pr: string, issue: string) => {
    const a = nodes.get(pr);
    const b = nodes.get(issue);
    if (!a || !b || a.kind !== 'pr' || b.kind !== 'issue') return;
    linkKeys.add(`${pr}\u0000${issue}`);
  };
  for (const n of nodes.values()) {
    if (!n.item) continue;
    if (n.kind === 'issue') for (const l of issuePrLinks(n.item, all) ?? []) addLink(l.key, n.key);
    else for (const k of n.item.refIssues ?? []) addLink(n.key, k);
  }
  const links: GraphLink[] = [...linkKeys]
    .sort()
    .map((k) => k.split('\u0000') as [string, string])
    .map(([from, to]) => ({ from, to, open: nodes.get(from)!.state === 'open' && nodes.get(to)!.state === 'open' }));

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
  // GitHub#636: an open issue with no open blocker of its own, whose open linked PR an open blocker holds
  const across = new Map<string, string[]>();
  for (const l of links) if (l.open) across.set(l.from, [...(across.get(l.from) ?? []), l.to]);
  for (const l of links) {
    const b = nodes.get(l.to)!;
    if (l.open && b.blockedByOpen === 0 && nodes.get(l.from)!.blockedByOpen > 0) b.prBlocked.push(l.from);
  }
  for (const n of nodes.values()) n.prBlocked.sort();
  // "挡住后面 N 项": along the arrows as before (through closed nodes too), and across a link only from a PR
  // reached along arrows through open nodes alone. A node reached only on a path through a closed one may
  // be reached again on an all-open path (and then go on across its links); never the other way round.
  for (const n of nodes.values()) {
    if (n.state !== 'open' || n.blockedByOpen > 0 || n.prBlocked.length > 0 || !out.has(n.key)) continue;
    const seen = new Set<string>([n.key]);
    const seenOpen = new Set<string>([n.key]);
    const queue: [string, boolean][] = [[n.key, true]];
    const reach = (k: string, ok: boolean) => {
      if (ok ? seenOpen.has(k) : seen.has(k)) return;
      if (ok) seenOpen.add(k);
      if (!seen.has(k)) {
        seen.add(k);
        if (nodes.get(k)!.state === 'open') n.blockingAhead++;
      }
      queue.push([k, ok]);
    };
    while (queue.length) {
      const [k, ok] = queue.shift()!;
      for (const v of out.get(k) ?? []) reach(v, ok && nodes.get(v)!.state === 'open');
      if (ok && k !== n.key) for (const v of across.get(k) ?? []) reach(v, true);
    }
  }

  for (const n of nodes.values()) {
    const it = n.item;
    const sub = it?.subIssues ?? null;
    n.look = JSON.stringify([n.kind, n.isDraft, n.title, n.state, n.stateReason, n.dim, n.item === null, n.blockedByOpen, n.blockingAhead, n.prBlocked, it?.labels.map((l) => [l.name, l.color]) ?? null, sub, it?.edits?.map((m) => [m.label, m.status]) ?? null]);
  }

  const roots = [...nodes.values()].filter((n) => n.parent === null).sort(byNumber).map((n) => n.key);
  const structure = JSON.stringify([[...nodes.keys()].sort(), [...parentOf].sort(), pairs, links.map((l) => [l.from, l.to])]);
  return { nodes, roots, edges, links, entries: entries.length + drawnEnds, noRelation, unknown, structure };
}

/** The sub-issue count a box shows: GitHub's own count when the item carries it, else what the graph holds. */
export function boxProgress(model: GraphModel, key: string): { completed: number; total: number } | null {
  const n = model.nodes.get(key)!;
  if (n.item?.subIssues) return n.item.subIssues;
  const subs = n.item?.relations?.subIssues;
  if (subs?.length) return { total: subs.length, completed: subs.filter((s) => s.state === 'closed').length };
  return null;
}

/**
 * GitHub#429: a node's state colour and words — the same rule as the board card and the table
 * (`stateTone` / `badgeText`), with every input the node carries (a PR's draft mark included).
 * The one place the graph asks; GraphView and its minimap go through it.
 */
export function nodeTone(n: GraphNode): StateTone {
  return stateTone(n.kind, n.state, n.stateReason, n.isDraft);
}
export function nodeBadge(n: GraphNode): string {
  return badgeText(n.kind, n.state, n.stateReason, n.isDraft);
}

/** GitHub#483: one linked pull request as the graph's summary lists it */
export interface SummaryPr {
  key: string;
  number: number;
  url: string;
  state: ItemState;
  /** the PR as the sources hold it (title, draft mark, labels); null = in no ticked source: only GitHub's link is known */
  item: Item | null;
  /** github = GitHub's "Linked pull requests"; body = only the PR's description names the issue */
  via: 'github' | 'body';
  /** the state's colour and words: the same rule as the board card, the table and the graph's nodes */
  tone: StateTone;
  badge: string;
}

/**
 * GitHub#483: the pull requests the summary of an issue node lists — exactly the table's "linked PRs"
 * column (`issuePrLinks`, same order, same state), each with its item from `all` when a source holds it.
 * null = not known (a repository source does not carry GitHub's links and no PR here names the issue),
 * never "none" (that is an empty list). Only issues in a source have one: what GitHub said about an
 * end outside the sources carries no links, and a PR node has none of its own.
 */
export function summaryPrs(n: GraphNode, all: Item[]): SummaryPr[] | null {
  if (n.kind !== 'issue' || n.item === null) return null;
  const links = issuePrLinks(n.item, all);
  if (links === null) return null;
  const byKey = new Map(all.map((i) => [i.key, i]));
  return links.map((l) => {
    const pr = byKey.get(l.key);
    const item = pr && pr.kind === 'pr' ? pr : null;
    const draft = item ? item.isDraft : null;
    return { key: l.key, number: l.number, url: l.url, state: l.state, item, via: l.via, tone: stateTone('pr', l.state, null, draft), badge: badgeText('pr', l.state, null, draft) };
  });
}
