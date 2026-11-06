// What the window may ask the app to change on GitHub, and what an item's
// detail page shows. Shared by the main process, the data layer and the
// renderer: no Node, no Electron in here.

import type { Label } from './types';

/**
 * Every write the client can make. Each one is sent to GitHub as it is; the
 * app never queues a write for later (offline = refused, nothing sent).
 * `key` is the item (`owner/repo#N`, see itemKey).
 */
export type WriteAction =
  | { kind: 'addLabel'; key: string; label: string }
  | { kind: 'removeLabel'; key: string; label: string }
  /** title = a milestone of the item's own repository with this title; null = remove the milestone */
  | { kind: 'setMilestone'; key: string; title: string | null }
  /** one Project's iteration of the item: iteration id of that Project, null = clear */
  | { kind: 'setIteration'; key: string; projectKey: string; iterationId: string | null }
  /** one Project's status of the item: option name of that Project, null = clear */
  | { kind: 'setStatus'; key: string; projectKey: string; status: string | null }
  /** an item not on that Project yet: add it, then set the iteration (asked first in the window) */
  | { kind: 'addToProject'; key: string; projectKey: string; iterationId: string | null; status: string | null }
  | { kind: 'comment'; key: string; body: string }
  /** remove the "waiting for a human" label, add the "agent, go" one (names from Settings) */
  | { kind: 'handBack'; key: string }
  /** headOid: the commit the user saw; GitHub refuses the merge if the PR moved since */
  | { kind: 'merge'; key: string; method: MergeMethod; headOid: string }
  | { kind: 'closePr'; key: string; comment: string }
  /** close an issue with GitHub's close reason; the comment (optional) is sent only once the close went through */
  | { kind: 'closeIssue'; key: string; reason: IssueCloseReason; comment: string }
  | { kind: 'createIssue'; repo: string; title: string; body: string; labels: string[] }
  /**
   * tick / untick one task-list box of a body or comment (GitHub#193): `entryId` is the
   * body's / comment's node id, `index` the box's number in it (document order),
   * `seenSource` the markdown source the click was made on — nothing is written
   * unless GitHub still holds exactly that
   */
  | { kind: 'toggleTask'; key: string; entryId: string; index: number; checked: boolean; seenSource: string };

export type MergeMethod = 'merge' | 'squash' | 'rebase';

/** The close reasons the client offers (GitHub#180). "Duplicate" needs the issue it duplicates: web only. */
export type IssueCloseReason = 'completed' | 'not_planned';
export const ISSUE_CLOSE_REASONS: readonly IssueCloseReason[] = ['completed', 'not_planned'];

export interface WriteResult {
  ok: boolean;
  /** why GitHub (or the app, before sending anything) refused; null when ok */
  error: string | null;
  /** done, but something after it did not work (e.g. re-reading it, a follow-up step) */
  warning: string | null;
  /** createIssue: the new item's key */
  createdKey?: string;
}

export interface RepoOptions {
  labels: Label[];
  milestones: { number: number; title: string; state: 'open' | 'closed'; dueOn: string | null }[];
  error: string | null;
}

export interface Author {
  login: string | null;
}

/**
 * Whether an entry's task-list boxes can be clicked (GitHub#193): only when GitHub
 * says this account may change it and its markdown source agrees box for box with
 * GitHub's rendering. `source` is the markdown the boxes were checked against.
 */
export type TaskEntry = { clickable: true; source: string } | { clickable: false; why: string };

/** One entry of the detail timeline. bodyHtml is GitHub's rendered HTML, shown only in the isolated view. */
export interface TimelineEntry {
  kind: 'body' | 'comment' | 'review';
  id: string;
  url: string;
  author: string | null;
  /** ISO time the entry is ordered by */
  at: string;
  bodyHtml: string;
  /** review only: APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED */
  reviewState?: string;
  /** the task-list boxes in bodyHtml (GitHub#193); absent when it has none */
  tasks?: TaskEntry;
  /** review only: its line comments, newest first */
  lineComments?: { id: string; url: string; author: string | null; at: string; path: string; line: number | null; bodyHtml: string }[];
}

export interface PrStatus {
  isDraft: boolean;
  merged: boolean;
  /** MERGEABLE / CONFLICTING / UNKNOWN */
  mergeable: string;
  /** CLEAN / BLOCKED / BEHIND / DIRTY / UNSTABLE / HAS_HOOKS / DRAFT / UNKNOWN */
  mergeStateStatus: string;
  /** APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / null */
  reviewDecision: string | null;
  /** SUCCESS / FAILURE / PENDING / ERROR / EXPECTED / null (no checks) */
  checks: string | null;
  headOid: string;
  baseRef: string;
  headRef: string;
  /** the merge methods the repository allows */
  mergeMethods: MergeMethod[];
}

export interface ItemDetail {
  key: string;
  repo: string;
  number: number;
  kind: 'issue' | 'pr';
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  /** newest first; the opening post (body) is the oldest, so it is last */
  timeline: TimelineEntry[];
  pr: PrStatus | null;
  /** epoch ms the detail was read */
  fetchedAt: number;
  labels: Label[];
}

export type DetailResult = { ok: true; detail: ItemDetail } | { ok: false; error: string };
