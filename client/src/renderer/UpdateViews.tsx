// The app updating itself (GitHub#184): the Settings section and the board's "ready" banner.
// What to show comes whole from the shell (state.update); nothing here decides anything.

import { useEffect, useRef, useState } from 'react';
import type { UpdateNotes, UpdateStatus } from '../shared/types';
import { api } from './api';
import { Icon } from './Icons';
import { useLayer, useShortcuts } from './keyboard';
import { MODAL } from './outsideClick';

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

/** Every client release, on GitHub (the one link the notes offer; nothing out of a release page is made clickable). */
const RELEASES_URL = 'https://github.com/GigleAI/cavil-loop/releases';

const two = (n: number) => String(n).padStart(2, '0');
/** `11-10 09:35`, in this machine's time; '' when GitHub gave no time (or one that cannot be read) */
export function noteTime(at: string | null): string {
  const d = at ? new Date(at) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Has anything to list (the buttons that open the list only show then). */
const listed = (n: UpdateNotes | null | undefined): n is UpdateNotes => !!n && n.entries.length > 0;

/**
 * What every version from the running one up to the new one changed (GitHub#348), newest first —
 * as the shell read it out of the release list; plain text only. `restart` = the new version is in
 * place and waits for a restart.
 */
export function UpdateNotesDialog({ notes, restart, onClose }: { notes: UpdateNotes; restart: boolean; onClose: () => void }) {
  useLayer('dialog');
  useShortcuts({ cancel: onClose, confirm: () => {} });
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  return (
    <div className="modal-back" {...{ [MODAL]: '' }} data-testid="update-notes" onClick={onClose}>
      <div className="modal update-notes" role="dialog" aria-modal="true" tabIndex={-1} ref={box} onClick={(e) => e.stopPropagation()}>
        <h3>
          更新内容{' '}
          <span className="sub" data-testid="update-notes-range">
            {notes.from} → {notes.to}，共 {notes.entries.length + notes.more} 个版本
          </span>
        </h3>
        {notes.entries.map((e) => (
          <div key={e.version} data-testid="update-notes-entry" data-version={e.version}>
            <div className="un-ver">
              {e.version} <span className="when">{noteTime(e.at)}</span>
            </div>
            {e.items.length ? (
              <ul className="un-items">
                {e.items.map((it, i) => (
                  <li key={i} data-testid="update-notes-item">
                    {it.more ? (
                      <details>
                        <summary>
                          <b>{it.title}</b>
                        </summary>
                        <div className="more">{it.more}</div>
                      </details>
                    ) : (
                      it.title
                    )}
                  </li>
                ))}
                {e.more > 0 && <li className="muted">还有 {e.more} 条，在 GitHub 上看</li>}
              </ul>
            ) : (
              <p className="small muted un-none" data-testid="update-notes-none">
                这一版没有写更新说明
              </p>
            )}
          </div>
        ))}
        <p className="un-note" data-testid="update-notes-foot">
          按版本从新到旧。没有写中文说明的版本，显示的是那次提交的标题。
          {notes.more > 0 && ` 还有 ${notes.more} 个更早的版本没有列出，在 GitHub 上看。`}
          {!notes.complete && ' 更早的版本说明已不在 GitHub 上（开发版只保留最近几个），这里可能不全。'}
        </p>
        <div className="row un-foot">
          <button className="link" data-testid="update-notes-web" onClick={() => void api().openExternal(RELEASES_URL)}>
            在 GitHub 上看全部版本
          </button>
          <span className="spacer" />
          <button data-testid="update-notes-close" onClick={onClose}>
            关闭
          </button>
          {restart && (
            <button className="primary" data-testid="update-notes-restart" onClick={() => api().restartToUpdate()}>
              立即重启
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The button that opens the list; nothing when there is nothing to list. */
function NotesButton({ notes, restart, label, link, testid }: { notes: UpdateNotes | null | undefined; restart: boolean; label: string; link?: boolean; testid: string }) {
  const [open, setOpen] = useState(false);
  if (!listed(notes)) return null;
  return (
    <>
      <button className={link ? 'link' : undefined} data-testid={testid} onClick={() => setOpen(true)}>
        {label}（{notes.entries.length + notes.more} 个版本）
      </button>
      {open && <UpdateNotesDialog notes={notes} restart={restart} onClose={() => setOpen(false)} />}
    </>
  );
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
        <NotesButton notes={update.notes} restart={update.phase === 'ready'} label="查看更新内容" testid="update-notes-open" />
      </div>
      {listed(update.installed) && (
        <div className="small update-installed-line" data-testid="update-installed-line">
          上次更新：{update.installed.from} → {update.installed.to}
          <NotesButton notes={update.installed} restart={false} label="查看更新内容" link testid="update-installed-open" />
        </div>
      )}
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
        <NotesButton notes={update.notes} restart label="更新内容" link testid="update-ready-notes" />
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

/** On the board, after the restart into a new version (GitHub#348): what it changed; closing it keeps it closed. */
export function UpdateInstalledBar({ update }: { update: UpdateStatus | null }) {
  const n = update?.installed;
  if (!listed(n) || n.dismissed) return null;
  return (
    <div className="banner info closable" data-testid="update-installed">
      <Icon name="refresh" />
      <span className="banner-text">
        已从 {n.from} 更新到 {n.to}。
        <NotesButton notes={n} restart={false} label="看更新了什么" link testid="update-installed-notes" />
      </span>
      <button className="banner-close" aria-label="关闭提示" title="关闭提示" data-testid="update-installed-close" onClick={() => api().dismissInstalledUpdate(n.to)}>
        <Icon name="x" />
      </button>
    </div>
  );
}
