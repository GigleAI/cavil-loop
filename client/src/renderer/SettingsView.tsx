import { useState } from 'react';
import type { AppState, BoardData } from '../shared/types';
import { sourceLabel } from '../shared/sources';
import { api } from './api';
import { AppKindPicker } from './AppKindPicker';
import { badgeText, stateTone } from '../shared/stateTone';
import { UpdateSection } from './UpdateViews';
import { Icon, type IconName } from './Icons';

const SECTIONS: { id: string; icon: IconName; title: string }[] = [
  { id: 'set-sources', icon: 'project', title: '数据来源' },
  { id: 'set-hand-back', icon: 'tag', title: '交给 agent' },
  { id: 'set-pending', icon: 'bell', title: '提醒' },
  // only in a build that updates itself (GitHub#184); the section is not there otherwise
  { id: 'set-update', icon: 'refresh', title: '更新' },
  { id: 'set-account', icon: 'user', title: '账号' },
  { id: 'set-login', icon: 'key', title: '登录方式' },
];

export function SettingsView({ state, data, onBack, onHelp }: { state: AppState; data: BoardData; onBack: () => void; onHelp: () => void }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const titles = new Map(data.projects.map((p) => [p.key, p.title]));
  // what the badge counts (GitHub#185); a row the board does not have opens on GitHub instead
  const boardKeys = new Set(data.items.map((i) => i.key));
  const openCount = state.pendingItems.filter((e) => e.state === 'open').length;

  const add = async () => {
    const r = await api().addSource(input);
    if (r.ok) {
      setInput('');
      setError(null);
    } else setError(r.error ?? '添加失败');
  };

  return (
    <div className="settings" data-testid="settings">
      <div className="toolbar">
        <button className="ghost" onClick={onBack} data-testid="back">
          <Icon name="back" />
          返回看板
        </button>
        <h2>设置</h2>
        <span className="muted small">只保存在这台电脑上</span>
      </div>

      <div className="settings-body">
      {/* contents: a click scrolls to that card (one page, nothing hidden) */}
      <nav className="settings-nav" aria-label="设置目录">
        {SECTIONS.filter((x) => x.id !== 'set-update' || state.update).map((x) => (
          <a
            key={x.id}
            href={`#${x.id}`}
            onClick={(e) => {
              e.preventDefault();
              document.getElementById(x.id)?.scrollIntoView({ block: 'start' });
            }}
          >
            <Icon name={x.icon} />
            {x.title}
          </a>
        ))}
      </nav>
      <div className="settings-main">
      <section id="set-sources">
        <h3>数据来源</h3>
        <p className="muted small">GitHub Project 贴网址；仓库写「组织/仓库名」。仓库读全部开着的条目，加上最近 14 天内有更新的。</p>
        <div className="row">
          <input
            data-testid="source-input"
            value={input}
            placeholder="https://github.com/orgs/GigleAI/projects/11  或  GigleAI/cavil-loop"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="primary" data-testid="source-add" onClick={add}>
            添加
          </button>
        </div>
        {error && (
          <div className="banner error" data-testid="source-error">
            <Icon name="warn" />
            <span className="banner-text">{error}</span>
          </div>
        )}
        <ul className="sources" data-testid="source-list">
          {state.sources.map((s) => {
            const st = state.sync.sources.find((x) => x.sourceKey === s.key);
            return (
              <li key={s.key} data-testid="source-row" data-key={s.key}>
                <span className="src-icon">
                  <Icon name={s.kind === 'project' ? 'project' : 'repo'} />
                </span>
                <span className="src-main">
                  <b>{sourceLabel(s, titles.get(s.key))}</b>
                  <span className="kind">
                    {s.kind === 'project' ? 'GitHub Project' : '仓库'} · {data.items.filter((it) => it.sources.includes(s.key)).length} 个条目
                  </span>
                </span>
                {st && !st.ok && <span className="err small">读取失败：{st.error}</span>}
                <button className="ghost" data-testid="source-remove" onClick={() => api().removeSource(s.key)}>
                  删除
                </button>
              </li>
            );
          })}
          {state.sources.length === 0 && <li className="muted">还没有添加来源</li>}
        </ul>
      </section>

      <section id="set-hand-back" data-testid="hand-back-settings">
        <h3>「交给 agent」「托管」用的标签</h3>
        <p className="muted small">
          详情页发送按钮旁的「交给 agent」：加上第二个标签、去掉第一个；「托管（自动合并）」先加上托管标签再交给 agent。要和 daemon 配置里的标签名一致（默认 pending/human → pending/agent，托管标签 autopilot）。托管标签留空就不显示「托管」按钮。
        </p>
        <div className="row">
          <label>
            等人处理的标签（去掉）
            <input data-testid="hand-back-human" defaultValue={state.handBack.human} onBlur={(e) => api().setHandBack({ human: e.target.value })} />
          </label>
          <label>
            交给 agent 的标签（加上）
            <input data-testid="hand-back-agent" defaultValue={state.handBack.agent} onBlur={(e) => api().setHandBack({ agent: e.target.value })} />
          </label>
          <label>
            托管标签（「托管」时加上；留空 = 不显示）
            <input data-testid="hand-back-autopilot" defaultValue={state.handBack.autopilot} onBlur={(e) => api().setHandBack({ autopilot: e.target.value })} />
          </label>
        </div>
      </section>

      <section id="set-pending" data-testid="pending-settings">
        <h3>提醒</h3>
        <p className="muted small">
          带「等人处理的标签」（上面那一格，现在是 <b data-testid="pending-label">{state.handBack.human}</b>）的条目算「待处理」：不论开着、已关闭还是已合并。新挂上就发一次系统通知。
        </p>
        {state.notifyProblem && (
          <div className="banner warn" data-testid="notify-problem">
            <Icon name="warn" />
            macOS 没有让 Cavil Loop 弹出通知（{state.notifyProblem}）。请打开「系统设置 → 通知 → Cavil Loop」，打开「允许通知」。角标和这里的数字不受影响。
          </div>
        )}
        <p className="note small" data-testid="pending-how-to-clear">
          Dock 角标是「未读数」：窗口不在前台时新来的待处理条目会让它加一；切到 App 就清零，已经弹出的系统通知也一并收起。下面列的是现在全部待处理的条目，看过也还在；处理完了就在详情的「标签」里删掉 <b>{state.handBack.human}</b>（或直接去 GitHub 上摘），下一轮同步后它就不再列出。
        </p>
        <p className="small">
          未读：<b data-testid="unread-count">{state.unreadCount}</b> 条 · 现在待处理：<b data-testid="pending-count">{state.pendingCount}</b> 条
          {state.pendingItems.length > 0 && (
            <span className="muted" data-testid="pending-breakdown">
              （开着 {openCount} · 已关闭 / 已合并 {state.pendingItems.length - openCount}）
            </span>
          )}
        </p>
        {state.pendingItems.length > 0 && (
          <ul className="pending-list" data-testid="pending-list">
            {state.pendingItems.map((e) => {
              const onBoard = boardKeys.has(e.key);
              // the one state rule the card, the table row and the detail badge use
              const tone = stateTone(e.kind, e.state, e.stateReason, e.isDraft);
              return (
                <li key={e.key}>
                  <button
                    className="pending-row"
                    data-testid="pending-item"
                    data-key={e.key}
                    data-tone={tone}
                    title={onBoard ? '在 App 里打开详情' : '看板上没有这一条（它的来源没在看板上勾选），在浏览器打开'}
                    onClick={() => api().openPending(e.key)}
                  >
                    <span className={`state ${tone}`} data-testid="pending-item-state">
                      ● {badgeText(e.kind, e.state, e.stateReason, e.isDraft)}
                    </span>
                    <span className="muted pending-ref">
                      {e.repo}#{e.number}
                    </span>
                    <span className="pending-title">{e.title}</span>
                    {!onBoard && (
                      <span className="muted small pending-ext" data-testid="pending-item-external">
                        看板上没勾这个来源 · 在浏览器打开 ↗
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {state.launchAtLogin !== null && (
          <label className="row small">
            <input
              type="checkbox"
              data-testid="launch-at-login"
              checked={state.launchAtLogin}
              onChange={(e) => api().setLaunchAtLogin(e.target.checked)}
            />
            开机自动启动（在后台运行，不弹窗口）
          </label>
        )}
        {state.launchAtLogin !== null && (
          // same platforms as launch at login (v1: macOS)
          <p className="muted small">关掉窗口后 App 仍在后台同步和提醒（Dock 图标保留）；要完全退出，用菜单「退出」或 ⌘Q。</p>
        )}
      </section>

      <UpdateSection update={state.update} />

      <section id="set-account">
        <h3>账号</h3>
        <p>
          已登录：<b data-testid="viewer">{state.viewer ?? '…'}</b>
        </p>
        <button data-testid="logout" onClick={() => api().logout()}>
          退出登录（同时删除钥匙串里的凭据）
        </button>
      </section>

      <section id="set-login">
        <h3>登录方式</h3>
        <AppKindPicker state={state} onHelp={onHelp} />
        <p className="muted small">改了以后，下次登录生效；现在登录着的账号不受影响。</p>
      </section>
      </div>
      </div>
    </div>
  );
}
