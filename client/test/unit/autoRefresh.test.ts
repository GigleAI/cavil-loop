// GitHub#226: when the open detail reads itself again after a sync round.

import { describe, expect, it } from 'vitest';
import { freshMark, sameDetail, shouldAutoRefresh, stillSettling } from '../../src/renderer/autoRefresh';
import type { ItemDetail, PrStatus } from '../../src/shared/actions';
import type { SourceStatus } from '../../src/shared/types';

const st = (sourceKey: string, ok: boolean, dataFrom: number | null): SourceStatus => ({ sourceKey, ok, error: ok ? null : 'x', dataFrom });

const pr = (p: Partial<PrStatus> = {}): PrStatus => ({
  isDraft: false,
  merged: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: null,
  checks: 'SUCCESS',
  headOid: 'a',
  baseRef: 'main',
  headRef: 'f',
  mergeMethods: ['squash'],
  ...p,
});

const detail = (d: Partial<ItemDetail> = {}): ItemDetail => ({
  key: 'o/r#1',
  repo: 'o/r',
  number: 1,
  kind: 'issue',
  title: 't',
  url: 'https://github.com/o/r/issues/1',
  state: 'open',
  timeline: [],
  pr: null,
  fetchedAt: 1,
  labels: [],
  ...d,
});

describe('freshMark: only a complete read of a source that carries the item', () => {
  const item = { sources: ['project:a', 'repo:o/r'] };
  it('newest ok source carrying the item', () => {
    expect(freshMark(item, [st('project:a', true, 10), st('repo:o/r', true, 20)])).toBe(20);
  });
  it('a failed source keeps its old snapshot: its time does not count', () => {
    expect(freshMark(item, [st('project:a', true, 10), st('repo:o/r', false, 30)])).toBe(10);
  });
  it('another source succeeding is not fresh data of this item', () => {
    expect(freshMark(item, [st('project:a', false, 10), st('repo:o/r', false, 10), st('repo:x/y', true, 50)])).toBeNull();
  });
  it('never read / no item', () => {
    expect(freshMark(item, [st('project:a', true, null)])).toBeNull();
    expect(freshMark(null, [st('project:a', true, 10)])).toBeNull();
  });
});

describe('stillSettling: a PR state GitHub was still working out', () => {
  it.each([
    [{ checks: 'PENDING' }, true],
    [{ checks: 'EXPECTED' }, true],
    [{ mergeable: 'UNKNOWN' }, true],
    [{ mergeStateStatus: 'UNKNOWN' }, true],
    [{}, false],
    [{ checks: null }, false],
    [{ checks: 'FAILURE', mergeable: 'CONFLICTING' }, false],
  ] as [Partial<PrStatus>, boolean][])('%j → %s', (p, want) => {
    expect(stillSettling(detail({ kind: 'pr', pr: pr(p) }))).toBe(want);
  });
  it('closed / merged PRs and issues never', () => {
    expect(stillSettling(detail({ kind: 'pr', state: 'closed', pr: pr({ checks: 'PENDING' }) }))).toBe(false);
    expect(stillSettling(detail({ kind: 'pr', state: 'merged', pr: pr({ mergeable: 'UNKNOWN' }) }))).toBe(false);
    expect(stillSettling(detail())).toBe(false);
    expect(stillSettling(null)).toBe(false);
  });
});

describe('shouldAutoRefresh', () => {
  const base = { item: { updatedAt: 'T1' }, readAt: 'T1', detail: detail(), busy: false, loading: false };
  it('unchanged item: no read', () => expect(shouldAutoRefresh(base)).toBe(false));
  it('changed on GitHub: read', () => expect(shouldAutoRefresh({ ...base, item: { updatedAt: 'T2' } })).toBe(true));
  it('unchanged but checks still running: read', () =>
    expect(shouldAutoRefresh({ ...base, detail: detail({ kind: 'pr', pr: pr({ checks: 'PENDING' }) }) })).toBe(true));
  it('first read failed (nothing on screen): try again', () => expect(shouldAutoRefresh({ ...base, detail: null, readAt: null })).toBe(true));
  it('a change in flight or a read in flight: never', () => {
    expect(shouldAutoRefresh({ ...base, item: { updatedAt: 'T2' }, busy: true })).toBe(false);
    expect(shouldAutoRefresh({ ...base, item: { updatedAt: 'T2' }, loading: true })).toBe(false);
  });
  it('item gone from the board: no read', () => expect(shouldAutoRefresh({ ...base, item: null })).toBe(false));
});

describe('sameDetail: the read time alone is no change', () => {
  it('equal but for fetchedAt', () => expect(sameDetail(detail({ fetchedAt: 1 }), detail({ fetchedAt: 2 }))).toBe(true));
  it('a new comment / label / PR state is a change', () => {
    expect(sameDetail(detail(), detail({ labels: [{ name: 'x', color: '000000' }] }))).toBe(false);
    expect(sameDetail(detail({ kind: 'pr', pr: pr() }), detail({ kind: 'pr', pr: pr({ checks: 'FAILURE' }) }))).toBe(false);
  });
  it('nothing on screen yet', () => expect(sameDetail(null, detail())).toBe(false));
});
