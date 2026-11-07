// GitHub App sign-in (PR #140, maintainer chose "GitHub App" on 2026-11-05):
// the access token expires after 8 h and comes with a refresh token that
// GitHub rotates on every refresh. Real controller, fake GitHub over HTTP,
// real SQLite, file credential store.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller, REASON_REFRESH_ENDED, REFRESH_MARGIN_MS } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { decodeGrant, encodeGrant } from '../support/grant';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { FIXTURE_NOW, tempDir } from './helpers';
import type { AppState } from '../../src/shared/types';

const APP_TOKEN = 'ghu_fakeapptoken0000000000000000000001';
const APP_REFRESH = 'ghr_fakeapprefresh00000000000000000000001';
const HOUR = 3_600_000;
const REPO = 'GigleAI/cavil-loop';

let fake: FakeGitHub;
let dir: string;
const caches: Cache[] = [];
const controllers: Controller[] = [];
const backends: HarnessBackend[] = [];

/** Credential store whose writes can be held by the test. */
class GatedStore extends FileStore {
  hold = false;
  writes: { value: string; release: () => void }[] = [];
  async set(value: string): Promise<void> {
    if (this.hold) {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      this.writes.push({ value, release });
      await gate;
    }
    await super.set(value);
  }
}

async function make(store: FileStore, clock: { t: number }) {
  // a restart reads the files: every earlier app of this test has finished writing its settings
  await Promise.all(controllers.map((c) => c.settled()));
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  const endpoints = { api: fake.api, web: fake.web };
  // the real back end (Rust) as a child process, on the same files
  const backend = new HarnessBackend({
    db: join(dir, 'cache.sqlite'),
    endpoints,
    credentials: store,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
      await new Promise((r) => setTimeout(r, 5));
    },
  });
  backends.push(backend);
  const c = await Controller.create({ backend, endpoints, now: () => clock.t, defaultClientId: fake.state.oauthClientId });
  controllers.push(c);
  return { c, cache, backend };
}

async function until(c: Controller, pred: (s: AppState) => boolean, what: string) {
  for (let i = 0; i < 1500; i++) {
    if (pred(c.getState())) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout: ${what}`);
}

/** Sign in through the device flow as a GitHub App would: expiring token + refresh token. */
async function signInAsApp(store: FileStore, clock: { t: number }) {
  fake.state.nextGrant = { token: APP_TOKEN, refreshToken: APP_REFRESH, expiresIn: 8 * 3600 };
  const h = await make(store, clock);
  h.c.addSource(REPO);
  await h.c.start();
  h.c.setAppKind('github-app');
  h.c.setClientId(fake.state.appClientId);
  const p = h.c.startLogin();
  await until(h.c, (s) => s.login.status === 'waiting', 'waiting');
  fake.resolveGrant('approved');
  await p;
  expect(h.c.getState().phase).toBe('ready');
  return h;
}

const refreshes = () => fake.log.filter((l) => l.operation === 'refresh');
const authOf = (fragment: string) => fake.log.filter((l) => l.path.includes(fragment)).map((l) => l.auth);

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
});
afterEach(async () => {
  for (const c of controllers.splice(0)) c.stopTimer();
  await Promise.all(backends.splice(0).map((b) => b.close()));
  for (const c of caches.splice(0)) c.close();
  await fake.close();
});

describe('stored credential format', () => {
  it('a GitHub App grant round-trips; a bare token (OAuth App / older installs) still reads', () => {
    const g = { accessToken: APP_TOKEN, refreshToken: APP_REFRESH, expiresAt: 1_000, refreshExpiresAt: 2_000 };
    expect(decodeGrant(encodeGrant(g))).toEqual(g);
    expect(decodeGrant('gho_plain0000000000000000000000000001')).toEqual({ accessToken: 'gho_plain0000000000000000000000000001', refreshToken: null, expiresAt: null, refreshExpiresAt: null });
    expect(decodeGrant('v2:a"b:c:1:2')).toBeNull();
    expect(decodeGrant(null)).toBeNull();
  });
});

describe('GitHub App sign-in: expiring tokens are refreshed', () => {
  it('stores the refresh token and its deadlines; a restart reads them back', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new FileStore(join(dir, 'cred'));
    await signInAsApp(store, clock);
    const stored = decodeGrant(await store.get())!;
    expect(stored).toMatchObject({ accessToken: APP_TOKEN, refreshToken: APP_REFRESH });
    // 8 h after the moment GitHub answered (the device-flow polling advanced the clock a few seconds)
    expect(stored.expiresAt! - clock.t).toBeLessThanOrEqual(8 * HOUR);
    expect(stored.expiresAt! - FIXTURE_NOW).toBeGreaterThanOrEqual(8 * HOUR);
    expect(stored.refreshExpiresAt).toBeGreaterThan(stored.expiresAt!);
    const again = await make(store, clock);
    await again.c.start();
    expect(again.c.getState().phase).toBe('ready');
    expect(refreshes()).toHaveLength(0); // nothing due yet
  });

  it('near expiry: refreshed before the round, the new token is used and stored, the old refresh token is spent', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new FileStore(join(dir, 'cred'));
    const { c } = await signInAsApp(store, clock);
    clock.t += 8 * HOUR - REFRESH_MARGIN_MS + 1_000;
    const before = fake.log.length;
    await c.syncNow();
    expect(refreshes()).toHaveLength(1);
    const after = fake.log.slice(before).filter((l) => l.path.includes('/issues?'));
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((l) => l.auth === 'Bearer ghu_fakerefreshed00000000000000000001')).toBe(true);
    expect(decodeGrant(await store.get())).toMatchObject({ accessToken: 'ghu_fakerefreshed00000000000000000001', refreshToken: 'ghr_fakerefresh0000000000000000000001' });
    expect(fake.state.refreshTokens.has(APP_REFRESH)).toBe(false);
    expect(c.getState().phase).toBe('ready');
  });

  it('changing the sign-in method while signed in: the token is still refreshed with the app it came from', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new FileStore(join(dir, 'cred'));
    const { c } = await signInAsApp(store, clock);
    // signed in through the GitHub App; the next sign-in will go through the OAuth app
    // (an app the fake also knows — but this token's refresh token belongs to the GitHub App)
    c.setAppKind('oauth');
    expect(c.getState().clientId).toBe(fake.state.oauthClientId);
    clock.t += 8 * HOUR - REFRESH_MARGIN_MS + 1_000;
    await c.syncNow();
    expect(refreshes()).toHaveLength(1);
    expect(refreshes()[0].status).toBe(200);
    expect(c.getState()).toMatchObject({ phase: 'ready', loginReason: null });
    expect(decodeGrant(await store.get())).toMatchObject({ accessToken: 'ghu_fakerefreshed00000000000000000001' });
  });

  it('GitHub says 401 before the deadline: one refresh, the round is retried and succeeds', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new FileStore(join(dir, 'cred'));
    const { c } = await signInAsApp(store, clock);
    fake.state.validTokens.delete(APP_TOKEN);
    await c.syncNow();
    expect(refreshes()).toHaveLength(1);
    expect(c.getState()).toMatchObject({ phase: 'ready', sync: { offline: false } });
    // the round was retried with the new token and that read succeeded
    const last = fake.log.filter((l) => l.path.includes('/issues?')).at(-1)!;
    expect(last).toMatchObject({ auth: 'Bearer ghu_fakerefreshed00000000000000000001', status: 200 });
  });

  it('GitHub refuses the refresh token: signed out with the reason, credential gone', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new FileStore(join(dir, 'cred'));
    const { c } = await signInAsApp(store, clock);
    fake.state.refreshTokens.clear();
    clock.t += 9 * HOUR;
    await c.syncNow();
    expect(refreshes()).toHaveLength(1);
    expect(c.getState()).toMatchObject({ phase: 'login', loginReason: REASON_REFRESH_ENDED });
    expect(await store.get()).toBeNull();
  });

  it('GitHub unreachable at refresh time: stays signed in, offline, cache and credential kept', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new FileStore(join(dir, 'cred'));
    const { c } = await signInAsApp(store, clock);
    const items = c.getBoardData().items.length;
    expect(items).toBeGreaterThan(0);
    fake.state.offline = true;
    clock.t += 9 * HOUR;
    await c.syncNow();
    expect(c.getState()).toMatchObject({ phase: 'ready', sync: { offline: true } });
    expect(c.getBoardData().items).toHaveLength(items);
    expect(decodeGrant(await store.get())?.refreshToken).toBe(APP_REFRESH);
    // back online: the pending refresh happens and everything continues
    fake.state.offline = false;
    await c.syncNow();
    expect(refreshes()).toHaveLength(1);
    expect(c.getState()).toMatchObject({ phase: 'ready', sync: { offline: false } });
  });

  it('two rounds asking at once share one refresh (a second one would burn the rotated token)', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new FileStore(join(dir, 'cred'));
    const { c, backend } = await signInAsApp(store, clock);
    clock.t += 9 * HOUR;
    const { session } = await backend.call<{ session: number }>('grantInfo');
    const release = fake.hold('/login/oauth/access_token');
    const a = c.syncNow();
    // a second trigger while the first refresh is in flight (e.g. the 60 s timer + a manual
    // refresh): the single flight lives in the back end, so ask it directly
    await new Promise((r) => setTimeout(r, 20));
    const b = backend.call('ensureFresh', { session, clientId: fake.state.appClientId });
    await new Promise((r) => setTimeout(r, 50));
    release();
    await Promise.all([a, b]);
    expect(refreshes()).toHaveLength(1);
    expect(c.getState().phase).toBe('ready');
  });

  it('signing out while a refresh is in flight: nothing comes back', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new FileStore(join(dir, 'cred'));
    const { c } = await signInAsApp(store, clock);
    clock.t += 9 * HOUR;
    const release = fake.hold('/login/oauth/access_token');
    const round = c.syncNow();
    for (let i = 0; i < 200 && refreshes().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(refreshes()).toHaveLength(1);
    await c.logout();
    release();
    await round;
    expect(c.getState().phase).toBe('login');
    expect(await store.get()).toBeNull();
    const n = fake.log.length;
    await c.syncNow();
    expect(fake.log.length).toBe(n); // holds no token any more
    const restarted = await make(store, clock);
    await restarted.c.start();
    expect(restarted.c.getState().phase).toBe('login');
  });

  it('signing out while the refreshed token is being saved: nothing comes back either', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new GatedStore(join(dir, 'cred'));
    const { c, backend, cache } = await signInAsApp(store, clock);
    clock.t += 9 * HOUR;
    store.hold = true;
    const round = c.syncNow();
    for (let i = 0; i < 200 && store.writes.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(store.writes).toHaveLength(1); // the refreshed token reached the store
    const out = c.logout();
    store.writes[0].release();
    await round;
    await out;
    expect(c.getState().phase).toBe('login');
    expect(await store.get()).toBeNull();
    const n = fake.log.length;
    await c.syncNow();
    expect(fake.log.length).toBe(n); // holds no token any more
    // nor does the back end (it holds the credential, not the window): it signs nothing, trusts nothing
    const info = await backend.call<{ signedIn: boolean; session: number }>('grantInfo');
    expect(info.signedIn).toBe(false);
    expect((await backend.call<{ error?: string }>('request', { session: info.session, method: 'GET', url: `${fake.api}/user` })).error).toBe('stale');
    expect(cache.getSetting('trustedCredentials', ['unread'])).toEqual([]);
    expect(fake.log.length).toBe(n);
  });

  it('refreshed, then the round could not reach GitHub: an offline restart still shows the cache', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new FileStore(join(dir, 'cred'));
    const { c } = await signInAsApp(store, clock);
    const items = c.getBoardData().items.length;
    expect(items).toBeGreaterThan(0);
    clock.t += 9 * HOUR;
    fake.state.offlineApi = true; // the refresh answers, the data API does not
    await c.syncNow();
    expect(refreshes()).toHaveLength(1);
    expect(c.getState().sync.offline).toBe(true);
    c.stopTimer();
    fake.state.offline = true;
    const again = await make(store, clock);
    await again.c.start();
    expect(again.c.getState()).toMatchObject({ phase: 'ready', sync: { offline: true } });
    expect(again.c.getBoardData().items).toHaveLength(items);
  });

  it('offline restart after a refresh still shows the cache (it stays bound to the refreshed token)', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new FileStore(join(dir, 'cred'));
    const { c } = await signInAsApp(store, clock);
    clock.t += 9 * HOUR;
    await c.syncNow();
    expect(refreshes()).toHaveLength(1);
    const items = c.getBoardData().items.length;
    expect(items).toBeGreaterThan(0);
    c.stopTimer();
    fake.state.offline = true;
    const again = await make(store, clock);
    await again.c.start();
    expect(again.c.getState()).toMatchObject({ phase: 'ready', sync: { offline: true } });
    expect(again.c.getBoardData().items).toHaveLength(items);
  });
});

// ---- review (PR #140, 2026-11-05 17:48): every way a refresh can fail ----

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

describe('how a refresh answer is classified (HTTP status × body shape)', () => {
  // the back end's own refresh call, against a server that answers exactly `status` + `body`
  async function classify(status: number, body: string | null) {
    const srv = createServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body ?? '');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as AddressInfo).port;
    // no connection at all: a port nobody listens on
    if (body === null) await new Promise<void>((r) => srv.close(() => r()));
    const b = new HarnessBackend({
      db: join(dir, 'cache.sqlite'),
      endpoints: { api: `http://127.0.0.1:${port}/api`, web: `http://127.0.0.1:${port}/web` },
      credentials: new FileStore(join(dir, 'cred')),
      now: () => 0,
    });
    try {
      const r = await b.call<{ ok?: string; reason?: string }>('test.refreshGrant', { clientId: 'cid', refreshToken: 'ghr_x' });
      return r.ok ? `ok:${r.ok}` : r.reason;
    } finally {
      await b.close();
      if (body !== null) await new Promise<void>((r) => srv.close(() => r()));
    }
  }
  const rejected = JSON.stringify({ error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' });
  const otherErr = JSON.stringify({ error: 'temporarily_unavailable' });
  const good = JSON.stringify({ access_token: 'ghu_new', refresh_token: 'ghr_new', expires_in: 28800 });
  const cases: [number, string | null, string][] = [
    [200, good, 'ok:ghu_new'],
    // only GitHub's "refresh token incorrect or expired" ends the sign-in
    [200, rejected, 'expired'],
    [400, rejected, 'expired'],
    [401, rejected, 'expired'],
    // 5xx / 429: GitHub not answering properly — whatever the body says
    [503, otherErr, 'unreachable'],
    [503, rejected, 'unreachable'],
    [500, '{}', 'unreachable'],
    [502, '<html>bad gateway</html>', 'unreachable'],
    [429, otherErr, 'unreachable'],
    // no connection at all
    [0, null, 'unreachable'],
    // anything else is not proof the credential is dead
    [200, otherErr, 'error'],
    [400, otherErr, 'error'],
    [200, '{}', 'error'],
    [200, 'not json', 'error'],
    [400, 'not json', 'error'],
    [404, '{}', 'error'],
  ];
  for (const [status, body, want] of cases) {
    it(`HTTP ${status || 'none'} ${body === null ? '(no connection)' : body.slice(0, 40)} → ${want}`, async () => {
      expect(await classify(status, body)).toBe(want);
    });
  }
});

/** A credential store that can be told to fail writes (like a keychain that refuses). */
class FlakyStore extends FileStore {
  failing = false;
  async set(value: string): Promise<void> {
    if (this.failing) throw new Error('keychain write denied');
    await super.set(value);
  }
}

describe('refresh failures keep what they should and recover', () => {
  let unhandled: unknown[];
  const onUnhandled = (r: unknown) => unhandled.push(r);
  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  it('HTTP 503 with an error body: still signed in, credential and cache kept, offline; recovers when GitHub is back', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new FileStore(join(dir, 'cred'));
    const { c, cache } = await signInAsApp(store, clock);
    expect(cache.loadSnapshots().size).toBe(1);
    clock.t += 9 * HOUR;
    fake.state.tokenAnswers.push({ kind: 'refresh', status: 503, body: { error: 'temporarily_unavailable' } });
    await c.syncNow();
    expect(refreshes()).toHaveLength(1); // the refresh really was asked
    expect(c.getState()).toMatchObject({ phase: 'ready', sync: { offline: true } });
    expect(decodeGrant(await store.get())?.refreshToken).toBe(APP_REFRESH);
    expect(cache.loadSnapshots().size).toBe(1);
    await c.syncNow();
    expect(refreshes()).toHaveLength(2);
    expect(c.getState()).toMatchObject({ phase: 'ready', sync: { offline: false, problem: null } });
    expect(decodeGrant(await store.get())?.accessToken).toBe('ghu_fakerefreshed00000000000000000001');
  });

  it('an unknown refresh error: still signed in, problem shown, nothing deleted; cleared after a good refresh', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new FileStore(join(dir, 'cred'));
    const { c, cache } = await signInAsApp(store, clock);
    clock.t += 9 * HOUR;
    fake.state.tokenAnswers.push({ kind: 'refresh', status: 400, body: { error: 'something_new', error_description: 'try again' } });
    await c.syncNow();
    expect(c.getState().phase).toBe('ready');
    expect(c.getState().sync.problem).toContain('续期没有成功');
    expect(decodeGrant(await store.get())?.refreshToken).toBe(APP_REFRESH);
    expect(cache.loadSnapshots().size).toBe(1);
    await c.syncNow();
    expect(c.getState()).toMatchObject({ phase: 'ready', sync: { problem: null } });
  });

  it('refreshed but the keychain refuses the write: keeps working on the new token, says so, saves it later; no unhandled rejection', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new FlakyStore(join(dir, 'cred'));
    const { c } = await signInAsApp(store, clock);
    clock.t += 9 * HOUR;
    store.failing = true;
    await c.syncNow();
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).toEqual([]);
    expect(refreshes()).toHaveLength(1);
    expect(c.getState().phase).toBe('ready');
    expect(c.getState().sync.problem).toContain('钥匙串');
    // the round ran on the NEW token (the old refresh token is already spent at GitHub)
    const last = fake.log.filter((l) => l.path.includes('/issues?')).at(-1)!;
    expect(last).toMatchObject({ auth: 'Bearer ghu_fakerefreshed00000000000000000001', status: 200 });
    expect(decodeGrant(await store.get())?.refreshToken).toBe(APP_REFRESH); // still the old one on disk
    // keychain works again: the next round saves the grant in use, the problem goes away
    store.failing = false;
    await c.syncNow();
    expect(refreshes()).toHaveLength(1); // no second refresh needed
    expect(decodeGrant(await store.get())).toMatchObject({ accessToken: 'ghu_fakerefreshed00000000000000000001', refreshToken: 'ghr_fakerefresh0000000000000000000001' });
    expect(c.getState().sync.problem).toBeNull();
    // and a restart uses it without asking GitHub for another refresh
    c.stopTimer();
    const again = await make(store, clock);
    await again.c.start();
    expect(again.c.getState()).toMatchObject({ phase: 'ready', sync: { offline: false } });
    expect(refreshes()).toHaveLength(1);
    expect(unhandled).toEqual([]);
  });

  it('keychain unreadable at start: login page with the reason, no throw, nothing deleted', async () => {
    const clock = { t: FIXTURE_NOW };
    class Unreadable extends FileStore {
      async get(): Promise<string | null> {
        throw new Error('user interaction is not allowed');
      }
    }
    const { c } = await make(new Unreadable(join(dir, 'cred')), clock);
    await expect(c.start()).resolves.toBeUndefined();
    expect(c.getState()).toMatchObject({ phase: 'login' });
    expect(c.getState().loginReason).toContain('读取本机保存的登录凭据失败');
  });

  it('a device-flow poll that gets a 503 keeps waiting instead of failing the sign-in', async () => {
    const clock = { t: FIXTURE_NOW };
    fake.state.tokenAnswers.push({ kind: 'poll', status: 503, body: { error: 'temporarily_unavailable' } });
    const store = new FileStore(join(dir, 'cred'));
    await signInAsApp(store, clock);
    expect(fake.log.filter((l) => l.path === '/web/login/oauth/access_token' && l.status === 503)).toHaveLength(1);
    expect(decodeGrant(await store.get())?.accessToken).toBe(APP_TOKEN);
  });
});

// ---- review (PR #140, round 2, 2026-11-05 18:10): sign-out when the keychain refuses the delete ----

/** A credential store whose deletes can fail, and can be held. */
class StickyStore extends FileStore {
  failClear = false;
  holdClear: (() => void) | null = null;
  clears = 0;
  private gate: Promise<void> | null = null;
  armHold() {
    this.gate = new Promise<void>((r) => (this.holdClear = r));
  }
  async clear(): Promise<void> {
    this.clears++;
    if (this.gate) await this.gate;
    if (this.failClear) throw new Error('keychain delete denied');
    await super.clear();
  }
}

describe('signing out when the stored credential cannot be deleted', () => {
  async function assertOnLoginPageAndInert(c: Controller) {
    expect(c.getState().phase).toBe('login');
    expect(c.getState().loginReason).toContain('没能删除');
    expect(c.getBoardData().items).toHaveLength(0);
    const n = fake.log.length;
    await c.syncNow();
    expect(fake.log.length).toBe(n); // signed out: nothing is sent any more
  }

  async function assertRestartDoesNotUseLeftover(store: StickyStore, clock: { t: number }) {
    // the leftover is still in the store, yet a restart must not sign in with it
    expect(await store.get()).not.toBeNull();
    const again = await make(store, clock);
    await again.c.start();
    expect(again.c.getState().phase).toBe('login');
    expect(again.c.getState().loginReason).toContain('没能删除');
    expect(fake.log.filter((l) => l.path.includes('/issues?') || l.operation === 'refresh').length).toBe(seenBeforeRestart);
    // keychain works again: the next start deletes the leftover and stays on the login page
    store.failClear = false;
    const third = await make(store, clock);
    await third.c.start();
    expect(third.c.getState()).toMatchObject({ phase: 'login', loginReason: null });
    expect(await store.get()).toBeNull();
    return third.c;
  }
  let seenBeforeRestart = 0;

  it('refresh refused (bad_refresh_token) + delete refused: login page with the reason, inert, restart does not reuse it, a new login works', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new StickyStore(join(dir, 'cred'));
    const { c } = await signInAsApp(store, clock);
    fake.state.refreshTokens.clear();
    store.failClear = true;
    clock.t += 9 * HOUR;
    await c.syncNow();
    expect(refreshes()).toHaveLength(1);
    expect(store.clears).toBe(1); // the delete really was attempted
    await assertOnLoginPageAndInert(c);
    expect(c.getState().loginReason).toContain(REASON_REFRESH_ENDED);
    c.stopTimer();
    seenBeforeRestart = fake.log.filter((l) => l.path.includes('/issues?') || l.operation === 'refresh').length;
    const fresh = await assertRestartDoesNotUseLeftover(store, clock);
    // and signing in again works normally
    fake.state.nextGrant = { token: 'ghu_fakeapptoken0000000000000000000002', refreshToken: 'ghr_fakeapprefresh00000000000000000000002' };
    const p = fresh.startLogin();
    await until(fresh, (s) => s.login.status === 'waiting', 'waiting');
    fake.resolveGrant('approved');
    await p;
    expect(fresh.getState()).toMatchObject({ phase: 'ready', loginReason: null });
  });

  it('refresh token past its own deadline + delete refused: same', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new StickyStore(join(dir, 'cred'));
    const { c } = await signInAsApp(store, clock);
    store.failClear = true;
    clock.t += 200 * 24 * HOUR; // beyond the ~6 month refresh-token lifetime
    await c.syncNow();
    expect(refreshes()).toHaveLength(0); // decided locally, GitHub not even asked
    expect(store.clears).toBe(1);
    await assertOnLoginPageAndInert(c);
    c.stopTimer();
    seenBeforeRestart = fake.log.filter((l) => l.path.includes('/issues?') || l.operation === 'refresh').length;
    await assertRestartDoesNotUseLeftover(store, clock);
  });

  it('manual sign-out + delete refused: login page with the reason; a restart does NOT sign back in with the still-valid leftover', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new StickyStore(join(dir, 'cred'));
    const { c } = await signInAsApp(store, clock);
    store.failClear = true;
    await expect(c.logout()).resolves.toBeUndefined();
    expect(store.clears).toBe(1);
    await assertOnLoginPageAndInert(c);
    c.stopTimer();
    seenBeforeRestart = fake.log.filter((l) => l.path.includes('/issues?') || l.operation === 'refresh').length;
    await assertRestartDoesNotUseLeftover(store, clock);
  });

  it('the page switches at once, even while the delete is still pending; a login started meanwhile is not undone when the delete fails late', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new StickyStore(join(dir, 'cred'));
    const { c } = await signInAsApp(store, clock);
    store.failClear = true;
    store.armHold();
    const out = c.logout();
    // before the keychain has answered: the delete is held until `holdClear` below. Polled, not a fixed
    // 10 ms sleep — on a loaded CI runner the switch took longer than that (PR #241, CI run 42361155753)
    await until(c, (s) => s.phase === 'login', 'login page while the delete is still pending');
    expect(store.holdClear).not.toBeNull();
    // a new sign-in while the old delete is still pending
    fake.state.nextGrant = { token: 'ghu_fakeapptoken0000000000000000000003', refreshToken: 'ghr_fakeapprefresh00000000000000000000003' };
    const p = c.startLogin();
    await until(c, (s) => s.login.status === 'waiting', 'waiting');
    fake.resolveGrant('approved');
    await new Promise((r) => setTimeout(r, 50));
    store.holdClear!(); // the old delete now fails, late
    await out;
    await p;
    expect(c.getState()).toMatchObject({ phase: 'ready', loginReason: null });
    expect(decodeGrant(await store.get())?.accessToken).toBe('ghu_fakeapptoken0000000000000000000003');
    // the new login cleared the "do not reuse" mark: a restart signs in with it
    c.stopTimer();
    const again = await make(store, clock);
    await again.c.start();
    expect(again.c.getState().phase).toBe('ready');
  });
});

describe('every credential-store failure, at every call site, ends somewhere visible', () => {
  it('the keychain refuses the write at the end of a sign-in: login page with the error, nothing stored, nothing synced, no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const on = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', on);
    try {
      const clock = { t: FIXTURE_NOW };
      const store = new FlakyStore(join(dir, 'cred'));
      store.failing = true;
      fake.state.nextGrant = { token: APP_TOKEN, refreshToken: APP_REFRESH };
      const { c } = await make(store, clock);
      c.addSource(REPO);
      await c.start();
      const p = c.startLogin();
      await until(c, (s) => s.login.status === 'waiting', 'waiting');
      fake.resolveGrant('approved');
      await expect(p).resolves.toBeUndefined();
      await new Promise((r) => setTimeout(r, 20));
      expect(c.getState()).toMatchObject({ phase: 'login', login: { status: 'error' } });
      expect(c.getState().login.message).toContain('keychain write denied');
      expect(await store.get()).toBeNull();
      expect(fake.log.filter((l) => l.path.includes('/issues?'))).toHaveLength(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', on);
    }
  });
});
