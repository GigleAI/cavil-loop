// App logic between the window and GitHub: login state, settings, sync
// rounds, cache. It runs in the window and never holds the GitHub credential:
// signing in, refreshing, signing out and every request that needs the
// credential go through the back end (src-tauri/crates/core, Rust), which
// signs requests for a session it names. No Electron / Tauri / Node imports —
// the unit tests drive it against the fake GitHub with the real Rust back end
// as a child process.

import { APP_KINDS, DEFAULT_HAND_BACK, type AppKind, type AppState, type BoardData, type CreateJob, type HandBackLabels, type Item, type ProjectMeta, type SourceConfig, type SourceSnapshot, type ViewSettings } from '../shared/types';
import type { DetailResult, ItemDetail, RepoOptions, WriteAction, WriteResult } from '../shared/actions';
import { isValidView, normalizeView, type ViewPatch } from '../shared/viewSettings';
import { normalizeMergePrefs, rememberMergeMethod } from '../shared/mergePrefs';
import { importView, pickView } from '../shared/viewImport';
import { itemKey, parseSource } from '../shared/sources';
import { clientIdKindProblem } from '../shared/appKind';
import { DEFAULT_GITHUB_APP_CLIENT_ID, DEFAULT_OAUTH_CLIENT_ID, FOLLOW_UP_SYNC_MS, SYNC_INTERVAL_MS } from '../shared/config';
import { Endpoints, GitHubClient } from '../data/github';
import { mergeSnapshots } from '../data/merge';
import { syncRound } from '../data/sync';
import { writesEnabled } from '../data/board';
import { ActionRefused, CreateUnanswered, explainError, listRepoOptions, performAction, refusedForSure } from '../data/actions';
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
import { PendingTracker, itemAlertText, summaryAlertText } from '../data/pending';
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
  /** built-in OAuth Client ID (tests inject their own; production uses the constant) */
  defaultClientId?: string;
  /** built-in GitHub App Client ID ('' = none, which is production today) */
  defaultGithubAppClientId?: string;
  /** notifications, Dock badge, launch at login, sync beat (none: nothing is shown, the counting still runs) */
  desktop?: Desktop;
  /** GitHub#229: how long an older unanswered change is watched for, and the first re-read of it (tests shorten them) */
  observeMs?: number;
  observeFirstMs?: number;
}

/** GitHub#229: the row of the snapshot table that holds the changes not yet confirmed (not a source). */
export const EDITS_KEY = '__edits__';
/** GitHub#229: how many item details are kept for a fast re-open (this run only, never on disk). */
export const DETAIL_CACHE_SIZE = 50;

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
  /** details read in this run, newest last (re-opening shows the last one while the new read is on its way) */
  private detailCache = new Map<string, ItemDetail>();
  /** labels / milestones per repository, only reads that worked */
  private optionsCache = new Map<string, RepoOptions>();
  private createSeq = 0;

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
      pendingCount: 0,
      pendingItems: [],
      unreadCount: 0,
      launchAtLogin: null,
      notifyProblem: null,
      focus: null,
      update: null,
      editsNeedingAction: 0,
      creates: [],
    };
    for (const s of init.snapshots) {
      if (s.sourceKey === EDITS_KEY) this.loadEdits(s);
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
    if (!this.edits.size) return { ...merged, allProjects: this.allProjects() };
    // GitHub#229: the changes on their way show on the item itself, the others beside it
    const byKey = new Map<string, EditRecord[]>();
    for (const r of this.edits.values()) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
    const all = this.allProjects();
    return { ...merged, items: merged.items.map((it) => (byKey.has(it.key) ? overlayItem(it, byKey.get(it.key)!, all) : it)), allProjects: all };
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
    this.stopTimer();
    this.timer = setInterval(() => void this.syncNow(), this.deps.syncIntervalMs ?? SYNC_INTERVAL_MS);
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.cancelFollowUp();
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
    // GitHub#229: the changes, cached details and candidates belonged to that account too (the back end dropped the stored changes in the same step)
    for (const t of this.editTimers.values()) t.forEach(clearTimeout);
    this.editTimers.clear();
    this.edits.clear();
    this.editsStored = false;
    this.itemQueues.clear();
    this.detailCache.clear();
    this.optionsCache.clear();
    this.state = { ...this.state, editsNeedingAction: 0, creates: [] };
    this.pending.reset();
    this.unread.clear();
    this.state = { ...this.state, pendingCount: 0, pendingItems: [], unreadCount: 0, sync: { ...this.state.sync, sources: [], dataFrom: null } };
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

  /**
   * The count and the list the settings page shows, from the tracker's one
   * de-duplicated set at the same moment (GitHub#185): every place that updates
   * the count updates the list with it.
   */
  private pendingNow(): Pick<AppState, 'pendingCount' | 'pendingItems' | 'unreadCount'> {
    return { pendingCount: this.pending.count(), pendingItems: this.pending.list(), unreadCount: this.unreadNow() };
  }

  /**
   * The unread items (GitHub#185, the Dock badge): what became pending while the window was not
   * in front, until the user switches to it. Only items still pending count — one whose label
   * went away meanwhile needs nobody. Nothing is forgotten here: only switching to the window
   * reads them (a label renamed and renamed back has not been seen).
   */
  private unreadNow(): number {
    let n = 0;
    for (const e of this.pending.list()) if (this.unread.has(e.key)) n++;
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

  /** A summary still holds when every source whose first read it reports is still that addition. */
  private summaryStillHolds(ctx: NoticeContext): boolean {
    return this.sameContext(ctx) && this.liveSources(ctx).length === ctx.sources.length;
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

  /** Feed the snapshots read completely this round; notify what became pending, summarise first reads. */
  private observePending(fresh: SourceSnapshot[]): void {
    const change = this.pending.observe(fresh, this.state.sources.map((s) => s.key));
    // unread (the badge): what arrived while the user was not looking at the window
    if (!this.active) for (const k of [...change.appeared.map((i) => i.key), ...change.brought]) this.unread.add(k);
    for (const it of change.appeared) {
      const ctx = this.noticeContext(this.pending.carriers(it.key));
      const alert: Alert = { kind: 'item', key: it.key, url: it.url, ...itemAlertText(it) };
      this.notify(() => (this.itemStillHolds(ctx, it.key) ? alert : null));
    }
    if (change.summary) {
      const summary = change.summary;
      const ctx = this.noticeContext(summary.sources);
      // the numbers are the ones at the moment it goes out: the same count as the badge then
      this.notify(() => (this.summaryStillHolds(ctx) ? { kind: 'summary', ...summaryAlertText({ ...summary, ...this.pending.totals() }) } : null));
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

  /**
   * A row of the settings page's pending list was clicked (GitHub#185): exactly what a
   * click on that item's notification does — its detail in the app when the board
   * has it, otherwise GitHub in the browser. A key no longer pending does nothing.
   */
  openPending(key: string): void {
    const entry = this.state.pendingItems.find((e) => e.key === key);
    if (entry) this.onDesktopEvent({ kind: 'open', key: entry.key, url: entry.url });
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
    this.cache.setSetting('sources', sources);
    this.cache.deleteSnapshot(key);
    this.snapshots.delete(key);
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
   * rounds never cut each other short.
   */
  restartSync(): Promise<void> {
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
    const round = await syncRound(this.client(session, run.signal), sources, this.snapshots, this.now());
    run.reading = false;
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
    let accepted = round.replaced.filter((snap) => current(snap.sourceKey));
    if (!(await this.writeSnapshots(session, accepted))) return over();
    // a source removed while the write was on its way: not shown either
    accepted = accepted.filter((snap) => current(snap.sourceKey));
    for (const snap of accepted) this.snapshots.set(snap.sourceKey, snap);
    this.feedSnapshots(accepted, issuedAt);
    this.applyImports(accepted);
    // Only what was read completely this round (and still belongs here) is compared.
    this.observePending(accepted);
    if (round.viewer) this.cache.setSetting('viewer', round.viewer);
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

  private async actNow(action: WriteAction, onOutcome?: (o: { missingProjects?: string[] }) => void, onError?: (e: unknown) => void): Promise<WriteResult> {
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
        const problem = await this.refreshOne(c.client, c.session, repo, number);
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
  private async refreshOne(client: GitHubClient, session: number, repo: string, number: number, opts: { final?: boolean; out?: { fresh?: FreshItem } } = {}): Promise<string | null> {
    const sources = this.state.sources;
    const epochAtStart = new Map(sources.map((src) => [src.key, this.epochs.get(src.key) ?? 0]));
    const issuedAt = this.stamp();
    let fresh;
    try {
      fresh = await fetchItem(client, repo, number);
    } catch (e) {
      if (session === this.session) this.feedReadFailure(itemKey(repo, number), (e as Error).message);
      void this.syncNow();
      return `修改已生效，但重读这一条失败（${(e as Error).message}），下一轮同步会更新`;
    }
    if (session !== this.session) return null;
    if (opts.out) opts.out.fresh = fresh;
    const current = (key: string) =>
      this.state.sources.some((s) => s.key === key) && (this.epochs.get(key) ?? 0) === epochAtStart.get(key);
    const changed = applyFreshItem([...this.snapshots.values()].filter((s) => current(s.sourceKey)), fresh);
    if (changed.length && (await this.writeSnapshots(session, changed))) {
      for (const snap of changed.filter((s) => current(s.sourceKey))) this.snapshots.set(snap.sourceKey, snap);
      this.set({});
    }
    // GitHub#229: only once the read landed (or had nothing to change) in this session
    if (session === this.session && (!changed.length || changed.some((snap) => this.snapshots.get(snap.sourceKey) === snap))) this.feedFresh(fresh, issuedAt, opts.final);
    if (this.syncing) void this.syncNow();
    return null;
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
    return this.enqueueItem(action.key, async (): Promise<WriteResult> => {
      const before = this.edits.get(id);
      if (session !== this.session || !before?.reqs.some((q) => q.id === reqId)) {
        return { ok: false, error: '这次修改在发出前被放弃或被后一次修改取代，没有发出', warning: null };
      }
      const c = await this.clientForCall(true);
      if ('error' in c) return this.answerEdit(id, reqId, session, 'rejected', c.error);
      const sent = markSent(before, reqId, this.stamp());
      this.setEdit(id, sent);
      if (!(await this.storeEdits())) return this.answerEdit(id, reqId, session, 'rejected', '没能存到本机，这次修改没发出');
      const data = this.getBoardData();
      const item = data.items.find((i) => i.key === action.key) ?? null;
      let outcome;
      try {
        outcome = await performAction(c.client, action, { item, projects: data.projects, handBack: this.state.handBack, createInProjects: [], cached: this.cachedItems() });
      } catch (e) {
        if (!(e instanceof ActionRefused)) this.noteAuthFailure(e);
        const error = explainError(e, action.kind);
        if (refusedForSure(e)) return this.answerEdit(id, reqId, session, 'rejected', error);
        // not explainError's words: they say "nothing was changed", which is exactly what is not known here
        return this.answerEdit(id, reqId, session, 'unknown', `没收到 GitHub 的明确答复（${(e as Error)?.message ?? String(e)}），不确定改没改上`);
      }
      await this.answerEdit(id, reqId, session, 'accepted', '');
      let warning = outcome.warning;
      if (session === this.session) {
        for (const [repo, number] of outcome.touched) {
          const problem = await this.refreshOne(c.client, session, repo, number);
          if (problem) warning = [warning, problem].filter(Boolean).join('；');
        }
        if (session === this.session) this.scheduleFollowUp(session);
      }
      return { ok: true, error: null, warning };
    });
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

  /** A sync round's snapshots landed: each record whose item is in one of them reads its field there. */
  private feedSnapshots(snaps: SourceSnapshot[], issuedAt: number): void {
    if (!this.edits.size || !snaps.length) return;
    const keys = new Set([...this.edits.values()].map((r) => r.key));
    for (const key of keys) {
      const copies = snaps.flatMap((snap) => snap.items.filter((i) => i.key === key));
      if (copies.length) this.feedRead(key, copies, issuedAt);
    }
  }

  /** One item was re-read: its own copy says labels / milestone, each Project it is on says that Project's fields. */
  private feedFresh(fresh: FreshItem, issuedAt: number, final = false): void {
    const key = freshKey(fresh);
    if (!key || ![...this.edits.values()].some((r) => r.key === key)) return;
    const base = contentToItem(fresh.content, [], []);
    const projectCopies = freshViews(
      [...this.snapshots.values()].filter((s) => s.project),
      fresh,
    ).flatMap((v) => (v.item ? [v.item] : []));
    this.feedRead(key, [...(base ? [base] : []), ...projectCopies], issuedAt, final);
  }

  private feedRead(key: string, copies: Item[], issuedAt: number, final = false): void {
    const receivedAt = this.stamp();
    let changed = false;
    for (const r of [...this.edits.values()]) {
      if (r.key !== key) continue;
      const value = copies.map((c) => fieldValue(c, r.field)).find((v) => v !== undefined);
      if (value === undefined) continue;
      this.setEdit(r.id, applyRead(r, { issuedAt, receivedAt, value }, this.deps.observeMs ?? OBSERVE_MS, final));
      changed = true;
    }
    if (changed) {
      this.editsChanged();
      void this.storeEdits();
    }
  }

  private feedReadFailure(key: string, reason: string): void {
    let changed = false;
    for (const r of [...this.edits.values()]) {
      if (r.key !== key) continue;
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
    const problem = await this.refreshOne(c.client, c.session, r.repo, r.number, { final });
    // the watch must not end on a failed read: try the end again a little later
    if (problem && final && c.session === this.session && this.edits.get(id)) {
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
      // the same re-read as after a change (it lands in the board data and reads the field), kept for the comparison
      const out: { fresh?: FreshItem } = {};
      const problem = await this.refreshOne(c.client, c.session, r.repo, r.number, { out });
      if (c.session !== this.session) return { ok: false, error: '账号已切换', warning: null };
      const fresh = out.fresh;
      if (!fresh) {
        const cur = this.edits.get(id);
        const why = problem ?? '读取失败';
        if (cur) this.setEdit(id, { ...cur, hold: { kind: 'unreadable', reason: why.replace(/^修改已生效，但重读这一条失败（(.*)），下一轮同步会更新$/, '$1') } });
        this.editsChanged();
        void this.storeEdits();
        return { ok: false, error: '读不到 GitHub 现在的值，没有重新发送；确认要发就点「仍然发送」', warning: null };
      }
      const cur = this.edits.get(id);
      // the read itself showed the change is on GitHub: nothing to send
      if (!cur) return { ok: true, error: null, warning: null };
      const base = contentToItem(fresh.content, [], []);
      const copies = [...(base ? [base] : []), ...freshViews([...this.snapshots.values()].filter((s) => s.project), fresh).flatMap((v) => (v.item ? [v.item] : []))];
      const now = copies.map((x) => fieldValue(x, cur.field)).find((v) => v !== undefined);
      if (now === undefined) {
        this.setEdit(id, { ...cur, hold: { kind: 'unreadable', reason: '这一条已不在那个看板上' } });
        this.editsChanged();
        return { ok: false, error: '这一条已不在那个看板上，没有重新发送', warning: null };
      }
      if (now !== cur.base && now !== cur.target) {
        this.setEdit(id, { ...cur, hold: { kind: 'changed', value: now } });
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
    const draft = { repo: action.repo, title: action.title, body: action.body, labels: action.labels, projects: Array.isArray(action.projects) ? action.projects : [] };
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
    const job = () => this.state.creates.find((j) => j.id === id);
    const sentAt = new Date(this.now() - 60_000).toISOString();
    let r: WriteResult;
    let unanswered: string | null = null;
    let missing: string[] = [];
    try {
      r = await this.actNow(action, (o) => (missing = o.missingProjects ?? []), (e) => (unanswered = e instanceof CreateUnanswered ? e.reason : null));
    } catch (e) {
      r = { ok: false, error: (e as Error).message, warning: null };
    }
    if (session !== this.session || !job()) return;
    const cur = job()!;
    if (r.ok && r.createdKey) {
      const number = Number(r.createdKey.split('#')[1]);
      if (r.warning) this.setCreate({ ...cur, status: 'partial', message: r.warning, createdKey: r.createdKey, number, missingProjects: missing });
      else this.setCreate(null, id);
      this.set({ focus: { key: r.createdKey, seq: ++this.focusSeq } });
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
    this.setCreate(null, id);
  }

  /** A created issue that missed some Projects: add exactly those to it (never a new issue). */
  async retryCreateProjects(id: number): Promise<WriteResult> {
    const cur = this.state.creates.find((j) => j.id === id);
    if (!cur || cur.status !== 'partial' || !cur.createdKey) return { ok: false, error: '没有要补的看板', warning: null };
    const left: string[] = [];
    let error: string | null = null;
    for (const projectKey of cur.missingProjects ?? []) {
      const r = await this.actNow({ kind: 'addToProject', key: cur.createdKey, projectKey, iterationId: null, status: null });
      if (!r.ok) {
        left.push(projectKey);
        error = r.error;
      }
    }
    const now = this.state.creates.find((j) => j.id === id);
    if (!now) return { ok: !left.length, error, warning: null };
    if (!left.length) this.setCreate(null, id);
    else this.setCreate({ ...now, missingProjects: left, message: `#${now.number} 已建好，但还有 ${left.length} 个看板没加进去：${error}` });
    return left.length ? { ok: false, error, warning: null } : { ok: true, error: null, warning: null };
  }
}
