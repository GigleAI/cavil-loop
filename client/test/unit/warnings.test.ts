import { describe, it, expect } from 'vitest';
import { parseFilter } from '../../src/shared/filter';
import type { SourceStatus, SyncState } from '../../src/shared/types';
import { dismiss, isShown, notifyWarningIds, reconcile, warningIds, WARN_KINDS, type Dismissed, type WarnIds, type WarnKind } from '../../src/renderer/warnings';

const T0 = Date.parse('2026-11-06T00:00:00Z');
const ok = (sourceKey: string): SourceStatus => ({ sourceKey, ok: true, error: null, dataFrom: T0 });
const bad = (sourceKey: string, error = 'GitHub 返回 HTTP 502', dataFrom: number | null = T0): SourceStatus => ({ sourceKey, ok: false, error, dataFrom });
function sync(p: Partial<SyncState> = {}): SyncState {
  return { syncing: false, offline: false, lastOnlineAt: T0, dataFrom: T0, sources: [], problem: null, ...p };
}
const none = parseFilter('');

/** replay a run: each step is the state the window sees; returns what is shown after each step */
function replay(steps: ({ state: WarnIds } | { close: WarnKind })[]): { shown: WarnKind[]; dismissed: Dismissed }[] {
  let dismissed: Dismissed = {};
  let current: WarnIds = {};
  const out: { shown: WarnKind[]; dismissed: Dismissed }[] = [];
  for (const s of steps) {
    if ('close' in s) dismissed = dismiss(dismissed, current, s.close);
    else {
      current = s.state;
      dismissed = reconcile(dismissed, current);
    }
    out.push({ shown: WARN_KINDS.filter((k) => isShown(k, current, dismissed)), dismissed });
  }
  return out;
}
const last = <T,>(xs: T[]) => xs[xs.length - 1];

describe('fault ids of the five yellow bars', () => {
  it('nothing wrong, no filter → no bar', () => {
    expect(warningIds(sync({ sources: [ok('a')] }), none)).toEqual({});
  });

  it('unsupported words: the words, sorted; the order typed does not matter', () => {
    const a = warningIds(sync(), parseFilter('label:x updated:>2026-01-01 priority:High'));
    const b = warningIds(sync(), parseFilter('priority:High label:x updated:>2026-01-01'));
    expect(a['filter-unsupported']).toBeDefined();
    expect(a['filter-unsupported']).toBe(b['filter-unsupported']);
    expect(warningIds(sync(), parseFilter('priority:Low'))['filter-unsupported']).not.toBe(a['filter-unsupported']);
  });

  it('filter may be incomplete: only while filtering, keyed on the failed sources (sorted), not on the words', () => {
    const s = sync({ sources: [bad('b'), ok('c'), bad('a')] });
    expect(warningIds(s, none)['filter-incomplete']).toBeUndefined();
    const x = warningIds(s, parseFilter('label:x'))['filter-incomplete'];
    expect(x).toBeDefined();
    expect(warningIds(sync({ sources: [bad('a'), bad('b')] }), parseFilter('客户端'))['filter-incomplete']).toBe(x);
    expect(warningIds(sync({ sources: [bad('a')] }), parseFilter('label:x'))['filter-incomplete']).not.toBe(x);
  });

  it('offline: one fixed id', () => {
    expect(warningIds(sync({ offline: true, dataFrom: T0 }), none).offline).toBe(warningIds(sync({ offline: true, dataFrom: T0 + 3_600_000 }), none).offline);
    expect(warningIds(sync({ offline: true }), none).offline).toBeDefined();
  });

  it('sync incomplete: source + reason of each failure, sorted; not while offline', () => {
    const one = warningIds(sync({ sources: [bad('a', 'x'), bad('b', 'y')] }), none).incomplete;
    expect(one).toBeDefined();
    expect(warningIds(sync({ sources: [bad('b', 'y'), bad('a', 'x')] }), none).incomplete).toBe(one);
    expect(warningIds(sync({ sources: [bad('a', 'x'), bad('b', 'z')] }), none).incomplete).not.toBe(one);
    expect(warningIds(sync({ sources: [bad('a', 'x'), bad('c', 'y')] }), none).incomplete).not.toBe(one);
    expect(warningIds(sync({ offline: true, sources: [bad('a', 'x')] }), none).incomplete).toBeUndefined();
  });

  it('sync problem: its text', () => {
    expect(warningIds(sync({ problem: '同步出错：boom' }), none)['sync-problem']).toBe('同步出错：boom');
  });

  it('two states that differ only in "data as of" have the same ids, bar by bar', () => {
    const f = parseFilter('label:x priority:High');
    const a = warningIds(sync({ dataFrom: T0, lastOnlineAt: T0, sources: [bad('a', 'e', T0)], problem: 'p' }), f);
    const b = warningIds(sync({ dataFrom: T0 - 7_200_000, lastOnlineAt: T0 + 60_000, sources: [bad('a', 'e', T0 - 7_200_000)], problem: 'p' }), f);
    expect(Object.keys(a).sort()).toEqual(['filter-incomplete', 'filter-unsupported', 'incomplete', 'sync-problem']);
    expect(b).toEqual(a);
    const off = (dataFrom: number | null) => warningIds(sync({ offline: true, dataFrom, sources: [bad('a', 'e', dataFrom)] }), f);
    expect(off(T0 - 7_200_000)).toEqual(off(T0));
    expect(off(null)).toEqual(off(T0));
  });
});

describe('closing a bar and when it comes back (the table of GitHub#153)', () => {
  const A = { incomplete: warningIds(sync({ sources: [bad('a', 'e1')] }), none).incomplete! };
  const B = { incomplete: warningIds(sync({ sources: [bad('b', 'e1')] }), none).incomplete! };

  it('close → only that bar goes; the others stay', () => {
    const both = warningIds(sync({ sources: [bad('a')], problem: 'p' }), none);
    const r = replay([{ state: both }, { close: 'incomplete' }]);
    expect(r[0].shown).toEqual(['incomplete', 'sync-problem']);
    expect(last(r).shown).toEqual(['sync-problem']);
  });

  it('only time passes (same failure, older data) → stays closed', () => {
    const at = (dataFrom: number) => warningIds(sync({ dataFrom, sources: [bad('a', 'e1', dataFrom)] }), none);
    const r = replay([{ state: at(T0) }, { close: 'incomplete' }, { state: at(T0 - 60_000) }, { state: at(T0 - 3_600_000) }]);
    expect(last(r).shown).toEqual([]);
  });

  it('the failing source changes → shows again', () => {
    expect(last(replay([{ state: A }, { close: 'incomplete' }, { state: B }])).shown).toEqual(['incomplete']);
  });

  it('the reason changes → shows again', () => {
    const e2 = { incomplete: warningIds(sync({ sources: [bad('a', 'e2')] }), none).incomplete! };
    expect(last(replay([{ state: A }, { close: 'incomplete' }, { state: e2 }])).shown).toEqual(['incomplete']);
  });

  it('recovers, then fails the same way again → shows again', () => {
    const r = replay([{ state: A }, { close: 'incomplete' }, { state: {} }, { state: A }]);
    expect(r[2].dismissed).toEqual({});
    expect(last(r).shown).toEqual(['incomplete']);
  });

  it('A → B → A → shows again on the way back to A', () => {
    const r = replay([{ state: A }, { close: 'incomplete' }, { state: B }, { state: A }]);
    expect(r[2].shown).toEqual(['incomplete']);
    expect(last(r).shown).toEqual(['incomplete']);
  });

  it('filter may be incomplete: closed → filter cleared → filtering again with the same failure → shows again', () => {
    const s = sync({ sources: [bad('a')] });
    const r = replay([
      { state: warningIds(s, parseFilter('label:x')) },
      { close: 'filter-incomplete' },
      { state: warningIds(s, parseFilter('label:y')) },
      { state: warningIds(s, none) },
      { state: warningIds(s, parseFilter('label:x')) },
    ]);
    expect(r[1].shown).toEqual(['incomplete']);
    expect(r[2].shown).toEqual(['incomplete']); // other words, same failed sources: still closed
    expect(r[3].dismissed).toEqual({});
    expect(last(r).shown).toEqual(['filter-incomplete', 'incomplete']);
  });

  it('sync incomplete closed → offline → back online with the same failure → shows again', () => {
    const fail = sync({ sources: [bad('a', 'e1')] });
    const r = replay([
      { state: warningIds(fail, none) },
      { close: 'incomplete' },
      { state: warningIds({ ...fail, offline: true }, none) },
      { state: warningIds(fail, none) },
    ]);
    expect(r[2].shown).toEqual(['offline']);
    expect(last(r).shown).toEqual(['incomplete']);
  });

  it('a round in progress keeps the failures: not a recovery', () => {
    const fail = sync({ sources: [bad('a', 'e1')] });
    const r = replay([{ state: warningIds(fail, none) }, { close: 'incomplete' }, { state: warningIds({ ...fail, syncing: true }, none) }, { state: warningIds(fail, none) }]);
    expect(last(r).shown).toEqual([]);
  });

  it('unsupported words: closed → filter changed to supported words → back to the same words → shows again', () => {
    const s = sync();
    const r = replay([
      { state: warningIds(s, parseFilter('updated:>2026-01-01')) },
      { close: 'filter-unsupported' },
      { state: warningIds(s, parseFilter('label:x')) },
      { state: warningIds(s, parseFilter('updated:>2026-01-01')) },
    ]);
    expect(r[1].shown).toEqual([]);
    expect(last(r).shown).toEqual(['filter-unsupported']);
  });

  it('reconciling the same state again changes nothing (same object)', () => {
    const d = dismiss({}, A, 'incomplete');
    expect(reconcile(d, A)).toBe(d);
    expect(reconcile({}, {})).toEqual({});
  });

  it('closing a bar that is not up records nothing', () => {
    expect(dismiss({}, {}, 'offline')).toEqual({});
  });
});

describe('the "notifications refused" bar (GitHub#139)', () => {
  const REFUSED = 'Notifications are not allowed for this application';
  it('is up only while the latest notification was refused; its id is the system\'s reason', () => {
    expect(notifyWarningIds(null)).toEqual({});
    expect(notifyWarningIds(REFUSED)).toEqual({ 'board-notify-problem': REFUSED });
  });
  it('× closes it for this reason only: a refusal with the same reason stays closed, one going out then refused again shows it', () => {
    const up = { state: notifyWarningIds(REFUSED) };
    const r = replay([up, { close: 'board-notify-problem' }, up, up, { state: notifyWarningIds(null) }, up]);
    expect(r.map((x) => x.shown.includes('board-notify-problem'))).toEqual([true, false, false, false, false, true]);
  });
  it('closing it leaves the other bars alone', () => {
    const both = { state: { ...warningIds(sync({ offline: true }), none), ...notifyWarningIds(REFUSED) } };
    const r = replay([both, { close: 'board-notify-problem' }]);
    expect(last(r).shown).toEqual(['offline']);
  });
});
