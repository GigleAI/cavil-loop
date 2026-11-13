import { useState } from 'react';
import { avatarInitial, avatarUrl } from '../shared/avatar';
import { t } from '../shared/i18n';

/** A person's avatar (GitHub#155); the first letter when there is none or it does not load. */
export function Avatar({ login, size = 16 }: { login: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.55)) };
  if (!login || failed) {
    return (
      <span className="avatar initial" style={style} data-testid="avatar" data-login={login ?? ''} data-fallback="yes" title={login ?? t('已删除的账号')}>
        {avatarInitial(login)}
      </span>
    );
  }
  return (
    <img
      className="avatar"
      style={style}
      src={avatarUrl(login, size)}
      alt=""
      title={login}
      data-testid="avatar"
      data-login={login}
      data-fallback="no"
      onError={() => setFailed(true)}
    />
  );
}

/** A login with its avatar in front. */
export function Person({ login, size = 16 }: { login: string | null; size?: number }) {
  return (
    <span className="person">
      <Avatar login={login} size={size} />
      {login ?? t('（已删除的账号）')}
    </span>
  );
}
