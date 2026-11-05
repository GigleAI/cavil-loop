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
  updatedAt: string;
  labels: Label[];
  assignees: string[];
  milestone: Milestone | null;
  projects: ProjectMembership[];
  /** keys of the sources this item came from (filled when sources are merged) */
  sources: string[];
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
}

export type SourceConfig =
  | { kind: 'project'; key: string; ownerType: 'org' | 'user'; owner: string; number: number; url: string }
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

/** The two labels "hand back to the agent" swaps (follows the daemon's label names; editable in Settings). */
export interface HandBackLabels {
  /** removed: the item waits for a human */
  human: string;
  /** added: the daemon picks it up again */
  agent: string;
}

export const DEFAULT_HAND_BACK: HandBackLabels = { human: 'pending/human', agent: 'pending/agent' };

export interface ViewSettings {
  mode: ColumnMode;
  swimlanes: boolean;
  /** source keys ticked at the top of the view; null = all */
  selected: string[] | null;
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
}

export interface BoardData {
  items: Item[];
  projects: ProjectMeta[];
}
