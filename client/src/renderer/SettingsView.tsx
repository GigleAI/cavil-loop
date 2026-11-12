import { useEffect, useRef, useState } from 'react';
import { DEFAULT_HAND_BACK, type AppState, type BoardData } from '../shared/types';
import { sourceLabel } from '../shared/sources';
import { api } from './api';
import { AppKindPicker } from './AppKindPicker';
import { UpdateSection } from './UpdateViews';
import { DaemonSection, useDaemonStatus } from './DaemonSection';
import { RemoteSection } from './RemoteSection';
import { ConnectButton } from './ConnectDialog';
import { Icon, type IconName } from './Icons';
import { useShortcuts } from './keyboard';
import { keyText, typingOf } from './shortcuts';
import { ProjectPicker } from './ProjectPicker';
import { FailureNote } from './FailureNote';
import type { SettingsIntent } from './EmptyGuide';
import { failureOf } from '../shared/readFailure';

const SECTIONS: { id: string; icon: IconName; title: string }[] = [
  { id: 'set-sources', icon: 'project', title: '数据来源' },
  { id: 'set-hand-back', icon: 'tag', title: '交给 agent' },
  { id: 'set-pending', icon: 'bell', title: '提醒' },
  // only in a build that updates itself (GitHub#184); the section is not there otherwise
  { id: 'set-update', icon: 'refresh', title: '更新' },
  // the local cavil-loop daemon (GitHub#314)
  { id: 'set-daemon', icon: 'gear', title: '本机 daemon' },
  // daemons on other machines, over Tailscale (GitHub#387)
  { id: 'set-remote', icon: 'gear', title: '远程 daemon' },
  { id: 'set-account', icon: 'user', title: '账号' },
  { id: 'set-login', icon: 'key', title: '登录方式' },
];

/** GitHub#404: these two cannot be empty (saving empty puts the default back) — show that default in the box too */
function keepDefault(input: HTMLInputElement, fallback: string): string {
  if (input.value.trim() === '') input.value = fallback;
  return input.value;
}

export function SettingsView({
  state,
  data,
  onBack,
  onHelp,
  intent = null,
  onIntentTaken,
}: {
  state: AppState;
  data: BoardData;
  onBack: () => void;
  onHelp: () => void;
  /** GitHub#401: opened from the empty board — the picker open, or the address box focused (taken once) */
  intent?: { what: SettingsIntent; seq: number } | null;
  onIntentTaken?: () => void;
}) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const inputBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!intent) return;
    if (intent.what === 'pick') setPicking(true);
    else inputBox.current?.focus();
    document.getElementById('set-sources')?.scrollIntoView({ block: 'start' });
    onIntentTaken?.();
  }, [intent?.seq]);
  const titles = new Map(data.projects.map((p) => [p.key, p.title]));
  // the local daemon's status: the daemon section and the repositories' "接上 daemon" share it (GitHub#315)
  const daemon = useDaemonStatus();
  // GitHub#369: Esc goes back to the board, like the "返回看板" button. In a text field the first Esc
  // only leaves it (the label fields save when left), so a half-typed value is never carried away.
  useShortcuts({
    settingsBack: () => {
      const el = document.activeElement;
      if (typingOf(el) !== 'none') (el as HTMLElement).blur();
      else onBack();
    },
  });

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
        <button className="ghost" onClick={onBack} data-testid="back" title={`返回看板（${keyText('settingsBack')}）`}>
          <Icon name="back" />
          返回看板
          <kbd data-testid="back-key">{keyText('settingsBack')}</kbd>
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
            ref={inputBox}
            data-testid="source-input"
            value={input}
            placeholder="https://github.com/orgs/GigleAI/projects/11  或  GigleAI/cavil-loop"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="primary" data-testid="source-add" onClick={add}>
            添加
          </button>
          <button className={picking ? 'on' : undefined} data-testid="source-pick" aria-expanded={picking} onClick={() => setPicking(!picking)}>
            从 GitHub 选…
          </button>
        </div>
        {picking && <ProjectPicker state={state} />}
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
              <li key={s.key} data-testid="source-row" data-key={s.key} className={st && !st.ok ? 'failed' : undefined}>
                <span className="src-icon">
                  <Icon name={s.kind === 'project' ? 'project' : 'repo'} />
                </span>
                <span className="src-main">
                  <b>{sourceLabel(s, titles.get(s.key))}</b>
                  <span className="kind">
                    {s.kind === 'project' ? 'GitHub Project' : '仓库'} · {data.items.filter((it) => it.sources.includes(s.key)).length} 个条目
                  </span>
                </span>
                {st && !st.ok && (
                  <span className="err small" data-testid="source-failed">
                    读取失败
                  </span>
                )}
                {s.kind === 'repo' && <ConnectButton repo={`${s.owner}/${s.name}`} daemon={daemon} />}
                <button className="ghost" data-testid="source-remove" onClick={() => api().removeSource(s.key)}>
                  删除
                </button>
                {st && !st.ok && (
                  <div className="src-why">
                    <FailureNote failure={failureOf(st)} state={state} testid="source-failure" />
                  </div>
                )}
              </li>
            );
          })}
          {state.sources.length === 0 && <li className="muted">还没有添加来源</li>}
        </ul>
      </section>

      <section id="set-hand-back" data-testid="hand-back-settings">
        <h3>流程标签（顶栏的三个数、「交给 agent」「托管」、关系图的 loop 前置登记都用这几个）</h3>
        <p className="muted small">
          顶栏右侧的「运行中 / 等 agent / 等人处理」三个数，分别数开着的条目里带「运行中的标签」「交给 agent 的标签」「等人处理的标签」的。运行中的标签留空，就不显示「运行中」这个数（标签页上的「正在运行」图标也认这一格，留空就不显示这个状态）；另外两格留空会恢复成默认值。
          <br />
          详情页发送按钮旁的「交给 agent」：加上「交给 agent 的标签」、去掉「等人处理的标签」；「托管（自动合并）」先加上托管标签再交给 agent。要和 daemon 配置里的标签名一致（默认 doing/agent、pending/human、pending/agent，托管标签 autopilot）。托管标签留空就不显示「托管」按钮。
          <br />
          <b>关系图</b>：开着的 issue 挂着「等前置的标签」时，读它评论里 loop 的前置登记，和 GitHub 的「Blocked by」一起画成依赖线（默认 pending/blocked，要和 daemon 配置一致）。只认仓库所有者 / 成员 / 协作者写的登记。
        </p>
        <div className="row label-grid">
          <label>
            运行中的标签（留空 = 不显示「运行中」这个数）
            <input data-testid="hand-back-running" defaultValue={state.handBack.running} onBlur={(e) => api().setHandBack({ running: e.target.value })} />
          </label>
          <label>
            等人处理的标签（去掉）
            <input data-testid="hand-back-human" defaultValue={state.handBack.human} onBlur={(e) => api().setHandBack({ human: keepDefault(e.target, DEFAULT_HAND_BACK.human) })} />
          </label>
          <label>
            交给 agent 的标签（加上）
            <input data-testid="hand-back-agent" defaultValue={state.handBack.agent} onBlur={(e) => api().setHandBack({ agent: keepDefault(e.target, DEFAULT_HAND_BACK.agent) })} />
          </label>
          <label>
            托管标签（「托管」时加上；留空 = 不显示）
            <input data-testid="hand-back-autopilot" defaultValue={state.handBack.autopilot} onBlur={(e) => api().setHandBack({ autopilot: e.target.value })} />
          </label>
          <label>
            等前置的标签（关系图按它读 loop 的前置登记；留空 = 不读）
            <input data-testid="hand-back-blocked" defaultValue={state.handBack.blocked} onBlur={(e) => api().setHandBack({ blocked: e.target.value })} />
          </label>
        </div>
        <label className="row small">
          <input type="checkbox" data-testid="autopilot-confirm" checked={state.autopilotConfirm} onChange={(e) => api().setAutopilotConfirm(e.target.checked)} />
          「托管」前先弹确认框（在确认框里勾过「不再提示」会关掉这一项，在这里勾回来）
        </label>
      </section>

      <section id="set-pending" data-testid="pending-settings">
        <h3>提醒</h3>
        <p className="muted small" data-testid="pending-rule">
          {state.notifyScope === 'mine' ? (
            <>
              开着的 issue / PR 新挂上「等人处理的标签」（上面那一格，现在是 <b data-testid="pending-label">{state.handBack.human}</b>）、并且和我有关时发一次系统通知；已挂着标签的条目后来变得和我有关（指派给我、请我 review），也算新来一条。已关闭、已合并的不提醒。App 启动或新加来源时已有的算历史，不通知、不计数。
            </>
          ) : (
            <>
              开着的 issue / PR 新挂上「等人处理的标签」（上面那一格，现在是 <b data-testid="pending-label">{state.handBack.human}</b>）时发一次系统通知；已关闭、已合并的不提醒。App 启动或新加来源时已经带着标签的条目算历史，不通知、不计数。
            </>
          )}
        </p>
        {/* GitHub#373: several people on one repository — each is reminded of their own items only */}
        <div className="notify-scope" role="radiogroup" aria-label="提醒哪些条目" data-testid="notify-scope">
          <div className="small notify-scope-title">提醒哪些条目</div>
          <label className="radio small">
            <input type="radio" name="notify-scope" data-testid="notify-scope-all" checked={state.notifyScope === 'all'} onChange={() => api().setNotifyScope('all')} />
            全部待处理（所有人共用的待办都提醒）
          </label>
          <label className="radio small">
            <input type="radio" name="notify-scope" data-testid="notify-scope-mine" checked={state.notifyScope === 'mine'} onChange={() => api().setNotifyScope('mine')} />
            <span>
              只提醒和我（<b>{state.viewer ?? '…'}</b>）有关的
            </span>
          </label>
          <p className="muted small notify-scope-note" data-testid="notify-scope-note">
            {state.notifyScope === 'mine'
              ? '「和我有关」：① 指派给我、或请我 review 的，提醒；② 已指派给别人、或只请了别人 review 的，即使我在 GitHub 上订阅着也不提醒；③ 谁都没指派、也没请人 review 的，我订阅着就提醒（开过、评论过、被 @ 过会自动订阅；条目页右侧 Subscribe 可手动加减）。PR 本身谁都没指派时，按它关联的 issue 判断。'
              : '一个仓库有几个人一起用时，每人都会收到全部待处理的通知；改成下面一项就只收自己的。'}
          </p>
        </div>
        {state.notifyProblem && (
          <div className="banner warn" data-testid="notify-problem">
            <Icon name="warn" />
            macOS 没有让 Cavil Loop 弹出通知（{state.notifyProblem}）。请打开「系统设置 → 通知 → Cavil Loop」，打开「允许通知」。角标不受影响。
          </div>
        )}
        <p className="note small" data-testid="pending-how-to-clear">
          Dock 角标只是「未读数」：窗口不在前台时每来一条新的待处理加一；切到 App 就清零。还没看就被摘掉标签或关掉的那条，不再算未读。
          <br />
          {/* GitHub#369 (PR #370 review round 1): what a click leaves behind depends on the box below */}
          <span data-testid="notification-keep-rule">
            {state.clearAllOnActivate
              ? '已勾选下面一项：切到 App 时本 App 的系统通知全部收起。点一条通知会把窗口带到前台，所以其余通知也会随之全部收起。'
              : '系统通知不会因为切到 App 而收起：点哪条通知，就只收起被点的那一条，其余留在通知中心。'}
          </span>
        </p>
        <label className="row small">
          <input
            type="checkbox"
            data-testid="clear-all-on-activate"
            checked={state.clearAllOnActivate}
            onChange={(e) => api().setClearAllOnActivate(e.target.checked)}
          />
          切到 App 时收起全部系统通知（勾上后，点一条通知时其余也会一起收起）
        </label>
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

      <DaemonSection daemon={daemon} />

      <RemoteSection />

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
