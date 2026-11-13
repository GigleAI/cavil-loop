// The app updating itself (GitHub#184): the Settings section and the board's "ready" banner.
// What to show comes whole from the shell (state.update); nothing here decides anything.

import { useEffect, useRef, useState } from 'react';
import type { UpdateNotes, UpdateStatus } from '../shared/types';
import { api } from './api';
import { Icon } from './Icons';
import { useLayer, useShortcuts } from './keyboard';
import { t } from '../shared/i18n';
import type { ReactNode } from 'react';
import { SaidText, Verbatim } from './Verbatim';
import { tNode } from './tNode';

const MB = 1_000_000;
const mb = (n: number) => (n / MB).toFixed(1);
const clock = (at: number) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * One line: what the updater is doing, or how its last round ended. The back end words its own
 * part (the last round, the problem) in the window's language; the outside words in it (the
 * network's, the updater's) are shown as written (GitHub#473).
 */
export function updateLine(u: UpdateStatus): ReactNode {
  if (u.problem) return u.problem;
  const version = u.version ?? '';
  switch (u.phase) {
    case 'checking':
      return t('正在检查…');
    case 'downloading':
      return u.total ? t('正在下载 {version}（{got} / {total} MB）', { version, got: mb(u.got ?? 0), total: mb(u.total) }) : t('正在下载 {version}（{got} MB）', { version, got: mb(u.got ?? 0) });
    case 'installing':
      return t('正在安装 {version}', { version });
    case 'ready':
      return t('新版 {version} 已下载，重启后生效', { version });
  }
  if (!u.last) return t('还没有检查过');
  const message = u.last.said ? <SaidText said={u.last.said} /> : u.last.message;
  return u.last.ok ? tNode('上次检查 {time}，{message}', { time: clock(u.last.at), message }) : tNode('{message}（{time}）', { message, time: clock(u.last.at) });
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
    <div className="modal-back" data-testid="update-notes" onClick={onClose}>
      <div className="modal update-notes" role="dialog" aria-modal="true" tabIndex={-1} ref={box} onClick={(e) => e.stopPropagation()}>
        <h3>
          {t('更新内容')}{' '}
          <span className="sub" data-testid="update-notes-range">
            {t('{from} → {to}，共 {n} 个版本', { from: notes.from, to: notes.to, n: notes.entries.length + notes.more })}
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
                    {/* the release page's words (GitHub), shown as written */}
                    {it.more ? (
                      <details>
                        <summary>
                          <b>
                            <Verbatim from="github">{it.title}</Verbatim>
                          </b>
                        </summary>
                        <div className="more">
                          <Verbatim from="github">{it.more}</Verbatim>
                        </div>
                      </details>
                    ) : (
                      <Verbatim from="github">{it.title}</Verbatim>
                    )}
                  </li>
                ))}
                {e.more > 0 && <li className="muted">{t('还有 {n} 条，在 GitHub 上看', { n: e.more })}</li>}
              </ul>
            ) : (
              <p className="small muted un-none" data-testid="update-notes-none">
                {t('这一版没有写更新说明')}
              </p>
            )}
          </div>
        ))}
        <p className="un-note" data-testid="update-notes-foot">
          {t('按版本从新到旧。没有写中文说明的版本，显示的是那次提交的标题。')}
          {notes.more > 0 && t(' 还有 {n} 个更早的版本没有列出，在 GitHub 上看。', { n: notes.more })}
          {!notes.complete && t(' 更早的版本说明已不在 GitHub 上（开发版只保留最近几个），这里可能不全。')}
        </p>
        <div className="row un-foot">
          <button className="link" data-testid="update-notes-web" onClick={() => void api().openExternal(RELEASES_URL)}>
            {t('在 GitHub 上看全部版本')}
          </button>
          <span className="spacer" />
          <button data-testid="update-notes-close" onClick={onClose}>
            {t('关闭')}
          </button>
          {restart && (
            <button className="primary" data-testid="update-notes-restart" onClick={() => api().restartToUpdate()}>
              {t('立即重启')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The button that opens the list; nothing when there is nothing to list.
 *
 * "Open" belongs to the list it was opened on (which versions, from → to): once that list is gone —
 * the round failed, the channel was switched, another version is found — the dialog is closed for
 * good, and a list that arrives later never opens by itself. The same list arriving again with
 * every progress report of one download keeps it open.
 */
function NotesButton({ notes, restart, label, link, testid }: { notes: UpdateNotes | null | undefined; restart: boolean; label: string; link?: boolean; testid: string }) {
  const key = listed(notes) ? `${notes.from}\n${notes.to}` : null;
  const [openOn, setOpenOn] = useState<string | null>(null);
  useEffect(() => {
    setOpenOn((was) => (was !== null && was !== key ? null : was));
  }, [key]);
  if (!listed(notes)) return null;
  return (
    <>
      <button className={link ? 'link' : undefined} data-testid={testid} onClick={() => setOpenOn(key)}>
        {t('{label}（{n} 个版本）', { label, n: notes.entries.length + notes.more })}
      </button>
      {openOn !== null && openOn === key && <UpdateNotesDialog notes={notes} restart={restart} onClose={() => setOpenOn(null)} />}
    </>
  );
}

export function UpdateSection({ update }: { update: UpdateStatus | null }) {
  if (!update) return null;
  const busy = update.phase !== 'idle' || !!update.problem;
  return (
    <section id="set-update" data-testid="update-settings">
      <h3>{t('更新')}</h3>
      <p className="small">{tNode('当前版本 {version}', { version: <b data-testid="update-current">{update.current}</b> })}</p>
      <p className={`small${update.last && !update.last.ok && update.phase === 'idle' ? ' err' : ''}`} data-testid="update-line" data-phase={update.phase}>
        {updateLine(update)}
      </p>
      <div className="row">
        {update.phase === 'ready' ? (
          <button className="primary" data-testid="update-restart" onClick={() => api().restartToUpdate()}>
            {t('立即重启')}
          </button>
        ) : (
          <button data-testid="update-check" disabled={busy} onClick={() => api().checkUpdate()}>
            {t('立即检查')}
          </button>
        )}
        <NotesButton notes={update.notes} restart={update.phase === 'ready'} label={t('查看更新内容')} testid="update-notes-open" />
      </div>
      {listed(update.installed) && (
        <div className="small update-installed-line" data-testid="update-installed-line">
          {t('上次更新：{from} → {to}', { from: update.installed.from, to: update.installed.to })}
          <NotesButton notes={update.installed} restart={false} label={t('查看更新内容')} link testid="update-installed-open" />
        </div>
      )}
      <label className="row small">
        <input type="checkbox" data-testid="update-auto" checked={update.auto} disabled={!!update.problem} onChange={(e) => api().setAutoUpdate(e.target.checked)} />
        {t('自动检查更新（每次打开 App 查一次，一直开着的话每 6 小时查一次；查到就在后台下载）')}
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
      <div className="row" role="radiogroup" aria-label={t('更新渠道')}>
        {t('更新渠道')}
        <label className="row">
          <input type="radio" name="update-channel" data-testid="update-channel-stable" checked={update.channel === 'stable'} disabled={locked} onChange={() => pick('stable')} />
          {t('正式版')}
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
          {t('开发版')}
        </label>
      </div>
      {update.phase === 'installing' ? (
        <p className="small" data-testid="update-channel-note">
          {t('正在安装 {version}，装好后可以切换', { version: update.version ?? '' })}
        </p>
      ) : update.devUnavailable ? (
        <p className="small" data-testid="update-channel-note">
          {update.devUnavailable}
        </p>
      ) : update.channel === 'dev' ? (
        <p className="small" data-testid="update-channel-note">
          {t('开发版跟着 main 走，每次合并都可能有新版，可能不稳定。切回正式版不会降级，会等下一个比当前高的正式版。')}
        </p>
      ) : null}
      {update.phase === 'ready' ? (
        <p className="small" data-testid="update-channel-ready">
          {t('已装好 {version}，重启后生效；之后按所选渠道检查', { version: update.version ?? '' })}
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
        {t('新版 {version} 已下载，重启后生效。', { version: v })}
        <NotesButton notes={update.notes} restart label={t('更新内容')} link testid="update-ready-notes" />
        <button className="link" data-testid="update-ready-restart" onClick={() => api().restartToUpdate()}>
          {t('立即重启')}
        </button>
      </span>
      <button className="banner-close" aria-label={t('关闭提示')} title={t('关闭提示')} data-testid="update-ready-close" onClick={() => api().dismissUpdate(v)}>
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
        {t('已从 {from} 更新到 {to}。', { from: n.from, to: n.to })}
        <NotesButton notes={n} restart={false} label={t('看更新了什么')} link testid="update-installed-notes" />
      </span>
      <button className="banner-close" aria-label={t('关闭提示')} title={t('关闭提示')} data-testid="update-installed-close" onClick={() => api().dismissInstalledUpdate(n.to)}>
        <Icon name="x" />
      </button>
    </div>
  );
}
