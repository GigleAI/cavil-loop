// GitHub#270: "offline" and why. Every way a round sets or clears the offline flag, with the
// reason travelling along: real controller, the real back end (Rust) as a child process, the
// fake GitHub over HTTP. The flag itself is decided exactly as before; what is new is that the
// reason is shown while offline and never kept once the round is not offline any more —
// whichever way it left (GitHub answered with an error, the refresh failed otherwise, success).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
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

async function until(c: Controller, pred: (s: AppState) => boolean, what: string) {
  for (let i = 0; i < 1500; i++) {
    if (pred(c.getState())) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout: ${what}`);
}

/** Signed in as a GitHub App (an expiring token + a refresh token), one source synced. */
async function signedIn() {
  const clock = { t: FIXTURE_NOW };
  const store = new FileStore(join(dir, 'cred'));
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  const endpoints = { api: fake.api, web: fake.web };
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
  fake.state.nextGrant = { token: APP_TOKEN, refreshToken: APP_REFRESH, expiresIn: 8 * 3600 };
  c.addSource(REPO);
  await c.start();
  c.setAppKind('github-app');
  c.setClientId(fake.state.appClientId);
  const p = c.startLogin();
  await until(c, (s) => s.login.status === 'waiting', 'waiting');
  fake.resolveGrant('approved');
  await p;
  expect(c.getState()).toMatchObject({ phase: 'ready', sync: { offline: false, offlineReason: null } });
  return { c, clock };
}

const refreshes = () => fake.log.filter((l) => l.operation === 'refresh');
const viewerAsks = () => fake.log.filter((l) => l.operation === 'CavilViewer');
const sync = (c: Controller) => c.getState().sync;

/** what every state must satisfy: a reason only while offline */
function consistent(c: Controller) {
  const s = sync(c);
  if (!s.offline) expect(s.offlineReason).toBeNull();
}

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

describe('one round: offline or not, and why', () => {
  it('the identity query cannot connect → offline, the connection error as the reason', async () => {
    const { c } = await signedIn();
    fake.state.offlineApi = true;
    await c.syncNow();
    expect(sync(c).offline).toBe(true);
    expect(sync(c).offlineReason).toMatch(/^无法连接 GitHub：/);
  });

  it('the identity query answers 200 with a body that is not JSON → offline, "回应不完整"', async () => {
    const { c } = await signedIn();
    fake.state.viewerAnswers.push({ status: 200, raw: 'not json' });
    await c.syncNow();
    expect(viewerAsks().at(-1)).toMatchObject({ status: 200 });
    expect(sync(c).offline).toBe(true);
    expect(sync(c).offlineReason).toMatch(/^GitHub 回应不完整：/);
  });

  it('the identity query answers 503 → not offline (unchanged rule), no reason, the sources show it', async () => {
    const { c } = await signedIn();
    // GitHub#374: a 503 is asked twice more before it counts
    for (const _ of [1, 2, 3]) fake.state.viewerAnswers.push({ status: 503, body: { message: 'Server Error' } });
    const asked = viewerAsks().length;
    await c.syncNow();
    expect(viewerAsks().length).toBe(asked + 3);
    expect(viewerAsks().at(-1)).toMatchObject({ status: 503 });
    expect(sync(c)).toMatchObject({ offline: false, offlineReason: null });
    expect(sync(c).sources.every((s) => !s.ok && /HTTP 503/.test(s.error ?? ''))).toBe(true);
  });

  it('expired, the refresh cannot connect → offline, the refresh error as the reason', async () => {
    const { c, clock } = await signedIn();
    fake.state.offline = true;
    clock.t += 9 * HOUR;
    await c.syncNow();
    expect(sync(c).offline).toBe(true);
    expect(sync(c).offlineReason).toMatch(/^无法连接 GitHub：/);
  });

  for (const status of [503, 429]) {
    it(`expired, the refresh answers ${status} → offline, "GitHub 暂时不可用（HTTP ${status}）"`, async () => {
      const { c, clock } = await signedIn();
      clock.t += 9 * HOUR;
      fake.state.tokenAnswers.push({ kind: 'refresh', status, body: { error: 'temporarily_unavailable' } });
      await c.syncNow();
      expect(refreshes()).toHaveLength(1);
      expect(sync(c)).toMatchObject({ offline: true, offlineReason: `GitHub 暂时不可用（HTTP ${status}）` });
    });
  }

  it('identity query 401 → the one refresh answers 503 → offline, the refresh reason', async () => {
    const { c } = await signedIn();
    fake.state.validTokens.delete(APP_TOKEN);
    fake.state.tokenAnswers.push({ kind: 'refresh', status: 503, body: { error: 'temporarily_unavailable' } });
    await c.syncNow();
    expect(viewerAsks().at(-1)).toMatchObject({ status: 401 });
    expect(refreshes()).toHaveLength(1);
    expect(sync(c)).toMatchObject({ offline: true, offlineReason: 'GitHub 暂时不可用（HTTP 503）' });
  });

  it('expired, the refresh answers something unreadable → not offline (unchanged rule), no reason, the refresh problem shown', async () => {
    const { c, clock } = await signedIn();
    clock.t += 9 * HOUR;
    fake.state.tokenAnswers.push({ kind: 'refresh', status: 200, raw: 'not json' });
    await c.syncNow();
    expect(refreshes()).toHaveLength(1);
    expect(sync(c)).toMatchObject({ offline: false, offlineReason: null });
    expect(sync(c).problem).toContain('续期没有成功');
  });
});

describe('across rounds: the reason goes whenever offline goes', () => {
  it('cannot connect → identity query 503: offline true → false, the old reason cleared', async () => {
    const { c } = await signedIn();
    fake.state.offlineApi = true;
    await c.syncNow();
    expect(sync(c).offlineReason).toMatch(/^无法连接 GitHub：/);
    fake.state.offlineApi = false;
    fake.state.viewerAnswers.push({ status: 503, body: { message: 'Server Error' } });
    await c.syncNow();
    expect(sync(c)).toMatchObject({ offline: false, offlineReason: null });
    consistent(c);
  });

  it('expired: refresh cannot connect → refresh answers unreadable (no identity query this round): true → false, reason cleared', async () => {
    const { c, clock } = await signedIn();
    fake.state.offline = true;
    clock.t += 9 * HOUR;
    await c.syncNow();
    expect(sync(c).offline).toBe(true);
    expect(sync(c).offlineReason).toMatch(/^无法连接 GitHub：/);
    fake.state.offline = false;
    const asked = viewerAsks().length;
    fake.state.tokenAnswers.push({ kind: 'refresh', status: 200, raw: 'not json' });
    await c.syncNow();
    expect(viewerAsks()).toHaveLength(asked); // the round ended before the identity query
    expect(sync(c)).toMatchObject({ offline: false, offlineReason: null });
    expect(sync(c).problem).toContain('续期没有成功');
    consistent(c);
  });

  it('cannot connect → everything works: cleared', async () => {
    const { c } = await signedIn();
    fake.state.offlineApi = true;
    await c.syncNow();
    expect(sync(c).offline).toBe(true);
    fake.state.offlineApi = false;
    await c.syncNow();
    expect(sync(c)).toMatchObject({ offline: false, offlineReason: null });
    expect(sync(c).sources.every((s) => s.ok)).toBe(true);
  });

  it('cannot connect → expired, the refresh answers 503: still offline, the reason is the new one', async () => {
    const { c, clock } = await signedIn();
    fake.state.offlineApi = true;
    await c.syncNow();
    expect(sync(c).offlineReason).toMatch(/^无法连接 GitHub：/);
    fake.state.offlineApi = false;
    clock.t += 9 * HOUR;
    fake.state.tokenAnswers.push({ kind: 'refresh', status: 503, body: { error: 'temporarily_unavailable' } });
    await c.syncNow();
    expect(sync(c)).toMatchObject({ offline: true, offlineReason: 'GitHub 暂时不可用（HTTP 503）' });
  });

  it('401 → refresh 503 → next round works: offline then cleared', async () => {
    const { c } = await signedIn();
    fake.state.validTokens.delete(APP_TOKEN);
    fake.state.tokenAnswers.push({ kind: 'refresh', status: 503, body: { error: 'temporarily_unavailable' } });
    await c.syncNow();
    expect(sync(c)).toMatchObject({ offline: true, offlineReason: 'GitHub 暂时不可用（HTTP 503）' });
    await c.syncNow();
    expect(refreshes()).toHaveLength(2);
    expect(sync(c)).toMatchObject({ offline: false, offlineReason: null });
    expect(sync(c).sources.every((s) => s.ok)).toBe(true);
  });
});
