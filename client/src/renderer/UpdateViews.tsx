// The app updating itself (GitHub#184): the Settings section and the board's "ready" banner.
// What to show comes whole from the shell (state.update); nothing here decides anything.

import type { UpdateStatus } from '../shared/types';
import { api } from './api';
import { Icon } from './Icons';

const MB = 1_000_000;
const mb = (n: number) => (n / MB).toFixed(1);
const clock = (at: number) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** One line: what the updater is doing, or how its last round ended. */
export function updateLine(u: UpdateStatus): string {
  if (u.problem) return u.problem;
  switch (u.phase) {
    case 'checking':
      return '正在检查…';
    case 'downloading':
      return `正在下载 ${u.version}（${mb(u.got ?? 0)}${u.total ? ` / ${mb(u.total)}` : ''} MB）`;
    case 'installing':
      return `正在安装 ${u.version}`;
    case 'ready':
      return `新版 ${u.version} 已下载，重启后生效`;
  }
  if (!u.last) return '还没有检查过';
  return u.last.ok ? `上次检查 ${clock(u.last.at)}，${u.last.message}` : `${u.last.message}（${clock(u.last.at)}）`;
}

export function UpdateSection({ update }: { update: UpdateStatus | null }) {
  if (!update) return null;
  const busy = update.phase !== 'idle' || !!update.problem;
  return (
    <section id="set-update" data-testid="update-settings">
      <h3>更新</h3>
      <p className="small">
        当前版本 <b data-testid="update-current">{update.current}</b>
      </p>
      <p className={`small${update.last && !update.last.ok && update.phase === 'idle' ? ' err' : ''}`} data-testid="update-line" data-phase={update.phase}>
        {updateLine(update)}
      </p>
      <div className="row">
        {update.phase === 'ready' ? (
          <button className="primary" data-testid="update-restart" onClick={() => api().restartToUpdate()}>
            立即重启
          </button>
        ) : (
          <button data-testid="update-check" disabled={busy} onClick={() => api().checkUpdate()}>
            立即检查
          </button>
        )}
      </div>
      <label className="row small">
        <input type="checkbox" data-testid="update-auto" checked={update.auto} disabled={!!update.problem} onChange={(e) => api().setAutoUpdate(e.target.checked)} />
        自动检查更新（每次打开 App 查一次，一直开着的话每 6 小时查一次；查到就在后台下载）
      </label>
      <ChannelPicker update={update} />
    </section>
  );
}

/** Which releases to update to (GitHub#215). Switching mid-round is the back end's to handle; only
 * while the new app is being put in place can it not be switched. */
function ChannelPicker({ update }: { update: UpdateStatus }) {
  const locked = !!update.problem || update.phase === 'installing';
  const pick = (c: 'stable' | 'dev') => {
    if (c !== update.channel) void api().setUpdateChannel(c);
  };
  return (
    <div className="small" data-testid="update-channel" data-channel={update.channel}>
      <div className="row" role="radiogroup" aria-label="更新渠道">
        更新渠道
        <label className="row">
          <input type="radio" name="update-channel" data-testid="update-channel-stable" checked={update.channel === 'stable'} disabled={locked} onChange={() => pick('stable')} />
          正式版
        </label>
        <label className="row">
          <input
            type="radio"
            name="update-channel"
            data-testid="update-channel-dev"
            checked={update.channel === 'dev'}
            disabled={locked || !!update.devUnavailable}
            onChange={() => pick('dev')}
          />
          开发版
        </label>
      </div>
      {update.phase === 'installing' ? (
        <p className="small" data-testid="update-channel-note">
          正在安装 {update.version}，装好后可以切换
        </p>
      ) : update.devUnavailable ? (
        <p className="small" data-testid="update-channel-note">
          {update.devUnavailable}
        </p>
      ) : update.channel === 'dev' ? (
        <p className="small" data-testid="update-channel-note">
          开发版跟着 main 走，每次合并都可能有新版，可能不稳定。切回正式版不会降级，会等下一个比当前高的正式版。
        </p>
      ) : null}
      {update.phase === 'ready' ? (
        <p className="small" data-testid="update-channel-ready">
          已装好 {update.version}，重启后生效；之后按所选渠道检查
        </p>
      ) : null}
    </div>
  );
}

/** On the board: the new version is in place; closing it hides it for that version. */
export function UpdateReadyBar({ update }: { update: UpdateStatus | null }) {
  if (!update || update.phase !== 'ready' || !update.version || update.dismissed === update.version) return null;
  const v = update.version;
  return (
    <div className="banner info closable" data-testid="update-ready">
      <Icon name="refresh" />
      <span className="banner-text">
        新版 {v} 已下载，重启后生效。
        <button className="link" data-testid="update-ready-restart" onClick={() => api().restartToUpdate()}>
          立即重启
        </button>
      </span>
      <button className="banner-close" aria-label="关闭提示" title="关闭提示" data-testid="update-ready-close" onClick={() => api().dismissUpdate(v)}>
        <Icon name="x" />
      </button>
    </div>
  );
}
