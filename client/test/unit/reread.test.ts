// GitHub#455: what "重新读取" / "重新同步" came to, said one way for the ⚠️ panel and the failure note.

import { describe, expect, it } from 'vitest';
import { clockSec, rereadOutcome, rereadResultText, rereadRunningText } from '../../src/renderer/reread';
import type { AppState, SourceStatus, SyncState } from '../../src/shared/types';

const st = (sourceKey: string, ok: boolean): SourceStatus => ({ sourceKey, ok, error: ok ? null : 'x', dataFrom: 1 });
const sync = (p: Partial<SyncState> = {}): SyncState => ({
  syncing: false,
  offline: false,
  offlineReason: null,
  lastOnlineAt: 1,
  dataFrom: 1,
  checkedFrom: 1,
  times: [],
  progress: null,
  sources: [],
  problem: null,
  ...p,
});
const at = (p: Partial<SyncState> = {}, phase: AppState['phase'] = 'ready') => ({ phase, sync: sync(p) });

describe('rereadOutcome', () => {
  it('every source read whole, online, signed in: ok', () => {
    expect(rereadOutcome(at({ sources: [st('a', true), st('b', true)] }))).toEqual({ kind: 'ok' });
  });
  it('some sources still failed: failed, with their keys in order', () => {
    expect(rereadOutcome(at({ sources: [st('a', false), st('b', true), st('c', false)] }))).toEqual({ kind: 'failed', keys: ['a', 'c'] });
  });
  it('offline is never ok, even with every source marked ok', () => {
    expect(rereadOutcome(at({ offline: true, sources: [st('a', true)] }))).toEqual({ kind: 'offline' });
  });
  it('a round that threw is an error, not ok', () => {
    const r = rereadOutcome(at({ problem: '同步出错：boom', sources: [st('a', true)] }));
    expect(r).toEqual({ kind: 'error', message: '同步出错：boom' });
  });
  it('a problem that is not a round error (e.g. a credential not saved) does not hide the outcome', () => {
    expect(rereadOutcome(at({ problem: '登录信息没存上', sources: [st('a', true)] }))).toEqual({ kind: 'ok' });
  });
  it('signed out meanwhile: error', () => {
    expect(rereadOutcome(at({ sources: [st('a', true)] }, 'login')).kind).toBe('error');
  });
});

describe('the words', () => {
  const t = new Date(2026, 10, 13, 14, 3, 41).getTime();
  it('times are to the second', () => {
    expect(clockSec(t)).toBe('14:03:41');
    expect(clockSec(new Date(2026, 0, 1, 7, 5, 9).getTime())).toBe('07:05:09');
  });
  it('running', () => {
    expect(rereadRunningText(t)).toBe('14:03:41 开始重新读取，连不上时每个请求最多等 30 秒。再点一次会放弃这一轮、重新开始。');
  });
  it('outcomes', () => {
    expect(rereadResultText({ at: t, outcome: { kind: 'ok' } })).toBeNull();
    expect(rereadResultText({ at: t, outcome: { kind: 'failed', keys: ['a'] } })).toBe('14:03:41 重新读取完毕：这个来源仍然读取失败（原因见上）。');
    expect(rereadResultText({ at: t, outcome: { kind: 'failed', keys: ['a', 'b'] } })).toBe('14:03:41 重新读取完毕：2 个来源仍然读取失败（原因见上）。');
    expect(rereadResultText({ at: t, outcome: { kind: 'offline' } })).toBe('14:03:41 重新读取完毕：仍然连不上 GitHub。');
    expect(rereadResultText({ at: t, outcome: { kind: 'error', message: '同步出错：boom' } })).toBe('14:03:41 重新读取没有完成：同步出错：boom');
  });
});
