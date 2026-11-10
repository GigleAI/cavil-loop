// GitHub#364: a connection that breaks is tried again — for reads only, once a request may have
// gone out. The real controller, the real back end (Rust) as a child process, the fake GitHub over
// HTTP whose answers are broken on purpose: dropped before a byte of answer, or cut off halfway
// through the body. (A handshake that breaks before anything is sent needs TLS; the Rust tests in
// src-tauri/crates/core/src/http.rs cover it against a real local socket.)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import * as documents from '../../src/data/queries';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, type FakeGitHub, type LoggedRequest } from '../fake-github/server';
import { FIXTURE_NOW, tempDir } from './helpers';
import type { AppState } from '../../src/shared/types';

const APP_TOKEN = 'ghu_retryapptoken00000000000000000001';
const APP_REFRESH = 'ghr_retryapprefresh0000000000000000001';
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

async function signedIn(beforeLogin: () => void = () => {}) {
  const clock = { t: FIXTURE_NOW };
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  const endpoints = { api: fake.api, web: fake.web };
  const b = new HarnessBackend({
    db: join(dir, 'cache.sqlite'),
    endpoints,
    credentials: new FileStore(join(dir, 'cred')),
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
      await new Promise((r) => setTimeout(r, 5));
    },
  });
  backends.push(b);
  const c = await Controller.create({ backend: b, endpoints, now: () => clock.t, defaultClientId: fake.state.oauthClientId });
  controllers.push(c);
  fake.state.nextGrant = { token: APP_TOKEN, refreshToken: APP_REFRESH, expiresIn: 8 * 3600 };
  c.addSource(REPO);
  await c.start();
  c.setAppKind('github-app');
  c.setClientId(fake.state.appClientId);
  beforeLogin();
  const p = c.startLogin();
  await until(c, (s) => s.login.status === 'waiting', 'waiting');
  fake.resolveGrant('approved');
  await p;
  const { session } = await b.call<{ session: number }>('grantInfo');
  return { c, b, session };
}

/** the same request, as far as the fake can tell */
const key = (e: LoggedRequest) => `${e.method} ${e.path} ${e.operation ?? ''} ${JSON.stringify(e.variables ?? null)}`;

/** break the first answer of every distinct API request: `close` before the answer, or `cut` mid-body when there is one */
function breakFirstOfEach(): Set<string> {
  const seen = new Set<string>();
  let n = 0;
  fake.state.breakAnswer = (e) => {
    if (!e.path.startsWith('/api/')) return null;
    const k = key(e);
    if (seen.has(k)) return null;
    seen.add(k);
    const hasBody = e.method !== 'HEAD' && e.status === 200;
    return hasBody && n++ % 2 === 1 ? 'cut' : 'close';
  };
  return seen;
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

describe('a sync round over connections that break', () => {
  /** every broken request was sent again and that time answered in full; the round has no failed source */
  function recovered(c: Controller, round: LoggedRequest[]) {
    const broken = round.filter((e) => e.broken);
    for (const e of broken) {
      const later = round.slice(round.indexOf(e) + 1).filter((x) => key(x) === key(e));
      expect(later.length, key(e)).toBeGreaterThanOrEqual(1);
      expect(later[0].broken, key(e)).toBeUndefined();
    }
    const s = c.getState().sync;
    expect(s).toMatchObject({ offline: false, offlineReason: null });
    expect(s.sources.length).toBeGreaterThan(0);
    expect(s.sources.every((x) => x.ok)).toBe(true);
    return broken;
  }

  it('the first round reads everything in full; the first answer of every request is dropped or cut off: each is read again and the round succeeds', async () => {
    const { c } = await signedIn(() => breakFirstOfEach());
    await until(c, (s) => !s.sync.syncing && s.sync.sources.length > 0, 'first round');
    const round = fake.log.filter((e) => e.path.startsWith('/api/'));
    const broken = recovered(c, round);
    // the breaking really happened, both ways, on the identity query and on the full read of the repository
    expect(broken.some((e) => e.broken === 'close')).toBe(true);
    expect(broken.some((e) => e.broken === 'cut')).toBe(true);
    expect(broken.some((e) => e.operation === 'CavilViewer')).toBe(true);
    expect(broken.some((e) => e.method === 'GET' && e.path.includes('/issues?'))).toBe(true);
  });

  it('a later round (the change check) the same way', async () => {
    const { c } = await signedIn();
    const from = fake.log.length;
    breakFirstOfEach();
    await c.syncNow();
    const round = fake.log.slice(from);
    const broken = recovered(c, round);
    expect(broken.some((e) => e.operation === 'CavilViewer')).toBe(true);
    expect(broken.some((e) => e.method === 'HEAD')).toBe(true);
  });
});

describe('every request the window can send: reads are sent again, writes are not', () => {
  const docs = Object.entries(documents).filter(([, v]) => typeof v === 'string' && /^\s*(query|mutation)\s/.test(v)) as [string, string][];

  it('covers every GraphQL document the client has', () => {
    expect(docs.filter(([, d]) => /^\s*query\s/.test(d)).length).toBeGreaterThanOrEqual(10);
    expect(docs.filter(([, d]) => /^\s*mutation\s/.test(d)).length).toBeGreaterThanOrEqual(7);
  });

  it('each GraphQL document, its answer dropped once: a query is asked again and answered, a mutation is sent once and reported lost', async () => {
    const { b, session } = await signedIn();
    for (const [name, query] of docs) {
      const mutation = /^\s*mutation\s/.test(query);
      fake.state.breakAnswer = null;
      let dropped = 0;
      fake.state.breakAnswer = () => (dropped++ === 0 ? 'close' : null);
      const from = fake.log.length;
      const r = await b.call<{ status?: number; error?: string; message?: string }>('request', {
        session,
        method: 'POST',
        url: `${fake.api}/graphql`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: {} }),
      });
      const sent = fake.log.slice(from);
      expect(dropped, name).toBeGreaterThanOrEqual(1);
      if (mutation) {
        expect(sent.length, name).toBe(1);
        expect(r.error, name).toBe('network');
        expect(r.message, name).not.toContain('已自动重试');
      } else {
        expect(sent.length, name).toBe(2);
        expect(r.status, name).toBe(200);
      }
    }
  });

  it('REST: a read whose answer is dropped or cut is read again; a write is sent once', async () => {
    const { b, session } = await signedIn();
    const path = `${fake.api}/repos/gigleai/cavil-loop/issues?state=all&per_page=100`;
    for (const how of ['close', 'cut'] as const) {
      let n = 0;
      fake.state.breakAnswer = () => (n++ === 0 ? how : null);
      const from = fake.log.length;
      const r = await b.call<{ status?: number; body?: string }>('request', { session, method: 'GET', url: path });
      expect(fake.log.length - from, how).toBe(2);
      expect(r.status, how).toBe(200);
      expect(Array.isArray(JSON.parse(r.body ?? ''))).toBe(true);
    }
    for (const how of ['close', 'cut'] as const) {
      let n = 0;
      fake.state.breakAnswer = () => (n++ === 0 ? how : null);
      const from = fake.log.length;
      const r = await b.call<{ error?: string }>('request', {
        session,
        method: 'POST',
        url: `${fake.api}/repos/gigleai/cavil-loop/issues/1/comments`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'x' }),
      });
      expect(n, how).toBe(1);
      expect(fake.log.length - from, how).toBe(1);
      expect(r.error, how).toBe('network');
    }
  });
});
