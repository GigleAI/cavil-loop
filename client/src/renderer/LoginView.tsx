import type { AppState } from '../shared/types';
import { api } from './api';
import { AppKindPicker } from './AppKindPicker';
import { permissionText } from '../shared/appKind';

const FAILURE_TEXT: Record<string, string> = {
  denied: '你在 GitHub 页面上拒绝了授权。',
  expired: '短码已过期。',
  error: '登录没有完成。',
};

export function LoginView({ state, onHelp }: { state: AppState; onHelp: () => void }) {
  const { login } = state;
  const busy = login.status === 'requesting' || login.status === 'waiting';

  return (
    <div className="login" data-testid="login">
      <h1>Cavil Loop</h1>
      <p className="muted">用你的 GitHub 账号登录，看你的 Project 看板和仓库。</p>

      {state.loginReason && (
        <div className="banner warn" data-testid="login-reason">
          {state.loginReason}
        </div>
      )}

      <AppKindPicker state={state} disabled={busy} onHelp={onHelp} />

      {login.status === 'waiting' && login.userCode ? (
        <div className="device" data-testid="device">
          <p>在 GitHub 页面输入下面这个短码，然后点「Authorize」：</p>
          <div className="user-code" data-testid="user-code">
            {login.userCode}
          </div>
          <div className="row">
            <button className="primary" data-testid="open-browser" onClick={() => api().openVerification()}>
              打开 GitHub 授权页
            </button>
            <button onClick={() => api().cancelLogin()}>取消</button>
          </div>
          <p className="muted small">授权页：{login.verificationUri} · 正在等待你在浏览器里确认…</p>
        </div>
      ) : (
        <div className="row">
          <button className="primary" data-testid="start-login" disabled={busy} onClick={() => api().startLogin()}>
            {login.status === 'requesting' ? '正在向 GitHub 申请短码…' : login.status === 'idle' ? '用 GitHub 登录' : '重新登录'}
          </button>
        </div>
      )}

      {(login.status === 'denied' || login.status === 'expired' || login.status === 'error') && (
        <div className="banner error" data-testid="login-error" data-status={login.status}>
          {FAILURE_TEXT[login.status]} {login.message}
        </div>
      )}

      <p className="muted small" data-testid="permission-text">
        {permissionText(state.appKind, state.clientId)} 凭据存在本机钥匙串里，只发给 GitHub。
        {!state.credentialsPersistent && ' 当前系统还不支持保存凭据，退出后需要重新登录。'}
      </p>
    </div>
  );
}
