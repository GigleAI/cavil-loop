// Types shared by the main process, the data layer and the renderer.
// Nothing in here may import Node or Electron: the renderer bundles it.

import type { MergePrefs } from './mergePrefs';

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
export interface CreateJob {
  id: number;
  repo: string;
  title: string;
  status: 'running' | 'partial' | 'unknown' | 'failed';
  message: string | null;
  /** partial: the new issue */
  createdKey?: string;
  number?: number;
  /** partial: Projects it did not join (a retry adds exactly these to #number) */
  missingProjects?: string[];
  /** unknown: same-title issues this account opened in this repository lately (links only) */
  candidates?: { number: number; url: string; createdAt: string }[];
  /** what was typed, for "copy" (unknown) and "reopen the draft" (failed) */
  draft: { repo: string; title: string; body: string; labels: string[]; projects: string[] };
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
  /** the latest round could not reach GitHub at all */
  offline: boolean;
  /** epoch ms of the latest round that reached GitHub */
  lastOnlineAt: number | null;
  /** epoch ms of the oldest snapshot currently shown (for "数据截至") */
  dataFrom: number | null;
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
  /** items carrying the "waiting for a human" label (`handBack.human`) in every source read completely so far, open or closed */
  pendingCount: number;
  /** those same items, one entry each (GitHub#185: Settings lists them); always as long as `pendingCount` */
  pendingItems: PendingEntry[];
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
  /** GitHub#229: new issues being created, and their outcome until dismissed */
  creates: CreateJob[];
}

/**
 * One item the badge counts, as the settings page lists it (GitHub#185). Kind,
 * state, close reason and draft mark are kept as read, so its colour and words
 * come from the same rule as the board card, the table row and the detail badge.
 */
export interface PendingEntry {
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  kind: ItemKind;
  state: ItemState;
  stateReason: IssueStateReason | null;
  isDraft: boolean | null;
  updatedAt: string;
}

export interface BoardData {
  items: Item[];
  /** the Projects of the sources ticked in the view */
  projects: ProjectMeta[];
  /** GitHub#205: every configured Project, ticked or not (what a new issue may join) */
  allProjects?: ProjectMeta[];
}
