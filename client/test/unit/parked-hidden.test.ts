// GitHub#708 / #741: while 「显示稍后处理」 is off the board leaves out the items carrying their repository's parked
// label ("稍后处理", LABEL_PENDING_LATER), unless the search names that label itself (`parkedStated`). The switch is
// a view setting, on by default (`normalizeView`). `parkedKeys` is the one rule; these cases are the unit rows of the
// acceptance matrix on the issue (1 base, 5 label left empty, 6 a repository renamed it, 7 closed), and the
// open part of what it picks must be exactly what the view bar's "稍后处理" number counts — one recognition.

import { describe, expect, it } from 'vitest';
import { parkedKeys, parkedNames, parkedStated, viewBarTallies } from '../../src/data/flowTally';
import { parseFilter } from '../../src/shared/filter';
import { DEFAULT_VIEW, isValidView, normalizeView } from '../../src/shared/viewSettings';
import { DEFAULT_HAND_BACK, type HandBackLabels, type Item } from '../../src/shared/types';
import { item } from './helpers';

const L = (...names: string[]) => names.map((name) => ({ name, color: 'ededed' }));
const A = 'o/a';
const B = 'o/b';
const hand = (later: string): HandBackLabels => ({ ...DEFAULT_HAND_BACK, later });
const keep = (items: Item[], hidden: Set<string>) => items.filter((it) => !hidden.has(it.key)).map((it) => it.number);

describe('parkedKeys (GitHub#708)', () => {
  const items: Item[] = [
    item(A, 1, { labels: L('pending/later') }), // P1, open, parked
    item(A, 2, { labels: L('Pending/Later', 'bug') }), // P2, open, parked (names are case-insensitive)
    item(A, 3, { labels: L('pending/human') }),
    item(A, 4, { labels: L('pending/later-ish') }), // a whole-name match, not a prefix
    item(A, 5, {}),
    item(A, 6, { labels: L('pending/later'), state: 'closed', stateReason: 'completed' }), // C1, closed, parked
    item(A, 7, { labels: L('pending/later'), kind: 'pr', state: 'merged' }),
  ];

  it('scenario 1 / 7: picks every item carrying the parked label, open or closed, and keeps the rest in order', () => {
    const hidden = parkedKeys(items, 'pending/later', () => 'pending/later');
    expect([...hidden].sort()).toEqual(['o/a#1', 'o/a#2', 'o/a#6', 'o/a#7']);
    expect(keep(items, hidden)).toEqual([3, 4, 5]);
  });

  it('scenario 5: the shared parked label left empty hides nothing, even when a repository has a name of its own', () => {
    expect(parkedKeys(items, '', () => 'pending/later').size).toBe(0);
    expect(parkedKeys(items, '   ', () => 'pending/later').size).toBe(0);
    // the number is left out in the same case: nothing to click, so nothing may be hidden
    const later = viewBarTallies(items, null, hand('')).find((e) => e.kind === 'later');
    expect(later).toBeUndefined();
  });

  it('scenario 6: each item by its own repository\'s name', () => {
    const two: Item[] = [
      item(B, 1, { labels: L('later/b') }), // Q1: B's parked name
      item(A, 2, { labels: L('later/b') }), // Q2: not A's parked name
      item(B, 3, { labels: L('pending/later') }), // the shared name is not B's any more
      item(A, 4, { labels: L('pending/later') }),
    ];
    const laterOf = (repo: string) => (repo === B ? 'later/b' : 'pending/later');
    const hidden = parkedKeys(two, 'pending/later', laterOf);
    expect([...hidden].sort()).toEqual(['o/a#4', 'o/b#1']);
    expect(keep(two, hidden)).toEqual([2, 3]);
    // a repository whose own name is empty hides nothing of its own
    expect([...parkedKeys(two, 'pending/later', (r) => (r === B ? '' : 'pending/later'))]).toEqual(['o/a#4']);
  });

  it('picks the same open items the "稍后处理" number counts (one recognition), shared and per repository', () => {
    const mixed: Item[] = [...items, item(B, 8, { labels: L('later/b') }), item(B, 9, { labels: L('pending/later') })];
    const byRepo = (repo: string) => hand(repo === B ? 'later/b' : 'pending/later');
    const entry = viewBarTallies(mixed, null, hand('pending/later'), undefined, byRepo, [B]).find((e) => e.kind === 'later')!;
    const hidden = parkedKeys(mixed, 'pending/later', (r) => byRepo(r).later);
    const openHidden = mixed.filter((it) => it.state === 'open' && hidden.has(it.key));
    expect(openHidden.map((it) => it.key).sort()).toEqual(['o/a#1', 'o/a#2', 'o/b#8']);
    expect(entry.count).toBe(openHidden.length);
  });
});

describe('parkedStated (GitHub#741): a search that names the parked label decides instead of the switch', () => {
  const names = ['pending/later', 'later/b'];
  const stated = (q: string, lit: { flow: 'later' | 'human' | null } | null = null, ns: string[] = names) => parkedStated(parseFilter(q), ns, lit);

  it('names it: label: with the shared name or a repository\'s own, negated or not, quoted or not, any case, one of several values', () => {
    for (const q of ['label:pending/later', 'label:"pending/later"', '-label:pending/later', 'LABEL:Pending/Later', 'label:later/b', 'label:bug,pending/later', 'is:open label:later/b assignee:@me']) {
      expect(stated(q), q).toBe(true);
    }
  });

  it('does not name it: other labels, a free-text word, a prefix, other fields, an empty search', () => {
    for (const q of ['', 'label:bug', 'pending/later', 'label:pending/later-ish', 'label:pending', 'no:label', 'has:label', 'milestone:pending/later', 'is:open']) {
      expect(stated(q), q).toBe(false);
    }
  });

  it('the lit 「稍后处理」 number names it (its own repositories may call it differently); another lit number does not', () => {
    expect(stated('', { flow: 'later' })).toBe(true);
    expect(stated('label:"pending/human"', { flow: 'human' })).toBe(false);
    expect(stated('label:"pending/later"', { flow: null })).toBe(true);
  });

  it('no names (the parked label left empty) name nothing', () => {
    expect(stated('label:pending/later', null, ['', '  '])).toBe(false);
  });
});

describe('the 「显示稍后处理」 view setting (GitHub#741)', () => {
  it('is on by default, and a view saved before the switch (or holding anything but a boolean) reads as on', () => {
    expect(DEFAULT_VIEW.showParked).toBe(true);
    const { showParked: _gone, ...old } = DEFAULT_VIEW;
    expect(normalizeView(old).showParked).toBe(true);
    for (const v of ['false', 0, null, {}]) expect(normalizeView({ ...old, showParked: v }).showParked).toBe(true);
  });

  it('a saved off reads back off, a saved on reads back on', () => {
    expect(normalizeView({ ...DEFAULT_VIEW, showParked: false }).showParked).toBe(false);
    expect(normalizeView(JSON.parse(JSON.stringify({ ...DEFAULT_VIEW, showParked: false }))).showParked).toBe(false);
    expect(normalizeView({ ...DEFAULT_VIEW, showParked: true }).showParked).toBe(true);
  });

  it('a change from the window must be a boolean', () => {
    expect(isValidView({ ...DEFAULT_VIEW, showParked: false })).toBe(true);
    expect(isValidView({ ...DEFAULT_VIEW, showParked: 'no' })).toBe(false);
    const { showParked: _gone, ...old } = DEFAULT_VIEW;
    expect(isValidView(old)).toBe(false);
  });
});

describe('parkedNames (GitHub#741 review round 1 problem 1): only the repositories holding the ticked sources\' items', () => {
  const laterOf = (repo: string) => ({ 'o/b': 'later/b', 'o/gone': 'bug' } as Record<string, string>)[repo] ?? 'pending/later';
  const items: Item[] = [item(A, 1, { labels: L('pending/later', 'bug') }), item(B, 2, {}), item(A, 3, {})];

  it('each held repository by its own name, the shared one elsewhere, once each', () => {
    expect(parkedNames(items, 'pending/later', laterOf).sort()).toEqual(['later/b', 'pending/later']);
  });

  it('a repository with settings of its own but no item here (not ticked, or removed) names nothing', () => {
    const names = parkedNames(items, 'pending/later', laterOf);
    expect(names).not.toContain('bug');
    // so its name cannot step the switch aside: a search for "bug" over the ticked items hides o/a#1 as usual
    expect(parkedStated(parseFilter('label:bug'), names, null)).toBe(false);
    expect(parkedStated(parseFilter('label:pending/later'), names, null)).toBe(true);
    // the same item is hidden by the one rule
    expect([...parkedKeys(items, 'pending/later', laterOf)]).toEqual(['o/a#1']);
  });

  it('the shared name empty, or no item, names nothing', () => {
    expect(parkedNames(items, '', laterOf)).toEqual([]);
    expect(parkedNames([], 'pending/later', laterOf)).toEqual([]);
    expect(parkedNames([item(A, 1, {})], 'pending/later', (r) => (r === A ? '' : 'x'))).toEqual([]);
  });
});
