// GitHub#404: the view bar's "运行中 / 等 agent / 等人处理" — how many issues / PRs of the ticked
// sources carry each flow label, whatever the search box says.
//
// "等人处理" counts through `isPending` (carries the label, open or closed — GitHub#462): the very rule
// the reminders and the Dock badge use, so "等人处理 5" and the pending reminders cannot disagree.
// "运行中" / "等 agent" count open items only: work in progress is open by definition.
//
// GitHub#418: a fourth number, "未处理" — open items of the ticked sources carrying no label at all. Its
// click query is the fixed `is:open no:label`, and the count goes through that very query's filter
// (`applyFilter`), so the number and the list a click shows are one rule, not two.
//
// A number can be clicked: the search box becomes `label:"<label>"` for "等人处理" and
// `is:open label:"<label>"` for the other two (the same items, through the ordinary filter; a label
// the filter cannot carry is shown but not clickable), and clicking the lit number again puts back
// what the box said before.

import type { HandBackLabels, Item } from '../shared/types';
import { hasLabel, isPending } from './pending';
import { applyFilter, parseFilter } from '../shared/filter';

export type TallyKind = 'running' | 'agent' | 'human' | 'unlabeled';

export interface TallyEntry {
  kind: TallyKind;
  /** the label as set in Settings (trimmed); '' for "unlabeled", which counts items with no label */
  label: string;
  /** items carrying it: open ones only, except "等人处理", which counts closed ones too (GitHub#462) */
  count: number;
  /** what the search box becomes on a click; null = this label cannot be written in the search syntax */
  query: string | null;
}

export const TALLY_TEXT: Record<TallyKind, string> = { running: '运行中', agent: '等 agent', human: '等人处理', unlabeled: '未处理' };

/** GitHub#418: the "未处理" number's search — open and no label at all */
export const UNLABELED_QUERY = 'is:open no:label';

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
    .map((e): TallyEntry => {
      // GitHub#462: "等人处理" is the reminders' rule (open or closed); the other two count open items only
      const human = e.kind === 'human';
      const counts = (it: Item) => (human ? isPending(it, e.label) : it.state === 'open' && hasLabel(it, e.label));
      return { ...e, count: items.filter(counts).length, query: tallyQuery(e.label, !human) };
    })
    .concat(unlabeledTally(items));
}

/**
 * GitHub#418: "未处理" — always shown, last. Counted through the real filter with its own click query
 * (no context is needed: `is` and `no:label` read nothing but the item), so a click lists exactly the
 * counted items. Items come merged by key (`mergeSnapshots`), so one carried by two sources counts once.
 */
export function unlabeledTally(items: Item[]): TallyEntry {
  const count = applyFilter(items, parseFilter(UNLABELED_QUERY), { viewer: null, today: '', projects: [] }).length;
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
