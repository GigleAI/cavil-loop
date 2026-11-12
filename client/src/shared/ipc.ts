// The one API the views get (`window.cavil`, src/app/localApi.ts). The
// credential never reaches it: the views only see state and board data.

import type { AppKind, AppState, BoardData, GroupBy, HandBackLabels, NotifyScope, ProjectChoices } from './types';
import type { ViewPatch } from './viewSettings';
import type { DetailResult, ItemDetail, MergeMethod, RepoOptions, WriteAction, WriteResult } from './actions';
import type { ImageResult } from './images';
import type { Handoff } from './handoff';
import type { ConfigRead, ConfigSave, ConnectInfo, ConnectPoll, DaemonResult, DaemonStatus, DaemonUpdate, DirCheck, Precheck2 } from './daemon';

export interface Snapshot {
  state: AppState;
  data: BoardData;
}

export interface CavilApi {
  get(): Promise<Snapshot>;
  subscribe(cb: (s: Snapshot) => void): () => void;
  startLogin(): Promise<void>;
  cancelLogin(): Promise<void>;
  openVerification(): Promise<void>;
  logout(): Promise<void>;
  setAppKind(kind: AppKind): Promise<void>;
  setClientId(id: string): Promise<void>;
  addSource(input: string): Promise<{ ok: boolean; error?: string }>;
  removeSource(key: string): Promise<void>;
  /** GitHub#401: the Projects the account and its organisations have, read now ("从 GitHub 选") */
  projectChoices(): Promise<ProjectChoices>;
  setView(patch: ViewPatch): Promise<void>;
  syncNow(): Promise<void>;
  /** refresh by hand (GitHub#217): a round reading GitHub is dropped and a new one starts at once */
  restartSync(): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** GitHub#401: GitHub's page for the app the current sign-in used (each organisation's access); the back end builds it */
  openAuthPage(): Promise<void>;
  setLaunchAtLogin(on: boolean): Promise<void>;
  /** the app updating itself (GitHub#184) */
  checkUpdate(): Promise<void>;
  setAutoUpdate(on: boolean): Promise<void>;
  setUpdateChannel(channel: 'stable' | 'dev'): Promise<void>;
  dismissUpdate(version: string): Promise<void>;
  /** the "updated to `version`" notice was closed (GitHub#348) */
  dismissInstalledUpdate(version: string): Promise<void>;
  restartToUpdate(): Promise<void>;
  loadDetail(key: string): Promise<DetailResult>;
  /** GitHub#229: the detail read last in this run, shown at once on re-opening; null = none */
  cachedDetail(key: string): Promise<ItemDetail | null>;
  /** GitHub#395: a release attachment image of the discussion, fetched with the sign-in (kept in memory for this account) */
  loadImage(src: string): Promise<ImageResult>;
  /** `fresh`: read again even when a read of this run worked (the detail's refresh button) */
  repoOptions(repo: string, fresh?: boolean): Promise<RepoOptions>;
  /** GitHub#229: send a change not saved / not confirmed again (read GitHub first unless `force`), or give it up */
  resendEdit(id: string, force?: boolean): Promise<WriteResult>;
  abandonEdit(id: string): Promise<void>;
  resendAllEdits(): Promise<WriteResult>;
  abandonAllEdits(): Promise<void>;
  /** GitHub#229: create in the background (the dialog closes); refused at once when it cannot go out at all */
  startCreate(action: Extract<WriteAction, { kind: 'createIssue' }>): Promise<{ ok: boolean; error: string | null; job?: number }>;
  dismissCreate(id: number): Promise<void>;
  retryCreateProjects(id: number): Promise<WriteResult>;
  /** GitHub#258: a board that took the new issue in by itself holds another value: set the group's value there (read again first) */
  applyCreateWatch(id: number, projectKey: string): Promise<WriteResult>;
  /**
   * GitHub#250: close an issue / PR, merge, autopilot, hand to the agent — started in the background
   * (the dialog closes); refused at once, nothing sent, when it cannot go out (offline, or the item
   * still has an operation that is not settled). Its progress is `state.ops`.
   */
  startOp(action: Extract<WriteAction, { kind: 'closeIssue' | 'closePr' | 'merge' | 'autopilot' | 'handBack' }>, from?: string): Promise<{ ok: boolean; error: string | null; id?: string }>;
  /** GitHub#359, "仍要重发…": send a label step again whose answer never came (checked first; judged again right before the send) */
  opResend(id: string): Promise<WriteResult>;
  /** "补做剩下的步骤" (re-reads first) */
  opFinish(id: string): Promise<{ ok: boolean; error: string | null; id?: string }>;
  /** "已核对，解除锁定": local only */
  opUnlock(id: string): Promise<void>;
  opDismiss(id: string, dismissed: boolean): Promise<void>;
  opDropDraft(id: string): Promise<void>;
  previewMarkdown(repo: string, text: string): Promise<{ ok: boolean; html?: string; error?: string }>;
  act(action: WriteAction): Promise<WriteResult>;
  setHandBack(patch: Partial<HandBackLabels>): Promise<void>;
  /** remember the merge method chosen for a PR in `repo` */
  setMergeMethod(repo: string, method: MergeMethod): Promise<void>;
  /** fold / unfold one table group under one "group by" (GitHub#231) */
  setTableFold(groupBy: GroupBy, key: string, folded: boolean): Promise<void>;
  /** fold / unfold one board swimlane, by repository (GitHub#297) */
  setLaneFold(lane: string, folded: boolean): Promise<void>;
  /** whether "托管" asks first (GitHub#231) */
  setAutopilotConfirm(on: boolean): Promise<void>;
  /** whether switching to the window takes back every delivered notification (GitHub#369) */
  setClearAllOnActivate(on: boolean): Promise<void>;
  /** which pending items remind: every one, or only the signed-in account's (GitHub#373) */
  setNotifyScope(scope: NotifyScope): Promise<void>;
  /** a repository dragged (GitHub#304): `shown` = the list on screen before the drag, `next` = the same repositories in the new order */
  reorderRepos(shown: string[], next: string[]): Promise<void>;
  /** "按名称排序": forget the dragged order (GitHub#304) */
  resetRepoOrder(): Promise<void>;
  /** who a new issue is handed to by default, as last chosen in the dialog (GitHub#245) */
  setNewIssueHandoff(h: Handoff): Promise<void>;
  /**
   * Detail tabs (GitHub#397). `openTab`: false = no such item is known (nothing opens). The list
   * itself is `state.tabs`; which tab is in front is the window's own.
   */
  openTab(key: string): Promise<boolean>;
  closeTab(key: string): Promise<void>;
  /** a tab dragged to position `to` of the list */
  moveTab(key: string, to: number): Promise<void>;
  /** the tab is in front and shows the item as of `updatedAt` (its "something new" dot goes) */
  seenTab(key: string, updatedAt: string): Promise<void>;
  /** the tab came to the front, or its refresh button: an item no complete read carries is checked now */
  checkTab(key: string): Promise<void>;
  /** the shell's "close" key with no tab in front: close the window the way its close button does */
  closeWindow(): Promise<void>;
  /**
   * The local cavil-loop daemon (GitHub#314). Fixed requests only: the back end reads the daemon's
   * status script again before acting and decides every path, unit and command itself.
   */
  daemonStatus(): Promise<DaemonStatus>;
  daemonInstall(): Promise<DaemonResult>;
  daemonService(key: string, action: 'stop' | 'start'): Promise<DaemonResult>;
  daemonDisconnect(key: string): Promise<DaemonResult>;
  daemonOpen(key: string, what: 'log' | 'config'): Promise<DaemonResult>;
  daemonUpdate(): Promise<DaemonUpdate>;
  /**
   * "配置" on a project (GitHub#388): its everyday settings as the daemon's own script reads them, and a
   * save of some of them. The window names a project and settings; where the file is and what may be
   * changed is the daemon's answer, checked again by the back end right before the save.
   */
  daemonConfigGet(key: string): Promise<ConfigRead>;
  daemonConfigSet(key: string, rev: string, values: Record<string, string>): Promise<ConfigSave>;
  /** "接上 daemon" (GitHub#315): the back end checks repository, agent and folder again before running setup.sh */
  daemonConnectInfo(repo: string): Promise<ConnectInfo>;
  daemonPrecheck(agent: string): Promise<Precheck2>;
  daemonCheckDir(repo: string, dir: string): Promise<DirCheck>;
  daemonPickFolder(start?: string): Promise<{ result: string; path?: string | null; output?: string }>;
  daemonConnect(o: { repo: string; agent: string; dir?: string; cloneInto?: string }): Promise<DaemonResult & { job?: number }>;
  daemonConnectPoll(job: number, from: number): Promise<ConnectPoll>;
}
