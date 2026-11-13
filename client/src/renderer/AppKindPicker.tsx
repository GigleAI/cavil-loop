// The sign-in method choice plus its Client ID box, shared by the login page
// and Settings so the two cannot drift apart.
import { useEffect, useState } from 'react';
import type { AppKind, AppState } from '../shared/types';
import { api } from './api';
import { clientIdKindProblem } from '../shared/appKind';
import { t } from '../shared/i18n';

export const appKindLabel = (k: AppKind): string => ({ oauth: t('OAuth 应用（默认）'), 'github-app': t('GitHub App（预览）') })[k];

export function AppKindPicker({ state, disabled, onHelp }: { state: AppState; disabled?: boolean; onHelp: () => void }) {
  const [clientId, setClientId] = useState(state.clientIdIsDefault ? '' : state.clientId);
  // switching kind shows that kind's saved override
  useEffect(() => setClientId(state.clientIdIsDefault ? '' : state.clientId), [state.appKind, state.clientId, state.clientIdIsDefault]);
  const [showAdvanced, setShowAdvanced] = useState(!state.clientId);
  const needsId = !state.clientId;
  // checked on what is typed, before saving, and on what is saved
  const problem = clientIdKindProblem(state.appKind, clientId) ?? clientIdKindProblem(state.appKind, state.clientId);
  const typedProblem = clientIdKindProblem(state.appKind, clientId);

  return (
    <div className="app-kind" data-testid="app-kind">
      <div className="row">
        <span>{t('登录方式：')}</span>
        {(['oauth', 'github-app'] as AppKind[]).map((k) => (
          <label key={k} className="radio">
            <input
              type="radio"
              name="app-kind"
              data-testid={`app-kind-${k}`}
              checked={state.appKind === k}
              disabled={disabled}
              onChange={() => api().setAppKind(k)}
            />
            {appKindLabel(k)}
          </label>
        ))}
        <button className="link small" data-testid="app-kind-help-link" onClick={onHelp}>
          {t('两种有什么区别？')}
        </button>
      </div>

      {!needsId && (
        <button className="link small" data-testid="oauth-settings-toggle" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? t('收起 Client ID') : t('改 Client ID')}
        </button>
      )}
      {problem && (
        <div className="banner error" data-testid="client-id-mismatch">
          {problem}
        </div>
      )}
      {(showAdvanced || needsId || problem) && (
        <div className="advanced">
          <label>
            {state.appKind === 'github-app' ? t('GitHub App 的 Client ID') : t('OAuth 应用的 Client ID')}
            {state.clientIdIsDefault && state.clientId ? t('（当前用内置值）') : ''}
            <input
              data-testid="client-id"
              value={clientId}
              disabled={disabled}
              placeholder={state.clientIdIsDefault && state.clientId ? state.clientId : state.appKind === 'github-app' ? t('例如 Iv23li…') : t('例如 Ov23li…')}
              onChange={(e) => setClientId(e.target.value)}
            />
          </label>
          <button data-testid="save-client-id" disabled={disabled || !!typedProblem} onClick={() => api().setClientId(clientId)}>
            {t('保存')}
          </button>
          <p className="muted small">
            {state.appKind === 'github-app'
              ? t('这一版还没有内置的 GitHub App：填你自己或组织建的 GitHub App 的 Client ID，那个 App 要勾上「Enable Device Flow」。')
              : t('Client ID 不是秘密，不需要 Client secret。留空保存 = 用内置值。')}
          </p>
        </div>
      )}
    </div>
  );
}
