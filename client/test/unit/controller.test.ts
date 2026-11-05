// End-to-end logic without a window: the controller against the fake GitHub
// over real HTTP, a real SQLite file and a credential store.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller, REASON_REVOKED } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore, MemoryStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { writesEnabled } from '../../src/data/board';
import { startFakeGitHub, FakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList, FIXTURE_ITEM_COUNT } from './helpers';
import type { AppState } from '../../src/shared/types';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const REPO = 'GigleAI/cavil-loop';

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

async function make(opts: { credentials?: FileStore | MemoryStore; clock?: { t: number }; defaultClientId?: string; defaultGithubAppClientId?: string; seed?: Record<string, unknown> } = {}) {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  for (const [k, v] of Object.entries(opts.seed ?? {})) cache.setSetting(k, v);
  // tests seed FAKE_TOKEN straight into the store: record it as signed in with, like a completed login
  if (cache.getSetting('trustedCredentials', null) === null) cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  const credentials = opts.credentials ?? new FileStore(join(dir, 'cred'));
  const clock = opts.clock ?? { t: FIXTURE_NOW };
  const opened: string[] = [];
  const endpoints = { api: fake.api, web: fake.web };
  // the real back end (Rust) as a child process, on the same files
  const backend = new HarnessBackend({
    db: join(dir, 'cache.sqlite'),
    endpoints,
    credentials,
    now: () => clock.t,
    // device-flow polling: advance the fake clock instead of waiting
    sleep: async (ms) => {
      clock.t += ms;
      await new Promise((r) => setTimeout(r, 5));
    },
    opened,
  });
  backends.push(backend);
  const c = await Controller.create({
    backend,
    endpoints,
    now: () => clock.t,
    // no built-in Client ID unless a test asks for one (the real built-in one is GitHub's, not the fake's)
    defaultClientId: opts.defaultClientId ?? '',
    ...(opts.defaultGithubAppClientId !== undefined ? { defaultGithubAppClientId: opts.defaultGithubAppClientId } : {}),
  });
  controllers.push(c);
  return { c, credentials, opened, clock, cache, backend };
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
  await Promise.all(backends.map((b) => b.close()));
  for (const c of caches) c.close();
  caches = [];
  controllers = [];
  backends = [];
  await fake.close();
});

describe('login (OAuth device flow)', () => {
  it('no stored credential → login page; without a Client ID it says so instead of calling GitHub', async () => {
    const { c } = await make();
    await c.start();
    expect(c.getState().phase).toBe('login');
    await c.startLogin();
    expect(c.getState().login).toMatchObject({ status: 'error' });
    expect(c.getState().login.message).toContain('Client ID');
    expect(fake.log.filter((l) => l.path.startsWith('/web/'))).toHaveLength(0);
  });

  it('the built-in Client ID is used when none is configured', async () => {
    const { c } = await make({ defaultClientId: fake.state.oauthClientId });
    await c.start();
    expect(c.getState()).toMatchObject({ appKind: 'oauth', clientId: fake.state.oauthClientId, clientIdIsDefault: true });
    const p = c.startLogin();
    await until(c, (s) => s.login.status === 'waiting', 'waiting');
    fake.resolveGrant('approved');
    await p;
    expect(c.getState().phase).toBe('ready');
    // an override replaces it, clearing the override brings it back
    c.setClientId('Ov23other');
    expect(c.getState()).toMatchObject({ clientId: 'Ov23other', clientIdIsDefault: false });
    c.setClientId('');
    expect(c.getState()).toMatchObject({ appKind: 'oauth', clientId: fake.state.oauthClientId, clientIdIsDefault: true });
  });

  it('waiting → user approves → token stored, synced; a restart needs no login', async () => {
    const { c, credentials, opened } = await make();
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

    const again = await make({ credentials });
    await again.c.start();
    expect(again.c.getState().phase).toBe('ready');
    expect(fake.log.filter((l) => l.path === '/web/login/device/code')).toHaveLength(1);
  });

  it('user denies on GitHub → back to the login page with the reason, nothing stored', async () => {
    const { c, credentials } = await make();
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
    const { c } = await make();
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
    const { c } = await make();
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
    const { c } = await make();
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
    const { c } = await make({ credentials });
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
    return await make({ credentials, clock });
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
    expect(cache.loadSnapshots().get('project:org/gigleai/11')!.items.length).toBe(FIXTURE_ITEM_COUNT);
    expect(st.offline).toBe(false);
  });

  it('each successful round replaces the cached snapshot as a whole', async () => {
    const { c, cache } = await loggedIn();
    c.addSource(PROJECT_URL);
    await c.start();
    await c.syncNow();
    expect(cache.loadSnapshots().get('project:org/gigleai/11')!.items).toHaveLength(FIXTURE_ITEM_COUNT);
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
    const second = await make({ credentials: first.credentials, clock });
    await second.c.start();
    const s = second.c.getState();
    expect(s.phase).toBe('ready');
    expect(s.sync.offline).toBe(true);
    expect(s.sync.dataFrom).toBe(FIXTURE_NOW);
    expect(writesEnabled(s.sync)).toBe(false);
    expect(second.c.getBoardData().items).toHaveLength(FIXTURE_ITEM_COUNT);
    // and the token is NOT dropped just because GitHub is unreachable
    expect(await first.credentials.get()).toBe(FAKE_TOKEN);
  });

  it('adding a Project imports its saved web view (/views/N, else the first) after the first complete read', async () => {
    const { c } = await loggedIn();
    expect(c.getState().view).toMatchObject({ layout: 'board', query: '', imported: null });
    c.addSource(`${PROJECT_URL}/views/2`);
    // nothing is imported before the Project was read
    expect(c.getState().view.imported).toBeNull();
    await c.start();
    await c.syncNow();
    expect(c.getState().view).toMatchObject({
      layout: 'board',
      mode: 'status',
      query: '-label:nightly-failure',
      imported: { sourceKey: 'project:org/gigleai/11', viewNumber: 2, viewName: '迭代统计' },
    });
    // a later round does not import again
    c.setView({ query: 'label:bug' });
    await c.syncNow();
    expect(c.getState().view.query).toBe('label:bug');

    // a repository brings no view; a Project without /views/N imports the first one
    c.removeSource('project:org/gigleai/11');
    c.addSource(REPO);
    await c.syncNow();
    expect(c.getState().view.query).toBe('label:bug');
    c.addSource(PROJECT_URL);
    await c.syncNow();
    expect(c.getState().view).toMatchObject({ layout: 'table', query: '-label:Done -status:Done', imported: { viewNumber: 1, viewName: 'Pending' } });
    expect(c.getState().view.table).toMatchObject({ groupBy: 'iteration', sort: { field: 'updated', dir: 'desc' } });
  });

  it('the import happens once: a later change of the saved view on GitHub does not override the client', async () => {
    const { c } = await loggedIn();
    c.addSource(`${PROJECT_URL}/views/1`);
    await c.start();
    await c.syncNow();
    expect(c.getState().view).toMatchObject({ layout: 'table', query: '-label:Done -status:Done' });
    // someone edits the saved view on github.com; the client keeps what it imported
    const pages = fake.state.projects.get('org/gigleai/11')!;
    const edited = pages.map((p: any) => ({
      ...p,
      views: { nodes: p.views.nodes.map((v: any) => (v.number === 1 ? { ...v, filter: 'is:open', layout: 'BOARD_LAYOUT' } : v)) },
    }));
    fake.state.projects.set('org/gigleai/11', edited);
    await c.syncNow();
    expect(c.getBoardData().projects[0].views[0]).toMatchObject({ filter: 'is:open' }); // the round did read the edit
    expect(c.getState().view).toMatchObject({ layout: 'table', query: '-label:Done -status:Done' });
  });

  it('settings changed by the user survive a restart; removing and re-adding the Project imports again', async () => {
    const first = await loggedIn();
    first.c.addSource(`${PROJECT_URL}/views/1`);
    await first.c.start();
    await first.c.syncNow();
    first.c.setView({ table: { groupBy: 'status' } });
    first.c.setView({ table: { sort: { field: 'title', dir: 'asc' }, columns: ['title', 'assignees'], sliceByRepo: false, slice: 'GigleAI/cavil-loop', hierarchy: false } });
    first.c.setView({ layout: 'board', query: 'is:open' });
    const changed = first.c.getState().view;
    first.c.stopTimer();

    const second = await make({ credentials: first.credentials });
    await second.c.start();
    await second.c.syncNow();
    expect(second.c.getState().view).toEqual(changed);
    expect(changed.table).toMatchObject({ groupBy: 'status', sort: { field: 'title', dir: 'asc' }, columns: ['title', 'assignees'], sliceByRepo: false, slice: 'GigleAI/cavil-loop', hierarchy: false });

    second.c.removeSource('project:org/gigleai/11');
    second.c.addSource(`${PROJECT_URL}/views/1`);
    await second.c.syncNow();
    expect(second.c.getState().view).toMatchObject({ layout: 'table', query: '-label:Done -status:Done' });
    expect(second.c.getState().view.table).toMatchObject({ groupBy: 'iteration', sort: { field: 'updated', dir: 'desc' }, slice: null, sliceByRepo: true, hierarchy: true });
  });

  it('a change made before the Project was first read wins over the import; a failed read imports later', async () => {
    const { c } = await loggedIn();
    fake.state.failProjectPage.set('org/gigleai/11', 1);
    c.addSource(`${PROJECT_URL}/views/1`);
    await c.start();
    await c.syncNow();
    expect(c.getState().view.imported).toBeNull(); // read failed on page 2: nothing imported yet
    c.setView({ table: { groupBy: 'repo' }, query: 'is:pr' });
    fake.state.failProjectPage.delete('org/gigleai/11');
    await c.syncNow();
    const v = c.getState().view;
    expect(v.imported).toMatchObject({ viewNumber: 1 });
    expect(v).toMatchObject({ layout: 'table', query: 'is:pr' });
    expect(v.table).toMatchObject({ groupBy: 'repo', sort: { field: 'updated', dir: 'desc' } });
  });

  it('invalid view changes are refused whole; settings saved by an older build are read with defaults', async () => {
    const { c } = await loggedIn();
    const before = c.getState().view;
    c.setView({ table: { groupBy: 'priority' as any } });
    c.setView({ layout: 'roadmap' as any });
    c.setView({ table: { columns: [] } });
    expect(c.getState().view).toEqual(before);
    const old = await make({ seed: { view: { mode: 'status', swimlanes: true, selected: null } } });
    expect(old.c.getState().view).toMatchObject({ mode: 'status', swimlanes: true, layout: 'board', query: '', imported: null });
    expect(old.c.getState().view.table.groupBy).toBe('iteration');
  });

  it('removing a source drops its cached data', async () => {
    const { c, cache } = await loggedIn();
    c.addSource(PROJECT_URL);
    await c.start();
    await c.syncNow();
    c.removeSource('project:org/gigleai/11');
    expect(c.getBoardData().items).toHaveLength(0);
    await c.settled(); // the back end has the file: wait until it answered
    expect(cache.loadSnapshots().size).toBe(0);
  });

  it('rejects unparseable and duplicate sources', async () => {
    const { c } = await loggedIn();
    expect(c.addSource('nope').ok).toBe(false);
    expect(c.addSource(REPO).ok).toBe(true);
    expect(c.addSource('https://github.com/gigleai/CAVIL-LOOP').ok).toBe(false);
  });
});

// ---- review round 1 (PR #140): account isolation and removals during a round ----

const TOKEN_B = 'gho_faketokenB00000000000000000000002';
const REPO_KEY = 'repo:gigleai/cavil-loop';

/** account B ("user-2") exists on the fake and cannot read GigleAI/cavil-loop */
function accountB() {
  fake.state.tokenViewers.set(TOKEN_B, 'user-2');
  fake.state.deniedRepos.set('user-2', new Set(['gigleai/cavil-loop']));
}

async function loginViaBrowser(c: Controller, token: string) {
  fake.state.nextGrant = { token };
  c.setClientId(fake.state.oauthClientId);
  const p = c.startLogin();
  await until(c, (s) => s.login.status === 'waiting', 'waiting');
  fake.resolveGrant('approved');
  return p;
}

/** wait until the fake has seen `n` requests whose path contains `fragment` */
async function requestsSeen(fragment: string, n: number) {
  for (let i = 0; i < 400; i++) {
    if (fake.log.filter((l) => l.path.includes(fragment)).length >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`fake never saw ${n} requests to ${fragment}`);
}

describe('the cache belongs to one account', () => {
  async function accountA() {
    const credentials = new FileStore(join(dir, 'cred'));
    await credentials.set(FAKE_TOKEN);
    const h = await make({ credentials });
    h.c.addSource(REPO);
    await h.c.start();
    await h.c.syncNow();
    // "something did happen": A really read its private repository
    expect(h.c.getBoardData().items.length).toBeGreaterThan(0);
    expect(h.cache.loadSnapshots().size).toBe(1);
    return h;
  }

  it('sign out → another account signs in: none of the first account\'s items are shown or kept', async () => {
    accountB();
    const { c, cache } = await accountA();
    await c.logout();
    expect(cache.loadSnapshots().size).toBe(0);
    expect(c.getBoardData().items).toHaveLength(0);
    expect(cache.getSetting('viewer', 'x')).toBeNull();

    await loginViaBrowser(c, TOKEN_B);
    expect(c.getState().viewer).toBe('user-2');
    const st = c.getState().sync.sources.find((s) => s.sourceKey === REPO_KEY)!;
    expect(st).toMatchObject({ ok: false, dataFrom: null });
    expect(st.error).toContain('404');
    expect(c.getBoardData().items).toHaveLength(0);
    expect(cache.loadSnapshots().size).toBe(0);
  });

  it('credential replaced outside the app: not trusted, so not used — login page, nothing cached shown, nothing sent', async () => {
    accountB();
    const a = await accountA();
    a.c.stopTimer();
    await a.credentials.set(TOKEN_B);
    fake.state.validTokens.add(TOKEN_B);
    const b = await make({ credentials: a.credentials });
    const n = fake.log.length;
    await b.c.start();
    expect(b.c.getState().phase).toBe('login');
    expect(b.c.getBoardData().items).toHaveLength(0);
    expect(b.cache.loadSnapshots().size).toBe(0);
    expect(fake.log.length).toBe(n);
    expect(await a.credentials.get()).toBeNull(); // the untrusted leftover is removed
  });

  // The two below: even if the trust list did list the replaced credential (say a
  // future bug), the cache binding still keeps the other account's data off screen.
  it('credential replaced outside the app, restart offline: the other account\'s cache is not shown', async () => {
    accountB();
    const a = await accountA();
    a.c.stopTimer();
    a.cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN, TOKEN_B));
    await a.credentials.set(TOKEN_B);
    fake.state.validTokens.add(TOKEN_B);
    fake.state.offline = true;
    const b = await make({ credentials: a.credentials });
    await b.c.start();
    expect(b.c.getState()).toMatchObject({ phase: 'ready', sync: { offline: true } });
    expect(b.c.getBoardData().items).toHaveLength(0);
    expect(b.cache.loadSnapshots().size).toBe(0);
  });

  it('credential replaced outside the app, restart online: GitHub says another account → cache dropped', async () => {
    accountB();
    const a = await accountA();
    a.c.stopTimer();
    a.cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN, TOKEN_B));
    await a.credentials.set(TOKEN_B);
    fake.state.validTokens.add(TOKEN_B);
    const b = await make({ credentials: a.credentials });
    await b.c.start();
    expect(b.c.getState().viewer).toBe('user-2');
    expect(b.c.getBoardData().items).toHaveLength(0);
    expect(b.cache.loadSnapshots().size).toBe(0);
  });

  it('a round still in flight for the first account never lands after the second one signs in', async () => {
    accountB();
    fake.state.deniedRepos.clear(); // B may read the repo too: only the round's owner decides
    fake.state.tokenViewers.set(TOKEN_B, 'user-2');
    const credentials = new FileStore(join(dir, 'cred'));
    await credentials.set(FAKE_TOKEN);
    const { c, cache } = await make({ credentials });
    c.addSource(REPO);
    await c.start();
    const release = fake.hold('/repos/GigleAI/cavil-loop/issues');
    const before = fake.log.filter((l) => l.path.includes('/issues?')).length;
    const inflight = c.syncNow();
    await requestsSeen('/issues?', before + 2);
    await c.logout();
    // From here on, at no moment may A's data be visible or owned (a later B round
    // overwriting it would hide the leak from an end-state check).
    const leaks: string[] = [];
    c.onChange(() => {
      const n = c.getBoardData().items.length;
      if (n > 1) leaks.push(`board showed ${n} items`);
      if (cache.getSetting('cacheOwner', null) === 'user-1') leaks.push('cache owned by user-1 again');
      const cached = cache.loadSnapshots().get(REPO_KEY)?.items.length ?? 0;
      if (cached > 1) leaks.push(`cache held ${cached} items`);
    });
    // B's repository has different content: whatever is shown must be B's
    fake.state.repos.set('gigleai/cavil-loop', [fake.state.repos.get('gigleai/cavil-loop')![0]]);
    const login = loginViaBrowser(c, TOKEN_B);
    await until(c, (s) => s.phase === 'ready', 'B ready');
    release();
    await inflight;
    await login;
    await c.syncNow();
    // the held responses (A's) really were delivered
    expect(fake.log.filter((l) => l.path.includes('/issues?') && l.auth === `Bearer ${FAKE_TOKEN}` && l.status === 200).length).toBeGreaterThanOrEqual(2);
    expect(leaks).toEqual([]);
    expect(c.getState().viewer).toBe('user-2');
    expect(c.getBoardData().items).toHaveLength(1);
    expect(cache.loadSnapshots().get(REPO_KEY)!.items).toHaveLength(1);
    expect(cache.getSetting('cacheOwner', null)).toBe('user-2');
  });
});

describe('sources removed while a round is in flight', () => {
  async function started() {
    const credentials = new FileStore(join(dir, 'cred'));
    await credentials.set(FAKE_TOKEN);
    const h = await make({ credentials });
    h.c.addSource(PROJECT_URL);
    h.c.addSource(REPO);
    await h.c.start();
    const release = fake.hold('/repos/GigleAI/cavil-loop/issues');
    const before = fake.log.filter((l) => l.path.includes('/issues?')).length;
    const inflight = h.c.syncNow();
    await requestsSeen('/issues?', before + 2);
    return { ...h, release, inflight };
  }

  it('removed → the finished old request does not bring it back (database, memory, status)', async () => {
    const { c, cache, release, inflight } = await started();
    c.removeSource(REPO_KEY);
    await c.settled();
    expect(cache.loadSnapshots().has(REPO_KEY)).toBe(false);
    release();
    await inflight;
    expect(fake.log.filter((l) => l.path.includes('/issues?') && l.status === 200).length).toBeGreaterThanOrEqual(2);
    expect(cache.loadSnapshots().has(REPO_KEY)).toBe(false);
    expect(c.getState().sync.sources.map((s) => s.sourceKey)).not.toContain(REPO_KEY);
    expect(c.getBoardData().items.every((i) => !i.sources.includes(REPO_KEY))).toBe(true);
    // the other source of the same round did land
    expect(cache.loadSnapshots().has('project:org/gigleai/11')).toBe(true);
  });

  it('removed and added again → the old request is not taken for the new addition', async () => {
    const { c, cache, release, inflight } = await started();
    c.removeSource(REPO_KEY);
    expect(c.addSource(REPO).ok).toBe(true);
    // the round queued by the re-add cannot read the repo: only the stale answer could fill it
    fake.state.failRepoPage.set('gigleai/cavil-loop', 1);
    release();
    await inflight;
    expect(cache.loadSnapshots().has(REPO_KEY)).toBe(false);
    const st = c.getState().sync.sources.find((s) => s.sourceKey === REPO_KEY)!;
    expect(st).toMatchObject({ ok: false, dataFrom: null });
    expect(fake.log.filter((l) => l.path.includes('/issues?') && l.status === 502).length).toBeGreaterThan(0);
  });
});

// ---- review round 2 (PR #140): cancel / sign out / newer login while the credential is being saved ----

/** A credential store whose writes wait for the test to release them (like a slow keychain prompt). */
class SlowStore extends FileStore {
  writes: { token: string; release: () => void }[] = [];
  async set(token: string): Promise<void> {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.writes.push({ token, release });
    await gate;
    await super.set(token);
  }
}

const TOKEN_A2 = 'gho_faketokenA20000000000000000000003';

async function untilWrites(store: SlowStore, n: number) {
  for (let i = 0; i < 400; i++) {
    if (store.writes.length >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`credential store never saw ${n} writes`);
}

describe('signing in is all-or-nothing against cancel / sign-out / a newer login', () => {
  async function approvedAndSaving() {
    const store = new SlowStore(join(dir, 'cred'));
    const h = await make({ credentials: store });
    h.c.setClientId(fake.state.oauthClientId);
    h.c.addSource(REPO);
    await h.c.start();
    fake.state.nextGrant = { token: FAKE_TOKEN };
    const login = h.c.startLogin();
    await until(h.c, (s) => s.login.status === 'waiting', 'waiting');
    fake.resolveGrant('approved');
    await untilWrites(store, 1); // GitHub handed out the token, the save is in progress
    return { ...h, store, login };
  }

  async function assertSignedOutEverywhere(c: Controller, store: SlowStore) {
    expect(c.getState().phase).toBe('login');
    expect(await store.get()).toBeNull();
    const before = fake.log.length;
    await c.syncNow();
    expect(fake.log.length).toBe(before); // holds no token: nothing is synced
    expect(c.getBoardData().items).toHaveLength(0);
    const restarted = await make({ credentials: store });
    await restarted.c.start();
    expect(restarted.c.getState().phase).toBe('login');
  }

  it('cancel while saving → nothing kept: login page, no credential, no sync, restart asks to sign in', async () => {
    const { c, store, login } = await approvedAndSaving();
    c.cancelLogin();
    store.writes[0].release();
    await login;
    // "something did happen": the write really reached the store before it was undone
    expect(store.writes.map((w) => w.token)).toEqual([FAKE_TOKEN]);
    expect(c.getState().login.status).toBe('idle');
    await assertSignedOutEverywhere(c, store);
  });

  it('sign out while saving → same: nothing kept', async () => {
    const { c, store, login } = await approvedAndSaving();
    const out = c.logout();
    store.writes[0].release();
    await login;
    await out;
    expect(store.writes).toHaveLength(1);
    await assertSignedOutEverywhere(c, store);
  });

  it('an older login finishing its save after a newer login neither survives nor deletes the newer one', async () => {
    const { c, store, login } = await approvedAndSaving();
    c.cancelLogin();
    fake.state.tokenViewers.set(TOKEN_A2, 'user-2');
    fake.state.nextGrant = { token: TOKEN_A2 };
    const second = c.startLogin();
    await until(c, (s) => s.login.status === 'waiting', 'second waiting');
    fake.resolveGrant('approved');
    // the newer login has its token; its save queues behind the older, still-running one
    await new Promise((r) => setTimeout(r, 50));
    expect(store.writes).toHaveLength(1);
    store.writes[0].release(); // the older save completes now
    await login;
    await untilWrites(store, 2);
    store.writes[1].release();
    await second;
    expect(c.getState()).toMatchObject({ phase: 'ready', viewer: 'user-2' });
    expect(await store.get()).toBe(TOKEN_A2);
    const restarted = await make({ credentials: new FileStore(join(dir, 'cred')) });
    fake.state.validTokens.add(TOKEN_A2);
    await restarted.c.start();
    expect(restarted.c.getState()).toMatchObject({ phase: 'ready', viewer: 'user-2' });
  });
});
describe('sign-in method: OAuth app by default, GitHub App when chosen', () => {
  const OAUTH_BUILTIN = 'Ov23builtin000000000';

  it('defaults to the OAuth app; GitHub App has no built-in ID, so signing in says what to fill in and calls nothing', async () => {
    const { c } = await make({ defaultClientId: OAUTH_BUILTIN });
    await c.start();
    expect(c.getState()).toMatchObject({ appKind: 'oauth', clientId: OAUTH_BUILTIN, clientIdIsDefault: true });
    c.setAppKind('github-app');
    expect(c.getState()).toMatchObject({ appKind: 'github-app', clientId: '', clientIdIsDefault: true });
    await c.startLogin();
    expect(c.getState().login).toMatchObject({ status: 'error' });
    expect(c.getState().login.message).toContain('GitHub App');
    expect(fake.state.deviceClientIds).toEqual([]);
  });

  it('the chosen kind\'s Client ID is the one sent to GitHub; each kind keeps its own; the choice survives a restart', async () => {
    const { c } = await make({ defaultClientId: OAUTH_BUILTIN });
    await c.start();
    c.setAppKind('github-app');
    c.setClientId(fake.state.appClientId);
    expect(c.getState()).toMatchObject({ appKind: 'github-app', clientId: fake.state.appClientId, clientIdIsDefault: false });
    // the OAuth app's ID is untouched by it
    c.setAppKind('oauth');
    expect(c.getState()).toMatchObject({ appKind: 'oauth', clientId: OAUTH_BUILTIN, clientIdIsDefault: true });
    c.setAppKind('github-app');
    const p = c.startLogin();
    await until(c, (s) => s.login.status === 'waiting', 'waiting');
    expect(fake.state.deviceClientIds).toEqual([fake.state.appClientId]);
    fake.resolveGrant('approved');
    await p;
    expect(c.getState().phase).toBe('ready');
    c.stopTimer();
    const again = await make({ defaultClientId: OAUTH_BUILTIN });
    await again.c.start();
    expect(again.c.getState()).toMatchObject({ phase: 'ready', appKind: 'github-app', clientId: fake.state.appClientId });
  });

  it('switching back to the OAuth app sends the OAuth app\'s ID', async () => {
    const { c } = await make({ defaultClientId: fake.state.oauthClientId, defaultGithubAppClientId: fake.state.appClientId });
    await c.start();
    c.setAppKind('github-app');
    expect(c.getState()).toMatchObject({ clientId: fake.state.appClientId, clientIdIsDefault: true });
    c.setAppKind('oauth');
    const p = c.startLogin();
    await until(c, (s) => s.login.status === 'waiting', 'waiting');
    expect(fake.state.deviceClientIds).toEqual([fake.state.oauthClientId]);
    fake.resolveGrant('approved');
    await p;
    expect(c.getState().phase).toBe('ready');
  });

  it('an unknown kind is ignored', async () => {
    const { c } = await make({ defaultClientId: OAUTH_BUILTIN });
    c.setAppKind('something-else');
    expect(c.getState()).toMatchObject({ appKind: 'oauth', clientId: OAUTH_BUILTIN });
  });

  it('a preview build that saved a GitHub App ID in the single box: that user stays on GitHub App, the OAuth app goes back to built-in', async () => {
    const { c } = await make({ defaultClientId: OAUTH_BUILTIN, seed: { oauthClientId: 'Iv23liPreviewApp0000' } });
    expect(c.getState()).toMatchObject({ appKind: 'github-app', clientId: 'Iv23liPreviewApp0000', clientIdIsDefault: false });
    c.setAppKind('oauth');
    expect(c.getState()).toMatchObject({ clientId: OAUTH_BUILTIN, clientIdIsDefault: true });
  });

  it('a preview build that saved an OAuth app ID: stays on the OAuth app with it', async () => {
    const { c } = await make({ defaultClientId: OAUTH_BUILTIN, seed: { oauthClientId: 'Ov23liMyOwnApp000000' } });
    expect(c.getState()).toMatchObject({ appKind: 'oauth', clientId: 'Ov23liMyOwnApp000000', clientIdIsDefault: false });
  });

  it('a Client ID that does not match the chosen method is refused before anything is sent', async () => {
    const { c } = await make({ defaultClientId: fake.state.oauthClientId });
    await c.start();
    // GitHub App chosen, an OAuth app's ID filled in: would ask for repo while the page describes a GitHub App
    c.setAppKind('github-app');
    c.setClientId(fake.state.oauthClientId);
    await c.startLogin();
    expect(c.getState().login).toMatchObject({ status: 'error' });
    expect(c.getState().login.message).toContain('不是 GitHub App 的');
    // and the other way round
    c.setAppKind('oauth');
    c.setClientId(fake.state.appClientId);
    await c.startLogin();
    expect(c.getState().login.message).toContain('是 GitHub App 的');
    expect(fake.state.deviceClientIds).toEqual([]);
    // matched again → it goes through
    c.setClientId('');
    const p = c.startLogin();
    await until(c, (s) => s.login.status === 'waiting', 'waiting');
    expect(fake.state.deviceClientIds).toEqual([fake.state.oauthClientId]);
    fake.resolveGrant('approved');
    await p;
    expect(c.getState().phase).toBe('ready');
  });
});

describe('what the app says about the two methods', () => {
  it('never promises a GitHub App cannot touch code, never states a fixed lifetime, and says nothing reassuring for a mismatched ID', async () => {
    const { APP_KIND_FACTS, permissionText } = await import('../../src/shared/appKind');
    const all = [permissionText('github-app', 'Iv23liSomeApp0000000'), permissionText('oauth', 'Ov23liSomeApp0000000'), ...APP_KIND_FACTS.flatMap((r) => [r.oauth, r.app])].join('\n');
    expect(all).not.toMatch(/碰不到代码|看不到也改不了代码/);
    expect(all).not.toMatch(/最多 8 小时/);
    const expiry = APP_KIND_FACTS.find((r) => r.topic.includes('过期'))!;
    expect(expiry.oauth).toContain('看应用的设置'); // not an unconditional "never expires"
    expect(expiry.oauth).not.toMatch(/^不过期/);
    expect(expiry.app).toContain('看 App 的设置');
    // a GitHub App's permissions are the App's own: the text says so instead of listing a fixed set
    expect(permissionText('github-app', 'Iv23liSomeApp0000000')).toContain('授权页上列的才算数');
    // mismatched pair: no permission promise at all, only "fix it first"
    for (const [kind, id] of [['github-app', 'Ov23liSomeApp0000000'], ['oauth', 'Iv23liSomeApp0000000']] as const) {
      const t = permissionText(kind, id);
      expect(t).toContain('对不上');
      expect(t).not.toMatch(/repo|Issues|授权页/);
    }
  });
});
