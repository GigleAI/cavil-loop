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
import { ISSUE_RELATIONS_BATCH_QUERY, ISSUE_RELATIONS_QUERY } from './queries';

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
  if (!c.id) throw new GitHubError('graphql', `${what} 的关系超过一页，但缺少读后续页要用的 id`);
  const out: T = { ...c };
  for (const name of LISTS) if (c[name]) out[name] = { pageInfo: { ...c[name]!.pageInfo }, nodes: [...c[name]!.nodes] };
  for (let page = 0; cut(out).length; page++) {
    if (page >= MAX_RELATION_PAGES) throw new GitHubError('http', `${what} 的关系分页超过 ${MAX_RELATION_PAGES} 页，已停止`);
    const want = cut(out);
    const variables: Record<string, unknown> = { id: c.id };
    for (const name of LISTS) {
      variables[name] = want.includes(name);
      variables[`${name}After`] = want.includes(name) ? out[name]!.pageInfo.endCursor : null;
      if (want.includes(name) && !out[name]!.pageInfo.endCursor) throw new GitHubError('graphql', `${what} 的关系分页缺少游标`);
    }
    const data = await client.graphql<{ node: (Partial<Record<ListName, GqlRelationList | null>> & { __typename?: string }) | null }>(ISSUE_RELATIONS_QUERY, variables);
    for (const name of want) {
      const more = data.node?.[name];
      if (!more || !Array.isArray(more.nodes) || !more.pageInfo) throw new GitHubError('graphql', `${what} 的关系后续页没有读到`);
      out[name] = { pageInfo: more.pageInfo, nodes: [...out[name]!.nodes, ...more.nodes] };
    }
  }
  return out;
}

/**
 * The relations of the issues with these node ids, each read to its last page: one request
 * per RELATION_BATCH_SIZE ids, plus the follow-up pages of an issue whose lists are long.
 * Every id gets an answer or the whole call throws.
 */
export async function fetchRelationsBatch(
  client: GitHubClient,
  issues: { nodeId: string; what: string }[],
  /** tests: a smaller batch, to cross the batch boundary with the recorded issues */
  size: number = RELATION_BATCH_SIZE,
): Promise<Map<string, ItemRelations>> {
  const out = new Map<string, ItemRelations>();
  for (let at = 0; at < issues.length; at += size) {
    const batch = issues.slice(at, at + size);
    const data = await client.graphql<{ nodes: ((GqlRelationFields & { __typename?: string }) | null)[] }>(ISSUE_RELATIONS_BATCH_QUERY, { ids: batch.map((i) => i.nodeId) });
    if (!Array.isArray(data.nodes) || data.nodes.length !== batch.length) throw new GitHubError('graphql', '批量读关系：回应的条数和请求的不一致');
    for (let i = 0; i < batch.length; i++) {
      const node = data.nodes[i];
      const { what } = batch[i];
      if (!node || node.__typename !== 'Issue') throw new GitHubError('graphql', `${what} 的关系没有读到`);
      const rel = readRelations(await completeRelations(client, node, what));
      if (!rel) throw new GitHubError('graphql', `${what} 的关系没有读全`);
      out.set(batch[i].nodeId, rel);
    }
  }
  return out;
}

/** Does every item of a source carry relations? (false: a snapshot cached before #349, not yet re-read) */
export function relationsKnown(items: Item[]): boolean {
  return items.every((i) => i.relations !== undefined);
}
