// The one API the views get (`window.cavil`, src/app/localApi.ts). The
// credential never reaches it: the views only see state and board data.

import type { AppKind, AppState, BoardData, HandBackLabels } from './types';
import type { ViewPatch } from './viewSettings';
import type { DetailResult, ItemDetail, MergeMethod, RepoOptions, WriteAction, WriteResult } from './actions';

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
  /** a row of the settings page's pending list: open it the way a click on its notification does */
  openPending(key: string): Promise<void>;
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
  previewMarkdown(repo: string, text: string): Promise<{ ok: boolean; html?: string; error?: string }>;
  act(action: WriteAction): Promise<WriteResult>;
  setHandBack(patch: Partial<HandBackLabels>): Promise<void>;
  /** remember the merge method chosen for a PR in `repo` */
  setMergeMethod(repo: string, method: MergeMethod): Promise<void>;
}
