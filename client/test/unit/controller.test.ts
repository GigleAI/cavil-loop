// End-to-end logic without a window: the controller against the fake GitHub
// over real HTTP, a real SQLite file and a credential store.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller, REASON_REVOKED } from '../../src/main/controller';
import { Cache } from '../../src/data/cache';
import { FileStore, MemoryStore } from '../../src/platform/credentials';
import { writesEnabled } from '../../src/data/board';
import { startFakeGitHub, FakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir } from './helpers';
import type { AppState } from '../../src/shared/types';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const REPO = 'GigleAI/cavil-loop';

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];

function make(opts: { credentials?: FileStore | MemoryStore; clock?: { t: number } } = {}) {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  const credentials = opts.credentials ?? new FileStore(join(dir, 'cred'));
  const clock = opts.clock ?? { t: FIXTURE_NOW };
  const opened: string[] = [];
  const c = new Controller({
    credentials,
    endpoints: { api: fake.api, web: fake.web },
    cache,
    now: () => clock.t,
    // device-flow polling: advance the fake clock instead of waiting
    sleep: async (ms) => {
      clock.t += ms;
      await new Promise((r) => setTimeout(r, 5));
    },
    openExternal: async (u) => void opened.push(u),
  });
  controllers.push(c);
  return { c, credentials, opened, clock, cache };
}

async function until(c: Controller, pred: (s: AppState) => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (pred(c.getState())) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for: ${what} (state: ${JSON.stringify(c.getState().login)} phase=${c.getState().phase})`);
}

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
});
afterEach(async () => {
  for (const c of controllers) c.stopTimer();
  for (const c of caches) c.close();
  caches = [];
  controllers = [];
  await fake.close();
});

describe('login (OAuth device flow)', () => {
  it('no stored credential → login page; without a Client ID it says so instead of calling GitHub', async () => {
    const { c } = make();
    await c.start();
    expect(c.getState().phase).toBe('login');
    await c.startLogin();
    expect(c.getState().login).toMatchObject({ status: 'error' });
    expect(c.getState().login.message).toContain('Client ID');
    expect(fake.log.filter((l) => l.path.startsWith('/web/'))).toHaveLength(0);
  });

  it('waiting → user approves → token stored, synced; a restart needs no login', async () => {
    const { c, credentials, opened } = make();
    c.setClientId(fake.state.oauthClientId);
    await c.start();
    const p = c.startLogin();
    await until(c, (s) => s.login.status === 'waiting', 'waiting');
    const s = c.getState();
    expect(s.login.userCode).toMatch(/^ABCD-/);
    expect(s.login.verificationUri).toBe(`${fake.web}/login/device`);
    await c.openVerification();
    expect(opened).toEqual([`${fake.web}/login/device`]);
    // still pending for a few polls: no token yet
    await new Promise((r) => setTimeout(r, 30));
    expect(c.getState().phase).toBe('login');
    expect(fake.log.filter((l) => l.path === '/web/login/oauth/access_token').length).toBeGreaterThan(0);
    const g = fake.resolveGrant('approved');
    await p;
    expect(c.getState().phase).toBe('ready');
    expect(await credentials.get()).toBe(g.token);
    // the device code request asked for exactly the agreed scopes
    expect(fake.state.lastScope?.split(' ').sort()).toEqual(['project', 'read:org', 'repo']);
    expect(c.getState().viewer).toBe('user-1');

    const again = make({ credentials });
    await again.c.start();
    expect(again.c.getState().phase).toBe('ready');
    expect(fake.log.filter((l) => l.path === '/web/login/device/code')).toHaveLength(1);
  });

  it('user denies on GitHub → back to the login page with the reason, nothing stored', async () => {
    const { c, credentials } = make();
    c.setClientId(fake.state.oauthClientId);
    await c.start();
    const p = c.startLogin();
    await until(c, (s) => s.login.status === 'waiting', 'waiting');
    fake.resolveGrant('denied');
    await p;
    expect(c.getState()).toMatchObject({ phase: 'login', login: { status: 'denied' } });
    expect(await credentials.get()).toBeNull();
  });

  it('code expires (GitHub says so) → expired', async () => {
    const { c } = make();
    c.setClientId(fake.state.oauthClientId);
    await c.start();
    const p = c.startLogin();
    await until(c, (s) => s.login.status === 'waiting', 'waiting');
    fake.resolveGrant('expired');
    await p;
    expect(c.getState().login.status).toBe('expired');
  });

  it('code expires (deadline passes while pending) → expired without asking again', async () => {
    fake.state.deviceExpiresIn = 3;
    const { c } = make();
    c.setClientId(fake.state.oauthClientId);
    await c.start();
    await c.startLogin();
    expect(c.getState().login.status).toBe('expired');
    const polls = fake.log.filter((l) => l.path === '/web/login/oauth/access_token').length;
    expect(polls).toBeGreaterThan(0);
    expect(polls).toBeLessThan(4);
  });

  it('slow_down is honoured (keeps polling, then succeeds)', async () => {
    fake.state.nextGrant = { slowDownOnce: true };
    const { c } = make();
    c.setClientId(fake.state.oauthClientId);
    await c.start();
    const p = c.startLogin();
    await until(c, (s) => s.login.status === 'waiting', 'waiting');
    await new Promise((r) => setTimeout(r, 40));
    fake.resolveGrant('approved');
    await p;
    expect(c.getState().phase).toBe('ready');
  });

  it('revoked credential → next sync returns to login with the reason and forgets the token', async () => {
    const credentials = new FileStore(join(dir, 'cred'));
    await credentials.set(FAKE_TOKEN);
    const { c } = make({ credentials });
    c.addSource(PROJECT_URL);
    await c.start();
    expect(c.getState().phase).toBe('ready');
    fake.state.validTokens.clear();
    await c.syncNow();
    expect(c.getState()).toMatchObject({ phase: 'login', loginReason: REASON_REVOKED });
    expect(await credentials.get()).toBeNull();
  });
});

describe('sync and cache', () => {
  async function loggedIn(clock?: { t: number }) {
    const credentials = new FileStore(join(dir, 'cred'));
    await credentials.set(FAKE_TOKEN);
    return make({ credentials, clock });
  }

  it('Project + repository: items de-duplicated, both sources ok', async () => {
    const { c } = await loggedIn();
    c.addSource(PROJECT_URL);
    c.addSource(REPO);
    await c.start();
    await c.syncNow();
    const data = c.getBoardData();
    const keys = data.items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    const fromBoth = data.items.filter((i) => i.sources.length === 2);
    expect(fromBoth.length).toBeGreaterThan(0);
    expect(c.getState().sync.sources.map((s) => s.ok)).toEqual([true, true]);
  });

  it('a source that fails mid-pagination keeps its previous snapshot; the other source still refreshes', async () => {
    const clock = { t: FIXTURE_NOW };
    const { c, cache } = await loggedIn(clock);
    c.addSource(PROJECT_URL);
    c.addSource(REPO);
    await c.start();
    await c.syncNow();
    const before = c.getBoardData().items.length;
    const projectFetchedAt = cache.loadSnapshots().get('project:org/gigleai/11')!.fetchedAt;

    // page 2 of the Project now fails; page 1 changed meanwhile (must NOT leak in)
    fake.state.failProjectPage.set('org/gigleai/11', 1);
    const pages = fake.state.projects.get('org/gigleai/11')!;
    pages[0] = { ...pages[0], items: { ...pages[0].items, nodes: pages[0].items.nodes.slice(0, 10) } };
    clock.t += 60_000;
    await c.syncNow();

    const st = c.getState().sync;
    const proj = st.sources.find((s) => s.sourceKey === 'project:org/gigleai/11')!;
    const repo = st.sources.find((s) => s.sourceKey === 'repo:gigleai/cavil-loop')!;
    expect(proj).toMatchObject({ ok: false, dataFrom: projectFetchedAt });
    expect(proj.error).toContain('502');
    // "something did happen": the repo source was re-read this round
    expect(repo).toMatchObject({ ok: true, dataFrom: clock.t });
    expect(c.getBoardData().items.length).toBe(before);
    expect(cache.loadSnapshots().get('project:org/gigleai/11')!.items.length).toBe(138);
    expect(st.offline).toBe(false);
  });

  it('each successful round replaces the cached snapshot as a whole', async () => {
    const { c, cache } = await loggedIn();
    c.addSource(PROJECT_URL);
    await c.start();
    await c.syncNow();
    expect(cache.loadSnapshots().get('project:org/gigleai/11')!.items).toHaveLength(138);
    const pages = fake.state.projects.get('org/gigleai/11')!;
    fake.state.projects.set('org/gigleai/11', [{ ...pages[0], items: { ...pages[0].items, pageInfo: { hasNextPage: false, endCursor: null }, nodes: pages[0].items.nodes.slice(0, 5) } }]);
    await c.syncNow();
    expect(cache.loadSnapshots().get('project:org/gigleai/11')!.items).toHaveLength(5);
    expect(c.getBoardData().items).toHaveLength(5);
  });

  it('offline restart: cached content still shows, flagged offline with its age, writes disabled', async () => {
    const clock = { t: FIXTURE_NOW };
    const first = await loggedIn(clock);
    first.c.addSource(PROJECT_URL);
    await first.c.start();
    await first.c.syncNow();
    expect(writesEnabled(first.c.getState().sync)).toBe(true);
    first.c.stopTimer();

    fake.state.offline = true;
    clock.t += 5 * 60_000;
    const second = make({ credentials: first.credentials, clock });
    await second.c.start();
    const s = second.c.getState();
    expect(s.phase).toBe('ready');
    expect(s.sync.offline).toBe(true);
    expect(s.sync.dataFrom).toBe(FIXTURE_NOW);
    expect(writesEnabled(s.sync)).toBe(false);
    expect(second.c.getBoardData().items).toHaveLength(138);
    // and the token is NOT dropped just because GitHub is unreachable
    expect(await first.credentials.get()).toBe(FAKE_TOKEN);
  });

  it('removing a source drops its cached data', async () => {
    const { c, cache } = await loggedIn();
    c.addSource(PROJECT_URL);
    await c.start();
    await c.syncNow();
    c.removeSource('project:org/gigleai/11');
    expect(c.getBoardData().items).toHaveLength(0);
    expect(cache.loadSnapshots().size).toBe(0);
  });

  it('rejects unparseable and duplicate sources', async () => {
    const { c } = await loggedIn();
    expect(c.addSource('nope').ok).toBe(false);
    expect(c.addSource(REPO).ok).toBe(true);
    expect(c.addSource('https://github.com/gigleai/CAVIL-LOOP').ok).toBe(false);
  });
});
