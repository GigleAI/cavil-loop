// GitHub#490: every failed notice offers at most 「重试」 + one way out + ×, and what 「重试」 does follows how sure
// the outcome is. The controller against the fake GitHub over real HTTP, with the real back end (Rust) as a
// child process and a real SQLite file. Each case counts the requests GitHub actually got: a retry of a
// "not sure" outcome only reads; a retry of a refusal sends exactly once more. Every "nothing more was
// sent" assertion has a "this did go out" sibling.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, FakeGitHub, type LoggedRequest } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import { opActions, opLocked, opPhase, type OpRecord } from '../../src/shared/ops';
import { sendActions, sendTakeable, type SendRecord } from '../../src/shared/sends';
import { createActions } from '../../src/shared/noticeTone';
import type { CreateJob } from '../../src/shared/types';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const REPO = 'GigleAI/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;
const ISSUE = 138;
const DAEMON_TOKEN = 'gho_daemontoken0000000000000000000000';

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

async function ready() {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const endpoints = { api: fake.api, web: fake.web };
  const harness = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: () => FIXTURE_NOW, sleep: async () => {} });
  backends.push(harness);
  const c = await Controller.create({ backend: harness, endpoints, now: () => FIXTURE_NOW, defaultClientId: '', observeMs: 60_000, observeFirstMs: 60_000, opStuckMs: 600_000, opCheckDelaysMs: [], followUpSyncMs: 60_000 });
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

async function until(pred: () => boolean, what: string) {
  for (let i = 0; i < 3000; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout waiting for: ${what}`);
}
const idle = async (c: Controller) => {
  for (const j of [...((c as any).opJobs as Map<string, Promise<void>>).values()]) await j;
  for (const j of [...((c as any).sendJobs as Map<string, Promise<void>>).values()]) await j;
  await c.settled();
};
const opOf = (c: Controller, id: string): OpRecord => {
  const r = c.getState().ops.find((x) => x.id === id);
  if (!r) throw new Error(`no op ${id}`);
  return r;
};
const sendOf = (c: Controller, id: string): SendRecord => {
  const r = c.getState().sends.find((x) => x.id === id);
  if (!r) throw new Error(`no send ${id}`);
  return r;
};
const jobOf = (c: Controller): CreateJob | undefined => c.getState().creates[0];
const writes = (pred: (w: LoggedRequest) => boolean) => fake.writes().filter(pred);
const closes = (n = ISSUE) => writes((w) => w.method === 'PATCH' && w.path === `/api/repos/${REPO}/issues/${n}` && (w.body as any)?.state === 'closed');
const comments = (n = ISSUE) => writes((w) => w.method === 'POST' && w.path === `/api/repos/${REPO}/issues/${n}/comments`);
const creates = () => writes((w) => w.method === 'POST' && w.path === `/api/repos/${REPO}/issues`);
const labelAdds = (label: string, n = ISSUE) => writes((w) => w.method === 'POST' && w.path === `/api/repos/${REPO}/issues/${n}/labels` && ((w.body as any)?.labels ?? []).includes(label));
const commentsOnGitHub = (n = ISSUE) => fake.state.w.comments.get(`gigleai/cavil-loop#${n}`) ?? [];
const stateOnGitHub = (n = ISSUE): string => fake.state.repos.get('gigleai/cavil-loop')!.find((r: any) => r.number === n)?.state;
const isList = (e: LoggedRequest) => e.method === 'GET' && e.path.includes(`/repos/${REPO}/issues`) && e.path.includes('since=');
const reads = () => fake.log.filter((e) => e.method === 'GET' || (e.operation !== undefined && !fake.writes().includes(e))).length;

function openIssue(n: number) {
  for (const p of fake.state.projects.get('org/gigleai/11')!) for (const node of p.items.nodes) if (node.content?.number === n) Object.assign(node.content, { state: 'OPEN', stateReason: null });
  for (const r of fake.state.repos.get('gigleai/cavil-loop')!) if (r.number === n) Object.assign(r, { state: 'open', state_reason: null });
}
function waitingForHuman(n = ISSUE) {
  for (const p of fake.state.projects.get('org/gigleai/11')!)
    for (const node of p.items.nodes) if (node.content?.number === n && !node.content.labels.nodes.some((l: any) => l.name === 'pending/human')) node.content.labels.nodes.push({ name: 'pending/human', color: 'ededed' });
  for (const r of fake.state.repos.get('gigleai/cavil-loop')!) if (r.number === n && !r.labels.some((l: any) => l.name === 'pending/human')) r.labels.push({ name: 'pending/human', color: 'ededed' });
}

beforeEach(async () => {
  fake = await startFakeGitHub();
  fake.state.validTokens.add(DAEMON_TOKEN);
  fake.state.tokenViewers.set(DAEMON_TOKEN, 'loop-bot');
  dir = tempDir();
  openIssue(ISSUE);
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

describe('refused for sure: 「重试」 does it again with the same choices, no dialog', () => {
  it('close refused → retry = redo, fallback = handle on GitHub (copies the comment), ×; redo → exactly one more close and one comment, the old record gone', async () => {
    const c = await ready();
    fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'not_planned', comment: '不做了' });
    await idle(c);
    expect(closes()).toHaveLength(1);
    expect(comments()).toHaveLength(0);
    expect(opActions(opOf(c, s.id!))).toMatchObject({ retry: 'redo', fallback: 'handleWeb', close: true, toBox: true, copy: '不做了' });
    fake.state.w.readOnlyRepos.clear();
    const again = c.opRedo(s.id!);
    expect(again.ok).toBe(true);
    await idle(c);
    expect(closes()).toHaveLength(2);
    expect(comments()).toHaveLength(1);
    expect(stateOnGitHub()).toBe('closed');
    expect(commentsOnGitHub().map((x) => x.body)).toEqual(['不做了']);
    // the same choices: the reason and the comment went out with it
    expect((closes()[1].body as any).state_reason).toBe('not_planned');
    expect(c.getState().ops.find((x) => x.id === s.id)).toBeUndefined();
    // a record that is not a refusal is not done again from here
    expect(c.opRedo(again.id!).ok).toBe(false);
    expect(closes()).toHaveLength(2);
  });

  it('× of a refused close puts its comment back into the reply box (a refused reply the panel takes), sends nothing', async () => {
    const c = await ready();
    fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '原文 A' });
    await idle(c);
    expect(closes()).toHaveLength(1);
    const before = fake.writes().length;
    c.opClose(s.id!);
    await c.settled();
    expect(fake.writes().length).toBe(before);
    expect(c.getState().ops.find((x) => x.id === s.id)).toBeUndefined();
    const back = c.getState().sends.filter((r) => r.key === K(ISSUE));
    expect(back).toHaveLength(1);
    expect(back[0].action).toEqual({ kind: 'comment', key: K(ISSUE), body: '原文 A' });
    expect(sendTakeable(back[0])).toBe(true);
    expect(back[0].dismissed).toBe(true);
  });

  it('close went through, the attached comment was refused → 「再发评论」 sends exactly one comment as a reply', async () => {
    const c = await ready();
    fake.state.w.failComment = true;
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '关了，说一句' });
    await idle(c);
    expect(closes()).toHaveLength(1);
    expect(comments()).toHaveLength(1);
    expect(opPhase(opOf(c, s.id!))).toBe('settled');
    expect(opActions(opOf(c, s.id!))).toMatchObject({ retry: 'sendComment', fallback: 'handleWeb', close: true });
    fake.state.w.failComment = false;
    const r = c.opSendComment(s.id!);
    expect(r.ok).toBe(true);
    await idle(c);
    expect(comments()).toHaveLength(2);
    expect(closes()).toHaveLength(1);
    expect(commentsOnGitHub().map((x) => x.body)).toEqual(['关了，说一句']);
    expect(sendOf(c, r.id!).state).toBe('ok');
  });

  it('hand-back refused on its label → redo: the labels again, exactly once', async () => {
    waitingForHuman();
    const c = await ready();
    fake.state.w.failLabel = 'pending/agent';
    const s = c.startOp({ kind: 'handBack', key: K(ISSUE) });
    await idle(c);
    expect(labelAdds('pending/agent')).toHaveLength(1);
    expect(opActions(opOf(c, s.id!)).retry).toBe('redo');
    fake.state.w.failLabel = null;
    expect(c.opRedo(s.id!).ok).toBe(true);
    await idle(c);
    expect(labelAdds('pending/agent')).toHaveLength(2);
  });
});

describe('no answer: 「再查一次」 only reads, 「到 GitHub 上核对」 has two steps', () => {
  it('close answer lost → recheck + check on GitHub, no ×; the recheck sends nothing; opening the page unlocks nothing; the late close lands → recheck proves it', async () => {
    const c = await ready();
    const late = fake.lateWhen((e) => e.method === 'PATCH' && e.path === `/api/repos/${REPO}/issues/${ISSUE}`);
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '' });
    await idle(c);
    expect(late.caught()).toBe(1);
    expect(opPhase(opOf(c, s.id!))).toBe('unknown');
    expect(opActions(opOf(c, s.id!))).toMatchObject({ retry: 'recheck', fallback: 'checkWeb', close: false, webOpened: false });
    const w0 = fake.writes().length;
    const r0 = reads();
    expect((await c.opRecheck(s.id!)).ok).toBe(false);
    expect(fake.writes().length).toBe(w0);
    expect(reads()).toBeGreaterThan(r0);
    // the first step: the page opened — still locked, still no ×
    c.opWebOpened(s.id!);
    expect(opOf(c, s.id!).webOpened).toBe(true);
    expect(opLocked(opOf(c, s.id!))).toBe(true);
    expect(opActions(opOf(c, s.id!))).toMatchObject({ fallback: 'checkWeb', close: false, webOpened: true });
    // the old request lands while the person looks: the next check proves it, the lock goes by itself
    late.land();
    expect((await c.opRecheck(s.id!)).ok).toBe(true);
    await idle(c);
    expect(opLocked(opOf(c, s.id!))).toBe(false);
    expect(closes()).toHaveLength(1);
    expect(fake.writes().length).toBe(w0);
  });

  it('the second step unlocks locally: no request, × appears', async () => {
    const c = await ready();
    const late = fake.lateWhen((e) => e.method === 'PATCH' && e.path === `/api/repos/${REPO}/issues/${ISSUE}`);
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '附的' });
    await idle(c);
    expect(late.caught()).toBe(1);
    // the comment never went out (it waits for the close): copied by the fallback, never back to the reply box while locked
    expect(opActions(opOf(c, s.id!))).toMatchObject({ fallback: 'checkWeb', copy: '附的', close: false });
    c.opWebOpened(s.id!);
    const w0 = fake.writes().length;
    const all0 = fake.log.length;
    c.opUnlock(s.id!);
    await c.settled();
    expect(fake.writes().length).toBe(w0);
    expect(fake.log.length).toBe(all0);
    expect(opActions(opOf(c, s.id!)).close).toBe(true);
    late.stop();
  });
});

describe('a reply whose answer never came', () => {
  it('recheck + check on GitHub; no ×; the text stays only in the notice; the late comment lands → recheck proves it, exactly one on GitHub', async () => {
    const c = await ready();
    const late = fake.lateWhen((e) => e.method === 'POST' && e.path === `/api/repos/${REPO}/issues/${ISSUE}/comments`);
    const s = c.startSend({ kind: 'comment', key: K(ISSUE), body: '迟到的评论' });
    await idle(c);
    expect(late.caught()).toBe(1);
    expect(sendOf(c, s.id!).state).toBe('unknown');
    expect(sendActions(sendOf(c, s.id!))).toMatchObject({ retry: 'recheck', fallback: 'checkWeb', close: false, copy: '迟到的评论', webOpened: false });
    expect(sendTakeable(sendOf(c, s.id!))).toBe(false);
    c.sendWebOpened(s.id!);
    expect(sendActions(sendOf(c, s.id!))).toMatchObject({ webOpened: true, close: false });
    const w0 = fake.writes().length;
    expect((await c.sendRecheck(s.id!)).ok).toBe(false);
    expect(fake.writes().length).toBe(w0);
    late.land();
    expect((await c.sendRecheck(s.id!)).ok).toBe(true);
    expect(sendOf(c, s.id!).state).toBe('ok');
    expect(fake.writes().length).toBe(w0);
    expect(commentsOnGitHub().filter((x) => x.body === '迟到的评论')).toHaveLength(1);
  });

  it('refused for sure → 「再发一次」 + 「放回编辑框」, ×', async () => {
    const c = await ready();
    fake.state.w.failComment = true;
    const s = c.startSend({ kind: 'comment', key: K(ISSUE), body: '被拒的评论' });
    await idle(c);
    expect(comments()).toHaveLength(1);
    expect(sendActions(sendOf(c, s.id!))).toMatchObject({ retry: 'resend', fallback: 'toBox', close: true, copy: null });
  });
});

describe('a new issue', () => {
  it('not sure it was created: 「再查一次」 only reads; the request lands after the look; still not sure, never a second create', async () => {
    const c = await ready();
    const late = fake.lateWhen((e) => e.method === 'POST' && e.path === `/api/repos/${REPO}/issues`);
    await c.startCreate({ kind: 'createIssue', repo: REPO, title: '迟到的新建', body: '正文', labels: [], projects: [] });
    await until(() => late.caught() === 1 && jobOf(c)?.status === 'unknown' && jobOf(c)?.looking === false, 'unknown, first look over');
    const job = jobOf(c)!;
    expect(createActions(job)).toEqual({ retry: 'look', fallback: 'webList', close: true });
    expect(job.candidates).toEqual([]);
    const lists = () => fake.log.filter(isList).length;
    const l0 = lists();
    expect((await c.createLook(job.id)).ok).toBe(true);
    expect(lists()).toBe(l0 + 1);
    expect(jobOf(c)!.candidates).toEqual([]);
    // the original request lands only now: the next look shows it as a candidate, nothing more
    late.land();
    expect((await c.createLook(job.id)).ok).toBe(true);
    expect(jobOf(c)!.status).toBe('unknown');
    expect(jobOf(c)!.candidates!.length).toBe(1);
    expect(createActions(jobOf(c)!).retry).toBe('look');
    // "重试" of a not-sure create does not exist
    expect((await c.createRetry(job.id)).ok).toBe(false);
    expect(creates()).toHaveLength(1);
  });

  it('a look that fails leaves it not sure, nothing created', async () => {
    const c = await ready();
    const late = fake.lateWhen((e) => e.method === 'POST' && e.path === `/api/repos/${REPO}/issues`);
    await c.startCreate({ kind: 'createIssue', repo: REPO, title: '查不到', body: '', labels: [], projects: [] });
    await until(() => late.caught() === 1 && jobOf(c)?.looking === false, 'first look over');
    const release = fake.holdWhen(isList);
    const p = c.createLook(jobOf(c)!.id);
    await until(() => jobOf(c)?.looking === true, 'looking');
    await fake.close();
    release();
    const out = await p;
    expect(out.ok).toBe(false);
    expect(jobOf(c)!.status).toBe('unknown');
    expect(jobOf(c)!.lookError).toBeTruthy();
    expect(createActions(jobOf(c)!).retry).toBe('look');
    expect(creates()).toHaveLength(1);
    fake = await startFakeGitHub();
  });

  it('refused for sure: 「重试」 creates again from the same draft — exactly one more create', async () => {
    const c = await ready();
    fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
    await c.startCreate({ kind: 'createIssue', repo: REPO, title: '被拒的新建', body: '正文 B', labels: [], projects: [] });
    await until(() => jobOf(c)?.status === 'failed', 'refused');
    expect(creates()).toHaveLength(1);
    expect(createActions(jobOf(c)!)).toEqual({ retry: 'recreate', fallback: 'reopenDraft', close: true });
    fake.state.w.readOnlyRepos.clear();
    const id = jobOf(c)!.id;
    expect((await c.createRetry(id)).ok).toBe(true);
    await until(() => c.getState().creates.every((j) => j.status !== 'running'), 'created');
    expect(creates()).toHaveLength(2);
    expect((creates()[1].body as any).title).toBe('被拒的新建');
    expect((creates()[1].body as any).body).toBe('正文 B');
    expect(c.getState().creates.find((j) => j.id === id)).toBeUndefined();
  });
});
