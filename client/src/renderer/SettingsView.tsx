import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_BLOCKED_LABELS } from '../shared/blocked';
import { DEFAULT_HAND_BACK, type AppState, type BoardData } from '../shared/types';
import { shownOnBoard, sourceLabel } from '../shared/sources';
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
import { getLang, preferredLanguages, systemLang, t, type Lang } from '../shared/i18n';
import type { ThemeSetting } from '../shared/theme';
import { KeepLang, SourceName, Verbatim } from './Verbatim';
import { tNode } from './tNode';
import { TallySettings } from './TallySettings';
import { ShortcutSettings } from './ShortcutSettings';
import { SettingsMore } from './SettingsMore';

const sections = (): { id: string; icon: IconName; title: ReactNode }[] => [
  // GitHub#471: first, and named in both languages — found by someone who cannot read the current one
  { id: 'set-language', icon: 'globe', title: <LanguageName /> },
  // GitHub#516
  { id: 'set-theme', icon: 'contrast', title: t('外观') },
  { id: 'set-sources', icon: 'project', title: t('数据来源') },
  // GitHub#514: named like the card's own title
  { id: 'set-hand-back', icon: 'tag', title: t('流程标签') },
  // GitHub#468: the view-bar numbers
  { id: 'set-tallies', icon: 'sliders', title: t('顶栏计数') },
  { id: 'set-pending', icon: 'bell', title: t('提醒') },
  // GitHub#487
  { id: 'set-keys', icon: 'keyboard', title: t('快捷键') },
  // only in a build that updates itself (GitHub#184); the section is not there otherwise
  { id: 'set-update', icon: 'refresh', title: t('更新') },
  // the local cavil-loop daemon (GitHub#314)
  { id: 'set-daemon', icon: 'gear', title: t('本机 daemon') },
  // daemons on other machines, over Tailscale (GitHub#387)
  { id: 'set-remote', icon: 'gear', title: t('远程 daemon') },
  // GitHub#514: the sign-in method is part of the account card
  { id: 'set-account', icon: 'user', title: t('账号') },
];

/** "语言 · Language" — the current language's word first (GitHub#471; both are kept as they are) */
function LanguageName() {
  const zh = <KeepLang text="语言" />;
  const en = <KeepLang text="Language" />;
  return (
    <span className="lang-name">
      {getLang() === 'zh' ? zh : en}
      {' · '}
      {getLang() === 'zh' ? en : zh}
    </span>
  );
}

/** a language named in its own words (kept as is: someone who reads only that one recognises it) */
function OwnName({ lang }: { lang: Lang }) {
  return lang === 'zh' ? <KeepLang text="简体中文" /> : <KeepLang text="English" />;
}

/** GitHub#471: the interface language — 简体中文 (default) / English / follow the system */
function LanguageSection({ state }: { state: AppState }) {
  const sys = systemLang(preferredLanguages());
  return (
    <section id="set-language" data-testid="language-settings">
      <h3 data-testid="language-title">
        <LanguageName />
      </h3>
      <p className="muted small">{t('窗口、菜单、系统通知和提示用的语言。GitHub 上的标题、评论、标签照原样显示，不翻译。')}</p>
      <div className="lang-choices" role="radiogroup" aria-labelledby="language-title-text" data-testid="language-choices">
        <span id="language-title-text" className="sr-only">
          {t('界面语言')}
        </span>
        <label className="radio small">
          <input type="radio" name="ui-language" data-testid="lang-zh" checked={state.uiLanguage === 'zh'} onChange={() => api().setUiLanguage('zh')} />
          <span>
            <OwnName lang="zh" />
            {t('（默认）')}
          </span>
        </label>
        <label className="radio small">
          <input type="radio" name="ui-language" data-testid="lang-en" checked={state.uiLanguage === 'en'} onChange={() => api().setUiLanguage('en')} />
          <OwnName lang="en" />
        </label>
        <label className="radio small">
          <input type="radio" name="ui-language" data-testid="lang-auto" checked={state.uiLanguage === 'auto'} onChange={() => api().setUiLanguage('auto')} />
          <span data-testid="lang-auto-label">{tNode('跟随系统（现在：{lang}）', { lang: <OwnName lang={sys} /> })}</span>
        </label>
      </div>
    </section>
  );
}

/**
 * GitHub#516: light / dark — follow the system (default) / light / dark. "现在：…" is said only while
 * following the system: once the native window is told light or dark, what the window reads as the
 * system's setting is that choice, not the system's.
 */
function ThemeSection({ state }: { state: AppState }) {
  const choice = (value: ThemeSetting, label: ReactNode) => (
    <label className="radio small">
      <input type="radio" name="ui-theme" data-testid={`theme-${value}`} checked={state.uiTheme === value} onChange={() => api().setUiTheme(value)} />
      <span data-testid={`theme-${value}-label`}>{label}</span>
    </label>
  );
  return (
    <section id="set-theme" data-testid="theme-settings">
      <h3 id="theme-title">{t('外观')}</h3>
      <p className="muted small">{t('窗口用浅色还是深色。看板、详情、讨论区、关系图、标签颜色和窗口标题栏一起换，选了立刻生效。')}</p>
      <div className="lang-choices" role="radiogroup" aria-labelledby="theme-title" data-testid="theme-choices">
        {choice('system', state.uiTheme === 'system' ? t('跟随系统（默认，现在：{look}）', { look: state.theme === 'dark' ? t('深色') : t('浅色') }) : t('跟随系统（默认）'))}
        {choice('light', t('浅色'))}
        {choice('dark', t('深色'))}
      </div>
    </section>
  );
}

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
    // GitHub#487: from the shortcut list's "在设置里改快捷键"
    if (intent.what === 'keys') {
      document.getElementById('set-keys')?.scrollIntoView({ block: 'start' });
      onIntentTaken?.();
      return;
    }
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
    } else setError(r.error ?? t('添加失败'));
  };

  return (
    <div className="settings" data-testid="settings">
      <div className="toolbar">
        <button className="ghost" onClick={onBack} data-testid="back" title={t('返回看板（{key}）', { key: keyText('settingsBack') })}>
          <Icon name="back" />
          {t('返回看板')}
          <kbd data-testid="back-key">{keyText('settingsBack')}</kbd>
        </button>
        <h2>{t('设置')}</h2>
        <span className="muted small">{t('只保存在这台电脑上')}</span>
      </div>

      <div className="settings-body">
      {/* contents: a click scrolls to that card (one page, nothing hidden) */}
      <nav className="settings-nav" aria-label={t('设置目录')} data-testid="settings-nav">
        {sections().filter((x) => x.id !== 'set-update' || state.update).map((x) => (
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
      <LanguageSection state={state} />
      <ThemeSection state={state} />

      <section id="set-sources">
        <h3>{t('数据来源')}</h3>
        <p className="muted small">{t('贴 GitHub Project 网址，或写「组织/仓库名」。')}</p>
        <div className="row">
          <input
            ref={inputBox}
            data-testid="source-input"
            value={input}
            placeholder={t('https://github.com/orgs/GigleAI/projects/11  或  GigleAI/cavil-loop')}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="primary" data-testid="source-add" onClick={add}>
            {t('添加')}
          </button>
          <button className={picking ? 'on' : undefined} data-testid="source-pick" aria-expanded={picking} onClick={() => setPicking(!picking)}>
            {t('从 GitHub 选…')}
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
            // GitHub#467: the board leaves a switched-off source out (it stays here, and keeps being read)
            const shown = state.view.selected === null || state.view.selected.includes(s.key);
            return (
              <li
                key={s.key}
                data-testid="source-row"
                data-key={s.key}
                data-shown={shown ? 'yes' : 'no'}
                className={[st && !st.ok ? 'failed' : '', shown ? '' : 'off'].filter(Boolean).join(' ') || undefined}
              >
                <span className="src-icon">
                  <Icon name={s.kind === 'project' ? 'project' : 'repo'} />
                </span>
                <span className="src-main">
                  <b>
                    <SourceName source={s} title={titles.get(s.key)} />
                  </b>
                  <span className="kind">
                    {s.kind === 'project' ? 'GitHub Project' : t('仓库')} · {t('{n} 个条目', { n: data.items.filter((it) => it.sources.includes(s.key)).length })}
                    {!shown && <span data-testid="source-hidden-note"> · {t('看板上暂不显示')}</span>}
                  </span>
                </span>
                {st && !st.ok && (
                  <span className="err small" data-testid="source-failed">
                    {t('读取失败')}
                  </span>
                )}
                <label className="toggle small" title={t('关掉后看板上暂时不显示这个来源的条目；来源不删，照常同步')}>
                  <input
                    type="checkbox"
                    data-testid="source-shown"
                    data-key={s.key}
                    checked={shown}
                    onChange={(e) => api().setView({ selected: shownOnBoard(state.sources, state.view.selected, s.key, e.target.checked) })}
                  />
                  {t('在看板显示')}
                </label>
                {s.kind === 'repo' && <ConnectButton repo={`${s.owner}/${s.name}`} daemon={daemon} />}
                <button className="ghost" data-testid="source-remove" onClick={() => api().removeSource(s.key)}>
                  {t('删除')}
                </button>
                {st && !st.ok && (
                  <div className="src-why">
                    <FailureNote failure={failureOf(st)} state={state} testid="source-failure" />
                  </div>
                )}
              </li>
            );
          })}
          {state.sources.length === 0 && <li className="muted">{t('还没有添加来源')}</li>}
        </ul>
        <SettingsMore title={t('读哪些条目')} testid="sources-more">
          {t('仓库读全部开着的条目、最近 14 天内有更新的，以及已关闭但还带着「等人处理的标签」的。GitHub Project 读它里面的全部条目。')}
        </SettingsMore>
      </section>

      <section id="set-hand-back" data-testid="hand-back-settings">
        <h3>{t('流程标签')}</h3>
        <p className="muted small">{t('要和 daemon 配置里的标签名一致。')}</p>
        <div className="row label-grid">
          <label>
            {t('运行中')}
            <input data-testid="hand-back-running" defaultValue={state.handBack.running} onBlur={(e) => api().setHandBack({ running: e.target.value })} />
            <span className="field-hint">{t('顶栏「运行中」、标签页的运行图标；留空 = 不用')}</span>
          </label>
          <label>
            {t('等人处理')}
            <input data-testid="hand-back-human" defaultValue={state.handBack.human} onBlur={(e) => api().setHandBack({ human: keepDefault(e.target, DEFAULT_HAND_BACK.human) })} />
            <span className="field-hint">{t('提醒、顶栏「等人处理」；「交给 agent」时去掉')}</span>
          </label>
          <label>
            {t('暂缓')}
            <input data-testid="hand-back-later" defaultValue={state.handBack.later} onBlur={(e) => api().setHandBack({ later: e.target.value })} />
            <span className="field-hint">{t('顶栏「稍后处理」，标签下拉里排在等人处理之后；留空 = 两样都不做')}</span>
          </label>
          <label>
            {t('交给 agent')}
            <input data-testid="hand-back-agent" defaultValue={state.handBack.agent} onBlur={(e) => api().setHandBack({ agent: keepDefault(e.target, DEFAULT_HAND_BACK.agent) })} />
            <span className="field-hint">{t('「交给 agent」时加上')}</span>
          </label>
          <label>
            {t('托管')}
            <input data-testid="hand-back-autopilot" defaultValue={state.handBack.autopilot} onBlur={(e) => api().setHandBack({ autopilot: e.target.value })} />
            <span className="field-hint">{t('「托管」时加上；留空 = 不显示「托管」按钮')}</span>
          </label>
          <label>
            {t('等前置')}
            <input data-testid="hand-back-blocked" defaultValue={state.handBack.blocked} onBlur={(e) => api().setHandBack({ blocked: e.target.value })} />
            <span className="field-hint">{t('「等前置…」时加上，关系图读它的登记；留空 = 不用')}</span>
          </label>
          <label>
            {t('其他流程标签')}
            <input data-testid="blocked-flow" defaultValue={state.blockedLabels.flow} onBlur={(e) => api().setBlockedLabels({ flow: keepDefault(e.target, DEFAULT_BLOCKED_LABELS.flow) })} />
            <span className="field-hint">{t('挂着时「等前置…」置灰；逗号分隔，* 结尾 = 前缀')}</span>
          </label>
        </div>
        <label className="row small" title={t('在确认框里勾过「不再提示」会关掉这一项，在这里勾回来')}>
          <input type="checkbox" data-testid="autopilot-confirm" checked={state.autopilotConfirm} onChange={(e) => api().setAutopilotConfirm(e.target.checked)} />
          {t('「托管」前先弹确认框')}
        </label>
        <SettingsMore title={t('这些标签各用在哪')} testid="hand-back-more">
          {t('顶栏右侧的数在下面「顶栏计数」里设置；跟随流程标签的数按这里的标签名数：跟随「等人处理」的开着的和已关闭的都数，其余的只数开着的。「运行中」「暂缓」留空，跟随它的数就不显示（标签页上的「正在运行」图标也认「运行中」这一格，留空就不显示这个状态）；「等人处理」「交给 agent」留空会恢复成默认值。')}
          <br />
          {t('详情页发送按钮旁的「交给 agent」：加上「交给 agent 的标签」、去掉「等人处理的标签」；「托管（自动合并）」先加上托管标签再交给 agent。要和 daemon 配置里的标签名一致（默认 doing/agent、pending/human、pending/agent，托管标签 autopilot）。托管标签留空就不显示「托管」按钮。')}
          <br />
          {tNode('{graph}：开着的 issue 挂着「等前置的标签」时，读它评论里 loop 的前置登记，和 GitHub 的「Blocked by」一起画成依赖线（默认 pending/blocked，要和 daemon 配置一致）。只认仓库所有者 / 成员 / 协作者写的登记。', { graph: <b>{t('关系图')}</b> })}
          <br />
          <span data-testid="blocked-settings-note">
            {t('「等前置…」：选这一条要等的 issue / PR，按 daemon 认的方式登记，再挂上等前置的标签；前置全部完成后 daemon 自动翻回「交给 agent 的标签」。条目挂着「其他流程标签」里任何一个（上面的「等人处理的标签」和等前置标签本身除外）时按钮置灰：daemon 看到这些标签就不处理等前置，登记了也不会生效。要和 daemon 配置一致。')}
          </span>
          <br />
          {t('「托管」前的确认框：在确认框里勾过「不再提示」会关掉上面那一项，在这里勾回来。')}
        </SettingsMore>
      </section>

      <TallySettings state={state} data={data} />

      <section id="set-pending" data-testid="pending-settings">
        <h3>{t('提醒')}</h3>
        <p className="muted small" data-testid="pending-rule">
          {state.notifyScope === 'mine'
            ? tNode('条目新挂上 {label}、并且和我有关时发一次系统通知（已关闭、已合并的也算）。', {
              label: (
                <b data-testid="pending-label">
                  <Verbatim from="user">{state.handBack.human}</Verbatim>
                </b>
              ),
            })
            : tNode('条目新挂上 {label} 时发一次系统通知（已关闭、已合并的也算）。', {
              label: (
                <b data-testid="pending-label">
                  <Verbatim from="user">{state.handBack.human}</Verbatim>
                </b>
              ),
            })}
        </p>
        {/* GitHub#373: several people on one repository — each is reminded of their own items only */}
        <div className="notify-scope" role="radiogroup" aria-label={t('提醒哪些条目')} data-testid="notify-scope">
          <div className="small notify-scope-title">{t('提醒哪些条目')}</div>
          <label className="radio small">
            <input type="radio" name="notify-scope" data-testid="notify-scope-all" checked={state.notifyScope === 'all'} onChange={() => api().setNotifyScope('all')} />
            {t('全部待处理')}
          </label>
          <label className="radio small">
            <input type="radio" name="notify-scope" data-testid="notify-scope-mine" checked={state.notifyScope === 'mine'} onChange={() => api().setNotifyScope('mine')} />
            <span>{tNode('只提醒和我（{viewer}）有关的', { viewer: <b>{state.viewer ? <Verbatim from="github">{state.viewer}</Verbatim> : '…'}</b> })}</span>
          </label>
          <p className="muted small notify-scope-note" data-testid="notify-scope-note">
            {state.notifyScope === 'mine' ? t('指派给我、请我 review 的提醒；谁都没指派的，我订阅着才提醒。') : t('几个人一起用一个仓库时，选下面一项就只收自己的。')}
          </p>
        </div>
        {state.notifyProblem && (
          <div className="banner warn" data-testid="notify-problem">
            <Icon name="warn" />
            <span>{tNode('macOS 没有让 Cavil Loop 弹出通知（{why}）。请打开「系统设置 → 通知 → Cavil Loop」，打开「允许通知」。角标不受影响。', { why: <Verbatim from="system">{state.notifyProblem}</Verbatim> })}</span>
          </div>
        )}
        <label className="row small">
          <input
            type="checkbox"
            data-testid="clear-all-on-activate"
            checked={state.clearAllOnActivate}
            onChange={(e) => api().setClearAllOnActivate(e.target.checked)}
          />
          {t('切到 App 时收起全部系统通知')}
        </label>
        <p className="muted small" data-testid="pending-how-to-clear">
          {t('Dock 角标 = 窗口不在前台时新来的待处理数，切到 App 清零。')}
        </p>
        {state.launchAtLogin !== null && (
          <label className="row small">
            <input
              type="checkbox"
              data-testid="launch-at-login"
              checked={state.launchAtLogin}
              onChange={(e) => api().setLaunchAtLogin(e.target.checked)}
            />
            {t('开机自动启动（在后台运行，不弹窗口）')}
          </label>
        )}
        {state.launchAtLogin !== null && (
          // same platforms as launch at login (v1: macOS)
          <p className="muted small">{t('关掉窗口后 App 仍在后台同步和提醒（Dock 图标保留）；要完全退出，用菜单「退出」或 ⌘Q。')}</p>
        )}
        <SettingsMore title={t('提醒规则')} testid="pending-more">
          <span data-testid="pending-rule-full">
            {state.notifyScope === 'mine'
              ? tNode('issue / PR 新挂上「等人处理的标签」（上面那一格，现在是 {label}）、并且和我有关时发一次系统通知；已挂着标签的条目后来变得和我有关（指派给我、请我 review），也算新来一条。已关闭、已合并的也提醒（托管的条目合并后就关闭了，留着标签等人看），带着标签关闭或重新打开不再提醒一次。App 启动或新加来源时已有的算历史，不通知、不计数。', {
                  label: <Verbatim from="user">{state.handBack.human}</Verbatim>,
                })
              : tNode('issue / PR 新挂上「等人处理的标签」（上面那一格，现在是 {label}）时发一次系统通知；已关闭、已合并的也提醒（托管的条目合并后就关闭了，留着标签等人看），带着标签关闭或重新打开不再提醒一次。App 启动或新加来源时已经带着标签的条目算历史，不通知、不计数。', {
                  label: <Verbatim from="user">{state.handBack.human}</Verbatim>,
                })}
          </span>
          <br />
          {t('「和我有关」：① 指派给我、或请我 review 的，提醒；② 已指派给别人、或只请了别人 review 的，即使我在 GitHub 上订阅着也不提醒；③ 谁都没指派、也没请人 review 的，我订阅着就提醒（开过、评论过、被 @ 过会自动订阅；条目页右侧 Subscribe 可手动加减）。PR 本身谁都没指派时，按它关联的 issue 判断。')}
          <br />
          {t('一个仓库有几个人一起用时，选「全部待处理」每人都会收到全部待处理的通知；选「只提醒和我有关的」就只收自己的。')}
          <br />
          {t('Dock 角标只是「未读数」：窗口不在前台时每来一条新的待处理加一；切到 App 就清零。还没看就被摘掉标签或关掉的那条，不再算未读。')}
          <br />
          {/* GitHub#369 (PR #370 review round 1): what a click leaves behind depends on the box above */}
          <span data-testid="notification-keep-rule">
            {state.clearAllOnActivate
              ? t('已勾选「切到 App 时收起全部系统通知」：切到 App 时本 App 的系统通知全部收起。点一条通知会把窗口带到前台，所以其余通知也会随之全部收起。')
              : t('系统通知不会因为切到 App 而收起：点哪条通知，就只收起被点的那一条，其余留在通知中心。')}
          </span>
        </SettingsMore>
      </section>

      <ShortcutSettings state={state} />

      <UpdateSection update={state.update} />

      <DaemonSection daemon={daemon} />

      <RemoteSection />

      <section id="set-account">
        <h3>{t('账号')}</h3>
        <div className="row account-row">
          <span>
            {tNode('已登录：{viewer}', {
              viewer: (
                <b data-testid="viewer">
                  <Verbatim from="github">{state.viewer ?? '…'}</Verbatim>
                </b>
              ),
            })}
          </span>
          <button data-testid="logout" onClick={() => api().logout()}>
            {t('退出登录')}
          </button>
          <span className="muted small">{t('会删除钥匙串里的凭据')}</span>
        </div>
        {/* GitHub#514: the sign-in method, inside the account card (it was a card of its own) */}
        <div id="set-login" className="account-login">
          <AppKindPicker state={state} onHelp={onHelp} />
          <p className="muted small">{t('登录方式改了，下次登录生效；现在登录着的账号不受影响。')}</p>
        </div>
      </section>
      </div>
      </div>
    </div>
  );
}
