// GitHub#299: changing the title of an issue / PR from the detail. The controller
// against the fake GitHub over real HTTP, the real back end (Rust) as a child
// process. For every refusal: GitHub received nothing (digest unchanged), next to a
// sibling case that really did write.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, FakeGitHub } from '../fake-github/server';
import { findCopies, gqlContent } from '../fake-github/writes';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import { TITLE_CHANGED } from '../../src/data/actions';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const REPO = 'GigleAI/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

async function ready() {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const endpoints = { api: fake.api, web: fake.web };
  const harness = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: () => FIXTURE_NOW, sleep: async () => {} });
  backends.push(harness);
  const c = await Controller.create({ backend: harness, endpoints, now: () => FIXTURE_NOW, defaultClientId: '', followUpSyncMs: 3_600_000 });
  controllers.push(c);
  c.addSource(PROJECT_URL);
  c.addSource(REPO);
  await c.start();
  await c.syncNow();
  expect(c.getState().phase).toBe('ready');
  return c;
}

const copies = (n: number) => findCopies(fake.state, REPO, n)!;
/** the title as GitHub holds it now */
const onGitHub = (n: number) => gqlContent(copies(n)).title as string;
/** change the title on GitHub (every copy), as someone on the web would */
function retitle(n: number, title: string) {
  const c = copies(n);
  for (const r of c.rest) r.title = title;
  for (const g of c.gql) g.title = title;
}
const boardTitle = (c: Controller, n: number) => c.getBoardData().items.find((i) => i.key === K(n))!.title;
const restWrites = () => fake.writes().map((w) => [w.method, w.path, w.body]);
const titleReads = () => fake.log.filter((l) => l.operation === 'CavilTitleSource').length;
function prNumber(): number {
  return fake.state.projects.get('org/gigleai/11')!.flatMap((p) => p.items.nodes).find((n) => n.content?.__typename === 'PullRequest')!.content.number as number;
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

describe('changing a title (GitHub#299)', () => {
  it('the detail says whether the account may change the item', async () => {
    const c = await ready();
    fake.state.w.cannotUpdate.add(gqlContent(copies(137)).id);
    const mine = await c.loadDetail(K(138));
    const theirs = await c.loadDetail(K(137));
    if (!mine.ok || !theirs.ok) throw new Error('detail');
    expect(mine.detail.canEdit).toBe(true);
    expect(theirs.detail.canEdit).toBe(false);
  });

  it('an issue: one PATCH with only the new title; the board and the detail show it at once', async () => {
    const c = await ready();
    const seen = boardTitle(c, 138);
    expect(onGitHub(138)).toBe(seen);
    const r = await c.act({ kind: 'editTitle', key: K(138), title: '  新标题：客户端能改标题了 ', seenTitle: seen });
    expect(r).toMatchObject({ ok: true, error: null, warning: null });
    // re-read first, then exactly one write carrying the trimmed title and nothing else
    expect(titleReads()).toBe(1);
    expect(restWrites()).toEqual([['PATCH', '/api/repos/GigleAI/cavil-loop/issues/138', { title: '新标题：客户端能改标题了' }]]);
    expect(onGitHub(138)).toBe('新标题：客户端能改标题了');
    // the touched item was read again: no sync round needed for the board to show it
    expect(boardTitle(c, 138)).toBe('新标题：客户端能改标题了');
    const d = await c.loadDetail(K(138));
    expect(d.ok && d.detail.title).toBe('新标题：客户端能改标题了');
  });

  it('a PR goes the same way (GitHub\'s issues endpoint changes both)', async () => {
    const n = prNumber();
    const c = await ready();
    const r = await c.act({ kind: 'editTitle', key: K(n), title: 'PR 的新标题', seenTitle: boardTitle(c, n) });
    expect(r).toMatchObject({ ok: true, warning: null });
    expect(restWrites()).toEqual([['PATCH', `/api/repos/GigleAI/cavil-loop/issues/${n}`, { title: 'PR 的新标题' }]]);
    expect(onGitHub(n)).toBe('PR 的新标题');
    expect(boardTitle(c, n)).toBe('PR 的新标题');
  });

  it('changed on the web while being edited: refused, nothing written, their title stays', async () => {
    const c = await ready();
    const seen = boardTitle(c, 138);
    retitle(138, '别人刚改的标题');
    const before = fake.digest();
    const r = await c.act({ kind: 'editTitle', key: K(138), title: '我的标题', seenTitle: seen });
    expect(r).toEqual({ ok: false, error: TITLE_CHANGED, warning: null });
    expect(titleReads()).toBe(1);
    expect(fake.writes()).toEqual([]);
    expect(fake.digest()).toBe(before);
    expect(onGitHub(138)).toBe('别人刚改的标题');
    // the sibling: started from what GitHub holds now, it is written
    expect((await c.act({ kind: 'editTitle', key: K(138), title: '我的标题', seenTitle: '别人刚改的标题' })).ok).toBe(true);
    expect(onGitHub(138)).toBe('我的标题');
  });

  it('no permission / empty / blank / unchanged / the re-read fails or misses a field: nothing written', async () => {
    const c = await ready();
    const seen = boardTitle(c, 138);
    const ro = boardTitle(c, 137);
    fake.state.w.cannotUpdate.add(gqlContent(copies(137)).id);
    const before = fake.digest();
    expect((await c.act({ kind: 'editTitle', key: K(137), title: 'x', seenTitle: ro })).error).toBe('GitHub 说你没有权限改这一条，没有修改');
    expect((await c.act({ kind: 'editTitle', key: K(138), title: '', seenTitle: seen })).error).toBe('标题不能为空，没有修改');
    expect((await c.act({ kind: 'editTitle', key: K(138), title: ' \t\n ', seenTitle: seen })).error).toBe('标题不能为空，没有修改');
    // the same title (also with only outer spaces added): done, nothing to write
    expect(await c.act({ kind: 'editTitle', key: K(138), title: ` ${seen} `, seenTitle: seen })).toMatchObject({ ok: true, warning: null });
    fake.state.w.failTitleSource = true;
    const failed = await c.act({ kind: 'editTitle', key: K(138), title: 'x', seenTitle: seen });
    expect(failed.ok).toBe(false);
    fake.state.w.failTitleSource = false;
    // an answer without the permission field (or the title) is "not known", never "may" / "unchanged"
    for (const drop of ['viewerCanUpdate', 'title'] as const) {
      fake.state.w.titleSourceDrop = drop;
      const missing = await c.act({ kind: 'editTitle', key: K(138), title: 'x', seenTitle: seen });
      expect(missing).toMatchObject({ ok: false, error: 'GitHub 拒绝了这次修改：GitHub 的回应缺少标题或权限，没有修改' });
    }
    fake.state.w.titleSourceDrop = null;
    expect(fake.writes()).toEqual([]);
    expect(fake.digest()).toBe(before);
    // the sibling that may be written is
    expect((await c.act({ kind: 'editTitle', key: K(138), title: 'x', seenTitle: seen })).ok).toBe(true);
    expect(restWrites()).toEqual([['PATCH', '/api/repos/GigleAI/cavil-loop/issues/138', { title: 'x' }]]);
  });

  it('GitHub keeps something else than what was sent: done, with a warning to check', async () => {
    const c = await ready();
    fake.state.w.titleKept = (t) => `${t}（改）`;
    const r = await c.act({ kind: 'editTitle', key: K(138), title: '新标题', seenTitle: boardTitle(c, 138) });
    expect(r).toMatchObject({ ok: true, warning: 'GitHub 返回的标题和要写的不一致，请刷新详情核对' });
    expect(boardTitle(c, 138)).toBe('新标题（改）');
  });

  it('two saves of one title at once: the second is refused at once, one write reaches GitHub', async () => {
    const c = await ready();
    const seen = boardTitle(c, 138);
    const [a, b] = await Promise.all([
      c.act({ kind: 'editTitle', key: K(138), title: 'one', seenTitle: seen }),
      c.act({ kind: 'editTitle', key: K(138), title: 'two', seenTitle: seen }),
    ]);
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, error: '这一条上一次修改还没完成，等它完成再试', warning: null });
    expect(restWrites()).toEqual([['PATCH', '/api/repos/GigleAI/cavil-loop/issues/138', { title: 'one' }]]);
  });
});
