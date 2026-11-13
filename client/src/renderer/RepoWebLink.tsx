// "Open this repository on GitHub" (GitHub#398): one button for the board's swimlane heads, the
// table's repository sections and the table's repository list. It sits next to the control that
// folds / filters / drags the repository, never inside it, and a click on it does only this.

import { repoWebUrl } from '../shared/repoWeb';
import { api } from './api';
import { Icon } from './Icons';
import { t } from '../shared/i18n';
import { verbatimParts } from './Verbatim';

export const repoWebTitle = (): string => t('在 GitHub 打开这个仓库');

export function RepoWebLink({ repo, className }: { repo: string; className?: string }) {
  const url = repoWebUrl(repo);
  if (!url) return null;
  return (
    <button
      type="button"
      className={`icon-btn repo-web${className ? ` ${className}` : ''}`}
      data-testid="repo-web"
      data-repo={repo}
      aria-label={t('在 GitHub 打开这个仓库：{repo}', { repo })}
      {...verbatimParts('github', [repo])}
      title={repoWebTitle()}
      draggable={false}
      onClick={(e) => {
        e.stopPropagation();
        void Promise.resolve(api().openExternal(url)).catch(() => undefined);
      }}
    >
      <Icon name="ext" size={14} />
    </button>
  );
}
