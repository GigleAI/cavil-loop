// GitHub#404: the view bar's "运行中 / 等 agent / 等人处理" — how many issues / PRs of the ticked
// sources carry each flow label, whatever the search box says.
//
// "等人处理" counts through `isPending` (carries the label, open or closed — GitHub#462): the very rule
// the reminders and the Dock badge use, so "等人处理 5" and the pending reminders cannot disagree.
// "运行中" / "等 agent" count open items only: work in progress is open by definition.
//
// GitHub#418: a fourth number, "未处理" — open items of the ticked sources carrying no label at all. Its
// click query is the fixed `no:label`, and the count goes through that very query's filter
// (`applyFilter`) over the open items (`openOnly`, the rule the "显示已关闭" switch applies while off),
// so the number and the list a click shows are one rule, not two.
//
// A number can be clicked: the search box becomes `label:"<label>"` (the same items, through the
// ordinary filter; a label the filter cannot carry is shown but not clickable), and clicking the lit
// number again puts back what the box said before.
// GitHub#464: no click query carries `is:open` — whether closed items are listed too is the lit
// number's own "显示已关闭" switch (`showClosedKey`). It starts as the number counts: off for "运行中" /
// "等 agent" / "未处理" (open only), on for "等人处理" (closed ones count too, GitHub#462) — so the
// default list is exactly the counted items, and each number can still be switched by itself.

// GitHub#468: the numbers are a table set in Settings (shared/tallies.ts). A "跟随流程标签" row counts
// exactly as above (the "等人处理" label through isPending, the other two open + label; click through
// `flowQuery`); a "自己写条件" row counts through its own search text and the board's filter, with the
// same context the board uses (viewer, today, projects), and a click puts that same text in the box.
// With the table never changed the bar is what it was.
// GitHub#464: every number has its own "显示已关闭" switch (keyed by the row's id); a query row counts what
// its click lists with that switch off — open items only, unless its condition names the state itself.

import type { HandBackLabels, Item, TallyColor, TallyDef, TallyFlow } from '../shared/types';
import type { FilterContext } from '../shared/filter';
import { hasLabel, isPending } from './pending';
import { applyFilter, openOnly, parseFilter, statesStated } from '../shared/filter';
import type { Layout, ShowClosedKey } from '../shared/types';
import { DEFAULT_TALLIES, UNLABELED_QUERY, defaultTallies } from '../shared/tallies';
import { tKey } from '../shared/i18n';

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
  /** a flow row: which flow label it follows; null for a query row */
  flow: TallyFlow | null;
  /** a flow row: the label as set in Settings (trimmed); '' for a query row */
  label: string;
  /** the items it picks (a flow row: open ones only, except "等人处理", which counts closed ones too — GitHub#462) */
  count: number;
  /** what the search box becomes on a click; null = this label cannot be written in the search syntax */
  query: string | null;
}

/**
 * GitHub#471: the name a number shows. A default row still carrying its default name is the client's
 * own word and follows the interface language; any other name is what the user typed in Settings and
 * is shown as written (`own` = true).
 */
export function tallyName(e: Pick<TallyEntry, 'kind' | 'name'>): { text: string; own: boolean } {
  const d = DEFAULT_TALLIES.find((x) => x.id === e.kind);
  if (!d || d.name !== e.name) return { text: e.name, own: true };
  return { text: tKey(d.name), own: false };
}

/** the default rows' names (kept for callers that name a default number) */
export const TALLY_TEXT: Record<'running' | 'agent' | 'human' | 'unlabeled', string> = Object.fromEntries(DEFAULT_TALLIES.map((d) => [d.id, d.name])) as Record<
  'running' | 'agent' | 'human' | 'unlabeled',
  string
>;

const NO_CONTEXT: FilterContext = { viewer: null, today: '', projects: [] };

/**
 * The query a number's click puts in the search box: `is:open label:"<label>"` (open = true), or
 * `label:"<label>"` alone (open = false, "等人处理" — GitHub#462: closed items with the label count
 * too); null for a label the search syntax cannot carry. Decided by the real parser, not by guessing
 * which characters are safe: the query must read back as exactly ("open" plus) this one whole label,
 * nothing ignored — a double quote breaks the quoting, and a leading `<` / `>` is a comparison the
 * filter drops (PR #408 review round 1: the number said 1, the click showed every open item).
 */
export function tallyQuery(label: string, open: boolean = true): string | null {
  const l = label.trim();
  if (l === '' || l.includes('"')) return null;
  const q = `${open ? 'is:open ' : ''}label:"${l}"`;
  const { clauses, unsupported } = parseFilter(q);
  if (unsupported.length !== 0 || clauses.length !== (open ? 2 : 1)) return null;
  const isOpen = (c: (typeof clauses)[number]) =>
    c.kind === 'field' && c.field === 'is' && !c.negated && c.values.length === 1 && c.values[0].toLowerCase() === 'open';
  const isLabel = (c: (typeof clauses)[number]) => c.kind === 'field' && c.field === 'label' && !c.negated && c.values.length === 1 && c.values[0] === l;
  const ok = open ? isOpen(clauses[0]) && isLabel(clauses[1]) : isLabel(clauses[0]);
  return ok ? q : null;
}

/**
 * GitHub#462: does a flow row count this item? "等人处理" is the reminders' own rule (`isPending`: the
 * label, open or closed); "运行中" / "等 agent" count open items only — work in progress is open.
 */
export function flowCounts(flow: TallyFlow, it: Item, label: string): boolean {
  return flow === 'human' ? isPending(it, label) : it.state === 'open' && hasLabel(it, label);
}

/**
 * A flow row's click query. GitHub#464: never `is:open` — with the number's own "显示已关闭" switch as it
 * starts (`showClosedDefault`) the list is exactly what `flowCounts` counts.
 */
export function flowQuery(_flow: TallyFlow, label: string): string | null {
  return tallyQuery(label, false);
}

/**
 * The condition a flow row becomes when it is turned into "自己写条件" (GitHub#468), picking the same items
 * `flowCounts` counts under the query rows' own rule (open items only unless the condition names the
 * state, GitHub#464): `label:"<label>"` for "运行中" / "等 agent"; for "等人处理", which counts closed
 * items too (GitHub#462), the state is written out — `label:"<label>" is:open,closed`. Null when the label
 * cannot be written in the search syntax.
 */
export function flowCondition(flow: TallyFlow, label: string): string | null {
  const q = tallyQuery(label, false);
  if (q === null) return null;
  return flow === 'human' ? `${q} is:open,closed` : q;
}

/**
 * GitHub#464: how a number's "显示已关闭" switch starts, until it is switched: on for a row following
 * "等人处理" (it counts closed items too, GitHub#462), off for every other number.
 */
export function showClosedDefault(entry: Pick<TallyEntry, 'flow'> | null): boolean {
  return entry?.flow === 'human';
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
      const flow = d.source.flow;
      const label = labels[flow].trim();
      if (label === '') continue;
      out.push({ kind: d.id, name, color: d.color, source: 'flow', flow, label, count: items.filter((it) => flowCounts(flow, it, label)).length, query: flowQuery(flow, label) });
    } else {
      const q = d.source.query.trim();
      if (q === '') continue;
      // GitHub#464: what a click lists while that number's "显示已关闭" switch is off (the default): open items
      // only, unless the condition itself says open / closed / merged — the same rule BoardView applies
      const parsed = parseFilter(q);
      const pool = statesStated(parsed) ? items : openOnly(items);
      out.push({ kind: d.id, name, color: d.color, source: 'query', flow: null, label: '', count: applyFilter(pool, parsed, ctx).length, query: q });
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

/**
 * Which number the search box is showing right now (its text is exactly that number's query), if any.
 * GitHub#464: two numbers can have the same click text (no click query carries `is:open` any more, so
 * "运行中" and "等人处理" set to one label read the same) — then `pick`, the number last clicked (kept by
 * the window), says which one is lit; without it (after a restart, or the text typed by hand) the first
 * one in the bar's order is. Each of them keeps its own "显示已关闭" switch either way.
 */
export function litTally(query: string, entries: TallyEntry[], pick: TallyKind | null = null): TallyKind | null {
  const q = query.trim();
  const same = entries.filter((e) => e.query !== null && e.query === q);
  if (same.length === 0) return null;
  return same.find((e) => e.kind === pick)?.kind ?? same[0].kind;
}

/**
 * A click on one number. `saved` is the search text from before the first number was clicked
 * (null = none); `pick` the number last clicked (see `litTally`). Rules:
 *  - the clicked number is lit → back to `saved` (empty when there is none), and `saved` is used up;
 *  - another number is lit → switch to the clicked one, `saved` stays as it was (also when the two
 *    share one click text: the box stays, the lit number and its switch change);
 *  - none is lit → remember the box as it is, then switch.
 * The answer's `pick` is the number lit afterwards (null = none).
 */
export function tallyClick(
  current: string,
  saved: string | null,
  target: TallyEntry,
  entries: TallyEntry[],
  pick: TallyKind | null = null,
): { query: string; saved: string | null; pick: TallyKind | null } {
  const lit = litTally(current, entries, pick);
  if (target.query === null) return { query: current, saved, pick: lit };
  if (lit === target.kind) return { query: saved ?? '', saved: null, pick: null };
  if (lit !== null) return { query: target.query, saved, pick: target.kind };
  return { query: target.query, saved: current, pick: target.kind };
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
