// GitHub#373 — several people on one repository: "only what concerns me" reminders.
//
// Four layers, each on the path the app really takes:
//   - the rule itself (`concernsViewer`) and the merge of the two new fields (`mergeSnapshots`),
//     row by row from the tables of the confirmed design, every merge row in both source orders;
//   - the three readers (board, repository, one-item re-read) against the fake GitHub over HTTP:
//     the same answer gives the same fields through each;
//   - the tracker alone for every "what happened to a source" row;
//   - the controller with the real Rust back end as a child process against the fake GitHub:
//     real sync rounds, the change check really skipping a source, a read really failing.
// The fake answers `viewerSubscription` / `reviewRequests` from its own state (not listed =
// UNSUBSCRIBED, nobody asked), the way it serves relations: these tests set them, and the
// assignees, the way a maintainer changes them on GitHub.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../src/app/controller';
import type { Alert, Desktop, DesktopEvent } from '../../src/app/desktop';
import { GitHubClient } from '../../src/data/github';
import { fetchProject, fetchRepo } from '../../src/data/fetchSources';
import { applyFreshItem, fetchItem } from '../../src/data/itemRefresh';
import { mergeSnapshots } from '../../src/data/merge';
import { PendingTracker, concernsViewer } from '../../src/data/pending';
import { parseSource } from '../../src/shared/sources';
import { normalizeNotifyScope } from '../../src/shared/uiPrefs';
import type { Item, ReviewRequested, SourceConfig, SourceSnapshot } from '../../src/shared/types';
import { Cache } from '../support/cache';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { startFakeGitHub, loadCavilProjectPages, loadCavilRepoIssues, type FakeGitHub, type LoggedRequest } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, item, tempDir, trustedList } from './helpers';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const PROJECT_KEY = 'project:org/gigleai/11';
const BOARD = 'org/gigleai/11';
const REPO = 'GigleAI/cavil-loop';
const REPO_KEY = 'repo:gigleai/cavil-loop';
const LABEL = 'pending/human';
/** the fake's signed-in account, and somebody else */
const ME = 'user-1';
const OTHER = 'someone-else';
const key = (n: number) => `gigleai/cavil-loop#${n}`;

// ---- what the recording holds (read straight from the JSON) ----
const rawRepo = loadCavilRepoIssues();
const rawBoard = loadCavilProjectPages().flatMap((pg) => pg.items.nodes).filter((n: any) => !n.isArchived && n.content?.number != null && n.content.repository);
const onBoard = (n: number) => rawBoard.some((x: any) => x.content.number === n && x.content.repository.nameWithOwner === REPO);
const free = (i: any) => i.state === 'open' && !i.labels.some((l: any) => (l.name ?? l) === LABEL) && onBoard(i.number);
/** open, unlabelled, in both sources */
const ISSUES: number[] = rawRepo.filter((i: any) => free(i) && !i.pull_request).map((i: any) => i.number);
const PRS: number[] = rawRepo.filter((i: any) => free(i) && i.pull_request).map((i: any) => i.number);
const [ISSUE_A, ISSUE_B, ISSUE_C, ISSUE_D, ISSUE_E] = ISSUES;
const [PR_A, PR_B] = PRS;

it('the recording still has what these tests need', () => {
  expect(ISSUES.length).toBeGreaterThanOrEqual(5);
  expect(PRS.length).toBeGreaterThanOrEqual(2);
});

// =====================================================================================
// 1. the rule
// =====================================================================================

describe('who an item concerns (the three steps, first that applies)', () => {
  const nobody: ReviewRequested = { users: [], others: false };
  const issue = (extra: Partial<Item> = {}) => item('o/r', 1, { viewerSubscribed: false, reviewRequested: nobody, viewerAt: 1, ...extra });
  const pr = (extra: Partial<Item> = {}) => item('o/r', 2, { kind: 'pr', viewerSubscribed: false, reviewRequested: nobody, viewerAt: 1, ...extra });

  const rows: [string, Item, Item[], boolean][] = [
    ['assigned to the account', issue({ assignees: [ME] }), [], true],
    ['assigned to the account, login written in another case', issue({ assignees: ['User-1'] }), [], true],
    ['assigned to the account and somebody else', issue({ assignees: [OTHER, ME] }), [], true],
    ['assigned to somebody else, the account does not subscribe', issue({ assignees: [OTHER] }), [], false],
    ['assigned to somebody else, the account still subscribes', issue({ assignees: [OTHER], viewerSubscribed: true }), [], false],
    ['assigned to somebody else, subscription unknown', issue({ assignees: [OTHER], viewerSubscribed: null }), [], false],
    ['nobody assigned, the account subscribes', issue({ viewerSubscribed: true }), [], true],
    ['nobody assigned, the account does not subscribe', issue(), [], false],
    ['nobody assigned, subscription read but unknown', issue({ viewerSubscribed: null }), [], true],
    ['nobody assigned, subscription never read (an old cache)', item('o/r', 1), [], true],
    ['PR: the account is asked to review', pr({ reviewRequested: { users: [ME], others: false } }), [], true],
    ['PR: the account is asked to review, assigned to somebody else', pr({ assignees: [OTHER], reviewRequested: { users: [ME], others: true } }), [], true],
    ['PR: only somebody else is asked to review, the account subscribes', pr({ viewerSubscribed: true, reviewRequested: { users: [OTHER], others: false } }), [], false],
    ['PR: only a team is asked to review, the account subscribes', pr({ viewerSubscribed: true, reviewRequested: { users: [], others: true } }), [], false],
    ['PR: the review requests were not read whole', pr({ assignees: [OTHER], reviewRequested: null }), [], true],
    ['PR: the review requests were never read', item('o/r', 2, { kind: 'pr', assignees: [OTHER], viewerSubscribed: false }), [], true],
    ['PR nobody answers for, its issue is assigned to the account', pr(), [issue({ assignees: [ME] })], true],
    ['PR nobody answers for, its issue is assigned to somebody else — the account subscribes to the PR', pr({ viewerSubscribed: true }), [issue({ assignees: [OTHER] })], false],
    ['PR nobody answers for, its issue has nobody and the account subscribes to the issue', pr(), [issue({ viewerSubscribed: true })], true],
    ['PR nobody answers for, two issues, one of them the account\'s', pr(), [issue({ assignees: [OTHER] }), issue({ assignees: [ME] })], true],
    ['PR nobody answers for, no issue found: its own subscription', pr({ viewerSubscribed: true }), [], true],
    ['PR nobody answers for, no issue found, not subscribed', pr(), [], false],
    ['PR nobody answers for, what it names is another PR (not an issue): its own subscription', pr(), [pr({ assignees: [ME] })], false],
    ['PR nobody answers for, the issues GitHub links to it were not read whole', pr({ closingIssues: null }), [], true],
    ['PR nobody answers for, GitHub links no issue to it, not subscribed', pr({ closingIssues: [] }), [], false],
    ['PR assigned to somebody else, its linked issues not read whole: the assignment decides', pr({ assignees: [OTHER], closingIssues: null }), [], false],
    ['PR assigned to somebody else, its issue is the account\'s: the PR\'s own assignment decides', pr({ assignees: [OTHER] }), [issue({ assignees: [ME] })], false],
  ];
  for (const [name, it_, linked, want] of rows) it(name, () => expect(concernsViewer(it_, ME, linked)).toBe(want));
});

// =====================================================================================
// 2. one item in two sources
// =====================================================================================

describe('the two fields of one item held by two sources (never decided by the order of the sources)', () => {
  const asked = (users: string[], others = false): ReviewRequested => ({ users, others });
  type Ties = Pick<Item, 'viewerSubscribed' | 'reviewRequested' | 'viewerAt'>;
  const copy = (ties: Ties, extra: Partial<Item> = {}) => item('o/r', 1, { kind: 'pr', ...ties, ...extra });
  const none: Ties = {};
  const rows: [string, Ties, Ties, Ties][] = [
    ['only one copy was asked (the other is an old cache)', none, { viewerSubscribed: false, reviewRequested: asked([]), viewerAt: 5 }, { viewerSubscribed: false, reviewRequested: asked([]), viewerAt: 5 }],
    ['neither was asked', none, none, none],
    ['read at different times, not subscribed → subscribed', { viewerSubscribed: false, reviewRequested: asked([]), viewerAt: 100 }, { viewerSubscribed: true, reviewRequested: asked(['a']), viewerAt: 200 }, { viewerSubscribed: true, reviewRequested: asked(['a']), viewerAt: 200 }],
    ['read at different times, subscribed → not subscribed', { viewerSubscribed: true, reviewRequested: asked(['a']), viewerAt: 100 }, { viewerSubscribed: false, reviewRequested: asked([]), viewerAt: 200 }, { viewerSubscribed: false, reviewRequested: asked([]), viewerAt: 200 }],
    ['read at different times, the later one unknown', { viewerSubscribed: true, reviewRequested: asked(['a']), viewerAt: 100 }, { viewerSubscribed: null, reviewRequested: null, viewerAt: 200 }, { viewerSubscribed: null, reviewRequested: null, viewerAt: 200 }],
    ['same time, same answer', { viewerSubscribed: true, reviewRequested: asked(['a']), viewerAt: 100 }, { viewerSubscribed: true, reviewRequested: asked(['a']), viewerAt: 100 }, { viewerSubscribed: true, reviewRequested: asked(['a']), viewerAt: 100 }],
    ['same time, one unknown', { viewerSubscribed: null, reviewRequested: null, viewerAt: 100 }, { viewerSubscribed: false, reviewRequested: asked(['a']), viewerAt: 100 }, { viewerSubscribed: null, reviewRequested: null, viewerAt: 100 }],
    ['same time, one says subscribed and one says not', { viewerSubscribed: false, reviewRequested: asked([]), viewerAt: 100 }, { viewerSubscribed: true, reviewRequested: asked([]), viewerAt: 100 }, { viewerSubscribed: true, reviewRequested: asked([]), viewerAt: 100 }],
    ['same time, different people asked', { viewerSubscribed: false, reviewRequested: asked(['b']), viewerAt: 100 }, { viewerSubscribed: false, reviewRequested: asked(['a'], true), viewerAt: 100 }, { viewerSubscribed: false, reviewRequested: asked(['a', 'b'], true), viewerAt: 100 }],
  ];
  const ties = (it_: Item): Ties => ({
    ...(it_.viewerSubscribed !== undefined ? { viewerSubscribed: it_.viewerSubscribed } : {}),
    ...(it_.reviewRequested !== undefined ? { reviewRequested: it_.reviewRequested } : {}),
    ...(it_.viewerAt !== undefined ? { viewerAt: it_.viewerAt } : {}),
  });
  const merged = (first: Item, second: Item) => mergeSnapshots([{ sourceKey: 'a', fetchedAt: 0, items: [first] }, { sourceKey: 'b', fetchedAt: 0, items: [second] }], null).items[0];
  for (const [name, x, y, want] of rows) {
    // the item itself was updated at the same moment in both copies: only the read time can tell them apart
    it(`${name} — both orders`, () => {
      expect(ties(merged(copy(x), copy(y)))).toEqual(want);
      expect(ties(merged(copy(y), copy(x)))).toEqual(want);
    });
    // … and the copy the other fields come from (the later `updatedAt`) does not decide either
    it(`${name} — the copy with the older fields was updated later`, () => {
      const late = { updatedAt: '2026-11-02T00:00:00Z', title: 'late' };
      for (const got of [merged(copy(x, late), copy(y)), merged(copy(y), copy(x, late))]) {
        expect(ties(got)).toEqual(want);
        expect(got.title).toBe('late');
      }
    });
  }

  // the issues GitHub lists as linked to a pull request travel with the same read, by the same rules
  const linkRows: [string, Pick<Item, 'closingIssues' | 'viewerAt'>, Pick<Item, 'closingIssues' | 'viewerAt'>, string[] | null | undefined][] = [
    ['only one copy was asked', {}, { closingIssues: ['o/r#7'], viewerAt: 5 }, ['o/r#7']],
    ['neither was asked', {}, {}, undefined],
    ['read at different times: the later list, also when it is empty', { closingIssues: ['o/r#7'], viewerAt: 100 }, { closingIssues: [], viewerAt: 200 }, []],
    ['read at different times: the later one not read whole', { closingIssues: ['o/r#7'], viewerAt: 100 }, { closingIssues: null, viewerAt: 200 }, null],
    ['same time, different lists: every issue either names', { closingIssues: ['o/r#9'], viewerAt: 100 }, { closingIssues: ['o/r#7'], viewerAt: 100 }, ['o/r#7', 'o/r#9']],
    ['same time, one not read whole', { closingIssues: null, viewerAt: 100 }, { closingIssues: ['o/r#7'], viewerAt: 100 }, null],
  ];
  for (const [name, x, y, want] of linkRows) {
    it(`linked issues: ${name} — both orders`, () => {
      const full = (t: Pick<Item, 'closingIssues' | 'viewerAt'>) => copy(t.viewerAt === undefined ? {} : { viewerSubscribed: false, reviewRequested: asked([]), viewerAt: t.viewerAt }, t.viewerAt === undefined ? {} : { closingIssues: t.closingIssues });
      expect(merged(full(x), full(y)).closingIssues).toEqual(want);
      expect(merged(full(y), full(x)).closingIssues).toEqual(want);
    });
  }

  it('three sources read at the same moment: whichever order, one answer', () => {
    const a = copy({ viewerSubscribed: false, reviewRequested: asked(['c']), viewerAt: 9 });
    const b = copy({ viewerSubscribed: true, reviewRequested: asked(['a']), viewerAt: 9 });
    const c = copy({ viewerSubscribed: false, reviewRequested: asked([], true), viewerAt: 9 });
    const old = copy({ viewerSubscribed: null, reviewRequested: null, viewerAt: 3 });
    const all = [a, b, c, old];
    const orders = [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]];
    for (const o of orders) {
      const got = mergeSnapshots(o.map((i, n) => ({ sourceKey: `s${n}`, fetchedAt: 0, items: [all[i]] })), null).items[0];
      expect(ties(got), o.join('')).toEqual({ viewerSubscribed: true, reviewRequested: asked(['a', 'c'], true), viewerAt: 9 });
    }
  });
});

// =====================================================================================
// 3. the three readers
// =====================================================================================

let fake: FakeGitHub;
let dir: string;
let caches: Cache[] = [];
let controllers: Controller[] = [];
let backends: HarnessBackend[] = [];

afterEach(async () => {
  for (const c of controllers) c.stopTimer();
  await Promise.all(controllers.map((c) => c.prefetchSettled()));
  await Promise.all(backends.map((b) => b.close()));
  for (const c of caches) c.close();
  caches = [];
  controllers = [];
  backends = [];
  await fake?.close();
});

/** Change one item on GitHub (the fake): on the board's copy and the repository list's alike, bumping `updatedAt` like GitHub does. */
function change(number: number, at: number, patch: { label?: boolean; assignees?: string[] }) {
  const when = new Date(at).toISOString();
  let found = false;
  for (const pg of fake.state.projects.get(BOARD) ?? []) {
    for (const n of pg.items.nodes) {
      const c = n.content;
      if (!c || c.number !== number || c.repository?.nameWithOwner !== REPO) continue;
      found = true;
      if (patch.label !== undefined) {
        const rest = c.labels.nodes.filter((l: { name: string }) => l.name !== LABEL);
        c.labels = { nodes: patch.label ? [...rest, { name: LABEL, color: 'ededed' }] : rest };
      }
      if (patch.assignees) c.assignees = { nodes: patch.assignees.map((login) => ({ login })) };
      c.updatedAt = when;
    }
  }
  for (const i of fake.state.repos.get('gigleai/cavil-loop') ?? []) {
    if (i.number !== number) continue;
    found = true;
    if (patch.label !== undefined) {
      const rest = i.labels.filter((l: { name: string }) => l.name !== LABEL);
      i.labels = patch.label ? [...rest, { name: LABEL, color: 'ededed' }] : rest;
    }
    if (patch.assignees) i.assignees = patch.assignees.map((login) => ({ login }));
    i.updated_at = when;
  }
  if (!found) throw new Error(`fixture has no #${number}`);
}

describe('the three readers bring the same answer (the board, the repository list, the one-item re-read)', () => {
  beforeEach(async () => {
    fake = await startFakeGitHub();
  });
  const client = () => new GitHubClient({ api: fake.api, web: fake.web }, FAKE_TOKEN);
  const boardSrc = () => parseSource(PROJECT_URL) as Extract<SourceConfig, { kind: 'project' }>;
  const repoSrc = () => parseSource(REPO) as Extract<SourceConfig, { kind: 'repo' }>;
  const of = (snap: SourceSnapshot, n: number) => snap.items.find((i) => i.key === key(n))!;

  it('subscription and review requests: one GitHub answer, the same fields through each reader, stamped with that read\'s time', async () => {
    fake.state.w.subscriptions.set(key(ISSUE_A), 'SUBSCRIBED');
    fake.state.w.subscriptions.set(key(ISSUE_B), 'IGNORED');
    fake.state.w.subscriptions.set(key(ISSUE_C), null);
    fake.state.w.subscriptions.set(key(PR_A), 'SUBSCRIBED');
    fake.state.w.reviewRequests.set(key(PR_A), { users: ['Zed', ME], teams: 1 });
    // more requests than the read returns: not read whole
    fake.state.w.reviewRequests.set(key(PR_B), { users: [ME], total: 30 });
    // linked on GitHub only (nothing in the description): one issue for PR_A; more than a read returns for PR_B
    fake.state.w.closingIssues.set(key(PR_A), [{ repo: REPO, number: ISSUE_E }]);
    fake.state.w.closingIssues.set(key(PR_B), Array.from({ length: 25 }, (_, i) => ({ repo: 'Other/Repo', number: 1000 + i })));
    const linkedOnBoard = (n: number) => rawBoard.filter((x: any) => x.content.__typename === 'Issue' && (x.content.closedByPullRequestsReferences?.nodes ?? []).some((r: any) => r.number === n)).map((x: any) => key(x.content.number));
    const want: [number, boolean | null, ReviewRequested | null, string[] | null][] = [
      [ISSUE_A, true, { users: [], others: false }, []],
      [ISSUE_B, false, { users: [], others: false }, []],
      [ISSUE_C, null, { users: [], others: false }, []],
      [ISSUE_D, false, { users: [], others: false }, []],
      [PR_A, true, { users: [ME, 'zed'], others: true }, [...new Set([key(ISSUE_E), ...linkedOnBoard(PR_A)])].sort()],
      [PR_B, false, null, null],
    ];
    const board = await fetchProject(client(), boardSrc(), 111);
    const repo = await fetchRepo(client(), repoSrc(), 222);
    for (const [n, sub, asked, links] of want) {
      const fresh = await fetchItem(client(), REPO, n, 333);
      const again = applyFreshItem([repo], fresh)[0];
      const got = { board: of(board, n), repo: of(repo, n), refresh: of(again, n) };
      for (const [reader, it_] of Object.entries(got)) {
        expect(it_.viewerSubscribed, `#${n} ${reader}`).toBe(sub);
        expect(it_.reviewRequested, `#${n} ${reader}`).toEqual(asked);
        expect(it_.closingIssues, `#${n} ${reader}`).toEqual(links);
      }
      expect([got.board.viewerAt, got.repo.viewerAt, got.refresh.viewerAt], `#${n}`).toEqual([111, 222, 333]);
    }
  });

  it('repository: an open item whose answer lacks the subscription fails the read — never stored as "not subscribed"', async () => {
    const origin = fake.state.answerOverride;
    // GitHub answers the batch without the field (what a schema change would look like)
    fake.state.answerOverride = (e: LoggedRequest) =>
      e.operation === 'CavilIssueRelationsBatch'
        ? { status: 200, body: { data: { nodes: (e.variables!.ids as string[]).map((id) => ({ __typename: id.startsWith('PR_') ? 'PullRequest' : 'Issue', id })) } } }
        : (origin?.(e) ?? null);
    await expect(fetchRepo(client(), repoSrc(), 1)).rejects.toThrow(/订阅状态没有读到|关系没有读/);
  });
});

// =====================================================================================
// 4. the tracker: every "what happened to a source" row
// =====================================================================================

describe('the tracker: only real changes notify, whichever source they come through', () => {
  const nobody: ReviewRequested = { users: [], others: false };
  const snap = (sourceKey: string, ...items: Item[]): SourceSnapshot => ({ sourceKey, fetchedAt: 0, items });
  const at = (t: number) => ({ viewerSubscribed: false, reviewRequested: nobody, viewerAt: t });
  /** issue #1 */
  const issue = (t: number, extra: Partial<Item> = {}) => item('o/r', 1, { ...at(t), ...extra });
  /** PR #2, pending, nobody answers for it, names issue #1 */
  const pr = (t: number, extra: Partial<Item> = {}) => item('o/r', 2, { kind: 'pr', labels: [{ name: LABEL, color: '' }], refIssues: ['o/r#1'], ...at(t), ...extra });
  const pend = (n: number, t: number, extra: Partial<Item> = {}) => item('o/r', n, { labels: [{ name: LABEL, color: '' }], ...at(t), ...extra });
  const mine = () => new PendingTracker(LABEL, { scope: 'mine', viewer: ME });
  const nums = (items: Item[]) => items.map((i) => i.number).sort();

  it('scope "all" ignores who an item concerns: the same data, every pending item reminds', () => {
    const t = new PendingTracker(LABEL, { scope: 'all', viewer: ME });
    t.observe([snap('a')], ['a']);
    expect(nums(t.observe([snap('a', pend(3, 1, { assignees: [OTHER] }), pend(4, 1))], ['a']).appeared)).toEqual([3, 4]);
  });

  it('scope "mine" without a known login reminds of everything (it cannot tell — never fewer)', () => {
    const t = new PendingTracker(LABEL, { scope: 'mine', viewer: null });
    t.observe([snap('a')], ['a']);
    expect(nums(t.observe([snap('a', pend(3, 1, { assignees: [OTHER] }))], ['a']).appeared)).toEqual([3]);
  });

  it('a normal update: assigned to the account → one notification; to somebody else → out, silently; a label on somebody else\'s item → nothing', () => {
    const t = mine();
    t.observe([snap('a', pend(3, 1, { assignees: [OTHER] }))], ['a']);
    expect(t.count()).toBe(0);
    expect(nums(t.observe([snap('a', pend(3, 2, { assignees: [ME] }), pend(4, 2, { assignees: [OTHER] }))], ['a']).appeared)).toEqual([3]);
    expect(t.has('o/r#3')).toBe(true);
    expect(t.has('o/r#4')).toBe(false);
    expect(t.carriers('o/r#4')).toEqual([]);
    // still subscribed, handed to somebody else
    expect(t.observe([snap('a', pend(3, 3, { assignees: [OTHER], viewerSubscribed: true }), pend(4, 3, { assignees: [OTHER] }))], ['a']).appeared).toEqual([]);
    expect(t.has('o/r#3')).toBe(false);
    expect(t.count()).toBe(0);
  });

  it('across sources: the PR\'s source was not read this round, its issue\'s source brings the new assignee → the PR is a notification; back → out, silently', () => {
    const t = mine();
    t.observe([snap('a', pr(1)), snap('b', issue(1, { assignees: [OTHER] }))], ['a', 'b']);
    expect(t.count()).toBe(0);
    // only b is fresh: a keeps what it had (confirmed unchanged, or its read failed)
    expect(nums(t.observe([snap('b', issue(2, { assignees: [ME] }))], ['a', 'b']).appeared)).toEqual([2]);
    expect(t.carriers('o/r#2')).toEqual(['a']);
    expect(t.observe([snap('b', issue(3, { assignees: [OTHER] }))], ['a', 'b']).appeared).toEqual([]);
    expect(t.has('o/r#2')).toBe(false);
  });

  it('the issue lists the PR as linked (the board\'s own link, no keyword in the description): the same', () => {
    const t = mine();
    const linking = (tt: number, assignees: string[]) => issue(tt, { assignees, linkedPrs: [{ key: 'o/r#2', repo: 'o/r', number: 2, url: '', state: 'open' }] });
    t.observe([snap('a', pr(1, { refIssues: [] })), snap('b', linking(1, [OTHER]))], ['a', 'b']);
    expect(t.count()).toBe(0);
    expect(nums(t.observe([snap('b', linking(2, [ME]))], ['a', 'b']).appeared)).toEqual([2]);
  });

  it('the PR is linked on GitHub only (its own list of linked issues, nothing in the description, the issue does not list it): the same; a list not read whole reminds', () => {
    const t = mine();
    t.observe([snap('a', pr(1, { refIssues: [], closingIssues: ['o/r#1'] })), snap('b', issue(1, { assignees: [OTHER], linkedPrs: null }))], ['a', 'b']);
    expect(t.count()).toBe(0);
    expect(nums(t.observe([snap('b', issue(2, { assignees: [ME], linkedPrs: null }))], ['a', 'b']).appeared)).toEqual([2]);
    expect(t.observe([snap('b', issue(3, { assignees: [OTHER], linkedPrs: null }))], ['a', 'b']).appeared).toEqual([]);
    expect(t.has('o/r#2')).toBe(false);
    // the next read of the PR cannot list its issues whole: it may be the account's
    expect(nums(t.observe([snap('a', pr(4, { refIssues: [], closingIssues: null }))], ['a', 'b']).appeared)).toEqual([2]);
  });

  it('a first read is history for what it carries: an item already assigned to the account is silent', () => {
    const t = mine();
    t.observe([snap('a')], ['a']);
    expect(t.observe([snap('b', pend(3, 1, { assignees: [ME] }))], ['a', 'b']).appeared).toEqual([]);
    expect(t.has('o/r#3')).toBe(true);
  });

  it('a first read is history for what it tells about another source\'s item: a PR long pending, its issue arriving with a new source, is silent — and reminds from then on', () => {
    const t = mine();
    t.observe([snap('a', pr(1))], ['a']);
    expect(t.count()).toBe(0); // no issue found: the PR's own subscription, and the account does not subscribe
    // b is read for the first time and brings the issue, assigned to the account
    expect(t.observe([snap('b', issue(2, { assignees: [ME] }))], ['a', 'b']).appeared).toEqual([]);
    expect(t.has('o/r#2')).toBe(true);
    // afterwards b is a source like any other
    expect(t.observe([snap('b', issue(3, { assignees: [OTHER] }))], ['a', 'b']).appeared).toEqual([]);
    expect(t.has('o/r#2')).toBe(false);
    expect(nums(t.observe([snap('b', issue(4, { assignees: [ME] }))], ['a', 'b']).appeared)).toEqual([2]);
  });

  it('the round that adds a source: a real change in an older source still notifies; one that needs the new source\'s data does not', () => {
    const t = mine();
    t.observe([snap('a', pr(1, { labels: [] }))], ['a']);
    // in one round: a brings a newly assigned item #3 and the PR newly labelled; b is new and holds the PR's issue
    const ch = t.observe([snap('a', pr(2), pend(3, 2, { assignees: [ME] })), snap('b', issue(2, { assignees: [ME] }))], ['a', 'b']);
    expect(nums(ch.appeared)).toEqual([3]);
    expect(t.has('o/r#2')).toBe(true);
  });

  it('the round that adds a source: an item that concerned the account without it still notifies when it becomes pending', () => {
    const t = mine();
    t.observe([snap('a', pr(1, { labels: [], viewerSubscribed: true }))], ['a']);
    // nobody answers for the PR and without b there is no issue: the account subscribes → it reminds either way
    const ch = t.observe([snap('a', pr(2, { viewerSubscribed: true })), snap('b', issue(2, { viewerSubscribed: true }))], ['a', 'b']);
    expect(nums(ch.appeared)).toEqual([2]);
  });

  it('a source removed: what turns "mine" because the issue is gone is silent, now and in the next round', () => {
    const t = mine();
    t.observe([snap('a', pr(1, { viewerSubscribed: null })), snap('b', issue(1, { assignees: [OTHER] }))], ['a', 'b']);
    expect(t.count()).toBe(0);
    t.prune(['a']);
    // the issue is gone with b: the PR's own subscription — unknown, so it reminds; not a notification
    expect(t.has('o/r#2')).toBe(true);
    expect(t.observe([snap('a', pr(2, { viewerSubscribed: null }))], ['a']).appeared).toEqual([]);
  });

  it('a source removed in the same call as a read (the controller prunes inside observe): still silent', () => {
    const t = mine();
    t.observe([snap('a', pr(1, { viewerSubscribed: null })), snap('b', issue(1, { assignees: [OTHER] }))], ['a', 'b']);
    expect(t.observe([snap('a', pr(2, { viewerSubscribed: null }))], ['a']).appeared).toEqual([]);
    expect(t.has('o/r#2')).toBe(true);
  });

  it('one item in two sources: one entry, one notification; the later read of its subscription is the one used', () => {
    const t = mine();
    t.observe([snap('a', pend(3, 1)), snap('b', pend(3, 1))], ['a', 'b']);
    expect(t.count()).toBe(0);
    // only b is read again: the account subscribed meanwhile (the item's own `updatedAt` did not move)
    const ch = t.observe([snap('b', pend(3, 2, { viewerSubscribed: true }))], ['a', 'b']);
    expect(nums(ch.appeared)).toEqual([3]);
    expect(t.count()).toBe(1);
    expect(t.carriers('o/r#3').sort()).toEqual(['a', 'b']);
    // … and unsubscribed again, read through a this time
    expect(t.observe([snap('a', pend(3, 3))], ['a', 'b']).appeared).toEqual([]);
    expect(t.count()).toBe(0);
  });

  it('a source whose read failed keeps its data in the judgement and is not a first read', () => {
    const t = mine();
    t.observe([snap('a', pr(1)), snap('b', issue(1, { assignees: [OTHER] }))], ['a', 'b']);
    // round 2: a failed (not fresh), b unchanged (not fresh) — nothing fed, nothing changes
    expect(t.observe([], ['a', 'b']).appeared).toEqual([]);
    // round 3: a still failing, b brings the assignee
    expect(nums(t.observe([snap('b', issue(3, { assignees: [ME] }))], ['a', 'b']).appeared)).toEqual([2]);
  });

  it('another scope, another login, another label: recounted silently; the next round notifies only what is new after it', () => {
    const t = new PendingTracker(LABEL, { scope: 'all', viewer: ME });
    t.observe([snap('a', pend(3, 1, { assignees: [OTHER] }), pend(4, 1, { assignees: [ME] }))], ['a']);
    expect(t.count()).toBe(2);
    t.setAudience({ scope: 'mine', viewer: ME });
    expect(nums(t.pending())).toEqual([4]);
    t.setAudience({ scope: 'mine', viewer: OTHER });
    expect(nums(t.pending())).toEqual([3]);
    t.setAudience({ scope: 'all', viewer: OTHER });
    expect(t.count()).toBe(2);
    t.setAudience({ scope: 'mine', viewer: ME });
    // nothing of that was "new work": the same data read again notifies nothing
    expect(t.observe([snap('a', pend(3, 1, { assignees: [OTHER] }), pend(4, 1, { assignees: [ME] }))], ['a']).appeared).toEqual([]);
    const held = new Map([['a', snap('a', pend(3, 1, { assignees: [OTHER] }), pend(4, 1, { assignees: [ME] }))]]);
    t.relabel('other', held);
    expect(t.count()).toBe(0);
    t.relabel(LABEL, held);
    expect(nums(t.pending())).toEqual([4]);
  });
});

// =====================================================================================
// 5. the app: real sync rounds
// =====================================================================================

interface Harness {
  c: Controller;
  backend: HarnessBackend;
  alerts: Alert[];
  badges: number[];
  clock: { t: number };
  items(): string[];
  badge(): number | undefined;
}

async function signedIn(opts: { sources?: string[]; seed?: Record<string, unknown>; clock?: { t: number } } = {}): Promise<Harness> {
  await Promise.all(controllers.map((c) => c.settled()));
  const cache = new Cache(join(dir, 'cache.sqlite'));
  caches.push(cache);
  if (cache.getSetting('trustedCredentials', null) === null) cache.setSetting('trustedCredentials', trustedList(FAKE_TOKEN));
  for (const [k, v] of Object.entries(opts.seed ?? {})) cache.setSetting(k, v);
  const credentials = new FileStore(join(dir, 'cred'));
  await credentials.set(FAKE_TOKEN);
  const clock = opts.clock ?? { t: FIXTURE_NOW };
  const alerts: Alert[] = [];
  const badges: number[] = [];
  const endpoints = { api: fake.api, web: fake.web };
  const backend = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints, credentials, now: () => clock.t, sleep: async () => {}, opened: [] });
  backends.push(backend);
  const desktop: Desktop = {
    notify: async (a) => {
      alerts.push(a);
      return { ok: true };
    },
    setBadge: async (n) => void badges.push(n),
    clearNotifications: async () => {},
    loginItem: async () => false,
    setLoginItem: async () => {},
    nextEvent: () => new Promise<DesktopEvent>(() => {}),
    updateStatus: async () => null,
    checkUpdate: async () => {},
    setAutoUpdate: async () => {},
    setUpdateChannel: async () => {},
    dismissUpdate: async () => {},
    dismissInstalledUpdate: async () => {},
    restartToUpdate: async () => {},
    closeWindow: async () => {},
    windowFrame: async () => ({ overlay: false, fullscreen: false }),
    startDrag: async () => {},
    toggleZoom: async () => {},
  };
  const c = await Controller.create({ backend, endpoints, now: () => clock.t, defaultClientId: '', desktop });
  controllers.push(c);
  for (const s of opts.sources ?? []) c.addSource(s);
  return { c, backend, alerts, badges, clock, items: () => alerts.filter((a) => a.kind === 'item').map((a) => (a as Extract<Alert, { kind: 'item' }>).key), badge: () => badges[badges.length - 1] };
}

async function started(opts: Parameters<typeof signedIn>[0]): Promise<Harness> {
  const h = await signedIn(opts);
  await h.c.start();
  await h.c.desktopSettled();
  expect(h.c.getState().sync.sources.every((s) => s.ok)).toBe(true);
  return h;
}

/** Next round, one minute later; then whatever it asked of the shell has been answered. */
async function tick(h: Harness) {
  h.clock.t += 60_000;
  await h.c.syncNow();
  await h.c.desktopSettled();
  await h.c.desktopSettled();
  const st = h.c.getState();
  expect(st.unreadCount).toBeLessThanOrEqual(st.pendingCount);
  if (h.badges.length) expect(h.badge()).toBe(st.unreadCount);
}

const boardItem = (h: Harness, n: number) => h.c.getBoardData().items.find((i) => i.key === key(n));
const labelled = (h: Harness, n: number) => Boolean(boardItem(h, n)?.labels.some((l) => l.name === LABEL));
const ops = (log: LoggedRequest[], name: string) => log.filter((e) => e.operation === name);
const MINE = { notifyScope: 'mine' };

describe('only a repository source: the reminders follow what the list itself does not carry', () => {
  beforeEach(async () => {
    fake = await startFakeGitHub();
    dir = tempDir();
    for (const n of [...ISSUES, ...PRS]) change(n, FIXTURE_NOW - 3_600_000, { assignees: [] });
  });

  it('every open issue / PR is read by id for it; somebody else\'s item is silent, a review asked of the account notifies, nobody\'s item goes by the subscription', async () => {
    const h = await started({ sources: [REPO], seed: MINE });
    // "did happen": the batch asked for the open pull requests too, and the board's copies carry the answer
    const asked = ops(fake.log, 'CavilIssueRelationsBatch').flatMap((e) => e.variables!.ids as string[]);
    for (const n of [ISSUE_A, PR_A]) expect(asked).toContain(boardItem(h, n)!.nodeId);
    expect(boardItem(h, PR_A)).toMatchObject({ viewerSubscribed: false, reviewRequested: { users: [], others: false } });
    expect(boardItem(h, PR_A)!.viewerAt).toBeGreaterThan(0);
    const base = h.c.getState().pendingCount;

    // somebody else's
    change(ISSUE_A, h.clock.t, { label: true, assignees: [OTHER] });
    await tick(h);
    expect(labelled(h, ISSUE_A)).toBe(true);
    expect(h.alerts).toEqual([]);
    expect(h.badge()).toBe(0);
    expect(h.c.getState().pendingCount).toBe(base);

    // a review asked of the account (GitHub writes the login in its own case)
    fake.state.w.reviewRequests.set(key(PR_A), { users: ['User-1'] });
    change(PR_A, h.clock.t, { label: true });
    await tick(h);
    expect(h.items()).toEqual([key(PR_A)]);
    expect(h.badge()).toBe(1);

    // nobody's: not subscribed → silent; subscription unknown → notified; subscribed → notified
    change(ISSUE_B, h.clock.t, { label: true });
    fake.state.w.subscriptions.set(key(ISSUE_C), null);
    change(ISSUE_C, h.clock.t, { label: true });
    fake.state.w.subscriptions.set(key(ISSUE_D), 'SUBSCRIBED');
    change(ISSUE_D, h.clock.t, { label: true });
    await tick(h);
    expect(labelled(h, ISSUE_B)).toBe(true);
    expect(h.items().sort()).toEqual([key(PR_A), key(ISSUE_C), key(ISSUE_D)].sort());
    expect(h.badge()).toBe(3);
    expect(h.c.getState().pendingCount).toBe(base + 3);

    // still subscribed, handed to somebody else: out, silently, and no longer unread
    change(ISSUE_D, h.clock.t, { assignees: [OTHER] });
    await tick(h);
    expect(boardItem(h, ISSUE_D)!.assignees).toEqual([OTHER]);
    expect(h.items()).toHaveLength(3);
    expect(h.badge()).toBe(2);
    expect(h.c.getState().pendingCount).toBe(base + 2);

    // an item long labelled, assigned to the account only now: a new one
    change(ISSUE_A, h.clock.t, { assignees: [ME] });
    await tick(h);
    expect(h.items().slice(3)).toEqual([key(ISSUE_A)]);
    expect(h.badge()).toBe(3);
  });

  it('a PR linked to its issue only in GitHub\'s sidebar (no number in the description): the list read brings the link — the account\'s issue notifies the PR, somebody else\'s does not', async () => {
    // GitHub links PR_A → ISSUE_A and PR_B → ISSUE_B; neither description names an issue, nobody answers for the PRs
    for (const i of fake.state.repos.get('gigleai/cavil-loop')!) if (i.number === PR_A || i.number === PR_B) i.body = 'no issue number here';
    fake.state.projects.clear();
    fake.state.w.closingIssues.set(key(PR_A), [{ repo: REPO, number: ISSUE_A }]);
    fake.state.w.closingIssues.set(key(PR_B), [{ repo: REPO, number: ISSUE_B }]);
    change(ISSUE_A, FIXTURE_NOW - 3_600_000, { assignees: [ME] });
    change(ISSUE_B, FIXTURE_NOW - 3_600_000, { assignees: [OTHER] });
    const h = await started({ sources: [REPO], seed: MINE });
    // "did happen": the repository read itself brought the link — the description names nothing, the issue lists nothing
    expect(boardItem(h, PR_A)).toMatchObject({ refIssues: [], closingIssues: [key(ISSUE_A)], viewerSubscribed: false, assignees: [] });
    expect(boardItem(h, PR_B)).toMatchObject({ refIssues: [], closingIssues: [key(ISSUE_B)], viewerSubscribed: false, assignees: [] });
    expect(boardItem(h, ISSUE_A)!.linkedPrs).toBeNull();
    const base = h.c.getState().pendingCount;
    change(PR_A, h.clock.t, { label: true });
    change(PR_B, h.clock.t, { label: true });
    await tick(h);
    expect(labelled(h, PR_B)).toBe(true);
    expect(h.items()).toEqual([key(PR_A)]);
    expect(h.badge()).toBe(1);
    expect(h.c.getState().pendingCount).toBe(base + 1);
    // the other issue is handed to the account: its PR follows
    change(ISSUE_B, h.clock.t, { assignees: [ME] });
    await tick(h);
    expect(h.items()).toEqual([key(PR_A), key(PR_B)]);
  });

  it('the read by id fails: the source fails this round, nothing is notified, the data stays; the next good round notifies', async () => {
    const h = await started({ sources: [REPO], seed: MINE });
    const before = boardItem(h, ISSUE_A)!;
    change(ISSUE_A, h.clock.t, { label: true, assignees: [ME] });
    fake.state.w.failRelationsBatch = true;
    const n = fake.log.length;
    await tick(h);
    expect(ops(fake.log.slice(n), 'CavilIssueRelationsBatch').some((e) => e.status === 502)).toBe(true);
    expect(h.c.getState().sync.sources.find((s) => s.sourceKey === REPO_KEY)!.ok).toBe(false);
    expect(boardItem(h, ISSUE_A)).toEqual(before);
    expect(h.alerts).toEqual([]);
    fake.state.w.failRelationsBatch = false;
    await tick(h);
    expect(h.items()).toEqual([key(ISSUE_A)]);
  });

  it('the default scope: the same rounds notify every item, whoever it is assigned to (as before GitHub#373)', async () => {
    const h = await started({ sources: [REPO] });
    expect(h.c.getState().notifyScope).toBe('all');
    change(ISSUE_A, h.clock.t, { label: true, assignees: [OTHER] });
    change(ISSUE_B, h.clock.t, { label: true });
    await tick(h);
    expect(h.items().sort()).toEqual([key(ISSUE_A), key(ISSUE_B)].sort());
  });
});

describe('a PR on the board, its issue only in the repository list', () => {
  /** the PR is only on the board, the issue it closes only in the repository list */
  const PR = PR_A;
  const ISSUE = ISSUE_A;
  beforeEach(async () => {
    const pages = loadCavilProjectPages().map((pg) => ({ ...pg, items: { ...pg.items, nodes: pg.items.nodes.filter((n: any) => n.content?.number !== ISSUE) } }));
    fake = await startFakeGitHub({ projects: new Map([[BOARD, pages]]), repos: new Map([['gigleai/cavil-loop', loadCavilRepoIssues().filter((i: any) => i.number !== PR)]]) });
    dir = tempDir();
    for (const pg of fake.state.projects.get(BOARD)!) {
      for (const n of pg.items.nodes) {
        if (n.content?.number === PR) n.content.body = `Closes #${ISSUE}`;
        // the recording links the PR to an issue on the board: here the one in the repository list is its only issue
        const linked = n.content?.closedByPullRequestsReferences;
        if (linked) linked.nodes = linked.nodes.filter((x: any) => x.number !== PR);
      }
    }
    // nobody answers for the PR, the account does not subscribe to it; it has waited for a human for a while
    change(PR, FIXTURE_NOW - 3_600_000, { label: true, assignees: [] });
    change(ISSUE, FIXTURE_NOW - 3_600_000, { assignees: [OTHER] });
  });
  /** the board was asked "changed?" and not read; the repository list was read */
  const onlyRepoRead = (since: number) => {
    const log = fake.log.slice(since);
    expect(ops(log, 'CavilProjectItems')).toEqual([]);
    expect(log.some((e) => e.path.includes('/projectsV2/') || e.operation === 'CavilProjectCounts')).toBe(true);
    expect(ops(log, 'CavilIssueRelationsBatch').map((e) => e.status)).toEqual([200]);
  };

  it('the issue is reassigned while the board is confirmed unchanged: the PR notifies; reassigned away: out, silently, no longer unread', async () => {
    const h = await started({ sources: [PROJECT_URL, REPO], seed: MINE });
    expect(boardItem(h, PR)!.sources).toEqual([PROJECT_KEY]);
    expect(boardItem(h, ISSUE)!.sources).toEqual([REPO_KEY]);
    const base = h.c.getState().pendingCount;
    expect(h.alerts).toEqual([]);

    let n = fake.log.length;
    change(ISSUE, h.clock.t, { assignees: [ME] });
    await tick(h);
    onlyRepoRead(n);
    expect(boardItem(h, ISSUE)!.assignees).toEqual([ME]);
    expect(h.items()).toEqual([key(PR)]);
    expect(h.badge()).toBe(1);
    expect(h.c.getState().pendingCount).toBe(base + 1);

    n = fake.log.length;
    change(ISSUE, h.clock.t, { assignees: [OTHER] });
    await tick(h);
    onlyRepoRead(n);
    expect(boardItem(h, ISSUE)!.assignees).toEqual([OTHER]);
    expect(h.items()).toEqual([key(PR)]);
    expect(h.badge()).toBe(0);
    expect(h.c.getState().pendingCount).toBe(base);
  });

  it('the board\'s read fails that round: the PR it holds from before still notifies', async () => {
    const h = await started({ sources: [PROJECT_URL, REPO], seed: MINE });
    // something on the board changed, so it is read — and that read fails
    change(PR_B, h.clock.t, { assignees: [] });
    fake.state.failProjectPage.set(BOARD, 0);
    change(ISSUE, h.clock.t, { assignees: [ME] });
    await tick(h);
    const st = h.c.getState().sync.sources;
    expect(st.find((s) => s.sourceKey === PROJECT_KEY)!.ok).toBe(false);
    expect(st.find((s) => s.sourceKey === REPO_KEY)!.ok).toBe(true);
    expect(h.items()).toEqual([key(PR)]);
  });

  it('the repository is added later with the issue already the account\'s: silent (first seen is history); a real reassignment afterwards notifies', async () => {
    change(ISSUE, FIXTURE_NOW - 3_600_000, { assignees: [ME] });
    const h = await started({ sources: [PROJECT_URL], seed: MINE });
    const base = h.c.getState().pendingCount;
    h.c.addSource(REPO);
    await h.c.syncNow();
    await h.c.desktopSettled();
    expect(boardItem(h, ISSUE)!.assignees).toEqual([ME]);
    expect(h.alerts).toEqual([]);
    expect(h.badge()).toBe(0);
    // it reminds from now on (it counts), it just was not news
    expect(h.c.getState().pendingCount).toBe(base + 1);
    change(ISSUE, h.clock.t, { assignees: [OTHER] });
    await tick(h);
    expect(h.c.getState().pendingCount).toBe(base);
    change(ISSUE, h.clock.t, { assignees: [ME] });
    await tick(h);
    expect(h.items()).toEqual([key(PR)]);
  });

  it('the repository is removed: the PR falls back to its own subscription (unknown → reminds) without a notification', async () => {
    fake.state.w.subscriptions.set(key(PR), null);
    const h = await started({ sources: [PROJECT_URL, REPO], seed: MINE });
    const base = h.c.getState().pendingCount;
    expect(boardItem(h, PR)!.viewerSubscribed).toBeNull();
    h.c.removeSource(REPO_KEY);
    await h.c.desktopSettled();
    expect(h.c.getState().pendingCount).toBe(base + 1);
    await tick(h);
    expect(h.alerts).toEqual([]);
    expect(h.badge()).toBe(0);
  });
});

describe('the setting', () => {
  beforeEach(async () => {
    fake = await startFakeGitHub();
    dir = tempDir();
    for (const n of [...ISSUES, ...PRS]) change(n, FIXTURE_NOW - 3_600_000, { assignees: [] });
  });

  it('anything saved that is not "mine" reads as "all"', () => {
    for (const v of [undefined, null, '', 'all', 'MINE', 'me', true, 1, {}, ['mine']]) expect(normalizeNotifyScope(v), String(v)).toBe('all');
    expect(normalizeNotifyScope('mine')).toBe('mine');
  });

  it('switching is silent both ways and never adds to the badge; what no longer reminds stops counting; it survives a restart', async () => {
    const h = await started({ sources: [REPO] });
    change(ISSUE_A, h.clock.t, { label: true, assignees: [OTHER] });
    change(ISSUE_B, h.clock.t, { label: true, assignees: [ME] });
    await tick(h);
    expect(h.items().sort()).toEqual([key(ISSUE_A), key(ISSUE_B)].sort());
    expect(h.badge()).toBe(2);
    const all = h.c.getState().pendingCount;

    h.c.setNotifyScope('mine');
    h.c.setNotifyScope('everything' as any); // not one of the two words: ignored
    await h.c.desktopSettled();
    expect(h.c.getState().notifyScope).toBe('mine');
    expect(h.items()).toHaveLength(2);
    expect(h.badge()).toBe(1);
    expect(h.c.getState().pendingCount).toBeLessThan(all);
    const mine = h.c.getState().pendingCount;

    h.c.setNotifyScope('all');
    await h.c.desktopSettled();
    expect(h.items()).toHaveLength(2);
    // somebody else's item reminds again, but it is not unread again: a setting brings no new work
    expect(h.badge()).toBe(1);
    expect(h.c.getState().pendingCount).toBe(all);
    await tick(h);
    expect(h.items()).toHaveLength(2);

    h.c.setNotifyScope('mine');
    await h.c.settled();
    const again = await started({ clock: h.clock });
    expect(again.c.getState().notifyScope).toBe('mine');
    expect(again.c.getState().pendingCount).toBe(mine);
    expect(again.alerts).toEqual([]);
    // and it is the one used: somebody else's new item is silent, the account's notifies
    change(ISSUE_C, again.clock.t, { label: true, assignees: [OTHER] });
    change(ISSUE_D, again.clock.t, { label: true, assignees: [ME] });
    await tick(again);
    expect(again.items()).toEqual([key(ISSUE_D)]);
  });

  it('the scope changed while a notification waits for the system: the one queued behind it is not sent (a settings change is silent)', async () => {
    const h = await started({ sources: [REPO] });
    // the first notification is held by "the system" until released
    const calls: Alert[] = [];
    let release: (d: { ok: boolean }) => void = () => {};
    (h.c as any).deps.desktop.notify = (a: Alert) => {
      calls.push(a);
      return calls.length === 1 ? new Promise((r) => (release = r)) : Promise.resolve({ ok: true });
    };
    change(ISSUE_A, h.clock.t, { label: true, assignees: [OTHER] });
    change(ISSUE_B, h.clock.t, { label: true, assignees: [OTHER] });
    h.clock.t += 60_000;
    await h.c.syncNow();
    await new Promise((r) => setTimeout(r, 20));
    // "did happen": both became pending, one notification is with the system, the other queued
    expect(labelled(h, ISSUE_A) && labelled(h, ISSUE_B)).toBe(true);
    expect(calls).toHaveLength(1);
    h.c.setNotifyScope('mine');
    release({ ok: true });
    await new Promise((r) => setTimeout(r, 20));
    await h.c.desktopSettled();
    expect(calls).toHaveLength(1);
    expect(h.c.getState().unreadCount).toBe(0);
    expect(h.badge()).toBe(0);
  });
});
