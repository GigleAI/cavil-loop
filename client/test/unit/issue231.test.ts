// GitHub#231: the pure rules behind "客户端优化 6" — iteration picker order, folded table groups,
// "托管" asking first, a new issue's default board, the group without a value going last.

import { describe, expect, it } from 'vitest';
import { iterationSections } from '../../src/shared/filter';
import { MAX_FOLDS_PER_GROUPING, normalizeAutopilotConfirm, normalizeTableFolds, setFold } from '../../src/shared/uiPrefs';
import { countRepos, defaultBoards } from '../../src/data/newIssueBoards';
import { buildTable } from '../../src/data/table';
import { DEFAULT_TABLE } from '../../src/shared/viewSettings';
import type { BoardRepoCount, Item, Iteration, ProjectMeta } from '../../src/shared/types';

const it7 = (n: number, startDate: string): Iteration => ({ id: `it${n}`, title: `Iteration ${n}`, startDate, duration: 7 });
/** Iteration 1 … 27, a week each, Iteration 1 starting 2026-05-04 (a Monday) */
const ALL = Array.from({ length: 27 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 4, 4 + 7 * i));
  return it7(i + 1, d.toISOString().slice(0, 10));
});
const TODAY = '2026-10-21'; // in Iteration 25 (10-19 … 10-25)
/** the order GitHub hands the field over in: completed latest first, then the others earliest first */
const FROM_GITHUB = [...ALL.slice(0, 24).reverse(), ...ALL.slice(24)];
const titles = (l: Iteration[]) => l.map((i) => i.title.replace('Iteration ', ''));

describe('iteration picker order (GitHub#231)', () => {
  it('the read order (24 … 1, 25, 26, 27 as in the report) becomes current → upcoming nearest first → ended latest first', () => {
    // the list as the old picker showed it: the bug in the report
    expect(titles(FROM_GITHUB).slice(0, 3)).toEqual(['24', '23', '22']);
    expect(titles(FROM_GITHUB).slice(-4)).toEqual(['1', '25', '26', '27']);
    const s = iterationSections(FROM_GITHUB, TODAY);
    expect(titles(s.current)).toEqual(['25']);
    expect(titles(s.upcoming)).toEqual(['26', '27']);
    expect(titles(s.ended)).toEqual(Array.from({ length: 24 }, (_, i) => String(24 - i)));
  });

  it('the same set in any read order gives the same picker; nothing is lost or doubled', () => {
    const want = iterationSections(FROM_GITHUB, TODAY);
    for (const order of [ALL, [...ALL].reverse(), [...ALL.slice(12), ...ALL.slice(0, 12)]]) expect(iterationSections(order, TODAY)).toEqual(want);
    const flat = [...want.current, ...want.upcoming, ...want.ended];
    expect(flat).toHaveLength(ALL.length);
    expect(new Set(flat.map((i) => i.id)).size).toBe(ALL.length);
  });

  it('day edges: the first day is current, the day after the last is ended; no current iteration in a gap', () => {
    expect(titles(iterationSections(ALL, '2026-10-19').current)).toEqual(['25']); // first day
    expect(titles(iterationSections(ALL, '2026-10-25').current)).toEqual(['25']); // last day
    const after = iterationSections(ALL, '2026-10-26');
    expect(titles(after.current)).toEqual(['26']);
    expect(titles(after.ended)[0]).toBe('25');
    // a two-week gap between two iterations: nothing current, the next one upcoming, the last one ended
    const gap = [it7(1, '2026-10-01'), it7(2, '2026-10-22')];
    const g = iterationSections(gap, '2026-10-15');
    expect(g.current).toEqual([]);
    expect(titles(g.upcoming)).toEqual(['2']);
    expect(titles(g.ended)).toEqual(['1']);
  });

  it('ended ones of different lengths: by end date, not start date', () => {
    const long = { id: 'long', title: 'long', startDate: '2026-09-01', duration: 28 }; // ends 09-29
    const short = { id: 'short', title: 'short', startDate: '2026-09-10', duration: 7 }; // ends 09-17
    expect(iterationSections([short, long], '2026-10-21').ended.map((i) => i.id)).toEqual(['long', 'short']);
  });
});

describe('folded table groups (GitHub#231)', () => {
  it('kept per "group by"; unfolding removes; folding again moves to the newest; unknown input changes nothing', () => {
    let f = setFold({}, 'iteration', 'none', true);
    f = setFold(f, 'status', 'none', true);
    expect(f).toEqual({ iteration: ['none'], status: ['none'] });
    f = setFold(f, 'status', 'status:Todo', true);
    f = setFold(f, 'status', 'none', true); // again: moves to the end
    expect(f.status).toEqual(['status:Todo', 'none']);
    f = setFold(f, 'iteration', 'none', false);
    expect(f).toEqual({ status: ['status:Todo', 'none'] });
    for (const [by, key, folded] of [['priority', 'x', true], ['status', '', true], ['status', 3, true], ['status', 'x', 'yes']] as const)
      expect(setFold(f, by, key, folded)).toBe(f);
    expect(setFold(f, 'status', 'never-folded', false)).toBe(f);
  });

  it(`at most ${MAX_FOLDS_PER_GROUPING} per grouping: the oldest goes first`, () => {
    let f = {};
    for (let i = 0; i <= MAX_FOLDS_PER_GROUPING; i++) f = setFold(f, 'iteration', `k${i}`, true);
    const list = (f as { iteration: string[] }).iteration;
    expect(list).toHaveLength(MAX_FOLDS_PER_GROUPING);
    expect(list[0]).toBe('k1');
    expect(list.at(-1)).toBe(`k${MAX_FOLDS_PER_GROUPING}`);
    // a saved list that is too long keeps the newest ones
    const long = Array.from({ length: MAX_FOLDS_PER_GROUPING + 5 }, (_, i) => `k${i}`);
    expect(normalizeTableFolds({ status: long }).status).toEqual(long.slice(5));
  });

  it('a broken saved value keeps only the valid parts', () => {
    expect(normalizeTableFolds(null)).toEqual({});
    expect(normalizeTableFolds([])).toEqual({});
    expect(normalizeTableFolds({ iteration: 'none', status: ['a', 2, 'a', ''], repo: [], nope: ['x'] })).toEqual({ status: ['a'] });
  });

  it('"托管" asks first unless the saved value is exactly false', () => {
    expect(normalizeAutopilotConfirm(false)).toBe(false);
    for (const v of [true, undefined, null, 'false', 0]) expect(normalizeAutopilotConfirm(v)).toBe(true);
  });
});

describe('a new issue\'s default board (GitHub#231)', () => {
  const meta = (key: string, viewerCanUpdate = true) => ({ key, title: key, viewerCanUpdate }) as ProjectMeta;
  const board = (key: string, repos: Record<string, number> | null): BoardRepoCount => ({ key, title: key, repos });
  const A = meta('project:a');
  const B = meta('project:b');
  const RO = meta('project:ro', false);

  it('only the board holding the most of the repository\'s items, not every board it is on', () => {
    const boards = [board('project:a', { 'x/app': 2, 'x/lib': 9 }), board('project:b', { 'x/app': 5 })];
    expect(defaultBoards(boards, [A, B], 'x/app').ticked).toEqual(['project:b']);
    expect(defaultBoards(boards, [A, B], 'X/Lib').ticked).toEqual(['project:a']); // repository names ignore case
  });

  it('a tie goes to the board added first', () => {
    const boards = [board('project:b', { 'x/app': 3 }), board('project:a', { 'x/app': 3 })];
    expect(defaultBoards(boards, [A, B], 'x/app').ticked).toEqual(['project:b']);
  });

  it('a board this account cannot change is never ticked, even with the most items', () => {
    const boards = [board('project:ro', { 'x/app': 50 }), board('project:a', { 'x/app': 1 })];
    expect(defaultBoards(boards, [RO, A], 'x/app').ticked).toEqual(['project:a']);
    expect(defaultBoards([board('project:ro', { 'x/app': 50 })], [RO], 'x/app').ticked).toEqual([]);
  });

  it('a repository on no board: none ticked', () => {
    expect(defaultBoards([board('project:a', { 'x/app': 2 })], [A], 'x/new').ticked).toEqual([]);
    expect(defaultBoards([], [], 'x/app').ticked).toEqual([]);
  });

  it('a board not read yet is unknown: left out of the choice and listed, never taken for "holds none"', () => {
    const boards = [board('project:a', null), board('project:b', { 'x/app': 1 })];
    const d = defaultBoards(boards, [B], 'x/app');
    expect(d.ticked).toEqual(['project:b']);
    expect(d.unsynced.map((b) => b.key)).toEqual(['project:a']);
    expect(defaultBoards([board('project:a', { 'x/app': 0 })], [A], 'x/app').unsynced).toEqual([]);
  });

  it('counts per repository from a board\'s own items', () => {
    const item = (repo: string, n: number) => ({ key: `${repo.toLowerCase()}#${n}`, repo }) as Item;
    expect(countRepos([item('X/App', 1), item('x/app', 2), item('x/lib', 3)])).toEqual({ 'x/app': 2, 'x/lib': 1 });
  });
});

describe('the table group without a value goes last (GitHub#231)', () => {
  const item = (n: number, milestone: Item['milestone']): Item =>
    ({ key: `x/a#${n}`, repo: 'x/a', number: n, title: `#${n}`, kind: 'issue', state: 'open', labels: [], assignees: [], projects: [], milestone, updatedAt: `2026-10-0${n}T00:00:00Z`, sources: [], parent: null }) as unknown as Item;
  it('after dated milestones and after milestones without a due date', () => {
    const items = [item(1, null), item(2, { title: 'later', dueOn: null } as Item['milestone']), item(3, { title: 'v1', dueOn: '2026-12-01T00:00:00Z' } as Item['milestone'])];
    const t = buildTable(items, [], { ...DEFAULT_TABLE, groupBy: 'milestone', sliceByRepo: false }, TODAY);
    expect(t.groups.map((g) => g.title)).toEqual(['v1', 'later', '无里程碑']);
  });
});
