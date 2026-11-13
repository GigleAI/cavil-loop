// GitHub#489: a reply, an edited body / comment / title and a ticked box are sent by the controller, not
// waited for by the panel. The controller against the fake GitHub over real HTTP, the real back end (Rust)
// as a child process and a real SQLite file. Every "nothing more was sent" assertion stands next to a "this
// did go out" one (the request reached GitHub, the comment is there).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller, SENDS_KEY } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, FakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import { sendButtons, sendClosable, sendHolds, sendKeepsText, sendNoticeText, sendShown, sendTakeable, sendTakeText, sendTone, type SendRecord } from '../../src/shared/sends';
import type { ItemDetail } from '../../src/shared/actions';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const REPO = 'GigleAI/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;
const ISSUE = 138;

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
  if (!c.getState().sources.length) {
    c.addSource(PROJECT_URL);
    c.addSource(REPO);
  }
  await c.start();
  await c.syncNow();
  expect(c.getState().phase).toBe('ready');
  return c;
}

const sendOf = (c: Controller, id: string): SendRecord => {
  const r = c.getState().sends.find((x) => x.id === id);
  if (!r) throw new Error(`no send ${id}`);
  return r;
};
/** every job of the controller is through (requests, re-reads, checks) */
const idle = async (c: Controller) => {
  for (let i = 0; i < 5; i++) for (const j of [...((c as any).sendJobs as Map<string, Promise<void>>).values()]) await j;
  await c.settled();
};
const posts = (n = ISSUE) => fake.writes().filter((w) => w.method === 'POST' && w.path === `/api/repos/${REPO}/issues/${n}/comments`);
const mutations = (op: string) => fake.writes().filter((w) => w.operation === op);
const titlePatches = (n = ISSUE) => fake.writes().filter((w) => w.method === 'PATCH' && w.path === `/api/repos/${REPO}/issues/${n}` && (w.body as any)?.title !== undefined);
const commentsOnGitHub = (n = ISSUE) => fake.state.w.comments.get(`gigleai/cavil-loop#${n}`) ?? [];
function commentOn(n: number, id: string, body: string) {
  const k = `gigleai/cavil-loop#${n}`;
  const list = fake.state.w.comments.get(k) ?? [];
  list.push({ id, url: `https://github.com/${REPO}/issues/${n}#issuecomment-${id}`, createdAt: '2026-11-01T00:00:00Z', bodyHTML: '', author: { login: 'user-1' }, body });
  fake.state.w.comments.set(k, list);
}
const sourceOf = (n: number, id: string) => fake.state.w.comments.get(`gigleai/cavil-loop#${n}`)!.find((c) => c.id === id)!.body!;
async function detailOf(c: Controller, n: number): Promise<ItemDetail> {
  const d = await c.loadDetail(K(n));
  if (!d.ok) throw new Error(d.error);
  return d.detail;
}
const storedSends = (): SendRecord[] | null => {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  return ((cache.loadSnapshots().get(SENDS_KEY) as any)?.sends ?? null) as SendRecord[] | null;
};
async function restart(c: Controller): Promise<Controller> {
  await idle(c);
  c.stopTimer();
  return ready();
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

describe('a reply', () => {
  it('startSend returns before GitHub answers; one request; green, then put away; the notice says nothing more', async () => {
    const c = await ready();
    const release = fake.hold(`/issues/${ISSUE}/comments`);
    const s = c.startSend({ kind: 'comment', key: K(ISSUE), body: '收到，马上看' });
    expect(s.ok).toBe(true);
    // on its way: blue, nothing to press, cannot be put away
    const r0 = sendOf(c, s.id!);
    expect(r0.state).toBe('sending');
    expect(sendTone(r0)).toBe('busy');
    expect(sendClosable(r0)).toBe(false);
    for (let i = 0; i < 300 && posts().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(posts()).toHaveLength(1);
    release();
    await idle(c);
    const r = sendOf(c, s.id!);
    expect(r).toMatchObject({ state: 'ok', warning: null });
    expect(sendTone(r)).toBe('ok');
    expect(sendNoticeText(r)).toBe('评论已发出');
    expect(sendButtons(r)).toEqual([]);
    expect(posts()).toHaveLength(1);
    expect(commentsOnGitHub().filter((x) => x.body === '收到，马上看')).toHaveLength(1);
    // the 5 s put it away: forgotten, also on disk
    c.sendDismiss(s.id!);
    await idle(c);
    expect(c.getState().sends).toEqual([]);
    expect(storedSends() ?? []).toEqual([]);
  });

  it('refused by GitHub: no comment there; the text is kept for the reply box, taken once, then offered no second send', async () => {
    const c = await ready();
    fake.state.w.failComment = true;
    const s = c.startSend({ kind: 'comment', key: K(ISSUE), body: '这段要放回去' });
    await idle(c);
    const r = sendOf(c, s.id!);
    expect(posts()).toHaveLength(1);
    expect(commentsOnGitHub().some((x) => x.body === '这段要放回去')).toBe(false);
    expect(r.state).toBe('refused');
    expect(sendTone(r)).toBe('error');
    expect(sendTakeable(r)).toBe(true);
    expect(sendButtons(r)).toEqual(['resend']);
    expect(sendClosable(r)).toBe(true);
    c.sendReturned(s.id!);
    const back = sendOf(c, s.id!);
    expect(sendTakeable(back)).toBe(false);
    // PR #510 review round 1: still kept by the record until it is sent again or leaves the box
    expect(sendKeepsText(back)).toBe(true);
    expect(sendButtons(back)).toEqual([]);
    expect(sendNoticeText(back)).toContain('原文已放回回复框');
    expect(posts()).toHaveLength(1);
  });

  it('refused, no panel took it: 「再发一次」 sends it once more and it goes through', async () => {
    const c = await ready();
    fake.state.w.failComment = true;
    const s = c.startSend({ kind: 'comment', key: K(ISSUE), body: '再来一次' });
    await idle(c);
    expect(sendOf(c, s.id!).state).toBe('refused');
    fake.state.w.failComment = false;
    expect(await c.sendResend(s.id!)).toMatchObject({ ok: true });
    await idle(c);
    expect(posts()).toHaveLength(2);
    expect(commentsOnGitHub().filter((x) => x.body === '再来一次')).toHaveLength(1);
    expect(sendOf(c, s.id!).state).toBe('ok');
  });

  it('answer lost, landing later: unknown, the text only in the notice, 「再查一次」 sends nothing; once it landed the check proves it — exactly one comment', async () => {
    const c = await ready();
    const late = fake.lateWhen((e) => e.method === 'POST' && e.path === `/api/repos/${REPO}/issues/${ISSUE}/comments`);
    const s = c.startSend({ kind: 'comment', key: K(ISSUE), body: '可能已经发出去了' });
    await idle(c);
    expect(late.caught()).toBe(1);
    let r = sendOf(c, s.id!);
    expect(r.state).toBe('unknown');
    expect(sendTakeable(r)).toBe(false);
    expect(sendKeepsText(r)).toBe(true);
    expect(sendClosable(r)).toBe(false);
    expect(sendHolds(r)).toBe(true);
    expect(sendButtons(r)).toEqual(['recheck', 'unlock']);
    expect(sendNoticeText(r)).toContain('没有放回编辑框');
    // the check made at once found nothing: still unknown, never "did not happen"
    expect(r.checks).toBe(1);
    expect(await c.sendRecheck(s.id!)).toMatchObject({ ok: false });
    expect(sendOf(c, s.id!).state).toBe('unknown');
    expect(posts()).toHaveLength(1);
    // it lands now; the next check proves it
    late.land();
    expect(commentsOnGitHub().filter((x) => x.body === '可能已经发出去了')).toHaveLength(1);
    expect(await c.sendRecheck(s.id!)).toMatchObject({ ok: true });
    await idle(c);
    r = sendOf(c, s.id!);
    expect(r.state).toBe('ok');
    expect(sendKeepsText(r)).toBe(false);
    expect(sendNoticeText(r)).toContain('在评论列表里找到了这条评论');
    expect(posts()).toHaveLength(1);
    expect(commentsOnGitHub().filter((x) => x.body === '可能已经发出去了')).toHaveLength(1);
  });

  it('a comment with the same text that was there before proves nothing', async () => {
    commentOn(ISSUE, 'IC_old', '同样的话');
    const c = await ready();
    const late = fake.lateWhen((e) => e.method === 'POST' && e.path === `/api/repos/${REPO}/issues/${ISSUE}/comments`);
    const s = c.startSend({ kind: 'comment', key: K(ISSUE), body: '同样的话' });
    await idle(c);
    expect(late.caught()).toBe(1);
    expect(await c.sendRecheck(s.id!)).toMatchObject({ ok: false });
    expect(sendOf(c, s.id!).state).toBe('unknown');
  });

  it('answer lost, then the app restarts: the record and its text are still there, still unknown; nothing is sent again', async () => {
    let c = await ready();
    const late = fake.lateWhen((e) => e.method === 'POST' && e.path === `/api/repos/${REPO}/issues/${ISSUE}/comments`);
    const s = c.startSend({ kind: 'comment', key: K(ISSUE), body: '重启后还在' });
    await idle(c);
    expect(late.caught()).toBe(1);
    expect(storedSends()?.find((x) => x.id === s.id)?.state).toBe('unknown');
    c = await restart(c);
    const r = sendOf(c, s.id!);
    expect(r.state).toBe('unknown');
    expect(sendKeepsText(r)).toBe(true);
    expect(sendShown(r)).toBe(true);
    expect(posts()).toHaveLength(1);
    // unlocked by a person: the text stays until × puts it away; nothing is sent
    c.sendUnlock(s.id!);
    const u = sendOf(c, s.id!);
    expect(sendHolds(u)).toBe(false);
    expect(sendKeepsText(u)).toBe(true);
    expect(sendClosable(u)).toBe(true);
    c.sendDismiss(s.id!);
    await idle(c);
    expect(c.getState().sends).toEqual([]);
    expect(posts()).toHaveLength(1);
  });

  it('refused at once when it cannot go out (empty, offline): no record, nothing sent', async () => {
    const c = await ready();
    expect(c.startSend({ kind: 'comment', key: K(ISSUE), body: '   ' })).toMatchObject({ ok: false, error: '评论是空的，没有发送' });
    expect(c.getState().sends).toEqual([]);
    expect(posts()).toHaveLength(0);
    // the sibling: a real one does go out
    c.startSend({ kind: 'comment', key: K(ISSUE), body: '真的' });
    await idle(c);
    expect(posts()).toHaveLength(1);
  });
});

describe('PR #510 review round 1', () => {
  it('a refused text back in the reply box survives a restart (the box is not on disk); once it left the box unsent it does not come back', async () => {
    let c = await ready();
    fake.state.w.failComment = true;
    const s = c.startSend({ kind: 'comment', key: K(ISSUE), body: '重启后还要能找回' });
    await idle(c);
    fake.state.w.failComment = false;
    // the panel took it back, and the notice was put away
    c.sendReturned(s.id!);
    c.sendDismiss(s.id!);
    await idle(c);
    expect(sendShown(sendOf(c, s.id!))).toBe(false);
    expect(storedSends()?.find((x) => x.id === s.id)).toMatchObject({ state: 'refused', returned: true });
    c = await restart(c);
    // offered to the reply box again
    expect(sendTakeable(sendOf(c, s.id!))).toBe(true);
    // taken again, then the box was emptied without sending it: let go, also after another restart
    c.sendReturned(s.id!);
    c.sendDropped(s.id!);
    await idle(c);
    expect(c.getState().sends.find((x) => x.id === s.id)).toBeUndefined();
    c = await restart(c);
    expect(c.getState().sends.find((x) => x.id === s.id)).toBeUndefined();
    expect(posts()).toHaveLength(1);
  });

  it('sent again from the box: the newer send takes the refused record over — gone once it went through, one comment', async () => {
    const c = await ready();
    fake.state.w.failComment = true;
    const s = c.startSend({ kind: 'comment', key: K(ISSUE), body: '第一版' });
    await idle(c);
    fake.state.w.failComment = false;
    c.sendReturned(s.id!);
    const again = c.startSend({ kind: 'comment', key: K(ISSUE), body: '前面加一句\n\n第一版' });
    expect(again.ok).toBe(true);
    await idle(c);
    expect(c.getState().sends.find((x) => x.id === s.id)).toBeUndefined();
    expect(sendOf(c, again.id!).state).toBe('ok');
    expect(commentsOnGitHub().filter((x) => (x.body ?? '').includes('第一版'))).toHaveLength(1);
  });

  it('the same text twice on one item: the second is refused while the first is not settled; another text goes out', async () => {
    const c = await ready();
    const release = fake.hold(`/issues/${ISSUE}/comments`);
    const a = c.startSend({ kind: 'comment', key: K(ISSUE), body: '同一句话' });
    expect(a.ok).toBe(true);
    expect(c.startSend({ kind: 'comment', key: K(ISSUE), body: '同一句话' })).toMatchObject({ ok: false, error: expect.stringContaining('同样的一段评论') });
    const b = c.startSend({ kind: 'comment', key: K(ISSUE), body: '另一句话' });
    expect(b.ok).toBe(true);
    release();
    await idle(c);
    expect(posts()).toHaveLength(2);
    expect(commentsOnGitHub().filter((x) => x.body === '同一句话')).toHaveLength(1);
    // settled: the same text may go again
    expect(c.startSend({ kind: 'comment', key: K(ISSUE), body: '同一句话' }).ok).toBe(true);
    await idle(c);
    expect(posts()).toHaveLength(3);
  });

  it('PR #510 review round 2: once unlocked, an unknown reply is no longer checked, and its same-text mark outlives every record — a later same-text reply that is not sure is never proven by another one\'s comment, also after a restart', async () => {
    let c = await ready();
    const lateA = fake.lateWhen((e) => e.method === 'POST' && e.path === `/api/repos/${REPO}/issues/${ISSUE}/comments`);
    const a = c.startSend({ kind: 'comment', key: K(ISSUE), body: '同文' });
    await idle(c);
    lateA.stop();
    expect(sendOf(c, a.id!).state).toBe('unknown');
    // still open: the same text is refused
    expect(c.startSend({ kind: 'comment', key: K(ISSUE), body: '同文' }).ok).toBe(false);
    // a person checked GitHub and unlocked it: no more checks of it, its text stays until ×
    c.sendUnlock(a.id!);
    expect(await c.sendRecheck(a.id!)).toMatchObject({ ok: false, error: expect.stringContaining('不再自动核对') });
    // the same text goes out again and is answered; its notice goes (as after the 5 s): its record is forgotten
    const b = c.startSend({ kind: 'comment', key: K(ISSUE), body: '同文' });
    await idle(c);
    expect(sendOf(c, b.id!).state).toBe('ok');
    c.sendDismiss(b.id!);
    c.sendDismiss(a.id!);
    await idle(c);
    expect(c.getState().sends.filter((x) => x.id === a.id || x.id === b.id)).toEqual([]);
    expect(commentsOnGitHub().filter((x) => x.body === '同文')).toHaveLength(1);
    // a restart in between: the mark is on disk
    c = await restart(c);
    // a third one of the same text whose answer is lost and that does not land
    const lateC = fake.lateWhen((e) => e.method === 'POST' && e.path === `/api/repos/${REPO}/issues/${ISSUE}/comments`);
    const third = c.startSend({ kind: 'comment', key: K(ISSUE), body: '同文' });
    await idle(c);
    lateC.stop();
    expect(sendOf(c, third.id!).state).toBe('unknown');
    // the first one's request lands now: a new same-text comment that is not the third one's — never taken as proof
    lateA.land();
    expect(commentsOnGitHub().filter((x) => x.body === '同文')).toHaveLength(2);
    expect(await c.sendRecheck(third.id!)).toMatchObject({ ok: false, error: expect.stringContaining('分不清') });
    expect(sendOf(c, third.id!).state).toBe('unknown');
    // the sibling: a reply of other text whose answer is lost and that lands is proven as before
    const lateD = fake.lateWhen((e) => e.method === 'POST' && e.path === `/api/repos/${REPO}/issues/${ISSUE}/comments`);
    const d = c.startSend({ kind: 'comment', key: K(ISSUE), body: '别的话' });
    await idle(c);
    lateD.stop();
    lateD.land();
    expect(await c.sendRecheck(d.id!)).toMatchObject({ ok: true });
    expect(posts()).toHaveLength(4);
  });

  it('PR #510 review round 2: an operation\'s attached comment that is not sure, unlocked by a person, marks its text too', async () => {
    let c = await ready();
    const late = fake.lateWhen((e) => e.method === 'POST' && e.path === `/api/repos/${REPO}/issues/${ISSUE}/comments`);
    const op = c.startOp({ kind: 'handBack', key: K(ISSUE), comment: '交回说明' });
    expect(op.ok).toBe(true);
    for (let i = 0; i < 500 && c.getState().ops.find((x) => x.id === op.id)?.steps[0].state !== 'unknown'; i++) await new Promise((r) => setTimeout(r, 10));
    late.stop();
    const r = c.getState().ops.find((x) => x.id === op.id)!;
    expect(r.steps[0]).toMatchObject({ name: 'comment', state: 'unknown' });
    // while it is not sure, a reply of the same text is refused
    expect(c.startSend({ kind: 'comment', key: K(ISSUE), body: '交回说明' }).ok).toBe(false);
    // (unlocking is offered once its own checks are through)
    for (let i = 0; i < 1000 && !c.getState().ops.find((x) => x.id === op.id)?.unlocked; i++) {
      c.opUnlock(op.id!);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(c.getState().ops.find((x) => x.id === op.id)?.unlocked).toBe(true);
    await idle(c);
    c = await restart(c);
    // a reply of the same text whose answer is lost; the operation's comment lands: not taken as the reply's
    const lateR = fake.lateWhen((e) => e.method === 'POST' && e.path === `/api/repos/${REPO}/issues/${ISSUE}/comments`);
    const s = c.startSend({ kind: 'comment', key: K(ISSUE), body: '交回说明' });
    expect(s.ok).toBe(true);
    await idle(c);
    lateR.stop();
    late.land();
    expect(commentsOnGitHub().filter((x) => x.body === '交回说明')).toHaveLength(1);
    expect(await c.sendRecheck(s.id!)).toMatchObject({ ok: false });
    expect(sendOf(c, s.id!).state).toBe('unknown');
  });

  it('PR #510 review round 2: a taken-back reply changed in the box comes back as changed after a restart; emptied, it is let go', async () => {
    let c = await ready();
    fake.state.w.failComment = true;
    const s = c.startSend({ kind: 'comment', key: K(ISSUE), body: 'abc' });
    await idle(c);
    fake.state.w.failComment = false;
    c.sendReturned(s.id!);
    // the person deletes a character in the box
    c.sendDraft(s.id!, 'ab');
    await new Promise((r) => setTimeout(r, 400));
    await idle(c);
    c = await restart(c);
    const back = sendOf(c, s.id!);
    expect(sendTakeable(back)).toBe(true);
    expect(sendTakeText(back)).toBe('ab');
    // an edited body likewise
    commentOn(ISSUE, 'IC_d', '原文');
    fake.state.w.comments.get(`gigleai/cavil-loop#${ISSUE}`)!.find((x) => x.id === 'IC_d')!.body = '原文';
    const e = c.startSend({ kind: 'editEntry', key: K(ISSUE), entryId: 'IC_d', body: '我的版本', seenSource: '别人看到的' });
    await idle(c);
    expect(sendOf(c, e.id!).state).toBe('refused');
    c.sendReturned(e.id!);
    c.sendDraft(e.id!, '我的版本，又改了一句');
    await new Promise((r) => setTimeout(r, 400));
    await idle(c);
    c = await restart(c);
    expect(sendTakeText(sendOf(c, e.id!))).toBe('我的版本，又改了一句');
    // emptied: let go
    c.sendReturned(s.id!);
    c.sendDropped(s.id!);
    c.sendDismiss(s.id!);
    await idle(c);
    expect(c.getState().sends.find((x) => x.id === s.id)).toBeUndefined();
    expect(posts()).toHaveLength(1);
  });

  it('an operation\'s attached comment and a reply of the same text are never in flight together', async () => {
    const c = await ready();
    const release = fake.hold(`/issues/${ISSUE}/comments`);
    expect(c.startSend({ kind: 'comment', key: K(ISSUE), body: '收尾说明' }).ok).toBe(true);
    // an operation carrying the same text is refused before anything goes out
    expect(c.startOp({ kind: 'handBack', key: K(ISSUE), comment: '收尾说明' })).toMatchObject({ ok: false, error: expect.stringContaining('同样的一段评论') });
    release();
    await idle(c);
    expect(posts()).toHaveLength(1);
  });
});

describe('an edited comment', () => {
  it('goes through: one write, the detail shows it, no notice left once it is put away', async () => {
    commentOn(ISSUE, 'IC_e', '原来的文字');
    const c = await ready();
    const e = (await detailOf(c, ISSUE)).timeline.find((x) => x.id === 'IC_e')!;
    const s = c.startSend({ kind: 'editEntry', key: K(ISSUE), entryId: 'IC_e', body: '改过的文字', seenSource: e.editSource! });
    await idle(c);
    expect(mutations('CavilUpdateComment')).toHaveLength(1);
    expect(sourceOf(ISSUE, 'IC_e')).toBe('改过的文字');
    expect(sendOf(c, s.id!).state).toBe('ok');
    expect(sendNoticeText(sendOf(c, s.id!))).toBe('正文 / 评论的修改已保存');
  });

  it('changed on the web meanwhile: refused, nothing written, the text kept for the editor', async () => {
    commentOn(ISSUE, 'IC_e', '原来的文字');
    const c = await ready();
    const e = (await detailOf(c, ISSUE)).timeline.find((x) => x.id === 'IC_e')!;
    fake.state.w.comments.get(`gigleai/cavil-loop#${ISSUE}`)!.find((x) => x.id === 'IC_e')!.body = '别人改的';
    const s = c.startSend({ kind: 'editEntry', key: K(ISSUE), entryId: 'IC_e', body: '我的文字', seenSource: e.editSource! });
    await idle(c);
    const r = sendOf(c, s.id!);
    expect(r.state).toBe('refused');
    expect(r.sentAt).toBeNull();
    expect(sendTakeable(r)).toBe(true);
    expect(mutations('CavilUpdateComment')).toHaveLength(0);
    expect(sourceOf(ISSUE, 'IC_e')).toBe('别人改的');
  });

  it('answer lost, not landed: unknown, another edit of it is refused at once; GitHub then holds it: the check proves it', async () => {
    commentOn(ISSUE, 'IC_e', '原来的文字');
    const c = await ready();
    const e = (await detailOf(c, ISSUE)).timeline.find((x) => x.id === 'IC_e')!;
    fake.state.w.dropWrites = true;
    const s = c.startSend({ kind: 'editEntry', key: K(ISSUE), entryId: 'IC_e', body: '新文字', seenSource: e.editSource! });
    await idle(c);
    fake.state.w.dropWrites = false;
    expect(sendOf(c, s.id!).state).toBe('unknown');
    expect(sourceOf(ISSUE, 'IC_e')).toBe('原来的文字');
    // a second change of the same comment would be overwritten by a late answer: refused, nothing sent
    expect(c.startSend({ kind: 'editEntry', key: K(ISSUE), entryId: 'IC_e', body: '再改', seenSource: '原来的文字' }).ok).toBe(false);
    expect((await c.act({ kind: 'editEntry', key: K(ISSUE), entryId: 'IC_e', body: '再改', seenSource: '原来的文字' })).ok).toBe(false);
    expect(await c.sendRecheck(s.id!)).toMatchObject({ ok: false });
    expect(sendOf(c, s.id!).state).toBe('unknown');
    // the request lands late (GitHub now holds it)
    fake.state.w.comments.get(`gigleai/cavil-loop#${ISSUE}`)!.find((x) => x.id === 'IC_e')!.body = '新文字';
    expect(await c.sendRecheck(s.id!)).toMatchObject({ ok: true });
    expect(sendOf(c, s.id!).state).toBe('ok');
    // the sibling: the same comment may be changed again now
    expect(c.startSend({ kind: 'editEntry', key: K(ISSUE), entryId: 'IC_e', body: '再改', seenSource: '新文字' }).ok).toBe(true);
    await idle(c);
    expect(sourceOf(ISSUE, 'IC_e')).toBe('再改');
  });
});

describe('a title', () => {
  it('goes through quietly (shown in its place): one PATCH, no notice', async () => {
    const c = await ready();
    const seen = (await detailOf(c, ISSUE)).title;
    const s = c.startSend({ kind: 'editTitle', key: K(ISSUE), title: ' 新标题 ', seenTitle: seen });
    expect(sendShown(sendOf(c, s.id!))).toBe(false);
    await idle(c);
    expect(titlePatches()).toHaveLength(1);
    expect(c.getState().sends.filter(sendShown)).toEqual([]);
    expect((await detailOf(c, ISSUE)).title).toBe('新标题');
  });

  it('refused (no write access): said in the notice, the title kept for its input box', async () => {
    const c = await ready();
    const seen = (await detailOf(c, ISSUE)).title;
    fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
    const s = c.startSend({ kind: 'editTitle', key: K(ISSUE), title: '改不了的标题', seenTitle: seen });
    await idle(c);
    const r = sendOf(c, s.id!);
    expect(r.state).toBe('refused');
    expect(sendShown(r)).toBe(true);
    expect(sendTakeable(r)).toBe(true);
    expect(sendNoticeText(r)).toContain('标题修改没有保存上');
  });

  it('answer lost, landed: the check made at once proves it, one PATCH', async () => {
    const c = await ready();
    const seen = (await detailOf(c, ISSUE)).title;
    const lost = fake.dropAnswerWhen((e) => e.method === 'PATCH' && e.path === `/api/repos/${REPO}/issues/${ISSUE}` && (e.body as any)?.title !== undefined);
    const s = c.startSend({ kind: 'editTitle', key: K(ISSUE), title: '丢了应答的标题', seenTitle: seen });
    await idle(c);
    expect(lost.caught()).toBe(1);
    const r = sendOf(c, s.id!);
    expect(r.state).toBe('ok');
    expect(r.reason).toBe('重读时 GitHub 上已是改后的标题');
    // proven after it was said as unknown: it says that it went through
    expect(sendShown(r)).toBe(true);
    expect(titlePatches()).toHaveLength(1);
  });
});

describe('a ticked box', () => {
  it('goes through quietly; refused when the text changed meanwhile (nothing written); lost and not landed: unknown', async () => {
    commentOn(ISSUE, 'IC_t', '- [ ] 第一项\n- [ ] 第二项');
    const c = await ready();
    const ok = c.startSend({ kind: 'toggleTask', key: K(ISSUE), entryId: 'IC_t', index: 0, checked: true, seenSource: '- [ ] 第一项\n- [ ] 第二项' });
    await idle(c);
    expect(sourceOf(ISSUE, 'IC_t')).toBe('- [x] 第一项\n- [ ] 第二项');
    expect(c.getState().sends.find((x) => x.id === ok.id)).toBeUndefined();
    // refused: the text is not what the click was made on
    const no = c.startSend({ kind: 'toggleTask', key: K(ISSUE), entryId: 'IC_t', index: 1, checked: true, seenSource: '- [ ] 第一项\n- [ ] 第二项' });
    await idle(c);
    expect(sendOf(c, no.id!).state).toBe('refused');
    expect(sendShown(sendOf(c, no.id!))).toBe(true);
    expect(sendTakeable(sendOf(c, no.id!))).toBe(false); // no text to give back
    expect(mutations('CavilUpdateComment')).toHaveLength(1);
    // lost
    fake.state.w.dropWrites = true;
    const lost = c.startSend({ kind: 'toggleTask', key: K(ISSUE), entryId: 'IC_t', index: 1, checked: true, seenSource: '- [x] 第一项\n- [ ] 第二项' });
    await idle(c);
    fake.state.w.dropWrites = false;
    const r = sendOf(c, lost.id!);
    expect(r.state).toBe('unknown');
    expect(sendShown(r)).toBe(true);
    expect(sendButtons(r)).toEqual(['recheck', 'unlock']);
    expect(sourceOf(ISSUE, 'IC_t')).toBe('- [x] 第一项\n- [ ] 第二项');
  });
});
