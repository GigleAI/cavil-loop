// GitHub#258: a new issue from a status / iteration group's "+" that a board NOT ticked takes in
// by itself (GitHub's own auto-add, simulated here straight on the fake's store — not through
// the API, so it is never mistaken for a write of the client). The controller against the fake
// GitHub over real HTTP, the real back end as a child process, a real SQLite file.
//
// The rule under test: empty → set once; already the group's value → done; any other value →
// never overwritten automatically, only by the notice's button, and only while the board still
// holds the value the notice showed. Every "nothing was written" assertion has a sibling proving
// the watch really ran (its reads went out; the same set-up with an empty field does write).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, FakeGitHub } from '../fake-github/server';
import { handleGraphql, type Store } from '../fake-github/writes';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import type { CreateJob } from '../../src/shared/types';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const PROJECT_KEY = 'project:org/gigleai/11';
const PROJECT_NODE = 'PVT_fixture_435fd6e043de';
const REPO = 'GigleAI/cavil-loop';

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

// wide enough gaps for a loaded machine: the tests act between two looks
const LOOKS = [150, 600, 1050];
const VERIFY = 200;
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

async function ready(opts: { looks?: number[] } = {}) {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const clock = { t: FIXTURE_NOW };
  const endpoints = { api: fake.api, web: fake.web };
  const harness = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: () => clock.t, sleep: async () => {} });
  backends.push(harness);
  const c = await Controller.create({ backend: harness, endpoints, now: () => clock.t, defaultClientId: '', watchLooksMs: opts.looks ?? LOOKS, watchVerifyMs: VERIFY, followUpSyncMs: 60_000 });
  controllers.push(c);
  c.addSource(PROJECT_URL);
  c.addSource(REPO);
  await c.start();
  await c.syncNow();
  expect(c.getState().phase).toBe('ready');
  return c;
}

async function until(pred: () => boolean, what: string) {
  for (let i = 0; i < 6000; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout waiting for: ${what}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const store = (): Store => ({ projects: fake.state.projects, repos: fake.state.repos, w: fake.state.w });
const nodeIdOf = (n: number) => fake.state.repos.get('gigleai/cavil-loop')!.find((r: any) => r.number === n)!.node_id as string;
const statusField = () => fake.state.projects.get('org/gigleai/11')![0].fields.nodes.find((f: any) => f.name === 'Status') as any;
const iterationField = () => fake.state.projects.get('org/gigleai/11')![0].fields.nodes.find((f: any) => f.name === 'Iteration') as any;
const boardNode = (n: number) =>
  fake.state.projects
    .get('org/gigleai/11')!
    .flatMap((p) => p.items.nodes)
    .find((x: any) => x.content?.repository?.nameWithOwner?.toLowerCase() === 'gigleai/cavil-loop' && x.content.number === n) as any;

/** GitHub's own auto-add (and, optionally, a board rule / a person setting the status), on GitHub's side */
function githubAdds(n: number, status: string | null = null) {
  const r = handleGraphql(store(), 'CavilAddProjectItem', { projectId: PROJECT_NODE, contentId: nodeIdOf(n) }) as any;
  expect(r.data?.addProjectV2ItemById?.item?.id).toBeTruthy();
  if (status) setOnGitHub(n, status);
}
function setOnGitHub(n: number, status: string) {
  const f = statusField();
  const o = f.options.find((x: any) => x.name === status);
  const r = handleGraphql(store(), 'CavilSetStatus', { projectId: PROJECT_NODE, itemId: boardNode(n).id, fieldId: f.id, optionId: o.id }) as any;
  expect(r.errors).toBeUndefined();
}
const statusOnGitHub = (n: number): string | null => boardNode(n)?.fieldValues.nodes.find((v: any) => v.field?.id === statusField().id)?.name ?? null;
const iterationOnGitHub = (n: number): string | null => boardNode(n)?.fieldValues.nodes.find((v: any) => v.field?.id === iterationField().id)?.title ?? null;

const reads = () => fake.log.filter((e) => e.operation === 'CavilCreatedItemBoards').length;
const fieldWrites = () => fake.writes().filter((w) => w.operation === 'CavilSetStatus' || w.operation === 'CavilSetIteration' || w.operation === 'CavilClearField');
const joins = () => fake.writes().filter((w) => w.operation === 'CavilAddProjectItem').length;

const WATCH_STATUS = { projectKey: PROJECT_KEY, iterationId: null, status: 'In progress', label: 'In progress' };

/** a new issue from the "In progress" group's "+", no board ticked; resolves to its number */
async function createInGroup(c: Controller, title: string, watch: any[] = [WATCH_STATUS], projects: string[] = []): Promise<number> {
  const r = await c.startCreate({ kind: 'createIssue', repo: REPO, title, body: '', labels: [], projects, plan: { milestone: null, projects: projects.map((k) => ({ projectKey: k, iterationId: null, status: 'In progress' })), watch } });
  expect(r.ok).toBe(true);
  await until(() => c.getState().focus !== null, 'created');
  return Number(c.getState().focus!.key.split('#')[1]);
}
const jobOf = (c: Controller): CreateJob | undefined => c.getState().creates[0];

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
});
afterEach(async () => {
  for (const c of controllers) c.stopTimer();
  // let watches still sleeping run out against a closed fake: their failures are swallowed
  await Promise.all(backends.map((b) => b.close()));
  for (const c of caches) c.close();
  caches = [];
  controllers = [];
  backends = [];
  await fake.close();
});

describe('GitHub#258: the board took it in with the field empty → set once, checked, no notice', () => {
  it('status: set to the group value; the check reads it back; the job goes and the board shows it in that group', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'empty status');
    // the job exists while it watches, without a notice
    expect(jobOf(c)?.status).toBe('watching');
    githubAdds(n);
    await until(() => fieldWrites().length === 1, 'the status write');
    expect(statusOnGitHub(n)).toBe('In progress');
    await until(() => c.getState().creates.length === 0, 'job settled');
    expect(fieldWrites()).toHaveLength(1);
    // never added by the client: GitHub did
    expect(joins()).toBe(0);
    await until(() => c.getBoardData().items.some((i) => i.number === n && i.projects.some((m) => m.projectKey === PROJECT_KEY && m.status === 'In progress')), 'shown in the group');
    // after the last look nothing more goes out
    const r0 = reads();
    await sleep(LOOKS[2] + VERIFY * 4);
    expect(reads()).toBe(r0);
    expect(fieldWrites()).toHaveLength(1);
  });

  it('iteration: the same for an iteration group', async () => {
    const c = await ready();
    const it25 = iterationField().configuration.iterations.find((x: any) => x.title === 'Iteration 25');
    const n = await createInGroup(c, 'empty iteration', [{ projectKey: PROJECT_KEY, iterationId: it25.id, status: null, label: 'Iteration 25' }]);
    githubAdds(n);
    await until(() => c.getState().creates.length === 0, 'job settled');
    expect(fieldWrites().map((w) => w.operation)).toEqual(['CavilSetIteration']);
    expect(iterationOnGitHub(n)).toBe('Iteration 25');
    expect(statusOnGitHub(n)).toBeNull();
  });

  it('found only at the last look: still set, and checked after the looks have ended', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'last look');
    await until(() => reads() === 2, 'two looks');
    githubAdds(n);
    await until(() => fieldWrites().length === 1, 'the write');
    const r0 = reads();
    await until(() => c.getState().creates.length === 0, 'checked');
    expect(reads()).toBeGreaterThan(r0);
    expect(statusOnGitHub(n)).toBe('In progress');
  });
});

describe('GitHub#258: another value already there → never overwritten automatically', () => {
  it('a value before the first look (a board rule or a person — the client cannot tell): no write, the notice shows it with a button', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'preset backlog');
    githubAdds(n, 'Backlog');
    await until(() => jobOf(c)?.status === 'partial', 'notice');
    const job = jobOf(c)!;
    expect(job.watch).toMatchObject([{ projectKey: PROJECT_KEY, state: 'human', seen: 'Backlog' }]);
    expect(job.message).toContain('「Backlog」');
    expect(job.message).toContain('没有自动改成「In progress」');
    expect(fieldWrites()).toHaveLength(0);
    expect(reads()).toBeGreaterThan(0);
    // the remaining looks leave it as it is
    await sleep(LOOKS[2] + VERIFY);
    expect(fieldWrites()).toHaveLength(0);
    expect(statusOnGitHub(n)).toBe('Backlog');
    // the person clicks: read again, still Backlog → written, checked, the notice goes
    const r = await c.applyCreateWatch(job.id, PROJECT_KEY);
    expect(r).toMatchObject({ ok: true });
    expect(fieldWrites()).toHaveLength(1);
    await until(() => c.getState().creates.length === 0, 'checked');
    expect(statusOnGitHub(n)).toBe('In progress');
  });

  it('added, then changed to Done before the client first looks: Done is kept', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'changed before seen');
    githubAdds(n);
    setOnGitHub(n, 'Done');
    await until(() => jobOf(c)?.status === 'partial', 'notice');
    expect(jobOf(c)!.watch).toMatchObject([{ state: 'human', seen: 'Done' }]);
    expect(fieldWrites()).toHaveLength(0);
    expect(statusOnGitHub(n)).toBe('Done');
  });

  it('the button when the board changed since the notice: nothing written, the notice shows the new value', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'stale button');
    githubAdds(n, 'Backlog');
    await until(() => jobOf(c)?.status === 'partial', 'notice');
    setOnGitHub(n, 'Done');
    const r = await c.applyCreateWatch(jobOf(c)!.id, PROJECT_KEY);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('「Done」');
    expect(fieldWrites()).toHaveLength(0);
    expect(jobOf(c)!.watch).toMatchObject([{ state: 'human', seen: 'Done', busy: false }]);
    expect(jobOf(c)!.message).toContain('「Done」');
    // a second click on what is shown now does write
    expect((await c.applyCreateWatch(jobOf(c)!.id, PROJECT_KEY)).ok).toBe(true);
    expect(fieldWrites()).toHaveLength(1);
  });

  it('the button refused by GitHub: the reason comes back, the board stays offered as it was', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'button refused');
    githubAdds(n, 'Backlog');
    await until(() => jobOf(c)?.status === 'partial', 'notice');
    fake.state.w.readOnlyProjects.add('org/gigleai/11');
    const r = await c.applyCreateWatch(jobOf(c)!.id, PROJECT_KEY);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/权限/);
    // the write really went out and was refused
    expect(fake.log.filter((e) => e.operation === 'CavilSetStatus').length).toBe(1);
    expect(jobOf(c)!.watch).toMatchObject([{ state: 'human', seen: 'Backlog', busy: false }]);
    fake.state.w.readOnlyProjects.delete('org/gigleai/11');
    expect((await c.applyCreateWatch(jobOf(c)!.id, PROJECT_KEY)).ok).toBe(true);
    await until(() => c.getState().creates.length === 0, 'checked');
    expect(statusOnGitHub(n)).toBe('In progress');
  });

  it('set, then cleared by somebody before the check: not written again automatically', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'cleared after write');
    githubAdds(n);
    await until(() => fieldWrites().length === 1, 'the write');
    const node = boardNode(n);
    node.fieldValues.nodes = node.fieldValues.nodes.filter((v: any) => v.field?.id !== statusField().id);
    await until(() => jobOf(c)?.status === 'partial', 'notice');
    expect(jobOf(c)!.watch).toMatchObject([{ state: 'human', seen: null, writes: 1 }]);
    await sleep(LOOKS[2] + VERIFY * 2);
    expect(fieldWrites()).toHaveLength(1);
    expect(statusOnGitHub(n)).toBeNull();
  });

  it('set, then changed by somebody before the check: not written again, the notice says what it is now', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'changed after write');
    githubAdds(n);
    await until(() => fieldWrites().length === 1, 'the write');
    setOnGitHub(n, 'Done');
    await until(() => jobOf(c)?.status === 'partial', 'notice');
    expect(jobOf(c)!.watch).toMatchObject([{ state: 'human', seen: 'Done', writes: 1 }]);
    await sleep(LOOKS[2] + VERIFY * 2);
    expect(fieldWrites()).toHaveLength(1);
    expect(statusOnGitHub(n)).toBe('Done');
  });
});

describe('GitHub#258: could not read is never "not there", a written value is not done until read back', () => {
  it('every look fails: the notice says it could not tell; nothing written', async () => {
    const c = await ready();
    fake.state.w.failCreatedBoards = 999;
    const n = await createInGroup(c, 'unreadable');
    githubAdds(n);
    await until(() => jobOf(c)?.status === 'partial', 'notice');
    expect(jobOf(c)!.watch).toMatchObject([{ state: 'unread' }]);
    expect(jobOf(c)!.message).toContain('读不到这条在不在看板「cavil project」上');
    expect(reads()).toBe(LOOKS.length);
    expect(fieldWrites()).toHaveLength(0);
  });

  it('some looks fail, then one reads: set as usual', async () => {
    const c = await ready();
    fake.state.w.failCreatedBoards = 2;
    const n = await createInGroup(c, 'flaky');
    githubAdds(n);
    await until(() => c.getState().creates.length === 0, 'settled');
    expect(fieldWrites()).toHaveLength(1);
    expect(statusOnGitHub(n)).toBe('In progress');
  });

  it('never taken in, every look read: nothing written, no notice, the client never adds it', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'never added');
    await until(() => reads() === LOOKS.length, 'all looks');
    await until(() => c.getState().creates.length === 0, 'job gone');
    expect(fieldWrites()).toHaveLength(0);
    expect(joins()).toBe(0);
    expect(boardNode(n)).toBeUndefined();
  });

  it('written, but every check fails: "could not confirm", never shown as done', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'unverified');
    githubAdds(n);
    await until(() => fieldWrites().length === 1, 'the write');
    fake.state.w.failCreatedBoards = 999;
    await until(() => jobOf(c)?.status === 'partial', 'notice');
    expect(jobOf(c)!.watch).toMatchObject([{ state: 'unverified' }]);
    expect(jobOf(c)!.message).toContain('没能确认最后是否保持');
    expect(fieldWrites()).toHaveLength(1);
  });

  it('the write refused: said in the notice', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'refused');
    githubAdds(n);
    fake.state.w.readOnlyProjects.add('org/gigleai/11');
    await until(() => jobOf(c)?.status === 'partial', 'notice');
    expect(jobOf(c)!.watch).toMatchObject([{ state: 'failed' }]);
    expect(jobOf(c)!.message).toContain('没能把状态设成「In progress」');
    expect(fake.log.filter((e) => e.operation === 'CavilSetStatus').length).toBe(1);
  });
});

describe('GitHub#258: what is not watched, and when watching stops', () => {
  it('auto-add surely off: the board is never looked at', async () => {
    fake.state.w.workflows.set('org/gigleai/11', [
      { name: 'Auto-add to project', enabled: false },
      { name: 'Item closed', enabled: true },
    ]);
    const c = await ready();
    const n = await createInGroup(c, 'auto-add off');
    await until(() => c.getState().creates.length === 0, 'job gone');
    githubAdds(n);
    await sleep(LOOKS[2] + VERIFY);
    expect(reads()).toBe(0);
    expect(fieldWrites()).toHaveLength(0);
    // the workflows really were read
    expect(fake.log.some((e) => e.operation === 'CavilProjectWorkflows')).toBe(true);
  });

  it('auto-add on (or the list unreadable, the default here): watched', async () => {
    fake.state.w.workflows.set('org/gigleai/11', [{ name: 'Auto-add to project', enabled: true }]);
    const c = await ready();
    const n = await createInGroup(c, 'auto-add on');
    githubAdds(n);
    await until(() => c.getState().creates.length === 0, 'settled');
    expect(fieldWrites()).toHaveLength(1);
  });

  it('signed out mid-watch: no read or write after that', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'sign out');
    await until(() => reads() === 1, 'first look');
    await c.logout();
    const r0 = reads();
    githubAdds(n);
    await sleep(LOOKS[2] + VERIFY * 2);
    expect(reads()).toBe(r0);
    expect(fieldWrites()).toHaveLength(0);
  });

  it('code review round 1: a first look reads "not there", every later one fails — said as unknown, nothing left watching silently', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'absent then unreadable');
    await until(() => reads() === 1, 'first look (complete, not there)');
    fake.state.w.failCreatedBoards = 999;
    githubAdds(n);
    await until(() => jobOf(c)?.status === 'partial', 'notice');
    expect(jobOf(c)!.watch).toMatchObject([{ state: 'unread' }]);
    expect(jobOf(c)!.message).toContain('读不到这条在不在看板「cavil project」上');
    expect(reads()).toBe(LOOKS.length);
    expect(fieldWrites()).toHaveLength(0);
  });

  it('code review round 1 (sibling): "not there" first, then it reads again at the last look — set as usual', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'absent then readable');
    await until(() => reads() === 1, 'first look');
    fake.state.w.failCreatedBoards = 1;
    githubAdds(n);
    await until(() => c.getState().creates.length === 0, 'settled');
    expect(fieldWrites()).toHaveLength(1);
    expect(statusOnGitHub(n)).toBe('In progress');
  });

  it('code review round 1: a button left from before the source was removed and added again writes nothing', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'source readded');
    githubAdds(n, 'Backlog');
    await until(() => jobOf(c)?.status === 'partial', 'notice');
    const id = jobOf(c)!.id;
    await sleep(LOOKS[2] + VERIFY);
    c.removeSource(PROJECT_KEY);
    // the button goes with the source
    expect(c.getState().creates.find((j) => j.id === id)?.watch ?? []).toEqual([]);
    c.addSource(PROJECT_URL);
    await c.syncNow();
    const r = await c.applyCreateWatch(id, PROJECT_KEY);
    expect(r.ok).toBe(false);
    expect(fieldWrites()).toHaveLength(0);
    expect(statusOnGitHub(n)).toBe('Backlog');
  });

  it('code review round 1 (sibling): the same button, source never removed, after the looks have ended — writes', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'button after looks');
    githubAdds(n, 'Backlog');
    await until(() => jobOf(c)?.status === 'partial', 'notice');
    await sleep(LOOKS[2] + VERIFY);
    expect((await c.applyCreateWatch(jobOf(c)!.id, PROJECT_KEY)).ok).toBe(true);
    expect(fieldWrites()).toHaveLength(1);
    await until(() => c.getState().creates.length === 0, 'checked');
    expect(statusOnGitHub(n)).toBe('In progress');
  });

  it('the source removed mid-watch: the watch ends', async () => {
    const c = await ready();
    const n = await createInGroup(c, 'source removed');
    await until(() => reads() === 1, 'first look');
    c.removeSource(PROJECT_KEY);
    githubAdds(n);
    await until(() => c.getState().creates.length === 0, 'job gone');
    await sleep(LOOKS[2] + VERIFY);
    expect(fieldWrites()).toHaveLength(0);
  });

  it('closing a notice while a board is still watched keeps watching it (no notice)', async () => {
    const c = await ready();
    fake.state.w.dropIssueLabels.add('gigleai/cavil-loop');
    const r = await c.startCreate({ kind: 'createIssue', repo: REPO, title: 'dismissed', body: '', labels: ['bug'], projects: [], plan: { milestone: null, projects: [], watch: [WATCH_STATUS] } });
    expect(r.ok).toBe(true);
    await until(() => jobOf(c)?.status === 'partial', 'label notice');
    const n = jobOf(c)!.number!;
    c.dismissCreate(jobOf(c)!.id);
    expect(jobOf(c)?.status).toBe('watching');
    githubAdds(n);
    await until(() => c.getState().creates.length === 0, 'settled');
    expect(statusOnGitHub(n)).toBe('In progress');
  });

  it('no watch in the plan (a ticked board, a milestone group, the plain "new" button): nothing looked at afterwards', async () => {
    const c = await ready();
    const r = await c.startCreate({ kind: 'createIssue', repo: REPO, title: 'ticked', body: '', labels: [], projects: [PROJECT_KEY], plan: { milestone: null, projects: [{ projectKey: PROJECT_KEY, iterationId: null, status: 'In progress' }] } });
    expect(r.ok).toBe(true);
    await until(() => c.getState().creates.length === 0 && c.getState().focus !== null, 'created');
    await sleep(LOOKS[2] + VERIFY);
    expect(reads()).toBe(0);
    // the ticked board: joined and set exactly as before
    expect(joins()).toBe(1);
    expect(fieldWrites().map((w) => w.operation)).toEqual(['CavilSetStatus']);
  });

  it('a ticked board listed in the watch too is not watched twice', async () => {
    const c = await ready();
    await createInGroup(c, 'ticked and watched', [WATCH_STATUS], [PROJECT_KEY]);
    await until(() => c.getState().creates.length === 0, 'created');
    await sleep(LOOKS[2] + VERIFY);
    expect(reads()).toBe(0);
    expect(fieldWrites()).toHaveLength(1);
  });
});
