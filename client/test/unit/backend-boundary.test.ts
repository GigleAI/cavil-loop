// The window never holds the GitHub credential (GitHub#151): the back end (Rust,
// a real child process here) signs requests for a session the window names.
// Checked on what really crosses the boundary — every command and every answer
// of a whole sign-in, sync, change, refresh and sign-out — plus the back end
// refusing requests to anything but the GitHub API.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { FIXTURE_NOW, tempDir } from './helpers';
import type { AppState } from '../../src/shared/types';

const APP_TOKEN = 'ghu_boundaryapptoken000000000000000001';
const APP_REFRESH = 'ghr_boundaryrefresh0000000000000000001';
const HOUR = 3_600_000;
const REPO = 'GigleAI/cavil-loop';

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

async function until(c: Controller, pred: (s: AppState) => boolean) {
  for (let i = 0; i < 400; i++) {
    if (pred(c.getState())) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timeout');
}

function backend(clock: { t: number }) {
  const b = new HarnessBackend({
    db: join(dir, 'cache.sqlite'),
    endpoints: { api: fake.api, web: fake.web },
    credentials: new FileStore(join(dir, 'cred')),
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
      await new Promise((r) => setTimeout(r, 5));
    },
  });
  open.push(b);
  return b;
}

describe('the credential never crosses into the window', () => {
  it('sign in, sync, change an item, refresh, sign out: no command and no answer carries a token', async () => {
    const clock = { t: FIXTURE_NOW };
    const b = backend(clock);
    const c = await Controller.create({ backend: b, endpoints: { api: fake.api, web: fake.web }, now: () => clock.t, defaultClientId: fake.state.oauthClientId });
    c.addSource(REPO);
    await c.start();
    c.setAppKind('github-app');
    c.setClientId(fake.state.appClientId);
    fake.state.nextGrant = { token: APP_TOKEN, refreshToken: APP_REFRESH, expiresIn: 8 * 3600 };
    const login = c.startLogin();
    await until(c, (s) => s.login.status === 'waiting');
    fake.resolveGrant('approved');
    await login;
    expect(c.getState().phase).toBe('ready');
    const key = c.getBoardData().items[0].key;
    expect((await c.act({ kind: 'addLabel', key, label: 'bug' })).ok).toBe(true);
    clock.t += 9 * HOUR; // due: the next round refreshes
    await c.syncNow();
    await c.logout();
    // "something did happen": GitHub saw the original token and the refreshed one, a write, a refresh
    const auths = new Set(fake.log.map((l) => l.auth).filter(Boolean));
    expect(auths.has(`Bearer ${APP_TOKEN}`)).toBe(true);
    expect([...auths].some((a) => a !== `Bearer ${APP_TOKEN}`)).toBe(true);
    expect(fake.log.some((l) => l.operation === 'refresh')).toBe(true);
    expect(fake.log.some((l) => l.method === 'POST' && l.path.includes('/labels'))).toBe(true);
    // every token GitHub handed out (access + refresh, before and after the refresh)
    const secrets = [APP_TOKEN, APP_REFRESH, ...[...auths].map((a) => a!.replace(/^Bearer\s+/, ''))];
    const crossed = JSON.stringify({ sent: b.sent, received: b.received });
    expect(b.sent.length).toBeGreaterThan(10);
    for (const s of secrets) expect(crossed, `token ${s.slice(0, 8)}… crossed the boundary`).not.toContain(s);
    expect(crossed).not.toMatch(/gh[ousr]_[A-Za-z0-9]{20,}/);
    // and the window's settings never held one either
    expect(JSON.stringify(c.getState())).not.toMatch(/gh[ousr]_[A-Za-z0-9]{20,}/);
  });
});

describe('the back end only signs requests for the GitHub API', () => {
  async function signedIn() {
    const clock = { t: FIXTURE_NOW };
    const b = backend(clock);
    const c = await Controller.create({ backend: b, endpoints: { api: fake.api, web: fake.web }, now: () => clock.t, defaultClientId: fake.state.oauthClientId });
    await c.start();
    const login = c.startLogin();
    await until(c, (s) => s.login.status === 'waiting');
    fake.resolveGrant('approved');
    await login;
    const { session } = await b.call<{ session: number }>('grantInfo');
    return { b, session };
  }

  it('the API: signed; the web side, a sibling path, another port, another host: refused before anything is sent', async () => {
    const { b, session } = await signedIn();
    const before = fake.log.length;
    const ok = await b.call<{ status?: number }>('request', { session, method: 'POST', url: `${fake.api}/graphql`, headers: { 'Content-Type': 'application/json' }, body: '{"query":"query { viewer { login } }"}' });
    expect(ok.status).toBe(200);
    expect(fake.log.length).toBe(before + 1);
    expect(fake.log.at(-1)!.auth).toMatch(/^Bearer /);
    const port = Number(new URL(fake.api).port);
    for (const url of [`${fake.web}/login/device`, `${fake.api}x/graphql`, `http://127.0.0.1:${port + 1}/api/graphql`, 'https://example.com/api/graphql', `http://user@127.0.0.1:${port}/api/graphql`]) {
      const r = await b.call<{ error?: string }>('request', { session, method: 'GET', url });
      expect(r.error, url).toBe('refused');
    }
    expect(fake.log.length).toBe(before + 1);
  });

  it('a header the window sets cannot replace the credential; a finished session signs nothing', async () => {
    const { b, session } = await signedIn();
    await b.call('request', { session, method: 'GET', url: `${fake.api}/user`, headers: { Authorization: 'Bearer gho_fromthewindow0000000000000000000' } });
    expect(fake.log.at(-1)!.auth).not.toContain('fromthewindow');
    expect(fake.log.at(-1)!.auth).toMatch(/^Bearer /);
    const n = fake.log.length;
    expect((await b.call<{ error?: string }>('request', { session: session + 1, method: 'GET', url: `${fake.api}/user` })).error).toBe('stale');
    await b.call('logout', { reason: null });
    expect((await b.call<{ error?: string }>('request', { session, method: 'GET', url: `${fake.api}/user` })).error).toBe('stale');
    expect(fake.log.length).toBe(n);
  });

  it('the settings that describe the credential cannot be written from the window', async () => {
    const { b } = await signedIn();
    for (const key of ['trustedCredentials', 'cacheCredential', 'cacheOwner', 'grantClientId']) {
      await expect(b.call('setSetting', { key, value: ['x'] }), key).rejects.toThrow(/只能由登录流程写/);
    }
    // and the window is never told them
    const init = await b.call<{ settings: Record<string, unknown> }>('init');
    expect(Object.keys(init.settings)).not.toContain('trustedCredentials');
    expect(Object.keys(init.settings)).not.toContain('cacheCredential');
    expect(Object.keys(init.settings).length).toBeGreaterThan(0);
  });
});
