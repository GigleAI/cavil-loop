// The table layout: filtered items -> optional repository slices -> (with
// "all repositories" picked: one section per repository, GitHub#213) -> groups
// -> sorted rows, sub-issues indented under their parent. Pure (callers pass
// `today`), shared by the renderer and the tests.
//
// GitHub#368: with "show hierarchy" on, the search no longer cuts a matched
// issue off from its sub-issues. After each group is laid out, the sub-issues
// (and theirs) of the rows already in it are added as "pulled" rows when they
// did not match the search, walking down from those rows only: a sub-issue
// that matched, or that the picked repository leaves out, ends the walk. So a
// pulled row's parent row is always right there in the same group. Which
// parent links count (`validParents`) is one rule, used for the walk and for
// the indenting alike.

import type { ColumnMode, GroupBy, Item, Iteration, ProjectMeta, TableSettings } from '../shared/types';
import type { GroupPreset } from '../shared/actions';
import { isCurrentIteration } from '../shared/filter';
import { COL_NO_ITERATION, COL_NO_MILESTONE, COL_NO_STATUS, dragScope, dropPlan, iterationColumnKey, type DropPlan } from './board';
import { itemSorter } from './sort';
import { repoComparator } from '../shared/repoOrder';
import { t, tKey, zhKey } from '../shared/i18n';
import { listHosts, nestPrs, orderUnits, prFollow, PR_ORDER, unitUpdated } from './prNest';

export const GROUP_NONE_KEY = 'none';

export interface Row {
  /** unique within the table: item key + group key */
  id: string;
  item: Item;
  /** 0 = top level; 1 = a sub-issue shown under its parent, or a PR under its issue; … */
  depth: number;
  /** did not match the search; shown only because an issue above it in this group did (GitHub#368) */
  pulled: boolean;
  /** a PR shown right under the issue it is linked to: that issue's key (GitHub#155); null otherwise */
  under: string | null;
  /** what dragging this row to another group changes: the same as the board card in that column (GitHub#294) */
  projectKeys: string[];
  projectTitles: string[];
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
  /** the board column with the same value: where a row dropped here goes (GitHub#294); null = rows cannot be dropped here (repository / no grouping) */
  column: string | null;
  /** the repository section it sits in ("all repositories"); null = no repository layer */
  section: string | null;
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
  /** distinct items shown in this repository's groups (pulled rows included) — an item shown in two groups counts once */
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
  /** distinct items picked (matched and in the picked repository); pulled rows not included */
  itemCount: number;
  /** items that matched the search, before the repository slice: what the view bar's "显示 N / M 条" says (GitHub#368) */
  matchCount: number;
  /** distinct items shown as pulled rows anywhere in the table (GitHub#368) */
  pulledCount: number;
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
  iteration: zhKey('无迭代'),
  status: zhKey('无状态'),
  milestone: zhKey('无里程碑'),
  repo: zhKey('无仓库'),
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
  const none = () => seed({ key: GROUP_NONE_KEY, title: NONE_TITLE[by as Exclude<GroupBy, 'none'>], subtitle: null, current: false, empty: true, order: NONE_LAST, preset: { by: 'none', field: by as Exclude<GroupBy, 'none' | 'repo'> } });
  if (by === 'repo')
    return [seed({ key: `repo:${item.repo.toLowerCase()}`, title: item.repo, subtitle: null, current: false, empty: false, order: `1${item.repo.toLowerCase()}`, preset: { by: 'repo', repo: item.repo } })];
  if (by === 'milestone') {
    if (!item.milestone) return [none()];
    const due = item.milestone.dueOn ?? '';
    const key = `milestone:${item.milestone.title}`;
    const order = due ? `1${due}` : '2';
    const cur = seeds.get(key);
    if (cur && order < cur.order) cur.order = order;
    return [seed({ key, title: item.milestone.title, subtitle: due ? t('截止 {date}', { date: due.slice(0, 10) }) : null, current: false, empty: false, order, preset: { by: 'milestone', title: item.milestone.title } })];
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
  parents: Map<string, string>,
  pulled: ReadonlySet<string>,
): Row[] {
  const sorted = [...items].sort(sort);
  const row = (item: Item, depth: number, under: string | null): Row => ({ id: `${item.key}@${groupKey}`, item, depth, under, pulled: pulled.has(item.key), projectKeys: [], projectTitles: [] });
  if (!hierarchy) {
    if (!prs) return sorted.map((item) => row(item, 0, null));
    return nestPrs(sorted, (it) => it, sortSetting, follow).map(({ entry, under }) => row(entry, under ? 1 : 0, under));
  }
  const here = new Map(sorted.map((it) => [it.key, it]));
  const hosts = prs ? listHosts(sorted, follow) : new Map<string, string>();
  // a parent link that counts (`validParents`: never a cycle), whose parent is in this group
  const parentOf = (it: Item): string | null => {
    const p = parents.get(it.key);
    return p !== undefined && here.has(p) ? p : null;
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
    out.push(row(it, depth, null));
    for (const pr of guests.get(it.key) ?? []) out.push(row(pr, depth + 1, it.key));
    for (const c of place(children.get(it.key) ?? [])) walk(c, depth + 1);
  };
  for (const it of place(top)) walk(it, 0);
  return out;
}

/**
 * GitHub#368: the parent link of each item that counts, as `child key -> parent key`. A link
 * counts when the parent is not the item itself, is among `universe` (the items the sources
 * hold), and walking up from it never comes back to the item (a link on a cycle — which GitHub
 * itself does not allow, only a damaged cache could hold one — counts for nobody on the cycle).
 * The one rule for both the indenting and the pulling of sub-issues.
 */
export function validParents(universe: readonly Item[]): Map<string, string> {
  const raw = new Map(universe.map((it) => [it.key, it.parent]));
  const out = new Map<string, string>();
  for (const it of universe) {
    const p = it.parent;
    if (!p || p === it.key || !raw.has(p)) continue;
    let onCycle = false;
    let cur: string | null | undefined = p;
    for (let n = 0; cur && n <= raw.size; n++) {
      if (cur === it.key) {
        onCycle = true;
        break;
      }
      cur = raw.get(cur);
    }
    if (!onCycle) out.set(it.key, p);
  }
  return out;
}

/** What laying out one group needs to add pulled rows (GitHub#368); null = no pulled rows. */
interface Pull {
  /** parent key -> its sub-issues in the sources, by the links that count */
  children: Map<string, Item[]>;
  /** keys of the items that matched the search */
  matched: ReadonlySet<string>;
  /** the picked repository (lower-cased); null = every repository */
  slice: string | null;
}

/** A group's items plus the pulled ones: walking down from the items already in it, stopping at a matched or sliced-away sub-issue. */
function withPulled(list: Item[], pull: Pull | null): { items: Item[]; pulled: Set<string> } {
  const pulled = new Set<string>();
  if (!pull) return { items: list, pulled };
  const inGroup = new Set(list.map((it) => it.key));
  const out = [...list];
  for (let i = 0; i < out.length; i++) {
    for (const c of pull.children.get(out[i].key) ?? []) {
      if (inGroup.has(c.key) || pull.matched.has(c.key)) continue;
      if (pull.slice !== null && c.repo.toLowerCase() !== pull.slice) continue;
      inGroup.add(c.key);
      pulled.add(c.key);
      out.push(c);
    }
  }
  return { items: out, pulled };
}

export function buildTable(
  items: Item[],
  projects: ProjectMeta[],
  settings: TableSettings,
  today: string,
  /** PRs right under the issue they are linked to (GitHub#155) */
  prsUnderIssues = false,
  /** the saved repository order (GitHub#304): slices, sections and "group by repository" go by it; empty = alphabetical */
  repoOrder: readonly string[] = [],
  /**
   * every item the sources hold, `items` being the ones the search matched (GitHub#368): with
   * "show hierarchy" on, sub-issues that did not match are pulled in under the rows above them.
   * Left out (older callers), `items` is all there is and nothing is pulled.
   */
  all: readonly Item[] = items,
): Table {
  const compareRepo = repoComparator(repoOrder);
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

  const sort = itemSorter(settings.sort, projects, [...all]);
  const parents = validParents(all);
  let pull: Pull | null = null;
  if (settings.hierarchy && all !== items) {
    const byKey = new Map(all.map((it) => [it.key, it]));
    const children = new Map<string, Item[]>();
    for (const [child, parent] of parents) {
      const c = byKey.get(child);
      if (c && c.kind === 'issue') children.set(parent, [...(children.get(parent) ?? []), c]);
    }
    pull = { children, matched: new Set(items.map((it) => it.key)), slice: slice === null ? null : slice.toLowerCase() };
  }
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
  const group = (list: Item[], prefix: string, section: string | null) => groupItems(list, prefix, section, settings, byKey, today, sort, prsUnderIssues, follow, placedBy, compareRepo, parents, pull);
  /** distinct items shown as pulled rows in these groups */
  const pulledIn = (gs: Group[]) => new Set(gs.flatMap((g) => g.rows.filter((r) => r.pulled).map((r) => r.item.key))).size;

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
      .sort(([, a], [, b]) => compareRepo(a.title, b.title))
      .map(([key, r]) => {
        const groups = group(r.items, `${key}|`, key);
        return { key, title: r.title, itemCount: r.items.length + pulledIn(groups), groups };
      });
    const groups = repos.flatMap((r) => r.groups);
    return { groups, repos, slices, slice, itemCount: picked.length, matchCount: items.length, pulledCount: pulledIn(groups) };
  }
  const groups = group(picked, '', null);
  return { groups, repos: null, slices, slice, itemCount: picked.length, matchCount: items.length, pulledCount: pulledIn(groups) };
}

const repoKey = (repo: string) => `repo:${repo.toLowerCase()}`;

/** Group `items` by the table's grouping and arrange each group; `prefix` keeps group keys apart across repositories. */
function groupItems(
  items: Item[],
  prefix: string,
  section: string | null,
  settings: TableSettings,
  byKey: Map<string, ProjectMeta>,
  today: string,
  sort: (a: Item, b: Item) => number,
  prs: boolean,
  follow: Map<string, string>,
  placedBy: (it: Item) => Item,
  compareRepo: (a: string, b: string) => number,
  parents: Map<string, string>,
  pull: Pull | null,
): Group[] {
  const lay = (list: Item[], key: string) => {
    const w = withPulled(list, pull);
    return arrange(w.items, key, settings.sort, sort, settings.hierarchy, prs, follow, parents, w.pulled);
  };
  if (settings.groupBy === 'none') {
    const key = `${prefix}all`;
    return [{ key, title: zhKey('全部'), subtitle: null, current: false, empty: false, preset: { by: 'none' }, column: null, section, rows: lay(items, key) }];
  }
  const mode = boardMode(settings.groupBy);
  // GitHub#294: each row carries what a drag changes, by the board's own rule for that column
  const scoped = (rows: Row[], column: string | null): Row[] =>
    !mode || !column ? rows : rows.map((r) => ({ ...r, ...dragScope(r.item, column, mode, byKey, placedBy(r.item) !== r.item) }));
  const seeds = new Map<string, Seed>();
  for (const it of items) for (const g of groupsOf(placedBy(it), settings.groupBy, byKey, today, seeds)) seeds.get(g)!.items.push(it);
  return [...seeds.values()]
    .filter((s) => s.items.length > 0)
    // grouped by repository: the saved repository order (GitHub#304); every other grouping by its own order
    .sort(settings.groupBy === 'repo' ? (a, b) => compareRepo(a.title, b.title) : (a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.key < b.key ? -1 : 1))
    .map((s) => {
      const key = `${prefix}${s.key}`;
      const column = groupColumn(settings.groupBy, s.key);
      return { key, title: s.title, subtitle: s.subtitle, current: s.current, empty: s.empty, preset: s.preset, column, section, rows: scoped(lay(s.items, key), column) };
    });
}

/** The board's column mode a grouping stands for; null = rows cannot be dragged between its groups (GitHub#294). */
export function boardMode(by: GroupBy): ColumnMode | null {
  return by === 'iteration' || by === 'status' || by === 'milestone' ? by : null;
}

/** A group's board column: the same key for a value, the board's "no value" column for the group without one. */
function groupColumn(by: GroupBy, seedKey: string): string | null {
  if (!boardMode(by)) return null;
  if (seedKey !== GROUP_NONE_KEY) return seedKey;
  return by === 'iteration' ? COL_NO_ITERATION : by === 'status' ? COL_NO_STATUS : COL_NO_MILESTONE;
}

export const REFUSE_OTHER_REPO = zhKey('只能拖到同一个仓库下的分组');

/** a group the client names itself ("全部", the group without a value): its title is a zhKey; every other title is GitHub's */
export function isOwnGroup(g: Pick<Group, 'preset'>): boolean {
  return g.preset.by === 'none';
}

/**
 * Dropping a table row on a group (GitHub#294): the board's drop rule, with
 * the row standing for the card and the groups for their columns. Nothing
 * when the grouping has no board column; refused across repository sections
 * (the row would not show up in the other repository's section).
 */
export function tableDropPlan(row: Row, from: Group, to: Group, by: GroupBy, projects: ProjectMeta[]): DropPlan {
  const mode = boardMode(by);
  if (!mode || !from.column || !to.column || from.key === to.key) return { kind: 'none' };
  if (from.section !== to.section) return { kind: 'refuse', reason: tKey(REFUSE_OTHER_REPO) };
  return dropPlan(row, from.column, { key: to.column }, mode, projects);
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
