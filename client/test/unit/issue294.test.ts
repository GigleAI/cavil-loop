// GitHub#294: a table row dragged to another group does exactly what the
// board does when the same card is dragged to the same column. Checked by
// building the board and the table from one input and comparing, for every
// row: what a drag of it changes, and the plan for every other group — on the
// recorded `cavil project` and on small boards with the hard cases (an item on
// two Projects that disagree, a PR shown under its issue, an item on no
// selected Project, a Project without the target iteration, a read-only one).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBoard, COL_NO_ITERATION, COL_UNBOARDED, dropPlan, type Card } from '../../src/data/board';
import { buildTable, REFUSE_OTHER_REPO, tableDropPlan, type Table } from '../../src/data/table';
import { fetchProject } from '../../src/data/fetchSources';
import { GitHubClient } from '../../src/data/github';
import { mergeSnapshots } from '../../src/data/merge';
import { parseSource } from '../../src/shared/sources';
import { DEFAULT_TABLE } from '../../src/shared/viewSettings';
import type { BoardData, GroupBy, Item, ProjectMeta, TableSettings } from '../../src/shared/types';
import { FakeGitHub, startFakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, FIXTURE_TODAY, item, iter, member, project } from './helpers';

type Mode = 'iteration' | 'status' | 'milestone';
const MODES: Mode[] = ['iteration', 'status', 'milestone'];

/** every row against the board card it stands for; returns how many rows / plans were compared */
function compare(items: Item[], projects: ProjectMeta[], by: Mode, prs: boolean, today: string, extra: Partial<TableSettings> = {}) {
  const settings: TableSettings = { ...DEFAULT_TABLE, ...extra, groupBy: by };
  const table = buildTable(items, projects, settings, today, prs);
  const board = buildBoard(items, projects, by, false, today, settings.sort, prs);
  expect(board.mode).toBe(by);
  const cards = new Map<string, { card: Card; col: string }>();
  for (const c of board.columns) for (const x of c.cards) cards.set(x.id, { card: x, col: c.key });
  let rows = 0;
  let plans = 0;
  const kinds = new Set<string>();
  for (const g of table.groups) {
    expect(g.column).not.toBeNull();
    for (const r of g.rows) {
      let hit = cards.get(`${r.item.key}@${g.column}`);
      if (!hit) {
        // an item on none of the selected Projects: the table keeps it under "no iteration / status", the board under 未加入看板
        expect(by).not.toBe('milestone');
        hit = cards.get(`${r.item.key}@${COL_UNBOARDED}`);
        expect(r.projectKeys, r.id).toEqual([]);
      }
      expect(hit, r.id).toBeDefined();
      expect({ keys: r.projectKeys, titles: r.projectTitles }, r.id).toEqual({ keys: hit!.card.projectKeys, titles: hit!.card.projectTitles });
      rows++;
      for (const to of table.groups) {
        if (to.key === g.key) {
          expect(tableDropPlan(r, g, to, by, projects)).toEqual({ kind: 'none' });
          continue;
        }
        if (to.section !== g.section) {
          // "all repositories": another repository's section never takes it
          expect(tableDropPlan(r, g, to, by, projects)).toEqual({ kind: 'refuse', reason: REFUSE_OTHER_REPO });
          continue;
        }
        const want = dropPlan(hit!.card, hit!.col, { key: to.column! }, by, projects);
        expect(tableDropPlan(r, g, to, by, projects), `${r.id} → ${to.key}`).toEqual(want);
        kinds.add(want.kind);
        plans++;
      }
    }
  }
  return { rows, plans, kinds, table };
}

describe('recorded cavil project: every row drags like its board card', () => {
  let fake: FakeGitHub;
  let data: BoardData;
  beforeAll(async () => {
    fake = await startFakeGitHub();
    const client = new GitHubClient({ api: fake.api, web: fake.web }, FAKE_TOKEN);
    const snap = await fetchProject(client, parseSource('https://github.com/orgs/GigleAI/projects/11/views/1') as any, FIXTURE_NOW);
    data = mergeSnapshots([snap], null);
  });
  afterAll(() => fake.close());

  for (const by of MODES)
    for (const prs of [false, true])
      it(`${by}, PRs under issues ${prs ? 'on' : 'off'}`, () => {
        const { rows, plans, kinds, table } = compare(data.items, data.projects, by, prs, FIXTURE_TODAY, { sliceByRepo: false });
        // the recording is big enough for these to mean something
        expect(rows).toBeGreaterThan(50);
        if (by === 'milestone') {
          // the recording has no milestones: one group, nothing to drag to
          expect(table.groups.map((g) => g.title)).toEqual(['无里程碑']);
          return;
        }
        expect(plans).toBeGreaterThan(rows);
        expect(kinds.has('do')).toBe(true);
      });
});

describe('small boards with the hard cases', () => {
  const A = project('A', 'Board A', [iter('S1', '2026-11-02'), iter('S2', '2026-11-09')], ['Todo', 'Done']);
  const B = project('B', 'Board B', [iter('S1', '2026-11-02')], ['Todo']);
  const RO = { ...project('C', 'Board C', [iter('S1', '2026-11-02'), iter('S2', '2026-11-09')], ['Todo', 'Done']), viewerCanUpdate: false };
  const today = '2026-11-03';
  const issue = (repo: string, n: number, ms: ReturnType<typeof member>[], extra: Partial<Item> = {}) => item(repo, n, extra, ms);
  const pr = (repo: string, n: number, refs: string[], ms: ReturnType<typeof member>[], extra: Partial<Item> = {}) =>
    item(repo, n, { kind: 'pr', refIssues: refs, updatedAt: '2026-11-02T00:00:00Z', ...extra }, ms);
  const items: Item[] = [
    // two Projects that disagree: a row in S1 (B) and one in S2 (A)
    issue('o/r', 1, [member(A, A.iterations[1], 'Done'), member(B, B.iterations[0], 'Todo')], { milestone: { title: 'v1', dueOn: null } }),
    // on both, agreeing
    issue('o/r', 2, [member(A, A.iterations[0], 'Todo'), member(B, B.iterations[0], 'Todo')]),
    // on no selected Project
    issue('o/r', 3, []),
    // a PR naming #2, with its own value elsewhere (S2 on A) / the same (S1 on B)
    pr('o/r', 4, ['o/r#2'], [member(A, A.iterations[1], 'Done')]),
    pr('o/r', 5, ['o/r#2'], [member(B, B.iterations[0], 'Todo')]),
    // a PR on no Project, following #1 into both its groups
    pr('o/r', 6, ['o/r#1'], []),
    // read-only board
    issue('x/y', 7, [member(RO, RO.iterations[0], 'Todo')], { milestone: { title: 'v2', dueOn: '2026-12-01T00:00:00Z' } }),
    // no iteration on A
    issue('x/y', 8, [member(A, null, null)]),
  ];
  const projects = [A, B, RO];

  for (const by of MODES)
    for (const prs of [false, true])
      for (const sliceByRepo of [false, true])
        it(`${by}, PRs under issues ${prs ? 'on' : 'off'}, ${sliceByRepo ? 'one section per repository' : 'one list'}: same as the board`, () => {
          const { kinds } = compare(items, projects, by, prs, today, { sliceByRepo, slice: null });
          expect([...kinds].sort()).toEqual(by === 'milestone' ? ['do'] : ['confirm', 'do', 'refuse']);
        });

  const row = (t: Table, n: number, groupTitle: string) => {
    const g = t.groups.find((x) => x.title === groupTitle)!;
    return { g, r: g.rows.find((x) => x.item.number === n)! };
  };
  const group = (t: Table, title: string) => t.groups.find((x) => x.title === title)!;

  it('the row in one Project\'s group changes only that Project; the one on both changes both', () => {
    const t = buildTable(items, projects, { ...DEFAULT_TABLE, sliceByRepo: false, groupBy: 'iteration' }, today, false);
    const inS2 = row(t, 1, 'S2');
    expect(inS2.r.projectKeys).toEqual(['A']);
    expect(tableDropPlan(inS2.r, inS2.g, group(t, '无迭代'), 'iteration', projects)).toEqual({
      kind: 'do',
      actions: [{ kind: 'setIteration', key: 'o/r#1', projectKey: 'A', iterationId: null }],
      summary: '清空 o/r#1 在看板「Board A」上的迭代',
    });
    const both = row(t, 2, 'S1');
    expect(both.r.projectKeys).toEqual(['A', 'B']);
    // S2 exists only on A: refused whole, nothing half-done
    expect(tableDropPlan(both.r, both.g, group(t, 'S2'), 'iteration', projects)).toMatchObject({ kind: 'refuse', reason: '看板「Board B」没有迭代「S2」' });
  });

  it('a PR shown under its issue: its own value there → that Project; otherwise every Project it is on', () => {
    const t = buildTable(items, projects, { ...DEFAULT_TABLE, sliceByRepo: false, groupBy: 'iteration' }, today, true);
    const own = row(t, 5, 'S1');
    expect(own.r.under).toBe('o/r#2');
    expect(own.r.projectKeys).toEqual(['B']);
    const moved = row(t, 4, 'S1');
    expect(moved.r.under).toBe('o/r#2');
    expect(moved.r.projectKeys).toEqual(['A']);
    expect(tableDropPlan(moved.r, moved.g, group(t, 'S2'), 'iteration', projects)).toMatchObject({
      kind: 'do',
      actions: [{ kind: 'setIteration', key: 'o/r#4', projectKey: 'A', iterationId: A.iterations[1].id }],
    });
  });

  it('an item on no selected Project asks first; a read-only board is refused with the reason', () => {
    const t = buildTable(items, projects, { ...DEFAULT_TABLE, sliceByRepo: false, groupBy: 'iteration' }, today, false);
    const lone = row(t, 3, '无迭代');
    const p = tableDropPlan(lone.r, lone.g, group(t, 'S2'), 'iteration', projects);
    expect(p.kind).toBe('confirm');
    expect((p as any).choices.map((c: any) => [c.projectKey, c.action])).toEqual([
      ['A', { kind: 'addToProject', key: 'o/r#3', projectKey: 'A', iterationId: A.iterations[1].id, status: null }],
    ]);
    const ro = row(t, 7, 'S1');
    expect(tableDropPlan(ro.r, ro.g, group(t, 'S2'), 'iteration', projects)).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('没有修改权限') });
  });

  it('milestones: set by the group\'s title, cleared in 无里程碑', () => {
    const t = buildTable(items, projects, { ...DEFAULT_TABLE, sliceByRepo: false, groupBy: 'milestone' }, today, false);
    const r1 = row(t, 1, 'v1');
    expect(tableDropPlan(r1.r, r1.g, group(t, 'v2'), 'milestone', projects)).toEqual({ kind: 'do', actions: [{ kind: 'setMilestone', key: 'o/r#1', title: 'v2' }], summary: '把 o/r#1 的里程碑改成「v2」' });
    expect(tableDropPlan(r1.r, r1.g, group(t, '无里程碑'), 'milestone', projects)).toMatchObject({ kind: 'do', actions: [{ kind: 'setMilestone', title: null }] });
  });

  it('"all repositories": within a repository like the board; across repositories refused, nothing sent', () => {
    const t = buildTable(items, projects, { ...DEFAULT_TABLE, groupBy: 'iteration', sliceByRepo: true, slice: null }, today, false);
    expect(t.repos!.map((r) => r.title)).toEqual(['o/r', 'x/y']);
    const [or, xy] = t.repos!;
    const r1 = or.groups.find((g) => g.title === 'S2')!;
    const src = r1.rows.find((x) => x.item.number === 1)!;
    expect(r1.section).toBe(or.key);
    expect(tableDropPlan(src, r1, or.groups.find((g) => g.column === COL_NO_ITERATION)!, 'iteration', projects)).toMatchObject({ kind: 'do' });
    const there = xy.groups.find((g) => g.column === COL_NO_ITERATION)!;
    expect(there.column).toBe(COL_NO_ITERATION);
    expect(tableDropPlan(src, r1, there, 'iteration', projects)).toEqual({ kind: 'refuse', reason: REFUSE_OTHER_REPO });
  });

  it('grouped by repository or not at all: nothing to drop on', () => {
    for (const by of ['repo', 'none'] as GroupBy[]) {
      const t = buildTable(items, projects, { ...DEFAULT_TABLE, sliceByRepo: false, groupBy: by }, today, false);
      expect(t.groups.every((g) => g.column === null)).toBe(true);
      const g = t.groups[0];
      const other = t.groups[t.groups.length - 1];
      expect(tableDropPlan(g.rows[0], g, other, by, projects)).toEqual({ kind: 'none' });
    }
  });
});
