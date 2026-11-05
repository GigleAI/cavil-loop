import { useState } from 'react';
import type { AppState, BoardData } from '../shared/types';
import { sourceLabel } from '../shared/sources';
import { api } from './api';
import { AppKindPicker } from './AppKindPicker';

export function SettingsView({ state, data, onBack, onHelp }: { state: AppState; data: BoardData; onBack: () => void; onHelp: () => void }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState(state.pendingLabel);
  const titles = new Map(data.projects.map((p) => [p.key, p.title]));

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
        <button onClick={onBack} data-testid="back">
          ← 返回看板
        </button>
        <h2>设置</h2>
      </div>

      <section>
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
            {error}
          </div>
        )}
        <ul className="sources" data-testid="source-list">
          {state.sources.map((s) => {
            const st = state.sync.sources.find((x) => x.sourceKey === s.key);
            return (
              <li key={s.key} data-testid="source-row" data-key={s.key}>
                <span className="kind">{s.kind === 'project' ? 'Project' : '仓库'}</span>
                <span>{sourceLabel(s, titles.get(s.key))}</span>
                {st && !st.ok && <span className="err small">读取失败：{st.error}</span>}
                <button className="link" data-testid="source-remove" onClick={() => api().removeSource(s.key)}>
                  删除
                </button>
              </li>
            );
          })}
          {state.sources.length === 0 && <li className="muted">还没有添加来源</li>}
        </ul>
      </section>

      <section data-testid="pending-settings">
        <h3>提醒</h3>
        <p className="muted small">
          带这个标签的条目算「待处理」：不论开着、已关闭还是已合并。新挂上就发一次系统通知，Dock 角标显示总数。和 daemon 配置里的标签名保持一致。
        </p>
        <div className="row">
          <input
            data-testid="pending-label"
            value={label}
            placeholder="pending/human"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && api().setPendingLabel(label)}
          />
          <button data-testid="pending-label-save" disabled={label.trim() === state.pendingLabel} onClick={() => api().setPendingLabel(label)}>
            保存
          </button>
        </div>
        <p className="small">
          现在待处理：<b data-testid="pending-count">{state.pendingCount}</b> 条
        </p>
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

      <section>
        <h3>账号</h3>
        <p>
          已登录：<b data-testid="viewer">{state.viewer ?? '…'}</b>
        </p>
        <button data-testid="logout" onClick={() => api().logout()}>
          退出登录（同时删除钥匙串里的凭据）
        </button>
      </section>

      <section>
        <h3>登录方式</h3>
        <AppKindPicker state={state} onHelp={onHelp} />
        <p className="muted small">改了以后，下次登录生效；现在登录着的账号不受影响。</p>
      </section>
    </div>
  );
}
