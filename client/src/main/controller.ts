// App logic between the window and GitHub: login, settings, sync rounds,
// cache. No Electron imports — the unit tests drive it against the fake
// GitHub directly; main.ts only wires it to IPC and a BrowserWindow.

import type { AppState, BoardData, ColumnMode, SourceConfig, SourceSnapshot, ViewSettings } from '../shared/types';
import { parseSource } from '../shared/sources';
import { DEFAULT_OAUTH_CLIENT_ID, SYNC_INTERVAL_MS } from '../shared/config';
import type { CredentialStore } from '../platform/credentials';
import { Cache } from '../data/cache';
import { Endpoints, FetchLike, GitHubClient } from '../data/github';
import { DeviceFlowError, pollForToken, refreshGrant, requestDeviceCode } from '../data/deviceFlow';
import { decodeGrant, encodeGrant, type TokenGrant } from '../data/grant';
import { mergeSnapshots } from '../data/merge';
import { syncRound } from '../data/sync';
import { VIEWER_QUERY } from '../data/queries';
import { createHash } from 'node:crypto';

/** Which credential the cache was last verified against (a hash, never the token itself). */
function credentialTag(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const REASON_REVOKED = 'GitHub 凭据已失效（可能被撤销或已过期），请重新登录';
/**
 * Cache setting: hashes of the stored credential(s) this app may sign in with
 * at start. The one rule that keeps every sign-out / cancel / crash safe:
 *   - a sign-out empties it FIRST (a synchronous SQLite write), before the page
 *     switches and before the keychain delete is even queued;
 *   - a login empties it before writing the keychain and adds the new
 *     credential only after the write succeeded and the login is still current;
 *   - a refresh trusts {old, new} while writing, then only the new one;
 *   - start uses the stored credential only if its hash is listed, otherwise
 *     it is a leftover (sign-out not finished, cancelled login, …): login page,
 *     and the leftover is deleted.
 * So whatever point a process stops at, a restart never signs in with a
 * credential the user signed out of. Never written (a profile from a preview
 * build before this rule) counts as empty: such a profile cannot tell "still
 * signed in" from "signed out, delete failed", so its credential is not reused.
 */
const TRUSTED = 'trustedCredentials';

function notDeletedMessage(reason: string | null, err: string): string {
  return `${reason ? `${reason}。` : ''}本机保存的旧登录凭据没能删除（${err}），它可能还留在钥匙串里。App 不会再用它自动登录；你可以直接重新登录（会覆盖它），或在「钥匙串访问」里搜「Cavil Loop」手动删除`;
}

export const REASON_REFRESH_ENDED = '登录已到期，GitHub 不再接受续期，请重新登录';
/** refresh this long before the access token expires */
export const REFRESH_MARGIN_MS = 5 * 60_000;

export interface ControllerDeps {
  credentials: CredentialStore;
  endpoints: Endpoints;
  cache: Cache;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  syncIntervalMs?: number;
  /** built-in OAuth Client ID (tests inject their own; production uses the constant) */
  defaultClientId?: string;
}

const DEFAULT_VIEW: ViewSettings = { mode: 'iteration', swimlanes: false, selected: null };
const MODES: ColumnMode[] = ['iteration', 'status', 'milestone'];

export class Controller {
  private state: AppState;
  private snapshots = new Map<string, SourceSnapshot>();
  /** the signed-in credential (null = signed out); `token` is its access token */
  private grant: TokenGrant | null = null;
  private get token(): string | null {
    return this.grant?.accessToken ?? null;
  }
  /** the one refresh in flight: GitHub rotates refresh tokens, a second refresh with the same one would fail */
  private refreshing: Promise<'ok' | 'unreachable' | 'ended' | 'failed'> | null = null;
  /** the grant in use was refreshed but could not be written to the credential store */
  private unsavedGrant = false;
  private unsavedProblem: string | null = null;
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
  /** every credential write / delete runs here, one after another, in call order */
  private credQueue: Promise<unknown> = Promise.resolve();
  /** GitHub login the cached snapshots belong to (null = nobody: the cache must be empty) */
  private owner: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly defaultClientId: string;

  constructor(private readonly deps: ControllerDeps) {
    this.defaultClientId = deps.defaultClientId ?? DEFAULT_OAUTH_CLIENT_ID;
    this.fetchImpl = deps.fetch ?? ((u, i) => fetch(u, i));
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const override = deps.cache.getSetting<string>('oauthClientId', '');
    this.state = {
      phase: 'loading',
      loginReason: null,
      login: { status: 'idle', userCode: null, verificationUri: null, message: null },
      oauthClientId: override || this.defaultClientId,
      oauthClientIdIsDefault: !override,
      viewer: deps.cache.getSetting<string | null>('viewer', null),
      sources: deps.cache.getSetting<SourceConfig[]>('sources', []),
      view: { ...DEFAULT_VIEW, ...deps.cache.getSetting<Partial<ViewSettings>>('view', {}) },
      sync: { syncing: false, offline: false, lastOnlineAt: null, dataFrom: null, sources: [], problem: null },
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
    let stored: TokenGrant | null;
    try {
      stored = decodeGrant(await this.deps.credentials.get());
    } catch (e) {
      // keychain unreadable: not "signed out" (nothing is deleted), just cannot use it now
      this.set({ phase: 'login', loginReason: `读取本机保存的登录凭据失败（${(e as Error).message}），请重新登录` });
      return;
    }
    if (!stored) {
      this.set({ phase: 'login' });
      return;
    }
    // Not listed (including every profile written before the list existed — those
    // cannot tell "still signed in" from "signed out but the delete failed"): a
    // leftover, never signed in with. Costs a preview-build user one sign-in.
    const trusted = this.deps.cache.getSetting<string[] | null>(TRUSTED, null) ?? [];
    if (!trusted.includes(credentialTag(stored.accessToken))) {
      // A leftover the user signed out of (or a login that never completed, or a
      // credential put there from outside): never sign in with it, show nothing
      // cached for it. Delete it now; say so if that fails again.
      this.adoptAccount(null, null);
      const err = await this.serialCredential(() => this.clearStored());
      this.set({ phase: 'login', loginReason: err ? notDeletedMessage(null, err) : null });
      return;
    }
    this.grant = stored;
    // A credential the cache was not read with (changed outside the app) means
    // the account is unknown until GitHub answers: show nothing cached meanwhile.
    if (this.deps.cache.getSetting<string | null>('cacheCredential', null) !== credentialTag(stored.accessToken)) {
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
      const grant = await pollForToken(this.deps.endpoints, clientId, code, this.fetchImpl, {
        now: this.now,
        sleep: this.sleep,
        cancelled: () => run !== this.loginRun,
      });
      // Who is this? Asked with the token in memory only: nothing is persisted
      // until the very last step. Unknown (query failed) is never "the same account".
      let login: string | null = null;
      try {
        login = (await new GitHubClient(this.deps.endpoints, grant.accessToken, this.fetchImpl).graphql<{ viewer: { login: string } }>(VIEWER_QUERY, {})).viewer.login;
      } catch {
        /* the first sync round asks again */
      }
      if (run !== this.loginRun) return;
      // Persist and switch to "signed in" as one step of the credential queue.
      // A cancel / sign-out / newer login that happens while the keychain write
      // is in progress makes this login stale: the token it just wrote is
      // removed in the same step, before anything queued after it (a newer
      // login's write, a sign-out) runs — so it can neither survive nor delete
      // somebody else's credential.
      const committed = await this.serialCredential(async () => {
        if (run !== this.loginRun) return false;
        // nothing stored is trusted while the new credential is being written
        this.setTrusted([]);
        await this.deps.credentials.set(encodeGrant(grant));
        if (run !== this.loginRun) {
          const err = await this.clearStored();
          if (err) this.set({ loginReason: notDeletedMessage('登录已取消', err) });
          return false;
        }
        this.setTrusted([grant.accessToken]);
        this.session++;
        this.grant = grant;
        // a GitHub App token is refreshed with the app it came from, whatever the setting says later
        this.deps.cache.setSetting('grantClientId', clientId);
        this.adoptAccount(login, grant.accessToken);
        this.deps.cache.setSetting('viewer', login);
        this.state = { ...this.state, viewer: login };
        this.set({
          phase: 'ready',
          loginReason: null,
          login: { status: 'idle', userCode: null, verificationUri: null, message: null },
        });
        return true;
      });
      if (committed) await this.syncNow();
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

  /** Run `fn` after every credential operation queued before it (whatever their outcome). */
  private serialCredential<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.credQueue.then(fn);
    this.credQueue = p.catch(() => undefined);
    return p;
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
    this.grant = null;
    this.unsavedGrant = false;
    // First of all, durably: the stored credential may never sign us in again,
    // whatever happens to the keychain delete below (queued, pending, failing,
    // or the process ending before it returns).
    this.setTrusted([]);
    // Signing out forgets everything read with that account.
    this.wipeCache();
    this.owner = null;
    this.deps.cache.setSetting('cacheOwner', null);
    this.deps.cache.setSetting('cacheCredential', null);
    this.deps.cache.setSetting('viewer', null);
    // This session is over whatever the keychain does next: switch the page first
    // (a failing delete must not leave the board on screen with nobody signed in).
    const session = this.session;
    this.set({
      phase: 'login',
      loginReason: reason,
      viewer: null,
      sync: { ...this.state.sync, problem: null },
      login: { status: 'idle', userCode: null, verificationUri: null, message: null },
    });
    const err = await this.serialCredential(() => this.clearStored());
    // only while nothing newer happened (a new login commits after this delete, in the same queue)
    if (err && session === this.session) this.set({ loginReason: notDeletedMessage(reason, err) });
  }

  /**
   * Delete the stored credential. Runs inside the credential queue. Never throws:
   * the error is returned for the caller to show. Safety does not depend on it —
   * whatever stays behind is not in the trust list (see TRUSTED).
   */
  private async clearStored(): Promise<string | null> {
    try {
      await this.deps.credentials.clear();
    } catch (e) {
      return (e as Error).message;
    }
    return null;
  }

  private setTrusted(accessTokens: string[]): void {
    this.deps.cache.setSetting(TRUSTED, accessTokens.map(credentialTag));
  }

  /**
   * Make sure the access token is usable (GitHub App tokens expire after 8 h).
   * `force` refreshes even before the deadline (GitHub said 401).
   *
   * Every way a refresh can go, and what it leaves behind:
   *   not needed (no refresh token / not due)        → ok
   *   refresh token past its own deadline            → ended: signed out with the reason
   *   no answer, 5xx, 429 (whatever the body says)   → unreachable: keep everything, next round retries
   *   GitHub says bad_refresh_token                  → ended: signed out with the reason
   *   any other error / unparseable / no token       → failed: keep everything, tell the user, next round retries
   *   new token, but saving it fails                 → ok: GitHub already retired the old refresh token, so the
   *                                                    new grant stays in memory, the user is told, every later
   *                                                    round retries the save (see saveUnsavedGrant)
   *   signed out / new login before or during save   → ended: the newer action wins, nothing of this refresh lands
   *   anything unexpected                            → failed (never a rejected promise: callers and timers
   *                                                    must not see an unhandled rejection)
   * Single-flight: concurrent callers share one refresh (refresh tokens rotate).
   */
  private ensureFresh(force = false): Promise<'ok' | 'unreachable' | 'ended' | 'failed'> {
    const used = this.grant;
    if (!used || !used.refreshToken) return Promise.resolve('ok');
    if (!force && (used.expiresAt == null || used.expiresAt - this.now() > REFRESH_MARGIN_MS)) return Promise.resolve('ok');
    if (this.refreshing) return this.refreshing;
    const session = this.session;
    const current = () => session === this.session && this.grant === used;
    const signOut = () => this.logout(REASON_REFRESH_ENDED); // never throws, see logout
    const run = (async (): Promise<'ok' | 'unreachable' | 'ended' | 'failed'> => {
      try {
        if (used.refreshExpiresAt != null && this.now() >= used.refreshExpiresAt) {
          if (current()) await signOut();
          return 'ended';
        }
        const clientId = this.deps.cache.getSetting<string>('grantClientId', '') || this.state.oauthClientId;
        let next: TokenGrant;
        try {
          next = await refreshGrant(this.deps.endpoints, clientId, used.refreshToken!, this.fetchImpl, this.now);
        } catch (e) {
          const reason = e instanceof DeviceFlowError ? e.reason : 'error';
          if (reason === 'expired') {
            if (current()) await signOut();
            return 'ended';
          }
          if (reason === 'unreachable') return 'unreachable';
          if (current()) this.setProblem(`登录续期没有成功（${(e as Error).message}），会在下一轮自动重试；一直失败的话请退出后重新登录`);
          return 'failed';
        }
        // Store + switch as one step of the credential queue, like a login: a
        // sign-out / new login meanwhile wins, and anything queued after (a
        // sign-out's delete, a newer login's write) runs after this write.
        return await this.serialCredential(async () => {
          if (!current()) return 'ended' as const;
          // while writing, either the old or the new one may be what ends up stored
          this.setTrusted([used.accessToken, next.accessToken]);
          let saved = true;
          try {
            await this.deps.credentials.set(encodeGrant(next));
          } catch (e) {
            saved = false;
            this.unsavedProblem = (e as Error).message;
          }
          if (!current()) return 'ended' as const;
          // GitHub has rotated the refresh token: only `next` works from now on,
          // saved or not. Keep using it; an unsaved grant is retried every round.
          this.grant = next;
          this.unsavedGrant = !saved;
          // saved: only the new one; not saved: the store still holds the old one (spent at
          // GitHub, so using it later just ends in "please sign in again") and the retry may store the new
          if (saved) this.setTrusted([next.accessToken]);
          // same account, new token: the cache stays bound to it
          if (this.owner && saved) this.deps.cache.setSetting('cacheCredential', credentialTag(next.accessToken));
          this.setProblem(saved ? null : this.unsavedMessage());
          return 'ok' as const;
        });
      } catch (e) {
        if (current()) this.setProblem(`登录续期出错（${(e as Error).message}），会在下一轮自动重试`);
        return 'failed';
      }
    })();
    this.refreshing = run;
    const clear = () => {
      if (this.refreshing === run) this.refreshing = null;
    };
    run.then(clear, clear);
    return run;
  }

  private unsavedMessage(): string {
    return `新的登录凭据没能存进钥匙串（${this.unsavedProblem ?? '未知错误'}）。这次运行照常可用，App 会每轮重试保存；在保存成功前退出 App，下次启动需要重新登录`;
  }

  /** A refreshed grant that could not be stored: try again (same queue and session rules as any credential write). */
  private async saveUnsavedGrant(): Promise<void> {
    if (!this.unsavedGrant || !this.grant) return;
    const grant = this.grant;
    const session = this.session;
    await this.serialCredential(async () => {
      if (session !== this.session || this.grant !== grant || !this.unsavedGrant) return;
      try {
        await this.deps.credentials.set(encodeGrant(grant));
      } catch (e) {
        this.unsavedProblem = (e as Error).message;
        this.setProblem(this.unsavedMessage());
        return;
      }
      if (session !== this.session || this.grant !== grant) return;
      this.setTrusted([grant.accessToken]);
      this.unsavedGrant = false;
      if (this.owner) this.deps.cache.setSetting('cacheCredential', credentialTag(grant.accessToken));
      this.setProblem(null);
    });
  }

  private setProblem(problem: string | null): void {
    if (this.state.sync.problem !== problem) this.set({ sync: { ...this.state.sync, problem } });
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
    this.set({ oauthClientId: v || this.defaultClientId, oauthClientIdIsDefault: !v });
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
          try {
            await this.runRound();
          } catch (e) {
            // a round must never reject: the 60 s timer and IPC callers would see an unhandled rejection
            this.set({ sync: { ...this.state.sync, syncing: false, problem: `同步出错：${(e as Error).message}` } });
          }
        } while (this.resync && this.token);
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  private async runRound(retried = false): Promise<void> {
    if (!this.token) return;
    const fresh = await this.ensureFresh();
    if (fresh === 'ended' || !this.grant) return;
    await this.saveUnsavedGrant();
    if (fresh !== 'ok' && this.grant.expiresAt != null && this.now() >= this.grant.expiresAt) {
      // expired and no new token (GitHub unreachable, or the refresh failed for a reason
      // that does not prove the credential dead): keep everything, the cache stays
      this.set({ sync: { ...this.state.sync, syncing: false, offline: fresh === 'unreachable' } });
      return;
    }
    const token = this.grant.accessToken;
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
        problem: this.state.sync.problem,
      },
    });
    if (round.authFailed) {
      // A GitHub App token can be refreshed once before the credential is declared dead.
      if (!retried && session === this.session && this.grant?.refreshToken && this.grant.accessToken === token) {
        const r = await this.ensureFresh(true);
        if (r === 'ok') return this.runRound(true);
        if (r === 'unreachable') this.set({ sync: { ...this.state.sync, offline: true } });
        return; // 'failed': kept signed in with the problem shown; 'ended': already signed out
      }
      if (session === this.session) await this.logout(REASON_REVOKED);
    }
  }
}
