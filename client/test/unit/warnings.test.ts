import { describe, it, expect } from 'vitest';
import { parseFilter } from '../../src/shared/filter';
import type { SourceStatus, SyncState } from '../../src/shared/types';
import { dismiss, isShown, notifyWarningIds, reconcile, syncTrouble, warningIds, WARN_KINDS, type Dismissed, type WarnIds, type WarnKind } from '../../src/renderer/warnings';

const T0 = Date.parse('2026-11-06T00:00:00Z');
const ok = (sourceKey: string): SourceStatus => ({ sourceKey, ok: true, error: null, dataFrom: T0 });
const bad = (sourceKey: string, error = 'GitHub 返回 HTTP 502', dataFrom: number | null = T0): SourceStatus => ({ sourceKey, ok: false, error, dataFrom });
function sync(p: Partial<SyncState> = {}): SyncState {
  return { syncing: false, offline: false, offlineReason: null, lastOnlineAt: T0, dataFrom: T0, sources: [], problem: null, ...p };
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

describe('fault ids of the yellow bars', () => {
  it('nothing wrong, no filter → no bar', () => {
    expect(warningIds(sync({ sources: [ok('a')] }), none)).toEqual({});
  });

  it('a failed source is no bar any more (GitHub#248: it is the ⚠️ next to refresh)', () => {
    const s = sync({ sources: [bad('a'), ok('b')] });
    expect(warningIds(s, none)).toEqual({});
    expect(warningIds(s, parseFilter('label:x'))).toEqual({});
    expect(Object.keys(warningIds({ ...s, offline: true }, parseFilter('label:x')))).toEqual(['offline']);
  });

  it('unsupported words: the words, sorted; the order typed does not matter', () => {
    const a = warningIds(sync(), parseFilter('label:x updated:>2026-01-01 priority:High'));
    const b = warningIds(sync(), parseFilter('priority:High label:x updated:>2026-01-01'));
    expect(a['filter-unsupported']).toBeDefined();
    expect(a['filter-unsupported']).toBe(b['filter-unsupported']);
    expect(warningIds(sync(), parseFilter('priority:Low'))['filter-unsupported']).not.toBe(a['filter-unsupported']);
  });

  it('offline: the reason changing is not a new fault (GitHub#270)', () => {
    const r = replay([
      { state: warningIds(sync({ offline: true, offlineReason: '无法连接 GitHub：timeout' }), none) },
      { close: 'offline' },
      { state: warningIds(sync({ offline: true, offlineReason: 'GitHub 暂时不可用（HTTP 503）' }), none) },
    ]);
    expect(r[2].shown).not.toContain('offline');
  });

  it('offline: one fixed id', () => {
    expect(warningIds(sync({ offline: true, dataFrom: T0 }), none).offline).toBe(warningIds(sync({ offline: true, dataFrom: T0 + 3_600_000 }), none).offline);
    expect(warningIds(sync({ offline: true }), none).offline).toBeDefined();
  });

  it('sync problem: its text', () => {
    expect(warningIds(sync({ problem: '同步出错：boom' }), none)['sync-problem']).toBe('同步出错：boom');
  });

  it('two states that differ only in "data as of" have the same ids, bar by bar', () => {
    const f = parseFilter('label:x priority:High');
    const a = warningIds(sync({ dataFrom: T0, lastOnlineAt: T0, sources: [bad('a', 'e', T0)], problem: 'p' }), f);
    const b = warningIds(sync({ dataFrom: T0 - 7_200_000, lastOnlineAt: T0 + 60_000, sources: [bad('a', 'e', T0 - 7_200_000)], problem: 'p' }), f);
    expect(Object.keys(a).sort()).toEqual(['filter-unsupported', 'sync-problem']);
    expect(b).toEqual(a);
    const off = (dataFrom: number | null) => warningIds(sync({ offline: true, dataFrom, sources: [bad('a', 'e', dataFrom)] }), f);
    expect(off(T0 - 7_200_000)).toEqual(off(T0));
    expect(off(null)).toEqual(off(T0));
  });
});

describe('failed sources: the ⚠️ next to refresh and its two parts (GitHub#248)', () => {
  const filter = parseFilter('label:x');

  it('nothing failed → no ⚠️, filtering or not, offline or not', () => {
    for (const offline of [false, true]) for (const f of [none, filter]) expect(syncTrouble(sync({ offline, sources: [ok('a')] }), f)).toBeNull();
    expect(syncTrouble(sync(), filter)).toBeNull();
  });

  it('online, a source failed, no filter → "sync incomplete" part only, with the failed sources only', () => {
    const t = syncTrouble(sync({ sources: [ok('a'), bad('b', 'e1'), bad('c', 'e2')] }), none);
    expect(t).toEqual({ failed: [bad('b', 'e1'), bad('c', 'e2')], incomplete: true, filterIncomplete: false });
  });

  it('online, a source failed, filtering → both parts', () => {
    const t = syncTrouble(sync({ sources: [bad('a')] }), filter);
    expect(t?.incomplete).toBe(true);
    expect(t?.filterIncomplete).toBe(true);
  });

  it('unsupported words alone also count as filtering (same rule as the board)', () => {
    expect(syncTrouble(sync({ sources: [bad('a')] }), parseFilter('updated:>2026-01-01'))?.filterIncomplete).toBe(true);
  });

  it('offline, not filtering → no ⚠️ (the offline bar says how old the data is)', () => {
    expect(syncTrouble(sync({ offline: true, sources: [bad('a')] }), none)).toBeNull();
  });

  it('offline and filtering → ⚠️ with the "filter may be incomplete" part only', () => {
    expect(syncTrouble(sync({ offline: true, sources: [bad('a')] }), filter)).toEqual({ failed: [bad('a')], incomplete: false, filterIncomplete: true });
  });

  it('fails → offline → recovers: the parts follow each state, then the ⚠️ goes', () => {
    const fail = sync({ sources: [bad('a', 'e1')] });
    const steps = [fail, { ...fail, offline: true }, sync({ sources: [ok('a')] })];
    expect(steps.map((s) => syncTrouble(s, filter) && [syncTrouble(s, filter)!.incomplete, syncTrouble(s, filter)!.filterIncomplete])).toEqual([[true, true], [false, true], null]);
    expect(steps.map((s) => syncTrouble(s, none) && syncTrouble(s, none)!.incomplete)).toEqual([true, null, null]);
  });
});

describe('closing a bar and when it comes back (the table of GitHub#153)', () => {
  const A = warningIds(sync({ problem: 'p1' }), none);
  const B = warningIds(sync({ problem: 'p2' }), none);

  it('close → only that bar goes; the others stay', () => {
    const both = warningIds(sync({ problem: 'p' }), parseFilter('updated:>2026-01-01'));
    const r = replay([{ state: both }, { close: 'sync-problem' }]);
    expect(r[0].shown).toEqual(['filter-unsupported', 'sync-problem']);
    expect(last(r).shown).toEqual(['filter-unsupported']);
  });

  it('only time passes (same problem, older data) → stays closed', () => {
    const at = (dataFrom: number) => warningIds(sync({ offline: true, dataFrom, sources: [bad('a', 'e1', dataFrom)] }), none);
    const r = replay([{ state: at(T0) }, { close: 'offline' }, { state: at(T0 - 60_000) }, { state: at(T0 - 3_600_000) }]);
    expect(last(r).shown).toEqual([]);
  });

  it('the problem changes → shows again', () => {
    expect(last(replay([{ state: A }, { close: 'sync-problem' }, { state: B }])).shown).toEqual(['sync-problem']);
  });

  it('recovers, then fails the same way again → shows again', () => {
    const r = replay([{ state: A }, { close: 'sync-problem' }, { state: {} }, { state: A }]);
    expect(r[2].dismissed).toEqual({});
    expect(last(r).shown).toEqual(['sync-problem']);
  });

  it('A → B → A → shows again on the way back to A', () => {
    const r = replay([{ state: A }, { close: 'sync-problem' }, { state: B }, { state: A }]);
    expect(r[2].shown).toEqual(['sync-problem']);
    expect(last(r).shown).toEqual(['sync-problem']);
  });

  it('offline closed → back online → offline again → shows again', () => {
    const off = sync({ offline: true, sources: [bad('a', 'e1')] });
    const r = replay([
      { state: warningIds(off, none) },
      { close: 'offline' },
      { state: warningIds({ ...off, offline: false }, none) },
      { state: warningIds(off, none) },
    ]);
    expect(r[1].shown).toEqual([]);
    expect(r[2].dismissed).toEqual({});
    expect(last(r).shown).toEqual(['offline']);
  });

  it('a round in progress keeps the problem: not a recovery', () => {
    const r = replay([{ state: A }, { close: 'sync-problem' }, { state: warningIds(sync({ problem: 'p1', syncing: true }), none) }, { state: A }]);
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
    const d = dismiss({}, A, 'sync-problem');
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
    // rebuilt at every step, as the window does on every render
    const up = () => ({ state: notifyWarningIds(REFUSED) });
    const r = replay([up(), { close: 'board-notify-problem' }, up(), up(), { state: notifyWarningIds(null) }, up()]);
    expect(r.map((x) => x.shown.includes('board-notify-problem'))).toEqual([true, false, false, false, false, true]);
  });
  it('closing it leaves the other bars alone', () => {
    const both = { state: { ...warningIds(sync({ offline: true }), none), ...notifyWarningIds(REFUSED) } };
    const r = replay([both, { close: 'board-notify-problem' }]);
    expect(last(r).shown).toEqual(['offline']);
  });
});
