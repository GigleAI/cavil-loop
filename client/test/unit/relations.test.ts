// GigleAI/cavil-loop#349: the sync reads each issue's relations — parent, sub-issues,
// blocked-by, blocking — and keeps them in the same snapshot as the items: whole, or the
// previous snapshot stays. Real readers / real controller with the real Rust back end, the
// fake GitHub over HTTP. The relation data is recorded from the real board
// (test/fixtures/record.mjs --relations); the fake cuts the lists into pages and can fail one.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import { GitHubClient } from '../../src/data/github';
import { contentToItem, fetchProject, fetchRepo } from '../../src/data/fetchSources';
import { applyFreshItem, fetchItem } from '../../src/data/itemRefresh';
import { mergeSnapshots } from '../../src/data/merge';
import { fetchRelationsBatch, readRelations, relationsKnown } from '../../src/data/relations';
import { syncRound } from '../../src/data/sync';
import type { SourceCheck } from '../../src/data/changeCheck';
import { parseSource } from '../../src/shared/sources';
import type { Item, ItemRelations, SourceConfig, SourceSnapshot } from '../../src/shared/types';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { loadRelationIssues, loadRelationPages, startFakeGitHub, type FakeGitHub, type LoggedRequest } from '../fake-github/server';
import { FAKE_TOKEN, tempDir, trustedList } from './helpers';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const PROJECT_KEY = 'project:org/gigleai/11';
const BOARD = 'org/gigleai/11';
const REPO = 'GigleAI/cavil-loop';
const REPO_KEY = 'repo:gigleai/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;
const NOW = Date.parse('2026-11-10T12:00:00Z');

// What the recording holds (2026-11-10), named once:
//   #346 has the sub-issues #349 and #350; #349 blocks #350, both open
//   #311 has three sub-issues (#313 #314 #315); the repository list holds #311, #314, #315 — not #313
//   #181 is blocked by #169 (closed);  #232's parent is in another repository
const PARENT = 346;
const BLOCKER = 349;
const BLOCKED = 350;
const WIDE = 311;
const WIDE_SUBS = [313, 314, 315];
const OUTSIDE_SUB = 313;

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

beforeEach(async () => {
  fake = await startFakeGitHub({ projects: new Map([[BOARD, loadRelationPages()]]), repos: new Map([['gigleai/cavil-loop', loadRelationIssues()]]) });
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

const client = () => new GitHubClient({ api: fake.api, web: fake.web }, FAKE_TOKEN);
const boardSrc = () => parseSource(PROJECT_URL) as Extract<SourceConfig, { kind: 'project' }>;
const repoSrc = () => parseSource(REPO) as Extract<SourceConfig, { kind: 'repo' }>;
const of = (snap: SourceSnapshot, n: number) => snap.items.find((i) => i.key === K(n))!;
const numbers = (xs: { number: number }[]) => xs.map((x) => x.number);
const since = (n: number) => fake.log.slice(n);
const ops = (l: LoggedRequest[], op: string) => l.filter((e) => e.operation === op);
const boardReads = (l: LoggedRequest[]) => l.filter((e) => e.operation === 'CavilProjectItems' && (e.variables?.after ?? null) === null).length;
const onePerPage = () => (fake.state.w.relationPage = { subIssues: 1, blockedBy: 1, blocking: 1, more: 1 });
/** somebody closes / reopens an issue on github.com */
async function setState(n: number, state: 'open' | 'closed') {
  const r = await fetch(`${fake.api}/repos/${REPO}/issues/${n}`, { method: 'PATCH', headers: { authorization: `Bearer ${FAKE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ state }) });
  expect(r.status).toBe(200);
}
/** a snapshot as a client before #349 cached it: the same items, no relations */
const preRelations = (snap: SourceSnapshot): SourceSnapshot => ({ ...snap, items: snap.items.map(({ relations: _r, relationsAt: _t, ...rest }) => rest as Item) });

describe('what is read', () => {
  it('board: parent with title and state, sub-issues, blocked-by and blocking — and no request beyond the board pages', async () => {
    const snap = await fetchProject(client(), boardSrc(), NOW);
    const parent = of(snap, PARENT).relations!;
    expect(numbers(parent.subIssues)).toEqual([BLOCKER, BLOCKED]);
    expect(parent.parent).toBeNull();
    const blocked = of(snap, BLOCKED).relations!;
    expect(blocked.blockedBy).toEqual([{ key: K(BLOCKER), repo: REPO, number: BLOCKER, title: of(snap, BLOCKER).title, url: `https://github.com/${REPO}/issues/${BLOCKER}`, state: 'open', stateReason: null }]);
    expect(blocked.parent).toMatchObject({ key: K(PARENT), number: PARENT, title: of(snap, PARENT).title, state: 'open' });
    expect(numbers(of(snap, BLOCKER).relations!.blocking)).toEqual([BLOCKED]);
    // a closed blocker keeps its close reason (what the arrow's colour will be decided on)
    expect(of(snap, 181).relations!.blockedBy).toMatchObject([{ number: 169, state: 'closed', stateReason: 'completed' }]);
    // the item's own parent key is still the parent's key
    expect(of(snap, BLOCKED).parent).toBe(K(PARENT));
    // every issue of the read carries relations; only board pages went out
    expect(relationsKnown(snap.items)).toBe(true);
    expect(fake.log.map((e) => e.operation)).toEqual(fake.log.map(() => 'CavilProjectItems'));
    expect(fake.log.length).toBeGreaterThan(0);
  });

  it('a parent in another repository, not in any source: its repository, number, title and state come with the child', async () => {
    const snap = await fetchProject(client(), boardSrc(), NOW);
    const child = of(snap, 232);
    expect(child.relations!.parent).toMatchObject({ repo: 'GigleAI/GigleTutor-Web', number: 1458, key: 'gigleai/gigletutor-web#1458' });
    expect(child.relations!.parent!.title).not.toBe('');
    expect(['open', 'closed']).toContain(child.relations!.parent!.state);
    expect(snap.items.some((i) => i.key === 'gigleai/gigletutor-web#1458')).toBe(false);
    // nothing was asked of that repository
    expect(fake.log.every((e) => !e.path.toLowerCase().includes('gigletutor'))).toBe(true);
  });

  it('repository: the parent is in the source, one sub-issue is not — its number, title and state are read all the same', async () => {
    const snap = await fetchRepo(client(), repoSrc(), NOW);
    expect(snap.items.some((i) => i.key === K(OUTSIDE_SUB))).toBe(false);
    expect(snap.items.some((i) => i.key === K(WIDE))).toBe(true);
    const subs = of(snap, WIDE).relations!.subIssues;
    expect(numbers(subs)).toEqual(WIDE_SUBS);
    const outside = subs.find((s) => s.number === OUTSIDE_SUB)!;
    expect(outside).toMatchObject({ key: K(OUTSIDE_SUB), repo: REPO, state: 'closed', stateReason: 'completed', url: `https://github.com/${REPO}/issues/${OUTSIDE_SUB}` });
    expect(outside.title.length).toBeGreaterThan(0);
  });

  it('repository: one batch request, for exactly the issues whose counts say they have relations; the others are known to have none', async () => {
    const issues = loadRelationIssues();
    const hinted = issues.filter((r) => r.issue_dependencies_summary.total_blocked_by || r.issue_dependencies_summary.total_blocking || r.sub_issues_summary?.total || r.parent_issue_url);
    expect(hinted.length).toBeGreaterThan(0);
    expect(hinted.length).toBeLessThan(issues.length);
    const snap = await fetchRepo(client(), repoSrc(), NOW);
    const batches = ops(fake.log, 'CavilIssueRelationsBatch');
    expect(batches).toHaveLength(1);
    const idOf = (n: number) => of(snap, n).nodeId;
    expect([...(batches[0].variables!.ids as string[])].sort()).toEqual(hinted.map((r) => idOf(r.number)).sort());
    expect(ops(fake.log, 'CavilIssueRelations')).toHaveLength(0);
    for (const it of snap.items) {
      const has = hinted.some((r) => r.number === it.number);
      const rel = it.relations!;
      expect(Boolean(rel.parent) || rel.subIssues.length + rel.blockedBy.length + rel.blocking.length > 0, `#${it.number}`).toBe(has);
    }
    expect(numbers(of(snap, BLOCKED).relations!.blockedBy)).toEqual([BLOCKER]);
  });

  it('repository: more issues than one batch holds are read batch by batch, all of them', async () => {
    const snap = await fetchRepo(client(), repoSrc(), NOW);
    const withRel = snap.items.filter((i) => i.relations!.parent || i.relations!.subIssues.length || i.relations!.blockedBy.length || i.relations!.blocking.length);
    const n = fake.log.length;
    const got = await fetchRelationsBatch(client(), withRel.map((i) => ({ nodeId: i.nodeId, what: i.key })), 2);
    expect(ops(since(n), 'CavilIssueRelationsBatch')).toHaveLength(Math.ceil(withRel.length / 2));
    expect(withRel.length).toBeGreaterThan(2);
    for (const i of withRel) expect(got.get(i.nodeId)).toEqual(i.relations);
  });

  it('a pull request has no relations: known-empty, not unknown (the earlier recording, which holds pull requests)', async () => {
    const legacy = await startFakeGitHub();
    try {
      const c = new GitHubClient({ api: legacy.api, web: legacy.web }, FAKE_TOKEN);
      for (const snap of [await fetchProject(c, boardSrc(), NOW), await fetchRepo(c, repoSrc(), NOW)]) {
        const prs = snap.items.filter((i) => i.kind === 'pr');
        expect(prs.length).toBeGreaterThan(0);
        for (const pr of prs) expect(pr.relations).toEqual({ parent: null, subIssues: [], blockedBy: [], blocking: [] });
        expect(relationsKnown(snap.items)).toBe(true);
      }
    } finally {
      await legacy.close();
    }
  });
});

describe('lists longer than one page', () => {
  it('an answer with pages still unread, or without the relation fields at all, is "unknown" — never the first page as the whole list', async () => {
    onePerPage();
    const data = await client().graphql<any>((await import('../../src/data/queries')).ITEM_REFRESH_QUERY, { owner: 'GigleAI', name: 'cavil-loop', number: WIDE });
    const raw = data.repository.issueOrPullRequest;
    // what GitHub sent: one of three sub-issues, and "there is more"
    expect(raw.subIssues.nodes).toHaveLength(1);
    expect(raw.subIssues.pageInfo.hasNextPage).toBe(true);
    expect(readRelations(raw)).toBeUndefined();
    expect(contentToItem(raw, [], [])!.relations).toBeUndefined();
    // the answer of a query that never asked (the shape before #349)
    const { parent: _p, subIssues: _s, blockedBy: _b, blocking: _g, ...old } = raw;
    expect(contentToItem(old, [], [])!.relations).toBeUndefined();
    // control: the same issue with whole lists is known
    expect(readRelations({ ...raw, subIssues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: raw.subIssues.nodes } })).toBeDefined();
  });

  it('board and repository: each list is read to its last page, and equals the one-page read', async () => {
    const whole = { board: await fetchProject(client(), boardSrc(), NOW), repo: await fetchRepo(client(), repoSrc(), NOW) };
    onePerPage();
    const n = fake.log.length;
    const board = await fetchProject(client(), boardSrc(), NOW);
    const boardLog = since(n);
    const paged = { board, repo: await fetchRepo(client(), repoSrc(), NOW) };
    const rel = (s: SourceSnapshot) => Object.fromEntries(s.items.map((i) => [i.key, i.relations]));
    expect(rel(paged.board)).toEqual(rel(whole.board));
    expect(rel(paged.repo)).toEqual(rel(whole.repo));
    // the follow-up pages really went out: #311's three sub-issues need two more, each from the cursor of the one before
    const forWide = (l: LoggedRequest[]) => ops(l, 'CavilIssueRelations').filter((e) => e.variables!.id === of(whole.board, WIDE).nodeId);
    for (const more of [forWide(boardLog), forWide(since(n + boardLog.length))]) {
      expect(more.map((e) => e.variables!.subIssuesAfter)).toEqual(['rel-1', 'rel-2']);
      expect(more.every((e) => e.variables!.subIssues === true && e.variables!.blockedBy === false && e.variables!.blocking === false)).toBe(true);
    }
    expect(numbers(of(paged.board, WIDE).relations!.subIssues)).toEqual(WIDE_SUBS);
    expect(numbers(of(paged.repo, WIDE).relations!.subIssues)).toEqual(WIDE_SUBS);
  });
});

describe('one issue read whole and re-read alone gives the same relations', () => {
  for (const pageSize of ['as recorded', 'one a page'] as const) {
    it(`every issue of the board and of the repository (${pageSize})`, async () => {
      if (pageSize === 'one a page') onePerPage();
      const snaps = [await fetchProject(client(), boardSrc(), NOW), await fetchRepo(client(), repoSrc(), NOW)];
      let compared = 0;
      let nonEmpty = 0;
      for (const snap of snaps)
        for (const it of snap.items.filter((i) => i.repo === REPO)) {
          const again = contentToItem((await fetchItem(client(), it.repo, it.number)).content, [], [])!;
          expect(again.relations, `${snap.sourceKey} ${it.key}`).toEqual(it.relations);
          compared++;
          if (it.relations!.parent || it.relations!.subIssues.length || it.relations!.blockedBy.length || it.relations!.blocking.length) nonEmpty++;
        }
      expect(compared).toBeGreaterThan(30);
      expect(nonEmpty).toBeGreaterThan(20);
    });
  }

  it('a re-read whose later page fails gives nothing at all (never the first page as if it were the list)', async () => {
    onePerPage();
    fake.state.w.failRelationPages.add(K(WIDE));
    const n = fake.log.length;
    await expect(fetchItem(client(), REPO, WIDE)).rejects.toThrow(/502/);
    expect(ops(since(n), 'CavilIssueRelations').map((e) => e.status)).toEqual([502]);
  });
});

describe('the blocker is closed and reopened on GitHub (in the fake; the recording is not edited)', () => {
  it('the state a blocked issue shows for its blocker follows, on the board and in the repository', async () => {
    const blockerState = async () => [
      of(await fetchProject(client(), boardSrc(), NOW), BLOCKED).relations!.blockedBy[0].state,
      of(await fetchRepo(client(), repoSrc(), NOW), BLOCKED).relations!.blockedBy[0].state,
      contentToItem((await fetchItem(client(), REPO, BLOCKED)).content, [], [])!.relations!.blockedBy[0].state,
    ];
    expect(await blockerState()).toEqual(['open', 'open', 'open']);
    await setState(BLOCKER, 'closed');
    expect(await blockerState()).toEqual(['closed', 'closed', 'closed']);
    await setState(BLOCKER, 'open');
    expect(await blockerState()).toEqual(['open', 'open', 'open']);
  });
});

describe('merging sources', () => {
  it('an issue in two sources takes its relations from the copy that has them; both have them: the newer copy', async () => {
    const board = await fetchProject(client(), boardSrc(), NOW);
    const repo = await fetchRepo(client(), repoSrc(), NOW);
    const withRel = of(board, BLOCKED).relations!;
    // the repository copy is the newer one, but cached before #349: no relations
    const old = preRelations(repo);
    old.items = old.items.map((i) => (i.key === K(BLOCKED) ? { ...i, updatedAt: '2099-01-01T00:00:00Z', title: 'newer title' } : i));
    const merged = mergeSnapshots([board, old], null);
    const it = merged.items.find((i) => i.key === K(BLOCKED))!;
    expect(it.title).toBe('newer title');
    expect(it.relations).toEqual(withRel);
    expect(merged.relationsUnknown).toEqual([REPO_KEY]);
    // both read: the newer copy's relations
    const newer: ItemRelations = { ...withRel, blockedBy: [] };
    const both = mergeSnapshots([board, { ...repo, items: repo.items.map((i) => (i.key === K(BLOCKED) ? { ...i, updatedAt: '2099-01-01T00:00:00Z', relations: newer } : i)) }], null);
    expect(both.items.find((i) => i.key === K(BLOCKED))!.relations).toEqual(newer);
    expect(both.relationsUnknown).toEqual([]);
    // an issue only the old snapshot holds stays unknown — not "no relations"
    const only = mergeSnapshots([old], null).items.find((i) => i.key === K(WIDE))!;
    expect(only.relations).toBeUndefined();
  });
});

describe('two sources hold the issue, only one of them is read again (PR #353 review round 1)', () => {
  // the blocked issue's own update time never moves in these: only its blocker is closed
  const blockerIn = (snaps: Iterable<SourceSnapshot>) => mergeSnapshots([...snaps], null).items.find((i) => i.key === K(BLOCKED))!.relations!.blockedBy[0].state;
  const cases = [
    { order: 'board first', fails: 'the board', srcs: () => [boardSrc(), repoSrc()], fail: () => void fake.state.failProjectPage.set(BOARD, 0), failed: PROJECT_KEY },
    { order: 'board first', fails: 'the repository', srcs: () => [boardSrc(), repoSrc()], fail: () => void (fake.state.w.failRelationsBatch = true), failed: REPO_KEY },
    { order: 'repository first', fails: 'the board', srcs: () => [repoSrc(), boardSrc()], fail: () => void fake.state.failProjectPage.set(BOARD, 0), failed: PROJECT_KEY },
    { order: 'repository first', fails: 'the repository', srcs: () => [repoSrc(), boardSrc()], fail: () => void (fake.state.w.failRelationsBatch = true), failed: REPO_KEY },
  ];
  for (const k of cases) {
    it(`${k.order}, ${k.fails} fails after the blocker was closed: the merged issue shows what the source that was read says`, async () => {
      const first = await syncRound(client(), k.srcs(), new Map(), NOW, new Map(), 0);
      expect(first.status.map((s) => s.ok)).toEqual([true, true]);
      expect(blockerIn(first.snapshots.values())).toBe('open');
      const stamp = (snaps: Map<string, SourceSnapshot>) => [PROJECT_KEY, REPO_KEY].map((key) => of(snaps.get(key)!, BLOCKED).updatedAt);
      await setState(BLOCKER, 'closed');
      k.fail();
      const second = await syncRound(client(), k.srcs(), first.snapshots, NOW + 60_000, new Map(), 0);
      // one source failed and kept its snapshot (blocker still open in it), the other was read
      expect(second.status.filter((s) => !s.ok).map((s) => s.sourceKey)).toEqual([k.failed]);
      expect(second.replaced).toHaveLength(1);
      expect(of(second.snapshots.get(k.failed)!, BLOCKED).relations!.blockedBy[0].state).toBe('open');
      // the blocked issue itself did not change, in either copy
      expect(stamp(second.snapshots)).toEqual(stamp(first.snapshots));
      expect(new Set(stamp(second.snapshots)).size).toBe(1);
      expect(blockerIn(second.snapshots.values())).toBe('closed');
      // and it stays so however long the one source keeps failing; reopened: follows again
      const third = await syncRound(client(), k.srcs(), second.snapshots, NOW + 120_000, new Map(), 0);
      expect(blockerIn(third.snapshots.values())).toBe('closed');
      await setState(BLOCKER, 'open');
      const fourth = await syncRound(client(), k.srcs(), third.snapshots, NOW + 180_000, new Map(), 0);
      expect(blockerIn(fourth.snapshots.values())).toBe('open');
    });
  }

  it('a one-item re-read that reaches only one of the two snapshots: its relations are the newer ones, the snapshot keeps its own time', async () => {
    for (const srcs of [[boardSrc(), repoSrc()], [repoSrc(), boardSrc()]]) {
      await setState(BLOCKER, 'open');
      const first = await syncRound(client(), srcs, new Map(), NOW, new Map(), 0);
      await setState(BLOCKER, 'closed');
      const fresh = await fetchItem(client(), REPO, BLOCKED, NOW + 30_000);
      for (const key of [PROJECT_KEY, REPO_KEY]) {
        const other = key === PROJECT_KEY ? REPO_KEY : PROJECT_KEY;
        const [changed] = applyFreshItem([first.snapshots.get(key)!], fresh);
        expect(changed.fetchedAt).toBe(NOW);
        expect(of(changed, BLOCKED).relationsAt).toBe(NOW + 30_000);
        const snaps = srcs.map((s) => (s.key === key ? changed : first.snapshots.get(other)!));
        expect(blockerIn(snaps), `${srcs[0].key} first, re-read into ${key}`).toBe('closed');
      }
      // a full read that started before that re-read does not put the older relations back
      expect(of(first.snapshots.get(PROJECT_KEY)!, BLOCKED).relationsAt).toBe(NOW);
    }
  });
});

describe('one round: items and relations land together, or the previous snapshot stays', () => {
  const sources = () => [boardSrc(), repoSrc()];

  it('a later relation page fails (an issue both sources hold): each keeps its previous snapshot, field for field, with this round\'s error', async () => {
    const first = await syncRound(client(), sources(), new Map(), NOW, new Map(), 0);
    expect(first.status.map((s) => s.ok)).toEqual([true, true]);
    const before = structuredClone(first.snapshots.get(PROJECT_KEY)!);
    // GitHub changed meanwhile (must not leak in), and #311's lists now need pages — one of which fails
    await setState(BLOCKER, 'closed');
    onePerPage();
    fake.state.w.failRelationPages.add(K(WIDE));
    const n = fake.log.length;
    const second = await syncRound(client(), sources(), first.snapshots, NOW + 60_000, new Map(), 0);
    // the failing request did go out, at the paging step, after the board pages were all read
    const failed = ops(since(n), 'CavilIssueRelations').filter((e) => e.status === 502);
    expect(failed).toHaveLength(2); // one per source
    for (const f of failed) expect(f.variables).toMatchObject({ id: of(before, WIDE).nodeId, subIssues: true, subIssuesAfter: 'rel-1' });
    expect(boardReads(since(n))).toBe(1);
    expect(ops(since(n), 'CavilIssueRelationsBatch').map((e) => e.status)).toEqual([200]);
    // the previous snapshot, the very object, unchanged
    expect(second.snapshots.get(PROJECT_KEY)).toBe(first.snapshots.get(PROJECT_KEY));
    expect(second.snapshots.get(PROJECT_KEY)).toEqual(before);
    expect(of(second.snapshots.get(PROJECT_KEY)!, BLOCKED).relations!.blockedBy[0].state).toBe('open');
    expect(second.replaced).toEqual([]);
    // this round's error and the time of the data still shown
    const st = second.status.find((s) => s.sourceKey === PROJECT_KEY)!;
    expect(st).toMatchObject({ ok: false, dataFrom: NOW });
    expect(st.error).toContain('502');
    expect(second.status.find((s) => s.sourceKey === REPO_KEY)).toMatchObject({ ok: false, dataFrom: NOW });
    expect(second.snapshots.get(REPO_KEY)).toBe(first.snapshots.get(REPO_KEY));
  });

  it('the batch read of a repository fails: its previous snapshot stays; the board, read whole, is replaced', async () => {
    const first = await syncRound(client(), sources(), new Map(), NOW, new Map(), 0);
    fake.state.w.failRelationsBatch = true;
    await setState(BLOCKER, 'closed');
    const n = fake.log.length;
    const second = await syncRound(client(), sources(), first.snapshots, NOW + 60_000, new Map(), 0);
    expect(ops(since(n), 'CavilIssueRelationsBatch').map((e) => e.status)).toEqual([502]);
    expect(second.snapshots.get(REPO_KEY)).toBe(first.snapshots.get(REPO_KEY));
    expect(second.status.find((s) => s.sourceKey === REPO_KEY)).toMatchObject({ ok: false, dataFrom: NOW });
    // "something did happen": the board was read again and shows the change
    expect(second.replaced.map((s) => s.sourceKey)).toEqual([PROJECT_KEY]);
    expect(of(second.snapshots.get(PROJECT_KEY)!, BLOCKED).relations!.blockedBy[0].state).toBe('closed');
  });

  it('no relations yet (a snapshot cached before #349) and the read fails: the items stay, the relations stay unknown — not empty', async () => {
    const good = await syncRound(client(), sources(), new Map(), NOW, new Map(), 0);
    const cached = new Map([...good.snapshots].map(([k, s]) => [k, preRelations(s)]));
    onePerPage();
    fake.state.w.failRelationPages.add(K(WIDE));
    const n = fake.log.length;
    const round = await syncRound(client(), sources(), cached, NOW + 60_000, new Map(), 0);
    expect(ops(since(n), 'CavilIssueRelations').some((e) => e.status === 502 && e.variables!.subIssuesAfter === 'rel-1')).toBe(true);
    for (const key of [PROJECT_KEY, REPO_KEY]) {
      const snap = round.snapshots.get(key)!;
      expect(snap).toBe(cached.get(key));
      expect(snap.items.length).toBe(good.snapshots.get(key)!.items.length);
      expect(snap.items.every((i) => i.relations === undefined)).toBe(true);
      expect(relationsKnown(snap.items)).toBe(false);
    }
    expect(mergeSnapshots([...round.snapshots.values()], null).relationsUnknown).toEqual([PROJECT_KEY, REPO_KEY]);
    // GitHub answers again: the first whole read fills them in
    fake.state.w.failRelationPages.clear();
    const ok = await syncRound(client(), sources(), round.snapshots, NOW + 120_000, new Map(), 0);
    expect(mergeSnapshots([...ok.snapshots.values()], null).relationsUnknown).toEqual([]);
    expect(numbers(of(ok.snapshots.get(PROJECT_KEY)!, WIDE).relations!.subIssues)).toEqual(WIDE_SUBS);
  });

  it('"nothing changed" never keeps a snapshot whose relations are unknown: it is read in full', async () => {
    // a first round with the change check on: snapshots and their check records
    const first = await syncRound(client(), sources(), new Map(), NOW, new Map(), 600_000);
    const records = first.checks;
    expect([...records.keys()].sort()).toEqual([PROJECT_KEY, REPO_KEY]);
    // control: with whole snapshots the next round confirms "unchanged" and reads nothing in full
    let n = fake.log.length;
    const same = await syncRound(client(), sources(), first.snapshots, NOW + 60_000, records, 600_000);
    expect(same.unchanged.sort()).toEqual([PROJECT_KEY, REPO_KEY]);
    expect(boardReads(since(n))).toBe(0);
    // the same records, the same answers from GitHub — but the snapshots carry no relations
    const cached = new Map([...first.snapshots].map(([k, s]) => [k, preRelations(s)]));
    n = fake.log.length;
    const round = await syncRound(client(), sources(), cached, NOW + 60_000, records as Map<string, SourceCheck>, 600_000);
    expect(round.unchanged).toEqual([]);
    expect(boardReads(since(n))).toBe(1);
    expect(ops(since(n), 'CavilIssueRelationsBatch')).toHaveLength(1);
    expect(round.replaced.map((s) => s.sourceKey).sort()).toEqual([PROJECT_KEY, REPO_KEY]);
    expect(relationsKnown(round.snapshots.get(PROJECT_KEY)!.items) && relationsKnown(round.snapshots.get(REPO_KEY)!.items)).toBe(true);
  });
});

describe('the app: cache on disk, status, the round after a failure, sign-out', () => {
  /** `again`: the app starts a second time on the files of the first */
  async function ready(again = false) {
    const cache = new Cache(join(dir, 'cache.sqlite'));
    caches.push(cache);
    if (!again) cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
    const credentials = new FileStore(join(dir, 'cred'));
    if (!again) await credentials.set(FAKE_TOKEN);
    const clock = { t: again ? NOW + 3_600_000 : NOW };
    const endpoints = { api: fake.api, web: fake.web };
    const harness = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: () => clock.t, sleep: async () => {} });
    backends.push(harness);
    const c = await Controller.create({ backend: harness, endpoints, now: () => clock.t, defaultClientId: '', followUpSyncMs: 600_000 });
    controllers.push(c);
    if (!again) for (const s of [PROJECT_URL, REPO]) c.addSource(s);
    return { c, cache, clock, harness };
  }
  const statusOf = (c: Controller, key: string) => c.getState().sync.sources.find((s) => s.sourceKey === key)!;
  const shown = (c: Controller, n: number) => c.getBoardData().items.find((i) => i.key === K(n))!;

  it('relations reach the cache and the board data; a failed round leaves both as they were and says so; the next round reads in full again', async () => {
    const { c, cache, clock } = await ready();
    await c.start();
    expect(numbers(shown(c, PARENT).relations!.subIssues)).toEqual([BLOCKER, BLOCKED]);
    expect(c.getBoardData().relationsUnknown).toEqual([]);
    const disk = () => JSON.stringify([...cache.loadSnapshots()].filter(([k]) => k === PROJECT_KEY || k === REPO_KEY).sort());
    await c.settled();
    const before = disk();
    expect(before).toContain('"blockedBy"');
    const readAt = cache.loadSnapshots().get(PROJECT_KEY)!.fetchedAt;

    // GitHub changes, and reading the relations now fails on a later page
    await setState(BLOCKER, 'closed');
    onePerPage();
    fake.state.w.failRelationPages.add(K(WIDE));
    clock.t += 60_000;
    let n = fake.log.length;
    await c.syncNow();
    await c.settled();
    expect(ops(since(n), 'CavilIssueRelations').some((e) => e.status === 502)).toBe(true);
    expect(disk()).toBe(before);
    expect(shown(c, BLOCKED).relations!.blockedBy[0].state).toBe('open');
    expect(statusOf(c, PROJECT_KEY)).toMatchObject({ ok: false, dataFrom: readAt });
    expect(statusOf(c, PROJECT_KEY).error).toContain('502');
    expect(c.getBoardData().relationsUnknown).toEqual([]);

    // GitHub answers again and nothing changed since the failed round: still a full read, not "unchanged"
    fake.state.w.failRelationPages.clear();
    clock.t += 60_000;
    n = fake.log.length;
    await c.syncNow();
    await c.settled();
    expect(boardReads(since(n))).toBe(1);
    expect(statusOf(c, PROJECT_KEY)).toMatchObject({ ok: true, error: null, dataFrom: clock.t });
    expect(shown(c, BLOCKED).relations!.blockedBy[0].state).toBe('closed');
    expect(disk()).not.toBe(before);
    // control: one more round, nothing changed and nothing failed — now the check may skip the read
    clock.t += 60_000;
    n = fake.log.length;
    await c.syncNow();
    expect(boardReads(since(n))).toBe(0);
  });

  it('a cache written before #349: relations unknown at start and after a failed first read, filled by the first read that succeeds', async () => {
    // the app ran, read everything and quit; then its rows are put back the way a version before #349 wrote them
    const one = await ready();
    await one.c.start();
    await one.c.settled();
    one.c.stopTimer();
    await one.harness.close();
    const good = one.cache.loadSnapshots();
    one.cache.replaceSnapshots([PROJECT_KEY, REPO_KEY].map((k) => preRelations(good.get(k)!)));

    fake.log.length = 0;
    onePerPage();
    fake.state.w.failRelationPages.add(K(WIDE));
    const { c, cache, clock } = await ready(true);
    // before any round: the cached items show, their relations are unknown
    expect(shown(c, WIDE).title).toBe(of(good.get(PROJECT_KEY)!, WIDE).title);
    expect(shown(c, WIDE).relations).toBeUndefined();
    expect(c.getBoardData().relationsUnknown).toEqual([PROJECT_KEY, REPO_KEY]);
    const count = c.getBoardData().items.length;
    expect(count).toBeGreaterThan(20);
    await c.start();
    await c.settled();
    expect(ops(fake.log, 'CavilIssueRelations').some((e) => e.status === 502 && e.variables!.subIssuesAfter === 'rel-1')).toBe(true);
    expect(statusOf(c, PROJECT_KEY)).toMatchObject({ ok: false, dataFrom: good.get(PROJECT_KEY)!.fetchedAt });
    expect(shown(c, WIDE).relations).toBeUndefined();
    expect(c.getBoardData().relationsUnknown).toEqual([PROJECT_KEY, REPO_KEY]);
    expect(c.getBoardData().items.length).toBe(count);
    expect(cache.loadSnapshots().get(PROJECT_KEY)!.items.every((i) => i.relations === undefined)).toBe(true);

    fake.state.w.failRelationPages.clear();
    clock.t += 60_000;
    await c.syncNow();
    await c.settled();
    expect(c.getBoardData().relationsUnknown).toEqual([]);
    expect(numbers(shown(c, WIDE).relations!.subIssues)).toEqual(WIDE_SUBS);
    expect(relationsKnown(cache.loadSnapshots().get(PROJECT_KEY)!.items)).toBe(true);
  });

  it('signing out takes the cached relations with everything else', async () => {
    const { c, cache } = await ready();
    await c.start();
    await c.settled();
    expect(JSON.stringify([...cache.loadSnapshots()])).toContain('"subIssues"');
    await c.logout();
    await c.settled();
    expect(cache.loadSnapshots().size).toBe(0);
    expect(c.getBoardData().items).toEqual([]);
  });
});
