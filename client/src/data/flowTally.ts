// GitHub#404: the view bar's "运行中 / 等 agent / 等人处理" — how many open issues / PRs of the ticked
// sources carry each flow label, whatever the search box says.
//
// Counting goes through `isPending` (open + carries the label, case-insensitive): the very rule the
// reminders and the Dock badge use, so "等人处理 5" and the pending reminders cannot disagree.
//
// GitHub#418: a fourth number, "未处理" — open items of the ticked sources carrying no label at all. Its
// click query is the fixed `no:label`, and the count goes through that very query's filter
// (`applyFilter`) over the open items (`openOnly`, the rule the "显示已关闭" switch applies while off),
// so the number and the list a click shows are one rule, not two.
//
// A number can be clicked: the search box becomes `label:"<label>"` (the same items, through the
// ordinary filter; a label the filter cannot carry is shown but not clickable), and clicking the lit number again puts back what the box said before.
// GitHub#464: the click queries no longer carry `is:open` — whether closed items are listed too is the
// lit number's own "显示已关闭" switch (`showClosedKey`), off by default, so the default list is still
// exactly the counted items.

import type { HandBackLabels, Item } from '../shared/types';
import { isPending } from './pending';
import { applyFilter, openOnly, parseFilter } from '../shared/filter';
import type { Layout, ShowClosedKey } from '../shared/types';

export type TallyKind = 'running' | 'agent' | 'human' | 'unlabeled';

export interface TallyEntry {
  kind: TallyKind;
  /** the label as set in Settings (trimmed); '' for "unlabeled", which counts items with no label */
  label: string;
  /** open items carrying it */
  count: number;
  /** what the search box becomes on a click; null = this label cannot be written in the search syntax */
  query: string | null;
}

export const TALLY_TEXT: Record<TallyKind, string> = { running: '运行中', agent: '等 agent', human: '等人处理', unlabeled: '未处理' };

/** GitHub#418: the "未处理" number's search — no label at all (open only while its switch is off, GitHub#464) */
export const UNLABELED_QUERY = 'no:label';

/**
 * `label:"<label>"`, or null for a label the search syntax cannot carry. Decided by the real
 * parser, not by guessing which characters are safe: the query must read back as exactly
 * this one whole label, nothing ignored — a double quote breaks the quoting, and a leading `<` / `>`
 * is a comparison the filter drops (PR #408 review round 1: the number said 1, the click showed every
 * open item).
 */
export function tallyQuery(label: string): string | null {
  const l = label.trim();
  if (l === '' || l.includes('"')) return null;
  const q = `label:"${l}"`;
  const { clauses, unsupported } = parseFilter(q);
  const [lab] = clauses;
  const ok =
    unsupported.length === 0 &&
    clauses.length === 1 &&
    lab.kind === 'field' && lab.field === 'label' && !lab.negated && lab.values.length === 1 && lab.values[0] === l;
  return ok ? q : null;
}

/**
 * The numbers, in display order ("未处理" last). "运行中" is left out when its label is empty (Settings: empty = not
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
    .map((e): TallyEntry => ({ ...e, count: items.filter((it) => isPending(it, e.label)).length, query: tallyQuery(e.label) }))
    .concat(unlabeledTally(items));
}

/**
 * GitHub#418: "未处理" — always shown, last. Counted through the real filter with its own click query
 * (no context is needed: `is` and `no:label` read nothing but the item), so a click lists exactly the
 * counted items. Items come merged by key (`mergeSnapshots`), so one carried by two sources counts once.
 */
export function unlabeledTally(items: Item[]): TallyEntry {
  const count = applyFilter(openOnly(items), parseFilter(UNLABELED_QUERY), { viewer: null, today: '', projects: [] }).length;
  return { kind: 'unlabeled', label: '', count, query: UNLABELED_QUERY };
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

/**
 * GitHub#464: which "显示已关闭" switch is in effect — the lit number's own while one is lit (whatever
 * the layout), else the layout's. The view bar's switch and the list both ask this, nothing else.
 */
export function showClosedKey(layout: Layout, lit: TallyKind | null): ShowClosedKey {
  return lit ?? layout;
}
