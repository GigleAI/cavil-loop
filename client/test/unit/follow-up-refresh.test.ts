// GigleAI/cavil-loop#177: after a change made in the detail panel, the list
// shows GitHub's new state without waiting for the 60 s timer.
//   1. merge / close a PR → the cached issues it links are read again at once
//      (GitHub's closing issues list, every page, plus the cached "linked pull
//      requests"); a list GitHub did not give in full is said so;
//   2. every successful change → one more sync round a few seconds after the
//      last one, for what GitHub does on its own side later (Project automation).
// Real controller, the real Rust back end as a child process, the fake GitHub
// over HTTP, real SQLite.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import type { Backend } from '../../src/backend/backend';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { nodeIdOf } from '../fake-github/writes';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import type { Item } from '../../src/shared/types';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const PROJECT_KEY = 'project:org/gigleai/11';
const REPO = 'GigleAI/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;
/** recorded: PR #146 (open, Status Backlog) closes issue #139 (open, Status In progress) */
const PR = 146;
const ISSUE = 139;
/** long enough that no follow-up round runs inside a test that does not wait for one */
const NEVER = 600_000;

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

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

interface Opts {
  project?: boolean;
  repo?: boolean;
  followUpSyncMs?: number;
  intercept?: (cmd: string, args: any) => unknown;
}

async function ready(opts: Opts = {}) {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const clock = { t: FIXTURE_NOW };
  const endpoints = { api: fake.api, web: fake.web };
  const harness = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: () => clock.t, sleep: async () => {} });
  backends.push(harness);
  const backend: Backend = opts.intercept ? { call: async (cmd, args) => (opts.intercept!(cmd, args) as any) ?? harness.call(cmd, args) } : harness;
  const c = await Controller.create({ backend, endpoints, now: () => clock.t, defaultClientId: '', followUpSyncMs: opts.followUpSyncMs ?? NEVER });
  controllers.push(c);
  if (opts.project !== false) c.addSource(PROJECT_URL);
  if (opts.repo !== false) c.addSource(REPO);
  await c.start();
  await c.syncNow();
  expect(c.getState().phase).toBe('ready');
  return { c };
}

/** PR #146 and issue #139 as the recording has them, made sure open (every copy) */
function openPair() {
  for (const r of fake.state.repos.get('gigleai/cavil-loop')!) {
    if (r.number === PR) Object.assign(r, { state: 'open', pull_request: { ...r.pull_request, merged_at: null } });
    if (r.number === ISSUE) r.state = 'open';
  }
  for (const p of fake.state.projects.get('org/gigleai/11')!)
    for (const n of p.items.nodes) {
      if (n.content?.number === PR) Object.assign(n.content, { state: 'OPEN', merged: false });
      if (n.content?.number === ISSUE) n.content.state = 'OPEN';
    }
}

/** `count` more open issues in the repository (REST copies only: a repository source lists them), numbered from `from` */
function addRepoIssues(from: number, count: number): number[] {
  const list = fake.state.repos.get('gigleai/cavil-loop')!;
  const model = list.find((r) => r.number === ISSUE)!;
  const numbers: number[] = [];
  for (let n = from; n < from + count; n++) {
    list.unshift({
      ...JSON.parse(JSON.stringify(model)),
      number: n,
      title: `generated issue ${n}`,
      state: 'open',
      node_id: nodeIdOf('Issue', REPO, n),
      html_url: `https://github.com/${REPO}/issues/${n}`,
      url: `https://api.github.com/repos/${REPO}/issues/${n}`,
    });
    numbers.push(n);
  }
  return numbers;
}

const find = (c: Controller, n: number): Item | null => c.getBoardData().items.find((i) => i.key === K(n)) ?? null;
const itemOf = (c: Controller, n: number): Item => {
  const it = find(c, n);
  if (!it) throw new Error(`#${n} not on the board`);
  return it;
};
const statusOf = (c: Controller, n: number) => itemOf(c, n).projects.find((p) => p.projectKey === PROJECT_KEY)?.status ?? null;
const linkedStateOf = (c: Controller, issue: number, pr: number) => itemOf(c, issue).linkedPrs?.find((l) => l.key === K(pr))?.state ?? null;

/** requests of one kind seen by the fake GitHub */
const count = (what: 'rounds' | 'refresh' | 'closing') =>
  fake.log.filter((l) =>
    what === 'rounds'
      ? // a sync round reads the repository's open issues once (repository sources) or the Project's first page once
        (l.method === 'GET' && l.path.startsWith('/api/repos/GigleAI/cavil-loop/issues?state=open')) ||
        (l.operation === 'CavilProjectItems' && !(l.variables as any)?.after)
      : what === 'refresh'
        ? l.operation === 'CavilItemRefresh'
        : l.operation === 'CavilClosingIssues',
  ).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, what: string, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error(`timeout: ${what}`);
}

async function mergeIt(c: Controller, n = PR) {
  const d = await c.loadDetail(K(n));
  if (!d.ok) throw new Error(d.error);
  return c.act({ kind: 'merge', key: K(n), method: 'merge', headOid: d.detail.pr!.headOid });
}

/** a request the back end is asked to send, as the intercept sees it */
const isOp = (args: any, op: string) => typeof args?.body === 'string' && args.body.includes(op);

describe('merge / close a PR: the issues it links are read again at once', () => {
  it('merge: the PR is merged, the issue it closes is closed and shows the PR merged — before any sync round', async () => {
    openPair();
    const { c } = await ready();
    expect(itemOf(c, ISSUE).state).toBe('open');
    expect(linkedStateOf(c, ISSUE, PR)).toBe('open');
    const rounds = count('rounds');
    const r = await mergeIt(c);
    expect(r).toMatchObject({ ok: true, error: null, warning: null });
    expect(itemOf(c, PR).state).toBe('merged');
    expect(itemOf(c, ISSUE).state).toBe('closed');
    expect(linkedStateOf(c, ISSUE, PR)).toBe('merged');
    // it came from the immediate re-reads, not from a sync round
    expect(count('rounds')).toBe(rounds);
    expect(count('closing')).toBe(1);
  });

  it('more than one page (repository source only, 101 issues): every one is read again; issues on no board are not', async () => {
    openPair();
    const extra = addRepoIssues(5001, 101);
    // the PR also closes an issue none of the sources holds (no copy anywhere): GitHub lists it, nothing reads it
    fake.state.w.closingIssues.set(K(PR), [...extra.map((number) => ({ repo: REPO, number })), { repo: REPO, number: 9999 }]);
    const { c } = await ready({ project: false });
    for (const n of extra) expect(itemOf(c, n).state).toBe('open');
    expect(itemOf(c, ISSUE).linkedPrs).toBeNull(); // a repository source does not know the links
    const rounds = count('rounds');
    const refresh = count('refresh');
    const r = await mergeIt(c);
    expect(r).toMatchObject({ ok: true, warning: null });
    // 103 listed (101 + #9999 + #139 from the recorded links): two pages
    expect(count('closing')).toBe(2);
    for (const n of extra) expect(itemOf(c, n).state).toBe('closed');
    expect(itemOf(c, ISSUE).state).toBe('closed');
    // the PR + 101 + #139; #9999 is in no source
    expect(count('refresh') - refresh).toBe(1 + 101 + 1);
    expect(count('rounds')).toBe(rounds);
  });

  it('a later page fails: the change stands, the user is told the list is partial, what was read is updated, the follow-up round catches the rest', async () => {
    openPair();
    const extra = addRepoIssues(5001, 101);
    fake.state.w.closingIssues.set(K(PR), extra.map((number) => ({ repo: REPO, number })));
    let failed = 0;
    const { c } = await ready({
      project: false,
      followUpSyncMs: 1000,
      intercept: (cmd, args) => {
        if (cmd === 'request' && isOp(args, 'CavilClosingIssues') && args.body.includes('"after":"ci-')) {
          failed++;
          return { error: 'network', message: 'socket hang up' };
        }
        return undefined;
      },
    });
    const rounds = count('rounds');
    const r = await mergeIt(c);
    expect(failed).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.error).toBeNull();
    expect(r.warning).toContain('没读全这个 PR 关联的 issue');
    expect(r.warning).toContain('socket hang up');
    // page 1 (100 issues) re-read at once; #5101 and #139 (page 2) not yet
    for (const n of extra.slice(0, 100)) expect(itemOf(c, n).state).toBe('closed');
    expect(itemOf(c, 5101).state).toBe('open');
    expect(count('rounds')).toBe(rounds);
    // the follow-up round reads the repository again: #5101 is no longer shown open
    await waitFor(() => count('rounds') > rounds && !c.getState().sync.syncing, 'follow-up round');
    await waitFor(() => find(c, 5101)?.state !== 'open', '#5101 caught up');
  });

  it('the first page fails too: the cached links still bring the issue up to date, and the user is told', async () => {
    openPair();
    const { c } = await ready({
      intercept: (cmd, args) => (cmd === 'request' && isOp(args, 'CavilClosingIssues') ? { error: 'network', message: 'socket hang up' } : undefined),
    });
    const r = await mergeIt(c);
    expect(r.ok).toBe(true);
    expect(r.warning).toContain('没读全这个 PR 关联的 issue');
    expect(itemOf(c, ISSUE).state).toBe('closed');
    expect(linkedStateOf(c, ISSUE, PR)).toBe('merged');
  });

  it('close: an issue linked only in the cache (GitHub\'s closing list does not name it) is read again and shows the PR closed', async () => {
    openPair();
    // GitHub answers an empty closing list for #146; the recorded link of #139 stays
    const { c } = await ready({
      intercept: (cmd, args) =>
        cmd === 'request' && isOp(args, 'CavilClosingIssues')
          ? {
              status: 200,
              headers: [['content-type', 'application/json']],
              body: JSON.stringify({ data: { repository: { pullRequest: { closingIssuesReferences: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } }),
            }
          : undefined,
    });
    const refresh = count('refresh');
    const r = await c.act({ kind: 'closePr', key: K(PR), comment: '' });
    expect(r).toMatchObject({ ok: true, warning: null });
    expect(itemOf(c, PR).state).toBe('closed');
    expect(itemOf(c, ISSUE).state).toBe('open'); // closing a PR does not close the issue
    expect(linkedStateOf(c, ISSUE, PR)).toBe('closed');
    expect(count('refresh') - refresh).toBe(2);
  });

  it('one linked issue cannot be read again: the merge stands, the PR is updated, the user is told', async () => {
    openPair();
    const { c } = await ready({
      intercept: (cmd, args) =>
        cmd === 'request' && isOp(args, 'CavilItemRefresh') && args.body.includes(`"number":${ISSUE}`) ? { error: 'network', message: 'socket hang up' } : undefined,
    });
    const r = await mergeIt(c);
    expect(r.ok).toBe(true);
    expect(r.warning).toContain('重读这一条失败');
    expect(itemOf(c, PR).state).toBe('merged');
  });

  it('a source removed and added again while a linked issue is being read: nothing of that read lands in the new addition', async () => {
    openPair();
    const { c } = await ready({ repo: false });
    const release = fake.holdWhen((e) => e.operation === 'CavilItemRefresh' && (e.variables as any)?.number === ISSUE);
    const p = mergeIt(c);
    await waitFor(() => fake.log.some((l) => l.operation === 'CavilItemRefresh' && (l.variables as any)?.number === ISSUE), 'issue re-read sent');
    c.removeSource(PROJECT_KEY);
    c.addSource(PROJECT_URL);
    release();
    expect((await p).ok).toBe(true);
    await c.settled();
    const cache = new Cache(join(dir, 'cache.sqlite'));
    caches.push(cache);
    expect(cache.loadSnapshots().has(PROJECT_KEY)).toBe(false);
  });
});

describe('one more sync round after a change', () => {
  it('GitHub\'s Project automation moves the cards later: the follow-up round shows it', async () => {
    openPair();
    fake.state.w.automation = { delayMs: 1000, status: 'Done' };
    const { c } = await ready({ followUpSyncMs: 2000 });
    const rounds = count('rounds');
    await mergeIt(c);
    // the immediate re-read was too early for the automation
    expect(statusOf(c, PR)).toBe('Backlog');
    expect(statusOf(c, ISSUE)).toBe('In progress');
    await waitFor(() => statusOf(c, PR) === 'Done' && statusOf(c, ISSUE) === 'Done', 'cards in Done');
    expect(count('rounds')).toBeGreaterThan(rounds);
  });

  it('three changes in a row: exactly one more round, after the last', async () => {
    const { c } = await ready({ followUpSyncMs: 1500 });
    const rounds = count('rounds');
    for (const label of ['a', 'b', 'c']) expect((await c.act({ kind: 'addLabel', key: K(ISSUE), label })).ok).toBe(true);
    expect(count('rounds')).toBe(rounds);
    await waitFor(() => count('rounds') > rounds && !c.getState().sync.syncing, 'one round');
    await sleep(2500);
    // a round reads both sources once: one round = two first reads
    expect(count('rounds') - rounds).toBe(2);
  });

  it('done with a warning (the new issue could not join the board) still counts as a change', async () => {
    fake.state.w.readOnlyProjects.add('org/gigleai/11');
    const { c } = await ready({ followUpSyncMs: 200 });
    const rounds = count('rounds');
    const r = await c.act({ kind: 'createIssue', repo: REPO, title: 'new', body: '', labels: [], projects: ['project:org/gigleai/11'] });
    expect(r.ok).toBe(true);
    expect(r.warning).toContain('没能加入看板');
    await waitFor(() => count('rounds') > rounds, 'follow-up round');
  });

  it('refused before sending / refused by GitHub: no extra round (and the allowed change next to it does get one)', async () => {
    const { c } = await ready({ followUpSyncMs: 200 });
    const rounds = count('rounds');
    const refused = await c.act({ kind: 'setMilestone', key: K(ISSUE), title: 'no such milestone' });
    expect(refused.ok).toBe(false);
    fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
    const denied = await c.act({ kind: 'addLabel', key: K(ISSUE), label: 'bug' });
    expect(denied.ok).toBe(false);
    await sleep(700);
    expect(count('rounds')).toBe(rounds);
    fake.state.w.readOnlyRepos.clear();
    expect((await c.act({ kind: 'addLabel', key: K(ISSUE), label: 'bug' })).ok).toBe(true);
    await waitFor(() => count('rounds') > rounds, 'round after the allowed change');
  });

  it('signed out before the round is due: it never runs, nothing is sent', async () => {
    const { c } = await ready({ followUpSyncMs: 1500 });
    expect((await c.act({ kind: 'addLabel', key: K(ISSUE), label: 'bug' })).ok).toBe(true);
    await c.logout();
    const sent = fake.log.length;
    await sleep(2000);
    expect(fake.log.length).toBe(sent);
  });

  it('signed out and signed in again before the round is due: the old round does not run in the new session', async () => {
    const { c } = await ready({ followUpSyncMs: 3000 });
    expect((await c.act({ kind: 'addLabel', key: K(ISSUE), label: 'bug' })).ok).toBe(true);
    await c.logout();
    c.setClientId(fake.state.oauthClientId);
    const login = c.startLogin();
    await waitFor(() => c.getState().login.status === 'waiting', 'device code');
    fake.resolveGrant('approved');
    await login;
    expect(c.getState().phase).toBe('ready');
    await waitFor(() => !c.getState().sync.syncing, 'first round of the new sign-in');
    // the new sign-in's own first round did run (reachability) …
    const rounds = count('rounds');
    expect(rounds).toBeGreaterThan(0);
    // … and nothing more once the old change's round would have been due
    await sleep(3500);
    expect(count('rounds')).toBe(rounds);
  });

  it('a change that answers only after a sign-out: no re-read, no round', async () => {
    openPair();
    const { c } = await ready({ followUpSyncMs: 200 });
    const d = await c.loadDetail(K(PR));
    if (!d.ok) throw new Error(d.error);
    const release = fake.hold(`/pulls/${PR}/merge`);
    const p = c.act({ kind: 'merge', key: K(PR), method: 'merge', headOid: d.detail.pr!.headOid });
    await waitFor(() => fake.log.some((l) => l.path.includes(`/pulls/${PR}/merge`)), 'merge sent');
    await c.logout();
    const sent = fake.log.length;
    release();
    await p;
    // the merge itself did reach GitHub and was answered
    await waitFor(() => fake.log.some((l) => l.path.includes(`/pulls/${PR}/merge`) && l.status === 200), 'merge answered');
    await sleep(600);
    // the merge's own answer is the only request after the sign-out
    expect(fake.log.slice(sent).filter((l) => l.operation === 'CavilItemRefresh' || l.operation === 'CavilClosingIssues')).toEqual([]);
    expect(fake.log.length).toBe(sent);
  });
});
