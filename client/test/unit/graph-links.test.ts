// GigleAI/cavil-loop#636: the dependency graph joins a pull request to the issues it is linked to with a
// dashed link, so a waiting chain that runs through a PR is no longer cut in two. The case that started
// it: an item registered to wait for an issue whose work sits in a PR, and that PR registered to wait
// for another issue — the graph drew "upstream → PR" and "issue → downstream", nothing between.
//
// The counting rule the design settled on (#636 design review rounds 1–4): "挡住后面 N 项" crosses a
// link only on a walk that reached the PR along arrows through open nodes alone; the arrows themselves
// are counted exactly as before. Every row of the design's test table is a case here, each run again
// with the items in reverse order. The items are the real readers' output over the fake GitHub.

import { afterEach, describe, expect, it } from 'vitest';
import { GitHubClient } from '../../src/data/github';
import { fetchRepo } from '../../src/data/fetchSources';
import { buildGraph, summaryPrs, type GraphModel } from '../../src/data/graph';
import { prsNaming } from '../../src/data/prNest';
import { edgePath, layoutGraph } from '../../src/data/graphLayout';
import { parseSource } from '../../src/shared/sources';
import type { Item, SourceConfig } from '../../src/shared/types';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN } from './helpers';

const REPO = 'octo-demo/sample';
const KEY = REPO.toLowerCase();
const K = (n: number) => `${KEY}#${n}`;
const NOW = Date.parse('2026-11-21T12:00:00Z');
const RECENT = '2026-11-21T05:00:00Z';
const BLOCKED = 'pending/blocked';

function issue(n: number, o: { labels?: string[]; state?: 'open' | 'closed'; parent?: number; subs?: number; blockedBy?: number; blocking?: number } = {}) {
  return {
    number: n,
    node_id: `I_demo_${n}`,
    title: `issue ${n}`,
    state: o.state ?? 'open',
    ...(o.state === 'closed' ? { state_reason: 'completed' } : {}),
    html_url: `https://github.com/${REPO}/issues/${n}`,
    updated_at: RECENT,
    labels: (o.labels ?? []).map((name) => ({ name, color: 'ededed' })),
    assignees: [],
    milestone: null,
    user: { login: 'demo' },
    parent_issue_url: o.parent ? `https://api.github.com/repos/${REPO}/issues/${o.parent}` : null,
    sub_issues_summary: { total: o.subs ?? 0, completed: 0, percent_completed: 0 },
    issue_dependencies_summary: { blocked_by: o.blockedBy ?? 0, total_blocked_by: o.blockedBy ?? 0, blocking: o.blocking ?? 0, total_blocking: o.blocking ?? 0 },
  };
}
/** a pull request; `waits` = it carries the waiting label (open ones only are read for a registration) */
function pr(n: number, body: string, o: { state?: 'open' | 'closed'; merged?: boolean; waits?: boolean } = {}) {
  return {
    ...issue(n, { labels: o.waits ? [BLOCKED] : [] }),
    node_id: `PR_demo_${n}`,
    title: `PR ${n}`,
    state: o.state ?? 'open',
    body,
    draft: false,
    pull_request: { merged_at: o.merged ? RECENT : null },
  };
}
/** what GitHub says about the other end of a relation; `n` may be `owner/repo#N` for another repository */
const rel = (end: number | string, state: 'OPEN' | 'CLOSED' = 'OPEN') => {
  const [repo, n] = typeof end === 'number' ? [REPO, end] : [end.split('#')[0], Number(end.split('#')[1])];
  return { number: n, title: `issue ${n}`, url: `https://github.com/${repo}/issues/${n}`, state, stateReason: state === 'CLOSED' ? 'COMPLETED' : null, repository: { nameWithOwner: repo } };
};

let fake: FakeGitHub;
let seq = 0;
afterEach(async () => {
  await fake?.close();
});

interface Case {
  items: any[];
  /** n → the prerequisites registered on it (the loop's hidden comment) */
  marks?: Record<number, number[]>;
  /** GitHub's own "Blocked by" / parent relations, keyed by issue number */
  relations?: Record<number, { parent?: number; subIssues?: number[]; blockedBy?: [number | string, 'OPEN' | 'CLOSED'][]; blocking?: [number | string, 'OPEN' | 'CLOSED'][] }>;
}
async function read(c: Case): Promise<Item[]> {
  fake = await startFakeGitHub({ repos: new Map([[KEY, c.items]]) });
  for (const [n, ends] of Object.entries(c.marks ?? {})) {
    const body = `## 等前置\n\n<!-- agent-blocked-by: ${ends.map((e) => `#${e}`).join(' ')} resume=pending/agent -->`;
    fake.state.w.comments.set(K(Number(n)), [
      { id: `IC_${++seq}`, url: `https://github.com/${REPO}/issues/${n}#c${seq}`, createdAt: '2026-11-21T04:00:00Z', bodyHTML: body, body, author: { login: 'demo-bot' }, authorAssociation: 'MEMBER' },
    ]);
  }
  for (const [n, r] of Object.entries(c.relations ?? {}))
    fake.state.w.relations.set(K(Number(n)), {
      parent: r.parent ? rel(r.parent) : null,
      subIssues: (r.subIssues ?? []).map((s) => rel(s)),
      blockedBy: (r.blockedBy ?? []).map(([s, st]) => rel(s, st)),
      blocking: (r.blocking ?? []).map(([s, st]) => rel(s, st)),
    } as any);
  const snap = await fetchRepo(new GitHubClient({ api: fake.api, web: fake.web }, FAKE_TOKEN), parseSource(REPO) as Extract<SourceConfig, { kind: 'repo' }>, NOW, undefined, BLOCKED);
  await fake.close();
  return snap.items;
}

const graph = (items: Item[], shown = items) => buildGraph(items, shown, BLOCKED);
const node = (g: GraphModel, n: number) => g.nodes.get(K(n))!;
const links = (g: GraphModel) => g.links.map((l) => `${l.from.split('#')[1]}~${l.to.split('#')[1]}${l.open ? '' : ' (closed)'}`);
/** what the design's table states for each node: blockingAhead, blockedByOpen, prBlocked */
const badges = (g: GraphModel) =>
  Object.fromEntries([...g.nodes.values()].map((n) => [n.number, { ahead: n.blockingAhead, by: n.blockedByOpen, pr: n.prBlocked.map((k) => Number(k.split('#')[1])) }]));

/** the same items read in reverse order give the same graph, the same counts, the same layout input */
function sameReversed(items: Item[]) {
  const a = graph(items);
  const b = graph([...items].reverse());
  expect(b.links).toEqual(a.links);
  expect(b.edges).toEqual(a.edges);
  expect(badges(b)).toEqual(badges(a));
  expect(b.structure).toBe(a.structure);
}

// C = 10, D = 11 (finished on the way), X = 12, PR P = 20, its issue B = 30, B's downstream A = 31
describe('the chain that started it: upstream → PR ⇢ issue → downstream', () => {
  const main: Case = {
    items: [issue(10), pr(20, 'perf: read the cache\n\nCloses #30', { waits: true }), issue(30, { labels: ['pending/PR'] }), issue(31, { labels: [BLOCKED] })],
    marks: { 20: [10], 31: [30] },
  };
  it('one dashed link; the upstream counts the PR, the issue and its downstream; the issue says "its PR is blocked"', async () => {
    const items = await read(main);
    const g = graph(items);
    expect(links(g)).toEqual(['20~30']);
    expect(g.edges.map((e) => [e.from, e.to])).toEqual([
      [K(10), K(20)],
      [K(30), K(31)],
    ]);
    expect(badges(g)).toEqual({
      10: { ahead: 3, by: 0, pr: [] },
      20: { ahead: 0, by: 1, pr: [] },
      30: { ahead: 0, by: 0, pr: [20] },
      31: { ahead: 0, by: 1, pr: [] },
    });
    sameReversed(items);
  });
  it('without the link (the PR not linked to the issue) the counts are what they were before', async () => {
    const items = await read({ ...main, items: [issue(10), pr(20, 'perf: read the cache', { waits: true }), issue(30), issue(31, { labels: [BLOCKED] })] });
    const g = graph(items);
    expect(g.links).toEqual([]);
    expect(badges(g)).toEqual({
      10: { ahead: 1, by: 0, pr: [] },
      20: { ahead: 0, by: 1, pr: [] },
      30: { ahead: 1, by: 0, pr: [] },
      31: { ahead: 0, by: 1, pr: [] },
    });
  });
  it('a state change keeps the structure (no new layout); the link is part of it', async () => {
    const items = await read(main);
    const g = graph(items);
    const closedUp = items.map((i) => (i.key === K(10) ? { ...i, state: 'closed' as const, stateReason: 'completed' as const } : i));
    const h = graph(closedUp);
    expect(h.structure).toBe(g.structure);
    expect(h.links).toEqual([{ from: K(20), to: K(30), open: true }]);
    // #10 closed: the PR is no longer held, nothing crosses, the issue heads its own chain again
    expect(badges(h)[30]).toEqual({ ahead: 1, by: 0, pr: [] });
    const unlinked = graph(items.map((i) => (i.key === K(20) ? { ...i, refIssues: [] } : i)));
    expect(unlinked.structure).not.toBe(g.structure);
  });
});

describe('a closed end: drawn grey, never crossed', () => {
  // W = 40 waits for the PR, so a closed PR is still drawn
  const shape = (p: any): Case => ({
    items: [issue(40, { labels: [BLOCKED] }), p, issue(30), issue(31, { labels: [BLOCKED] })],
    marks: { 40: [20], 31: [30] },
  });
  it('the PR merged', async () => {
    const items = await read(shape(pr(20, 'Closes #30', { state: 'closed', merged: true })));
    const g = graph(items);
    expect(links(g)).toEqual(['20~30 (closed)']);
    expect(badges(g)[30]).toEqual({ ahead: 1, by: 0, pr: [] });
    expect(badges(g)[20].ahead).toBe(0);
    sameReversed(items);
  });
  it('the PR only says "Refs" and was closed without merging', async () => {
    const items = await read(shape(pr(20, 'Refs #30', { state: 'closed' })));
    const g = graph(items);
    expect(links(g)).toEqual(['20~30 (closed)']);
    expect(badges(g)[30]).toEqual({ ahead: 1, by: 0, pr: [] });
  });
  it('the issue closed: the upstream counts the PR only, never the downstream through it', async () => {
    const items = await read({
      items: [issue(10), pr(20, 'Closes #30', { waits: true }), issue(30, { state: 'closed' }), issue(31, { labels: [BLOCKED] })],
      marks: { 20: [10], 31: [30] },
    });
    const g = graph(items);
    expect(links(g)).toEqual(['20~30 (closed)']);
    expect(badges(g)[10]).toEqual({ ahead: 1, by: 0, pr: [] });
    expect(badges(g)[30].pr).toEqual([]);
  });
  it('another, open PR of the same issue still carries the count', async () => {
    const items = await read({
      items: [issue(10), issue(40, { labels: [BLOCKED] }), pr(20, 'Closes #30', { state: 'closed', merged: true }), pr(21, 'Closes #30', { waits: true }), issue(30), issue(31, { labels: [BLOCKED] })],
      marks: { 40: [20], 21: [10], 31: [30] },
    });
    const g = graph(items);
    expect(links(g)).toEqual(['20~30 (closed)', '21~30']);
    expect(badges(g)[10]).toEqual({ ahead: 3, by: 0, pr: [] });
    expect(badges(g)[30]).toEqual({ ahead: 0, by: 0, pr: [21] });
    sameReversed(items);
  });
});

describe('a PR nobody holds: the link is drawn, nobody counts the issue (design review round 2, #5)', () => {
  it('A waits for the PR, the PR only refers to B: the PR counts A alone, B is unchanged', async () => {
    const items = await read({
      items: [pr(20, 'Refs #30'), issue(31, { labels: [BLOCKED] }), issue(30), issue(32, { labels: [BLOCKED] })],
      marks: { 31: [20], 32: [30] },
    });
    const g = graph(items);
    expect(links(g)).toEqual(['20~30']);
    expect(badges(g)).toEqual({
      20: { ahead: 1, by: 0, pr: [] },
      30: { ahead: 1, by: 0, pr: [] },
      31: { ahead: 0, by: 1, pr: [] },
      32: { ahead: 0, by: 1, pr: [] },
    });
    sameReversed(items);
  });
});

describe('only a path through open items crosses (design review round 3, #9)', () => {
  // C → D (finished) → P, and X → P; P ⇢ B → A
  const base = (withX: boolean): Case => ({
    items: [issue(10, { blocking: 1 }), issue(11, { state: 'closed', blockedBy: 1 }), ...(withX ? [issue(12)] : []), pr(20, 'Closes #30', { waits: true }), issue(30), issue(31, { labels: [BLOCKED] })],
    marks: { 20: withX ? [11, 12] : [11], 31: [30] },
    relations: { 10: { blocking: [[11, 'CLOSED']] }, 11: { blockedBy: [[10, 'OPEN']] } },
  });
  it('X holds the PR directly: X counts the PR, B and A; C, whose path runs through finished D, counts the PR only', async () => {
    const items = await read(base(true));
    const g = graph(items);
    expect(g.edges.map((e) => `${e.from.split('#')[1]}>${e.to.split('#')[1]}${e.open ? '' : ' (done)'}`)).toEqual(['10>11', '11>20 (done)', '12>20', '30>31']);
    expect(badges(g)[12]).toEqual({ ahead: 3, by: 0, pr: [] });
    expect(badges(g)[10]).toEqual({ ahead: 1, by: 0, pr: [] });
    expect(badges(g)[30]).toEqual({ ahead: 0, by: 0, pr: [20] });
    sameReversed(items);
  });
  it('no X: nobody holds the PR, B is not "its PR is blocked" and heads its own chain', async () => {
    const items = await read(base(false));
    const g = graph(items);
    expect(badges(g)).toEqual({
      10: { ahead: 1, by: 0, pr: [] },
      11: { ahead: 0, by: 1, pr: [] },
      20: { ahead: 0, by: 0, pr: [] },
      30: { ahead: 1, by: 0, pr: [] },
      31: { ahead: 0, by: 1, pr: [] },
    });
  });
  it('the same upstream reaches the PR through D and directly: the direct, all-open path carries it across', async () => {
    const items = await read({ ...base(false), marks: { 20: [11, 10], 31: [30] } });
    const g = graph(items);
    expect(badges(g)[10]).toEqual({ ahead: 3, by: 0, pr: [] });
    sameReversed(items);
  });
});

describe('repeated paths and loops', () => {
  it('two held PRs of one issue: every node counted once', async () => {
    const items = await read({
      items: [issue(10), pr(20, 'Closes #30', { waits: true }), pr(21, 'Closes #30', { waits: true }), issue(30), issue(31, { labels: [BLOCKED] })],
      marks: { 20: [10], 21: [10], 31: [30] },
    });
    const g = graph(items);
    expect(links(g)).toEqual(['20~30', '21~30']);
    expect(badges(g)[10]).toEqual({ ahead: 4, by: 0, pr: [] });
    expect(badges(g)[30].pr).toEqual([20, 21]);
    sameReversed(items);
  });
  it('a loop through the link (B blocks its own PR): the walk ends, every node and line is laid out', async () => {
    const items = await read({
      items: [issue(10), pr(20, 'Closes #30', { waits: true }), issue(30)],
      marks: { 20: [10, 30] },
    });
    const g = graph(items);
    expect(links(g)).toEqual(['20~30']);
    expect(badges(g)[10]).toEqual({ ahead: 2, by: 0, pr: [] });
    expect(badges(g)[30]).toEqual({ ahead: 0, by: 0, pr: [20] });
    const lay = layoutGraph(g, 1.6);
    for (const k of g.nodes.keys()) expect(lay.rects.get(k), k).toBeDefined();
    for (const l of [...g.edges, ...g.links]) expect(edgePath(lay.rects.get(l.from)!, lay.rects.get(l.to)!, false, false).d).not.toMatch(/NaN/);
  });
});

describe('which issues a PR is joined to', () => {
  // P names B1 = 30 and B2 = 32; each heads a chain of its own so it is drawn
  const two: Case = {
    items: [issue(10), pr(20, 'Closes #30\nCloses #32', { waits: true }), issue(30), issue(31, { labels: [BLOCKED] }), issue(32), issue(33, { labels: [BLOCKED] })],
    marks: { 20: [10], 31: [30], 33: [32] },
  };
  it('every drawn issue it is linked to, in any order of the items', async () => {
    const items = await read(two);
    const g = graph(items);
    expect(links(g)).toEqual(['20~30', '20~32']);
    expect(badges(g)[10].ahead).toBe(5);
    sameReversed(items);
  });
  it('one of them not drawn (left out by the search): only the other link, its result unchanged', async () => {
    const items = await read(two);
    const g = graph(items);
    const shown = items.filter((i) => i.key !== K(32) && i.key !== K(33));
    const h = graph(items, shown);
    expect(h.nodes.has(K(32))).toBe(false);
    expect(links(h)).toEqual(['20~30']);
    expect(badges(h)[30]).toEqual(badges(g)[30]);
  });
  it('the same relation as the summary\'s "linked PRs", limited to the PRs drawn; the summary still lists the others', async () => {
    // #22 closes #30 too, but nobody waits for it and it waits for nothing: not drawn
    const items = await read({ ...two, items: [...two.items, pr(22, 'Closes #30')] });
    const g = graph(items);
    expect(g.nodes.has(K(22))).toBe(false);
    for (const n of g.nodes.values()) {
      if (n.kind !== 'issue') continue;
      // an issue in no source has no summary list (GitHub's links were not read): the PRs naming it
      const listed = n.item ? (summaryPrs(n, items) ?? []).map((p) => p.key) : prsNaming(n.key, items).map((p) => p.key);
      const drawn = listed.filter((k) => g.nodes.get(k)?.kind === 'pr').sort();
      expect(g.links.filter((l) => l.to === n.key).map((l) => l.from).sort(), n.key).toEqual(drawn);
    }
    expect((summaryPrs(node(g, 30), items) ?? []).map((p) => p.number).sort()).toEqual([20, 22]);
    expect(g.links.filter((l) => l.to === K(30)).map((l) => l.from)).toEqual([K(20)]);
  });
});

describe('layout', () => {
  it('siblings: the PR sits left of its issue', async () => {
    const items = await read({
      items: [issue(10), pr(20, 'Closes #30', { waits: true }), issue(30), issue(31, { labels: [BLOCKED] })],
      marks: { 20: [10], 31: [30] },
    });
    const g = graph(items);
    const lay = layoutGraph(g, 1.6);
    const r = (n: number) => lay.rects.get(K(n))!;
    expect(r(20).x + r(20).w).toBeLessThan(r(30).x);
    expect(r(30).x + r(30).w).toBeLessThan(r(31).x);
    // one group: the link joins the two chains
    expect(lay.groups).toHaveLength(1);
  });
  it('a PR inside the box of the issue it is linked to: the boxes are laid out as without that link, the line is still drawn', async () => {
    // #466 ⊃ #473; PR #521 closes #473 (so it sits in #466's box) and also refers to #466
    const items = await read({
      items: [issue(466, { subs: 1 }), issue(473, { parent: 466 }), issue(523), pr(521, 'Closes #473\nRefs #466', { waits: true })],
      marks: { 521: [523] },
      relations: { 466: { subIssues: [473] }, 473: { parent: 466 } },
    });
    const g = graph(items);
    expect(node(g, 521).parent).toBe(K(466));
    expect(links(g)).toEqual(['521~466', '521~473']);
    const with_ = layoutGraph(g, 1.6);
    const without = layoutGraph({ ...g, links: g.links.filter((l) => l.to !== K(466)) }, 1.6);
    expect(with_.rects).toEqual(without.rects);
    const d = edgePath(with_.rects.get(K(521))!, with_.rects.get(K(466))!, false, true).d;
    expect(d).toMatch(/^M[\d.]+,[\d.]+ C/);
  });
});

// PR #641 review round 1: an issue known only from another item's relations (its repository is no source)
// gets the link, the badge and — in the window — the summary line from the same data
describe('an issue in no source, known from another item\'s relations', () => {
  const OTHER = 'octo-demo/other#5';
  const OK = OTHER.toLowerCase();
  const shape: Case = {
    // #14 (in the source) is blocked by octo-demo/other#5 on GitHub; PR #20 refers to that issue and waits for #10
    items: [issue(10), pr(20, 'Refs octo-demo/other#5', { waits: true }), issue(14, { blockedBy: 1 })],
    marks: { 20: [10] },
    relations: { 14: { blockedBy: [[OTHER, 'OPEN']] } },
  };
  it('the link from the PR, the count across it, "its PR is blocked" on the node', async () => {
    const items = await read(shape);
    const g = graph(items);
    const far = g.nodes.get(OK)!;
    expect(far.item).toBeNull();
    expect(g.links).toEqual([{ from: K(20), to: OK, open: true }]);
    expect(far.prBlocked).toEqual([K(20)]);
    expect(far.blockedByOpen).toBe(0);
    // #10 → PR #20 ⇢ other#5 → #14
    expect(badges(g)[10]).toEqual({ ahead: 3, by: 0, pr: [] });
    expect(g.links.filter((l) => l.to === OK).map((l) => l.from)).toEqual(prsNaming(OK, items).map((p) => p.key));
    sameReversed(items);
  });
});
