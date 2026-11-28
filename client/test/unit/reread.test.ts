// GitHub#455: what "重新读取" / "重新同步" came to, said one way for the ⚠️ panel and the failure note.
// GitHub#755: while it runs, how long it has taken, where the round doing it is, and the read limit;
// a read the limit stopped is its own outcome.

import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../../src/shared/i18n';
import { clockSec, rereadOutcome, rereadResultText, rereadRunningText } from '../../src/renderer/reread';
import type { AppState, SourceStatus, SyncState } from '../../src/shared/types';

const st = (sourceKey: string, ok: boolean, stopped = false): SourceStatus => ({ sourceKey, ok, error: ok ? null : 'x', dataFrom: 1, ...(stopped ? { stopped: true } : {}) });
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
  it('GitHub#755: sources the read limit stopped: stopped, with their keys, and how many failed otherwise', () => {
    expect(rereadOutcome(at({ sources: [st('a', false, true), st('b', true)] }))).toEqual({ kind: 'stopped', keys: ['a'], others: 0 });
    expect(rereadOutcome(at({ sources: [st('a', false), st('b', false, true), st('c', false, true)] }))).toEqual({ kind: 'stopped', keys: ['b', 'c'], others: 1 });
    // failures of another kind alone stay "failed"
    expect(rereadOutcome(at({ sources: [st('a', false)] }))).toEqual({ kind: 'failed', keys: ['a'] });
    // PR #757 review round 1, problem 3: stopped before GitHub said who the account is (offline too): still "stopped"
    expect(rereadOutcome(at({ offline: true, sources: [st('a', false, true), st('b', false, true)] }))).toEqual({ kind: 'stopped', keys: ['a', 'b'], others: 0 });
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
  const LIMIT = '读 GitHub 最多 2 分钟，到时还没读完的来源这次算读取失败。再点一次会放弃这一轮、重新开始。';
  const KEEP = '这一步不计入读 GitHub 的 2 分钟；再点一次也不会打断它。';
  const run = (manual: SyncState['manual'], progress: SyncState['progress'] = null) => ({ manual, progress });
  it('running: the time taken, ticking (seconds, then minutes and seconds)', () => {
    expect(rereadRunningText(t, t + 4_000)).toBe(`14:03:41 开始重新读取，已用 4 秒。正在开始。${LIMIT}`);
    expect(rereadRunningText(t, t + 65_000)).toBe(`14:03:41 开始重新读取，已用 1 分 5 秒。正在开始。${LIMIT}`);
    expect(rereadRunningText(t, t + 125_000, run(null))).toBe(`14:03:41 开始重新读取，已用 2 分 5 秒。正在开始。${LIMIT}`);
  });
  it('running: reading GitHub, with the sources done so far', () => {
    expect(rereadRunningText(t, t + 30_000, run({ claimed: true, step: 'read' }, { startedAt: t, done: 1, total: 3 }))).toBe(
      `14:03:41 开始重新读取，已用 30 秒。正在读 GitHub：读完 1 / 3 个来源。${LIMIT}`,
    );
    expect(rereadRunningText(t, t + 30_000, run({ claimed: true, step: 'read' }))).toBe(`14:03:41 开始重新读取，已用 30 秒。正在读 GitHub。${LIMIT}`);
    expect(rereadRunningText(t, t + 30_000, run({ claimed: true, step: 'activity' }))).toBe(`14:03:41 开始重新读取，已用 30 秒。正在「读与我相关的通知」。${LIMIT}`);
  });
  it('running: a step that is never cut says so, and that it does not count', () => {
    expect(rereadRunningText(t, t + 10_000, run({ claimed: false, step: 'renew' }))).toBe(
      `14:03:41 开始重新读取，已用 10 秒。正在「续期登录」：这一步不能中途停下，做完马上开始读 GitHub。${KEEP}`,
    );
    expect(rereadRunningText(t, t + 10_000, run({ claimed: true, step: 'store' }))).toBe(
      `14:03:41 开始重新读取，已用 10 秒。正在「存到本机」：这一步不能中途停下，做完就给结果。${KEEP}`,
    );
    // an earlier round, past its reading: this refresh waits for it
    expect(rereadRunningText(t, t + 135_000, run({ claimed: false, step: 'store' }))).toBe(
      `14:03:41 开始重新读取，已用 2 分 15 秒。正在等上一轮做完「存到本机」：这一步不能中途停下，做完马上开始读 GitHub。${KEEP}`,
    );
  });
  it('in English the sentences are joined by spaces', () => {
    setLang('en');
    expect(rereadRunningText(t, t + 65_000, run({ claimed: true, step: 'read' }, { startedAt: t, done: 0, total: 1 }))).toBe(
      '14:03:41 started reading again, 1 min 5 s so far. Reading GitHub: 0 of 1 sources done. Reading GitHub takes at most 2 minutes; a source not read by then counts as failed this time. Click again to drop this round and start over.',
    );
  });
  afterEach(() => setLang('zh'));
  it('outcomes', () => {
    expect(rereadResultText({ at: t, outcome: { kind: 'ok' } })).toBeNull();
    expect(rereadResultText({ at: t, outcome: { kind: 'failed', keys: ['a'] } })).toBe('14:03:41 重新读取完毕：这个来源仍然读取失败（原因见上）。');
    expect(rereadResultText({ at: t, outcome: { kind: 'failed', keys: ['a', 'b'] } })).toBe('14:03:41 重新读取完毕：2 个来源仍然读取失败（原因见上）。');
    expect(rereadResultText({ at: t, outcome: { kind: 'offline' } })).toBe('14:03:41 重新读取完毕：仍然连不上 GitHub。');
    expect(rereadResultText({ at: t, outcome: { kind: 'stopped', keys: ['a'], others: 0 } })).toBe(
      '14:03:41 重新读取停下：读 GitHub 满 2 分钟这个来源还没读完，这次算读取失败（网络太慢或连不上）。之后的自动同步会照常再读。',
    );
    expect(rereadResultText({ at: t, outcome: { kind: 'stopped', keys: ['a', 'b'], others: 1 } })).toBe(
      '14:03:41 重新读取停下：读 GitHub 满 2 分钟还有 2 个来源没读完，这次算读取失败（网络太慢或连不上）。之后的自动同步会照常再读。另有 1 个来源读取失败（原因见上）。',
    );
    expect(rereadResultText({ at: t, outcome: { kind: 'error', message: '同步出错：boom' } })).toBe('14:03:41 重新读取没有完成：同步出错：boom');
  });
});
