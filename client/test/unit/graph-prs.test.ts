// GigleAI/cavil-loop#483: the dependency graph's summary of an issue lists its linked pull requests —
// the same ones, in the same order and state, as the table's "linked PRs" column — with the PR's
// own title, draft mark and labels when a source holds it. The items are the real readers' output
// over the fake GitHub serving the relations recorded from the real board, plus a few pull requests
// added to the repository list (the recording has none in its sources). The window is tested in
// test/e2e/graph.spec.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubClient } from '../../src/data/github';
import { fetchProject, fetchRepo } from '../../src/data/fetchSources';
import { mergeSnapshots } from '../../src/data/merge';
import { buildGraph, summaryPrs, type GraphModel } from '../../src/data/graph';
import { issuePrLinks } from '../../src/data/prNest';
import { parseSource } from '../../src/shared/sources';
import { badgeText, stateTone } from '../../src/shared/stateTone';
import type { Item, SourceConfig, SourceSnapshot } from '../../src/shared/types';
import { loadRelationIssues, loadRelationPages, startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN } from './helpers';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const BOARD = 'org/gigleai/11';
const REPO = 'GigleAI/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;
const NOW = Date.parse('2026-11-10T12:00:00Z');

/** a pull request as GitHub's REST issue list returns it */
const restPr = (number: number, o: { state: 'open' | 'closed'; merged?: boolean; draft?: boolean; body: string; labels?: [string, string][]; title?: string }) => ({
  number,
  node_id: `PR_fixture_${number}`,
  title: o.title ?? `PR ${number}`,
  state: o.state,
  draft: o.draft ?? false,
  body: o.body,
  html_url: `https://github.com/GigleAI/cavil-loop/pull/${number}`,
  updated_at: '2026-11-10T11:00:00Z',
  labels: (o.labels ?? []).map(([name, color]) => ({ name, color })),
  assignees: [],
  milestone: null,
  user: { login: 'luosky' },
  pull_request: { merged_at: o.merged ? '2026-11-10T10:00:00Z' : null },
});

// #350 (board, no GitHub link): named by #351 (draft) and #352 (two words, one line each)
// #70 (board, GitHub links #72): #72 is added to the list too, and its body also names #70 — one line, not two
// #314 (in the repository source alone): GitHub's links unknown; #353 names it in the second run
const PRS = [
  restPr(351, { state: 'open', draft: true, body: 'Refs #350', labels: [['pending/review', 'c5def5']], title: '客户端：依赖图视图' }),
  restPr(352, { state: 'closed', body: 'Closes #350', title: '依赖图第一版' }),
  restPr(72, { state: 'closed', merged: true, body: 'Closes #70', labels: [['Done', '444444']], title: '新安装改名' }),
];

let fake: FakeGitHub;
async function start(extra: object[]) {
  fake = await startFakeGitHub({ projects: new Map([[BOARD, loadRelationPages()]]), repos: new Map([['gigleai/cavil-loop', [...loadRelationIssues(), ...extra]]]) });
}
afterEach(async () => {
  await fake?.close();
});

const client = () => new GitHubClient({ api: fake.api, web: fake.web }, FAKE_TOKEN);
const board = () => fetchProject(client(), parseSource(PROJECT_URL) as Extract<SourceConfig, { kind: 'project' }>, NOW);
const repo = () => fetchRepo(client(), parseSource(REPO) as Extract<SourceConfig, { kind: 'repo' }>, NOW);
const merged = (...snaps: SourceSnapshot[]) => mergeSnapshots(snaps, null).items;
const node = (g: GraphModel, n: number) => g.nodes.get(K(n))!;
const lines = (g: GraphModel, all: Item[], n: number) => summaryPrs(node(g, n), all)!.map((p) => [p.number, p.via, p.badge, p.item?.title ?? null, p.item?.labels.map((l) => l.name) ?? null]);

describe('the linked PRs of an issue in the summary', () => {
  beforeEach(async () => start(PRS));

  it('the PRs are in the sources: number, state words, title, draft, labels, where the link comes from', async () => {
    const all = merged(await board(), await repo());
    // reachability: the added PRs really came through the repository reader
    expect(all.filter((i) => i.kind === 'pr').map((i) => i.number).sort((a, b) => a - b)).toEqual([72, 351, 352]);
    const g = buildGraph(all, all);
    expect(lines(g, all, 350)).toEqual([
      [351, 'body', '草稿', '客户端：依赖图视图', ['pending/review']],
      [352, 'body', '已关闭', '依赖图第一版', []],
    ]);
    // GitHub's link first; the PR's own "Closes #70" does not add a second line
    expect(lines(g, all, 70)).toEqual([[72, 'github', '已合并', '新安装改名', ['Done']]]);
  });

  it('every issue node lists exactly what the table\'s "linked PRs" column lists, with the board\'s state colours', async () => {
    const all = merged(await board(), await repo());
    const g = buildGraph(all, all);
    let compared = 0;
    for (const n of g.nodes.values()) {
      if (n.kind !== 'issue' || !n.item) continue;
      const table = issuePrLinks(n.item, all);
      const summary = summaryPrs(n, all);
      expect(summary?.map((p) => [p.key, p.state, p.via, p.url]) ?? null, n.key).toEqual(table?.map((l) => [l.key, l.state, l.via, l.url]) ?? null);
      for (const p of summary ?? []) {
        compared++;
        const draft = p.item?.isDraft ?? null;
        expect([p.tone, p.badge]).toEqual([stateTone('pr', p.state, null, draft), badgeText('pr', p.state, null, draft)]);
      }
    }
    // reachability: real links were compared, not only empty lists
    expect(compared).toBeGreaterThanOrEqual(14);
  });

  it('a PR in no source: GitHub\'s number and state only, no title or labels', async () => {
    const all = merged(await board(), await repo());
    const g = buildGraph(all, all);
    // #67 links #69 (closed, not merged), which no source holds
    expect(lines(g, all, 67)).toEqual([[69, 'github', '已关闭', null, null]]);
    expect(summaryPrs(node(g, 67), all)![0].tone).toBe('closed');
  });

  it('none is "none"; a repository source that cannot know GitHub\'s links is "unknown", never "none"', async () => {
    const all = merged(await board(), await repo());
    const g = buildGraph(all, all);
    // #349 is on the board: GitHub's links are read and there are none
    expect(summaryPrs(node(g, 349), all)).toEqual([]);
    // the repository source alone: GitHub's links are not in its list (#314 is drawn, inside #311)
    const fromRepo = merged(await repo());
    const r = buildGraph(fromRepo, fromRepo);
    expect(node(r, 314).item!.linkedPrs).toBeNull();
    expect(summaryPrs(node(r, 314), fromRepo)).toBeNull();
    const unknown = [...r.nodes.values()].filter((n) => n.item?.linkedPrs === null && summaryPrs(n, fromRepo) === null);
    expect(unknown.length).toBeGreaterThanOrEqual(5);
  });

  it('a node outside the sources and a PR node have no list', async () => {
    const all = merged(await board(), await repo());
    const g = buildGraph(all, all);
    const outside = g.nodes.get('gigleai/gigletutor-web#1458')!;
    expect(outside.item).toBeNull();
    expect(summaryPrs(outside, all)).toBeNull();
    const asPr = { ...node(g, 350), kind: 'pr' as const };
    expect(summaryPrs(asPr, all)).toBeNull();
  });

  it('the search does not hide a PR from the summary: the list is read from every item of the sources', async () => {
    const all = merged(await board(), await repo());
    const shown = all.filter((i) => i.kind === 'issue');
    const g = buildGraph(all, shown);
    expect(lines(g, all, 350).map((l) => l[0])).toEqual([351, 352]);
    expect(lines(g, all, 350)[0][3]).toBe('客户端：依赖图视图');
  });
});

describe('a repository-only issue named by a PR', () => {
  beforeEach(async () => start([...PRS, restPr(353, { state: 'open', body: 'Refs #314', title: '给 #314 的 PR' })]));

  it('is no longer "unknown": the PR that names it is listed', async () => {
    const all = merged(await repo());
    const g = buildGraph(all, all);
    expect(node(g, 314).item!.linkedPrs).toBeNull();
    expect(lines(g, all, 314)).toEqual([[353, 'body', '开', '给 #314 的 PR', []]]);
  });
});
