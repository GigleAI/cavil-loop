// App logic between the window and GitHub: login state, settings, sync
// rounds, cache. It runs in the window and never holds the GitHub credential:
// signing in, refreshing, signing out and every request that needs the
// credential go through the back end (src-tauri/crates/core, Rust), which
// signs requests for a session it names. No Electron / Tauri / Node imports —
// the unit tests drive it against the fake GitHub with the real Rust back end
// as a child process.

import { APP_KINDS, DEFAULT_HAND_BACK, type AppKind, type AppState, type BoardData, type CreateBoard, type CreateJob, type CreateWatch, type HandBackLabels, type Item, type ProjectMeta, type SourceConfig, type SourceSnapshot, type ViewSettings } from '../shared/types';
import { ISSUE_CLOSE_REASONS, type DetailResult, type ItemDetail, type RepoOptions, type WriteAction, type WriteResult } from '../shared/actions';
import { isValidView, normalizeView, type ViewPatch } from '../shared/viewSettings';
import { normalizeMergePrefs, rememberMergeMethod } from '../shared/mergePrefs';
import { normalizeAutopilotConfirm, normalizeTableFolds, setFold } from '../shared/uiPrefs';
import { normalizeHandoff, type Handoff } from '../shared/handoff';
import { importView, pickView } from '../shared/viewImport';
import { itemKey, parseSource, sourceLabel } from '../shared/sources';
import { countRepos, type BoardRepoCount } from '../data/newIssueBoards';
import { clientIdKindProblem } from '../shared/appKind';
import { DEFAULT_GITHUB_APP_CLIENT_ID, DEFAULT_OAUTH_CLIENT_ID, FOLLOW_UP_SYNC_MS, SYNC_INTERVAL_MS } from '../shared/config';
import { Endpoints, GitHubClient } from '../data/github';
import { mergeSnapshots } from '../data/merge';
import { syncRound } from '../data/sync';
import { FULL_READ_EVERY_MS, type SourceCheck } from '../data/changeCheck';
import { writesEnabled } from '../data/board';
import { ActionRefused, CreateUnanswered, addLabel, closeStep, commentStep, createBoard, explainError, joinCreatedIssue, listRepoOptions, mergeStep, performAction, readItemRecords, refusedForSure, relatedIssues, removeLabel, setCreatedField } from '../data/actions';
import { WATCH_LOOKS_MS, WATCH_VERIFY_MS, WATCH_VERIFY_TRIES, autoAddSurelyOff, judgeWatch, readCreatedBoards, watchActive, watchedValue, watchProblem, type BoardSighting } from '../data/autoJoin';
import {
  STUCK_MS,
  finishSteps,
  isOpKind,
  isOpRecord,
  needsRecords,
  opAfterRestart,
  opApplyRead,
  opDisposable,
  opLockOf,
  opPhase,
  opProveFromRecords,
  opText,
  type OpKind,
  type OpRecord,
  type OpStep,
} from '../shared/ops';
import { fetchRawDetail, toDetail } from '../data/detail';
import { applyFreshItem, fetchItem, freshKey, freshViews, type FreshItem } from '../data/itemRefresh';
import { contentToItem } from '../data/fetchSources';
import {
  MAX_EDITS,
  OBSERVE_FIRST_MS,
  OBSERVE_MS,
  afterRestart,
  applyAnswer,
  applyRead,
  applyReadFailure,
  editStatus,
  fieldId,
  fieldValue,
  isEditRecord,
  latestStamp,
  markSent,
  overlayItem,
  startEdit,
  type EditField,
  type EditRecord,
  type EditValue,
} from '../data/edits';
import { GitHubError } from '../data/github';
import { proxyFetch, type Backend, type BackendInit, type FreshOut, type FreshResult, type GrantInfo } from '../backend/backend';
import { PendingTracker, itemAlertText } from '../data/pending';
import type { Alert, Delivery, Desktop, DesktopEvent, UpdateStatus } from './desktop';

export const REASON_REVOKED = 'GitHub 凭据已失效（可能被撤销或已过期），请重新登录';
export const REASON_REFRESH_ENDED = '登录已到期，GitHub 不再接受续期，请重新登录';
/** the back end refreshes this long before the access token expires (src-tauri/crates/core/src/engine.rs) */
export const REFRESH_MARGIN_MS = 5 * 60_000;

/** What a queued notification was decided on (see Controller.noticeContext). */
interface NoticeContext {
  label: number;
  sources: (readonly [string, number])[];
}

export interface ControllerDeps {
  backend: Backend;
  endpoints: Endpoints;
  now?: () => number;
  syncIntervalMs?: number;
  /** how long after the last successful change one more sync round runs (tests shorten / lengthen it) */
  followUpSyncMs?: number;
  /**
   * GitHub#261: each source is read in full at least this often; in between, a round whose change
   * check finds nothing changed keeps the previous snapshot. 0 = no change check (every round reads
   * every source in full). Default FULL_READ_EVERY_MS.
   */
  fullReadEveryMs?: number;
  /** tests only: a round's read is in and its change-check records were dealt with (`dropped`: the round had been given up on) */
  afterRoundRead?: (dropped: boolean) => void;
  /** built-in OAuth Client ID (tests inject their own; production uses the constant) */
  defaultClientId?: string;
  /** built-in GitHub App Client ID ('' = none, which is production today) */
  defaultGithubAppClientId?: string;
  /** notifications, Dock badge, launch at login, sync beat (none: nothing is shown, the counting still runs) */
  desktop?: Desktop;
  /** GitHub#229: how long an older unanswered change is watched for, and the first re-read of it (tests shorten them) */
  observeMs?: number;
  observeFirstMs?: number;
  /** GitHub#250: how long a succeeded operation waits for its re-read before the manual unlock is offered (tests shorten it) */
  opStuckMs?: number;
  /** GitHub#258: when the boards not ticked are looked at after a create (ms after it), and the check after a write (tests shorten them) */
  watchLooksMs?: number[];
  watchVerifyMs?: number;
}

/** GitHub#229: the row of the snapshot table that holds the changes not yet confirmed (not a source). */
export const EDITS_KEY = '__edits__';
/** GitHub#250: the row of the snapshot table that holds the close / merge / autopilot / hand-back operations (not a source). */
export const OPS_KEY = '__ops__';
/** GitHub#250: the operations started from the window: one action of one of the five kinds */
export type OpAction = Extract<WriteAction, { kind: OpKind }>;
/** GitHub#229: how many item details are kept for a fast re-open (this run only, never on disk). */
export const DETAIL_CACHE_SIZE = 50;

/**
 * GitHub#229: what the notice of a created issue says, from every board it is still not
 * finished on (code review rounds 2–3: one list kept across retries; a joined board never
 * hides a field that failed on it, a later retry of another board never drops it). null =
 * nothing left: the notice goes.
 */
export function createNotice(number: number, boards: CreateBoard[], labelsNote = '', watch: CreateWatch[] = []): string | null {
  const missing = boards.filter((b) => b.state === 'missing');
  const fields = boards.filter((b) => b.state === 'fieldsFailed');
  const parts: string[] = [];
  // GitHub#245: labels GitHub dropped come first — the issue may not be handed to the agent at all
  if (labelsNote) parts.push(labelsNote);
  if (missing.length) parts.push(`没能加入看板 ${missing.map((b) => `「${b.title}」（${b.reason}）`).join('、')}`);
  if (fields.length) parts.push(`已加入看板但字段没设上 ${fields.map((b) => `「${b.title}」（${b.reason}）`).join('、')}，请在详情里手动设置`);
  // GitHub#258: boards not ticked that took it in by themselves and were not (surely) set
  for (const w of watch) {
    const t = watchProblem(w);
    if (t) parts.push(t);
  }
  return parts.length ? `issue #${number} 已建好，但${parts.join('；')}` : null;
}

/**
 * After a retry of the missing boards: each board the retry worked on takes its new state
 * (joined and set → gone; joined, field refused → fieldsFailed; still refused → missing with
 * the new reason); every other board keeps what it had.
 */
export function mergeRetry(boards: CreateBoard[], results: Map<string, CreateBoard | null>): CreateBoard[] {
  return boards.flatMap((b) => (results.has(b.projectKey) ? (results.get(b.projectKey) ? [results.get(b.projectKey)!] : []) : [b]));
}

/** The four kinds of change shown before GitHub confirms them (GitHub#229). */
type FieldAction = Extract<WriteAction, { kind: 'addLabel' | 'removeLabel' | 'setMilestone' | 'setStatus' | 'setIteration' }>;
function isFieldAction(a: WriteAction): a is FieldAction {
  return a.kind === 'addLabel' || a.kind === 'removeLabel' || a.kind === 'setMilestone' || a.kind === 'setStatus' || a.kind === 'setIteration';
}

/** where each kind's Client ID override is saved ('oauthClientId' predates the choice and keeps its name) */
const CLIENT_ID_SETTING: Record<AppKind, string> = { oauth: 'oauthClientId', 'github-app': 'githubAppClientId' };

/**
 * A Project added and not yet imported: its saved web view is applied after
 * its first complete read. `touched` = settings the user changed meanwhile;
 * those keep the user's value (top-level keys, `table.<key>` for the table).
 */
interface PendingImport {
  sourceKey: string;
  view?: number;
  touched: string[];
}
const PENDING_IMPORTS = 'pendingImports';
/** its own key, not part of the view settings: importing a Project's web view must not touch it */
const MERGE_PREFS = 'mergePrefs';
/** GitHub#231: their own keys too, for the same reason */
const TABLE_FOLDS = 'tableFolds';
const AUTOPILOT_CONFIRM = 'autopilotConfirm';
const NEW_ISSUE_HANDOFF = 'newIssueHandoff';

/**
 * The settings, as the window sees them: read once at start, every change
 * applied here at once and written through to the back end in call order.
 */
class Settings {
  private values: Map<string, unknown>;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly backend: Backend,
    init: Record<string, unknown>,
  ) {
    this.values = new Map(Object.entries(init));
  }
  getSetting<T>(k: string, fallback: T): T {
    return this.values.has(k) ? (this.values.get(k) as T) : fallback;
  }
  setSetting(k: string, v: unknown): void {
    this.values.set(k, v);
    this.enqueue(() => this.backend.call('setSetting', { key: k, value: v }));
  }
  /** the back end already wrote it (sign-in / sign-out): mirror only */
  mirror(k: string, v: unknown): void {
    this.values.set(k, v);
  }
  deleteSnapshot(key: string): void {
    this.enqueue(() => this.backend.call('deleteSnapshot', { key }));
  }
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.writes.then(fn);
    this.writes = p.catch(() => undefined);
    return p;
  }
  /** resolves once every write queued so far has been answered */
  flushed(): Promise<void> {
    return this.writes.then(() => undefined);
  }
}

/** One sync round as `restartSync` sees it (GitHub#217). */
interface SyncRun {
  /** aborts when the round is dropped: no further request goes out */
  signal: AbortSignal;
  /** true only while the round reads GitHub, the one stretch a restart may cut */
  reading: boolean;
  drop(): void;
}

export class Controller {
  private state: AppState;
  private snapshots = new Map<string, SourceSnapshot>();
  /**
   * GitHub#261: the change check's records, per source, valid for one sign-in session and one
   * addition of the source (`epoch`); each vouches only for the snapshot whose fetchedAt is its
   * `snapshotAt`. Memory only: a restart, sign-out or another account starts with full reads.
   */
  private checks = new Map<string, { epoch: number; check: SourceCheck }>();
  private checksSession: number | null = null;
  /** GitHub#261: refresh by hand asked for a full read: the next round to start ignores the records */
  private fullReadNext = false;
  /** signed in, as the back end last said (it holds the credential, this side never does) */
  private signedIn = false;
  private listeners = new Set<(s: AppState) => void>();
  private syncing: Promise<void> | null = null;
  private resync = false;
  /** the round in flight (GitHub#217): a restart may drop it, but only while it is reading GitHub */
  private round: SyncRun | null = null;
  private loginRun = 0;
  /**
   * Cancels sent to the back end, in order. A new sign-in waits for them: commands to the back
   * end run side by side, so a cancel that arrived after the next `loginBegin` would end that
   * new attempt instead of the old one.
   */
  private loginCancels: Promise<unknown> = Promise.resolve();
  /** the back end's number for the sign-in attempt in progress (a cancel names it) */
  private pendingRun: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** the one sync round queued after the last successful change (GigleAI/cavil-loop#177) */
  private followUp: ReturnType<typeof setTimeout> | null = null;
  /** bodies / comments with a box being ticked right now: one read-change-write each at a time (GitHub#193) */
  private tasksInFlight = new Set<string>();
  /** the back end's session: bumps on every login / logout, a round started in another session is dropped */
  private session = 0;
  /** the last sign-out applied here (a refresh ending the sign-in can be reported by several callers) */
  private signedOutAt = -1;
  /** per source key, bumps on every add / remove: a round only writes a source added before it started */
  private epochs = new Map<string, number>();
  private epochSeq = 0;
  private readonly cache: Settings;
  private readonly backend: Backend;
  private readonly now: () => number;

  private readonly defaultClientIds: Record<AppKind, string>;
  /** items carrying the pending label: notifications, badge and summary all come from here (GitHub#139) */
  private readonly pending: PendingTracker;
  private focusSeq = 0;
  private eventsRunning = false;

  // ---- GitHub#229 ----
  /** changes shown before GitHub confirmed them, one per field (see data/edits.ts); stored in the snapshot table under EDITS_KEY */
  private edits = new Map<string, EditRecord>();
  /** the EDITS_KEY row exists on disk (an empty set deletes it instead of writing it) */
  private editsStored = false;
  private editSeq = 0;
  /** the last stamp handed out: stamps only ever grow, so "sent after" never ties */
  private stampAt = 0;
  /** one chain per item: its changes go out one after the other, in the order they were made */
  private itemQueues = new Map<string, Promise<unknown>>();
  /** the watch re-reads of a record (cleared when it ends) */
  private editTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
  /** GitHub#258: the waits of the watched boards of new issues */
  private watchTimers = new Set<ReturnType<typeof setTimeout>>();
  /** details read in this run, newest last (re-opening shows the last one while the new read is on its way) */
  private detailCache = new Map<string, ItemDetail>();
  /** labels / milestones per repository, only reads that worked */
  private optionsCache = new Map<string, RepoOptions>();
  private createSeq = 0;
  /**
   * The newest read that landed, per source (a whole sync round) and per source + item (one
   * item's re-read): a read issued before it is older than what is shown and does not land.
   */
  private sourceReadAt = new Map<string, number>();
  private itemReadAt = new Map<string, number>();

  // ---- GitHub#250 ----
  /** close / merge / autopilot / hand-back operations (shared/ops.ts), stored under OPS_KEY */
  private ops = new Map<string, OpRecord>();
  private opsStored = false;
  private opSeq = 0;
  /** an operation's requests and re-reads, while they run */
  private opJobs = new Map<string, Promise<void>>();
  /** items a "finish the remaining steps" is preparing for (it re-reads first): the send gate counts them */
  private opPreparing = new Set<string>();
  /** the wait of a succeeded operation for its re-read: offers the manual unlock when it runs out */
  private opTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Read what the back end has (settings, cached snapshots), then build the controller. */
  static async create(deps: ControllerDeps): Promise<Controller> {
    const init = await deps.backend.call<BackendInit>('init');
    return new Controller(deps, init);
  }

  constructor(
    private readonly deps: ControllerDeps,
    init: BackendInit,
  ) {
    this.backend = deps.backend;
    this.cache = new Settings(deps.backend, init.settings);
    this.defaultClientIds = {
      oauth: deps.defaultClientId ?? DEFAULT_OAUTH_CLIENT_ID,
      'github-app': deps.defaultGithubAppClientId ?? DEFAULT_GITHUB_APP_CLIENT_ID,
    };
    this.now = deps.now ?? Date.now;
    const appKind = this.loadAppKind();
    const handBack: HandBackLabels = { ...DEFAULT_HAND_BACK, ...this.cache.getSetting<Partial<HandBackLabels>>('handBack', {}) };
    // One "waiting for a human" label for everything: reminders count it, "hand back to the agent" removes it.
    this.pending = new PendingTracker(handBack.human.trim() || DEFAULT_HAND_BACK.human);
    this.state = {
      phase: 'loading',
      loginReason: null,
      login: { status: 'idle', userCode: null, verificationUri: null, message: null },
      appKind,
      ...this.clientIdFor(appKind),
      viewer: this.cache.getSetting<string | null>('viewer', null),
      sources: this.cache.getSetting<SourceConfig[]>('sources', []),
      view: normalizeView(this.cache.getSetting<unknown>('view', {})),
      sync: { syncing: false, offline: false, lastOnlineAt: null, dataFrom: null, sources: [], problem: null },
      credentialsPersistent: init.persistent,
      handBack,
      mergePrefs: normalizeMergePrefs(this.cache.getSetting<unknown>(MERGE_PREFS, null)),
      tableFolds: normalizeTableFolds(this.cache.getSetting<unknown>(TABLE_FOLDS, null)),
      autopilotConfirm: normalizeAutopilotConfirm(this.cache.getSetting<unknown>(AUTOPILOT_CONFIRM, true)),
      newIssueHandoff: normalizeHandoff(this.cache.getSetting<unknown>(NEW_ISSUE_HANDOFF, 'none')),
      pendingCount: 0,
      unreadCount: 0,
      launchAtLogin: null,
      notifyProblem: null,
      focus: null,
      update: null,
      editsNeedingAction: 0,
      creates: [],
      ops: [],
    };
    for (const s of init.snapshots) {
      if (s.sourceKey === EDITS_KEY) this.loadEdits(s);
      else if (s.sourceKey === OPS_KEY) this.loadOps(s);
      else this.snapshots.set(s.sourceKey, s);
    }
    this.refreshDerived();
  }

  getState(): AppState {
    return this.state;
  }

  getBoardData(): BoardData {
    const configured = this.state.sources.map((s) => s.key);
    const snaps = [...this.snapshots.values()].filter((s) => configured.includes(s.sourceKey));
    const selected = this.state.view.selected?.filter((k) => configured.includes(k)) ?? null;
    const merged = mergeSnapshots(snaps, selected);
    if (!this.edits.size) return { ...merged, allProjects: this.allProjects(), boardRepos: this.boardRepos() };
    // GitHub#229: the changes on their way show on the item itself, the others beside it
    const byKey = new Map<string, EditRecord[]>();
    for (const r of this.edits.values()) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
    const all = this.allProjects();
    return { ...merged, items: merged.items.map((it) => (byKey.has(it.key) ? overlayItem(it, byKey.get(it.key)!, all) : it)), allProjects: all, boardRepos: this.boardRepos() };
  }

  /**
   * GitHub#231: every configured Project with its items counted per repository, from its own
   * snapshot — not the filtered view — so a new issue's default board does not depend on what the
   * top filter shows. No snapshot yet = never read completely = unknown (null).
   */
  private boardRepos(): BoardRepoCount[] {
    const out: BoardRepoCount[] = [];
    for (const s of this.state.sources) {
      if (s.kind !== 'project') continue;
      const snap = this.snapshots.get(s.key);
      out.push({ key: s.key, title: snap?.project?.title ?? sourceLabel(s), repos: snap?.project ? countRepos(snap.items) : null });
    }
    return out;
  }

  /** Every configured Project, in the order the sources were added (GitHub#205: what a new issue may join). */
  private allProjects() {
    return this.state.sources.map((s) => this.snapshots.get(s.key)?.project).filter((p): p is NonNullable<typeof p> => Boolean(p));
  }

  onChange(cb: (s: AppState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Every setting written so far has reached the back end (tests read the file afterwards). */
  settled(): Promise<void> {
    return this.cache.flushed();
  }

  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    this.refreshDerived();
    for (const l of this.listeners) l(this.state);
  }

  private refreshDerived() {
    const times = this.state.sources.map((s) => this.snapshots.get(s.key)?.fetchedAt).filter((t): t is number => t != null);
    const dataFrom = times.length ? Math.min(...times) : null;
    if (dataFrom !== this.state.sync.dataFrom) this.state = { ...this.state, sync: { ...this.state.sync, dataFrom } };
  }

  async start(): Promise<void> {
    void this.readLoginItem();
    void this.readUpdate();
    const r = await this.backend.call<{ phase: 'login' | 'ready'; reason?: string | null; session?: number; wiped: boolean }>('start');
    if (r.wiped) this.dropMirror();
    if (r.phase === 'login') {
      this.set({ phase: 'login', loginReason: r.reason ?? null });
      return;
    }
    this.session = r.session!;
    this.signedIn = true;
    this.set({ phase: 'ready' });
    await this.syncNow();
  }

  startTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.cancelFollowUp();
    this.timer = setInterval(() => void this.syncNow(), this.deps.syncIntervalMs ?? SYNC_INTERVAL_MS);
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.cancelFollowUp();
    // GitHub#258: and the watches of new issues (they only end here or with the session)
    for (const t of this.watchTimers) clearTimeout(t);
    this.watchTimers.clear();
  }

  /**
   * One more sync round a few seconds after the last successful change: GitHub's
   * own automations (closed / merged → Done, …) happen on GitHub's side after
   * the immediate re-read. Several changes in a row push it back: one round, after
   * the last. Dropped when the session it was queued in is over.
   */
  private scheduleFollowUp(session: number): void {
    this.cancelFollowUp();
    this.followUp = setTimeout(() => {
      this.followUp = null;
      if (session === this.session && this.signedIn) void this.syncNow();
    }, this.deps.followUpSyncMs ?? FOLLOW_UP_SYNC_MS);
  }

  private cancelFollowUp(): void {
    if (this.followUp) clearTimeout(this.followUp);
    this.followUp = null;
  }

  // ---- login -------------------------------------------------------------

  async startLogin(): Promise<void> {
    const clientId = this.state.clientId.trim();
    const run = ++this.loginRun;
    const problem = !clientId
      ? this.state.appKind === 'github-app'
        ? '用 GitHub App 登录要先填它的 Client ID（这一版还没有内置的 GitHub App），或改回默认的 OAuth 应用'
        : '还没有配置 OAuth 应用的 Client ID，请先在下方填写'
      : // never sign in through a different kind of app than the page describes
        clientIdKindProblem(this.state.appKind, clientId);
    if (problem) {
      // a new attempt ends any older one, even when this one cannot start
      this.sendCancel();
      this.set({ login: { status: 'error', userCode: null, verificationUri: null, message: problem } });
      return;
    }
    this.set({ login: { status: 'requesting', userCode: null, verificationUri: null, message: null } });
    const fail = (status: string, message: string) =>
      this.set({
        login: { status: status === 'denied' ? 'denied' : status === 'expired' ? 'expired' : 'error', userCode: null, verificationUri: null, message },
      });
    try {
      await this.loginCancels;
      if (run !== this.loginRun) return;
      const begun = await this.backend.call<{ status: string; run?: number; userCode?: string; verificationUri?: string; message?: string }>('loginBegin', { clientId });
      if (run !== this.loginRun || begun.status === 'stale') return;
      if (begun.status !== 'waiting') return fail(begun.status, begun.message ?? '');
      this.pendingRun = begun.run ?? null;
      this.set({ login: { status: 'waiting', userCode: begun.userCode!, verificationUri: begun.verificationUri!, message: null } });
      // The back end polls GitHub, asks who this is, and stores + trusts the
      // credential as one step of its credential queue: a cancel / sign-out /
      // newer login meanwhile makes this login stale there, whatever happens here.
      const done = await this.backend.call<{ status: string; session?: number; viewer?: string | null; wiped?: boolean; message?: string; loginReason?: string | null }>(
        'loginFinish',
        { run: begun.run },
      );
      if (done.status === 'stale') {
        if (done.loginReason) this.set({ loginReason: done.loginReason });
        return;
      }
      if (done.status !== 'ok') {
        if (run === this.loginRun) fail(done.status, done.message ?? '');
        return;
      }
      if (run !== this.loginRun) {
        // cancelled here after the back end had already committed: the back end signs that
        // login out when the cancel (which names this attempt) reaches it — see sendCancel
        return;
      }
      this.pendingRun = null;
      this.session = done.session!;
      this.signedIn = true;
      if (done.wiped) this.dropMirror();
      this.cache.mirror('viewer', done.viewer ?? null);
      this.state = { ...this.state, viewer: done.viewer ?? null };
      this.set({
        phase: 'ready',
        loginReason: null,
        login: { status: 'idle', userCode: null, verificationUri: null, message: null },
      });
      await this.syncNow();
    } catch (e) {
      if (run === this.loginRun) fail('error', (e as Error).message);
    }
  }

  private sendCancel(): void {
    const run = this.pendingRun;
    this.pendingRun = null;
    const sent = this.backend
      .call<{ signedOut?: { session: number; message?: string | null } }>('loginCancel', run !== null ? { run } : {})
      .then(async (r) => {
        // the attempt had already committed: the back end signed it out
        if (r?.signedOut) await this.applySignedOut(r.signedOut.session, r.signedOut.message ?? null);
      })
      .catch(() => {});
    this.loginCancels = this.loginCancels.then(() => sent);
  }

  cancelLogin(): void {
    this.loginRun++;
    this.sendCancel();
    this.set({ login: { status: 'idle', userCode: null, verificationUri: null, message: null } });
  }

  async openVerification(): Promise<void> {
    if (this.state.login.verificationUri) await this.backend.call('openVerification');
  }

  async logout(reason: string | null = null): Promise<void> {
    this.loginRun++;
    this.signedIn = false;
    // The back end first makes it durable that the stored credential may never
    // sign us in again, and drops the cache, in one transaction; only then does
    // the page switch. The keychain delete runs after that (see logoutResult).
    // `message`: the sign-out could not be made fully durable — never shown as a clean sign-out
    const { session, message } = await this.backend.call<{ session: number; message?: string | null }>('logout', { reason });
    await this.applySignedOut(session, message ?? reason);
  }

  /** The back end signed out (asked to here, or because a refresh ended the sign-in): switch the page, then report a failed delete. */
  private async applySignedOut(session: number, reason: string | null): Promise<void> {
    if (session <= this.signedOutAt) return;
    this.signedOutAt = session;
    this.session = session;
    this.signedIn = false;
    this.cancelFollowUp();
    this.dropMirror();
    this.cache.mirror('viewer', null);
    this.set({
      phase: 'login',
      loginReason: reason,
      viewer: null,
      sync: { ...this.state.sync, problem: null },
      login: { status: 'idle', userCode: null, verificationUri: null, message: null },
    });
    const r = await this.backend.call<{ message: string | null; current: boolean }>('logoutResult', { session });
    // only while nothing newer happened (a new login commits after this delete, in the same queue)
    if (r.message && r.current && session === this.session) this.set({ loginReason: r.message });
  }

  /** The back end refreshes when due (single flight); this side shows what came of it. */
  private async fresh(force = false, gen?: number): Promise<FreshResult> {
    let r: FreshOut;
    try {
      r = await this.backend.call<FreshOut>('ensureFresh', { session: this.session, force, clientId: this.state.clientId, ...(gen !== undefined ? { gen } : {}) });
    } catch (e) {
      this.setProblem(`登录续期出错（${(e as Error).message}），会在下一轮自动重试`);
      return 'failed';
    }
    if (r.signedOut) await this.applySignedOut(r.signedOut.session, r.signedOut.reason);
    if (r.problem !== undefined && this.signedIn) this.setProblem(r.problem);
    return r.result;
  }

  /** A refreshed grant that could not be stored: the back end tries again. */
  private async saveUnsaved(): Promise<void> {
    const r = await this.backend.call<{ problem?: string | null }>('saveUnsaved');
    if (r.problem !== undefined) this.setProblem(r.problem);
  }

  private setProblem(problem: string | null): void {
    if (this.state.sync.problem !== problem) this.set({ sync: { ...this.state.sync, problem } });
  }

  /** The back end dropped every snapshot (sign-out / another account): forget them here too, and what was pending with them. */
  private dropMirror(): void {
    this.snapshots.clear();
    this.checks.clear();
    // GitHub#229: the changes, cached details and candidates belonged to that account too (the back end dropped the stored changes in the same step)
    for (const t of this.editTimers.values()) t.forEach(clearTimeout);
    this.editTimers.clear();
    this.edits.clear();
    this.editsStored = false;
    this.itemQueues.clear();
    this.detailCache.clear();
    this.optionsCache.clear();
    this.sourceReadAt.clear();
    this.itemReadAt.clear();
    for (const t of this.opTimers.values()) clearTimeout(t);
    this.opTimers.clear();
    this.ops.clear();
    this.opsStored = false;
    this.opPreparing.clear();
    // GitHub#258: the watches of that account's new issues end with it
    for (const t of this.watchTimers) clearTimeout(t);
    this.watchTimers.clear();
    this.state = { ...this.state, editsNeedingAction: 0, creates: [], ops: [] };
    this.pending.reset();
    this.unread.clear();
    this.state = { ...this.state, pendingCount: 0, unreadCount: 0, sync: { ...this.state.sync, sources: [], dataFrom: null } };
    // what was queued for the shell belonged to that account: none of it goes out any more, and the
    // cleared badge does not wait behind a notification the system is still answering
    this.desktopEra++;
    this.desktopCalls = Promise.resolve();
    this.badge();
  }

  // ---- pending: notifications, Dock badge, start-up summary (GitHub#139) ----

  /**
   * Calls to the shell go one at a time, in order. A window the user closed is
   * hidden, and its web engine may hold back a second request sent while the
   * first is in flight until the page wakes again — a badge then lagged a whole
   * sync beat behind its notification (found by test/tauri/background.spec.ts).
   */
  private desktopCalls: Promise<unknown> = Promise.resolve();
  /**
   * Bumps on sign-out / another account (dropMirror). A call queued in an earlier era is
   * dropped before it reaches the shell, and the answer to one already handed over is ignored.
   */
  private desktopEra = 0;
  /** items not yet seen (GitHub#185): the Dock badge */
  private unread = new Set<string>();
  /** the window is in front (the shell says so); while it is, new items are seen as they come */
  private active = false;
  /** bumps when the "waiting for a human" label is renamed: a recount is silent, nothing queued before it goes out */
  private labelVersion = 0;

  /** Queue one call to the shell; `run` decides right before it goes out (null = dropped). */
  private toDesktop<T>(run: (d: Desktop) => Promise<T> | null): Promise<{ answer: T; current: () => boolean } | null> | null {
    const d = this.deps.desktop;
    if (!d) return null;
    const era = this.desktopEra;
    const current = () => era === this.desktopEra;
    const p = this.desktopCalls.then(async () => {
      if (!current()) return null;
      const call = run(d);
      return call ? { answer: await call, current } : null;
    });
    this.desktopCalls = p.catch(() => undefined);
    return p;
  }

  /** Every call to the shell queued so far has been answered (the tests wait on this). */
  desktopSettled(): Promise<void> {
    return this.desktopCalls.then(() => undefined);
  }

  /** The count and the unread part of it, from the tracker's one de-duplicated set at the same moment. */
  private pendingNow(): Pick<AppState, 'pendingCount' | 'unreadCount'> {
    return { pendingCount: this.pending.count(), unreadCount: this.unreadNow() };
  }

  /**
   * The unread items (GitHub#185, the Dock badge): what became pending while the window was not
   * in front, until the user switches to it. Only items still pending count — one whose label
   * went away or that was closed meanwhile needs nobody. Nothing is forgotten here: only switching
   * to the window reads them (a label renamed and renamed back has not been seen). What a first
   * read finds is history and never unread (GitHub#251).
   */
  private unreadNow(): number {
    let n = 0;
    for (const k of this.unread) if (this.pending.has(k)) n++;
    return n;
  }

  /** The user switched to the window: everything is read — the badge and the delivered notifications go. */
  private markRead(): void {
    this.unread.clear();
    this.set({ unreadCount: 0 });
    this.badge();
    this.toDesktop((d) => d.clearNotifications())?.catch(() => {});
  }

  private badge(): void {
    // the count as it is when the call goes out; a badge that cannot be set must not break a sync round
    this.toDesktop((d) => d.setBadge(this.unreadNow()))?.catch(() => {});
  }

  /**
   * What a notification was decided on: the label and the sources (each as the
   * addition it was) that it came from. Checked again right before it goes out — the one rule for
   * every queued notification (PR #173 review rounds 1–2: sign-out, a source removed, removed and
   * added back, the label renamed and renamed back all happened while one waited).
   */
  private noticeContext(sources: string[]): NoticeContext {
    return { label: this.labelVersion, sources: sources.map((k) => [k, this.epochs.get(k) ?? 0] as const) };
  }

  /** The recorded sources still configured as the same addition. */
  private liveSources(ctx: NoticeContext): string[] {
    return ctx.sources
      .filter(([k, e]) => this.state.sources.some((s) => s.key === k) && (this.epochs.get(k) ?? 0) === e)
      .map(([k]) => k);
  }

  /** (the session is checked once, by the queue: a call from an earlier era never runs) */
  private sameContext(ctx: NoticeContext): boolean {
    return ctx.label === this.labelVersion;
  }

  /**
   * An item notification still holds when the item is pending now through at least one of the
   * sources it came from, still the same addition (another source carrying it does not revive it,
   * one of its own still carrying it keeps it — one item is one notification across sources).
   */
  private itemStillHolds(ctx: NoticeContext, key: string): boolean {
    if (!this.sameContext(ctx)) return false;
    const carriers = this.pending.carriers(key);
    return this.liveSources(ctx).some((k) => carriers.includes(k));
  }

  private notify(make: () => Alert | null): void {
    const era = this.desktopEra;
    this.toDesktop((d) => {
      const a = make();
      return a ? d.notify(a) : null;
    })?.then(
      (r) => {
        if (r && r.current()) this.reportNotification(r.answer);
      },
      (e) => {
        if (era === this.desktopEra) this.reportNotification({ ok: false, error: (e as Error).message ?? String(e) });
      },
    );
  }

  /**
   * Feed the snapshots read completely this round; notify what became pending. A source's first
   * read is only its baseline: no notification, no summary, nothing unread (GitHub#251).
   */
  private observePending(fresh: SourceSnapshot[]): void {
    const change = this.pending.observe(fresh, this.state.sources.map((s) => s.key));
    // unread (the badge): what arrived while the user was not looking at the window
    if (!this.active) for (const it of change.appeared) this.unread.add(it.key);
    for (const it of change.appeared) {
      const ctx = this.noticeContext(this.pending.carriers(it.key));
      const alert: Alert = { kind: 'item', key: it.key, url: it.url, ...itemAlertText(it) };
      this.notify(() => (this.itemStillHolds(ctx, it.key) ? alert : null));
    }
    this.badge();
    this.state = { ...this.state, ...this.pendingNow() };
  }

  /**
   * What the system did with a notification: a refusal is shown on the board
   * and in Settings instead of failing silently; the next one that goes out clears it.
   */
  private reportNotification(result: Delivery): void {
    const problem = result.ok ? null : result.error;
    if (problem !== this.state.notifyProblem) this.set({ notifyProblem: problem });
  }

  private async readLoginItem(): Promise<void> {
    let v: boolean | null = null;
    try {
      v = (await this.deps.desktop?.loginItem()) ?? null;
    } catch {
      v = null;
    }
    if (v !== this.state.launchAtLogin) this.set({ launchAtLogin: v });
  }

  async setLaunchAtLogin(on: boolean): Promise<void> {
    if (!this.deps.desktop || this.state.launchAtLogin === null) return;
    try {
      await this.deps.desktop.setLoginItem(Boolean(on));
    } catch {
      /* read back below shows what the system actually has */
    }
    await this.readLoginItem();
  }

  // ---- the app updating itself (GitHub#184): the shell decides and reports; this only shows and asks ----

  /** bumps on every status the shell sends: a read that started before one is older than it */
  private updateSeq = 0;

  private async readUpdate(): Promise<void> {
    const d = this.deps.desktop;
    if (!d) return;
    const seq = this.updateSeq;
    let v: UpdateStatus | null = null;
    try {
      v = (await d.updateStatus()) ?? null;
    } catch {
      v = null;
    }
    if (seq === this.updateSeq) this.set({ update: v });
  }

  private onUpdate(status: UpdateStatus): void {
    this.updateSeq++;
    this.set({ update: status });
  }

  async checkUpdate(): Promise<void> {
    await this.deps.desktop?.checkUpdate().catch(() => {});
  }

  async setAutoUpdate(on: boolean): Promise<void> {
    await this.deps.desktop?.setAutoUpdate(Boolean(on)).catch(() => {});
  }

  async setUpdateChannel(channel: 'stable' | 'dev'): Promise<void> {
    await this.deps.desktop?.setUpdateChannel(channel === 'dev' ? 'dev' : 'stable').catch(() => {});
  }

  async dismissUpdate(version: string): Promise<void> {
    await this.deps.desktop?.dismissUpdate(String(version)).catch(() => {});
  }

  async restartToUpdate(): Promise<void> {
    await this.deps.desktop?.restartToUpdate().catch(() => {});
  }

  /**
   * Events from the shell, one at a time: a sync beat (the shell keeps time,
   * so a hidden window keeps syncing) or a clicked notification.
   */
  async runDesktopEvents(): Promise<void> {
    const d = this.deps.desktop;
    if (!d || this.eventsRunning) return;
    this.eventsRunning = true;
    while (this.eventsRunning) {
      let ev: DesktopEvent;
      try {
        ev = await d.nextEvent();
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (!this.eventsRunning) break;
      this.onDesktopEvent(ev);
    }
  }

  stopDesktopEvents(): void {
    this.eventsRunning = false;
  }

  /** One event from the shell (also what the tests feed). */
  onDesktopEvent(ev: DesktopEvent): void {
    if (ev.kind === 'active' || ev.kind === 'inactive') {
      this.active = ev.kind === 'active';
      if (this.active) this.markRead();
      return;
    }
    if (ev.kind === 'tick') {
      void this.syncNow();
      return;
    }
    if (ev.kind === 'update') {
      this.onUpdate(ev.status);
      return;
    }
    // a click: the item's detail in the app; an item no longer on the board opens on GitHub instead
    if (this.state.phase === 'ready' && this.findItem(ev.key)) {
      this.set({ focus: { key: ev.key, seq: ++this.focusSeq } });
    } else if (ev.url) {
      void this.backend.call('openExternal', { url: ev.url }).catch(() => {});
    }
  }

  /** Write snapshots read in `session`; false when that session is over (nothing lands, here or on disk). */
  private async writeSnapshots(session: number, snaps: SourceSnapshot[]): Promise<boolean> {
    if (!snaps.length) return session === this.session;
    const r = await this.cache.enqueue(() => this.backend.call<{ written: boolean }>('replaceSnapshots', { session, snapshots: snaps }));
    return r.written && session === this.session;
  }

  /**
   * GitHub#229: land snapshots one after the other. `build` runs in the write queue, against
   * memory as every earlier landing left it, so a later landing never builds on a copy an
   * earlier one has since replaced. It returns the rows to write and `commit`, which records
   * which reads these rows hold. Only after the disk took the rows, in this session, does
   * memory take them (the ones `keep` still accepts then) and `commit` run, in the same step:
   * a read whose rows did not reach the disk leaves no trace — no row, no read time — so it
   * is never taken for evidence (PR #240 plan review round 2).
   * `ended`: the session is over; `failed`: the write threw or was refused (nothing landed).
   */
  private landSnapshots(
    session: number,
    build: () => { rows: SourceSnapshot[]; commit: (keep: (sourceKey: string) => boolean) => void },
    keep: (sourceKey: string) => boolean,
  ): Promise<{ kind: 'landed'; rows: SourceSnapshot[] } | { kind: 'ended' } | { kind: 'failed'; reason: string; error?: unknown }> {
    return this.cache.enqueue(async () => {
      if (session !== this.session) return { kind: 'ended' as const };
      const plan = build();
      if (plan.rows.length) {
        let r: { written: boolean };
        try {
          r = await this.backend.call<{ written: boolean }>('replaceSnapshots', { session, snapshots: plan.rows });
        } catch (e) {
          return { kind: 'failed' as const, reason: `没能存到本机：${(e as Error).message}`, error: e };
        }
        if (session !== this.session) return { kind: 'ended' as const };
        if (!r.written) return { kind: 'failed' as const, reason: '没能存到本机' };
      }
      const rows = plan.rows.filter((snap) => keep(snap.sourceKey));
      for (const snap of rows) this.snapshots.set(snap.sourceKey, snap);
      plan.commit(keep);
      return { kind: 'landed' as const, rows };
    });
  }

  /** the newest read of this item that landed in this source (recorded only once its rows were on disk) */
  private readAt(sourceKey: string, key: string): number {
    return Math.max(this.sourceReadAt.get(sourceKey) ?? 0, this.itemReadAt.get(`${sourceKey}\n${key}`) ?? 0);
  }

  /**
   * GitHub#229 (PR #240 plan revision 1): what GitHub holds in this field, from reads issued
   * at `since` or later that landed — the one place every decision taken on GitHub's value
   * reads it (the checks of a change, the end of a watch, the check before a resend).
   * Only the board data counts, never a read's own answer: an answer that came back after a
   * newer one, or whose rows never reached the disk, is no evidence. Among the sources that
   * qualify the newest read wins. A Project field is only read in that Project's source;
   * an item a qualifying Project source no longer has is `absent` there.
   * `own`: the read's own copy, passed only when no source carries the item at all (then
   * nothing newer can have landed) — labels and milestone only, a Project field never.
   * null: no evidence that new.
   */
  private evidence(key: string, field: EditField, since: number, own: Item | null = null): { value: EditValue } | 'absent' | null {
    let best: { value: EditValue; at: number } | null = null;
    let absent = false;
    for (const snap of this.snapshots.values()) {
      const at = this.readAt(snap.sourceKey, key);
      if (at < since) continue;
      if ((field.kind === 'status' || field.kind === 'iteration') && snap.project?.key !== field.projectKey) continue;
      const item = snap.items.find((i) => i.key === key);
      const value = item ? fieldValue(item, field) : undefined;
      if (value === undefined) {
        if (field.kind === 'status' || field.kind === 'iteration') absent = true;
        continue;
      }
      if (!best || at > best.at) best = { value, at };
    }
    if (best) return { value: best.value };
    if (own && field.kind !== 'status' && field.kind !== 'iteration') {
      const value = fieldValue(own, field);
      if (value !== undefined) return { value };
    }
    return absent ? 'absent' : null;
  }

  private bumpEpoch(key: string): void {
    this.epochs.set(key, ++this.epochSeq);
  }

  /**
   * Which kind of GitHub application the next sign-in uses. It never touches
   * the current sign-in: a token is refreshed with the app it came from.
   */
  setAppKind(kind: string): void {
    if (!APP_KINDS.includes(kind as AppKind)) return;
    const k = kind as AppKind;
    this.cache.setSetting('appKind', k);
    this.set({ appKind: k, ...this.clientIdFor(k) });
  }

  /** Saves the Client ID override of the kind currently chosen; '' = back to the built-in one. */
  setClientId(id: string): void {
    const v = id.trim();
    this.cache.setSetting(CLIENT_ID_SETTING[this.state.appKind], v);
    this.set(this.clientIdFor(this.state.appKind));
  }

  private clientIdFor(kind: AppKind): { clientId: string; clientIdIsDefault: boolean } {
    const override = this.cache.getSetting<string>(CLIENT_ID_SETTING[kind], '');
    return { clientId: override || this.defaultClientIds[kind], clientIdIsDefault: !override };
  }

  /**
   * The saved choice; OAuth app when none was saved. A preview build had only
   * one Client ID box: a GitHub App's ID saved there (they start with "Iv",
   * an OAuth app's with "Ov" or a hex string) means that user had chosen a
   * GitHub App, so it moves to the GitHub App's box and that kind is kept.
   */
  private loadAppKind(): AppKind {
    const saved = this.cache.getSetting<string | null>('appKind', null);
    if (APP_KINDS.includes(saved as AppKind)) return saved as AppKind;
    const old = this.cache.getSetting<string>(CLIENT_ID_SETTING.oauth, '');
    const kind: AppKind = /^Iv/.test(old) ? 'github-app' : 'oauth';
    if (kind === 'github-app') {
      this.cache.setSetting(CLIENT_ID_SETTING['github-app'], old);
      this.cache.setSetting(CLIENT_ID_SETTING.oauth, '');
    }
    this.cache.setSetting('appKind', kind);
    return kind;
  }

  // ---- sources & view ------------------------------------------------------

  addSource(input: string): { ok: boolean; error?: string } {
    const src = parseSource(input);
    if (!src) return { ok: false, error: '认不出这个地址：Project 请贴网址（https://github.com/orgs/<组织>/projects/<编号>），仓库写「组织/仓库名」' };
    if (this.state.sources.some((s) => s.key === src.key)) return { ok: false, error: '这个来源已经加过了' };
    const sources = [...this.state.sources, src];
    this.bumpEpoch(src.key);
    this.cache.setSetting('sources', sources);
    const view = this.state.view.selected ? { ...this.state.view, selected: [...this.state.view.selected, src.key] } : this.state.view;
    this.cache.setSetting('view', view);
    // a Project brings its saved web view along (again when it is removed and added back)
    if (src.kind === 'project') {
      const pending = this.pendingImports().filter((p) => p.sourceKey !== src.key);
      this.cache.setSetting(PENDING_IMPORTS, [...pending, { sourceKey: src.key, ...(src.view !== undefined ? { view: src.view } : {}), touched: [] }]);
    }
    this.set({ sources, view });
    void this.syncNow();
    return { ok: true };
  }

  removeSource(key: string): void {
    const sources = this.state.sources.filter((s) => s.key !== key);
    this.bumpEpoch(key);
    // GitHub#258: its watches and their buttons end with it (adding it again does not bring them back)
    for (const j of this.state.creates) if (j.watch?.some((w) => w.projectKey === key)) this.patchWatch(j.id, key, () => null);
    this.cache.setSetting('sources', sources);
    this.cache.deleteSnapshot(key);
    this.snapshots.delete(key);
    this.checks.delete(key);
    // GitHub#229: the read times of that addition go with it
    this.sourceReadAt.delete(key);
    for (const k of [...this.itemReadAt.keys()]) if (k.startsWith(`${key}\n`)) this.itemReadAt.delete(k);
    // its own items stop counting, silently
    this.pending.prune(sources.map((s) => s.key));
    this.badge();
    this.state = { ...this.state, ...this.pendingNow() };
    const view = this.state.view.selected ? { ...this.state.view, selected: this.state.view.selected.filter((k) => k !== key) } : this.state.view;
    this.cache.setSetting('view', view);
    this.cache.setSetting(PENDING_IMPORTS, this.pendingImports().filter((p) => p.sourceKey !== key));
    this.set({ sources, view, sync: { ...this.state.sync, sources: this.state.sync.sources.filter((s) => s.sourceKey !== key) } });
  }

  /** A change made by the user. Invalid values are ignored as a whole. */
  setView(patch: ViewPatch): void {
    const merged = { ...this.state.view, ...patch, table: { ...this.state.view.table, ...(patch.table ?? {}) } };
    if (!isValidView(merged)) return;
    const view: ViewSettings = merged;
    const touched = Object.keys(patch).flatMap((k) => (k === 'table' ? Object.keys(patch.table ?? {}).map((t) => `table.${t}`) : [k]));
    const pending = this.pendingImports();
    if (pending.length && touched.length) {
      this.cache.setSetting(
        PENDING_IMPORTS,
        pending.map((p) => ({ ...p, touched: [...new Set([...p.touched, ...touched])] })),
      );
    }
    this.cache.setSetting('view', view);
    this.set({ view });
  }

  private pendingImports(): PendingImport[] {
    const raw = this.cache.getSetting<unknown>(PENDING_IMPORTS, []);
    return Array.isArray(raw) ? raw.filter((p): p is PendingImport => typeof p?.sourceKey === 'string' && Array.isArray(p.touched)) : [];
  }

  /** Apply the saved web view of Projects read completely for the first time since they were added. */
  private applyImports(accepted: SourceSnapshot[]): void {
    let pending = this.pendingImports();
    if (!pending.length) return;
    let view = this.state.view;
    for (const snap of accepted) {
      const p = pending.find((x) => x.sourceKey === snap.sourceKey);
      if (!p || !snap.project) continue;
      pending = pending.filter((x) => x !== p);
      const { view: saved, note } = pickView(snap.project, p.view);
      if (!saved) {
        view = { ...view, imported: { sourceKey: snap.sourceKey, viewNumber: 0, viewName: '', notes: [note!] } };
        continue;
      }
      const patch = importView(saved, snap.project, view, note);
      const next: ViewSettings = { ...view, table: { ...view.table } };
      for (const k of ['layout', 'query', 'mode', 'swimlanes'] as const) {
        if (!p.touched.includes(k)) (next as any)[k] = patch[k];
      }
      for (const k of Object.keys(patch.table) as (keyof ViewSettings['table'])[]) {
        if (!p.touched.includes('table') && !p.touched.includes(`table.${k}`)) (next.table as any)[k] = patch.table[k];
      }
      next.imported = patch.imported;
      view = normalizeView(next);
    }
    this.cache.setSetting(PENDING_IMPORTS, pending);
    if (view !== this.state.view) {
      this.cache.setSetting('view', view);
      this.state = { ...this.state, view };
    }
  }

  // ---- sync ----------------------------------------------------------------

  /** Run one round; a call during a round queues exactly one more round. */
  syncNow(): Promise<void> {
    if (this.syncing) {
      this.resync = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        do {
          this.resync = false;
          try {
            await this.runOne();
          } catch (e) {
            // a round must never reject: the 60 s timer and the window would see an unhandled rejection
            this.set({ sync: { ...this.state.sync, syncing: false, problem: `同步出错：${(e as Error).message}` } });
          }
        } while (this.resync && this.signedIn);
      } finally {
        this.syncing = null;
        // no round runs any more: a dropped round set "syncing" and the next one may have ended early
        if (this.state.sync.syncing) this.set({ sync: { ...this.state.sync, syncing: false } });
      }
    })();
    return this.syncing;
  }

  /**
   * Refresh asked for by hand — the button or its key (GitHub#217): start over now.
   * A round that is reading GitHub is dropped: nothing it read lands anywhere, it
   * sends no further request (one already sent runs out, its answer is thrown away),
   * and a new round starts at once. A round renewing the sign-in or saving what it
   * read is not cut there (a half-done renewal can lose the sign-in, a half-done save
   * would race the new round's): it finishes, then the new round starts right after.
   * The timer and every other automatic caller keep queueing (`syncNow`): automatic
   * rounds never cut each other short. GitHub#261: the round started by hand reads every
   * source in full (the change check's "nothing changed" is not taken for it).
   */
  restartSync(): Promise<void> {
    // GitHub#261: by hand = read every source in full now, whatever the change check would say
    this.fullReadNext = true;
    if (this.round?.reading) this.round.drop();
    return this.syncNow();
  }

  /** One round, given up on (without waiting for it) when it is dropped. */
  private runOne(): Promise<void> {
    const abort = new AbortController();
    let dropped!: () => void;
    const gone = new Promise<void>((r) => (dropped = r));
    const run: SyncRun = {
      signal: abort.signal,
      reading: false,
      drop: () => {
        abort.abort();
        this.resync = true;
        dropped();
      },
    };
    this.round = run;
    // the dropped round goes on alone until its next check; whatever it ends in is nobody's business
    const done = this.runRound(run).catch((e) => {
      if (!abort.signal.aborted) throw e;
    });
    return Promise.race([done, gone]).finally(() => {
      if (this.round === run) this.round = null;
    });
  }

  private async runRound(run: SyncRun, retried = false): Promise<void> {
    if (!this.signedIn) return;
    const fresh = await this.fresh();
    if (fresh === 'ended' || !this.signedIn) return;
    await this.saveUnsaved();
    const info = await this.backend.call<GrantInfo>('grantInfo');
    if (!info.signedIn || info.session !== this.session) return;
    if (fresh !== 'ok' && info.expired) {
      // expired and no new token (GitHub unreachable, or the refresh failed for a reason
      // that does not prove the credential dead): keep everything, the cache stays
      this.set({ sync: { ...this.state.sync, syncing: false, offline: fresh === 'unreachable' } });
      return;
    }
    const session = this.session;
    const sources = this.state.sources;
    const epochAtStart = new Map(sources.map((src) => [src.key, this.epochs.get(src.key) ?? 0]));
    this.set({ sync: { ...this.state.sync, syncing: true } });
    // the one stretch a restart may cut: reading GitHub (GitHub#217)
    run.reading = true;
    // GitHub#229: every read of this round went out after this stamp (a lower bound is what the check of a change needs)
    const issuedAt = this.stamp();
    // GitHub#261: only records of this session and of the very addition of each source
    if (this.checksSession !== session) {
      this.checks.clear();
      this.checksSession = session;
    }
    // the very record objects this round starts from: at its end it may only drop those (PR #272 review round 2)
    const held = new Map(this.checks);
    const recorded = new Map<string, SourceCheck>();
    // refresh by hand: no record is offered, so every source is read in full (and new tags are taken)
    const byHand = this.fullReadNext;
    this.fullReadNext = false;
    if (!byHand) for (const [key, c] of this.checks) if (c.epoch === epochAtStart.get(key)) recorded.set(key, c.check);
    const round = await syncRound(this.client(session, run.signal), sources, this.snapshots, this.now(), recorded, this.deps.fullReadEveryMs ?? FULL_READ_EVERY_MS);
    run.reading = false;
    // Every source this round did not confirm unchanged needed a full read (it changed, the check could
    // not tell, 10 minutes were up, or the refresh was by hand). Its old record goes now, before anything
    // can fail: until a new one lands with the read, the next round reads it in full again — a read that
    // never landed (dropped round, failed or refused save, another account) is retried, never skipped
    // (PR #272 review round 1). Only a record that is still the one this round started from: a round
    // dropped by a refresh by hand finishes in the background, possibly after the newer round saved its
    // own record — that one is not this round's to drop (review round 2).
    this.dropChecks(sources.filter((src) => !round.unchanged.includes(src.key)), held);
    this.deps.afterRoundRead?.(run.signal.aborted);
    // dropped meanwhile: a newer round owns the state now, nothing of this one may land
    if (run.signal.aborted) return;
    const over = () => {
      // logged out / another account logged in meanwhile: nothing of this round may land
      this.set({ sync: { ...this.state.sync, syncing: false } });
    };
    if (session !== this.session) return over();
    // GitHub says who this token belongs to; data of anybody else goes first.
    if (round.viewer) {
      const a = await this.backend.call<{ wiped?: boolean; stale?: boolean; problem?: string }>('adoptViewer', { session, login: round.viewer });
      if (a.problem) this.setProblem(a.problem);
      if (a.stale || session !== this.session) return over();
      if (a.wiped) this.dropMirror();
    }
    // Only sources still configured *as the same addition* the round started with.
    // A source removed (or removed and re-added) meanwhile is skipped everywhere:
    // database, memory and status all take this one filtered result.
    const current = (key: string) =>
      this.state.sources.some((s) => s.key === key) && (this.epochs.get(key) ?? 0) === epochAtStart.get(key);
    // GitHub#229: an item re-read after this round started keeps that newer copy
    const landing = await this.landSnapshots(session, () => this.roundRows(round.replaced.filter((snap) => current(snap.sourceKey)), issuedAt), current);
    if (landing.kind === 'failed' && landing.error !== undefined) throw landing.error;
    // a source removed while the write was on its way: not shown either
    if (landing.kind !== 'landed') return over();
    const accepted = landing.rows;
    this.keepChecks(session, round.checks, sources, epochAtStart);
    this.feedSnapshots(accepted, issuedAt);
    for (const key of new Set([...this.ops.values()].map((r) => r.key))) if (accepted.some((snap) => snap.items.some((i) => i.key === key))) this.feedOps(key, issuedAt);
    this.applyImports(accepted);
    // Only what was read completely this round (and still belongs here) is compared.
    this.observePending(accepted);
    // GitHub#266: the back end wrote it when it adopted the viewer, under the session check;
    // a write from here could land after a sign-out and put the old name back
    if (round.viewer) this.cache.mirror('viewer', round.viewer);
    const status = round.status
      .filter((st) => current(st.sourceKey))
      .map((st) => (st.ok ? st : { ...st, dataFrom: this.snapshots.get(st.sourceKey)?.fetchedAt ?? null }));
    const untouched = this.state.sync.sources.filter((st) => !status.some((x) => x.sourceKey === st.sourceKey) && this.state.sources.some((x) => x.key === st.sourceKey));
    this.set({
      viewer: round.viewer ?? this.state.viewer,
      sync: {
        syncing: false,
        offline: round.offline,
        lastOnlineAt: round.offline ? this.state.sync.lastOnlineAt : this.now(),
        dataFrom: this.state.sync.dataFrom,
        sources: [...status, ...untouched],
        problem: this.state.sync.problem,
      },
    });
    if (round.authFailed) {
      // A GitHub App token can be refreshed once before the credential is declared dead —
      // the token this round used, not one that changed meanwhile.
      if (!retried && session === this.session && info.canRefresh) {
        const r = await this.fresh(true, info.gen);
        if (r === 'ok') return this.runRound(run, true);
        if (r === 'unreachable') this.set({ sync: { ...this.state.sync, offline: true } });
        if (r !== 'changed') return; // 'failed': kept signed in with the problem shown; 'ended': already signed out
      }
      if (session === this.session && this.signedIn) await this.logout(REASON_REVOKED);
    }
  }

  /**
   * GitHub#261: after a round landed, keep each source's new change-check record only if the
   * snapshot in memory is the one it vouches for (same fetchedAt), the source is still the same
   * addition and the session is the round's. Every other source of the round loses its record:
   * its next round is a full read.
   */
  private keepChecks(session: number, fresh: Map<string, SourceCheck>, sources: SourceConfig[], epochAtStart: Map<string, number>): void {
    for (const src of sources) {
      const c = fresh.get(src.key);
      const epoch = epochAtStart.get(src.key) ?? 0;
      const holds =
        c &&
        session === this.session &&
        this.checksSession === session &&
        (this.epochs.get(src.key) ?? 0) === epoch &&
        this.state.sources.some((s) => s.key === src.key) &&
        this.snapshots.get(src.key)?.fetchedAt === c.snapshotAt;
      if (holds) this.checks.set(src.key, { epoch, check: c });
      else this.checks.delete(src.key);
    }
  }

  /**
   * GitHub#261: forget the records of `sources` — each only while it is still the record object the
   * round started from (`held`). A record written since (a newer round's, another session's after a
   * clear) is someone else's; one cleared meanwhile stays cleared.
   */
  private dropChecks(sources: SourceConfig[], held: Map<string, { epoch: number; check: SourceCheck }>): void {
    for (const src of sources) {
      const c = this.checks.get(src.key);
      if (c && c === held.get(src.key)) this.checks.delete(src.key);
    }
  }

  /** A GitHub client whose requests the back end signs for `session`. */
  private client(session: number, signal?: AbortSignal): GitHubClient {
    return new GitHubClient(this.deps.endpoints, null, proxyFetch(this.backend, session), signal);
  }

  // ---- view & change one item ---------------------------------------------

  /** Labels "hand back to the agent" swaps; empty names fall back to the defaults. */
  /** The user picked a merge method for a PR in `repo` (GitHub#175). An unknown method is ignored. */
  setMergeMethod(repo: string, method: unknown): void {
    const next = rememberMergeMethod(this.state.mergePrefs, repo, method);
    if (next === this.state.mergePrefs) return;
    this.cache.setSetting(MERGE_PREFS, next);
    this.set({ mergePrefs: next });
  }

  /** GitHub#231: a table group folded or unfolded. Unknown input is ignored. */
  setTableFold(groupBy: unknown, key: unknown, folded: unknown): void {
    const next = setFold(this.state.tableFolds, groupBy, key, folded);
    if (next === this.state.tableFolds) return;
    this.cache.setSetting(TABLE_FOLDS, next);
    this.set({ tableFolds: next });
  }

  /** GitHub#231: "托管" asks first (true) or not ("不再提示", false). Anything but a boolean is ignored. */
  setAutopilotConfirm(on: unknown): void {
    if (typeof on !== 'boolean' || on === this.state.autopilotConfirm) return;
    this.cache.setSetting(AUTOPILOT_CONFIRM, on);
    this.set({ autopilotConfirm: on });
  }

  /** GitHub#245: who the next new issue is handed to by default (the dialog calls this after a create it was chosen for). Unknown values are ignored. */
  setNewIssueHandoff(h: unknown): void {
    if (typeof h !== 'string' || normalizeHandoff(h) !== h || h === this.state.newIssueHandoff) return;
    this.cache.setSetting(NEW_ISSUE_HANDOFF, h);
    this.set({ newIssueHandoff: h as Handoff });
  }

  setHandBack(patch: Partial<HandBackLabels>): void {
    const next: HandBackLabels = {
      human: (patch.human ?? this.state.handBack.human).trim() || DEFAULT_HAND_BACK.human,
      agent: (patch.agent ?? this.state.handBack.agent).trim() || DEFAULT_HAND_BACK.agent,
      // empty is a choice here: no autopilot button (a project without autopilot)
      autopilot: typeof patch.autopilot === 'string' ? patch.autopilot.trim() : this.state.handBack.autopilot,
    };
    this.cache.setSetting('handBack', next);
    // The same label is what reminders count: another name is recounted silently
    // (a settings change is not new work arriving).
    if (next.human !== this.state.handBack.human) {
      this.labelVersion++;
      this.pending.relabel(next.human, this.snapshots);
      this.badge();
      this.state = { ...this.state, ...this.pendingNow() };
    }
    this.set({ handBack: next });
  }

  /** A client for one call, or why there is none (signed out / offline / credential ended). */
  private async clientForCall(write: boolean): Promise<{ client: GitHubClient; session: number } | { error: string }> {
    if (!this.signedIn || this.state.phase !== 'ready') return { error: '还没有登录' };
    if (write && !writesEnabled(this.state.sync)) return { error: '离线时不能修改：GitHub 上什么都没改' };
    const fresh = await this.fresh();
    if (fresh === 'ended' || !this.signedIn) return { error: '登录已结束，请重新登录' };
    return { client: this.client(this.session), session: this.session };
  }

  /** Every item the cache holds for the configured sources, whatever the view shows. */
  private cachedItems() {
    const configured = this.state.sources.map((s) => s.key);
    return mergeSnapshots([...this.snapshots.values()].filter((s) => configured.includes(s.sourceKey)), null).items;
  }

  private findItem(key: string) {
    return this.getBoardData().items.find((i) => i.key === key) ?? null;
  }

  /** The whole detail of one item, read from GitHub now (not cached). */
  async loadDetail(key: string): Promise<DetailResult> {
    const item = this.findItem(key);
    if (!item) return { ok: false, error: '看板上找不到这一条，请刷新后再试' };
    const c = await this.clientForCall(false);
    if ('error' in c) return { ok: false, error: c.error };
    try {
      const raw = await fetchRawDetail(c.client, item.repo, item.number);
      if (c.session !== this.session) return { ok: false, error: '账号已切换' };
      const detail = toDetail(item.repo, raw, this.now());
      this.detailCache.delete(key);
      this.detailCache.set(key, detail);
      while (this.detailCache.size > DETAIL_CACHE_SIZE) this.detailCache.delete(this.detailCache.keys().next().value!);
      return { ok: true, detail };
    } catch (e) {
      this.noteAuthFailure(e);
      const msg = e instanceof GitHubError && e.kind === 'network' ? `连不上 GitHub，读不到详情（${e.message}）` : `读取详情失败：${(e as Error).message}`;
      return { ok: false, error: msg };
    }
  }

  /** GitHub#229: the detail read last in this run (shown at once on re-opening, while it is read again); null = none. */
  cachedDetail(key: string): ItemDetail | null {
    return this.detailCache.get(key) ?? null;
  }

  /**
   * Labels and milestones of one repository (the candidates the window offers).
   * GitHub#229: a read that worked is kept for this run and answers the next call
   * at once; `fresh` reads again (the detail's refresh button). A lost connection
   * is tried once more before the failure is reported; a failure is never kept.
   */
  async repoOptions(repo: string, fresh = false): Promise<RepoOptions> {
    const kept = this.optionsCache.get(repo);
    if (kept && !fresh) return kept;
    const c = await this.clientForCall(false);
    if ('error' in c) return { labels: [], milestones: [], error: c.error };
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await listRepoOptions(c.client, repo);
        if (c.session === this.session) this.optionsCache.set(repo, r);
        return r;
      } catch (e) {
        if (attempt === 0 && e instanceof GitHubError && e.kind === 'network') continue;
        this.noteAuthFailure(e);
        return { labels: [], milestones: [], error: `读取 ${repo} 的标签 / 里程碑失败：${(e as Error).message}` };
      }
    }
  }

  /** GitHub renders the reply preview (same renderer as the web page). */
  async previewMarkdown(repo: string, text: string): Promise<{ ok: boolean; html?: string; error?: string }> {
    const c = await this.clientForCall(false);
    if ('error' in c) return { ok: false, error: c.error };
    try {
      return { ok: true, html: await c.client.restText('/markdown', { text, mode: 'gfm', context: repo }) };
    } catch (e) {
      return { ok: false, error: `预览失败：${(e as Error).message}` };
    }
  }

  /**
   * Make one change on GitHub. Refused before sending when offline, signed
   * out, or the app can already tell it cannot work. On success the touched
   * item is read again from GitHub at once and the cache takes that copy.
   */
  async act(action: WriteAction): Promise<WriteResult> {
    if (isFieldAction(action)) return this.actEdit(action);
    // GitHub#250: the five operations go through the one send gate; this waits for them (the window does not)
    if (isOpKind(action.kind)) return this.actOp(action as OpAction);
    if (action.kind === 'comment' && action.draftOf) return this.actReplyFromDraft(action as Extract<WriteAction, { kind: 'comment' }> & { draftOf: string });
    if (action.kind !== 'toggleTask' && action.kind !== 'editEntry') return this.actNow(action);
    // two clicks on one comment would be two read-change-writes racing each other: the second waits its turn as a refusal
    if (this.tasksInFlight.has(action.entryId)) return { ok: false, error: '这一条上一次修改还没完成，等它完成再试', warning: null };
    this.tasksInFlight.add(action.entryId);
    try {
      return await this.actNow(action);
    } finally {
      this.tasksInFlight.delete(action.entryId);
    }
  }

  private async actNow(action: WriteAction, onOutcome?: (o: { boards?: CreateBoard[]; createdNodeId?: string; labelsNote?: string }) => void, onError?: (e: unknown) => void): Promise<WriteResult> {
    const c = await this.clientForCall(true);
    if ('error' in c) return { ok: false, error: c.error, warning: null };
    const data = this.getBoardData();
    const item = 'key' in action ? (data.items.find((i) => i.key === action.key) ?? null) : null;
    // GitHub#205: a new issue joins exactly the Projects ticked in the dialog; one the app does not know is refused before sending
    const known = this.allProjects();
    const wanted = action.kind === 'createIssue' ? (Array.isArray(action.projects) ? action.projects : null) : [];
    if (wanted === null) return { ok: false, error: '不知道要加入哪些看板，没有新建', warning: null };
    const createInProjects = wanted.map((k) => known.find((p) => p.key === k));
    if (createInProjects.some((p) => !p)) return { ok: false, error: '勾选的看板不在当前来源里（可能刚被删掉），没有新建；请重新打开对话框', warning: null };
    let outcome;
    try {
      outcome = await performAction(c.client, action, { item, projects: data.projects, handBack: this.state.handBack, createInProjects: createInProjects as ProjectMeta[], cached: this.cachedItems() });
    } catch (e) {
      if (!(e instanceof ActionRefused)) this.noteAuthFailure(e);
      onError?.(e);
      return { ok: false, error: e instanceof CreateUnanswered ? `不确定有没有建好：${e.reason}` : explainError(e, action.kind), warning: null };
    }
    onOutcome?.(outcome);
    let warning = outcome.warning;
    if (c.session === this.session) {
      for (const [repo, number] of outcome.touched) {
        const { problem } = await this.refreshOne(c.client, c.session, repo, number);
        if (problem) warning = [warning, problem].filter(Boolean).join('；');
      }
      // GitHub changed something (also when a follow-up step warned): one more round soon
      if (c.session === this.session) this.scheduleFollowUp(c.session);
    }
    return { ok: true, error: null, warning, ...(outcome.createdKey ? { createdKey: outcome.createdKey } : {}) };
  }

  /**
   * Read one item again and put it into every cached source that carries it.
   * Same guards as a sync round: nothing lands after a sign-out / account
   * switch, nor into a source removed (or re-added) meanwhile. A round already
   * in flight may have read the item before the change: one more round is queued.
   */
  /**
   * Read one item again and land it in every source that carries it. GitHub#229: the answer
   * itself is never handed out (PR #240 plan revision 1) — whoever decides on GitHub's value
   * reads it from the board data through `evidence`, with this read's `issuedAt`:
   *   done   — the read landed, or in a source was overtaken by a newer read that had landed;
   *            either way the board data holds a read issued at `issuedAt` or later
   *   failed — GitHub could not be read, or the rows did not reach the disk (`problem` says which)
   *   ended  — the session is over
   * `own`: the item's own copy, only when no source carries it (see `evidence`).
   */
  private async refreshOne(
    client: GitHubClient,
    session: number,
    repo: string,
    number: number,
    opts: { final?: boolean } = {},
  ): Promise<{ kind: 'done' | 'failed' | 'ended'; problem: string | null; issuedAt: number; own: Item | null }> {
    const sources = this.state.sources;
    const epochAtStart = new Map(sources.map((src) => [src.key, this.epochs.get(src.key) ?? 0]));
    const issuedAt = this.stamp();
    const key = itemKey(repo, number);
    const failed = (reason: string) => {
      if (session === this.session) this.feedReadFailure(key, reason, issuedAt);
      void this.syncNow();
      return { kind: 'failed' as const, problem: `修改已生效，但重读这一条失败（${reason}），下一轮同步会更新`, issuedAt, own: null };
    };
    let fresh;
    try {
      fresh = await fetchItem(client, repo, number);
    } catch (e) {
      return failed((e as Error).message);
    }
    if (session !== this.session) return { kind: 'ended', problem: null, issuedAt, own: null };
    const current = (k: string) => this.state.sources.some((s) => s.key === k) && (this.epochs.get(k) ?? 0) === epochAtStart.get(k);
    const freshK = freshKey(fresh);
    let own: Item | null = null;
    // only into sources where nothing newer of this item landed meanwhile (a read that comes back
    // after a later one would put the older value back); its read time is recorded only once the
    // rows are on disk
    const landing = await this.landSnapshots(
      session,
      () => {
        if (!freshK) return { rows: [], commit: () => {} };
        const views = freshViews(
          [...this.snapshots.values()].filter((s) => current(s.sourceKey)),
          fresh,
        );
        if (views.every((v) => !v.item)) own = contentToItem(fresh.content, [], []);
        const fresher = views.filter((v) => this.readAt(v.snap.sourceKey, freshK) < issuedAt);
        return {
          rows: applyFreshItem(
            fresher.map((v) => v.snap),
            fresh,
          ),
          commit: (keep) => {
            for (const v of fresher) if (keep(v.snap.sourceKey)) this.itemReadAt.set(`${v.snap.sourceKey}\n${freshK}`, issuedAt);
          },
        };
      },
      current,
    );
    if (landing.kind === 'ended') return { kind: 'ended', problem: null, issuedAt, own: null };
    if (landing.kind === 'failed') return failed(landing.reason);
    if (landing.rows.length) this.set({});
    // the checks of the changes read what the board data holds now (this read, or a newer one)
    this.feedEvidence(freshK ?? key, issuedAt, own, opts.final);
    this.feedOps(freshK ?? key, issuedAt, own);
    if (this.syncing) void this.syncNow();
    return { kind: 'done', problem: null, issuedAt, own };
  }

  /** A 401 on a call outside the sync round: let the next round do the refresh / sign-out logic. */
  private noteAuthFailure(e: unknown): void {
    if (e instanceof GitHubError && e.kind === 'auth') void this.syncNow();
  }

  // ---- GitHub#229: changes shown before GitHub confirms them ----------------

  /** A stamp later than every one handed out before (also across a restart: see loadEdits). */
  private stamp(): number {
    this.stampAt = Math.max(this.now(), this.stampAt + 1);
    return this.stampAt;
  }

  /** The stored records, as the last run left them: every request still waiting has no answer now, and nothing is sent again. */
  private loadEdits(row: SourceSnapshot): void {
    const raw = (row as unknown as { edits?: unknown }).edits;
    const list = Array.isArray(raw) ? raw.filter(isEditRecord) : [];
    for (const r of list) this.edits.set(r.id, afterRestart(r));
    this.editsStored = true;
    this.stampAt = Math.max(this.stampAt, latestStamp(list));
    this.editSeq = Math.max(0, ...list.flatMap((r) => r.reqs.map((q) => q.id)));
    this.state = { ...this.state, editsNeedingAction: this.needingAction() };
    // a watch that was running goes on: the first sync round reads every source anyway, the end is re-read when due
    for (const r of this.edits.values()) this.scheduleWatch(r);
  }

  private needingAction(): number {
    let n = 0;
    for (const r of this.edits.values()) {
      const st = editStatus(r);
      if (st === 'failed' || st === 'unconfirmed') n++;
    }
    return n;
  }

  /** Records changed in memory: views see them now (the caller stores them). */
  private editsChanged(): void {
    this.set({ editsNeedingAction: this.needingAction() });
  }

  /**
   * Store every record (one row of the snapshot table, written in this session
   * only: the back end refuses it after a sign-out, and drops it with the cache).
   * false = not stored: the change it was for must not go out.
   */
  private async storeEdits(): Promise<boolean> {
    const session = this.session;
    const list = [...this.edits.values()];
    try {
      if (!list.length) {
        if (this.editsStored) {
          this.editsStored = false;
          this.cache.deleteSnapshot(EDITS_KEY);
        }
        return session === this.session;
      }
      const row = { sourceKey: EDITS_KEY, fetchedAt: this.now(), items: [], edits: list } as unknown as SourceSnapshot;
      const ok = await this.writeSnapshots(session, [row]);
      if (ok) this.editsStored = true;
      return ok;
    } catch {
      return false;
    }
  }

  private setEdit(id: string, next: EditRecord | null): void {
    const before = this.edits.get(id);
    if (next) this.edits.set(id, next);
    else this.edits.delete(id);
    if (!next) {
      this.editTimers.get(id)?.forEach(clearTimeout);
      this.editTimers.delete(id);
    } else if (next.observeUntil !== null && next.observeUntil !== before?.observeUntil) {
      this.scheduleWatch(next);
    }
  }

  /** A change was made by the user: shown at once, stored, then sent behind the item's earlier changes. */
  private async actEdit(action: FieldAction): Promise<WriteResult> {
    if (!this.signedIn || this.state.phase !== 'ready') return { ok: false, error: '还没有登录', warning: null };
    if (!writesEnabled(this.state.sync)) return { ok: false, error: '离线时不能修改：GitHub 上什么都没改', warning: null };
    const item = this.findItem(action.key);
    if (!item) return { ok: false, error: '看板上找不到这一条（可能刚被同步掉了），请刷新后再试', warning: null };
    const field = this.fieldOf(action, item);
    const id = fieldId(item.key, field);
    const prev = this.edits.get(id) ?? null;
    if (!prev && this.edits.size >= MAX_EDITS) return { ok: false, error: `还有 ${MAX_EDITS} 处修改没确认，请先处理掉一些（重新发送或放弃）再改`, warning: null };
    const value = this.valueOf(action);
    const shown = fieldValue(item, field);
    const reqId = ++this.editSeq;
    this.setEdit(id, startEdit(prev, { id, key: item.key, repo: item.repo, number: item.number, field, base: shown ?? null }, value, reqId));
    this.editsChanged();
    return this.sendEdit(id, reqId, action);
  }

  private fieldOf(action: FieldAction, item: Item): EditField {
    switch (action.kind) {
      case 'addLabel':
      case 'removeLabel': {
        const color = (action.kind === 'addLabel' ? action.color : undefined) ?? item.labels.find((l) => l.name === action.label)?.color ?? this.optionsCache.get(item.repo)?.labels.find((l) => l.name === action.label)?.color ?? '';
        return { kind: 'label', label: action.label, color };
      }
      case 'setMilestone':
        return { kind: 'milestone' };
      case 'setStatus':
        return { kind: 'status', projectKey: action.projectKey };
      case 'setIteration':
        return { kind: 'iteration', projectKey: action.projectKey };
    }
  }

  private valueOf(action: FieldAction): EditValue {
    switch (action.kind) {
      case 'addLabel':
        return true;
      case 'removeLabel':
        return false;
      case 'setMilestone':
        return action.title;
      case 'setStatus':
        return action.status;
      case 'setIteration':
        return action.iterationId;
    }
  }

  /** The request that writes a record's target (for a resend). */
  private actionOf(r: EditRecord): FieldAction {
    const f = r.field;
    switch (f.kind) {
      case 'label':
        return r.target ? { kind: 'addLabel', key: r.key, label: f.label, color: f.color } : { kind: 'removeLabel', key: r.key, label: f.label };
      case 'milestone':
        return { kind: 'setMilestone', key: r.key, title: typeof r.target === 'string' ? r.target : null };
      case 'status':
        return { kind: 'setStatus', key: r.key, projectKey: f.projectKey, status: typeof r.target === 'string' ? r.target : null };
      case 'iteration':
        return { kind: 'setIteration', key: r.key, projectKey: f.projectKey, iterationId: typeof r.target === 'string' ? r.target : null };
    }
  }

  /** Behind the item's earlier changes. */
  private enqueueItem<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.itemQueues.get(key) ?? Promise.resolve();
    const p = prev.then(fn, fn);
    const tail = p.catch(() => undefined);
    this.itemQueues.set(key, tail);
    void tail.then(() => {
      if (this.itemQueues.get(key) === tail) this.itemQueues.delete(key);
    });
    return p;
  }

  /**
   * Store the record, then send its request behind the item's earlier ones. The
   * record is stored as "sent" before the request goes out (a crash in between
   * then reads as "no answer", never as "never sent"); not stored = not sent.
   */
  private async sendEdit(id: string, reqId: number, action: FieldAction): Promise<WriteResult> {
    const session = this.session;
    if (!(await this.storeEdits())) {
      const r = this.edits.get(id);
      if (r && session === this.session) {
        this.setEdit(id, applyAnswer(r, reqId, 'rejected', this.stamp(), '没能存到本机，这次修改没发出'));
        this.editsChanged();
      }
      return { ok: false, error: '没能存到本机，这次修改没发出', warning: null };
    }
    // Only the write and its answer hold the item's queue (GitHub#229 review round 1): the re-read
    // after an accepted change runs once the next change of the item may go out.
    const slot = await this.enqueueItem(action.key, () => this.sendInQueue(id, reqId, action, session));
    return slot.after ? slot.after() : slot.result;
  }

  /**
   * One request of the item's queue. Every await may let the record change (a newer change of the
   * same field, abandon, sign-out): after each one the record is read again and the request must
   * still be in it — the copy from before the await is never written back.
   */
  private async sendInQueue(id: string, reqId: number, action: FieldAction, session: number): Promise<{ result: WriteResult; after?: () => Promise<WriteResult> }> {
    const notSent = { result: { ok: false, error: '这次修改在发出前被放弃或被后一次修改取代，没有发出', warning: null } };
    const holds = () => session === this.session && Boolean(this.edits.get(id)?.reqs.some((q) => q.id === reqId));
    if (!holds()) return notSent;
    const c = await this.clientForCall(true);
    if (!holds()) return notSent;
    if ('error' in c) return { result: await this.answerEdit(id, reqId, session, 'rejected', c.error) };
    this.setEdit(id, markSent(this.edits.get(id)!, reqId, this.stamp()));
    if (!(await this.storeEdits())) return { result: await this.answerEdit(id, reqId, session, 'rejected', '没能存到本机，这次修改没发出') };
    if (!holds()) return notSent;
    const data = this.getBoardData();
    const item = data.items.find((i) => i.key === action.key) ?? null;
    let outcome;
    try {
      outcome = await performAction(c.client, action, { item, projects: data.projects, handBack: this.state.handBack, createInProjects: [], cached: this.cachedItems() });
    } catch (e) {
      if (!(e instanceof ActionRefused)) this.noteAuthFailure(e);
      const error = explainError(e, action.kind);
      if (refusedForSure(e)) return { result: await this.answerEdit(id, reqId, session, 'rejected', error) };
      // not explainError's words: they say "nothing was changed", which is exactly what is not known here
      return { result: await this.answerEdit(id, reqId, session, 'unknown', `没收到 GitHub 的明确答复（${(e as Error)?.message ?? String(e)}），不确定改没改上`) };
    }
    await this.answerEdit(id, reqId, session, 'accepted', '');
    const touched = outcome.touched;
    const first = outcome.warning;
    return {
      result: { ok: true, error: null, warning: first },
      after: async () => {
        let warning = first;
        if (session === this.session) {
          for (const [repo, number] of touched) {
            const { problem } = await this.refreshOne(c.client, session, repo, number);
            if (problem) warning = [warning, problem].filter(Boolean).join('；');
          }
          if (session === this.session) this.scheduleFollowUp(session);
        }
        return { ok: true, error: null, warning };
      },
    };
  }

  private async answerEdit(id: string, reqId: number, session: number, outcome: 'accepted' | 'rejected' | 'unknown', reason: string): Promise<WriteResult> {
    if (session === this.session) {
      const r = this.edits.get(id);
      if (r) {
        this.setEdit(id, applyAnswer(r, reqId, outcome, this.stamp(), reason));
        this.editsChanged();
        await this.storeEdits();
      }
    }
    return outcome === 'accepted' ? { ok: true, error: null, warning: null } : { ok: false, error: reason, warning: null };
  }

  /** A sync round's snapshots landed: each record whose item is in one of them reads its field from the board data. */
  private feedSnapshots(snaps: SourceSnapshot[], issuedAt: number): void {
    if (!this.edits.size || !snaps.length) return;
    const keys = new Set([...this.edits.values()].map((r) => r.key));
    for (const key of keys) {
      if (snaps.some((snap) => snap.items.some((i) => i.key === key))) this.feedEvidence(key, issuedAt);
    }
  }

  /**
   * A round's rows as they may land: a source a newer round already landed is left out; an
   * item re-read after this round started keeps the copy memory has (or stays absent when that
   * re-read took it out of the source). The read times move only in `commit`, after the write.
   */
  private roundRows(rows: SourceSnapshot[], issuedAt: number): { rows: SourceSnapshot[]; commit: (keep: (sourceKey: string) => boolean) => void } {
    const out: SourceSnapshot[] = [];
    for (const snap of rows) {
      if ((this.sourceReadAt.get(snap.sourceKey) ?? 0) > issuedAt) continue;
      const prefix = `${snap.sourceKey}\n`;
      const kept = [...this.itemReadAt].filter(([k, at]) => k.startsWith(prefix) && at > issuedAt).map(([k]) => k.slice(prefix.length));
      let items = snap.items;
      if (kept.length) {
        const shown = this.snapshots.get(snap.sourceKey)?.items ?? [];
        const keptSet = new Set(kept);
        items = snap.items.flatMap((i) => {
          if (!keptSet.has(i.key)) return [i];
          const s = shown.find((x) => x.key === i.key);
          return s ? [s] : [];
        });
        for (const k of kept) {
          const s = shown.find((x) => x.key === k);
          if (s && !items.some((x) => x.key === k)) items.push(s);
        }
      }
      out.push(items === snap.items ? snap : { ...snap, items });
    }
    const commit = (keep: (sourceKey: string) => boolean) => {
      for (const snap of out) {
        if (!keep(snap.sourceKey)) continue;
        // what this round read is now the floor of the source; older per-item stamps are covered by it
        const prefix = `${snap.sourceKey}\n`;
        this.sourceReadAt.set(snap.sourceKey, issuedAt);
        for (const [k, at] of [...this.itemReadAt]) if (k.startsWith(prefix) && at <= issuedAt) this.itemReadAt.delete(k);
      }
    };
    return { rows: out, commit };
  }

  /**
   * Every record of this item reads its field through `evidence` (reads issued at `since` or
   * later that landed); `since` is the read's issue time, a lower bound for whatever newer read
   * may have given the value — it only ever makes a read count less.
   */
  private feedEvidence(key: string, since: number, own: Item | null = null, final = false): void {
    let changed = false;
    for (const r of [...this.edits.values()]) {
      if (r.key !== key) continue;
      const ev = this.evidence(key, r.field, since, own);
      if (!ev || ev === 'absent') continue;
      const receivedAt = this.stamp();
      this.setEdit(r.id, applyRead(r, { issuedAt: since, receivedAt, value: ev.value }, this.deps.observeMs ?? OBSERVE_MS, final));
      changed = true;
    }
    if (changed) {
      this.editsChanged();
      void this.storeEdits();
    }
  }

  /** A read of this item issued at `issuedAt` failed: "GitHub unreadable" only where nothing issued later has landed. */
  private feedReadFailure(key: string, reason: string, issuedAt: number): void {
    let changed = false;
    for (const r of [...this.edits.values()]) {
      if (r.key !== key) continue;
      if (this.evidence(key, r.field, issuedAt) !== null) continue;
      this.setEdit(r.id, applyReadFailure(r, reason, this.stamp()));
      changed = true;
    }
    if (changed) this.editsChanged();
  }

  /** A watched record is re-read soon after it was checked, and once more when the watch runs out. */
  private scheduleWatch(r: EditRecord): void {
    if (r.observeUntil === null) return;
    this.editTimers.get(r.id)?.forEach(clearTimeout);
    const now = this.now();
    const first = this.deps.observeFirstMs ?? OBSERVE_FIRST_MS;
    const id = r.id;
    const end = Math.max(0, r.observeUntil - now);
    const timers = [setTimeout(() => void this.rereadForEdit(id, false), Math.min(first, end)), setTimeout(() => void this.rereadForEdit(id, true), end + 10)];
    this.editTimers.set(id, timers);
  }

  private async rereadForEdit(id: string, final: boolean): Promise<void> {
    const r = this.edits.get(id);
    if (!r || r.observeUntil === null) return;
    const c = await this.clientForCall(false);
    if ('error' in c) return;
    // the same re-read as after a change: it lands in the board data, then reads the field
    const read = await this.refreshOne(c.client, c.session, r.repo, r.number, { final });
    // the watch must not end on a failed read (GitHub unreadable, or not stored): try the end again a little later
    if (read.kind === 'failed' && final && c.session === this.session && this.edits.get(id)) {
      this.editTimers.set(id, [setTimeout(() => void this.rereadForEdit(id, true), this.deps.observeFirstMs ?? OBSERVE_FIRST_MS)]);
    }
  }

  /**
   * Send a change again (one not saved or not confirmed). Q1 = A: GitHub is read
   * first; only when it still holds the value from before the first click (or
   * already the wanted one) does it go out. Changed by somebody, or unreadable:
   * held back until `force` (the user's "overwrite anyway" / "send anyway").
   */
  async resendEdit(id: string, force = false): Promise<WriteResult> {
    const r = this.edits.get(id);
    if (!r) return { ok: false, error: '这处修改已经不在了', warning: null };
    const st = editStatus(r);
    if (st !== 'failed' && st !== 'unconfirmed') return { ok: false, error: '这处修改还在保存或核对中，不用重新发送', warning: null };
    if (!writesEnabled(this.state.sync)) return { ok: false, error: '离线时不能修改：GitHub 上什么都没改', warning: null };
    if (!force) {
      const c = await this.clientForCall(false);
      if ('error' in c) return { ok: false, error: c.error, warning: null };
      // the same re-read as after a change (it lands in the board data and feeds the checks);
      // the comparison reads GitHub's value from the board data, from reads issued at this
      // check or later that landed — never this read's own answer (PR #240 plan revision 1)
      const read = await this.refreshOne(c.client, c.session, r.repo, r.number);
      if (c.session !== this.session) return { ok: false, error: '账号已切换', warning: null };
      const cur = this.edits.get(id);
      // the read itself showed the change is on GitHub: nothing to send
      if (!cur) return { ok: true, error: null, warning: null };
      const ev = read.kind === 'done' || read.kind === 'failed' ? this.evidence(cur.key, cur.field, read.issuedAt, read.own) : null;
      if (ev === null) {
        const why = read.problem?.replace(/^修改已生效，但重读这一条失败（(.*)），下一轮同步会更新$/, '$1') ?? '读取失败';
        this.setEdit(id, { ...cur, hold: { kind: 'unreadable', reason: why } });
        this.editsChanged();
        void this.storeEdits();
        return { ok: false, error: '读不到 GitHub 现在的值，没有重新发送；确认要发就点「仍然发送」', warning: null };
      }
      if (ev === 'absent') {
        this.setEdit(id, { ...cur, hold: { kind: 'unreadable', reason: '这一条已不在那个看板上' } });
        this.editsChanged();
        return { ok: false, error: '这一条已不在那个看板上，没有重新发送', warning: null };
      }
      if (ev.value !== cur.base && ev.value !== cur.target) {
        this.setEdit(id, { ...cur, hold: { kind: 'changed', value: ev.value } });
        this.editsChanged();
        void this.storeEdits();
        return { ok: false, error: '你改之后有人改过这一项，没有重新发送；确认要覆盖就点「仍然覆盖」', warning: null };
      }
    }
    const cur = this.edits.get(id);
    if (!cur) return { ok: true, error: null, warning: null };
    const reqId = ++this.editSeq;
    this.setEdit(id, startEdit(cur, cur, cur.target, reqId));
    this.editsChanged();
    return this.sendEdit(id, reqId, this.actionOf(cur));
  }

  /** Give a change up: GitHub's value shows again. A request still on its way may land later; the next read shows what GitHub holds. */
  async abandonEdit(id: string): Promise<void> {
    if (!this.edits.has(id)) return;
    this.setEdit(id, null);
    this.editsChanged();
    await this.storeEdits();
  }

  /** Every change that needs the user, one after the other (each with its own check). */
  async resendAllEdits(): Promise<WriteResult> {
    const ids = [...this.edits.values()].filter((r) => ['failed', 'unconfirmed'].includes(editStatus(r))).map((r) => r.id);
    const held: string[] = [];
    for (const id of ids) {
      const r = await this.resendEdit(id);
      if (!r.ok && r.error) held.push(r.error);
    }
    return held.length ? { ok: false, error: `${held.length} 处没有重新发送：${held[0]}`, warning: null } : { ok: true, error: null, warning: null };
  }

  async abandonAllEdits(): Promise<void> {
    for (const r of [...this.edits.values()]) if (['failed', 'unconfirmed'].includes(editStatus(r))) this.setEdit(r.id, null);
    this.editsChanged();
    await this.storeEdits();
  }

  // ---- GitHub#229: a new issue does not hold the dialog --------------------

  /**
   * Create an issue in the background: refused at once (the dialog stays) when it
   * cannot go out at all; otherwise the dialog closes and the outcome shows above
   * the board. Only an outcome that is known to have created nothing gives the
   * draft back with a create button; no answer = "not sure", never "try again".
   */
  async startCreate(action: Extract<WriteAction, { kind: 'createIssue' }>): Promise<{ ok: boolean; error: string | null; job?: number }> {
    if (!this.signedIn || this.state.phase !== 'ready') return { ok: false, error: '还没有登录' };
    if (!writesEnabled(this.state.sync)) return { ok: false, error: '离线时不能修改：GitHub 上什么都没改' };
    if (!action.title.trim()) return { ok: false, error: '标题不能为空' };
    const id = ++this.createSeq;
    const draft = { repo: action.repo, title: action.title, body: action.body, labels: action.labels, projects: Array.isArray(action.projects) ? action.projects : [], handoff: action.handoff, handoffPicked: action.handoffPicked === true };
    this.setCreate({ id, repo: action.repo, title: action.title, status: 'running', message: null, draft });
    void this.runCreate(id, action);
    return { ok: true, error: null, job: id };
  }

  private setCreate(job: CreateJob | null, drop?: number): void {
    const others = this.state.creates.filter((j) => j.id !== (job?.id ?? drop));
    this.set({ creates: job ? [...others, job].sort((a, b) => a.id - b.id) : others });
  }

  private async runCreate(id: number, action: Extract<WriteAction, { kind: 'createIssue' }>): Promise<void> {
    const session = this.session;
    // GitHub#258 (code review round 2): which addition of each source the watches belong to, taken
    // before anything is sent — a source removed / added again while the create is on its way is another one
    const epochs = new Map((action.plan?.watch ?? []).map((w) => [w.projectKey, this.epochs.get(w.projectKey) ?? 0]));
    const job = () => this.state.creates.find((j) => j.id === id);
    const sentAt = new Date(this.now() - 60_000).toISOString();
    let r: WriteResult;
    let unanswered: string | null = null;
    let boards: CreateBoard[] = [];
    let nodeId = '';
    let labelsNote = '';
    try {
      r = await this.actNow(
        action,
        (o) => {
          boards = o.boards ?? [];
          nodeId = o.createdNodeId ?? '';
          labelsNote = o.labelsNote ?? '';
        },
        (e) => (unanswered = e instanceof CreateUnanswered ? e.reason : null),
      );
    } catch (e) {
      r = { ok: false, error: (e as Error).message, warning: null };
    }
    if (session !== this.session || !job()) return;
    const cur = job()!;
    if (r.ok && r.createdKey) {
      // GitHub#245: a hand-over picked by hand in the dialog is remembered once the issue exists — never a fallback, never a failed create
      if (action.handoffPicked === true && action.handoff) this.setNewIssueHandoff(action.handoff);
      const number = Number(r.createdKey.split('#')[1]);
      // GitHub#258: boards left unticked that may take it in by themselves
      const watch = nodeId ? this.watchEntries(action, epochs) : [];
      const done: CreateJob = { ...cur, createdKey: r.createdKey, number, boards, createdNodeId: nodeId, ...(labelsNote ? { labelsNote } : {}), ...(watch.length ? { watch } : {}) };
      // the boards' state words it when there is any; another warning (the re-read failed) is said as it came
      this.settleCreate(done, r.warning);
      this.set({ focus: { key: r.createdKey, seq: ++this.focusSeq } });
      if (watch.length) void this.runWatch(id, session, nodeId).catch(() => {});
      return;
    }
    if (unanswered === null) {
      this.setCreate({ ...cur, status: 'failed', message: r.error });
      return;
    }
    this.setCreate({ ...cur, status: 'unknown', message: `请求发出后没收到 GitHub 的明确答复（${unanswered}），不确定有没有建好` });
    // same-title issues this account opened in this repository lately: links to look at, nothing is claimed or changed
    const c = await this.clientForCall(false);
    if ('error' in c || c.session !== session) return;
    try {
      const [owner, name] = action.repo.split('/');
      const list = await c.client.restList<{ number: number; html_url: string; title: string; created_at: string; user?: { login?: string }; pull_request?: unknown }>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues?state=all&sort=created&direction=desc&since=${encodeURIComponent(sentAt)}&per_page=50`,
      );
      const since = Date.parse(sentAt) - 9 * 60_000;
      const candidates = list
        .filter((x) => !x.pull_request && x.title === action.title && (!this.state.viewer || x.user?.login === this.state.viewer) && Date.parse(x.created_at) >= since)
        .map((x) => ({ number: x.number, url: x.html_url, createdAt: x.created_at }));
      const now = job();
      if (now && now.status === 'unknown' && session === this.session) this.setCreate({ ...now, candidates });
    } catch {
      // no list: the notice still says "not sure", with the web link
    }
  }

  dismissCreate(id: number): void {
    // GitHub#258: boards still being watched keep being watched (without a notice); what was shown is gone
    const job = this.state.creates.find((j) => j.id === id);
    const active = (job?.watch ?? []).filter(watchActive);
    if (job && active.length && job.createdKey) this.setCreate({ ...job, status: 'watching', message: null, boards: [], labelsNote: undefined, watch: active });
    else this.setCreate(null, id);
  }

  /**
   * A created job's notice from all it still holds: something to say → `partial`; only boards
   * still watched → `watching` (no notice); nothing → gone. `extra`: a warning said only when
   * nothing else is (the re-read right after creating failed).
   */
  private settleCreate(job: CreateJob, extra: string | null = null): void {
    const watch = job.watch ?? [];
    const message = createNotice(job.number ?? 0, job.boards ?? [], job.labelsNote, watch) ?? extra;
    if (message) this.setCreate({ ...job, status: 'partial', message });
    else if (watch.some(watchActive)) this.setCreate({ ...job, status: 'watching', message: null });
    else this.setCreate(null, job.id);
  }

  // ---- GitHub#258: boards not ticked that take a new issue in by themselves --------
  //
  // data/autoJoin.ts holds the rules (what is written, what is left to a person, what is
  // unknown). This part schedules the looks and the checks, and feeds their results into
  // the job: one entry per board, patched in place on the job as it is at that moment.

  /** The plan's watched boards that are still sources, not ticked, and known to the app. */
  private watchEntries(action: Extract<WriteAction, { kind: 'createIssue' }>, epochs: Map<string, number>): CreateWatch[] {
    const ticked = new Set(Array.isArray(action.projects) ? action.projects : []);
    const known = this.allProjects();
    const out: CreateWatch[] = [];
    for (const w of action.plan?.watch ?? []) {
      const p = known.find((x) => x.key === w.projectKey);
      if (!p || ticked.has(w.projectKey) || out.some((x) => x.projectKey === w.projectKey)) continue;
      if ((w.iterationId === null) === (w.status === null)) continue;
      // removed (or removed and added again) while the create was on its way: not watched
      if (!epochs.has(w.projectKey) || (this.epochs.get(w.projectKey) ?? 0) !== epochs.get(w.projectKey)) continue;
      out.push({ projectKey: w.projectKey, title: p.title, iterationId: w.iterationId, status: w.status, label: String(w.label ?? w.status ?? ''), state: 'looking', writes: 0, epoch: epochs.get(w.projectKey) ?? -1 });
    }
    return out;
  }

  /** One entry of a job, changed by `f` (null = dropped), then the job settled again. */
  private patchWatch(id: number, key: string, f: (w: CreateWatch) => CreateWatch | null): void {
    const job = this.state.creates.find((j) => j.id === id);
    if (!job?.watch?.some((w) => w.projectKey === key)) return;
    const watch = job.watch.flatMap((w) => {
      if (w.projectKey !== key) return [w];
      const n = f(w);
      return n ? [n] : [];
    });
    this.settleCreate({ ...job, watch });
  }

  private watchSleep(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setTimeout(() => {
        this.watchTimers.delete(t);
        r();
      }, Math.max(0, ms));
      this.watchTimers.add(t);
    });
  }

  /**
   * The job's entry for `key`, while the session and that board's source are still the very
   * ones the entry was made for (`w.epoch`, recorded at creation — never re-read at a later
   * call: a source removed and added again is another addition, its old watch and button are over).
   */
  private watchEntry(id: number, key: string, session: number): CreateWatch | null {
    if (session !== this.session) return null;
    const job = this.state.creates.find((j) => j.id === id);
    const w = job?.watch?.find((x) => x.projectKey === key) ?? null;
    if (!w) return null;
    if (!this.state.sources.some((s) => s.key === key) || (this.epochs.get(key) ?? 0) !== w.epoch) {
      // the source was removed (or removed and added again): this watch is over
      this.patchWatch(id, key, () => null);
      return null;
    }
    return w;
  }

  private async runWatch(id: number, session: number, nodeId: string): Promise<void> {
    let why = '留意中断';
    try {
      why = await this.runLooks(id, session, nodeId);
    } finally {
      // every way out of the looks settles what is still being looked for: nothing stays
      // "looking" without a timer (code review round 1) — unknown is said, never dropped
      if (session === this.session)
        for (const w of this.state.creates.find((j) => j.id === id)?.watch ?? [])
          if (w.state === 'looking') this.patchWatch(id, w.projectKey, (x) => ({ ...x, state: 'unread', reason: why }));
    }
  }

  /** The scheduled looks. Returns why the last one could not tell (for whatever is left looking). */
  private async runLooks(id: number, session: number, nodeId: string): Promise<string> {
    const looks = this.deps.watchLooksMs ?? WATCH_LOOKS_MS;
    const start = this.state.creates.find((j) => j.id === id)?.watch ?? [];
    // a board whose auto-add is surely off never takes it in: not watched (no client now: all watched)
    const c0 = await this.clientForCall(false);
    if (!('error' in c0) && c0.session === session)
      for (const w of start) {
        const p = this.allProjects().find((x) => x.key === w.projectKey);
        if (p && (await autoAddSurelyOff(c0.client, p))) this.patchWatch(id, w.projectKey, () => null);
      }
    let why = '读不到';
    let at = 0;
    for (let i = 0; i < looks.length; i++) {
      await this.watchSleep(looks[i] - at);
      at = looks[i];
      const last = i === looks.length - 1;
      if (session !== this.session) return why;
      const keys = (this.state.creates.find((j) => j.id === id)?.watch ?? []).filter((w) => w.state === 'looking').map((w) => w.projectKey);
      const live = keys.filter((k) => this.watchEntry(id, k, session));
      if (!live.length) continue;
      const seen = await this.readWatched(id, session, nodeId, live);
      if (seen === 'ended') return why;
      for (const k of live) {
        const w = this.watchEntry(id, k, session);
        if (!w || w.state !== 'looking') continue;
        const s = typeof seen === 'string' ? null : seen.get(k);
        if (!s || s.state === 'unknown') {
          // the latest look decides: an earlier "not there" says nothing about now
          why = typeof seen === 'string' ? seen : 'GitHub 的回应没有列全这条所在的看板';
          if (last) this.patchWatch(id, k, (x) => ({ ...x, state: 'unread', reason: why }));
          continue;
        }
        if (s.state === 'absent') {
          if (last) this.patchWatch(id, k, () => null);
          continue;
        }
        await this.actOnSighting(id, k, session, s, true);
      }
    }
    return why;
  }

  /** One read for the watched boards `keys`: the sightings, or why it failed ('ended': the session is over). */
  private async readWatched(id: number, session: number, nodeId: string, keys: string[]): Promise<Map<string, BoardSighting> | string | 'ended'> {
    const c = await this.clientForCall(false);
    if (session !== this.session) return 'ended';
    if ('error' in c) return c.error;
    if (c.session !== session) return 'ended';
    const metas = this.allProjects().filter((p) => keys.includes(p.key));
    try {
      return await readCreatedBoards(c.client, nodeId, metas);
    } catch (e) {
      this.noteAuthFailure(e);
      return (e as Error)?.message ?? String(e);
    }
  }

  /** A board holds the issue: write (empty, only automatically once), finish, or leave it to a person. */
  private async actOnSighting(id: number, key: string, session: number, s: Extract<BoardSighting, { state: 'on' }>, auto: boolean): Promise<void> {
    const w = this.watchEntry(id, key, session);
    if (!w) return;
    const verdict = judgeWatch(w, s.membership);
    if (verdict === 'done') return this.patchWatch(id, key, () => null);
    if (verdict === 'human' || (auto && w.writes >= 1)) return this.patchWatch(id, key, (x) => ({ ...x, state: 'human', seen: watchedValue(x, s.membership).text, busy: false }));
    await this.writeWatched(id, key, session, s.itemId, auto);
  }

  /**
   * Write the group's value on that board. Returns why it was not written (null = written, now
   * being checked). Automatic: a refusal is said in the notice. By the button: the board stays as
   * the person saw it (button still there), the reason goes back to the click.
   */
  private async writeWatched(id: number, key: string, session: number, itemId: string, auto: boolean): Promise<string | null> {
    const c = await this.clientForCall(true);
    const w = this.watchEntry(id, key, session);
    if (!w) return '这个看板已不在来源里，没有修改';
    const p = this.allProjects().find((x) => x.key === key);
    const refused = (reason: string) => {
      this.patchWatch(id, key, (x) => (auto ? { ...x, state: 'failed', reason, busy: false } : { ...x, busy: false }));
      return reason;
    };
    if ('error' in c) return refused(c.error);
    if (c.session !== session || !p) return refused('账号已切换');
    if (auto) this.patchWatch(id, key, (x) => ({ ...x, writes: x.writes + 1 }));
    try {
      await setCreatedField(c.client, p, itemId, w.iterationId, w.status);
    } catch (e) {
      if (!(e instanceof ActionRefused)) this.noteAuthFailure(e);
      return refused(explainError(e, w.iterationId !== null ? 'setIteration' : 'setStatus'));
    }
    if (!this.watchEntry(id, key, session)) return null;
    this.patchWatch(id, key, (x) => ({ ...x, state: 'written', busy: false }));
    void this.verifyWatched(id, key, session).catch(() => {});
    return null;
  }

  /** After a write: read it back (a few tries); only seeing the value there counts as done. */
  private async verifyWatched(id: number, key: string, session: number): Promise<void> {
    try {
      await this.verifyLoop(id, key, session);
    } finally {
      const w = session === this.session ? this.state.creates.find((j) => j.id === id)?.watch?.find((x) => x.projectKey === key) : undefined;
      if (w?.state === 'written') this.patchWatch(id, key, (x) => ({ ...x, state: 'unverified', reason: x.reason ?? '核对中断' }));
    }
  }

  private async verifyLoop(id: number, key: string, session: number): Promise<void> {
    const job = this.state.creates.find((j) => j.id === id);
    const nodeId = job?.createdNodeId ?? '';
    const ms = this.deps.watchVerifyMs ?? WATCH_VERIFY_MS;
    let reason = '';
    for (let i = 0; i < WATCH_VERIFY_TRIES; i++) {
      await this.watchSleep(ms);
      const w = this.watchEntry(id, key, session);
      if (!w || w.state !== 'written') return;
      const seen = await this.readWatched(id, session, nodeId, [key]);
      if (seen === 'ended') return;
      const s = typeof seen === 'string' ? null : seen.get(key);
      if (!s || s.state === 'unknown') {
        reason = typeof seen === 'string' ? seen : 'GitHub 的回应没有列全这条所在的看板';
        continue;
      }
      // taken off the board meanwhile: nothing left to do there
      if (s.state === 'absent') return this.patchWatch(id, key, () => null);
      const verdict = judgeWatch(w, s.membership);
      if (verdict === 'done') {
        this.patchWatch(id, key, () => null);
        // the board shows it in that group now
        const c = await this.clientForCall(false);
        const cur = this.state.creates.find((j) => j.id === id) ?? job;
        if (!('error' in c) && c.session === session && cur?.createdKey) {
          const [repo, n] = [cur.repo, Number(cur.createdKey.split('#')[1])];
          await this.refreshOne(c.client, session, repo, n);
        }
        return;
      }
      // changed (or emptied) after the write: never written again automatically
      return this.patchWatch(id, key, (x) => ({ ...x, state: 'human', seen: watchedValue(x, s.membership).text }));
    }
    this.patchWatch(id, key, (x) => ({ ...x, state: 'unverified', reason }));
  }

  /**
   * GitHub#258: the notice's "change it to …" for a board that holds another value. Read again
   * first: written only while the board still holds exactly the value the notice showed (what the
   * person decided on); otherwise the notice shows the new value and nothing is written.
   */
  async applyCreateWatch(id: number, key: string): Promise<WriteResult> {
    const job = this.state.creates.find((j) => j.id === id);
    const w = job?.watch?.find((x) => x.projectKey === key);
    if (!job || !w || w.state !== 'human' || !job.createdNodeId) return { ok: false, error: '没有要改的看板', warning: null };
    if (w.busy) return { ok: false, error: '上一次修改还没完成', warning: null };
    // taken before the first wait (code review round 2): a second click meanwhile is refused above
    this.patchWatch(id, key, (x) => ({ ...x, busy: true }));
    const unbusy = (error: string): WriteResult => {
      this.patchWatch(id, key, (x) => ({ ...x, busy: false }));
      return { ok: false, error, warning: null };
    };
    const c = await this.clientForCall(true);
    if ('error' in c) return unbusy(c.error);
    const session = c.session;
    const seen = await this.readWatched(id, session, job.createdNodeId, [key]);
    if (seen === 'ended') return { ok: false, error: '账号已切换', warning: null };
    const s = typeof seen === 'string' ? null : seen.get(key);
    if (!s || s.state === 'unknown') return unbusy(`读不到这条在看板上的当前值（${typeof seen === 'string' ? seen : '回应不完整'}），没有修改`);
    if (s.state === 'absent') {
      this.patchWatch(id, key, () => null);
      return { ok: false, error: '这条已经不在这个看板上，没有修改', warning: null };
    }
    const cur = this.watchEntry(id, key, session);
    if (!cur) return { ok: false, error: '这个看板已不在来源里，没有修改', warning: null };
    if (judgeWatch(cur, s.membership) === 'done') {
      this.patchWatch(id, key, () => null);
      return { ok: true, error: null, warning: null };
    }
    const now = watchedValue(cur, s.membership).text;
    if (now !== (cur.seen ?? null)) {
      this.patchWatch(id, key, (x) => ({ ...x, seen: now, busy: false }));
      return { ok: false, error: `看板上现在是「${now ?? '空'}」，和提示里的不一样，没有修改；看过后再决定`, warning: null };
    }
    const error = await this.writeWatched(id, key, session, s.itemId, false);
    return error === null ? { ok: true, error: null, warning: null } : { ok: false, error, warning: null };
  }

  /**
   * A created issue that missed some Projects: add exactly those to it (never a new issue).
   * Addressed by the node id GitHub returned when it was created — the issue need not be on
   * any source (with only Project sources it is not, since joining that board is what failed).
   */
  async retryCreateProjects(id: number): Promise<WriteResult> {
    const cur = this.state.creates.find((j) => j.id === id);
    if (!cur || cur.status !== 'partial' || !cur.createdKey) return { ok: false, error: '没有要补的看板', warning: null };
    const c = await this.clientForCall(true);
    if ('error' in c) return { ok: false, error: c.error, warning: null };
    const results = new Map<string, CreateBoard | null>();
    for (const b of cur.boards ?? []) {
      if (b.state !== 'missing') continue;
      const p = this.allProjects().find((x) => x.key === b.projectKey);
      try {
        if (!p) throw new ActionRefused('这个看板已不在来源里');
        const fieldError = await joinCreatedIssue(c.client, p, cur.createdNodeId ?? '', b.iterationId, b.status);
        results.set(b.projectKey, fieldError === null ? null : { ...b, state: 'fieldsFailed', reason: explainError(fieldError, 'addToProject') });
      } catch (e) {
        if (!(e instanceof ActionRefused)) this.noteAuthFailure(e);
        results.set(b.projectKey, { ...b, reason: explainError(e, 'addToProject') });
      }
    }
    if (c.session !== this.session) return { ok: false, error: '账号已切换', warning: null };
    const number = Number(cur.createdKey.split('#')[1]);
    const after = [...results.values()];
    if (after.some((x) => x === null || x.state === 'fieldsFailed')) {
      // the boards it joined carry it now: read it once so it shows there
      await this.refreshOne(c.client, c.session, cur.repo, number);
      this.scheduleFollowUp(c.session);
    }
    // merged into the job as it is now (it may have changed meanwhile): only the boards this retry worked on change
    const now = this.state.creates.find((j) => j.id === id);
    const stillMissing = after.filter((x): x is CreateBoard => x !== null && x.state === 'missing');
    const fieldsNow = after.filter((x): x is CreateBoard => x !== null && x.state === 'fieldsFailed');
    const error = stillMissing.length ? stillMissing.map((x) => `「${x.title}」（${x.reason}）`).join('、') : null;
    const warning = fieldsNow.length ? `已加入看板，但字段没设上 ${fieldsNow.map((x) => `「${x.title}」（${x.reason}）`).join('、')}` : null;
    if (now) {
      const boards = mergeRetry(now.boards ?? [], results);
      // the notice goes only when nothing is left on any board, and no dropped label is left unsaid (GitHub#245);
      // boards still watched keep the job (GitHub#258)
      this.settleCreate({ ...now, number: now.number ?? number, boards });
    }
    return stillMissing.length ? { ok: false, error, warning } : { ok: true, error: null, warning };
  }


  // ---- GitHub#250: close / merge / autopilot / hand-back do not hold a dialog ------
  //
  // Each one is a record (shared/ops.ts) stored before its first request goes out and
  // updated after every answer. shared/ops.ts alone decides what a record means — whether
  // it locks its item, its notice, its buttons, its draft; this part only runs requests,
  // re-reads and evidence reads, and feeds their results in. `startOp` is the one send
  // gate: the panel, the board and `act` all go through it.

  /** The window's entry: refused at once (nothing sent) or started in the background. */
  startOp(action: OpAction, opts: { from?: string } = {}): { ok: boolean; error: string | null; id?: string } {
    const refuse = (error: string) => ({ ok: false, error });
    if (!this.signedIn || this.state.phase !== 'ready') return refuse('还没有登录');
    if (!writesEnabled(this.state.sync)) return refuse('离线时不能修改：GitHub 上什么都没改');
    if (!action || !isOpKind(action.kind)) return refuse('未知的操作');
    const item = this.findItem(action.key);
    if (!item) return refuse('看板上找不到这一条（可能刚被同步掉了），请刷新后再试');
    const blocked = this.opBlocked(item.key);
    if (blocked) return refuse(blocked);
    const step = (name: OpStep['name'], label?: string): OpStep => ({ name, ...(label !== undefined ? { label } : {}), state: 'unsent', reason: null, sentAt: null, answeredAt: null });
    let steps: OpStep[];
    let draft: OpRecord['draft'] = {};
    switch (action.kind) {
      case 'closeIssue': {
        if (item.kind !== 'issue') return refuse('这一条不是 issue');
        if (!ISSUE_CLOSE_REASONS.includes(action.reason)) return refuse('未知的关闭原因');
        const comment = typeof action.comment === 'string' ? action.comment : '';
        draft = { reason: action.reason, ...(comment.trim() ? { comment } : {}) };
        steps = comment.trim() ? [step('close'), step('comment')] : [step('close')];
        break;
      }
      case 'closePr': {
        if (item.kind !== 'pr') return refuse('这一条不是 PR');
        const comment = typeof action.comment === 'string' ? action.comment : '';
        draft = comment.trim() ? { comment } : {};
        steps = comment.trim() ? [step('close'), step('comment')] : [step('close')];
        break;
      }
      case 'merge': {
        if (item.kind !== 'pr') return refuse('这一条不是 PR');
        if (!/^[0-9a-f]{40}$/.test(action.headOid)) return refuse('不知道你看到的是哪个提交，请刷新详情后再合并');
        if (!['merge', 'squash', 'rebase'].includes(action.method)) return refuse('未知的合并方式');
        draft = { method: action.method, headOid: action.headOid };
        steps = [step('merge')];
        break;
      }
      case 'autopilot':
      case 'handBack': {
        const { human, agent, autopilot } = this.state.handBack;
        if (!human.trim() || !agent.trim()) return refuse('设置里「交给 agent」的两个标签名不能为空');
        if (action.kind === 'autopilot' && !autopilot.trim()) return refuse('设置里没有填托管标签，没有修改');
        // the autopilot label first (the daemon must see it when it picks the item up); add before remove
        steps = [...(action.kind === 'autopilot' ? [step('addLabel', autopilot)] : []), step('addLabel', agent), step('removeLabel', human)];
        break;
      }
    }
    const id = `op-${++this.opSeq}`;
    const rec: OpRecord = {
      id,
      key: item.key,
      repo: item.repo,
      number: item.number,
      kind: action.kind,
      startedAt: this.stamp(),
      steps,
      draft,
      readAt: null,
      targetSeen: false,
      unlocked: false,
      draftDropped: false,
      dismissed: false,
      stuck: false,
      checkProblem: null,
      running: true,
    };
    // a draft taken from an earlier record (its "重新关闭 / 合并 / 托管") now lives here
    const from = opts.from ? this.ops.get(opts.from) : undefined;
    if (from) this.setOp({ ...from, draftDropped: true, dismissed: true });
    this.setOp(rec);
    this.pruneOps();
    this.opsChanged();
    this.launchOp(id, item);
    return { ok: true, error: null, id };
  }

  /** Why nothing conflicting may be sent for this item now; null = it may. */
  private opBlocked(key: string): string | null {
    const lock = opLockOf([...this.ops.values()], key);
    if (lock) return `上一次操作还没结清，没有发送：${opText(lock)}`;
    if (this.opPreparing.has(key)) return '正在准备补做上一次操作剩下的步骤，没有发送';
    return null;
  }

  private launchOp(id: string, item: Item, client?: { client: GitHubClient; session: number }): void {
    const session = this.session;
    const job = this.runOp(id, item, client)
      .catch(() => undefined)
      .then(() => {
        // whatever happened, it no longer runs: the record says what came of it
        const r = this.ops.get(id);
        if (!r || !r.running || session !== this.session) return;
        this.setOp({ ...r, running: false });
        this.opsChanged();
        void this.storeOps();
      });
    this.opJobs.set(id, job);
    void job.then(() => {
      if (this.opJobs.get(id) === job) this.opJobs.delete(id);
    });
  }

  /** The requests of a record, one after the other; then the re-reads, then (if an answer never came) the evidence. */
  private async runOp(id: string, item: Item, given?: { client: GitHubClient; session: number }): Promise<void> {
    const session = this.session;
    const fail = (reason: string) => {
      const r = this.ops.get(id);
      if (!r || session !== this.session) return;
      // nothing went out: the first step that was going to carries why
      const i = r.steps.findIndex((s) => s.state === 'unsent');
      if (i < 0) return;
      this.setOp({ ...r, steps: r.steps.map((s, j) => (j === i ? { ...s, reason } : s)) });
      this.opsChanged();
      void this.storeOps();
    };
    // stored before anything goes out: not stored = not sent
    if (!(await this.storeOps())) return fail('没能存到本机，没有发送');
    const c = given ?? (await this.clientForCall(true));
    if ('error' in c) return fail(c.error);
    if (c.session !== session || session !== this.session) return;
    // what the item already has (code review round 1): evidence for a step whose answer never comes must be newer
    const first = this.ops.get(id);
    if (first && first.before === undefined && first.steps.some(needsRecords)) {
      let before: OpRecord['before'] = null;
      try {
        const rec = await readItemRecords(c.client, item.repo, item.number);
        before = { comments: rec.comments.map((x) => x.id), events: rec.labelEvents.map((x) => x.id) };
      } catch {
        // sent anyway; a step of it whose answer never comes can then only be checked by a person
      }
      if (session !== this.session) return;
      const now = this.ops.get(id);
      if (!now) return;
      this.setOp({ ...now, before });
    }
    let sent = false;
    for (let i = 0; ; i++) {
      let r = this.ops.get(id);
      if (!r || session !== this.session || i >= r.steps.length) break;
      if (r.steps[i].state !== 'unsent') continue;
      if (i > 0 && r.steps[i - 1].state !== 'ok') break;
      this.setOp((r = { ...r, steps: r.steps.map((s, j) => (j === i ? { ...s, state: 'pending' as const, reason: null, sentAt: this.stamp() } : s)) }));
      this.opsChanged();
      if (!(await this.storeOps())) {
        const now = this.ops.get(id);
        if (now && session === this.session) {
          this.setOp({ ...now, steps: now.steps.map((s, j) => (j === i ? { ...s, state: 'unsent' as const, reason: '没能存到本机，没有发送', sentAt: null } : s)) });
          this.opsChanged();
        }
        break;
      }
      sent = true;
      let state: 'ok' | 'refused' | 'unknown';
      let reason: string | null = null;
      try {
        await this.sendStep(c.client, item, r, i);
        state = 'ok';
      } catch (e) {
        if (r.steps[i].name === 'removeLabel' && e instanceof GitHubError && e.status === 404) {
          // the label is not on it (any more): that is the state wanted
          state = 'ok';
          reason = '这个标签本来就不在';
        } else if (refusedForSure(e)) {
          state = 'refused';
          reason = explainError(e, this.stepKind(r, i));
        } else {
          state = 'unknown';
          reason = unknownReason(e);
        }
        if (!(e instanceof ActionRefused)) this.noteAuthFailure(e);
      }
      if (session !== this.session) return;
      const now = this.ops.get(id);
      if (!now) return;
      this.setOp({ ...now, steps: now.steps.map((s, j) => (j === i ? { ...s, state, reason, answeredAt: this.stamp() } : s)) });
      this.opsChanged();
      await this.storeOps();
      if (state !== 'ok') break;
    }
    // every request has its result: from here the steps lock by themselves (unknown / waiting for the re-read)
    const done = this.ops.get(id);
    if (done?.running && session === this.session) {
      this.setOp({ ...done, running: false });
      this.opsChanged();
    }
    if (!sent || session !== this.session) return;
    await this.opReread(id, item, c);
    const after = this.ops.get(id);
    if (after && opPhase(after) === 'unknown') await this.recheckWith(id, c);
  }

  private stepKind(r: OpRecord, i: number): WriteAction['kind'] {
    const n = r.steps[i].name;
    if (n === 'merge') return 'merge';
    if (n === 'close') return r.kind === 'closePr' ? 'closePr' : 'closeIssue';
    if (n === 'comment') return 'comment';
    return n === 'addLabel' ? 'addLabel' : 'removeLabel';
  }

  private async sendStep(client: GitHubClient, item: Item, r: OpRecord, i: number): Promise<void> {
    const s = r.steps[i];
    switch (s.name) {
      case 'close':
        return closeStep(client, item, r.draft.reason);
      case 'comment':
        return commentStep(client, item, r.draft.comment ?? '');
      case 'merge':
        return mergeStep(client, item, r.draft.method ?? 'merge', r.draft.headOid ?? '');
      case 'addLabel':
        return addLabel(client, item.repo, item.number, s.label ?? '');
      case 'removeLabel':
        return removeLabel(client, item.repo, item.number, s.label ?? '');
    }
  }

  /** The item, and what a merge / close of a PR also changed, read again; their landing feeds the records. */
  private async opReread(id: string, item: Item, c: { client: GitHubClient; session: number }): Promise<void> {
    const r = this.ops.get(id);
    if (!r) return;
    const touched: [string, number][] = [[r.repo, r.number]];
    const problems: string[] = [];
    const closedPr = (r.kind === 'merge' || r.kind === 'closePr') && r.steps[0].state !== 'refused' && r.steps[0].state !== 'unsent';
    if (closedPr) {
      try {
        const rel = await relatedIssues(c.client, item, this.cachedItems());
        touched.push(...rel.items);
        if (rel.problem) problems.push(rel.problem);
      } catch (e) {
        // the follow-up round reads them
        problems.push(`没读到这个 PR 关联的 issue（${(e as Error)?.message ?? String(e)}），下一轮同步会更新`);
      }
    }
    for (const [repo, number] of touched) {
      if (c.session !== this.session) return;
      const read = await this.refreshOne(c.client, c.session, repo, number);
      if (read.problem) problems.push(read.problem);
    }
    if (c.session !== this.session) return;
    this.scheduleFollowUp(c.session);
    const now = this.ops.get(id);
    if (now && (problems.length || now.readProblem)) this.patchOp(id, { readProblem: problems.length ? problems.join('；') : null });
  }

  /**
   * A read of this item landed (issued at `since`): every record of it reads the item from
   * the board data — the newest read issued at `since` or later that landed (the same rule
   * as the field changes' evidence). `own`: the read's own copy, when no source carries the item.
   */
  private feedOps(key: string, since: number, own: Item | null = null): void {
    let changed = false;
    for (const r of [...this.ops.values()]) {
      if (r.key !== key) continue;
      const seen = this.itemEvidence(key, since, own);
      if (!seen) continue;
      const next = opApplyRead(r, { issuedAt: since, ...seen });
      if (next !== r) {
        this.setOp(next);
        changed = true;
      }
    }
    if (changed) {
      this.opsChanged();
      void this.storeOps();
    }
  }

  /** The item's state and labels from landed reads issued at `since` or later (the newest wins); null = none that new. */
  private itemEvidence(key: string, since: number, own: Item | null): { state: 'open' | 'closed' | 'merged'; labels: string[] } | null {
    let best: { item: Item; at: number } | null = null;
    for (const snap of this.snapshots.values()) {
      if (!this.state.sources.some((s) => s.key === snap.sourceKey)) continue;
      const at = this.readAt(snap.sourceKey, key);
      if (at < since) continue; // only reads issued at `since` or later that landed
      const it = snap.items.find((i) => i.key === key);
      if (it && (!best || at > best.at)) best = { item: it, at };
    }
    const it = best?.item ?? own;
    return it ? { state: it.state, labels: it.labels.map((l) => l.name) } : null;
  }

  /** "重新查证据": reads only — the item again, the comments, the label events. */
  async opRecheck(id: string): Promise<WriteResult> {
    const r = this.ops.get(id);
    if (!r || opPhase(r) !== 'unknown') return { ok: false, error: '这次操作没有需要查证的步骤', warning: null };
    const c = await this.clientForCall(false);
    if ('error' in c) {
      this.patchOp(id, { checkProblem: c.error });
      return { ok: false, error: c.error, warning: null };
    }
    await this.recheckWith(id, c);
    const after = this.ops.get(id);
    return after && opPhase(after) === 'unknown' ? { ok: false, error: after.checkProblem ?? '还是查不到这一步的结果', warning: null } : { ok: true, error: null, warning: null };
  }

  private async recheckWith(id: string, c: { client: GitHubClient; session: number }): Promise<void> {
    const start = this.ops.get(id);
    if (!start) return;
    const problems: string[] = [];
    // the item itself: an unknown close / merge read back closed / merged, a label read back gone
    const read = await this.refreshOne(c.client, c.session, start.repo, start.number);
    if (read.kind === 'failed' && read.problem) problems.push(`重读这一条失败（${read.problem}）`);
    if (c.session !== this.session) return;
    const login = this.state.viewer;
    const mid = this.ops.get(id);
    if (!mid) return;
    if (mid.replyState === 'unknown' || mid.steps.some((s) => s.state === 'unknown' && needsRecords(s))) {
      if (!login) problems.push('不知道当前账号是谁，查不了评论和标签记录');
      else {
        try {
          const records = await readItemRecords(c.client, mid.repo, mid.number);
          if (c.session !== this.session) return;
          const now = this.ops.get(id);
          if (now) {
            const out = opProveFromRecords(now, records, login);
            this.setOp(out.record);
            problems.push(...out.missing);
          }
        } catch (e) {
          problems.push(`读评论和标签记录失败（${(e as Error)?.message ?? String(e)}）`);
        }
      }
    }
    if (c.session !== this.session) return;
    const end = this.ops.get(id);
    if (!end) return;
    this.setOp({ ...end, checkProblem: problems.length ? problems.join('；') : null });
    this.opsChanged();
    await this.storeOps();
  }

  /** "补做剩下的步骤": the item is read first; only the label steps still missing on GitHub go out, as a new record. */
  async opFinish(id: string): Promise<{ ok: boolean; error: string | null; id?: string }> {
    const r = this.ops.get(id);
    if (!r) return { ok: false, error: '这次操作已经不在了' };
    if (!finishSteps(r).length) return { ok: false, error: '没有需要补做的步骤' };
    if (!writesEnabled(this.state.sync)) return { ok: false, error: '离线时不能修改：GitHub 上什么都没改' };
    const blocked = this.opBlocked(r.key);
    if (blocked) return { ok: false, error: blocked };
    this.opPreparing.add(r.key);
    try {
      const c = await this.clientForCall(true);
      if ('error' in c) return { ok: false, error: c.error };
      const read = await this.refreshOne(c.client, c.session, r.repo, r.number);
      if (c.session !== this.session) return { ok: false, error: '账号已切换' };
      const seen = read.kind === 'done' ? this.itemEvidence(r.key, read.issuedAt, read.own) : null;
      if (!seen) return { ok: false, error: `重读这一条失败，什么都没发${read.problem ? `（${read.problem}）` : ''}` };
      const now = this.ops.get(id);
      if (!now) return { ok: false, error: '这次操作已经不在了' };
      const steps = finishSteps(now, seen.labels);
      const item = this.findItem(r.key);
      if (!item) return { ok: false, error: '看板上找不到这一条，请刷新后再试' };
      this.opPreparing.delete(r.key);
      const lock = this.opBlocked(r.key);
      if (lock) return { ok: false, error: lock };
      if (!steps.length) {
        this.setOp({ ...now, dismissed: true });
        this.pruneOps();
        this.opsChanged();
        void this.storeOps();
        return { ok: true, error: null };
      }
      const nid = `op-${++this.opSeq}`;
      const rec: OpRecord = {
        id: nid,
        key: r.key,
        repo: r.repo,
        number: r.number,
        kind: r.kind,
        startedAt: this.stamp(),
        steps,
        draft: {},
        readAt: null,
        targetSeen: false,
        unlocked: false,
        draftDropped: false,
        dismissed: false,
        stuck: false,
        checkProblem: null,
        finishOf: id,
        running: true,
      };
      this.setOp({ ...now, dismissed: true });
      this.setOp(rec);
      this.pruneOps();
      this.opsChanged();
      this.launchOp(nid, item, c);
      return { ok: true, error: null, id: nid };
    } finally {
      this.opPreparing.delete(r.key);
    }
  }

  /** "已核对，解除锁定": local only, nothing is sent. */
  opUnlock(id: string): void {
    const r = this.ops.get(id);
    if (!r || r.unlocked) return;
    const p = opPhase(r);
    if (p !== 'unknown' && !(p === 'settling' && r.stuck)) return;
    this.patchOp(id, { unlocked: true, dismissed: false });
  }

  /** Put a notice away (a record still locking cannot be), or show it again. */
  opDismiss(id: string, dismissed = true): void {
    const r = this.ops.get(id);
    if (!r) return;
    if (dismissed && ['waiting', 'unknown', 'settling'].includes(opPhase(r))) return;
    this.patchOp(id, { dismissed });
  }

  /** "丢掉草稿": the only way besides the step being done. */
  opDropDraft(id: string): void {
    const r = this.ops.get(id);
    if (!r || opPhase(r) === 'waiting') return;
    this.patchOp(id, { draftDropped: true });
  }

  private patchOp(id: string, patch: Partial<OpRecord>): void {
    const r = this.ops.get(id);
    if (!r) return;
    this.setOp({ ...r, ...patch });
    this.pruneOps();
    this.opsChanged();
    void this.storeOps();
  }

  /**
   * A reply carrying an operation's kept comment (code review round 1): the outcome lands on that
   * record here, not in whichever panel sent it — sent = the draft is done; refused for sure (or
   * never sent) = offered again; no clear answer = "not sure", the comment is no longer offered
   * for the reply box. One such reply at a time per record.
   */
  private async actReplyFromDraft(action: Extract<WriteAction, { kind: 'comment' }> & { draftOf: string }): Promise<WriteResult> {
    const id = action.draftOf;
    const rec = this.ops.get(id);
    const { draftOf: _drop, ...plain } = action;
    if (!rec) return this.actNow(plain);
    const refuse = (error: string): WriteResult => ({ ok: false, error, warning: null });
    if (rec.replyState) return refuse('这条附带评论已经用来发过回复（结果还没确定），没有再发');
    if (opPhase(rec) === 'waiting' || opPhase(rec) === 'unknown') return refuse(`这次操作还没结清，附带评论先不发：${opText(rec)}`);
    if (!this.signedIn || this.state.phase !== 'ready') return refuse('还没有登录');
    if (!writesEnabled(this.state.sync)) return refuse('离线时不能修改：GitHub 上什么都没改');
    const item = this.findItem(plain.key);
    if (!item || item.key !== rec.key) return refuse('看板上找不到这一条，回复没有发送');
    if (!plain.body.trim()) return refuse('评论是空的，没有发送');
    // code review round 3: everything below belongs to the session it started in. One client, bound
    // to that session (the back end refuses a request signed for a session that ended), is used for
    // every read and the write; after every wait the session and the record are checked again, and a
    // save that did not go through stops it. A sign-out / another account in between = nothing sent.
    const session = this.session;
    const mine = () => session === this.session && this.ops.get(id) !== undefined;
    const ended = () => refuse('账号已切换或这次操作已不在，回复没有发送');
    this.setOp({ ...rec, replyState: 'sending', reply: { body: plain.body, before: null } });
    this.opsChanged();
    const undo = (error: string): WriteResult => {
      const now = this.ops.get(id);
      if (now && session === this.session) {
        this.setOp({ ...now, replyState: null, reply: null });
        this.opsChanged();
        void this.storeOps();
      }
      return refuse(error);
    };
    // 1. "sending" on disk before anything goes out
    if (!(await this.storeOps())) return mine() ? undo('没能存到本机，回复没有发送') : ended();
    if (!mine()) return ended();
    // 2. the credential of this session (refreshed if due) — never of a later one
    const c = await this.clientForCall(true);
    if ('error' in c) return mine() ? undo(c.error) : ended();
    if (c.session !== session || !mine()) return ended();
    // 3. the comments already there (a comment proves this reply only when it is not one of them)
    let before: string[] | null = null;
    try {
      before = (await readItemRecords(c.client, rec.repo, rec.number)).comments.map((x) => x.id);
    } catch {
      // sent anyway; if its answer never comes it can only be checked by a person
    }
    if (!mine()) return ended();
    // 4. that list on disk too (not stored = not sent: the record must say what proves it)
    this.setOp({ ...this.ops.get(id)!, reply: { body: plain.body, before } });
    if (!(await this.storeOps())) return mine() ? undo('没能存到本机，回复没有发送') : ended();
    if (!mine()) return ended();
    // 5. the write, with the same client
    let outcome: 'ok' | 'refused' | 'unknown';
    let error: string | null = null;
    try {
      await commentStep(c.client, item, plain.body);
      outcome = 'ok';
    } catch (e) {
      outcome = refusedForSure(e) ? 'refused' : 'unknown';
      error = outcome === 'refused' ? explainError(e, 'comment') : `不确定有没有发出：${unknownReason(e)}`;
      if (!(e instanceof ActionRefused)) this.noteAuthFailure(e);
    }
    if (!mine()) return outcome === 'ok' ? { ok: true, error: null, warning: '账号已切换，这条回复的结果没有记下' } : refuse(error ?? '账号已切换');
    if (outcome === 'ok') this.patchOp(id, { replyState: null, reply: null, commentUsed: true });
    else if (outcome === 'refused') this.patchOp(id, { replyState: null, reply: null });
    else this.patchOp(id, { replyState: 'unknown' });
    if (outcome !== 'ok') return refuse(error ?? '没有发出');
    // the item read again with the same client, like any change
    const read = await this.refreshOne(c.client, c.session, item.repo, item.number);
    if (c.session === this.session) this.scheduleFollowUp(c.session);
    return { ok: true, error: null, warning: read.problem };
  }

  /** `act` for the five operations: started like the window does, then waited for (requests and re-reads). */
  private async actOp(action: OpAction): Promise<WriteResult> {
    const s = this.startOp(action);
    if (!s.ok || !s.id) return { ok: false, error: s.error, warning: null };
    await this.opJobs.get(s.id);
    const r = this.ops.get(s.id);
    if (!r) return { ok: false, error: '这次操作已经不在了', warning: null };
    const m = r.steps[0];
    if (m.state !== 'ok') return { ok: false, error: opText(r), warning: null };
    return { ok: true, error: null, warning: r.steps.every((x) => x.state === 'ok') && !r.readProblem ? null : opText(r) };
  }

  private setOp(r: OpRecord): void {
    this.ops.set(r.id, r);
    // a succeeded record waiting for its re-read: the manual unlock is offered when the wait runs out
    const settling = opPhase(r) === 'settling' && !r.stuck;
    const t = this.opTimers.get(r.id);
    if (!settling) {
      if (t) clearTimeout(t);
      this.opTimers.delete(r.id);
    } else if (!t) {
      const session = this.session;
      this.opTimers.set(
        r.id,
        setTimeout(() => {
          this.opTimers.delete(r.id);
          const now = this.ops.get(r.id);
          if (!now || session !== this.session || opPhase(now) !== 'settling') return;
          this.setOp({ ...now, stuck: true });
          this.opsChanged();
          void this.storeOps();
        }, this.deps.opStuckMs ?? STUCK_MS),
      );
    }
  }

  /** Records settled, put away and with no draft left are forgotten. */
  private pruneOps(): void {
    for (const r of [...this.ops.values()]) {
      if (!opDisposable(r)) continue;
      this.ops.delete(r.id);
      const t = this.opTimers.get(r.id);
      if (t) clearTimeout(t);
      this.opTimers.delete(r.id);
    }
  }

  private opsChanged(): void {
    this.set({ ops: [...this.ops.values()] });
  }

  /** One row of the snapshot table, this session only (the back end drops it with the cache on sign-out). false = not stored. */
  private async storeOps(): Promise<boolean> {
    const session = this.session;
    const list = [...this.ops.values()];
    try {
      if (!list.length) {
        if (this.opsStored) {
          this.opsStored = false;
          this.cache.deleteSnapshot(OPS_KEY);
        }
        return session === this.session;
      }
      const row = { sourceKey: OPS_KEY, fetchedAt: this.now(), items: [], ops: list } as unknown as SourceSnapshot;
      const ok = await this.writeSnapshots(session, [row]);
      if (ok) this.opsStored = true;
      return ok;
    } catch {
      return false;
    }
  }

  /** The stored records as the last run left them: a request still waiting has no answer now, and nothing is sent again. */
  private loadOps(row: SourceSnapshot): void {
    const raw = (row as unknown as { ops?: unknown }).ops;
    const list = Array.isArray(raw) ? raw.filter(isOpRecord).map(opAfterRestart) : [];
    for (const r of list) {
      this.setOp({ ...r, stuck: false });
      this.stampAt = Math.max(this.stampAt, r.startedAt, ...r.steps.map((s) => Math.max(s.sentAt ?? 0, s.answeredAt ?? 0)), r.readAt ?? 0);
      const n = Number(/^op-(\d+)$/.exec(r.id)?.[1] ?? 0);
      if (n > this.opSeq) this.opSeq = n;
    }
    this.opsStored = true;
    this.state = { ...this.state, ops: [...this.ops.values()] };
  }
}

/** Why an answer never came (GitHub#250): the request may have been carried out. */
function unknownReason(e: unknown): string {
  if (e instanceof GitHubError) {
    if (e.kind === 'network') return `连接中断，没有收到 GitHub 的应答（${e.message}）`;
    if (e.status) return `GitHub 返回 HTTP ${e.status}，不确定有没有生效`;
  }
  return `没有收到明确的应答（${(e as Error)?.message ?? String(e)}）`;
}
