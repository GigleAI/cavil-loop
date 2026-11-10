// GitHub#357: a notice's colour follows what is going on with it. The controller against the fake
// GitHub over real HTTP, with the real back end (Rust) as a child process and a real SQLite file.
//
// Every entry that sends something (the evidence read, "补做剩下的步骤", "再试加入看板",
// "在某看板改成…", "重新发送", the look for same-title issues) is walked through its whole life:
// before, while its request is held on GitHub's side, after it failed, while the next attempt is
// held, after that one worked — the colour and the words are asserted at each step, from the
// state the window reads (the record / the job), never from a click's return value alone.
// Every "nothing happened" assertion has a "this did happen" sibling (the request reached GitHub).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, FakeGitHub, type LoggedRequest } from '../fake-github/server';
import { handleGraphql, type Store } from '../fake-github/writes';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import { opAutoDismissable, opButtons, opPhase, opText, opTone, type OpRecord } from '../../src/shared/ops';
import { createTone, editsTone } from '../../src/shared/noticeTone';
import type { CreateJob, EditMark } from '../../src/shared/types';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const PROJECT_KEY = 'project:org/gigleai/11';
const PROJECT_NODE = 'PVT_fixture_435fd6e043de';
const REPO = 'GigleAI/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;
const ISSUE = 138;
const ITEM = `gigleai/cavil-loop#${ISSUE}`;

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

const LOOKS = [150, 600, 1050];
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
  const c = await Controller.create({ backend: harness, endpoints, now: () => FIXTURE_NOW, defaultClientId: '', observeMs: 60_000, observeFirstMs: 60_000, opStuckMs: 600_000, watchLooksMs: LOOKS, watchVerifyMs: 200, followUpSyncMs: 60_000 });
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
  await c.settled();
};
const opOf = (c: Controller, id: string): OpRecord => {
  const r = c.getState().ops.find((x) => x.id === id);
  if (!r) throw new Error(`no op ${id}`);
  return r;
};
const jobOf = (c: Controller): CreateJob | undefined => c.getState().creates[0];
/** a hold on GitHub's side that also counts what it caught */
function holding(pred: (e: LoggedRequest) => boolean) {
  let caught = 0;
  const release = fake.holdWhen((e) => pred(e) && ++caught > 0);
  return { caught: () => caught, release };
}
const isRefresh = (e: LoggedRequest) => e.operation === 'CavilItemRefresh' && e.variables?.number === ISSUE;

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

describe('an answer that never came: checking is blue, a check that failed is red, the next check is blue again', () => {
  it('lost answer → the automatic check runs (blue) → it fails (red, "这次没能查证") → "重新查证据" runs (blue, the old failure gone) → proven closed (green, goes by itself)', async () => {
    const c = await ready();
    const late = fake.lateWhen((e) => e.method === 'PATCH' && e.path === `/api/repos/${REPO}/issues/${ISSUE}`);
    // the reads after the lost answer are held, and will fail once released
    fake.state.w.failRefresh.add(ITEM);
    const auto = holding(isRefresh);
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '' });
    await until(() => late.caught() === 1 && auto.caught() >= 1, 'the close went out, its answer was lost, the look into it is on its way');
    // 1. the automatic check is running
    let r = opOf(c, s.id!);
    expect(opPhase(r)).toBe('unknown');
    expect(r.checking).toBe(true);
    expect(opTone(r)).toBe('busy');
    expect(opText(r)).toContain(`不确定 issue #${ISSUE} 有没有关上`);
    expect(opText(r)).toContain('；正在查证…');
    expect(opButtons(r)).not.toContain('recheck');
    // still locked: nothing conflicting goes out while it is checked
    expect(c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '' }).ok).toBe(false);
    // 2. it ends without an answer
    auto.release();
    await idle(c);
    r = opOf(c, s.id!);
    expect(r.checking).toBe(false);
    expect(opPhase(r)).toBe('unknown');
    expect(opTone(r)).toBe('error');
    expect(opText(r)).toContain('；这次没能查证：重读这一条失败');
    expect(opText(r)).not.toContain('正在查证');
    expect(opButtons(r)).toContain('recheck');
    // 3. the person checks again: running, and the failure before it is no longer said
    const again = holding(isRefresh);
    const p = c.opRecheck(s.id!);
    await until(() => again.caught() === 1, 'the second check reached GitHub');
    r = opOf(c, s.id!);
    expect(r.checking).toBe(true);
    expect(opTone(r)).toBe('busy');
    expect(opText(r)).toContain('；正在查证…');
    expect(opText(r)).not.toContain('这次没能查证');
    // a second click meanwhile changes nothing and sends nothing
    const twice = await c.opRecheck(s.id!);
    expect(twice.ok).toBe(false);
    expect(again.caught()).toBe(1);
    expect(opTone(opOf(c, s.id!))).toBe('busy');
    // (the fake answers a held request with what it held when the request arrived: this one fails too)
    again.release();
    expect((await p).ok).toBe(false);
    expect(opTone(opOf(c, s.id!))).toBe('error');
    // 4. GitHub answers again, and the close has landed: the next check proves it
    fake.state.w.failRefresh.delete(ITEM);
    late.land();
    expect((await c.opRecheck(s.id!)).ok).toBe(true);
    await idle(c);
    r = opOf(c, s.id!);
    expect(r.checking).toBe(false);
    expect(r.steps.map((x) => x.state)).toEqual(['ok']);
    expect(opPhase(r)).toBe('settled');
    expect(opText(r)).not.toMatch(/查证/);
    // the re-read right after the lost answer had failed; a sync round catches that part up (GitHub#279,
    // yellow until then — whether one already ran by now is not this test's business)
    await c.syncNow();
    await idle(c);
    r = opOf(c, s.id!);
    expect(r.readProblem ?? null).toBeNull();
    expect(opTone(r)).toBe('ok');
    expect(opAutoDismissable(r)).toBe(true);
    // one close on GitHub in all
    expect(fake.writes().filter((w) => w.method === 'PATCH' && w.path === `/api/repos/${REPO}/issues/${ISSUE}`)).toHaveLength(1);
  });

  it('a check that read everything and still cannot tell is not a failure: yellow as before, no "这次没能查证"', async () => {
    const c = await ready();
    const late = fake.lateWhen((e) => e.method === 'PATCH' && e.path === `/api/repos/${REPO}/issues/${ISSUE}`);
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '' });
    await idle(c);
    expect(late.caught()).toBe(1);
    // the reads did go out and worked: the item is still open, nothing proves the close
    expect(fake.log.filter(isRefresh).length).toBeGreaterThan(0);
    const r = opOf(c, s.id!);
    expect(opPhase(r)).toBe('unknown');
    expect(r.checking).toBe(false);
    expect(r.checkProblem).toBeNull();
    expect(opTone(r)).toBe('warn');
  });

  it('left unknown by an earlier run: after the restart nothing is being checked — yellow, not blue, not red', async () => {
    const c = await ready();
    const late = fake.lateWhen((e) => e.method === 'PATCH' && e.path === `/api/repos/${REPO}/issues/${ISSUE}`);
    fake.state.w.failRefresh.add(ITEM);
    const auto = holding(isRefresh);
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '' });
    await until(() => late.caught() === 1 && opOf(c, s.id!).checking === true, 'checking');
    // stored while the check runs
    await (c as any).storeOps();
    c.stopTimer();
    auto.release();
    fake.state.w.failRefresh.delete(ITEM);
    const c2 = await ready();
    await idle(c2);
    const r = opOf(c2, s.id!);
    expect(r.steps[0].state).toBe('unknown');
    expect(r.checking).toBe(false);
    expect(opTone(r)).toBe('warn');
    expect(opText(r)).not.toContain('正在查证');
  });

  it('the account signs out while a check is held: its records go with it, nothing is written back when the read returns', async () => {
    const c = await ready();
    const late = fake.lateWhen((e) => e.method === 'PATCH' && e.path === `/api/repos/${REPO}/issues/${ISSUE}`);
    const auto = holding(isRefresh);
    const s = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '' });
    await until(() => late.caught() === 1 && auto.caught() >= 1 && opOf(c, s.id!).checking === true, 'checking, its read on GitHub\'s side');
    await c.logout();
    expect(c.getState().ops).toEqual([]);
    auto.release();
    await idle(c);
    expect(auto.caught()).toBeGreaterThan(0);
    expect(c.getState().ops).toEqual([]);
  });
});

describe('"补做剩下的步骤": preparing is blue, one that did nothing is red, the next one is blue again', () => {
  it('partly done (yellow) → finish, its read held (blue) → the read fails (red, "这次没能补做") → finish again (blue, the old failure gone) → it goes out as a new notice (blue → green)', async () => {
    waitingForHuman();
    const c = await ready();
    fake.state.w.failLabel = 'pending/agent';
    const s = c.startOp({ kind: 'autopilot', key: K(ISSUE) });
    await idle(c);
    let r = opOf(c, s.id!);
    expect(r.steps.map((x) => x.state)).toEqual(['ok', 'refused', 'unsent']);
    // nobody tried to finish it yet
    expect(opTone(r)).toBe('warn');
    fake.state.w.failLabel = null;
    // 1. the first finish: its read is held, then fails
    fake.state.w.failRefresh.add(ITEM);
    const first = holding(isRefresh);
    const p1 = c.opFinish(s.id!);
    await until(() => first.caught() === 1, 'the read before finishing reached GitHub');
    r = opOf(c, s.id!);
    expect(r.finishing).toBe(true);
    expect(opTone(r)).toBe('busy');
    expect(opText(r)).toContain('；正在补做…');
    expect(opButtons(r)).toEqual([]);
    // a second click meanwhile: refused, nothing changes, nothing more goes out
    expect((await c.opFinish(s.id!)).ok).toBe(false);
    expect(first.caught()).toBe(1);
    expect(opTone(opOf(c, s.id!))).toBe('busy');
    first.release();
    const out1 = await p1;
    expect(out1.ok).toBe(false);
    r = opOf(c, s.id!);
    expect(r.finishing).toBe(false);
    expect(opTone(r)).toBe('error');
    expect(opText(r)).toContain('；这次没能补做：重读这一条失败，什么都没发');
    expect(opButtons(r)).toEqual(['finish', 'dismiss']);
    // nothing was sent by it
    const addsBefore = fake.writes().filter((w) => w.method === 'POST' && w.path.endsWith(`/issues/${ISSUE}/labels`)).length;
    // 2. again: running, the failure before it is no longer said
    fake.state.w.failRefresh.delete(ITEM);
    const second = holding(isRefresh);
    const p2 = c.opFinish(s.id!);
    await until(() => second.caught() === 1, 'the second read reached GitHub');
    r = opOf(c, s.id!);
    expect(opTone(r)).toBe('busy');
    expect(opText(r)).toContain('；正在补做…');
    expect(opText(r)).not.toContain('这次没能补做');
    second.release();
    const out2 = await p2;
    expect(out2.ok).toBe(true);
    // 3. the rest went out as a new record; the old notice is put away, not left red or busy
    const old = c.getState().ops.find((x) => x.id === s.id);
    expect(old === undefined || (old.dismissed && !old.finishing && !old.finishProblem)).toBe(true);
    await idle(c);
    const fresh = opOf(c, out2.id!);
    expect(fresh.steps.every((x) => x.state === 'ok')).toBe(true);
    expect(opTone(fresh)).toBe('ok');
    expect(opAutoDismissable(fresh)).toBe(true);
    expect(fake.writes().filter((w) => w.method === 'POST' && w.path.endsWith(`/issues/${ISSUE}/labels`)).length).toBe(addsBefore + 1);
  });

  it('a finish that cannot start (another operation holds the item) says why on the notice: red', async () => {
    waitingForHuman();
    const c = await ready();
    fake.state.w.failLabel = 'pending/agent';
    const s = c.startOp({ kind: 'autopilot', key: K(ISSUE) });
    await idle(c);
    fake.state.w.failLabel = null;
    // a close of the same item is on its way
    const held = holding((e) => e.method === 'PATCH' && e.path === `/api/repos/${REPO}/issues/${ISSUE}`);
    const close = c.startOp({ kind: 'closeIssue', key: K(ISSUE), reason: 'completed', comment: '' });
    expect(close.ok).toBe(true);
    await until(() => held.caught() === 1, 'the close reached GitHub');
    const out = await c.opFinish(s.id!);
    expect(out.ok).toBe(false);
    const r = opOf(c, s.id!);
    expect(r.finishing).toBe(false);
    expect(opTone(r)).toBe('error');
    expect(opText(r)).toContain('；这次没能补做：上一次操作还没结清');
    held.release();
    await idle(c);
  });
});

describe('a new issue that missed its board: "再试加入看板"', () => {
  const create = (c: Controller, title: string) => c.startCreate({ kind: 'createIssue', repo: REPO, title, body: '', labels: [], projects: [PROJECT_KEY] });
  const isJoin = (e: LoggedRequest) => e.operation === 'CavilAddProjectItem';
  async function missed(c: Controller, title: string) {
    fake.state.w.readOnlyProjects.add('org/gigleai/11');
    await create(c, title);
    await until(() => jobOf(c)?.status === 'partial', 'partial');
    return jobOf(c)!;
  }

  it('never retried (yellow) → retry held (blue) → it fails (red, with this attempt\'s reason) → retry held again (blue, the reason gone) → it works (the notice goes)', async () => {
    const c = await ready();
    const job = await missed(c, 'retry life');
    expect(createTone(job)).toBe('warn');
    expect(job.actionError ?? null).toBeNull();
    const joinsBefore = fake.log.filter(isJoin).length;
    // 1. held
    const first = holding(isJoin);
    const p1 = c.retryCreateProjects(job.id);
    await until(() => first.caught() === 1, 'the retry reached GitHub');
    expect(jobOf(c)!.retrying).toBe(true);
    expect(createTone(jobOf(c)!)).toBe('busy');
    // a second click meanwhile: refused, no second request, still running
    const twice = await c.retryCreateProjects(job.id);
    expect(twice.ok).toBe(false);
    expect(first.caught()).toBe(1);
    expect(createTone(jobOf(c)!)).toBe('busy');
    // 2. refused again
    first.release();
    const out1 = await p1;
    expect(out1.ok).toBe(false);
    expect(jobOf(c)!.retrying).toBe(false);
    expect(jobOf(c)!.actionError).toBe(out1.error);
    expect(jobOf(c)!.actionError).toMatch(/cavil project/);
    expect(createTone(jobOf(c)!)).toBe('error');
    // 3. once more (the board takes it now): running, the reason of the attempt before is gone the moment it starts
    fake.state.w.readOnlyProjects.delete('org/gigleai/11');
    const second = holding(isJoin);
    const p2 = c.retryCreateProjects(job.id);
    await until(() => second.caught() === 1, 'the second retry reached GitHub');
    expect(jobOf(c)!.retrying).toBe(true);
    expect(jobOf(c)!.actionError ?? null).toBeNull();
    expect(createTone(jobOf(c)!)).toBe('busy');
    // 4. it joined
    second.release();
    expect((await p2).ok).toBe(true);
    expect(c.getState().creates).toEqual([]);
    expect(fake.log.filter(isJoin).length).toBe(joinsBefore + 2);
  });

  it('the notice is closed while the retry is held: it stays closed when the retry returns (nothing brings it back)', async () => {
    const c = await ready();
    const job = await missed(c, 'closed meanwhile');
    const held = holding(isJoin);
    const p = c.retryCreateProjects(job.id);
    await until(() => held.caught() === 1, 'the retry reached GitHub');
    c.dismissCreate(job.id);
    expect(c.getState().creates).toEqual([]);
    held.release();
    await p;
    expect(c.getState().creates).toEqual([]);
  });

  it('the account signs out while the retry is held: its notices go with it and are not written back', async () => {
    const c = await ready();
    const job = await missed(c, 'signed out meanwhile');
    const held = holding(isJoin);
    const p = c.retryCreateProjects(job.id);
    await until(() => held.caught() === 1, 'the retry reached GitHub');
    await c.logout();
    expect(c.getState().creates).toEqual([]);
    held.release();
    await p;
    expect(c.getState().creates).toEqual([]);
  });

  it('a retry that joins the board but cannot set its field ends red with that reason', async () => {
    const c = await ready();
    fake.state.w.readOnlyProjects.add('org/gigleai/11');
    await c.startCreate({ kind: 'createIssue', repo: REPO, title: 'field fails', body: '', labels: [], projects: [PROJECT_KEY], plan: { milestone: null, projects: [{ projectKey: PROJECT_KEY, iterationId: null, status: 'In progress' }] } });
    await until(() => jobOf(c)?.status === 'partial', 'partial');
    const job = jobOf(c)!;
    fake.state.w.readOnlyProjects.delete('org/gigleai/11');
    const held = holding(isJoin);
    const p = c.retryCreateProjects(job.id);
    await until(() => held.caught() === 1, 'the join reached GitHub');
    expect(createTone(jobOf(c)!)).toBe('busy');
    fake.state.w.readOnlyProjects.add('org/gigleai/11');
    held.release();
    const r = await p;
    expect(r.warning).toMatch(/字段没设上/);
    expect(jobOf(c)!.retrying).toBe(false);
    expect(jobOf(c)!.actionError).toMatch(/字段没设上/);
    expect(createTone(jobOf(c)!)).toBe('error');
  });
});

describe('a board that took the new issue in by itself: "在某看板改成…" and the automatic write', () => {
  const store = (): Store => ({ projects: fake.state.projects, repos: fake.state.repos, w: fake.state.w });
  const nodeIdOf = (n: number) => fake.state.repos.get('gigleai/cavil-loop')!.find((r: any) => r.number === n)!.node_id as string;
  const statusField = () => fake.state.projects.get('org/gigleai/11')![0].fields.nodes.find((f: any) => f.name === 'Status') as any;
  const boardNode = (n: number) =>
    fake.state.projects
      .get('org/gigleai/11')!
      .flatMap((p) => p.items.nodes)
      .find((x: any) => x.content?.repository?.nameWithOwner?.toLowerCase() === 'gigleai/cavil-loop' && x.content.number === n) as any;
  function githubAdds(n: number, status: string | null = null) {
    const r = handleGraphql(store(), 'CavilAddProjectItem', { projectId: PROJECT_NODE, contentId: nodeIdOf(n) }) as any;
    expect(r.data?.addProjectV2ItemById?.item?.id).toBeTruthy();
    if (status) {
      const f = statusField();
      const o = f.options.find((x: any) => x.name === status);
      expect((handleGraphql(store(), 'CavilSetStatus', { projectId: PROJECT_NODE, itemId: boardNode(n).id, fieldId: f.id, optionId: o.id }) as any).errors).toBeUndefined();
    }
  }
  const WATCH = { projectKey: PROJECT_KEY, iterationId: null, status: 'In progress', label: 'In progress' };
  async function createInGroup(c: Controller, title: string): Promise<number> {
    const r = await c.startCreate({ kind: 'createIssue', repo: REPO, title, body: '', labels: [], projects: [], plan: { milestone: null, projects: [], watch: [WATCH] } });
    expect(r.ok).toBe(true);
    await until(() => c.getState().focus !== null, 'created');
    return Number(c.getState().focus!.key.split('#')[1]);
  }
  const isBoardRead = (e: LoggedRequest) => e.operation === 'CavilCreatedItemBoards';
  const watchOf = (c: Controller) => jobOf(c)?.watch?.find((w) => w.projectKey === PROJECT_KEY);

  it('another value, a person decides (yellow) → the button held (blue) → refused (red, the reason on the notice) → held again (blue, the reason gone) → written (not red, not busy)', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'apply life');
    githubAdds(n, 'Backlog');
    await until(() => watchOf(c)?.state === 'human', 'the notice with its button');
    // the timed looks are over before the clicks (they read the same thing)
    await new Promise((r) => setTimeout(r, LOOKS[2] + 300));
    expect(createTone(jobOf(c)!)).toBe('warn');
    const id = jobOf(c)!.id;
    // 1. the click: its read is held; GitHub will refuse the write
    fake.state.w.readOnlyProjects.add('org/gigleai/11');
    const first = holding(isBoardRead);
    const p1 = c.applyCreateWatch(id, PROJECT_KEY);
    await until(() => first.caught() === 1, 'the read before writing reached GitHub');
    expect(watchOf(c)!.busy).toBe(true);
    expect(createTone(jobOf(c)!)).toBe('busy');
    first.release();
    const out1 = await p1;
    expect(out1.ok).toBe(false);
    // the write did go out and was refused
    expect(fake.log.filter((e) => e.operation === 'CavilSetStatus').length).toBe(1);
    expect(watchOf(c)!.busy).toBe(false);
    expect(jobOf(c)!.actionError).toBe(out1.error);
    expect(jobOf(c)!.actionError).toMatch(/权限/);
    expect(createTone(jobOf(c)!)).toBe('error');
    // 2. again (GitHub accepts the write now): running, the reason of the attempt before is gone
    fake.state.w.readOnlyProjects.delete('org/gigleai/11');
    const second = holding(isBoardRead);
    const p2 = c.applyCreateWatch(id, PROJECT_KEY);
    await until(() => second.caught() === 1, 'the second read reached GitHub');
    expect(watchOf(c)!.busy).toBe(true);
    expect(jobOf(c)!.actionError ?? null).toBeNull();
    expect(createTone(jobOf(c)!)).toBe('busy');
    second.release();
    expect((await p2).ok).toBe(true);
    // written and being checked in the background: no longer this click's request, and nothing failed
    const after = jobOf(c);
    expect(after === undefined || (createTone(after) !== 'busy' && createTone(after) !== 'error')).toBe(true);
    await until(() => c.getState().creates.length === 0, 'checked, the notice is gone');
  });

  it('the board changed since the notice: the click writes nothing, says so on the notice (red), and leaves no board marked as being worked on', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'stale');
    githubAdds(n, 'Backlog');
    await until(() => watchOf(c)?.state === 'human', 'the notice with its button');
    const f = statusField();
    const done = f.options.find((x: any) => x.name === 'Done');
    handleGraphql(store(), 'CavilSetStatus', { projectId: PROJECT_NODE, itemId: boardNode(n).id, fieldId: f.id, optionId: done.id });
    const out = await c.applyCreateWatch(jobOf(c)!.id, PROJECT_KEY);
    expect(out.ok).toBe(false);
    expect(watchOf(c)).toMatchObject({ state: 'human', seen: 'Done', busy: false });
    expect(jobOf(c)!.actionError).toContain('「Done」');
    expect(createTone(jobOf(c)!)).toBe('error');
  });

  it('the automatic write was refused: the notice is red without anybody clicking', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'auto refused');
    githubAdds(n);
    fake.state.w.readOnlyProjects.add('org/gigleai/11');
    await until(() => watchOf(c)?.state === 'failed', 'the automatic write was refused');
    // it did go out
    expect(fake.log.filter((e) => e.operation === 'CavilSetStatus').length).toBeGreaterThan(0);
    expect(createTone(jobOf(c)!)).toBe('error');
  });

  it('never read whether the board took it in: red once the looks are over; while they still run the notice is not busy', async () => {
    const c = await ready();
    fake.state.w.failCreatedBoards = 99;
    await createInGroup(c, 'unread');
    // looks are a background loop: no notice yet, and never "busy" because of them
    expect(jobOf(c) === undefined || createTone(jobOf(c)!) !== 'busy').toBe(true);
    await until(() => watchOf(c)?.state === 'unread', 'the last look could not read it');
    expect(fake.log.filter(isBoardRead).length).toBeGreaterThan(0);
    expect(createTone(jobOf(c)!)).toBe('error');
  });
});

describe('no answer to the create: the look for same-title issues', () => {
  const isList = (e: LoggedRequest) => e.method === 'GET' && e.path.includes(`/repos/${REPO}/issues`) && e.path.includes('since=');

  it('looking is blue; once the look is over the notice is yellow again (still "not sure")', async () => {
    const c = await ready();
    const lost = fake.dropAnswerWhen((e) => e.method === 'POST' && e.path === `/api/repos/${REPO}/issues`);
    const held = holding(isList);
    await c.startCreate({ kind: 'createIssue', repo: REPO, title: 'lost create', body: '', labels: [], projects: [] });
    await until(() => lost.caught() === 1 && held.caught() === 1, 'the create went out, its answer was lost, the look is on its way');
    expect(jobOf(c)).toMatchObject({ status: 'unknown', looking: true });
    expect(createTone(jobOf(c)!)).toBe('busy');
    held.release();
    await until(() => jobOf(c)?.looking === false, 'the look is over');
    // the look did come back with a list (how many it holds is the look's own business, tested with GitHub#229)
    expect(Array.isArray(jobOf(c)!.candidates)).toBe(true);
    expect(jobOf(c)!.lookError ?? null).toBeNull();
    expect(createTone(jobOf(c)!)).toBe('warn');
  });

  it('a look that fails is said on the notice: red', async () => {
    const c = await ready();
    const lost = fake.dropAnswerWhen((e) => e.method === 'POST' && e.path === `/api/repos/${REPO}/issues`);
    // the list read loses its connection too
    const cut = fake.holdWhen(isList);
    await c.startCreate({ kind: 'createIssue', repo: REPO, title: 'lost create, lost look', body: '', labels: [], projects: [] });
    await until(() => lost.caught() === 1 && jobOf(c)?.looking === true, 'looking');
    await fake.close();
    cut();
    await until(() => jobOf(c)?.looking === false, 'the look is over');
    expect(jobOf(c)!.lookError).toBeTruthy();
    expect(createTone(jobOf(c)!)).toBe('error');
    // the fake is gone for the rest of this test: start another one for afterEach to close
    fake = await startFakeGitHub();
  });
});

describe('changes not saved: "重新发送"', () => {
  const markOf = (c: Controller): EditMark | null => c.getBoardData().items.find((i) => i.key === K(ISSUE))?.edits?.find((m) => m.field === 'label') ?? null;

  it('red → the resend\'s check read held (blue) → refused again (red) → held again (blue) → saved (the notice is gone)', async () => {
    const c = await ready();
    fake.state.w.failLabel = 'x-fail';
    expect((await c.act({ kind: 'addLabel', key: K(ISSUE), label: 'x-fail', color: '000000' })).ok).toBe(false);
    const id = markOf(c)!.id;
    expect(c.getState().editsNeedingAction).toBe(1);
    expect(c.getState().editsResending).toEqual([]);
    expect(editsTone(c.getState().editsResending.length > 0)).toBe('error');
    const posts = () => fake.writes().filter((w) => w.method === 'POST' && w.path.endsWith(`/issues/${ISSUE}/labels`)).length;
    expect(posts()).toBe(1);
    // 1. held, then refused again
    const first = holding(isRefresh);
    const p1 = c.resendEdit(id);
    await until(() => first.caught() === 1, 'the check before resending reached GitHub');
    expect(c.getState().editsResending).toEqual([id]);
    expect(editsTone(c.getState().editsResending.length > 0)).toBe('busy');
    first.release();
    expect((await p1).ok).toBe(false);
    expect(posts()).toBe(2);
    expect(c.getState().editsResending).toEqual([]);
    expect(c.getState().editsNeedingAction).toBe(1);
    expect(markOf(c)!.status).toBe('failed');
    // 2. held again, then saved
    fake.state.w.failLabel = null;
    const second = holding(isRefresh);
    const p2 = c.resendEdit(id);
    await until(() => second.caught() === 1, 'the second check reached GitHub');
    expect(c.getState().editsResending).toEqual([id]);
    second.release();
    expect((await p2).ok).toBe(true);
    expect(posts()).toBe(3);
    expect(c.getState().editsResending).toEqual([]);
    expect(c.getState().editsNeedingAction).toBe(0);
  });

  it('"全部重新发送" reads as running until the last one is through', async () => {
    const c = await ready();
    fake.state.w.failLabel = 'x-fail';
    expect((await c.act({ kind: 'addLabel', key: K(ISSUE), label: 'x-fail', color: '000000' })).ok).toBe(false);
    const id = markOf(c)!.id;
    const held = holding(isRefresh);
    const p = c.resendAllEdits();
    await until(() => held.caught() === 1, 'the check reached GitHub');
    expect(c.getState().editsResending).toEqual([id]);
    held.release();
    await p;
    expect(c.getState().editsResending).toEqual([]);
  });

  it('signing out while a resend is held leaves nothing marked as running', async () => {
    const c = await ready();
    fake.state.w.failLabel = 'x-fail';
    await c.act({ kind: 'addLabel', key: K(ISSUE), label: 'x-fail', color: '000000' });
    const held = holding(isRefresh);
    const p = c.resendEdit(markOf(c)!.id);
    await until(() => held.caught() === 1, 'the check reached GitHub');
    await c.logout();
    expect(c.getState().editsResending).toEqual([]);
    held.release();
    await p;
    expect(c.getState().editsResending).toEqual([]);
  });
});
