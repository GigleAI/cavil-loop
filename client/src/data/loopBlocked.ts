// GitHub#429: what an open issue waits for according to the loop's own registration — the hidden
// `<!-- agent-blocked-by: #12 owner/repo#34 resume=… -->` comment the daemon goes by — so the
// dependency graph can draw it next to GitHub's own "Blocked by". Read-only: nothing is written.
//
// Which comment counts is the daemon's rule (scripts/_lib.sh `blocked_mark_pick`), with one
// documented gap: the client does not know the loop's own account, so only the author's standing in
// the repository (owner / member / collaborator) admits a registration. Both implementations run the
// same cases with the same expected answers (tests/fixtures/blocked-marks.json): the shell test and
// test/unit/loop-blocked.test.ts. Change one, change the other.
//
// Read whole or not at all, like the relations: a page that cannot be read fails the source read
// (its previous snapshot stays); nothing half-read is ever stored.

import { parseStateReason } from '../shared/stateTone';
import { itemKey } from '../shared/sources';
import type { Item, RelatedIssue } from '../shared/types';
import { GitHubClient, GitHubError } from './github';
import { t } from '../shared/i18n';
import { LOOP_BLOCKED_BATCH_QUERY, LOOP_BLOCKED_MORE_QUERY, LOOP_END_QUERY } from './queries';
import { fetchNodesBatch } from './relations';
import { countingMarks, parseMark, type MarkComment, type MarkEnd } from '../shared/blocked';

/** pages (100 each) of one issue's comments / label removals before giving up */
const MAX_PAGES = 50;

// GitHub#434: the rule itself is shared with "等前置…" (src/shared/blocked.ts): one implementation
export type { MarkComment, MarkEnd } from '../shared/blocked';

/**
 * The prerequisites the counting registration names, or [] when none counts.
 * `since`: when the waiting label was last removed ('' = never); a registration must be strictly later.
 * `self`: the issue's own repository, lower-cased (a registration naming it in full means "this repository").
 */
export function pickLoopMark(comments: MarkComment[], since: string, self: string): MarkEnd[] {
  const last = countingMarks(comments, since).pop();
  return last ? parseMark(last.body, self).ends : [];
}

interface GqlPage<T> {
  pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
  nodes: (T | null)[];
}
interface GqlComment {
  databaseId: number;
  body: string;
  createdAt: string;
  authorAssociation: string;
}
interface GqlUnlabeled {
  __typename: string;
  createdAt?: string;
  label?: { name: string } | null;
}
interface GqlLoopNode {
  __typename?: string;
  id?: string;
  comments?: GqlPage<GqlComment> | null;
  timelineItems?: GqlPage<GqlUnlabeled> | null;
}

const whole = <T,>(p: GqlPage<T> | null | undefined, what: string): GqlPage<T> => {
  if (!p || !Array.isArray(p.nodes) || !p.pageInfo) throw new GitHubError('graphql', t('{item} 的前置登记没有读全', { item: what }));
  if (p.pageInfo.hasPreviousPage && !p.pageInfo.startCursor) throw new GitHubError('graphql', t('{item} 的前置登记分页缺少游标', { item: what }));
  return p;
};

/** One issue's registration, from the first (newest) pages the batch brought; older pages read as needed. */
async function readOne(client: GitHubClient, it: Item, node: GqlLoopNode, label: string): Promise<MarkEnd[]> {
  // the item, as the messages below name it
  const what = `${it.repo}#${it.number}`;
  // 1. when the waiting label was last removed: newest page first, walking back until found
  let events = whole(node.timelineItems, what);
  let since: string | null = null;
  for (let page = 0; ; page++) {
    for (let i = events.nodes.length - 1; i >= 0 && since === null; i--) {
      const e = events.nodes[i];
      if (e?.__typename === 'UnlabeledEvent' && e.label?.name === label) {
        if (!e.createdAt) throw new GitHubError('graphql', t('{item} 的前置登记：摘标签记录缺少时间', { item: what }));
        since = e.createdAt;
      }
    }
    if (since !== null || !events.pageInfo.hasPreviousPage) break;
    if (page >= MAX_PAGES) throw new GitHubError('http', t('{item} 的前置登记：标签记录分页超过 {n} 页，已停止', { item: what, n: MAX_PAGES }));
    const more = await client.graphql<{ node: GqlLoopNode | null }>(LOOP_BLOCKED_MORE_QUERY, { id: it.nodeId, comments: false, commentsBefore: null, events: true, eventsBefore: events.pageInfo.startCursor });
    events = whole(more.node?.timelineItems, what);
  }
  const from = since ?? '';
  // 2. the comments: newest page first, walking back until a page reaches back to `from` (older ones cannot count)
  let page = whole(node.comments, what);
  const all: MarkComment[] = [];
  for (let n = 0; ; n++) {
    for (const c of page.nodes) {
      if (!c) throw new GitHubError('graphql', t('{item} 的前置登记：有评论没有读到', { item: what }));
      all.push({ id: c.databaseId, body: c.body ?? '', createdAt: c.createdAt ?? '', authorAssociation: c.authorAssociation ?? '' });
    }
    const oldest = page.nodes[0]?.createdAt ?? '';
    if (!page.pageInfo.hasPreviousPage || (from !== '' && oldest !== '' && oldest <= from)) break;
    if (n >= MAX_PAGES) throw new GitHubError('http', t('{item} 的前置登记：评论分页超过 {n} 页，已停止', { item: what, n: MAX_PAGES }));
    const more = await client.graphql<{ node: GqlLoopNode | null }>(LOOP_BLOCKED_MORE_QUERY, { id: it.nodeId, comments: true, commentsBefore: page.pageInfo.startCursor, events: false, eventsBefore: null });
    page = whole(more.node?.comments, what);
  }
  return pickLoopMark(all, from, it.repo.toLowerCase());
}

interface GqlEnd {
  __typename: 'Issue' | 'PullRequest';
  number: number;
  title: string;
  url: string;
  state: string;
  stateReason?: string | null;
  merged?: boolean;
  isDraft?: boolean | null;
  repository: { nameWithOwner: string };
}

/** One prerequisite's title and state; null = GitHub says this account cannot see it (or it is gone). */
async function readEnd(client: GitHubClient, repo: string, number: number): Promise<RelatedIssue | null> {
  const [owner, name] = repo.split('/');
  let data: { repository: { issueOrPullRequest: GqlEnd | null } | null };
  try {
    data = await client.graphql(LOOP_END_QUERY, { owner, name, number });
  } catch (e) {
    // only "not there / not visible" is an answer; anything else fails the read
    if (e instanceof GitHubError && e.kind === 'graphql' && (e.meta.gqlTypes as string[] | undefined)?.length && (e.meta.gqlTypes as string[]).every((t) => t === 'NOT_FOUND')) return null;
    throw e;
  }
  const c = data.repository?.issueOrPullRequest;
  if (!c) return null;
  const r = c.repository.nameWithOwner;
  const pr = c.__typename === 'PullRequest';
  return {
    key: itemKey(r, c.number),
    repo: r,
    number: c.number,
    title: c.title ?? '',
    url: c.url ?? '',
    state: pr && c.merged ? 'merged' : c.state === 'OPEN' ? 'open' : 'closed',
    stateReason: pr ? null : parseStateReason(c.stateReason),
    ...(pr ? { kind: 'pr' as const, isDraft: typeof c.isDraft === 'boolean' ? c.isDraft : null } : {}),
  };
}

const asRelated = (x: Item): RelatedIssue => ({
  key: x.key,
  repo: x.repo,
  number: x.number,
  title: x.title,
  url: x.url,
  state: x.state,
  stateReason: x.stateReason,
  ...(x.kind === 'pr' ? { kind: 'pr' as const, isDraft: x.isDraft } : {}),
});

/** Does `it` get its registration read under this setting? (open issue carrying the label) */
export function loopCandidate(it: Item, label: string): boolean {
  return label !== '' && it.kind === 'issue' && it.state === 'open' && it.labels.some((l) => l.name === label);
}

/**
 * Fill `loopBlocked` on every issue of `items` (one source's read, or one re-read item) under the
 * label setting `label`. '' = off: nothing is read, nothing is set. Requests go out only for open
 * issues carrying the label; every other issue is known to wait for nothing. Throws when any page
 * cannot be read — the caller then has nothing to store.
 */
export async function readLoopBlocked(client: GitHubClient, items: Item[], label: string): Promise<void> {
  if (!label) return;
  const wanted = items.filter((it) => loopCandidate(it, label));
  const missingId = wanted.find((it) => !it.nodeId);
  if (missingId) throw new GitHubError('http', t('{item} 缺少读前置登记要用的 id', { item: `${missingId.repo}#${missingId.number}` }));
  const nodes = wanted.length ? await fetchNodesBatch<GqlLoopNode>(client, LOOP_BLOCKED_BATCH_QUERY, wanted.map((it) => it.nodeId)) : [];
  const known = new Map(items.map((it) => [it.key, it]));
  const ends = new Map<string, RelatedIssue | null>();
  const result = new Map<string, RelatedIssue[]>();
  for (let i = 0; i < wanted.length; i++) {
    const it = wanted[i];
    const node = nodes[i];
    if (!node || node.__typename !== 'Issue') throw new GitHubError('graphql', t('{item} 的前置登记没有读到', { item: `${it.repo}#${it.number}` }));
    const marks = await readOne(client, it, node, label);
    const out: RelatedIssue[] = [];
    for (const m of marks) {
      const repo = m.r === '' ? it.repo : m.r;
      const key = itemKey(repo, m.n);
      if (key === it.key) continue;
      if (!ends.has(key)) {
        const local = known.get(key);
        ends.set(key, local ? asRelated(local) : await readEnd(client, repo, m.n));
      }
      const end = ends.get(key);
      if (end) out.push(end);
    }
    result.set(it.key, out);
  }
  // only once everything is in: nothing half-read lands on the items
  for (const it of items) if (it.kind === 'issue') it.loopBlocked = { label, ends: result.get(it.key) ?? [] };
}

/** Is every issue's registration known under this setting? (false: read under another setting, or before #429) */
export function loopKnown(items: Item[], label: string): boolean {
  return !label || items.every((it) => it.kind !== 'issue' || it.loopBlocked?.label === label);
}
