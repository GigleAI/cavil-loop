// "A pull request goes right under the issue it is linked to" (GitHub#155).
// One rule, used by the board's columns and the table's groups alike. Pure.
//
// The link is the issue's "Linked pull requests" (what GitHub lists in the
// issue's sidebar: pull requests that close it), as synced into
// `Item.linkedPrs`, plus (GitHub#275) every issue the PR's own description
// names with Closes / Fixes / Resolves / Refs #N (`Item.refIssues`): GitHub
// does not list a `Refs #N` PR as linked, and autopilot PRs write only that.
// A repository-only issue does not know GitHub's links (null); the PR-side
// references still apply to it.
//
// Nesting happens within one list (a column, a group). Which list a PR goes
// to is decided before that (GitHub#275, `prFollow`): a PR whose issue is
// shown follows the issue into the issue's column / group, so the two always
// meet. A PR linked to several issues goes under the first of them only
// (never shown twice). Under the "updated" sort, an issue and its PRs move as
// one unit, placed by the latest update among them; under any other sort the
// unit sits where the issue sits.

import type { Item, LinkedPr, TableSettings } from '../shared/types';
import { itemKey } from '../shared/sources';
import { fromMarkdown } from 'mdast-util-from-markdown';

export interface Nested<T> {
  entry: T;
  /** key of the issue this PR is shown under; null = top level */
  under: string | null;
}

/** Closes / Fixes / Resolves / Refs (and their -s / -d / -es / -ed forms), then `#N` or `owner/repo#N`. */
const REF_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\s+(?:([A-Za-z0-9][\w.-]*\/[\w.-]+))?#(\d+)\b/gi;

type MdNode = { type: string; value?: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: MdNode[] };

/**
 * Raw HTML elements whose content reads as code: their text never names an issue. (`<script>`,
 * `<style>`, `<textarea>` are not here: GitHub's Markdown filters those tags and shows them as text.)
 */
const CODE_ELEMENTS = new Set(['code', 'pre', 'kbd', 'samp']);

/**
 * The parts of `body` a reader does not see as prose (GitHub#275, PR #278 review rounds 1–2), as
 * [start, end) offsets — one rule, decided once:
 *  - Markdown code: fenced and indented blocks, inline spans (found by the Markdown parser, so a
 *    fence is closed only by a fence of its own kind and length);
 *  - inside raw HTML (every `html` node, in document order): comments (`<!-->` and `<!--->` are
 *    empty ones; a comment never closed hides the rest of the body, as a browser reads it),
 *    the tags themselves (attribute values too), and everything from an opening code-like element
 *    (CODE_ELEMENTS) to its matching close — across nodes, so the prose between `<code>` and
 *    `</code>` in two raw HTML pieces is hidden too; never closed = to the end of the body.
 * Text of other elements (`<div>`, a folded `<details>`) is prose: shown, so it counts.
 */
export function hiddenSpans(body: string): [number, number][] {
  const spans: [number, number][] = [];
  const html: { at: number; value: string }[] = [];
  const walk = (n: MdNode) => {
    const a = n.position?.start.offset;
    const b = n.position?.end.offset;
    if ((n.type === 'code' || n.type === 'inlineCode') && a !== undefined && b !== undefined) spans.push([a, b]);
    else if (n.type === 'html' && a !== undefined) html.push({ at: a, value: body.slice(a, b ?? body.length) });
    else n.children?.forEach(walk);
  };
  walk(fromMarkdown(body) as MdNode);
  html.sort((x, y) => x.at - y.at);
  let open: { name: string; at: number; depth: number } | null = null;
  for (const { at, value } of html) {
    let i = 0;
    while (i < value.length) {
      const lt = value.indexOf('<', i);
      if (lt < 0) break;
      const rest = value.slice(lt);
      let end: number;
      if (rest.startsWith('<!--')) {
        const short = /^<!--->?|^<!-->/.exec(rest);
        const close = short ? -1 : value.indexOf('-->', lt + 4);
        if (short) end = lt + short[0].length;
        else if (close < 0) {
          // never closed: everything after is inside the comment
          spans.push([at + lt, body.length]);
          return spans.sort((x, y) => x[0] - y[0]);
        } else end = close + 3;
        if (!open) spans.push([at + lt, at + end]);
        i = end;
        continue;
      }
      const tag = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)(?:[^>"']|"[^"]*"|'[^']*')*>/.exec(rest) ?? /^<[!?][^>]*>/.exec(rest);
      if (!tag) {
        i = lt + 1;
        continue;
      }
      end = lt + tag[0].length;
      const name = (tag[2] ?? '').toLowerCase();
      const closing = tag[1] === '/';
      const selfClosed = /\/>$/.test(tag[0]);
      if (open) {
        if (name === open.name && !closing && !selfClosed) open.depth++;
        else if (name === open.name && closing && --open.depth === 0) {
          spans.push([open.at, at + end]);
          open = null;
        }
      } else if (CODE_ELEMENTS.has(name) && !closing && !selfClosed) {
        open = { name, at: at + lt, depth: 1 };
      } else spans.push([at + lt, at + end]);
      i = end;
    }
  }
  if (open) spans.push([open.at, body.length]);
  return spans.sort((x, y) => x[0] - y[0]);
}

/** `body` with every hidden part (hiddenSpans) blanked, line breaks kept: the prose keywords are read in. */
export function proseText(body: string): string {
  let out = body;
  for (const [a, b] of hiddenSpans(body)) out = out.slice(0, a) + out.slice(a, b).replace(/[^\n]/g, ' ') + out.slice(b);
  return out;
}

/** The issue keys `text` names, in order, each once, never `self`. Shared by the parser and its browser cross-check. */
export function namedIn(text: string, repo: string, self: number | null | undefined): string[] {
  const own = itemKey(repo, self ?? -1);
  const out: string[] = [];
  for (const m of text.matchAll(REF_RE)) {
    const key = itemKey(m[1] ?? repo, Number(m[2]));
    if (key !== own && !out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * The issues a PR's description names (GitHub#275), as item keys, in the order
 * written, each once — read in its prose only (hiddenSpans says what is not
 * prose; the Markdown parser is the one the task lists use). `#N` alone means
 * this repository; the PR itself is never one of them.
 */
export function bodyIssueRefs(body: string | null | undefined, repo: string, self: number | null | undefined): string[] {
  return body ? namedIn(proseText(body), repo, self) : [];
}

/** Per issue: the keys of the PRs linked to it, GitHub's links first, then the PRs (of `items`, in order) whose description names it. */
function linksOf(items: Item[]): Map<string, string[]> {
  const named = new Map<string, string[]>();
  for (const it of items) {
    if (it.kind !== 'pr') continue;
    for (const k of it.refIssues ?? []) named.set(k, [...(named.get(k) ?? []), it.key]);
  }
  const out = new Map<string, string[]>();
  for (const it of items) {
    if (it.kind !== 'issue') continue;
    const keys = [...(it.linkedPrs ?? []).map((l) => l.key), ...(named.get(it.key) ?? [])];
    if (keys.length) out.set(it.key, [...new Set(keys)]);
  }
  return out;
}

/** PR key -> the issue (of `items`, in that order) it goes under. */
export function prHosts(items: Item[]): Map<string, string> {
  const here = new Set(items.map((i) => i.key));
  const links = linksOf(items);
  const hosts = new Map<string, string>();
  for (const it of items) {
    for (const k of links.get(it.key) ?? []) {
      if (k === it.key || !here.has(k) || hosts.has(k)) continue;
      hosts.set(k, it.key);
    }
  }
  // only real PRs of the list: a key that is an issue here is never moved
  for (const it of items) if (it.kind !== 'pr') hosts.delete(it.key);
  return hosts;
}

/**
 * GitHub#275: which issue each PR follows into its column / group — the issue
 * it would go under if the whole (filtered, sorted) list were one column. Only
 * issues that `canHost` take a PR (an issue on none of the selected Projects
 * does not pull a PR into "no status"); a PR with no such issue stays by its
 * own value.
 */
export function prFollow(items: Item[], canHost: (issue: Item) => boolean): Map<string, string> {
  return prHosts(items.filter((it) => it.kind !== 'issue' || canHost(it)));
}

/** One linked PR as the "linked PRs" column shows it, and where the link comes from. */
export interface PrLink extends LinkedPr {
  /** github = GitHub's "Linked pull requests"; body = only the PR's description names the issue */
  via: 'github' | 'body';
}

/**
 * The PRs shown as linked to `issue` (GitHub#275): GitHub's links, then the PRs
 * of `all` whose description names it. null = GitHub's links are not known
 * (repository source) and no PR here names it.
 */
export function issuePrLinks(issue: Item, all: Item[]): PrLink[] | null {
  const out: PrLink[] = (issue.linkedPrs ?? []).map((l) => ({ ...l, via: 'github' }));
  if (issue.kind === 'issue') {
    for (const pr of all) {
      if (pr.kind !== 'pr' || pr.key === issue.key || !pr.refIssues?.includes(issue.key) || out.some((l) => l.key === pr.key)) continue;
      out.push({ key: pr.key, repo: pr.repo, number: pr.number, url: pr.url, state: pr.state, via: 'body' });
    }
  }
  return issue.linkedPrs === null && out.length === 0 ? null : out;
}

/** Latest update of a unit: the item and the PRs shown under it. */
export function unitUpdated(item: Item, under: Item[]): string {
  return under.reduce((m, p) => (p.updatedAt > m ? p.updatedAt : m), item.updatedAt);
}

/** PRs under one issue: newest first. */
export const PR_ORDER = (a: Item, b: Item) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);

/**
 * Re-order units under the "updated" sort by their latest update (stable:
 * equal times keep the incoming order). Any other sort: unchanged.
 */
export function orderUnits<U>(units: U[], time: (u: U) => string, sort: TableSettings['sort'] | undefined): U[] {
  if (sort?.field !== 'updated') return units;
  const sign = sort.dir === 'asc' ? 1 : -1;
  return units
    .map((u, i) => ({ u, i, t: time(u) }))
    .sort((a, b) => (a.t < b.t ? -sign : a.t > b.t ? sign : a.i - b.i))
    .map((x) => x.u);
}

/**
 * The hosts inside one list: `prHosts` of the list, except that a PR that
 * follows an issue (`follow`, GitHub#275) goes under that issue whenever it is
 * in the list — the list it was put in for that very reason.
 */
export function listHosts(items: Item[], follow?: Map<string, string>): Map<string, string> {
  const hosts = prHosts(items);
  if (!follow) return hosts;
  const here = new Set(items.map((i) => i.key));
  for (const it of items) {
    const h = follow.get(it.key);
    if (h && here.has(h)) hosts.set(it.key, h);
  }
  return hosts;
}

/**
 * One list (already in the view's order) with every PR moved right under the
 * issue it is linked to.
 */
export function nestPrs<T>(entries: T[], itemOf: (t: T) => Item, sort: TableSettings['sort'] | undefined, follow?: Map<string, string>): Nested<T>[] {
  const hosts = listHosts(entries.map(itemOf), follow);
  if (hosts.size === 0) return entries.map((entry) => ({ entry, under: null }));
  const guests = new Map<string, T[]>();
  for (const e of entries) {
    const h = hosts.get(itemOf(e).key);
    if (h) guests.set(h, [...(guests.get(h) ?? []), e]);
  }
  const units = entries
    .filter((e) => !hosts.has(itemOf(e).key))
    .map((head) => ({ head, prs: [...(guests.get(itemOf(head).key) ?? [])].sort((a, b) => PR_ORDER(itemOf(a), itemOf(b))) }));
  const ordered = orderUnits(units, (u) => unitUpdated(itemOf(u.head), u.prs.map(itemOf)), sort);
  return ordered.flatMap((u) => [
    { entry: u.head, under: null },
    ...u.prs.map((entry) => ({ entry, under: itemOf(u.head).key })),
  ]);
}
