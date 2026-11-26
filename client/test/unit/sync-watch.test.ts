// GigleAI/cavil-loop#733: the window's watch over syncing.
//   1. A round stuck while reading GitHub is dropped after 12 quiet wakes (3 minutes awake) and a new
//      round runs; the dropped round's late answer lands nowhere. The header says so until a check succeeds.
//   2. A round stuck at a step that is never cut (saving to this machine, renewing the sign-in) is only
//      reported: no drop, no second write, no new round. Once the step ends, the round completes.
//   3. A slow round that keeps moving (one answer per wake, longer than 3 minutes) is never reported —
//      notification pages included.
//   4. Without the shell's beat, the watch asks for timed rounds itself; with the beat, it adds none.
//   5. Wakes further apart than the gap (the machine slept) start the count again; 12 wakes awake still report.
// Real controller, the real Rust back end as a child process, the fake GitHub over HTTP, real SQLite.
// "Stuck" = one chosen call from the window to the back end is held — the boundary the watch looks at
// (a request held at the fake GitHub would end in the back end's own 30 s budget first: that budget is
// http.rs's own test, `cargo test -p cavil-core --lib http::`). Time is a clock the test moves.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller, type SyncTimers } from '../../src/app/controller';
import type { Backend } from '../../src/backend/backend';
import type { Desktop, DesktopEvent } from '../../src/app/desktop';
import { createController } from '../support/controller';
import { headerStatus, headerText, hoverLines, stallText } from '../../src/renderer/syncTimes';
import { WATCH_EVERY_MS, WATCH_QUIET_TICKS } from '../../src/shared/config';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import { waitUntil } from '../support/wait';

const REPO = 'GigleAI/cavil-loop';
const REPO_KEY = 'repo:gigleai/cavil-loop';
const BEAT = 60_000;
const S = 1000;
const WAKE = WATCH_EVERY_MS / S;

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

beforeEach(async () => {
  fake = await startFakeGitHub();
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

/** A clock moved by hand, with the timers that run on it (in time order). `skip` jumps without firing (sleep). */
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
    /** move `sec` seconds on, firing what is due on the way */
    by(sec: number) {
      const target = t + sec * S;
      for (;;) {
        const due = jobs.filter((j) => j.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        t = Math.max(t, due.at);
        if (due.every === null) drop(due);
        else due.at += due.every;
        due.fn();
      }
      t = Math.max(t, target);
    },
    /** the machine sleeps `sec` seconds: no timer fires; each repeating one comes next a period after waking */
    sleep(sec: number) {
      t += sec * S;
      for (const j of jobs) if (j.at < t) j.at = j.every === null ? t : t + j.every;
    },
  };
}

/** Holds the window's calls to the back end that match, until released (the boundary the watch observes). */
class HoldingBackend implements Backend {
  private rules: { match: (cmd: string, args?: Record<string, unknown>) => boolean; once: boolean; used: boolean }[] = [];
  private waiting: { release: () => void; cmd: string; args?: Record<string, unknown> }[] = [];
  readonly calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  constructor(private readonly inner: Backend) {}
  /** hold the next call that matches (or every one, `once: false`) */
  hold(match: (cmd: string, args?: Record<string, unknown>) => boolean, once = true): void {
    this.rules.push({ match, once, used: false });
  }
  stopHolding(): void {
    this.rules = [];
  }
  held(): number {
    return this.waiting.length;
  }
  /** let the oldest held call go on */
  releaseOne(): void {
    this.waiting.shift()?.release();
  }
  releaseAll(): void {
    this.rules = [];
    for (const w of this.waiting.splice(0)) w.release();
  }
  async call<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ cmd, ...(args ? { args } : {}) });
    const rule = this.rules.find((r) => !(r.once && r.used) && r.match(cmd, args));
    if (rule) {
      rule.used = true;
      await new Promise<void>((release) => this.waiting.push({ release, cmd, ...(args ? { args } : {}) }));
    }
    return this.inner.call<T>(cmd, args);
  }
}
let holds: HoldingBackend[] = [];

function quietDesktop(): Desktop {
  return {
    notify: async () => ({ ok: true }),
    setBadge: async () => {},
    clearNotifications: async () => {},
    clearItemNotifications: async () => {},
    loginItem: async () => false,
    setLoginItem: async () => {},
    nextEvent: () => new Promise<DesktopEvent>(() => {}),
    updateStatus: async () => null,
    checkUpdate: async () => {},
    setAutoUpdate: async () => {},
    setUpdateChannel: async () => {},
    dismissUpdate: async () => {},
    dismissInstalledUpdate: async () => {},
    restartToUpdate: async () => {},
    closeWindow: async () => {},
    windowFrame: async () => ({ overlay: false, fullscreen: false }),
    startDrag: async () => {},
    toggleZoom: async () => {},
  };
}

async function boot(opts: { desktop?: boolean; /** hold this call of the very first round (before any check succeeded) */ holdFirst?: (cmd: string) => boolean } = {}) {
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
    syncIntervalMs: BEAT,
    defaultClientId: '',
    followUpSyncMs: 600_000,
    readRetryDelaysMs: [0, 0],
    // every round reads in full: rounds are counted by full reads
    fullReadEveryMs: 0,
    ...(opts.desktop ? { desktop: quietDesktop() } : {}),
  });
  controllers.push(c);
  c.addSource(REPO);
  if (opts.holdFirst) {
    backend.hold(opts.holdFirst);
    c.startWatch();
    void c.start();
    await waitUntil(() => backend.held() === 1, 'the first round is held');
    return { c, clock, backend };
  }
  await c.start();
  expect(c.getState().phase).toBe('ready');
  c.startWatch();
  return { c, clock, backend };
}

const isFirstPage = (path: string) => path.startsWith('/api/repos/GigleAI/cavil-loop/issues?') && path.includes('state=open') && !/[?&]page=/.test(path);
const rounds = () => fake.log.filter((l) => l.method === 'GET' && isFirstPage(l.path)).length;
const reqTo = (part: string) => (cmd: string, args?: Record<string, unknown>) => cmd === 'request' && String(args?.url ?? '').includes(part);
const isRepoRead = (cmd: string, args?: Record<string, unknown>) => cmd === 'request' && isFirstPage(String(args?.url ?? '').replace(fake.api, '/api'));
const syncing = (c: Controller) => (c as any).syncing !== null;
const idle = (c: Controller) => () => !syncing(c) && !c.getState().sync.syncing;
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** a few real milliseconds for answers in flight to come back (the clock does not move) */
const breathe = () => sleepMs(30);

/** wake the watch `n` times (one WATCH_EVERY_MS each), letting answers in flight land between wakes */
async function wakes(clock: ReturnType<typeof manualClock>, n: number, between?: () => Promise<void> | void) {
  for (let i = 0; i < n; i++) {
    clock.by(WAKE);
    await breathe();
    await between?.();
  }
}

describe('a round stuck while reading GitHub', () => {
  it('is dropped after 12 quiet wakes; a new round completes; the late answer does not land; the header says so until then', async () => {
    const { c, clock, backend } = await boot();
    const before = rounds();
    const doneBefore = c.getState().sync.checkedFrom!;
    backend.hold(isRepoRead);
    void c.syncNow();
    await waitUntil(() => backend.held() === 1, 'the read is held');
    const stuckStart = (c as any).roundStartedAt as number;
    // the first wake still sees the round's own first answers (who am I): progress, not a quiet wake
    await wakes(clock, 1);
    expect((c as any).watchQuiet).toBe(0);

    await wakes(clock, WATCH_QUIET_TICKS - 1);
    expect((c as any).watchQuiet).toBe(WATCH_QUIET_TICKS - 1);
    expect(c.getState().sync.stall ?? null).toBeNull(); // 11 quiet wakes: nothing yet
    expect(backend.held()).toBe(1);

    // the 12th: given up on, a new round starts at once and reads GitHub again (read before it can finish)
    clock.by(WAKE);
    const stall = c.getState().sync.stall!;
    expect(stall).toEqual({ kind: 'restarted', step: 'read', roundStartedAt: stuckStart });
    expect(stallText(c.getState().sync)).toBe('同步卡住，已重来');
    await waitUntil(idle(c), 'the new round ends');
    expect(rounds()).toBe(before + 1); // the new round did read (the held one never reached GitHub)
    expect(c.getState().sync.checkedFrom!).toBeGreaterThan(doneBefore);
    expect(c.getState().sync.stall ?? null).toBeNull(); // a check succeeded: green again

    // the held read now goes on, with GitHub holding another title: it lands nowhere
    const checked = c.getState().sync.checkedFrom;
    const issue = fake.state.repos.get('gigleai/cavil-loop')!.find((r: any) => r.state === 'open')!;
    issue.title = 'changed after the drop';
    backend.releaseAll();
    await sleepMs(200);
    expect(rounds()).toBe(before + 2); // it did reach GitHub
    const shown = c.getBoardData().items.find((i) => i.number === issue.number)!;
    expect(shown.title).not.toBe('changed after the drop');
    expect(c.getState().sync.checkedFrom).toBe(checked);
  });

  it('while the new round runs, the yellow stays and the hover names both rounds', async () => {
    const { c, clock, backend } = await boot();
    backend.hold(isRepoRead);
    void c.syncNow();
    await waitUntil(() => backend.held() === 1, 'the first read is held');
    // the new round's read is held too, so it is seen running
    backend.hold(isRepoRead);
    await wakes(clock, WATCH_QUIET_TICKS + 1);
    await waitUntil(() => backend.held() === 2, 'the new round is reading');
    await wakes(clock, 1);
    const sync = c.getState().sync;
    expect(sync.stall?.kind).toBe('restarted');
    expect(sync.roundAt!.startedAt).toBeGreaterThan(sync.stall!.roundStartedAt);
    const lines = hoverLines(sync, () => '仓库', clock.now());
    expect(lines[0]).toMatch(/^\d\d:\d\d 开始的那一轮卡在「读 GitHub」，3 分钟没有任何进展，客户端已放弃它/);
    expect(lines[1]).toMatch(/^正在进行的新一轮：\d\d:\d\d 开始，已进行 \d+ 秒，最后一次进展/);
    expect(headerText(sync, clock.now())).toMatch(/^上次检查 \d+ 分钟前$/);
    backend.releaseAll();
    await waitUntil(idle(c), 'ends');
  });
});

describe("only the round's own answers are its progress (code review round 1, problem 1)", () => {
  it('a stuck read while other operations get answers every wake: still dropped after 12 quiet wakes', async () => {
    const { c, clock, backend } = await boot();
    const before = rounds();
    backend.hold(isRepoRead);
    void c.syncNow();
    await waitUntil(() => backend.held() === 1, 'the read is held');
    await wakes(clock, 1); // the round's own first answers (who am I)
    // another operation through the same back end answers before every wake
    let others = 0;
    for (let i = 0; i < WATCH_QUIET_TICKS - 1; i++) {
      await (c as any).backend.call('grantInfo');
      others++;
      clock.by(WAKE);
    }
    expect(others).toBe(WATCH_QUIET_TICKS - 1); // the other answers did come
    expect(c.getState().sync.stall ?? null).toBeNull();
    await (c as any).backend.call('grantInfo');
    clock.by(WAKE);
    expect(c.getState().sync.stall?.kind).toBe('restarted');
    await waitUntil(idle(c), 'the new round ends');
    expect(rounds()).toBe(before + 1);
  });

  it("a dropped round's late answers do not move the new round's watch", async () => {
    const { c, clock, backend } = await boot();
    // the first round's read and the next round's read are both held
    backend.hold(isRepoRead);
    void c.syncNow();
    await waitUntil(() => backend.held() === 1, 'first read held');
    backend.hold(isRepoRead);
    await wakes(clock, 1);
    await wakes(clock, WATCH_QUIET_TICKS - 1);
    clock.by(WAKE); // dropped; the new round starts and is held too
    expect(c.getState().sync.stall?.kind).toBe('restarted');
    await waitUntil(() => backend.held() === 2, 'the new round is held');
    await wakes(clock, 1); // the new round's own first answers
    // the dropped round's held read now answers: not the new round's progress
    backend.releaseOne();
    await breathe();
    const quiet = (c as any).watchQuiet as number;
    clock.by(WAKE);
    expect((c as any).watchQuiet).toBe(quiet + 1);
    backend.releaseAll();
    await waitUntil(idle(c), 'ends');
  });
});

describe('catch-up re-reads after a round count each answer (code review round 2, problem 1)', () => {
  /**
   * A merged PR whose re-read failed (its notice says so): the next round re-reads it after its check —
   * the PR's closing issues, then the PR and each of those issues, one request each.
   */
  async function mergedWithFailedReread(c: Controller, linked: number) {
    const list = fake.state.repos.get('gigleai/cavil-loop')!;
    const pr = list.find((r: any) => r.pull_request)!;
    Object.assign(pr, { state: 'open', pull_request: { ...pr.pull_request, merged_at: null } });
    // enough open issues on the repository for the linked list (the recording has fewer open ones)
    const issues = list.filter((r: any) => !r.pull_request && r.number !== pr.number).slice(0, linked);
    for (const r of issues) Object.assign(r, { state: 'open', state_reason: null, closed_at: null });
    expect(issues).toHaveLength(linked);
    fake.state.w.closingIssues.set(`gigleai/cavil-loop#${pr.number}`, issues.map((r: any) => ({ repo: 'GigleAI/cavil-loop', number: r.number })));
    await c.syncNow();
    const d = await c.loadDetail(`gigleai/cavil-loop#${pr.number}`);
    const headOid = d.ok ? d.detail.pr!.headOid : '';
    // the merge's re-read cannot read the PR's linked issues: its notice says so, the next round re-reads
    fake.state.answerOverride = (e) => (e.operation === 'CavilClosingIssues' ? { status: 502, body: { message: 'Bad Gateway' } } : null);
    const s = c.startOp({ kind: 'merge', key: `gigleai/cavil-loop#${pr.number}`, method: 'merge', headOid });
    await waitUntil(() => {
      const r = c.getState().ops.find((x) => x.id === s.id);
      return Boolean(r?.readProblem) && !r?.running;
    }, 'merged, its re-read failed');
    fake.state.answerOverride = null;
    await waitUntil(idle(c), 'idle');
    return { pr: pr.number as number, linked: issues.length };
  }
  const isCatchUp = (cmd: string, args?: Record<string, unknown>) => cmd === 'request' && /CavilItemRefresh|CavilClosingIssues/.test(String(args?.body ?? ''));

  it('a merged PR with 14 linked issues re-read one request per wake (over 3 minutes): never reported', async () => {
    const { c, clock, backend } = await boot();
    const { linked } = await mergedWithFailedReread(c, 14);
    backend.hold(isCatchUp, false);
    void c.syncNow();
    await waitUntil(() => backend.held() === 1, 'the catch-up reached its first request');
    expect((c as any).step).toBe('catchUp');
    let answered = 0;
    while (backend.held() === 1) {
      clock.by(WAKE);
      expect(c.getState().sync.stall ?? null).toBeNull();
      backend.releaseOne();
      answered++;
      await waitUntil(() => backend.held() === 1 || idle(c)(), 'the next request, or the end');
    }
    // the closing-issues list, the PR and every linked issue: more wakes than the 12 that report
    expect(answered).toBeGreaterThanOrEqual(linked + 2);
    expect(answered).toBeGreaterThan(WATCH_QUIET_TICKS);
    await waitUntil(idle(c), 'ends');
    expect(c.getState().sync.stall ?? null).toBeNull();
  });

  it('one catch-up request that never answers: reported at 「补读」, not dropped', async () => {
    const { c, clock, backend } = await boot();
    await mergedWithFailedReread(c, 3);
    backend.hold(isCatchUp);
    void c.syncNow();
    await waitUntil(() => backend.held() === 1, 'the catch-up request is held');
    await wakes(clock, WATCH_QUIET_TICKS + 1);
    expect(c.getState().sync.stall).toMatchObject({ kind: 'waiting', step: 'catchUp' });
    expect(hoverLines(c.getState().sync, () => '仓库', clock.now())[0]).toContain('卡在「补读」');
    expect(backend.held()).toBe(1);
    backend.releaseAll();
    await waitUntil(idle(c), 'ends');
  });
});

describe('a first sync stuck, before any check succeeded (code review round 1, problem 2)', () => {
  for (const [step, name, match] of [
    ['renew', '续期登录', (cmd: string) => cmd === 'ensureFresh'],
    ['store', '存到本机', (cmd: string) => cmd === 'replaceSnapshots'],
  ] as const) {
    it(`${name}: the header shows the stall with no "上次检查", the hover says which step and how to recover`, async () => {
      const { c, clock, backend } = await boot({ holdFirst: match });
      expect(c.getState().sync.checkedFrom).toBeNull(); // nothing checked yet
      expect(headerStatus(c.getState().sync, clock.now())).toBeNull(); // nothing to show yet
      await wakes(clock, WATCH_QUIET_TICKS + 1);
      const sync = c.getState().sync;
      expect(sync.checkedFrom).toBeNull();
      expect(sync.stall).toMatchObject({ kind: 'waiting', step });
      expect(headerStatus(sync, clock.now())).toEqual({ text: null, stall: '同步卡住' });
      const lines = hoverLines(sync, () => '仓库', clock.now());
      expect(lines[0]).toContain(`卡在「${name}」已 3 分钟没有进展`);
      expect(lines.some((l) => l.includes('完全退出客户端再打开'))).toBe(true);
      backend.releaseAll();
      await waitUntil(() => c.getState().sync.checkedFrom !== null && idle(c)(), 'the first check succeeds');
      // the yellow is gone; the check time is the read's (a stuck save lands the read it was saving)
      const after = headerStatus(c.getState().sync, clock.now())!;
      expect(after.stall).toBeNull();
      expect(after.text).toMatch(/^上次检查 (不到 1|\d+) 分钟前$/);
    });
  }
});

describe('a round stuck at a step that is never cut', () => {
  for (const [step, name, match] of [
    ['store', '存到本机', (cmd: string) => cmd === 'replaceSnapshots'],
    ['renew', '续期登录', (cmd: string) => cmd === 'ensureFresh'],
  ] as const) {
    it(`${name}: reported after 12 quiet wakes, never dropped, no second write, no new round; it completes once the step ends`, async () => {
      const { c, clock, backend } = await boot();
      const before = rounds();
      const callsBefore = backend.calls.length;
      backend.hold(match);
      void c.syncNow();
      await waitUntil(() => backend.held() === 1, 'the step is held');
      await wakes(clock, WATCH_QUIET_TICKS + 4);
      const sync = c.getState().sync;
      expect(sync.stall).toMatchObject({ kind: 'waiting', step });
      expect(stallText(sync)).toBe('同步卡住');
      const lines = hoverLines(sync, () => '仓库', clock.now());
      expect(lines[0]).toContain(`卡在「${name}」已 3 分钟没有进展`);
      expect(lines.some((l) => l.includes('只关窗口不算退出'))).toBe(true);
      // nothing was cut: one held call, no second one of its kind, no further round reached GitHub
      expect(backend.held()).toBe(1);
      expect(backend.calls.slice(callsBefore).filter((x) => match(x.cmd)).length).toBe(1);
      expect(rounds()).toBe(step === 'store' ? before + 1 : before);
      backend.releaseAll();
      await waitUntil(idle(c), 'the round completes');
      expect(c.getState().sync.stall ?? null).toBeNull();
      expect(rounds()).toBe(before + 1);
    });
  }
});

describe('slow but moving is never reported', () => {
  it('a round whose reads answer one per wake, over more than 3 minutes', async () => {
    // small pages: the repository read is many requests long
    fake.state.restPageSize = 3;
    const { c, clock, backend } = await boot();
    backend.hold((cmd) => cmd === 'request', false);
    void c.syncNow();
    // each wake lets one request answer; the next is asked for before the clock moves on
    let released = 0;
    await waitUntil(() => backend.held() === 1, 'the first request is held');
    while (backend.held() === 1 && released < WATCH_QUIET_TICKS * 3) {
      clock.by(WAKE);
      backend.releaseOne();
      released++;
      await waitUntil(() => backend.held() === 1 || idle(c)(), 'the next request, or the end');
      expect(c.getState().sync.stall ?? null).toBeNull();
    }
    expect(released).toBeGreaterThan(WATCH_QUIET_TICKS); // it really ran past 3 minutes, moving
    expect(c.getState().sync.stall ?? null).toBeNull();
    backend.releaseAll();
    await waitUntil(idle(c), 'ends');
    expect(c.getState().sync.stall ?? null).toBeNull();
  });

  it('notifications of 20 pages, one page per wake: no report; one page that never answers: reported, not dropped', async () => {
    fake.state.restPageSize = 1;
    for (let i = 0; i < 20; i++) {
      fake.state.inbox.threads.push({
        id: String(900 + i),
        unread: true,
        reason: 'mention',
        updated_at: new Date(FIXTURE_NOW - 3_600_000 + i * 1000).toISOString(),
        subject: { title: `t${i}`, url: `${fake.api}/repos/${REPO}/issues/${i + 1}`, latest_comment_url: `${fake.api}/repos/${REPO}/issues/${i + 1}`, type: 'Issue' },
        repository: { full_name: REPO },
      });
    }
    const { c, clock, backend } = await boot({ desktop: true });
    const notif = reqTo('/notifications');
    // a later round (the inbox is read once a minute at most), with the inbox changed: every page is read again
    clock.by(61);
    await waitUntil(idle(c), 'idle');
    for (const th of fake.state.inbox.threads) th.updated_at = new Date(clock.now() - 1000).toISOString();
    const pagesBefore = fake.log.filter((l) => l.operation === 'notifications').length;
    backend.hold(notif, false);
    void c.syncNow();
    await waitUntil(() => backend.held() === 1, 'the first page is held');
    // one page answers per wake; the next page is asked for before the clock moves on
    let pages = 0;
    for (let i = 0; i < 20; i++) {
      clock.by(WAKE);
      backend.releaseOne();
      pages++;
      if (pages < 20) await waitUntil(() => backend.held() === 1, 'the next page is asked for');
    }
    expect(pages).toBe(20); // 20 pages, one per wake: 5 minutes of the round moving
    expect(c.getState().sync.stall ?? null).toBeNull();
    backend.stopHolding();
    await waitUntil(idle(c), 'ends');
    expect(fake.log.filter((l) => l.operation === 'notifications').length - pagesBefore).toBeGreaterThanOrEqual(20);
    expect(c.getState().sync.stall ?? null).toBeNull();

    // a page that never answers: the next round that reads the inbox (the watch asks for it: no beat here)
    backend.hold(notif);
    for (let i = 0; i < 12 && backend.held() === 0; i++) {
      clock.by(WAKE);
      await waitUntil(() => backend.held() === 1 || idle(c)(), 'held or idle');
    }
    await waitUntil(() => backend.held() === 1, 'the page is held');
    await wakes(clock, WATCH_QUIET_TICKS + 1);
    expect(c.getState().sync.stall).toMatchObject({ kind: 'waiting', step: 'activity' });
    expect(hoverLines(c.getState().sync, () => '仓库', clock.now())[0]).toContain('卡在「读与我相关的通知」');
    expect(backend.held()).toBe(1); // not dropped
    backend.releaseAll();
    await waitUntil(idle(c), 'ends');
  });
});

describe('the beat', () => {
  it('no shell beat for 60 minutes: the watch asks for rounds itself, never more than about 2 minutes apart', async () => {
    const { c, clock } = await boot();
    const before = rounds();
    const at: number[] = [];
    let last = rounds();
    for (let i = 0; i < 240; i++) {
      clock.by(WAKE);
      // a round the watch asked for ends before the clock moves on (the clock stands still meanwhile)
      await waitUntil(idle(c), 'idle');
      if (rounds() !== last) {
        last = rounds();
        at.push(clock.now());
      }
    }
    await waitUntil(idle(c), 'idle');
    expect(rounds() - before).toBeGreaterThanOrEqual(25);
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(120_000);
  });

  it('with the shell beat every 60 s for 10 minutes: exactly 10 rounds (the watch adds none), and the hover says when it last came', async () => {
    const { c, clock } = await boot();
    clock.timers.setInterval(() => c.onDesktopEvent({ kind: 'tick', everyMs: BEAT }), BEAT);
    const before = rounds();
    for (let i = 0; i < 40; i++) {
      clock.by(WAKE);
      await breathe();
      await waitUntil(idle(c), 'idle');
    }
    expect(rounds() - before).toBe(10);
    const lines = hoverLines(c.getState().sync, () => '仓库', clock.now());
    expect(lines).toContain('最后收到定时信号：不到 1 分钟前');
  });
});

describe('sleep', () => {
  it('11 quiet wakes, 8 hours asleep: the first wake after does not report; the round then completes', async () => {
    const { c, clock, backend } = await boot();
    const before = rounds();
    backend.hold(isRepoRead);
    void c.syncNow();
    await waitUntil(() => backend.held() === 1, 'held');
    await wakes(clock, WATCH_QUIET_TICKS - 1);
    clock.sleep(8 * 3600);
    await wakes(clock, 1);
    expect(c.getState().sync.stall ?? null).toBeNull();
    expect(backend.held()).toBe(1); // not dropped either
    backend.releaseAll();
    await waitUntil(idle(c), 'the round completes');
    expect(rounds()).toBeGreaterThanOrEqual(before + 1); // the held read did reach GitHub
    expect(c.getState().sync.sources.every((st) => st.ok)).toBe(true);
  });

  it('awake, 12 quiet wakes in a row still report (the count only starts again after a gap)', async () => {
    const { c, clock, backend } = await boot();
    backend.hold(isRepoRead);
    void c.syncNow();
    await waitUntil(() => backend.held() === 1, 'held');
    clock.sleep(8 * 3600);
    // the first wake sees the round's first answers; then 11 quiet ones; the 12th quiet one acts (read at once)
    await wakes(clock, WATCH_QUIET_TICKS);
    expect(c.getState().sync.stall ?? null).toBeNull();
    clock.by(WAKE);
    expect(c.getState().sync.stall?.kind).toBe('restarted');
    backend.releaseAll();
    await waitUntil(idle(c), 'ends');
  });
});
