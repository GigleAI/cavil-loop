// Turn merged items into board columns. Pure: no Node, no Electron, no clock
// (callers pass `today`), so the renderer and the tests run the same code.

import type { ColumnMode, Item, Iteration, ProjectMeta, TableSettings } from '../shared/types';
import type { WriteAction } from '../shared/actions';
import { itemSorter } from './sort';
import { nestPrs, prFollow } from './prNest';
import { repoComparator } from '../shared/repoOrder';

export const COL_UNBOARDED = 'unboarded';
export const COL_NO_ITERATION = 'iteration:none';
export const COL_NO_STATUS = 'status:none';
export const COL_NO_MILESTONE = 'milestone:none';

export interface Card {
  /** unique within the board: item key + column key */
  id: string;
  item: Item;
  /** titles of the Projects whose value put the card in this column (empty for milestone / unboarded) */
  projectTitles: string[];
  /** keys of those Projects (what a drag changes: only these Projects' values) */
  projectKeys: string[];
  /** repository = swimlane (a PR shown under its issue follows the issue's lane) */
  lane: string;
  /** a PR shown right under the issue it is linked to: that issue's key (GitHub#155); null = top level */
  under: string | null;
}

export interface Column {
  key: string;
  title: string;
  /** extra line under the title, e.g. which Project an unmerged iteration belongs to */
  subtitle: string | null;
  /** iteration columns only: the iteration is over (folded into one group by the UI) */
  ended: boolean;
  cards: Card[];
}

export interface Board {
  /** the mode actually used (iteration falls back to status) */
  mode: ColumnMode;
  notice: string | null;
  columns: Column[];
  /** repositories, in the saved repository order (GitHub#304), when swimlanes are on; null otherwise */
  lanes: string[] | null;
}

export const NOTICE_NO_ITERATION_FIELD = '所选 Project 都没有迭代字段，已改按状态分列';

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function iterationEnded(it: Iteration, today: string): boolean {
  return addDays(it.startDate, it.duration) <= today;
}

/** Iterations of different Projects merge into one column only when title AND start date match. */
export function iterationColumnKey(it: Iteration): string {
  return `iteration:${it.title}\u0000${it.startDate}`;
}

interface ColumnSeed {
  key: string;
  title: string;
  sort: string;
  rank: number;
  ended: boolean;
  projects: Set<string>;
}

/** repository, then newest number first: the order when no sort is given */
const BY_REPO_NUMBER = (a: Item, b: Item) => (a.repo === b.repo ? b.number - a.number : a.repo < b.repo ? -1 : 1);

/** One column's cards in the view's order; with `nest`, every PR right under its linked issue. */
function arrangeCards(cards: Card[], order: (a: Item, b: Item) => number, nest: Nest): Card[] {
  const sorted = cards.sort((a, b) => order(a.item, b.item));
  if (!nest.on) return sorted;
  const lanes = new Map(sorted.map((c) => [c.item.key, c.lane]));
  return nestPrs(sorted, (c) => c.item, nest.sort, nest.follow).map(({ entry, under }) =>
    under ? { ...entry, under, lane: lanes.get(under) ?? entry.lane } : entry,
  );
}

interface Nest {
  on: boolean;
  sort: TableSettings['sort'] | undefined;
  /** PR key -> the issue whose column(s) it is shown in (GitHub#275) */
  follow?: Map<string, string>;
}

/**
 * GitHub#275: a PR whose issue is on the board is shown in the issue's
 * column(s), under it, and nowhere else — whatever the PR's own value. A card
 * moved there keeps what a drag changes when the PR's own value also put it in
 * that column; otherwise a drag changes the PR on every selected Project it is
 * on. Returns PR key -> issue key for the PRs moved.
 */
function followIssues(
  items: Item[],
  order: (a: Item, b: Item) => number,
  placements: Map<string, Card[]>,
  canHost: (issue: Item) => boolean,
  selectedProjects: Map<string, ProjectMeta>,
  mode: ColumnMode,
): Map<string, string> {
  const follow = prFollow([...items].sort(order), canHost);
  if (follow.size === 0) return follow;
  const hostCols = new Map<string, string[]>();
  const own = new Map<string, Card>();
  for (const [col, cards] of placements) {
    for (const c of cards) {
      hostCols.set(c.item.key, [...(hostCols.get(c.item.key) ?? []), col]);
      if (follow.has(c.item.key)) own.set(`${c.item.key}@${col}`, c);
    }
  }
  for (const [col, cards] of placements) placements.set(col, cards.filter((c) => !follow.has(c.item.key)));
  const byKey = new Map(items.map((it) => [it.key, it]));
  for (const [prKey, host] of follow) {
    const pr = byKey.get(prKey)!;
    for (const col of hostCols.get(host) ?? []) {
      const mine = own.get(`${prKey}@${col}`);
      placements.get(col)!.push(mine ?? { id: `${prKey}@${col}`, item: pr, ...dragScope(pr, col, mode, selectedProjects, true), lane: pr.repo, under: null });
    }
  }
  return follow;
}

function finish(
  seeds: Map<string, ColumnSeed>,
  placements: Map<string, Card[]>,
  order: (a: Item, b: Item) => number,
  subtitleFor: (s: ColumnSeed) => string | null,
  nest: Nest,
): Column[] {
  return [...seeds.values()]
    .sort((a, b) => a.rank - b.rank || (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0) || (a.key < b.key ? -1 : 1))
    .map((s) => ({
      key: s.key,
      title: s.title,
      subtitle: subtitleFor(s),
      ended: s.ended,
      cards: arrangeCards(placements.get(s.key) ?? [], order, nest),
    }));
}

function place(placements: Map<string, Card[]>, col: string, item: Item, projectTitles: string[], projectKeys: string[] = []) {
  const list = placements.get(col) ?? [];
  list.push({ id: `${item.key}@${col}`, item, projectTitles, projectKeys, lane: item.repo, under: null });
  placements.set(col, list);
}

/** The column one Project membership puts an item in (iteration / status columns; the table's groups use the same keys). */
export function memberColumn(m: Item['projects'][number], p: ProjectMeta, mode: 'iteration' | 'status'): string {
  if (mode === 'iteration') return !p.hasIterationField || !m.iteration ? COL_NO_ITERATION : iterationColumnKey(m.iteration);
  return m.status ? `status:${m.status}` : COL_NO_STATUS;
}

/**
 * What a drag of `item`, shown in column `col`, changes: the selected Projects
 * whose own value put it there (GitHub#294: one rule for the board's cards and
 * the table's rows). `following` = a PR shown there only because its issue is
 * (GitHub#275): when none of its own values put it there either, a drag changes
 * it on every selected Project it is on. Milestones belong to the repository:
 * no Project is involved.
 */
export function dragScope(
  item: Item,
  col: string,
  mode: ColumnMode,
  selectedProjects: Map<string, ProjectMeta>,
  following: boolean,
): { projectKeys: string[]; projectTitles: string[] } {
  if (mode === 'milestone') return { projectKeys: [], projectTitles: [] };
  const members = item.projects.filter((m) => selectedProjects.has(m.projectKey));
  const own = members.filter((m) => memberColumn(m, selectedProjects.get(m.projectKey)!, mode) === col);
  if (own.length || !following) return { projectKeys: own.map((m) => m.projectKey), projectTitles: own.map((m) => m.projectTitle) };
  return { projectKeys: members.map((m) => m.projectKey), projectTitles: [] };
}

/**
 * Group the item's memberships (in selected Projects) by column; one card per
 * distinct column. An item whose two Projects disagree shows up in both
 * columns, labelled with the Project; agreeing Projects give a single card.
 */
function placeByMembership(
  item: Item,
  selectedProjects: Map<string, ProjectMeta>,
  columnOf: (m: Item['projects'][number], p: ProjectMeta) => string,
  placements: Map<string, Card[]>,
  seeds: Map<string, ColumnSeed>,
  mode: 'iteration' | 'status',
) {
  const memberships = item.projects.filter((m) => selectedProjects.has(m.projectKey));
  if (memberships.length === 0) {
    place(placements, COL_UNBOARDED, item, []);
    return;
  }
  const cols = new Set<string>();
  for (const m of memberships) {
    const col = columnOf(m, selectedProjects.get(m.projectKey)!);
    cols.add(col);
    if (!seeds.has(col)) throw new Error(`internal: column ${col} has no seed`);
  }
  for (const col of cols) {
    const { projectTitles, projectKeys } = dragScope(item, col, mode, selectedProjects, false);
    place(placements, col, item, projectTitles, projectKeys);
  }
}

const RANK_REGULAR = 1;
const RANK_UNBOARDED = 8;
const RANK_NONE = 9;

export function buildBoard(
  items: Item[],
  projects: ProjectMeta[],
  requested: ColumnMode,
  swimlanes: boolean,
  today: string,
  /** card order inside every column (the view's sort, shared with the table); none = repository, then number */
  sort?: TableSettings['sort'],
  /** PRs right under the issue they are linked to, in the same column (GitHub#155) */
  prsUnderIssues = false,
  /** the saved repository order (GitHub#304): the swimlanes' order; empty = alphabetical */
  repoOrder: readonly string[] = [],
): Board {
  const cardOrder = sort ? itemSorter(sort, projects, items) : BY_REPO_NUMBER;
  const nest: Nest = { on: prsUnderIssues, sort };
  let mode = requested;
  let notice: string | null = null;
  if (mode === 'iteration' && !projects.some((p) => p.hasIterationField)) {
    mode = 'status';
    notice = NOTICE_NO_ITERATION_FIELD;
  }
  const selectedProjects = new Map(projects.map((p) => [p.key, p]));
  const seeds = new Map<string, ColumnSeed>();
  const placements = new Map<string, Card[]>();
  const seed = (s: Omit<ColumnSeed, 'projects'>, project?: string) => {
    const cur = seeds.get(s.key) ?? { ...s, projects: new Set<string>() };
    if (project) cur.projects.add(project);
    seeds.set(s.key, cur);
  };
  // columns that stand without a card (filled just before the items are placed)
  let standing = new Set<string>();
  const onBoard = (it: Item) => it.projects.some((m) => selectedProjects.has(m.projectKey));
  const settle = (canHost: (issue: Item) => boolean) => {
    if (nest.on) nest.follow = followIssues(items, cardOrder, placements, canHost, selectedProjects, mode);
  };
  const hasUnboarded = items.some((it) => !it.projects.some((m) => selectedProjects.has(m.projectKey)));
  if (mode !== 'milestone' && hasUnboarded) {
    seed({ key: COL_UNBOARDED, title: '未加入看板', sort: '', rank: RANK_UNBOARDED, ended: false });
  }

  let columns: Column[];
  if (mode === 'iteration') {
    // Every not-yet-ended iteration gets a column even when empty (as on the
    // web board); ended ones only when a card sits in them.
    for (const p of projects) {
      for (const it of p.iterations) {
        if (!iterationEnded(it, today)) {
          seed({ key: iterationColumnKey(it), title: it.title, sort: it.startDate, rank: RANK_REGULAR, ended: false }, p.title);
        }
      }
    }
    seed({ key: COL_NO_ITERATION, title: '无迭代', sort: '', rank: RANK_NONE, ended: false });
    standing = new Set(seeds.keys());
    for (const item of items) {
      placeByMembership(
        item,
        selectedProjects,
        (m, p) => {
          const key = memberColumn(m, p, 'iteration');
          if (key === COL_NO_ITERATION || !m.iteration) return key;
          seed(
            {
              key,
              title: m.iteration.title,
              sort: m.iteration.startDate,
              rank: RANK_REGULAR,
              ended: iterationEnded(m.iteration, today),
            },
            p.title,
          );
          return key;
        },
        placements,
        seeds,
        'iteration',
      );
    }
    // A title shared by columns that did NOT merge (different start dates)
    // gets the Project names underneath so the two can be told apart.
    const titleCount = new Map<string, number>();
    for (const s of seeds.values()) if (s.rank === RANK_REGULAR) titleCount.set(s.title, (titleCount.get(s.title) ?? 0) + 1);
    settle(onBoard);
    columns = finish(seeds, placements, cardOrder, (s) => {
      if (s.rank !== RANK_REGULAR) return null;
      const range = `${s.sort} 起`;
      return (titleCount.get(s.title) ?? 0) > 1 ? `${range} · ${[...s.projects].join('、')}` : range;
    }, nest);
  } else if (mode === 'status') {
    let order = 0;
    for (const p of projects) {
      for (const o of p.statusOptions) {
        const key = `status:${o}`;
        if (!seeds.has(key)) seed({ key, title: o, sort: String(order++).padStart(6, '0'), rank: RANK_REGULAR, ended: false }, p.title);
        else seed({ key, title: o, sort: '', rank: RANK_REGULAR, ended: false }, p.title);
      }
    }
    seed({ key: COL_NO_STATUS, title: '无状态', sort: '', rank: RANK_NONE, ended: false });
    standing = new Set(seeds.keys());
    for (const item of items) {
      placeByMembership(
        item,
        selectedProjects,
        (m, p) => {
          const key = memberColumn(m, p, 'status');
          if (key === COL_NO_STATUS || !m.status) return key;
          if (!seeds.has(key)) seed({ key, title: m.status, sort: String(order++).padStart(6, '0'), rank: RANK_REGULAR, ended: false });
          return key;
        },
        placements,
        seeds,
        'status',
      );
    }
    settle(onBoard);
    columns = finish(seeds, placements, cardOrder, () => null, nest);
  } else {
    // Milestones belong to repositories: same title across repositories = one column.
    seed({ key: COL_NO_MILESTONE, title: '无里程碑', sort: '', rank: RANK_NONE, ended: false });
    standing = new Set(seeds.keys());
    for (const item of items) {
      if (!item.milestone) {
        place(placements, COL_NO_MILESTONE, item, []);
        continue;
      }
      const key = `milestone:${item.milestone.title}`;
      const due = item.milestone.dueOn ?? '';
      // earliest due date among the merged milestones decides the order; no due date sorts after dated ones
      const sort = due ? `0${due}` : '1';
      const cur = seeds.get(key);
      if (!cur) seed({ key, title: item.milestone.title, sort, rank: RANK_REGULAR, ended: false });
      else if (sort < cur.sort) cur.sort = sort;
      place(placements, key, item, []);
    }
    // milestones belong to the repository, not to a board: any issue takes its PRs along
    settle(() => true);
    columns = finish(seeds, placements, cardOrder, (s) => {
      if (s.rank !== RANK_REGULAR) return null;
      return s.sort.startsWith('0') ? `截止 ${s.sort.slice(1, 11)}` : '无截止日期';
    }, nest);
  }
  // keep the "none" columns only when they hold something; a column that only
  // appeared for a card (an ended iteration, a milestone, an unknown status) goes
  // when that card followed its issue elsewhere (GitHub#275)
  columns = columns.filter(
    (c) => c.cards.length > 0 || (standing.has(c.key) && ![COL_NO_ITERATION, COL_NO_STATUS, COL_NO_MILESTONE, COL_UNBOARDED].includes(c.key)),
  );
  const lanes = swimlanes ? [...new Set(columns.flatMap((c) => c.cards.map((x) => x.lane)))].sort(repoComparator(repoOrder)) : null;
  return { mode, notice, columns, lanes };
}

/** Writes are only possible while GitHub is reachable: offline, every change entry is grey and nothing is queued. */
export function writesEnabled(sync: { offline: boolean }): boolean {
  return !sync.offline;
}

/** What dropping a card on a column means. */
export type DropPlan =
  | { kind: 'none' }
  | { kind: 'refuse'; reason: string }
  | { kind: 'do'; actions: WriteAction[]; summary: string }
  /** an item on none of the selected Projects: ask "add it to Project X and set …?" first */
  | { kind: 'confirm'; question: string; choices: { projectKey: string; projectTitle: string; action: WriteAction }[] };

function iterationOfColumn(key: string): { title: string; startDate: string } | null {
  if (!key.startsWith('iteration:') || key === COL_NO_ITERATION) return null;
  const [title, startDate] = key.slice('iteration:'.length).split('\u0000');
  return { title, startDate };
}

/**
 * Drag & drop, decided without touching anything. A card changes only the
 * Projects it sits in that column for (one value per Project, with that
 * Project's own iteration / option). Milestones belong to the repository: the
 * item's repository's milestone with the column's title (checked when sent).
 */
export function dropPlan(card: Pick<Card, 'item' | 'projectKeys' | 'projectTitles'>, from: string, to: Pick<Column, 'key'>, mode: ColumnMode, projects: ProjectMeta[]): DropPlan {
  if (from === to.key) return { kind: 'none' };
  const it = card.item;
  const meta = (k: string) => projects.find((p) => p.key === k);
  if (to.key === COL_UNBOARDED) return { kind: 'refuse', reason: '客户端不把条目移出看板；要移出请在网页上操作' };

  if (mode === 'milestone') {
    if (to.key === COL_NO_MILESTONE) return { kind: 'do', actions: [{ kind: 'setMilestone', key: it.key, title: null }], summary: `去掉 ${it.repo}#${it.number} 的里程碑` };
    const title = to.key.slice('milestone:'.length);
    return { kind: 'do', actions: [{ kind: 'setMilestone', key: it.key, title }], summary: `把 ${it.repo}#${it.number} 的里程碑改成「${title}」` };
  }

  const iteration = mode === 'iteration' ? iterationOfColumn(to.key) : null;
  const clear = to.key === COL_NO_ITERATION || to.key === COL_NO_STATUS;
  const status = mode === 'status' && !clear ? to.key.slice('status:'.length) : null;
  const pickIteration = (p: ProjectMeta) => (iteration ? p.iterations.find((x) => x.title === iteration.title && x.startDate === iteration.startDate) : undefined);
  const has = (p: ProjectMeta) => (mode === 'iteration' ? Boolean(pickIteration(p)) : p.statusOptions.includes(status ?? ''));
  const what = mode === 'iteration' ? `迭代「${iteration?.title ?? ''}」` : `状态「${status ?? ''}」`;

  if (card.projectKeys.length === 0) {
    if (clear) return { kind: 'refuse', reason: '这一条不在所选看板上，没有可清空的值' };
    const candidates = projects.filter((p) => has(p));
    if (!candidates.length) return { kind: 'refuse', reason: `所选看板里没有${what}` };
    const writable = candidates.filter((p) => p.viewerCanUpdate);
    if (!writable.length) return { kind: 'refuse', reason: `你在看板${candidates.map((p) => `「${p.title}」`).join('、')}上没有修改权限` };
    return {
      kind: 'confirm',
      question: `${it.repo}#${it.number} 还没加入看板。加入看板${writable.length === 1 ? `「${writable[0].title}」` : ''}并设为${what}？`,
      choices: writable.map((p) => ({
        projectKey: p.key,
        projectTitle: p.title,
        action: { kind: 'addToProject', key: it.key, projectKey: p.key, iterationId: pickIteration(p)?.id ?? null, status: mode === 'status' ? status : null },
      })),
    };
  }

  const actions: WriteAction[] = [];
  for (const k of card.projectKeys) {
    const p = meta(k);
    if (!p) return { kind: 'refuse', reason: '这张卡所在的看板不在当前来源里，请刷新' };
    if (!p.viewerCanUpdate) return { kind: 'refuse', reason: `你在看板「${p.title}」上没有修改权限（GitHub 说这个账号不能改它）` };
    if (!clear && !has(p)) return { kind: 'refuse', reason: `看板「${p.title}」没有${what}` };
    if (mode === 'iteration') actions.push({ kind: 'setIteration', key: it.key, projectKey: k, iterationId: clear ? null : pickIteration(p)!.id });
    else actions.push({ kind: 'setStatus', key: it.key, projectKey: k, status: clear ? null : status });
  }
  const where = card.projectTitles.map((t) => `「${t}」`).join('、');
  return { kind: 'do', actions, summary: clear ? `清空 ${it.repo}#${it.number} 在看板${where}上的${mode === 'iteration' ? '迭代' : '状态'}` : `把 ${it.repo}#${it.number} 在看板${where}上改成${what}` };
}
