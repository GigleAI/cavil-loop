// Run as separate Node processes by test/unit/crash-restart.test.ts (bundled
// with esbuild), each with the real back end (Rust) as its child process.
// Phase 1 brings a profile into some state and then ends the process abruptly
// (process.exit, which takes the back end with it) at a chosen point — the way
// quitting the app does while a keychain operation has not returned. Phase 2 is a fresh process
// on the same files: it must never sign in with a credential the user signed
// out of, and must keep a credential that was legitimately being written.
//
//   node driver.mjs <dir> <scenario>   scenarios: see SCENARIOS below; "restart" = phase 2
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { encodeGrant, decodeGrant } from '../support/grant';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { createHash } from 'node:crypto';

const [dir, scenario] = process.argv.slice(2);
mkdirSync(dir, { recursive: true });
const NOW = Date.parse('2026-11-05T12:00:00Z');
const OLD = 'ghu_oldtoken0000000000000000000000000001';
const OLD_REFRESH = 'ghr_oldrefresh000000000000000000000000001';
const NEW = 'ghu_newtoken0000000000000000000000000001';
const NEW_REFRESH = 'ghr_newrefresh000000000000000000000000001';
const never = new Promise<never>(() => {});

/** File-backed store with switchable failure points. */
class Store extends FileStore {
  mode: 'normal' | 'clear-hangs' | 'clear-fails' | 'set-writes-then-hangs' | 'set-hangs' = 'normal';
  clearStarted = false;
  setStarted = false;
  async clear() {
    this.clearStarted = true;
    if (this.mode === 'clear-hangs') return never;
    if (this.mode === 'clear-fails') throw new Error('keychain delete denied');
    return super.clear();
  }
  async set(v: string) {
    this.setStarted = true;
    if (this.mode === 'set-hangs') return never; // never written, never returns: holds the credential queue
    await super.set(v);
    if (this.mode === 'set-writes-then-hangs') return never; // written, but the call never returns
  }
}

// A tiny GitHub on loopback (the back end makes real HTTP requests): device flow,
// token, viewer, empty lists; every Authorization header it sees is recorded.
const auths: string[] = [];
const server = createServer((req, res) => {
  const auth = req.headers.authorization;
  if (auth) auths.push(auth);
  const json = (b: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(b));
  };
  req.resume();
  req.on('end', () => {
    const url = req.url ?? '';
    if (url.endsWith('/login/device/code')) return json({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: `http://127.0.0.1:${port}/web/login/device`, expires_in: 900, interval: 0 });
    if (url.endsWith('/login/oauth/access_token')) return json({ access_token: NEW, refresh_token: NEW_REFRESH, expires_in: 28800, refresh_token_expires_in: 15897600 });
    if (url.endsWith('/graphql')) return json({ data: { viewer: { login: 'user-1' } } });
    return json([]);
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as AddressInfo).port;
const endpoints = { api: `http://127.0.0.1:${port}/api`, web: `http://127.0.0.1:${port}/web` };

const store = new Store(join(dir, 'cred'));
const cache = new Cache(join(dir, 'cache.sqlite'));
// the real back end (Rust) as a child process: it dies with this one
let clock = NOW;
const backend = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials: store, now: () => clock, sleep: async () => {} });
const c = await Controller.create({ backend, endpoints, now: () => clock, defaultClientId: 'Ov23litestclient0000' });
const report = async (tag: string) => {
  const stored = decodeGrant(await new FileStore(join(dir, 'cred')).get());
  console.log(tag, JSON.stringify({ phase: c.getState().phase, stored: stored?.accessToken ?? null, auths, reason: c.getState().loginReason }));
};
const tick = () => new Promise((r) => setTimeout(r, 20));

/** A signed-in profile: grant stored and trusted through a real start(). */
async function signedIn(grant = { accessToken: OLD, refreshToken: OLD_REFRESH, expiresAt: NOW + 3_600_000, refreshExpiresAt: NOW + 86_400_000 * 30 }) {
  await store.set(encodeGrant(grant));
  // what a completed sign-in leaves on disk; LEGACY=1 = a preview build from before the trust list,
  // which never wrote it (its own start() signs in with whatever is stored)
  if (process.env.LEGACY !== '1') cache.setSetting('trustedCredentials', [createHash('sha256').update(grant.accessToken).digest('hex')]);
  await c.start();
  if (c.getState().phase !== 'ready') throw new Error('setup: not signed in');
}

const SCENARIOS: Record<string, () => Promise<void>> = {
  // sign-out, the keychain delete is still waiting when the app quits
  'logout-delete-pending': async () => {
    await signedIn();
    store.mode = 'clear-hangs';
    void c.logout();
    while (!store.clearStarted) await tick();
  },
  // sign-out, the delete has not even started (an earlier keychain call holds the queue:
  // a refresh whose keychain write never returns)
  'logout-delete-queued': async () => {
    await signedIn();
    clock += 3_600_000; // the token is now due for a refresh
    store.mode = 'set-hangs';
    store.setStarted = false;
    void c.syncNow(); // due for a refresh → GitHub answers → the write holds the queue
    while (!store.setStarted) await tick();
    void c.logout();
    // the page switch does not wait for the queue, but on a slow machine one 20 ms tick is not
    // always enough for it to land (GitHub CI, PR #183): wait for it, bounded
    for (let i = 0; i < 200 && c.getState().phase !== 'login'; i++) await tick();
    if (store.clearStarted) throw new Error('setup: delete should not have started');
  },
  'logout-delete-fails': async () => {
    await signedIn();
    store.mode = 'clear-fails';
    await c.logout();
  },
  'logout-delete-ok': async () => {
    await signedIn();
    await c.logout();
  },
  // a brand-new profile signs in; the keychain write lands but never returns before the app quits
  'login-write-pending': async () => {
    await c.start();
    store.mode = 'set-writes-then-hangs';
    void c.startLogin();
    for (let i = 0; i < 200 && !(await new FileStore(join(dir, 'cred')).get()); i++) await tick();
  },
  // signed in, nothing else (used with LEGACY=1: an old build's normal signed-in profile)
  'signed-in': async () => {
    await signedIn();
  },
  // a full sign-in through the device flow, then quit normally
  login: async () => {
    await c.start();
    await c.startLogin();
    if (c.getState().phase !== 'ready') throw new Error('login did not complete');
  },
  restart: async () => {
    await c.start();
  },
};

// signed in with an expiring token; the refreshed one is written but the call never returns
if (scenario === 'refresh-write-pending') {
  // build the signed-in profile by hand: old grant stored and trusted, refresh due
  await store.set(encodeGrant({ accessToken: OLD, refreshToken: OLD_REFRESH, expiresAt: NOW - 1, refreshExpiresAt: NOW + 86_400_000 * 30 }));
  cache.setSetting('trustedCredentials', [createHash('sha256').update(OLD).digest('hex')]);
  store.mode = 'set-writes-then-hangs';
  void c.start(); // start → round → refresh → write lands, never returns
  for (let i = 0; i < 200; i++) {
    const s = decodeGrant(await new FileStore(join(dir, 'cred')).get());
    if (s?.accessToken === NEW) break;
    await tick();
  }
  await report('PHASE1');
  process.exit(0);
}

const run = SCENARIOS[scenario];
if (!run) {
  console.error(`unknown scenario ${scenario}`);
  process.exit(2);
}
await run();
await report(scenario === 'restart' ? 'PHASE2' : 'PHASE1');
// end the process right here, like quitting the app with the keychain call outstanding
process.exit(0);
