// What the window may ask the app to change on GitHub, and what an item's
// detail page shows. Shared by the main process, the data layer and the
// renderer: no Node, no Electron in here.

import type { Label } from './types';
import type { Handoff } from './handoff';

/**
 * Every write the client can make. Each one is sent to GitHub as it is; the
 * app never queues a write for later (offline = refused, nothing sent).
 * `key` is the item (`owner/repo#N`, see itemKey).
 */
export type WriteAction =
  /** `color`: the label's colour, so it can be shown before GitHub confirms (GitHub#229); optional */
  | { kind: 'addLabel'; key: string; label: string; color?: string }
  | { kind: 'removeLabel'; key: string; label: string }
  /** title = a milestone of the item's own repository with this title; null = remove the milestone */
  | { kind: 'setMilestone'; key: string; title: string | null }
  /** one Project's iteration of the item: iteration id of that Project, null = clear */
  | { kind: 'setIteration'; key: string; projectKey: string; iterationId: string | null }
  /** one Project's status of the item: option name of that Project, null = clear */
  | { kind: 'setStatus'; key: string; projectKey: string; status: string | null }
  /** an item not on that Project yet: add it, then set the iteration (asked first in the window) */
  | { kind: 'addToProject'; key: string; projectKey: string; iterationId: string | null; status: string | null }
  /** `draftOf` (GitHub#250): the reply carries the kept comment of that operation — sent = that draft is done, wherever the panel is by then */
  | { kind: 'comment'; key: string; body: string; draftOf?: string }
  /**
   * remove the "waiting for a human" label, add the "agent, go" one (names from Settings).
   * GitHub#451: `comment` (the reply box's text) goes out first, and the labels only once it did —
   * the daemon dispatches on the label, so the comment must be there when it looks. Blank / absent =
   * labels only. `draftOf`: the text carries that earlier operation's kept comment, which moves into this one
   */
  | { kind: 'handBack'; key: string; comment?: string; draftOf?: string }
  /** GitHub#205: add the autopilot label (name from Settings), then hand to the agent as above (`comment` / `draftOf` likewise) */
  | { kind: 'autopilot'; key: string; comment?: string; draftOf?: string }
  /** headOid: the commit the user saw; GitHub refuses the merge if the PR moved since */
  | { kind: 'merge'; key: string; method: MergeMethod; headOid: string }
  | { kind: 'closePr'; key: string; comment: string }
  /** close an issue with GitHub's close reason; the comment (optional) is sent only once the close went through */
  | { kind: 'closeIssue'; key: string; reason: IssueCloseReason; comment: string }
  /**
   * `projects`: the Project sources (keys) the new issue joins, ticked one by one in the dialog (GitHub#205).
   * `plan` (GitHub#214, the "+" of a table group): exactly what the dialog showed it would
   * set — never re-derived when writing, only checked again; absent = the plain new issue.
   * `handoff` (GitHub#245): hand the new issue to the agent / autopilot in the same request — the
   * labels come from Settings and are checked against a fresh read of the repository's labels;
   * absent = 'none'. `handoffPicked`: chosen by hand in the dialog — the app remembers it once the issue exists
   */
  | { kind: 'createIssue'; repo: string; title: string; body: string; labels: string[]; projects: string[]; plan?: CreatePlan; handoff?: Handoff; handoffPicked?: boolean; picks?: Picks }
  /**
   * tick / untick one task-list box of a body or comment (GitHub#193): `entryId` is the
   * body's / comment's node id, `index` the box's number in it (document order),
   * `seenSource` the markdown source the click was made on — nothing is written
   * unless GitHub still holds exactly that
   */
  | { kind: 'toggleTask'; key: string; entryId: string; index: number; checked: boolean; seenSource: string }
  /**
   * GitHub#205: replace the whole markdown of a body or comment (`entryId`, its node id) with
   * `body` — written only while GitHub still holds `seenSource`, the text the edit started from
   */
  | { kind: 'editEntry'; key: string; entryId: string; body: string; seenSource: string }
  /**
   * GitHub#299: change the title of an issue / PR to `title` — written only while GitHub still
   * holds `seenTitle`, the title shown when the edit started
   */
  | { kind: 'editTitle'; key: string; title: string; seenTitle: string };

export type MergeMethod = 'merge' | 'squash' | 'rebase';

/**
 * The value of one table group (GitHub#214): what a new issue made from that
 * group's "+" carries. `none` = a "no iteration / no status / no milestone" group
 * (`field`: which one, GitHub#276), or the whole table when it is not grouped / the
 * plain "新建" button (no `field`).
 */
export type GroupPreset =
  | { by: 'iteration'; title: string; startDate: string }
  | { by: 'status'; status: string }
  | { by: 'milestone'; title: string }
  | { by: 'repo'; repo: string }
  | { by: 'none'; field?: 'iteration' | 'status' | 'milestone' };

/**
 * GitHub#372: the dialog's iteration and milestone pickers. `null` = not touched: the value the
 * group (or the plain "新建") gives, exactly as before the pickers existed.
 *   iteration: `auto` = the iteration today falls in, per ticked board (GitHub#276); `none` = none;
 *              `set` = this one (same title and start date — the key the table groups by) on every
 *              ticked board that has it.
 *   milestone: `none` = none; `set` = the repository's milestone with that title (an open one first).
 */
export type IterationPick = { kind: 'auto' } | { kind: 'none' } | { kind: 'set'; title: string; startDate: string };
export type MilestonePick = { kind: 'none' } | { kind: 'set'; title: string };
export interface Picks {
  iteration: IterationPick | null;
  milestone: MilestonePick | null;
}

/**
 * What a new issue from a group's "+" sets, as confirmed in the dialog (GitHub#214).
 * `milestone: null` = explicitly none. `projects` = every Project the issue joins
 * (the ones ticked when the dialog showed it), each with its iteration / status or null = none.
 */
export interface CreatePlan {
  milestone: { number: number; title: string } | null;
  projects: { projectKey: string; iterationId: string | null; status: string | null }[];
  /**
   * GitHub#258: boards NOT ticked whose field is set only if GitHub's own auto-add puts the
   * issue there and the field is still empty (`label`: the group's value as shown)
   */
  watch?: { projectKey: string; iterationId: string | null; status: string | null; label: string }[];
}

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
  /**
   * GitHub#488: a label / milestone / status / iteration change the controller recorded — its outcome is
   * held in the list of changes and said in the window's notice area (failed, not confirmed) or by the
   * field itself (saved). Unset: refused before anything was recorded, the caller says why.
   */
  held?: boolean;
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
  /** GitHub#205: the markdown source, present only when GitHub says this account may change it (body / comment) */
  editSource?: string;
  /**
   * GitHub#503: this round's total time in seconds, from the usage record on the last line of
   * the markdown source (body / comment only); absent when there is no valid record.
   */
  wallSecs?: number;
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
  /**
   * GitHub#299: GitHub says this account may change the item itself (its title, its opening post).
   * Absent (a detail cached by an older version) = not known: no edit button until it is read again
   */
  canEdit?: boolean;
}

export type DetailResult = { ok: true; detail: ItemDetail } | { ok: false; error: string };
