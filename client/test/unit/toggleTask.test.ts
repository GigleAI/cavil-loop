// GitHub#193: ticking a task-list box from the detail. The controller against
// the fake GitHub over real HTTP, the real back end (Rust) as a child process.
// For every case: exactly what GitHub received (or that it received nothing:
// digest unchanged), next to a sibling case that really did write.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, FakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import { TASK_CHANGED } from '../../src/data/actions';
import type { ItemDetail, TimelineEntry } from '../../src/shared/actions';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const REPO = 'GigleAI/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;

/** a choice question the way the worker templates write it */
const QUESTION = '## 方案\n\n**Q1: 换手机后怎么找回？**（默认 A）\n\n- [ ] **A. 导出文件** — 手动\n  - 好处：简单\n- [ ] **B. 云端** — 自动\n\n```\n- [ ] 代码块里的不是选项\n```\n\n不勾会怎样：按 A 走\n';

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

/** a comment with markdown source on #n (the fake renders it the way GitHub marks boxes) */
function commentOn(n: number, id: string, body: string) {
  const k = `gigleai/cavil-loop#${n}`;
  const list = fake.state.w.comments.get(k) ?? [];
  list.push({ id, url: `https://github.com/${REPO}/issues/${n}#issuecomment-${id}`, createdAt: '2026-11-01T00:00:00Z', bodyHTML: '', author: { login: 'bot' }, body });
  fake.state.w.comments.set(k, list);
}
const sourceOf = (n: number, id: string) => fake.state.w.comments.get(`gigleai/cavil-loop#${n}`)!.find((c) => c.id === id)!.body!;

async function detailOf(c: Controller, n: number): Promise<ItemDetail> {
  const d = await c.loadDetail(K(n));
  if (!d.ok) throw new Error(d.error);
  return d.detail;
}
const entry = (d: ItemDetail, id: string): TimelineEntry => d.timeline.find((e) => e.id === id)!;
const seen = (e: TimelineEntry) => (e.tasks?.clickable ? e.tasks.source : 'NOT CLICKABLE');
const writes = () => fake.writes().map((w) => [w.operation ?? w.method, w.variables ?? w.body]);
const sourceReads = () => fake.log.filter((l) => l.operation === 'CavilTaskSource').length;

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

describe('a comment: one box ticked, one character changed', () => {
  it('the detail says the boxes are clickable; tick A → one update with only that box changed; untick → back to the original', async () => {
    commentOn(138, 'IC_q1', QUESTION);
    const c = await ready();
    const e = entry(await detailOf(c, 138), 'IC_q1');
    expect(e.tasks).toEqual({ clickable: true, source: QUESTION });
    expect((e.bodyHtml.match(/task-list-item-checkbox/g) ?? []).length).toBe(2);

    const r = await c.act({ kind: 'toggleTask', key: K(138), entryId: 'IC_q1', index: 0, checked: true, seenSource: seen(e) });
    expect(r).toEqual({ ok: true, error: null, warning: null });
    const ticked = QUESTION.replace('- [ ] **A.', '- [x] **A.');
    expect(writes()).toEqual([['CavilUpdateComment', { id: 'IC_q1', body: ticked }]]);
    expect(sourceOf(138, 'IC_q1')).toBe(ticked);
    // the re-read shows it ticked; the code block's "- [ ]" was never a box and never changed
    const e2 = entry(await detailOf(c, 138), 'IC_q1');
    expect(e2.bodyHtml.match(/<input[^>]*>/g)!.map((t) => /checked/.test(t))).toEqual([true, false]);
    expect(sourceOf(138, 'IC_q1')).toContain('- [ ] 代码块里的不是选项');

    expect((await c.act({ kind: 'toggleTask', key: K(138), entryId: 'IC_q1', index: 0, checked: false, seenSource: seen(e2) })).ok).toBe(true);
    expect(sourceOf(138, 'IC_q1')).toBe(QUESTION);
    expect(fake.writes()).toHaveLength(2);
  });

  it('box B (the second one) changes B only', async () => {
    commentOn(138, 'IC_q1', QUESTION);
    const c = await ready();
    const e = entry(await detailOf(c, 138), 'IC_q1');
    expect((await c.act({ kind: 'toggleTask', key: K(138), entryId: 'IC_q1', index: 1, checked: true, seenSource: seen(e) })).ok).toBe(true);
    expect(sourceOf(138, 'IC_q1')).toBe(QUESTION.replace('- [ ] **B.', '- [x] **B.'));
  });
});

describe('the opening post of an issue and of a PR', () => {
  it('issue body → updateIssue; PR body → updatePullRequest; each with one character changed', async () => {
    fake.state.w.bodySources.set('gigleai/cavil-loop#138', QUESTION);
    const node = fake.state.projects.get('org/gigleai/11')!.flatMap((p) => p.items.nodes).find((n: any) => n.content?.__typename === 'PullRequest')!;
    const pr = node.content.number as number;
    fake.state.w.bodySources.set(`gigleai/cavil-loop#${pr}`, '- [x] done\n- [ ] todo\n');
    const c = await ready();

    const body = (await detailOf(c, 138)).timeline.at(-1)!;
    expect(body.kind).toBe('body');
    expect(body.tasks).toMatchObject({ clickable: true });
    expect((await c.act({ kind: 'toggleTask', key: K(138), entryId: body.id, index: 1, checked: true, seenSource: seen(body) })).ok).toBe(true);
    expect(fake.state.w.bodySources.get('gigleai/cavil-loop#138')).toBe(QUESTION.replace('- [ ] **B.', '- [x] **B.'));

    const prBody = (await detailOf(c, pr)).timeline.at(-1)!;
    expect(prBody.kind).toBe('body');
    expect((await c.act({ kind: 'toggleTask', key: K(pr), entryId: prBody.id, index: 0, checked: false, seenSource: seen(prBody) })).ok).toBe(true);
    expect(fake.state.w.bodySources.get(`gigleai/cavil-loop#${pr}`)).toBe('- [ ] done\n- [ ] todo\n');
    expect(writes().map((w) => w[0])).toEqual(['CavilUpdateIssueBody', 'CavilUpdatePrBody']);
  });
});

describe('nothing is written on a guess', () => {
  it('somebody changed the comment after it was shown: refused, nothing written, their text stays', async () => {
    commentOn(138, 'IC_q1', QUESTION);
    const c = await ready();
    const e = entry(await detailOf(c, 138), 'IC_q1');
    // edited on the web meanwhile (here: B ticked by someone else)
    const theirs = QUESTION.replace('- [ ] **B.', '- [x] **B.');
    fake.state.w.comments.get('gigleai/cavil-loop#138')!.find((x) => x.id === 'IC_q1')!.body = theirs;
    const before = fake.digest();
    const r = await c.act({ kind: 'toggleTask', key: K(138), entryId: 'IC_q1', index: 0, checked: true, seenSource: seen(e) });
    expect(r).toEqual({ ok: false, error: TASK_CHANGED, warning: null });
    expect(sourceReads()).toBe(1);
    expect(fake.writes()).toEqual([]);
    expect(fake.digest()).toBe(before);
    expect(sourceOf(138, 'IC_q1')).toBe(theirs);
  });

  it('the box is already in the state asked for: refused, nothing written', async () => {
    commentOn(138, 'IC_q1', QUESTION);
    const c = await ready();
    const e = entry(await detailOf(c, 138), 'IC_q1');
    const r = await c.act({ kind: 'toggleTask', key: K(138), entryId: 'IC_q1', index: 0, checked: false, seenSource: seen(e) });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(TASK_CHANGED);
    expect(fake.writes()).toEqual([]);
  });

  it('GitHub says this account may not change it: read-only in the detail; a write is refused after the fresh read', async () => {
    commentOn(138, 'IC_q1', QUESTION);
    commentOn(138, 'IC_ok', QUESTION);
    fake.state.w.cannotUpdate.add('IC_q1');
    const c = await ready();
    const d = await detailOf(c, 138);
    expect(entry(d, 'IC_q1').tasks).toEqual({ clickable: false, why: 'GitHub 说你没有权限改这一条，勾选框只读' });
    expect(entry(d, 'IC_ok').tasks).toMatchObject({ clickable: true });
    const before = fake.digest();
    const r = await c.act({ kind: 'toggleTask', key: K(138), entryId: 'IC_q1', index: 0, checked: true, seenSource: QUESTION });
    expect(r.error).toBe('GitHub 说你没有权限改这一条，没有修改');
    expect(fake.writes()).toEqual([]);
    expect(fake.digest()).toBe(before);
    // the sibling the account may change does go through
    expect((await c.act({ kind: 'toggleTask', key: K(138), entryId: 'IC_ok', index: 0, checked: true, seenSource: QUESTION })).ok).toBe(true);
    expect(fake.writes()).toHaveLength(1);
  });

  it('the fresh read fails (502): an error, nothing written — the old source is never written back on a guess', async () => {
    commentOn(138, 'IC_q1', QUESTION);
    const c = await ready();
    const e = entry(await detailOf(c, 138), 'IC_q1');
    fake.state.w.failTaskSource = true;
    const before = fake.digest();
    const r = await c.act({ kind: 'toggleTask', key: K(138), entryId: 'IC_q1', index: 0, checked: true, seenSource: seen(e) });
    expect(r.ok).toBe(false);
    expect(sourceReads()).toBe(1);
    expect(fake.writes()).toEqual([]);
    expect(fake.digest()).toBe(before);
    fake.state.w.failTaskSource = false;
    expect((await c.act({ kind: 'toggleTask', key: K(138), entryId: 'IC_q1', index: 0, checked: true, seenSource: seen(e) })).ok).toBe(true);
  });

  it('a comment of another item: refused, nothing written', async () => {
    commentOn(137, 'IC_other', QUESTION);
    const c = await ready();
    const r = await c.act({ kind: 'toggleTask', key: K(138), entryId: 'IC_other', index: 0, checked: true, seenSource: QUESTION });
    expect(r.error).toBe('这条评论不属于当前这一条，没有修改');
    expect(fake.writes()).toEqual([]);
    expect((await c.act({ kind: 'toggleTask', key: K(137), entryId: 'IC_other', index: 0, checked: true, seenSource: QUESTION })).ok).toBe(true);
  });

  it('two clicks on one comment at once: the second is refused at once, one read-change-write reaches GitHub', async () => {
    commentOn(138, 'IC_q1', QUESTION);
    const c = await ready();
    const e = entry(await detailOf(c, 138), 'IC_q1');
    const release = fake.holdWhen((l) => l.operation === 'CavilTaskSource');
    const first = c.act({ kind: 'toggleTask', key: K(138), entryId: 'IC_q1', index: 0, checked: true, seenSource: seen(e) });
    await expect.poll(() => sourceReads()).toBe(1);
    const second = await c.act({ kind: 'toggleTask', key: K(138), entryId: 'IC_q1', index: 1, checked: true, seenSource: seen(e) });
    expect(second).toEqual({ ok: false, error: '这一条上一次勾选还没完成，等它完成再点', warning: null });
    release();
    expect((await first).ok).toBe(true);
    expect(sourceReads()).toBe(1);
    expect(writes()).toEqual([['CavilUpdateComment', { id: 'IC_q1', body: QUESTION.replace('- [ ] **A.', '- [x] **A.') }]]);
    // once it is done, the next click on that comment goes through
    const e2 = entry(await detailOf(c, 138), 'IC_q1');
    expect((await c.act({ kind: 'toggleTask', key: K(138), entryId: 'IC_q1', index: 1, checked: true, seenSource: seen(e2) })).ok).toBe(true);
  });

  it('offline: refused before sending, nothing read or written', async () => {
    commentOn(138, 'IC_q1', QUESTION);
    const c = await ready();
    const e = entry(await detailOf(c, 138), 'IC_q1');
    fake.state.offline = true;
    await c.syncNow();
    expect(c.getState().sync.offline).toBe(true);
    const r = await c.act({ kind: 'toggleTask', key: K(138), entryId: 'IC_q1', index: 0, checked: true, seenSource: seen(e) });
    expect(r.ok).toBe(false);
    expect(sourceReads()).toBe(0);
    expect(fake.writes()).toEqual([]);
  });
});

describe('boxes in reviews stay read-only', () => {
  it('a review body with boxes: shown read-only with the reason', async () => {
    const node = fake.state.projects.get('org/gigleai/11')!.flatMap((p) => p.items.nodes).find((n: any) => n.content?.__typename === 'PullRequest')!;
    const pr = node.content.number as number;
    fake.state.w.reviews.set(`gigleai/cavil-loop#${pr}`, [
      {
        id: 'PRR_1',
        url: '',
        state: 'COMMENTED',
        submittedAt: '2026-11-01T00:00:00Z',
        createdAt: '2026-11-01T00:00:00Z',
        bodyHTML: '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" id="" disabled="" class="task-list-item-checkbox" aria-label="Incomplete task"> x</li></ul>',
        author: { login: 'r' },
        comments: { totalCount: 0, nodes: [] },
      },
    ]);
    const c = await ready();
    const r = entry(await detailOf(c, pr), 'PRR_1');
    expect(r.tasks).toEqual({ clickable: false, why: '评审意见里的勾选框只能在网页上勾' });
  });
});
