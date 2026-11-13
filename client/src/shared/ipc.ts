// The one API the views get (`window.cavil`, src/app/localApi.ts). The
// credential never reaches it: the views only see state and board data.

import type { AppKind, AppState, BoardData, GroupBy, HandBackLabels, NotifyScope, ProjectChoices, TallyDef } from './types';
import type { ViewPatch } from './viewSettings';
import type { DetailResult, ItemDetail, MergeMethod, RepoOptions, WriteAction, WriteResult } from './actions';
import type { ImageResult } from './images';
import type { Handoff } from './handoff';
import type { BlockedLabels, EntryState, NumberSettled, Pick as BlockedPick, Ref } from './blocked';
import type { ConfigRead, ConfigSave, ConnectInfo, ConnectPoll, DaemonResult, DaemonStatus, DaemonUpdate, DirCheck, Precheck2 } from './daemon';
import type { HostAction, HostResult, HostStatus, RemoteList, RemoteRead, RemoteResult, TailnetList } from './remote';

export interface Snapshot {
  state: AppState;
  data: BoardData;
}

/** GitHub#434: one prerequisite as the dialog shows it ('unknown' = its state could not be read) */
export interface BlockedRefInfo {
  repo: string;
  number: number;
  kind: 'issue' | 'pr' | null;
  title: string;
  state: 'open' | 'closed' | 'merged' | 'unknown';
  url: string;
}

/**
 * GitHub#434: what "等前置…" read about an item, read now in full. `fingerprint` names exactly this read:
 * the start is refused (and the dialog refreshed) when GitHub no longer holds it.
 */
export type BlockedView =
  | {
      ok: true;
      key: string;
      repo: string;
      number: number;
      isPr: boolean;
      entry: EntryState;
      /** the prerequisites the daemon counts now: the newest registration of this wait, and the native "Blocked by" */
      current: BlockedRefInfo[];
      /** prerequisites of earlier registrations of this wait the newest one lost (open or not readable: ticked by default) */
      lost: BlockedRefInfo[];
      /** the newest registration's prerequisites, and the native "Blocked by" (what the plan is computed from) */
      latest: Ref[];
      native: Ref[];
      fingerprint: string;
      /** set: the dialog may not confirm, and says why (labels missing in the repository, ...) */
      refuse: string | null;
    }
  | { ok: false; error: string };

export interface BlockedStart {
  key: string;
  fingerprint: string;
  picks: BlockedPick[];
  restore: Ref[];
}

export type BlockedStartResult = { ok: true; id: string } | { ok: false; error: string; view?: BlockedView };

/** GitHub#467: `overlay` = the page's top row is the window's title bar (macOS); `fullscreen` = its window buttons are hidden */
export interface WindowFrame {
  overlay: boolean;
  fullscreen: boolean;
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
  /** GitHub#468: the view-bar numbers; null = back to the default table */
  setTallies(tallies: TallyDef[] | null): Promise<void>;
  /** GitHub#434: the other flow labels of "等前置…" (the waiting label is set with setHandBack) */
  setBlockedLabels(patch: Partial<BlockedLabels>): Promise<void>;
  /** GitHub#434: read an item for the "等前置…" dialog (every list in full) */
  blockedRead(key: string): Promise<BlockedView>;
  /**
   * GitHub#434 / #448: the picker's search — a number lists the item with it and the open items whose
   * number starts with it, an address that one item, text searches open titles. `error` with `ok: true`:
   * part of the answer could not be read (`items` is what could). `settled` (a number search): what the
   * answer decided, so the window drops its own out-of-date copies of those items (PR #452 review round 1).
   */
  blockedSearch(key: string, text: string): Promise<{ ok: true; items: (BlockedRefInfo & BlockedPick)[]; error?: string; settled?: NumberSettled } | { ok: false; error: string }>;
  /** GitHub#434: register the prerequisites; refused (with the item read again) when GitHub no longer holds what the dialog showed */
  blockedStart(req: BlockedStart): Promise<BlockedStartResult>;
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
  /** GitHub#467: how the window's top row sits (macOS: the title bar; elsewhere, and when it cannot be read: the system's own) */
  windowFrame(): Promise<WindowFrame>;
  /** GitHub#467: an empty part of the top row pressed (macOS): move the window */
  startDrag(): Promise<void>;
  /** GitHub#467: an empty part of the top row double-clicked (macOS): zoom the window, or put it back */
  toggleZoom(): Promise<void>;
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
  /**
   * A daemon on another machine (GitHub#387), over Tailscale only. The window names a machine from the
   * list and a project; the back end holds the key, proves the other end is that machine before it
   * sends anything, and signs each request.
   */
  remoteList(): Promise<RemoteList>;
  remotePair(host: string, code: string): Promise<RemoteResult>;
  remoteStatus(id: string): Promise<RemoteRead>;
  remoteService(id: string, key: string, action: 'stop' | 'start'): Promise<RemoteResult>;
  remoteLog(id: string, key: string): Promise<RemoteResult>;
  /** `localOnly`: when the machine cannot confirm, stop using the key anyway and keep the entry as "取消配对未完成" */
  remoteUnpair(id: string, localOnly: boolean): Promise<RemoteResult>;
  /** drop a "取消配对未完成" entry: the person revoked this computer on the machine itself */
  remoteForget(id: string): Promise<RemoteResult>;
  /** the machines this computer's Tailscale knows, each looked at once: is its remote entry open */
  remoteTailnet(): Promise<TailnetList>;
  /** this machine as the one being connected to: its remote entry switch, a pairing code, the computers paired with it */
  remoteHost(action: 'status'): Promise<HostStatus>;
  remoteHost(action: Exclude<HostAction, 'status'>, target?: string): Promise<HostResult>;
}
