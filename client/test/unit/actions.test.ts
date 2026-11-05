// Sub-item #138: viewing and changing items. The controller against the fake
// GitHub over real HTTP. For every kind of change: the exact write request
// GitHub receives, the board / cache after the immediate re-read; for every
// refusal: an error that says why and GitHub unchanged (digest), next to a
// "the normal case really did write" assertion.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/main/controller';
import { Cache } from '../../src/data/cache';
import { FileStore } from '../../src/platform/credentials';
import { buildTimeline } from '../../src/data/detail';
import { startFakeGitHub, FakeGitHub } from '../fake-github/server';
import { headOidOf } from '../fake-github/writes';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import type { Item } from '../../src/shared/types';
import { buildTable } from '../../src/data/table';
import { buildBoard } from '../../src/data/board';
import { applyFreshItem } from '../../src/data/itemRefresh';
import { DEFAULT_TABLE } from '../../src/shared/viewSettings';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const PROJECT_KEY = 'project:org/gigleai/11';
const REPO = 'GigleAI/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];

/**
 * The state these tests are written against: #137–#139 carry exactly
 * `pending/human` (as when they were written). Set on the fake GitHub here, not
 * taken from whatever a re-recording of the fixtures happened to capture.
 */
function pinLabels(n: number, names: string[]) {
  const nodes = names.map((name) => ({ name, color: 'ededed' }));
  for (const r of fake.state.repos.get('gigleai/cavil-loop')!) if (r.number === n) r.labels = nodes.map((l) => ({ ...l }));
  for (const p of fake.state.projects.get('org/gigleai/11')!) for (const node of p.items.nodes) if (node.content?.number === n) node.content.labels.nodes = nodes.map((l) => ({ ...l }));
}
/** the number GitHub gives the next issue: one past the highest number in the recorded data */
const nextNumber = () =>
  1 +
  Math.max(
    ...fake.state.repos.get('gigleai/cavil-loop')!.map((r: any) => r.number),
    ...fake.state.projects.get('org/gigleai/11')!.flatMap((p) => p.items.nodes.map((n: any) => n.content?.number ?? 0)),
  );

async function ready(opts: { project?: boolean; repo?: boolean; fetch?: (u: string, init?: RequestInit) => Promise<Response> } = {}) {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const clock = { t: FIXTURE_NOW };
  const c = new Controller({
    credentials,
    endpoints: { api: fake.api, web: fake.web },
    cache,
    now: () => clock.t,
    sleep: async () => {},
    openExternal: async () => {},
    defaultClientId: '',
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  controllers.push(c);
  for (const n of [137, 138, 139]) pinLabels(n, ['pending/human']);
  if (opts.project !== false) c.addSource(PROJECT_URL);
  if (opts.repo !== false) c.addSource(REPO);
  await c.start();
  await c.syncNow();
  expect(c.getState().phase).toBe('ready');
  return { c, cache, clock };
}

const itemOf = (c: Controller, n: number): Item => {
  const it = c.getBoardData().items.find((i) => i.key === K(n));
  if (!it) throw new Error(`#${n} not on the board`);
  return it;
};
const labelsOf = (c: Controller, n: number) => itemOf(c, n).labels.map((l) => l.name).sort();
/** the cache as a fresh process would read it */
const cachedItem = (n: number) => {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  return [...cache.loadSnapshots().values()].flatMap((s) => s.items.filter((i) => i.key === K(n)).map((i) => ({ ...i, source: s.sourceKey })));
};

/** someone else changes the item on GitHub (not through the client): add a label to every copy */
function labelOnGitHub(n: number, name: string) {
  for (const r of fake.state.repos.get('gigleai/cavil-loop')!) if (r.number === n) r.labels.push({ name, color: '000000' });
  for (const p of fake.state.projects.get('org/gigleai/11')!) for (const node of p.items.nodes) if (node.content?.number === n) node.content.labels.nodes.push({ name, color: '000000' });
}

/** make a recorded (merged / closed) PR an open one, in every copy */
function openPr(): number {
  const node = fake.state.projects.get('org/gigleai/11')!.flatMap((p) => p.items.nodes).find((n) => n.content?.__typename === 'PullRequest')!;
  const n = node.content.number as number;
  node.content.state = 'OPEN';
  node.content.merged = false;
  for (const r of fake.state.repos.get('gigleai/cavil-loop')!) if (r.number === n) Object.assign(r, { state: 'open', pull_request: { ...r.pull_request, merged_at: null } });
  return n;
}

beforeEach(async () => {
  fake = await startFakeGitHub();
  dir = tempDir();
});
afterEach(async () => {
  for (const c of controllers) c.stopTimer();
  for (const c of caches) c.close();
  caches = [];
  controllers = [];
  await fake.close();
});

describe('labels: only "add this one" / "remove this one" is sent', () => {
  it('add a label: POST with just that label; a label somebody else added meanwhile survives', async () => {
    const { c } = await ready();
    labelOnGitHub(138, 'added-on-the-web'); // not in the client's cache yet
    const r = await c.act({ kind: 'addLabel', key: K(138), label: 'bug' });
    expect(r).toMatchObject({ ok: true, error: null });
    expect(fake.writes().map((w) => [w.method, w.path, w.body])).toEqual([['POST', '/api/repos/GigleAI/cavil-loop/issues/138/labels', { labels: ['bug'] }]]);
    // re-read at once: the board and the cache show GitHub's state, including the other label
    expect(labelsOf(c, 138)).toEqual(['added-on-the-web', 'bug', 'pending/human']);
    expect(cachedItem(138).map((i) => i.labels.map((l) => l.name).sort())).toEqual([
      ['added-on-the-web', 'bug', 'pending/human'],
      ['added-on-the-web', 'bug', 'pending/human'],
    ]);
  });

  it('remove a label: DELETE of that one label (name escaped); a label somebody else added meanwhile survives', async () => {
    const { c } = await ready();
    labelOnGitHub(138, 'added-on-the-web');
    const r = await c.act({ kind: 'removeLabel', key: K(138), label: 'pending/human' });
    expect(r.ok).toBe(true);
    expect(fake.writes().map((w) => [w.method, w.path])).toEqual([['DELETE', '/api/repos/GigleAI/cavil-loop/issues/138/labels/pending%2Fhuman']]);
    expect(labelsOf(c, 138)).toEqual(['added-on-the-web']);
  });

  it('read-only repository: refused with the reason, GitHub unchanged', async () => {
    const { c } = await ready();
    fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
    const before = fake.digest();
    const r = await c.act({ kind: 'addLabel', key: K(138), label: 'bug' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没有权限');
    expect(fake.digest()).toBe(before);
    expect(labelsOf(c, 138)).toEqual(['pending/human']);
  });
});

describe('milestone: same title in the item\'s own repository, never created', () => {
  it('sets the repository\'s milestone with that title; removing sends null', async () => {
    const { c } = await ready();
    fake.state.w.milestones.set('gigleai/cavil-loop', [
      { number: 3, title: 'v1', state: 'open', due_on: '2026-12-01T00:00:00Z' },
      { number: 4, title: 'v2', state: 'open', due_on: null },
    ]);
    expect((await c.act({ kind: 'setMilestone', key: K(138), title: 'v1' })).ok).toBe(true);
    expect(itemOf(c, 138).milestone).toEqual({ title: 'v1', dueOn: '2026-12-01T00:00:00Z' });
    expect((await c.act({ kind: 'setMilestone', key: K(138), title: null })).ok).toBe(true);
    expect(itemOf(c, 138).milestone).toBeNull();
    expect(fake.writes().map((w) => [w.method, w.path, w.body])).toEqual([
      ['PATCH', '/api/repos/GigleAI/cavil-loop/issues/138', { milestone: 3 }],
      ['PATCH', '/api/repos/GigleAI/cavil-loop/issues/138', { milestone: null }],
    ]);
  });

  it('no milestone with that title in this repository: refused, nothing sent, GitHub unchanged', async () => {
    const { c } = await ready();
    fake.state.w.milestones.set('gigleai/cavil-loop', [{ number: 3, title: 'v1', state: 'open', due_on: null }]);
    const before = fake.digest();
    const r = await c.act({ kind: 'setMilestone', key: K(138), title: 'only-in-another-repo' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没有名为「only-in-another-repo」的里程碑');
    expect(r.error).toContain('不新建');
    expect(fake.writes()).toEqual([]);
    expect(fake.digest()).toBe(before);
  });
});

describe('Project fields: only that Project, with its own ids', () => {
  it('iteration: set and clear', async () => {
    const { c } = await ready();
    const meta = c.getBoardData().projects.find((p) => p.key === PROJECT_KEY)!;
    const it26 = meta.iterations.find((i) => i.title === 'Iteration 26')!;
    const m = itemOf(c, 138).projects[0];
    expect((await c.act({ kind: 'setIteration', key: K(138), projectKey: PROJECT_KEY, iterationId: it26.id })).ok).toBe(true);
    expect(itemOf(c, 138).projects[0].iteration?.title).toBe('Iteration 26');
    expect((await c.act({ kind: 'setIteration', key: K(138), projectKey: PROJECT_KEY, iterationId: null })).ok).toBe(true);
    expect(itemOf(c, 138).projects[0].iteration).toBeNull();
    expect(fake.writes().map((w) => [w.operation, w.variables])).toEqual([
      ['CavilSetIteration', { projectId: meta.projectId, itemId: m.itemId, fieldId: meta.iterationFieldId, iterationId: it26.id }],
      ['CavilClearField', { projectId: meta.projectId, itemId: m.itemId, fieldId: meta.iterationFieldId }],
    ]);
    expect(cachedItem(138).find((i) => i.source === PROJECT_KEY)!.projects[0].iteration).toBeNull();
  });

  it('status: the option id of that Project', async () => {
    const { c } = await ready();
    const meta = c.getBoardData().projects.find((p) => p.key === PROJECT_KEY)!;
    expect((await c.act({ kind: 'setStatus', key: K(138), projectKey: PROJECT_KEY, status: 'In progress' })).ok).toBe(true);
    expect(itemOf(c, 138).projects[0].status).toBe('In progress');
    expect(fake.writes()[0].variables).toMatchObject({ fieldId: meta.statusFieldId, optionId: meta.statusOptionIds.find((o) => o.name === 'In progress')!.id });
  });

  it('a Project the account cannot change: field changes refused before sending; labels still work', async () => {
    fake.state.w.readOnlyProjects.add('org/gigleai/11');
    const { c } = await ready();
    const meta = c.getBoardData().projects.find((p) => p.key === PROJECT_KEY)!;
    expect(meta.viewerCanUpdate).toBe(false);
    const before = fake.digest();
    const r = await c.act({ kind: 'setStatus', key: K(138), projectKey: PROJECT_KEY, status: 'Done' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没有修改权限');
    expect(fake.writes()).toEqual([]);
    expect(fake.digest()).toBe(before);
    // labels / milestones are the repository's, not the Project's
    expect((await c.act({ kind: 'addLabel', key: K(138), label: 'bug' })).ok).toBe(true);
    expect(fake.writes()).toHaveLength(1);
  });

  it('GitHub refuses the field change (permission): the reason is shown, GitHub unchanged', async () => {
    const { c } = await ready();
    fake.state.w.readOnlyProjects.add('org/gigleai/11'); // after the sync: the client still thinks it may
    const before = fake.digest();
    const r = await c.act({ kind: 'setStatus', key: K(138), projectKey: PROJECT_KEY, status: 'Done' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没有权限');
    expect(fake.writes()).toHaveLength(1); // it was sent …
    expect(fake.digest()).toBe(before); // … and GitHub changed nothing
  });

  it('an item not on the board: added to that Project, then the iteration set', async () => {
    // #139 only in the repository
    const pages = fake.state.projects.get('org/gigleai/11')!;
    for (const p of pages) p.items.nodes = p.items.nodes.filter((n: any) => n.content?.number !== 139);
    const { c } = await ready();
    expect(itemOf(c, 139).projects).toEqual([]);
    const meta = c.getBoardData().projects.find((p) => p.key === PROJECT_KEY)!;
    const it25 = meta.iterations.find((i) => i.title === 'Iteration 25')!;
    const r = await c.act({ kind: 'addToProject', key: K(139), projectKey: PROJECT_KEY, iterationId: it25.id, status: null });
    expect(r).toMatchObject({ ok: true, warning: null });
    expect(fake.writes().map((w) => w.operation)).toEqual(['CavilAddProjectItem', 'CavilSetIteration']);
    expect(fake.writes()[0].variables).toEqual({ projectId: meta.projectId, contentId: itemOf(c, 139).nodeId });
    expect(itemOf(c, 139).projects).toMatchObject([{ projectKey: PROJECT_KEY, iteration: { title: 'Iteration 25' } }]);
    expect(cachedItem(139).map((i) => i.source).sort()).toEqual([PROJECT_KEY, 'repo:gigleai/cavil-loop']);
  });
});

describe('comments and handing back to the agent', () => {
  it('reply: POST the text; the detail shows it on top', async () => {
    const { c } = await ready();
    const r = await c.act({ kind: 'comment', key: K(138), body: '看过了，按 A 做' });
    expect(r.ok).toBe(true);
    expect(fake.writes().map((w) => [w.method, w.path, w.body])).toEqual([['POST', '/api/repos/GigleAI/cavil-loop/issues/138/comments', { body: '看过了，按 A 做' }]]);
    const d = await c.loadDetail(K(138));
    expect(d.ok && d.detail.timeline[0]).toMatchObject({ kind: 'comment', bodyHtml: '<p>看过了，按 A 做</p>' });
  });

  it('hand back: adds the agent label, removes the human one (names from Settings)', async () => {
    const { c } = await ready();
    expect((await c.act({ kind: 'handBack', key: K(138) })).ok).toBe(true);
    expect(fake.writes().map((w) => [w.method, w.path, w.body])).toEqual([
      ['POST', '/api/repos/GigleAI/cavil-loop/issues/138/labels', { labels: ['pending/agent'] }],
      ['DELETE', '/api/repos/GigleAI/cavil-loop/issues/138/labels/pending%2Fhuman', undefined],
    ]);
    expect(labelsOf(c, 138)).toEqual(['pending/agent']);
    // the daemon's labels are configurable: the client follows the setting
    c.setHandBack({ human: 'wait/me', agent: 'go/bot' });
    labelOnGitHub(137, 'wait/me');
    expect((await c.act({ kind: 'handBack', key: K(137) })).ok).toBe(true);
    expect(labelsOf(c, 137)).toEqual(['go/bot', 'pending/human']);
  });
});

describe('PR merge / close', () => {
  it('merge sends the method and the commit the user saw; the PR shows merged', async () => {
    const n = openPr();
    const { c } = await ready();
    const d = await c.loadDetail(K(n));
    if (!d.ok) throw new Error(d.error);
    expect(d.detail.pr).toMatchObject({ mergeable: 'MERGEABLE', checks: 'SUCCESS', mergeMethods: ['merge', 'squash', 'rebase'] });
    const r = await c.act({ kind: 'merge', key: K(n), method: 'squash', headOid: d.detail.pr!.headOid });
    expect(r).toMatchObject({ ok: true, error: null });
    expect(fake.writes().map((w) => [w.method, w.path, w.body])).toEqual([
      ['PUT', `/api/repos/GigleAI/cavil-loop/pulls/${n}/merge`, { merge_method: 'squash', sha: headOidOf(REPO, n) }],
    ]);
    expect(itemOf(c, n).state).toBe('merged');
  });

  it('a new commit was pushed after the user looked: GitHub refuses, the user is told to refresh, nothing merged', async () => {
    const n = openPr();
    const { c } = await ready();
    const d = await c.loadDetail(K(n));
    if (!d.ok) throw new Error(d.error);
    fake.state.w.pulls.get(`gigleai/cavil-loop#${n}`)!.headOid = headOidOf(REPO, n, 1); // pushed meanwhile
    const before = fake.digest();
    const r = await c.act({ kind: 'merge', key: K(n), method: 'merge', headOid: d.detail.pr!.headOid });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('新提交');
    expect(r.error).toContain('刷新');
    expect(fake.writes()).toHaveLength(1);
    expect(fake.digest()).toBe(before);
    expect(itemOf(c, n).state).toBe('open');
  });

  for (const [what, refusal, says] of [
    ['checks failing', { status: 405, message: 'Required status check "test" is failing.' }, 'Required status check'],
    ['branch protection', { status: 405, message: 'At least 1 approving review is required by reviewers with write access.' }, 'approving review'],
  ] as const) {
    it(`${what}: GitHub's reason shown as is, nothing merged`, async () => {
      const n = openPr();
      const { c } = await ready();
      const d = await c.loadDetail(K(n));
      if (!d.ok) throw new Error(d.error);
      fake.state.w.pulls.get(`gigleai/cavil-loop#${n}`)!.mergeRefusal = { ...refusal };
      const before = fake.digest();
      const r = await c.act({ kind: 'merge', key: K(n), method: 'merge', headOid: d.detail.pr!.headOid });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('GitHub 不允许现在合并');
      expect(r.error).toContain(says);
      expect(fake.digest()).toBe(before);
    });
  }

  it('no permission to merge: refused, nothing merged', async () => {
    const n = openPr();
    const { c } = await ready();
    const d = await c.loadDetail(K(n));
    if (!d.ok) throw new Error(d.error);
    fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
    const before = fake.digest();
    const r = await c.act({ kind: 'merge', key: K(n), method: 'merge', headOid: d.detail.pr!.headOid });
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toContain('没有权限');
    expect(fake.digest()).toBe(before);
  });

  it('only the methods the repository allows are offered', async () => {
    const n = openPr();
    fake.state.w.mergeMethods.set('gigleai/cavil-loop', { merge: false, squash: true, rebase: false });
    const { c } = await ready();
    const d = await c.loadDetail(K(n));
    expect(d.ok && d.detail.pr!.mergeMethods).toEqual(['squash']);
  });

  it('close with a comment: closed first, then the comment', async () => {
    const n = openPr();
    const { c } = await ready();
    expect((await c.act({ kind: 'closePr', key: K(n), comment: '不做了' })).ok).toBe(true);
    expect(fake.writes().map((w) => [w.method, w.path, w.body])).toEqual([
      ['PATCH', `/api/repos/GigleAI/cavil-loop/pulls/${n}`, { state: 'closed' }],
      ['POST', `/api/repos/GigleAI/cavil-loop/issues/${n}/comments`, { body: '不做了' }],
    ]);
    expect(itemOf(c, n).state).toBe('closed');
  });

  it('close refused: no comment left behind either', async () => {
    const n = openPr();
    const { c } = await ready();
    fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
    const before = fake.digest();
    const r = await c.act({ kind: 'closePr', key: K(n), comment: '不做了' });
    expect(r.ok).toBe(false);
    expect(fake.writes()).toHaveLength(1);
    expect(fake.digest()).toBe(before);
  });
});

describe('new issue', () => {
  it('created in the chosen repository with title, body, labels; joins the ticked Projects', async () => {
    const { c } = await ready();
    const next = nextNumber();
    const r = await c.act({ kind: 'createIssue', repo: REPO, title: '新问题', body: '正文', labels: ['bug'] });
    expect(r).toMatchObject({ ok: true, warning: null, createdKey: K(next) });
    const w = fake.writes();
    expect([w[0].method, w[0].path, w[0].body]).toEqual(['POST', '/api/repos/GigleAI/cavil-loop/issues', { title: '新问题', body: '正文', labels: ['bug'] }]);
    expect(w[1].operation).toBe('CavilAddProjectItem');
    expect(w).toHaveLength(2);
    const created = itemOf(c, next);
    expect(created.projects.map((p) => p.projectKey)).toEqual([PROJECT_KEY]);
    expect(created.labels.map((l) => l.name)).toEqual(['bug']);
  });

  it('Projects not ticked in the view are left alone', async () => {
    const { c } = await ready();
    c.setView({ selected: ['repo:gigleai/cavil-loop'] });
    expect((await c.act({ kind: 'createIssue', repo: REPO, title: 'x', body: '', labels: [] })).ok).toBe(true);
    expect(fake.writes().map((w) => w.operation ?? w.method)).toEqual(['POST']);
  });
});

describe('offline: nothing is sent, nothing queued', () => {
  it('offline round → every change refused before sending; back online the same change goes through', async () => {
    const { c } = await ready();
    fake.state.offline = true;
    await c.syncNow();
    expect(c.getState().sync.offline).toBe(true);
    fake.state.offline = false;
    const before = fake.digest();
    const r = await c.act({ kind: 'addLabel', key: K(138), label: 'bug' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('离线');
    expect(fake.log.filter((l) => l.method !== 'GET' && l.path !== '/api/graphql')).toEqual([]);
    expect(fake.digest()).toBe(before);
    await c.syncNow();
    expect((await c.act({ kind: 'addLabel', key: K(138), label: 'bug' })).ok).toBe(true);
    expect(fake.digest()).not.toBe(before);
  });

  it('the connection drops during the change: told so, GitHub unchanged', async () => {
    const { c } = await ready();
    fake.state.w.dropWrites = true;
    const before = fake.digest();
    const r = await c.act({ kind: 'addLabel', key: K(138), label: 'bug' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('连不上 GitHub，没有修改');
    expect(fake.digest()).toBe(before);
  });
});

describe('an edit keeps the Project order (#137 × #138)', () => {
  const manual = { ...DEFAULT_TABLE, groupBy: 'none' as const, hierarchy: false, sort: { field: 'manual' as const, dir: 'asc' as const } };
  const tableOrder = (c: Controller) => buildTable(c.getBoardData().items, c.getBoardData().projects, manual, '2026-11-05').groups[0].rows.map((r) => r.item.key);
  const boardOrder = (c: Controller) =>
    buildBoard(c.getBoardData().items, c.getBoardData().projects, 'status', false, '2026-11-05', manual.sort).columns.map((col) => col.cards.map((x) => x.item.key));

  it('label added on the first item: re-read at once → table and board order unchanged → still unchanged after a full sync', async () => {
    const { c } = await ready({ repo: false });
    const before = tableOrder(c);
    const boardBefore = boardOrder(c);
    const first = before[0];
    const n = Number(first.split('#')[1]);
    expect(before.length).toBeGreaterThan(10);
    const r = await c.act({ kind: 'addLabel', key: first, label: 'bug' });
    expect(r).toMatchObject({ ok: true, warning: null });
    // the change happened and was re-read (not a no-op)
    expect(fake.writes().map((w) => [w.method, w.path])).toEqual([['POST', `/api/repos/GigleAI/cavil-loop/issues/${n}/labels`]]);
    expect(labelsOf(c, n)).toContain('bug');
    expect(tableOrder(c)).toEqual(before);
    expect(boardOrder(c)).toEqual(boardBefore);
    await c.syncNow();
    expect(tableOrder(c)).toEqual(before);
    expect(labelsOf(c, n)).toContain('bug');
  });

  it('pure rule: an item still on the Project is replaced in place; one gone from it is removed; one new to it is appended', () => {
    const snap = { sourceKey: 'repo:x/a', fetchedAt: 1, items: [1, 2, 3].map((n) => ({ key: `x/a#${n}`, repo: 'x/a', number: n }) as unknown as Item) };
    const content = (n: number) => ({ __typename: 'Issue', id: `I${n}`, number: n, title: `new ${n}`, url: '', state: 'OPEN', updatedAt: '', repository: { nameWithOwner: 'x/a' } }) as any;
    const [kept] = applyFreshItem([snap], { content: content(1), projectItems: [] } as any);
    expect(kept.items.map((i) => [i.number, i.title])).toEqual([[1, 'new 1'], [2, undefined], [3, undefined]]);
    const [added] = applyFreshItem([snap], { content: content(9), projectItems: [] } as any);
    expect(added.items.map((i) => i.number)).toEqual([1, 2, 3, 9]);
    const proj = { ...snap, sourceKey: 'project:org/x/1', project: { projectId: 'P1' } as any };
    const [gone] = applyFreshItem([proj], { content: content(2), projectItems: [] } as any);
    expect(gone.items.map((i) => i.number)).toEqual([1, 3]);
  });
});

describe('re-read after a change', () => {
  it('re-read fails: the change stands, the user is told, the next round catches up', async () => {
    let refreshCalls = 0;
    // fail exactly the one-item re-read (GraphQL CavilItemRefresh)
    const { c } = await ready({
      fetch: async (u, init) => {
        if (typeof init?.body === 'string' && init.body.includes('CavilItemRefresh')) {
          refreshCalls++;
          throw new Error('socket hang up');
        }
        return fetch(u, init);
      },
    });
    const r = await c.act({ kind: 'addLabel', key: K(138), label: 'bug' });
    expect(refreshCalls).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.warning).toContain('重读这一条失败');
    await c.syncNow();
    expect(labelsOf(c, 138)).toEqual(['bug', 'pending/human']);
  });
});

describe('detail: newest first', () => {
  it('comments, reviews and their line comments by time, newest on top; the opening post last; every page read', async () => {
    const n = openPr();
    fake.state.w.detailPageSize = 2;
    const key = `gigleai/cavil-loop#${n}`;
    const c0 = (i: number, at: string) => ({ id: `C${i}`, url: `u${i}`, createdAt: at, bodyHTML: `<p>c${i}</p>`, author: { login: 'a' } });
    fake.state.w.comments.set(key, [c0(1, '2026-11-01T01:00:00Z'), c0(2, '2026-11-01T03:00:00Z'), c0(3, '2026-11-01T05:00:00Z'), c0(4, '2026-11-01T07:00:00Z'), c0(5, '2026-11-01T09:00:00Z')]);
    const line = (i: number, at: string) => ({ ...c0(i, at), id: `L${i}`, path: 'a.ts', line: i, originalLine: i });
    fake.state.w.reviews.set(key, [
      { id: 'R1', url: 'r1', state: 'CHANGES_REQUESTED', submittedAt: '2026-11-01T04:00:00Z', createdAt: '2026-11-01T03:30:00Z', bodyHTML: '<p>r1</p>', author: { login: 'b' }, comments: { totalCount: 2, nodes: [line(1, '2026-11-01T03:30:00Z'), line(2, '2026-11-01T03:40:00Z')] } },
      { id: 'R2', url: 'r2', state: 'PENDING', submittedAt: null, createdAt: '2026-11-01T10:00:00Z', bodyHTML: '', author: { login: 'b' }, comments: { totalCount: 0, nodes: [] } },
      { id: 'R3', url: 'r3', state: 'APPROVED', submittedAt: '2026-11-01T08:00:00Z', createdAt: '2026-11-01T08:00:00Z', bodyHTML: '', author: { login: 'b' }, comments: { totalCount: 0, nodes: [] } },
    ]);
    const { c } = await ready();
    const d = await c.loadDetail(K(n));
    if (!d.ok) throw new Error(d.error);
    expect(d.detail.timeline.map((e) => e.id)).toEqual(['C5', 'R3', 'C4', 'C3', 'R1', 'C2', 'C1', d.detail.timeline.at(-1)!.id]);
    expect(d.detail.timeline.at(-1)!.kind).toBe('body');
    expect(d.detail.timeline.find((e) => e.id === 'R1')!.lineComments!.map((x) => x.id)).toEqual(['L2', 'L1']);
    // 5 comments in pages of 2 + reviews in pages of 2 → more than one request
    expect(fake.log.filter((l) => l.operation === 'CavilItemDetail').length).toBe(3);
  });

  it('a review with more than 100 line comments: every page read, newest first; a failed later page is an error, never a shorter discussion', async () => {
    const n = openPr();
    const key = `gigleai/cavil-loop#${n}`;
    const lines = Array.from({ length: 101 }, (_, i) => ({
      id: `L${i + 1}`,
      url: '',
      createdAt: new Date(Date.parse('2026-11-01T00:00:00Z') + i * 60_000).toISOString(),
      bodyHTML: `<p>l${i + 1}</p>`,
      author: { login: 'b' },
      path: 'a.ts',
      line: i + 1,
      originalLine: i + 1,
    }));
    fake.state.w.reviews.set(key, [
      { id: 'R-big', url: 'r', state: 'COMMENTED', submittedAt: '2026-11-02T00:00:00Z', createdAt: '2026-11-01T00:00:00Z', bodyHTML: '', author: { login: 'b' }, comments: { totalCount: 101, nodes: lines } },
    ]);
    const { c } = await ready();
    const d = await c.loadDetail(K(n));
    if (!d.ok) throw new Error(d.error);
    const got = d.detail.timeline.find((e) => e.id === 'R-big')!.lineComments!.map((x) => x.id);
    expect(got).toHaveLength(101);
    expect(got[0]).toBe('L101'); // the newest, which sits on the second page
    expect(got.at(-1)).toBe('L1');
    expect(fake.log.filter((l) => l.operation === 'CavilReviewComments').map((l) => l.variables)).toEqual([{ id: 'R-big', after: 'l-100' }]);

    fake.state.w.failReviewCommentPages = true;
    const bad = await c.loadDetail(K(n));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain('读取详情失败');
  });

  it('pure ordering: same input in any order gives the same timeline', () => {
    const raw = {
      item: { __typename: 'Issue', id: 'B', number: 1, title: '', url: '', state: 'OPEN', createdAt: '2026-01-01T00:00:00Z', bodyHTML: '', author: null, labels: { nodes: [] } } as any,
      comments: [
        { id: 'a', url: '', createdAt: '2026-01-03T00:00:00Z', bodyHTML: '', author: null },
        { id: 'b', url: '', createdAt: '2026-01-02T00:00:00Z', bodyHTML: '', author: null },
      ],
      reviews: [],
    };
    expect(buildTimeline(raw).map((e) => e.id)).toEqual(['a', 'b', 'B']);
    expect(buildTimeline({ ...raw, comments: [...raw.comments].reverse() }).map((e) => e.id)).toEqual(['a', 'b', 'B']);
  });
});
