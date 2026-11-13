// The detail page of one issue / PR: read it whole from GitHub (every page
// of comments and reviews), and order it newest first. The rendered HTML is
// GitHub's own (bodyHTML); it is only ever shown inside the isolated view.

import { t, zhKey } from '../shared/i18n';
import type { ItemDetail, MergeMethod, PrStatus, TaskEntry, TimelineEntry } from '../shared/actions';
import { itemKey } from '../shared/sources';
import { GitHubClient, GitHubError } from './github';
import { ITEM_DETAIL_QUERY, REVIEW_COMMENTS_QUERY } from './queries';
import { planTasks, renderedTaskBoxes } from './taskList';
import { wallSecsOf } from '../shared/agentMetrics';

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
  /** markdown source and "may this account change it" (issue / PR comments; GitHub#193) */
  body?: string;
  viewerCanUpdate?: boolean;
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
  comments: Page<GqlLineComment>;
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
  body?: string;
  viewerCanUpdate?: boolean;
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
    if (page >= MAX_PAGES) throw new GitHubError('http', t('评论分页超过 {n} 页，已停止', { n: MAX_PAGES }));
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
    if (!data.repository || !it) throw new GitHubError('graphql', t('找不到 {repo}#{number}（不存在，或当前账号没有权限）', { repo, number }));
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
      if (!it.comments) throw new GitHubError('graphql', t('GitHub 回应缺少评论列表'));
      comments.push(...it.comments.nodes);
      withComments = it.comments.pageInfo.hasNextPage;
      commentsAfter = it.comments.pageInfo.endCursor;
      if (withComments && !commentsAfter) throw new GitHubError('graphql', t('评论分页缺少游标'));
    }
    if (withReviews) {
      // an issue has no reviews: the PR branch of the query is simply absent
      if (it.__typename === 'PullRequest') {
        if (!it.reviews) throw new GitHubError('graphql', t('GitHub 回应缺少评审列表'));
        reviews.push(...it.reviews.nodes);
        withReviews = it.reviews.pageInfo.hasNextPage;
        reviewsAfter = it.reviews.pageInfo.endCursor;
        if (withReviews && !reviewsAfter) throw new GitHubError('graphql', t('评审分页缺少游标'));
      } else withReviews = false;
    }
  }
  // a review's line comments come 100 at a time: read every review's remaining pages
  for (const r of reviews) {
    let page = r.comments;
    const all = [...page.nodes];
    for (let n = 0; page.pageInfo.hasNextPage; n++) {
      if (n >= MAX_PAGES) throw new GitHubError('http', t('逐行评论分页超过 {n} 页，已停止', { n: MAX_PAGES }));
      if (!page.pageInfo.endCursor) throw new GitHubError('graphql', t('逐行评论分页缺少游标'));
      const d: { node: { comments?: Page<GqlLineComment> } | null } = await client.graphql(REVIEW_COMMENTS_QUERY, { id: r.id, after: page.pageInfo.endCursor });
      if (!d.node?.comments) throw new GitHubError('graphql', t('读不到评审的逐行评论'));
      page = d.node.comments;
      all.push(...page.nodes);
    }
    r.comments = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: all };
  }
  return { item: first!, comments, reviews, mergeMethods };
}

/**
 * Can the boxes of this body / comment be clicked (GitHub#193)? Only with its source
 * and GitHub's "you may change it" both read, and the source agreeing with the
 * rendering box for box. Anything not read is read-only, never "probably fine".
 */
export function taskEntry(html: string, source: unknown, canUpdate: unknown): TaskEntry | undefined {
  if (!renderedTaskBoxes(html).length) return undefined;
  if (typeof source !== 'string' || typeof canUpdate !== 'boolean') return { clickable: false, why: zhKey('没读到这一条的原文或修改权限，勾选框只读') };
  if (!canUpdate) return { clickable: false, why: zhKey('GitHub 说你没有权限改这一条，勾选框只读') };
  const plan = planTasks(source, html);
  if (!plan.ok) return { clickable: false, why: plan.why };
  return { clickable: true, source };
}

/**
 * GitHub#205: a body / comment can be edited only with its source read and GitHub's
 * "you may change it" saying yes; anything not read is not editable.
 */
export function editSource(source: unknown, canUpdate: unknown): { editSource: string } | Record<string, never> {
  return typeof source === 'string' && canUpdate === true ? { editSource: source } : {};
}

/** GitHub#503: the round's total time, only when the source ends with a valid usage record. */
function wallSecs(source: unknown): { wallSecs: number } | Record<string, never> {
  const n = wallSecsOf(source);
  return n === undefined ? {} : { wallSecs: n };
}

/** Boxes in a review or a line comment stay read-only: ticking them is left to the web page. */
const REVIEW_TASKS: TaskEntry = { clickable: false, why: zhKey('评审意见里的勾选框只能在网页上勾') };

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
    const tasks = taskEntry(c.bodyHTML, c.body, c.viewerCanUpdate);
    out.push({ kind: 'comment', id: c.id, url: c.url, author: c.author?.login ?? null, at: c.createdAt, bodyHtml: c.bodyHTML, ...(tasks ? { tasks } : {}), ...editSource(c.body, c.viewerCanUpdate), ...wallSecs(c.body) });
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
      ...(renderedTaskBoxes(r.bodyHTML).length ? { tasks: REVIEW_TASKS } : {}),
      reviewState: r.state,
      lineComments,
    });
  }
  out.sort(desc);
  const tasks = taskEntry(it.bodyHTML, it.body, it.viewerCanUpdate);
  out.push({ kind: 'body', id: it.id, url: it.url, author: it.author?.login ?? null, at: it.createdAt, bodyHtml: it.bodyHTML, ...(tasks ? { tasks } : {}), ...editSource(it.body, it.viewerCanUpdate), ...wallSecs(it.body) });
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
    canEdit: it.viewerCanUpdate === true,
  };
}
