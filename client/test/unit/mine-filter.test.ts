// GitHub#689: 「只看我的」 — one switch for the whole window with two boxes, 我提出的 (author) and 指派给我
// (assignee), either matching. The expected items are written out here by hand (who opened / is assigned
// each one), and compared with the search box's own `author:@me` / `assignee:@me` — the switch must pick
// exactly what those pick, never a second rule.

import { describe, expect, it } from 'vitest';
import { applyFilter, mineActive, mineOnly, parseFilter } from '../../src/shared/filter';
import { DEFAULT_MINE_FILTER, normalizeMineFilter, setMineFilter, type MineFilter } from '../../src/shared/uiPrefs';
import { viewBarTallies } from '../../src/data/flowTally';
import { DEFAULT_HAND_BACK, type Item } from '../../src/shared/types';
import { item } from './helpers';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MineFilterButton } from '../../src/renderer/MineFilterButton';

const R = 'o/r';
const L = (...names: string[]) => names.map((name) => ({ name, color: 'ededed' }));
const ITEMS: Item[] = [
  item(R, 1, { author: 'me', labels: L('doing/agent') }), // opened by me
  item(R, 2, { author: 'bob', assignees: ['Me'], labels: L('doing/agent') }), // assigned to me (other case)
  item(R, 3, { author: 'ME', assignees: ['me'], kind: 'pr', labels: L('pending/human') }), // both
  item(R, 4, { author: 'bob', assignees: ['alice'], labels: L('doing/agent') }), // neither
  item(R, 5, { author: null, labels: L('pending/human') }), // no author recorded: neither
  item(R, 6, { author: 'bob', assignees: ['meme'] }), // a longer login that only contains mine: neither
  item(R, 7, { author: 'me', state: 'closed', stateReason: 'completed', labels: L('pending/human') }), // mine, closed
];
const nums = (xs: Item[]) => xs.map((i) => i.number);
const ON = (p: Partial<MineFilter> = {}): MineFilter => ({ on: true, author: true, assignee: true, ...p });
const search = (q: string) => nums(applyFilter(ITEMS, parseFilter(q), { viewer: 'me', today: '2026-11-25', projects: [] }));

describe('which items 「只看我的」 picks', () => {
  it('我提出的 alone = author:@me; 指派给我 alone = assignee:@me; both = either, in the items\' own order', () => {
    expect(nums(mineOnly(ITEMS, ON({ assignee: false }), 'me'))).toEqual([1, 3, 7]);
    expect(nums(mineOnly(ITEMS, ON({ assignee: false }), 'me'))).toEqual(search('author:@me'));
    expect(nums(mineOnly(ITEMS, ON({ author: false }), 'me'))).toEqual([2, 3]);
    expect(nums(mineOnly(ITEMS, ON({ author: false }), 'me'))).toEqual(search('assignee:@me'));
    expect(nums(mineOnly(ITEMS, ON(), 'me'))).toEqual([1, 2, 3, 7]);
  });

  it('off, or no signed-in account: every item, the very same list', () => {
    expect(mineOnly(ITEMS, { ...ON(), on: false }, 'me')).toBe(ITEMS);
    expect(mineOnly(ITEMS, ON(), null)).toBe(ITEMS);
    expect(mineOnly(ITEMS, ON(), '')).toBe(ITEMS);
    expect(mineActive(ON(), 'me')).toBe(true);
    expect(mineActive(ON(), null)).toBe(false);
    expect(mineActive({ ...ON(), on: false }, 'me')).toBe(false);
  });
});

describe('the view-bar numbers follow it', () => {
  const counts = (items: Item[]) => Object.fromEntries(viewBarTallies(items, null, DEFAULT_HAND_BACK).map((e) => [e.kind, e.count]));
  it('on: only my items are counted (open ones for 运行中, open and closed for 等人处理); off: as before', () => {
    const all = counts(ITEMS);
    const mine = counts(mineOnly(ITEMS, ON(), 'me'));
    const running = viewBarTallies(ITEMS, null, DEFAULT_HAND_BACK).find((e) => e.flow === 'running')!.kind;
    const human = viewBarTallies(ITEMS, null, DEFAULT_HAND_BACK).find((e) => e.flow === 'human')!.kind;
    expect(all[running]).toBe(3); // 1, 2, 4
    expect(all[human]).toBe(3); // 3, 5, 7
    expect(mine[running]).toBe(2); // 1, 2
    expect(mine[human]).toBe(2); // 3, 7
    expect(counts(mineOnly(ITEMS, { ...ON(), on: false }, 'me'))).toEqual(all);
  });
});

describe('the saved setting', () => {
  it('reads field by field; both boxes unticked reads as both ticked; anything else is the default', () => {
    expect(normalizeMineFilter(null)).toEqual(DEFAULT_MINE_FILTER);
    expect(normalizeMineFilter([true])).toEqual(DEFAULT_MINE_FILTER);
    expect(normalizeMineFilter({ on: true })).toEqual({ on: true, author: true, assignee: true });
    expect(normalizeMineFilter({ on: 1, author: false, assignee: true })).toEqual({ on: false, author: false, assignee: true });
    expect(normalizeMineFilter({ on: true, author: false, assignee: false })).toEqual({ on: true, author: true, assignee: true });
  });

  it('a change keeps one box ticked, ignores what is not a boolean, and gives back the same value when nothing changed', () => {
    const cur: MineFilter = { on: true, author: true, assignee: false };
    expect(setMineFilter(cur, { author: false })).toBe(cur);
    expect(setMineFilter(cur, { on: 'yes' })).toBe(cur);
    expect(setMineFilter(cur, { on: true })).toBe(cur);
    expect(setMineFilter(cur, null)).toBe(cur);
    expect(setMineFilter(cur, { author: false, assignee: true })).toEqual({ on: true, author: false, assignee: true });
    expect(setMineFilter(cur, { on: false })).toEqual({ on: false, author: true, assignee: false });
  });
});

describe('the button', () => {
  const html = (filter: MineFilter, viewer: string | null) => renderToStaticMarkup(createElement(MineFilterButton, { filter, viewer, onChange: () => undefined }));
  it('greyed out with no signed-in account, saying why; lit only while on with an account', () => {
    const out = html(ON(), null);
    expect(out).toMatch(/<button[^>]*disabled=""/);
    expect(out).toContain('登录后才能只看自己的条目');
    expect(out).toContain('data-on="no"');
    expect(html(ON(), 'me')).toContain('data-on="yes"');
    expect(html(ON(), 'me')).not.toMatch(/<button[^>]*disabled=""/);
    expect(html({ ...ON(), on: false }, 'me')).toContain('data-on="no"');
    expect(html(ON({ assignee: false }), 'me')).toContain('只看我的：我提出的（满足任一项就显示）');
  });
});
