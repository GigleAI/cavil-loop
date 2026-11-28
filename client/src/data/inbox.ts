// GitHub#752 — the table's 「收件箱」 and 「最近完成」: two flat lists at the top of its left column, newest
// update first. Pure (callers pass `now`), shared by the renderer and the tests.
//
// The rules (the design confirmed on GitHub#752):
//   - both lists hold only what concerns the account, by the conditions of the 「只看我的」 panel — the same
//     function the view bar's switch uses (`mineOnly`), whether that switch is on or not. No signed-in
//     account known: nothing is listed (unknown is not "every item", and not "nothing of mine");
//   - 收件箱 = the items carrying the pending label (each repository's own name, `isPending`, the rule the
//     reminders go by), open or closed, plus the items of GitHub's notification inbox that are unread there,
//     whose reason is one the reminders count (`REASONS`), that are in a data source and that were not opened
//     in the app since their last activity (the controller hands those threads over). One row per item;
//   - 最近完成 = issues closed as completed and merged pull requests, updated within the last N days (N set
//     on this machine, 7 by default). A closed issue whose close reason was not read is not counted as done:
//     it is only counted, so the list can say how many it leaves out;
//   - what the search box and 「显示稍后处理」 leave out stays out: callers pass the items after those.

import type { InboxThread, Item } from '../shared/types';
import type { MineFilter } from '../shared/uiPrefs';
import { mineOnly } from '../shared/filter';
import { isPending } from './pending';

/** The table's saved slice for each list. A repository's name always has a "/", these never do. */
export const SLICE_INBOX = '@inbox';
export const SLICE_DONE = '@done';

export type SpecialSlice = 'inbox' | 'done';

export function specialSlice(slice: string | null | undefined): SpecialSlice | null {
  return slice === SLICE_INBOX ? 'inbox' : slice === SLICE_DONE ? 'done' : null;
}

/** 「最近完成」's days: the default, and the range a typed number must be in. */
export const DONE_DAYS_DEFAULT = 7;
export const DONE_DAYS_MIN = 1;
export const DONE_DAYS_MAX = 365;
/** the choices offered next to 「自定义…」 */
export const DONE_DAYS_CHOICES: readonly number[] = [1, 3, 7, 14, 30];

/** A saved or sent number of days: a whole number in range, anything else is the default. */
export function normalizeDoneDays(raw: unknown): number {
  return validDoneDays(raw) ? raw : DONE_DAYS_DEFAULT;
}

export function validDoneDays(raw: unknown): raw is number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= DONE_DAYS_MIN && raw <= DONE_DAYS_MAX;
}

export type { InboxThread };

/** One row of a list: the item, and why it is in the inbox ('pending' = the label; else the notification's reason; null = 最近完成). */
export interface Listed {
  item: Item;
  why: 'pending' | string | null;
}

/** Newest update first; the same time by key, so a list never reorders between two renders. */
export function newestFirst<T extends { item: Item }>(a: T, b: T): number {
  if (a.item.updatedAt !== b.item.updatedAt) return a.item.updatedAt > b.item.updatedAt ? -1 : 1;
  return a.item.key < b.item.key ? -1 : a.item.key > b.item.key ? 1 : 0;
}

/** The 「只看我的」 panel's conditions, applied whether the switch is on or not; no account = nothing. */
export function mineScope(items: readonly Item[], pick: MineFilter, viewer: string | null): Item[] {
  if (viewer === null || viewer === '') return [];
  return mineOnly([...items], { ...pick, on: true }, viewer);
}

/**
 * 收件箱. `items`: what the search and the parked switch leave (open and closed); `threads`: the unread
 * notification threads still to be looked at; `pendingLabel`: the pending label of an item's repository.
 */
export function inboxList(
  items: readonly Item[],
  threads: readonly InboxThread[],
  pick: MineFilter,
  viewer: string | null,
  pendingLabel: (repo: string) => string,
): Listed[] {
  const why = new Map<string, string>();
  for (const th of threads) if (!why.has(th.key)) why.set(th.key, th.reason);
  const out: Listed[] = [];
  for (const it of mineScope(items, pick, viewer)) {
    if (isPending(it, pendingLabel(it.repo))) out.push({ item: it, why: 'pending' });
    else {
      const r = why.get(it.key);
      if (r) out.push({ item: it, why: r });
    }
  }
  return out.sort(newestFirst);
}

/** 最近完成, and how many closed issues in the same range were left out because their close reason is not known. */
export function doneList(items: readonly Item[], days: number, now: number, pick: MineFilter, viewer: string | null): { rows: Listed[]; unknown: number } {
  const since = now - normalizeDoneDays(days) * 86_400_000;
  const rows: Listed[] = [];
  let unknown = 0;
  for (const it of mineScope(items, pick, viewer)) {
    // an unreadable time is not "recent"
    if (!(Date.parse(it.updatedAt) >= since)) continue;
    if (it.kind === 'pr') {
      if (it.state === 'merged') rows.push({ item: it, why: null });
    } else if (it.state !== 'open') {
      if (it.stateReason === 'completed') rows.push({ item: it, why: null });
      else if (it.stateReason === null) unknown++;
    }
  }
  return { rows: rows.sort(newestFirst), unknown };
}
