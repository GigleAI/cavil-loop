// GigleAI/cavil-loop#545: read only what changed. #558: no quota of the client's own — it reads as long
// as GitHub answers, and says so only when GitHub refuses with its rate limit.
// Real controller, the real Rust back end as a child process, the fake GitHub over HTTP: its
// GraphQL board read carries each item's own updatedAt (`itemTimes`), its board item list filters
// by `updated:>=DAY` in GitHub's REST shape, it answers board items by node id, it keeps both hourly
// quotas and puts them in the headers of every answer, and its clock (the Date header, GitHub's time)
// follows this test's clock. Every "nothing went out" assertion has a "this did go out" next to it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, type CannedAnswer, type FakeGitHub, type LoggedRequest } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';
import { GitHubClient } from '../../src/data/github';
import { fetchProject, fetchRepo } from '../../src/data/fetchSources';
import { parseSource } from '../../src/shared/sources';
import type { Item, SourceConfig } from '../../src/shared/types';
import { hoverLines, retryText } from '../../src/renderer/syncTimes';
import { syncTrouble } from '../../src/renderer/warnings';
import { describeFailure } from '../../src/shared/readFailure';
import { parseFilter } from '../../src/shared/filter';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const PROJECT_KEY = 'project:org/gigleai/11';
const BOARD = 'org/gigleai/11';
const REPO = 'GigleAI/cavil-loop';
const REPO_KEY = 'repo:gigleai/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;
const MIN = 60_000;

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

beforeEach(async () => {
  fake = await startFakeGitHub({ itemTimes: true });
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

async function ready(opts: { sources?: string[]; lastSendAt?: number } = {}) {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  // GitHub#558: what an older version (#545) wrote before each request; it made a restart wait up to 2 minutes
  if (opts.lastSendAt !== undefined) cache.setSetting('syncLastSendAt', opts.lastSendAt);
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const clock = { t: FIXTURE_NOW };
  const endpoints = { api: fake.api, web: fake.web };
  const harness = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: () => clock.t, sleep: async () => {} });
  backends.push(harness);
  const c = await Controller.create({ backend: harness, endpoints, now: () => clock.t, defaultClientId: '', followUpSyncMs: 600_000, readRetryDelaysMs: [0, 0] });
  controllers.push(c);
  for (const s of opts.sources ?? [PROJECT_URL]) c.addSource(s);
  await c.start();
  expect(c.getState().phase).toBe('ready');
  labels = { blocked: c.getState().handBack.blocked, human: c.getState().handBack.human };
  return { c, cache, clock };
}

/** one round, `min` minutes after the previous one; returns what it sent */
async function round(c: Controller, clock: { t: number }, min = 1) {
  clock.t += min * MIN;
  const n = fake.log.length;
  await c.syncNow();
  return fake.log.slice(n);
}

const boardFullReads = (l: LoggedRequest[]) => l.filter((e) => e.operation === 'CavilProjectItems' && (e.variables?.after ?? null) === null).length;
const byIds = (l: LoggedRequest[]) => l.filter((e) => e.operation === 'CavilProjectItemsByIds');
const idsAsked = (l: LoggedRequest[]) => byIds(l).flatMap((e) => (e.variables?.ids as string[]) ?? []);
const repoFullReads = (l: LoggedRequest[]) => l.filter((e) => e.method === 'GET' && e.path.startsWith('/api/repos/GigleAI/cavil-loop/issues?') && e.path.includes('state=open')).length;
const sinceLists = (l: LoggedRequest[]) => l.filter((e) => e.method === 'GET' && /\/issues\?state=all&since=/.test(e.path));
const gql = (l: LoggedRequest[]) => l.filter((e) => e.path === '/api/graphql');
const rest = (l: LoggedRequest[]) => l.filter((e) => e.path.startsWith('/api/') && e.path !== '/api/graphql');

const nodes = () => fake.state.projects.get(BOARD)!.flatMap((p) => p.items.nodes);
const nodeOf = (n: number) => nodes().find((x: any) => x.content?.number === n)!;
const shown = (c: Controller, n: number) => c.getBoardData().items.find((i) => i.key === K(n)) ?? null;
const statusOf = (c: Controller, n: number) => shown(c, n)?.projects.find((m) => m.projectKey === PROJECT_KEY)?.status ?? null;
const src = (key: string) => (key === PROJECT_KEY ? (parseSource(PROJECT_URL) as Extract<SourceConfig, { kind: 'project' }>) : (parseSource(REPO) as Extract<SourceConfig, { kind: 'repo' }>));

/** a card moved on github.com: its board item's own time moves, the issue's does not */
function moveCard(n: number, status: string, at: number) {
  const node = nodeOf(n);
  const v = node.fieldValues.nodes.find((f: any) => f.__typename === 'ProjectV2ItemFieldSingleSelectValue' && f.field?.name === 'Status');
  v.name = status;
  node.updatedAt = new Date(at).toISOString();
}

/** the issue itself changed on github.com (a label): its own time moves, its board item's does not (measured: GitHub lags) */
async function labelOnGitHub(n: number, label: string, at: number) {
  const before = nodeOf(n).updatedAt ?? nodeOf(n).content.updatedAt;
  const r = await fetch(`${fake.api}/repos/${REPO}/issues/${n}/labels`, {
    method: 'POST',
    headers: { authorization: `Bearer ${FAKE_TOKEN}`, 'content-type': 'application/json', 'x-fake-now': String(at) },
    body: JSON.stringify({ labels: [label] }),
  });
  expect(r.status).toBe(200);
  // the fake's write clock is the real one: the change's time as GitHub's clock (this test's) says
  const when = new Date(at).toISOString();
  nodeOf(n).content.updatedAt = when;
  for (const i of fake.state.repos.get('gigleai/cavil-loop')!) if (i.number === n) i.updated_at = when;
  // the board item's own time stays where it was
  nodeOf(n).updatedAt = before;
}

/** what a full read of the board gives right now, in the fields the board shows (not the read times) */
let labels = { blocked: '', human: '' };
async function fullReadNow(key: string, at: number): Promise<Record<string, unknown>[]> {
  const client = new GitHubClient({ api: fake.api, web: fake.web }, FAKE_TOKEN);
  // the same label settings the controller reads with (the loop's waiting label, the pending label)
  const snap = key === PROJECT_KEY ? await fetchProject(client, src(key) as any, at, labels.blocked) : await fetchRepo(client, src(key) as any, at, 100, labels.blocked, labels.human);
  return comparable(snap.items, key === PROJECT_KEY);
}
/**
 * A board keeps its own order (the table's "Project 里的顺序" and each group's order follow it), so a
 * board is compared in that order; a repository's list order is not shown, it is compared by key.
 */
function comparable(items: Item[], ordered: boolean): Record<string, unknown>[] {
  const out = items.map((it) => {
    const { seenAt: _s, relationsAt: _r, viewerAt: _v, ...rest } = it as any;
    return { ...rest, projects: rest.projects.map((m: any) => ({ ...m })) };
  });
  return ordered ? out : out.sort((a, b) => String(a.key).localeCompare(String(b.key)));
}
/** the source's snapshot as kept on disk (what the board is built from) */
const shownOf = (cache: Cache, key: string) => comparable(cache.loadSnapshots().get(key)!.items, key === PROJECT_KEY);
const orderOf = (cache: Cache) => cache.loadSnapshots().get(PROJECT_KEY)!.items.map((it) => it.key);

// ---------------------------------------------------------------------------

describe('a board: only the changed items are read again', () => {
  it('a card moved: one read of that item by id, no full read; the board equals a full read', async () => {
    const { c, cache, clock } = await ready();
    // the first round read in full; one quiet round takes the repositories' check tags
    await round(c, clock);
    expect(statusOf(c, 22)).toBe('Done');
    moveCard(22, 'In progress', clock.t + 30_000);
    const sent = await round(c, clock);
    expect(boardFullReads(sent)).toBe(0);
    expect(idsAsked(sent)).toEqual([nodeOf(22).id]);
    expect(statusOf(c, 22)).toBe('In progress');
    expect(shownOf(cache, PROJECT_KEY)).toEqual(await fullReadNow(PROJECT_KEY, clock.t));
    // the hover says the data came from a read of changes
    const line = hoverLines(c.getState().sync, () => '看板', clock.t).find((l) => l.startsWith('看板：'))!;
    expect(line).toMatch(/^看板：读取变化（1 个条目）不到 1 分钟前 · 整份读取 \d+ 分钟前 · 上次检查/);
  });

  it('the first item changed: it stays first, the board\'s order is the one a full read gives', async () => {
    const { c, cache, clock } = await ready();
    await round(c, clock);
    const before = orderOf(cache);
    const first = nodes().find((x: any) => !x.isArchived && x.content?.repository?.nameWithOwner === REPO)!;
    const n = first.content.number as number;
    expect(before.indexOf(K(n))).toBe(0);
    moveCard(n, 'In progress', clock.t + 30_000);
    const sent = await round(c, clock);
    expect(boardFullReads(sent)).toBe(0);
    expect(idsAsked(sent)).toEqual([first.id]);
    expect(statusOf(c, n)).toBe('In progress');
    // same order as before, and the same order (and content) a full read gives now
    expect(orderOf(cache)).toEqual(before);
    expect(shownOf(cache, PROJECT_KEY)).toEqual(await fullReadNow(PROJECT_KEY, clock.t));
  });

  it('an archived item changed and then restored, the count unchanged: read by id while hidden, shown again in its place', async () => {
    const node = nodes().find((x: any) => !x.isArchived && x.content?.repository?.nameWithOwner === REPO)!;
    const n = node.content.number as number;
    // archived on github.com before the first read: counted, not shown
    node.isArchived = true;
    node.updatedAt = new Date(FIXTURE_NOW - 60 * MIN).toISOString();
    const { c, cache, clock } = await ready();
    await round(c, clock);
    expect(shown(c, n)).toBeNull();
    const count = nodes().length;
    // a change while archived: read, still hidden
    node.updatedAt = new Date(clock.t + 30_000).toISOString();
    let sent = await round(c, clock);
    expect(boardFullReads(sent)).toBe(0);
    expect(idsAsked(sent)).toContain(node.id);
    expect(shown(c, n)).toBeNull();
    clock.t += 10 * MIN;
    // restored: the board's count is the same as before, only its own time moved
    node.isArchived = false;
    node.updatedAt = new Date(clock.t + 30_000).toISOString();
    expect(nodes().length).toBe(count);
    sent = await round(c, clock);
    expect(boardFullReads(sent)).toBe(0);
    expect(idsAsked(sent)).toContain(node.id);
    expect(shown(c, n)).not.toBeNull();
    expect(shownOf(cache, PROJECT_KEY)).toEqual(await fullReadNow(PROJECT_KEY, clock.t));
  });

  it('only the issue changed and the board\'s own pages still answer "not modified": the repository\'s check finds it', async () => {
    const { c, clock } = await ready();
    await round(c, clock);
    // GitHub lags on the board: every board page and the field list say "not modified"
    fake.state.checkFault = (e) => (/\/projectsV2\/11\//.test(e.path) ? 'not-modified' : null);
    await labelOnGitHub(138, 'bug', clock.t + 30_000);
    const sent = await round(c, clock);
    // the board's check really did answer 304 everywhere, the repository's did not
    const checks = sent.filter((e) => e.method === 'HEAD');
    expect(checks.filter((e) => /\/projectsV2\/11\//.test(e.path)).every((e) => e.status === 304)).toBe(true);
    expect(checks.some((e) => /\/repos\/gigleai\/cavil-loop\/issues\?/i.test(e.path) && e.status === 200)).toBe(true);
    expect(boardFullReads(sent)).toBe(0);
    expect(idsAsked(sent)).toEqual([nodeOf(138).id]);
    expect(shown(c, 138)!.labels.map((l) => l.name)).toContain('bug');
  });

  it('several rounds of different changes: each round reads exactly that round\'s items, never the last round\'s again', async () => {
    const { c, cache, clock } = await ready();
    await round(c, clock);
    // items on the board that the repository's own list carries too (an issue-only change shows there)
    const inRepo = new Set(fake.state.repos.get('gigleai/cavil-loop')!.map((i) => i.number));
    const order = nodes()
      .filter((x: any) => x.content?.repository?.nameWithOwner === REPO && inRepo.has(x.content.number) && !x.isArchived)
      .slice(0, 6)
      .map((x: any) => x.content.number);
    expect(order).toHaveLength(6);
    let points = 0;
    for (let i = 0; i < 3; i++) {
      const [a, b] = [order[2 * i], order[2 * i + 1]];
      moveCard(a, 'In progress', clock.t + 30_000);
      await labelOnGitHub(b, `l${i}`, clock.t + 30_000);
      const used = fake.state.quota.graphql.used;
      const sent = await round(c, clock);
      points += fake.state.quota.graphql.used - used;
      expect(boardFullReads(sent)).toBe(0);
      expect(new Set(idsAsked(sent))).toEqual(new Set([nodeOf(a).id, nodeOf(b).id]));
    }
    expect(shownOf(cache, PROJECT_KEY)).toEqual(await fullReadNow(PROJECT_KEY, clock.t));
    // each round: the count (1) and one read by id (1) in the fake's accounting
    expect(points).toBe(3 * 2);
  });

  it('read less than 10 s after its change: the next round reads it once more even though every check says "not modified"', async () => {
    const { c, clock } = await ready();
    await round(c, clock);
    // changed 5 s before the round starts (GitHub's clock): the read cannot be sure it saw the last change
    moveCard(22, 'In progress', clock.t + MIN - 5_000);
    const first = await round(c, clock);
    expect(idsAsked(first)).toEqual([nodeOf(22).id]);
    // nothing changes; every check answers "not modified" and the count is the same
    const second = await round(c, clock);
    expect(second.filter((e) => e.method === 'HEAD').every((e) => e.status === 304)).toBe(true);
    expect(idsAsked(second)).toEqual([nodeOf(22).id]);
    // read well after its change now: no more
    const third = await round(c, clock);
    expect(third.filter((e) => e.method === 'HEAD').length).toBeGreaterThan(0);
    expect(byIds(third)).toHaveLength(0);
  });

  it('changed twice in the same second, read in between: the second version is read too', async () => {
    const { c, cache, clock } = await ready();
    await round(c, clock);
    const second = clock.t + MIN; // the coming round's start, to the second
    moveCard(22, 'In progress', second);
    await round(c, clock);
    expect(statusOf(c, 22)).toBe('In progress');
    // the same second, after the read: the time GitHub shows does not move
    moveCard(22, 'Done', second);
    await round(c, clock);
    expect(statusOf(c, 22)).toBe('Done');
    expect(shownOf(cache, PROJECT_KEY)).toEqual(await fullReadNow(PROJECT_KEY, clock.t));
  });

  it('an item taken off the board: GitHub\'s count disagrees with the merged snapshot — read in full', async () => {
    const { c, clock } = await ready();
    await round(c, clock);
    const p = fake.state.projects.get(BOARD)!.find((pg) => pg.items.nodes.some((x: any) => x.content?.number === 22))!;
    p.items.nodes = p.items.nodes.filter((x: any) => x.content?.number !== 22);
    const sent = await round(c, clock);
    expect(boardFullReads(sent)).toBe(1);
    expect(shown(c, 22)).toBeNull();
  });

  it('more than 100 items changed in one round: read in full, not 2 reads by id', async () => {
    const { c, clock } = await ready();
    await round(c, clock);
    const all = nodes().filter((x: any) => x.content?.__typename !== 'DraftIssue' && !x.isArchived);
    expect(all.length).toBeGreaterThan(100);
    for (const n of all.slice(0, 101)) n.updatedAt = new Date(clock.t + 30_000).toISOString();
    const sent = await round(c, clock);
    expect(boardFullReads(sent)).toBe(1);
    expect(byIds(sent)).toHaveLength(0);
  });

  it('the read by id keeps failing: after 3 rounds the board is read in full, then by changes again', async () => {
    const { c, clock } = await ready();
    await round(c, clock);
    fake.state.answerOverride = (e) => (e.operation === 'CavilProjectItemsByIds' ? { status: 502, body: { message: 'Server Error' } } : null);
    for (let i = 0; i < 3; i++) {
      moveCard(22, i % 2 ? 'Done' : 'In progress', clock.t + 30_000);
      const sent = await round(c, clock, i === 0 ? 1 : 10); // the failing source waits 1, 2, 4… minutes
      expect(byIds(sent).length).toBeGreaterThan(0);
      expect(boardFullReads(sent)).toBe(0);
    }
    moveCard(22, 'In progress', clock.t + 30_000);
    const fourth = await round(c, clock, 10);
    expect(byIds(fourth)).toHaveLength(0);
    expect(boardFullReads(fourth)).toBe(1);
    fake.state.answerOverride = null;
    moveCard(22, 'Done', clock.t + 30_000);
    await round(c, clock); // takes the repositories' tags again
    moveCard(22, 'In progress', clock.t + 30_000);
    const after = await round(c, clock);
    expect(boardFullReads(after)).toBe(0);
    expect(idsAsked(after)).toEqual([nodeOf(22).id]);
  });

  it('an item GitHub gives no time for: the board is read the way it was before (in full when it changed, every 10 minutes)', async () => {
    const { c, clock } = await ready();
    const off = nodeOf(22);
    delete off.updatedAt;
    delete off.content.updatedAt;
    // the fake fills an item's own time from its content's: without both, the read has none
    clock.t += MIN;
    await c.restartSync();
    await round(c, clock);
    // the issue changes: the time filters cannot see an item with no time — the board is read in full
    moveCard(23, 'In progress', clock.t + 30_000);
    const sent = await round(c, clock);
    expect(boardFullReads(sent)).toBe(1);
    expect(sinceLists(sent)).toHaveLength(0);
    expect(byIds(sent)).toHaveLength(0);
    // nothing changes: kept as it is, and read in full again at 10 minutes (not 60)
    expect(boardFullReads(await round(c, clock))).toBe(0);
    expect(boardFullReads(await round(c, clock, 10))).toBe(1);
  });
});

describe('a repository: read by its changes, and the 14-day rule every round', () => {
  it('a label added: the list since the last read, no full read; equal to a full read', async () => {
    const { c, cache, clock } = await ready({ sources: [REPO] });
    await round(c, clock);
    await labelOnGitHub(138, 'bug', clock.t + 30_000);
    const sent = await round(c, clock);
    expect(repoFullReads(sent)).toBe(0);
    expect(sinceLists(sent)).toHaveLength(1);
    expect(shown(c, 138)!.labels.map((l) => l.name)).toContain('bug');
    expect(shownOf(cache, REPO_KEY)).toEqual(await fullReadNow(REPO_KEY, clock.t));
  });

  it('a closed item slides out of the 14 days with nothing changed: gone at the next round, without a full read', async () => {
    const { c, cache, clock } = await ready({ sources: [REPO] });
    const closed = fake.state.repos.get('gigleai/cavil-loop')!.find((i) => i.state === 'closed' && !i.pull_request)!;
    // inside the 14 days by 30 s when read in full now, outside them 2 minutes later
    clock.t += MIN;
    closed.updated_at = new Date(clock.t - 14 * 86_400_000 + 30_000).toISOString();
    await c.restartSync();
    expect(shown(c, closed.number)).not.toBeNull();
    const sent = await round(c, clock, 2);
    expect(repoFullReads(sent)).toBe(0);
    expect(sent.some((e) => e.method === 'HEAD')).toBe(true);
    expect(shown(c, closed.number)).toBeNull();
    expect(shownOf(cache, REPO_KEY)).toEqual(await fullReadNow(REPO_KEY, clock.t));
  });

  it('still read in full every 10 minutes', async () => {
    const { c, clock } = await ready({ sources: [REPO] });
    expect(repoFullReads(await round(c, clock))).toBe(0);
    expect(repoFullReads(await round(c, clock, 10))).toBe(1);
  });
});

/** GitHub's own hourly limit, as its REST API says it (the reset in epoch seconds) */
function limitedRest(resetS: number): CannedAnswer {
  return {
    status: 403,
    body: { message: 'API rate limit exceeded for user ID 1.', documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api' },
    headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetS) },
  };
}

describe('GitHub#558: no quota of the client\'s own; GitHub\'s own limit is said', () => {
  it('the account well past half of its hour: the round reads as usual, and never asks for the quota', async () => {
    const { c, clock } = await ready({ sources: [PROJECT_URL, REPO] });
    await round(c, clock);
    const reset = Math.ceil((clock.t + 20 * MIN) / 1000);
    fake.state.quota.graphql = { limit: 5000, used: 4900, resetAt: reset };
    fake.state.quota.core = { limit: 5000, used: 4900, resetAt: reset };
    moveCard(22, 'In progress', clock.t + 30_000);
    const sent = await round(c, clock);
    // the change was read (GraphQL went out) and shows
    expect(gql(sent).length).toBeGreaterThan(0);
    expect(statusOf(c, 22)).toBe('In progress');
    expect(c.getState().sync.sources.every((s) => s.ok)).toBe(true);
    expect(syncTrouble(c.getState().sync, parseFilter(''))).toBeNull();
    // no rate-limit endpoint, no quota line in the hover
    expect(fake.log.some((e) => e.path.startsWith('/api/rate_limit'))).toBe(false);
    expect(fake.log.filter((e) => e.operation === 'user').length).toBeGreaterThan(1);
    expect(hoverLines(c.getState().sync, () => 'x', clock.t).some((l) => l.includes('额度'))).toBe(false);
  });

  it('reopened right after closing (an older version left the time of its last request): the first round reads at once', async () => {
    const n = fake.log.length;
    const { c } = await ready({ lastSendAt: FIXTURE_NOW - 30_000 });
    const sent = fake.log.slice(n);
    expect(sent.some((e) => e.operation === 'user')).toBe(true);
    expect(gql(sent).length).toBeGreaterThan(0);
    expect(c.getBoardData().items.length).toBeGreaterThan(0);
    expect(c.getState().sync.sources.every((s) => s.ok)).toBe(true);
  });

  it('GitHub refuses with its hourly limit: "GitHub 暂时限制了读取次数", the yellow GitHub 限流 with the reset; nothing more until then; then it reads again', async () => {
    const { c, clock } = await ready({ sources: [PROJECT_URL, REPO] });
    await round(c, clock);
    const reset = Math.ceil((clock.t + 20 * MIN) / 1000);
    fake.state.answerOverride = (e) => (e.path.startsWith('/api/repos/') ? limitedRest(reset) : null);
    moveCard(22, 'In progress', clock.t + 30_000);
    const refused = await round(c, clock, 0);
    expect(refused.some((e) => e.status === 403)).toBe(true);
    const st = c.getState().sync.sources;
    expect(st.some((s) => s.failure?.kind === 'rateLimited')).toBe(true);
    const limitedOne = st.find((s) => s.failure?.kind === 'rateLimited')!;
    expect(describeFailure(limitedOne.failure!, clock.t).title).toBe('GitHub 暂时限制了读取次数');
    expect(statusOf(c, 22)).toBe('Done'); // the old data stays
    const trouble = syncTrouble(c.getState().sync, parseFilter(''))!;
    expect(trouble).toMatchObject({ limited: true, limitedUntil: reset * 1000 });
    // before the reset: nothing goes out at all
    const quiet = await round(c, clock, 5);
    expect(quiet.filter((e) => e.path.startsWith('/api/'))).toHaveLength(0);
    // the reset: it reads again, and the yellow goes
    fake.state.answerOverride = null;
    clock.t = reset * 1000 + 1000;
    const after = await round(c, clock, 0);
    expect(gql(after).length + rest(after).length).toBeGreaterThan(0);
    expect(statusOf(c, 22)).toBe('In progress');
    expect(c.getState().sync.sources.every((s) => s.ok)).toBe(true);
    expect(syncTrouble(c.getState().sync, parseFilter(''))).toBeNull();
  });

  it('GitHub limits without saying when (GraphQL RATE_LIMITED, no reset): no "HH:MM 恢复" anywhere — first round and the next while the gate is closed', async () => {
    const { c, clock } = await ready({ sources: [PROJECT_URL] });
    await round(c, clock);
    moveCard(22, 'In progress', clock.t + 30_000);
    // GitHub's GraphQL limit: HTTP 200, an error of type RATE_LIMITED; the quota still has room (no reset taken)
    fake.state.answerOverride = (e) => (e.path === '/api/graphql' ? { status: 200, body: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' }] } } : null);
    const sent = await round(c, clock);
    expect(sent.some((e) => e.path === '/api/graphql' && e.status === 200)).toBe(true);
    const check = (where: string) => {
      const st = c.getState().sync.sources.find((s) => s.sourceKey === PROJECT_KEY)!;
      expect(st.failure, where).toMatchObject({ kind: 'rateLimited' });
      // the client's own wait: a time to try again (the button), never GitHub's reset
      expect(typeof st.failure!.retryAt, where).toBe('number');
      expect(st.failure!.retrySaid, where).toBeUndefined();
      expect(st.retry, where).toMatchObject({ limitedSaid: false });
      expect(syncTrouble(c.getState().sync, parseFilter('')), where).toMatchObject({ limited: true, limitedUntil: null });
      // never "HH:MM 额度恢复": that is GitHub's reset, and GitHub gave none
      expect(describeFailure(st.failure!, clock.t).body, where).not.toMatch(/\d\d:\d\d 额度恢复/);
      expect(retryText(st, clock.t), where).toMatch(/^GitHub 没说什么时候恢复，客户端 \d\d:\d\d 再试/);
    };
    check('first round');
    // 30 s later, the gate still closed: nothing goes out, still no GitHub time
    clock.t += 30_000;
    const n = fake.log.length;
    await c.syncNow();
    expect(fake.log.slice(n).filter((e) => e.path.startsWith('/api/'))).toHaveLength(0);
    check('gate closed');
    expect(statusOf(c, 22)).toBe('Done');
  });

  it('GitHub does give its reset: the time is GitHub\'s, and said as when the quota comes back', async () => {
    const { c, clock } = await ready({ sources: [PROJECT_URL] });
    await round(c, clock);
    const reset = Math.ceil((clock.t + 20 * MIN) / 1000);
    fake.state.answerOverride = (e) => (e.path === '/api/graphql' ? { status: 200, body: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' }] }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } } : null);
    await round(c, clock);
    const st = c.getState().sync.sources.find((s) => s.sourceKey === PROJECT_KEY)!;
    expect(st.failure).toMatchObject({ kind: 'rateLimited', retryAt: reset * 1000, retrySaid: true });
    expect(st.retry).toMatchObject({ limitedUntil: reset * 1000, limitedSaid: true });
    expect(syncTrouble(c.getState().sync, parseFilter(''))).toMatchObject({ limited: true, limitedUntil: reset * 1000 });
    expect(retryText(st, clock.t)).toMatch(/^额度约 \d\d:\d\d 恢复/);
    // the gate closed on GitHub's time: the next round, refused before sending, keeps it as GitHub's
    clock.t += 60_000;
    const n = fake.log.length;
    await c.syncNow();
    expect(fake.log.slice(n).filter((e) => e.path.startsWith('/api/'))).toHaveLength(0);
    expect(c.getState().sync.sources.find((s) => s.sourceKey === PROJECT_KEY)!.failure).toMatchObject({ retrySaid: true });
  });

  it('who-am-I\'s answer carries no clock: every source with a snapshot is read in full that round, even "unchanged" ones; the clock back = checks again', async () => {
    const { c, clock } = await ready({ sources: [PROJECT_URL, REPO] });
    // with the clock, nothing changed: no full read ("this did happen" for the contrast below)
    const quiet = await round(c, clock);
    expect(boardFullReads(quiet)).toBe(0);
    expect(repoFullReads(quiet)).toBe(0);
    fake.state.noDate = (e) => e.operation === 'user';
    const sent = await round(c, clock);
    expect(sent.find((e) => e.operation === 'user')?.status).toBeGreaterThan(0);
    expect(boardFullReads(sent)).toBe(1);
    expect(repoFullReads(sent)).toBe(1);
    expect(byIds(sent)).toHaveLength(0);
    expect(c.getState().sync.sources.every((s) => s.ok)).toBe(true);
    fake.state.noDate = null;
    const back = await round(c, clock);
    expect(boardFullReads(back)).toBe(0);
    expect(repoFullReads(back)).toBe(0);
  });

  it('busy board and repository for an hour: within the fake\'s REST accounting, no full read after the first', async () => {
    const { c, clock } = await ready({ sources: [PROJECT_URL, REPO] });
    await round(c, clock);
    const core = fake.state.quota.core.used;
    const points = fake.state.quota.graphql.used;
    const inRepo = new Set(fake.state.repos.get('gigleai/cavil-loop')!.map((i) => i.number));
    const sample = nodes()
      .filter((x: any) => x.content?.__typename === 'Issue' && !x.isArchived && inRepo.has(x.content.number))
      .slice(0, 60)
      .map((x: any) => x.content.number);
    expect(sample.length).toBeGreaterThan(10);
    let full = 0;
    // 57 rounds: the hourly full read of the board (60 minutes after the first) is not in this stretch
    for (let m = 0; m < 57; m++) {
      moveCard(sample[m % sample.length], m % 2 ? 'Done' : 'In progress', clock.t + 30_000);
      await labelOnGitHub(sample[(m + 7) % sample.length], `m${m}`, clock.t + 30_000);
      full += boardFullReads(await round(c, clock));
    }
    expect(full).toBe(0);
    // REST: the checks that answered 200, the lists of changes — well under a tenth of the hour's 5000
    expect(fake.state.quota.core.used - core).toBeLessThan(650);
    expect(fake.state.quota.graphql.used - points).toBeLessThan(450);
  });
});
