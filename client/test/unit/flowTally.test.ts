// GitHub#404: the view bar's three flow numbers and what a click on one does to the search box.
// Counting and the click query must pick the same items, and "等人处理" must be the reminders' own
// rule (isPending) — checked here on the same items through all three paths.

import { describe, expect, it } from 'vitest';
import { flowTally, litTally, tallyClick, tallyForget, tallyQuery, type TallyEntry } from '../../src/data/flowTally';
import { isPending } from '../../src/data/pending';
import { applyFilter, parseFilter } from '../../src/shared/filter';
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
  item(R, 10, {}),
];
const counts = (e: TallyEntry[]) => Object.fromEntries(e.map((x) => [x.kind, x.count]));
const today = '2026-11-12';

describe('flowTally', () => {
  it('counts open issues and PRs per flow label, whole name, any case, closed / merged left out', () => {
    const e = flowTally(ITEMS, DEFAULT_HAND_BACK);
    expect(e.map((x) => x.kind)).toEqual(['running', 'agent', 'human']);
    expect(counts(e)).toEqual({ running: 2, agent: 2, human: 2 });
  });

  it('the count, the click query and the reminders rule pick the same items', () => {
    for (const labels of [DEFAULT_HAND_BACK, { ...DEFAULT_HAND_BACK, running: ' DOING/AGENT ', human: 'Pending/Human' }]) {
      for (const e of flowTally(ITEMS, labels)) {
        const viaQuery = applyFilter(ITEMS, parseFilter(e.query!), { viewer: null, today, projects: [] }).map((i) => i.number);
        const viaRule = ITEMS.filter((i) => isPending(i, e.label)).map((i) => i.number);
        expect(viaQuery, e.kind).toEqual(viaRule);
        expect(viaRule.length, e.kind).toBe(e.count);
        expect(e.count, e.kind).toBeGreaterThan(0);
      }
    }
  });

  it('an empty running label leaves "运行中" out; the other two are still there', () => {
    const e = flowTally(ITEMS, { ...DEFAULT_HAND_BACK, running: '  ' });
    expect(e.map((x) => x.kind)).toEqual(['agent', 'human']);
    expect(counts(e)).toEqual({ agent: 2, human: 2 });
  });

  it('zero is shown as zero (the number stays in place)', () => {
    expect(counts(flowTally([], DEFAULT_HAND_BACK))).toEqual({ running: 0, agent: 0, human: 0 });
  });

  it('labels with spaces / commas still make a working query; a double quote makes none', () => {
    const items = [item(R, 1, { labels: L('wait for, me') }), item(R, 2, { labels: L('x') })];
    const q = tallyQuery(' wait for, me ')!;
    expect(q).toBe('is:open label:"wait for, me"');
    expect(applyFilter(items, parseFilter(q), { viewer: null, today, projects: [] }).map((i) => i.number)).toEqual([1]);
    expect(tallyQuery('say "hi"')).toBeNull();
    expect(tallyQuery('')).toBeNull();
  });
});

describe('a click on a number', () => {
  const E = flowTally(ITEMS, DEFAULT_HAND_BACK);
  const [running, agent, human] = E;
  const RUN = 'is:open label:"doing/agent"';
  const HUM = 'is:open label:"pending/human"';

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
    expect(s).toEqual({ query: 'is:open label:"pending/agent"', saved: '' });
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
