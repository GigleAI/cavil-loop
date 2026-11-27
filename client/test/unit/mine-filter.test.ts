// GitHub#689: 「只看我的」 — one switch for the whole window with two boxes, 我提出的 (author) and 指派给我
// (assignee), either matching. The expected items are written out here by hand (who opened / is assigned
// each one), and compared with the search box's own `author:@me` / `assignee:@me` — the switch must pick
// exactly what those pick, never a second rule. GitHub#746: picked accounts (提出者 / 负责人) are more
// conditions by the same rule, compared with `author:<login>` / `assignee:<login>`.

import { describe, expect, it } from 'vitest';
import { applyFilter, mineActive, mineCandidates, mineOnly, parseFilter } from '../../src/shared/filter';
import { DEFAULT_MINE_FILTER, MINE_PEOPLE_MAX, minePeople, normalizeMineFilter, setMineFilter, type MineFilter } from '../../src/shared/uiPrefs';
import { viewBarTallies } from '../../src/data/flowTally';
import { DEFAULT_HAND_BACK, type Item } from '../../src/shared/types';
import { item } from './helpers';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MineFilterButton, mineLabel, mineTip } from '../../src/renderer/MineFilterButton';

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
const ON = (p: Partial<MineFilter> = {}): MineFilter => ({ on: true, author: true, assignee: true, authors: [], assignees: [], ...p });
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
    expect(normalizeMineFilter({ on: true })).toEqual(ON());
    expect(normalizeMineFilter({ on: 1, author: false, assignee: true })).toEqual({ ...ON({ author: false }), on: false });
    expect(normalizeMineFilter({ on: true, author: false, assignee: false })).toEqual(ON());
  });

  it('a change keeps one box ticked, ignores what is not a boolean, and gives back the same value when nothing changed', () => {
    const cur: MineFilter = ON({ assignee: false });
    expect(setMineFilter(cur, { author: false })).toBe(cur);
    expect(setMineFilter(cur, { on: 'yes' })).toBe(cur);
    expect(setMineFilter(cur, { on: true })).toBe(cur);
    expect(setMineFilter(cur, null)).toBe(cur);
    expect(setMineFilter(cur, { author: false, assignee: true })).toEqual(ON({ author: false }));
    expect(setMineFilter(cur, { on: false })).toEqual({ ...ON({ assignee: false }), on: false });
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

// GitHub#746: two more lists, 提出者 (authors) and 负责人 (assignees)
const PEOPLE: Item[] = [
  item(R, 11, { author: 'me' }), // mine, nobody else's
  item(R, 12, { author: 'Alice' }), // opened by alice (other case)
  item(R, 13, { author: 'bob', assignees: ['me'] }), // assigned to me only
  item(R, 14, { author: 'carol', assignees: ['DAVE', 'erin'] }), // assigned to dave (other case)
  item(R, 15, { author: 'bob', assignees: ['alice'] }), // assigned to alice, opened by bob: not "opened by alice"
  item(R, 16, { author: 'alicea' }), // a longer login that only contains alice: no one picked
  item(R, 17, { author: null, assignees: [] }), // nobody recorded
  item(R, 18, { author: 'alice', state: 'closed', stateReason: 'completed' }), // alice's, closed
];
const pick = (p: Partial<MineFilter>) => nums(mineOnly(PEOPLE, ON(p), 'me'));
const searchP = (q: string) => nums(applyFilter(PEOPLE, parseFilter(q), { viewer: 'me', today: '2026-11-28', projects: [] }));

describe('GitHub#746: picked accounts', () => {
  it('only another 提出者 (both boxes off) = author:<login>, item for item — none of my own come along', () => {
    expect(pick({ author: false, assignee: false, authors: ['alice'] })).toEqual([12, 18]);
    expect(pick({ author: false, assignee: false, authors: ['alice'] })).toEqual(searchP('author:alice'));
    expect(pick({ author: false, assignee: false, authors: ['alice'] })).not.toContain(11);
  });

  it('only another 负责人 (both boxes off) = assignee:<login>, any case', () => {
    expect(pick({ author: false, assignee: false, assignees: ['dave'] })).toEqual([14]);
    expect(pick({ author: false, assignee: false, assignees: ['dave'] })).toEqual(searchP('assignee:dave'));
    expect(pick({ author: false, assignee: false, assignees: ['alice'] })).toEqual(searchP('assignee:alice'));
    expect(pick({ author: false, assignee: false, assignees: ['alice'] })).toEqual([15]);
  });

  it("boxes kept and accounts picked: the union — mine (11, 13) and alice's (12, 18) together, nothing else", () => {
    expect(pick({ authors: ['alice'] })).toEqual([11, 12, 13, 18]);
    expect(pick({ author: false, authors: ['alice'] })).toEqual([12, 13, 18]); // 指派给我 kept: 13 stays, 11 goes
  });

  it("提出者 and 负责人 mixed, boxes off: each list's own result, together", () => {
    const both = pick({ author: false, assignee: false, authors: ['alice', 'bob'], assignees: ['dave'] });
    const union = new Set([...searchP('author:alice'), ...searchP('author:bob'), ...searchP('assignee:dave')]);
    expect(both).toEqual(nums(PEOPLE).filter((n) => union.has(n)));
    expect(both).toEqual([12, 13, 14, 15, 18]);
  });

  it('off, or no signed-in account: every item even with accounts picked', () => {
    expect(mineOnly(PEOPLE, { ...ON({ authors: ['alice'] }), on: false }, 'me')).toBe(PEOPLE);
    expect(mineOnly(PEOPLE, ON({ author: false, assignee: false, authors: ['alice'] }), null)).toBe(PEOPLE);
  });
});

describe('GitHub#746: who the searches offer', () => {
  it('提出者: everyone who opened an item read so far, counted, most first then by name; not me; picked ones always listed', () => {
    expect(mineCandidates(PEOPLE, 'author', 'me', [])).toEqual([
      { login: 'Alice', count: 2 }, // 12 and 18, one account whatever the case
      { login: 'bob', count: 2 },
      { login: 'alicea', count: 1 },
      { login: 'carol', count: 1 },
    ]);
    expect(mineCandidates(PEOPLE, 'author', 'me', ['zed']).at(-1)).toEqual({ login: 'zed', count: 0 });
    expect(mineCandidates(PEOPLE, 'author', 'ME', []).map((c) => c.login)).not.toContain('me');
  });

  it('负责人: everyone assigned an item; one item counts once per account', () => {
    const twice = [...PEOPLE, item(R, 19, { author: 'x', assignees: ['erin', 'Erin'] })];
    expect(mineCandidates(twice, 'assignee', 'me', [])).toEqual([
      { login: 'erin', count: 2 },
      { login: 'alice', count: 1 },
      { login: 'DAVE', count: 1 },
    ]);
  });
});

describe('GitHub#746: the saved lists', () => {
  it('keeps login-shaped strings only, one per account (first spelling), at most MINE_PEOPLE_MAX', () => {
    expect(minePeople(['alice', 'ALICE', 'bad login', '-x', 7, null, 'dependabot[bot]', 'a'.repeat(40), 'b'.repeat(39)])).toEqual(['alice', 'dependabot[bot]', 'b'.repeat(39)]);
    expect(minePeople('alice')).toEqual([]);
    const many = Array.from({ length: MINE_PEOPLE_MAX + 5 }, (_, i) => `u${i}`);
    expect(minePeople(many)).toEqual(many.slice(0, MINE_PEOPLE_MAX));
  });

  it('an old saved value (no lists) reads with empty lists, as before; both boxes off with someone picked stays as saved', () => {
    expect(normalizeMineFilter({ on: true, author: true, assignee: false })).toEqual(ON({ assignee: false }));
    expect(normalizeMineFilter({ on: true, author: false, assignee: false, authors: ['alice'] })).toEqual(ON({ author: false, assignee: false, authors: ['alice'] }));
    expect(normalizeMineFilter({ on: true, author: false, assignee: false, authors: ['bad login'] })).toEqual(ON());
  });

  it('a change: both boxes may go while someone is picked; the last condition of any kind is refused', () => {
    const cur = ON({ author: false, assignee: false, authors: ['alice'] });
    expect(setMineFilter(cur, { authors: [] })).toBe(cur);
    expect(setMineFilter(cur, { authors: ['alice'] })).toBe(cur); // same list: nothing changed
    expect(setMineFilter(cur, { authors: 'alice' })).toBe(cur); // not an array: ignored
    expect(setMineFilter(cur, { authors: [], assignee: true })).toEqual(ON({ author: false }));
    expect(setMineFilter(ON(), { author: false, assignee: false, assignees: ['dave', 'Dave'] })).toEqual(ON({ author: false, assignee: false, assignees: ['dave'] }));
  });
});

describe("GitHub#746: the button's words", () => {
  it('「只看我的」 with nobody else picked; 「只看 N 人」 once someone is, me counted once while a box is ticked', () => {
    expect(mineLabel(ON(), 'me')).toBe('只看我的');
    expect(mineLabel(ON({ author: false, assignee: false, authors: ['alice', 'bob'], assignees: ['dave'] }), 'me')).toBe('只看 3 人');
    expect(mineLabel(ON({ assignee: false, authors: ['alice', 'bob'], assignees: ['dave'] }), 'me')).toBe('只看 4 人');
    expect(mineLabel(ON({ author: false, assignee: false, authors: ['alice'], assignees: ['ALICE'] }), 'me')).toBe('只看 1 人');
  });

  it('the hover text names every condition', () => {
    expect(mineTip(ON({ assignee: false, authors: ['alice'], assignees: ['dave'] }), 'me')).toBe('只看 3 人：我提出的、alice 提出的、dave 负责的（满足任一项就显示）');
    expect(mineTip({ ...ON({ authors: ['alice'] }), on: false }, 'me')).toBe('只看 2 人：关');
    expect(mineTip({ ...ON(), on: false }, 'me')).toBe('只看我的：关');
  });
});
