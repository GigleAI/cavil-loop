// The detail page of one issue / PR: read it whole from GitHub (every page
// of comments and reviews), and order it newest first. The rendered HTML is
// GitHub's own (bodyHTML); it is only ever shown inside the isolated view.

import type { ItemDetail, MergeMethod, PrStatus, TimelineEntry } from '../shared/actions';
import { itemKey } from '../shared/sources';
import { GitHubClient, GitHubError } from './github';
import { ITEM_DETAIL_QUERY } from './queries';

const MAX_PAGES = 50;

interface GqlAuthor {
  login: string;
}
interface GqlComment {
  id: string;
  url: string;
  createdAt: string;
  bodyHTML: string;
  author: GqlAuthor | null;
}
interface GqlLineComment extends GqlComment {
  path: string;
  line: number | null;
  originalLine: number | null;
}
interface GqlReview {
  id: string;
  url: string;
  state: string;
  submittedAt: string | null;
  createdAt: string;
  bodyHTML: string;
  author: GqlAuthor | null;
  comments: { totalCount: number; nodes: GqlLineComment[] };
}
interface Page<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}
interface GqlDetail {
  __typename: 'Issue' | 'PullRequest';
  id: string;
  number: number;
  title: string;
  url: string;
  state: string;
  merged?: boolean;
  isDraft?: boolean;
  createdAt: string;
  bodyHTML: string;
  author: GqlAuthor | null;
  labels: { nodes: { name: string; color: string }[] };
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  headRefOid?: string;
  baseRefName?: string;
  headRefName?: string;
  commits?: { nodes: { commit: { oid: string; statusCheckRollup: { state: string } | null } }[] };
  comments?: Page<GqlComment>;
  reviews?: Page<GqlReview>;
}
interface GqlDetailResponse {
  repository: {
    mergeCommitAllowed: boolean;
    squashMergeAllowed: boolean;
    rebaseMergeAllowed: boolean;
    issueOrPullRequest: GqlDetail | null;
  } | null;
}

export interface RawDetail {
  item: GqlDetail;
  comments: GqlComment[];
  reviews: GqlReview[];
  mergeMethods: MergeMethod[];
}

/** Read the whole detail (all pages) or throw: a half-read discussion is never shown as complete. */
export async function fetchRawDetail(client: GitHubClient, repo: string, number: number): Promise<RawDetail> {
  const [owner, name] = repo.split('/');
  const comments: GqlComment[] = [];
  const reviews: GqlReview[] = [];
  let commentsAfter: string | null = null;
  let reviewsAfter: string | null = null;
  let withComments = true;
  let withReviews = true;
  let first: GqlDetail | null = null;
  let mergeMethods: MergeMethod[] = [];
  for (let page = 0; withComments || withReviews; page++) {
    if (page >= MAX_PAGES) throw new GitHubError('http', `评论分页超过 ${MAX_PAGES} 页，已停止`);
    const data: GqlDetailResponse = await client.graphql<GqlDetailResponse>(ITEM_DETAIL_QUERY, {
      owner,
      name,
      number,
      commentsAfter,
      reviewsAfter,
      withComments,
      withReviews,
    });
    const it = data.repository?.issueOrPullRequest;
    if (!data.repository || !it) throw new GitHubError('graphql', `找不到 ${repo}#${number}（不存在，或当前账号没有权限）`);
    if (!first) {
      first = it;
      const r = data.repository;
      mergeMethods = [
        ...(r.mergeCommitAllowed ? (['merge'] as const) : []),
        ...(r.squashMergeAllowed ? (['squash'] as const) : []),
        ...(r.rebaseMergeAllowed ? (['rebase'] as const) : []),
      ];
    }
    if (withComments) {
      if (!it.comments) throw new GitHubError('graphql', 'GitHub 回应缺少评论列表');
      comments.push(...it.comments.nodes);
      withComments = it.comments.pageInfo.hasNextPage;
      commentsAfter = it.comments.pageInfo.endCursor;
      if (withComments && !commentsAfter) throw new GitHubError('graphql', '评论分页缺少游标');
    }
    if (withReviews) {
      // an issue has no reviews: the PR branch of the query is simply absent
      if (it.__typename === 'PullRequest') {
        if (!it.reviews) throw new GitHubError('graphql', 'GitHub 回应缺少评审列表');
        reviews.push(...it.reviews.nodes);
        withReviews = it.reviews.pageInfo.hasNextPage;
        reviewsAfter = it.reviews.pageInfo.endCursor;
        if (withReviews && !reviewsAfter) throw new GitHubError('graphql', '评审分页缺少游标');
      } else withReviews = false;
    }
  }
  return { item: first!, comments, reviews, mergeMethods };
}

const desc = (a: { at: string }, b: { at: string }) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);

/**
 * Newest first. The opening post is the oldest entry, so it comes last.
 * A review sits at the time it was submitted, its line comments under it
 * (newest first too). Pending reviews (an unsent draft) are not shown.
 */
export function buildTimeline(raw: Pick<RawDetail, 'item' | 'comments' | 'reviews'>): TimelineEntry[] {
  const it = raw.item;
  const out: TimelineEntry[] = [];
  for (const c of raw.comments) {
    out.push({ kind: 'comment', id: c.id, url: c.url, author: c.author?.login ?? null, at: c.createdAt, bodyHtml: c.bodyHTML });
  }
  for (const r of raw.reviews) {
    if (r.state === 'PENDING') continue;
    const lineComments = r.comments.nodes
      .map((c) => ({
        id: c.id,
        url: c.url,
        author: c.author?.login ?? null,
        at: c.createdAt,
        path: c.path,
        line: c.line ?? c.originalLine ?? null,
        bodyHtml: c.bodyHTML,
      }))
      .sort(desc);
    out.push({
      kind: 'review',
      id: r.id,
      url: r.url,
      author: r.author?.login ?? null,
      at: r.submittedAt ?? r.createdAt,
      bodyHtml: r.bodyHTML,
      reviewState: r.state,
      lineComments,
      moreLineComments: Math.max(0, r.comments.totalCount - r.comments.nodes.length),
    });
  }
  out.sort(desc);
  out.push({ kind: 'body', id: it.id, url: it.url, author: it.author?.login ?? null, at: it.createdAt, bodyHtml: it.bodyHTML });
  return out;
}

export function toDetail(repo: string, raw: RawDetail, fetchedAt: number): ItemDetail {
  const it = raw.item;
  const isPr = it.__typename === 'PullRequest';
  let pr: PrStatus | null = null;
  if (isPr) {
    pr = {
      isDraft: Boolean(it.isDraft),
      merged: Boolean(it.merged),
      mergeable: it.mergeable ?? 'UNKNOWN',
      mergeStateStatus: it.mergeStateStatus ?? 'UNKNOWN',
      reviewDecision: it.reviewDecision ?? null,
      checks: it.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? null,
      headOid: it.headRefOid ?? '',
      baseRef: it.baseRefName ?? '',
      headRef: it.headRefName ?? '',
      mergeMethods: raw.mergeMethods,
    };
  }
  return {
    key: itemKey(repo, it.number),
    repo,
    number: it.number,
    kind: isPr ? 'pr' : 'issue',
    title: it.title,
    url: it.url,
    state: isPr && it.merged ? 'merged' : it.state === 'OPEN' ? 'open' : 'closed',
    timeline: buildTimeline(raw),
    pr,
    fetchedAt,
    labels: it.labels.nodes.map((l) => ({ name: l.name, color: l.color })),
  };
}
