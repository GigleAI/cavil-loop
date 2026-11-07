// GitHub#205: editing a body / comment from the detail, and the "hand to the
// agent" / "autopilot" buttons. The controller against the fake GitHub over real
// HTTP, the real back end (Rust) as a child process. For every case: exactly
// what GitHub received (or that it received nothing: digest unchanged), next to
// a sibling case that really did write.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, FakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import { EDIT_CHANGED } from '../../src/data/actions';
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

describe('editing a body / comment (GitHub#205)', () => {
  it('the detail carries the source only where GitHub says the account may change it', async () => {
    commentOn(138, 'IC_mine', 'mine');
    commentOn(138, 'IC_theirs', 'theirs');
    fake.state.w.cannotUpdate.add('IC_theirs');
    const c = await ready();
    const d = await detailOf(c, 138);
    expect(entry(d, 'IC_mine').editSource).toBe('mine');
    expect(entry(d, 'IC_theirs').editSource).toBeUndefined();
  });

  it('a comment: one updateIssueComment with the whole new text; the detail shows it', async () => {
    commentOn(138, 'IC_e', '原来的文字');
    const c = await ready();
    const e = entry(await detailOf(c, 138), 'IC_e');
    const r = await c.act({ kind: 'editEntry', key: K(138), entryId: 'IC_e', body: '改过的文字\n\n第二段', seenSource: e.editSource! });
    expect(r).toMatchObject({ ok: true, warning: null });
    expect(writes()).toEqual([['CavilUpdateComment', { id: 'IC_e', body: '改过的文字\n\n第二段' }]]);
    expect(sourceOf(138, 'IC_e')).toBe('改过的文字\n\n第二段');
    expect(entry(await detailOf(c, 138), 'IC_e').editSource).toBe('改过的文字\n\n第二段');
  });

  it('the opening post of an issue → updateIssue', async () => {
    fake.state.w.bodySources.set('gigleai/cavil-loop#138', 'old body');
    const c = await ready();
    const body = (await detailOf(c, 138)).timeline.at(-1)!;
    expect(body).toMatchObject({ kind: 'body', editSource: 'old body' });
    expect((await c.act({ kind: 'editEntry', key: K(138), entryId: body.id, body: 'new body', seenSource: body.editSource! })).ok).toBe(true);
    expect(writes().map((w) => w[0])).toEqual(['CavilUpdateIssueBody']);
    expect(fake.state.w.bodySources.get('gigleai/cavil-loop#138')).toBe('new body');
  });

  it('changed on the web while being edited: refused, nothing written, their text stays', async () => {
    commentOn(138, 'IC_e', 'v1');
    const c = await ready();
    const e = entry(await detailOf(c, 138), 'IC_e');
    fake.state.w.comments.get('gigleai/cavil-loop#138')!.find((x) => x.id === 'IC_e')!.body = 'v2 (theirs)';
    const before = fake.digest();
    const r = await c.act({ kind: 'editEntry', key: K(138), entryId: 'IC_e', body: 'mine', seenSource: e.editSource! });
    expect(r).toEqual({ ok: false, error: EDIT_CHANGED, warning: null });
    expect(sourceReads()).toBe(1);
    expect(fake.writes()).toEqual([]);
    expect(fake.digest()).toBe(before);
    expect(sourceOf(138, 'IC_e')).toBe('v2 (theirs)');
  });

  it('no permission / another item\'s comment / an empty comment / the fresh read fails: refused, nothing written', async () => {
    commentOn(138, 'IC_ro', 'ro');
    commentOn(137, 'IC_other', 'other');
    commentOn(138, 'IC_e', 'text');
    fake.state.w.cannotUpdate.add('IC_ro');
    const c = await ready();
    const before = fake.digest();
    expect((await c.act({ kind: 'editEntry', key: K(138), entryId: 'IC_ro', body: 'x', seenSource: 'ro' })).error).toBe('GitHub 说你没有权限改这一条，没有修改');
    expect((await c.act({ kind: 'editEntry', key: K(138), entryId: 'IC_other', body: 'x', seenSource: 'other' })).error).toBe('这条评论不属于当前这一条，没有修改');
    expect((await c.act({ kind: 'editEntry', key: K(138), entryId: 'IC_e', body: '  \n', seenSource: 'text' })).error).toContain('评论不能改成空的');
    fake.state.w.failTaskSource = true;
    expect((await c.act({ kind: 'editEntry', key: K(138), entryId: 'IC_e', body: 'x', seenSource: 'text' })).ok).toBe(false);
    fake.state.w.failTaskSource = false;
    expect(fake.writes()).toEqual([]);
    expect(fake.digest()).toBe(before);
    // the sibling that may be written is
    expect((await c.act({ kind: 'editEntry', key: K(138), entryId: 'IC_e', body: 'x', seenSource: 'text' })).ok).toBe(true);
    expect(fake.writes()).toHaveLength(1);
  });

  it('two saves of one comment at once: the second is refused at once, one write reaches GitHub', async () => {
    commentOn(138, 'IC_e', 'text');
    const c = await ready();
    const [a, b] = await Promise.all([
      c.act({ kind: 'editEntry', key: K(138), entryId: 'IC_e', body: 'one', seenSource: 'text' }),
      c.act({ kind: 'editEntry', key: K(138), entryId: 'IC_e', body: 'two', seenSource: 'text' }),
    ]);
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, error: '这一条上一次修改还没完成，等它完成再试', warning: null });
    expect(writes()).toEqual([['CavilUpdateComment', { id: 'IC_e', body: 'one' }]]);
  });
});

describe('"hand to the agent" and "autopilot" (GitHub#205)', () => {
  const restWrites = () => fake.writes().map((w) => [w.method, w.path, w.body]);
  it('autopilot: the autopilot label first, then the agent label, then the human one off; names from Settings', async () => {
    const c = await ready();
    expect(c.getState().handBack).toEqual({ human: 'pending/human', agent: 'pending/agent', autopilot: 'autopilot' });
    expect((await c.act({ kind: 'autopilot', key: K(138) })).ok).toBe(true);
    expect(restWrites()).toEqual([
      ['POST', '/api/repos/GigleAI/cavil-loop/issues/138/labels', { labels: ['autopilot'] }],
      ['POST', '/api/repos/GigleAI/cavil-loop/issues/138/labels', { labels: ['pending/agent'] }],
      ['DELETE', '/api/repos/GigleAI/cavil-loop/issues/138/labels/pending%2Fhuman', undefined],
    ]);
    const labels = c.getBoardData().items.find((i) => i.key === K(138))!.labels.map((l) => l.name);
    expect(labels).toEqual(expect.arrayContaining(['autopilot', 'pending/agent']));
    expect(labels).not.toContain('pending/human');
    c.setHandBack({ autopilot: '  auto/merge ' });
    expect(c.getState().handBack.autopilot).toBe('auto/merge');
    expect((await c.act({ kind: 'autopilot', key: K(137) })).ok).toBe(true);
    expect(restWrites()[3]).toEqual(['POST', '/api/repos/GigleAI/cavil-loop/issues/137/labels', { labels: ['auto/merge'] }]);
  });

  it('an empty autopilot label: the setting keeps it empty (no button) and the action is refused before sending', async () => {
    const c = await ready();
    c.setHandBack({ autopilot: '' });
    expect(c.getState().handBack).toEqual({ human: 'pending/human', agent: 'pending/agent', autopilot: '' });
    // changing another name keeps it empty
    c.setHandBack({ agent: 'go' });
    expect(c.getState().handBack.autopilot).toBe('');
    const before = fake.digest();
    const r = await c.act({ kind: 'autopilot', key: K(138) });
    expect(r).toEqual({ ok: false, error: '设置里没有填托管标签，没有修改', warning: null });
    expect(fake.writes()).toEqual([]);
    expect(fake.digest()).toBe(before);
    // "hand to the agent" next to it still works
    expect((await c.act({ kind: 'handBack', key: K(138) })).ok).toBe(true);
    expect(fake.writes()).toHaveLength(2);
  });

  it('autopilot label added but the agent label refused: done with a warning that says it was not handed over', async () => {
    const c = await ready();
    fake.state.w.failLabel = 'pending/agent';
    const r = await c.act({ kind: 'autopilot', key: K(138) });
    expect(r.ok).toBe(true);
    expect(r.warning).toContain('已加上「autopilot」，但加「pending/agent」没有成功，还没有交给 agent');
  });
});
