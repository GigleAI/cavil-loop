// App logic between the window and GitHub: login state, settings, sync
// rounds, cache. It runs in the window and never holds the GitHub credential:
// signing in, refreshing, signing out and every request that needs the
// credential go through the back end (src-tauri/crates/core, Rust), which
// signs requests for a session it names. No Electron / Tauri / Node imports —
// the unit tests drive it against the fake GitHub with the real Rust back end
// as a child process.

import { APP_KINDS, DEFAULT_HAND_BACK, type AppKind, type AppState, type BoardData, type HandBackLabels, type SourceConfig, type SourceSnapshot, type ViewSettings } from '../shared/types';
import type { DetailResult, RepoOptions, WriteAction, WriteResult } from '../shared/actions';
import { isValidView, normalizeView, type ViewPatch } from '../shared/viewSettings';
import { normalizeMergePrefs, rememberMergeMethod } from '../shared/mergePrefs';
import { importView, pickView } from '../shared/viewImport';
import { parseSource } from '../shared/sources';
import { clientIdKindProblem } from '../shared/appKind';
import { DEFAULT_GITHUB_APP_CLIENT_ID, DEFAULT_OAUTH_CLIENT_ID, SYNC_INTERVAL_MS } from '../shared/config';
import { Endpoints, GitHubClient } from '../data/github';
import { mergeSnapshots } from '../data/merge';
import { syncRound } from '../data/sync';
import { writesEnabled } from '../data/board';
import { ActionRefused, explainError, listRepoOptions, performAction } from '../data/actions';
import { fetchRawDetail, toDetail } from '../data/detail';
import { applyFreshItem, fetchItem } from '../data/itemRefresh';
import { GitHubError } from '../data/github';
import { proxyFetch, type Backend, type BackendInit, type FreshOut, type FreshResult, type GrantInfo } from '../backend/backend';

export const REASON_REVOKED = 'GitHub 凭据已失效（可能被撤销或已过期），请重新登录';
export const REASON_REFRESH_ENDED = '登录已到期，GitHub 不再接受续期，请重新登录';
/** the back end refreshes this long before the access token expires (src-tauri/crates/core/src/engine.rs) */
export const REFRESH_MARGIN_MS = 5 * 60_000;

export interface ControllerDeps {
  backend: Backend;
  endpoints: Endpoints;
  now?: () => number;
  syncIntervalMs?: number;
  /** built-in OAuth Client ID (tests inject their own; production uses the constant) */
  defaultClientId?: string;
  /** built-in GitHub App Client ID ('' = none, which is production today) */
  defaultGithubAppClientId?: string;
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

export class Controller {
  private state: AppState;
  private snapshots = new Map<string, SourceSnapshot>();
  /** signed in, as the back end last said (it holds the credential, this side never does) */
  private signedIn = false;
  private listeners = new Set<(s: AppState) => void>();
  private syncing: Promise<void> | null = null;
  private resync = false;
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
      handBack: { ...DEFAULT_HAND_BACK, ...this.cache.getSetting<Partial<HandBackLabels>>('handBack', {}) },
      mergePrefs: normalizeMergePrefs(this.cache.getSetting<unknown>(MERGE_PREFS, null)),
    };
    for (const s of init.snapshots) this.snapshots.set(s.sourceKey, s);
    this.refreshDerived();
  }

  getState(): AppState {
    return this.state;
  }

  getBoardData(): BoardData {
    const configured = this.state.sources.map((s) => s.key);
    const snaps = [...this.snapshots.values()].filter((s) => configured.includes(s.sourceKey));
    const selected = this.state.view.selected?.filter((k) => configured.includes(k)) ?? null;
    return mergeSnapshots(snaps, selected);
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

  /** The back end dropped every snapshot (sign-out / another account): forget them here too. */
  private dropMirror(): void {
    this.snapshots.clear();
    this.state = { ...this.state, sync: { ...this.state.sync, sources: [], dataFrom: null } };
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
            await this.runRound();
          } catch (e) {
            // a round must never reject: the 60 s timer and the window would see an unhandled rejection
            this.set({ sync: { ...this.state.sync, syncing: false, problem: `同步出错：${(e as Error).message}` } });
          }
        } while (this.resync && this.signedIn);
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  private async runRound(retried = false): Promise<void> {
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
    const round = await syncRound(this.client(session), sources, this.snapshots, this.now());
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
    this.applyImports(accepted);
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
        if (r === 'ok') return this.runRound(true);
        if (r === 'unreachable') this.set({ sync: { ...this.state.sync, offline: true } });
        if (r !== 'changed') return; // 'failed': kept signed in with the problem shown; 'ended': already signed out
      }
      if (session === this.session && this.signedIn) await this.logout(REASON_REVOKED);
    }
  }

  /** A GitHub client whose requests the back end signs for `session`. */
  private client(session: number): GitHubClient {
    return new GitHubClient(this.deps.endpoints, null, proxyFetch(this.backend, session));
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
    };
    this.cache.setSetting('handBack', next);
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
      return { ok: true, detail: toDetail(item.repo, raw, this.now()) };
    } catch (e) {
      this.noteAuthFailure(e);
      const msg = e instanceof GitHubError && e.kind === 'network' ? `连不上 GitHub，读不到详情（${e.message}）` : `读取详情失败：${(e as Error).message}`;
      return { ok: false, error: msg };
    }
  }

  /** Labels and milestones of one repository (the candidates the window offers). */
  async repoOptions(repo: string): Promise<RepoOptions> {
    const c = await this.clientForCall(false);
    if ('error' in c) return { labels: [], milestones: [], error: c.error };
    try {
      return await listRepoOptions(c.client, repo);
    } catch (e) {
      this.noteAuthFailure(e);
      return { labels: [], milestones: [], error: `读取 ${repo} 的标签 / 里程碑失败：${(e as Error).message}` };
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
    const c = await this.clientForCall(true);
    if ('error' in c) return { ok: false, error: c.error, warning: null };
    const data = this.getBoardData();
    const item = 'key' in action ? (data.items.find((i) => i.key === action.key) ?? null) : null;
    // the board data only holds the sources ticked in the view: a new issue joins exactly those Projects
    const createInProjects = data.projects;
    let outcome;
    try {
      outcome = await performAction(c.client, action, { item, projects: data.projects, handBack: this.state.handBack, createInProjects });
    } catch (e) {
      if (!(e instanceof ActionRefused)) this.noteAuthFailure(e);
      return { ok: false, error: explainError(e, action.kind), warning: null };
    }
    let warning = outcome.warning;
    if (c.session === this.session) {
      for (const [repo, number] of outcome.touched) {
        const problem = await this.refreshOne(c.client, c.session, repo, number);
        if (problem) warning = [warning, problem].filter(Boolean).join('；');
      }
    }
    return { ok: true, error: null, warning, ...(outcome.createdKey ? { createdKey: outcome.createdKey } : {}) };
  }

  /**
   * Read one item again and put it into every cached source that carries it.
   * Same guards as a sync round: nothing lands after a sign-out / account
   * switch, nor into a source removed (or re-added) meanwhile. A round already
   * in flight may have read the item before the change: one more round is queued.
   */
  private async refreshOne(client: GitHubClient, session: number, repo: string, number: number): Promise<string | null> {
    const sources = this.state.sources;
    const epochAtStart = new Map(sources.map((src) => [src.key, this.epochs.get(src.key) ?? 0]));
    let fresh;
    try {
      fresh = await fetchItem(client, repo, number);
    } catch (e) {
      void this.syncNow();
      return `修改已生效，但重读这一条失败（${(e as Error).message}），下一轮同步会更新`;
    }
    if (session !== this.session) return null;
    const current = (key: string) =>
      this.state.sources.some((s) => s.key === key) && (this.epochs.get(key) ?? 0) === epochAtStart.get(key);
    const changed = applyFreshItem([...this.snapshots.values()].filter((s) => current(s.sourceKey)), fresh);
    if (changed.length && (await this.writeSnapshots(session, changed))) {
      for (const snap of changed.filter((s) => current(s.sourceKey))) this.snapshots.set(snap.sourceKey, snap);
      this.set({});
    }
    if (this.syncing) void this.syncNow();
    return null;
  }

  /** A 401 on a call outside the sync round: let the next round do the refresh / sign-out logic. */
  private noteAuthFailure(e: unknown): void {
    if (e instanceof GitHubError && e.kind === 'auth') void this.syncNow();
  }
}
