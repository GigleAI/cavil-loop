// The table layout: filtered items -> optional repository slices -> groups ->
// sorted rows, sub-issues indented under their parent. Pure (callers pass
// `today`), shared by the renderer and the tests.

import type { GroupBy, Item, Iteration, ProjectMeta, TableSettings } from '../shared/types';
import { isCurrentIteration } from '../shared/filter';
import { iterationColumnKey } from './board';
import { itemSorter } from './sort';
import { nestPrs, orderUnits, prHosts, PR_ORDER, unitUpdated } from './prNest';

export const GROUP_NONE_KEY = 'none';

export interface Row {
  /** unique within the table: item key + group key */
  id: string;
  item: Item;
  /** 0 = top level; 1 = a sub-issue shown under its parent, or a PR under its issue; … */
  depth: number;
  /** a PR shown right under the issue it is linked to: that issue's key (GitHub#155); null otherwise */
  under: string | null;
}

export interface Group {
  key: string;
  title: string;
  /** e.g. an iteration's date range; null = nothing to add */
  subtitle: string | null;
  /** the iteration `today` falls in */
  current: boolean;
  /** "no value" group (No iteration / No status / …) */
  empty: boolean;
  rows: Row[];
}

export interface Slice {
  value: string;
  count: number;
}

export interface Table {
  groups: Group[];
  /** per repository, over the filtered items; null when slicing is off */
  slices: Slice[] | null;
  /** the slice actually applied (a picked repository that has no items left is still applied, showing nothing) */
  slice: string | null;
  /** distinct items shown */
  itemCount: number;
}

interface Seed {
  key: string;
  title: string;
  subtitle: string | null;
  current: boolean;
  empty: boolean;
  /** smaller first */
  order: string;
  items: Item[];
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "Nov 3 – Nov 9" style range in the user's terms: 11/03 – 11/09 */
export function iterationRange(it: Iteration): string {
  const end = addDays(it.startDate, it.duration - 1);
  return `${it.startDate.slice(5).replace('-', '/')} – ${end.slice(5).replace('-', '/')}`;
}

const NONE_TITLE: Record<Exclude<GroupBy, 'none'>, string> = {
  iteration: '无迭代',
  status: '无状态',
  milestone: '无里程碑',
  repo: '无仓库',
};

/** Which groups one item lands in. Iteration / status belong to each Project: two Projects that disagree give two rows. */
function groupsOf(item: Item, by: GroupBy, projects: Map<string, ProjectMeta>, today: string, seeds: Map<string, Seed>): string[] {
  const seed = (s: Omit<Seed, 'items'>) => {
    if (!seeds.has(s.key)) seeds.set(s.key, { ...s, items: [] });
    return s.key;
  };
  const none = () => seed({ key: GROUP_NONE_KEY, title: NONE_TITLE[by as Exclude<GroupBy, 'none'>], subtitle: null, current: false, empty: true, order: '' });
  if (by === 'repo') return [seed({ key: `repo:${item.repo.toLowerCase()}`, title: item.repo, subtitle: null, current: false, empty: false, order: `1${item.repo.toLowerCase()}` })];
  if (by === 'milestone') {
    if (!item.milestone) return [none()];
    const due = item.milestone.dueOn ?? '';
    const key = `milestone:${item.milestone.title}`;
    const order = due ? `1${due}` : '2';
    const cur = seeds.get(key);
    if (cur && order < cur.order) cur.order = order;
    return [seed({ key, title: item.milestone.title, subtitle: due ? `截止 ${due.slice(0, 10)}` : null, current: false, empty: false, order })];
  }
  const members = item.projects.filter((m) => projects.has(m.projectKey));
  const keys = new Set<string>();
  if (by === 'iteration') {
    for (const m of members) {
      if (!m.iteration) keys.add(none());
      else
        keys.add(
          seed({
            key: iterationColumnKey(m.iteration),
            title: m.iteration.title,
            subtitle: iterationRange(m.iteration),
            current: isCurrentIteration(m.iteration, today),
            empty: false,
            order: `1${m.iteration.startDate}`,
          }),
        );
    }
  } else {
    for (const m of members) {
      if (!m.status) {
        keys.add(none());
        continue;
      }
      // option order of the first Project that has it; unknown options after
      let idx = -1;
      for (const p of projects.values()) {
        const i = p.statusOptions.indexOf(m.status);
        if (i >= 0) {
          idx = i;
          break;
        }
      }
      keys.add(seed({ key: `status:${m.status}`, title: m.status, subtitle: null, current: false, empty: false, order: `1${String(idx < 0 ? 9999 : idx).padStart(4, '0')}${m.status}` }));
    }
  }
  if (keys.size === 0) keys.add(none());
  return [...keys];
}


/**
 * Order rows of one group. With `hierarchy`, a sub-issue whose parent is in
 * the same group goes right under it; with `prs`, a PR goes right under the
 * issue it is linked to (GitHub#155, the same rule as the board's columns),
 * before that issue's sub-issues.
 */
function arrange(items: Item[], groupKey: string, sortSetting: TableSettings['sort'], sort: (a: Item, b: Item) => number, hierarchy: boolean, prs: boolean): Row[] {
  const sorted = [...items].sort(sort);
  if (!hierarchy) {
    if (!prs) return sorted.map((item) => ({ id: `${item.key}@${groupKey}`, item, depth: 0, under: null }));
    return nestPrs(sorted, (it) => it, sortSetting).map(({ entry, under }) => ({ id: `${entry.key}@${groupKey}`, item: entry, depth: under ? 1 : 0, under }));
  }
  const here = new Map(sorted.map((it) => [it.key, it]));
  const hosts = prs ? prHosts(sorted) : new Map<string, string>();
  // parent inside this group, and no cycle on the way up
  const parentOf = (it: Item): string | null => {
    if (!it.parent || it.parent === it.key || !here.has(it.parent)) return null;
    const seen = new Set([it.key]);
    for (let p: string | null = it.parent; p; p = here.get(p)?.parent ?? null) {
      if (seen.has(p)) return null;
      seen.add(p);
      if (!here.has(p)) break;
    }
    return it.parent;
  };
  const children = new Map<string, Item[]>();
  const guests = new Map<string, Item[]>();
  const top: Item[] = [];
  for (const it of sorted) {
    const h = hosts.get(it.key);
    const p = parentOf(it);
    if (h) guests.set(h, [...(guests.get(h) ?? []), it]);
    else if (p) children.set(p, [...(children.get(p) ?? []), it]);
    else top.push(it);
  }
  for (const g of guests.values()) g.sort(PR_ORDER);
  // under "updated", an issue moves with its PRs (the latest of them decides)
  const place = (list: Item[]) => orderUnits(list, (it) => unitUpdated(it, guests.get(it.key) ?? []), sortSetting);
  const out: Row[] = [];
  const walk = (it: Item, depth: number) => {
    out.push({ id: `${it.key}@${groupKey}`, item: it, depth, under: null });
    for (const pr of guests.get(it.key) ?? []) out.push({ id: `${pr.key}@${groupKey}`, item: pr, depth: depth + 1, under: it.key });
    for (const c of place(children.get(it.key) ?? [])) walk(c, depth + 1);
  };
  for (const it of place(top)) walk(it, 0);
  return out;
}

export function buildTable(
  items: Item[],
  projects: ProjectMeta[],
  settings: TableSettings,
  today: string,
  /** PRs right under the issue they are linked to (GitHub#155) */
  prsUnderIssues = false,
): Table {
  let slices: Slice[] | null = null;
  let slice: string | null = null;
  let picked = items;
  if (settings.sliceByRepo) {
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.repo, (counts.get(it.repo) ?? 0) + 1);
    slices = [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.toLowerCase().localeCompare(b.value.toLowerCase()));
    if (settings.slice) {
      slice = settings.slice;
      picked = items.filter((it) => it.repo.toLowerCase() === settings.slice!.toLowerCase());
    }
  }

  const sort = itemSorter(settings.sort, projects, items);

  if (settings.groupBy === 'none') {
    return {
      groups: [{ key: 'all', title: '全部', subtitle: null, current: false, empty: false, rows: arrange(picked, 'all', settings.sort, sort, settings.hierarchy, prsUnderIssues) }],
      slices,
      slice,
      itemCount: picked.length,
    };
  }
  const byKey = new Map(projects.map((p) => [p.key, p]));
  const seeds = new Map<string, Seed>();
  for (const it of picked) for (const g of groupsOf(it, settings.groupBy, byKey, today, seeds)) seeds.get(g)!.items.push(it);
  const groups = [...seeds.values()]
    .filter((s) => s.items.length > 0)
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.key < b.key ? -1 : 1))
    .map((s) => ({ key: s.key, title: s.title, subtitle: s.subtitle, current: s.current, empty: s.empty, rows: arrange(s.items, s.key, settings.sort, sort, settings.hierarchy, prsUnderIssues) }));
  return { groups, slices, slice, itemCount: picked.length };
}
