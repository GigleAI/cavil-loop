// GitHub#468: the view-bar numbers ("未处理 / 等人处理 / 等 agent / 运行中 / 稍后处理") as a table set in Settings —
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

import type { SourceConfig, TallyColor, TallyDef, TallyFlow, TallyFold, TallySource } from './types';
import { t, zhKey } from './i18n';
import { parseFilter } from './filter';

export const TALLY_COLORS: readonly TallyColor[] = ['green', 'blue', 'orange', 'red', 'purple', 'gray', 'ring'];
export const TALLY_FLOWS: readonly TallyFlow[] = ['running', 'agent', 'human', 'later'];
/** GitHub#634: the three ways a number can fold, in the order Settings lists them */
export const TALLY_FOLDS: readonly TallyFold[] = ['never', 'zero', 'always'];
/** at most this many numbers: the view bar has room for no more */
export const TALLY_MAX = 8;
/** the "未处理" number's search — no label at all (GitHub#418); open only while its "显示已关闭" switch is off (GitHub#464) */
export const UNLABELED_QUERY = 'no:label';
/** the setting's key */
export const TALLIES_SETTING = 'tallies';

/** the names of the flow labels as Settings calls them */
export const tallyFlowText = (flow: TallyFlow): string =>
  ({ running: t('运行中的标签'), agent: t('交给 agent 的标签'), human: t('等人处理的标签'), later: t('暂缓的标签') })[flow];

/**
 * The table used until it is changed in Settings. GitHub#514: left to right 未处理 → 等人处理 → 等 agent →
 * 运行中 → 稍后处理 (the parked label, LABEL_PENDING_LATER). The four older rows keep their ids, names and
 * colours, so a number's "显示已关闭" switch (kept by id, GitHub#464) carries over; a saved table is not touched.
 */
export const DEFAULT_TALLIES: readonly TallyDef[] = Object.freeze([
  { id: 'unlabeled', name: zhKey('未处理'), color: 'ring', source: { kind: 'query', query: UNLABELED_QUERY }, fold: 'zero' },
  { id: 'human', name: zhKey('等人处理'), color: 'orange', source: { kind: 'flow', flow: 'human' }, fold: 'zero' },
  { id: 'agent', name: zhKey('等 agent'), color: 'blue', source: { kind: 'flow', flow: 'agent' }, fold: 'zero' },
  { id: 'running', name: zhKey('运行中'), color: 'green', source: { kind: 'flow', flow: 'running' }, fold: 'never' },
  { id: 'later', name: zhKey('稍后处理'), color: 'purple', source: { kind: 'flow', flow: 'later' }, fold: 'always' },
] satisfies TallyDef[]);

/**
 * GitHub#643: what the default fold rule needs to know about the parked label ("暂缓", LABEL_PENDING_LATER).
 * `shared`: the shared name ('' = "稍后处理" switched off). `common`: the one name every repository the ticked
 * sources can hold uses for its parked label ('' = there is no such name, or it cannot be told) — from
 * `commonParked`. Absent = neither: only a row's own setting and its id decide, as before.
 */
export interface ParkedFold {
  shared: string;
  common: string;
}

/**
 * GitHub#643: which repositories the ticked sources can hold. Only repository sources ticked: exactly those
 * repositories; any Project ticked: not known in advance; nothing ticked: none. `selected` is the view's
 * ticked keys (null = every source), judged against the configured sources only, as the board merges them.
 */
export type ParkedScope = { kind: 'repos'; repos: string[] } | { kind: 'unknown' } | { kind: 'none' };

export function parkedScope(sources: readonly SourceConfig[], selected: readonly string[] | null): ParkedScope {
  const ticked = selected === null ? sources : sources.filter((s) => selected.includes(s.key));
  if (ticked.length === 0) return { kind: 'none' };
  if (ticked.some((s) => s.kind !== 'repo')) return { kind: 'unknown' };
  return { kind: 'repos', repos: ticked.map((s) => (s.kind === 'repo' ? `${s.owner}/${s.name}` : '')) };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * GitHub#643: the parked label every repository in `scope` really uses (its own name where it has one, the
 * shared one elsewhere — `laterOf`, the settings' one lookup), or '' when there is none:
 *  - the shared name is empty ("稍后处理" switched off) → ''
 *  - known repositories → their names, when all equal (case-insensitive) and not empty
 *  - not known (a Project) → the shared name, only when no repository with names of its own (`ownRepos`) renamed it
 *  - no repository → the shared name
 * Settings and the ticked sources only — never the items in hand, so a sync or an empty source changes nothing.
 */
export function commonParked(shared: string, laterOf: (repo: string) => string, scope: ParkedScope, ownRepos: readonly string[]): string {
  const s = shared.trim();
  if (s === '') return '';
  const repos = scope.kind === 'repos' ? scope.repos : scope.kind === 'unknown' ? [...ownRepos] : [];
  const names = repos.map((r) => laterOf(r).trim());
  if (scope.kind === 'unknown') return names.every((n) => same(n, s)) ? s : '';
  if (names.length === 0) return s;
  return names.every((n) => n !== '' && same(n, names[0])) ? names[0] : '';
}

/**
 * GitHub#643: the one label name a written condition picks, or null — read by the search box's own parser:
 * exactly one `label:` with one name, not negated, optionally with `is:open`; nothing else, nothing it ignored.
 */
export function soleLabel(query: string): string | null {
  const { clauses, unsupported } = parseFilter(query);
  if (unsupported.length) return null;
  let label: string | null = null;
  let open = false;
  for (const c of clauses) {
    if (c.kind !== 'field' || c.negated) return null;
    if (c.field === 'label' && label === null && c.values.length === 1) label = c.values[0];
    else if (c.field === 'is' && !open && c.values.length === 1 && c.values[0].toLowerCase() === 'open') open = true;
    else return null;
  }
  return label;
}

/**
 * GitHub#634: how a row folds. Its own setting when it has one. GitHub#643: then, while "稍后处理" is on
 * (`parked.shared`), a row counting the parked label always folds — one following the parked flow label, or a
 * condition of one's own picking exactly the name all the ticked sources' repositories use (`parked.common`) —
 * whatever its id. Otherwise the default row of the same id decides — "运行中" never, "稍后处理" always — and
 * every other row folds while it counts 0.
 */
export function tallyFold(d: Pick<TallyDef, 'id' | 'fold'> & { source?: TallySource }, parked?: ParkedFold): TallyFold {
  if (d.fold) return d.fold;
  if (parked && parked.shared.trim() !== '' && d.source) {
    if (d.source.kind === 'flow' && d.source.flow === 'later') return 'always';
    if (d.source.kind === 'query' && parked.common !== '') {
      const l = soleLabel(d.source.query);
      if (l !== null && same(l.trim(), parked.common.trim())) return 'always';
    }
  }
  return DEFAULT_TALLIES.find((x) => x.id === d.id)?.fold ?? 'zero';
}

/** GitHub#634: does a number with this fold rule and this count go into the fold? */
export function foldsAt(fold: TallyFold, count: number): boolean {
  return fold === 'always' || (fold === 'zero' && count === 0);
}

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
  if (!source) return null;
  // GitHub#634: no fold = the row's default (tables saved before folding existed); an unknown one breaks the table
  if (o.fold === undefined) return { id: o.id, name: o.name, color: o.color as TallyColor, source };
  if (!isStr(o.fold) || !(TALLY_FOLDS as readonly string[]).includes(o.fold)) return null;
  return { id: o.id, name: o.name, color: o.color as TallyColor, source, fold: o.fold as TallyFold };
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
