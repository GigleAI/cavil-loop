// GitHub#622: a search (a lit view-bar number included) that matches a PR but not the issue it belongs to
// shows that issue too, faded, with the PR under it. One rule for the board and the table (`carryIssues`):
// a PR that already goes under a matched issue keeps it; otherwise the first eligible linked issue that did
// not match is carried — eligibility asked of the issue whose value places it (the matched issue above it
// when the table's hierarchy already brings it in, else itself). The cases are the design's three scenarios
// (one group with both reasons on one row, a parent in two groups, a carried issue that brings nothing below
// it) plus the rules around them (no move, eligibility order, repository pick, nothing when off).

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildBoard } from '../../src/data/board';
import { carryIssues } from '../../src/data/prNest';
import { buildTable, type Table } from '../../src/data/table';
import { CARRIED_TITLE, PULLED_TITLE, TableView, fadedTitle } from '../../src/renderer/TableView';
import { DEFAULT_TABLE, DEFAULT_VIEW } from '../../src/shared/viewSettings';
import type { Item, TableSettings } from '../../src/shared/types';
import { item, member, project } from './helpers';

const TODAY = '2026-11-21';
const A = project('project:org/o/1', '甲', null, ['Todo', 'In Progress', 'Done']);
const B = project('project:org/o/2', '乙', null, ['Todo', 'In Progress', 'Done']);
const T = (patch: Partial<TableSettings> = {}): TableSettings => ({ ...DEFAULT_TABLE, sliceByRepo: false, hierarchy: true, groupBy: 'status', sort: { field: 'number', dir: 'asc' }, ...patch });
const pr = (repo: string, n: number, refs: string[], extra: Partial<Item> = {}, ms: Item['projects'] = []) =>
  item(repo, n, { kind: 'pr', url: `https://github.com/${repo}/pull/${n}`, refIssues: refs, ...extra }, ms);

/** the table the board builds: `matched` (numbers) are the search results among `all` */
function table(all: Item[], matched: number[], settings: TableSettings, carry = true, prs = true, projects = [A, B]): Table {
  const items = all.filter((it) => matched.includes(it.number));
  return buildTable(items, projects, settings, TODAY, prs, [], all, [], carry);
}
/** rows as "<indent><number><marks>": * pulled (sub-issue reason), + carried (PR reason), ↳ a PR under an issue */
const rows = (t: Table) =>
  t.groups.map((g) => [g.title, g.rows.map((r) => `${'  '.repeat(r.depth)}${r.under ? '↳' : ''}${r.item.number}${r.pulled ? '*' : ''}${r.carried ? '+' : ''}`)]);
const counts = (t: Table) => ({
  groups: t.groups.map((g) => g.rows.length),
  sections: t.repos?.map((r) => r.itemCount) ?? null,
  matched: t.matchCount,
  pulled: t.pulledCount,
  carried: t.carriedCount,
});

describe('GitHub#622 scenario 1: one group, one issue with both reasons', () => {
  // #346 and PR #625 and #623 match; #349 is #346's sub-issue and PR #625's issue; #350 is #349's sub-issue
  const all = [
    item('o/a', 346, {}, [member(A, null, 'Todo')]),
    item('o/a', 349, { parent: 'o/a#346' }, [member(A, null, 'In Progress')]),
    item('o/a', 350, { parent: 'o/a#349' }, [member(A, null, 'Todo')]),
    item('o/a', 623, {}, [member(A, null, 'Todo')]),
    pr('o/a', 625, ['o/a#349'], {}, [member(A, null, 'In Progress')]),
  ];
  it('#349 is drawn once under #346 with both reasons, the PR goes under it, #350 stays; every count as in the design', () => {
    const t = table(all, [346, 623, 625], T({ sliceByRepo: true, slice: null }));
    expect(rows(t)).toEqual([['Todo', ['346', '  349*+', '    ↳625', '    350*', '623']]]);
    expect(counts(t)).toEqual({ groups: [5], sections: [5], matched: 3, pulled: 2, carried: 1 });
  });
  it('the sub-issue reason is counted exactly as without carrying (same input)', () => {
    const before = table(all, [346, 623, 625], T(), false);
    const after = table(all, [346, 623, 625], T());
    expect(after.pulledCount).toBe(before.pulledCount);
    expect(before.carriedCount).toBe(0);
  });
});

describe('GitHub#622 scenario 2: the parent issue sits in two groups', () => {
  // #346 matches and is Todo on 甲, Done on 乙; #349 (its sub-issue) does not match; PR #625 matches, names #349
  const all = (sub349: Item['projects'] = []) => [
    item('o/a', 346, {}, [member(A, null, 'Todo'), member(B, null, 'Done')]),
    item('o/a', 349, { parent: 'o/a#346' }, sub349),
    pr('o/a', 625, ['o/a#349']),
  ];
  it('#349 comes along in both groups and the PR follows it into both; the section counts each item once', () => {
    const t = table(all(), [346, 625], T({ sliceByRepo: true, slice: null }));
    expect(rows(t)).toEqual([
      ['Todo', ['346', '  349*+', '    ↳625']],
      ['Done', ['346', '  349*+', '    ↳625']],
    ]);
    expect(counts(t)).toEqual({ groups: [3, 3], sections: [3], matched: 2, pulled: 1, carried: 1 });
  });
  it('#349 on no Project at all still qualifies: the matched #346 decides where it goes', () => {
    expect(rows(table(all(), [346, 625], T()))).toEqual(rows(table(all([member(A, null, 'In Progress')]), [346, 625], T())));
  });
});

describe('GitHub#622 scenario 3: an issue carried only for its PR brings nothing below it', () => {
  it('D carries PR Q; its sub-issue E stays hidden; descendants a matched parent brings in still show', () => {
    const all = [
      item('o/a', 10, {}, [member(A, null, 'Todo')]),
      item('o/a', 11, { parent: 'o/a#10' }, [member(A, null, 'Todo')]),
      pr('o/a', 12, []),
      item('o/a', 20, {}, [member(A, null, 'Todo')]),
      item('o/a', 21, { parent: 'o/a#20' }, [member(A, null, 'Todo')]),
    ];
    // GitHub's own link (the issue's "Linked pull requests") counts as well as the PR's description
    all[0] = { ...all[0], linkedPrs: [{ key: 'o/a#12', repo: 'o/a', number: 12, url: '', state: 'open' }] };
    const t = table(all, [12, 20], T({ sliceByRepo: true, slice: null }));
    expect(rows(t)).toEqual([['Todo', ['10+', '  ↳12', '20', '  21*']]]);
    expect(counts(t)).toEqual({ groups: [4], sections: [4], matched: 2, pulled: 1, carried: 1 });
    expect(t.pulledCount).toBe(table(all, [12, 20], T(), false).pulledCount);
  });
});

describe('GitHub#622: which issue comes along', () => {
  const issue = (n: number, extra: Partial<Item> = {}, ms = [member(A, null, 'Todo')]) => item('o/a', n, extra, ms);
  it('the issue matched too: nothing is carried, the table is what it was', () => {
    const all = [issue(1), pr('o/a', 2, ['o/a#1'])];
    expect(table(all, [1, 2], T())).toEqual(table(all, [1, 2], T(), false));
  });
  it('a PR already under a matched issue is never moved, even when an unmatched linked issue sorts first', () => {
    const all = [issue(1), issue(5), pr('o/a', 9, ['o/a#1', 'o/a#5'])];
    const t = table(all, [5, 9], T());
    expect(rows(t)).toEqual([['Todo', ['5', '  ↳9']]]);
    expect(t.carriedCount).toBe(0);
  });
  it('the first linked issue that may take a PR: one on no selected Project is skipped; none eligible = the PR alone', () => {
    const all = [issue(1, {}, []), issue(2), pr('o/a', 9, ['o/a#1', 'o/a#2'], {}, [member(A, null, 'Done')])];
    expect(rows(table(all, [9], T()))).toEqual([['Todo', ['2+', '  ↳9']]]);
    const none = [issue(1, {}, []), pr('o/a', 9, ['o/a#1'], {}, [member(A, null, 'Done')])];
    expect(rows(table(none, [9], T()))).toEqual([['Done', ['9']]]);
  });
  it('one picked repository: an issue in another repository is not carried; every repository: it is, and the PR goes to its section', () => {
    const all = [item('o/b', 1, {}, [member(A, null, 'Todo')]), pr('o/a', 9, ['o/b#1'], {}, [member(A, null, 'Done')])];
    const one = table(all, [9], T({ sliceByRepo: true, slice: 'o/a' }));
    expect(rows(one)).toEqual([['Done', ['9']]]);
    expect(one.carriedCount).toBe(0);
    const every = table(all, [9], T({ sliceByRepo: true, slice: null }));
    expect(every.repos!.map((r) => [r.title, r.groups.map((g) => g.rows.map((x) => x.item.number))])).toEqual([['o/b', [[1, 9]]]]);
    expect(every.slices!.map((s) => [s.value, s.count])).toEqual([['o/a', 1]]);
  });
  it('a closed issue comes along too (it only explains the PR)', () => {
    const all = [issue(1, { state: 'closed', stateReason: 'completed' }), pr('o/a', 9, ['o/a#1'])];
    expect(rows(table(all, [9], T()))).toEqual([['Todo', ['1+', '  ↳9']]]);
  });
  it('not searching, or PRs not under issues: exactly the table and board of before', () => {
    const all = [issue(1), pr('o/a', 9, ['o/a#1'])];
    expect(table(all, [9], T(), true, false)).toEqual(table(all, [9], T(), false, false));
    expect(buildBoard([all[1]], [A], 'status', false, TODAY, undefined, false, [], all)).toEqual(buildBoard([all[1]], [A], 'status', false, TODAY, undefined, false, [], null));
  });
});

describe('GitHub#622: one set of links for hosting and carrying (same input, both entries)', () => {
  // I is linked to three PRs: P through GitHub's "Linked pull requests" only, Q through Q's description only,
  // R through both. Matched, I hosts all three (the existing rule); hidden by the search, I is carried for all three.
  const I = item('o/a', 1, { linkedPrs: [{ key: 'o/a#2', repo: 'o/a', number: 2, url: '', state: 'open' }, { key: 'o/a#4', repo: 'o/a', number: 4, url: '', state: 'open' }] }, [member(A, null, 'Todo')]);
  const all = [I, pr('o/a', 2, []), pr('o/a', 3, ['o/a#1']), pr('o/a', 4, ['o/a#1'])];
  const under = (t: Table) => t.groups.flatMap((g) => g.rows.filter((r) => r.under).map((r) => [r.item.number, r.under]));
  it('issue matched: every PR goes under it, whichever source links it', () => {
    expect(under(table(all, [1, 2, 3, 4], T()))).toEqual([[2, 'o/a#1'], [3, 'o/a#1'], [4, 'o/a#1']]);
  });
  it('issue not matched: it is carried for every one of them, the same three', () => {
    const t = table(all, [2, 3, 4], T());
    expect(under(t)).toEqual([[2, 'o/a#1'], [3, 'o/a#1'], [4, 'o/a#1']]);
    expect(rows(t)).toEqual([['Todo', ['1+', '  ↳2', '  ↳3', '  ↳4']]]);
    expect(t.carriedCount).toBe(1);
  });
  it('carryIssues: the same three hosts on the board input as on the table input', () => {
    const c = carryIssues({ shown: all.slice(1), matched: new Set(['o/a#2', 'o/a#3', 'o/a#4']), all, order: (a, b) => a.number - b.number, canHost: () => true, repo: null });
    expect([...c.hosts]).toEqual([['o/a#2', 'o/a#1'], ['o/a#3', 'o/a#1'], ['o/a#4', 'o/a#1']]);
    const board = buildBoard(all.slice(1), [A], 'status', false, TODAY, { field: 'number', dir: 'asc' }, true, [], all);
    expect(board.columns.flatMap((col) => col.cards.filter((x) => x.under).map((x) => [x.item.number, x.under]))).toEqual([[2, 'o/a#1'], [3, 'o/a#1'], [4, 'o/a#1']]);
  });
});

describe('GitHub#622: the anchor is the hierarchy walk itself (same input, rows and counts)', () => {
  // A (o/a, matched) → X → B → C, all sub-issues not matched; PR P (matched) names B. A is Todo on 甲, Done on 乙.
  const chain = (xRepo = 'o/a', bRepo = 'o/a') => [
    item('o/a', 1, {}, [member(A, null, 'Todo'), member(B, null, 'Done')]),
    item(xRepo, 2, { parent: 'o/a#1' }, [member(A, null, 'In Progress')]),
    item(bRepo, 3, { parent: `${xRepo.toLowerCase()}#2` }, [member(A, null, 'In Progress')]),
    item('o/a', 4, { parent: `${bRepo.toLowerCase()}#3` }, [member(A, null, 'Todo')]),
    pr('o/a', 9, [`${bRepo.toLowerCase()}#3`]),
  ];
  it('several levels, two groups: B is pulled two levels down in both groups with both reasons, P under it, C below', () => {
    const t = table(chain(), [1, 9], T({ sliceByRepo: true, slice: null }));
    const g = ['1', '  2*', '    3*+', '      ↳9', '      4*'];
    expect(rows(t)).toEqual([['Todo', g], ['Done', g]]);
    expect(counts(t)).toEqual({ groups: [5, 5], sections: [5], matched: 2, pulled: 3, carried: 1 });
    // the walk with and without carrying pulls the same rows (P aside)
    const off = table(chain(), [1, 9], T({ sliceByRepo: true, slice: null }), false);
    expect(off.pulledCount).toBe(t.pulledCount);
  });
  it('across repositories, every repository: the walk crosses, so does the anchor; the PR joins A\'s section', () => {
    const t = table(chain('o/b', 'o/b'), [1, 9], T({ sliceByRepo: true, slice: null }));
    expect(t.repos!.map((r) => [r.title, r.itemCount])).toEqual([['o/a', 5]]);
    expect(rows(t)).toEqual([['Todo', ['1', '  2*', '    3*+', '      ↳9', '      4*']], ['Done', ['1', '  2*', '    3*+', '      ↳9', '      4*']]]);
  });
  it('one repository picked and the chain leaves it: no walk past X, so B has no anchor and comes along by its own value', () => {
    // X in o/b cuts the walk; B is in o/a, so it may still be carried — placed by its own status
    const t = table(chain('o/b', 'o/a'), [1, 9], T({ sliceByRepo: true, slice: 'o/a' }));
    expect(rows(t)).toEqual([['Todo', ['1']], ['In Progress', ['3+', '  ↳9']], ['Done', ['1']]]);
    expect(counts(t)).toEqual({ groups: [1, 2, 1], sections: null, matched: 2, pulled: 0, carried: 1 });
    // and when B itself is in the other repository, nothing is carried
    const out = table(chain('o/b', 'o/b'), [1, 9], T({ sliceByRepo: true, slice: 'o/a' }));
    expect(out.carriedCount).toBe(0);
    expect(rows(out)).toEqual([['Todo', ['1']], ['Done', ['1']], ['无状态', ['9']]]);
  });
});

describe('GitHub#622 on the board', () => {
  it('an issue in two columns (two Projects) is carried into both, the PR under it in each; columns count it, the board counts it once', () => {
    const all = [item('o/a', 1, {}, [member(A, null, 'Todo'), member(B, null, 'Done')]), pr('o/a', 9, ['o/a#1'])];
    const board = buildBoard([all[1]], [A, B], 'status', false, TODAY, { field: 'number', dir: 'asc' }, true, [], all);
    const cols = board.columns.filter((c) => c.cards.length).map((c) => [c.title, c.cards.map((x) => `${x.under ? '↳' : ''}${x.item.number}${x.carried ? '+' : ''}`)]);
    expect(cols).toEqual([
      ['Todo', ['1+', '↳9']],
      ['Done', ['1+', '↳9']],
    ]);
    expect(board.carriedCount).toBe(1);
  });
  it('nothing to carry from (no search): the PR stays where its own value puts it', () => {
    const all = [item('o/a', 1, {}, [member(A, null, 'Todo')]), pr('o/a', 9, ['o/a#1'], {}, [member(A, null, 'Done')])];
    const board = buildBoard([all[1]], [A], 'status', false, TODAY, undefined, true, [], null);
    expect(board.columns.filter((c) => c.cards.length).map((c) => [c.title, c.cards.map((x) => x.item.number)])).toEqual([['Done', [9]]]);
    expect(board.carriedCount).toBe(0);
  });
});

describe('GitHub#622 in the window', () => {
  it('a carried row is faded, tagged and says why; a row with both reasons says both', () => {
    const all = [
      item('o/a', 346, {}, [member(A, null, 'Todo')]),
      item('o/a', 349, { parent: 'o/a#346' }, [member(A, null, 'Todo')]),
      item('o/a', 10, {}, [member(A, null, 'Todo')]),
      pr('o/a', 625, ['o/a#349']),
      pr('o/a', 12, ['o/a#10']),
    ];
    const t = table(all, [346, 625, 12], T());
    const view = { ...DEFAULT_VIEW, layout: 'table' as const, table: T() };
    const html = renderToStaticMarkup(createElement(TableView, { items: all, projects: [A, B], view, today: TODAY, now: Date.parse('2026-11-21T00:00:00Z'), onOpen: () => {}, table: t }));
    const tr = (n: number) => html.match(new RegExp(`<tr [^>]*data-key="o/a#${n}"[^>]*>`))![0];
    expect(tr(10)).toContain('data-carried=""');
    expect(tr(10)).toContain('class="pulled"');
    expect(tr(10)).toContain(`title="${CARRIED_TITLE}"`);
    expect(tr(10)).not.toContain('data-pulled');
    expect(tr(349)).toContain('data-carried=""');
    expect(tr(349)).toContain('data-pulled=""');
    expect(fadedTitle({ pulled: true, carried: true })).toBe(`${PULLED_TITLE}\n${CARRIED_TITLE}`);
    expect(tr(346)).not.toContain('data-carried');
    expect((html.match(/data-testid="carried-tag"/g) ?? []).length).toBe(2);
    expect(CARRIED_TITLE).toBe('此 issue 不符合搜索条件；因下面有命中的 PR 而显示');
  });
});
