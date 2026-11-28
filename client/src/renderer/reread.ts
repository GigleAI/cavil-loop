// GitHub#455: "重新读取" / "重新同步" said what they did. Both start the sync over (restartSync,
// the same as the refresh button); the button waits for that call — it returns once the round(s)
// it set off are over — and then reads the state the round left behind. The words for "running"
// and for the outcome are decided here, once, for every place that shows them: the ⚠️ panel next
// to refresh (its two buttons share one run), and the failure note in Settings and on the empty
// board.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, SyncState } from '../shared/types';
import { api } from './api';
import { getLang, t, tKey, translate, zhKey } from '../shared/i18n';
import { REREAD_READ_LIMIT_MS } from '../shared/config';
import { lasted, stepName } from './syncTimes';

/** what a reread by hand came to, judged from the state after it */
export type RereadOutcome =
  | { kind: 'ok' }
  /** some sources still failed (their keys, in the order of the sources) */
  | { kind: 'failed'; keys: string[] }
  /** GitHub#755: the read time ran out before these sources were read (`others`: sources that failed for another reason) */
  | { kind: 'stopped'; keys: string[]; others: number }
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
  const failed = s.sources.filter((x) => !x.ok);
  // GitHub#755: the read limit stopped it — said so even when it stopped before GitHub said who the account is (then offline too)
  const stopped = failed.filter((x) => x.stopped === true).map((x) => x.sourceKey);
  if (stopped.length) return { kind: 'stopped', keys: stopped, others: failed.length - stopped.length };
  if (s.offline) return { kind: 'offline' };
  return failed.length ? { kind: 'failed', keys: failed.map((x) => x.sourceKey) } : { kind: 'ok' };
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

/** GitHub#755: the read time of a refresh by hand, in whole minutes, as the words say it */
const limitMin = () => Math.round(REREAD_READ_LIMIT_MS / 60_000);

/**
 * The line while it runs (GitHub#755: how long it has taken, where the round doing it is, and the
 * limit). `sync` = the state now; without it (or before the controller said anything) only the
 * time and the limit are said.
 */
export function rereadRunningText(startedAt: number, now: number, sync?: Pick<SyncState, 'manual' | 'progress'> | null): string {
  const parts = [t('{time} 开始重新读取，已用 {elapsed}。', { time: clockSec(startedAt), elapsed: lasted(now - startedAt) })];
  const m = sync?.manual ?? null;
  const step = m?.step ?? null;
  const reading = m?.claimed === true && (step === 'read' || step === 'activity');
  if (!m || step === null) {
    parts.push(t('正在开始。'));
  } else if (m.claimed && step === 'read') {
    const p = sync?.progress ?? null;
    parts.push(p ? t('正在读 GitHub：读完 {done} / {total} 个来源。', { done: p.done, total: p.total }) : t('正在读 GitHub。'));
  } else if (m.claimed && step === 'activity') {
    parts.push(t('正在「{step}」。', { step: stepName(step) }));
  } else if (step === 'renew' || step === 'saveCredential' || step === 'grant') {
    // before reading: this round (or the round about to take the refresh) is at a step that is never cut
    parts.push(t('正在「{step}」：这一步不能中途停下，做完马上开始读 GitHub。', { step: stepName(step) }));
  } else if (m.claimed) {
    // after reading: what was read is being confirmed / saved — never cut, the result comes right after
    parts.push(t('正在「{step}」：这一步不能中途停下，做完就给结果。', { step: stepName(step) }));
  } else {
    // an earlier round, past its reading, is at a step that is never cut; this refresh starts right after it
    parts.push(t('正在等上一轮做完「{step}」：这一步不能中途停下，做完马上开始读 GitHub。', { step: stepName(step) }));
  }
  parts.push(
    reading || !m || step === null
      ? t('读 GitHub 最多 {min} 分钟，到时还没读完的来源这次算读取失败。再点一次会放弃这一轮、重新开始。', { min: limitMin() })
      : t('这一步不计入读 GitHub 的 {min} 分钟；再点一次也不会打断它。', { min: limitMin() }),
  );
  return parts.join(getLang() === 'en' ? ' ' : '');
}

/** GitHub#755: the time now, again every second while `on` (the running line's "已用") */
export function useSecondTick(on: boolean, now: () => number = Date.now): number {
  const [at, setAt] = useState(now);
  useEffect(() => {
    if (!on) return;
    setAt(now());
    const h = setInterval(() => setAt(now()), 1000);
    return () => clearInterval(h);
  }, [on, now]);
  return on ? at : now();
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
    case 'stopped': {
      const head =
        r.outcome.keys.length === 1
          ? t('{time} 重新读取停下：读 GitHub 满 {min} 分钟这个来源还没读完，这次算读取失败（网络太慢或连不上）。之后的自动同步会照常再读。', { time, min: limitMin() })
          : t('{time} 重新读取停下：读 GitHub 满 {min} 分钟还有 {n} 个来源没读完，这次算读取失败（网络太慢或连不上）。之后的自动同步会照常再读。', { time, min: limitMin(), n: r.outcome.keys.length });
      return r.outcome.others ? [head, t('另有 {n} 个来源读取失败（原因见上）。', { n: r.outcome.others })].join(getLang() === 'en' ? ' ' : '') : head;
    }
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
        // GitHub#755: answered once its round's result is in (not after the re-reads that follow it)
        await api().reread();
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
