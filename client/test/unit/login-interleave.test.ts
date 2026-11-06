// A cancel or sign-out that lands while a sign-in is committing (PR #161 review round 2).
// The real back end (child process) is held inside its commit by a real SQLite write lock
// taken from a second connection the moment the keychain write lands; the cancel / sign-out
// is sent then; the lock is released. Whatever the order the back end picks, the result
// must be the same: not signed in, nothing trusted on disk, and a second process on the
// same files stays on the login page. Asserted on the back end and the second process —
// no window involved, so nothing here leans on the window cleaning up afterwards.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { FIXTURE_NOW, tempDir } from './helpers';

let fake: FakeGitHub;
let dir: string;
const open: HarnessBackend[] = [];

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((b) => b.close()));
  await fake.close();
});

const db = () => join(dir, 'cache.sqlite');

/**
 * Keychain stand-in: once `lockDbOnSet` is on, the moment a credential is written a second
 * SQLite connection takes the write lock, so the back end's commit that follows has to wait.
 */
class Store extends FileStore {
  lockDbOnSet = false;
  clearFails = false;
  holder: DatabaseSync | null = null;
  wrote: string[] = [];
  async set(v: string) {
    await super.set(v);
    this.wrote.push(v);
    if (this.lockDbOnSet && !this.holder) {
      this.holder = new DatabaseSync(db());
      this.holder.exec('BEGIN IMMEDIATE');
    }
  }
  async clear() {
    if (this.clearFails) throw new Error('keychain delete denied');
    return super.clear();
  }
  release() {
    this.holder?.exec('ROLLBACK');
    this.holder?.close();
    this.holder = null;
  }
}

function backend(store: FileStore) {
  const b = new HarnessBackend({ db: db(), endpoints: { api: fake.api, web: fake.web }, credentials: store, now: () => FIXTURE_NOW, sleep: async () => {} });
  open.push(b);
  return b;
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** device flow up to "GitHub approved": returns the attempt's run and the pending finish */
async function approvedLogin(b: HarnessBackend) {
  await b.call('init');
  await b.call('start');
  const begun = await b.call<{ status: string; run: number }>('loginBegin', { clientId: fake.state.oauthClientId });
  expect(begun.status).toBe('waiting');
  fake.resolveGrant('approved');
  const finish = b.call<{ status: string; session?: number }>('loginFinish', { run: begun.run });
  return { run: begun.run, finish };
}

/** what must hold afterwards, on the back end and on a fresh process on the same files */
async function assertNotSignedIn(b: HarnessBackend, store: Store) {
  const info = await b.call<{ signedIn: boolean; session: number }>('grantInfo');
  expect(info.signedIn).toBe(false);
  const n = fake.log.length;
  for (const session of [info.session, info.session - 1, 1, 2]) {
    expect((await b.call<{ error?: string }>('request', { session, method: 'GET', url: `${fake.api}/user` })).error).toBe('stale');
  }
  expect(fake.log.length).toBe(n);
  const c = new Cache(db());
  expect(c.getSetting<string[]>('trustedCredentials', ['unread'])).toEqual([]);
  c.close();
  await b.close();
  const again = backend(store);
  await again.call('init');
  const r = await again.call<{ phase: string }>('start');
  expect(r.phase).toBe('login');
}

describe('a sign-in committing while a cancel or sign-out lands', () => {
  for (const what of ['cancel', 'sign-out'] as const) {
    it(`${what} sent while the commit waits for the database: never signed in afterwards, restart asks to sign in`, async () => {
      const store = new Store(join(dir, 'cred'));
      store.clearFails = true; // the credential stays on disk: only the trust list decides a restart
      store.lockDbOnSet = true;
      const b = backend(store);
      const { run, finish } = await approvedLogin(b);
      for (let i = 0; i < 400 && !store.holder; i++) await tick(10);
      // "something did happen": the token really reached the keychain and the database really is locked
      expect(store.wrote.length).toBe(1);
      expect(store.holder).not.toBeNull();
      await tick(200); // let the back end reach its commit and start waiting on the database
      let landedAt = 0;
      const sent = (what === 'cancel' ? b.call('loginCancel', { run }) : b.call('logout', { reason: null })).then((r) => {
        landedAt = Date.now();
        return r;
      });
      await tick(300);
      const releasedAt = Date.now();
      store.release();
      const [done] = await Promise.all([finish, sent]);
      // either order is allowed; the outcome is not: whichever came second undid or blocked the sign-in
      expect(['ok', 'stale']).toContain(done.status);
      // the cancel / sign-out could not complete inside the commit (it waited for it)
      expect(landedAt).toBeGreaterThanOrEqual(releasedAt);
      await assertNotSignedIn(b, store);
    });
  }

  it('a cancel naming an attempt that already committed signs it out (its "signed in" was still on the way)', async () => {
    const store = new Store(join(dir, 'cred'));
    store.clearFails = true;
    const b = backend(store);
    const { run, finish } = await approvedLogin(b);
    const done = await finish;
    expect(done.status).toBe('ok'); // "something did happen": the sign-in really committed
    expect((await b.call<{ signedIn: boolean }>('grantInfo')).signedIn).toBe(true);
    const r = await b.call<{ signedOut?: { session: number } }>('loginCancel', { run });
    expect(r.signedOut?.session).toBeGreaterThan(done.session!);
    await assertNotSignedIn(b, store);
  });

  it('a cancel naming an older attempt leaves the current sign-in alone', async () => {
    const store = new Store(join(dir, 'cred'));
    const b = backend(store);
    const { run, finish } = await approvedLogin(b);
    expect((await finish).status).toBe('ok');
    const r = await b.call<{ signedOut?: unknown }>('loginCancel', { run: run - 1 });
    expect(r.signedOut).toBeUndefined();
    expect((await b.call<{ signedIn: boolean }>('grantInfo')).signedIn).toBe(true);
  });
});
