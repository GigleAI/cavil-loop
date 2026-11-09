// GitHub#304: the repository order set by dragging. One saved order, one comparison, used by every
// list of repositories (table slices, "all repositories" sections, "group by repository", board
// swimlanes, the new-issue dialog's repository list); a drag only moves the repositories on screen.
// The fixtures use an order that is NOT alphabetical, so a place still sorting by name fails here.

import { describe, expect, it } from 'vitest';
import { MAX_HIDDEN_REPOS, moveRepo, normalizeRepoOrder, reorderRepos, repoComparator, sortRepos } from '../../src/shared/repoOrder';
import { buildTable } from '../../src/data/table';
import { buildBoard } from '../../src/data/board';
import { knownRepos } from '../../src/renderer/NewIssueDialog';
import { DEFAULT_TABLE } from '../../src/shared/viewSettings';
import type { AppState, BoardData, Item } from '../../src/shared/types';
import { item, iter, member, project } from './helpers';

const TODAY = '2026-11-05';

describe('the comparison', () => {
  it('saved ones in the saved order, then the rest alphabetically; case does not matter', () => {
    const order = ['org/c', 'org/a'];
    expect(sortRepos(['Org/B', 'org/a', 'ORG/C', 'org/d'], order)).toEqual(['ORG/C', 'org/a', 'Org/B', 'org/d']);
    // nothing saved: plain alphabetical, as before
    expect(sortRepos(['org/c', 'Org/B', 'org/a'], [])).toEqual(['org/a', 'Org/B', 'org/c']);
    expect(repoComparator(order)('org/C', 'ORG/c')).toBe(0);
  });

  it('a saved value that is not a list of strings reads as nothing saved; strings are lower-cased, trimmed, de-duplicated, never cut', () => {
    for (const bad of [null, undefined, 'org/a', 7, { 0: 'org/a' }]) expect(normalizeRepoOrder(bad)).toEqual([]);
    expect(normalizeRepoOrder(['Org/A', ' org/b ', 3, '', 'org/a', null, 'ORG/C'])).toEqual(['org/a', 'org/b', 'org/c']);
    const many = Array.from({ length: 1200 }, (_, i) => `org/r${i}`);
    expect(normalizeRepoOrder(many)).toHaveLength(1200);
  });
});

describe('moving one repository in the list on screen', () => {
  it('before or after the target; nothing when either is missing or they are the same', () => {
    const shown = ['org/c', 'org/a', 'org/b'];
    expect(moveRepo(shown, 'org/b', 'org/c', false)).toEqual(['org/b', 'org/c', 'org/a']);
    expect(moveRepo(shown, 'org/c', 'org/b', true)).toEqual(['org/a', 'org/b', 'org/c']);
    expect(moveRepo(shown, 'org/c', 'org/a', true)).toEqual(['org/a', 'org/c', 'org/b']);
    expect(moveRepo(shown, 'ORG/B', 'org/a', false)).toEqual(['org/c', 'org/b', 'org/a']);
    expect(moveRepo(shown, 'org/b', 'org/b', false)).toBeNull();
    expect(moveRepo(shown, 'org/x', 'org/a', false)).toBeNull();
    expect(moveRepo(shown, 'org/a', 'org/x', false)).toBeNull();
  });
});

describe('the saved order after a drag', () => {
  it('the review example: saved c a b, a hidden by the search, b dragged before c → b a c (a keeps its place)', () => {
    const shown = sortRepos(['org/c', 'org/b'], ['org/c', 'org/a', 'org/b']);
    expect(shown).toEqual(['org/c', 'org/b']);
    const next = moveRepo(shown, 'org/b', 'org/c', false)!;
    expect(reorderRepos(['org/c', 'org/a', 'org/b'], shown, next)).toEqual(['org/b', 'org/a', 'org/c']);
  });

  it('nothing saved yet: the shown repositories are remembered where the drag put them; a hidden one never seen is not written', () => {
    // the list shows a, b, c alphabetically (d is hidden and was never saved)
    expect(reorderRepos([], ['Org/A', 'org/b', 'org/c'], ['org/c', 'Org/A', 'org/b'])).toEqual(['org/c', 'org/a', 'org/b']);
  });

  it('shown repositories not saved yet join after the saved ones, alphabetically — exactly where the list showed them', () => {
    const saved = ['org/z', 'org/y'];
    const shown = sortRepos(['org/b', 'org/z', 'org/a', 'org/y'], saved);
    expect(shown).toEqual(['org/z', 'org/y', 'org/a', 'org/b']);
    // a hidden saved one between them stays in its place too
    const saved2 = ['org/z', 'org/h', 'org/y'];
    const next = moveRepo(shown, 'org/b', 'org/z', false)!;
    expect(reorderRepos(saved2, shown, next)).toEqual(['org/b', 'org/h', 'org/z', 'org/y', 'org/a']);
  });

  it('not the same repositories (one more, one less, one twice, not strings), or no change: nothing to write', () => {
    const saved = ['org/a', 'org/b'];
    expect(reorderRepos(saved, ['org/a', 'org/b'], ['org/b'])).toBeNull();
    expect(reorderRepos(saved, ['org/a', 'org/b'], ['org/b', 'org/a', 'org/c'])).toBeNull();
    expect(reorderRepos(saved, ['org/a', 'org/b'], ['org/b', 'org/b'])).toBeNull();
    expect(reorderRepos(saved, ['org/a', 'org/a'], ['org/a', 'org/a'])).toBeNull();
    expect(reorderRepos(saved, ['org/a', 'org/b'], ['org/b', 'org/x'])).toBeNull();
    expect(reorderRepos(saved, ['org/a', 7], ['org/a', 7])).toBeNull();
    expect(reorderRepos(saved, [], [])).toBeNull();
    expect(reorderRepos(saved, ['org/a', 'org/b'], ['org/a', 'org/b'])).toBeNull();
    // the right set is accepted (the positive control of the lines above)
    expect(reorderRepos(saved, ['org/a', 'org/b'], ['org/b', 'org/a'])).toEqual(['org/b', 'org/a']);
  });

  const repos = (n: number, p: string) => Array.from({ length: n }, (_, i) => `org/${p}${String(i).padStart(4, '0')}`);

  it('500 shown, all of them: every one kept in the new order', () => {
    const all = repos(500, 'r');
    const next = moveRepo(all, all[499], all[0], false)!;
    const out = reorderRepos(all, all, next)!;
    expect(out).toEqual(next);
    expect(normalizeRepoOrder(out)).toEqual(next); // read back after a restart: unchanged
  });

  it('501 shown, all of them: every one kept — a drag is never refused or cut', () => {
    const all = repos(501, 'r');
    const next = moveRepo(all, all[500], all[0], false)!;
    const out = reorderRepos([], all, next)!;
    expect(out).toHaveLength(501);
    expect(out).toEqual(next);
    expect(sortRepos(all, normalizeRepoOrder(out))).toEqual(next);
  });

  it(`10 shown + 600 hidden: the 10 kept, the first ${MAX_HIDDEN_REPOS} hidden kept, the last 100 dropped (they later come back last, alphabetically)`, () => {
    const hidden = repos(600, 'h');
    const shown = repos(10, 's');
    const saved = [...shown.slice(0, 5), ...hidden, ...shown.slice(5)];
    const before = sortRepos(shown, saved);
    const next = moveRepo(before, before[9], before[0], false)!;
    const out = reorderRepos(saved, before, next)!;
    expect(out.filter((r) => r.startsWith('org/s'))).toEqual(next);
    expect(out.filter((r) => r.startsWith('org/h'))).toEqual(hidden.slice(0, MAX_HIDDEN_REPOS));
    expect(out).toHaveLength(10 + MAX_HIDDEN_REPOS);
    // read back (a restart), then the dropped ones show up again: after every saved one, alphabetically
    const back = normalizeRepoOrder(out);
    const dropped = hidden.slice(MAX_HIDDEN_REPOS);
    const list = sortRepos([...[...dropped].reverse(), hidden[0], shown[3]], back);
    expect(list.slice(0, 2)).toEqual(back.filter((r) => r === hidden[0] || r === shown[3]));
    expect(list.slice(2)).toEqual(dropped);
  });
});

/** a non-alphabetical saved order over three repositories, used by every list below */
const ORDER = ['org/c', 'org/a', 'org/b'];
const P = project('p', 'Board', [iter('Iteration 1', '2026-11-02')]);
const items: Item[] = ['org/a', 'org/b', 'org/c'].flatMap((r, i) => [item(r, 1 + i, {}, [member(P, P.iterations[0], 'Todo')])]);
const T = (patch: Partial<typeof DEFAULT_TABLE>) => ({ ...DEFAULT_TABLE, ...patch });

describe('every list of repositories follows the one saved order', () => {
  it('table: the slice list', () => {
    expect(buildTable(items, [P], T({ sliceByRepo: true }), TODAY, false, ORDER).slices!.map((s) => s.value)).toEqual(ORDER);
    expect(buildTable(items, [P], T({ sliceByRepo: true }), TODAY).slices!.map((s) => s.value)).toEqual(['org/a', 'org/b', 'org/c']);
  });

  it('table: the "all repositories" sections, and their groups one section after another', () => {
    const t = buildTable(items, [P], T({ sliceByRepo: true, slice: null, groupBy: 'iteration' }), TODAY, false, ORDER);
    expect(t.repos!.map((r) => r.title)).toEqual(ORDER);
    expect(t.groups.map((g) => g.section)).toEqual(ORDER.map((r) => `repo:${r}`));
  });

  it('table: grouped by repository', () => {
    expect(buildTable(items, [P], T({ groupBy: 'repo' }), TODAY, false, ORDER).groups.map((g) => g.title)).toEqual(ORDER);
    expect(buildTable(items, [P], T({ groupBy: 'repo' }), TODAY).groups.map((g) => g.title)).toEqual(['org/a', 'org/b', 'org/c']);
  });

  it('board: the swimlanes', () => {
    expect(buildBoard(items, [P], 'iteration', true, TODAY, undefined, false, ORDER).lanes).toEqual(ORDER);
    expect(buildBoard(items, [P], 'iteration', true, TODAY).lanes).toEqual(['org/a', 'org/b', 'org/c']);
  });

  it('the new-issue dialog: its repository list (and so the first one picked when nothing else decides)', () => {
    const state = { sources: [{ kind: 'repo', key: 'repo:org/b', owner: 'org', name: 'b' }], repoOrder: ORDER } as unknown as AppState;
    const data = { items, projects: [P] } as unknown as BoardData;
    expect(knownRepos(state, data)).toEqual(ORDER);
    expect(knownRepos({ ...state, repoOrder: [] }, data)).toEqual(['org/a', 'org/b', 'org/c']);
  });
});
