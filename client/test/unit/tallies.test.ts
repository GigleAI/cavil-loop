// GitHub#468: the view-bar numbers as a table set in Settings.
//  - a "跟随流程标签" row counts exactly as the old fixed number (open + whole label name, the reminders'
//    rule), including labels the search syntax cannot carry, and keeps following the label setting
//  - a "自己写条件" row: count and click are the same text through the board's filter and context
//  - what is kept: a whole valid table or nothing (the default, flagged)
// The expected items are written out here with rules of this file, not with the app's functions.

import { describe, expect, it } from 'vitest';
import { flowTally, litTally, tallyClick, tallyEntries, tallyQuery } from '../../src/data/flowTally';
import { applyFilter, parseFilter } from '../../src/shared/filter';
import { DEFAULT_TALLIES, defaultTallies, effectiveTallies, normalizeTallies, tallyFold, TALLY_FOLDS, TALLY_MAX, UNLABELED_QUERY } from '../../src/shared/tallies';
import { toQueryRow } from '../../src/renderer/TallySettings';
import { DEFAULT_HAND_BACK, type Item, type TallyDef } from '../../src/shared/types';
import { item } from './helpers';

const L = (...names: string[]) => names.map((name) => ({ name, color: 'ededed' }));
const R = 'o/r';
const today = '2026-11-13';
/** open + carries the label, whole name, any case — written out here */
const carrying = (items: Item[], label: string) => items.filter((i) => i.state === 'open' && i.labels.some((l) => l.name.toLowerCase() === label.trim().toLowerCase())).map((i) => i.number);
/** GitHub#462: the "等人处理" rule — carries the label, open or closed */
const carryingAny = (items: Item[], label: string) => items.filter((i) => i.labels.some((l) => l.name.toLowerCase() === label.trim().toLowerCase())).map((i) => i.number);

const ITEMS: Item[] = [
  item(R, 1, { labels: L('doing/agent'), author: 'alice' }),
  item(R, 2, { labels: L('pending/human'), kind: 'pr', author: 'bob' }),
  item(R, 3, { labels: L('pending/human'), state: 'closed', stateReason: 'completed', author: 'bob' }),
  item(R, 4, { labels: L('pending/agent'), kind: 'pr', author: 'Bob' }),
  item(R, 5, { kind: 'pr', author: 'bob' }),
  item(R, 6, { kind: 'pr', state: 'merged', author: 'bob' }),
  item(R, 7, { labels: L('bug') }),
];
const flow = (id: string, f: 'running' | 'agent' | 'human' | 'later', extra: Partial<TallyDef> = {}): TallyDef => ({ id, name: id, color: 'blue', source: { kind: 'flow', flow: f }, ...extra });
const query = (id: string, q: string, extra: Partial<TallyDef> = {}): TallyDef => ({ id, name: id, color: 'purple', source: { kind: 'query', query: q }, ...extra });

// GitHub#514: two parked items — one open (counted by "稍后处理"), one closed (not)
const PARKED: Item[] = [...ITEMS, item(R, 8, { labels: L('pending/later') }), item(R, 9, { labels: L('Pending/Later'), state: 'closed', stateReason: 'not_planned' })];

describe('the default table', () => {
  it('GitHub#514: 未处理 → 等人处理 → 等 agent → 运行中 → 稍后处理; the older four keep their ids, names and colours, and count by the old fixed rules', () => {
    expect(DEFAULT_TALLIES.map((d) => [d.id, d.name, d.color, d.source.kind])).toEqual([
      ['unlabeled', '未处理', 'ring', 'query'],
      ['human', '等人处理', 'orange', 'flow'],
      ['agent', '等 agent', 'blue', 'flow'],
      ['running', '运行中', 'green', 'flow'],
      ['later', '稍后处理', 'purple', 'flow'],
    ]);
    expect(DEFAULT_TALLIES.find((d) => d.id === 'later')!.source).toEqual({ kind: 'flow', flow: 'later' });
    const e = tallyEntries(PARKED, defaultTallies(), DEFAULT_HAND_BACK);
    expect(e.map((x) => [x.kind, x.count])).toEqual([
      ['unlabeled', PARKED.filter((i) => i.state === 'open' && i.labels.length === 0).length],
      ['human', carryingAny(PARKED, 'pending/human').length],
      ['agent', carrying(PARKED, 'pending/agent').length],
      ['running', carrying(PARKED, 'doing/agent').length],
      ['later', carrying(PARKED, 'pending/later').length],
    ]);
    // #3 is closed and carries pending/human: "等人处理" counts it (GitHub#462); the closed parked #9 is not counted
    expect(e.map((x) => x.count)).toEqual([1, 2, 1, 1, 1]);
    expect(e).toEqual(flowTally(PARKED, DEFAULT_HAND_BACK));
  });

  it('GitHub#514: "稍后处理" follows the parked label — renamed (any case), and left out when it is empty', () => {
    const later = (hb: typeof DEFAULT_HAND_BACK) => tallyEntries(PARKED, defaultTallies(), hb).find((x) => x.kind === 'later');
    expect(later(DEFAULT_HAND_BACK)!).toMatchObject({ label: 'pending/later', count: 1, query: 'label:"pending/later"', flow: 'later', color: 'purple' });
    expect(later({ ...DEFAULT_HAND_BACK, later: 'bug' })!).toMatchObject({ label: 'bug', count: carrying(PARKED, 'bug').length });
    expect(carrying(PARKED, 'bug').length).toBeGreaterThan(0);
    expect(later({ ...DEFAULT_HAND_BACK, later: '' })).toBeUndefined();
    expect(later({ ...DEFAULT_HAND_BACK, later: '  ' })).toBeUndefined();
    // the others are not touched by it
    expect(tallyEntries(PARKED, defaultTallies(), { ...DEFAULT_HAND_BACK, later: '' }).map((x) => x.kind)).toEqual(['unlabeled', 'human', 'agent', 'running']);
  });

  it('a copy is handed out: editing it does not change the default', () => {
    const a = defaultTallies();
    a[1].name = 'x';
    (a[0].source as { query: string }).query = 'y';
    expect(defaultTallies()[1].name).toBe('等人处理');
    expect(defaultTallies()[0].source).toEqual({ kind: 'query', query: UNLABELED_QUERY });
  });
});

describe('a row that follows a flow label (review round 1 of the design: labels the search syntax cannot carry)', () => {
  for (const name of ['>待处理', 'say "hi"', '<x', 'a"b']) {
    it(`"${name}": counted exactly (not every item, not 0), not clickable`, () => {
      const items = [item(R, 1, { labels: L(name) }), item(R, 2, { labels: L('bug') }), item(R, 3, { labels: L(name), state: 'closed' })];
      const labels = { running: '', agent: 'pending/agent', human: name, later: '' };
      // "等人处理" counts the closed #3 too (GitHub#462); "运行中" only the open #1
      const [e] = tallyEntries(items, [flow('h', 'human')], labels);
      expect(e.count).toBe(2);
      expect(carryingAny(items, name)).toEqual([1, 3]);
      expect(e.query).toBeNull();
      expect(tallyClick('foo', null, e, [e])).toEqual({ query: 'foo', saved: null, pick: null });
      const [r] = tallyEntries(items, [flow('r', 'running')], { ...labels, running: name });
      expect(r.count).toBe(1);
      expect(carrying(items, name)).toEqual([1]);
      expect(r.query).toBeNull();
      // the default table counts it the same way
      expect(tallyEntries(items, defaultTallies(), labels).find((x) => x.kind === 'human')!.count).toBe(2);
    });
  }

  it('keeps following the label setting after the table was saved (renamed, recoloured, moved)', () => {
    const saved = normalizeTallies([query('mine', 'is:open author:@me'), flow('h', 'human', { name: '待我', color: 'red' })]).tallies!;
    for (const human of ['pending/human', 'pending/agent', 'Doing/Agent', 'bug']) {
      const e = tallyEntries(ITEMS, saved, { ...DEFAULT_HAND_BACK, human }).find((x) => x.kind === 'h')!;
      expect(e.count, human).toBe(carryingAny(ITEMS, human).length);
      expect(e.count, human).toBeGreaterThan(0);
      expect(e.label).toBe(human);
      expect([e.name, e.color]).toEqual(['待我', 'red']);
    }
  });

  it('an empty label leaves that row out; a clickable one clicks to the same items it counts', () => {
    expect(tallyEntries(ITEMS, [flow('r', 'running')], { ...DEFAULT_HAND_BACK, running: ' ' })).toEqual([]);
    const [e] = tallyEntries(ITEMS, [flow('r', 'running')], DEFAULT_HAND_BACK);
    expect(e.query).toBe('label:"doing/agent"');
    expect(applyFilter(ITEMS, parseFilter(e.query!), { viewer: null, today, projects: [] }).map((i) => i.number)).toEqual(carrying(ITEMS, 'doing/agent'));
  });
});

describe('a row with a condition of its own', () => {
  const ctx = { viewer: 'bob', today, projects: [] };

  it('counts through the board filter with the board context; a click shows exactly those items', () => {
    const mine = query('mine', 'is:open is:pr author:@me');
    const [e] = tallyEntries(ITEMS, [mine], DEFAULT_HAND_BACK, ctx);
    // open PRs by bob (any case), written out here
    const want = ITEMS.filter((i) => i.state === 'open' && i.kind === 'pr' && i.author?.toLowerCase() === 'bob').map((i) => i.number);
    expect(want).toEqual([2, 4, 5]);
    expect(e.count).toBe(want.length);
    expect(e.query).toBe('is:open is:pr author:@me');
    expect(applyFilter(ITEMS, parseFilter(e.query!), ctx).map((i) => i.number)).toEqual(want);
    // another viewer, another count
    expect(tallyEntries(ITEMS, [mine], DEFAULT_HAND_BACK, { ...ctx, viewer: 'alice' })[0].count).toBe(0);
  });

  it('an unsupported part is ignored in the count and in the click alike', () => {
    const [e] = tallyEntries(ITEMS, [query('rr', 'is:open review-requested:@me')], DEFAULT_HAND_BACK, ctx);
    expect(parseFilter(e.query!).unsupported).toEqual(['review-requested:@me']);
    expect(e.count).toBe(applyFilter(ITEMS, parseFilter(e.query!), ctx).length);
    expect(e.count).toBe(ITEMS.filter((i) => i.state === 'open').length);
  });

  it('an empty name or an empty condition is not shown; the order and the colours are the table\'s', () => {
    const defs = [query('a', 'is:open', { name: '  ' }), query('b', '   '), query('c', 'is:issue', { color: 'gray' }), flow('d', 'agent', { color: 'red' })];
    const e = tallyEntries(ITEMS, defs, DEFAULT_HAND_BACK, ctx);
    expect(e.map((x) => [x.kind, x.color])).toEqual([
      ['c', 'gray'],
      ['d', 'red'],
    ]);
    expect(tallyEntries(ITEMS, [], DEFAULT_HAND_BACK, ctx)).toEqual([]);
  });

  it('two rows with the same click text: the first is lit', () => {
    const e = tallyEntries(ITEMS, [query('x', 'is:open'), query('y', 'is:open')], DEFAULT_HAND_BACK, ctx);
    expect(litTally('is:open', e)).toBe('x');
  });
});

describe('改成自己写条件 / 改回跟随流程标签', () => {
  it('a label the syntax can carry becomes its exact query; one it cannot becomes empty, never a query that counts something else', () => {
    const labels = { running: 'doing/agent', agent: '>待处理', human: 'say "hi"', later: '' };
    expect(toQueryRow(flow('r', 'running'), labels).source).toEqual({ kind: 'query', query: 'label:"doing/agent"', from: 'running' });
    expect(toQueryRow(flow('a', 'agent'), labels).source).toEqual({ kind: 'query', query: '', from: 'agent' });
    expect(toQueryRow(flow('h', 'human'), labels).source).toEqual({ kind: 'query', query: '', from: 'human' });
    // the converted row counts the same items as the flow row it came from
    const items = [item(R, 1, { labels: L('doing/agent') }), item(R, 2, {})];
    const before = tallyEntries(items, [flow('r', 'running')], labels)[0];
    const after = tallyEntries(items, [toQueryRow(flow('r', 'running'), labels)], labels)[0];
    expect([after.count, after.query]).toEqual([before.count, before.query]);
    // GitHub#462: "等人处理" still counts the closed ones after the conversion
    const plain = { ...labels, human: 'pending/human' };
    const withClosed = [item(R, 1, { labels: L('pending/human') }), item(R, 2, { labels: L('pending/human'), state: 'closed' }), item(R, 3, {})];
    // GitHub#464: a condition of one's own counts open items only unless it names the state, so "等人处理"'s says it
    expect(toQueryRow(flow('h', 'human'), plain).source).toEqual({ kind: 'query', query: 'label:"pending/human" is:open,closed', from: 'human' });
    const hBefore = tallyEntries(withClosed, [flow('h', 'human')], plain)[0];
    const hAfter = tallyEntries(withClosed, [toQueryRow(flow('h', 'human'), plain)], plain)[0];
    expect([hAfter.count, hAfter.query]).toEqual([2, 'label:"pending/human" is:open,closed']);
    expect(hAfter.count).toBe(hBefore.count);
    // an empty converted row is left off the bar rather than counting everything
    expect(tallyEntries(items, [toQueryRow(flow('a', 'agent'), labels)], labels)).toEqual([]);
    expect(tallyQuery('>待处理')).toBeNull();
  });
});

describe('what is kept', () => {
  it('nothing kept = the default, not broken', () => {
    expect(normalizeTallies(null)).toEqual({ tallies: null, broken: false });
    expect(normalizeTallies(undefined)).toEqual({ tallies: null, broken: false });
    expect(effectiveTallies(null)).toEqual(defaultTallies());
  });

  it('a valid table is read back whole, an empty one too', () => {
    const t = [query('mine', 'is:open author:@me'), { ...flow('h', 'human'), source: { kind: 'query' as const, query: '', from: 'human' as const } }];
    expect(normalizeTallies(t)).toEqual({ tallies: t, broken: false });
    expect(normalizeTallies([])).toEqual({ tallies: [], broken: false });
    expect(normalizeTallies(defaultTallies()).tallies).toEqual(defaultTallies());
  });

  it('anything else is broken: the default is used, never half the table', () => {
    const ok = query('a', 'is:open');
    const bad: unknown[] = [
      'x',
      { a: 1 },
      [ok, { ...ok, id: 'b', color: 'pink' }],
      [ok, { ...ok, id: 'b', source: { kind: 'flow', flow: 'blocked' } }],
      [ok, { ...ok, id: 'b', source: { kind: 'other' } }],
      [ok, { ...ok, id: 'b', source: { kind: 'query', query: 1 } }],
      [ok, { ...ok, id: 'b', source: { kind: 'query', query: '', from: 'x' } }],
      [ok, { ...ok, id: '' }],
      [ok, { ...ok, name: 3, id: 'b' }],
      [ok, ok],
      [ok, null],
      Array.from({ length: TALLY_MAX + 1 }, (_, i) => query(`r${i}`, 'is:open')),
    ];
    for (const v of bad) expect(normalizeTallies(v), JSON.stringify(v)).toEqual({ tallies: null, broken: true });
    expect(normalizeTallies(Array.from({ length: TALLY_MAX }, (_, i) => query(`r${i}`, 'is:open'))).broken).toBe(false);
  });
});

// GitHub#634: a number goes into the fold at the end of the bar by its row's rule — never / at 0 / always.
// The expected answers are written out here, not computed with the app's functions.
describe('GitHub#634: folding', () => {
  const NONE = 'label:"no-such-label"'; // counts 0 over ITEMS
  const SOME = 'is:open'; // counts > 0 over ITEMS

  it('the default rows: 运行中 never, 稍后处理 always, the other three at 0', () => {
    expect(DEFAULT_TALLIES.map((d) => [d.id, d.fold])).toEqual([
      ['unlabeled', 'zero'],
      ['human', 'zero'],
      ['agent', 'zero'],
      ['running', 'never'],
      ['later', 'always'],
    ]);
    expect(TALLY_FOLDS).toEqual(['never', 'zero', 'always']);
  });

  it('all six combinations of rule × count (0 / not 0)', () => {
    expect(applyFilter(ITEMS, parseFilter(NONE), { viewer: null, today, projects: [] }).length).toBe(0);
    const defs: TallyDef[] = [];
    for (const f of ['never', 'zero', 'always'] as const) {
      defs.push(query(`${f}-0`, NONE, { fold: f }), query(`${f}-n`, SOME, { fold: f }));
    }
    const e = tallyEntries(ITEMS, defs, DEFAULT_HAND_BACK, { viewer: null, today, projects: [] });
    expect(e.map((x) => [x.kind, x.count > 0, x.folded])).toEqual([
      ['never-0', false, false],
      ['never-n', true, false],
      ['zero-0', false, true],
      ['zero-n', true, false],
      ['always-0', false, true],
      ['always-n', true, true],
    ]);
    // flow rows fold by the same rule: "运行中" (1 here) never, "等 agent" at 0, "稍后处理" (0 here) always
    const hb = DEFAULT_HAND_BACK;
    const flows = tallyEntries(ITEMS, [flow('a', 'agent', { fold: 'zero' }), flow('b', 'agent', { fold: 'always' }), flow('c', 'later', { fold: 'never' })], hb);
    expect(flows.map((x) => [x.kind, x.count, x.folded])).toEqual([
      ['a', 1, false],
      ['b', 1, true],
      ['c', 0, false],
    ]);
  });

  it('the default table over items: 稍后处理 folded with a count, 运行中 shown, 等 agent folded at 0', () => {
    const parked = [...ITEMS, item(R, 8, { labels: L('pending/later') })];
    const e = tallyEntries(parked, defaultTallies(), DEFAULT_HAND_BACK);
    expect(e.map((x) => [x.kind, x.count, x.folded])).toEqual([
      ['unlabeled', 1, false],
      ['human', 2, false],
      ['agent', 1, false],
      ['running', 1, false],
      ['later', 1, true],
    ]);
    const quiet = ITEMS.filter((i) => !i.labels.some((l) => ['doing/agent', 'pending/agent'].includes(l.name)));
    expect(tallyEntries(quiet, defaultTallies(), DEFAULT_HAND_BACK).map((x) => [x.kind, x.count, x.folded])).toEqual([
      ['unlabeled', 1, false],
      ['human', 2, false],
      ['agent', 0, true],
      ['running', 0, false],
      ['later', 0, true],
    ]);
  });

  it('a row with no rule of its own takes its id\'s default: the default rows\' own, any other row at 0', () => {
    expect(tallyFold({ id: 'running' })).toBe('never');
    expect(tallyFold({ id: 'later' })).toBe('always');
    expect(tallyFold({ id: 'human' })).toBe('zero');
    expect(tallyFold({ id: 't-abc' })).toBe('zero');
    // its own rule wins over the id's default
    expect(tallyFold({ id: 'later', fold: 'never' })).toBe('never');
    // "改成自己写条件" keeps the id, so the parked row turned into a condition still folds always
    const later = defaultTallies().find((d) => d.id === 'later')!;
    const turned = toQueryRow({ id: later.id, name: later.name, color: later.color, source: later.source }, { running: 'doing/agent', agent: 'pending/agent', human: 'pending/human', later: 'pending/later' });
    expect(tallyFold(turned)).toBe('always');
  });

  it('a table saved before folding existed reads back unchanged (names, colours, order, conditions) and folds by the defaults', () => {
    const old = [
      { id: 'later', name: '以后再说', color: 'red', source: { kind: 'flow', flow: 'later' } },
      { id: 'running', name: 'running!', color: 'blue', source: { kind: 'flow', flow: 'running' } },
      { id: 't-mine', name: '我的', color: 'gray', source: { kind: 'query', query: NONE } },
      { id: 'human', name: '等人处理', color: 'orange', source: { kind: 'query', query: 'label:"pending/human" is:open,closed', from: 'human' } },
    ];
    const r = normalizeTallies(JSON.parse(JSON.stringify(old)));
    expect(r.broken).toBe(false);
    expect(r.tallies).toEqual(old);
    expect(r.tallies!.every((d) => !('fold' in d))).toBe(true);
    const e = tallyEntries(ITEMS, r.tallies!, DEFAULT_HAND_BACK, { viewer: null, today, projects: [] });
    expect(e.map((x) => [x.kind, x.name, x.color, x.fold, x.folded])).toEqual([
      ['later', '以后再说', 'red', 'always', true],
      ['running', 'running!', 'blue', 'never', false],
      ['t-mine', '我的', 'gray', 'zero', true],
      ['human', '等人处理', 'orange', 'zero', false],
    ]);
    // one row changed and saved: the new rule is kept, nothing else moves
    const saved = r.tallies!.map((d) => (d.id === 'running' ? { ...d, fold: 'always' as const } : d));
    const back = normalizeTallies(JSON.parse(JSON.stringify(saved)));
    expect(back).toEqual({ tallies: saved, broken: false });
    expect(tallyEntries(ITEMS, back.tallies!, DEFAULT_HAND_BACK).find((x) => x.kind === 'running')!.folded).toBe(true);
  });

  it('an unknown rule breaks the whole table (the default is shown, flagged) — never half of it', () => {
    for (const bad of ['sometimes', '', 'Zero', 1, null, true, {}]) {
      const r = normalizeTallies([{ id: 'a', name: 'a', color: 'blue', source: { kind: 'query', query: SOME }, fold: bad }, { id: 'b', name: 'b', color: 'blue', source: { kind: 'query', query: SOME } }]);
      expect(r).toEqual({ tallies: null, broken: true });
      expect(effectiveTallies(r.tallies)).toEqual(defaultTallies());
    }
    for (const good of TALLY_FOLDS) {
      expect(normalizeTallies([{ id: 'a', name: 'a', color: 'blue', source: { kind: 'query', query: SOME }, fold: good }]).broken).toBe(false);
    }
  });

  it('rows the bar never shows (empty name, empty condition, an empty flow label) are not in the fold either', () => {
    const defs: TallyDef[] = [
      query('blank-name', NONE, { name: ' ', fold: 'always' }),
      query('blank-cond', '  ', { fold: 'always' }),
      flow('no-label', 'later', { fold: 'always' }),
      query('real', NONE, { fold: 'zero' }),
    ];
    const e = tallyEntries(ITEMS, defs, { ...DEFAULT_HAND_BACK, later: '' }, { viewer: null, today, projects: [] });
    expect(e.map((x) => x.kind)).toEqual(['real']);
    expect(e.filter((x) => x.folded).map((x) => x.kind)).toEqual(['real']);
  });

  it('which number is lit and what a click gives back are worked out on the whole list, folded or not', () => {
    const quiet = ITEMS.filter((i) => !i.labels.some((l) => l.name === 'pending/agent'));
    const shown = tallyEntries(ITEMS, defaultTallies(), DEFAULT_HAND_BACK);
    const gone = tallyEntries(quiet, defaultTallies(), DEFAULT_HAND_BACK);
    expect(shown.find((x) => x.kind === 'agent')!.folded).toBe(false);
    expect(gone.find((x) => x.kind === 'agent')!.folded).toBe(true);
    // "等 agent" lit from the search "bug"; it drops to 0 and folds: still lit, a click still gives "bug" back
    const on = tallyClick('bug', null, shown.find((x) => x.kind === 'agent')!, shown);
    expect(on).toEqual({ query: 'label:"pending/agent"', saved: 'bug', pick: 'agent' });
    expect(litTally(on.query, gone, on.pick)).toBe('agent');
    expect(tallyClick(on.query, on.saved, gone.find((x) => x.kind === 'agent')!, gone, on.pick)).toEqual({ query: 'bug', saved: null, pick: null });
  });
});
