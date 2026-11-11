// GigleAI/cavil-loop#374: once a source failed, the sync used to read it in full every minute —
// a big board's full read costs ~120 points of GitHub's 5000 an hour, so the retries alone used
// the quota up and every read then failed until the hour was over.
//   1. A read GitHub answers with a temporary failure (5xx, GraphQL "something went wrong") is
//      asked again on the spot (the same page), before the source counts as failed.
//   2. A source that keeps failing is read again after 1, 2, 4, 8, then every 10 minutes; one
//      good read and it is back to every round. The other sources are not held back.
//   3. Rate limited — whichever read hears it first (who am I, the board count, the change
//      check, a page of a full read): nothing more goes out until GitHub's reset time, in this
//      round or the next ones; then the reads go out again and work.
//   4. A refresh by hand waits for neither.
//   5. The ⚠ panel and the hover say how many failures, since when, the next try / the reset.
// Real controller, the real Rust back end as a child process, the fake GitHub over HTTP, real
// SQLite. Time is a clock the test moves (the controller's `now`).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller, type SyncTimers } from '../../src/app/controller';
import { RATE_LIMIT_MESSAGE } from '../../src/data/github';
import { clockAt, hoverLines, retryText, RETRY_BY_HAND } from '../../src/renderer/syncTimes';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, type CannedAnswer, type FakeGitHub, type LoggedRequest } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const PROJECT_KEY = 'project:org/gigleai/11';
const BOARD = 'org/gigleai/11';
const REPO = 'GigleAI/cavil-loop';
const REPO_KEY = 'repo:gigleai/cavil-loop';
const MIN = 60_000;

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

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

/** timers that never fire on their own (nothing here waits for a beat: each round is started by the test) */
const NO_TIMERS: SyncTimers = { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} };

async function boot(opts: { sources?: string[]; retryDelaysMs?: number[] } = {}) {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const clock = { t: FIXTURE_NOW };
  const endpoints = { api: fake.api, web: fake.web };
  const harness = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: () => clock.t, sleep: async () => {} });
  backends.push(harness);
  const c = await Controller.create({
    backend: harness,
    endpoints,
    now: () => clock.t,
    timers: NO_TIMERS,
    defaultClientId: '',
    followUpSyncMs: 600_000,
    // the waits before asking a failed page again: real ones would only make the test slow
    readRetryDelaysMs: opts.retryDelaysMs ?? [0, 0],
  });
  controllers.push(c);
  for (const s of opts.sources ?? [PROJECT_URL, REPO]) c.addSource(s);
  await c.start();
  expect(c.getState().phase).toBe('ready');
  expect(c.getState().sync.sources.every((s) => s.ok)).toBe(true);
  /** one automatic round at `min` minutes after the start; returns what it sent */
  const at = async (min: number) => {
    clock.t = FIXTURE_NOW + min * MIN;
    const n = fake.log.length;
    await c.syncNow();
    return fake.log.slice(n);
  };
  return { c, clock, at };
}

const isBoardPage = (e: LoggedRequest) => e.operation === 'CavilProjectItems';
const boardReads = (l: LoggedRequest[]) => l.filter((e) => isBoardPage(e) && (e.variables?.after ?? null) === null).length;
const isRepoList = (e: LoggedRequest) => e.method === 'GET' && e.path.startsWith('/api/repos/GigleAI/cavil-loop/issues?') && e.path.includes('state=open');
const repoReads = (l: LoggedRequest[]) => l.filter((e) => isRepoList(e) && !/[?&]page=/.test(e.path)).length;
const fullReads = (l: LoggedRequest[]) => boardReads(l) + repoReads(l);
const status = (c: Controller, key: string) => c.getState().sync.sources.find((s) => s.sourceKey === key)!;
const label = (k: string) => (k === PROJECT_KEY ? '看板' : '仓库');

/** GitHub's primary rate limit, as its REST API says it (the reset is in seconds) */
function limited(resetAt: number, status = 403): CannedAnswer {
  return {
    status,
    body: { message: 'API rate limit exceeded for user ID 1.', documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api' },
    headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt / 1000) },
  };
}
/** … and as its GraphQL API says it (HTTP 200, an error of type RATE_LIMITED) */
function limitedGraphql(resetAt: number): CannedAnswer {
  return {
    status: 200,
    body: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' }] },
    headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt / 1000) },
  };
}
/** a reset time GitHub could send: whole seconds, `min` minutes from the clock */
const resetIn = (clock: { t: number }, min: number) => Math.ceil((clock.t + min * MIN) / 1000) * 1000;

// ---------------------------------------------------------------------------

describe('a temporary failure is asked again on the spot', () => {
  it('page 2 of the board answers 502 once: the round still reads the board, with one extra request for that page only', async () => {
    const { c, at } = await boot({ sources: [PROJECT_URL] });
    let broken = 0;
    fake.state.answerOverride = (e) => (isBoardPage(e) && e.variables?.after && broken++ === 0 ? { status: 502, body: { message: 'Server Error' } } : null);
    // a round that reads the board in full (by hand: no "nothing changed")
    const n = fake.log.length;
    await c.restartSync();
    const sent = fake.log.slice(n);
    const pages = sent.filter(isBoardPage);
    expect(broken).toBeGreaterThan(1); // it did break once, and was asked again
    expect(pages.filter((e) => e.status === 502)).toHaveLength(1);
    expect(pages.filter((e) => e.variables?.after === pages.find((p) => p.status === 502)!.variables?.after)).toHaveLength(2);
    expect(pages.filter((e) => (e.variables?.after ?? null) === null)).toHaveLength(1); // page 1 was not read again
    expect(status(c, PROJECT_KEY)).toMatchObject({ ok: true });
    expect(status(c, PROJECT_KEY).retry).toBeUndefined();
    void at;
  });

  it('GraphQL "Something went wrong" is asked again too; a missing board is not (it would only fail again)', async () => {
    const { c } = await boot({ sources: [PROJECT_URL] });
    let broken = 0;
    fake.state.answerOverride = (e) =>
      isBoardPage(e) && broken++ === 0 ? { status: 200, body: { errors: [{ message: 'Something went wrong while executing your query. Please include `ABC` when reporting this issue.' }] } } : null;
    await c.restartSync();
    expect(broken).toBeGreaterThan(1);
    expect(status(c, PROJECT_KEY).ok).toBe(true);

    fake.state.answerOverride = null;
    c.addSource('https://github.com/orgs/GigleAI/projects/98');
    await c.settled();
    const n = fake.log.length;
    await c.restartSync();
    const of98 = fake.log.slice(n).filter((e) => isBoardPage(e) && e.variables?.number === 98);
    expect(of98).toHaveLength(1);
    expect(status(c, 'project:org/gigleai/98')).toMatchObject({ ok: false });
  });

  it('a 502 every time: three tries, then the source fails (and keeps what it showed)', async () => {
    const { c } = await boot({ sources: [PROJECT_URL] });
    const shown = c.getBoardData().items.length;
    fake.state.failProjectPage.set(BOARD, 1);
    const n = fake.log.length;
    await c.restartSync();
    const failed = fake.log.slice(n).filter((e) => isBoardPage(e) && e.status === 502);
    expect(failed).toHaveLength(3);
    expect(status(c, PROJECT_KEY)).toMatchObject({ ok: false });
    expect(c.getBoardData().items.length).toBe(shown);
  });
});

describe('a source that keeps failing waits longer each time', () => {
  it('1, 2, 4, 8, 10, 10 minutes between full reads of the failing board; the repository is checked every round; one good read resets it', async () => {
    const { c, at } = await boot();
    fake.state.failProjectPage.set(BOARD, 1);
    const readAt: number[] = [];
    let viewer = 0;
    let repoChecks = 0;
    for (let min = 1; min <= 36; min++) {
      const sent = await at(min);
      if (boardReads(sent)) readAt.push(min);
      viewer += sent.filter((e) => e.operation === 'CavilViewer').length;
      repoChecks += sent.filter((e) => e.method === 'HEAD' || isRepoList(e)).length > 0 ? 1 : 0;
    }
    // failed at 1 → next at 2 (+1) → 4 (+2) → 8 (+4) → 16 (+8) → 26 (+10) → 36 (+10)
    expect(readAt).toEqual([1, 2, 4, 8, 16, 26, 36]);
    // every round still ran, and the repository was looked at in each of them
    expect(viewer).toBe(36);
    expect(repoChecks).toBe(36);
    expect(status(c, REPO_KEY)).toMatchObject({ ok: true });
    const st = status(c, PROJECT_KEY);
    expect(st).toMatchObject({ ok: false, retry: { count: 7, since: FIXTURE_NOW + MIN, nextAt: FIXTURE_NOW + 46 * MIN, limitedUntil: null } });

    // the words of the panel and the hover, two minutes later
    const now = FIXTURE_NOW + 38 * MIN;
    const line = `从 ${clockAt(FIXTURE_NOW + MIN)} 起连续失败 7 次 · 下次自动重试 ${clockAt(FIXTURE_NOW + 46 * MIN)}（失败越多隔得越久，最长 10 分钟）`;
    expect(retryText(st, now)).toBe(line);
    expect(hoverLines(c.getState().sync, label, now)).toContain(`看板：${line}`);
    expect(retryText(status(c, REPO_KEY), now)).toBeNull();
    expect(RETRY_BY_HAND).toContain('重新同步');

    // GitHub is fine again: the board is read at its next turn, then it is back to every round
    fake.state.failProjectPage.clear();
    expect(boardReads(await at(45))).toBe(0); // not its turn yet
    expect(boardReads(await at(46))).toBe(1);
    expect(status(c, PROJECT_KEY)).toMatchObject({ ok: true });
    expect(status(c, PROJECT_KEY).retry).toBeUndefined();
    // and a new failure starts again at 1 minute
    fake.state.failProjectPage.set(BOARD, 1);
    await c.restartSync(); // a full read (a check would say "nothing changed")
    expect(status(c, PROJECT_KEY).retry).toMatchObject({ count: 1, nextAt: FIXTURE_NOW + 47 * MIN });
  });

  it('a refresh by hand reads the waiting board at once', async () => {
    const { c, at } = await boot();
    fake.state.failProjectPage.set(BOARD, 1);
    await at(1);
    await at(2); // second failure: next at 4
    expect(boardReads(await at(3))).toBe(0);
    fake.state.failProjectPage.clear();
    const n = fake.log.length;
    await c.restartSync();
    expect(boardReads(fake.log.slice(n))).toBe(1);
    expect(status(c, PROJECT_KEY)).toMatchObject({ ok: true });
  });

  it('an offline round does not count as a failure of the board', async () => {
    const { c, at } = await boot();
    fake.state.failProjectPage.set(BOARD, 1);
    await at(1);
    fake.state.offline = true;
    await at(2);
    await at(3);
    expect(c.getState().sync.offline).toBe(true);
    fake.state.offline = false;
    expect(boardReads(await at(4))).toBe(1); // still its first wait (1 minute): read
    expect(status(c, PROJECT_KEY).retry).toMatchObject({ count: 2 });
  });

  it('removed and added again: the new addition is read at once', async () => {
    const { c, at } = await boot();
    fake.state.failProjectPage.set(BOARD, 1);
    await at(1);
    await at(2); // next at 4
    expect(boardReads(await at(3))).toBe(0); // waiting
    fake.state.failProjectPage.clear();
    const n = fake.log.length;
    c.removeSource(PROJECT_KEY);
    c.addSource(PROJECT_URL); // adding starts a round of its own
    await c.settled();
    await c.syncNow();
    expect(boardReads(fake.log.slice(n))).toBe(1);
    expect(status(c, PROJECT_KEY).ok).toBe(true);
    expect(status(c, PROJECT_KEY).retry).toBeUndefined();
  });
});

describe('rate limited: nothing more goes out until the reset, then the reads work again', () => {
  /** after the limit: rounds before the reset send nothing; a round after it reads, and the ⚠ is gone */
  async function holdsUntilReset(c: Controller, at: (min: number) => Promise<LoggedRequest[]>, from: number, reset: number, keys = [PROJECT_KEY, REPO_KEY]) {
    for (const key of keys) {
      expect(status(c, key)).toMatchObject({ ok: false, rateLimited: true, error: RATE_LIMIT_MESSAGE, retry: { limitedUntil: reset, nextAt: reset } });
    }
    const resetMin = (reset - FIXTURE_NOW) / MIN;
    const lastOnline = c.getState().sync.lastOnlineAt;
    for (let min = from + 1; min < resetMin; min++) expect(await at(min)).toEqual([]);
    // "nothing went out" is not "connected"
    expect(c.getState().sync.lastOnlineAt).toBe(lastOnline);
    const text = retryText(status(c, PROJECT_KEY), FIXTURE_NOW + from * MIN);
    expect(text).toBe(`额度约 ${clockAt(reset)} 恢复，到时自动重读；在那之前不再发读取请求`);
    expect(hoverLines(c.getState().sync, label, FIXTURE_NOW + from * MIN)).toContain(`看板：${text}`);
    // the reset: the reads go out again, and work
    const sent = await at(Math.ceil(resetMin));
    expect(sent.length).toBeGreaterThan(0);
    expect(c.getState().sync.sources.every((s) => s.ok)).toBe(true);
    expect(c.getState().sync.sources.every((s) => s.retry === undefined)).toBe(true);
  }

  it('"who am I" is limited first: not one more request this round', async () => {
    const { c, clock, at } = await boot();
    clock.t = FIXTURE_NOW + MIN;
    const reset = resetIn(clock, 30);
    fake.state.answerOverride = (e) => (e.operation === 'CavilViewer' ? limitedGraphql(reset) : null);
    const sent = await at(1);
    expect(sent.map((e) => e.operation)).toEqual(['CavilViewer']);
    fake.state.answerOverride = null;
    await holdsUntilReset(c, at, 1, reset);
  });

  it('the board count is limited first (who am I answered): no full read, no change check after it', async () => {
    const { c, clock, at } = await boot();
    clock.t = FIXTURE_NOW + MIN;
    const reset = resetIn(clock, 20);
    fake.state.answerOverride = (e) => (e.operation === 'CavilProjectCounts' ? limitedGraphql(reset) : null);
    const sent = await at(1);
    expect(sent.map((e) => e.operation ?? e.path)).toEqual(['CavilViewer', 'CavilProjectCounts']);
    fake.state.answerOverride = null;
    await holdsUntilReset(c, at, 1, reset);
  });

  it('the change check is limited first: no full read of either source after it', async () => {
    const { c, clock, at } = await boot();
    clock.t = FIXTURE_NOW + MIN;
    const reset = resetIn(clock, 15);
    let hits = 0;
    fake.state.answerOverride = (e) => (/\/projectsV2\/11\/fields/.test(e.path) && hits++ === 0 ? limited(reset) : null);
    const sent = await at(1);
    expect(hits).toBe(1); // the limit was heard, and the request was not asked again
    expect(sent.some((e) => /\/projectsV2\/11\/fields/.test(e.path) && e.status === 403)).toBe(true);
    expect(fullReads(sent)).toBe(0);
    // the repository's own check may have been answered before the limit ("nothing changed" is a good answer)
    const repo = status(c, REPO_KEY);
    expect(repo.ok || repo.rateLimited).toBe(true);
    await holdsUntilReset(c, at, 1, reset, [PROJECT_KEY]);
  });

  it('page 2 of a full read is limited while the repository read is already on its way: that answer still lands, nothing else goes out, the board keeps its old data', async () => {
    const { c, clock } = await boot();
    clock.t = FIXTURE_NOW + MIN;
    const reset = resetIn(clock, 10);
    const boardFrom = c.getState().sync.times.find((t) => t.sourceKey === PROJECT_KEY)!.readAt;
    // the repository's first list page is held at GitHub until the board heard the limit
    let release: () => void = () => {};
    let limitHeard!: () => void;
    const heard = new Promise<void>((r) => (limitHeard = r));
    release = fake.holdWhen((e) => isRepoList(e) && !/[?&]page=/.test(e.path));
    fake.state.answerOverride = (e) => {
      if (isBoardPage(e) && e.variables?.after) {
        setTimeout(limitHeard, 50);
        return limited(reset);
      }
      return null;
    };
    const round = c.restartSync(); // by hand: both read in full
    await heard;
    const before = fake.log.length;
    release();
    await round;
    const after = fake.log.slice(before);
    // nothing new went out once the limit was heard
    expect(after).toEqual([]);
    const repoPage = fake.log.filter((e) => isRepoList(e) && !/[?&]page=/.test(e.path)).at(-1)!;
    expect(repoPage.status).toBe(200); // the request on its way was answered
    expect(status(c, PROJECT_KEY)).toMatchObject({ ok: false, rateLimited: true });
    expect(c.getState().sync.times.find((t) => t.sourceKey === PROJECT_KEY)!.readAt).toBe(boardFrom); // no half board
  });

  it('a limit that says no reset time: 1 minute, then 2 — never "forever"', async () => {
    const { c, at } = await boot({ sources: [REPO] });
    const noTime: CannedAnswer = { status: 403, body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' } };
    fake.state.answerOverride = () => noTime;
    await at(1);
    expect(status(c, REPO_KEY).retry).toMatchObject({ limitedUntil: FIXTURE_NOW + 2 * MIN });
    expect(await at(1.5)).toEqual([]);
    expect((await at(2)).length).toBeGreaterThan(0); // asked again at its time, limited again
    expect(status(c, REPO_KEY).retry).toMatchObject({ limitedUntil: FIXTURE_NOW + 4 * MIN });
    fake.state.answerOverride = null;
    expect(await at(3)).toEqual([]);
    await at(4);
    expect(status(c, REPO_KEY)).toMatchObject({ ok: true });
  });

  it('a refresh by hand goes out during the limit; still limited → closed again, and the panel says so', async () => {
    const { c, clock, at } = await boot();
    clock.t = FIXTURE_NOW + MIN;
    const reset = resetIn(clock, 30);
    fake.state.answerOverride = (e) => (e.operation === 'CavilViewer' ? limitedGraphql(reset) : null);
    await at(1);
    expect(await at(2)).toEqual([]);
    clock.t = FIXTURE_NOW + 3 * MIN;
    let n = fake.log.length;
    await c.restartSync();
    expect(fake.log.slice(n).map((e) => e.operation)).toEqual(['CavilViewer']);
    expect(status(c, REPO_KEY)).toMatchObject({ rateLimited: true });
    // GitHub lets it through now: by hand reads at once
    fake.state.answerOverride = null;
    clock.t = FIXTURE_NOW + 4 * MIN;
    n = fake.log.length;
    await c.restartSync();
    expect(fullReads(fake.log.slice(n))).toBe(2);
    expect(c.getState().sync.sources.every((s) => s.ok)).toBe(true);
  });

  it('writes are not held back by the sync\'s limit (they say GitHub\'s own answer)', async () => {
    const { c, clock, at } = await boot();
    clock.t = FIXTURE_NOW + MIN;
    fake.state.answerOverride = (e) => (e.operation === 'CavilViewer' ? limitedGraphql(resetIn(clock, 30)) : null);
    await at(1);
    fake.state.answerOverride = null;
    const n = fake.log.length;
    const r = await c.act({ kind: 'addLabel', key: 'gigleai/cavil-loop#138', label: 'bug' });
    expect(fake.log.slice(n).some((e) => e.method === 'POST' && /\/labels$/.test(e.path))).toBe(true);
    expect(r.ok).toBe(true);
  });
});
