// GitHub#455: "重新读取" / "重新同步" said what they did. Both start the sync over (restartSync,
// the same as the refresh button); the button waits for that call — it returns once the round(s)
// it set off are over — and then reads the state the round left behind. The words for "running"
// and for the outcome are decided here, once, for every place that shows them: the ⚠️ panel next
// to refresh (its two buttons share one run), and the failure note in Settings and on the empty
// board.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState } from '../shared/types';
import { api } from './api';
import { t, tKey, translate, zhKey } from '../shared/i18n';

/** what a reread by hand came to, judged from the state after it */
export type RereadOutcome =
  | { kind: 'ok' }
  /** some sources still failed (their keys, in the order of the sources) */
  | { kind: 'failed'; keys: string[] }
  /** the round could not use GitHub at all */
  | { kind: 'offline' }
  /** the sync itself went wrong, or the app is no longer signed in */
  | { kind: 'error'; message: string };

/**
 * The controller's "the round itself went wrong" problem (`t(ROUND_ERROR, { why })`), in either language
 * (it may have been worded before the language was switched)
 */
export const ROUND_ERROR = zhKey('同步出错：{why}');
function isRoundError(problem: string | null | undefined): boolean {
  return typeof problem === 'string' && (['zh', 'en'] as const).some((l) => problem.startsWith(translate(l, ROUND_ERROR, { why: '' })));
}

/** The one judgement. Never "ok" unless the app is signed in, online, every source read whole and no round error stands. */
export function rereadOutcome(state: Pick<AppState, 'phase' | 'sync'>): RereadOutcome {
  if (state.phase !== 'ready') return { kind: 'error', message: t('已不在登录状态') };
  const s = state.sync;
  // the round's own failure (controller: a round that threw) — not hidden behind "ok"
  if (isRoundError(s.problem)) return { kind: 'error', message: s.problem! };
  if (s.offline) return { kind: 'offline' };
  const failed = s.sources.filter((x) => !x.ok).map((x) => x.sourceKey);
  return failed.length ? { kind: 'failed', keys: failed } : { kind: 'ok' };
}

export type RereadState =
  | { phase: 'idle' }
  | { phase: 'running'; startedAt: number }
  | { phase: 'done'; at: number; outcome: RereadOutcome };

/** HH:MM:SS (local) — to the second, so two clicks a minute apart still read as two */
export function clockSec(at: number): string {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** the line while it runs */
export function rereadRunningText(startedAt: number): string {
  return t('{time} 开始重新读取，连不上时每个请求最多等 30 秒。再点一次会放弃这一轮、重新开始。', { time: clockSec(startedAt) });
}

/** the line after it; null = nothing to say here (all read: the failure it was about is gone) */
export function rereadResultText(r: { at: number; outcome: RereadOutcome }): string | null {
  const time = clockSec(r.at);
  switch (r.outcome.kind) {
    case 'ok':
      return null;
    case 'failed':
      return r.outcome.keys.length === 1
        ? t('{time} 重新读取完毕：这个来源仍然读取失败（原因见上）。', { time })
        : t('{time} 重新读取完毕：{n} 个来源仍然读取失败（原因见上）。', { time, n: r.outcome.keys.length });
    case 'offline':
      return t('{time} 重新读取完毕：仍然连不上 GitHub。', { time });
    case 'error':
      return t('{time} 重新读取没有完成：{message}', { time, message: r.outcome.message });
  }
}

/** kept as the Chinese key: show it with tKey(REREAD_OK_TEXT), or call rereadOkText() */
export const REREAD_OK_TEXT = zhKey('已重新读取，所有来源都读到了');
export const rereadOkText = (): string => tKey(REREAD_OK_TEXT);

export interface Reread {
  state: RereadState;
  run: () => void;
  /** back to idle (a run in progress is left alone) */
  clear: () => void;
}

/**
 * One reread by hand. A click while one runs starts over (restartSync drops the round) and only
 * the latest click's outcome is shown: an earlier click whose call ends first never writes.
 */
export function useReread(now: () => number = Date.now): Reread {
  const [state, setState] = useState<RereadState>({ phase: 'idle' });
  const latest = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(() => {
    const token = ++latest.current;
    setState({ phase: 'running', startedAt: now() });
    void (async () => {
      let outcome: RereadOutcome;
      try {
        await api().restartSync();
        outcome = rereadOutcome((await api().get()).state);
      } catch (e) {
        outcome = { kind: 'error', message: (e as Error)?.message || String(e) };
      }
      if (!alive.current || token !== latest.current) return;
      setState({ phase: 'done', at: now(), outcome });
    })();
  }, [now]);
  const clear = useCallback(() => setState((s) => (s.phase === 'running' ? s : { phase: 'idle' })), []);
  return { state, run, clear };
}
