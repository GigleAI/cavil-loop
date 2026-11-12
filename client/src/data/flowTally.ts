// GitHub#404: the view bar's "运行中 / 等 agent / 等人处理" — how many open issues / PRs of the ticked
// sources carry each flow label, whatever the search box says.
//
// Counting goes through `isPending` (open + carries the label, case-insensitive): the very rule the
// reminders and the Dock badge use, so "等人处理 5" and the pending reminders cannot disagree.
// A number can be clicked: the search box becomes `is:open label:"<label>"` (the same items, through
// the ordinary filter), and clicking the lit number again puts back what the box said before.

import type { HandBackLabels, Item } from '../shared/types';
import { isPending } from './pending';

export type TallyKind = 'running' | 'agent' | 'human';

export interface TallyEntry {
  kind: TallyKind;
  /** the label as set in Settings (trimmed) */
  label: string;
  /** open items carrying it */
  count: number;
  /** what the search box becomes on a click; null = this label cannot be written in the search syntax */
  query: string | null;
}

export const TALLY_TEXT: Record<TallyKind, string> = { running: '运行中', agent: '等 agent', human: '等人处理' };

/** `is:open label:"<label>"`, or null for a label the search syntax cannot carry (a double quote in it). */
export function tallyQuery(label: string): string | null {
  const l = label.trim();
  if (l === '' || l.includes('"')) return null;
  return `is:open label:"${l}"`;
}

/**
 * The numbers, in display order. "运行中" is left out when its label is empty (Settings: empty = not
 * shown); the other two always have a label — saving them empty puts the default back.
 */
export function flowTally(items: Item[], labels: Pick<HandBackLabels, 'running' | 'agent' | 'human'>): TallyEntry[] {
  const order: [TallyKind, string][] = [
    ['running', labels.running],
    ['agent', labels.agent],
    ['human', labels.human],
  ];
  return order
    .map(([kind, raw]) => ({ kind, label: raw.trim() }))
    .filter((e) => e.label !== '')
    .map((e) => ({ ...e, count: items.filter((it) => isPending(it, e.label)).length, query: tallyQuery(e.label) }));
}

/** Which number the search box is showing right now (its text is exactly that number's query), if any. */
export function litTally(query: string, entries: TallyEntry[]): TallyKind | null {
  const q = query.trim();
  return entries.find((e) => e.query !== null && e.query === q)?.kind ?? null;
}

/**
 * A click on one number. `saved` is the search text from before the first number was clicked
 * (null = none). Rules:
 *  - the clicked number is lit → back to `saved` (empty when there is none), and `saved` is used up;
 *  - another number is lit → switch to the clicked one, `saved` stays as it was;
 *  - none is lit → remember the box as it is, then switch.
 */
export function tallyClick(current: string, saved: string | null, target: TallyEntry, entries: TallyEntry[]): { query: string; saved: string | null } {
  if (target.query === null) return { query: current, saved };
  const lit = litTally(current, entries);
  if (lit === target.kind) return { query: saved ?? '', saved: null };
  if (lit !== null) return { query: target.query, saved };
  return { query: target.query, saved: current };
}

/** The box was changed some other way: once it no longer shows a number's query, the remembered text is void. */
export function tallyForget(saved: string | null, current: string, entries: TallyEntry[]): string | null {
  return litTally(current, entries) === null ? null : saved;
}
