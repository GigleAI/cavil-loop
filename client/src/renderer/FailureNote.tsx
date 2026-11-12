// GitHub#401: a failed read, said the one way (shared/readFailure.ts) — in a source's row in
// Settings, an organisation of the Project picker and the empty board's card.

import type { AppState } from '../shared/types';
import { authPageUrl, describeFailure, type FailureAction, type ReadFailure } from '../shared/readFailure';
import { api } from './api';

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** the page "打开 GitHub 授权页" opens for this sign-in */
export function authUrlOf(state: Pick<AppState, 'githubWeb' | 'appKind' | 'clientId'>): string {
  return authPageUrl(state.githubWeb, state.appKind, state.clientId);
}

export function FailureNote({
  failure,
  state,
  onRetry,
  compact = false,
  testid = 'failure-note',
}: {
  failure: ReadFailure;
  state: Pick<AppState, 'githubWeb' | 'appKind' | 'clientId'>;
  /** "重新读取"; absent = the sync is read again */
  onRetry?: () => void;
  /** one line (title + buttons), for a list row */
  compact?: boolean;
  testid?: string;
}) {
  const now = Date.now();
  const t = describeFailure(failure, now, state.appKind);
  const button = (a: FailureAction) => {
    switch (a) {
      case 'retry': {
        const waiting = t.retryAt !== undefined;
        return (
          <button key={a} data-testid="failure-retry" disabled={waiting} onClick={() => (onRetry ? onRetry() : void api().restartSync())}>
            {waiting ? `重新读取（${hhmm(t.retryAt!)} 后可用）` : '重新读取'}
          </button>
        );
      }
      case 'authPage':
        return (
          <button key={a} data-testid="failure-auth-page" onClick={() => void api().openExternal(authUrlOf(state))}>
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
    <div className={`failure-note${compact ? ' compact' : ''}`} data-testid={testid} data-kind={failure.kind}>
      <b data-testid="failure-title">{t.title}</b>
      {!compact && <div className="failure-body">{t.body}</div>}
      {t.actions.length > 0 && <div className="failure-actions">{t.actions.map(button)}</div>}
      {!compact && failure.raw && <div className="failure-raw">错误原文：{failure.raw}</div>}
    </div>
  );
}
