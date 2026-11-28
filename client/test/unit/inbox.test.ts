// GitHub#752 — the table's 「收件箱」 and 「最近完成」 (data/inbox.ts) and the flat table they make
// (data/table.ts). The rules alone, each case with an input that tells a right implementation from a
// plausible wrong one: an item the view bar's switch would leave in but the panel's conditions leave out,
// a closed issue whose close reason is unknown next to a completed one, two items updated in the
// opposite order of their numbers, the same item pending and notified. The controller's side (which
// notification threads reach the window) is in test/unit/inbox-controller.test.ts.

import { describe, expect, it } from 'vitest';
import { doneList, inboxList, mineScope, normalizeDoneDays, specialSlice, SLICE_DONE, SLICE_INBOX } from '../../src/data/inbox';
import { buildTable } from '../../src/data/table';
import { mineOnly } from '../../src/shared/filter';
import { DEFAULT_TABLE } from '../../src/shared/viewSettings';
import { DEFAULT_MINE_FILTER, type MineFilter } from '../../src/shared/uiPrefs';
import type { InboxThread, Item } from '../../src/shared/types';
import { item } from './helpers';

const ME = 'me';
const R = 'o/r';
const S = 'o/s';
const label = (name: string) => ({ name, color: 'ededed' });
const pending = (n: number, extra: Partial<Item> = {}, repo = R) => item(repo, n, { labels: [label('pending/human')], ...extra });
const human = () => 'pending/human';
const keys = (rows: { item: Item }[]) => rows.map((r) => r.item.key);
const pick = (p: Partial<MineFilter> = {}): MineFilter => ({ ...DEFAULT_MINE_FILTER, ...p });
const NOW = Date.parse('2026-11-28T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const th = (key: string, reason = 'mention', at = NOW): InboxThread => ({ key, reason, updatedAt: at });

describe('the scope: the 「只看我的」 panel\'s conditions, whatever its switch', () => {
  const mine = pending(1, { author: ME });
  const assigned = pending(2, { author: 'x', assignees: ['Me'] });
  const others = pending(3, { author: 'x', assignees: ['y'] });
  const byAlice = pending(4, { author: 'alice' });
  const all = [mine, assigned, others, byAlice];

  it('the switch off makes no difference: the same items as the view bar with the switch on', () => {
    for (const p of [pick({ on: false }), pick({ on: true }), pick({ on: false, assignee: false }), pick({ on: false, author: false, authors: ['alice'] })]) {
      const want = mineOnly(all, { ...p, on: true }, ME).map((i) => i.key);
      expect(mineScope(all, p, ME).map((i) => i.key), JSON.stringify(p)).toEqual(want);
    }
    // did narrow: the switch's own "off" would have kept everything
    expect(mineScope(all, pick({ on: false }), ME).map((i) => i.number)).toEqual([1, 2]);
    expect(mineOnly(all, pick({ on: false }), ME)).toHaveLength(4);
  });

  it('only 我提出的 ticked: an item assigned to the account but opened by someone else is out; ticking 指派给我 brings it in; a picked author brings theirs', () => {
    expect(keys(inboxList(all, [], pick({ assignee: false }), ME, human))).toEqual([mine.key]);
    expect(keys(inboxList(all, [], pick(), ME, human)).sort()).toEqual([mine.key, assigned.key].sort());
    expect(keys(inboxList(all, [], pick({ authors: ['ALICE'] }), ME, human))).toContain(byAlice.key);
  });

  it('no signed-in account: both lists are empty (the switch\'s rule would have let everything through)', () => {
    expect(mineOnly(all, pick({ on: true }), null)).toHaveLength(4);
    expect(inboxList(all, [], pick(), null, human)).toEqual([]);
    expect(inboxList(all, [], pick(), '', human)).toEqual([]);
    const done = [item(R, 9, { author: ME, state: 'closed', stateReason: 'completed', updatedAt: daysAgo(1) })];
    expect(doneList(done, 7, NOW, pick(), ME).rows).toHaveLength(1);
    expect(doneList(done, 7, NOW, pick(), null)).toEqual({ rows: [], unknown: 0 });
  });
});

describe('收件箱', () => {
  it('pending items open and closed, each repository under its own label name; one without the label is out', () => {
    const open = pending(1, { author: ME });
    const closed = pending(2, { author: ME, state: 'closed', stateReason: 'completed' });
    const merged = pending(3, { author: ME, kind: 'pr', state: 'merged' });
    const renamed = item(S, 4, { author: ME, labels: [label('Needs-Me')] });
    const plain = item(R, 5, { author: ME });
    const got = inboxList([open, closed, merged, renamed, plain], [], pick(), ME, (repo) => (repo === S ? 'needs-me' : 'pending/human'));
    expect(keys(got).sort()).toEqual([open.key, closed.key, merged.key, renamed.key].sort());
    expect(got.every((r) => r.why === 'pending')).toBe(true);
  });

  it('a notification brings in an item without the label, with its reason; an item both pending and notified is one row, as pending', () => {
    const a = item(R, 1, { author: ME });
    const b = pending(2, { author: ME });
    const c = item(R, 3, { author: ME });
    const got = inboxList([a, b, c], [th(a.key, 'review_requested'), th(b.key, 'mention')], pick(), ME, human);
    expect(got.map((r) => [r.item.number, r.why]).sort()).toEqual([
      [1, 'review_requested'],
      [2, 'pending'],
    ]);
  });

  it('a notification for an item outside the scope stays out — and it was really there to bring in', () => {
    const othersIssue = item(R, 7, { author: 'alice' });
    const t = [th(othersIssue.key, 'mention')];
    expect(inboxList([othersIssue], t, pick(), ME, human)).toEqual([]);
    expect(keys(inboxList([othersIssue], t, pick({ authors: ['alice'] }), ME, human))).toEqual([othersIssue.key]);
  });

  it('a notification for an item the search left out (not in the list handed in) does not come back', () => {
    const a = item(R, 1, { author: ME });
    expect(inboxList([], [th(a.key)], pick(), ME, human)).toEqual([]);
    expect(inboxList([a], [th(a.key)], pick(), ME, human)).toHaveLength(1);
  });

  it('newest update first, whatever the numbers; the same time by key', () => {
    const older = pending(1, { author: ME, updatedAt: '2026-11-20T00:00:00Z' });
    const newer = pending(2, { author: ME, updatedAt: '2026-11-27T00:00:00Z' });
    const tieA = pending(3, { author: ME, updatedAt: '2026-11-25T00:00:00Z' });
    const tieB = pending(4, { author: ME, updatedAt: '2026-11-25T00:00:00Z' });
    expect(inboxList([older, tieB, newer, tieA], [], pick(), ME, human).map((r) => r.item.number)).toEqual([2, 3, 4, 1]);
  });
});

describe('最近完成', () => {
  const mk = (n: number, extra: Partial<Item>) => item(R, n, { author: ME, updatedAt: daysAgo(1), ...extra });

  it('only issues closed as completed and merged pull requests; not planned, duplicate, a PR closed unmerged, open items are out', () => {
    const list = [
      mk(1, { state: 'closed', stateReason: 'completed' }),
      mk(2, { kind: 'pr', state: 'merged' }),
      mk(3, { state: 'closed', stateReason: 'not_planned' }),
      mk(4, { state: 'closed', stateReason: 'duplicate' }),
      mk(5, { kind: 'pr', state: 'closed' }),
      mk(6, { state: 'open' }),
      mk(7, { kind: 'pr', state: 'open' }),
    ];
    const got = doneList(list, 7, NOW, pick(), ME);
    expect(got.rows.map((r) => r.item.number).sort()).toEqual([1, 2]);
    expect(got.unknown).toBe(0);
  });

  it('a closed issue whose close reason is not known is not done: it is only counted (in range and in scope only)', () => {
    const list = [
      mk(1, { state: 'closed', stateReason: 'completed' }),
      mk(2, { state: 'closed', stateReason: null }),
      mk(3, { state: 'closed', stateReason: null, updatedAt: daysAgo(30) }),
      mk(4, { state: 'closed', stateReason: null, author: 'x' }),
    ];
    const got = doneList(list, 7, NOW, pick(), ME);
    expect(got.rows.map((r) => r.item.number)).toEqual([1]);
    expect(got.unknown).toBe(1);
    // read again with its reason: it moves in, or stays out and is no longer counted
    expect(doneList([list[0], { ...list[1], stateReason: 'completed' }], 7, NOW, pick(), ME)).toMatchObject({ unknown: 0 });
    expect(doneList([list[0], { ...list[1], stateReason: 'completed' }], 7, NOW, pick(), ME).rows).toHaveLength(2);
    expect(doneList([list[0], { ...list[1], stateReason: 'not_planned' }], 7, NOW, pick(), ME)).toMatchObject({ unknown: 0, rows: [{ item: list[0] }] });
  });

  it('the days decide by the update time: 7 keeps a 6-day-old one and drops an 8-day-old one; 30 keeps both; an unreadable time is never recent', () => {
    const six = mk(1, { kind: 'pr', state: 'merged', updatedAt: daysAgo(6) });
    const eight = mk(2, { kind: 'pr', state: 'merged', updatedAt: daysAgo(8) });
    const broken = mk(3, { kind: 'pr', state: 'merged', updatedAt: 'not a time' });
    expect(doneList([six, eight, broken], 7, NOW, pick(), ME).rows.map((r) => r.item.number)).toEqual([1]);
    expect(doneList([six, eight, broken], 30, NOW, pick(), ME).rows.map((r) => r.item.number)).toEqual([1, 2]);
    // a value out of range is the default (7)
    expect(doneList([six, eight], 0, NOW, pick(), ME).rows).toHaveLength(1);
  });

  it('newest update first', () => {
    const a = mk(1, { kind: 'pr', state: 'merged', updatedAt: daysAgo(3) });
    const b = mk(2, { kind: 'pr', state: 'merged', updatedAt: daysAgo(1) });
    expect(doneList([a, b], 7, NOW, pick(), ME).rows.map((r) => r.item.number)).toEqual([2, 1]);
  });
});

describe('the days as saved or typed', () => {
  it('a whole number from 1 to 365; anything else is 7', () => {
    for (const v of [1, 7, 30, 365]) expect(normalizeDoneDays(v)).toBe(v);
    for (const v of [0, 366, -1, 2.5, '7', null, undefined, NaN, {}]) expect(normalizeDoneDays(v), String(v)).toBe(7);
  });
});

describe('the flat table', () => {
  const settings = { ...DEFAULT_TABLE, groupBy: 'iteration' as const, hierarchy: true, sort: { field: 'number' as const, dir: 'asc' as const } };

  it('the picked list alone, in its order, one group, every row at the top level — no PR under its issue, no sub-issue under its parent', () => {
    const parent = pending(1, { author: ME, updatedAt: '2026-11-20T00:00:00Z' });
    const child = pending(2, { author: ME, parent: parent.key, updatedAt: '2026-11-27T00:00:00Z' });
    const pr = pending(3, { author: ME, kind: 'pr', refIssues: [parent.key], updatedAt: '2026-11-25T00:00:00Z' });
    const other = item(S, 4, { author: ME });
    const all = [parent, child, pr, other];
    const rows = inboxList(all, [th(other.key, 'assign', 1)], pick(), ME, human);
    const table = buildTable(all, [], { ...settings, slice: SLICE_INBOX }, '2026-11-28', true, [], all, [], true, { kind: 'inbox', rows });
    expect(table.flat).toBe('inbox');
    expect(table.slice).toBe(SLICE_INBOX);
    expect(table.groups).toHaveLength(1);
    expect(table.groups[0].rows.map((r) => [r.item.number, r.depth, r.under])).toEqual([
      [2, 0, null],
      [3, 0, null],
      [1, 0, null],
      [4, 0, null],
    ]);
    expect(table.groups[0].rows.map((r) => r.why ?? null)).toEqual([null, null, null, 'assign']);
    expect(table.itemCount).toBe(4);
    // the repository list on the left is still counted from every item
    expect(table.slices?.map((s) => [s.value, s.count])).toEqual([
      [R, 3],
      [S, 1],
    ]);
    // did differ: the same items laid out normally nest the sub-issue and the PR
    const normal = buildTable(all, [], { ...settings, slice: null }, '2026-11-28', true, [], all, [], false);
    expect(normal.groups.flatMap((g) => g.rows).some((r) => r.depth > 0)).toBe(true);
  });

  it('a saved special slice without its list (an older caller) is "all repositories", never a repository named @inbox', () => {
    const all = [pending(1), item(S, 2)];
    const table = buildTable(all, [], { ...settings, groupBy: 'none', slice: SLICE_DONE }, '2026-11-28', false, [], all);
    expect(table.flat).toBeUndefined();
    expect(table.itemCount).toBe(2);
  });

  it('the two saved values; a repository name is never one of them', () => {
    expect(specialSlice(SLICE_INBOX)).toBe('inbox');
    expect(specialSlice(SLICE_DONE)).toBe('done');
    expect(specialSlice('o/r')).toBeNull();
    expect(specialSlice(null)).toBeNull();
  });
});
