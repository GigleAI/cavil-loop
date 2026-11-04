// App logic between the window and GitHub: login, settings, sync rounds,
// cache. No Electron imports — the unit tests drive it against the fake
// GitHub directly; main.ts only wires it to IPC and a BrowserWindow.

import type { AppState, BoardData, ColumnMode, SourceConfig, SourceSnapshot, ViewSettings } from '../shared/types';
import { parseSource } from '../shared/sources';
import { DEFAULT_OAUTH_CLIENT_ID, SYNC_INTERVAL_MS } from '../shared/config';
import type { CredentialStore } from '../platform/credentials';
import { Cache } from '../data/cache';
import { Endpoints, FetchLike, GitHubClient } from '../data/github';
import { DeviceFlowError, pollForToken, requestDeviceCode } from '../data/deviceFlow';
import { mergeSnapshots } from '../data/merge';
import { syncRound } from '../data/sync';
import { VIEWER_QUERY } from '../data/queries';
import { createHash } from 'node:crypto';

/** Which credential the cache was last verified against (a hash, never the token itself). */
function credentialTag(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const REASON_REVOKED = 'GitHub 凭据已失效（可能被撤销或已过期），请重新登录';

export interface ControllerDeps {
  credentials: CredentialStore;
  endpoints: Endpoints;
  cache: Cache;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  syncIntervalMs?: number;
}

const DEFAULT_VIEW: ViewSettings = { mode: 'iteration', swimlanes: false, selected: null };
const MODES: ColumnMode[] = ['iteration', 'status', 'milestone'];

export class Controller {
  private state: AppState;
  private snapshots = new Map<string, SourceSnapshot>();
  private token: string | null = null;
  private listeners = new Set<(s: AppState) => void>();
  private syncing: Promise<void> | null = null;
  private resync = false;
  private loginRun = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** bumps on every login / logout: a round started in another session is dropped */
  private session = 0;
  /** per source key, bumps on every add / remove: a round only writes a source added before it started */
  private epochs = new Map<string, number>();
  private epochSeq = 0;
  /** GitHub login the cached snapshots belong to (null = nobody: the cache must be empty) */
  private owner: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: ControllerDeps) {
    this.fetchImpl = deps.fetch ?? ((u, i) => fetch(u, i));
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const override = deps.cache.getSetting<string>('oauthClientId', '');
    this.state = {
      phase: 'loading',
      loginReason: null,
      login: { status: 'idle', userCode: null, verificationUri: null, message: null },
      oauthClientId: override || DEFAULT_OAUTH_CLIENT_ID,
      oauthClientIdIsDefault: !override,
      viewer: deps.cache.getSetting<string | null>('viewer', null),
      sources: deps.cache.getSetting<SourceConfig[]>('sources', []),
      view: { ...DEFAULT_VIEW, ...deps.cache.getSetting<Partial<ViewSettings>>('view', {}) },
      sync: { syncing: false, offline: false, lastOnlineAt: null, dataFrom: null, sources: [] },
      credentialsPersistent: deps.credentials.persistent,
    };
    if (!MODES.includes(this.state.view.mode)) this.state.view.mode = 'iteration';
    this.owner = deps.cache.getSetting<string | null>('cacheOwner', null);
    this.snapshots = deps.cache.loadSnapshots();
    // A cache nobody owns cannot be shown to anybody.
    if (!this.owner && this.snapshots.size) this.wipeCache();
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
    this.token = await this.deps.credentials.get();
    if (!this.token) {
      this.set({ phase: 'login' });
      return;
    }
    // A credential the cache was not read with (changed outside the app) means
    // the account is unknown until GitHub answers: show nothing cached meanwhile.
    if (this.deps.cache.getSetting<string | null>('cacheCredential', null) !== credentialTag(this.token)) {
      this.adoptAccount(null, null);
    }
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
    const clientId = this.state.oauthClientId.trim();
    const run = ++this.loginRun;
    if (!clientId) {
      this.set({
        login: { status: 'error', userCode: null, verificationUri: null, message: '还没有配置 OAuth 应用的 Client ID，请先在下方填写' },
      });
      return;
    }
    this.set({ login: { status: 'requesting', userCode: null, verificationUri: null, message: null } });
    try {
      const code = await requestDeviceCode(this.deps.endpoints, clientId, this.fetchImpl, this.now);
      if (run !== this.loginRun) return;
      this.set({ login: { status: 'waiting', userCode: code.userCode, verificationUri: code.verificationUri, message: null } });
      const token = await pollForToken(this.deps.endpoints, clientId, code, this.fetchImpl, {
        now: this.now,
        sleep: this.sleep,
        cancelled: () => run !== this.loginRun,
      });
      await this.deps.credentials.set(token);
      this.session++;
      this.token = token;
      // Bind the cache to the account that just signed in before anything is shown.
      // Unknown account (viewer query failed) is never treated as "the same one".
      let login: string | null = null;
      try {
        login = (await new GitHubClient(this.deps.endpoints, token, this.fetchImpl).graphql<{ viewer: { login: string } }>(VIEWER_QUERY, {})).viewer.login;
      } catch {
        /* the first sync round asks again */
      }
      if (run !== this.loginRun) return;
      this.adoptAccount(login, token);
      this.deps.cache.setSetting('viewer', login);
      this.state = { ...this.state, viewer: login };
      this.set({
        phase: 'ready',
        loginReason: null,
        login: { status: 'idle', userCode: null, verificationUri: null, message: null },
      });
      await this.syncNow();
    } catch (e) {
      if (run !== this.loginRun) return;
      const reason = e instanceof DeviceFlowError ? e.reason : 'error';
      if (reason === 'cancelled') return;
      this.set({
        login: {
          status: reason === 'denied' ? 'denied' : reason === 'expired' ? 'expired' : 'error',
          userCode: null,
          verificationUri: null,
          message: (e as Error).message,
        },
      });
    }
  }

  cancelLogin(): void {
    this.loginRun++;
    this.set({ login: { status: 'idle', userCode: null, verificationUri: null, message: null } });
  }

  async openVerification(): Promise<void> {
    const uri = this.state.login.verificationUri;
    if (uri) await this.deps.openExternal(uri);
  }

  async logout(reason: string | null = null): Promise<void> {
    this.loginRun++;
    this.session++;
    this.token = null;
    // Signing out forgets everything read with that account.
    this.wipeCache();
    this.owner = null;
    this.deps.cache.setSetting('cacheOwner', null);
    this.deps.cache.setSetting('cacheCredential', null);
    this.deps.cache.setSetting('viewer', null);
    await this.deps.credentials.clear();
    this.set({
      phase: 'login',
      loginReason: reason,
      viewer: null,
      login: { status: 'idle', userCode: null, verificationUri: null, message: null },
    });
  }

  /** Drop every snapshot, in memory and in SQLite. */
  private wipeCache(): void {
    this.deps.cache.clearSnapshots();
    this.snapshots.clear();
    this.state = { ...this.state, sync: { ...this.state.sync, sources: [], dataFrom: null } };
  }

  /** The cache may only hold data read by `login`; another (or unknown) account wipes it first. */
  private adoptAccount(login: string | null, token: string | null): void {
    this.deps.cache.setSetting('cacheCredential', login && token ? credentialTag(token) : null);
    if (login && login === this.owner) return;
    this.wipeCache();
    this.owner = login;
    this.deps.cache.setSetting('cacheOwner', login);
  }

  private bumpEpoch(key: string): void {
    this.epochs.set(key, ++this.epochSeq);
  }

  setClientId(id: string): void {
    const v = id.trim();
    this.deps.cache.setSetting('oauthClientId', v);
    this.set({ oauthClientId: v || DEFAULT_OAUTH_CLIENT_ID, oauthClientIdIsDefault: !v });
  }

  // ---- sources & view ------------------------------------------------------

  addSource(input: string): { ok: boolean; error?: string } {
    const src = parseSource(input);
    if (!src) return { ok: false, error: '认不出这个地址：Project 请贴网址（https://github.com/orgs/<组织>/projects/<编号>），仓库写「组织/仓库名」' };
    if (this.state.sources.some((s) => s.key === src.key)) return { ok: false, error: '这个来源已经加过了' };
    const sources = [...this.state.sources, src];
    this.bumpEpoch(src.key);
    this.deps.cache.setSetting('sources', sources);
    const view = this.state.view.selected ? { ...this.state.view, selected: [...this.state.view.selected, src.key] } : this.state.view;
    this.deps.cache.setSetting('view', view);
    this.set({ sources, view });
    void this.syncNow();
    return { ok: true };
  }

  removeSource(key: string): void {
    const sources = this.state.sources.filter((s) => s.key !== key);
    this.bumpEpoch(key);
    this.deps.cache.setSetting('sources', sources);
    this.deps.cache.deleteSnapshot(key);
    this.snapshots.delete(key);
    const view = this.state.view.selected ? { ...this.state.view, selected: this.state.view.selected.filter((k) => k !== key) } : this.state.view;
    this.deps.cache.setSetting('view', view);
    this.set({ sources, view, sync: { ...this.state.sync, sources: this.state.sync.sources.filter((s) => s.sourceKey !== key) } });
  }

  setView(patch: Partial<ViewSettings>): void {
    const view = { ...this.state.view, ...patch };
    if (!MODES.includes(view.mode)) return;
    this.deps.cache.setSetting('view', view);
    this.set({ view });
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
          await this.runRound();
        } while (this.resync && this.token);
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  private async runRound(): Promise<void> {
    const token = this.token;
    if (!token) return;
    const session = this.session;
    const sources = this.state.sources;
    const epochAtStart = new Map(sources.map((src) => [src.key, this.epochs.get(src.key) ?? 0]));
    this.set({ sync: { ...this.state.sync, syncing: true } });
    const round = await syncRound(new GitHubClient(this.deps.endpoints, token, this.fetchImpl), sources, this.snapshots, this.now());
    if (session !== this.session) {
      // logged out / another account logged in meanwhile: nothing of this round may land
      this.set({ sync: { ...this.state.sync, syncing: false } });
      return;
    }
    // GitHub says who this token belongs to; data of anybody else goes first.
    if (round.viewer) this.adoptAccount(round.viewer, token);
    // Only sources still configured *as the same addition* the round started with.
    // A source removed (or removed and re-added) meanwhile is skipped everywhere:
    // database, memory and status all take this one filtered result.
    const current = (key: string) =>
      this.state.sources.some((s) => s.key === key) && (this.epochs.get(key) ?? 0) === epochAtStart.get(key);
    const accepted = round.replaced.filter((snap) => current(snap.sourceKey));
    if (accepted.length) this.deps.cache.replaceSnapshots(accepted);
    for (const snap of accepted) this.snapshots.set(snap.sourceKey, snap);
    if (round.viewer) this.deps.cache.setSetting('viewer', round.viewer);
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
      },
    });
    if (round.authFailed) await this.logout(REASON_REVOKED);
  }
}
