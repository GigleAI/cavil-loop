// The table layout and importing saved web views: on the recorded
// `cavil project` (its saved view 1 "Pending" has the same settings as the
// Tutor Project view the maintainer pointed at: table, grouped by iteration,
// newest update first, `-label:Done -status:Done`), and on small synthetic
// boards for grouping / sorting / slicing / hierarchy rules.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTable, foldRuns, foldTally, GROUP_NONE_KEY, iterationRange, repoSources, type Group, type RepoSource, type Table } from '../../src/data/table';
import { buildBoard, iterationColumnKey } from '../../src/data/board';
import { fetchProject } from '../../src/data/fetchSources';
import { GitHubClient } from '../../src/data/github';
import { mergeSnapshots } from '../../src/data/merge';
import { applyFilter, parseFilter } from '../../src/shared/filter';
import { parseSource } from '../../src/shared/sources';
import { importView, pickView } from '../../src/shared/viewImport';
import { DEFAULT_QUERY, DEFAULT_TABLE, DEFAULT_VIEW } from '../../src/shared/viewSettings';
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

  it('recorded board view 2 ("by update, newest first") → every board column is newest first', () => {
    const { view } = pickView(data.projects[0], 2);
    expect(view).toMatchObject({ layout: 'BOARD_LAYOUT', sortBy: [{ field: { dataType: 'UPDATED' }, direction: 'DESC' }] });
    const patch = importView(view!, data.projects[0], DEFAULT_VIEW, null);
    const items = applyFilter(data.items, parseFilter(patch.query), { viewer: null, today: FIXTURE_TODAY, projects: data.projects });
    const board = buildBoard(items, data.projects, patch.mode, patch.swimlanes, FIXTURE_TODAY, patch.table.sort);
    const r = raw();
    let checked = 0;
    for (const col of board.columns) {
      const ts = col.cards.map((c) => r.get(c.item.key).content.updatedAt);
      expect(ts, col.title).toEqual([...ts].sort().reverse());
      if (ts.length > 1) checked++;
    }
    expect(checked).toBeGreaterThan(0);
    // and that order differs from the old fixed "repository, newest number" one somewhere
    const old = buildBoard(items, data.projects, patch.mode, patch.swimlanes, FIXTURE_TODAY);
    expect(board.columns.map((c) => c.cards.map((x) => x.item.number))).not.toEqual(old.columns.map((c) => c.cards.map((x) => x.item.number)));
  });

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
    // GitHub#464: the view's filter only hides finished items — that is the "显示已关闭" switch's job now
    expect(view!.filter).toBe('-label:Done -status:Done');
    expect(patch).toMatchObject({ layout: 'table', query: '' });
    expect(patch.table).toMatchObject({ groupBy: 'iteration', sort: { field: 'updated', dir: 'desc' } });
    expect(patch.table.columns).toEqual(['title', 'labels', 'linkedPrs', 'subIssues', 'updated', 'iteration']);
    expect(patch.imported!.notes).toEqual([]);

    // the rest of the import (grouping, order, columns) on the items the web view's own filter picks
    const parsed = parseFilter(view!.filter);
    expect(parsed.unsupported).toEqual([]);
    const filtered = applyFilter(data.items, parsed, { viewer: null, today: FIXTURE_TODAY, projects: data.projects });
    const table = buildTable(filtered, data.projects, patch.table, FIXTURE_TODAY);
    // items: exactly what GitHub's own filter returned for this view's filter
    expect([...keysOf(table)].sort()).toEqual(serverResults.find((x) => x.query === view!.filter)!.server);

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
// The single-level grouping rules below run with the repository slices off: that is the table
// without a repository layer, unchanged by GitHub#213 (with slices on and "all" picked the same
// rules apply inside each repository — see "all repositories" below, which turns slicing on).
const T = (patch: Partial<TableSettings> = {}): TableSettings => ({ ...DEFAULT_TABLE, sliceByRepo: false, ...patch });

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
  it('group by iteration: date range, Current mark, the "no iteration" group last (as on the web, GitHub#231), an item in two Projects twice', () => {
    const t = buildTable(board(), [A, B], T({ hierarchy: false }), TODAY);
    expect(t.groups.map((g) => [g.title, g.subtitle, g.current, g.empty])).toEqual([
      ['S1', iterationRange(A.iterations[0]), false, false],
      ['S2', '11/03 – 11/09', true, false],
      ['S3', '11/10 – 11/16', false, false],
      ['无迭代', null, false, true],
    ]);
    expect(t.groups.find((g) => g.title === 'S1')!.rows.map((r) => r.item.number)).toEqual([20]);
    expect(t.groups.find((g) => g.title === 'S2')!.rows.map((r) => r.item.number)).toEqual([11, 13, 12, 10, 20]);
    expect(t.groups[3].rows.map((r) => r.item.number)).toEqual([21]);
    expect(t.itemCount).toBe(7);
  });

  it('hierarchy: sub-issues under their parent, recursively; a child in another group stays at top level there', () => {
    const t = buildTable(board(), [A, B], T(), TODAY);
    expect(flat(t)).toEqual([
      ['S1', ['20']],
      ['S2', ['10', '  11', '    13', '  12', '20']],
      ['S3', ['14']],
      ['无迭代', ['21']],
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

  it('group by status follows option order; by milestone by due date; by repository alphabetically; none groups last', () => {
    const items = board();
    expect(buildTable(items, [A, B], T({ groupBy: 'status', hierarchy: false }), TODAY).groups.map((g) => `${g.title}:${g.rows.length}`)).toEqual([
      'Todo:3',
      'Doing:1',
      'Done:2',
      '无状态:2',
    ]);
    expect(buildTable(items, [A, B], T({ groupBy: 'milestone' }), TODAY).groups.map((g) => `${g.title}:${g.rows.length}`)).toEqual(['v1:1', 'v2:1', '无里程碑:5']);
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

describe('"all repositories": repository first, then the chosen grouping inside it (GitHub#213)', () => {
  // board() plus a sub-issue of x/app#10 that lives in x/lib, in the same iteration as its parent
  const items = () => [...board(), item('x/lib', 22, { title: 'cross-repo child', parent: 'x/app#10', updatedAt: '2026-11-06T00:00:00Z' }, [member(A, A.iterations[1], 'Todo')])];
  const ALL = (patch: Partial<TableSettings> = {}) => T({ sliceByRepo: true, slice: null, ...patch });
  const nested = (t: Table) => t.repos!.map((r) => [r.title, r.itemCount, r.groups.map((g) => [g.title, g.rows.map((x) => `${'  '.repeat(x.depth)}${x.item.number}`)])]);
  /** what a group shows, without its key (keys carry the repository prefix) */
  const shown = (gs: Group[]) => gs.map((g) => ({ ...g, key: undefined, section: undefined, rows: g.rows.map((r) => [r.item.key, r.depth, r.under]) }));

  it('grouped by iteration: one section per repository, alphabetical, each with only its own iterations; an item in two iterations shows twice and counts once', () => {
    const t = buildTable([...items()].reverse(), [A, B], ALL(), TODAY);
    // expected by the rule, not copied from the output: x/app holds 10–14 (S2 and S3); x/lib holds 20 (S1 on Alpha, S2 on Beta), 21 (no iteration), 22 (S2)
    expect(nested(t)).toEqual([
      ['x/app', 5, [['S2', ['10', '  11', '    13', '  12']], ['S3', ['14']]]],
      ['x/lib', 3, [['S1', ['20']], ['S2', ['22', '20']], ['无迭代', ['21']]]],
    ]);
    // the count is distinct items, not the rows of its groups added up (x/lib shows 4 rows)
    expect(t.repos![1].groups.reduce((n, g) => n + g.rows.length, 0)).toBe(4);
    expect(t.groups).toEqual(t.repos!.flatMap((r) => r.groups));
    expect(t.itemCount).toBe(8);
  });

  it('a sub-issue in another repository is a top-level row in its own repository; without the layer it sat under its parent', () => {
    const layered = buildTable(items(), [A, B], ALL(), TODAY);
    const lib = layered.repos!.find((r) => r.title === 'x/lib')!;
    expect(lib.groups.find((g) => g.title === 'S2')!.rows.find((r) => r.item.number === 22)!.depth).toBe(0);
    const flatTable = buildTable(items(), [A, B], T(), TODAY);
    expect(flatTable.groups.find((g) => g.title === 'S2')!.rows.find((r) => r.item.number === 22)!.depth).toBe(1);
  });

  for (const groupBy of ['iteration', 'status', 'milestone', 'none'] as const) {
    for (const hierarchy of [true, false]) {
      it(`grouped by ${groupBy}, sub-issues ${hierarchy ? 'indented' : 'flat'}: each repository's groups show exactly what picking that repository shows`, () => {
        const t = buildTable(items(), [A, B], ALL({ groupBy, hierarchy }), TODAY, true);
        expect(t.repos!.map((r) => r.title)).toEqual(['x/app', 'x/lib']);
        for (const r of t.repos!) {
          const one = buildTable(items(), [A, B], ALL({ groupBy, hierarchy, slice: r.title }), TODAY, true);
          expect(one.repos).toBeNull();
          expect(shown(r.groups), r.title).toEqual(shown(one.groups));
          expect(r.itemCount).toBe(one.itemCount);
          for (const g of r.groups) expect(g.key.startsWith(`${r.key}|`)).toBe(true);
        }
      });
    }
  }

  it('grouped by nothing: only the repository layer', () => {
    const t = buildTable(items(), [A, B], ALL({ groupBy: 'none', hierarchy: false }), TODAY);
    expect(t.repos!.map((r) => [r.title, r.groups.map((g) => g.key)])).toEqual([
      ['x/app', ['repo:x/app|all']],
      ['x/lib', ['repo:x/lib|all']],
    ]);
  });

  it('same-named groups in two repositories have different keys', () => {
    const t = buildTable(items(), [A, B], ALL(), TODAY);
    const s2 = t.groups.filter((g) => g.title === 'S2').map((g) => g.key);
    expect(s2).toHaveLength(2);
    expect(new Set(s2).size).toBe(2);
    expect(new Set(t.groups.map((g) => g.key)).size).toBe(t.groups.length);
    expect(new Set(t.groups.flatMap((g) => g.rows.map((r) => r.id))).size).toBe(t.groups.reduce((n, g) => n + g.rows.length, 0));
  });

  it('no repository layer when one repository is picked, when slicing is off, or when grouped by repository: the same table as before', () => {
    for (const patch of [{ slice: 'x/lib' }, { sliceByRepo: false }, { groupBy: 'repo' as const }, { groupBy: 'repo' as const, sliceByRepo: false }]) {
      const t = buildTable(items(), [A, B], ALL(patch), TODAY);
      expect(t.repos, JSON.stringify(patch)).toBeNull();
    }
    // with slicing off the groups mix repositories, exactly as the single-level rules above
    expect(flat(buildTable(items(), [A, B], ALL({ sliceByRepo: false }), TODAY))).toEqual([
      ['S1', ['20']],
      ['S2', ['10', '  22', '  11', '    13', '  12', '20']],
      ['S3', ['14']],
      ['无迭代', ['21']],
    ]);
    expect(buildTable(items(), [A, B], ALL({ groupBy: 'repo' }), TODAY).groups.map((g) => `${g.key}:${g.rows.length}`)).toEqual(['repo:x/app:5', 'repo:x/lib:3']);
    const picked = buildTable(items(), [A, B], ALL({ slice: 'X/LIB' }), TODAY);
    expect(picked.groups.map((g) => [g.key, g.title])).toEqual([
      [iterationColumnKey(A.iterations[0]), 'S1'],
      [iterationColumnKey(A.iterations[1]), 'S2'],
      [GROUP_NONE_KEY, '无迭代'],
    ]);
  });

  it('repository names that differ only in case are one repository, as in the slice list', () => {
    const t = buildTable([item('x/Lib', 1), item('B/z', 3), item('x/lib', 2), item('a/y', 4)], [], ALL({ groupBy: 'milestone' }), TODAY);
    expect(t.repos!.map((r) => [r.key, r.title, r.itemCount])).toEqual([
      ['repo:a/y', 'a/y', 1],
      ['repo:b/z', 'B/z', 1],
      ['repo:x/lib', 'x/Lib', 2],
    ]);
  });

  it('nothing left after filtering: no sections', () => {
    expect(buildTable([], [A, B], ALL(), TODAY)).toMatchObject({ repos: [], groups: [], itemCount: 0 });
  });
});

describe('GitHub#587: a repository source with nothing to show keeps its place in the table', () => {
  // sources as typed in Settings: x/app and X/LIB have items (X/LIB differs from GitHub's "x/lib" only in case),
  // x/new was read and has none, x/wait was never read
  const SRC: RepoSource[] = [
    { repo: 'x/app', read: true },
    { repo: 'X/LIB', read: true },
    { repo: 'x/new', read: true },
    { repo: 'x/wait', read: false },
  ];
  const ALL = (patch: Partial<TableSettings> = {}) => T({ sliceByRepo: true, slice: null, ...patch });
  const build = (settings: TableSettings, items = board(), sources: readonly RepoSource[] = SRC, order: string[] = []) =>
    buildTable(items, [A, B], settings, TODAY, false, order, items, sources);

  it('the slice list: every source once, whatever the case of its name; 0 for a read one, unknown for one never read', () => {
    expect(build(ALL()).slices).toEqual([
      { value: 'x/app', count: 5 },
      { value: 'x/lib', count: 2 },
      { value: 'x/new', count: 0 },
      { value: 'x/wait', count: 0, unread: true },
    ]);
    // two spellings of one repository on items are one entry too (GitHub's spelling, the first seen)
    expect(buildTable([item('x/Lib', 1), item('x/lib', 2)], [], ALL(), TODAY).slices).toEqual([{ value: 'x/Lib', count: 2 }]);
  });

  for (const groupBy of ['iteration', 'status', 'milestone', 'none'] as const) {
    it(`"all repositories", grouped by ${groupBy}: an empty section per such source, in the repository order`, () => {
      const t = build(ALL({ groupBy }));
      expect(t.repos!.map((r) => [r.key, r.title, r.itemCount, r.groups.length > 0, r.unread ?? false])).toEqual([
        ['repo:x/app', 'x/app', 5, true, false],
        ['repo:x/lib', 'x/lib', 2, true, false],
        ['repo:x/new', 'x/new', 0, false, false],
        ['repo:x/wait', 'x/wait', 0, false, true],
      ]);
      // the sections with items are exactly what they were without the sources
      expect(t.repos!.slice(0, 2)).toEqual(build(ALL({ groupBy }), board(), []).repos);
      expect(t.groups).toEqual(t.repos!.flatMap((r) => r.groups));
      expect(t.itemCount).toBe(7);
    });

    it(`one empty repository picked, grouped by ${groupBy}: no rows, the table names the repository`, () => {
      const t = build(ALL({ groupBy, slice: 'X/NEW' }));
      // (without a grouping the one group "全部" is there, as before, with no rows)
      expect(t).toMatchObject({ repos: null, itemCount: 0, blankRepo: { repo: 'x/new' } });
      expect(t.groups.flatMap((g) => g.rows)).toEqual([]);
      expect(build(ALL({ groupBy, slice: 'x/wait' })).blankRepo).toEqual({ repo: 'x/wait', unread: true });
      // a picked repository with items, or one that is no source: no such line
      expect(build(ALL({ groupBy, slice: 'x/lib' })).blankRepo).toBeUndefined();
      expect(build(ALL({ groupBy, slice: 'x/gone' })).blankRepo).toBeUndefined();
    });
  }

  it('grouped by repository (slicing on or off): an empty group per such source, carrying that repository for "+"', () => {
    for (const sliceByRepo of [false, true]) {
      const t = build(ALL({ groupBy: 'repo', sliceByRepo }));
      expect(t.groups.map((g) => [g.key, g.title, g.rows.length, g.preset, g.unread ?? false])).toEqual([
        ['repo:x/app', 'x/app', 5, { by: 'repo', repo: 'x/app' }, false],
        ['repo:x/lib', 'x/lib', 2, { by: 'repo', repo: 'x/lib' }, false],
        ['repo:x/new', 'x/new', 0, { by: 'repo', repo: 'x/new' }, false],
        ['repo:x/wait', 'x/wait', 0, { by: 'repo', repo: 'x/wait' }, true],
      ]);
    }
  });

  it('the saved repository order places them, as every other repository list', () => {
    const order = ['x/wait', 'x/lib', 'x/new'];
    expect(build(ALL(), board(), SRC, order).repos!.map((r) => r.title)).toEqual(['x/wait', 'x/lib', 'x/new', 'x/app']);
    expect(build(ALL(), board(), SRC, order).slices!.map((s) => s.value)).toEqual(['x/wait', 'x/lib', 'x/new', 'x/app']);
    expect(build(ALL({ groupBy: 'repo' }), board(), SRC, order).groups.map((g) => g.title)).toEqual(['x/wait', 'x/lib', 'x/new', 'x/app']);
  });

  it('a search that hides every item of a repository: the repository still has its place', () => {
    const t = buildTable([], [A, B], ALL(), TODAY, false, [], board(), SRC);
    expect(t.repos!.map((r) => [r.title, r.groups.length, r.unread ?? false])).toEqual([
      ['x/app', 0, false],
      ['X/LIB', 0, false],
      ['x/new', 0, false],
      ['x/wait', 0, true],
    ]);
    expect(t.itemCount).toBe(0);
  });

  it('no repository layer (slicing off, grouped by anything but repository): nothing added', () => {
    for (const groupBy of ['iteration', 'status', 'milestone', 'none'] as const) expect(build(T({ groupBy }))).toEqual(build(T({ groupBy }), board(), []));
  });

  it('every source has items: the table is the one built without sources, in every layout', () => {
    const covered: RepoSource[] = [{ repo: 'x/app', read: true }, { repo: 'x/lib', read: false }];
    for (const groupBy of ['iteration', 'status', 'milestone', 'repo', 'none'] as const)
      for (const patch of [{ sliceByRepo: false }, { sliceByRepo: true }, { sliceByRepo: true, slice: 'x/lib' }]) {
        const settings = ALL({ groupBy, ...patch });
        expect(build(settings, board(), covered), `${groupBy} ${JSON.stringify(patch)}`).toEqual(build(settings, board(), []));
      }
  });

  it('PR #594 review round 1: a repository whose only shown item is a PR placed under an issue elsewhere is not "nothing to show"', () => {
    // x/lib's only item is a PR naming x/app#1: with PRs under their issues it shows in x/app's place
    const items = [item('x/app', 1, { title: 'issue' }), item('x/lib', 2, { title: 'pr', kind: 'pr', refIssues: ['x/app#1'] })];
    const src: RepoSource[] = [{ repo: 'x/app', read: true }, { repo: 'x/lib', read: true }, { repo: 'x/new', read: true }];
    const run = (patch: Partial<TableSettings>) => buildTable(items, [], ALL(patch), TODAY, true, [], items, src);
    // the PR really does follow its issue (otherwise this case tests nothing)
    const sections = run({ groupBy: 'milestone' });
    expect(sections.repos!.find((r) => r.title === 'x/app')!.groups.flatMap((g) => g.rows.map((r) => r.item.key))).toEqual(['x/app#1', 'x/lib#2']);
    // no empty section or group for x/lib — only x/new, which has no item at all
    expect(sections.repos!.map((r) => [r.title, r.groups.length > 0])).toEqual([
      ['x/app', true],
      ['x/new', false],
    ]);
    const byRepo = run({ groupBy: 'repo' });
    expect(byRepo.groups.map((g) => [g.title, g.rows.map((r) => r.item.key)])).toEqual([
      ['x/app', ['x/app#1', 'x/lib#2']],
      ['x/new', []],
    ]);
    for (const sliceByRepo of [true, false]) expect(run({ groupBy: 'repo', sliceByRepo }).groups.map((g) => g.title)).toEqual(['x/app', 'x/new']);
    // the slice list counts the PR in its own repository, as before
    expect(sections.slices).toEqual([
      { value: 'x/app', count: 1 },
      { value: 'x/lib', count: 1 },
      { value: 'x/new', count: 0 },
    ]);
  });

  it('PR #594 review round 2: a repository whose only row is a sub-issue pulled in under a matched parent is not "nothing to show"', () => {
    // the search matches x/app#1 only; its sub-issue x/lib#5 did not match and comes in under it (show hierarchy)
    const parent = item('x/app', 1, { title: 'parent' });
    const child = item('x/lib', 5, { title: 'child', parent: 'x/app#1' });
    const src: RepoSource[] = [{ repo: 'x/app', read: true }, { repo: 'x/lib', read: true }, { repo: 'x/new', read: true }];
    const run = (patch: Partial<TableSettings>) => buildTable([parent], [], ALL({ hierarchy: true, ...patch }), TODAY, false, [], [parent, child], src);
    const sections = run({ groupBy: 'milestone' });
    // the child really is drawn, as a pulled row under its parent (otherwise this case tests nothing)
    const appRows = sections.repos!.find((r) => r.title === 'x/app')!.groups.flatMap((g) => g.rows);
    expect(appRows.map((r) => [r.item.key, r.depth, r.pulled])).toEqual([
      ['x/app#1', 0, false],
      ['x/lib#5', 1, true],
    ]);
    expect(sections.repos!.map((r) => [r.title, r.groups.length > 0])).toEqual([
      ['x/app', true],
      ['x/new', false],
    ]);
    for (const sliceByRepo of [true, false]) {
      const byRepo = run({ groupBy: 'repo', sliceByRepo });
      expect(byRepo.groups.map((g) => [g.title, g.rows.map((r) => r.item.key)])).toEqual([
        ['x/app', ['x/app#1', 'x/lib#5']],
        ['x/new', []],
      ]);
    }
    // the search counts keep their meaning: one match, one pulled row; the slice list counts matches only
    expect(sections).toMatchObject({ itemCount: 1, matchCount: 1, pulledCount: 1 });
    expect(sections.slices).toEqual([
      { value: 'x/app', count: 1 },
      { value: 'x/lib', count: 0 },
      { value: 'x/new', count: 0 },
    ]);
    // picking x/lib: nothing of its own matched, nothing is pulled into it — its line says so
    expect(run({ groupBy: 'none', slice: 'x/lib' }).blankRepo).toEqual({ repo: 'x/lib' });
  });

  it('every way an item reaches the table counts: a placed PR and a pulled sub-issue together, in both layouts', () => {
    const parent = item('x/app', 1, { title: 'parent' });
    const pr = item('x/lib', 2, { title: 'pr', kind: 'pr', refIssues: ['x/app#1'] });
    const child = item('x/doc', 3, { title: 'child', parent: 'x/app#1' });
    const src: RepoSource[] = ['x/app', 'x/lib', 'x/doc', 'x/new'].map((repo) => ({ repo, read: true }));
    for (const groupBy of ['milestone', 'repo'] as const) {
      const t = buildTable([parent, pr], [], ALL({ hierarchy: true, groupBy }), TODAY, true, [], [parent, pr, child], src);
      const drawn = new Set(t.groups.flatMap((g) => g.rows.map((r) => r.item.key)));
      expect([...drawn].sort(), groupBy).toEqual(['x/app#1', 'x/doc#3', 'x/lib#2']);
      const empty = groupBy === 'repo' ? t.groups.filter((g) => g.rows.length === 0).map((g) => g.title) : t.repos!.filter((r) => r.groups.length === 0).map((r) => r.title);
      expect(empty, groupBy).toEqual(['x/new']);
    }
  });

  it('PR #594 review round 1: a folded run never adds an unknown count in as 0', () => {
    const t = build(ALL({ groupBy: 'repo' }), board(), [...SRC, { repo: 'x/wait2', read: false }]);
    const all = new Set(t.groups.map((g) => g.key));
    const runs = foldRuns(t.groups, all);
    expect(runs.map((r) => r.kind)).toEqual(['folded']);
    const run = runs[0] as Extract<(typeof runs)[number], { kind: 'folded' }>;
    // read and never-read groups folded together: the known rows, and how many are unknown
    expect(foldTally(run.groups)).toEqual({ rows: 7, unknown: 2 });
    // two never-read groups alone: nothing known
    const unread = t.groups.filter((g) => g.unread);
    expect(unread).toHaveLength(2);
    expect(foldTally(unread)).toEqual({ rows: 0, unknown: 2 });
    // read ones only: the plain sum, as before
    expect(foldTally(t.groups.filter((g) => !g.unread))).toEqual({ rows: 7, unknown: 0 });
  });

  it('which sources count: repository sources shown on the board; read = has a snapshot', () => {
    const sources = [
      parseSource('x/app')!,
      parseSource('https://github.com/orgs/x/projects/1')!,
      parseSource('X/New')!,
      parseSource('x/off')!,
    ];
    const times = [
      { sourceKey: 'repo:x/app', readAt: 1 },
      { sourceKey: 'repo:x/new', readAt: null },
    ];
    expect(repoSources(sources, null, times)).toEqual([
      { repo: 'x/app', read: true },
      { repo: 'X/New', read: false },
      { repo: 'x/off', read: false },
    ]);
    expect(repoSources(sources, ['repo:x/app', 'project:org/x/1', 'repo:x/new'], times)).toEqual([
      { repo: 'x/app', read: true },
      { repo: 'X/New', read: false },
    ]);
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

  it('GitHub#464: the filter is taken as written, without the words that only hid finished items', () => {
    const at = (query: string) => ({ ...DEFAULT_VIEW, query });
    expect(DEFAULT_QUERY).toBe('');
    expect(importView(view({ filter: '' }), P, at(DEFAULT_QUERY), null).query).toBe('');
    expect(importView(view({ filter: '   ' }), P, at(DEFAULT_QUERY), null).query).toBe('');
    expect(importView(view({ filter: '-label:Done -status:Done' }), P, at(DEFAULT_QUERY), null).query).toBe('');
    expect(importView(view({ filter: 'is:open -Status:done' }), P, at('label:x'), null).query).toBe('');
    expect(importView(view({ filter: '-label:Done label:bug' }), P, at(DEFAULT_QUERY), null).query).toBe('label:bug');
    expect(importView(view({ filter: 'label:bug' }), P, at(DEFAULT_QUERY), null).query).toBe('label:bug');
    expect(importView(view({ filter: 'is:closed' }), P, at(DEFAULT_QUERY), null).query).toBe('is:closed');
    expect(importView(view({ filter: '' }), P, at('label:bug'), null).query).toBe('');
  });

  it('a view without sort = the Project order; slices and hierarchy (not in the API) go back to on, the picked slice is reset', () => {
    const r = importView(view({}), P, { ...DEFAULT_VIEW, table: { ...DEFAULT_TABLE, slice: 'x/a', sliceByRepo: false, hierarchy: false } }, null);
    expect(r.table.sort).toEqual({ field: 'manual', dir: 'asc' });
    expect(r.table).toMatchObject({ slice: null, sliceByRepo: true, hierarchy: true });
  });
});

// keep the recorded-data helper honest about the fixture day it relies on
it('fixture day', () => expect(FIXTURE_TODAY).toBe(new Date(FIXTURE_NOW).toISOString().slice(0, 10)));

describe('the view\'s sort applies to the board too', () => {
  const P = { ...project('project:org/x/9', 'P', null, ['Todo', 'Done']), views: [] as any[] };
  const items = [
    item('x/a', 1, { updatedAt: '2026-11-05T00:00:00Z' }, [member(P, null, 'Todo')]),
    item('x/a', 2, { updatedAt: '2026-11-01T00:00:00Z' }, [member(P, null, 'Todo')]),
    item('x/a', 3, { updatedAt: '2026-11-03T00:00:00Z' }, [member(P, null, 'Todo')]),
  ];
  const cards = (b: ReturnType<typeof buildBoard>) => b.columns.find((c) => c.title === 'Todo')!.cards.map((c) => c.item.number);

  it('import a board view sorted by "updated, newest first" → the board shows newest first', () => {
    const v = { number: 2, name: 'b', layout: 'BOARD_LAYOUT', filter: '', groupBy: [], verticalGroupBy: [{ name: 'Status', dataType: 'SINGLE_SELECT' }], sortBy: [{ field: { name: 'Updated', dataType: 'UPDATED' }, direction: 'DESC' }], fields: [] } as any;
    const patch = importView(v, P, DEFAULT_VIEW, null);
    expect(patch).toMatchObject({ layout: 'board', mode: 'status' });
    expect(patch.imported!.notes).toEqual([]);
    // the same call the board page makes
    expect(cards(buildBoard(items, [P], patch.mode, patch.swimlanes, TODAY, patch.table.sort))).toEqual([1, 3, 2]);
    expect(cards(buildBoard(items, [P], 'status', false, TODAY, { field: 'updated', dir: 'asc' }))).toEqual([2, 3, 1]);
  });

  it('no sort given (older callers): repository, then newest number first, as before', () => {
    expect(cards(buildBoard(items, [P], 'status', false, TODAY))).toEqual([3, 2, 1]);
  });
});

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
