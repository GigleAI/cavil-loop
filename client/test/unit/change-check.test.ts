// GigleAI/cavil-loop#261: before a sync round reads a source in full, it asks GitHub with
// conditional requests whether anything changed; only an unbroken chain of "not modified"
// answers (and, on a board, the same item count) keeps the previous snapshot. Anything
// else reads in full, as before. Every source is read in full at least every 10 minutes.
// Real controller, the real Rust back end as a child process, the fake GitHub over HTTP
// (its version tags are a hash of the answer, 304 carries no Link header — as on GitHub).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { FULL_READ_EVERY_MS } from '../../src/data/changeCheck';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import type { Backend } from '../../src/backend/backend';
import { startFakeGitHub, type CheckFault, type FakeGitHub, type LoggedRequest } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, tempDir, trustedList } from './helpers';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const PROJECT_KEY = 'project:org/gigleai/11';
const BOARD = 'org/gigleai/11';
const REPO = 'GigleAI/cavil-loop';
const REPO_KEY = 'repo:gigleai/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;

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

type Intercept = (cmd: string, args: any, next: (cmd: string, args: any) => Promise<unknown>) => unknown;

async function ready(opts: { sources?: string[]; intercept?: Intercept; fullReadEveryMs?: number; afterRoundRead?: (dropped: boolean) => void } = {}) {
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const clock = { t: FIXTURE_NOW };
  const endpoints = { api: fake.api, web: fake.web };
  const harness = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: () => clock.t, sleep: async () => {} });
  backends.push(harness);
  const backend: Backend = opts.intercept ? { call: async (cmd, args) => (opts.intercept!(cmd, args, (c2, a2) => harness.call(c2, a2)) as any) ?? harness.call(cmd, args) } : harness;
  const c = await Controller.create({
    backend,
    endpoints,
    now: () => clock.t,
    defaultClientId: '',
    followUpSyncMs: 600_000,
    ...(opts.fullReadEveryMs !== undefined ? { fullReadEveryMs: opts.fullReadEveryMs } : {}),
    ...(opts.afterRoundRead ? { afterRoundRead: opts.afterRoundRead } : {}),
  });
  controllers.push(c);
  for (const s of opts.sources ?? [PROJECT_URL, REPO]) c.addSource(s);
  await c.start();
  expect(c.getState().phase).toBe('ready');
  return { c, cache, clock, harness };
}

// ---- what went out --------------------------------------------------------

const since = (n: number) => fake.log.slice(n);
/** full reads of the board: its first GraphQL page */
const boardReads = (l: LoggedRequest[]) => l.filter((e) => e.operation === 'CavilProjectItems' && (e.variables?.after ?? null) === null).length;
/** full reads of the repository: the first page of its open-issue list */
const repoReads = (l: LoggedRequest[]) => l.filter((e) => e.method === 'GET' && e.path.startsWith('/api/repos/GigleAI/cavil-loop/issues?') && e.path.includes('state=open') && !/[?&]page=/.test(e.path)).length;
const gqlOps = (l: LoggedRequest[]) => l.filter((e) => e.path === '/api/graphql').map((e) => e.operation);
const checks = (l: LoggedRequest[]) => l.filter((e) => e.method === 'HEAD' || /\/projectsV2\/\d+\/fields/.test(e.path));

/** one round; returns what it sent */
async function round(c: Controller) {
  const n = fake.log.length;
  await c.syncNow();
  return since(n);
}

// ---- changing GitHub the way GitHub changes ---------------------------------

const pages = () => fake.state.projects.get(BOARD)!;
const nodeOf = (n: number) => pages().flatMap((p) => p.items.nodes).find((x: any) => x.content?.number === n)!;
const onBoard = (c: Controller, n: number) => c.getBoardData().items.find((i) => i.key === K(n)) ?? null;
/** somebody adds a label on github.com (through the fake's API: every copy changes, updated_at moves) */
async function labelOnGitHub(n: number, label: string) {
  const r = await fetch(`${fake.api}/repos/${REPO}/issues/${n}/labels`, {
    method: 'POST',
    headers: { authorization: `Bearer ${FAKE_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ labels: [label] }),
  });
  expect(r.status).toBe(200);
}
/** somebody moves the card to another column (a board field: the issue's own update time does not move) */
function statusOnBoard(n: number, status: string) {
  const v = nodeOf(n).fieldValues.nodes.find((f: any) => f.__typename === 'ProjectV2ItemFieldSingleSelectValue' && f.field?.name === 'Status');
  v.name = status;
}
const statusOf = (c: Controller, n: number) => onBoard(c, n)?.projects.find((m) => m.projectKey === PROJECT_KEY)?.status ?? null;
const fault = (f: (e: LoggedRequest) => CheckFault | null) => (fake.state.checkFault = f);

// ---------------------------------------------------------------------------

describe('nothing changed: the round keeps the previous snapshot and reads nothing in full', () => {
  it('second round: no board page, no repo list; one login query and one count query; status confirmed this round', async () => {
    const { c, cache, clock } = await ready();
    const first = since(0);
    expect(boardReads(first)).toBe(1);
    expect(repoReads(first)).toBe(1);
    const board = JSON.stringify(c.getBoardData().items);
    const onDisk = cache.loadSnapshots().get(PROJECT_KEY)!.fetchedAt;

    clock.t += 60_000;
    const sent = await round(c);
    expect(boardReads(sent)).toBe(0);
    expect(repoReads(sent)).toBe(0);
    expect(gqlOps(sent)).toEqual(['CavilViewer', 'CavilProjectCounts']);
    // the check did go out and was answered "not modified" every time
    expect(checks(sent).length).toBeGreaterThan(0);
    expect(checks(sent).every((e) => e.status === 304)).toBe(true);
    // the same board, the snapshot not written again, the status says "confirmed now"
    expect(JSON.stringify(c.getBoardData().items)).toBe(board);
    expect(cache.loadSnapshots().get(PROJECT_KEY)!.fetchedAt).toBe(onDisk);
    for (const st of c.getState().sync.sources) expect(st).toMatchObject({ ok: true, dataFrom: clock.t });
  });

  it('switched off (0): every round reads every source in full and sends no check at all', async () => {
    const { c } = await ready({ fullReadEveryMs: 0 });
    const sent = await round(c);
    expect(boardReads(sent)).toBe(1);
    expect(repoReads(sent)).toBe(1);
    expect(checks(sent)).toEqual([]);
    expect(gqlOps(sent)).not.toContain('CavilProjectCounts');
  });
});

describe('a change the check sees: the next round reads in full and shows it', () => {
  it('a label added on github.com (board + repo)', async () => {
    const { c } = await ready();
    await round(c);
    await labelOnGitHub(138, 'bug');
    const sent = await round(c);
    expect(boardReads(sent)).toBe(1);
    expect(repoReads(sent)).toBe(1);
    expect(onBoard(c, 138)!.labels.map((l) => l.name)).toContain('bug');
    // and quiet again afterwards
    const after = await round(c);
    expect(boardReads(after) + repoReads(after)).toBe(0);
  });

  it('a card moved to another column (board field only: the issue itself is not updated)', async () => {
    const { c } = await ready({ sources: [PROJECT_URL] });
    expect(statusOf(c, 22)).toBe('Done');
    statusOnBoard(22, 'In progress');
    const sent = await round(c);
    expect(boardReads(sent)).toBe(1);
    expect(statusOf(c, 22)).toBe('In progress');
  });

  it('an item taken off the board', async () => {
    const { c } = await ready({ sources: [PROJECT_URL] });
    expect(onBoard(c, 22)).not.toBeNull();
    const p = pages().find((pg) => pg.items.nodes.some((x: any) => x.content?.number === 22))!;
    p.items.nodes = p.items.nodes.filter((x: any) => x.content?.number !== 22);
    const sent = await round(c);
    expect(boardReads(sent)).toBe(1);
    expect(onBoard(c, 22)).toBeNull();
  });

  it('a new column option on the board (the field list changed, no item did)', async () => {
    const { c } = await ready({ sources: [PROJECT_URL] });
    const status = pages()[0].fields.nodes.find((f: any) => f.name === 'Status') as any;
    for (const pg of pages()) (pg.fields.nodes.find((f: any) => f.name === 'Status') as any).options = [...status.options, { id: 'new-opt', name: 'Blocked' }];
    const sent = await round(c);
    expect(boardReads(sent)).toBe(1);
    expect(c.getBoardData().projects[0].statusOptions).toContain('Blocked');
  });

  it('an item added right after a full last page: only the count can tell (GitHub sends no next-page link with a 304)', async () => {
    // a board of exactly 200 items: two full REST pages
    const all = pages().flatMap((p) => p.items.nodes);
    const extra = Array.from({ length: 200 - all.length }, (_, i) => {
      const copy = JSON.parse(JSON.stringify(all[0]));
      copy.id = `PVTI_extra_${i}`;
      copy.content.number = 50_000 + i;
      copy.content.id = `I_extra_${i}`;
      return copy;
    });
    const nodes = [...all, ...extra];
    const page = (from: number, to: number, cursor: string, more: boolean) => ({ ...pages()[0], items: { totalCount: 0, pageInfo: { hasNextPage: more, endCursor: cursor }, nodes: nodes.slice(from, to) } });
    fake.state.projects.set(BOARD, [page(0, 100, 'cursor-1', true), page(100, 200, 'cursor-2', false)]);
    const { c } = await ready({ sources: [PROJECT_URL] });
    expect(c.getBoardData().items).toHaveLength(200);
    expect(boardReads(await round(c))).toBe(0); // quiet board: kept

    // one more item, on a third GraphQL page; REST pages 1 and 2 stay byte-identical
    const added = JSON.parse(JSON.stringify(all[0]));
    added.id = 'PVTI_added';
    added.content.number = 60_000;
    added.content.id = 'I_added';
    const ps = pages();
    ps[1].items.pageInfo = { hasNextPage: true, endCursor: 'cursor-2' };
    ps.push({ ...ps[0], items: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: 'cursor-3' }, nodes: [added] } });
    const sent = await round(c);
    // both item pages were "not modified" — the count is what sent the round to read
    expect(checks(sent).filter((e) => e.method === 'HEAD' && e.path.includes('/items')).every((e) => e.status === 304)).toBe(true);
    expect(boardReads(sent)).toBe(1);
    expect(onBoard(c, 60_000)).not.toBeNull();
  });
});

describe('what the check cannot see waits for the 10-minute full read (the documented limit)', () => {
  it('a saved view edited on github.com: kept until 10 minutes after the last full read, then read', async () => {
    const { c, clock } = await ready({ sources: [PROJECT_URL] });
    for (const pg of pages()) pg.views = { nodes: pg.views!.nodes.map((v: any) => (v.number === 1 ? { ...v, name: 'Renamed view' } : v)) };
    clock.t += FULL_READ_EVERY_MS - 1;
    expect(boardReads(await round(c))).toBe(0);
    expect(c.getBoardData().projects[0].views.find((v) => v.number === 1)!.name).not.toBe('Renamed view');
    clock.t += 1;
    expect(boardReads(await round(c))).toBe(1);
    expect(c.getBoardData().projects[0].views.find((v) => v.number === 1)!.name).toBe('Renamed view');
  });

  it('refresh by hand reads every source in full at once (a view edited on github.com shows right away)', async () => {
    const { c } = await ready();
    expect(boardReads(await round(c)) + repoReads(await round(c))).toBe(0);
    for (const pg of pages()) pg.views = { nodes: pg.views!.nodes.map((v: any) => (v.number === 1 ? { ...v, name: 'Renamed view' } : v)) };
    const n = fake.log.length;
    await c.restartSync();
    expect(boardReads(since(n))).toBe(1);
    expect(repoReads(since(n))).toBe(1);
    expect(c.getBoardData().projects[0].views.find((v) => v.number === 1)!.name).toBe('Renamed view');
    // the timer's rounds after it go back to checking first
    expect(boardReads(await round(c)) + repoReads(await round(c))).toBe(0);
  });

  it('repository: an issue deleted (not the latest updated one) shows at the 10-minute read; a forced read starts the next 10 minutes', async () => {
    const { c, clock } = await ready({ sources: [REPO] });
    const list = fake.state.repos.get('gigleai/cavil-loop')!;
    const oldest = [...list].filter((r) => r.state === 'open').sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1))[0];
    expect(onBoard(c, oldest.number)).not.toBeNull();
    fake.state.repos.set('gigleai/cavil-loop', list.filter((r) => r !== oldest));
    expect(repoReads(await round(c))).toBe(0);
    expect(onBoard(c, oldest.number)).not.toBeNull();
    clock.t += FULL_READ_EVERY_MS;
    expect(repoReads(await round(c))).toBe(1);
    expect(onBoard(c, oldest.number)).toBeNull();
    clock.t += 60_000;
    expect(repoReads(await round(c))).toBe(0);
  });
});

describe('an answer that is not a clear "not modified" reads in full', () => {
  // [what, the fault, which source it hits]
  const cases: [string, (e: LoggedRequest) => CheckFault | null, 'board' | 'repo'][] = [
    ['an item page answers 500', (e) => (e.path.includes('/items') ? { status: 500 } : null), 'board'],
    ['an item page answers 403', (e) => (e.path.includes('/items') ? { status: 403 } : null), 'board'],
    ['the field list answers 404', (e) => (e.path.includes('/fields') ? { status: 404 } : null), 'board'],
    ['a later item page answers 200 without a version tag', (e) => (e.path.includes('/items') && e.path.includes('after=') ? 'no-etag' : null), 'board'],
    ['the repository answers 500', (e) => (e.path.includes('/repos/') ? { status: 500 } : null), 'repo'],
    ['the repository answers 200 without a version tag', (e) => (e.path.includes('/repos/') ? 'no-etag' : null), 'repo'],
    // PR #272 review round 1: "not modified" without a version tag is no answer either, at each of the three calls
    ['the field list answers 304 without a version tag', (e) => (e.path.includes('/fields') ? { status: 304 } : null), 'board'],
    ['an item page answers 304 without a version tag', (e) => (e.path.includes('/items') ? { status: 304 } : null), 'board'],
    ['the repository answers 304 without a version tag', (e) => (e.path.includes('/repos/') ? { status: 304 } : null), 'repo'],
  ];
  for (const [what, f, hit] of cases) {
    it(what, async () => {
      const { c } = await ready();
      expect(boardReads(await round(c)) + repoReads(await round(c))).toBe(0); // quiet before the fault
      fault(f);
      for (const _ of [1, 2]) {
        // this round and the next: a failed check leaves no record to compare with
        const sent = await round(c);
        expect(boardReads(sent)).toBe(hit === 'board' ? 1 : 0);
        expect(repoReads(sent)).toBe(hit === 'repo' ? 1 : 0);
        expect(c.getState().sync.sources.every((s) => s.ok)).toBe(true);
      }
      // honest answers again: one round takes new tags (and reads), then quiet
      fault(() => null);
      await round(c);
      const quiet = await round(c);
      expect(boardReads(quiet) + repoReads(quiet)).toBe(0);
    });
  }

  it('the count query fails: every board reads in full each round (repositories are not affected)', async () => {
    const { c, clock } = await ready();
    // a board that does not exist makes the one count query answer with an error
    c.addSource('https://github.com/orgs/GigleAI/projects/98');
    await c.settled();
    await c.syncNow();
    const of11 = (l: LoggedRequest[]) => l.filter((e) => e.operation === 'CavilProjectItems' && e.variables?.number === 11 && (e.variables?.after ?? null) === null).length;
    // GitHub#374: the missing board waits 1, then 2 minutes before it is read again — the clock moves on to each turn
    for (const wait of [60_000, 120_000]) {
      clock.t += wait;
      const sent = await round(c);
      expect(sent.some((e) => e.operation === 'CavilProjectCounts' && e.status === 200)).toBe(true);
      expect(of11(sent)).toBe(1);
      expect(repoReads(sent)).toBe(0);
    }
    expect(c.getState().sync.sources.find((s) => s.sourceKey === PROJECT_KEY)!.ok).toBe(true);
  });
});

describe('a record vouches only for the snapshot it was taken for', () => {
  it('a change between the check and the full read: not in this read, seen by the next round', async () => {
    const { c } = await ready({ sources: [PROJECT_URL] });
    statusOnBoard(22, 'In progress');
    // the full read's first page has been answered (the fake froze it) when this runs: the
    // second change lands after the check and after that page was read
    let done = false;
    const release = fake.holdWhen((e) => {
      if (done || e.operation !== 'CavilProjectItems') return false;
      done = true;
      statusOnBoard(22, 'In review');
      return false;
    });
    await c.syncNow();
    release();
    expect(done).toBe(true);
    expect(statusOf(c, 22)).toBe('In progress');
    const sent = await round(c);
    expect(boardReads(sent)).toBe(1);
    expect(statusOf(c, 22)).toBe('In review');
  });

  it('a round whose read could not be saved keeps no record: the next round reads in full', async () => {
    let failSave = false;
    const { c } = await ready({
      sources: [PROJECT_URL],
      intercept: (cmd) => (cmd === 'replaceSnapshots' && failSave ? Promise.reject(new Error('disk full')) : undefined),
    });
    statusOnBoard(22, 'In progress');
    failSave = true;
    await c.syncNow();
    expect(statusOf(c, 22)).toBe('Done'); // nothing landed
    failSave = false;
    const sent = await round(c);
    expect(boardReads(sent)).toBe(1);
    expect(statusOf(c, 22)).toBe('In progress');
  });

  // PR #272 review round 1: a full read the check could not have asked for (a view edited, read by
  // hand) whose save fails must be read again by the next round — the old record must not skip it
  for (const how of ['the save throws', 'the save is refused'] as const) {
    it(`a refresh by hand whose save fails (${how}): the next automatic round reads in full again`, async () => {
      let failSave = false;
      const { c, clock } = await ready({
        sources: [PROJECT_URL],
        intercept: (cmd) =>
          cmd === 'replaceSnapshots' && failSave ? (how === 'the save throws' ? Promise.reject(new Error('disk full')) : Promise.resolve({ written: false })) : undefined,
      });
      clock.t += 60_000;
      expect(boardReads(await round(c))).toBe(0);
      for (const pg of pages()) pg.views = { nodes: pg.views!.nodes.map((v: any) => (v.number === 1 ? { ...v, name: 'Renamed view' } : v)) };
      failSave = true;
      clock.t += 60_000;
      const n = fake.log.length;
      await c.restartSync();
      expect(boardReads(since(n))).toBe(1);
      expect(c.getBoardData().projects[0].views.find((v) => v.number === 1)!.name).not.toBe('Renamed view');
      failSave = false;
      clock.t += 60_000;
      const sent = await round(c);
      expect(boardReads(sent)).toBe(1);
      expect(c.getBoardData().projects[0].views.find((v) => v.number === 1)!.name).toBe('Renamed view');
      expect(c.getState().sync.sources.find((st) => st.sourceKey === PROJECT_KEY)).toMatchObject({ ok: true, dataFrom: clock.t });
      // and quiet again once that read has landed
      clock.t += 60_000;
      expect(boardReads(await round(c))).toBe(0);
    });
  }

  it('a round dropped by a refresh by hand, finishing after the new round saved: it drops none of the new records (PR #272 review round 2)', async () => {
    let droppedDone!: () => void;
    const droppedFinished = new Promise<void>((r) => (droppedDone = r));
    const { c, clock } = await ready({ sources: [PROJECT_URL], afterRoundRead: (dropped) => dropped && droppedDone() });
    clock.t += 60_000;
    statusOnBoard(22, 'In progress');
    // the automatic round's full read is held (its first page)
    let holding = true;
    const release = fake.holdWhen((e) => holding && e.operation === 'CavilProjectItems' && (e.variables?.after ?? null) === null);
    const n = fake.log.length;
    const auto = c.syncNow();
    for (let i = 0; i < 500 && !since(n).some((e) => e.operation === 'CavilProjectItems' && e.status === 0); i++) await new Promise((res) => setTimeout(res, 10));
    expect(since(n).some((e) => e.operation === 'CavilProjectItems' && e.status === 0)).toBe(true);
    // a refresh by hand drops it, reads in full and saves its record
    holding = false;
    clock.t += 60_000;
    await c.restartSync();
    expect(statusOf(c, 22)).toBe('In progress');
    // only now does the dropped round's answer come, and that round finishes in the background
    release();
    await auto;
    await droppedFinished;
    // nothing changed since the refresh: the record the refresh saved is still there
    clock.t += 60_000;
    const next = await round(c);
    expect(boardReads(next)).toBe(0);
    expect(checks(next).filter((e) => e.method === 'HEAD').every((e) => e.status === 304)).toBe(true);
    expect(statusOf(c, 22)).toBe('In progress');
  });

  it('signed out and in again: the first round reads in full although nothing changed', async () => {
    const { c } = await ready({ sources: [PROJECT_URL] });
    expect(boardReads(await round(c))).toBe(0);
    await c.logout();
    const n = fake.log.length;
    fake.state.nextGrant = { token: FAKE_TOKEN };
    c.setClientId(fake.state.oauthClientId);
    const login = c.startLogin();
    for (let i = 0; i < 500 && c.getState().login.status !== 'waiting'; i++) await new Promise((res) => setTimeout(res, 10));
    fake.resolveGrant('approved');
    await login;
    await c.syncNow();
    // nothing changed on GitHub, yet the board was read in full after signing in again
    // (a record kept across the sign-out would keep the snapshot for up to 10 minutes)
    expect(boardReads(since(n))).toBeGreaterThanOrEqual(1);
    // and quiet again on the round after
    expect(boardReads(await round(c))).toBe(0);
  });

  it('a source removed and added again starts with a full read', async () => {
    const { c } = await ready({ sources: [PROJECT_URL] });
    expect(boardReads(await round(c))).toBe(0);
    const n = fake.log.length;
    c.removeSource(PROJECT_KEY);
    c.addSource(PROJECT_URL);
    await c.settled();
    await c.syncNow();
    expect(boardReads(since(n))).toBeGreaterThanOrEqual(1);
    expect(c.getBoardData().items.length).toBeGreaterThan(0);
    expect(boardReads(await round(c))).toBe(0);
  });
});

describe('a kept snapshot is no new read: an edit in flight is not judged on it', () => {
  it('GitHub lags ("not modified" although the label is there): the board keeps showing the edit, the round lands nothing', async () => {
    const { c, cache, clock } = await ready({ sources: [PROJECT_URL] });
    clock.t += 60_000;
    // the re-read after the change never comes back, and every check says "not modified"
    const holdRefresh = fake.holdWhen((e) => e.operation === 'CavilItemRefresh');
    fault(() => 'not-modified');
    const p = c.act({ kind: 'addLabel', key: K(138), label: 'bug', color: 'd73a4a' });
    for (let i = 0; i < 500 && !fake.log.some((e) => e.operation === 'CavilItemRefresh'); i++) await new Promise((res) => setTimeout(res, 10));
    const before = cache.loadSnapshots().get(PROJECT_KEY)!.fetchedAt;
    clock.t += 60_000;
    const sent = await round(c);
    expect(boardReads(sent)).toBe(0);
    // the label the user just added is still what the board shows (an old copy re-stamped as a
    // fresh read would have counted as "GitHub says otherwise, read after the change")
    expect(onBoard(c, 138)!.labels.map((l) => l.name)).toContain('bug');
    expect(cache.loadSnapshots().get(PROJECT_KEY)!.fetchedAt).toBe(before);
    holdRefresh();
    await p;
  });
});
