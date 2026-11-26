// GigleAI/cavil-loop#726: a detail read that shows the item newer than the board's copy brings the
// board's copy up to it at once (one re-read of the item, the same one a change made here uses),
// instead of leaving the list / board on the old copy until the next sync round:
//   - changed on GitHub since the board read it → one item re-read, the board shows the new title / state / labels;
//   - not changed → no re-read (and the detail really was read);
//   - the board already holds something newer than the detail → no re-read, nothing goes back;
//   - the re-read fails → the board keeps what it has, no extra round, the detail is still shown;
//   - signed out while the detail was read → nothing is read again, nothing lands;
//   - an item only a tab holds → the tab's own copy follows;
//   - the panel's "is the detail current" check (shouldAutoRefresh) does not read the detail again after the catch-up.
// Real controller, the real Rust back end as a child process, the fake GitHub over HTTP, real SQLite.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { createController } from '../support/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, type FakeGitHub, type LoggedRequest } from '../fake-github/server';
import { findCopies } from '../fake-github/writes';
import { shouldAutoRefresh } from '../../src/renderer/autoRefresh';
import { newerThan } from '../../src/data/itemRefresh';
import type { Item } from '../../src/shared/types';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';

const REPO = 'GigleAI/cavil-loop';
const REPO_KEY = 'repo:gigleai/cavil-loop';
/** recorded issue #139 (open) */
const ISSUE = 139;
const K = (n: number) => `gigleai/cavil-loop#${n}`;

let fake: FakeGitHub;
let dir: string;
let clock: { t: number };
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
  clock = { t: FIXTURE_NOW };
  setIssue({ state: 'open', labels: [], title: 'old title' });
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

async function ready() {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  cache.close();
  await new FileStore(join(dir, 'cred')).set(FAKE_TOKEN);
  const endpoints = { api: fake.api, web: fake.web };
  const backend = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials: new FileStore(join(dir, 'cred')), now: () => clock.t, sleep: async () => {} });
  backends.push(backend);
  const c = await createController({ backend, endpoints, now: () => clock.t, defaultClientId: '', followUpSyncMs: 600_000, fullReadEveryMs: 0 });
  controllers.push(c);
  c.addSource(REPO);
  await c.start();
  await c.syncNow();
  expect(c.getState().phase).toBe('ready');
  return c;
}

/** change the issue on GitHub (every copy the fake holds), bumping its update time like GitHub does */
function setIssue(p: { state?: 'open' | 'closed'; labels?: string[]; title?: string }) {
  const c = findCopies(fake.state, REPO, ISSUE)!;
  clock.t += 1000;
  const when = new Date(clock.t).toISOString();
  for (const r of c.rest) {
    if (p.state) {
      r.state = p.state;
      r.state_reason = p.state === 'closed' ? 'completed' : null;
    }
    if (p.labels) r.labels = p.labels.map((name) => ({ name, color: 'ededed' }));
    if (p.title) r.title = p.title;
    r.updated_at = when;
  }
  for (const g of c.gql) {
    if (p.state) {
      g.state = p.state === 'open' ? 'OPEN' : 'CLOSED';
      g.stateReason = p.state === 'closed' ? 'COMPLETED' : null;
    }
    if (p.labels) g.labels = { nodes: p.labels.map((name) => ({ name, color: 'ededed' })) };
    if (p.title) g.title = p.title;
    g.updatedAt = when;
  }
  return when;
}

const of = (op: string) => (l: LoggedRequest) => l.operation === op && l.variables?.number === ISSUE;
const itemReads = () => fake.log.filter(of('CavilItemRefresh')).length;
const detailReads = () => fake.log.filter(of('CavilItemDetail')).length;
/** a sync round reads the repository's first page of open issues once */
const rounds = () => fake.log.filter((l) => l.method === 'GET' && l.path.startsWith('/api/repos/GigleAI/cavil-loop/issues?') && !l.path.includes('page=2')).length;
const boardItem = (c: Controller): Item | null => c.getBoardData().items.find((i) => i.key === K(ISSUE)) ?? null;

async function readDetail(c: Controller) {
  const d = await c.loadDetail(K(ISSUE));
  if (!d.ok) throw new Error(d.error);
  await c.detailCaughtUp();
  return d.detail;
}

describe('a detail newer than the board brings the board up to it', () => {
  it('changed on GitHub after the board read it: one item re-read, the board shows the new title, state and labels — before any round', async () => {
    const c = await ready();
    expect(boardItem(c)).toMatchObject({ title: 'old title', state: 'open', labels: [] });
    const when = setIssue({ title: 'new title', state: 'closed', labels: ['pending/human'] });
    const r0 = rounds();
    const detail = await readDetail(c);
    expect(detail).toMatchObject({ title: 'new title', state: 'closed', updatedAt: when });
    expect(itemReads()).toBe(1);
    expect(boardItem(c)).toMatchObject({ title: 'new title', state: 'closed', updatedAt: when });
    expect(boardItem(c)!.labels.map((l) => l.name)).toEqual(['pending/human']);
    expect(rounds()).toBe(r0);
    // read again with nothing new: the board already holds that version — no second re-read
    await readDetail(c);
    expect(detailReads()).toBe(2);
    expect(itemReads()).toBe(1);
  });

  it('not changed: the detail is read, the item is not read again', async () => {
    const c = await ready();
    const before = boardItem(c)!;
    const detail = await readDetail(c);
    expect(detailReads()).toBe(1);
    expect(detail.updatedAt).toBe(before.updatedAt);
    expect(itemReads()).toBe(0);
    expect(boardItem(c)).toEqual(before);
  });

  it('the board already holds a newer copy than the detail read: nothing is read again, nothing goes back', async () => {
    const c = await ready();
    // the detail's answer is taken now (old title), held until the board has read a newer change
    const release = fake.holdWhen(of('CavilItemDetail'));
    const reading = c.loadDetail(K(ISSUE));
    await new Promise<void>((go) => {
      const t = setInterval(() => detailReads() > 0 && (clearInterval(t), go()), 5);
    });
    const when = setIssue({ title: 'newer title' });
    await c.syncNow();
    expect(boardItem(c)).toMatchObject({ title: 'newer title', updatedAt: when });
    release();
    const d = await reading;
    expect(d.ok && d.detail.title).toBe('old title');
    await c.detailCaughtUp();
    expect(itemReads()).toBe(0);
    expect(boardItem(c)).toMatchObject({ title: 'newer title', updatedAt: when });
  });

  it('the re-read fails: the detail is shown, the board keeps its copy, no extra round is asked for', async () => {
    const c = await ready();
    setIssue({ title: 'new title' });
    fake.state.w.failRefresh.add(K(ISSUE));
    const r0 = rounds();
    const d = await c.loadDetail(K(ISSUE));
    expect(d).toMatchObject({ ok: true, detail: { title: 'new title' } });
    await c.detailCaughtUp();
    expect(itemReads()).toBe(1); // it was tried
    expect(boardItem(c)).toMatchObject({ title: 'old title' });
    expect(rounds()).toBe(r0);
    // the next round reads it anyway
    fake.state.w.failRefresh.clear();
    await c.syncNow();
    expect(rounds()).toBeGreaterThan(r0); // (the count does see a round)
    expect(boardItem(c)).toMatchObject({ title: 'new title' });
  });

  it('signed out while the detail was read: nothing is read again', async () => {
    const c = await ready();
    setIssue({ title: 'new title' });
    const release = fake.holdWhen(of('CavilItemDetail'));
    const reading = c.loadDetail(K(ISSUE));
    await new Promise<void>((go) => {
      const t = setInterval(() => detailReads() > 0 && (clearInterval(t), go()), 5);
    });
    await c.logout();
    release();
    expect((await reading).ok).toBe(false);
    await c.detailCaughtUp();
    expect(itemReads()).toBe(0);
  });

  it('an item only a tab holds (its source was removed): the tab\'s own copy follows', async () => {
    const c = await ready();
    expect(c.openTab(K(ISSUE))).toBe(true);
    c.removeSource(REPO_KEY);
    await c.checkTabsSettled();
    const reads = itemReads();
    const tabItem = () => c.getBoardData().tabItems?.find((i) => i.key === K(ISSUE)) ?? null;
    expect(tabItem()).toMatchObject({ title: 'old title' });
    const when = setIssue({ title: 'new title', state: 'closed' });
    await readDetail(c);
    expect(itemReads()).toBe(reads + 1);
    expect(tabItem()).toMatchObject({ title: 'new title', state: 'closed', updatedAt: when });
  });

  it('after the catch-up the panel does not read the detail again for the version it already shows', async () => {
    const c = await ready();
    const seen = boardItem(c)!.updatedAt; // what the panel knew when its read started
    setIssue({ title: 'new title' });
    const detail = await readDetail(c);
    // the panel records the detail's own version (falls back to `seen` only when the read had none)
    const readAt = detail.updatedAt ?? seen;
    expect(shouldAutoRefresh({ item: { updatedAt: boardItem(c)!.updatedAt }, readAt, detail, busy: false, loading: false })).toBe(false);
    // what the panel recorded before GitHub#726 would have asked for one more read here
    expect(shouldAutoRefresh({ item: { updatedAt: boardItem(c)!.updatedAt }, readAt: seen, detail, busy: false, loading: false })).toBe(true);
  });
});

describe('newerThan: only a provably later time', () => {
  it('later / same / earlier / unknown', () => {
    expect(newerThan('2026-11-26T05:00:01Z', '2026-11-26T05:00:00Z')).toBe(true);
    expect(newerThan('2026-11-26T05:00:00Z', '2026-11-26T05:00:00Z')).toBe(false);
    expect(newerThan('2026-11-26T05:00:00.000Z', '2026-11-26T05:00:00Z')).toBe(false);
    expect(newerThan('2026-11-26T04:59:59Z', '2026-11-26T05:00:00Z')).toBe(false);
    expect(newerThan(undefined, '2026-11-26T05:00:00Z')).toBe(false);
    expect(newerThan('2026-11-26T05:00:00Z', '')).toBe(false);
    expect(newerThan('not a time', '2026-11-26T05:00:00Z')).toBe(false);
  });
  it('the panel treats two spellings of one moment as the same version', () => {
    const detail = { state: 'open', pr: null } as any;
    expect(shouldAutoRefresh({ item: { updatedAt: '2026-11-26T05:00:00Z' }, readAt: '2026-11-26T05:00:00.000Z', detail, busy: false, loading: false })).toBe(false);
    expect(shouldAutoRefresh({ item: { updatedAt: '2026-11-26T05:00:01Z' }, readAt: '2026-11-26T05:00:00Z', detail, busy: false, loading: false })).toBe(true);
  });
});
