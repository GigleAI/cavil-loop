// The table layout and importing saved web views: on the recorded
// `cavil project` (its saved view 1 "Pending" has the same settings as the
// Tutor Project view the maintainer pointed at: table, grouped by iteration,
// newest update first, `-label:Done -status:Done`), and on small synthetic
// boards for grouping / sorting / slicing / hierarchy rules.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTable, GROUP_NONE_KEY, iterationRange, type Table } from '../../src/data/table';
import { fetchProject } from '../../src/data/fetchSources';
import { GitHubClient } from '../../src/data/github';
import { mergeSnapshots } from '../../src/data/merge';
import { applyFilter, parseFilter } from '../../src/shared/filter';
import { parseSource } from '../../src/shared/sources';
import { importView, pickView } from '../../src/shared/viewImport';
import { DEFAULT_TABLE, DEFAULT_VIEW } from '../../src/shared/viewSettings';
import type { BoardData, Item, TableSettings } from '../../src/shared/types';
import { FakeGitHub, loadCavilProjectPages, startFakeGitHub } from '../fake-github/server';
import { FAKE_TOKEN, FIXTURE_NOW, FIXTURE_TODAY, item, iter, member, project } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
const serverResults: { query: string; server: string[] }[] = JSON.parse(
  readFileSync(join(here, '../fixtures/cavil-project-11.filters.json'), 'utf8'),
).results;

const keysOf = (t: Table) => t.groups.flatMap((g) => g.rows.map((r) => r.item.key));

describe('recorded cavil project: importing its saved view "Pending"', () => {
  let fake: FakeGitHub;
  let data: BoardData;
  beforeAll(async () => {
    fake = await startFakeGitHub();
    const client = new GitHubClient({ api: fake.api, web: fake.web }, FAKE_TOKEN);
    const snap = await fetchProject(client, parseSource('https://github.com/orgs/GigleAI/projects/11/views/1') as any, FIXTURE_NOW);
    data = mergeSnapshots([snap], null);
  });
  afterAll(() => fake.close());

  /** raw recorded node per item key, read independently of the client code */
  function raw() {
    const out = new Map<string, any>();
    for (const p of loadCavilProjectPages())
      for (const n of p.items.nodes) {
        if (n.isArchived || !n.content || n.content.__typename === 'DraftIssue') continue;
        out.set(`${n.content.repository.nameWithOwner.toLowerCase()}#${n.content.number}`, n);
      }
    return out;
  }

  it('the sync reads the saved views and the new item fields', () => {
    const p = data.projects[0];
    expect(p.views.map((v) => v.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(p.views[0]).toMatchObject({ name: 'Pending', layout: 'TABLE_LAYOUT', filter: '-label:Done -status:Done' });
    // fields the table needs, compared with the raw recorded JSON
    const r = raw();
    let parents = 0;
    let progress = 0;
    let linked = 0;
    for (const it of data.items) {
      const c = r.get(it.key).content;
      expect(it.author).toBe(c.author?.login ?? null);
      expect(it.parent).toBe(c.parent ? `${c.parent.repository.nameWithOwner.toLowerCase()}#${c.parent.number}` : null);
      const s = c.subIssuesSummary;
      expect(it.subIssues).toEqual(s && s.total > 0 ? { total: s.total, completed: s.completed } : null);
      expect(it.linkedPrs?.map((p) => p.number) ?? []).toEqual((c.closedByPullRequestsReferences?.nodes ?? []).map((p: any) => p.number));
      if (it.parent) parents++;
      if (it.subIssues) progress++;
      if (it.linkedPrs?.length) linked++;
    }
    // the recording has real cases of each, so these checks are not vacuous
    expect(parents).toBeGreaterThan(0);
    expect(progress).toBeGreaterThan(0);
    expect(linked).toBeGreaterThan(0);
  });

  it('import → table: same items as GitHub, grouped by iteration, newest first, the columns of the view', () => {
    const { view, note } = pickView(data.projects[0], 1);
    expect(note).toBeNull();
    const patch = importView(view!, data.projects[0], DEFAULT_VIEW, note);
    expect(patch).toMatchObject({ layout: 'table', query: '-label:Done -status:Done' });
    expect(patch.table).toMatchObject({ groupBy: 'iteration', sort: { field: 'updated', dir: 'desc' } });
    expect(patch.table.columns).toEqual(['title', 'labels', 'linkedPrs', 'subIssues', 'updated', 'iteration']);
    expect(patch.imported!.notes).toEqual([]);

    const parsed = parseFilter(patch.query);
    expect(parsed.unsupported).toEqual([]);
    const filtered = applyFilter(data.items, parsed, { viewer: null, today: FIXTURE_TODAY, projects: data.projects });
    const table = buildTable(filtered, data.projects, patch.table, FIXTURE_TODAY);
    // items: exactly what GitHub's own filter returned for this view's filter
    expect([...keysOf(table)].sort()).toEqual(serverResults.find((x) => x.query === patch.query)!.server);

    // groups and their counts, from the raw recorded iteration values
    const r = raw();
    const want = new Map<string, number>();
    for (const k of keysOf(table)) {
      const v = r.get(k).fieldValues.nodes.find((x: any) => x.iterationId);
      want.set(v ? v.title : '无迭代', (want.get(v ? v.title : '无迭代') ?? 0) + 1);
    }
    expect(new Map(table.groups.map((g) => [g.title, g.rows.length]))).toEqual(want);
    // order inside every group: updated, newest first (raw timestamps)
    for (const g of table.groups) {
      const top = g.rows.filter((x) => x.depth === 0).map((x) => r.get(x.item.key).content.updatedAt);
      expect(top).toEqual([...top].sort().reverse());
    }
  });
});

const A = project('project:org/x/1', 'Alpha', [iter('S1', '2026-10-27', 7), iter('S2', '2026-11-03', 7), iter('S3', '2026-11-10', 7)], ['Todo', 'Doing', 'Done']);
const B = project('project:org/x/2', 'Beta', [iter('S2', '2026-11-03', 7)], ['Todo', 'Done']);
const TODAY = '2026-11-05';
const T = (patch: Partial<TableSettings> = {}): TableSettings => ({ ...DEFAULT_TABLE, ...patch });

function board(): Item[] {
  return [
    item('x/app', 10, { title: 'parent', updatedAt: '2026-11-01T00:00:00Z', subIssues: { total: 2, completed: 1 } }, [member(A, A.iterations[1], 'Doing')]),
    item('x/app', 11, { title: 'child a', parent: 'x/app#10', updatedAt: '2026-11-04T00:00:00Z' }, [member(A, A.iterations[1], 'Todo')]),
    item('x/app', 12, { title: 'child b', parent: 'x/app#10', updatedAt: '2026-11-02T00:00:00Z' }, [member(A, A.iterations[1], 'Done')]),
    item('x/app', 13, { title: 'grandchild', parent: 'x/app#11', updatedAt: '2026-11-03T00:00:00Z' }, [member(A, A.iterations[1], null)]),
    item('x/app', 14, { title: 'child elsewhere', parent: 'x/app#10', updatedAt: '2026-11-05T00:00:00Z' }, [member(A, A.iterations[2], 'Todo')]),
    item('x/lib', 20, { title: 'two boards', updatedAt: '2026-10-30T00:00:00Z', milestone: { title: 'v2', dueOn: '2026-12-01T00:00:00Z' } }, [member(A, A.iterations[0], 'Done'), member(B, B.iterations[0], 'Todo')]),
    item('x/lib', 21, { title: 'repo only', updatedAt: '2026-10-29T00:00:00Z', milestone: { title: 'v1', dueOn: '2026-11-15T00:00:00Z' } }, []),
  ];
}
const flat = (t: Table) => t.groups.map((g) => [g.title, g.rows.map((r) => `${'  '.repeat(r.depth)}${r.item.number}`)]);

describe('table rules', () => {
  it('group by iteration: date range, Current mark, the "no iteration" group first, an item in two Projects twice', () => {
    const t = buildTable(board(), [A, B], T({ hierarchy: false }), TODAY);
    expect(t.groups.map((g) => [g.title, g.subtitle, g.current, g.empty])).toEqual([
      ['无迭代', null, false, true],
      ['S1', iterationRange(A.iterations[0]), false, false],
      ['S2', '11/03 – 11/09', true, false],
      ['S3', '11/10 – 11/16', false, false],
    ]);
    expect(t.groups.find((g) => g.title === 'S1')!.rows.map((r) => r.item.number)).toEqual([20]);
    expect(t.groups.find((g) => g.title === 'S2')!.rows.map((r) => r.item.number)).toEqual([11, 13, 12, 10, 20]);
    expect(t.groups[0].rows.map((r) => r.item.number)).toEqual([21]);
    expect(t.itemCount).toBe(7);
  });

  it('hierarchy: sub-issues under their parent, recursively; a child in another group stays at top level there', () => {
    const t = buildTable(board(), [A, B], T(), TODAY);
    expect(flat(t)).toEqual([
      ['无迭代', ['21']],
      ['S1', ['20']],
      ['S2', ['10', '  11', '    13', '  12', '20']],
      ['S3', ['14']],
    ]);
  });

  it('hierarchy off: plain sorted list', () => {
    const t = buildTable(board(), [A, B], T({ groupBy: 'none', hierarchy: false }), TODAY);
    expect(flat(t)).toEqual([['全部', ['14', '11', '13', '12', '10', '20', '21']]]);
  });

  it('a parent cycle does not hang or drop rows', () => {
    const items = [item('x/a', 1, { parent: 'x/a#2' }), item('x/a', 2, { parent: 'x/a#1' }), item('x/a', 3, { parent: 'x/a#3' })];
    const t = buildTable(items, [], T({ groupBy: 'none', sort: { field: 'number', dir: 'asc' } }), TODAY);
    expect(t.groups[0].rows.map((r) => r.item.number).sort()).toEqual([1, 2, 3]);
  });

  it('group by status follows option order; by milestone by due date; by repository alphabetically; none groups first', () => {
    const items = board();
    expect(buildTable(items, [A, B], T({ groupBy: 'status', hierarchy: false }), TODAY).groups.map((g) => `${g.title}:${g.rows.length}`)).toEqual([
      '无状态:2',
      'Todo:3',
      'Doing:1',
      'Done:2',
    ]);
    expect(buildTable(items, [A, B], T({ groupBy: 'milestone' }), TODAY).groups.map((g) => `${g.title}:${g.rows.length}`)).toEqual(['无里程碑:5', 'v1:1', 'v2:1']);
    expect(buildTable(items, [A, B], T({ groupBy: 'repo' }), TODAY).groups.map((g) => `${g.title}:${g.rows.length}`)).toEqual(['x/app:5', 'x/lib:2']);
  });

  it('sort: ascending / descending; items without a value stay last either way; manual keeps the read order', () => {
    const items = board();
    const order = (s: TableSettings['sort']) => buildTable(items, [A, B], T({ groupBy: 'none', hierarchy: false, sort: s }), TODAY).groups[0].rows.map((r) => r.item.number);
    expect(order({ field: 'updated', dir: 'asc' })).toEqual([21, 20, 10, 12, 13, 11, 14]);
    expect(order({ field: 'title', dir: 'asc' })).toEqual([11, 12, 14, 13, 10, 21, 20]);
    expect(order({ field: 'milestone', dir: 'asc' })).toEqual([21, 20, 10, 11, 12, 13, 14]);
    expect(order({ field: 'milestone', dir: 'desc' })).toEqual([20, 21, 10, 11, 12, 13, 14]);
    expect(order({ field: 'manual', dir: 'asc' })).toEqual([10, 11, 12, 13, 14, 20, 21]);
  });

  it('slices by repository: counts over the filtered items, picking one narrows the table, a gone repository shows nothing', () => {
    const items = board();
    const all = buildTable(items, [A, B], T({ sliceByRepo: true }), TODAY);
    expect(all.slices).toEqual([
      { value: 'x/app', count: 5 },
      { value: 'x/lib', count: 2 },
    ]);
    const lib = buildTable(items, [A, B], T({ sliceByRepo: true, slice: 'x/lib' }), TODAY);
    expect(lib.itemCount).toBe(2);
    expect(lib.slices).toEqual(all.slices); // the list still shows every repository
    expect(buildTable(items, [A, B], T({ sliceByRepo: true, slice: 'x/gone' }), TODAY).itemCount).toBe(0);
    // slicing off: the picked value is ignored
    expect(buildTable(items, [A, B], T({ sliceByRepo: false, slice: 'x/lib' }), TODAY)).toMatchObject({ slices: null, itemCount: 7 });
  });

  it('"no value" group key is stable', () => {
    expect(buildTable([item('x/a', 1)], [], T({ groupBy: 'milestone' }), TODAY).groups[0].key).toBe(GROUP_NONE_KEY);
  });
});

describe('importing saved views', () => {
  const P = { ...project('project:org/x/9', 'P', [iter('S', '2026-11-01')]), views: [] as any[] };
  const f = (name: string, dataType: string) => ({ name, dataType });
  const view = (over: Record<string, unknown>) => ({ number: 1, name: 'v', layout: 'TABLE_LAYOUT', filter: '', groupBy: [], verticalGroupBy: [], sortBy: [], fields: [f('Title', 'TITLE')], ...over }) as any;

  it('pickView: /views/N when present, else the first one with a note; no views at all is said', () => {
    const p = { ...P, views: [view({ number: 3, name: 'three' }), view({ number: 7, name: 'seven' })] };
    expect(pickView(p, 7)).toMatchObject({ view: { number: 7 }, note: null });
    expect(pickView(p, undefined)).toMatchObject({ view: { number: 3 }, note: null });
    const missing = pickView(p, 5);
    expect(missing.view!.number).toBe(3);
    expect(missing.note).toContain('5');
    expect(pickView(P, undefined)).toMatchObject({ view: null });
  });

  it('board view: column field → board mode, repository lanes → swimlanes', () => {
    const r = importView(view({ layout: 'BOARD_LAYOUT', verticalGroupBy: [f('Status', 'SINGLE_SELECT')], groupBy: [f('Repository', 'REPOSITORY')] }), P, DEFAULT_VIEW, null);
    expect(r).toMatchObject({ layout: 'board', mode: 'status', swimlanes: true });
    expect(r.imported!.notes).toEqual([]);
  });

  it('what cannot be reproduced is named: custom grouping / sort / columns, roadmap, extra sort levels', () => {
    const r = importView(
      view({
        layout: 'ROADMAP_LAYOUT',
        groupBy: [f('Priority', 'SINGLE_SELECT')],
        sortBy: [{ field: f('Estimate', 'NUMBER'), direction: 'ASC' }, { field: f('Updated', 'UPDATED'), direction: 'DESC' }],
        fields: [f('Title', 'TITLE'), f('Start date', 'DATE'), f('Assignees', 'ASSIGNEES'), f('Priority', 'SINGLE_SELECT')],
      }),
      P,
      DEFAULT_VIEW,
      null,
    );
    expect(r.layout).toBe('table');
    expect(r.table.groupBy).toBe('none');
    expect(r.table.sort).toEqual(DEFAULT_VIEW.table.sort);
    expect(r.table.columns).toEqual(['title', 'assignees']);
    const notes = r.imported!.notes.join('\n');
    for (const word of ['路线图', 'Priority', 'Estimate', '2 级排序', 'Start date']) expect(notes).toContain(word);
  });

  it('a view without sort = the Project order; slices and hierarchy (not in the API) go back to on, the picked slice is reset', () => {
    const r = importView(view({}), P, { ...DEFAULT_VIEW, table: { ...DEFAULT_TABLE, slice: 'x/a', sliceByRepo: false, hierarchy: false } }, null);
    expect(r.table.sort).toEqual({ field: 'manual', dir: 'asc' });
    expect(r.table).toMatchObject({ slice: null, sliceByRepo: true, hierarchy: true });
  });
});

// keep the recorded-data helper honest about the fixture day it relies on
it('fixture day', () => expect(FIXTURE_TODAY).toBe(new Date(FIXTURE_NOW).toISOString().slice(0, 10)));

describe('merging a Project copy with a repository copy of the same item', () => {
  it('linked pull requests come from the copy that knows them, even when the repository copy is newer', () => {
    const fromProject = item('x/a', 1, { updatedAt: '2026-11-01T00:00:00Z', linkedPrs: [{ key: 'x/a#2', repo: 'x/a', number: 2, url: 'u', state: 'open' }], sources: ['p'] });
    const fromRepo = item('x/a', 1, { updatedAt: '2026-11-02T00:00:00Z', linkedPrs: null, title: 'newer', sources: ['r'] });
    for (const order of [
      [fromProject, fromRepo],
      [fromRepo, fromProject],
    ]) {
      const merged = mergeSnapshots(
        order.map((it, i) => ({ sourceKey: it.sources[0], fetchedAt: i, items: [it] })),
        null,
      ).items;
      expect(merged).toHaveLength(1);
      expect(merged[0].title).toBe('newer');
      expect(merged[0].linkedPrs?.map((p) => p.number)).toEqual([2]);
    }
  });
});
