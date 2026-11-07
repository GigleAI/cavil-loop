// GigleAI/cavil-loop#217: refresh by hand while a round runs starts over.
//   - a round reading GitHub is dropped: nothing it read lands (screen, cache),
//     it sends no further page, and a new round starts without waiting for it;
//   - a round renewing the sign-in or saving what it read is not cut: it
//     finishes, then the new round starts right after;
//   - automatic calls (the timer) keep queueing, they never cut a round.
// Real controller, the real Rust back end as a child process, the fake GitHub
// over HTTP (responses held to stop a round half way), real SQLite.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import type { Backend } from '../../src/backend/backend';
import { startFakeGitHub, type FakeGitHub, type LoggedRequest } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';

const REPO = 'GigleAI/cavil-loop';
const REPO_KEY = 'repo:gigleai/cavil-loop';
/** recorded issue #139 (open): its title tells which round's read landed */
const ISSUE = 139;
const K = (n: number) => `gigleai/cavil-loop#${n}`;

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

beforeEach(async () => {
  fake = await startFakeGitHub();
  // a repository source reads its open issues in several pages: a dropped round could go on to the next
  fake.state.restPageSize = 5;
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

/** a gate a test opens by hand */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

async function ready(intercept?: (cmd: string, args: any, harness: HarnessBackend) => Promise<unknown> | undefined) {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const endpoints = { api: fake.api, web: fake.web };
  const harness = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: () => FIXTURE_NOW, sleep: async () => {} });
  backends.push(harness);
  const backend: Backend = { call: async (cmd, args) => ((await intercept?.(cmd, args, harness)) as any) ?? harness.call(cmd, args) };
  const c = await Controller.create({ backend, endpoints, now: () => FIXTURE_NOW, defaultClientId: '', followUpSyncMs: 600_000 });
  controllers.push(c);
  c.addSource(REPO);
  await c.start();
  expect(c.getState().phase).toBe('ready');
  expect(titleOnBoard(c)).toBe(recordedTitle);
  return { c, cache };
}

let recordedTitle = '';
beforeEach(() => {
  issue().state = 'open';
  recordedTitle = issue().title;
});
const issue = () => fake.state.repos.get('gigleai/cavil-loop')!.find((r) => r.number === ISSUE)!;
const titleOnBoard = (c: Controller) => c.getBoardData().items.find((i) => i.key === K(ISSUE))?.title ?? null;
/** what the cache on disk holds for the issue (a fresh connection: what a restart would show) */
const titleInCache = () => {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  try {
    return cache.loadSnapshots().get(REPO_KEY)?.items.find((i) => i.key === K(ISSUE))?.title ?? null;
  } finally {
    cache.close();
  }
};

const isOpenList = (l: LoggedRequest) => l.method === 'GET' && l.path.startsWith('/api/repos/GigleAI/cavil-loop/issues?') && l.path.includes('state=open');
const isFirstPage = (l: LoggedRequest) => isOpenList(l) && !/[?&]page=/.test(l.path);
/** sync rounds that reached GitHub: each reads the open issues' first page once */
const rounds = () => fake.log.filter(isFirstPage).length;
/** open-issue pages after the first, across all rounds */
const laterPages = () => fake.log.filter((l) => isOpenList(l) && /[?&]page=\d/.test(l.path)).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, what: string, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(`timeout: ${what}`);
}
/** hold the next first page of the open-issue list (later ones go through) */
function holdNextRead(): () => void {
  let taken = false;
  return fake.holdWhen((e) => {
    if (taken || !isFirstPage(e)) return false;
    taken = true;
    return true;
  });
}
/** the held request reached the fake (its answer is written out only when released) */
const heldReached = (n: number) => () => rounds() >= n;

describe('refresh by hand while a round reads GitHub: drop it, start over at once', () => {
  it('the new round starts without the old one finishing; nothing the old one read lands, on screen or in the cache', async () => {
    const { c } = await ready();
    const before = rounds();
    const pagesPerRound = laterPages() / before;
    expect(pagesPerRound).toBeGreaterThanOrEqual(1); // the fixture does span several pages

    const release = holdNextRead();
    void c.syncNow(); // the timer's round
    await waitFor(heldReached(before + 1), 'round 1 reached GitHub');
    expect(c.getState().sync.syncing).toBe(true);
    // GitHub changes after round 1 read it: only round 2 can know
    issue().title = 'title read by the new round';

    // the restart's promise settles with the old round still held: it did not wait for it
    await c.restartSync();
    expect(rounds()).toBe(before + 2);
    expect(titleOnBoard(c)).toBe('title read by the new round');
    expect(titleInCache()).toBe('title read by the new round');
    expect(c.getState().sync.syncing).toBe(false);
    expect(c.getState().sync.problem).toBeNull();
    const pagesAfterNew = laterPages();

    // the old round's answer arrives late: thrown away, and it asks for no further page
    issue().title = 'title nobody should see';
    release();
    await sleep(500);
    expect(laterPages()).toBe(pagesAfterNew);
    expect(titleOnBoard(c)).toBe('title read by the new round');
    expect(titleInCache()).toBe('title read by the new round');
    expect(c.getState().sync.syncing).toBe(false);
    expect(c.getState().sync.problem).toBeNull();
    expect(c.getState().sync.sources.every((s) => s.ok)).toBe(true);
  });

  it('the old round has nothing left to ask for (one page): its late, complete read still lands nowhere', async () => {
    fake.state.restPageSize = 1000;
    const { c } = await ready();
    const before = rounds();
    expect(laterPages()).toBe(0); // one page per list: the held answer is the old round's last
    const release = holdNextRead();
    void c.syncNow();
    await waitFor(heldReached(before + 1), 'round 1 reached GitHub');
    issue().title = 'title read by the new round';
    await c.restartSync();
    expect(titleOnBoard(c)).toBe('title read by the new round');
    // the fake writes a held answer out when it is released: this is what the old round gets
    issue().title = 'title nobody should see';
    release();
    await sleep(500);
    expect(titleOnBoard(c)).toBe('title read by the new round');
    expect(titleInCache()).toBe('title read by the new round');
    expect(c.getState().sync.syncing).toBe(false);
  });

  it('three clicks in a row while a round reads: one new round, not three', async () => {
    const { c } = await ready();
    const before = rounds();
    const release = holdNextRead();
    void c.syncNow();
    await waitFor(heldReached(before + 1), 'round 1 reached GitHub');
    const p = [c.restartSync(), c.restartSync(), c.restartSync()];
    await Promise.all(p);
    expect(rounds()).toBe(before + 2);
    release();
    await sleep(300);
    expect(rounds()).toBe(before + 2);
    expect(c.getState().sync.syncing).toBe(false);
  });

  it('nothing running: a click syncs one round at once', async () => {
    const { c } = await ready();
    const before = rounds();
    issue().title = 'changed on GitHub';
    await c.restartSync();
    expect(rounds()).toBe(before + 1);
    expect(titleOnBoard(c)).toBe('changed on GitHub');
  });

  it('the timer during a round reading GitHub does not cut it: the round lands, one more follows', async () => {
    const { c } = await ready();
    const before = rounds();
    const release = holdNextRead();
    const first = c.syncNow();
    await waitFor(heldReached(before + 1), 'round 1 reached GitHub');
    void c.syncNow(); // the next tick, while round 1 is held
    await sleep(200);
    expect(rounds()).toBe(before + 1); // round 2 waits for round 1
    release();
    await first;
    expect(rounds()).toBe(before + 2);
    expect(c.getState().sync.syncing).toBe(false);
  });
});

describe('refresh by hand during the two stretches that are not cut', () => {
  it('renewing the sign-in: the renewal finishes, the new round starts right after, still signed in', async () => {
    let hold: ReturnType<typeof gate> | null = null;
    let reached = false;
    const { c } = await ready(async (cmd, args, harness) => {
      if (cmd !== 'ensureFresh' || !hold) return undefined;
      const g = hold;
      hold = null;
      reached = true;
      await g.opened;
      return harness.call(cmd, args);
    });
    const before = rounds();
    const g = gate();
    hold = g;
    void c.syncNow();
    await waitFor(() => reached, 'round 1 renewing');
    const restarted = c.restartSync();
    await sleep(200);
    expect(rounds()).toBe(before); // not cut: no new round went to GitHub meanwhile
    g.open();
    await restarted;
    expect(rounds()).toBe(before + 2); // round 1 ran on, then the restart's round
    expect(c.getState().phase).toBe('ready');
    expect(c.getState().sync.syncing).toBe(false);
  });

  it('saving what was read: the save finishes, the new round starts right after and its data is what stays', async () => {
    let hold: ReturnType<typeof gate> | null = null;
    let reached = false;
    let saves = 0;
    const { c } = await ready(async (cmd, args, harness) => {
      if (cmd !== 'replaceSnapshots') return undefined;
      saves++;
      if (!hold) return undefined;
      const g = hold;
      hold = null;
      reached = true;
      await g.opened;
      return harness.call(cmd, args);
    });
    const before = rounds();
    const savesBefore = saves;
    issue().title = 'read by round 1';
    const g = gate();
    hold = g;
    void c.syncNow();
    await waitFor(() => reached, 'round 1 saving');
    issue().title = 'read by round 2';
    const restarted = c.restartSync();
    await sleep(200);
    expect(rounds()).toBe(before + 1); // not cut: round 2 waits for the save
    g.open();
    await restarted;
    expect(rounds()).toBe(before + 2);
    expect(saves - savesBefore).toBe(2); // round 1's save was kept, round 2 saved after it
    expect(titleOnBoard(c)).toBe('read by round 2');
    expect(titleInCache()).toBe('read by round 2');
  });
});
