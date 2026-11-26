// The assignee picker (GitHub#711): the label picker with the rows of shared/assignees.ts. The detail
// and the table cell both open this one, so they offer the same rows and send the same two writes —
// one account in or out per Enter / click, never the whole list.
import { useMemo } from 'react';
import type { RepoAssignees, WriteAction } from '../shared/actions';
import { assigneeRows } from '../shared/assignees';
import { t } from '../shared/i18n';
import type { Item } from '../shared/types';
import { LabelPicker } from './LabelPicker';
import { Verbatim, saidParts } from './Verbatim';

export function AssigneePicker({
  item,
  candidates,
  viewer,
  disabled,
  testid,
  act,
  onClose,
}: {
  /** the item as shown (changes on their way applied) */
  item: Item;
  /** null = still being read */
  candidates: RepoAssignees | null;
  viewer: string | null;
  disabled: boolean;
  testid: string;
  act: (action: WriteAction, done: string) => void;
  onClose: () => void;
}) {
  const rows = useMemo(() => assigneeRows(item.assignees, candidates?.logins ?? [], viewer), [item.assignees, candidates, viewer]);
  const hint = !candidates ? (
    <span data-testid="assignee-candidates" data-state="loading">
      {t('读取可指派的账号…')}
    </span>
  ) : candidates.error ? (
    <span className="err" data-testid="assignee-candidates" data-state="failed" title={candidates.error} {...saidParts(candidates.errorSaid, [item.repo])}>
      {candidates.error}
    </span>
  ) : (
    <Verbatim from="github">{item.repo}</Verbatim>
  );
  return (
    <LabelPicker
      title={t('设置负责人')}
      hint={hint}
      testid={testid}
      disabled={disabled}
      pinned={viewer ? [viewer] : []}
      items={rows}
      onToggle={(r) =>
        act(
          r.checked ? { kind: 'removeAssignee', key: item.key, login: r.name } : { kind: 'addAssignee', key: item.key, login: r.name },
          r.checked ? t('已去掉负责人「{login}」', { login: r.name }) : t('已把「{login}」设为负责人', { login: r.name }),
        )
      }
      onClose={onClose}
    />
  );
}
