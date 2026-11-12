// GitHub#401: a failed read, said the one way (shared/readFailure.ts) — in a source's row in
// Settings, an organisation of the Project picker, the empty board's card and the ⚠️ panel next to
// the refresh button: the same title, explanation, buttons and GitHub's own words in all four.

import { useEffect, useState } from 'react';
import type { AppState } from '../shared/types';
import { describeFailure, type FailureAction, type ReadFailure } from '../shared/readFailure';
import { api } from './api';

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
  testid = 'failure-note',
}: {
  failure: ReadFailure;
  state: Pick<AppState, 'signedInAppKind'>;
  /** "重新读取"; absent = the sync starts over */
  onRetry?: () => void;
  testid?: string;
}) {
  const waiting = useWaiting(failure.kind === 'rateLimited' ? failure.retryAt : null);
  const t = describeFailure(failure, Date.now(), state.signedInAppKind ?? 'oauth');
  const button = (a: FailureAction) => {
    switch (a) {
      case 'retry':
        return (
          <button key={a} data-testid="failure-retry" disabled={waiting} onClick={() => (onRetry ? onRetry() : void api().restartSync())}>
            {waiting && t.retryAt !== undefined ? `重新读取（${hhmm(t.retryAt)} 后可用）` : '重新读取'}
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
      {failure.raw && (
        <div className="failure-raw" data-testid="failure-raw">
          错误原文：{failure.raw}
        </div>
      )}
    </div>
  );
}
