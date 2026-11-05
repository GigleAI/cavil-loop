// Item order for one sort setting, shared by the table and the board so an
// imported "newest first" means the same thing in both layouts. Pure.

import type { Item, Iteration, ProjectMeta, SortField, TableSettings } from '../shared/types';

function firstIteration(item: Item): Iteration | null {
  return item.projects.find((m) => m.iteration)?.iteration ?? null;
}

/** Ascending comparator for one sort field; ties are left to the stable sort (input order). */
function comparator(field: SortField, projects: ProjectMeta[], index: Map<string, number>): (a: Item, b: Item) => number {
  const cmp = (x: string | number, y: string | number) => (x < y ? -1 : x > y ? 1 : 0);
  switch (field) {
    case 'manual':
      return (a, b) => cmp(index.get(a.key) ?? 0, index.get(b.key) ?? 0);
    case 'updated':
      return (a, b) => cmp(a.updatedAt, b.updatedAt);
    case 'title':
      return (a, b) => a.title.localeCompare(b.title);
    case 'number':
      return (a, b) => cmp(a.number, b.number);
    case 'repo':
      return (a, b) => cmp(a.repo.toLowerCase(), b.repo.toLowerCase());
    case 'iteration':
      // no value sorts after every value, whatever the direction (as on the web)
      return (a, b) => cmp(firstIteration(a)?.startDate ?? '￿', firstIteration(b)?.startDate ?? '￿');
    case 'milestone':
      return (a, b) => cmp(a.milestone ? a.milestone.dueOn ?? '￾' : '￿', b.milestone ? b.milestone.dueOn ?? '￾' : '￿');
    case 'status': {
      const rank = (it: Item) => {
        const s = it.projects.find((m) => m.status)?.status;
        if (!s) return 99999;
        for (const p of projects) {
          const i = p.statusOptions.indexOf(s);
          if (i >= 0) return i;
        }
        return 9999;
      };
      return (a, b) => cmp(rank(a), rank(b));
    }
  }
}

/** Descending order, except that "no value" stays last for the fields that have one. */
function directional(a: Item, b: Item, asc: (a: Item, b: Item) => number, field: SortField): number {
  const missing = (it: Item) =>
    (field === 'iteration' && !firstIteration(it)) || (field === 'milestone' && !it.milestone) || (field === 'status' && !it.projects.some((m) => m.status));
  const ma = missing(a);
  const mb = missing(b);
  if (ma !== mb) return ma ? 1 : -1;
  return -asc(a, b);
}

/**
 * Comparator for a sort setting. `items` gives the read order, which is
 * GitHub's own order of the Project ("manual"); ties keep that order too
 * (Array.prototype.sort is stable).
 */
export function itemSorter(sort: TableSettings['sort'], projects: ProjectMeta[], items: Item[]): (a: Item, b: Item) => number {
  const index = new Map(items.map((it, i) => [it.key, i]));
  const asc = comparator(sort.field, projects, index);
  return sort.dir === 'desc' && sort.field !== 'manual' ? (a, b) => directional(a, b, asc, sort.field) : asc;
}
