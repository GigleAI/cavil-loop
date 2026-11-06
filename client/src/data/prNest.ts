// "A pull request goes right under the issue it is linked to" (GitHub#155).
// One rule, used by the board's columns and the table's groups alike. Pure.
//
// The link is the issue's "Linked pull requests" (what GitHub lists in the
// issue's sidebar: pull requests that close it), as synced into
// `Item.linkedPrs`. A repository-only issue does not know its links (null):
// nothing is nested under it.
//
// Only within one list (a column, a group): a PR and its issue in different
// columns stay where they are. A PR linked to several issues of the list goes
// under the first of them only (never shown twice). Under the "updated" sort,
// an issue and its PRs move as one unit, placed by the latest update among
// them; under any other sort the unit sits where the issue sits.

import type { Item, TableSettings } from '../shared/types';

export interface Nested<T> {
  entry: T;
  /** key of the issue this PR is shown under; null = top level */
  under: string | null;
}

/** PR key -> the issue (of `items`, in that order) it goes under. */
export function prHosts(items: Item[]): Map<string, string> {
  const here = new Set(items.map((i) => i.key));
  const hosts = new Map<string, string>();
  for (const it of items) {
    if (it.kind !== 'issue' || !it.linkedPrs) continue;
    for (const l of it.linkedPrs) {
      if (l.key === it.key || !here.has(l.key) || hosts.has(l.key)) continue;
      hosts.set(l.key, it.key);
    }
  }
  // only real PRs of the list: a key that is an issue here is never moved
  for (const it of items) if (it.kind !== 'pr') hosts.delete(it.key);
  return hosts;
}

/** Latest update of a unit: the item and the PRs shown under it. */
export function unitUpdated(item: Item, under: Item[]): string {
  return under.reduce((m, p) => (p.updatedAt > m ? p.updatedAt : m), item.updatedAt);
}

/** PRs under one issue: newest first. */
export const PR_ORDER = (a: Item, b: Item) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);

/**
 * Re-order units under the "updated" sort by their latest update (stable:
 * equal times keep the incoming order). Any other sort: unchanged.
 */
export function orderUnits<U>(units: U[], time: (u: U) => string, sort: TableSettings['sort'] | undefined): U[] {
  if (sort?.field !== 'updated') return units;
  const sign = sort.dir === 'asc' ? 1 : -1;
  return units
    .map((u, i) => ({ u, i, t: time(u) }))
    .sort((a, b) => (a.t < b.t ? -sign : a.t > b.t ? sign : a.i - b.i))
    .map((x) => x.u);
}

/**
 * One list (already in the view's order) with every PR moved right under the
 * issue it is linked to.
 */
export function nestPrs<T>(entries: T[], itemOf: (t: T) => Item, sort: TableSettings['sort'] | undefined): Nested<T>[] {
  const hosts = prHosts(entries.map(itemOf));
  if (hosts.size === 0) return entries.map((entry) => ({ entry, under: null }));
  const guests = new Map<string, T[]>();
  for (const e of entries) {
    const h = hosts.get(itemOf(e).key);
    if (h) guests.set(h, [...(guests.get(h) ?? []), e]);
  }
  const units = entries
    .filter((e) => !hosts.has(itemOf(e).key))
    .map((head) => ({ head, prs: [...(guests.get(itemOf(head).key) ?? [])].sort((a, b) => PR_ORDER(itemOf(a), itemOf(b))) }));
  const ordered = orderUnits(units, (u) => unitUpdated(itemOf(u.head), u.prs.map(itemOf)), sort);
  return ordered.flatMap((u) => [
    { entry: u.head, under: null },
    ...u.prs.map((entry) => ({ entry, under: itemOf(u.head).key })),
  ]);
}
