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

// GitHub#468: the numbers are a table set in Settings (shared/tallies.ts). A "跟随流程标签" row counts
// exactly as above (isPending, click through `tallyQuery`); a "自己写条件" row counts through its own
// search text and the board's filter, with the same context the board uses (viewer, today, projects),
// and a click puts that same text in the box. With the table never changed the bar is what it was.
// GitHub#464: every number has its own "显示已关闭" switch (keyed by the row's id); a query row counts what
// its click lists with that switch off — open items only, unless its condition names the state itself.

import type { HandBackLabels, Item, TallyColor, TallyDef } from '../shared/types';
import type { FilterContext } from '../shared/filter';
import { isPending } from './pending';
import { applyFilter, openOnly, parseFilter, statesStated } from '../shared/filter';
import type { Layout, ShowClosedKey } from '../shared/types';
import { DEFAULT_TALLIES, UNLABELED_QUERY, defaultTallies } from '../shared/tallies';

export { UNLABELED_QUERY };

/** a row's id ('running' / 'agent' / 'human' / 'unlabeled' for the default rows) */
export type TallyKind = string;

export interface TallyEntry {
  /** the row's id — the default rows keep the names the view bar always used */
  kind: TallyKind;
  /** the name shown */
  name: string;
  color: TallyColor;
  /** which kind of row: follows a flow label, or a search condition of its own */
  source: 'flow' | 'query';
  /** a flow row: the label as set in Settings (trimmed); '' for a query row */
  label: string;
  /** the items it picks */
  count: number;
  /** what the search box becomes on a click; null = this label cannot be written in the search syntax */
  query: string | null;
}

/** the default rows' names (kept for callers that name a default number) */
export const TALLY_TEXT: Record<'running' | 'agent' | 'human' | 'unlabeled', string> = Object.fromEntries(DEFAULT_TALLIES.map((d) => [d.id, d.name])) as Record<
  'running' | 'agent' | 'human' | 'unlabeled',
  string
>;

const NO_CONTEXT: FilterContext = { viewer: null, today: '', projects: [] };

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
 * GitHub#468: the numbers of a table, in its order. A row is left out when its name is empty, when it
 * follows a flow label that is empty ("运行中的标签" left empty = not shown, GitHub#404), or when its own
 * condition is empty (that would be "every item", not a number).
 */
export function tallyEntries(items: Item[], defs: readonly TallyDef[], labels: Pick<HandBackLabels, 'running' | 'agent' | 'human'>, ctx: FilterContext = NO_CONTEXT): TallyEntry[] {
  const out: TallyEntry[] = [];
  for (const d of defs) {
    const name = d.name.trim();
    if (name === '') continue;
    if (d.source.kind === 'flow') {
      const label = labels[d.source.flow].trim();
      if (label === '') continue;
      out.push({ kind: d.id, name, color: d.color, source: 'flow', label, count: items.filter((it) => isPending(it, label)).length, query: tallyQuery(label) });
    } else {
      const q = d.source.query.trim();
      if (q === '') continue;
      // GitHub#464: what a click lists while that number's "显示已关闭" switch is off (the default): open items
      // only, unless the condition itself says open / closed / merged — the same rule BoardView applies
      const parsed = parseFilter(q);
      const pool = statesStated(parsed) ? items : openOnly(items);
      out.push({ kind: d.id, name, color: d.color, source: 'query', label: '', count: applyFilter(pool, parsed, ctx).length, query: q });
    }
  }
  return out;
}

/**
 * The default table's numbers ("未处理" last). "运行中" is left out when its label is empty (Settings: empty = not
 * shown); the other two always have a label — saving them empty puts the default back.
 */
export function flowTally(items: Item[], labels: Pick<HandBackLabels, 'running' | 'agent' | 'human'>): TallyEntry[] {
  return tallyEntries(items, defaultTallies(), labels);
}

/**
 * GitHub#418: "未处理" — the default table's last row. Counted through the real filter with its own click query
 * (no context is needed: `is` and `no:label` read nothing but the item), so a click lists exactly the
 * counted items. Items come merged by key (`mergeSnapshots`), so one carried by two sources counts once.
 */
export function unlabeledTally(items: Item[]): TallyEntry {
  return tallyEntries(items, defaultTallies().filter((d) => d.id === 'unlabeled'), { running: '', agent: '', human: '' })[0];
}

/** Which number the search box is showing right now (its text is exactly that number's query), if any. */
export function litTally(query: string, entries: TallyEntry[]): TallyKind | null {
  // two rows with the same click text: the first one is lit
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
  if (lit === null) return layout;
  // a number's id never takes a layout's switch (ids made in Settings are `t-…`; this only guards a hand-edited one)
  return (['board', 'table', 'graph'] as string[]).includes(lit) ? `tally:${lit}` : lit;
}
