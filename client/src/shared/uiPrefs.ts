// Small per-machine preferences of the window (GitHub#231), each under its own setting key — not
// part of the view settings, so importing a Project's web view never touches them.
// Pure; shared by the controller (reads / writes the settings) and the renderer.

import type { GroupBy, NotifyScope } from './types';
import { GROUP_BYS } from './viewSettings';

/**
 * Which table groups are folded, kept apart per "group by" (folding "无迭代" while grouped by
 * iteration does not fold "无状态" under status). Each list is oldest first.
 */
export type TableFolds = Partial<Record<GroupBy, string[]>>;

/** At most this many folded groups are kept per "group by"; past that the oldest one is dropped. */
export const MAX_FOLDS_PER_GROUPING = 200;

/** Whatever was saved: keep each valid list (strings, no repeats, the newest 200), drop the rest. */
export function normalizeTableFolds(raw: unknown): TableFolds {
  const out: TableFolds = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [by, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!GROUP_BYS.includes(by as GroupBy) || !Array.isArray(list)) continue;
    const keys = [...new Set(list.filter((k): k is string => typeof k === 'string' && k !== ''))];
    if (keys.length) out[by as GroupBy] = keys.slice(-MAX_FOLDS_PER_GROUPING);
  }
  return out;
}

/** Fold (`folded` true) or unfold one group under `by`. A fold goes to the end (newest); unknown input changes nothing. */
export function setFold(folds: TableFolds, by: unknown, key: unknown, folded: unknown): TableFolds {
  if (!GROUP_BYS.includes(by as GroupBy) || typeof key !== 'string' || key === '' || typeof folded !== 'boolean') return folds;
  const g = by as GroupBy;
  const cur = folds[g] ?? [];
  if (!folded && !cur.includes(key)) return folds;
  const rest = cur.filter((k) => k !== key);
  const next = folded ? [...rest, key].slice(-MAX_FOLDS_PER_GROUPING) : rest;
  const out: TableFolds = { ...folds };
  if (next.length) out[g] = next;
  else delete out[g];
  return out;
}

/**
 * GitHub#297: which board swimlanes (one per repository, `owner/name` as shown) are folded to their
 * head line. Kept on this machine like the table folds, apart from them (folding a repository on the
 * board does not fold it in the table). Oldest first.
 */
export type LaneFolds = string[];

/** At most this many folded swimlanes are kept; past that the oldest one is dropped. */
export const MAX_LANE_FOLDS = 200;

/** Whatever was saved: strings, no repeats, the newest 200; anything else reads as "nothing folded". */
export function normalizeLaneFolds(raw: unknown): LaneFolds {
  if (!Array.isArray(raw)) return [];
  const keys = [...new Set(raw.filter((k): k is string => typeof k === 'string' && k !== ''))];
  return keys.slice(-MAX_LANE_FOLDS);
}

/** Fold (`folded` true) or unfold one swimlane. A fold goes to the end (newest); unknown input changes nothing. */
export function setLaneFold(folds: LaneFolds, lane: unknown, folded: unknown): LaneFolds {
  if (typeof lane !== 'string' || lane === '' || typeof folded !== 'boolean') return folds;
  if (!folded && !folds.includes(lane)) return folds;
  const rest = folds.filter((k) => k !== lane);
  return folded ? [...rest, lane].slice(-MAX_LANE_FOLDS) : rest;
}

/** "托管" asks first unless the user ticked "不再提示" (GitHub#231); anything but an explicit `false` asks. */
export function normalizeAutopilotConfirm(raw: unknown): boolean {
  return raw !== false;
}

/**
 * GitHub#369: switching to the window takes back every delivered notification only when the user
 * ticked it in Settings; anything but an explicit `true` keeps them (a click still takes back the one clicked).
 */
export function normalizeClearAllOnActivate(raw: unknown): boolean {
  return raw === true;
}

/**
 * GitHub#713: also remind of GitHub's own activity concerning the account. Anything but an explicit
 * `false` is on — a value this build cannot read must never make reminders fewer.
 */
export function normalizeGithubActivity(raw: unknown): boolean {
  return raw !== false;
}

/**
 * GitHub#713: opening an item marks its GitHub notification read. Anything but an explicit `true` is
 * off — the app writes to GitHub only when the user asked for it (the maintainer's choice on GitHub#713).
 */
export function normalizeGithubActivityMarkRead(raw: unknown): boolean {
  return raw === true;
}

/**
 * GitHub#373: which pending items remind. Anything but an explicit 'mine' is 'all' — a value this
 * build cannot read must never make reminders fewer.
 */
export function normalizeNotifyScope(raw: unknown): NotifyScope {
  return raw === 'mine' ? 'mine' : 'all';
}

/**
 * GitHub#689: the view bar's 「只看我的」 — one switch for the whole window (every layout, the lit number,
 * the view-bar numbers), kept on this machine under its own key like the folds above, so importing a
 * Project's web view or switching layouts never touches it. `author` = 我提出的, `assignee` = 指派给我;
 * GitHub#746: `authors` / `assignees` = other accounts picked in the panel (提出者 / 负责人). An item shows
 * when any one of these matches. At least one condition stays: a filter with nothing to match would list
 * nothing, and the way to stop narrowing is the switch itself.
 */
export interface MineFilter {
  on: boolean;
  author: boolean;
  assignee: boolean;
  /** GitHub#746: other accounts whose opened items show (logins as picked, in picking order) */
  authors: string[];
  /** GitHub#746: other accounts whose assigned items show */
  assignees: string[];
}

/** GitHub#746: how many accounts each of the two lists keeps (the panel and the button stay readable) */
export const MINE_PEOPLE_MAX = 20;

export const DEFAULT_MINE_FILTER: MineFilter = { on: false, author: true, assignee: true, authors: [], assignees: [] };

// a GitHub login (letters, digits, hyphens, at most 39), or an app's `name[bot]`
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

/**
 * GitHub#746: a saved or sent list of accounts, cleaned: only strings shaped like a login, one per account
 * (logins are not case-sensitive: the first spelling stays), at most MINE_PEOPLE_MAX. Anything but an array is
 * no one.
 */
export function minePeople(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !LOGIN.test(v)) continue;
    if (out.some((o) => o.toLowerCase() === v.toLowerCase())) continue;
    out.push(v);
    if (out.length === MINE_PEOPLE_MAX) break;
  }
  return out;
}

/** GitHub#746: how many conditions the filter holds (each box ticked, each account picked) */
export function mineConditions(f: MineFilter): number {
  return (f.author ? 1 : 0) + (f.assignee ? 1 : 0) + f.authors.length + f.assignees.length;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Whatever was saved: each field a boolean / a list or its default; nothing left to match reads as both boxes ticked. */
export function normalizeMineFilter(raw: unknown): MineFilter {
  const r = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const pick = (k: 'on' | 'author' | 'assignee') => (typeof r[k] === 'boolean' ? (r[k] as boolean) : DEFAULT_MINE_FILTER[k]);
  const out: MineFilter = { on: pick('on'), author: pick('author'), assignee: pick('assignee'), authors: minePeople(r.authors), assignees: minePeople(r.assignees) };
  if (mineConditions(out) === 0) return { ...out, author: true, assignee: true };
  return out;
}

/**
 * One change from the window. Boolean fields that are not booleans, and lists that are not arrays, are ignored;
 * a list is cleaned like a saved one. A change that would leave no condition is refused as a whole. Returns
 * `cur` itself when nothing changes.
 */
export function setMineFilter(cur: MineFilter, patch: unknown): MineFilter {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return cur;
  const p = patch as Record<string, unknown>;
  const next: MineFilter = { ...cur };
  for (const k of ['on', 'author', 'assignee'] as const) if (typeof p[k] === 'boolean') next[k] = p[k] as boolean;
  for (const k of ['authors', 'assignees'] as const) if (Array.isArray(p[k])) next[k] = minePeople(p[k]);
  if (mineConditions(next) === 0) return cur;
  const same = next.on === cur.on && next.author === cur.author && next.assignee === cur.assignee && sameList(next.authors, cur.authors) && sameList(next.assignees, cur.assignees);
  return same ? cur : next;
}
