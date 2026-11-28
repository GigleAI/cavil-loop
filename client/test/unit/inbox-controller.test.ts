// GitHub#752 — the notification part of the table's 「收件箱」, as the controller hands it to the window
// (`inboxThreads` / `inboxRead`), and 「最近完成」's days. The controller with the real Rust back end as a child
// process against the fake GitHub: real sync rounds read the inbox over HTTP. The harness is the one of
// test/unit/github-activity.test.ts (GitHub#713). Every "it is not there" check has a "it was there / the inbox
// really was read" sibling.
//
// Unlike the reminders, the inbox is not about what is new: a thread already unread at start is in it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { createController } from '../support/controller';
import type { Alert, Desktop, DesktopEvent } from '../../src/app/desktop';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, loadCavilProjectPages, loadCavilRepoIssues, type FakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';

const REPO = 'GigleAI/cavil-loop';
const key = (n: number) => `gigleai/cavil-loop#${n}`;
const iso = (ms: number) => new Date(ms).toISOString();

let fake: FakeGitHub;
let dir: string;
const controllers: Controller[] = [];
const caches: Cache[] = [];
const backends: HarnessBackend[] = [];

afterEach(async () => {
  const cs = controllers.splice(0);
  for (const c of cs) c.stopTimer();
  await Promise.all(cs.map((c) => c.prefetchSettled()));
  await Promise.all(cs.map((c) => c.activitySettled()));
  await Promise.all(backends.splice(0).map((b) => b.close()));
  for (const c of caches.splice(0)) c.close();
  await fake?.close();
});

const rawRepo = loadCavilRepoIssues();
const rawBoard = loadCavilProjectPages().flatMap((pg) => pg.items.nodes).filter((n: any) => !n.isArchived && n.content?.number != null && n.content.repository?.nameWithOwner === REPO);
const onBoard = new Set(rawBoard.map((n: any) => n.content.number as number));
const openIssues = rawRepo.filter((i: any) => i.state === 'open' && !i.pull_request && !i.labels.some((l: any) => (l.name ?? l) === 'pending/human'));
/** open issues on the Project board / not on it (both in the repository) */
const [A, B, C] = openIssues.filter((i: any) => onBoard.has(i.number)).map((i: any) => i.number as number);
/** an issue of the repository the Project does not list (its number on GitHub needs no copy here: the inbox names it) */
const OFF_BOARD = Math.max(...rawRepo.map((i: any) => i.number as number)) + 1000;

it('the recording still has what these tests need', () => {
  expect([A, B, C].every((n) => typeof n === 'number')).toBe(true);
  expect(onBoard.has(OFF_BOARD)).toBe(false);
});

interface Harness {
  c: Controller;
  /** set: the shell's next badge call waits for it (what is queued behind it waits too) */
  badgeGate: { wait: Promise<void> | null };
  alerts: Alert[];
  clock: { t: number };
  items(): Extract<Alert, { kind: 'item' }>[];
  cache: Cache;
}

/** `skew`: this machine's clock ahead of GitHub's by that much (ms); GitHub's clock is `clock.t` */
async function started(opts: { sources: string[]; seed?: Record<string, unknown>; skew?: number }): Promise<Harness> {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  for (const [k, v] of Object.entries(opts.seed ?? {})) cache.setSetting(k, v);
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const clock = { t: FIXTURE_NOW };
  const alerts: Alert[] = [];
  const badgeGate: Harness['badgeGate'] = { wait: null };
  const endpoints = { api: fake.api, web: fake.web };
  const backend = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: () => clock.t, sleep: async () => {}, opened: [] });
  backends.push(backend);
  const desktop: Desktop = {
    notify: async (a) => {
      alerts.push(a);
      return { ok: true };
    },
    setBadge: async () => {
      const w = badgeGate.wait;
      badgeGate.wait = null;
      if (w) await w;
    },
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
  const skew = opts.skew ?? 0;
  const c = await createController({ backend, endpoints, now: () => clock.t + skew, defaultClientId: '', desktop });
  controllers.push(c);
  for (const s of opts.sources) c.addSource(s);
  await c.start();
  await c.desktopSettled();
  expect(c.getState().sync.sources.every((s) => s.ok)).toBe(true);
  return { c, cache, alerts, clock, badgeGate, items: () => alerts.filter((a): a is Extract<Alert, { kind: 'item' }> => a.kind === 'item') };
}

async function tick(h: Harness) {
  h.clock.t += 60_000;
  await h.c.syncNow();
  await h.c.desktopSettled();
  await h.c.desktopSettled();
}



let seq = 100;
/** a thread of the fake's inbox (GitHub's shape); returns it to change later */
function thread(n: number, o: { reason?: string; at: number; unread?: boolean; repo?: string }) {
  const repo = o.repo ?? REPO;
  const url = `${fake.api}/repos/${repo}/issues/${n}`;
  const th = {
    id: String(seq++),
    unread: o.unread ?? true,
    reason: o.reason ?? 'mention',
    updated_at: iso(o.at),
    subject: { title: `issue ${n}`, url, latest_comment_url: url, type: 'Issue' },
    repository: { full_name: repo },
  };
  fake.state.inbox.threads.push(th);
  return th;
}
const reqs = (op: string, from = 0) => fake.log.slice(from).filter((e) => e.operation === op);
/** what landed on disk (settings reach the back end asynchronously) */
const stored = async (h: Harness, k: string) => {
  await h.c.settled();
  return h.cache.getSetting<unknown>(k, null);
};
const inbox = (h: Harness) => h.c.getState().inboxThreads.map((t) => [t.key, t.reason]);
const look = async (h: Harness, n: number) => {
  h.c.onDesktopEvent({ kind: 'active' });
  h.c.showingItem(key(n));
  await h.c.activitySettled();
};

describe('the notification part of 「收件箱」', () => {
  beforeEach(async () => {
    fake = await startFakeGitHub();
    dir = tempDir();
    fake.state.inbox.threads = [];
    fake.state.inbox.comments.clear();
  });

  it('unread threads already there at start are in it, one per item, the latest; read ones and ones outside every source are not', async () => {
    thread(A, { at: FIXTURE_NOW - 3_600_000, reason: 'comment' });
    thread(A, { at: FIXTURE_NOW - 60_000, reason: 'review_requested' });
    thread(B, { at: FIXTURE_NOW - 60_000, unread: false });
    thread(7, { at: FIXTURE_NOW - 60_000, repo: 'someone/elsewhere' });
    const h = await started({ sources: [REPO] });
    // did happen: the inbox was read
    expect(reqs('notifications')).toHaveLength(1);
    expect(h.c.getState().inboxRead).toBe(true);
    expect(inbox(h)).toEqual([[key(A), 'review_requested']]);
  });

  it('opened in the app: it leaves, and the opening is kept on this machine; newer activity brings it back; read on GitHub, it leaves and the record goes', async () => {
    const a = thread(A, { at: FIXTURE_NOW - 60_000 });
    thread(B, { at: FIXTURE_NOW - 60_000 });
    const h = await started({ sources: [REPO] });
    expect(inbox(h).map(([k]) => k).sort()).toEqual([key(A), key(B)].sort());
    await look(h, A);
    expect(inbox(h).map(([k]) => k)).toEqual([key(B)]);
    expect(Object.keys((await stored(h, 'inboxOpened')) as Record<string, number>)).toEqual([key(A)]);
    // nothing was written to GitHub (marking read there is its own setting, off)
    expect(reqs('markThreadRead')).toEqual([]);
    // the next round, nothing new: still out
    await tick(h);
    expect(inbox(h).map(([k]) => k)).toEqual([key(B)]);
    // a new reply after the opening
    a.updated_at = iso(h.clock.t + 10_000);
    await tick(h);
    expect(inbox(h).map(([k]) => k).sort()).toEqual([key(A), key(B)].sort());
    // read on GitHub
    a.unread = false;
    await tick(h);
    expect(inbox(h).map(([k]) => k)).toEqual([key(B)]);
    expect(await stored(h, 'inboxOpened')).toEqual({});
  });

  it('opening an item with no unread thread records nothing', async () => {
    thread(B, { at: FIXTURE_NOW - 60_000 });
    const h = await started({ sources: [REPO] });
    await look(h, A);
    expect(await stored(h, 'inboxOpened')).toBeNull();
    // did happen: the other item's thread is there
    expect(inbox(h).map(([k]) => k)).toEqual([key(B)]);
  });

  it('a read that fails keeps the last complete one', async () => {
    fake.state.restPageSize = 1;
    thread(A, { at: FIXTURE_NOW - 60_000 });
    const b = thread(B, { at: FIXTURE_NOW - 50_000 });
    const h = await started({ sources: [REPO] });
    expect(inbox(h)).toHaveLength(2);
    // something changed (or GitHub answers "unchanged" and no second page is asked for), and its read fails
    const before = h.c.getState().inboxThreads;
    b.unread = false;
    thread(C, { at: FIXTURE_NOW - 40_000 });
    const page2 = (path: string) => path.startsWith('/api/notifications?') && path.includes('page=2');
    fake.state.answerOverride = (e) => (page2(e.path) ? { status: 502, body: { message: 'boom' } } : null);
    await tick(h);
    expect(fake.log.some((e) => page2(e.path) && e.status === 502)).toBe(true);
    expect(h.c.getState().inboxThreads).toEqual(before);
    expect(h.c.getState().inboxRead).toBe(true);
    // did happen: the next good read drops the thread read on GitHub and brings the new one
    fake.state.answerOverride = null;
    await tick(h);
    expect(inbox(h).map(([k]) => k).sort()).toEqual([key(A), key(C)].sort());
  });

  it('the reminding switched off: nothing, and the window is told the inbox is not read; on again, it is read and listed', async () => {
    thread(A, { at: FIXTURE_NOW - 60_000 });
    const h = await started({ sources: [REPO] });
    expect(inbox(h)).toHaveLength(1);
    h.c.setGithubActivity(false);
    expect(h.c.getState()).toMatchObject({ inboxThreads: [], inboxRead: false });
    await tick(h);
    expect(h.c.getState()).toMatchObject({ inboxThreads: [], inboxRead: false });
    h.c.setGithubActivity(true);
    await tick(h);
    expect(h.c.getState().inboxRead).toBe(true);
    expect(inbox(h)).toHaveLength(1);
  });
});

describe('「最近完成」\'s days', () => {
  beforeEach(async () => {
    fake = await startFakeGitHub();
    dir = tempDir();
    fake.state.inbox.threads = [];
  });

  it('7 by default; a whole number from 1 to 365 is kept on this machine; anything else changes nothing', async () => {
    const h = await started({ sources: [REPO] });
    expect(h.c.getState().doneDays).toBe(7);
    h.c.setDoneDays(30);
    expect(h.c.getState().doneDays).toBe(30);
    expect(await stored(h, 'doneDays')).toBe(30);
    for (const v of [0, 366, 2.5, '14', null]) {
      h.c.setDoneDays(v);
      expect(h.c.getState().doneDays, String(v)).toBe(30);
    }
    expect(await stored(h, 'doneDays')).toBe(30);
  });

  it('what was saved is read at start; a broken value is 7', async () => {
    const h = await started({ sources: [REPO], seed: { doneDays: 14 } });
    expect(h.c.getState().doneDays).toBe(14);
  });

  it('a broken saved value is 7', async () => {
    const h = await started({ sources: [REPO], seed: { doneDays: 'x' } });
    expect(h.c.getState().doneDays).toBe(7);
  });
});
