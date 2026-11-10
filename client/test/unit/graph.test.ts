// GigleAI/cavil-loop#350: the dependency graph — what goes in, which box each node sits in, the
// arrows and their colour, the counts beside the graph, and where things are laid out. The items
// are the real readers' output over the fake GitHub serving the relations recorded from the real
// board (test/fixtures/record.mjs --relations); a source left out of the view is how an issue
// ends up "not in the current sources". The window itself is tested in test/e2e/graph.spec.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubClient } from '../../src/data/github';
import { fetchProject, fetchRepo } from '../../src/data/fetchSources';
import { mergeSnapshots } from '../../src/data/merge';
import { buildGraph, boxProgress, type GraphModel } from '../../src/data/graph';
import { BOX_HEAD, BOX_PAD, MIN_SCALE, edgePath, fitView, focusOpen, keepAnchor, layoutGraph, READABLE_SCALE, zoomAt, type Rect } from '../../src/data/graphLayout';
import { applyFilter, parseFilter } from '../../src/shared/filter';
import { parseSource } from '../../src/shared/sources';
import type { Item, SourceConfig, SourceSnapshot } from '../../src/shared/types';
import { loadRelationIssues, loadRelationPages, startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN } from './helpers';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const BOARD = 'org/gigleai/11';
const REPO = 'GigleAI/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;
const NOW = Date.parse('2026-11-10T12:00:00Z');

// The recording (2026-11-10), as test/unit/relations.test.ts names it:
//   #346 ⊃ #349 #350, #349 blocks #350, all open;  #311 ⊃ #313 #314 #315 (the repository list lacks #313)
//   #169 blocks #181, both closed;  #232's parent is GigleAI/GigleTutor-Web#1458 (in no source)
const OUTSIDE_PARENT = 'gigleai/gigletutor-web#1458';

let fake: FakeGitHub;
beforeEach(async () => {
  fake = await startFakeGitHub({ projects: new Map([[BOARD, loadRelationPages()]]), repos: new Map([['gigleai/cavil-loop', loadRelationIssues()]]) });
});
afterEach(async () => {
  await fake.close();
});

const client = () => new GitHubClient({ api: fake.api, web: fake.web }, FAKE_TOKEN);
const board = () => fetchProject(client(), parseSource(PROJECT_URL) as Extract<SourceConfig, { kind: 'project' }>, NOW);
const repo = () => fetchRepo(client(), parseSource(REPO) as Extract<SourceConfig, { kind: 'repo' }>, NOW);
const merged = (...snaps: SourceSnapshot[]) => mergeSnapshots(snaps, null).items;
const preRelations = (snap: SourceSnapshot): SourceSnapshot => ({ ...snap, items: snap.items.map(({ relations: _r, relationsAt: _t, ...rest }) => rest as Item) });
async function setState(n: number, state: 'open' | 'closed') {
  const r = await fetch(`${fake.api}/repos/${REPO}/issues/${n}`, { method: 'PATCH', headers: { authorization: `Bearer ${FAKE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ state }) });
  expect(r.status).toBe(200);
}
const node = (g: GraphModel, n: number | string) => g.nodes.get(typeof n === 'number' ? K(n) : n)!;
const edge = (g: GraphModel, from: number, to: number) => g.edges.find((e) => e.from === K(from) && e.to === K(to));
const nums = (keys: string[]) => keys.map((k) => Number(k.split('#')[1]));

/** what the recording says, read straight from the JSON (not through the client's readers) */
function recordedBoardIssues() {
  return loadRelationPages()
    .flatMap((p: any) => p.items.nodes)
    .map((n: any) => n.content)
    .filter((c: any) => c.__typename === 'Issue');
}
const recordedHasRelations = (c: any) => Boolean(c.parent) || c.subIssues.nodes.length + c.blockedBy.nodes.length + c.blocking.nodes.length > 0;

describe('what goes in', () => {
  it('parents become boxes holding their sub-issues, in GitHub order; arrows run from the blocker to the blocked', async () => {
    const items = merged(await board(), await repo());
    const g = buildGraph(items, items);
    expect(nums(node(g, 311).children)).toEqual([313, 314, 315]);
    expect(nums(node(g, 346).children)).toEqual([349, 350]);
    for (const c of [349, 350]) expect(node(g, c).parent).toBe(K(346));
    // every box on the recorded board, and every child in its box: straight from the recording
    for (const c of recordedBoardIssues().filter((x: any) => x.subIssues.nodes.length))
      expect(nums(node(g, c.number).children), `#${c.number}`).toEqual(c.subIssues.nodes.map((s: any) => s.number));
    // the arrows: blocker → blocked; open blocker = open arrow, closed blocker = closed arrow
    expect(edge(g, 349, 350)).toEqual({ from: K(349), to: K(350), open: true });
    expect(edge(g, 169, 181)).toEqual({ from: K(169), to: K(181), open: false });
    expect(edge(g, 350, 349)).toBeUndefined();
    expect(g.edges).toHaveLength(2);
    // the badges: #350 waits for one open blocker; #349 holds one open issue back; a closed blocker holds nobody
    expect(node(g, 350).blockedByOpen).toBe(1);
    expect(node(g, 349).blockingAhead).toBe(1);
    expect(node(g, 181).blockedByOpen).toBe(0);
    expect(node(g, 169).blockingAhead).toBe(0);
    // the sub-issue count on a box is GitHub's
    expect(boxProgress(g, K(311))).toEqual({ total: 3, completed: 3 });
  });

  it('only issues with a relation go in; the rest are counted, not drawn — and the count matches the recording', async () => {
    const r = await repo();
    const g = buildGraph(r.items, r.items);
    const recorded = loadRelationIssues();
    const withRel = recorded.filter((i: any) => i.sub_issues_summary.total > 0 || i.issue_dependencies_summary.total_blocked_by + i.issue_dependencies_summary.total_blocking > 0 || i.parent_issue_url);
    expect(withRel.length).toBeGreaterThan(0);
    expect(g.entries).toBe(withRel.length);
    expect(g.noRelation).toBe(recorded.length - withRel.length);
    expect(g.noRelation).toBeGreaterThan(0);
    expect(g.unknown).toBe(0);
    // an issue with no relation is not a node (control: one with a relation is)
    const lonely = recorded.find((i: any) => !withRel.includes(i))!;
    expect(g.nodes.has(K(lonely.number))).toBe(false);
    expect(g.nodes.has(K(withRel[0].number))).toBe(true);
  });

  it('the board: entries are exactly the recorded issues with a relation', async () => {
    const b = await board();
    const g = buildGraph(b.items, b.items);
    const recorded = recordedBoardIssues();
    expect(g.entries).toBe(recorded.filter(recordedHasRelations).length);
    expect(g.noRelation).toBe(b.items.length - g.entries);
  });
});

describe('the other end of a relation in no source: drawn dashed from what GitHub said, never read', () => {
  it('a parent in another repository: a box of its own around the child', async () => {
    const items = merged(await board());
    const g = buildGraph(items, items);
    const p = node(g, OUTSIDE_PARENT);
    expect(p.item).toBeNull();
    expect(p).toMatchObject({ repo: 'GigleAI/GigleTutor-Web', number: 1458 });
    expect(p.title.length).toBeGreaterThan(0);
    expect(p.children).toEqual([K(232)]);
    expect(node(g, 232).parent).toBe(OUTSIDE_PARENT);
    // control: an in-source parent carries its item
    expect(node(g, 311).item).not.toBeNull();
  });

  it('a sub-issue: the repository alone lacks #313 — it is still in #311\'s box, dashed', async () => {
    const r = await repo();
    expect(r.items.some((i) => i.key === K(313))).toBe(false);
    const g = buildGraph(r.items, r.items);
    expect(node(g, 313).item).toBeNull();
    expect(node(g, 313).parent).toBe(K(311));
    expect(node(g, 313)).toMatchObject({ state: 'closed', stateReason: 'completed' });
    expect(node(g, 314).item).not.toBeNull();
    expect(nums(node(g, 311).children)).toEqual([313, 314, 315]);
  });

  it('a blocker: with #169 in no source the arrow into #181 is still drawn, its colour from what #181 was told', async () => {
    const items = merged(await board()).filter((i) => i.key !== K(169));
    const g = buildGraph(items, items);
    expect(node(g, 169).item).toBeNull();
    expect(edge(g, 169, 181)).toEqual({ from: K(169), to: K(181), open: false });
    // GitHub reopens it: the next read of #181 says so, and the arrow turns
    await setState(169, 'open');
    const again = merged(await board()).filter((i) => i.key !== K(169));
    const g2 = buildGraph(again, again);
    expect(edge(g2, 169, 181)!.open).toBe(true);
    expect(node(g2, 181).blockedByOpen).toBe(1);
  });
});

describe('the search picks first; the other ends it hid stay, faded', () => {
  it('only #350 picked: its blocker and parent are drawn faded, the arrow and the box are whole', async () => {
    const items = merged(await board(), await repo());
    const shown = applyFilter(items, parseFilter('is:open'), { viewer: null, today: '2026-11-10', projects: [] }).filter((i) => i.number === 350);
    expect(shown.map((i) => i.key)).toEqual([K(350)]);
    const g = buildGraph(items, shown);
    expect(g.entries).toBe(1);
    expect([...g.nodes.keys()].sort()).toEqual([K(346), K(349), K(350)].sort());
    expect(node(g, 349).dim).toBe(true);
    expect(node(g, 346).dim).toBe(true);
    expect(node(g, 350).dim).toBe(false);
    expect(edge(g, 349, 350)).toBeDefined();
    expect(nums(node(g, 346).children)).toEqual([349, 350]);
  });

  it('"is:open": every closed issue drops out unless an open one needs it', async () => {
    const items = merged(await board(), await repo());
    const shown = applyFilter(items, parseFilter('is:open'), { viewer: null, today: '2026-11-10', projects: [] });
    const g = buildGraph(items, shown);
    expect(g.nodes.has(K(311))).toBe(false);
    expect(g.nodes.has(K(169))).toBe(false);
    expect(g.nodes.has(K(350))).toBe(true);
    expect([...g.nodes.values()].every((n) => !n.dim)).toBe(true);
  });
});

describe('relations unknown (a cache written before relations were read) are never "no relations"', () => {
  it('one source unknown: its items are counted apart; an item the other source also holds is drawn from that one', async () => {
    const b = await board();
    const r = preRelations(await repo());
    const data = mergeSnapshots([b, r], null);
    expect(data.relationsUnknown).toEqual(['repo:gigleai/cavil-loop']);
    const g = buildGraph(data.items, data.items);
    const onlyRepo = r.items.filter((i) => !b.items.some((x) => x.key === i.key));
    expect(onlyRepo.length).toBeGreaterThan(0);
    expect(g.unknown).toBe(onlyRepo.length);
    for (const i of onlyRepo) expect(g.nodes.has(i.key)).toBe(false);
    // #311 is on the board as well: drawn, with its box
    expect(nums(node(g, 311).children)).toEqual([313, 314, 315]);
  });

  it('every source unknown: nothing drawn, every item counted as unknown, none as "no relations"', async () => {
    const data = mergeSnapshots([preRelations(await board()), preRelations(await repo())], null);
    const g = buildGraph(data.items, data.items);
    expect(g.nodes.size).toBe(0);
    expect(g.unknown).toBe(data.items.length);
    expect(g.noRelation).toBe(0);
    expect(data.items.length).toBeGreaterThan(20);
  });
});

describe('layout', () => {
  const contains = (o: Rect, i: Rect) => i.x >= o.x && i.y >= o.y + BOX_HEAD && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
  const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it('children inside their box, nothing overlapping its siblings, blockers left of what they block', async () => {
    const items = merged(await board(), await repo());
    const g = buildGraph(items, items);
    const l = layoutGraph(g, 16 / 10);
    expect(l.rects.size).toBe(g.nodes.size);
    for (const n of g.nodes.values()) {
      if (n.parent) expect(contains(l.rects.get(n.parent)!, l.rects.get(n.key)!), n.key).toBe(true);
      const sibs = n.parent ? g.nodes.get(n.parent)!.children : g.roots;
      for (const s of sibs) if (s !== n.key) expect(overlap(l.rects.get(s)!, l.rects.get(n.key)!), `${n.key} / ${s}`).toBe(false);
    }
    expect(l.rects.get(K(349))!.x + l.rects.get(K(349))!.w).toBeLessThan(l.rects.get(K(350))!.x);
    expect(l.rects.get(K(349))!.y).toBe(l.rects.get(K(350))!.y);
    // inner padding
    expect(l.rects.get(K(313))!.x - l.rects.get(K(311))!.x).toBe(BOX_PAD);
  });

  it('many groups fill the window\'s shape in rows, not one long column; open groups first', async () => {
    const items = merged(await board(), await repo());
    const g = buildGraph(items, items);
    const wide = layoutGraph(g, 16 / 10);
    expect(wide.groups.length).toBeGreaterThan(4);
    const rows = new Set(wide.groups.map((x) => x.rect.y));
    expect(rows.size).toBeGreaterThan(1);
    expect(rows.size).toBeLessThan(wide.groups.length);
    expect(wide.width / wide.height).toBeGreaterThan(0.8);
    // a taller window makes a taller graph (the shape is followed, not fixed)
    const tall = layoutGraph(g, 1 / 2);
    expect(tall.width / tall.height).toBeLessThan(wide.width / wide.height);
    // the group holding the open issues is placed first
    expect(wide.groups[0].open).toBe(true);
    expect(wide.groups[0].keys).toContain(K(346));
    expect(wide.groups.filter((x) => x.open)).toHaveLength(1);
  });

  it('a loop (GitHub forbids one; a stale read could show one) is broken for the layout, every arrow still there', async () => {
    const items = merged(await board()).map((i) =>
      i.key === K(350) ? { ...i, relations: { ...i.relations!, blocking: [{ ...i.relations!.blockedBy[0] }] } } : i,
    );
    const g = buildGraph(items, items);
    expect(edge(g, 349, 350)).toBeDefined();
    expect(edge(g, 350, 349)).toBeDefined();
    const l = layoutGraph(g, 1.6);
    expect(l.rects.has(K(349)) && l.rects.has(K(350))).toBe(true);
    expect(edgePath(l.rects.get(K(350))!, l.rects.get(K(349))!, false, false).d).toMatch(/^M/);
  });

  it('a state change keeps the structure (no new layout); an issue added changes it', async () => {
    const before = merged(await board(), await repo());
    const g1 = buildGraph(before, before);
    await setState(349, 'closed');
    const after = merged(await board(), await repo());
    const g2 = buildGraph(after, after);
    // it did change: the arrow turned grey, the badges went, the node's look changed
    expect(edge(g2, 349, 350)!.open).toBe(false);
    expect(node(g2, 350).blockedByOpen).toBe(0);
    expect(node(g2, 349).look).not.toBe(node(g1, 349).look);
    // the structure did not
    expect(g2.structure).toBe(g1.structure);
    // control: the layout of either is the same, place for place
    expect([...layoutGraph(g2, 1.6).rects]).toEqual([...layoutGraph(g1, 1.6).rects]);
    // an item gone changes the structure
    const fewer = after.filter((i) => i.key !== K(181) && i.key !== K(169));
    expect(buildGraph(fewer, fewer).structure).not.toBe(g2.structure);
  });
});

describe('the view', () => {
  it('after a new layout, the node nearest the middle stays where it was on screen', async () => {
    const all = merged(await board(), await repo());
    const g1 = buildGraph(all, all);
    const l1 = layoutGraph(g1, 1.6);
    // looking at #315 at 100%
    const r = l1.rects.get(K(315))!;
    const vw = 1200;
    const vh = 700;
    const v = { scale: 1, tx: vw / 2 - (r.x + r.w / 2), ty: vh / 2 - (r.y + r.h / 2) };
    // issues with relations go (#346 and its two sub-issues, the first group): a new layout in which #315 moved
    const fewer = all.filter((i) => ![346, 349, 350].includes(i.number));
    const g2 = buildGraph(fewer, fewer);
    const l2 = layoutGraph(g2, 1.6);
    const r2 = l2.rects.get(K(315))!;
    expect(r2.x !== r.x || r2.y !== r.y).toBe(true);
    const kept = keepAnchor(l1.rects, l2.rects, v, vw, vh, (k) => g2.nodes.get(k)!.children.length > 0)!;
    expect(r2.x * kept.scale + kept.tx).toBeCloseTo(r.x * v.scale + v.tx);
    expect(r2.y * kept.scale + kept.ty).toBeCloseTo(r.y * v.scale + v.ty);
    expect(kept.scale).toBe(1);
  });

  it('fit: never above 100%; "too big" below the readable size, and then the open group at a readable size', async () => {
    const items = merged(await board(), await repo());
    const l = layoutGraph(buildGraph(items, items), 1.6);
    const roomy = fitView(l, l.width * 2, l.height * 2);
    expect(roomy.view.scale).toBe(1);
    expect(roomy.tooBig).toBe(false);
    const small = fitView(l, l.width * 0.3, l.height * 0.3);
    expect(small.tooBig).toBe(true);
    expect(small.view.scale).toBeLessThan(READABLE_SCALE);
    const f = focusOpen(l, l.width * 0.3, l.height * 0.3)!;
    expect(f.scale).toBeGreaterThanOrEqual(READABLE_SCALE);
    // the open group's top-left is on screen
    const g = l.groups[0].rect;
    expect(g.x * f.scale + f.tx).toBeGreaterThanOrEqual(0);
    expect(g.y * f.scale + f.ty).toBeGreaterThanOrEqual(0);
  });

  it('fit puts every edge of a very wide graph in the window, even below the manual zoom floor; zooming out from there does not jump back up (PR #367 review round 1)', () => {
    const l = { width: 10000, height: 1000 };
    const { view } = fitView(l, 900, 500);
    expect(view.scale).toBeCloseTo(0.09);
    expect(view.scale).toBeLessThan(MIN_SCALE);
    // the four edges on screen are inside the 900 × 500 canvas
    expect(view.tx).toBeGreaterThanOrEqual(-1e-9);
    expect(view.tx + l.width * view.scale).toBeLessThanOrEqual(900 + 1e-9);
    expect(view.ty).toBeGreaterThanOrEqual(-1e-9);
    expect(view.ty + l.height * view.scale).toBeLessThanOrEqual(500 + 1e-9);
    // from there: "-" stays put (not up to the floor), "+" zooms in
    expect(zoomAt(view, 1 / 1.2, 450, 250).scale).toBeCloseTo(view.scale);
    expect(zoomAt(view, 1.2, 450, 250).scale).toBeCloseTo(view.scale * 1.2);
    // one after another (PR #367 review round 2): "+" then "-" comes back to the fit, and "-" again stays there
    const step = (v: typeof view, f: number) => zoomAt(v, f, 450, 250);
    const inOut = step(step(view, 1.2), 1 / 1.2);
    expect(inOut.scale).toBeCloseTo(view.scale);
    expect(inOut.tx).toBeCloseTo(view.tx);
    expect(step(inOut, 1 / 1.2).scale).toBeCloseTo(view.scale);
    // a few steps in, then out further than back: stops at the fit, never below it, never jumps to 20%
    let v = view;
    for (const f of [1.2, 1.2, 1.2, 1 / 1.2, 1 / 1.2, 1 / 1.2, 1 / 1.2, 1 / 1.2]) v = step(v, f);
    expect(v.scale).toBeCloseTo(view.scale);
    // up past 20% and back down: still reaches the fit again
    for (let i = 0; i < 12; i++) v = step(v, 1.2);
    expect(v.scale).toBeGreaterThan(MIN_SCALE);
    for (let i = 0; i < 20; i++) v = step(v, 1 / 1.2);
    expect(v.scale).toBeCloseTo(view.scale);
    // control: a graph that fits above the floor is not taken below it by zooming out
    expect(zoomAt({ tx: 0, ty: 0, scale: 0.21 }, 0.5, 0, 0).scale).toBe(MIN_SCALE);
    const roomy = fitView({ width: 1000, height: 500 }, 900, 500).view;
    expect(roomy.floor).toBeUndefined();
    let r = roomy;
    for (let i = 0; i < 20; i++) r = zoomAt(r, 1 / 1.2, 0, 0);
    expect(r.scale).toBe(MIN_SCALE);
  });

  it('zoom keeps the point under the pointer still', () => {
    const v = zoomAt({ tx: 10, ty: 20, scale: 1 }, 1.5, 300, 200);
    expect((300 - v.tx) / v.scale).toBeCloseTo(290);
    expect((200 - v.ty) / v.scale).toBeCloseTo(180);
  });
});

describe('the layout setting', () => {
  it('"graph" is a layout of its own, kept; what an older build saved still reads as it did', async () => {
    const { normalizeView, isValidView, DEFAULT_VIEW } = await import('../../src/shared/viewSettings');
    expect(normalizeView({ ...DEFAULT_VIEW, layout: 'graph' }).layout).toBe('graph');
    expect(isValidView({ ...DEFAULT_VIEW, layout: 'graph' })).toBe(true);
    for (const old of ['board', 'table'] as const) expect(normalizeView({ mode: 'status', layout: old }).layout).toBe(old);
    // something no build ever wrote falls back to the default (not to the graph)
    expect(normalizeView({ layout: 'roadmap' }).layout).toBe('board');
    expect(isValidView({ ...DEFAULT_VIEW, layout: 'roadmap' })).toBe(false);
  });
});
