// The search box: GitHub's Project filter syntax, evaluated locally on the
// cached items. Pure (no Node, no Electron, no clock: callers pass `today`),
// so the renderer and the tests run the same code.
//
// Supported, matching what GitHub's own Project filter returns on the same
// data (test/unit/filter-parity.test.ts compares the two item by item):
//   free text            title / number / label name, case-insensitive, any
//                        position (also inside Chinese runs, where GitHub's
//                        word split misses matches); several words = all must hit
//   label: status: milestone: assignee: author: repo: project: iteration:
//   iteration:@current / @next / @previous      assignee:@me / author:@me
//   no:<field>  has:<field>  (label, assignee, milestone, iteration, status)
//   is:open|closed|merged|issue|pr   (closed includes merged PRs, as on GitHub)
//   -qualifier:...  negates;  a,b  = either;  "a b" = a value with spaces
// `project:` is this client's own: it picks items by the Project they came from.
//
// Anything else (body / comment search, date comparisons, `reason:`, custom
// fields, `sort:`, negated free text, an unknown value such as `is:draft`) is
// NOT silently turned into "0 results": it is listed in `unsupported` and
// ignored, and the view shows a yellow bar naming it — the result can then be
// wider than on the web, never empty because of a word we did not understand.

import type { Item, Iteration, ProjectMeta } from './types';

export type Field = 'label' | 'status' | 'milestone' | 'assignee' | 'author' | 'repo' | 'project' | 'iteration' | 'is' | 'no' | 'has';

export type Clause =
  | { kind: 'text'; value: string }
  | { kind: 'field'; field: Field; negated: boolean; values: string[] };

export interface ParsedFilter {
  clauses: Clause[];
  /** tokens ignored because this client does not support them (shown in the yellow bar) */
  unsupported: string[];
}

export interface FilterContext {
  /** signed-in login for @me (null: @me matches nothing) */
  viewer: string | null;
  /** YYYY-MM-DD, for @current / @next / @previous */
  today: string;
  projects: ProjectMeta[];
}

const FIELDS: readonly Field[] = ['label', 'status', 'milestone', 'assignee', 'author', 'repo', 'project', 'iteration', 'is', 'no', 'has'];
const IS_VALUES = ['open', 'closed', 'merged', 'issue', 'pr'];
const PRESENCE_VALUES = ['label', 'assignee', 'milestone', 'iteration', 'status'];
const ITERATION_TOKENS = ['@current', '@next', '@previous'];

/** Split on whitespace outside double quotes; quotes stay in the token. */
function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of input) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** `a,"b c",d` -> ['a', 'b c', 'd'] (commas inside quotes stay). */
function splitValues(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of raw) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

export function parseFilter(input: string): ParsedFilter {
  const clauses: Clause[] = [];
  const unsupported: string[] = [];
  for (const token of tokenize(input)) {
    const m = token.match(/^(-?)([A-Za-z][A-Za-z0-9_-]*):(.*)$/);
    if (!m) {
      // free text; a leading "-" would mean "exclude", which GitHub's Project
      // filter does not do either (it returns nothing) — say so instead
      if (token.startsWith('-') && token.length > 1) {
        unsupported.push(token);
        continue;
      }
      const value = token.replace(/"/g, '').trim();
      if (value) clauses.push({ kind: 'text', value });
      continue;
    }
    const negated = m[1] === '-';
    const field = m[2].toLowerCase() as Field;
    const values = splitValues(m[3]);
    if (!FIELDS.includes(field) || values.some((v) => !v) || !valuesSupported(field, values)) {
      unsupported.push(token);
      continue;
    }
    clauses.push({ kind: 'field', field, negated, values });
  }
  return { clauses, unsupported };
}

function valuesSupported(field: Field, values: string[]): boolean {
  const lower = values.map((v) => v.toLowerCase());
  switch (field) {
    case 'is':
      return lower.every((v) => IS_VALUES.includes(v));
    case 'no':
    case 'has':
      return lower.every((v) => PRESENCE_VALUES.includes(v));
    case 'iteration':
      // comparisons (`>@current`, `@current+1`, ranges) are not supported
      return lower.every((v) => !/^[<>]|\.\./.test(v) && (!v.startsWith('@') || ITERATION_TOKENS.includes(v)));
    case 'assignee':
    case 'author':
      return lower.every((v) => !v.startsWith('@') || v === '@me');
    default:
      return values.every((v) => !/^[<>]/.test(v));
  }
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The project's iterations by start date, and which one `today` falls in. */
function iterationTokenIds(p: ProjectMeta, today: string): Record<string, string | null> {
  const list = [...p.iterations].sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
  const i = list.findIndex((it) => it.startDate <= today && today < addDays(it.startDate, it.duration));
  if (i < 0) return { '@current': null, '@next': null, '@previous': null };
  return {
    '@current': list[i].id,
    '@next': list[i + 1]?.id ?? null,
    '@previous': list[i - 1]?.id ?? null,
  };
}

const lc = (s: string) => s.toLocaleLowerCase();

function textHit(item: Item, value: string): boolean {
  const v = lc(value);
  const num = v.replace(/^#/, '');
  if (/^\d+$/.test(num) && String(item.number) === num) return true;
  // several words in one quoted value / one token: each word must hit (GitHub does the same for "a b")
  return v
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => lc(item.title).includes(w) || item.labels.some((l) => lc(l.name).includes(w)));
}

function present(item: Item, what: string): boolean {
  switch (what) {
    case 'label':
      return item.labels.length > 0;
    case 'assignee':
      return item.assignees.length > 0;
    case 'milestone':
      return item.milestone !== null;
    case 'iteration':
      return item.projects.some((m) => m.iteration !== null);
    case 'status':
      return item.projects.some((m) => m.status !== null);
    default:
      return false;
  }
}

/** Does one value of a field clause hit the item (before negation)? */
function valueHit(item: Item, field: Field, raw: string, ctx: FilterContext, tokens: Map<string, Record<string, string | null>>): boolean {
  const v = lc(raw);
  switch (field) {
    case 'label':
      return item.labels.some((l) => lc(l.name) === v);
    case 'status':
      return item.projects.some((m) => m.status !== null && lc(m.status) === v);
    case 'milestone':
      return item.milestone !== null && lc(item.milestone.title) === v;
    case 'assignee':
      return item.assignees.some((a) => lc(a) === (v === '@me' ? lc(ctx.viewer ?? '\u0000') : v));
    case 'author':
      return item.author !== null && lc(item.author) === (v === '@me' ? lc(ctx.viewer ?? '\u0000') : v);
    case 'repo':
      return lc(item.repo) === v;
    case 'project':
      return item.projects.some((m) => {
        const meta = ctx.projects.find((p) => p.key === m.projectKey);
        const num = m.projectKey.split('/').pop();
        return lc(m.projectTitle) === v || v === num || v === `#${num}` || (meta !== undefined && lc(meta.url) === v);
      });
    case 'iteration':
      return item.projects.some((m) => {
        if (!m.iteration) return false;
        if (v.startsWith('@')) return tokens.get(m.projectKey)?.[v] === m.iteration.id;
        return lc(m.iteration.title) === v;
      });
    case 'is':
      if (v === 'open') return item.state === 'open';
      if (v === 'closed') return item.state !== 'open';
      if (v === 'merged') return item.state === 'merged';
      if (v === 'issue') return item.kind === 'issue';
      return item.kind === 'pr';
    case 'no':
      return !present(item, v);
    case 'has':
      return present(item, v);
  }
}

/** Items matching every clause (unsupported tokens were already dropped by the parser). */
export function applyFilter(items: Item[], parsed: ParsedFilter, ctx: FilterContext): Item[] {
  if (parsed.clauses.length === 0) return items;
  const tokens = new Map(ctx.projects.map((p) => [p.key, iterationTokenIds(p, ctx.today)]));
  return items.filter((item) =>
    parsed.clauses.every((c) => {
      if (c.kind === 'text') return textHit(item, c.value);
      const hit = c.values.some((v) => valueHit(item, c.field, v, ctx, tokens));
      return c.negated ? !hit : hit;
    }),
  );
}

/** Iteration whose window contains `today` (exported for the table's "Current" mark). */
export function isCurrentIteration(it: Iteration, today: string): boolean {
  return it.startDate <= today && today < addDays(it.startDate, it.duration);
}
