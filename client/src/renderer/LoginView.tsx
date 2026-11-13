import type { AppState } from '../shared/types';
import { api } from './api';
import { AppKindPicker } from './AppKindPicker';
import { permissionText } from '../shared/appKind';
import { Icon } from './Icons';
import brandIcon from '../../build/icon.png';
import { t } from '../shared/i18n';
import { SaidText, Verbatim } from './Verbatim';
import { tNode } from './tNode';

const failureText = (status: string): string =>
  ({
    denied: t('你在 GitHub 页面上拒绝了授权。'),
    expired: t('短码已过期。'),
    error: t('登录没有完成。'),
  })[status] ?? '';

export function LoginView({ state, onHelp }: { state: AppState; onHelp: () => void }) {
  const { login } = state;
  const busy = login.status === 'requesting' || login.status === 'waiting';

  return (
    <div className="login-page">
    <div className="login" data-testid="login">
      <div className="login-brand">
        <img src={brandIcon} alt="" />
      </div>
      <h1>Cavil Loop</h1>
      <p className="muted lead">{t('用你的 GitHub 账号登录，看你的 Project 看板和仓库。')}</p>

      {state.loginReason && (
        <div className="banner warn" data-testid="login-reason">
          <span className="banner-text">{state.loginReasonSaid ? <SaidText said={state.loginReasonSaid} /> : state.loginReason}</span>
        </div>
      )}

      {login.status === 'waiting' && login.userCode ? (
        <div className="device" data-testid="device">
          <p>{t('在 GitHub 页面输入下面这个短码，然后点「Authorize」：')}</p>
          <div className="user-code" data-testid="user-code">
            {login.userCode}
          </div>
          <div className="row">
            <button className="primary" data-testid="open-browser" onClick={() => api().openVerification()}>
              <Icon name="ext" />
              {t('打开 GitHub 授权页')}
            </button>
            <button onClick={() => api().cancelLogin()}>{t('取消')}</button>
          </div>
          <p className="muted small">{tNode('授权页：{url} · 正在等待你在浏览器里确认…', { url: <Verbatim from="github">{login.verificationUri}</Verbatim> })}</p>
        </div>
      ) : (
        <div className="row">
          <button className="primary" data-testid="start-login" disabled={busy} onClick={() => api().startLogin()}>
            {login.status === 'requesting' ? t('正在向 GitHub 申请短码…') : login.status === 'idle' ? t('用 GitHub 登录') : t('重新登录')}
          </button>
        </div>
      )}

      {(login.status === 'denied' || login.status === 'expired' || login.status === 'error') && (
        <div className="banner error" data-testid="login-error" data-status={login.status}>
          {/* one run of text: the banner lays its children out side by side */}
          <span className="banner-text">
            {failureText(login.status)}
            {/* denied / expired: the words above already say it all (the back end's message repeats them) */}
            {login.status === 'error' && login.message && (
              <>
                {' '}
                {login.said ? <SaidText said={login.said} /> : login.message}
              </>
            )}
          </span>
        </div>
      )}

      <AppKindPicker state={state} disabled={busy} onHelp={onHelp} />

      <p className="muted small" data-testid="permission-text">
        {permissionText(state.appKind, state.clientId)} {t('凭据存在本机钥匙串里，只发给 GitHub。')}
        {!state.credentialsPersistent && ` ${t('当前系统还不支持保存凭据，退出后需要重新登录。')}`}
      </p>
    </div>
    </div>
  );
}
