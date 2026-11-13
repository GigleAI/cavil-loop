// GitHub#468: the view-bar numbers ("运行中 / 等 agent / 等人处理 / 未处理") as a table set in Settings —
// add, remove, reorder, rename, recolour, write a search condition of one's own.
//
// Two kinds of rows (shared/types.ts `TallySource`):
//  - "跟随流程标签": counts open items carrying the flow label set under 流程标签, by whole name — the
//    rule the reminders use — and follows that setting for as long as the row exists, also after the
//    table was saved. A label the search syntax cannot carry (a leading `<` / `>`, a double quote) is
//    still counted exactly; only its click is off, as before (PR #408 review round 1).
//  - "自己写条件": a search condition; the count and the click go through that very text and the board's
//    own filter, so the number and the list a click shows are one rule.
//
// What is kept: `null` = never changed (the default table); otherwise the whole table. A saved value
// that is not a valid table is not shown half: the default is shown and Settings says so.

import type { TallyColor, TallyDef, TallyFlow, TallySource } from './types';

export const TALLY_COLORS: readonly TallyColor[] = ['green', 'blue', 'orange', 'red', 'purple', 'gray', 'ring'];
export const TALLY_FLOWS: readonly TallyFlow[] = ['running', 'agent', 'human'];
/** at most this many numbers: the view bar has room for no more */
export const TALLY_MAX = 8;
/** the "未处理" number's search — no label at all (GitHub#418); open only while its "显示已关闭" switch is off (GitHub#464) */
export const UNLABELED_QUERY = 'no:label';
/** the setting's key */
export const TALLIES_SETTING = 'tallies';

/** the names of the three flow labels as Settings calls them */
export const TALLY_FLOW_TEXT: Record<TallyFlow, string> = { running: '运行中的标签', agent: '交给 agent 的标签', human: '等人处理的标签' };

/** the table as it was before GitHub#468: the same names, order and colours */
export const DEFAULT_TALLIES: readonly TallyDef[] = Object.freeze([
  { id: 'running', name: '运行中', color: 'green', source: { kind: 'flow', flow: 'running' } },
  { id: 'agent', name: '等 agent', color: 'blue', source: { kind: 'flow', flow: 'agent' } },
  { id: 'human', name: '等人处理', color: 'orange', source: { kind: 'flow', flow: 'human' } },
  { id: 'unlabeled', name: '未处理', color: 'ring', source: { kind: 'query', query: UNLABELED_QUERY } },
] satisfies TallyDef[]);

/** a fresh copy of the default table (the frozen one is never handed out to be edited) */
export function defaultTallies(): TallyDef[] {
  return DEFAULT_TALLIES.map((d) => ({ ...d, source: { ...d.source } }));
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isFlow = (v: unknown): v is TallyFlow => isStr(v) && (TALLY_FLOWS as readonly string[]).includes(v);

function readSource(v: unknown): TallySource | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.kind === 'flow') return isFlow(o.flow) ? { kind: 'flow', flow: o.flow } : null;
  if (o.kind === 'query') {
    if (!isStr(o.query)) return null;
    if (o.from === undefined) return { kind: 'query', query: o.query };
    return isFlow(o.from) ? { kind: 'query', query: o.query, from: o.from } : null;
  }
  return null;
}

function readDef(v: unknown): TallyDef | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isStr(o.id) || o.id.trim() === '' || !isStr(o.name) || !isStr(o.color) || !(TALLY_COLORS as readonly string[]).includes(o.color)) return null;
  const source = readSource(o.source);
  return source ? { id: o.id, name: o.name, color: o.color as TallyColor, source } : null;
}

/**
 * A table read back (from the settings store or from the window). `null` / `undefined` = never set:
 * the default, not broken. Anything else must be a whole valid table — a list of at most TALLY_MAX
 * known rows with distinct ids — or it is `broken` and the default is used; never half of it.
 */
export function normalizeTallies(v: unknown): { tallies: TallyDef[] | null; broken: boolean } {
  if (v === null || v === undefined) return { tallies: null, broken: false };
  if (!Array.isArray(v) || v.length > TALLY_MAX) return { tallies: null, broken: true };
  const out: TallyDef[] = [];
  const ids = new Set<string>();
  for (const x of v) {
    const d = readDef(x);
    if (!d || ids.has(d.id)) return { tallies: null, broken: true };
    ids.add(d.id);
    out.push(d);
  }
  return { tallies: out, broken: false };
}

/** the table in effect: the saved one, or the default */
export function effectiveTallies(saved: TallyDef[] | null): TallyDef[] {
  return saved ?? defaultTallies();
}
