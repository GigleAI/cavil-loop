// GigleAI/cavil-loop#324.
//   1. Two times per source, never merged: 整份读取 (the read whose data is shown) and 上次检查
//      (the latest full read or "nothing changed" answer). A round that reached GitHub but read no
//      source moves neither; what the change check cannot see never moves the full-read time.
//   2. Timed rounds (the window's timer, the shell's beat): a stretch of syncing that ran over a
//      beat is followed by one beat of quiet, so a slow round is not followed by the next one at
//      once; a round that fits between two beats keeps the beat's pace. Rounds asked for by an
//      operation or by hand are not held back, and leave no late timed round.
// Real controller, the real Rust back end as a child process, the fake GitHub over HTTP (answers
// held to make a round last), real SQLite. Time is a clock the test moves: the controller's
// `now`, its beat and its alarm all run on it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller, type SyncTimers } from '../../src/app/controller';
import { FULL_READ_EVERY_MS } from '../../src/data/changeCheck';
import { headerText, hoverLines, offlineDataText } from '../../src/renderer/syncTimes';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, type FakeGitHub, type LoggedRequest } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const PROJECT_KEY = 'project:org/gigleai/11';
const BOARD = 'org/gigleai/11';
const REPO = 'GigleAI/cavil-loop';
const REPO_KEY = 'repo:gigleai/cavil-loop';
const MISSING_URL = 'https://github.com/orgs/GigleAI/projects/98';
const MISSING_KEY = 'project:org/gigleai/98';
const K = (n: number) => `gigleai/cavil-loop#${n}`;
const BEAT = 60_000;
const S = 1000;

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

/** A clock moved by hand, with the timers that run on it (in time order, each at its own moment). */
function manualClock(t0: number) {
  interface Job {
    id: number;
    at: number;
    fn: () => void;
    every: number | null;
  }
  let t = t0;
  let seq = 0;
  let jobs: Job[] = [];
  const counts = { beats: 0, alarms: 0 };
  const add = (fn: () => void, ms: number, every: number | null): Job => {
    const j = { id: ++seq, at: t + ms, fn, every };
    jobs.push(j);
    return j;
  };
  const drop = (h: unknown) => {
    jobs = jobs.filter((j) => j !== h);
  };
  const timers: SyncTimers = {
    setTimeout: (fn, ms) => add(fn, ms, null),
    clearTimeout: drop,
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearInterval: drop,
  };
  return {
    timers,
    now: () => t,
    /** seconds since the start */
    at: () => (t - t0) / S,
    /** beats (interval jobs) and alarms (timeouts) that fired so far: "it did arrive" */
    counts,
    /** alarms waiting */
    pending: () => jobs.filter((j) => j.every === null).length,
    /** move to `sec` seconds after the start, firing what is due on the way */
    to(sec: number) {
      const target = t0 + sec * S;
      for (;;) {
        const due = jobs.filter((j) => j.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        t = Math.max(t, due.at);
        if (due.every === null) {
          drop(due);
          counts.alarms++;
        } else {
          due.at += due.every;
          counts.beats++;
        }
        due.fn();
      }
      t = Math.max(t, target);
    },
  };
}
type Clock = ReturnType<typeof manualClock>;

type Entry = 'window' | 'shell';

interface Opts {
  sources?: string[];
  /** 0 = no change check: every round reads every source in full (rounds are counted by full reads) */
  fullReadEveryMs?: number;
  /** which of the two timed entries carries the beat; none = no beat */
  entry?: Entry;
  /** the first round's read is held; the caller releases it and awaits `started` */
  holdFirst?: boolean;
  /** the round after a successful change (real time; default: never within a test) */
  followUpSyncMs?: number;
}

async function boot(opts: Opts = {}) {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const clock = manualClock(FIXTURE_NOW);
  const endpoints = { api: fake.api, web: fake.web };
  const harness = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: clock.now, sleep: async () => {} });
  backends.push(harness);
  const c = await Controller.create({
    backend: harness,
    endpoints,
    now: clock.now,
    timers: clock.timers,
    syncIntervalMs: BEAT,
    defaultClientId: '',
    followUpSyncMs: opts.followUpSyncMs ?? 600_000,
    ...(opts.fullReadEveryMs !== undefined ? { fullReadEveryMs: opts.fullReadEveryMs } : {}),
  });
  controllers.push(c);
  for (const s of opts.sources ?? [REPO]) c.addSource(s);
  // the same beat through either entry: the window's own timer, or the shell's event (which says its interval)
  if (opts.entry === 'window') c.startTimer();
  if (opts.entry === 'shell') clock.timers.setInterval(() => c.onDesktopEvent({ kind: 'tick', everyMs: BEAT }), BEAT);
  const release = opts.holdFirst ? holdNextRead() : null;
  const started = c.start();
  if (!opts.holdFirst) {
    await started;
    expect(c.getState().phase).toBe('ready');
  }
  return { c, clock, harness, started, release: release ?? (() => {}) };
}

const isOpenList = (l: LoggedRequest) => l.method === 'GET' && l.path.startsWith('/api/repos/GigleAI/cavil-loop/issues?') && l.path.includes('state=open');
const isFirstPage = (l: LoggedRequest) => isOpenList(l) && !/[?&]page=/.test(l.path);
/** full reads of the repository source that reached GitHub (with the change check off: one per round) */
const rounds = () => fake.log.filter(isFirstPage).length;
/** rounds that reached GitHub at all: each asks who the account is once */
const viewerAsks = () => fake.log.filter((l) => l.operation === 'CavilViewer').length;
const boardReads = () => fake.log.filter((e) => e.operation === 'CavilProjectItems' && (e.variables?.after ?? null) === null).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, what: string, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(`timeout: ${what}`);
}
/** hold the next first page of the repository's open-issue list */
function holdNextRead(): () => void {
  let taken = false;
  return fake.holdWhen((e) => {
    if (taken || !isFirstPage(e)) return false;
    taken = true;
    return true;
  });
}
const idle = (c: Controller) => () => !c.getState().sync.syncing && (c as any).syncing === null;
/** nothing more starts: give a wrongly started round the time to reach GitHub */
async function settle(c: Controller) {
  await waitFor(idle(c), 'idle');
  await sleep(150);
  await waitFor(idle(c), 'idle');
}
const times = (c: Controller, key: string) => c.getState().sync.times.find((t) => t.sourceKey === key)!;
const onBoard = (c: Controller, n: number) => c.getBoardData().items.find((i) => i.key === K(n)) ?? null;

// ---------------------------------------------------------------------------

describe('two times per source: 整份读取 and 上次检查', () => {
  it('one source read in full, the other confirmed unchanged: the check moves for both, the full read only for the one read', async () => {
    const { c, clock } = await boot({ sources: [PROJECT_URL, REPO] });
    const t0 = clock.now();
    expect(times(c, PROJECT_KEY)).toEqual({ sourceKey: PROJECT_KEY, readAt: t0, checkedAt: t0 });
    expect(times(c, REPO_KEY)).toEqual({ sourceKey: REPO_KEY, readAt: t0, checkedAt: t0 });

    // two minutes on, somebody moves a card on the board: the board is read in full, the repository only checked
    clock.to(120);
    const node = fake.state.projects.get(BOARD)!.flatMap((p) => p.items.nodes).find((x: any) => x.content?.number === 22)!;
    node.fieldValues.nodes.find((f: any) => f.__typename === 'ProjectV2ItemFieldSingleSelectValue' && f.field?.name === 'Status').name = 'In progress';
    const reads = { board: boardReads(), repo: rounds() };
    await c.syncNow();
    expect(boardReads()).toBe(reads.board + 1); // it did read the board
    expect(rounds()).toBe(reads.repo); // and did not read the repository
    const t2 = clock.now();
    expect(times(c, PROJECT_KEY)).toEqual({ sourceKey: PROJECT_KEY, readAt: t2, checkedAt: t2 });
    expect(times(c, REPO_KEY)).toEqual({ sourceKey: REPO_KEY, readAt: t0, checkedAt: t2 });
    // board-wide: the oldest of each
    const sync = c.getState().sync;
    expect(sync.dataFrom).toBe(t0);
    expect(sync.checkedFrom).toBe(t2);

    // the words, three minutes later: header = the check, the bar = the full read, then the check
    const now = t2 + 3 * 60_000;
    expect(headerText(sync, now)).toBe('上次检查 3 分钟前');
    expect(offlineDataText(sync, now)).toBe('数据整份读取：5 分钟前；上次检查：3 分钟前');
    const hover = hoverLines(sync, (k) => (k === REPO_KEY ? '仓库' : '看板'), now);
    expect(hover).toContain('看板：整份读取 3 分钟前 · 上次检查 3 分钟前');
    expect(hover).toContain('仓库：整份读取 5 分钟前 · 上次检查 3 分钟前');
    expect(hover).toContain('最后连上 GitHub：3 分钟前');
    expect(hover.some((l) => l.includes('看不到') && l.includes('被删除'))).toBe(true);
  });

  it('what the check cannot see (an issue deleted): the check moves on, the full read does not — until the forced full read', async () => {
    const { c, clock } = await boot({ sources: [REPO] });
    const t0 = clock.now();
    const list = fake.state.repos.get('gigleai/cavil-loop')!;
    const oldest = [...list].filter((r) => r.state === 'open').sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1))[0];
    fake.state.repos.set('gigleai/cavil-loop', list.filter((r) => r !== oldest));

    clock.to(60);
    const before = rounds();
    await c.syncNow();
    expect(rounds()).toBe(before); // the check said "nothing changed": no full read
    expect(onBoard(c, oldest.number)).not.toBeNull(); // the deleted issue is still shown
    expect(times(c, REPO_KEY)).toEqual({ sourceKey: REPO_KEY, readAt: t0, checkedAt: clock.now() });
    // so nothing says the data was read less than a minute ago
    expect(c.getState().sync.dataFrom).toBe(t0);
    expect(offlineDataText(c.getState().sync, clock.now())).toBe('数据整份读取：1 分钟前；上次检查：不到 1 分钟前');

    clock.to(60 + FULL_READ_EVERY_MS / S);
    await c.syncNow();
    expect(rounds()).toBe(before + 1); // the forced full read
    expect(onBoard(c, oldest.number)).toBeNull();
    expect(times(c, REPO_KEY)).toEqual({ sourceKey: REPO_KEY, readAt: clock.now(), checkedAt: clock.now() });
  });

  it('GitHub answered but every source failed: neither time moves, though "connected" does', async () => {
    const { c, clock } = await boot({ sources: [REPO] });
    const t0 = clock.now();
    clock.to(60);
    await c.syncNow(); // confirmed unchanged
    const checked = clock.now();
    expect(times(c, REPO_KEY).checkedAt).toBe(checked);

    // the list fails from now on (the check cannot tell, the full read fails); "who is this" still answers
    fake.state.checkFault = () => ({ status: 502 });
    fake.state.failRepoPage.set('gigleai/cavil-loop', 1);
    clock.to(180);
    const asks = viewerAsks();
    await c.syncNow();
    expect(viewerAsks()).toBe(asks + 1); // the round did reach GitHub
    const sync = c.getState().sync;
    expect(sync.offline).toBe(false);
    expect(sync.sources.find((s) => s.sourceKey === REPO_KEY)!.ok).toBe(false);
    expect(sync.lastOnlineAt).toBe(clock.now()); // what the header used to show as "上次同步"
    expect(times(c, REPO_KEY)).toEqual({ sourceKey: REPO_KEY, readAt: t0, checkedAt: checked });
    expect(headerText(sync, clock.now())).toBe('上次检查 2 分钟前');

    // an offline round keeps them too
    fake.state.offline = true;
    clock.to(240);
    await c.syncNow();
    expect(c.getState().sync.offline).toBe(true);
    expect(times(c, REPO_KEY)).toEqual({ sourceKey: REPO_KEY, readAt: t0, checkedAt: checked });
    expect(offlineDataText(c.getState().sync, clock.now())).toBe('数据整份读取：4 分钟前；上次检查：3 分钟前');

    // back: the next good round moves the check again
    fake.state.offline = false;
    fake.state.checkFault = null;
    fake.state.failRepoPage.clear();
    clock.to(300);
    await c.syncNow();
    expect(times(c, REPO_KEY).checkedAt).toBe(clock.now());
  });

  it('a source never read has no times and does not hold the others back; with no data at all nothing is shown', async () => {
    const { c, clock } = await boot({ sources: [REPO, MISSING_URL] });
    const t0 = clock.now();
    expect(c.getState().sync.sources.find((s) => s.sourceKey === MISSING_KEY)!.ok).toBe(false); // it was tried
    expect(times(c, MISSING_KEY)).toEqual({ sourceKey: MISSING_KEY, readAt: null, checkedAt: null });
    expect(c.getState().sync.dataFrom).toBe(t0);
    expect(c.getState().sync.checkedFrom).toBe(t0);
    expect(hoverLines(c.getState().sync, (k) => k, t0)).toContain(`${MISSING_KEY}：还没有读到过`);

    c.removeSource(REPO_KEY);
    await settle(c);
    const sync = c.getState().sync;
    expect(sync.times).toEqual([{ sourceKey: MISSING_KEY, readAt: null, checkedAt: null }]);
    expect(sync.dataFrom).toBeNull();
    expect(sync.checkedFrom).toBeNull();
    expect(headerText(sync, t0)).toBeNull();
    expect(offlineDataText(sync, t0)).toBe('还没有同步过');
  });

  it('a source removed and added again, a restart, a sign-out: the check time does not outlive the data it was about', async () => {
    const { c, clock, harness } = await boot({ sources: [REPO] });
    const t0 = clock.now();
    clock.to(60);
    await c.syncNow();
    expect(times(c, REPO_KEY)).toEqual({ sourceKey: REPO_KEY, readAt: t0, checkedAt: clock.now() });

    // a restart: the check time is not stored — it is the stored read's time again (older, never newer)
    await c.settled();
    const again = await Controller.create({ backend: harness, endpoints: { api: fake.api, web: fake.web }, now: clock.now, timers: clock.timers, defaultClientId: '' });
    controllers.push(again);
    expect(times(again, REPO_KEY)).toEqual({ sourceKey: REPO_KEY, readAt: t0, checkedAt: t0 });

    // removed and added again two minutes later: read anew, both times are that read's
    clock.to(180);
    c.removeSource(REPO_KEY);
    expect(c.getState().sync.times).toEqual([]);
    const before = rounds();
    c.addSource(REPO);
    await waitFor(() => rounds() > before, 'the source added again is read');
    await settle(c);
    expect(times(c, REPO_KEY)).toEqual({ sourceKey: REPO_KEY, readAt: clock.now(), checkedAt: clock.now() });

    clock.to(240);
    await c.syncNow();
    expect(times(c, REPO_KEY).checkedAt).toBe(clock.now());
    await c.logout();
    expect(times(c, REPO_KEY)).toEqual({ sourceKey: REPO_KEY, readAt: null, checkedAt: null });
    expect(c.getState().sync.checkedFrom).toBeNull();
  });

  it('a round in progress says how far it is; it ends with the round', async () => {
    const { c, clock, started, release } = await boot({ sources: [PROJECT_URL, REPO], fullReadEveryMs: 0, holdFirst: true });
    await waitFor(() => rounds() === 1, 'the round reached GitHub');
    await waitFor(() => c.getState().sync.progress?.done === 1, 'the board is through, the repository is held');
    clock.to(75);
    const sync = c.getState().sync;
    expect(sync.progress).toEqual({ startedAt: FIXTURE_NOW, done: 1, total: 2 });
    expect(hoverLines(sync, (k) => k, clock.now())).toContain('同步中，已进行 1 分 15 秒，已读完 1 / 2 个来源');
    release();
    await started;
    expect(c.getState().sync.syncing).toBe(false);
    expect(c.getState().sync.progress).toBeNull();
    expect(hoverLines(c.getState().sync, (k) => k, clock.now()).some((l) => l.startsWith('同步中'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

/**
 * A slow first round, 0–90 s: the beat at 60 s came while it ran. Idle at 90 s, so the next timed
 * round may start at 150 s; the beat at 120 s is too early and sets the alarm. Returns at 120 s.
 */
async function waitingFor150(entry: Entry, opts: Opts = {}) {
  const h = await boot({ fullReadEveryMs: 0, entry, holdFirst: true, ...opts });
  await waitFor(() => rounds() === 1, 'round 1 reached GitHub');
  h.clock.to(60);
  expect(h.clock.counts.beats).toBe(1); // a beat while the round runs
  h.clock.to(90);
  h.release();
  await h.started;
  await settle(h.c);
  expect(rounds()).toBe(1); // no round was queued to run right behind it
  expect(h.c.getState().sync.syncing).toBe(false); // the button stopped spinning
  expect(h.clock.pending()).toBe(0);
  h.clock.to(120);
  expect(h.clock.counts.beats).toBe(2); // the beat did arrive
  await settle(h.c);
  expect(rounds()).toBe(1); // and started nothing
  expect(h.clock.pending()).toBe(1); // one alarm waits
  return h;
}

describe.each<Entry>(['window', 'shell'])('a stretch of syncing that ran over a beat is followed by one beat of quiet (the beat comes from: %s)', (entry) => {
  it('a 3-second round keeps the beat\'s own pace: the next rounds start with the beats at 60 s and 120 s, no alarm involved', async () => {
    const { c, clock, started, release } = await boot({ fullReadEveryMs: 0, entry, holdFirst: true });
    await waitFor(() => rounds() === 1, 'round 1 reached GitHub');
    clock.to(3);
    release();
    await started;
    await settle(c);
    clock.to(59.999);
    await settle(c);
    expect(rounds()).toBe(1);
    clock.to(60);
    expect(clock.counts.beats).toBe(1);
    await waitFor(() => rounds() === 2, 'the round at 60 s');
    await settle(c);
    expect(clock.pending()).toBe(0);
    clock.to(120);
    await waitFor(() => rounds() === 3, 'the round at 120 s');
    await settle(c);
    expect(rounds()).toBe(3);
    expect(clock.counts.alarms).toBe(0);
  });

  it('a 90-second round: no round queued behind it, the beat at 120 s starts nothing, exactly one round at 150 s', async () => {
    const { c, clock } = await waitingFor150(entry);
    clock.to(149.999);
    await settle(c);
    expect(rounds()).toBe(1);

    clock.to(150);
    expect(clock.counts.alarms).toBe(1);
    await waitFor(() => rounds() === 2, 'the round at 150 s');
    await settle(c);
    expect(rounds()).toBe(2); // one, not two
    expect(clock.pending()).toBe(0);

    // that round was quick: the beat's own pace again
    clock.to(180);
    await waitFor(() => rounds() === 3, 'the round at 180 s');
    await settle(c);
    expect(rounds()).toBe(3);
  });

  it('a round that fails (offline) is retried with the next beat', async () => {
    const { c, clock } = await boot({ fullReadEveryMs: 0, entry });
    fake.state.offline = true;
    clock.to(60);
    await waitFor(() => c.getState().sync.offline, 'the round at 60 s failed: offline');
    await settle(c);
    fake.state.offline = false;
    clock.to(119.999);
    await settle(c);
    expect(c.getState().sync.offline).toBe(true); // nothing ran in between
    clock.to(120);
    await waitFor(() => !c.getState().sync.offline, 'the retry at 120 s');
    await settle(c);
    expect(rounds()).toBe(2); // the first round, and the retry (the offline one never reached GitHub)
  });

  it('a slow round that fails is followed by the gap too', async () => {
    fake.state.restPageSize = 5; // the open issues span several pages
    const { c, clock, started, release } = await boot({ fullReadEveryMs: 0, entry, holdFirst: true });
    await waitFor(() => rounds() === 1, 'round 1 reached GitHub');
    fake.state.failRepoPage.set('gigleai/cavil-loop', 2); // a later page of the same read fails
    clock.to(60);
    clock.to(90);
    release();
    await started;
    await settle(c);
    expect(c.getState().sync.sources.find((s) => s.sourceKey === REPO_KEY)!.ok).toBe(false); // it did fail
    fake.state.failRepoPage.clear();
    clock.to(120);
    await settle(c);
    expect(rounds()).toBe(1);
    clock.to(150);
    await waitFor(() => rounds() === 2, 'the round at 150 s');
    await settle(c);
    expect(c.getState().sync.sources.find((s) => s.sourceKey === REPO_KEY)!.ok).toBe(true);
  });

  it('a source added while a timed round waits is read at once, and the waiting one does not run on top of it', async () => {
    const { c, clock } = await waitingFor150(entry);
    clock.to(121);
    c.addSource(PROJECT_URL);
    await waitFor(() => rounds() === 2, 'the round of the added source, at once');
    await settle(c);
    expect(c.getBoardData().projects.length).toBe(1);
    expect(clock.pending()).toBe(0); // the old alarm went with it

    clock.to(179.999);
    await settle(c);
    expect(rounds()).toBe(2); // nothing at 150 s
    clock.to(180);
    await waitFor(() => rounds() === 3, 'the next timed round, with the beat at 180 s');
    await settle(c);
    expect(rounds()).toBe(3);
  });

  it('the round a few seconds after a change is not held back by the gap, and replaces the waiting timed round', async () => {
    const { c, clock } = await waitingFor150(entry, { followUpSyncMs: 200 });
    clock.to(121);
    expect((await c.act({ kind: 'addLabel', key: K(139), label: 'bug' })).ok).toBe(true);
    // the clock stays at 121 s: the round after the change runs on its own (0.2 s of real time), long before 150 s
    await waitFor(() => rounds() === 2, 'the round after the change');
    await settle(c);
    expect(onBoard(c, 139)!.labels.map((l) => l.name)).toContain('bug');
    expect(clock.pending()).toBe(0);
    clock.to(179.999);
    await settle(c);
    expect(rounds()).toBe(2); // the old timed round did not run on top of it
    clock.to(180);
    await waitFor(() => rounds() === 3, 'the next timed round, with the beat at 180 s');
    await settle(c);
    expect(rounds()).toBe(3);
  });

  it('refresh by hand while a timed round waits: at once; the round it dropped ends late and changes nothing', async () => {
    const { c, clock } = await waitingFor150(entry);
    // 121 s: by hand — runs at once (round 2, held); 130 s: by hand again — round 2 is dropped, round 3 runs
    clock.to(121);
    const releaseSecond = holdNextRead();
    void c.restartSync();
    await waitFor(() => rounds() === 2, 'the round by hand, at once');
    expect(clock.pending()).toBe(0);
    clock.to(130);
    await c.restartSync();
    expect(rounds()).toBe(3);
    await settle(c);
    // the dropped round's answer arrives at 140 s: it starts nothing and sets no alarm
    clock.to(140);
    releaseSecond();
    await sleep(300);
    expect(rounds()).toBe(3);
    expect(clock.pending()).toBe(0);

    clock.to(179.999);
    await settle(c);
    expect(rounds()).toBe(3); // nothing at 150 s
    clock.to(180);
    await waitFor(() => rounds() === 4, 'the next timed round, with the beat at 180 s');
    await settle(c);
    expect(rounds()).toBe(4);
  });

  it('a source added during a slow round is read right behind it, as before; the gap follows the whole stretch', async () => {
    const { c, clock, started, release } = await boot({ fullReadEveryMs: 0, entry, holdFirst: true });
    await waitFor(() => rounds() === 1, 'round 1 reached GitHub');
    clock.to(60);
    c.addSource(PROJECT_URL); // while round 1 is still reading
    clock.to(90);
    release();
    await started;
    await waitFor(() => rounds() === 2, 'the queued round, right after the slow one');
    await settle(c);
    expect(c.getBoardData().projects.length).toBe(1);
    expect(rounds()).toBe(2);
    clock.to(120);
    await settle(c);
    expect(rounds()).toBe(2);
    clock.to(150);
    await waitFor(() => rounds() === 3, 'the timed round at 150 s');
  });
});

describe('the alarm of a timed round', () => {
  const tick = { kind: 'tick', everyMs: BEAT } as const;

  it('the beat and the alarm at the same moment start one round — whichever comes first', async () => {
    // the beat first: it starts the round, and the alarm is gone before its turn
    {
      const { c, clock, started, release } = await boot({ fullReadEveryMs: 0, entry: 'window', holdFirst: true });
      await waitFor(() => rounds() === 1, 'round 1 reached GitHub');
      clock.to(60); // the beat, while the round runs
      release(); // idle at 60 s: the next timed round is due at 120 s
      await started;
      await settle(c);
      // a beat of the shell at 90 s sets the alarm for 120 s — where the window's own beat falls too
      clock.to(90);
      c.onDesktopEvent(tick);
      expect(clock.pending()).toBe(1);
      const beats = clock.counts.beats;
      clock.to(120);
      expect(clock.counts.beats).toBe(beats + 1); // the beat did fire
      expect(clock.pending()).toBe(0);
      await waitFor(() => rounds() === 2, 'the round at 120 s');
      await settle(c);
      expect(rounds()).toBe(2);
      c.stopTimer();
    }
    // the alarm first: it starts the round, and the beat right behind it finds a round running
    {
      const before = rounds();
      const { c, clock, started, release } = await boot({ fullReadEveryMs: 0, holdFirst: true });
      await waitFor(() => rounds() === before + 1, 'round 1 reached GitHub');
      clock.to(10);
      c.onDesktopEvent(tick); // a beat while the round runs
      clock.to(20);
      release(); // idle at 20 s: due at 80 s
      await started;
      await settle(c);
      clock.to(30);
      c.onDesktopEvent(tick); // too early: the alarm, for 80 s
      expect(clock.pending()).toBe(1);
      let late = 0;
      clock.timers.setTimeout(() => {
        late++;
        c.onDesktopEvent(tick);
      }, 50 * S); // a beat at 80 s too, after the alarm
      clock.to(80);
      expect(clock.counts.alarms).toBe(2); // the alarm, then the beat
      expect(late).toBe(1);
      await waitFor(() => rounds() === before + 2, 'the round at 80 s');
      await settle(c);
      expect(rounds()).toBe(before + 2);
    }
  });

  it('signed out and in again while it waits: the old alarm starts nothing in the new session', async () => {
    const { c, clock } = await waitingFor150('shell');
    await c.logout();
    expect(clock.pending()).toBe(0); // gone with the session
    fake.state.nextGrant = { token: FAKE_TOKEN };
    c.setClientId(fake.state.oauthClientId);
    const login = c.startLogin();
    for (let i = 0; i < 500 && c.getState().login.status !== 'waiting'; i++) await sleep(10);
    fake.resolveGrant('approved');
    await login;
    await settle(c);
    expect(c.getState().phase).toBe('ready');
    const after = rounds();
    expect(after).toBeGreaterThan(1); // the new session's first round did run, at once

    clock.to(179.999);
    await settle(c);
    expect(rounds()).toBe(after); // nothing at 150 s
    clock.to(180);
    await waitFor(() => rounds() === after + 1, 'the timed round of the new session, with its beat');
  });

  it('the beat stopped: the alarm goes, nothing starts later', async () => {
    const { c, clock } = await waitingFor150('window');
    c.stopTimer();
    expect(clock.pending()).toBe(0);
    clock.to(300);
    await settle(c);
    expect(rounds()).toBe(1);
    // and a round by hand still runs
    await c.restartSync();
    expect(rounds()).toBe(2);
  });

  it('a beat that says its interval sets the gap: 0 = every beat is due (what the UI tests send)', async () => {
    const { c, clock, started, release } = await boot({ fullReadEveryMs: 0, holdFirst: true });
    await waitFor(() => rounds() === 1, 'round 1 reached GitHub');
    clock.to(10);
    c.onDesktopEvent({ kind: 'tick', everyMs: 0 }); // a beat while the round runs
    clock.to(20);
    release();
    await started;
    await settle(c);
    c.onDesktopEvent({ kind: 'tick' }); // no interval said: the gap stays as last told — 0, so due at once
    await waitFor(() => rounds() === 2, 'a round at once');
    await settle(c);
    expect(clock.pending()).toBe(0);
  });

  it('a clock that went back does not hold timed rounds for longer than one beat', async () => {
    const { c, clock } = await waitingFor150('shell');
    // "due at 150 s". The machine's clock is set back by an hour: by it, that is an hour away
    const back = manualClock(FIXTURE_NOW - 3600 * S);
    (c as any).now = back.now;
    clock.to(150); // the alarm still fires
    await waitFor(() => rounds() === 2, 'the round runs although the clock says it is too early by an hour');
  });
});
