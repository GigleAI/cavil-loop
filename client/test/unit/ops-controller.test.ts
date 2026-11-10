// GitHub#250: close an issue / PR, merge, autopilot and hand-back do not hold the dialog.
// The controller against the fake GitHub over real HTTP, with the real back end (Rust) as a
// child process and a real SQLite file. Every "nothing more was sent" assertion has a
// "this did go out" sibling (the first request reached GitHub, the daemon's step happened).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller, OPS_KEY } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, FakeGitHub, type LoggedRequest } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import { opAutoDismissable, opButtons, opDraftLeft, opLockOf, opPhase, opResendConfirm, opReusableDraft, opText, opTone, type OpRecord } from '../../src/shared/ops';
import type { Item } from '../../src/shared/types';

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

async function ready(opts: { opCheckDelaysMs?: number[]; opAutoMs?: number; opStuckMs?: number; fresh?: boolean; intercept?: (cmd: string, args: any) => unknown; followUpSyncMs?: number; afterRoundRead?: (dropped: boolean) => void } = {}) {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const endpoints = { api: fake.api, web: fake.web };
  const harness = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: () => FIXTURE_NOW, sleep: async () => {} });
  backends.push(harness);
  const backend = opts.intercept ? { call: async (cmd: string, args?: any) => ((await opts.intercept!(cmd, args)) as any) ?? harness.call(cmd, args) } : harness;
  const c = await Controller.create({ backend: backend as any, endpoints, now: () => FIXTURE_NOW, defaultClientId: '', observeMs: 60_000, observeFirstMs: 60_000, opStuckMs: opts.opStuckMs ?? 600_000,
    // GitHub#359: only the check made at once, unless a test asks for the later ones
    opCheckDelaysMs: opts.opCheckDelaysMs ?? [],
    ...(opts.opAutoMs !== undefined ? { opAutoMs: opts.opAutoMs } : {}),
    ...(opts.followUpSyncMs !== undefined ? { followUpSyncMs: opts.followUpSyncMs } : {}),
    ...(opts.afterRoundRead ? { afterRoundRead: opts.afterRoundRead } : {}) });
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

const itemOf = (c: Controller, n: number): Item => {
  const it = c.getBoardData().items.find((i) => i.key === K(n));
  if (!it) throw new Error(`#${n} not on the board`);
  return it;
};
const opOf = (c: Controller, id: string): OpRecord => {
  const r = c.getState().ops.find((x) => x.id === id);
  if (!r) throw new Error(`no op ${id}`);
  return r;
};
async function until(pred: () => boolean, what: string) {
  for (let i = 0; i < 1500; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for: ${what}`);
}
/** every job of the controller is through (requests, re-reads, evidence) */
const idle = async (c: Controller) => {
  for (const j of [...((c as any).opJobs as Map<string, Promise<void>>).values()]) await j;
  await c.settled();
};
const writes = (pred: (w: LoggedRequest) => boolean) => fake.writes().filter(pred);
const closes = (n = ISSUE) => writes((w) => w.method === 'PATCH' && w.path === `/api/repos/${REPO}/issues/${n}` && (w.body as any)?.state === 'closed');
const prCloses = (n: number) => writes((w) => w.method === 'PATCH' && w.path === `/api/repos/${REPO}/pulls/${n}`);
const comments = (n = ISSUE) => writes((w) => w.method === 'POST' && w.path === `/api/repos/${REPO}/issues/${n}/comments`);
const merges = (n: number) => writes((w) => w.method === 'PUT' && w.path === `/api/repos/${REPO}/pulls/${n}/merge`);
const labelAdds = (label: string, n = ISSUE) => writes((w) => w.method === 'POST' && w.path === `/api/repos/${REPO}/issues/${n}/labels` && ((w.body as any)?.labels ?? []).includes(label));
const labelRemoves = (label: string, n = ISSUE) => writes((w) => w.method === 'DELETE' && w.path === `/api/repos/${REPO}/issues/${n}/labels/${encodeURIComponent(label)}`);
/** every read of the item / the board (the one-item re-read and a sync round alike) */
const isRead = (e: LoggedRequest) => e.operation === 'CavilItemRefresh' || e.operation === 'CavilProjectItems' || (e.method === 'GET' && /\/issues(\?|$)/.test(e.path));
/** the comments GitHub holds on #n */
const commentsOnGitHub = (n = ISSUE) => fake.state.w.comments.get(`gigleai/cavil-loop#${n}`) ?? [];
const labelsOnGitHub = (n = ISSUE): string[] => (fake.state.repos.get('gigleai/cavil-loop')!.find((r: any) => r.number === n)?.labels ?? []).map((l: any) => l.name);
const stateOnGitHub = (n = ISSUE): string => fake.state.repos.get('gigleai/cavil-loop')!.find((r: any) => r.number === n)?.state;
/** the daemon (another account) picks the item up: takes "pending/agent" away, puts "doing/agent" on */
/** the same, in the very moment the write it follows was carried out (GitHub#359: before any read of the app can arrive) */
function daemonPicksUpNow(n = ISSUE) {
  fake.actAs('loop-bot', 'DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('pending/agent')}`);
  fake.actAs('loop-bot', 'POST', `/repos/${REPO}/issues/${n}/labels`, { labels: ['doing/agent'] });
}
async function daemonPicksUp(n = ISSUE) {
  const h = { authorization: `Bearer ${DAEMON_TOKEN}`, 'content-type': 'application/json' };
  expect((await fetch(`${fake.api}/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('pending/agent')}`, { method: 'DELETE', headers: h })).status).toBe(200);
  expect((await fetch(`${fake.api}/repos/${REPO}/issues/${n}/labels`, { method: 'POST', headers: h, body: JSON.stringify({ labels: ['doing/agent'] }) })).status).toBe(200);
}
/** somebody reopens #n on the web */
async function reopen(n = ISSUE) {
  const r = await fetch(`${fake.api}/repos/${REPO}/issues/${n}`, { method: 'PATCH', headers: { authorization: `Bearer ${DAEMON_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ state: 'open' }) });
  expect(r.status).toBe(200);
}
const storedOps = (): OpRecord[] | null => {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  return ((cache.loadSnapshots().get(OPS_KEY) as any)?.ops ?? null) as OpRecord[] | null;
};

function openIssue(n: number) {
  for (const p of fake.state.projects.get('org/gigleai/11')!) for (const node of p.items.nodes) if (node.content?.number === n) Object.assign(node.content, { state: 'OPEN', stateReason: null });
  for (const r of fake.state.repos.get('gigleai/cavil-loop')!) if (r.number === n) Object.assign(r, { state: 'open', state_reason: null });
}
function openPr(): number {
  const node = fake.state.projects.get('org/gigleai/11')!.flatMap((p) => p.items.nodes).find((n) => n.content?.__typename === 'PullRequest')!;
  const n = node.content.number as number;
  node.content.state = 'OPEN';
  node.content.merged = false;
  for (const r of fake.state.repos.get('gigleai/cavil-loop')!) if (r.number === n) Object.assign(r, { state: 'open', pull_request: { ...r.pull_request, merged_at: null } });
  return n;
}
/** #n carries "pending/human" on GitHub (every copy) */
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

describe('nothing waits for the answer any more', () => {
  it('startOp returns before GitHub answers; the answer shows before the re-read; the item stays locked until the re-read lands and shows it closed', async () => {
    const c = await ready();
    const holdClose = fake.hold(`/issues/${ISSUE}`);
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '做完了' });
    // returned at once (synchronously), with the operation on record
    expect(s.ok).toBe(true);
    const id = s.id!;
    expect(opPhase(opOf(c, id))).toBe('waiting');
    expect(opText(opOf(c, id))).toBe(`正在关闭 issue #${ISSUE}…`);
    await until(() => closes().length === 1, 'the close request reached GitHub');
    // the re-read is held now: the answers must show without it
    const holdRead = fake.holdWhen(isRead);
    holdClose();
    // answered and no longer running (code review round 1: the steps alone are set a moment before the run ends)
    await until(() => opOf(c, id).steps.every((x) => x.state === 'ok') && opPhase(opOf(c, id)) !== 'waiting', 'close and comment answered');
    expect(opText(opOf(c, id))).toBe(`issue #${ISSUE} 已关闭（已完成），评论已发出（正在等 GitHub 的最新状态）`);
    expect(opPhase(opOf(c, id))).toBe('settling');
    expect(opLockOf(c.getState().ops, K(ISSUE))?.id).toBe(id);
    // GitHub closed it, but the board has not read it back: a second close is refused, nothing sent
    const again = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '再关一次' });
    expect(again.ok).toBe(false);
    expect(again.error).toContain('上一次操作还没结清');
    holdRead();
    await idle(c);
    expect(opPhase(opOf(c, id))).toBe('settled');
    expect(itemOf(c, ISSUE).state).toBe('closed');
    expect(closes()).toHaveLength(1);
    expect(comments()).toHaveLength(1);
    expect(commentsOnGitHub().map((x) => x.body)).toEqual(['做完了']);
    // done: the draft is gone, the notice can be put away and then the record is forgotten
    expect(opDraftLeft(opOf(c, id))).toBeNull();
    c.opDismiss(id);
    expect(c.getState().ops.find((x) => x.id === id)).toBeUndefined();
  });

  it('a reply and a label change go out while the close waits (they do not conflict)', async () => {
    const c = await ready();
    const holdClose = fake.holdWhen((e) => e.method === 'PATCH' && e.path === `/api/repos/${REPO}/issues/${ISSUE}`);
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '' });
    await until(() => closes().length === 1, 'close sent');
    expect((await c.act({ kind: 'comment', key: K(ISSUE), body: '顺便说一句' })).ok).toBe(true);
    expect(comments()).toHaveLength(1);
    holdClose();
    await idle(c);
    expect(opPhase(opOf(c, s.id!))).toBe('settled');
  });

  it('the gate is the one entry: act, startOp and a second click are refused while one is waiting; hand-back and autopilot too', async () => {
    const c = await ready();
    const hold = fake.hold(`/issues/${ISSUE}`);
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '做完了' });
    expect(s.ok).toBe(true);
    for (const a of [
      { kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: 'x' },
      { kind: 'handBack', key: K(ISSUE) },
      { kind: 'autopilot', key: K(ISSUE) },
    ] as const) {
      expect(c.startOp(a as any).ok).toBe(false);
      expect((await c.act(a as any)).ok).toBe(false);
    }
    await until(() => closes().length === 1, 'the first close reached GitHub');
    hold();
    await idle(c);
    expect(closes()).toHaveLength(1);
    expect(comments()).toHaveLength(1);
    expect(labelAdds('pending/agent')).toHaveLength(0);
  });
});

describe('the lock lives in the controller, not in a panel (plan review round 1)', () => {
  it('held close answer: a new startOp (what a re-opened panel sends) is refused; released: one close, one comment', async () => {
    const c = await ready();
    const hold = fake.hold(`/issues/${ISSUE}`);
    const first = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '做完了' });
    await until(() => closes().length === 1, 'close sent');
    // a re-opened panel has nothing of its own: the lock is the controller's record
    expect(opLockOf(c.getState().ops, K(ISSUE))?.id).toBe(first.id);
    expect(c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '做完了' }).ok).toBe(false);
    hold();
    await idle(c);
    expect(closes()).toHaveLength(1);
    expect(comments()).toHaveLength(1);
  });
});

describe('first step refused: settled at once, later steps never sent, draft kept and restorable', () => {
  it('close issue refused: one PATCH, no comment; unlocked; the reason and the comment are kept; a new close takes the draft', async () => {
    const c = await ready();
    fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'not_planned', comment: '不做了' });
    await idle(c);
    const r = opOf(c, s.id!);
    expect(closes()).toHaveLength(1);
    expect(comments()).toHaveLength(0);
    expect(r.steps.map((x) => x.state)).toEqual(['refused', 'unsent']);
    expect(opPhase(r)).toBe('settled');
    expect(opText(r)).toContain(`没有关闭 issue #${ISSUE}：没有权限`);
    expect(opDraftLeft(r)).toEqual({ reason: 'not_planned', comment: '不做了' });
    expect(opButtons(r)).toEqual(expect.arrayContaining(['retry', 'copy', 'toReply', 'dropDraft', 'dismiss']));
    // settling never deletes the draft: put away, it is still there (and on disk)
    c.opDismiss(s.id!);
    expect(opDraftLeft(opOf(c, s.id!))).toEqual({ reason: 'not_planned', comment: '不做了' });
    await c.settled();
    expect(storedOps()?.find((x) => x.id === s.id)?.draft).toEqual({ reason: 'not_planned', comment: '不做了' });
    // "重新关闭": the draft moves to the new operation, which goes out like any other
    fake.state.w.readOnlyRepos.clear();
    const again = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'not_planned', comment: '不做了' }, { from: s.id });
    expect(again.ok).toBe(true);
    await idle(c);
    expect(closes()).toHaveLength(2);
    expect(comments()).toHaveLength(1);
    expect(stateOnGitHub()).toBe('closed');
    expect(opDraftLeft(opOf(c, again.id!))).toBeNull();
    // the old record handed its draft on: nothing of it is left
    expect(c.getState().ops.find((x) => x.id === s.id)).toBeUndefined();
  });

  it('close PR, merge, autopilot and hand-back refused on their first step: that request reached GitHub, nothing after it, unlocked', async () => {
    const pr = openPr();
    const c = await ready();
    const headOid = (await c.loadDetail(K(pr))).ok ? ((await c.loadDetail(K(pr))) as any).detail.pr.headOid : '';
    const cases: [any, () => number, () => number][] = [];
    fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
    cases.push([{ kind: 'closePr', key: K(pr), comment: '不合了' }, () => prCloses(pr).length, () => comments(pr).length]);
    for (const [a, sent, after] of cases) {
      const s = c.startOp(a);
      await idle(c);
      expect(sent()).toBe(1);
      expect(after()).toBe(0);
      expect(opPhase(opOf(c, s.id!))).toBe('settled');
      expect(opButtons(opOf(c, s.id!))).toContain('retry');
    }
    fake.state.w.readOnlyRepos.clear();
    fake.state.w.pulls.get(`gigleai/cavil-loop#${pr}`)!.mergeRefusal = { status: 405, message: 'Required status check is failing' };
    const m = c.startOp({ kind: 'merge', key: K(pr), method: 'squash', headOid });
    await idle(c);
    expect(merges(pr)).toHaveLength(1);
    expect(opPhase(opOf(c, m.id!))).toBe('settled');
    expect(opDraftLeft(opOf(c, m.id!))).toEqual({ method: 'squash', headOid });
    waitingForHuman();
    fake.state.w.failLabel = 'autopilot';
    const a = c.startOp({ kind: 'autopilot', key: K(ISSUE) });
    await idle(c);
    expect(labelAdds('autopilot')).toHaveLength(1);
    expect(labelAdds('pending/agent')).toHaveLength(0);
    expect(labelRemoves('pending/human')).toHaveLength(0);
    expect(opPhase(opOf(c, a.id!))).toBe('settled');
    fake.state.w.failLabel = 'pending/agent';
    const h = c.startOp({ kind: 'handBack', key: K(ISSUE) });
    await idle(c);
    expect(labelAdds('pending/agent')).toHaveLength(1);
    expect(labelRemoves('pending/human')).toHaveLength(0);
    expect(opPhase(opOf(c, h.id!))).toBe('settled');
    expect(opButtons(opOf(c, h.id!))).toContain('retry');
  });
});

describe('an answer that never came stays unknown: a read showing the old state does not unlock (plan review round 2)', () => {
  it('close accepted but landing late: the client gives up, the re-read shows it open, no second close from anywhere; once it lands the re-read proves it; the comment is never sent after', async () => {
    const c = await ready();
    const late = fake.lateWhen((e) => e.method === 'PATCH' && e.path === `/api/repos/${REPO}/issues/${ISSUE}`);
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '做完了' });
    await idle(c);
    // the close request did reach GitHub
    expect(late.caught()).toBe(1);
    let r = opOf(c, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['unknown', 'unsent']);
    expect(opText(r)).toContain(`不确定 issue #${ISSUE} 有没有关上`);
    // the re-read (and the evidence check) saw it open: still unknown, still locked
    expect(itemOf(c, ISSUE).state).toBe('open');
    expect(opPhase(r)).toBe('unknown');
    expect(opButtons(r)).toEqual(expect.arrayContaining(['unlock', 'copy', 'toReply']));
    // GitHub#359: a close is only checked, never offered for a second send
    expect(opButtons(r)).not.toContain('resend');
    expect(opButtons(r)).not.toContain('retry');
    expect(c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '做完了' }).ok).toBe(false);
    expect((await c.act({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '做完了' })).ok).toBe(false);
    expect((await c.opRecheck(s.id!)).ok).toBe(false);
    expect(opPhase(opOf(c, s.id!))).toBe('unknown');
    // now the old request lands
    late.land();
    expect(stateOnGitHub()).toBe('closed');
    expect((await c.opRecheck(s.id!)).ok).toBe(true);
    await idle(c);
    r = opOf(c, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'unsent']);
    expect(opPhase(r)).toBe('settled');
    expect(opText(r)).toContain('附的评论没有发出（关闭的应答丢了，没敢接着发）');
    expect(closes()).toHaveLength(1);
    expect(comments()).toHaveLength(0);
    // the comment is kept: it may be put into the reply box (it surely did not go out)
    expect(opDraftLeft(r)).toEqual({ comment: '做完了' });
    expect(opButtons(r)).toEqual(expect.arrayContaining(['copy', 'toReply', 'dropDraft']));
  });

  it('merge accepted but landing late: no second merge until it is proven; the proof is the re-read showing it merged', async () => {
    const pr = openPr();
    const c = await ready();
    const d = await c.loadDetail(K(pr));
    const headOid = d.ok ? d.detail.pr!.headOid : '';
    const late = fake.lateWhen((e) => e.method === 'PUT' && e.path.endsWith(`/pulls/${pr}/merge`));
    const s = c.startOp({ kind: 'merge', key: K(pr), method: 'merge', headOid });
    await idle(c);
    expect(late.caught()).toBe(1);
    expect(opPhase(opOf(c, s.id!))).toBe('unknown');
    expect(c.startOp({ kind: 'merge', key: K(pr), method: 'merge', headOid }).ok).toBe(false);
    late.land();
    await c.opRecheck(s.id!);
    await idle(c);
    expect(opPhase(opOf(c, s.id!))).toBe('settled');
    expect(merges(pr)).toHaveLength(1);
    expect(itemOf(c, pr).state).toBe('merged');
  });

  it('the comment went out but its answer was lost: "not sure", only "copy"; the comment list proves it; one comment on GitHub', async () => {
    const c = await ready();
    const lost = fake.dropAnswerWhen((e) => e.method === 'POST' && e.path.endsWith(`/issues/${ISSUE}/comments`));
    // the list is unreadable once the requests went out (the read made before them worked)
    const holdClose = fake.holdWhen((e) => e.method === 'PATCH' && e.path === `/api/repos/${REPO}/issues/${ISSUE}`);
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '做完了' });
    await until(() => closes().length === 1, 'close sent (after the read of what was there)');
    expect(opOf(c, s.id!).before).toMatchObject({ comments: [], events: [] });
    fake.state.w.failCommentList = true;
    holdClose();
    await idle(c);
    expect(lost.caught()).toBe(1);
    let r = opOf(c, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'unknown']);
    expect(opText(r)).toContain('附的评论不确定有没有发出');
    expect(opButtons(r)).toContain('copy');
    expect(opButtons(r)).not.toContain('toReply');
    expect(opPhase(r)).toBe('unknown');
    fake.state.w.failCommentList = false;
    expect((await c.opRecheck(s.id!)).ok).toBe(true);
    r = opOf(c, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'ok']);
    expect(opPhase(r)).toBe('settled');
    expect(opDraftLeft(r)).toBeNull();
    expect(commentsOnGitHub().map((x) => x.body)).toEqual(['做完了']);
    expect(comments()).toHaveLength(1);
  });
});

describe('the "agent" label is consumed by the daemon: never added twice (plan review rounds 2 and 3)', () => {
  it('autopilot: label added; agent label landed but answer lost; daemon took it; events unreadable while the item re-read works — every entry refused, then the events prove it', async () => {
    waitingForHuman();
    const c = await ready();
    // GitHub#359: a read showing the label on would prove the step — here the daemon is faster than every read of ours
    const lost = fake.dropAnswerWhen((e) => e.method === 'POST' && e.path.endsWith(`/issues/${ISSUE}/labels`) && ((e.body as any)?.labels ?? []).includes('pending/agent'), () => daemonPicksUpNow());
    // the events become unreadable once the first request went out (the read made before it worked)
    const holdFirst = fake.holdWhen((e) => e.method === 'POST' && e.path.endsWith(`/issues/${ISSUE}/labels`) && ((e.body as any)?.labels ?? []).includes('autopilot'));
    // the daemon picks it up as soon as the label is on GitHub, before any re-read of ours
    const s = c.startOp({ kind: 'autopilot', key: K(ISSUE) });
    await until(() => labelAdds('autopilot').length === 1, 'the autopilot label reached GitHub');
    expect(opOf(c, s.id!).before).not.toBeNull();
    fake.state.w.failEvents = true;
    holdFirst();
    await until(() => lost.caught() === 1, 'the agent label reached GitHub');
    lost.stop();
    await idle(c);
    // it happened: the first add went out, the daemon took the label and put its own on
    expect(labelAdds('pending/agent')).toHaveLength(1);
    expect(labelsOnGitHub()).toEqual(expect.arrayContaining(['autopilot', 'doing/agent']));
    expect(labelsOnGitHub()).not.toContain('pending/agent');
    let r = opOf(c, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'unknown', 'unsent']);
    // the item was re-read after the answers, and it landed: still locked
    expect(r.readAt).not.toBeNull();
    expect(opPhase(r)).toBe('unknown');
    expect(opButtons(r)).not.toContain('finish');
    expect(opButtons(r)).not.toContain('retry');
    // every entry: what a re-opened panel would send, the board, act
    expect(c.startOp({ kind: 'handBack', key: K(ISSUE) }).ok).toBe(false);
    expect(c.startOp({ kind: 'autopilot', key: K(ISSUE) }).ok).toBe(false);
    expect((await c.act({ kind: 'handBack', key: K(ISSUE) })).ok).toBe(false);
    expect((await c.opFinish(s.id!)).ok).toBe(false);
    expect((await c.opRecheck(s.id!)).ok).toBe(false);
    expect(labelAdds('pending/agent')).toHaveLength(1);
    // the events can be read again: the add by this account is found
    fake.state.w.failEvents = false;
    expect((await c.opRecheck(s.id!)).ok).toBe(true);
    await idle(c);
    r = opOf(c, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'ok', 'unsent']);
    expect(opPhase(r)).toBe('settled');
    // GitHub#359: proven, but the label was taken away again (the daemon, or a person taking it back — the app
    // cannot tell): the step left is not sent by itself, and the notice says why
    expect(opText(r)).toContain('这期间「pending/agent」被摘掉了，没有接着往下做');
    expect(labelRemoves('pending/human')).toHaveLength(0);
    // "finish" only takes "pending/human" off; the agent label is never sent again
    expect(opButtons(r)).toContain('finish');
    const f = await c.opFinish(s.id!);
    expect(f.ok).toBe(true);
    await idle(c);
    expect(labelRemoves('pending/human')).toHaveLength(1);
    expect(labelAdds('pending/agent')).toHaveLength(1);
    expect(labelsOnGitHub()).not.toContain('pending/human');
  });

  it('hand-back: answer received, the daemon took the label before the re-read: settled, nothing added again', async () => {
    waitingForHuman();
    const c = await ready();
    const holdRead = fake.holdWhen(isRead);
    const s = c.startOp({ kind: 'handBack', key: K(ISSUE) });
    await until(() => opOf(c, s.id!).steps.every((x) => x.state === 'ok'), 'both answered');
    await daemonPicksUp();
    holdRead();
    await idle(c);
    const r = opOf(c, s.id!);
    expect(opPhase(r)).toBe('settled');
    expect(opText(r)).toContain('已交给 agent');
    expect(labelAdds('pending/agent')).toHaveLength(1);
    expect(labelsOnGitHub()).toContain('doing/agent');
  });

  it('unknown and no evidence at all: only the person unlocks; then a new hand-back may go out', async () => {
    waitingForHuman();
    const c = await ready();
    // GitHub#359: the daemon is faster than every read of ours (a read showing the label on would prove the step),
    // and from then on the label records cannot be read
    const lost = fake.dropAnswerWhen((e) => e.method === 'POST' && e.path.endsWith(`/issues/${ISSUE}/labels`), () => {
      daemonPicksUpNow();
      fake.state.w.failEvents = true;
    });
    const s = c.startOp({ kind: 'handBack', key: K(ISSUE) });
    await until(() => lost.caught() === 1, 'the agent label reached GitHub');
    lost.stop();
    await idle(c);
    expect(labelsOnGitHub()).toContain('doing/agent');
    expect((await c.opRecheck(s.id!)).ok).toBe(false);
    // not read is not "not there": nothing to send again
    expect(opButtons(opOf(c, s.id!))).toEqual(['unlock']);
    expect(c.startOp({ kind: 'handBack', key: K(ISSUE) }).ok).toBe(false);
    expect(labelAdds('pending/agent')).toHaveLength(1);
    c.opUnlock(s.id!);
    expect(opPhase(opOf(c, s.id!))).toBe('unlocked');
    expect(opText(opOf(c, s.id!))).toContain('已由人核对后解除锁定');
    const again = c.startOp({ kind: 'handBack', key: K(ISSUE) });
    expect(again.ok).toBe(true);
    await idle(c);
    expect(labelAdds('pending/agent')).toHaveLength(2);
  });
});

describe('partly done: each step said, only refused label steps may be finished', () => {
  it('autopilot: agent label refused — "finish" adds it and takes "pending/human" off; a second finish while it prepares is refused', async () => {
    waitingForHuman();
    const c = await ready();
    fake.state.w.failLabel = 'pending/agent';
    const s = c.startOp({ kind: 'autopilot', key: K(ISSUE) });
    await idle(c);
    const r = opOf(c, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'refused', 'unsent']);
    expect(opText(r)).toContain('加「pending/agent」没有成功');
    expect(opPhase(r)).toBe('settled');
    fake.state.w.failLabel = null;
    const [a, b] = await Promise.all([c.opFinish(s.id!), c.opFinish(s.id!)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    await idle(c);
    expect(labelAdds('autopilot')).toHaveLength(1);
    expect(labelAdds('pending/agent')).toHaveLength(2); // the refused one, then the finish
    expect(labelRemoves('pending/human')).toHaveLength(1);
    expect(labelsOnGitHub()).toEqual(expect.arrayContaining(['autopilot', 'pending/agent']));
  });

  it('hand-back: agent label added, removing "pending/human" refused — "finish" only removes it', async () => {
    waitingForHuman();
    const c = await ready();
    fake.state.w.failUnlabel = 'pending/human';
    const s = c.startOp({ kind: 'handBack', key: K(ISSUE) });
    await idle(c);
    expect(opOf(c, s.id!).steps.map((x) => x.state)).toEqual(['ok', 'refused']);
    expect(opText(opOf(c, s.id!))).toContain('摘「pending/human」没有成功');
    fake.state.w.failUnlabel = null;
    expect((await c.opFinish(s.id!)).ok).toBe(true);
    await idle(c);
    expect(labelAdds('pending/agent')).toHaveLength(1);
    expect(labelRemoves('pending/human')).toHaveLength(2);
    expect(labelsOnGitHub()).not.toContain('pending/human');
  });

  it('close done, comment refused: one close; the comment is kept, may go into the reply box, and the reply sending it ends the draft', async () => {
    const c = await ready();
    fake.state.w.failComment = true;
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '做完了' });
    await idle(c);
    const r = opOf(c, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'refused']);
    expect(opText(r)).toContain(`issue #${ISSUE} 已关闭（已完成），但附的评论没有发出去：GitHub 不接受这次修改`);
    expect(opPhase(r)).toBe('settled');
    expect(closes()).toHaveLength(1);
    expect(comments()).toHaveLength(1);
    expect(commentsOnGitHub()).toHaveLength(0);
    expect(opDraftLeft(r)).toEqual({ comment: '做完了' });
    expect(opButtons(r)).toEqual(expect.arrayContaining(['copy', 'toReply', 'dropDraft', 'dismiss']));
    expect(opButtons(r)).not.toContain('retry');
    // what the panel does after the reply carrying it went out
    fake.state.w.failComment = false;
    expect((await c.act({ kind: 'comment', key: K(ISSUE), body: '做完了' })).ok).toBe(true);
    c.opDropDraft(s.id!);
    expect(opDraftLeft(opOf(c, s.id!))).toBeNull();
    expect(closes()).toHaveLength(1);
  });
});

describe('evidence must be newer than the request (code review round 1)', () => {
  it('an older comment of this account with the same text proves nothing: still unknown, the draft and the lock stay', async () => {
    const c = await ready();
    // one minute ago the same account wrote exactly this
    expect((await c.act({ kind: 'comment', key: K(ISSUE), body: '做完了' })).ok).toBe(true);
    expect(commentsOnGitHub()).toHaveLength(1);
    const late = fake.lateWhen((e) => e.method === 'POST' && e.path.endsWith(`/issues/${ISSUE}/comments`));
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '做完了' });
    await idle(c);
    expect(late.caught()).toBe(1);
    let r = opOf(c, s.id!);
    expect(r.before?.comments).toHaveLength(1);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'unknown']);
    expect((await c.opRecheck(s.id!)).ok).toBe(false);
    r = opOf(c, s.id!);
    expect(r.steps[1].state).toBe('unknown');
    expect(opPhase(r)).toBe('unknown');
    expect(opDraftLeft(r)).toEqual({ comment: '做完了' });
    expect(c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '' }).ok).toBe(false);
    // the request lands: now a new comment is there, and it proves the step
    late.land();
    expect(commentsOnGitHub()).toHaveLength(2);
    expect((await c.opRecheck(s.id!)).ok).toBe(true);
    expect(opOf(c, s.id!).steps[1].state).toBe('ok');
    expect(opDraftLeft(opOf(c, s.id!))).toBeNull();
  });

  it('an older "pending/agent" added by this account proves nothing: the label is gone (the daemon), still unknown, nothing re-sent', async () => {
    waitingForHuman();
    const c = await ready();
    // earlier: this account handed it over, the daemon took the label
    const h = { authorization: `Bearer ${FAKE_TOKEN}`, 'content-type': 'application/json' };
    expect((await fetch(`${fake.api}/repos/${REPO}/issues/${ISSUE}/labels`, { method: 'POST', headers: h, body: JSON.stringify({ labels: ['pending/agent'] }) })).status).toBe(200);
    await daemonPicksUp();
    const late = fake.lateWhen((e) => e.method === 'POST' && e.path.endsWith(`/issues/${ISSUE}/labels`) && ((e.body as any)?.labels ?? []).includes('pending/agent'));
    const s = c.startOp({ kind: 'handBack', key: K(ISSUE) });
    await idle(c);
    expect(late.caught()).toBe(1);
    const r = opOf(c, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['unknown', 'unsent']);
    expect(opPhase(r)).toBe('unknown');
    expect(c.startOp({ kind: 'handBack', key: K(ISSUE) }).ok).toBe(false);
    expect(labelsOnGitHub()).not.toContain('pending/agent');
    late.land();
    expect((await c.opRecheck(s.id!)).ok).toBe(true);
    expect(opOf(c, s.id!).steps[0].state).toBe('ok');
  });

  it('the read before sending failed: the step can never be proven automatically — only a person unlocks', async () => {
    const c = await ready();
    fake.state.w.failCommentList = true;
    const lost = fake.dropAnswerWhen((e) => e.method === 'POST' && e.path.endsWith(`/issues/${ISSUE}/comments`));
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '做完了' });
    await idle(c);
    expect(lost.caught()).toBe(1);
    expect(opOf(c, s.id!).before).toBeNull();
    fake.state.w.failCommentList = false;
    expect((await c.opRecheck(s.id!)).ok).toBe(false);
    expect(opOf(c, s.id!).checkProblem).toContain('发送前没读到');
    expect(opPhase(opOf(c, s.id!))).toBe('unknown');
    c.opUnlock(s.id!);
    expect(opPhase(opOf(c, s.id!))).toBe('unlocked');
    expect(commentsOnGitHub()).toHaveLength(1);
  });
});

describe('a reply built from the kept comment is finished by the controller (code review round 1)', () => {
  async function refusedComment(c: Controller) {
    fake.state.w.failComment = true;
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '做完了' });
    await idle(c);
    fake.state.w.failComment = false;
    expect(opButtons(opOf(c, s.id!))).toContain('toReply');
    return s.id!;
  }
  it('sent: the draft is done even though no panel is left to say so; a second reply from it is refused while the first is on its way', async () => {
    const c = await ready();
    const id = await refusedComment(c);
    const hold = fake.holdWhen((e) => e.method === 'POST' && e.path.endsWith(`/issues/${ISSUE}/comments`));
    const p = c.act({ kind: 'comment', key: K(ISSUE), body: '做完了', draftOf: id });
    await until(() => opOf(c, id).replyState === 'sending', 'reply on its way');
    expect(opButtons(opOf(c, id))).not.toContain('toReply');
    expect((await c.act({ kind: 'comment', key: K(ISSUE), body: '做完了', draftOf: id })).ok).toBe(false);
    hold();
    expect((await p).ok).toBe(true);
    expect(commentsOnGitHub().map((x) => x.body)).toEqual(['做完了']);
    expect(opDraftLeft(opOf(c, id))).toBeNull();
  });
  it('no answer: "not sure", copy only — never offered for the reply box again; one comment on GitHub', async () => {
    const c = await ready();
    const id = await refusedComment(c);
    const lost = fake.dropAnswerWhen((e) => e.method === 'POST' && e.path.endsWith(`/issues/${ISSUE}/comments`));
    expect((await c.act({ kind: 'comment', key: K(ISSUE), body: '做完了', draftOf: id })).ok).toBe(false);
    expect(lost.caught()).toBe(1);
    const r = opOf(c, id);
    expect(r.replyState).toBe('unknown');
    expect(opButtons(r)).toContain('copy');
    expect(opButtons(r)).not.toContain('toReply');
    expect(opText(r)).toContain('用附的评论原文发的回复不确定有没有发出');
    expect((await c.act({ kind: 'comment', key: K(ISSUE), body: '做完了', draftOf: id })).ok).toBe(false);
    expect(commentsOnGitHub()).toHaveLength(1);
  });
  it('refused for sure: offered again', async () => {
    const c = await ready();
    const id = await refusedComment(c);
    fake.state.w.failComment = true;
    expect((await c.act({ kind: 'comment', key: K(ISSUE), body: '做完了', draftOf: id })).ok).toBe(false);
    expect(comments()).toHaveLength(2); // the refused step, then the refused reply
    expect(opOf(c, id).replyState).toBeNull();
    expect(opButtons(opOf(c, id))).toContain('toReply');
  });
});

describe('a reply made from the kept comment is part of the lock (code review round 2)', () => {
  /** the close is refused: its comment is kept and offered for the reply box */
  async function refusedClose(c: Controller, comment = '恢复评论') {
    fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'not_planned', comment });
    await idle(c);
    fake.state.w.readOnlyRepos.clear();
    const r = opOf(c, s.id!);
    expect(opButtons(r)).toEqual(expect.arrayContaining(['retry', 'toReply']));
    return s.id!;
  }

  it('close refused, the reply from its comment reached GitHub but the answer was lost: no "重新关闭", every entry refused, the comment is never sent twice; the comment list then proves it', async () => {
    const c = await ready();
    const id = await refusedClose(c);
    const lost = fake.dropAnswerWhen((e) => e.method === 'POST' && e.path.endsWith(`/issues/${ISSUE}/comments`));
    expect((await c.act({ kind: 'comment', key: K(ISSUE), body: '恢复评论', draftOf: id })).ok).toBe(false);
    lost.stop();
    // it did go out once
    expect(lost.caught()).toBe(1);
    expect(commentsOnGitHub().map((x) => x.body)).toEqual(['恢复评论']);
    let r = opOf(c, id);
    expect(r.replyState).toBe('unknown');
    expect(opPhase(r)).toBe('unknown');
    expect(opButtons(r)).not.toContain('retry');
    expect(opButtons(r)).not.toContain('toReply');
    expect(opButtons(r)).toContain('copy');
    expect(opReusableDraft(r)).toEqual({ reason: 'not_planned' });
    // every entry: a new close (what "重新关闭" or a re-opened panel sends), with the comment or without; another reply from it
    expect(c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'not_planned', comment: '恢复评论' }, { from: id }).ok).toBe(false);
    expect(c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'not_planned', comment: '' }).ok).toBe(false);
    expect((await c.act({ kind: 'closeIssue', key: K(ISSUE), reason: 'not_planned', comment: '恢复评论' })).ok).toBe(false);
    expect((await c.act({ kind: 'comment', key: K(ISSUE), body: '恢复评论', draftOf: id })).ok).toBe(false);
    expect(comments()).toHaveLength(1);
    // the list shows a comment that was not there before the reply: proven, the comment is done
    expect((await c.opRecheck(id)).ok).toBe(true);
    r = opOf(c, id);
    expect(r.replyState).toBeNull();
    expect(opDraftLeft(r)).toEqual({ reason: 'not_planned' });
    expect(opButtons(r)).toContain('retry');
    // closing again now carries no comment
    const again = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'not_planned', comment: '' }, { from: id });
    expect(again.ok).toBe(true);
    await idle(c);
    expect(stateOnGitHub()).toBe('closed');
    expect(commentsOnGitHub().map((x) => x.body)).toEqual(['恢复评论']);
  });

  it('an older comment with the same text proves nothing for the reply either', async () => {
    const c = await ready();
    const id = await refusedClose(c);
    expect((await c.act({ kind: 'comment', key: K(ISSUE), body: '恢复评论' })).ok).toBe(true);
    const late = fake.lateWhen((e) => e.method === 'POST' && e.path.endsWith(`/issues/${ISSUE}/comments`));
    expect((await c.act({ kind: 'comment', key: K(ISSUE), body: '恢复评论', draftOf: id })).ok).toBe(false);
    expect(late.caught()).toBe(1);
    expect((await c.opRecheck(id)).ok).toBe(false);
    expect(opOf(c, id).replyState).toBe('unknown');
    late.land();
    expect((await c.opRecheck(id)).ok).toBe(true);
    expect(opOf(c, id).replyState).toBeNull();
  });

  it('"sending" cannot be stored: the reply is refused, no comment request at all; storing was really tried', async () => {
    let tried = 0;
    let failing = false;
    const c = await ready({
      intercept: (cmd, args) => {
        if (failing && cmd === 'replaceSnapshots' && (args?.snapshots ?? []).some((x: any) => x.sourceKey === '__ops__' && (x.ops ?? []).some((o: any) => o.replyState === 'sending'))) {
          tried++;
          return { written: false };
        }
        return undefined;
      },
    });
    const id = await refusedClose(c);
    const before = comments().length;
    failing = true;
    const r = await c.act({ kind: 'comment', key: K(ISSUE), body: '恢复评论', draftOf: id });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没能存到本机');
    expect(tried).toBeGreaterThan(0);
    expect(comments()).toHaveLength(before);
    expect(opOf(c, id).replyState).toBeNull();
    expect(opButtons(opOf(c, id))).toContain('toReply');
    // stored fine again: it goes out
    failing = false;
    expect((await c.act({ kind: 'comment', key: K(ISSUE), body: '恢复评论', draftOf: id })).ok).toBe(true);
    expect(commentsOnGitHub().map((x) => x.body)).toEqual(['恢复评论']);
  });

  it('the app stops while the reply is on its way: after the restart it is "not sure", locked, not offered again; the list then proves it', async () => {
    const c = await ready();
    const id = await refusedClose(c);
    fake.holdWhen((e) => e.method === 'POST' && e.path.endsWith(`/issues/${ISSUE}/comments`));
    void c.act({ kind: 'comment', key: K(ISSUE), body: '恢复评论', draftOf: id });
    await until(() => comments().length === 1, 'reply sent');
    await until(() => storedOps()?.find((x) => x.id === id)?.replyState === 'sending', 'stored as sending');
    c.stopTimer();
    // GitHub#359: the first round after the restart checks by itself — here the comment list cannot be read yet
    fake.state.w.failCommentList = true;
    const c2 = await ready();
    await idle(c2);
    const r = opOf(c2, id);
    expect(r.replyState).toBe('unknown');
    expect(opPhase(r)).toBe('unknown');
    expect(opButtons(r)).not.toContain('toReply');
    expect(opButtons(r)).not.toContain('retry');
    expect((await c2.act({ kind: 'comment', key: K(ISSUE), body: '恢复评论', draftOf: id })).ok).toBe(false);
    expect(c2.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'not_planned', comment: '' }).ok).toBe(false);
    fake.state.w.failCommentList = false;
    expect((await c2.opRecheck(id)).ok).toBe(true);
    expect(opOf(c2, id).replyState).toBeNull();
    expect(comments()).toHaveLength(1);
  });
});

describe('a reply from a kept comment never crosses a session (code review round 3)', () => {
  it('account A signs out and account B signs in (and syncs) while the reply waits on its way to GitHub: nothing is sent, not as A and not as B; a reply in one session does go out', async () => {
    const OTHER = 'gho_othertoken0000000000000000000000002';
    const c = await ready();
    // reachability: in one session the same path does post the reply
    fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
    const first = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '一次就好' });
    await idle(c);
    fake.state.w.readOnlyRepos.clear();
    expect((await c.act({ kind: 'comment', key: K(ISSUE), body: '一次就好', draftOf: first.id })).ok).toBe(true);
    expect(commentsOnGitHub().map((x) => x.body)).toEqual(['一次就好']);

    // account A: another refused close, its comment put into a reply; the reply waits on GitHub (the read of what is there)
    fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '旧账号的草稿' });
    await idle(c);
    fake.state.w.readOnlyRepos.clear();
    const holdRead = fake.holdWhen((e) => e.operation === 'CavilOpRecords');
    const reply = c.act({ kind: 'comment', key: K(ISSUE), body: '旧账号的草稿', draftOf: s.id });
    await until(() => fake.log.some((l) => l.operation === 'CavilOpRecords' && l.auth === `Bearer ${FAKE_TOKEN}` && l.status === 0), 'the reply is on its way');
    // A signs out, B signs in and its first sync lands
    await c.logout();
    expect(c.getState().ops).toHaveLength(0);
    fake.state.nextGrant = { token: OTHER };
    fake.state.tokenViewers.set(OTHER, 'user-2');
    c.setClientId(fake.state.oauthClientId);
    const login = c.startLogin();
    await until(() => c.getState().login.status === 'waiting', 'device code');
    fake.resolveGrant('approved');
    await login;
    await until(() => c.getState().phase === 'ready' && !c.getState().sync.syncing && c.getState().viewer === 'user-2', 'B signed in and synced');
    expect(c.getBoardData().items.some((i) => i.key === K(ISSUE))).toBe(true);
    // the old request goes on
    holdRead();
    const r = await reply;
    expect(r.ok).toBe(false);
    expect(comments().filter((w) => (w.body as any)?.body === '旧账号的草稿')).toHaveLength(0);
    // B did read (its sync), and wrote nothing at all
    expect(fake.log.some((l) => l.auth === `Bearer ${OTHER}`)).toBe(true);
    expect(fake.writes().filter((l) => l.auth === `Bearer ${OTHER}`)).toHaveLength(0);
    expect(commentsOnGitHub().map((x) => x.body)).toEqual(['一次就好']);
    expect(c.getState().ops).toHaveLength(0);
  }, 60_000);
});

describe('restart, sign-out', () => {
  it('restart while waiting, GitHub had carried the close out: unknown, nothing re-sent; the first read after the restart proves it, settles it, keeps the comment that never went out (code review round 1)', async () => {
    const c = await ready();
    // GitHub closes it at once; the answer never reaches this run
    fake.holdWhen((e) => e.method === 'PATCH' && e.path === `/api/repos/${REPO}/issues/${ISSUE}`);
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '做完了' });
    await until(() => closes().length === 1, 'close sent');
    await until(() => storedOps()?.find((x) => x.id === s.id)?.steps[0].state === 'pending', 'stored as sent');
    expect(stateOnGitHub()).toBe('closed');
    c.stopTimer();
    const before = fake.writes().length;
    const c2 = await ready();
    await idle(c2);
    const r = opOf(c2, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'unsent']);
    expect(r.steps[0].answeredAt).toBeNull(); // proven by the read, no answer made up
    expect(opPhase(r)).toBe('settled');
    expect(opText(r)).toContain('附的评论没有发出');
    expect(opDraftLeft(r)).toEqual({ comment: '做完了' });
    expect(opButtons(r)).toEqual(expect.arrayContaining(['copy', 'toReply']));
    expect(fake.writes().length).toBe(before);
    expect(comments()).toHaveLength(0);
  });

  it('restart while waiting, the close had not landed: unknown and locked, nothing sent; once it lands the next read proves it', async () => {
    const c = await ready();
    const late = fake.lateWhen((e) => e.method === 'PATCH' && e.path === `/api/repos/${REPO}/issues/${ISSUE}`);
    const hold = fake.holdWhen((e) => e.method === 'GET' && e.path === '/never');
    hold();
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '做完了' });
    await until(() => late.caught() === 1, 'close sent');
    await idle(c);
    c.stopTimer();
    // what a run stopped while waiting leaves on disk
    const kept = storedOps()!.find((x) => x.id === s.id)!;
    expect(kept.steps[0].state).toBe('unknown');
    const before = fake.writes().length;
    const c2 = await ready();
    await idle(c2);
    expect(opOf(c2, s.id!).steps.map((x) => x.state)).toEqual(['unknown', 'unsent']);
    expect(c2.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '做完了' }).ok).toBe(false);
    late.land();
    await c2.syncNow();
    await idle(c2);
    const r = opOf(c2, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'unsent']);
    expect(opPhase(r)).toBe('settled');
    expect(fake.writes().length).toBe(before);
  });

  it('restart while a merge waited, GitHub had merged: the first read proves it and settles it, nothing re-sent', async () => {
    const pr = openPr();
    const c = await ready();
    const d = await c.loadDetail(K(pr));
    const headOid = d.ok ? d.detail.pr!.headOid : '';
    fake.holdWhen((e) => e.method === 'PUT' && e.path.endsWith(`/pulls/${pr}/merge`));
    const s = c.startOp({ kind: 'merge', key: K(pr), method: 'merge', headOid });
    await until(() => merges(pr).length === 1, 'merge sent');
    await until(() => storedOps()?.find((x) => x.id === s.id)?.steps[0].state === 'pending', 'stored as sent');
    c.stopTimer();
    const c2 = await ready();
    await idle(c2);
    const r = opOf(c2, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['ok']);
    expect(opPhase(r)).toBe('settled');
    expect(merges(pr)).toHaveLength(1);
  });

  it('a draft kept after settling survives the restart', async () => {
    const c = await ready();
    fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'not_planned', comment: '不做了' });
    await idle(c);
    c.opDismiss(s.id!);
    await c.settled();
    c.stopTimer();
    const c2 = await ready();
    const r = opOf(c2, s.id!);
    expect(r.dismissed).toBe(true);
    expect(opDraftLeft(r)).toEqual({ reason: 'not_planned', comment: '不做了' });
    // only a person drops it
    c2.opDropDraft(s.id!);
    expect(c2.getState().ops.find((x) => x.id === s.id)).toBeUndefined();
  });

  it('sign-out drops the records with the cache', async () => {
    const c = await ready();
    fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
    c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '做完了' });
    await idle(c);
    expect(c.getState().ops).toHaveLength(1);
    await c.logout();
    expect(c.getState().ops).toHaveLength(0);
    expect(storedOps()).toBeNull();
  });
});

describe('a success never read back', () => {
  it('re-reads keep failing: after the wait the person is offered the check and the unlock', async () => {
    const c = await ready({ opStuckMs: 2000 });
    fake.state.w.failDetail.add('never');
    const holdRead = fake.holdWhen(isRead);
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '' });
    await until(() => opOf(c, s.id!).steps[0].state === 'ok' && opPhase(opOf(c, s.id!)) !== 'waiting', 'answered, no longer running');
    expect(opPhase(opOf(c, s.id!))).toBe('settling');
    expect(opButtons(opOf(c, s.id!))).not.toContain('unlock');
    await until(() => opOf(c, s.id!).stuck, 'stuck');
    expect(opButtons(opOf(c, s.id!))).toEqual(expect.arrayContaining(['openWeb', 'unlock']));
    c.opUnlock(s.id!);
    expect(opLockOf(c.getState().ops, K(ISSUE))).toBeNull();
    holdRead();
    await idle(c);
  });

  it('closed, then reopened on the web before our re-read: the re-read shows it open — stays waiting (not taken as done)', async () => {
    const c = await ready({ opStuckMs: 600_000 });
    // GitHub carries out the close at once; its answer is held while somebody reopens it on the web
    const holdClose = fake.holdWhen((e) => e.method === 'PATCH' && e.path === `/api/repos/${REPO}/issues/${ISSUE}` && e.auth === `Bearer ${FAKE_TOKEN}`);
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '' });
    await until(() => closes().length === 1, 'close sent');
    await reopen();
    holdClose();
    await idle(c);
    const r = opOf(c, s.id!);
    expect(r.steps[0].state).toBe('ok');
    expect(r.readAt).not.toBeNull();
    expect(itemOf(c, ISSUE).state).toBe('open');
    expect(opPhase(r)).toBe('settling');
    expect(c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '' }).ok).toBe(false);
  });
});

// GitHub#279: "修改已生效，但重读这一条失败…，下一轮同步会更新" — the next round that reaches GitHub
// really re-reads it, and only a re-read that works clears it. The re-read after a round never asks
// for a round of its own. Every "no more rounds / no re-read" has a "this did happen" sibling.
describe('a re-read that failed is caught up by the next round that reaches GitHub (GitHub#279)', () => {
  const ITEM = `gigleai/cavil-loop#${ISSUE}`;
  const refreshes = () => fake.log.filter((e) => e.operation === 'CavilItemRefresh' && e.variables?.number === ISSUE).length;
  /** what a round sent that reads data in full (a confirmed-unchanged round sends only version checks) */
  const fullReads = (from: number) => fake.log.slice(from).filter((e) => e.operation === 'CavilProjectItems' || (e.method === 'GET' && /\/repos\/[^/]+\/[^/]+\/issues(\?|$)/.test(e.path)));
  let rounds = 0;
  /** an autopilot whose every step worked, and whose re-read right after failed; every round it asked for is through */
  async function failedReread() {
    rounds = 0;
    waitingForHuman();
    const c = await ready({ followUpSyncMs: 30, afterRoundRead: () => rounds++ });
    fake.state.w.failRefresh.add(ITEM);
    const s = c.startOp({ kind: 'autopilot', key: K(ISSUE) });
    await idle(c);
    await quiet(c);
    const r = opOf(c, s.id!);
    expect(r.steps.every((x) => x.state === 'ok')).toBe(true);
    expect(r.readProblem).toContain('重读这一条失败');
    return { c, id: s.id! };
  }
  /** no round runs and none is due (the follow-up a re-read asks for has fired) */
  async function quiet(c: Controller) {
    for (let i = 0; i < 20; i++) {
      const before = rounds;
      await new Promise((r) => setTimeout(r, 120));
      await c.syncNow();
      await idle(c);
      // syncNow above is one round of its own; nothing else came in while waiting
      if (rounds === before + 1) return;
    }
    throw new Error('rounds keep coming by themselves');
  }

  it('the notice is a warning while the problem stands, not a success; it never puts itself away', async () => {
    const { c, id } = await failedReread();
    const r = opOf(c, id);
    expect(opTone(r)).toBe('warn');
    expect(opAutoDismissable(r)).toBe(false);
  });

  it('a round that reads the data, the item answers again: the re-read went out, the problem is gone, the notice is a success that puts itself away', async () => {
    const { c, id } = await failedReread();
    fake.state.w.failRefresh.delete(ITEM);
    // something changed on GitHub: the round reads in full
    await daemonPicksUp();
    const from = fake.log.length;
    const n = refreshes();
    await c.syncNow();
    await idle(c);
    expect(fullReads(from).length).toBeGreaterThan(0);
    expect(refreshes()).toBe(n + 1);
    const r = opOf(c, id);
    expect(r.readProblem ?? null).toBeNull();
    expect(opTone(r)).toBe('ok');
    expect(opAutoDismissable(r)).toBe(true);
    expect(storedOps()!.find((x) => x.id === id)!.readProblem ?? null).toBeNull();
  });

  it('a round that only confirms nothing changed still re-reads; "unchanged" alone clears nothing, the re-read working does', async () => {
    const { c, id } = await failedReread();
    // still failing: a confirmed-unchanged round re-reads, the problem stays (with this re-read's reason)
    let from = fake.log.length;
    let n = refreshes();
    await c.syncNow();
    await idle(c);
    expect(fullReads(from)).toHaveLength(0);
    expect(fake.log.slice(from).some((e) => e.method === 'HEAD')).toBe(true);
    expect(refreshes()).toBe(n + 1);
    expect(opOf(c, id).readProblem).toContain('重读这一条失败');
    expect(opTone(opOf(c, id))).toBe('warn');
    // the item answers again; the round still finds nothing changed
    fake.state.w.failRefresh.delete(ITEM);
    from = fake.log.length;
    n = refreshes();
    await c.syncNow();
    await idle(c);
    expect(fullReads(from)).toHaveLength(0);
    expect(refreshes()).toBe(n + 1);
    expect(opOf(c, id).readProblem ?? null).toBeNull();
    expect(opAutoDismissable(opOf(c, id))).toBe(true);
  });

  it('a re-read after a round asks for no round: failing (three rounds = three re-reads, no more rounds), or working while the round still runs', async () => {
    const { c, id } = await failedReread();
    const n = refreshes();
    const r0 = rounds;
    for (let i = 0; i < 3; i++) {
      await c.syncNow();
      await idle(c);
    }
    await new Promise((r) => setTimeout(r, 200)); // a follow-up round would be due after 30 ms
    await idle(c);
    expect(refreshes()).toBe(n + 3);
    expect(rounds).toBe(r0 + 3);
    expect(opOf(c, id).readProblem).toContain('重读这一条失败');
    // working: it lands while its round is still on (the round waits for it) — no round is queued after it
    fake.state.w.failRefresh.delete(ITEM);
    await c.syncNow();
    await new Promise((r) => setTimeout(r, 200));
    await idle(c);
    expect(refreshes()).toBe(n + 4);
    expect(rounds).toBe(r0 + 4);
    expect(opOf(c, id).readProblem ?? null).toBeNull();
  });

  it('a round that cannot reach GitHub, or reads no source, re-reads nothing (the round did run); a notice put away is not re-read', async () => {
    const { c, id } = await failedReread();
    fake.state.w.failRefresh.delete(ITEM);
    let n = refreshes();
    let r0 = rounds;
    fake.state.offline = true;
    await c.syncNow();
    await idle(c);
    expect(c.getState().sync.offline).toBe(true);
    expect(rounds).toBe(r0 + 1);
    expect(refreshes()).toBe(n);
    expect(opOf(c, id).readProblem).toContain('重读这一条失败');
    // GitHub answers, but every source of the round fails: the round did not reach the data — no re-read either
    fake.state.offline = false;
    fake.state.failProjectPage.set('org/gigleai/11', 0);
    fake.state.failRepoPage.set('gigleai/cavil-loop', 1);
    n = refreshes();
    r0 = rounds;
    const from = fake.log.length;
    await c.syncNow();
    await idle(c);
    expect(rounds).toBe(r0 + 1);
    expect(fake.log.slice(from).some((e) => e.status === 502)).toBe(true);
    expect(c.getState().sync.sources.every((st) => !st.ok)).toBe(true);
    expect(refreshes()).toBe(n);
    expect(opOf(c, id).readProblem).toContain('重读这一条失败');
    fake.state.failProjectPage.clear();
    fake.state.failRepoPage.clear();
    // back online, but the notice was put away by hand: nothing to catch up
    fake.state.offline = false;
    c.opDismiss(id, true);
    n = refreshes();
    r0 = rounds;
    await c.syncNow();
    await idle(c);
    expect(rounds).toBe(r0 + 1);
    expect(refreshes()).toBe(n);
  });

  it('re-reads and the sync fail past the wait (stuck); once both work again the notice is settled, no longer stuck, and puts itself away (PR #282 code review round 1)', async () => {
    waitingForHuman();
    const c = await ready({ opStuckMs: 30, followUpSyncMs: 30 });
    fake.state.w.failRefresh.add(ITEM);
    fake.state.failProjectPage.set('org/gigleai/11', 0);
    fake.state.failRepoPage.set('gigleai/cavil-loop', 1);
    const s = c.startOp({ kind: 'autopilot', key: K(ISSUE) });
    await idle(c);
    await until(() => opOf(c, s.id!).stuck, 'stuck');
    await idle(c);
    expect(opPhase(opOf(c, s.id!))).toBe('settling');
    expect(opOf(c, s.id!).readProblem).toContain('重读这一条失败');
    expect(opAutoDismissable(opOf(c, s.id!))).toBe(false);
    fake.state.w.failRefresh.delete(ITEM);
    fake.state.failProjectPage.clear();
    fake.state.failRepoPage.clear();
    const n = refreshes();
    await c.syncNow();
    await idle(c);
    expect(refreshes()).toBeGreaterThan(n);
    const r = opOf(c, s.id!);
    expect(r.readProblem ?? null).toBeNull();
    expect(opPhase(r)).toBe('settled');
    expect(r.stuck).toBe(false);
    expect(opAutoDismissable(r)).toBe(true);
  });

  it('a close stuck waiting: a read still showing it open keeps it stuck; the read showing it closed ends that', async () => {
    const c = await ready({ opStuckMs: 30, followUpSyncMs: 30 });
    // GitHub carries out the close, but every read of the item still shows it open
    const holdClose = fake.holdWhen((e) => e.method === 'PATCH' && e.path === `/api/repos/${REPO}/issues/${ISSUE}` && e.auth === `Bearer ${FAKE_TOKEN}`);
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '' });
    await until(() => closes().length === 1, 'close sent');
    await reopen();
    holdClose();
    await idle(c);
    await until(() => opOf(c, s.id!).stuck, 'stuck');
    await c.syncNow();
    await idle(c);
    expect(opPhase(opOf(c, s.id!))).toBe('settling');
    expect(opOf(c, s.id!).stuck).toBe(true);
    // closed on GitHub now: the next read shows it
    await fetch(`${fake.api}/repos/${REPO}/issues/${ISSUE}`, { method: 'PATCH', headers: { authorization: `Bearer ${DAEMON_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ state: 'closed' }) });
    await c.syncNow();
    await idle(c);
    const r = opOf(c, s.id!);
    expect(opPhase(r)).toBe('settled');
    expect(r.stuck).toBe(false);
    expect(opAutoDismissable(r)).toBe(true);
  });

  it('kept over a restart: the first round after it re-reads and clears the problem', async () => {
    const { c, id } = await failedReread();
    c.stopTimer();
    await c.settled();
    fake.state.w.failRefresh.delete(ITEM);
    const n = refreshes();
    const c2 = await ready({ followUpSyncMs: 30 });
    await idle(c2);
    expect(refreshes()).toBeGreaterThan(n);
    expect(opOf(c2, id).readProblem ?? null).toBeNull();
  });
});

// GitHub#296: a successful autopilot notice stayed for hours. An evidence read that could not be done
// ("这次没能查证：…") was kept after the step was proven; the notice no longer said it, yet it never put
// itself away. The controller keeps every record through one setOp, which drops such a mark; each way
// a record comes in — a sync read, the end of a recheck, a record left by an earlier run — is run here.
describe('GitHub#296: a check problem that no longer stands never keeps a successful notice', () => {
  const removal = () => fake.lateWhen((e) => e.method === 'DELETE' && e.path === `/api/repos/${REPO}/issues/${ISSUE}/labels/${encodeURIComponent('pending/human')}`);

  /** autopilot whose "pending/human" removal reached GitHub late; the evidence read failed: unknown, with a check problem */
  async function unknownWithProblem() {
    waitingForHuman();
    const c = await ready();
    const late = removal();
    const s = c.startOp({ kind: 'autopilot', key: K(ISSUE) });
    await idle(c);
    expect(late.caught()).toBe(1);
    fake.state.w.failEvents = true;
    expect((await c.opRecheck(s.id!)).ok).toBe(false);
    const r = opOf(c, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'ok', 'unknown']);
    expect(opPhase(r)).toBe('unknown');
    expect(r.checkProblem).toBeTruthy();
    expect(opText(r)).toContain('这次没能查证');
    return { c, id: s.id!, late };
  }

  it('a sync read proves the removal: the notice reads as a plain success and goes by itself; stored without the problem', async () => {
    const { c, id, late } = await unknownWithProblem();
    late.land();
    expect(labelsOnGitHub()).not.toContain('pending/human');
    await c.syncNow();
    await idle(c);
    const r = opOf(c, id);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'ok', 'ok']);
    expect(opPhase(r)).toBe('settled');
    expect(opText(r)).toBe('已托管：已加上「autopilot」、已加上「pending/agent」、已摘掉「pending/human」');
    expect(opTone(r)).toBe('ok');
    expect(opButtons(r)).toEqual(['dismiss']);
    expect(r.checkProblem).toBeNull();
    expect(opAutoDismissable(r)).toBe(true);
    expect(storedOps()!.find((x) => x.id === id)!.checkProblem).toBeNull();
  });

  it('the end of a recheck: the records prove the step but the item itself could not be re-read — settled, no problem kept', async () => {
    const { c, id, late } = await unknownWithProblem();
    late.land();
    fake.state.w.failEvents = false;
    fake.state.w.failRefresh.add(K(ISSUE));
    const out = await c.opRecheck(id);
    expect(out.ok).toBe(true);
    await idle(c);
    // the recheck did read the item (and that failed): the problem it found is about no unknown step any more
    const r = opOf(c, id);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'ok', 'ok']);
    expect(opPhase(r)).toBe('settled');
    expect(r.checkProblem).toBeNull();
    expect(opAutoDismissable(r)).toBe(true);
    fake.state.w.failRefresh.delete(K(ISSUE));
  });

  it('while the step stays unknown the problem stays (the notice says it) — and the person still has to check', async () => {
    const { c, id } = await unknownWithProblem();
    await c.syncNow();
    await idle(c);
    const r = opOf(c, id);
    expect(opPhase(r)).toBe('unknown');
    expect(r.checkProblem).toBeTruthy();
    expect(opText(r)).toContain('这次没能查证');
    expect(opAutoDismissable(r)).toBe(false);
  });

  it('unlocked by hand: the problem goes with the unknown phase, yet the notice still never goes by itself', async () => {
    const { c, id } = await unknownWithProblem();
    c.opUnlock(id);
    const r = opOf(c, id);
    expect(opPhase(r)).toBe('unlocked');
    expect(r.checkProblem).toBeNull();
    expect(opAutoDismissable(r)).toBe(false);
  });

  it('a record an earlier version left on disk settled with the problem still on: loaded without it, it goes by itself', async () => {
    waitingForHuman();
    const c = await ready();
    const s = c.startOp({ kind: 'autopilot', key: K(ISSUE) });
    await idle(c);
    expect(opAutoDismissable(opOf(c, s.id!))).toBe(true);
    c.stopTimer();
    await c.settled();
    // what the earlier version could leave: settled, every step ok, the old problem still on
    const cache = new Cache(join(dir, 'cache.sqlite'));
    caches.push(cache);
    const row = cache.loadSnapshots().get(OPS_KEY) as any;
    row.ops = row.ops.map((x: OpRecord) => (x.id === s.id ? { ...x, checkProblem: '读评论和标签记录失败（连接中断）' } : x));
    cache.replaceSnapshots([row]);
    expect(storedOps()!.find((x) => x.id === s.id)!.checkProblem).toBeTruthy();
    const c2 = await ready();
    await idle(c2);
    const r = opOf(c2, s.id!);
    expect(opPhase(r)).toBe('settled');
    expect(r.checkProblem).toBeNull();
    expect(opAutoDismissable(r)).toBe(true);
  });
});

// GitHub#359: a step whose answer never came is checked by the app itself; proven = the steps left go out by
// themselves (each judged on a fresh read first); not found = still "not sure", locked, and only a person —
// told what it can cause — sends it again. Every "nothing was sent" has a "the check did read" sibling.
describe('GitHub#359: checked by itself, finished by itself, sent again only by a person', () => {
  const addOf = (label: string) => (e: LoggedRequest) => e.method === 'POST' && e.path.endsWith(`/issues/${ISSUE}/labels`) && ((e.body as any)?.labels ?? []).includes(label);
  const removeOf = (label: string) => (e: LoggedRequest) => e.method === 'DELETE' && e.path.endsWith(`/issues/${ISSUE}/labels/${encodeURIComponent(label)}`);
  const snapshots = () => fake.log.filter((e) => e.operation === 'CavilOpSnapshot').length;
  const eventsOnGitHub = (label: string) => (fake.state.w.labelEvents.get(K(ISSUE)) ?? []).filter((e) => e.label.name === label).map((e) => `${e.event} by ${e.actor.login}`);
  const me = (method: string, path: string, body?: unknown) => fake.actAs('user-1', method, `/repos/${REPO}/issues/${ISSUE}${path}`, body);
  /** #n as a fresh item waiting for a person: "pending/human" on, no hand-over label, no label records */
  function fresh() {
    openIssue(ISSUE);
    for (const p of fake.state.projects.get('org/gigleai/11')!)
      for (const node of p.items.nodes) if (node.content?.number === ISSUE) node.content.labels.nodes = node.content.labels.nodes.filter((l: any) => !['autopilot', 'pending/agent', 'doing/agent'].includes(l.name));
    for (const r of fake.state.repos.get('gigleai/cavil-loop')!) if (r.number === ISSUE) r.labels = r.labels.filter((l: any) => !['autopilot', 'pending/agent', 'doing/agent'].includes(l.name));
    fake.state.w.labelEvents.delete(K(ISSUE));
    waitingForHuman();
  }
  /** autopilot whose first request never reaches GitHub until `late.land()`; the check made at once is through */
  async function autopilotNotLanded(opts: Parameters<typeof ready>[0] = {}) {
    fresh();
    const c = await ready(opts);
    const late = fake.lateWhen(addOf('autopilot'));
    const s = c.startOp({ kind: 'autopilot', key: K(ISSUE) });
    await idle(c);
    expect(late.caught()).toBe(1);
    return { c, late, id: s.id! };
  }

  it('read in full and not found is still "not sure": locked, the notice says it may yet land, nothing is sent again; once it lands the next round finishes all three steps', async () => {
    const { c, late, id } = await autopilotNotLanded();
    let r = opOf(c, id);
    // the check did read (and read everything)
    expect(snapshots()).toBeGreaterThanOrEqual(2);
    expect(r.steps.map((x) => x.state)).toEqual(['unknown', 'unsent', 'unsent']);
    expect(r.steps[0].check).toBe('unseen');
    expect(opPhase(r)).toBe('unknown');
    expect(opLockOf(c.getState().ops, K(ISSUE))?.id).toBe(id);
    expect(opText(r)).toContain('「autopilot」不确定有没有加上（已核对 1 次，到现在还没查到；原来那次请求仍可能稍后生效；还会继续自动核对）');
    // never "it was not added": only "not sure"
    expect(opText(r).replace(/不确定有没有加上/g, '')).not.toContain('没有加上');
    expect(opTone(r)).toBe('warn');
    expect(opButtons(r)).toEqual(['resend', 'unlock']);
    expect(labelAdds('autopilot')).toHaveLength(1);
    expect(labelAdds('pending/agent')).toHaveLength(0);
    // a round that finds nothing new: checked again, still not sure, still nothing sent
    const before = snapshots();
    await c.syncNow();
    await idle(c);
    expect(snapshots()).toBeGreaterThan(before);
    expect(opOf(c, id).steps[0]).toMatchObject({ state: 'unknown', check: 'unseen' });
    expect(opOf(c, id).checks).toBe(2);
    expect(labelAdds('autopilot')).toHaveLength(1);
    // the first request lands late: the next round's check proves it, the offer to send again is gone, the rest goes out
    late.land();
    late.stop();
    await c.syncNow();
    await idle(c);
    r = opOf(c, id);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'ok', 'ok']);
    expect(opButtons(r)).not.toContain('resend');
    expect(opText(r)).toContain('已托管');
    expect(labelAdds('autopilot')).toHaveLength(1);
    expect(labelAdds('pending/agent')).toHaveLength(1);
    expect(labelRemoves('pending/human')).toHaveLength(1);
    expect(eventsOnGitHub('autopilot')).toEqual(['labeled by user-1']);
    expect(eventsOnGitHub('pending/agent')).toEqual(['labeled by user-1']);
    expect(labelsOnGitHub()).toEqual(expect.arrayContaining(['autopilot', 'pending/agent']));
    expect(labelsOnGitHub()).not.toContain('pending/human');
  });

  it('a person sends it again: read first, then sent, the rest follows; the first request landing afterwards changes nothing more', async () => {
    const { c, late, id } = await autopilotNotLanded();
    expect(opResendConfirm(opOf(c, id))).toMatchObject({ title: '再发一次「加上 autopilot」？', after: '发出后会接着加「pending/agent」、摘「pending/human」。' });
    expect(opResendConfirm(opOf(c, id))!.lines.join('')).toContain('仍可能稍后生效');
    expect(opResendConfirm(opOf(c, id))!.lines.join('')).toContain('托管被恢复');
    late.stop();
    const reads = snapshots();
    const out = await c.opResend(id);
    expect(out).toMatchObject({ ok: true, warning: null });
    await idle(c);
    // judged on the check's read and again on one made right before the send
    expect(snapshots() - reads).toBeGreaterThanOrEqual(2);
    let r = opOf(c, id);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'ok', 'ok']);
    expect(r.steps[0].resent).toBe(1);
    expect(labelAdds('autopilot')).toHaveLength(2);
    expect(labelAdds('pending/agent')).toHaveLength(1);
    expect(labelRemoves('pending/human')).toHaveLength(1);
    // the first request lands now: the label was on already, GitHub records nothing new
    late.land();
    await c.syncNow();
    await idle(c);
    r = opOf(c, id);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'ok', 'ok']);
    expect(eventsOnGitHub('autopilot')).toEqual(['labeled by user-1']);
    expect(labelsOnGitHub()).toContain('autopilot');
    expect(labelAdds('pending/agent')).toHaveLength(1);
    expect(labelRemoves('pending/human')).toHaveLength(1);
  });

  it('asked to send again, but the check made first finds the first request landed: nothing is sent a second time, the rest goes on', async () => {
    const { c, late, id } = await autopilotNotLanded();
    late.land();
    late.stop();
    const reads = snapshots();
    const out = await c.opResend(id);
    expect(out).toMatchObject({ ok: true, warning: '核对时发现上一次请求已经生效，没有重发' });
    await idle(c);
    expect(snapshots()).toBeGreaterThan(reads);
    expect(labelAdds('autopilot')).toHaveLength(1);
    expect(opOf(c, id).steps.map((x) => x.state)).toEqual(['ok', 'ok', 'ok']);
    expect(opOf(c, id).steps[0].resent).toBeUndefined();
  });

  it('asked to send again after the item was closed, or after somebody touched the label: refused, nothing sent; the read did happen', async () => {
    for (const what of ['closed', 'touched'] as const) {
      dir = tempDir();
      const { c, late, id } = await autopilotNotLanded();
      late.stop();
      if (what === 'closed') fake.actAs('loop-bot', 'PATCH', `/repos/${REPO}/issues/${ISSUE}`, { state: 'closed' });
      else {
        // another account put the label on and took it off again
        fake.actAs('loop-bot', 'POST', `/repos/${REPO}/issues/${ISSUE}/labels`, { labels: ['autopilot'] });
        fake.actAs('loop-bot', 'DELETE', `/repos/${REPO}/issues/${ISSUE}/labels/autopilot`);
      }
      const reads = snapshots();
      const sent = labelAdds('autopilot').length;
      const out = await c.opResend(id);
      await idle(c);
      expect(out.ok).toBe(false);
      expect(out.error).toContain(what === 'closed' ? '这一条已经关闭' : '这期间这个标签被人动过');
      expect(snapshots()).toBeGreaterThan(reads);
      expect(labelAdds('autopilot')).toHaveLength(sent);
      expect(labelAdds('pending/agent')).toHaveLength(0);
      const r = opOf(c, id);
      expect(r.steps[0].state).toBe('unknown');
      if (what === 'touched') {
        expect(r.steps[0].check).toBe('touched');
        expect(opButtons(r)).toEqual(['unlock']);
      }
      c.stopTimer();
    }
  });

  it('the agent label and the "human" label: each says its own consequence, and is sent again the same way', async () => {
    // hand-back, the agent label never arrived
    fresh();
    let c = await ready();
    let late = fake.lateWhen(addOf('pending/agent'));
    let s = c.startOp({ kind: 'handBack', key: K(ISSUE) });
    await idle(c);
    let r = opOf(c, s.id!);
    expect(r.steps[0]).toMatchObject({ state: 'unknown', check: 'unseen', role: 'agent' });
    expect(opText(r)).toContain('「pending/agent」不确定有没有加上（已核对 1 次，到现在还没查到；原来那次请求仍可能稍后生效');
    expect(opResendConfirm(r)!.lines.join('')).toContain('这一条会被派两次工');
    expect(labelAdds('pending/agent')).toHaveLength(1);
    late.stop();
    expect((await c.opResend(s.id!)).ok).toBe(true);
    await idle(c);
    expect(opOf(c, s.id!).steps.map((x) => x.state)).toEqual(['ok', 'ok']);
    expect(labelAdds('pending/agent')).toHaveLength(2);
    expect(labelRemoves('pending/human')).toHaveLength(1);
    c.stopTimer();
    // hand-back, the agent label went on, taking "pending/human" off never arrived
    fresh();
    dir = tempDir();
    c = await ready();
    late = fake.lateWhen(removeOf('pending/human'));
    const removesBefore = labelRemoves('pending/human').length;
    s = c.startOp({ kind: 'handBack', key: K(ISSUE) });
    await idle(c);
    r = opOf(c, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'unknown']);
    expect(r.steps[1]).toMatchObject({ check: 'unseen', role: 'human' });
    expect(opText(r)).toContain('「pending/human」不确定有没有摘掉（已核对 1 次，到现在还没查到');
    expect(opResendConfirm(r)).toMatchObject({ title: '再发一次「摘掉 pending/human」？', after: null });
    expect(opResendConfirm(r)!.lines.join('')).toContain('可能被当成待派工');
    late.stop();
    expect((await c.opResend(s.id!)).ok).toBe(true);
    await idle(c);
    expect(opOf(c, s.id!).steps.map((x) => x.state)).toEqual(['ok', 'ok']);
    expect(labelRemoves('pending/human').length - removesBefore).toBe(2);
    expect(labelsOnGitHub()).not.toContain('pending/human');
  });

  it('proven, and nobody touched anything: the rest goes out by itself — the same start with the label taken off again by the same account, or the item closed: it stops', async () => {
    for (const what of ['untouched', 'revoked', 'closed'] as const) {
      fresh();
      dir = tempDir();
      const c = await ready();
      const agents = labelAdds('pending/agent').length;
      const removes = labelRemoves('pending/human').length;
      // the label lands, its answer is lost — and what happens next on GitHub happens before any read of the app
      const lost = fake.dropAnswerWhen(addOf('autopilot'), () => {
        if (what === 'revoked') me('DELETE', '/labels/autopilot');
        if (what === 'closed') me('PATCH', '', { state: 'closed' });
      });
      const reads = snapshots();
      const s = c.startOp({ kind: 'autopilot', key: K(ISSUE) });
      await idle(c);
      lost.stop();
      expect(lost.caught()).toBe(1);
      expect(snapshots()).toBeGreaterThan(reads);
      const r = opOf(c, s.id!);
      // done either way: this account's "labeled" record is there
      expect(r.steps[0].state).toBe('ok');
      if (what === 'untouched') {
        expect(r.steps.map((x) => x.state)).toEqual(['ok', 'ok', 'ok']);
        expect(labelAdds('pending/agent').length - agents).toBe(1);
        expect(labelRemoves('pending/human').length - removes).toBe(1);
      } else {
        expect(r.steps.map((x) => x.state)).toEqual(['ok', 'unsent', 'unsent']);
        expect(labelAdds('pending/agent').length - agents).toBe(0);
        expect(labelRemoves('pending/human').length - removes).toBe(0);
        expect(opText(r)).toContain(what === 'revoked' ? '这期间「autopilot」被摘掉了，没有接着往下做' : '这一条已经关闭，没有接着往下做');
        expect(opPhase(r)).toBe('settled');
        expect(opButtons(r)).toContain('retry');
        expect(opButtons(r)).not.toContain('finish');
        expect(opButtons(r)).not.toContain('resend');
      }
      c.stopTimer();
    }
  });

  it('the agent label is on, and the same account put "pending/human" on again meanwhile: it is not taken off; untouched: it is', async () => {
    for (const handedBack of [false, true]) {
      fresh();
      dir = tempDir();
      const c = await ready();
      const removes = labelRemoves('pending/human').length;
      const lost = fake.dropAnswerWhen(addOf('pending/agent'), () => {
        if (!handedBack) return;
        me('DELETE', `/labels/${encodeURIComponent('pending/human')}`);
        me('POST', '/labels', { labels: ['pending/human'] });
      });
      const s = c.startOp({ kind: 'handBack', key: K(ISSUE) });
      await idle(c);
      lost.stop();
      const r = opOf(c, s.id!);
      expect(r.steps[0].state).toBe('ok');
      expect(snapshots()).toBeGreaterThan(0);
      if (handedBack) {
        expect(r.steps[1].state).toBe('unsent');
        expect(labelRemoves('pending/human').length - removes).toBe(0);
        expect(labelsOnGitHub()).toContain('pending/human');
        expect(opText(r)).toContain('这期间「pending/human」被人动过，没有接着往下做');
        expect(opButtons(r)).toContain('finish');
      } else {
        expect(r.steps[1].state).toBe('ok');
        expect(labelRemoves('pending/human').length - removes).toBe(1);
      }
      c.stopTimer();
    }
  });

  it('judged twice: allowed on the check\'s read, the label taken off before the read made right before the send — not sent', async () => {
    fresh();
    let seen = 0;
    let armed = false;
    const meanwhile: { ok: boolean; error: string | null }[] = [];
    const c: Controller = await ready({
      intercept: (cmd, args) => {
        if (!armed || !JSON.stringify(args ?? '').includes('CavilOpSnapshot')) return undefined;
        seen++;
        // while the record reads before its next step, nothing else of this item starts: not a new hand-over, not "finish"
        if (seen === 1 && id) {
          meanwhile.push(c.startOp({ kind: 'handBack', key: K(ISSUE) }));
          void c.opFinish(id).then((x) => meanwhile.push(x));
        }
        if (seen === 2) me('DELETE', '/labels/autopilot');
        return undefined;
      },
    });
    let id = '';
    // armed once the request is out: the check's snapshot is the 1st, the one right before the next send the 2nd
    const lost = fake.dropAnswerWhen(addOf('autopilot'), () => (armed = true));
    const s = c.startOp({ kind: 'autopilot', key: K(ISSUE) });
    id = s.id!;
    await idle(c);
    lost.stop();
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(meanwhile).toHaveLength(2);
    expect(meanwhile.every((x) => !x.ok)).toBe(true);
    expect(meanwhile[0].error).toContain('还在自动处理剩下的步骤');
    const r = opOf(c, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'unsent', 'unsent']);
    expect(labelAdds('pending/agent')).toHaveLength(0);
    expect(opText(r)).toContain('这期间「autopilot」被摘掉了，没有接着往下做');
  });

  it('label records over several pages are read back to what was there before; a page that fails, or labels that do not add up: not read — nothing sent, nothing offered', async () => {
    for (const what of ['paged', 'page fails', 'does not add up'] as const) {
      fresh();
      // history from before the operation
      fake.actAs('loop-bot', 'POST', `/repos/${REPO}/issues/${ISSUE}/labels`, { labels: ['old'] });
      fake.actAs('loop-bot', 'DELETE', `/repos/${REPO}/issues/${ISSUE}/labels/old`);
      fake.state.w.eventPage = 2;
      fake.state.w.failEventPages = false;
      fake.state.w.staleSnapshotLabels = null;
      dir = tempDir();
      const c = await ready();
      const agents = labelAdds('pending/agent').length;
      const lost = fake.dropAnswerWhen(addOf('autopilot'), () => {
        // other labels come and go meanwhile: more new records than one page holds
        for (const l of ['x', 'y']) {
          fake.actAs('loop-bot', 'POST', `/repos/${REPO}/issues/${ISSUE}/labels`, { labels: [l] });
          fake.actAs('loop-bot', 'DELETE', `/repos/${REPO}/issues/${ISSUE}/labels/${l}`);
        }
        if (what === 'page fails') fake.state.w.failEventPages = true;
        if (what === 'does not add up') fake.state.w.staleSnapshotLabels = [{ name: 'pending/human' }, { name: 'autopilot' }, { name: 'from-nowhere' }];
      });
      const pagesBefore = fake.log.filter((e) => e.operation === 'CavilOpSnapshot' && (e.variables as any)?.before).length;
      const s = c.startOp({ kind: 'autopilot', key: K(ISSUE) });
      await idle(c);
      lost.stop();
      // older pages were asked for
      expect(fake.log.filter((e) => e.operation === 'CavilOpSnapshot' && (e.variables as any)?.before).length).toBeGreaterThan(pagesBefore);
      const r = opOf(c, s.id!);
      if (what === 'paged') {
        expect(r.steps.map((x) => x.state)).toEqual(['ok', 'ok', 'ok']);
        expect(labelAdds('pending/agent').length - agents).toBe(1);
      } else {
        // the label itself is read on / its record found on the newest page: that step is done; whether the rest may go out could not be read
        expect(r.steps.map((x) => x.state)).toEqual(['ok', 'unsent', 'unsent']);
        expect(labelAdds('pending/agent').length - agents).toBe(0);
        expect(opButtons(r)).not.toContain('resend');
        expect(r.halt ?? null).toBeNull();
        // the next round reads again; once it adds up the rest goes out
        fake.state.w.failEventPages = false;
        fake.state.w.staleSnapshotLabels = null;
        await c.syncNow();
        await idle(c);
        expect(opOf(c, s.id!).steps.map((x) => x.state)).toEqual(['ok', 'ok', 'ok']);
        expect(labelAdds('pending/agent').length - agents).toBe(1);
      }
      c.stopTimer();
    }
    fake.state.w.eventPage = 0;
  });

  it('not read in full is never "not found": no offer to send again, the notice says the read failed', async () => {
    fresh();
    const c = await ready();
    const late = fake.lateWhen(addOf('autopilot'));
    fake.state.w.eventPage = 1;
    // one label record from before, then the older page cannot be read
    const s = c.startOp({ kind: 'autopilot', key: K(ISSUE) });
    await until(() => late.caught() === 1, 'the request went out');
    fake.actAs('loop-bot', 'POST', `/repos/${REPO}/issues/${ISSUE}/labels`, { labels: ['x'] });
    fake.actAs('loop-bot', 'POST', `/repos/${REPO}/issues/${ISSUE}/labels`, { labels: ['y'] });
    fake.state.w.failEventPages = true;
    await idle(c);
    await c.opRecheck(s.id!);
    const r = opOf(c, s.id!);
    expect(r.steps[0]).toMatchObject({ state: 'unknown', check: 'unread' });
    expect(opButtons(r)).toEqual(['unlock']);
    expect(opText(r)).toContain('这次没能查证');
    expect(opText(r)).not.toContain('到现在还没查到');
    expect(labelAdds('autopilot')).toHaveLength(1);
    expect((await c.opResend(s.id!)).ok).toBe(false);
    expect(labelAdds('autopilot')).toHaveLength(1);
    fake.state.w.eventPage = 0;
    fake.state.w.failEventPages = false;
  });

  it('the read before the first request failed: checked, never offered for a second send, nothing goes on by itself', async () => {
    fresh();
    const c = await ready();
    fake.state.w.failEvents = true;
    const late = fake.lateWhen(addOf('autopilot'));
    const s = c.startOp({ kind: 'autopilot', key: K(ISSUE) });
    await until(() => late.caught() === 1, 'the request went out');
    fake.state.w.failEvents = false;
    await idle(c);
    expect(opOf(c, s.id!).before).toBeNull();
    const reads = snapshots();
    await c.opRecheck(s.id!);
    expect(snapshots()).toBeGreaterThan(reads);
    let r = opOf(c, s.id!);
    expect(r.steps[0]).toMatchObject({ state: 'unknown', check: 'unread' });
    expect(opButtons(r)).toEqual(['unlock']);
    // it lands: the label being on proves the step, but what was there before is not known — the rest waits for a person
    late.land();
    late.stop();
    await c.syncNow();
    await idle(c);
    r = opOf(c, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'unsent', 'unsent']);
    expect(labelAdds('pending/agent')).toHaveLength(0);
    expect(opButtons(r)).toContain('finish');
  });

  it('after a restart, and past the time limit: checked and proven, but the rest is not sent by itself', async () => {
    // restart
    let { c, late, id } = await autopilotNotLanded();
    c.stopTimer();
    late.land();
    late.stop();
    const c2 = await ready();
    await idle(c2);
    let r = opOf(c2, id);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'unsent', 'unsent']);
    expect(labelAdds('pending/agent')).toHaveLength(0);
    expect(opButtons(r)).toContain('finish');
    c2.stopTimer();
    // past the limit (here: 0 ms)
    dir = tempDir();
    ({ c, late, id } = await autopilotNotLanded({ opAutoMs: 0 }));
    const adds = labelAdds('pending/agent').length;
    late.land();
    late.stop();
    await c.syncNow();
    await idle(c);
    r = opOf(c, id);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'unsent', 'unsent']);
    expect(labelAdds('pending/agent').length).toBe(adds);
    expect(opText(r)).toContain('离发起已经超过 10 分钟，剩下的步骤不再自动发，没有接着往下做');
    expect(opButtons(r)).toContain('finish');
  });

  it('the later checks run by themselves: busy and nothing to choose while they run; the request landing in between is found and the rest goes out without a click', async () => {
    fresh();
    const c = await ready({ opCheckDelaysMs: [150, 150, 150] });
    const late = fake.lateWhen(addOf('autopilot'));
    const s = c.startOp({ kind: 'autopilot', key: K(ISSUE) });
    await until(() => (opOf(c, s.id!).checks ?? 0) >= 1 && opOf(c, s.id!).steps[0].state === 'unknown', 'the check made at once is through');
    let r = opOf(c, s.id!);
    expect(r.checking).toBe(true);
    expect(opTone(r)).toBe('busy');
    expect(opButtons(r)).toEqual([]);
    expect(opText(r)).toBe('正在托管…「autopilot」发出后没有收到 GitHub 的应答，正在自动核对有没有加上（第 2 次）');
    expect(opLockOf(c.getState().ops, K(ISSUE))?.id).toBe(s.id);
    late.land();
    late.stop();
    await idle(c);
    r = opOf(c, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'ok', 'ok']);
    expect(r.checking).toBeFalsy();
    expect(labelAdds('autopilot')).toHaveLength(1);
    expect(labelAdds('pending/agent')).toHaveLength(1);
    expect(labelRemoves('pending/human')).toHaveLength(1);
  });

  it('signing out while the later checks wait: they end there — the request landing afterwards is neither checked nor followed by anything', async () => {
    fresh();
    const c = await ready({ opCheckDelaysMs: [150, 150, 150] });
    const late = fake.lateWhen(addOf('autopilot'));
    const s = c.startOp({ kind: 'autopilot', key: K(ISSUE) });
    await until(() => (opOf(c, s.id!).checks ?? 0) >= 1 && opOf(c, s.id!).checking === true, 'the check made at once is through, the later ones wait');
    await c.logout();
    late.land();
    late.stop();
    const reads = snapshots();
    await idle(c);
    await new Promise((r) => setTimeout(r, 500));
    expect(c.getState().ops).toHaveLength(0);
    expect(snapshots()).toBe(reads);
    expect(labelsOnGitHub()).toContain('autopilot');
    expect(labelAdds('pending/agent')).toHaveLength(0);
    expect(labelRemoves('pending/human')).toHaveLength(0);
  });

  it('PR #365 code review round 1: GitHub sends part of the label list and the "human" label is not in it — not taken for removed; the record of the removal proves it once it lands', async () => {
    fresh();
    // 100 other labels ahead of "pending/human": every read that asks for the first 100 (or 50) leaves it out
    const fillers = Array.from({ length: 100 }, (_, i) => ({ name: `zz-${i}`, color: 'ededed' }));
    for (const p of fake.state.projects.get('org/gigleai/11')!) for (const node of p.items.nodes) if (node.content?.number === ISSUE) node.content.labels.nodes = [...fillers, ...node.content.labels.nodes];
    for (const r of fake.state.repos.get('gigleai/cavil-loop')!) if (r.number === ISSUE) r.labels = [...fillers, ...r.labels];
    const c = await ready();
    const late = fake.lateWhen(removeOf('pending/human'));
    const reads = snapshots();
    const s = c.startOp({ kind: 'handBack', key: K(ISSUE) });
    await idle(c);
    expect(late.caught()).toBe(1);
    // the check did read, and the read left "pending/human" out
    expect(snapshots()).toBeGreaterThan(reads);
    expect(labelsOnGitHub()).toContain('pending/human');
    let r = opOf(c, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'unknown']);
    expect(r.steps[1].check).toBe('unread');
    expect(opLockOf(c.getState().ops, K(ISSUE))?.id).toBe(s.id);
    expect(opText(r)).toContain('「pending/human」不确定有没有摘掉');
    expect(opText(r)).not.toContain('已交给 agent：');
    expect(opButtons(r)).not.toContain('resend');
    // a sync round does not take it for removed either
    await c.syncNow();
    await idle(c);
    expect(opOf(c, s.id!).steps[1].state).toBe('unknown');
    // the removal lands: its "unlabeled" record by this account proves it
    late.land();
    late.stop();
    expect(labelsOnGitHub()).not.toContain('pending/human');
    await c.syncNow();
    await idle(c);
    r = opOf(c, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'ok']);
    expect(r.steps[1].reason).toBe('在 GitHub 的标签记录里找到了这一步');
    expect(labelRemoves('pending/human')).toHaveLength(1);
  });

  it('the later checks run out: the notice turns into the warning with the two choices, still locked, nothing sent', async () => {
    fresh();
    const c = await ready({ opCheckDelaysMs: [20, 20, 20] });
    const late = fake.lateWhen(addOf('autopilot'));
    const s = c.startOp({ kind: 'autopilot', key: K(ISSUE) });
    await idle(c);
    const r = opOf(c, s.id!);
    expect(late.caught()).toBe(1);
    expect(r.checks).toBe(4);
    expect(r.checking).toBeFalsy();
    expect(opTone(r)).toBe('warn');
    expect(opButtons(r)).toEqual(['resend', 'unlock']);
    expect(opText(r)).toContain('已核对 4 次，到现在还没查到');
    expect(labelAdds('autopilot')).toHaveLength(1);
    expect(storedOps()?.find((x) => x.id === s.id)?.checking).toBeFalsy();
  });
});
