// GitHub#349: an issue's relations — parent, sub-issues, blocked-by, blocking — as the sync
// reads them. One transform (`readRelations`) and one "read the rest" (`completeRelations`)
// serve the board read, the repository read and the one-item re-read alike, so the three
// cannot disagree about one issue.
//
// The rule: relations are whole or unknown. A list GitHub cut at its first page is not
// "these are all of them" — until every page is in, the answer is `undefined`, and the
// callers that read a whole source fail the source instead of storing half a list.

import { parseStateReason } from '../shared/stateTone';
import type { Item, ItemRelations, RelatedIssue } from '../shared/types';
import { itemKey } from '../shared/sources';
import { GitHubClient, GitHubError } from './github';
import { t } from '../shared/i18n';
import { ISSUE_RELATIONS_QUERY } from './queries';

/** issues per request of the repository batch (GitHub's limit for `nodes(ids:)`) */
export const RELATION_BATCH_SIZE = 100;
/** follow-up pages of one issue's lists before giving up (100 a page) */
const MAX_RELATION_PAGES = 50;

export interface GqlRelated {
  number: number;
  title: string;
  url: string;
  state: string;
  stateReason?: string | null;
  repository: { nameWithOwner: string };
}
export interface GqlRelationList {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  /** null = an issue this account may not see */
  nodes: (GqlRelated | null)[];
}
/** The relation part of an issue as GraphQL returns it (RELATION_FIELDS). */
export interface GqlRelationFields {
  id?: string;
  parent?: GqlRelated | null;
  subIssues?: GqlRelationList | null;
  blockedBy?: GqlRelationList | null;
  blocking?: GqlRelationList | null;
}

const LISTS = ['subIssues', 'blockedBy', 'blocking'] as const;
type ListName = (typeof LISTS)[number];

/** Known to have none (a pull request; an issue whose counts are all zero). A fresh object each time: items are never shared. */
export function noRelations(): ItemRelations {
  return { parent: null, subIssues: [], blockedBy: [], blocking: [] };
}

function toRelated(n: GqlRelated): RelatedIssue {
  const repo = n.repository.nameWithOwner;
  return {
    key: itemKey(repo, n.number),
    repo,
    number: n.number,
    title: n.title ?? '',
    url: n.url ?? '',
    state: n.state === 'OPEN' ? 'open' : 'closed',
    stateReason: parseStateReason(n.stateReason),
  };
}

/**
 * The relations `c` carries, or undefined when they are not all there: a list missing from the
 * answer, or one with pages still unread. Never a partial list.
 */
export function readRelations(c: GqlRelationFields): ItemRelations | undefined {
  // `parent` is null for "none"; a key that is not there at all was not asked for / not answered
  if (c.parent === undefined) return undefined;
  const out = noRelations();
  out.parent = c.parent ? toRelated(c.parent) : null;
  for (const name of LISTS) {
    const list = c[name];
    if (!list || !Array.isArray(list.nodes) || !list.pageInfo || list.pageInfo.hasNextPage) return undefined;
    // an issue this account may not see comes back as null: there is nothing to show for it
    out[name] = list.nodes.filter((n): n is GqlRelated => Boolean(n)).map(toRelated);
  }
  return out;
}

/**
 * Read every remaining page of `c`'s relation lists and return `c` with the lists whole.
 * No request when nothing is cut. Any failure throws: the caller has no relations for this
 * issue then, not the first page of them.
 */
export async function completeRelations<T extends GqlRelationFields>(client: GitHubClient, c: T, what: string): Promise<T> {
  const cut = (x: GqlRelationFields) => LISTS.filter((name) => x[name]?.pageInfo?.hasNextPage);
  if (!cut(c).length) return c;
  if (!c.id) throw new GitHubError('graphql', t('{item} 的关系超过一页，但缺少读后续页要用的 id', { item: what }));
  const out: T = { ...c };
  for (const name of LISTS) if (c[name]) out[name] = { pageInfo: { ...c[name]!.pageInfo }, nodes: [...c[name]!.nodes] };
  for (let page = 0; cut(out).length; page++) {
    if (page >= MAX_RELATION_PAGES) throw new GitHubError('http', t('{item} 的关系分页超过 {max} 页，已停止', { item: what, max: MAX_RELATION_PAGES }));
    const want = cut(out);
    const variables: Record<string, unknown> = { id: c.id };
    for (const name of LISTS) {
      variables[name] = want.includes(name);
      variables[`${name}After`] = want.includes(name) ? out[name]!.pageInfo.endCursor : null;
      if (want.includes(name) && !out[name]!.pageInfo.endCursor) throw new GitHubError('graphql', t('{item} 的关系分页缺少游标', { item: what }));
    }
    const data = await client.graphql<{ node: (Partial<Record<ListName, GqlRelationList | null>> & { __typename?: string }) | null }>(ISSUE_RELATIONS_QUERY, variables);
    for (const name of want) {
      const more = data.node?.[name];
      if (!more || !Array.isArray(more.nodes) || !more.pageInfo) throw new GitHubError('graphql', t('{item} 的关系后续页没有读到', { item: what }));
      out[name] = { pageInfo: more.pageInfo, nodes: [...out[name]!.nodes, ...more.nodes] };
    }
  }
  return out;
}

/**
 * What a repository source reads by node id after its list (an issue's relations; GitHub#373: how
 * the signed-in account stands to an item): `nodes(ids:)`, RELATION_BATCH_SIZE a request, answers
 * in the order asked.
 * Every id gets an answer slot or the whole call throws (a slot may be null: the caller says what
 * that means). `query` takes `$ids` and returns `nodes`.
 */
export async function fetchNodesBatch<T>(
  client: GitHubClient,
  query: string,
  ids: string[],
  size: number = RELATION_BATCH_SIZE,
): Promise<((T & { __typename?: string }) | null)[]> {
  const out: ((T & { __typename?: string }) | null)[] = [];
  for (let at = 0; at < ids.length; at += size) {
    const batch = ids.slice(at, at + size);
    const data = await client.graphql<{ nodes: ((T & { __typename?: string }) | null)[] }>(query, { ids: batch });
    if (!Array.isArray(data.nodes) || data.nodes.length !== batch.length) throw new GitHubError('graphql', t('批量读关系：回应的条数和请求的不一致'));
    out.push(...data.nodes);
  }
  return out;
}

/** Does every item of a source carry relations? (false: a snapshot cached before #349, not yet re-read) */
export function relationsKnown(items: Item[]): boolean {
  return items.every((i) => i.relations !== undefined);
}
