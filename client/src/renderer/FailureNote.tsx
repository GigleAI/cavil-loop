// GitHub#401: a failed read, said the one way (shared/readFailure.ts) — in a source's row in
// Settings, an organisation of the Project picker, the empty board's card and the ⚠️ panel next to
// the refresh button: the same title, explanation, buttons and GitHub's own words in all four.

import { useEffect, useState } from 'react';
import type { AppState } from '../shared/types';
import { describeFailure, type FailureAction, type ReadFailure } from '../shared/readFailure';
import { api } from './api';
import { rereadResultText, rereadRunningText, useReread, type Reread } from './reread';

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * True until `until` (epoch ms), then false — the component re-renders at that moment by itself,
 * so a button held for a rate limit comes back without anything else changing (PR #414 review
 * round 1: it used to read the clock only when something else re-rendered it).
 */
export function useWaiting(until: number | null | undefined): boolean {
  const [, tick] = useState(0);
  const waiting = until != null && Date.now() < until;
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.max(0, until! - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [until, waiting]);
  return waiting;
}

/** "打开 GitHub 授权页": the back end opens the page of the app the current sign-in used */
export const openAuthPage = () => void api().openAuthPage();

export function FailureNote({
  failure,
  state,
  onRetry,
  reread: shared,
  testid = 'failure-note',
}: {
  failure: ReadFailure;
  state: Pick<AppState, 'signedInAppKind'>;
  /** "重新读取"; absent = the sync starts over */
  onRetry?: () => void;
  /**
   * GitHub#455: the sync started over by hand, shared with its surroundings (the ⚠️ panel, which
   * says when it started and what it came to); absent = this note runs its own and says both itself
   */
  reread?: Reread;
  testid?: string;
}) {
  const waiting = useWaiting(failure.kind === 'rateLimited' ? failure.retryAt : null);
  const own = useReread();
  // a caller's own retry (the Project picker) has its own reading state: not this one's
  const rr = onRetry ? null : (shared ?? own);
  const running = rr?.state.phase === 'running';
  const lines = rr !== null && !shared;
  const rs = rr?.state;
  const t = describeFailure(failure, Date.now(), state.signedInAppKind ?? 'oauth');
  const button = (a: FailureAction) => {
    switch (a) {
      case 'retry':
        return (
          <button
            key={a}
            className={running ? 'reread-busy' : undefined}
            data-testid="failure-retry"
            data-running={running ? 'yes' : 'no'}
            disabled={waiting}
            onClick={() => (onRetry ? onRetry() : rr!.run())}
          >
            {running && <span className="spin" aria-hidden="true" />}
            {waiting && t.retryAt !== undefined ? `重新读取（${hhmm(t.retryAt)} 后可用）` : running ? '正在重新读取…' : '重新读取'}
          </button>
        );
      case 'authPage':
        return (
          <button key={a} data-testid="failure-auth-page" onClick={openAuthPage}>
            打开 GitHub 授权页
          </button>
        );
      case 'ssoPage':
        return (
          <button key={a} data-testid="failure-sso-page" onClick={() => void api().openExternal(failure.ssoUrl!)}>
            去 GitHub 授权单点登录
          </button>
        );
      case 'relogin':
        return (
          <button key={a} data-testid="failure-relogin" onClick={() => void api().logout()}>
            重新登录
          </button>
        );
    }
  };
  return (
    <div className="failure-note" data-testid={testid} data-kind={failure.kind}>
      <b data-testid="failure-title">{t.title}</b>
      <div className="failure-body" data-testid="failure-body">
        {t.body}
      </div>
      {t.actions.length > 0 && <div className="failure-actions">{t.actions.map(button)}</div>}
      {lines && rs?.phase === 'running' && (
        <div className="reread-line running" data-testid="failure-reread-running" role="status">
          <span className="spin" aria-hidden="true" />
          <span>{rereadRunningText(rs.startedAt)}</span>
        </div>
      )}
      {lines && rs?.phase === 'done' && rereadResultText(rs) && (
        <div className="reread-line bad" data-testid="failure-reread-result" data-kind={rs.outcome.kind} role="status">
          <span>{rereadResultText(rs)}</span>
        </div>
      )}
      {failure.raw && (
        <div className="failure-raw" data-testid="failure-raw">
          错误原文：{failure.raw}
        </div>
      )}
    </div>
  );
}
