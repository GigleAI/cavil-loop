import { stateTone } from '../shared/stateTone';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { Item, ProjectMeta, TableColumn, ViewSettings } from '../shared/types';
import type { RepoOptions, WriteAction } from '../shared/actions';
import { COLUMN_MAX_WIDTH, COLUMN_MIN_WIDTH } from '../shared/viewSettings';
import { buildTable, type Group } from '../data/table';
import { api } from './api';
import { Person } from './Avatar';
import { OPENS_ITEM } from './outsideClick';
import { labelStyle, useDarkMode } from './colors';
import { Icon, itemIcon } from './Icons';
import { LabelPicker } from './LabelPicker';
import { noteOf, type ResultNote } from './DetailPanel';
import { IterationOptions } from './iterationOptions';
import type { TableFolds } from '../shared/uiPrefs';

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
            <span key={l.name} className={`label${item.edits?.some((m) => m.label === l.name && ['saving', 'verifying', 'observing'].includes(m.status)) ? ' pending' : ''}`} style={labelStyle(l.color, dark)}>
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

/** GitHub#205: the columns a table cell can change, the same changes the detail panel makes. */
export const EDITABLE_COLUMNS: readonly TableColumn[] = ['labels', 'iteration', 'status', 'milestone'];

/** A column's width when none was dragged (fixed layout only, once any column has been dragged). */
const DEFAULT_WIDTH: Partial<Record<TableColumn, number>> = { title: 360, labels: 200, assignees: 120, linkedPrs: 120, author: 120 };
const widthOf = (c: TableColumn, widths: Partial<Record<TableColumn, number>>) => widths[c] ?? DEFAULT_WIDTH[c] ?? 140;

type Editor = {
  item: Item;
  col: TableColumn;
  projects: ProjectMeta[];
  options: RepoOptions | null;
  disabled: boolean;
  /** YYYY-MM-DD: which iteration is current (GitHub#231) */
  today: string;
  act: (a: WriteAction, okText: string) => void;
  close: () => void;
};

/** The open editor of one cell: a picker for labels, one dropdown per Project for iteration / status, a dropdown for the milestone. */
function CellEditor({ item, col, projects, options, disabled, today, act, close }: Editor) {
  const box = useRef<HTMLSpanElement>(null);
  // a click outside the editor puts it away (the label picker has its own)
  useEffect(() => {
    if (col === 'labels') return;
    const out = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', out);
    return () => document.removeEventListener('mousedown', out);
  }, [col, close]);
  if (col === 'labels') {
    if (!options) return <span className="small muted">读取标签…</span>;
    if (options.error) return <span className="small err">{options.error}</span>;
    return (
      <span className="picker-anchor">
        <LabelPicker
          title="设置标签"
          hint={item.repo}
          testid="cell-label-picker"
          disabled={disabled}
          items={[
            ...options.labels.map((l) => ({ name: l.name, color: l.color, checked: item.labels.some((x) => x.name === l.name) })),
            ...item.labels.filter((l) => !options.labels.some((x) => x.name === l.name)).map((l) => ({ name: l.name, color: l.color, checked: true })),
          ]}
          onToggle={(l) =>
            l.checked
              ? act({ kind: 'removeLabel', key: item.key, label: l.name }, `已去掉标签「${l.name}」`)
              : act({ kind: 'addLabel', key: item.key, label: l.name }, `已加上标签「${l.name}」`)
          }
          onClose={close}
        />
      </span>
    );
  }
  if (col === 'milestone') {
    if (!options) return <span className="small muted">读取里程碑…</span>;
    if (options.error) return <span className="small err">{options.error}</span>;
    const titles = [...new Set(options.milestones.map((m) => m.title))];
    if (item.milestone && !titles.includes(item.milestone.title)) titles.unshift(item.milestone.title);
    return (
      <span ref={box}>
        <select
          className="cell-select"
          data-testid="cell-milestone"
          autoFocus
          disabled={disabled}
          value={item.milestone?.title ?? ''}
          onChange={(e) => {
            act({ kind: 'setMilestone', key: item.key, title: e.target.value || null }, e.target.value ? `里程碑改成「${e.target.value}」` : '已去掉里程碑');
            close();
          }}
        >
          <option value="">（无）</option>
          {titles.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </span>
    );
  }
  // iteration / status: one dropdown per Project the item is on (the values belong to the Project)
  const field = col as 'iteration' | 'status';
  const rows = item.projects
    .map((m) => ({ m, p: projects.find((x) => x.key === m.projectKey) }))
    .filter((x): x is { m: Item['projects'][number]; p: ProjectMeta } => Boolean(x.p && (field === 'iteration' ? x.p.hasIterationField : x.p.statusFieldId)));
  if (!rows.length) return <span className="small muted">{item.projects.length ? '看板没有这个字段' : '不在看板上；加入看板请在详情里'}</span>;
  return (
    <span ref={box} className="cell-selects">
      {rows.map(({ m, p }) => {
        const ro = !p.viewerCanUpdate;
        return (
          <select
            key={p.key}
            className="cell-select"
            data-testid={`cell-${field}`}
            data-project={p.key}
            disabled={disabled || ro}
            title={ro ? `你在看板「${p.title}」上没有修改权限` : `看板「${p.title}」`}
            value={field === 'iteration' ? (m.iteration?.id ?? '') : (m.status ?? '')}
            onChange={(e) => {
              const v = e.target.value || null;
              act(
                field === 'iteration'
                  ? { kind: 'setIteration', key: item.key, projectKey: p.key, iterationId: v }
                  : { kind: 'setStatus', key: item.key, projectKey: p.key, status: v },
                `看板「${p.title}」的${field === 'iteration' ? '迭代' : '状态'}已改`,
              );
              close();
            }}
          >
            <option value="">{field === 'iteration' ? '（无迭代）' : '（无状态）'}</option>
            {field === 'iteration' ? (
              <IterationOptions iterations={p.iterations} chosen={m.iteration} today={today} label={(i) => `${rows.length > 1 ? `${p.title}：` : ''}${i.title}`} />
            ) : (
              p.statusOptions.map((o) => (
                <option key={o} value={o}>
                  {rows.length > 1 ? `${p.title}：` : ''}
                  {o}
                </option>
              ))
            )}
          </select>
        );
      })}
    </span>
  );
}

/**
 * `onOpen`: a click anywhere in a row's title cell opens the item's detail panel, the same as clicking a card on the board (GitHub#257).
 * `onNewInGroup`: a group's "+" (GitHub#214); `canCreate` false greys it (offline, no sources).
 */
export function TableView({
  items,
  projects,
  view,
  today,
  now,
  canWrite = false,
  onOpen,
  onNote,
  onNewInGroup,
  canCreate = false,
  createTitle = '',
  folds = {},
}: {
  items: Item[];
  projects: ProjectMeta[];
  view: ViewSettings;
  today: string;
  now: number;
  /** online and signed in: cells can be changed (GitHub#205) */
  canWrite?: boolean;
  onOpen: (key: string) => void;
  /** the result of a change made from a cell (shown on top of the board) */
  onNote?: (note: ResultNote) => void;
  onNewInGroup?: (g: Group) => void;
  canCreate?: boolean;
  createTitle?: string;
  /** folded groups, per "group by" — kept on this machine, so switching to the board and back, or a restart, keeps them (GitHub#231) */
  folds?: TableFolds;
}) {
  const dark = useDarkMode();
  const t = view.table;
  const table = buildTable(items, projects, t, today, view.prsUnderIssues);
  const cols = t.columns.filter((c) => c !== 'title');
  const folded = new Set(folds[t.groupBy] ?? []);
  const toggle = (k: string) => void Promise.resolve(api().setTableFold(t.groupBy, k, !folded.has(k))).catch(() => undefined);

  // ---- editing a cell (GitHub#205) ----
  // which cell is open: the table row (item + group: an item can show in two groups, PR #220 review round 1) and column
  const [editing, setEditing] = useState<{ row: string; col: TableColumn } | null>(null);
  const [options, setOptions] = useState<Record<string, RepoOptions>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const asked = useRef(new Set<string>());
  const needOptions = (repo: string) => {
    if (asked.current.has(repo)) return;
    asked.current.add(repo);
    void api()
      .repoOptions(repo)
      .then((o) => {
        setOptions((m) => ({ ...m, [repo]: o }));
        // a failed read is asked again next time the cell is opened
        if (o.error) asked.current.delete(repo);
      });
  };
  const startEdit = (row: string, item: Item, col: TableColumn) => {
    if (!canWrite || !EDITABLE_COLUMNS.includes(col)) return;
    if (col === 'labels' || col === 'milestone') needOptions(item.repo);
    setEditing({ row, col });
  };
  const act = (item: Item) => async (a: WriteAction, okText: string) => {
    setBusy((b) => new Set(b).add(item.key));
    const r = await api().act(a);
    setBusy((b) => {
      const n = new Set(b);
      n.delete(item.key);
      return n;
    });
    onNote?.(noteOf(r, `${item.repo}#${item.number}：${okText}`));
  };

  // ---- column widths (GitHub#205): dragged on the head's right edge, kept in the view settings; double-click = default ----
  const widths = t.widths ?? {};
  const [live, setLive] = useState<{ col: TableColumn; w: number } | null>(null);
  const shown = live ? { ...widths, [live.col]: live.w } : widths;
  const sized = Object.keys(shown).length > 0;
  const startResize = (col: TableColumn) => (e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement!;
    const x0 = e.clientX;
    const w0 = th.getBoundingClientRect().width;
    let w = Math.round(w0);
    const clamp = (v: number) => Math.min(COLUMN_MAX_WIDTH, Math.max(COLUMN_MIN_WIDTH, Math.round(v)));
    const move = (ev: PointerEvent) => {
      w = clamp(w0 + ev.clientX - x0);
      setLive({ col, w });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setLive(null);
      if (w !== Math.round(w0) || widths[col] === undefined) void api().setView({ table: { widths: { ...widths, [col]: w } } });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const resetWidth = (col: TableColumn) => {
    const next = { ...widths };
    delete next[col];
    void api().setView({ table: { widths: next } });
  };
  const head = (c: TableColumn) => (
    <th key={c} data-testid="col-head" data-col={c} data-width={sized ? widthOf(c, shown) : undefined}>
      {COLUMN_LABEL[c]}
      <span
        className={`col-resize${live?.col === c ? ' on' : ''}`}
        data-testid="col-resize"
        data-col={c}
        title="拖动改列宽；双击恢复默认"
        onPointerDown={startResize(c)}
        onDoubleClick={() => resetWidth(c)}
      />
    </th>
  );

  const groupBody = (g: Group, inRepo: boolean) => (
    <tbody key={g.key} className={inRepo ? 'in-repo' : undefined} data-testid="group" data-key={g.key} data-title={g.title}>
      {t.groupBy !== 'none' && (
        // GitHub#229: the whole row folds; the arrow stays a button (Tab reaches it) and its click is this same one
        <tr className="group-head" data-testid="group-head" onClick={() => toggle(g.key)} title={folded.has(g.key) ? '点一下展开这一组' : '点一下收起这一组'}>
          <td colSpan={cols.length + 1}>
            <button className="link" data-testid="group-toggle" aria-label={folded.has(g.key) ? '展开这一组' : '收起这一组'}>
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
            <td
              className="title-cell"
              data-testid="title-cell"
              style={{ paddingLeft: 8 + r.depth * 20 }}
              {...{ [OPENS_ITEM]: '' }}
              onClick={() => onOpen(r.item.key)}
            >
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
                // the link only stops the jump to GitHub; the click goes on to the cell, which opens (GitHub#257)
                onClick={(e) => e.preventDefault()}
              >
                {r.item.title}
              </a>{' '}
              <span className="muted small">
                {r.item.repo} #{r.item.number}
              </span>
            </td>
            {cols.map((c) => {
              const editable = canWrite && EDITABLE_COLUMNS.includes(c);
              const open = editing?.row === r.id && editing.col === c;
              return (
                <td
                  key={c}
                  className={`col-${c}${editable ? ' editable' : ''}`}
                  data-testid="cell"
                  data-col={c}
                  data-editing={open ? 'yes' : undefined}
                  title={editable && !open ? '点一下修改' : undefined}
                  onClick={editable && !open ? () => startEdit(r.id, r.item, c) : undefined}
                >
                  {open ? (
                    <CellEditor
                      item={r.item}
                      col={c}
                      projects={projects}
                      options={options[r.item.repo] ?? null}
                      disabled={!canWrite || busy.has(r.item.key)}
                      today={today}
                      act={(a, ok) => void act(r.item)(a, ok)}
                      close={() => setEditing(null)}
                    />
                  ) : (
                    <Cell col={c} item={r.item} now={now} dark={dark} />
                  )}
                </td>
              );
            })}
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
  );

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
        <table className={`items${sized ? ' sized' : ''}`} style={sized ? { width: ['title' as TableColumn, ...cols].reduce((n, c) => n + widthOf(c, shown), 0) } : undefined}>
          {sized && (
            <colgroup>
              {(['title', ...cols] as TableColumn[]).map((c) => (
                <col key={c} style={{ width: widthOf(c, shown) }} />
              ))}
            </colgroup>
          )}
          <thead>
            <tr>
              {head('title')}
              {cols.map(head)}
            </tr>
          </thead>
          {table.repos
            ? table.repos.map((r) => (
                <Fragment key={r.key}>
                  <tbody data-testid="repo-group" data-key={r.key} data-title={r.title}>
                    <tr className="repo-head" data-testid="repo-head" onClick={() => toggle(r.key)} title={folded.has(r.key) ? '点一下展开这个仓库' : '点一下收起这个仓库'}>
                      <td colSpan={cols.length + 1}>
                        <button className="link" data-testid="repo-toggle" aria-label={folded.has(r.key) ? '展开这个仓库' : '收起这个仓库'}>
                          {folded.has(r.key) ? '▸' : '▾'}
                        </button>{' '}
                        <b>{r.title}</b> <span className="count" data-testid="repo-count">{r.itemCount}</span>
                      </td>
                    </tr>
                  </tbody>
                  {!folded.has(r.key) && r.groups.map((g) => groupBody(g, true))}
                </Fragment>
              ))
            : table.groups.map((g) => groupBody(g, false))}
        </table>
        {table.itemCount === 0 && <div className="center muted" data-testid="table-empty">没有符合条件的条目</div>}
      </div>
    </div>
  );
}
