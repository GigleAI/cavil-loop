// Types shared by the main process, the data layer and the renderer.
// Nothing in here may import Node or Electron: the renderer bundles it.

export type ItemKind = 'issue' | 'pr';
export type ItemState = 'open' | 'closed' | 'merged';

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
  repo: string;
  number: number;
  title: string;
  url: string;
  kind: ItemKind;
  state: ItemState;
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
}

export interface ProjectMeta {
  key: string;
  title: string;
  url: string;
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
}

/** What the last import of a saved web view brought in, and what it could not. */
export interface ImportInfo {
  sourceKey: string;
  viewNumber: number;
  viewName: string;
  /** settings of that view this client cannot reproduce (shown to the user) */
  notes: string[];
}

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
}

export interface BoardData {
  items: Item[];
  projects: ProjectMeta[];
}
