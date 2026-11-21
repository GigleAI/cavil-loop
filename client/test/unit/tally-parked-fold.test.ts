// GitHub#643: a "稍后处理" number written by hand (a condition of one's own that picks just the parked label)
// folds always by default — when every repository the ticked sources can hold uses that very name as its parked
// label. Everything goes through the view bar's own entry (`viewBarTallies`) with the label settings' own lookup
// (`handBackFor`) and the ticked sources (`parkedScope`); the expected folds are written out here per case.
// Each case also checks that the count and the click text are exactly what they were without the new input.

import { describe, expect, it } from 'vitest';
import { viewBarParked, viewBarTallies, type TallyEntry } from '../../src/data/flowTally';
import { handBackFor, type RepoLabels } from '../../src/shared/repoLabels';
import { parkedScope, soleLabel, tallyFold } from '../../src/shared/tallies';
import { DEFAULT_HAND_BACK, type HandBackLabels, type Item, type SourceConfig, type TallyDef, type TallyFold } from '../../src/shared/types';
import { item } from './helpers';

const L = (...names: string[]) => names.map((name) => ({ name, color: 'ededed' }));
const A = 'o/a';
const B = 'o/b';
const SRC_A: SourceConfig = { kind: 'repo', key: 'repo:o/a', owner: 'o', name: 'a' };
const SRC_B: SourceConfig = { kind: 'repo', key: 'repo:o/b', owner: 'o', name: 'b' };
const SRC_P: SourceConfig = { kind: 'project', key: 'proj:o/1', ownerType: 'org', owner: 'o', number: 1, url: 'https://github.com/orgs/o/projects/1' };

// A parks two items under its own name 「待排期」 and one under the shared name; B uses 「待排期」 as an ordinary label
const ITEMS: Item[] = [
  item(A, 1, { labels: L('待排期') }),
  item(A, 2, { labels: L('待排期') }),
  item(A, 3, { labels: L('pending/later') }),
  item(B, 4, { labels: L('待排期') }),
  item(B, 5, { labels: L('pending/later') }),
];

const row = (q: string, extra: Partial<TallyDef> = {}): TallyDef => ({ id: 't-mine', name: '稍后处理', color: 'purple', source: { kind: 'query', query: q }, ...extra });
const laterFlow: TallyDef = { id: 't-flow', name: '暂缓', color: 'purple', source: { kind: 'flow', flow: 'later' } };

interface Case {
  hb?: Partial<HandBackLabels>;
  own?: RepoLabels;
  sources: SourceConfig[];
  selected?: string[] | null;
}

function bar(c: Case, defs: TallyDef[], items: Item[] = ITEMS, withScope = true): TallyEntry[] {
  const hb = { ...DEFAULT_HAND_BACK, ...c.hb };
  const repoLabels = c.own ?? {};
  const scope = parkedScope(c.sources, c.selected ?? null);
  return viewBarTallies(items, defs, hb, undefined, (r) => handBackFor({ handBack: hb, repoLabels }, r), Object.keys(repoLabels), withScope ? scope : undefined);
}

/** the fold Settings' picker shows for a row — from the same inputs as the bar */
function picker(c: Case, d: TallyDef): TallyFold {
  const hb = { ...DEFAULT_HAND_BACK, ...c.hb };
  const repoLabels = c.own ?? {};
  return tallyFold(d, viewBarParked(hb, (r) => handBackFor({ handBack: hb, repoLabels }, r), Object.keys(repoLabels), parkedScope(c.sources, c.selected ?? null)));
}

/** the fold of one written row under a case; count, click text and the picker checked on the way */
function foldOf(c: Case, q: string, extra: Partial<TallyDef> = {}): TallyFold {
  const d = row(q, extra);
  const [e] = bar(c, [d]);
  const [old] = bar(c, [d], ITEMS, false);
  expect([e.count, e.query]).toEqual([old.count, old.query]);
  expect(picker(c, d)).toBe(e.fold);
  expect(e.folded).toBe(e.fold === 'always' || (e.fold === 'zero' && e.count === 0));
  return e.fold;
}

const renamedA: RepoLabels = { [A]: { hand: { later: '待排期' } } };

describe('GitHub#643: which written condition is "just the parked label"', () => {
  it('one label, optionally with is:open; anything else is not', () => {
    expect(soleLabel('label:"pending/later"')).toBe('pending/later');
    expect(soleLabel('is:open label:"pending/later"')).toBe('pending/later');
    expect(soleLabel('label:pending/later is:open')).toBe('pending/later');
    for (const q of ['label:"pending/later" author:bob', '-label:"pending/later"', 'label:"a","b"', 'label:"pending/later" sometext', 'label:"pending/later" sort:updated', 'is:closed label:"pending/later"', 'label:a label:b', '']) {
      expect(soleLabel(q)).toBeNull();
    }
  });
});

describe('GitHub#643: the default fold of a written 稍后处理 number', () => {
  it('only repository A ticked, no names of its own: the shared parked label folds always, at any count and any case', () => {
    const c: Case = { sources: [SRC_A, SRC_B], selected: [SRC_A.key] };
    for (const q of ['label:"pending/later"', 'is:open label:"pending/later"', 'label:"Pending/Later"']) expect(foldOf(c, q)).toBe('always');
    // a count of 0 folds always too
    const [e] = bar(c, [row('label:"pending/later"')], []);
    expect([e.count, e.fold, e.folded]).toEqual([0, 'always', true]);
    for (const q of ['label:"pending/later" author:bob', '-label:"pending/later"', 'label:"bug"', 'label:"pending/later","x"', 'label:"pending/later" sort:x']) expect(foldOf(c, q)).toBe('zero');
  });

  it('review round 3: only A ticked, A renamed its parked label to 待排期 → 待排期 folds, the shared name does not', () => {
    const c: Case = { own: renamedA, sources: [SRC_A, SRC_B], selected: [SRC_A.key] };
    expect(foldOf(c, 'label:"待排期"')).toBe('always');
    expect(foldOf(c, 'label:"pending/later"')).toBe('zero');
  });

  it('review round 1: A renamed, B uses 待排期 as an ordinary label — with both ticked neither name folds', () => {
    const c: Case = { own: renamedA, sources: [SRC_A, SRC_B], selected: [SRC_A.key, SRC_B.key] };
    expect(foldOf(c, 'label:"待排期"')).toBe('zero');
    expect(foldOf(c, 'label:"pending/later"')).toBe('zero');
    // the number keeps counting B's ordinary label as before, so it is in the bar
    const [e] = bar(c, [row('label:"待排期"')]);
    expect([e.count, e.folded]).toEqual([3, false]);
  });

  it('only A then A + B then A again: folded with 2, in the bar with 3, folded with 2 — over the ticked sources\' items only, as the board merges them', () => {
    // the board hands the bar only the ticked sources' items: written out here per step
    const of = (repos: string[]) => ITEMS.filter((i) => repos.includes(i.repo));
    const steps: [string[], string[], TallyFold, number, boolean][] = [
      [[SRC_A.key], [A], 'always', 2, true],
      [[SRC_A.key, SRC_B.key], [A, B], 'zero', 3, false],
      [[SRC_A.key], [A], 'always', 2, true],
    ];
    for (const [selected, repos, fold, count, folded] of steps) {
      const c: Case = { own: renamedA, sources: [SRC_A, SRC_B], selected };
      const d = row('label:"待排期"');
      const [e] = bar(c, [d], of(repos));
      const [old] = bar(c, [d], of(repos), false);
      expect([e.fold, e.count, e.folded, e.query]).toEqual([fold, count, folded, 'label:"待排期"']);
      expect([old.count, old.query]).toEqual([e.count, e.query]);
      expect(picker(c, d)).toBe(fold);
    }
  });

  it('both renamed to the same name: that name folds', () => {
    const c: Case = { own: { [A]: { hand: { later: '待排期' } }, [B]: { hand: { later: '待排期' } } }, sources: [SRC_A, SRC_B], selected: null };
    expect(foldOf(c, 'label:"待排期"')).toBe('always');
  });

  it('review round 2: an unticked repository that renamed its parked label takes no part', () => {
    const c: Case = { own: { [B]: { hand: { later: '待排期' } } }, sources: [SRC_A, SRC_B], selected: [SRC_A.key] };
    expect(foldOf(c, 'label:"pending/later"')).toBe('always');
  });

  it('a Project ticked: the shared name folds only while no repository renamed its parked label', () => {
    expect(foldOf({ own: { [A]: { hand: { human: 'x/human' } } }, sources: [SRC_P] }, 'label:"pending/later"')).toBe('always');
    expect(foldOf({ own: renamedA, sources: [SRC_P] }, 'label:"pending/later"')).toBe('zero');
    expect(foldOf({ own: renamedA, sources: [SRC_P] }, 'label:"待排期"')).toBe('zero');
    expect(foldOf({ own: renamedA, sources: [SRC_P, SRC_A], selected: [SRC_P.key, SRC_A.key] }, 'label:"pending/later"')).toBe('zero');
  });

  it('no source ticked: judged by the shared name, every count 0', () => {
    const c: Case = { own: renamedA, sources: [SRC_A], selected: [] };
    const [e] = bar(c, [row('label:"pending/later"')], []);
    expect([e.count, e.fold, e.folded]).toEqual([0, 'always', true]);
    expect(picker(c, row('label:"pending/later"'))).toBe('always');
    expect(picker(c, row('label:"bug"'))).toBe('zero');
    expect(parkedScope([], null)).toEqual({ kind: 'none' });
  });

  it('the shared parked label empty ("稍后处理" off), or a repository that blanked its own: never folds always', () => {
    expect(foldOf({ hb: { later: '' }, own: renamedA, sources: [SRC_A] }, 'label:"待排期"')).toBe('zero');
    expect(foldOf({ hb: { later: '' }, sources: [SRC_A] }, 'label:"pending/later"')).toBe('zero');
    expect(foldOf({ own: { [A]: { hand: { later: '' } } }, sources: [SRC_A] }, 'label:"pending/later"')).toBe('zero');
  });

  it('a row following the parked flow label folds always whatever its id; a rule of the row\'s own always wins', () => {
    for (const c of [{ sources: [SRC_A] }, { own: renamedA, sources: [SRC_P] }] as Case[]) {
      expect(bar(c, [laterFlow])[0].fold).toBe('always');
      expect(picker(c, laterFlow)).toBe('always');
    }
    const c: Case = { sources: [SRC_A] };
    expect(foldOf(c, 'label:"pending/later"', { fold: 'never' })).toBe('never');
    expect(foldOf(c, 'label:"pending/later"', { fold: 'zero' })).toBe('zero');
  });

  it('the items in hand never change the default: none, some, all', () => {
    const c: Case = { own: renamedA, sources: [SRC_A, SRC_B], selected: [SRC_A.key] };
    const folds = [[], ITEMS.slice(0, 1), ITEMS].map((items) => bar(c, [row('label:"待排期"'), row('label:"bug"', { id: 't-2' })], items).map((e) => e.fold));
    expect(folds).toEqual([
      ['always', 'zero'],
      ['always', 'zero'],
      ['always', 'zero'],
    ]);
  });

  it('the default table folds exactly as before under every one of these settings', () => {
    const cases: Case[] = [{ sources: [SRC_A] }, { own: renamedA, sources: [SRC_A, SRC_B] }, { own: renamedA, sources: [SRC_P] }, { hb: { later: '' }, sources: [] }];
    for (const c of cases) {
      const now = bar(c, null as unknown as TallyDef[]).map((e) => [e.kind, e.count, e.query, e.fold, e.folded]);
      const before = bar(c, null as unknown as TallyDef[], ITEMS, false).map((e) => [e.kind, e.count, e.query, e.fold, e.folded]);
      expect(now).toEqual(before);
    }
  });
});
