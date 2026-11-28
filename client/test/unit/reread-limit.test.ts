// GigleAI/cavil-loop#755: a refresh by hand reads GitHub for at most REREAD_READ_LIMIT_MS.
//   1. Reading stuck: at the limit the read stops — no further request, the answer not in is no longer
//      waited for — the source fails "stopped" (a network failure, not "given up on"), the refresh
//      (`reread`, what the buttons wait for) is answered, and no new round starts at once. A late answer lands nowhere.
//   2. Two sources: the one read in time lands (screen and cache), the slow one fails.
//   3. Saving what was read is never cut and never counted: the answer waits for it, however long.
//   4. A refresh asked for while an earlier round saves: it waits, and its limit starts only when its
//      own round starts reading. Renewing the sign-in before reading does not count either.
//   5. A timed round has no such limit.
//   6. Clicking again starts over with a fresh limit; the earlier click is answered at once.
//   7. Normal network: answered once the result is in, outcome ok.
//   8. (PR #757 review round 1) A round taken over before it read: no extra round after the stop — but one
//      another caller asked for meanwhile still runs. A wait before asking a failed read again ends at the
//      limit (and the retry still happens when there is time). A limit reached before GitHub said who the
//      account is gives the same "stopped" result as any other read it stopped.
// Real controller, the real Rust back end as a child process, the fake GitHub over HTTP, real SQLite.
// "Stuck" = one chosen call from the window to the back end is held (test/support/held.ts). Time is a
// clock the test moves: the limit is the real constant, 120 s on that clock.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { createController } from '../support/controller';
import { HoldingBackend, manualClock } from '../support/held';
import { REREAD_READ_LIMIT_MS } from '../../src/shared/config';
import { rereadOutcome } from '../../src/renderer/reread';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import { waitUntil } from '../support/wait';

const REPO = 'GigleAI/cavil-loop';
const REPO_KEY = 'repo:gigleai/cavil-loop';
const BOARD = 'https://github.com/orgs/GigleAI/projects/11';
const LIMIT_S = REREAD_READ_LIMIT_MS / 1000;

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];
let holds: HoldingBackend[] = [];

beforeEach(async () => {
  fake = await startFakeGitHub();
  // a repository source reads its open issues in several pages: the board is through before the repository
  fake.state.restPageSize = 5;
  fake.state.inbox.threads = [];
  fake.state.inbox.comments.clear();
  dir = tempDir();
});
afterEach(async () => {
  for (const c of controllers) c.stopTimer();
  for (const h of holds) h.releaseAll();
  holds = [];
  await Promise.all(backends.map((b) => b.close()));
  for (const c of caches) c.close();
  caches = [];
  controllers = [];
  backends = [];
  await fake.close();
});

async function boot(opts: { board?: boolean; retry?: { delaysMs: number[]; sleep: (ms: number) => Promise<void> } } = {}) {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const clock = manualClock(FIXTURE_NOW);
  const endpoints = { api: fake.api, web: fake.web };
  const harness = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: clock.now, sleep: async () => {} });
  backends.push(harness);
  const backend = new HoldingBackend(harness);
  holds.push(backend);
  const c = await createController({
    backend,
    endpoints,
    now: clock.now,
    timers: clock.timers,
    defaultClientId: '',
    followUpSyncMs: 600_000,
    readRetryDelaysMs: opts.retry?.delaysMs ?? [0, 0],
    ...(opts.retry ? { readRetrySleep: opts.retry.sleep } : {}),
    // every round reads in full: rounds are counted by full reads
    fullReadEveryMs: 0,
  });
  controllers.push(c);
  c.addSource(REPO);
  if (opts.board) c.addSource(BOARD);
  await c.start();
  expect(c.getState().phase).toBe('ready');
  expect(c.getState().sync.sources.every((s) => s.ok)).toBe(true);
  return { c, clock, backend };
}

const isFirstPage = (path: string) => path.startsWith('/api/repos/GigleAI/cavil-loop/issues?') && path.includes('state=open') && !/[?&]page=/.test(path);
/** rounds that reached GitHub's repository list (each reads its first page once) */
const rounds = () => fake.log.filter((l) => l.method === 'GET' && isFirstPage(l.path)).length;
const isRepoRead = (cmd: string, args?: Record<string, unknown>) => cmd === 'request' && isFirstPage(String(args?.url ?? '').replace(fake.api, '/api'));
const syncing = (c: Controller) => (c as any).syncing !== null;
const idle = (c: Controller) => () => !syncing(c) && !c.getState().sync.syncing;
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** a few real milliseconds for answers in flight to come back (the clock does not move) */
const breathe = () => sleepMs(30);
/** a request of the repository source made once the board source of a refresh by hand is through */
const afterBoard = (c: Controller) => (cmd: string, args?: Record<string, unknown>) =>
  cmd === 'request' && String(args?.url ?? '').includes('/repos/GigleAI/cavil-loop/') && c.getState().sync.manual?.claimed === true && (c.getState().sync.progress?.done ?? 0) >= 1;
const repoStatus = (c: Controller) => c.getState().sync.sources.find((s) => s.sourceKey === REPO_KEY)!;
const boardStatus = (c: Controller) => c.getState().sync.sources.find((s) => s.sourceKey !== REPO_KEY)!;
/** a promise's state, without waiting for it */
function track(p: Promise<unknown>) {
  const s = { done: false };
  void p.then(() => (s.done = true));
  return s;
}
/** what the cache on disk holds for a source (a fresh connection: what a restart would show) */
function fetchedInCache(key: string): number | null {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  try {
    return cache.loadSnapshots().get(key)?.fetchedAt ?? null;
  } finally {
    cache.close();
  }
}

describe('a refresh by hand whose read is stuck', () => {
  it('stops at the limit: the source fails "stopped", the refresh is answered, no new round starts; the late answer lands nowhere', async () => {
    const { c, clock, backend } = await boot();
    const before = rounds();
    const dataBefore = repoStatus(c).dataFrom;
    backend.hold(isRepoRead);
    const answered = track(c.reread());
    await waitUntil(() => backend.held() === 1, 'the read is held');
    expect(c.getState().sync.manual).toEqual({ claimed: true, step: 'read' });

    clock.by(LIMIT_S - 1);
    await breathe();
    expect(answered.done).toBe(false); // one second short: still reading
    expect(syncing(c)).toBe(true);

    clock.by(1);
    await waitUntil(() => answered.done, 'the refresh is answered at the limit');
    const st = repoStatus(c);
    expect(st.ok).toBe(false);
    expect(st.stopped).toBe(true);
    expect(st.failure?.kind).toBe('network'); // a failure of this round, not "given up on"
    expect(st.error).toBe('重新读取时读 GitHub 满 2 分钟没读完，已停下');
    expect(st.dataFrom).toBe(dataBefore); // the old data stays
    expect(rereadOutcome(c.getState())).toEqual({ kind: 'stopped', keys: [REPO_KEY], others: 0 });
    await waitUntil(idle(c), 'the round ends');
    expect(c.getState().sync.manual ?? null).toBeNull();
    // no new round started by itself
    expect(rounds()).toBe(before);

    // the held read now goes on, GitHub holding another title: it reaches GitHub and lands nowhere
    const issue = fake.state.repos.get('gigleai/cavil-loop')!.find((r: any) => r.state === 'open')!;
    issue.title = 'changed after the stop';
    backend.releaseAll();
    await waitUntil(() => rounds() === before + 1, 'the late read reached GitHub');
    await sleepMs(200);
    expect(c.getBoardData().items.find((i) => i.number === issue.number)!.title).not.toBe('changed after the stop');
    expect(repoStatus(c).stopped).toBe(true);
  });

  it('two sources: the one read in time lands on screen and on disk, the slow one fails', async () => {
    const { c, clock, backend } = await boot({ board: true });
    const boardKey = boardStatus(c).sourceKey;
    const boardBefore = boardStatus(c).dataFrom!;
    clock.by(5); // the board's new read carries a later time
    // the sync's requests go out one at a time: the repository's read is held once the board is read
    backend.hold(afterBoard(c));
    const answered = track(c.reread());
    await waitUntil(() => backend.held() === 1, 'the repository read is held, the board read');
    expect(c.getState().sync.progress?.done).toBe(1);
    clock.by(LIMIT_S);
    await waitUntil(() => answered.done, 'answered at the limit');
    expect(boardStatus(c).ok).toBe(true);
    expect(boardStatus(c).dataFrom!).toBeGreaterThan(boardBefore);
    expect(fetchedInCache(boardKey)).toBe(boardStatus(c).dataFrom); // it did land in the cache
    expect(repoStatus(c).stopped).toBe(true);
    expect(rereadOutcome(c.getState())).toEqual({ kind: 'stopped', keys: [REPO_KEY], others: 0 });
  });
});

describe('the steps that are never cut are never counted', () => {
  it('saving what was read after the limit: not cut, waited for however long, then answered', async () => {
    const { c, clock, backend } = await boot({ board: true });
    const boardKey = boardStatus(c).sourceKey;
    clock.by(5);
    backend.hold(afterBoard(c));
    backend.hold((cmd) => cmd === 'replaceSnapshots');
    const answered = track(c.reread());
    await waitUntil(() => backend.held() === 1, 'the repository read is held, the board read');
    clock.by(LIMIT_S);
    await waitUntil(() => backend.held() === 2, 'the save is held');
    expect(c.getState().sync.manual).toEqual({ claimed: true, step: 'store' });
    clock.by(60); // a slow save: a minute more
    await breathe();
    expect(answered.done).toBe(false);
    // only the save goes on (the held read stays held: its answer is no longer waited for)
    backend.releaseOne(); // the oldest: the read (lands nowhere)
    backend.releaseOne(); // the save
    await waitUntil(() => answered.done, 'answered once the save is done');
    expect(fetchedInCache(boardKey)).toBe(boardStatus(c).dataFrom); // the save did complete
    expect(repoStatus(c).stopped).toBe(true);
  });

  it('asked for while an earlier round saves: it waits for that save, and its limit starts with its own read', async () => {
    const { c, clock, backend } = await boot();
    backend.hold((cmd) => cmd === 'replaceSnapshots');
    void c.syncNow(); // a timed round
    await waitUntil(() => backend.held() === 1, 'the earlier round saves');
    const answered = track(c.reread());
    expect(c.getState().sync.manual).toEqual({ claimed: false, step: 'store' });
    clock.by(3 * 60); // three minutes: the save is not cut, the refresh has not started reading
    await breathe();
    expect(answered.done).toBe(false);
    // the refresh's own read is held too
    backend.hold(isRepoRead);
    backend.releaseOne();
    await waitUntil(() => backend.held() === 1, "the refresh's own read is held");
    expect(c.getState().sync.manual).toEqual({ claimed: true, step: 'read' });
    clock.by(LIMIT_S - 1);
    await breathe();
    expect(answered.done).toBe(false); // the three minutes before did not count
    clock.by(1);
    await waitUntil(() => answered.done, 'answered at its own limit');
    expect(repoStatus(c).stopped).toBe(true);
  });

  it('renewing the sign-in before reading: not counted', async () => {
    const { c, clock, backend } = await boot();
    backend.hold((cmd) => cmd === 'ensureFresh');
    const answered = track(c.reread());
    await waitUntil(() => backend.held() === 1, 'the renewal is held');
    expect(c.getState().sync.manual).toEqual({ claimed: false, step: 'renew' });
    clock.by(25);
    backend.hold(isRepoRead);
    backend.releaseOne();
    await waitUntil(() => backend.held() === 1, 'the read is held');
    clock.by(LIMIT_S - 1);
    await breathe();
    expect(answered.done).toBe(false);
    clock.by(1);
    await waitUntil(() => answered.done, 'answered at the limit');
    expect(repoStatus(c).stopped).toBe(true);
  });
});

describe('only a refresh by hand has the limit', () => {
  it('a timed round stuck as long is not stopped', async () => {
    const { c, clock, backend } = await boot();
    backend.hold(isRepoRead);
    const round = track(c.syncNow());
    await waitUntil(() => backend.held() === 1, 'the read is held');
    expect(c.getState().sync.manual ?? null).toBeNull();
    clock.by(LIMIT_S * 2);
    await breathe();
    expect(round.done).toBe(false);
    expect(syncing(c)).toBe(true);
    backend.releaseAll();
    await waitUntil(() => round.done, 'the round ends once the read is answered');
    expect(repoStatus(c).ok).toBe(true);
    expect(repoStatus(c).stopped).toBeUndefined();
  });

  it('clicking again: the earlier click is answered at once, the new one has a fresh limit', async () => {
    const { c, clock, backend } = await boot();
    backend.hold(isRepoRead);
    const first = track(c.reread());
    await waitUntil(() => backend.held() === 1, 'the first read is held');
    clock.by(100);
    backend.hold(isRepoRead);
    const second = track(c.reread());
    await waitUntil(() => first.done, 'the earlier click is answered');
    await waitUntil(() => backend.held() === 2, 'the new read is held');
    clock.by(100); // 200 s after the first click, 100 s after the second
    await breathe();
    expect(second.done).toBe(false);
    clock.by(LIMIT_S - 100);
    await waitUntil(() => second.done, 'answered at its own limit');
    expect(repoStatus(c).stopped).toBe(true);
  });

  it('normal network: answered once the result is in; everything read; `restartSync` still waits for syncing to go idle', async () => {
    const { c } = await boot();
    const before = rounds();
    await c.reread();
    expect(rounds()).toBe(before + 1);
    expect(rereadOutcome(c.getState())).toEqual({ kind: 'ok' });
    expect(c.getState().sync.manual ?? null).toBeNull();
    await waitUntil(idle(c), 'idle');
    await c.restartSync();
    expect(syncing(c)).toBe(false);
    expect(rounds()).toBe(before + 2);
  });
});

describe('PR #757 review round 1', () => {
  it('problem 1: a round taken over while renewing the sign-in, then stopped: no round reads again by itself', async () => {
    const { c, clock, backend } = await boot();
    const before = rounds();
    backend.hold((cmd) => cmd === 'ensureFresh');
    void c.syncNow(); // a timed round
    await waitUntil(() => backend.held() === 1, 'the timed round renews');
    const answered = track(c.reread());
    expect(c.getState().sync.manual).toEqual({ claimed: false, step: 'renew' });
    backend.hold(isRepoRead);
    backend.releaseOne();
    await waitUntil(() => backend.held() === 1, 'the read is held');
    expect(c.getState().sync.manual).toEqual({ claimed: true, step: 'read' }); // the running round took it over
    clock.by(LIMIT_S);
    await waitUntil(() => answered.done, 'answered at the limit');
    await waitUntil(idle(c), 'syncing goes idle');
    await sleepMs(200);
    expect(rounds()).toBe(before); // nothing read again (the held read never reached GitHub)
    expect(repoStatus(c).stopped).toBe(true);
  });

  it('problem 1: the same, with another caller asking for a round meanwhile: that round does run', async () => {
    const { c, clock, backend } = await boot();
    const before = rounds();
    backend.hold((cmd) => cmd === 'ensureFresh');
    void c.syncNow();
    await waitUntil(() => backend.held() === 1, 'the timed round renews');
    const answered = track(c.reread());
    void c.syncNow(); // e.g. a change's follow-up asks for one more round
    backend.hold(isRepoRead);
    backend.releaseOne();
    await waitUntil(() => backend.held() === 1, 'the read is held');
    clock.by(LIMIT_S);
    await waitUntil(() => answered.done, 'answered at the limit');
    await waitUntil(() => rounds() === before + 1, 'the round the other caller asked for reads GitHub');
    await waitUntil(idle(c), 'syncing goes idle');
    expect(repoStatus(c).ok).toBe(true);
  });

  it('problem 2: waiting to ask a failed read again, the limit ends the wait at once', async () => {
    let waits = 0;
    const { c, clock } = await boot({ retry: { delaysMs: [3000], sleep: () => (waits++, new Promise<void>(() => {})) } });
    fake.state.failRepoPage.set('gigleai/cavil-loop', 1);
    const answered = track(c.reread());
    // (the repository's lists each fail and wait: at least one wait is under way)
    await waitUntil(() => waits >= 1, 'a read failed and waits to be asked again');
    clock.by(LIMIT_S - 1);
    await breathe();
    expect(answered.done).toBe(false);
    clock.by(1);
    await waitUntil(() => answered.done, 'answered at the limit, the wait never ending by itself');
    expect(repoStatus(c).stopped).toBe(true);
    expect(rereadOutcome(c.getState()).kind).toBe('stopped');
  });

  it('problem 2: with time left, the failed read is still asked again (and read)', async () => {
    let waits = 0;
    const { c } = await boot({
      retry: {
        delaysMs: [3000],
        sleep: async () => {
          waits++;
          fake.state.failRepoPage.delete('gigleai/cavil-loop'); // GitHub answers again
        },
      },
    });
    const before = rounds();
    fake.state.failRepoPage.set('gigleai/cavil-loop', 1);
    await c.reread();
    expect(waits).toBeGreaterThanOrEqual(1);
    expect(repoStatus(c).ok).toBe(true);
    expect(rounds()).toBe(before + 2); // the first page asked twice: refused (502), then asked again and read
  });

  it('problem 3: the limit reached before GitHub said who the account is: every source "stopped", the stopped result', async () => {
    const { c, clock, backend } = await boot({ board: true });
    backend.hold((cmd, args) => cmd === 'request' && /\/user(\?|$)/.test(String(args?.url ?? '')));
    const answered = track(c.reread());
    await waitUntil(() => backend.held() === 1, 'who-am-I is held');
    clock.by(LIMIT_S);
    await waitUntil(() => answered.done, 'answered at the limit');
    const sources = c.getState().sync.sources;
    expect(sources).toHaveLength(2);
    expect(sources.every((s) => !s.ok && s.stopped === true && s.failure?.kind === 'network')).toBe(true);
    expect(rereadOutcome(c.getState())).toEqual({ kind: 'stopped', keys: sources.map((s) => s.sourceKey), others: 0 });
  });
});
