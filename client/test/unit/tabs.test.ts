// GigleAI/cavil-loop#397: detail tabs — the pure rules (shared/tabs.ts).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOING_LABEL,
  ENDED_CHECK_MS,
  HOME,
  afterClose,
  listedNow,
  moveTab,
  newestCopy,
  normalizeDoingLabel,
  normalizeTabs,
  stepTab,
  summarize,
  tabCheckDue,
  tabStatus,
  tabUnread,
  type TabSummary,
} from '../../src/shared/tabs';
import type { SourceStatus } from '../../src/shared/types';
import { item } from './helpers';

const LABELS = { human: 'pending/human', doing: 'doing/agent' };
const sum = (extra: Partial<TabSummary> = {}): TabSummary => ({
  key: 'o/r#1',
  repo: 'o/r',
  number: 1,
  kind: 'issue',
  title: 't',
  url: 'https://github.com/o/r/issues/1',
  state: 'open',
  stateReason: null,
  isDraft: null,
  labels: [],
  updatedAt: '2026-01-01T00:00:00Z',
  ...extra,
});

describe('the status a tab shows', () => {
  it('ended first (GitHub\'s own state), then waiting for a human, then running, then open', () => {
    expect(tabStatus(sum({ kind: 'pr', state: 'merged', labels: ['doing/agent', 'pending/human'] }), LABELS)).toBe('merged');
    expect(tabStatus(sum({ kind: 'pr', state: 'closed', labels: ['pending/human'] }), LABELS)).toBe('closed');
    expect(tabStatus(sum({ state: 'closed', stateReason: 'completed', labels: ['pending/human'] }), LABELS)).toBe('done');
    expect(tabStatus(sum({ state: 'closed', stateReason: null }), LABELS)).toBe('done');
    expect(tabStatus(sum({ state: 'closed', stateReason: 'not_planned' }), LABELS)).toBe('skipped');
    expect(tabStatus(sum({ state: 'closed', stateReason: 'duplicate' }), LABELS)).toBe('skipped');
    // both labels on an open item: a human is asked — that is the one to see
    expect(tabStatus(sum({ labels: ['doing/agent', 'pending/human'] }), LABELS)).toBe('waiting');
    expect(tabStatus(sum({ labels: ['doing/agent'] }), LABELS)).toBe('running');
    expect(tabStatus(sum({ labels: ['pending/agent'] }), LABELS)).toBe('open');
    expect(tabStatus(sum({ kind: 'pr', isDraft: true }), LABELS)).toBe('draft');
    expect(tabStatus(sum({ kind: 'pr', isDraft: true, labels: ['doing/agent'] }), LABELS)).toBe('running');
  });

  it('label names are GitHub\'s: case does not matter; an empty setting never matches', () => {
    expect(tabStatus(sum({ labels: ['Doing/Agent'] }), LABELS)).toBe('running');
    expect(tabStatus(sum({ labels: ['working'] }), { human: 'pending/human', doing: ' Working ' })).toBe('running');
    expect(tabStatus(sum({ labels: ['doing/agent', ''] }), { human: 'pending/human', doing: '' })).toBe('open');
    expect(tabStatus(sum({ labels: ['pending/human'] }), { human: '', doing: 'doing/agent' })).toBe('open');
  });

  it('the running label as saved: a string is kept (empty = off), anything else is the default', () => {
    expect(normalizeDoingLabel(' wip ')).toBe('wip');
    expect(normalizeDoingLabel('')).toBe('');
    expect(normalizeDoingLabel(null)).toBe(DEFAULT_DOING_LABEL);
    expect(normalizeDoingLabel(3)).toBe(DEFAULT_DOING_LABEL);
  });
});

describe('something new on a tab that is not in front', () => {
  const t = (seen: string | null, updatedAt: string) => ({ seen, item: sum({ updatedAt }) });
  it('only a tab that was looked at, changed since, and is not in front', () => {
    expect(tabUnread(t('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'), false)).toBe(true);
    expect(tabUnread(t('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'), true)).toBe(false);
    expect(tabUnread(t('2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'), false)).toBe(false);
    // opened in the background and never looked at: the whole item is new to the reader, not "changed since"
    expect(tabUnread(t(null, '2026-01-02T00:00:00Z'), false)).toBe(false);
  });
});

describe('is the item kept fresh by the sync rounds', () => {
  const st = (sourceKey: string, ok: boolean, dataFrom: number | null): SourceStatus => ({ sourceKey, ok, dataFrom }) as SourceStatus;
  it('only a source read completely in this run that carries it counts', () => {
    const it1 = item('o/r', 1, { sources: ['a', 'b'] });
    expect(listedNow(it1, [st('a', true, 10)])).toBe(true);
    expect(listedNow(it1, [st('a', false, 10), st('b', false, 5)])).toBe(false); // failed: it kept its cache
    expect(listedNow(it1, [st('a', true, null)])).toBe(false);
    expect(listedNow(it1, [st('c', true, 10)])).toBe(false); // another source succeeding is no news of this item
    expect(listedNow(it1, [])).toBe(false);
    expect(listedNow(null, [st('a', true, 10)])).toBe(false);
  });
});

describe('when an item no complete read carries is checked by itself', () => {
  const T = 1_000_000;
  it('an open one with every round; an ended one every ten minutes; never checked = now; never "ended, so never"', () => {
    expect(tabCheckDue('open', T, T)).toBe(true);
    expect(tabCheckDue('closed', null, T)).toBe(true);
    expect(tabCheckDue('closed', T, T + ENDED_CHECK_MS - 1)).toBe(false);
    expect(tabCheckDue('closed', T, T + ENDED_CHECK_MS)).toBe(true);
    expect(tabCheckDue('merged', T, T + ENDED_CHECK_MS - 1)).toBe(false);
    expect(tabCheckDue('merged', T, T + ENDED_CHECK_MS)).toBe(true);
    // however long ago it ended, it stays due
    expect(tabCheckDue('closed', T, T + 1000 * ENDED_CHECK_MS)).toBe(true);
  });
  it('somebody asked: now, whatever the last check', () => {
    expect(tabCheckDue('closed', T, T + 1, true)).toBe(true);
  });
  it('the newest copy known wins', () => {
    const a = sum({ updatedAt: '2026-01-01T00:00:00Z', title: 'a' });
    const b = sum({ updatedAt: '2026-01-03T00:00:00Z', title: 'b' });
    expect(newestCopy([a, null, b, undefined])!.title).toBe('b');
    expect(newestCopy([b, a])!.title).toBe('b');
    expect(newestCopy([null, undefined])).toBeNull();
  });
});

describe('the list', () => {
  const list = ['a', 'b', 'c', 'd'].map((key) => ({ key }));
  const keys = (l: { key: string }[]) => l.map((t) => t.key).join('');
  it('a tab dragged to a position ends up there; unknown input changes nothing', () => {
    expect(keys(moveTab(list, 'a', 2))).toBe('bcad');
    expect(keys(moveTab(list, 'd', 0))).toBe('dabc');
    expect(keys(moveTab(list, 'b', 99))).toBe('acdb');
    expect(keys(moveTab(list, 'b', -5))).toBe('bacd');
    expect(moveTab(list, 'b', 1)).toBe(list);
    expect(moveTab(list, 'x', 1)).toBe(list);
    expect(moveTab(list, 'b', 1.5)).toBe(list);
    expect(moveTab(list, 'b', '2')).toBe(list);
  });
  it('closing the tab in front brings its right neighbour, else its left one, else home; closing another changes nothing', () => {
    const k = ['a', 'b', 'c'];
    expect(afterClose(k, 'b', 'b')).toBe('c');
    expect(afterClose(k, 'c', 'c')).toBe('b');
    expect(afterClose(['a'], 'a', 'a')).toBe(HOME);
    expect(afterClose(k, 'a', 'c')).toBe('c');
    expect(afterClose(k, 'a', HOME)).toBe(HOME);
  });
  it('next / previous go round, home included', () => {
    const k = ['a', 'b'];
    expect(stepTab(k, HOME, 1)).toBe('a');
    expect(stepTab(k, 'a', 1)).toBe('b');
    expect(stepTab(k, 'b', 1)).toBe(HOME);
    expect(stepTab(k, HOME, -1)).toBe('b');
    expect(stepTab(k, 'a', -1)).toBe(HOME);
    expect(stepTab([], HOME, 1)).toBe(HOME);
  });
  it('what was saved: valid tabs in order, one per item; anything else is dropped', () => {
    const a = { key: 'o/r#1', item: sum(), seen: '2026-01-01T00:00:00Z' };
    const b = { key: 'o/r#2', item: sum({ key: 'o/r#2', number: 2 }), seen: 7 };
    const out = normalizeTabs([a, b, a, { key: 'o/r#3', item: sum() }, { key: 'x' }, null, 'tab', { key: 'o/r#4', item: { ...sum({ key: 'o/r#4' }), state: 'weird' } }]);
    expect(out.map((t) => t.key)).toEqual(['o/r#1', 'o/r#2']);
    expect(out[1].seen).toBeNull();
    expect(normalizeTabs(null)).toEqual([]);
    expect(normalizeTabs({ 0: a })).toEqual([]);
  });
  it('a summary carries what the tab shows, label names only', () => {
    const s = summarize(item('o/r', 7, { title: 'T', labels: [{ name: 'doing/agent', color: 'fff' }], state: 'open', kind: 'issue' }));
    expect(s).toMatchObject({ key: 'o/r#7', repo: 'o/r', number: 7, title: 'T', labels: ['doing/agent'], state: 'open', kind: 'issue' });
    expect(normalizeTabs([{ key: s.key, item: s, seen: null }])).toHaveLength(1);
  });
});
