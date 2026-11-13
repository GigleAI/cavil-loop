// GitHub#404: the view bar's three flow numbers and what a click on one does to the search box.
// Counting and the click query must pick the same items, and "等人处理" must be the reminders' own
// rule (isPending) — checked here on the same items through all three paths.
// GitHub#418: the fourth number "未处理" (open, no label at all) — its count and its click query
// `no:label` must pick the same items too.
// GitHub#464: the click queries carry no `is:open` any more — what a click lists is the query through
// the ordinary filter and then, with the number's "显示已关闭" switch off (the default), open items only
// (`openOnly`). That list must equal the count; with the switch on the closed ones come too.

import { describe, expect, it } from 'vitest';
import { flowTally, litTally, showClosedKey, tallyClick, tallyEntries, tallyForget, tallyQuery, unlabeledTally, UNLABELED_QUERY, type TallyEntry } from '../../src/data/flowTally';
import { mergeSnapshots } from '../../src/data/merge';
import { isPending } from '../../src/data/pending';
import { applyFilter, openOnly, parseFilter, statesStated } from '../../src/shared/filter';
import { DEFAULT_HAND_BACK, type Item } from '../../src/shared/types';
import { item } from './helpers';

const L = (...names: string[]) => names.map((name) => ({ name, color: 'ededed' }));
const R = 'o/r';
const ITEMS: Item[] = [
  item(R, 1, { labels: L('doing/agent') }),
  item(R, 2, { labels: L('Doing/Agent') }), // GitHub label names are case-insensitive
  item(R, 3, { labels: L('doing/agent'), state: 'closed', stateReason: 'completed' }), // closed: never counted
  item(R, 4, { labels: L('pending/human'), kind: 'pr' }),
  item(R, 5, { labels: L('pending/human'), kind: 'pr', state: 'merged' }), // merged: never counted
  item(R, 6, { labels: L('pending/human', 'pending/agent') }), // two flow labels at once: counted under both
  item(R, 7, { labels: L('pending/agent'), kind: 'pr', isDraft: true }), // a draft PR is open
  item(R, 8, { labels: L('bug') }),
  item(R, 9, { labels: L('pending/human-ish') }), // a whole-name match, not a prefix
  item(R, 10, {}), // no label at all: "未处理"
  item(R, 11, { kind: 'pr', isDraft: true }), // a draft PR with no label: open, so "未处理"
  item(R, 12, { state: 'closed', stateReason: 'not_planned' }), // closed, no label: never counted
  item(R, 13, { kind: 'pr', state: 'merged' }), // merged, no label: never counted
  item(R, 14, { labels: L('pending/agent'), state: 'closed', stateReason: 'not_planned' }), // closed: never counted
];
const counts = (e: TallyEntry[]) => Object.fromEntries(e.map((x) => [x.kind, x.count]));
const today = '2026-11-12';
/** what a click lists: the query, then open only while the number's switch is off (BoardView does exactly this) */
const listed = (items: Item[], q: string, showClosed = false) => {
  const hit = applyFilter(items, parseFilter(q), { viewer: null, today, projects: [] });
  return (showClosed ? hit : openOnly(hit)).map((i) => i.number);
};

describe('flowTally', () => {
  it('counts open issues and PRs per flow label, whole name, any case, closed / merged left out', () => {
    const e = flowTally(ITEMS, DEFAULT_HAND_BACK);
    expect(e.map((x) => x.kind)).toEqual(['running', 'agent', 'human', 'unlabeled']);
    expect(counts(e)).toEqual({ running: 2, agent: 2, human: 2, unlabeled: 2 });
  });

  it('the count, the click query and the reminders rule pick the same items', () => {
    for (const labels of [DEFAULT_HAND_BACK, { ...DEFAULT_HAND_BACK, running: ' DOING/AGENT ', human: 'Pending/Human' }]) {
      for (const e of flowTally(ITEMS, labels).filter((x) => x.kind !== 'unlabeled')) {
        const viaQuery = listed(ITEMS, e.query!);
        const viaRule = ITEMS.filter((i) => isPending(i, e.label)).map((i) => i.number);
        expect(viaQuery, e.kind).toEqual(viaRule);
        // the number's own switch on: the closed / merged ones carrying the label come too
        const withClosed = ITEMS.filter((i) => i.labels.some((l) => l.name.toLowerCase() === e.label.toLowerCase())).map((i) => i.number);
        expect(listed(ITEMS, e.query!, true), e.kind).toEqual(withClosed);
        expect(withClosed.length, e.kind).toBeGreaterThan(viaRule.length);
        expect(viaRule.length, e.kind).toBe(e.count);
        expect(e.count, e.kind).toBeGreaterThan(0);
      }
    }
  });

  it('an empty running label leaves "运行中" out; the other two are still there', () => {
    const e = flowTally(ITEMS, { ...DEFAULT_HAND_BACK, running: '  ' });
    expect(e.map((x) => x.kind)).toEqual(['agent', 'human', 'unlabeled']);
    expect(counts(e)).toEqual({ agent: 2, human: 2, unlabeled: 2 });
  });

  it('zero is shown as zero (the number stays in place)', () => {
    expect(counts(flowTally([], DEFAULT_HAND_BACK))).toEqual({ running: 0, agent: 0, human: 0, unlabeled: 0 });
  });

  it('every label: either the click shows exactly the counted items, or the number cannot be clicked (PR #408 review round 1)', () => {
    const names = ['>待处理', '<x', '> 空格', 'wait for, me', 'a b', 'pending/human', 'x..y', '-neg', '@me', 'is:open', 'a:b', '中文 标签', 'say "hi"'];
    const unclickable = new Set(['>待处理', '<x', '> 空格', 'say "hi"']);
    for (const name of names) {
      // the label on #1 only, unrelated open items around it, one closed item with it
      const items = [
        item(R, 1, { labels: L(name) }),
        item(R, 2, { labels: L('bug') }),
        item(R, 3, {}),
        item(R, 4, { labels: L(name), state: 'closed', stateReason: 'completed' }),
        item(R, 5, { labels: L(`${name}x`) }),
      ];
      const [e] = flowTally(items, { running: name, agent: 'pending/agent', human: 'pending/human' });
      expect(e.count, name).toBe(1);
      expect(items.filter((i) => isPending(i, e.label)).map((i) => i.number), name).toEqual([1]);
      if (unclickable.has(name)) {
        expect(e.query, name).toBeNull();
        continue;
      }
      expect(e.query, name).not.toBeNull();
      const parsed = parseFilter(e.query!);
      expect(parsed.unsupported, name).toEqual([]);
      expect(listed(items, e.query!), name).toEqual([1]);
      expect(listed(items, e.query!, true), name).toEqual([1, 4]);
    }
  });

  it('labels with spaces / commas still make a working query; a double quote makes none', () => {
    const items = [item(R, 1, { labels: L('wait for, me') }), item(R, 2, { labels: L('x') })];
    const q = tallyQuery(' wait for, me ')!;
    expect(q).toBe('label:"wait for, me"');
    expect(applyFilter(items, parseFilter(q), { viewer: null, today, projects: [] }).map((i) => i.number)).toEqual([1]);
    expect(tallyQuery('say "hi"')).toBeNull();
    expect(tallyQuery('')).toBeNull();
  });
});

describe('GitHub#418: 未处理 (open, no label at all)', () => {
  /** the rule written out here, independent of the filter the app uses */
  const bare = (items: Item[]) => items.filter((i) => i.state === 'open' && i.labels.length === 0).map((i) => i.number);

  it('counts open issues and draft / ready PRs with no label; any label, closed or merged leaves it out', () => {
    expect(bare(ITEMS)).toEqual([10, 11]);
    const u = unlabeledTally(ITEMS);
    expect(u).toEqual({ kind: 'unlabeled', name: '未处理', color: 'ring', source: 'query', label: '', count: 2, query: 'no:label' });
    // one label of any kind is enough to leave: a classification label, the autopilot label, a flow label
    for (const name of ['bug', 'autopilot', 'pending/agent']) {
      expect(unlabeledTally([item(R, 1, { labels: L(name) }), item(R, 2, {})]).count, name).toBe(1);
    }
  });

  it('the count and the click query pick the same items, through the real filter', () => {
    for (const items of [ITEMS, ITEMS.slice(0, 9), [], [item(R, 1, { kind: 'pr' }), item(R, 2, { kind: 'pr', state: 'closed' })]]) {
      const u = unlabeledTally(items);
      const viaQuery = listed(items, u.query!);
      expect(viaQuery).toEqual(bare(items));
      expect(listed(items, u.query!, true)).toEqual(items.filter((i) => i.labels.length === 0).map((i) => i.number));
      expect(u.count).toBe(viaQuery.length);
    }
    expect(parseFilter(UNLABELED_QUERY).unsupported).toEqual([]);
  });

  it('it does not follow the label settings: always there, always last, even with "运行中" cleared', () => {
    for (const labels of [DEFAULT_HAND_BACK, { ...DEFAULT_HAND_BACK, running: '' }, { running: 'x', agent: 'bug', human: 'y' }]) {
      const e = flowTally(ITEMS, labels);
      expect(e.at(-1)).toEqual(unlabeledTally(ITEMS));
      expect(e.filter((x) => x.kind === 'unlabeled')).toHaveLength(1);
    }
  });

  it('an item carried by two sources counts once (the board merges by item before counting)', () => {
    const shared = item(R, 20, {});
    const board = mergeSnapshots(
      [
        { sourceKey: 'a', fetchedAt: 1, items: [shared, item(R, 21, {})] },
        { sourceKey: 'b', fetchedAt: 1, items: [{ ...shared }, item(R, 22, { labels: L('bug') })] },
      ],
      null,
    );
    expect(unlabeledTally(board.items).count).toBe(2);
  });

  it('a click works like the other numbers: lit, back to the search before, switching keeps it', () => {
    const E = flowTally(ITEMS, DEFAULT_HAND_BACK);
    const u = E.find((x) => x.kind === 'unlabeled')!;
    const human = E.find((x) => x.kind === 'human')!;
    let s = tallyClick('新增依赖图视图', null, u, E);
    expect(s).toEqual({ query: UNLABELED_QUERY, saved: '新增依赖图视图' });
    expect(litTally(s.query, E)).toBe('unlabeled');
    s = tallyClick(s.query, s.saved, human, E);
    expect(s).toEqual({ query: 'label:"pending/human"', saved: '新增依赖图视图' });
    s = tallyClick(s.query, s.saved, u, E);
    expect(s).toEqual({ query: UNLABELED_QUERY, saved: '新增依赖图视图' });
    expect(tallyClick(s.query, s.saved, u, E)).toEqual({ query: '新增依赖图视图', saved: null });
    // its query never reads as one of the label numbers' queries
    expect(E.filter((x) => x.query === UNLABELED_QUERY).map((x) => x.kind)).toEqual(['unlabeled']);
  });
});

describe('a click on a number', () => {
  const E = flowTally(ITEMS, DEFAULT_HAND_BACK);
  const [running, agent, human] = E;
  const RUN = 'label:"doing/agent"';
  const HUM = 'label:"pending/human"';

  it('lit = the box says exactly that number\'s query (surrounding spaces ignored)', () => {
    expect(litTally(RUN, E)).toBe('running');
    expect(litTally(`  ${HUM} `, E)).toBe('human');
    expect(litTally(`${RUN} bug`, E)).toBeNull();
    expect(litTally('', E)).toBeNull();
  });

  it('a search, click, click again: the search comes back whole', () => {
    let s = tallyClick('新增依赖图视图', null, running, E);
    expect(s).toEqual({ query: RUN, saved: '新增依赖图视图' });
    s = tallyClick(s.query, s.saved, running, E);
    expect(s).toEqual({ query: '新增依赖图视图', saved: null });
  });

  it('switching numbers keeps the first search; clicking the lit one brings it back', () => {
    let s = tallyClick('新增依赖图视图', null, running, E);
    s = tallyClick(s.query, s.saved, human, E);
    expect(s).toEqual({ query: HUM, saved: '新增依赖图视图' });
    s = tallyClick(s.query, s.saved, human, E);
    expect(s).toEqual({ query: '新增依赖图视图', saved: null });
  });

  it('an empty box: click, click again → empty', () => {
    let s = tallyClick('', null, agent, E);
    expect(s).toEqual({ query: 'label:"pending/agent"', saved: '' });
    expect(tallyClick(s.query, s.saved, agent, E)).toEqual({ query: '', saved: null });
  });

  it('a lit number with nothing remembered (e.g. after a restart) → empty', () => {
    expect(tallyClick(RUN, null, running, E)).toEqual({ query: '', saved: null });
  });

  it('a hand edit that leaves the numbers voids the remembered search', () => {
    const s = tallyClick('foo', null, running, E);
    // the box is typed into: no longer a number's query
    const saved = tallyForget(s.saved, 'bar', E);
    expect(saved).toBeNull();
    // later typed back to a number's query by hand: clicking it does not resurrect "foo"
    expect(tallyClick(HUM, saved, human, E)).toEqual({ query: '', saved: null });
    // while it still shows a number's query, the memory stays
    expect(tallyForget('foo', HUM, E)).toBe('foo');
  });

  it('a label that cannot be written as a query does nothing on click', () => {
    const e = flowTally([], { ...DEFAULT_HAND_BACK, running: 'a"b' });
    expect(e[0].query).toBeNull();
    expect(tallyClick('foo', 'x', e[0], e)).toEqual({ query: 'foo', saved: 'x' });
  });
});

describe('GitHub#464: which "显示已关闭" switch is in effect', () => {
  it('the lit number\'s own (by its row id, a number made in Settings too), whatever the layout; else the layout\'s', () => {
    for (const layout of ['board', 'table', 'graph'] as const) {
      expect(showClosedKey(layout, null)).toBe(layout);
      for (const k of ['running', 'agent', 'human', 'unlabeled', 't-abc'] as const) expect(showClosedKey(layout, k)).toBe(k);
      // a (hand-edited) row id equal to a layout name never shares that layout's switch
      expect(showClosedKey(layout, 'board')).toBe('tally:board');
    }
  });

  it('a condition of one\'s own counts what its click lists with the switch off: open only, unless the condition names the state', () => {
    const defs = [
      { id: 't-1', name: 'human', color: 'gray' as const, source: { kind: 'query' as const, query: 'label:"pending/human"' } },
      { id: 't-2', name: 'closed human', color: 'gray' as const, source: { kind: 'query' as const, query: 'is:closed label:"pending/human"' } },
      { id: 't-3', name: 'all human', color: 'gray' as const, source: { kind: 'query' as const, query: 'label:"pending/human" is:open,closed' } },
    ];
    const E = tallyEntries(ITEMS, defs, DEFAULT_HAND_BACK);
    for (const e of E) {
      const parsed = parseFilter(e.query!);
      const hit = applyFilter(ITEMS, parsed, { viewer: null, today, projects: [] });
      const shown = statesStated(parsed) ? hit : openOnly(hit);
      expect(e.count, e.name).toBe(shown.length);
    }
    expect(E.map((e) => e.count)).toEqual([2, 1, 3]); // #4 #6 open, #5 merged
  });

  it('the old `is:open` click queries no longer light a number (a saved one is migrated, see view settings)', () => {
    const E = flowTally(ITEMS, DEFAULT_HAND_BACK);
    expect(litTally('is:open label:"pending/human"', E)).toBeNull();
    expect(litTally('label:"pending/human"', E)).toBe('human');
    expect(litTally('no:label', E)).toBe('unlabeled');
  });
});
