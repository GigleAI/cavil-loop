// GitHub#401: what the empty board shows instead of one line of text — how to add a source, or,
// when every source in view failed, which ones and why (shared/emptyGuide.ts decides which).

import type { AppState } from '../shared/types';
import type { EmptyGuide as Guide } from '../shared/emptyGuide';
import { failureOf } from '../shared/readFailure';
import { Icon } from './Icons';
import { FailureNote, openAuthPage } from './FailureNote';

/** GitHub#487: 'keys' = the shortcut list's "在设置里改快捷键" */
export type SettingsIntent = 'pick' | 'add' | 'keys';

export function EmptyGuide({ guide, state, labelOf, onSettings }: { guide: NonNullable<Guide>; state: AppState; labelOf: (key: string) => string; onSettings: (intent?: SettingsIntent) => void }) {
  if (guide.kind === 'add')
    return (
      <div className="guide" data-testid="empty-guide" data-kind="add">
        <h3>还没有数据来源</h3>
        <p>看板显示的是 GitHub Project 或仓库里的 issue / PR。先添加一个来源：</p>
        <div className="guide-choice">
          <div className="opt">
            <b>
              <Icon name="project" />从 GitHub 选 Project
            </b>
            <span>列出{state.viewer ? ` ${state.viewer} ` : '这个账号'}本人和所在组织能看到的 Project，点一下就加上。</span>
            <button className="primary" data-testid="guide-pick" onClick={() => onSettings('pick')}>
              从 GitHub 选…
            </button>
          </div>
          <div className="opt">
            <b>
              <Icon name="repo" />添加仓库或贴网址
            </b>
            <span>写「组织/仓库名」，或贴 Project 的网址（如 github.com/orgs/GigleAI/projects/11）。</span>
            <button data-testid="guide-add" onClick={() => onSettings('add')}>
              去设置添加
            </button>
          </div>
        </div>
        <div className="guide-hint">
          <Icon name="warn" size={14} />
          <span>组织的 Project 看不到？组织可能还没批准 Cavil Loop 访问，需要组织管理员批准一次。</span>
          <button className="link" data-testid="guide-auth-page" onClick={openAuthPage}>
            打开 GitHub 授权页
          </button>
        </div>
      </div>
    );
  return (
    <div className="guide" data-testid="empty-guide" data-kind="failed">
      <h3>已添加的来源都没读到</h3>
      <p>看板是空的，不是因为没有条目，而是下面的来源读取失败了：</p>
      {guide.failed.map((st) => (
        <div key={st.sourceKey} className="guide-fail" data-testid="guide-failed-source" data-key={st.sourceKey}>
          <b className="guide-source">{labelOf(st.sourceKey)}</b>
          <FailureNote failure={failureOf(st)} state={state} testid="guide-failure" />
        </div>
      ))}
      <div className="guide-foot">
        <button className="ghost" data-testid="guide-settings" onClick={() => onSettings()}>
          去设置查看详情
        </button>
        <span className="spacer" />
        <button className="link" data-testid="guide-pick-other" onClick={() => onSettings('pick')}>
          从 GitHub 选别的 Project
        </button>
      </div>
    </div>
  );
}
