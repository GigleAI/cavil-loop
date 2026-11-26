// GitHub#713 — GitHub's own activity concerning the account (@, replies, review requests,
// assignments), read from its notification inbox and reminded of like a pending item.
//
// Two layers, each on the path the app really takes:
//   1. the rules alone (`ActivityTracker`, `activityText`, `parseThreads`, `mentions`), each row with
//      an input that tells a right implementation from a plausible wrong one;
//   2. the controller with the real Rust back end as a child process against the fake GitHub: real
//      sync rounds read the inbox over HTTP, the latest comment is read for the words, opening an
//      item marks its thread read only when the setting says so. Every "nothing happened" check has
//      a "this did happen" sibling (the inbox really was read, the PATCH really went out).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { createController } from '../support/controller';
import type { Alert, Desktop, DesktopEvent } from '../../src/app/desktop';
import { ActivityTracker, activityText, mentions, parseThreads, type Candidate, type Thread } from '../../src/data/notifications';
import { normalizeGithubActivity, normalizeGithubActivityMarkRead } from '../../src/shared/uiPrefs';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, loadCavilProjectPages, loadCavilRepoIssues, type FakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';

const REPO = 'GigleAI/cavil-loop';
const ME = 'user-1';
const OTHER = 'someone-else';
const key = (n: number) => `gigleai/cavil-loop#${n}`;
const iso = (ms: number) => new Date(ms).toISOString();

// =====================================================================================
// 1. the rules
// =====================================================================================

const API = 'https://api.github.com';
function raw(id: number, n: number, o: { reason?: string; at: number; comment?: number | null; unread?: boolean; type?: string; repo?: string }) {
  const repo = o.repo ?? 'o/r';
  const url = `${API}/repos/${repo}/${o.type === 'PullRequest' ? 'pulls' : 'issues'}/${n}`;
  return {
    id: String(id),
    unread: o.unread ?? true,
    reason: o.reason ?? 'mention',
    updated_at: iso(o.at),
    subject: { title: `title ${n}`, url, latest_comment_url: o.comment === undefined ? url : o.comment === null ? null : `${API}/repos/${repo}/issues/comments/${o.comment}`, type: o.type ?? 'Issue' },
    repository: { full_name: repo },
  };
}

describe('the inbox as GitHub sends it', () => {
  it('keeps issues and pull requests with the six reasons; everything else is left out', () => {
    const got = parseThreads([
      raw(1, 1, { at: 1000, reason: 'mention' }),
      raw(2, 2, { at: 1000, reason: 'team_mention' }),
      raw(3, 3, { at: 1000, reason: 'comment' }),
      raw(4, 4, { at: 1000, reason: 'author' }),
      raw(5, 5, { at: 1000, reason: 'review_requested', type: 'PullRequest' }),
      raw(6, 6, { at: 1000, reason: 'assign' }),
      raw(7, 7, { at: 1000, reason: 'subscribed' }),
      raw(8, 8, { at: 1000, reason: 'state_change' }),
      raw(9, 9, { at: 1000, reason: 'ci_activity' }),
      raw(10, 10, { at: 1000, reason: 'security_alert' }),
      { ...raw(11, 11, { at: 1000 }), subject: { title: 'r', url: `${API}/repos/o/r/releases/1`, latest_comment_url: null, type: 'Release' } },
      { ...raw(12, 12, { at: 1000 }), subject: { title: 'd', url: null, latest_comment_url: null, type: 'Discussion' } },
      'not a thread',
    ]);
    expect(got.map((t) => t.id)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(got[4]).toMatchObject({ key: 'o/r#5', kind: 'pr', repo: 'o/r', number: 5 });
  });

  it('the item key is lower-cased like every item key; a "latest comment" that is the item itself is no comment', () => {
    const [th] = parseThreads([raw(1, 42, { at: 1000, repo: 'GigleAI/Cavil-Loop', comment: undefined })]);
    expect(th.key).toBe('gigleai/cavil-loop#42');
    expect(th.repo).toBe('GigleAI/Cavil-Loop');
    expect(th.commentUrl).toBeNull();
    expect(parseThreads([raw(1, 42, { at: 1000, comment: 7 })])[0].commentUrl).toBe(`${API}/repos/o/r/issues/comments/7`);
  });
});

describe('which threads remind', () => {
  const inAll = () => [{ key: 'repo:o/r', since: -Infinity }];
  const t0 = 1_000_000;
  const th = (id: number, n: number, at: number, extra: Parameters<typeof raw>[2] extends infer O ? Partial<O> : never = {}) => parseThreads([raw(id, n, { at, ...extra })])[0];
  const ids = (c: Candidate[]) => c.map((x) => x.thread.id);

  it('the first complete read is history; after it, a thread updated later reminds exactly once', () => {
    const t = new ActivityTracker();
    expect(t.observe([th(1, 1, t0 - 10)], inAll, t0)).toEqual([]);
    expect(t.started()).toBe(true);
    // unchanged: nothing
    expect(t.observe([th(1, 1, t0 - 10)], inAll, t0 + 60_000)).toEqual([]);
    // updated: once
    expect(ids(t.observe([th(1, 1, t0 + 30_000)], inAll, t0 + 120_000))).toEqual(['1']);
    expect(t.observe([th(1, 1, t0 + 30_000)], inAll, t0 + 180_000)).toEqual([]);
  });

  it('a thread first seen after the baseline reminds when updated after it, not when its last update is older (an item that only now joined a source)', () => {
    const t = new ActivityTracker();
    t.observe([], inAll, t0);
    expect(ids(t.observe([th(2, 2, t0 + 5), th(3, 3, t0 - 5)], inAll, t0 + 60_000))).toEqual(['2']);
  });

  it('a read thread does not remind, nor one outside every source; a source counts only for activity after it was added — before it is history, after it is not lost (in the first read with it too)', () => {
    const t = new ActivityTracker();
    let where: Record<string, { key: string; since: number }[]> = {};
    const by = (k: string) => where[k] ?? [];
    t.observe([th(9, 9, t0 - 50)], by, t0);
    // read on GitHub already / in no source
    where = { 'o/r#1': [{ key: 'repo:o/r', since: -Infinity }] };
    expect(t.observe([th(1, 1, t0 + 5, { unread: false }), th(2, 2, t0 + 5), th(9, 9, t0 - 50)], by, t0 + 60_000)).toEqual([]);
    // #4 had activity at +70 s; the source holding it was added at +80 s; read at +120 s: history
    where = { 'o/r#4': [{ key: 'project:x', since: t0 + 80_000 }], 'o/r#3': [{ key: 'project:x', since: t0 + 80_000 }] };
    expect(t.observe([th(4, 4, t0 + 70_000), th(3, 3, t0 + 90_000)], by, t0 + 120_000).map((c) => [c.thread.id, c.sources])).toEqual([['3', ['project:x']]]);
    // #4 changes after the source was added: it reminds
    expect(ids(t.observe([th(4, 4, t0 + 130_000), th(3, 3, t0 + 90_000)], by, t0 + 180_000))).toEqual(['4']);
    // in a source added late and an old one: the old one makes earlier activity count, and only that one is named
    where = { 'o/r#5': [{ key: 'project:x', since: t0 + 200_000 }, { key: 'repo:o/r', since: -Infinity }] };
    expect(t.observe([th(5, 5, t0 + 190_000)], by, t0 + 240_000).map((c) => c.sources)).toEqual([['repo:o/r']]);
    // the comment must be newer than the source's addition too, to be called new
    where = { 'o/r#6': [{ key: 'project:y', since: t0 + 250_000 }] };
    expect(t.observe([th(6, 6, t0 + 260_000)], by, t0 + 300_000)[0].since).toBe(t0 + 250_000);
  });

  it('a 304 (null) judges the inbox last read whole: nothing reminds again', () => {
    const t = new ActivityTracker();
    t.observe([th(1, 1, t0 - 10)], inAll, t0);
    expect(t.observe(null, inAll, t0 + 60_000)).toEqual([]);
    expect(t.threads().map((x) => x.id)).toEqual(['1']);
    expect(ids(t.observe([th(1, 1, t0 + 70_000)], inAll, t0 + 120_000))).toEqual(['1']);
  });

  it('the latest comment is worth reading only when its address changed; `since` is the time remembered for the thread', () => {
    const t = new ActivityTracker();
    t.observe([th(1, 1, t0 - 10, { comment: 7 })], inAll, t0);
    // the old @-comment unchanged, the thread updated (an assignment): not read
    const [same] = t.observe([th(1, 1, t0 + 10, { comment: 7, reason: 'assign' })], inAll, t0 + 60_000);
    expect(same).toMatchObject({ readComment: false, since: t0 - 10 });
    const [moved] = t.observe([th(1, 1, t0 + 20, { comment: 8 })], inAll, t0 + 120_000);
    expect(moved).toMatchObject({ readComment: true, since: t0 + 10 });
  });

  it('reset: the next complete read is a baseline again (sign-out, another account, the setting off)', () => {
    const t = new ActivityTracker();
    t.observe([th(1, 1, t0)], inAll, t0);
    t.reset();
    expect(t.started()).toBe(false);
    expect(t.observe([th(1, 1, t0 + 99_000)], inAll, t0 + 120_000)).toEqual([]);
  });

  it('marked read here: no longer among the item\'s unread threads; other items\' threads stay', () => {
    const t = new ActivityTracker();
    t.observe([th(1, 1, t0), th(2, 1, t0, { reason: 'assign' }), th(3, 2, t0)], inAll, t0);
    expect(t.unreadOf('o/r#1').map((x) => x.id)).toEqual(['1', '2']);
    t.markedRead('1');
    expect(t.unreadOf('o/r#1').map((x) => x.id)).toEqual(['2']);
    expect(t.unreadOf('o/r#2').map((x) => x.id)).toEqual(['3']);
  });
});

describe('the words: specific only when the latest comment is proven new', () => {
  const thread = (reason: Thread['reason'], kind: Thread['kind'] = 'issue'): Thread => ({ id: '1', key: 'acme/web#42', repo: 'acme/web', number: 42, kind, title: 'Safari 白屏', reason, unread: true, updatedAt: 2000, commentUrl: 'c', apiUrl: 'a' });
  const cand = (reason: Thread['reason'], readComment = true, since = 1000): Candidate => ({ thread: thread(reason), readComment, since, sources: ['repo:acme/web'] });
  const comment = (author: string, body: string, createdAt = 1500) => ({ author, body, createdAt, htmlUrl: null });

  const rows: [string, Candidate, ReturnType<typeof comment> | null, string, string][] = [
    ['a new comment by someone else with @me', cand('mention'), comment('someone', '@user-1 这个是不是上周那个改动引起的？'), 'someone 在 acme/web#42 里 @了我', 'Safari 白屏 —「@user-1 这个是不是上周那个改动引起的？」'],
    ['@me written in another case', cand('comment'), comment('someone', 'cc @User-1'), 'someone 在 acme/web#42 里 @了我', 'Safari 白屏 —「cc @User-1」'],
    ['GitHub\'s reason still "mention", the new comment is a plain reply', cand('mention'), comment('other', '已经处理'), 'other 回复了 acme/web#42', 'Safari 白屏 —「已经处理」'],
    ['@user-10 is somebody else', cand('mention'), comment('other', 'ping @user-10'), 'other 回复了 acme/web#42', 'Safari 白屏 —「ping @user-10」'],
    ['an e-mail address is no mention', cand('comment'), comment('other', 'mail x@user-1.example'), 'other 回复了 acme/web#42', 'Safari 白屏 —「mail x@user-1.example」'],
    ['the comment is older than the time remembered (an older one became latest)', cand('mention', true, 1600), comment('someone', '@user-1 hi'), 'acme/web#42 有新动态', 'Safari 白屏 · 提到过我的'],
    ['the comment address did not change (an assignment changed the thread)', cand('assign', false), comment('someone', '@user-1 hi'), 'acme/web#42 有新动态', 'Safari 白屏 · 指派给我的'],
    ['the comment is the account\'s own', cand('comment'), comment('User-1', 'done'), 'acme/web#42 有新动态', 'Safari 白屏 · 我参与过的'],
    ['the comment could not be read', cand('review_requested'), null, 'acme/web#42 有新动态', 'Safari 白屏 · 请我 review 的 PR'],
    ['no comment, the account opened it', cand('author', false), null, 'acme/web#42 有新动态', 'Safari 白屏 · 我开的'],
    ['a quoted first line is skipped', cand('comment'), comment('other', '> 原话\n\n好的'), 'other 回复了 acme/web#42', 'Safari 白屏 —「好的」'],
  ];
  for (const [name, c, cm, title, body] of rows) it(name, () => expect(activityText(c, cm, ME)).toEqual({ title, body }));

  it('mentions(): the login exactly, not a prefix of a longer one', () => {
    expect(mentions('hi @user-1.', ME)).toBe(true);
    expect(mentions('(@user-1)', ME)).toBe(true);
    expect(mentions('@user-1x', ME)).toBe(false);
    expect(mentions('a/@user-1', ME)).toBe(false);
  });
});

describe('the two settings as saved', () => {
  it('reminding is on unless saved as false; marking read is off unless saved as true', () => {
    for (const v of [undefined, null, true, 'false', 0, {}]) expect(normalizeGithubActivity(v)).toBe(true);
    expect(normalizeGithubActivity(false)).toBe(false);
    for (const v of [undefined, null, false, 'true', 1, {}]) expect(normalizeGithubActivityMarkRead(v)).toBe(false);
    expect(normalizeGithubActivityMarkRead(true)).toBe(true);
  });
});

// =====================================================================================
// 2. the app: real sync rounds against the fake GitHub
// =====================================================================================

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
  return { c, alerts, clock, badgeGate, items: () => alerts.filter((a): a is Extract<Alert, { kind: 'item' }> => a.kind === 'item') };
}

async function tick(h: Harness) {
  h.clock.t += 60_000;
  await h.c.syncNow();
  await h.c.desktopSettled();
  await h.c.desktopSettled();
}

let seq = 100;
/** a thread of the fake's inbox (GitHub's shape); returns it to change later */
function thread(n: number, o: { reason?: string; at: number; comment?: number | null; unread?: boolean }) {
  const url = `${fake.api}/repos/${REPO}/issues/${n}`;
  const th = {
    id: String(seq++),
    unread: o.unread ?? true,
    reason: o.reason ?? 'mention',
    updated_at: iso(o.at),
    subject: { title: `issue ${n}`, url, latest_comment_url: o.comment ? `${fake.api}/repos/${REPO}/issues/comments/${o.comment}` : url, type: 'Issue' },
    repository: { full_name: REPO },
  };
  fake.state.inbox.threads.push(th);
  return th;
}
/** a new latest comment on a thread, written at `at` */
function comment(th: ReturnType<typeof thread>, id: number, author: string, body: string, at: number) {
  fake.state.inbox.comments.set(`/repos/${REPO}/issues/comments/${id}`, { id, user: { login: author }, created_at: iso(at), body, html_url: `${fake.web}/${REPO}/issues/1#issuecomment-${id}` });
  th.subject.latest_comment_url = `${fake.api}/repos/${REPO}/issues/comments/${id}`;
  th.updated_at = iso(at);
  th.unread = true;
}
const reqs = (op: string, from = 0) => fake.log.slice(from).filter((e) => e.operation === op);

describe('reminding of GitHub activity in real rounds', () => {
  beforeEach(async () => {
    fake = await startFakeGitHub();
    dir = tempDir();
    fake.state.inbox.threads = [];
    fake.state.inbox.comments.clear();
  });

  it('the inbox at start is history; a new @ reminds with who and where, a plain reply after it says "回复了", the same again says nothing', async () => {
    const old = thread(A, { at: FIXTURE_NOW - 3_600_000, comment: 1 });
    comment(old, 1, OTHER, `@${ME} old`, FIXTURE_NOW - 3_600_000);
    const h = await started({ sources: [REPO] });
    // did happen: the inbox was read, and nothing of it reminded
    expect(reqs('notifications').length).toBe(1);
    expect(h.items()).toEqual([]);

    comment(old, 2, OTHER, `@${ME} 这个是不是上周那个改动引起的？`, h.clock.t + 30_000);
    await tick(h);
    expect(h.items()).toHaveLength(1);
    expect(h.items()[0]).toMatchObject({ key: key(A), title: `${OTHER} 在 ${REPO}#${A} 里 @了我` });
    expect(h.items()[0].body).toContain(`@${ME} 这个是不是上周那个改动引起的？`);
    // on the board: the click opens the item in the app (the board's address)
    expect(h.items()[0].url).toBe(h.c.getBoardData().items.find((i) => i.key === key(A))!.url);

    comment(old, 3, 'third', '已经处理', h.clock.t + 30_000);
    await tick(h);
    expect(h.items().map((a) => a.title)).toEqual([`${OTHER} 在 ${REPO}#${A} 里 @了我`, `third 回复了 ${REPO}#${A}`]);

    // nothing changed on GitHub: the next round asks (a 304) and reminds of nothing
    const n = fake.log.length;
    await tick(h);
    expect(reqs('notifications', n).map((e) => e.status)).toEqual([304]);
    expect(h.items()).toHaveLength(2);
  });

  it('an assignment on a thread whose old @-comment did not change: "有新动态", and the old comment is not read again', async () => {
    const th = thread(A, { at: FIXTURE_NOW - 3_600_000, comment: 1 });
    comment(th, 1, OTHER, `@${ME} old`, FIXTURE_NOW - 3_600_000);
    const h = await started({ sources: [REPO] });
    th.updated_at = iso(h.clock.t + 30_000);
    th.reason = 'assign';
    const n = fake.log.length;
    await tick(h);
    expect(h.items().map((a) => [a.title, a.body])).toEqual([[`${REPO}#${A} 有新动态`, `issue ${A} · 指派给我的`]]);
    expect(reqs('comment', n)).toEqual([]);
  });

  it('only items in the data sources remind: a Project source reminds of its own items, not of the rest of their repository', async () => {
    const h = await started({ sources: ['https://github.com/orgs/GigleAI/projects/11'] });
    const inProject = thread(B, { at: h.clock.t + 30_000, comment: 11 });
    comment(inProject, 11, OTHER, `@${ME} on the board`, h.clock.t + 30_000);
    const outside = thread(OFF_BOARD, { at: h.clock.t + 30_000, comment: 12 });
    comment(outside, 12, OTHER, `@${ME} not on the board`, h.clock.t + 30_000);
    const n = fake.log.length;
    await tick(h);
    expect(h.items().map((a) => a.key)).toEqual([key(B)]);
    // the comment of the item outside every source is not even read
    expect(reqs('comment', n).map((e) => e.path)).toEqual([`/api/repos/${REPO}/issues/comments/11`]);
  });

  it('a repository not among the sources does not remind', async () => {
    const h = await started({ sources: [REPO] });
    const th = thread(A, { at: h.clock.t + 30_000 });
    th.repository.full_name = 'someone/else';
    th.subject.url = `${fake.api}/repos/someone/else/issues/${A}`;
    th.subject.latest_comment_url = th.subject.url;
    await tick(h);
    expect(reqs('notifications').length).toBeGreaterThanOrEqual(2);
    expect(h.items()).toEqual([]);
  });

  it('switched off: the inbox is not read at all; switched on again, its first read is a baseline', async () => {
    const h = await started({ sources: [REPO], seed: { githubActivity: false } });
    expect(h.c.getState().githubActivity).toBe(false);
    thread(A, { at: h.clock.t + 30_000 });
    await tick(h);
    expect(reqs('notifications')).toEqual([]);
    expect(h.items()).toEqual([]);
    h.c.setGithubActivity(true);
    await tick(h);
    // did happen: read now, and what was there already is history
    expect(reqs('notifications')).toHaveLength(1);
    expect(h.items()).toEqual([]);
    thread(C, { at: h.clock.t + 30_000 });
    await tick(h);
    expect(h.items().map((a) => a.key)).toEqual([key(C)]);
  });

  it('a read that fails (any page) reminds of nothing and remembers nothing: the next good round reminds', async () => {
    fake.state.restPageSize = 1;
    const h = await started({ sources: [REPO] });
    thread(A, { at: h.clock.t + 30_000 });
    thread(B, { at: h.clock.t + 20_000 });
    // the second page fails
    const page2 = (path: string) => path.startsWith('/api/notifications?') && path.includes('page=2');
    fake.state.answerOverride = (e) => (page2(e.path) ? { status: 502, body: { message: 'boom' } } : null);
    await tick(h);
    expect(fake.log.some((e) => page2(e.path) && e.status === 502)).toBe(true);
    expect(h.items()).toEqual([]);
    fake.state.answerOverride = null;
    await tick(h);
    expect(h.items().map((a) => a.key).sort()).toEqual([key(A), key(B)].sort());
  });

  it('GitHub refuses the inbox (a token that may not read it): said under the setting, nothing reminds, the pending reminders go on', async () => {
    fake.state.inbox.refuse = 403;
    const h = await started({ sources: [REPO] });
    expect(h.c.getState().githubActivityProblem).toContain('Resource not accessible by integration');
    const issue = fake.state.repos.get('gigleai/cavil-loop')!.find((i: any) => i.number === A);
    issue.labels = [...issue.labels, { name: 'pending/human' }];
    issue.updated_at = iso(h.clock.t + 1000);
    await tick(h);
    expect(h.items().map((a) => a.title)).toEqual([`待处理：${REPO}#${A}`]);
    // allowed again: the problem goes with the next good read
    fake.state.inbox.refuse = null;
    await tick(h);
    expect(h.c.getState().githubActivityProblem).toBeNull();
  });

  it('the same item newly pending and with new activity in one round: one notification, saying both', async () => {
    const h = await started({ sources: [REPO] });
    const th = thread(A, { at: h.clock.t + 30_000, comment: 21 });
    comment(th, 21, OTHER, `@${ME} 请看一下`, h.clock.t + 30_000);
    const issue = fake.state.repos.get('gigleai/cavil-loop')!.find((i: any) => i.number === A);
    issue.labels = [...issue.labels, { name: 'pending/human' }];
    issue.updated_at = iso(h.clock.t + 30_000);
    await tick(h);
    expect(h.items()).toHaveLength(1);
    expect(h.items()[0].title).toBe(`待处理：${REPO}#${A}`);
    expect(h.items()[0].body).toContain(`${OTHER} 在 ${REPO}#${A} 里 @了我`);
  });

  it('GitHub asks for a longer gap: the inbox is not asked again before it', async () => {
    fake.state.inbox.pollSecs = 300;
    const h = await started({ sources: [REPO] });
    await tick(h);
    await tick(h);
    expect(reqs('notifications')).toHaveLength(1);
    h.clock.t += 180_000;
    await tick(h);
    expect(reqs('notifications')).toHaveLength(2);
  });
});

describe('marking read on GitHub when an item is opened in the app', () => {
  beforeEach(async () => {
    fake = await startFakeGitHub();
    dir = tempDir();
    fake.state.inbox.threads = [];
    fake.state.inbox.comments.clear();
  });

  const look = async (h: Harness, n: number) => {
    h.c.onDesktopEvent({ kind: 'active' });
    h.c.showingItem(key(n));
    await h.c.activitySettled();
  };

  it('off by default: opening an item with an unread notification sends nothing to GitHub', async () => {
    const h = await started({ sources: [REPO] });
    thread(A, { at: h.clock.t + 30_000 });
    await tick(h);
    // did happen: it reminded, so the thread is known unread
    expect(h.items().map((a) => a.key)).toEqual([key(A)]);
    expect(h.c.getState().githubActivityMarkRead).toBe(false);
    await look(h, A);
    expect(reqs('markThreadRead')).toEqual([]);
  });

  it('on: exactly the opened item\'s threads are marked read, once; another item\'s stay unread', async () => {
    const h = await started({ sources: [REPO], seed: { githubActivityMarkRead: true } });
    const a = thread(A, { at: h.clock.t + 30_000 });
    const b = thread(B, { at: h.clock.t + 30_000 });
    await tick(h);
    await look(h, A);
    expect(reqs('markThreadRead').map((e) => [e.path, e.status])).toEqual([[`/api/notifications/threads/${a.id}`, 205]]);
    expect(a.unread).toBe(false);
    expect(b.unread).toBe(true);
    // opened again: already read, nothing more goes out
    await look(h, A);
    expect(reqs('markThreadRead')).toHaveLength(1);
  });

  it('on, the window not in front: nothing until it comes to the front with the item shown', async () => {
    const h = await started({ sources: [REPO], seed: { githubActivityMarkRead: true } });
    const a = thread(A, { at: h.clock.t + 30_000 });
    await tick(h);
    h.c.showingItem(key(A));
    await h.c.activitySettled();
    expect(reqs('markThreadRead')).toEqual([]);
    h.c.onDesktopEvent({ kind: 'active' });
    await h.c.activitySettled();
    expect(reqs('markThreadRead').map((e) => e.path)).toEqual([`/api/notifications/threads/${a.id}`]);
  });

  it('switched off before the item is opened, or the reminding switched off: nothing goes out', async () => {
    const h = await started({ sources: [REPO], seed: { githubActivityMarkRead: true } });
    thread(A, { at: h.clock.t + 30_000 });
    await tick(h);
    h.c.setGithubActivityMarkRead(false);
    await look(h, A);
    expect(reqs('markThreadRead')).toEqual([]);
    h.c.setGithubActivityMarkRead(true);
    h.c.setGithubActivity(false);
    h.c.showingItem(null);
    await look(h, A);
    expect(reqs('markThreadRead')).toEqual([]);
  });

  it('GitHub refuses marking read: said under the setting, nothing else changes; the next opening tries again', async () => {
    fake.state.inbox.refuseMark = 403;
    const h = await started({ sources: [REPO], seed: { githubActivityMarkRead: true } });
    const a = thread(A, { at: h.clock.t + 30_000 });
    await tick(h);
    await look(h, A);
    expect(reqs('markThreadRead').map((e) => e.status)).toEqual([403]);
    expect(h.c.getState().githubMarkReadProblem).toContain('Resource not accessible by integration');
    expect(a.unread).toBe(true);
    fake.state.inbox.refuseMark = null;
    h.c.showingItem(null);
    await look(h, A);
    expect(reqs('markThreadRead').map((e) => e.status)).toEqual([403, 205]);
    expect(h.c.getState().githubMarkReadProblem).toBeNull();
  });
});

describe('the inbox\'s timing and the sources changing around it (PR #719 code review round 1)', () => {
  beforeEach(async () => {
    fake = await startFakeGitHub();
    dir = tempDir();
    fake.state.inbox.threads = [];
    fake.state.inbox.comments.clear();
  });

  it('GitHub\'s interval in full: 50 s after a read nothing is asked, at 60 s it is', async () => {
    const h = await started({ sources: [REPO] });
    expect(reqs('notifications')).toHaveLength(1);
    h.clock.t += 50_000;
    await h.c.syncNow();
    expect(reqs('notifications')).toHaveLength(1);
    // did happen: that round itself ran (it read the repository)
    expect(fake.log.filter((e) => e.path.startsWith('/api/repos/gigleai/cavil-loop/issues?') || e.path.startsWith('/api/repos/GigleAI/cavil-loop/issues?')).length).toBeGreaterThan(1);
    h.clock.t += 10_000;
    await h.c.syncNow();
    expect(reqs('notifications')).toHaveLength(2);
  });

  it('a repository added after an item of it had activity: that activity is history; what comes after the addition reminds — removed and added again, likewise', async () => {
    const h = await started({ sources: ['https://github.com/orgs/GigleAI/projects/11'] });
    const t0 = h.clock.t;
    const th = thread(OFF_BOARD, { at: t0 + 10_000, comment: 31 });
    comment(th, 31, OTHER, `@${ME} before the repository was added`, t0 + 10_000);
    h.clock.t = t0 + 20_000;
    h.c.addSource(REPO);
    await h.c.settled();
    h.clock.t = t0 + 60_000;
    await h.c.syncNow();
    await h.c.desktopSettled();
    // did happen: the inbox was read with the repository in, and the thread was there
    expect(reqs('notifications').length).toBeGreaterThanOrEqual(2);
    expect(h.c.getState().sources.map((s) => s.key)).toContain('repo:gigleai/cavil-loop');
    expect(h.items()).toEqual([]);
    // after the addition: reminds
    comment(th, 32, OTHER, `@${ME} after`, t0 + 70_000);
    h.clock.t = t0 + 120_000;
    await h.c.syncNow();
    await h.c.desktopSettled();
    expect(h.items().map((a) => a.title)).toEqual([`${OTHER} 在 ${REPO}#${OFF_BOARD} 里 @了我`]);
    // removed, activity, added again, read: the activity of the gap is history
    h.c.removeSource('repo:gigleai/cavil-loop');
    comment(th, 33, OTHER, `@${ME} while removed`, t0 + 130_000);
    h.clock.t = t0 + 140_000;
    h.c.addSource(REPO);
    await h.c.settled();
    h.clock.t = t0 + 180_000;
    await h.c.syncNow();
    await h.c.desktopSettled();
    expect(h.items()).toHaveLength(1);
  });

  const midRead = async (remove: boolean, addBack = false) => {
    const h = await started({ sources: [REPO] });
    const th = thread(A, { at: h.clock.t + 30_000, comment: 41 });
    comment(th, 41, OTHER, 'a reply', h.clock.t + 30_000);
    const release = fake.hold('/issues/comments/41');
    h.clock.t += 60_000;
    const round = h.c.syncNow();
    await expect.poll(() => reqs('comment').length).toBeGreaterThan(0);
    if (remove) h.c.removeSource('repo:gigleai/cavil-loop');
    if (addBack) h.c.addSource(REPO);
    release();
    await round;
    await h.c.desktopSettled();
    await h.c.desktopSettled();
    return h;
  };

  it('the item\'s only source removed while its comment is being read: nothing goes out', async () => {
    const h = await midRead(true);
    expect(h.c.getState().sources).toEqual([]);
    expect(h.items()).toEqual([]);
  });

  it('the same round with the source kept: the reminder goes out', async () => {
    const h = await midRead(false);
    expect(h.items().map((a) => a.title)).toEqual([`${OTHER} 回复了 ${REPO}#${A}`]);
  });

  it('removed and added back while the comment is being read: the old reminder does not go out (another addition)', async () => {
    const h = await midRead(true, true);
    // did happen: the repository is a source again, and the comment was read
    expect(h.c.getState().sources.map((x) => x.key)).toEqual(['repo:gigleai/cavil-loop']);
    expect(reqs('comment').length).toBeGreaterThan(0);
    expect(h.items()).toEqual([]);
  });

  for (const skew of [300_000, -300_000]) {
    it(`this machine's clock ${skew > 0 ? 'ahead of' : 'behind'} GitHub's by 5 min: activity before a repository was added stays history, activity after it reminds`, async () => {
      const h = await started({ sources: ['https://github.com/orgs/GigleAI/projects/11'], skew });
      const t0 = h.clock.t;
      const th = thread(OFF_BOARD, { at: t0 + 10_000, comment: 51 });
      comment(th, 51, OTHER, `@${ME} before`, t0 + 10_000);
      h.clock.t = t0 + 20_000;
      h.c.addSource(REPO);
      await h.c.settled();
      h.clock.t = t0 + 60_000;
      await h.c.syncNow();
      await h.c.desktopSettled();
      expect(reqs('notifications').length).toBeGreaterThanOrEqual(2);
      expect(h.items()).toEqual([]);
      comment(th, 52, OTHER, `@${ME} after`, t0 + 70_000);
      h.clock.t = t0 + 120_000;
      await h.c.syncNow();
      await h.c.desktopSettled();
      expect(h.items().map((a) => a.title)).toEqual([`${OTHER} 在 ${REPO}#${OFF_BOARD} 里 @了我`]);
    });
  }

  it('removed and added back while the reminder waits its turn for the shell: it does not go out; left alone, it does', async () => {
    for (const readd of [true, false]) {
      fake.state.inbox.threads = [];
      const h = await started({ sources: [REPO] });
      thread(A, { at: h.clock.t + 30_000 });
      let open!: () => void;
      h.badgeGate.wait = new Promise<void>((r) => (open = r));
      // a badge call now holds the shell's queue; the round's reminder queues behind it
      h.c.onDesktopEvent({ kind: 'active' });
      h.clock.t += 60_000;
      await h.c.syncNow();
      expect(h.items()).toEqual([]);
      if (readd) {
        h.c.removeSource('repo:gigleai/cavil-loop');
        h.c.addSource(REPO);
      }
      open();
      await h.c.desktopSettled();
      await h.c.desktopSettled();
      expect(h.items().map((a) => a.key)).toEqual(readd ? [] : [key(A)]);
      h.c.stopTimer();
      await h.c.settled();
      await Promise.all(backends.splice(0).map((b) => b.close()));
      for (const c of caches.splice(0)) c.close();
      controllers.splice(0);
      dir = tempDir();
    }
  });
});
