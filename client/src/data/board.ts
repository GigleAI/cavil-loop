// Turn merged items into board columns. Pure: no Node, no Electron, no clock
// (callers pass `today`), so the renderer and the tests run the same code.

import type { ColumnMode, Item, Iteration, ProjectMeta } from '../shared/types';
import type { WriteAction } from '../shared/actions';

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
  /** repository = swimlane */
  lane: string;
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
  /** repositories, sorted, when swimlanes are on; null otherwise */
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

function finish(
  seeds: Map<string, ColumnSeed>,
  placements: Map<string, Card[]>,
  subtitleFor: (s: ColumnSeed) => string | null,
): Column[] {
  return [...seeds.values()]
    .sort((a, b) => a.rank - b.rank || (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0) || (a.key < b.key ? -1 : 1))
    .map((s) => ({
      key: s.key,
      title: s.title,
      subtitle: subtitleFor(s),
      ended: s.ended,
      cards: (placements.get(s.key) ?? []).sort((a, b) =>
        a.item.repo === b.item.repo ? b.item.number - a.item.number : a.item.repo < b.item.repo ? -1 : 1,
      ),
    }));
}

function place(placements: Map<string, Card[]>, col: string, item: Item, projectTitles: string[], projectKeys: string[] = []) {
  const list = placements.get(col) ?? [];
  list.push({ id: `${item.key}@${col}`, item, projectTitles, projectKeys, lane: item.repo });
  placements.set(col, list);
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
) {
  const memberships = item.projects.filter((m) => selectedProjects.has(m.projectKey));
  if (memberships.length === 0) {
    place(placements, COL_UNBOARDED, item, []);
    return;
  }
  const byCol = new Map<string, string[]>();
  const keysByCol = new Map<string, string[]>();
  for (const m of memberships) {
    const col = columnOf(m, selectedProjects.get(m.projectKey)!);
    const titles = byCol.get(col) ?? [];
    titles.push(m.projectTitle);
    byCol.set(col, titles);
    keysByCol.set(col, [...(keysByCol.get(col) ?? []), m.projectKey]);
    if (!seeds.has(col)) throw new Error(`internal: column ${col} has no seed`);
  }
  for (const [col, titles] of byCol) place(placements, col, item, titles, keysByCol.get(col));
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
): Board {
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
    for (const item of items) {
      placeByMembership(
        item,
        selectedProjects,
        (m, p) => {
          if (!p.hasIterationField || !m.iteration) return COL_NO_ITERATION;
          const key = iterationColumnKey(m.iteration);
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
      );
    }
    // A title shared by columns that did NOT merge (different start dates)
    // gets the Project names underneath so the two can be told apart.
    const titleCount = new Map<string, number>();
    for (const s of seeds.values()) if (s.rank === RANK_REGULAR) titleCount.set(s.title, (titleCount.get(s.title) ?? 0) + 1);
    columns = finish(seeds, placements, (s) => {
      if (s.rank !== RANK_REGULAR) return null;
      const range = `${s.sort} 起`;
      return (titleCount.get(s.title) ?? 0) > 1 ? `${range} · ${[...s.projects].join('、')}` : range;
    });
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
    for (const item of items) {
      placeByMembership(
        item,
        selectedProjects,
        (m) => {
          if (!m.status) return COL_NO_STATUS;
          const key = `status:${m.status}`;
          if (!seeds.has(key)) seed({ key, title: m.status, sort: String(order++).padStart(6, '0'), rank: RANK_REGULAR, ended: false });
          return key;
        },
        placements,
        seeds,
      );
    }
    columns = finish(seeds, placements, () => null);
  } else {
    // Milestones belong to repositories: same title across repositories = one column.
    seed({ key: COL_NO_MILESTONE, title: '无里程碑', sort: '', rank: RANK_NONE, ended: false });
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
    columns = finish(seeds, placements, (s) => {
      if (s.rank !== RANK_REGULAR) return null;
      return s.sort.startsWith('0') ? `截止 ${s.sort.slice(1, 11)}` : '无截止日期';
    });
  }
  // keep the "none" columns only when they hold something
  columns = columns.filter(
    (c) => c.cards.length > 0 || ![COL_NO_ITERATION, COL_NO_STATUS, COL_NO_MILESTONE, COL_UNBOARDED].includes(c.key),
  );
  const lanes = swimlanes ? [...new Set(items.map((i) => i.repo))].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())) : null;
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
export function dropPlan(card: Card, from: string, to: Column, mode: ColumnMode, projects: ProjectMeta[]): DropPlan {
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
