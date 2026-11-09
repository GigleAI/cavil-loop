// The one API the views get (`window.cavil`, src/app/localApi.ts). The
// credential never reaches it: the views only see state and board data.

import type { AppKind, AppState, BoardData, GroupBy, HandBackLabels } from './types';
import type { ViewPatch } from './viewSettings';
import type { DetailResult, ItemDetail, MergeMethod, RepoOptions, WriteAction, WriteResult } from './actions';
import type { Handoff } from './handoff';

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
  setView(patch: ViewPatch): Promise<void>;
  syncNow(): Promise<void>;
  /** refresh by hand (GitHub#217): a round reading GitHub is dropped and a new one starts at once */
  restartSync(): Promise<void>;
  openExternal(url: string): Promise<void>;
  setLaunchAtLogin(on: boolean): Promise<void>;
  /** the app updating itself (GitHub#184) */
  checkUpdate(): Promise<void>;
  setAutoUpdate(on: boolean): Promise<void>;
  setUpdateChannel(channel: 'stable' | 'dev'): Promise<void>;
  dismissUpdate(version: string): Promise<void>;
  restartToUpdate(): Promise<void>;
  loadDetail(key: string): Promise<DetailResult>;
  /** GitHub#229: the detail read last in this run, shown at once on re-opening; null = none */
  cachedDetail(key: string): Promise<ItemDetail | null>;
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
  /** read the evidence of an operation whose answer never came again (reads only) */
  opRecheck(id: string): Promise<WriteResult>;
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
  /** a repository dragged (GitHub#304): `shown` = the list on screen before the drag, `next` = the same repositories in the new order */
  reorderRepos(shown: string[], next: string[]): Promise<void>;
  /** "按名称排序": forget the dragged order (GitHub#304) */
  resetRepoOrder(): Promise<void>;
  /** who a new issue is handed to by default, as last chosen in the dialog (GitHub#245) */
  setNewIssueHandoff(h: Handoff): Promise<void>;
}
