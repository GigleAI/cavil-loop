// The one API the renderer gets (exposed by the preload as `window.cavil`).
// The token never crosses it: the renderer only sees state and board data.

import type { AppKind, AppState, BoardData, HandBackLabels, ViewSettings } from './types';
import type { DetailResult, RepoOptions, WriteAction, WriteResult } from './actions';

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
  setView(patch: Partial<ViewSettings>): Promise<void>;
  syncNow(): Promise<void>;
  openExternal(url: string): Promise<void>;
  loadDetail(key: string): Promise<DetailResult>;
  repoOptions(repo: string): Promise<RepoOptions>;
  previewMarkdown(repo: string, text: string): Promise<{ ok: boolean; html?: string; error?: string }>;
  act(action: WriteAction): Promise<WriteResult>;
  setHandBack(patch: Partial<HandBackLabels>): Promise<void>;
}

export const IPC = {
  get: 'cavil:get',
  push: 'cavil:state',
  startLogin: 'cavil:login:start',
  cancelLogin: 'cavil:login:cancel',
  openVerification: 'cavil:login:open',
  logout: 'cavil:logout',
  setAppKind: 'cavil:app-kind',
  setClientId: 'cavil:client-id',
  addSource: 'cavil:source:add',
  removeSource: 'cavil:source:remove',
  setView: 'cavil:view',
  syncNow: 'cavil:sync',
  openExternal: 'cavil:open',
  loadDetail: 'cavil:detail',
  repoOptions: 'cavil:repo-options',
  previewMarkdown: 'cavil:markdown',
  act: 'cavil:act',
  setHandBack: 'cavil:hand-back',
} as const;
