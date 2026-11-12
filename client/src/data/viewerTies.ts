// GitHub#373: how the signed-in account stands to an item — does it subscribe to it, who is
// asked to review it, and (a pull request) which issues GitHub lists as linked to it. Read with the item by every reader (the board read, the repository batch,
// the one-item re-read) through `readViewerTies`, merged across sources by `mergedViewerTies`.
//
// Unknown is never "no": a field GitHub did not answer in a shape this client knows, or a review
// list cut short, reads as null; a copy that was never asked (a cache written before #373, a
// closed item of a repository list) has no `viewerAt` and gives way to any copy that has one.

import type { Item, ReviewRequested } from '../shared/types';
import { itemKey } from '../shared/sources';

/** The fields VIEWER_ISSUE_FIELDS / VIEWER_PR_FIELDS (queries.ts) ask for. */
export interface GqlViewerFields {
  viewerSubscription?: string | null;
  reviewRequests?: {
    totalCount?: number | null;
    nodes?: ({ requestedReviewer?: { __typename?: string; login?: string | null } | null } | null)[] | null;
  } | null;
  closingIssuesReferences?: {
    totalCount?: number | null;
    nodes?: ({ number?: number | null; repository?: { nameWithOwner?: string | null } | null } | null)[] | null;
  } | null;
}

export type ViewerTies = Required<Pick<Item, 'viewerSubscribed' | 'reviewRequested' | 'closingIssues' | 'viewerAt'>>;

const NOBODY: ReviewRequested = { users: [], others: false };

function subscribed(v: string | null | undefined): boolean | null {
  if (v === 'SUBSCRIBED') return true;
  // IGNORED: the account muted the item — it does not follow it either
  if (v === 'UNSUBSCRIBED' || v === 'IGNORED') return false;
  return null;
}

function reviewers(r: GqlViewerFields['reviewRequests']): ReviewRequested | null {
  if (!r || !Array.isArray(r.nodes) || typeof r.totalCount !== 'number') return null;
  // more requests than this read returned: the signed-in account may be among the rest
  if (r.totalCount > r.nodes.length) return null;
  const users = new Set<string>();
  let others = false;
  for (const n of r.nodes) {
    const who = n?.requestedReviewer;
    if (who?.__typename === 'User' && typeof who.login === 'string' && who.login !== '') users.add(who.login.toLowerCase());
    // a team (its members cannot be read without the organisation's permission), a bot, a
    // reviewer GitHub does not show: somebody else was asked
    else others = true;
  }
  return { users: [...users].sort(), others };
}

/** The issues GitHub lists as linked to a pull request; null when the list is cut short or an entry cannot be read. */
function closing(r: GqlViewerFields['closingIssuesReferences']): string[] | null {
  if (!r || !Array.isArray(r.nodes) || typeof r.totalCount !== 'number') return null;
  if (r.totalCount > r.nodes.length) return null;
  const keys = new Set<string>();
  for (const n of r.nodes) {
    const repo = n?.repository?.nameWithOwner;
    if (typeof repo !== 'string' || repo === '' || typeof n?.number !== 'number') return null;
    keys.add(itemKey(repo, n.number));
  }
  return [...keys].sort();
}

/**
 * What one read says, or null when the answer does not carry the fields at all (a reader that did
 * not ask). `readAt` = when that read went out. An issue has no review requests: known-empty.
 */
export function readViewerTies(c: GqlViewerFields, kind: 'issue' | 'pr', readAt: number): ViewerTies | null {
  if (c.viewerSubscription === undefined) return null;
  return {
    viewerSubscribed: subscribed(c.viewerSubscription),
    reviewRequested: kind === 'pr' ? reviewers(c.reviewRequests) : NOBODY,
    closingIssues: kind === 'pr' ? closing(c.closingIssuesReferences) : [],
    viewerAt: readAt,
  };
}

/** Does this copy carry an answer (known or unknown)? */
function has(it: Item): it is Item & { viewerAt: number } {
  return it.viewerAt !== undefined;
}

/**
 * The two fields of one item held by two sources. The copy read later wins (`viewerAt`), a copy
 * never asked gives way. Read at the same moment (two sources of one round) and disagreeing: the
 * answer that reminds rather than not — unknown stays unknown, subscribed by either is subscribed,
 * the people asked are everybody either names, the linked issues are every one either lists. Every rule here is the same whichever copy comes
 * first, so the order of the sources never decides.
 */
export function mergedViewerTies(a: Item, b: Item): Partial<ViewerTies> {
  const pick = (x: Item & { viewerAt: number }): ViewerTies => ({
    viewerSubscribed: x.viewerSubscribed ?? null,
    reviewRequested: x.reviewRequested ?? null,
    closingIssues: x.closingIssues ?? null,
    viewerAt: x.viewerAt,
  });
  if (!has(a)) return has(b) ? pick(b) : {};
  if (!has(b)) return pick(a);
  if (a.viewerAt !== b.viewerAt) return pick(a.viewerAt > b.viewerAt ? a : b);
  const x = pick(a);
  const y = pick(b);
  const viewerSubscribed = x.viewerSubscribed === null || y.viewerSubscribed === null ? null : x.viewerSubscribed || y.viewerSubscribed;
  const reviewRequested =
    x.reviewRequested === null || y.reviewRequested === null
      ? null
      : { users: [...new Set([...x.reviewRequested.users, ...y.reviewRequested.users])].sort(), others: x.reviewRequested.others || y.reviewRequested.others };
  const closingIssues = x.closingIssues === null || y.closingIssues === null ? null : [...new Set([...x.closingIssues, ...y.closingIssues])].sort();
  return { viewerSubscribed, reviewRequested, closingIssues, viewerAt: x.viewerAt };
}
