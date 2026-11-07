import { stateTone } from '../shared/stateTone';
import { useState } from 'react';
import type { Item, ProjectMeta, TableColumn, ViewSettings } from '../shared/types';
import { buildTable, type Group } from '../data/table';
import { api } from './api';
import { Person } from './Avatar';
import { OPENS_ITEM } from './outsideClick';
import { labelStyle, useDarkMode } from './colors';
import { Icon, itemIcon } from './Icons';

export const COLUMN_LABEL: Record<TableColumn, string> = {
  title: '标题',
  assignees: '负责人',
  labels: '标签',
  linkedPrs: '关联 PR',
  subIssues: '子 issue 进度',
  updated: '更新时间',
  iteration: '迭代',
  status: '状态',
  milestone: '里程碑',
  repo: '仓库',
  author: '作者',
};

const STATE_TEXT = { open: '开着', closed: '已关闭', merged: '已合并' } as const;

function updatedText(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.floor((now - t) / 60_000));
  if (mins < 60) return `${Math.max(1, mins)} 分钟前`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return iso.slice(0, 10);
}

function open(url: string) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    api().openExternal(url);
  };
}

/** GitHub's state colour of a row */
function toneOf(it: Item) {
  return stateTone(it.kind, it.state, it.stateReason, it.isDraft ?? null);
}

function Cell({ col, item, now, dark }: { col: TableColumn; item: Item; now: number; dark: boolean }) {
  switch (col) {
    case 'assignees':
      return (
        <span className="people">
          {item.assignees.map((a) => (
            <Person key={a} login={a} />
          ))}
        </span>
      );
    case 'labels':
      return (
        <span className="labels">
          {item.labels.map((l) => (
            <span key={l.name} className="label" style={labelStyle(l.color, dark)}>
              {l.name}
            </span>
          ))}
        </span>
      );
    case 'linkedPrs':
      if (item.linkedPrs === null) return <span className="muted small" title="仓库来源读不到关联 PR">—</span>;
      return (
        <>
          {item.linkedPrs.map((p) => (
            <a key={p.key} href={p.url} className={`pr-link ${p.state}`} onClick={open(p.url)} data-testid="linked-pr">
              <Icon name={itemIcon('pr', p.state, null)} size={14} title={`PR ${STATE_TEXT[p.state]}`} />#{p.number}
            </a>
          ))}
        </>
      );
    case 'subIssues':
      if (!item.subIssues) return null;
      return (
        <span className="progress" data-testid="sub-progress" title={`${item.subIssues.completed} / ${item.subIssues.total}`}>
          <span className="bar">
            <span style={{ width: `${Math.round((item.subIssues.completed / item.subIssues.total) * 100)}%` }} />
          </span>
          {item.subIssues.completed}/{item.subIssues.total}
        </span>
      );
    case 'updated':
      return <span title={item.updatedAt}>{updatedText(item.updatedAt, now)}</span>;
    case 'iteration':
      return <>{[...new Set(item.projects.filter((m) => m.iteration).map((m) => m.iteration!.title))].join('、')}</>;
    case 'status':
      return <>{[...new Set(item.projects.filter((m) => m.status).map((m) => m.status!))].join('、')}</>;
    case 'milestone':
      return <>{item.milestone?.title ?? ''}</>;
    case 'repo':
      return <>{item.repo}</>;
    case 'author':
      return <Person login={item.author} />;
    case 'title':
      return null;
  }
}

/**
 * `onOpen`: a row's title opens the item's detail panel, the same as clicking a card on the board.
 * `onNewInGroup`: a group's "+" (GitHub#214); `canCreate` false greys it (offline, no sources).
 */
export function TableView({
  items,
  projects,
  view,
  today,
  now,
  onOpen,
  onNewInGroup,
  canCreate = false,
  createTitle = '',
}: {
  items: Item[];
  projects: ProjectMeta[];
  view: ViewSettings;
  today: string;
  now: number;
  onOpen: (key: string) => void;
  onNewInGroup?: (g: Group) => void;
  canCreate?: boolean;
  createTitle?: string;
}) {
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const dark = useDarkMode();
  const t = view.table;
  const table = buildTable(items, projects, t, today, view.prsUnderIssues);
  const cols = t.columns.filter((c) => c !== 'title');
  const toggle = (k: string) => {
    const next = new Set(folded);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setFolded(next);
  };

  return (
    <div className="table-layout" data-testid="table">
      {table.slices && (
        <nav className="slices" data-testid="slices">
          <div className="small muted">仓库</div>
          <button className={table.slice === null ? 'slice on' : 'slice'} data-testid="slice" data-value="" onClick={() => api().setView({ table: { slice: null } })}>
            全部 <span className="count">{items.length}</span>
          </button>
          {table.slices.map((s) => (
            <button
              key={s.value}
              className={table.slice?.toLowerCase() === s.value.toLowerCase() ? 'slice on' : 'slice'}
              data-testid="slice"
              data-value={s.value}
              onClick={() => api().setView({ table: { slice: s.value } })}
            >
              {s.value} <span className="count" data-testid="slice-count">{s.count}</span>
            </button>
          ))}
        </nav>
      )}
      <div className="table-scroll">
        <table className="items">
          <thead>
            <tr>
              <th>{COLUMN_LABEL.title}</th>
              {cols.map((c) => (
                <th key={c}>{COLUMN_LABEL[c]}</th>
              ))}
            </tr>
          </thead>
          {table.groups.map((g) => (
            <tbody key={g.key} data-testid="group" data-key={g.key} data-title={g.title}>
              {t.groupBy !== 'none' && (
                <tr className="group-head">
                  <td colSpan={cols.length + 1}>
                    <button className="link" data-testid="group-toggle" aria-label={folded.has(g.key) ? '展开这一组' : '收起这一组'} onClick={() => toggle(g.key)}>
                      {folded.has(g.key) ? '▸' : '▾'}
                    </button>{' '}
                    <b>{g.title}</b> <span className="count" data-testid="group-count">{g.rows.length}</span>
                    {g.current && <span className="current" data-testid="group-current">当前</span>}
                    {g.subtitle && <span className="small muted"> {g.subtitle}</span>}
                  </td>
                </tr>
              )}
              {!folded.has(g.key) &&
                g.rows.map((r) => (
                  <tr key={r.id} data-testid="row" data-key={r.item.key} data-depth={r.depth} data-under={r.under ?? undefined}>
                    <td className="title-cell" style={{ paddingLeft: 8 + r.depth * 20 }}>
                      {r.under && (
                        <span className="nest-mark" title="关联到上面这个 issue 的 PR">
                          ↳{' '}
                        </span>
                      )}
                      <span className={`state ${r.item.kind} ${toneOf(r.item)}`} data-testid="row-state" data-tone={toneOf(r.item)}>
                        <Icon name={itemIcon(r.item.kind, r.item.state, r.item.stateReason)} title={`${r.item.kind === 'pr' ? 'PR' : 'Issue'} ${STATE_TEXT[r.item.state]}`} />
                      </span>
                      <a
                        href={r.item.url}
                        data-testid="row-title"
                        {...{ [OPENS_ITEM]: '' }}
                        onClick={(e) => {
                          e.preventDefault();
                          onOpen(r.item.key);
                        }}
                      >
                        {r.item.title}
                      </a>{' '}
                      <span className="muted small">
                        {r.item.repo} #{r.item.number}
                      </span>
                    </td>
                    {cols.map((c) => (
                      <td key={c} className={`col-${c}`}>
                        <Cell col={c} item={r.item} now={now} dark={dark} />
                      </td>
                    ))}
                  </tr>
                ))}
              {t.groupBy !== 'none' && onNewInGroup && !folded.has(g.key) && (
                <tr className="group-add">
                  <td colSpan={cols.length + 1}>
                    <button className="link" data-testid="group-add" disabled={!canCreate} title={createTitle} onClick={() => onNewInGroup(g)}>
                      ＋ 新建 issue
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          ))}
        </table>
        {table.itemCount === 0 && <div className="center muted" data-testid="table-empty">没有符合条件的条目</div>}
      </div>
    </div>
  );
}
