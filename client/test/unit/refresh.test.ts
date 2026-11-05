// GitHub App sign-in (PR #140, maintainer chose "GitHub App" on 2026-11-05):
// the access token expires after 8 h and comes with a refresh token that
// GitHub rotates on every refresh. Real controller, fake GitHub over HTTP,
// real SQLite, file credential store.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller, REASON_REFRESH_ENDED, REFRESH_MARGIN_MS } from '../../src/main/controller';
import { Cache } from '../../src/data/cache';
import { FileStore } from '../../src/platform/credentials';
import { decodeGrant, encodeGrant } from '../../src/data/grant';
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

function make(store: FileStore, clock: { t: number }) {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  const c = new Controller({
    credentials: store,
    endpoints: { api: fake.api, web: fake.web },
    cache,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
      await new Promise((r) => setTimeout(r, 5));
    },
    openExternal: async () => {},
    defaultClientId: fake.state.oauthClientId,
  });
  controllers.push(c);
  return { c, cache };
}

async function until(c: Controller, pred: (s: AppState) => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (pred(c.getState())) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout: ${what}`);
}

/** Sign in through the device flow as a GitHub App would: expiring token + refresh token. */
async function signInAsApp(store: FileStore, clock: { t: number }) {
  fake.state.nextGrant = { token: APP_TOKEN, refreshToken: APP_REFRESH, expiresIn: 8 * 3600 };
  const h = make(store, clock);
  h.c.addSource(REPO);
  await h.c.start();
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
    const again = make(store, clock);
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
    const { c } = await signInAsApp(store, clock);
    clock.t += 9 * HOUR;
    const release = fake.hold('/login/oauth/access_token');
    const a = c.syncNow();
    // a second trigger while the first refresh is in flight (e.g. the 60 s timer + a manual refresh)
    const b = (c as unknown as { ensureFresh(): Promise<string> }).ensureFresh();
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
    const restarted = make(store, clock);
    await restarted.c.start();
    expect(restarted.c.getState().phase).toBe('login');
  });

  it('signing out while the refreshed token is being saved: nothing comes back either', async () => {
    const clock = { t: FIXTURE_NOW };
    const store = new GatedStore(join(dir, 'cred'));
    const { c } = await signInAsApp(store, clock);
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
    const again = make(store, clock);
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
    const again = make(store, clock);
    await again.c.start();
    expect(again.c.getState()).toMatchObject({ phase: 'ready', sync: { offline: true } });
    expect(again.c.getBoardData().items).toHaveLength(items);
  });
});
