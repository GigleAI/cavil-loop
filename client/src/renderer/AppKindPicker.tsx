// The sign-in method choice plus its Client ID box, shared by the login page
// and Settings so the two cannot drift apart.
import { useEffect, useState } from 'react';
import type { AppKind, AppState } from '../shared/types';
import { api } from './api';

export const APP_KIND_LABEL: Record<AppKind, string> = {
  oauth: 'OAuth 应用（默认）',
  'github-app': 'GitHub App（预览）',
};

export function AppKindPicker({ state, disabled, onHelp }: { state: AppState; disabled?: boolean; onHelp: () => void }) {
  const [clientId, setClientId] = useState(state.clientIdIsDefault ? '' : state.clientId);
  // switching kind shows that kind's saved override
  useEffect(() => setClientId(state.clientIdIsDefault ? '' : state.clientId), [state.appKind, state.clientId, state.clientIdIsDefault]);
  const [showAdvanced, setShowAdvanced] = useState(!state.clientId);
  const needsId = !state.clientId;

  return (
    <div className="app-kind" data-testid="app-kind">
      <div className="row">
        <span>登录方式：</span>
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
            {APP_KIND_LABEL[k]}
          </label>
        ))}
        <button className="link small" data-testid="app-kind-help-link" onClick={onHelp}>
          两种有什么区别？
        </button>
      </div>

      {!needsId && (
        <button className="link small" data-testid="oauth-settings-toggle" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? '收起 Client ID' : '改 Client ID'}
        </button>
      )}
      {(showAdvanced || needsId) && (
        <div className="advanced">
          <label>
            {state.appKind === 'github-app' ? 'GitHub App 的 Client ID' : 'OAuth 应用的 Client ID'}
            {state.clientIdIsDefault && state.clientId ? '（当前用内置值）' : ''}
            <input
              data-testid="client-id"
              value={clientId}
              disabled={disabled}
              placeholder={state.clientIdIsDefault && state.clientId ? state.clientId : state.appKind === 'github-app' ? '例如 Iv23li…' : '例如 Ov23li…'}
              onChange={(e) => setClientId(e.target.value)}
            />
          </label>
          <button data-testid="save-client-id" disabled={disabled} onClick={() => api().setClientId(clientId)}>
            保存
          </button>
          <p className="muted small">
            {state.appKind === 'github-app'
              ? '这一版还没有内置的 GitHub App：填你自己或组织建的 GitHub App 的 Client ID，那个 App 要勾上「Enable Device Flow」。'
              : 'Client ID 不是秘密，不需要 Client secret。留空保存 = 用内置值。'}
          </p>
        </div>
      )}
    </div>
  );
}

/** What the authorization page will ask for, per kind. */
export function permissionText(kind: AppKind): string {
  return kind === 'github-app'
    ? 'GitHub 授权页上会列出：Issues、Pull requests、Projects 读写，仓库基本信息只读，碰不到代码。'
    : 'GitHub 授权页上会列出：repo（仓库读写，含代码与设置）、read:org、project——OAuth 应用读私有仓库只能要整个 repo。本应用这一版只读取看板数据。';
}
