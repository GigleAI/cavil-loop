// The local database refuses a write (GitHub#151 review round 1): the back end
// must never report a clean sign-out it could not make durable, never sign in on
// top of another account's data it could not drop, and never stay silent about a
// refresh it could not record. Real Rust back end (child process), real SQLite
// with a trigger that refuses exactly one kind of write, a second process
// restarting on the same files.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Controller } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { encodeGrant } from '../support/grant';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import type { AppState } from '../../src/shared/types';

const REPO = 'GigleAI/cavil-loop';
const HOUR = 3_600_000;

let fake: FakeGitHub;
let dir: string;
const open: HarnessBackend[] = [];
const caches: Cache[] = [];

/** keychain stand-in whose delete can be refused */
class Store extends FileStore {
  clearFails = false;
  /** hold the delete until released */
  clearGate: Promise<void> | null = null;
  clearStarted = false;
  async clear() {
    this.clearStarted = true;
    if (this.clearGate) await this.clearGate;
    if (this.clearFails) throw new Error('keychain delete denied');
    return super.clear();
  }
}

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((b) => b.close()));
  for (const c of caches.splice(0)) c.close();
  await fake.close();
});

const db = () => join(dir, 'cache.sqlite');
const marker = () => join(dir, 'signed-out');

function cache() {
  const c = new Cache(db());
  caches.push(c);
  return c;
}

/** SQL straight on the file: install / drop a trigger the back end cannot see coming */
function sql(statement: string) {
  const d = new DatabaseSync(db());
  d.exec('PRAGMA busy_timeout = 5000');
  d.exec(statement);
  d.close();
}
const refuseTrustWrites = () =>
  sql(`CREATE TRIGGER deny_trust BEFORE UPDATE ON setting WHEN OLD.k='trustedCredentials'
       BEGIN SELECT RAISE(ABORT,'simulated disk write failure'); END;`);
const allowTrustWrites = () => sql('DROP TRIGGER IF EXISTS deny_trust;');
const refuseCacheWipe = () =>
  sql(`CREATE TRIGGER deny_wipe BEFORE DELETE ON snapshot BEGIN SELECT RAISE(ABORT,'simulated disk write failure'); END;`);

async function app(store: FileStore, clock = { t: FIXTURE_NOW }) {
  const endpoints = { api: fake.api, web: fake.web };
  const backend = new HarnessBackend({ db: db(), endpoints, credentials: store, now: () => clock.t, sleep: async () => {} });
  open.push(backend);
  const c = await Controller.create({ backend, endpoints, now: () => clock.t, defaultClientId: fake.state.oauthClientId });
  return { c, backend };
}

async function until(c: Controller, pred: (s: AppState) => boolean, what: string) {
  for (let i = 0; i < 1500; i++) {
    if (pred(c.getState())) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout: ${what} (${JSON.stringify(c.getState().loginReason)})`);
}

/** a signed-in profile with one synced source */
async function signedIn(store: Store) {
  await store.set(FAKE_TOKEN);
  cache().setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  const h = await app(store);
  h.c.addSource(REPO);
  await h.c.start();
  await h.c.syncNow();
  expect(h.c.getState().phase).toBe('ready');
  expect(h.c.getBoardData().items.length).toBeGreaterThan(0);
  return h;
}

describe('signing out when the database refuses to clear the trust list', () => {
  it('the sign-out is not reported as clean; a restart — keychain delete failed too — does not sign back in', async () => {
    const store = new Store(join(dir, 'cred'));
    const { c, backend } = await signedIn(store);
    refuseTrustWrites();
    store.clearFails = true;
    await c.logout();
    expect(c.getState().phase).toBe('login');
    // told what happened, not a silent success
    expect(c.getState().loginReason).toContain('本地数据库写入失败');
    // "something did happen": the trigger really kept the trust list, the credential really stayed
    expect(cache().getSetting<string[]>('trustedCredentials', [])).toEqual(trustedList(FAKE_TOKEN));
    expect(await store.get()).toBe(FAKE_TOKEN);
    expect(existsSync(marker())).toBe(true);
    await backend.close();

    // quit, start again on the same files (trigger still there, credential still there)
    const before = fake.log.length;
    const again = await app(store);
    await again.c.start();
    expect(again.c.getState().phase).toBe('login');
    expect(fake.log.slice(before).filter((l) => l.auth)).toEqual([]);
    expect(again.c.getBoardData().items).toHaveLength(0);
  });

  it('the explanation is on screen at once, while the keychain delete is still pending', async () => {
    const store = new Store(join(dir, 'cred'));
    const { c } = await signedIn(store);
    refuseTrustWrites();
    let release!: () => void;
    store.clearGate = new Promise<void>((r) => (release = r));
    const out = c.logout();
    try {
      // The back end answers the sign-out first and asks the keychain to delete after that
      // (controller.ts applySignedOut), through a separate call into this process — so the
      // login page can be up a moment before clear() is entered. Wait for both (GitHub#295
      // code review round 1: asserting clearStarted right after the page switch was flaky).
      await until(c, (s) => s.phase === 'login', 'login page');
      for (let i = 0; i < 1500 && !store.clearStarted; i++) await new Promise((r) => setTimeout(r, 10));
      // "something did happen": the delete really started, and is still held by the gate
      expect(store.clearStarted).toBe(true);
      expect(c.getState().phase).toBe('login');
      expect(c.getState().loginReason).toContain('本地数据库写入失败');
    } finally {
      release();
      await out;
    }
  });

  it('once the database works again: the leftover is deleted, the marker goes, a new sign-in sticks across a restart', async () => {
    const store = new Store(join(dir, 'cred'));
    const { c, backend } = await signedIn(store);
    refuseTrustWrites();
    store.clearFails = true;
    await c.logout();
    await backend.close();
    allowTrustWrites();
    store.clearFails = false;
    const again = await app(store);
    await again.c.start();
    expect(again.c.getState().phase).toBe('login');
    expect(await store.get()).toBeNull();
    expect(existsSync(marker())).toBe(false);
    const login = again.c.startLogin();
    await until(again.c, (s) => s.login.status === 'waiting', 'waiting');
    fake.resolveGrant('approved');
    await login;
    expect(again.c.getState().phase).toBe('ready');
    await again.backend.close();
    const third = await app(store);
    await third.c.start();
    expect(third.c.getState().phase).toBe('ready');
  });

  it('neither the database nor the marker can be written: the window says a restart may sign back in', async () => {
    const store = new Store(join(dir, 'cred'));
    const { c } = await signedIn(store);
    refuseTrustWrites();
    mkdirSync(marker()); // a directory where the marker file would go: creating it fails
    store.clearFails = true;
    await c.logout();
    expect(c.getState().phase).toBe('login');
    expect(c.getState().loginReason).toContain('下次启动可能会自动登录回去');
    expect(c.getState().loginReason).toContain('钥匙串里的凭据也没能删除');
  });
});

describe('another account\'s cache that cannot be dropped', () => {
  it('a credential the cache was not read with, and the wipe refused: no sign-in on top of it, nothing of it shown', async () => {
    const TOKEN_B = 'gho_faketoken000000000000000000000002';
    const store = new Store(join(dir, 'cred'));
    const { backend } = await signedIn(store); // user-1's data on disk
    await backend.close();
    // the stored credential replaced outside the app (trusted, but not the one the cache was read with)
    await store.set(TOKEN_B);
    cache().setSetting('trustedCredentials', trustedList(FAKE_TOKEN, TOKEN_B));
    refuseCacheWipe();
    const before = fake.log.length;
    const again = await app(store);
    // "something did happen": the window was handed user-1's data at first
    expect(again.c.getBoardData().items.length).toBeGreaterThan(0);
    await again.c.start();
    expect(again.c.getState().phase).toBe('login');
    expect(again.c.getState().loginReason).toContain('本地缓存没能清空');
    expect(again.c.getBoardData().items).toHaveLength(0);
    expect(fake.log.slice(before).filter((l) => l.auth)).toEqual([]);
  });
});

describe('a cache nobody owns that cannot be dropped', () => {
  it('is never handed to the window', async () => {
    const store = new Store(join(dir, 'cred'));
    const { backend } = await signedIn(store);
    await backend.close();
    // user-1's snapshots stay, but the record of whose they are is gone (e.g. an old build)
    cache().setSetting('cacheOwner', null);
    expect(cache().loadSnapshots().size).toBeGreaterThan(0);
    refuseCacheWipe();
    const again = await app(store);
    expect(cache().loadSnapshots().size).toBeGreaterThan(0); // the wipe really was refused
    expect(again.c.getBoardData().items).toHaveLength(0);
  });
});

describe('a refresh the database cannot record', () => {
  it('still signed in on the new token, and the user is told (not silent)', async () => {
    const APP = 'ghu_storagefailapptoken00000000000001';
    const REFRESH = 'ghr_storagefailrefresh0000000000000001';
    const store = new Store(join(dir, 'cred'));
    const clock = { t: FIXTURE_NOW };
    await store.set(encodeGrant({ accessToken: APP, refreshToken: REFRESH, expiresAt: FIXTURE_NOW + 8 * HOUR, refreshExpiresAt: FIXTURE_NOW + 100 * 24 * HOUR }));
    cache().setSetting('trustedCredentials', trustedList(APP));
    cache().setSetting('grantClientId', fake.state.appClientId);
    fake.state.validTokens.add(APP);
    fake.state.refreshTokens.set(REFRESH, APP);
    fake.state.refreshClients.set(REFRESH, fake.state.appClientId);
    const { c } = await app(store, clock);
    c.addSource(REPO);
    await c.start();
    expect(c.getState().phase).toBe('ready');
    refuseTrustWrites();
    clock.t += 9 * HOUR;
    await c.syncNow();
    // "something did happen": the refresh really went through at GitHub
    expect(fake.log.some((l) => l.operation === 'refresh')).toBe(true);
    expect(c.getState().phase).toBe('ready');
    expect(c.getState().sync.problem).toContain('本地数据库写入失败');
  });
});
