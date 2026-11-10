// Types shared by the main process, the data layer and the renderer.
// Nothing in here may import Node or Electron: the renderer bundles it.

import type { MergePrefs } from './mergePrefs';
import type { LaneFolds, TableFolds } from './uiPrefs';
import type { OpRecord } from './ops';
import type { Handoff } from './handoff';

/**
 * The app updating itself (GitHub#184), as the shell reports it (src-tauri/crates/core/src/update.rs
 * decides; src-tauri/src/updater.rs installs). null from `updateStatus` = this build does not update itself.
 */
export interface UpdateStatus {
  supported: true;
  /** the running version */
  current: string;
  /** automatic checks (at start, then every 6 hours) */
  auto: boolean;
  /** which releases it updates to (GitHub#215): the tagged releases, or also the development builds from main */
  channel: 'stable' | 'dev';
  /** why the development channel cannot be chosen on this machine (no development builds for it); null = it can */
  devUnavailable: string | null;
  /** why this build cannot update itself at all (it never looks) */
  problem: string | null;
  phase: 'idle' | 'checking' | 'downloading' | 'installing' | 'ready';
  /** downloading / installing / ready: the new version */
  version?: string;
  /** downloading: bytes so far, and the total when known */
  got?: number;
  total?: number | null;
  /** the "ready" banner was closed for this version */
  dismissed: string | null;
  /** the last finished round: when, and what it ended with (a failure never reads as "up to date") */
  last: { at: number; ok: boolean; message: string } | null;
  /** downloading / installing / ready: what every version up to the new one changed (GitHub#348); null = nothing to list */
  notes?: UpdateNotes | null;
  /** what the update this app was started from changed, and whether its notice was closed; null = nothing kept for this version */
  installed?: (UpdateNotes & { dismissed: boolean }) | null;
}

/** What the versions from `from` (not included) up to `to` changed, newest first — read by the shell out of the release list. */
export interface UpdateNotes {
  from: string;
  to: string;
  /** false = the running version's own release page is gone from GitHub, so older versions may be missing */
  complete: boolean;
  /** versions left out (more than the list holds) */
  more: number;
  entries: {
    version: string;
    /** when it was published (ISO), when GitHub said */
    at: string | null;
    /** plain text; `more` = the description behind the title. Empty = that release page says nothing readable */
    items: { title: string; more: string | null }[];
    /** items left out */
    more: number;
  }[];
}


export type ItemKind = 'issue' | 'pr';
export type ItemState = 'open' | 'closed' | 'merged';
/** why an issue was closed, as GitHub records it (lower-cased); a PR never has one */
export type IssueStateReason = 'completed' | 'not_planned' | 'duplicate' | 'reopened';

export interface Iteration {
  id: string;
  title: string;
  /** YYYY-MM-DD */
  startDate: string;
  /** days */
  duration: number;
}

/** One item's values inside one Project. Iterations and status belong to the Project. */
export interface ProjectMembership {
  projectKey: string;
  projectTitle: string;
  /** the Project item's node id (what field updates address); '' in snapshots cached before it was read */
  itemId: string;
  iteration: Iteration | null;
  status: string | null;
}

export interface Label {
  name: string;
  color: string;
}

export interface Milestone {
  title: string;
  /** ISO timestamp or null when the milestone has no due date */
  dueOn: string | null;
}

export interface LinkedPr {
  key: string;
  repo: string;
  number: number;
  url: string;
  state: ItemState;
}

/**
 * The other end of a relation (GitHub#349): what GitHub says about it while reading *this*
 * item's relations — enough to draw it even when it is in no configured source. No request
 * ever goes to its repository for it.
 */
export interface RelatedIssue {
  /** `owner/repo#N`, lower-cased owner/repo (same identity as Item.key) */
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: ItemState;
  stateReason: IssueStateReason | null;
}

/**
 * One issue's relations as GitHub records them (GitHub#349): every list read to its last page.
 * A pull request has none (GitHub keeps these for issues only): all empty.
 */
export interface ItemRelations {
  /** the parent issue with its title and state; null = none */
  parent: RelatedIssue | null;
  /** the sub-issues, in GitHub's order */
  subIssues: RelatedIssue[];
  /** issues this one waits for ("Blocked by") */
  blockedBy: RelatedIssue[];
  /** issues waiting for this one ("Blocking") */
  blocking: RelatedIssue[];
}

export interface Item {
  /** `owner/repo#N`, lower-cased owner/repo: the identity used for de-duplication. */
  key: string;
  /** GitHub node id of the issue / PR (adding it to a Project needs it) */
  nodeId: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  kind: ItemKind;
  state: ItemState;
  /** issues only: GitHub's close reason; null = none recorded / a PR / not read (a cache written before #172 lacks it) */
  stateReason: IssueStateReason | null;
  /** PRs only: GitHub's draft mark; null = an issue / not read (a cache written before #172 lacks it) */
  isDraft: boolean | null;
  updatedAt: string;
  labels: Label[];
  assignees: string[];
  milestone: Milestone | null;
  /** login of whoever opened it (null: unknown / deleted account) */
  author: string | null;
  /** key (`owner/repo#N`) of the parent issue; null = none */
  parent: string | null;
  /** sub-issue progress; null = no sub-issues */
  subIssues: { total: number; completed: number } | null;
  /** pull requests linked to an issue (GitHub's "Linked pull requests"); null = not known for this source (repository lists do not carry them) */
  linkedPrs: LinkedPr[] | null;
  /**
   * PRs only (GitHub#275): keys of the issues the PR's description names with
   * Closes / Fixes / Resolves / Refs #N. GitHub lists only the closing ones as
   * linked, and an autopilot PR writes only `Refs #N`. Absent = none (or a cache
   * written before #275). Used to place a PR under its issue, never to decide
   * which issues a merge closes.
   */
  refIssues?: string[];
  /**
   * GitHub#349: parent, sub-issues, blocked-by and blocking, read whole with the item. Absent =
   * unknown — a cache written before #349 — and never "no relations" (that is four empty fields).
   */
  relations?: ItemRelations;
  /**
   * GitHub#349: epoch ms of the read that brought `relations` — the full read of the source, or
   * the one-item re-read (which leaves the snapshot's own time alone). The other end of a relation
   * changes without this item's `updatedAt` moving (a blocker is closed), so when two sources hold
   * the item, this — never `updatedAt` — says whose relations are newer.
   */
  relationsAt?: number;
  projects: ProjectMembership[];
  /** keys of the sources this item came from (filled when sources are merged) */
  sources: string[];
  /** GitHub#229: changes of this item not yet confirmed by GitHub (only on board data, never in the cache) */
  edits?: EditMark[];
}

/**
 * One change shown before GitHub confirmed it (GitHub#229), as the views see it.
 * saving / verifying / observing: the item already shows the new value;
 * unconfirmed / failed: the item shows GitHub's value, the view shows this one beside it.
 */
export interface EditMark {
  id: string;
  field: 'label' | 'milestone' | 'status' | 'iteration';
  label?: string;
  color?: string;
  projectKey?: string;
  status: 'saving' | 'verifying' | 'observing' | 'unconfirmed' | 'failed';
  /** what the user wants, in words ("加上「x」", a milestone title, "（无状态）", …) */
  targetText: string;
  /** GitHub's value as last read (words + when), or why it could not be read; null = not read since */
  github: { text: string; at: number } | { unreadable: string; at: number } | null;
  /** GitHub's value (as last read) differs from the value before the first click */
  changedByOthers: boolean;
  /** why it is not saved: GitHub's refusal, or "read a value an earlier unanswered change wrote" */
  failure: string | null;
  /** a resend held back (GitHub changed meanwhile / could not be read): what the button asks to confirm */
  hold: { kind: 'changed' | 'unreadable'; text: string } | null;
}

/**
 * A new issue being created, or what came of it (GitHub#229): the dialog closes
 * at once, the result shows above the board. Only `failed` (nothing was created
 * for sure) gives the draft back with a create button.
 */
/** One board a created issue is not finished on (GitHub#229). */
export interface CreateBoard {
  projectKey: string;
  title: string;
  state: 'missing' | 'fieldsFailed';
  /** GitHub's words for what went wrong last time */
  reason: string;
  /** what the board was meant to carry */
  iterationId: string | null;
  status: string | null;
}

/**
 * GitHub#258: a board not ticked in the dialog that may take the new issue in by itself
 * (its auto-add workflow), and what came of it so far.
 *   looking    — not seen there yet; looked at again on a schedule
 *   written    — the empty field was set; checked again shortly
 *   human      — the field holds another value (`seen`): never overwritten automatically, the notice offers a button
 *   failed     — the write was refused (`reason`)
 *   unverified — written, but the check could not read it back
 *   unread     — every look failed: whether it is there is unknown
 * A board that never took the issue in, or one done, is dropped from the list.
 */
export interface CreateWatch {
  projectKey: string;
  title: string;
  iterationId: string | null;
  status: string | null;
  /** the group's value, as the notice names it */
  label: string;
  state: 'looking' | 'written' | 'human' | 'failed' | 'unverified' | 'unread';
  /** human: the value the board holds, as last read (what the button overwrites) */
  seen?: string | null;
  reason?: string;
  /** automatic writes made so far (at most one) */
  writes: number;
  /** a button click is being carried out */
  busy?: boolean;
  /** which addition of that board's source this watch belongs to (removed / added again → over) */
  epoch: number;
}

export interface CreateJob {
  id: number;
  repo: string;
  title: string;
  /** `watching` (GitHub#258): created, nothing to say; boards not ticked are still being watched — no notice */
  status: 'running' | 'partial' | 'unknown' | 'failed' | 'watching';
  message: string | null;
  /** partial: the new issue */
  createdKey?: string;
  number?: number;
  /**
   * partial: every board still unfinished (code review round 3: kept across retries — a retry
   * only changes the boards it worked on). `missing` = not on the board yet (a retry adds it,
   * then sets its fields); `fieldsFailed` = on the board, a field it was meant to carry not set
   * (set it in the detail; a retry does not touch it). The notice goes when the list is empty.
   */
  boards?: CreateBoard[];
  /** partial: the new issue's node id from GitHub's create answer (what a retry adds to a board) */
  createdNodeId?: string;
  /** partial (GitHub#245): labels GitHub dropped from the new issue — stays in the notice until dismissed; a board retry never clears it */
  labelsNote?: string;
  /** GitHub#258: boards not ticked that are watched for taking the issue in by themselves */
  watch?: CreateWatch[];
  /** unknown: same-title issues this account opened in this repository lately (links only) */
  candidates?: { number: number; url: string; createdAt: string }[];
  /** what was typed, for "copy" (unknown) and "reopen the draft" (failed) */
  draft: { repo: string; title: string; body: string; labels: string[]; projects: string[]; handoff?: Handoff; handoffPicked?: boolean };
  /** GitHub#357: "再试加入看板" is being carried out (set before its first wait, cleared on every way out) */
  retrying?: boolean;
  /**
   * GitHub#357: why the last "再试加入看板" / "在某看板改成…" did not do it (or could not start).
   * Cleared the moment the next one starts, so a notice never shows "running" and the failure
   * before it together. It lives on the job, not in the bar that was clicked: every view of the
   * notice shows the same.
   */
  actionError?: string | null;
  /** GitHub#357: unknown — the look for same-title issues is running */
  looking?: boolean;
  /** GitHub#357: unknown — why that look could not be done */
  lookError?: string | null;
}

export interface FieldOption {
  id: string;
  name: string;
}

export interface ProjectMeta {
  key: string;
  title: string;
  url: string;
  /** GitHub node id of the Project */
  projectId: string;
  /** may the signed-in account change this Project's fields / items? (GitHub's viewerCanUpdate) */
  viewerCanUpdate: boolean;
  iterationFieldId: string | null;
  statusFieldId: string | null;
  /** the "Status" options with their ids, in field order (statusOptions is the same list by name) */
  statusOptionIds: FieldOption[];
  hasIterationField: boolean;
  /** every iteration the field knows, active and completed */
  iterations: Iteration[];
  /** options of the "Status" single-select field, in field order */
  statusOptions: string[];
  /** the Project's saved web views, in tab order (imported when the Project is added) */
  views: SavedView[];
}

/** One field as a saved view refers to it: GitHub's name and data type (TITLE, ITERATION, SINGLE_SELECT, …). */
export interface ViewField {
  name: string;
  dataType: string;
}

/** A view saved on the GitHub Project page, as the API returns it. */
export interface SavedView {
  number: number;
  name: string;
  /** BOARD_LAYOUT / TABLE_LAYOUT / ROADMAP_LAYOUT */
  layout: string;
  filter: string;
  groupBy: ViewField[];
  verticalGroupBy: ViewField[];
  sortBy: { field: ViewField; direction: 'ASC' | 'DESC' }[];
  fields: ViewField[];
}

export type SourceConfig =
  | {
      kind: 'project';
      key: string;
      ownerType: 'org' | 'user';
      owner: string;
      number: number;
      url: string;
      /** `/views/N` in the pasted address: the saved view to import (none = the first view) */
      view?: number;
    }
  | { kind: 'repo'; key: string; owner: string; name: string };

export interface SourceSnapshot {
  sourceKey: string;
  /** epoch ms of the sync that produced this snapshot */
  fetchedAt: number;
  items: Item[];
  project?: ProjectMeta;
}

export interface SourceTimes {
  sourceKey: string;
  /** epoch ms of the full read whose data is shown */
  readAt: number | null;
  /** epoch ms of the latest full read or "nothing changed" answer; never before `readAt` */
  checkedAt: number | null;
}

export interface SyncProgress {
  startedAt: number;
  /** sources this round is through with (read, confirmed unchanged or failed) */
  done: number;
  total: number;
}

export interface SourceStatus {
  sourceKey: string;
  /** did the latest attempt read the whole source? */
  ok: boolean;
  error: string | null;
  /** epoch ms of the snapshot currently shown for this source (null: never synced) */
  dataFrom: number | null;
}

export type ColumnMode = 'iteration' | 'status' | 'milestone';
export type Layout = 'board' | 'table';
export type GroupBy = 'iteration' | 'status' | 'milestone' | 'repo' | 'none';
export type SortField = 'manual' | 'updated' | 'title' | 'number' | 'repo' | 'iteration' | 'status' | 'milestone';
export type TableColumn =
  | 'title'
  | 'assignees'
  | 'labels'
  | 'linkedPrs'
  | 'subIssues'
  | 'updated'
  | 'iteration'
  | 'status'
  | 'milestone'
  | 'repo'
  | 'author';

export interface TableSettings {
  groupBy: GroupBy;
  sort: { field: SortField; dir: 'asc' | 'desc' };
  columns: TableColumn[];
  /** the left-hand slice list by repository */
  sliceByRepo: boolean;
  /** the repository picked in that list; null = all */
  slice: string | null;
  /** sub-issues indented under their parent */
  hierarchy: boolean;
  /** GitHub#205: column widths dragged by hand, CSS px; a column not in here has its default width */
  widths: Partial<Record<TableColumn, number>>;
}

/** What the last import of a saved web view brought in, and what it could not. */
export interface ImportInfo {
  sourceKey: string;
  viewNumber: number;
  viewName: string;
  /** settings of that view this client cannot reproduce (shown to the user) */
  notes: string[];
}

/** The labels the "hand to the agent" buttons use (follows the daemon's label names; editable in Settings). */
export interface HandBackLabels {
  /** removed: the item waits for a human */
  human: string;
  /** added: the daemon picks it up again */
  agent: string;
  /** added by "autopilot (merge automatically)" before handing over (GitHub#205); '' = no such button */
  autopilot: string;
}

export const DEFAULT_HAND_BACK: HandBackLabels = { human: 'pending/human', agent: 'pending/agent', autopilot: 'autopilot' };

export interface ViewSettings {
  mode: ColumnMode;
  swimlanes: boolean;
  /** source keys ticked at the top of the view; null = all */
  selected: string[] | null;
  layout: Layout;
  /** the search box (GitHub filter syntax) */
  query: string;
  table: TableSettings;
  imported: ImportInfo | null;
  /** PRs shown right under the issue they are linked to, on the board and in the table (GitHub#155) */
  prsUnderIssues: boolean;
  /** width of the floating detail panel, CSS px (GitHub#155) */
  detailWidth: number;
  /** labels / milestone / board fields shown in the detail panel; false = folded away (GitHub#260) */
  detailFields: boolean;
}

export type LoginStatus = 'idle' | 'requesting' | 'waiting' | 'denied' | 'expired' | 'error';

export interface LoginState {
  status: LoginStatus;
  userCode: string | null;
  verificationUri: string | null;
  message: string | null;
}

export interface SyncState {
  syncing: boolean;
  /** the latest round could not use GitHub at all (see `offlineFields` for every way in and out) */
  offline: boolean;
  /** GitHub#270: why, as GitHub / the connection said it; null whenever `offline` is false, or when no reason is known */
  offlineReason: string | null;
  /** epoch ms of the latest round that reached GitHub */
  lastOnlineAt: number | null;
  /** epoch ms of the oldest full read among the sources that have data ("整份读取") */
  dataFrom: number | null;
  /**
   * GitHub#324: epoch ms of the oldest check among the sources that have data ("上次检查"). A check =
   * the source was read in full, or GitHub's change check found nothing changed — which does not see
   * everything (changeCheck.ts), so this is never shown as "the data is current as of".
   */
  checkedFrom: number | null;
  /** GitHub#324: the two times of every configured source, in their order (both null: never read) */
  times: SourceTimes[];
  /** GitHub#324: the round reading GitHub right now; null whenever none is */
  progress: SyncProgress | null;
  sources: SourceStatus[];
  /** something the user should know that is not "offline" (e.g. a refresh that failed, a credential not saved); null = none */
  problem: string | null;
}

/** 'oauth' = an OAuth app (the default); 'github-app' = a GitHub App the user chose */
export type AppKind = 'oauth' | 'github-app';
export const APP_KINDS: readonly AppKind[] = ['oauth', 'github-app'];

export interface AppState {
  phase: 'loading' | 'login' | 'ready';
  /** why the user is on the login page (e.g. credential revoked) */
  loginReason: string | null;
  login: LoginState;
  /** which kind of GitHub application the next sign-in goes through (OAuth app by default) */
  appKind: AppKind;
  /** the Client ID the next sign-in uses for that kind; '' = none configured */
  clientId: string;
  /** true when clientId is the built-in one (no override saved for this kind) */
  clientIdIsDefault: boolean;
  viewer: string | null;
  sources: SourceConfig[];
  view: ViewSettings;
  sync: SyncState;
  /** whether the platform layer can persist credentials (false on unsupported platforms) */
  credentialsPersistent: boolean;
  handBack: HandBackLabels;
  /** the merge method last chosen, per repository and overall (GitHub#175) */
  mergePrefs: MergePrefs;
  /** which table groups are folded, per "group by" (GitHub#231; kept on this machine) */
  tableFolds: TableFolds;
  /** folded board swimlanes (repositories), kept on this machine (GitHub#297) */
  laneFolds: LaneFolds;
  /** "托管" asks before writing; false = the user ticked "不再提示" (GitHub#231) */
  autopilotConfirm: boolean;
  /** the repository order set by dragging (GitHub#304; lower-cased `owner/name`, kept on this machine); empty = alphabetical */
  repoOrder: string[];
  /** who a new issue is handed to, as last chosen in the new-issue dialog (GitHub#245; kept on this machine) */
  newIssueHandoff: Handoff;
  /** open items carrying the "waiting for a human" label (`handBack.human`) in every source read completely so far (not shown since GitHub#251) */
  pendingCount: number;
  /** of those, the ones not yet seen: became pending while the window was not in front (= the Dock badge, GitHub#185) */
  unreadCount: number;
  /** launch at login: on / off, null = this platform cannot */
  launchAtLogin: boolean | null;
  /** the system refused the latest notification (e.g. not allowed in System Settings); null = the latest one went out */
  notifyProblem: string | null;
  /** a notification was clicked: open this item's detail (`seq` changes on every click) */
  focus: { key: string; seq: number } | null;
  /** the app updating itself (GitHub#184); null = this build does not */
  update: UpdateStatus | null;
  /** GitHub#229: changes not saved (refused) or not confirmed (no answer): the ones that need the user */
  editsNeedingAction: number;
  /** GitHub#357: ids of the changes a "重新发送" a person asked for is working on right now (their notices read as running) */
  editsResending: string[];
  /** GitHub#229: new issues being created, and their outcome until dismissed */
  creates: CreateJob[];
  /** GitHub#250: close / merge / autopilot / hand-back operations, oldest first (see shared/ops.ts) */
  ops: OpRecord[];
}

/** One configured Project, as the new-issue dialog weighs it for its default board (GitHub#231). */
export interface BoardRepoCount {
  /** the source key (= ProjectMeta.key once synced) */
  key: string;
  /** what the dialog calls it */
  title: string;
  /**
   * items on the board per lower-cased `owner/repo`, from its last complete read;
   * null = never read completely yet (unknown — not "none of this repository's items")
   */
  repos: Record<string, number> | null;
}

export interface BoardData {
  items: Item[];
  /** the Projects of the sources ticked in the view */
  projects: ProjectMeta[];
  /** GitHub#205: every configured Project, ticked or not (what a new issue may join) */
  allProjects?: ProjectMeta[];
  /** GitHub#231: every configured Project's items per repository (null = never read completely), whatever the view shows */
  boardRepos?: BoardRepoCount[];
  /**
   * GitHub#349: keys of the ticked sources whose relations are unknown (their snapshot was cached
   * before relations were read, and no full read succeeded since). Not "these have no relations".
   */
  relationsUnknown?: string[];
}
