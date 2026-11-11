// GitHub#368: with "show hierarchy" on, a matched issue keeps its sub-issues in the table even when
// they do not match the search ("pulled" rows, faded). The cases are the five of the design that
// the plan review settled on (cross-group, counts and repository slices, cycles, a chain through a
// sliced-away repository, several levels), plus an invariant over random parent links.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildTable, validParents, type Table } from '../../src/data/table';
import { PULLED_TITLE, TableView } from '../../src/renderer/TableView';
import { DEFAULT_TABLE, DEFAULT_VIEW } from '../../src/shared/viewSettings';
import type { Item, TableSettings } from '../../src/shared/types';
import { item, iter, member, project } from './helpers';

const TODAY = '2026-11-05';
const P = project('project:org/o/1', 'P', [iter('I1', '2026-11-03', 7), iter('I2', '2026-11-10', 7), iter('I3', '2026-11-17', 7)], ['进行中', '已完成']);
const Q = project('project:org/o/2', 'Q', [iter('I2', '2026-11-10', 7)], ['进行中', '已完成']);
const T = (patch: Partial<TableSettings> = {}): TableSettings => ({ ...DEFAULT_TABLE, sliceByRepo: false, hierarchy: true, sort: { field: 'number', dir: 'asc' }, ...patch });

/** the table the board builds: `matched` are the search results among `all` */
function build(all: Item[], matched: number[], settings: TableSettings, projects = [P, Q]): Table {
  const items = all.filter((it) => matched.includes(it.number));
  return buildTable(items, projects, settings, TODAY, false, [], all);
}
/** rows as "<indent><number>", a pulled row marked with * */
const rows = (rows: Table['groups'][number]['rows']) => rows.map((r) => `${'  '.repeat(r.depth)}${r.item.number}${r.pulled ? '*' : ''}`);
const shown = (t: Table) => t.groups.map((g) => [g.title, rows(g.rows)]);

describe('GitHub#368: sub-issues stay under a matched parent', () => {
  it('example 1, across groups: a pulled row follows its direct parent row; a matched sub-issue stays in its own group and ends the walk', () => {
    // A (1) and B (2) match; D (4) and C (3) do not. B and D are A's, C is B's. A is 进行中, the rest 已完成.
    const all = [
      item('o/a', 1, {}, [member(P, null, '进行中')]),
      item('o/a', 2, { parent: 'o/a#1' }, [member(P, null, '已完成')]),
      item('o/a', 3, { parent: 'o/a#2' }, [member(P, null, '已完成')]),
      item('o/a', 4, { parent: 'o/a#1' }, [member(P, null, '已完成')]),
    ];
    const t = build(all, [1, 2], T({ groupBy: 'status' }));
    expect(shown(t)).toEqual([
      ['进行中', ['1', '  4*']],
      ['已完成', ['2', '  3*']],
    ]);
    expect(t.pulledCount).toBe(2);
    expect(t.matchCount).toBe(2);
  });

  it('example 1, a parent in two groups (two Projects): the pulled sub-issue shows in both and counts once', () => {
    const all = [item('o/a', 1, {}, [member(P, P.iterations[0]), member(Q, Q.iterations[0])]), item('o/a', 4, { parent: 'o/a#1' }, [member(P, P.iterations[2])])];
    const t = build(all, [1], T({ groupBy: 'iteration' }));
    expect(shown(t)).toEqual([
      ['I1', ['1', '  4*']],
      ['I2', ['1', '  4*']],
    ]);
    expect(t.pulledCount).toBe(1);
  });

  describe('example 2: counts, and the repository list on the left', () => {
    // 甲 (o/jia): P1 matches, in I1 (Project P) and I2 (Project Q); c1, c2 its sub-issues do not match.
    // 乙 (o/yi): P2 matches with sub-issue d1 not matching; Q matches, no sub-issues; x1 is P1's sub-issue, not matching.
    const all = () => [
      item('o/jia', 1, { title: 'P1' }, [member(P, P.iterations[0]), member(Q, Q.iterations[0])]),
      item('o/jia', 2, { title: 'c1', parent: 'o/jia#1' }, [member(P, P.iterations[0])]),
      item('o/jia', 3, { title: 'c2', parent: 'o/jia#1' }, [member(P, P.iterations[0])]),
      item('o/yi', 4, { title: 'x1', parent: 'o/jia#1' }, [member(P, P.iterations[0])]),
      item('o/yi', 5, { title: 'P2' }, [member(P, P.iterations[0])]),
      item('o/yi', 6, { title: 'd1', parent: 'o/yi#5' }, [member(P, P.iterations[0])]),
      item('o/yi', 7, { title: 'Q' }, [member(P, P.iterations[0])]),
    ];
    const MATCHED = [1, 5, 7];
    const S = (slice: string | null) => T({ groupBy: 'iteration', sliceByRepo: true, slice });
    const counts = (t: Table) => ({
      groups: t.groups.map((g) => g.rows.length),
      repos: t.repos?.map((r) => [r.title, r.itemCount]) ?? null,
      slices: t.slices!.map((s) => [s.value, s.count]),
      matchCount: t.matchCount,
      pulledCount: t.pulledCount,
    });

    it('searching, every repository: sub-issues from another repository go under their parent, counts as in the design', () => {
      const t = build(all(), MATCHED, S(null));
      expect(t.repos!.map((r) => [r.title, r.groups.map((g) => [g.title, rows(g.rows)])])).toEqual([
        ['o/jia', [['I1', ['1', '  2*', '  3*', '  4*']], ['I2', ['1', '  2*', '  3*', '  4*']]]],
        ['o/yi', [['I1', ['5', '  6*', '7']]]],
      ]);
      expect(counts(t)).toEqual({ groups: [4, 4, 3], repos: [['o/jia', 4], ['o/yi', 3]], slices: [['o/jia', 1], ['o/yi', 2]], matchCount: 3, pulledCount: 4 });
      // two folded groups next to each other say "共 8 条": the rows of both
      expect(t.repos![0].groups.reduce((n, g) => n + g.rows.length, 0)).toBe(8);
    });

    it('searching, 甲 picked: x1 (in 乙) is not shown; the search count and the repository list still count every repository', () => {
      const t = build(all(), MATCHED, S('o/jia'));
      expect(shown(t)).toEqual([
        ['I1', ['1', '  2*', '  3*']],
        ['I2', ['1', '  2*', '  3*']],
      ]);
      expect(counts(t)).toEqual({ groups: [3, 3], repos: null, slices: [['o/jia', 1], ['o/yi', 2]], matchCount: 3, pulledCount: 2 });
    });

    it('searching, 乙 picked: x1 has no parent row to go under, so it is not shown', () => {
      const t = build(all(), MATCHED, S('o/yi'));
      expect(shown(t)).toEqual([['I1', ['5', '  6*', '7']]]);
      expect(counts(t)).toEqual({ groups: [3], repos: null, slices: [['o/jia', 1], ['o/yi', 2]], matchCount: 3, pulledCount: 1 });
    });

    it('back to every repository: the same table as before', () => {
      expect(build(all(), MATCHED, S(null))).toEqual(build(all(), MATCHED, S(null)));
      expect(counts(build(all(), MATCHED, S(null))).pulledCount).toBe(4);
    });

    it('search cleared: exactly the table without this change, for every repository and for 甲 alone', () => {
      for (const slice of [null, 'o/jia', 'o/yi']) {
        const now = buildTable(all(), [P, Q], S(slice), TODAY, false, [], all());
        const before = buildTable(all(), [P, Q], S(slice), TODAY, false, []);
        expect(now, String(slice)).toEqual(before);
        expect(now.pulledCount).toBe(0);
        expect(now.groups.flatMap((g) => g.rows).some((r) => r.pulled)).toBe(false);
      }
      // 甲 alone, no search: x1 (in 乙) stays out, as it always did
      expect(shown(buildTable(all(), [P, Q], S('o/jia'), TODAY, false, [], all()))).toEqual([
        ['I1', ['1', '  2', '  3']],
        ['I2', ['1']],
      ]);
    });
  });

  it('example 3, parent links on a cycle count for nobody: no faded top-level row', () => {
    const cyc = [item('o/a', 1, { parent: 'o/a#2' }), item('o/a', 2, { parent: 'o/a#1' })];
    let t = build(cyc, [1], T({ groupBy: 'none' }));
    expect(shown(t)).toEqual([['全部', ['1']]]);
    expect(t.pulledCount).toBe(0);
    t = build([...cyc, item('o/a', 3, { parent: 'o/a#1' })], [1], T({ groupBy: 'none' }));
    expect(shown(t)).toEqual([['全部', ['1', '  3*']]]);
    expect(t.pulledCount).toBe(1);
    expect(validParents(cyc)).toEqual(new Map());
  });

  it('example 4, 甲 → 乙 → 甲: the walk stops at the sub-issue the picked repository leaves out', () => {
    const all = [item('o/jia', 1), item('o/yi', 2, { parent: 'o/jia#1' }), item('o/jia', 3, { parent: 'o/yi#2' })];
    const S = (slice: string | null) => T({ groupBy: 'none', sliceByRepo: true, slice });
    const every = build(all, [1], S(null));
    expect(every.repos!.map((r) => [r.title, r.itemCount, r.groups.map((g) => rows(g.rows))])).toEqual([['o/jia', 3, [['1', '  2*', '    3*']]]]);
    expect(every.pulledCount).toBe(2);
    const jia = build(all, [1], S('o/jia'));
    expect(shown(jia)).toEqual([['全部', ['1']]]);
    expect(jia.pulledCount).toBe(0);
    const yi = build(all, [1], S('o/yi'));
    expect(yi.groups.flatMap((g) => g.rows)).toEqual([]);
    expect(yi.pulledCount).toBe(0);
  });

  it('example 5, several levels: both pulled rows are faded and say why, in words right for a grandchild too', () => {
    const all = [item('o/a', 1), item('o/a', 2, { parent: 'o/a#1' }), item('o/a', 3, { parent: 'o/a#2' })];
    const t = build(all, [1], T({ groupBy: 'none' }));
    expect(shown(t)).toEqual([['全部', ['1', '  2*', '    3*']]]);
    expect(t.pulledCount).toBe(2);
    const view = { ...DEFAULT_VIEW, layout: 'table' as const, table: T({ groupBy: 'none' }) };
    const html = renderToStaticMarkup(createElement(TableView, { items: all.slice(0, 1), projects: [], view, today: TODAY, now: Date.parse('2026-11-05T00:00:00Z'), onOpen: () => {}, table: t }));
    const tr = [...html.matchAll(/<tr [^>]*data-testid="row"[^>]*>/g)].map((m) => m[0]);
    expect(tr).toHaveLength(3);
    expect(tr[0]).not.toContain('data-pulled');
    for (const r of tr.slice(1)) {
      expect(r).toContain('data-pulled=""');
      expect(r).toContain('class="pulled"');
      expect(r).toContain(`title="${PULLED_TITLE}"`);
    }
    expect(PULLED_TITLE).toBe('此条目不符合搜索条件；因上层有命中的 issue 而显示');
  });

  it('only a sub-issue matches: as before, a top-level row; hierarchy off: nothing pulled', () => {
    const all = [item('o/a', 1), item('o/a', 2, { parent: 'o/a#1' }), item('o/a', 3, { parent: 'o/a#2' })];
    expect(shown(build(all, [2], T({ groupBy: 'none' })))).toEqual([['全部', ['2', '  3*']]]);
    const off = build(all, [1], T({ groupBy: 'none', hierarchy: false }));
    expect(shown(off)).toEqual([['全部', ['1']]]);
    expect(off).toEqual(buildTable(all.slice(0, 1), [P, Q], T({ groupBy: 'none', hierarchy: false }), TODAY, false, []));
  });

  it('invariant over random parent links (cycles included): every pulled row sits right under its direct parent, in the same group', () => {
    let seed = 368;
    let pulledSeen = 0;
    const rnd = (n: number) => {
      // xorshift32: small, deterministic, and every bit of it varies
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) % n;
    };
    for (let round = 0; round < 300; round++) {
      const n = 3 + rnd(14);
      const repos = ['o/jia', 'o/yi'];
      const keyed = Array.from({ length: n }, (_, i) => {
        const repo = ['o/jia', 'o/yi'][rnd(2)];
        const it = item(repo, i + 1, {}, [member(P, rnd(3) === 0 ? null : P.iterations[rnd(2)], rnd(2) ? '进行中' : '已完成')]);
        return { ...it, parentNo: rnd(4) === 0 ? 0 : 1 + rnd(n) };
      }).map(({ parentNo, ...it }, _i, list) => ({ ...it, parent: parentNo ? list[parentNo - 1].repo.toLowerCase() + `#${parentNo}` : null }));
      const matched = keyed.filter(() => rnd(3) === 0).map((it) => it.number);
      const groupBy = (['none', 'status', 'iteration'] as const)[rnd(3)];
      const slice = [null, 'o/jia', 'o/yi'][rnd(3)];
      const sliceByRepo = rnd(2) === 0;
      const t = build(keyed, matched, T({ groupBy, sliceByRepo, slice: sliceByRepo ? slice : null }));
      const parents = validParents(keyed);
      const pulledKeys = new Set<string>();
      for (const g of t.groups) {
        g.rows.forEach((r, i) => {
          if (!r.pulled) return;
          pulledKeys.add(r.item.key);
          expect(matched).not.toContain(r.item.number);
          expect(r.depth).toBeGreaterThan(0);
          // the nearest row above one level up is its direct parent
          let j = i - 1;
          while (j >= 0 && g.rows[j].depth >= r.depth) j--;
          expect(j, `round ${round}`).toBeGreaterThanOrEqual(0);
          expect(g.rows[j].depth).toBe(r.depth - 1);
          expect(g.rows[j].item.key).toBe(parents.get(r.item.key));
          if (sliceByRepo && slice) expect(r.item.repo).toBe(slice);
        });
        expect(new Set(g.rows.map((r) => r.item.key)).size, 'no row twice in a group').toBe(g.rows.length);
      }
      expect(t.pulledCount).toBe(pulledKeys.size);
      expect(t.matchCount).toBe(matched.length);
      pulledSeen += pulledKeys.size;
    }
    // the rounds did produce pulled rows to check
    expect(pulledSeen).toBeGreaterThan(100);
  });
});
