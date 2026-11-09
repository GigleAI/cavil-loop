// The table layout: filtered items -> optional repository slices -> (with
// "all repositories" picked: one section per repository, GitHub#213) -> groups
// -> sorted rows, sub-issues indented under their parent. Pure (callers pass
// `today`), shared by the renderer and the tests.

import type { GroupBy, Item, Iteration, ProjectMeta, TableSettings } from '../shared/types';
import type { GroupPreset } from '../shared/actions';
import { isCurrentIteration } from '../shared/filter';
import { iterationColumnKey } from './board';
import { itemSorter } from './sort';
import { listHosts, nestPrs, orderUnits, prFollow, PR_ORDER, unitUpdated } from './prNest';

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
  /** the group's value: what a new issue from its "+" carries (GitHub#214) */
  preset: GroupPreset;
  rows: Row[];
}

export interface Slice {
  value: string;
  count: number;
}

/** One repository's part of the table when "all repositories" is picked (GitHub#213) */
export interface RepoSection {
  /** `repo:<lower-cased owner/name>`; also the prefix of its groups' keys */
  key: string;
  title: string;
  /** distinct items of this repository — an item shown in two groups counts once */
  itemCount: number;
  groups: Group[];
}

export interface Table {
  /** every group, in display order; with `repos` set, the repositories' groups one after another */
  groups: Group[];
  /** per repository, then its groups; null = no repository layer (slicing off, one repository picked, or grouped by repository) */
  repos: RepoSection[] | null;
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
  preset: GroupPreset;
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

/** Sorts after every value's order (they all start with '1' or '2'). */
const NONE_LAST = '9';

/** Which groups one item lands in. Iteration / status belong to each Project: two Projects that disagree give two rows. */
function groupsOf(item: Item, by: GroupBy, projects: Map<string, ProjectMeta>, today: string, seeds: Map<string, Seed>): string[] {
  const seed = (s: Omit<Seed, 'items'>) => {
    if (!seeds.has(s.key)) seeds.set(s.key, { ...s, items: [] });
    return s.key;
  };
  // the group without a value goes after every group with one, as on the web Project's table (GitHub#231)
  const none = () => seed({ key: GROUP_NONE_KEY, title: NONE_TITLE[by as Exclude<GroupBy, 'none'>], subtitle: null, current: false, empty: true, order: NONE_LAST, preset: { by: 'none' } });
  if (by === 'repo')
    return [seed({ key: `repo:${item.repo.toLowerCase()}`, title: item.repo, subtitle: null, current: false, empty: false, order: `1${item.repo.toLowerCase()}`, preset: { by: 'repo', repo: item.repo } })];
  if (by === 'milestone') {
    if (!item.milestone) return [none()];
    const due = item.milestone.dueOn ?? '';
    const key = `milestone:${item.milestone.title}`;
    const order = due ? `1${due}` : '2';
    const cur = seeds.get(key);
    if (cur && order < cur.order) cur.order = order;
    return [seed({ key, title: item.milestone.title, subtitle: due ? `截止 ${due.slice(0, 10)}` : null, current: false, empty: false, order, preset: { by: 'milestone', title: item.milestone.title } })];
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
            preset: { by: 'iteration', title: m.iteration.title, startDate: m.iteration.startDate },
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
      keys.add(seed({ key: `status:${m.status}`, title: m.status, subtitle: null, current: false, empty: false, order: `1${String(idx < 0 ? 9999 : idx).padStart(4, '0')}${m.status}`, preset: { by: 'status', status: m.status } }));
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
function arrange(
  items: Item[],
  groupKey: string,
  sortSetting: TableSettings['sort'],
  sort: (a: Item, b: Item) => number,
  hierarchy: boolean,
  prs: boolean,
  follow: Map<string, string> | undefined,
): Row[] {
  const sorted = [...items].sort(sort);
  if (!hierarchy) {
    if (!prs) return sorted.map((item) => ({ id: `${item.key}@${groupKey}`, item, depth: 0, under: null }));
    return nestPrs(sorted, (it) => it, sortSetting, follow).map(({ entry, under }) => ({ id: `${entry.key}@${groupKey}`, item: entry, depth: under ? 1 : 0, under }));
  }
  const here = new Map(sorted.map((it) => [it.key, it]));
  const hosts = prs ? listHosts(sorted, follow) : new Map<string, string>();
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
    slices = [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => compareRepo(a.value, b.value));
    if (settings.slice) {
      slice = settings.slice;
      picked = items.filter((it) => it.repo.toLowerCase() === settings.slice!.toLowerCase());
    }
  }

  const sort = itemSorter(settings.sort, projects, items);
  const byKey = new Map(projects.map((p) => [p.key, p]));
  // GitHub#275: a PR goes to the group(s) of the issue it is shown under, never by its own value then.
  // An issue on none of the selected Projects (iteration / status grouping) does not pull its PRs into "no value".
  const boardGrouping = settings.groupBy === 'iteration' || settings.groupBy === 'status';
  const follow = prsUnderIssues
    ? prFollow([...picked].sort(sort), (it) => !boardGrouping || it.projects.some((m) => byKey.has(m.projectKey)))
    : new Map<string, string>();
  const pickedByKey = new Map(picked.map((it) => [it.key, it]));
  /** whose value decides where an item goes: its own, or the issue it follows */
  const placedBy = (it: Item) => pickedByKey.get(follow.get(it.key) ?? '') ?? it;
  const group = (list: Item[], prefix: string) => groupItems(list, prefix, settings, byKey, today, sort, prsUnderIssues, follow, placedBy);

  // "all repositories" picked in the slice list: repository first, then the chosen grouping inside it (GitHub#213)
  if (settings.sliceByRepo && !settings.slice && settings.groupBy !== 'repo') {
    const byRepo = new Map<string, { title: string; items: Item[] }>();
    for (const it of picked) {
      // a PR from another repository follows its issue into the issue's repository (as on the board's swimlanes)
      const home = placedBy(it).repo;
      const k = repoKey(home);
      const cur = byRepo.get(k);
      if (cur) cur.items.push(it);
      else byRepo.set(k, { title: home, items: [it] });
    }
    const repos = [...byRepo]
      .sort(([a], [b]) => compareRepo(a, b))
      .map(([key, r]) => ({ key, title: r.title, itemCount: r.items.length, groups: group(r.items, `${key}|`) }));
    return { groups: repos.flatMap((r) => r.groups), repos, slices, slice, itemCount: picked.length };
  }
  return { groups: group(picked, ''), repos: null, slices, slice, itemCount: picked.length };
}

const repoKey = (repo: string) => `repo:${repo.toLowerCase()}`;
/** the slice list's order: case-insensitive, alphabetical */
const compareRepo = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());

/** Group `items` by the table's grouping and arrange each group; `prefix` keeps group keys apart across repositories. */
function groupItems(
  items: Item[],
  prefix: string,
  settings: TableSettings,
  byKey: Map<string, ProjectMeta>,
  today: string,
  sort: (a: Item, b: Item) => number,
  prs: boolean,
  follow: Map<string, string>,
  placedBy: (it: Item) => Item,
): Group[] {
  if (settings.groupBy === 'none') {
    const key = `${prefix}all`;
    return [{ key, title: '全部', subtitle: null, current: false, empty: false, preset: { by: 'none' }, rows: arrange(items, key, settings.sort, sort, settings.hierarchy, prs, follow) }];
  }
  const seeds = new Map<string, Seed>();
  for (const it of items) for (const g of groupsOf(placedBy(it), settings.groupBy, byKey, today, seeds)) seeds.get(g)!.items.push(it);
  return [...seeds.values()]
    .filter((s) => s.items.length > 0)
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.key < b.key ? -1 : 1))
    .map((s) => {
      const key = `${prefix}${s.key}`;
      return { key, title: s.title, subtitle: s.subtitle, current: s.current, empty: s.empty, preset: s.preset, rows: arrange(s.items, key, settings.sort, sort, settings.hierarchy, prs, follow) };
    });
}

/** One block of a list of groups as drawn (GitHub#275): a group, or two or more folded groups next to each other shown as one line. */
export type GroupRun = { kind: 'group'; group: Group } | { kind: 'folded'; groups: Group[]; key: string };

/**
 * Consecutive folded groups (in display order) as one run (GitHub#275). An
 * unfolded group breaks a run; a single folded group stays a group. Callers
 * pass one repository's groups at a time, so a run never crosses repositories,
 * and only groups that are shown: one emptied by a filter is not in the list
 * and does not break a run. Display only — what is folded is not changed.
 */
export function foldRuns(groups: Group[], folded: ReadonlySet<string>): GroupRun[] {
  const out: GroupRun[] = [];
  let run: Group[] = [];
  const flush = () => {
    if (run.length === 1) out.push({ kind: 'group', group: run[0] });
    else if (run.length > 1) out.push({ kind: 'folded', groups: run, key: `folded:${run[0].key}` });
    run = [];
  };
  for (const g of groups) {
    if (folded.has(g.key)) run.push(g);
    else {
      flush();
      out.push({ kind: 'group', group: g });
    }
  }
  flush();
  return out;
}
