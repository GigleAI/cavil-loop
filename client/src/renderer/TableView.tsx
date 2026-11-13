import { stateTone } from '../shared/stateTone';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { Item, ProjectMeta, TableColumn, ViewSettings } from '../shared/types';
import type { RepoOptions, WriteAction } from '../shared/actions';
import { COLUMN_MAX_WIDTH, COLUMN_MIN_WIDTH } from '../shared/viewSettings';
import { boardMode, buildTable, foldRuns, isOwnGroup, tableDropPlan, type Group, type Row, type Table } from '../data/table';
import type { DropPlan } from '../data/board';
import { issuePrLinks } from '../data/prNest';
import { api } from './api';
import { Person } from './Avatar';
import { OPENS_ITEM } from './outsideClick';
import { labelStyle, useDarkMode } from './colors';
import { Icon, itemIcon } from './Icons';
import { LabelPicker } from './LabelPicker';
import { resultNote, type ResultNote } from './DetailPanel';
import { IterationOptions } from './iterationOptions';
import type { TableFolds } from '../shared/uiPrefs';
import { useRepoDrag } from './repoDrag';
import { RepoWebLink } from './RepoWebLink';
import { t, tKey, zhKey } from '../shared/i18n';
import { Verbatim, verbatimParts } from './Verbatim';

/** a table column's heading, in the window's language */
export function columnLabel(c: TableColumn): string {
  return {
    title: t('标题'),
    assignees: t('负责人'),
    labels: t('标签'),
    linkedPrs: t('关联 PR'),
    subIssues: t('子 issue 进度'),
    updated: t('更新时间'),
    iteration: t('迭代'),
    status: t('状态'),
    milestone: t('里程碑'),
    repo: t('仓库'),
    author: t('作者'),
  }[c];
}

/** a group's title: the client's own name ("全部", the group without a value) in the window's language, GitHub's value as is */
function GroupTitle({ g }: { g: Group }) {
  return isOwnGroup(g) ? <>{tKey(g.title)}</> : <Verbatim from="github">{g.title}</Verbatim>;
}

function updatedText(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const mins = Math.max(0, Math.floor((now - at) / 60_000));
  if (mins < 60) return t('{n} 分钟前', { n: Math.max(1, mins) });
  const h = Math.floor(mins / 60);
  if (h < 24) return t('{n} 小时前', { n: h });
  const d = Math.floor(h / 24);
  if (d < 30) return t('{n} 天前', { n: d });
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

/** GitHub#368: the hover text of a pulled row — right for a sub-issue and for a sub-issue's sub-issue alike */
export const PULLED_TITLE = zhKey('此条目不符合搜索条件；因上层有命中的 issue 而显示');

function Cell({ col, item, all, now, dark }: { col: TableColumn; item: Item; all: Item[]; now: number; dark: boolean }) {
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
              <Verbatim from="github">{l.name}</Verbatim>
            </span>
          ))}
        </span>
      );
    case 'linkedPrs': {
      // GitHub's links, plus the PRs whose description names this issue (GitHub#275)
      const links = issuePrLinks(item, all);
      if (links === null) return <span className="muted small" title={t('仓库来源读不到关联 PR')}>—</span>;
      return (
        <>
          {links.map((p) => (
            <a
              key={p.key}
              href={p.url}
              className={`pr-link ${p.state}`}
              onClick={open(p.url)}
              data-testid="linked-pr"
              data-via={p.via}
              title={
                p.via === 'github'
                  ? p.state === 'open'
                    ? t('PR 开着（GitHub 关联）')
                    : p.state === 'closed'
                      ? t('PR 已关闭（GitHub 关联）')
                      : t('PR 已合并（GitHub 关联）')
                  : p.state === 'open'
                    ? t('PR 开着（PR 正文引用）')
                    : p.state === 'closed'
                      ? t('PR 已关闭（PR 正文引用）')
                      : t('PR 已合并（PR 正文引用）')
              }
            >
              <Icon name={itemIcon('pr', p.state, null)} size={14} />#{p.number}
            </a>
          ))}
        </>
      );
    }
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
      return <Verbatim from="github">{[...new Set(item.projects.filter((m) => m.iteration).map((m) => m.iteration!.title))].join(t('、'))}</Verbatim>;
    case 'status':
      return <Verbatim from="github">{[...new Set(item.projects.filter((m) => m.status).map((m) => m.status!))].join(t('、'))}</Verbatim>;
    case 'milestone':
      return <Verbatim from="github">{item.milestone?.title ?? ''}</Verbatim>;
    case 'repo':
      return <Verbatim from="github">{item.repo}</Verbatim>;
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
/**
 * What a row says after its title (GitHub#275): just "#N" under a heading of
 * its own repository; the full "owner/repo #N" otherwise — also for a PR of
 * another repository that followed its issue into this heading's section
 * (PR #278 review round 1: two "#7" from two repositories side by side).
 */
export function rowRef(item: Item, sectionRepo: string | null): string {
  return sectionRepo !== null && item.repo.toLowerCase() === sectionRepo.toLowerCase() ? `#${item.number}` : `${item.repo} #${item.number}`;
}

/** GitHub#275: a grouped row's title starts under its group's title (the guide line runs 10px left of it); inside a repository one step further in */
const ROW_BASE = 34;
const REPO_ROW_BASE = 52;
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
  /** labels the label picker keeps near the top (GitHub#496) */
  pinned?: readonly string[];
};

/** The open editor of one cell: a picker for labels, one dropdown per Project for iteration / status, a dropdown for the milestone. */
function CellEditor({ item, col, projects, options, disabled, today, act, close, pinned }: Editor) {
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
    if (!options) return <span className="small muted">{t('读取标签…')}</span>;
    if (options.error) return <span className="small err">{options.error}</span>;
    return (
      <span className="picker-anchor">
        <LabelPicker
          title={t('设置标签')}
          hint={item.repo}
          testid="cell-label-picker"
          pinned={pinned}
          disabled={disabled}
          items={[
            ...options.labels.map((l) => ({ name: l.name, color: l.color, checked: item.labels.some((x) => x.name === l.name) })),
            ...item.labels.filter((l) => !options.labels.some((x) => x.name === l.name)).map((l) => ({ name: l.name, color: l.color, checked: true })),
          ]}
          onToggle={(l) =>
            l.checked
              ? act({ kind: 'removeLabel', key: item.key, label: l.name }, t('已去掉标签「{label}」', { label: l.name }))
              : act({ kind: 'addLabel', key: item.key, label: l.name }, t('已加上标签「{label}」', { label: l.name }))
          }
          onClose={close}
        />
      </span>
    );
  }
  if (col === 'milestone') {
    if (!options) return <span className="small muted">{t('读取里程碑…')}</span>;
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
            act({ kind: 'setMilestone', key: item.key, title: e.target.value || null }, e.target.value ? t('里程碑改成「{title}」', { title: e.target.value }) : t('已去掉里程碑'));
            close();
          }}
        >
          <option value="">{t('（无）')}</option>
          {titles.map((x) => (
            <option key={x} value={x} data-verbatim="github">
              {x}
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
  if (!rows.length) return <span className="small muted">{item.projects.length ? t('看板没有这个字段') : t('不在看板上；加入看板请在详情里')}</span>;
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
            title={ro ? t('你在看板「{board}」上没有修改权限', { board: p.title }) : t('看板「{board}」', { board: p.title })}
            {...verbatimParts('github', [p.title])}
            value={field === 'iteration' ? (m.iteration?.id ?? '') : (m.status ?? '')}
            onChange={(e) => {
              const v = e.target.value || null;
              act(
                field === 'iteration'
                  ? { kind: 'setIteration', key: item.key, projectKey: p.key, iterationId: v }
                  : { kind: 'setStatus', key: item.key, projectKey: p.key, status: v },
                field === 'iteration' ? t('看板「{board}」的迭代已改', { board: p.title }) : t('看板「{board}」的状态已改', { board: p.title }),
              );
              close();
            }}
          >
            <option value="">{field === 'iteration' ? t('（无迭代）') : t('（无状态）')}</option>
            {field === 'iteration' ? (
              <IterationOptions iterations={p.iterations} chosen={m.iteration} today={today} label={(i) => (rows.length > 1 ? t('{board}：{value}', { board: p.title, value: i.title }) : i.title)} />
            ) : (
              p.statusOptions.map((o) => (
                <option key={o} value={o} data-verbatim="github">
                  {rows.length > 1 ? t('{board}：{value}', { board: p.title, value: o }) : o}
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
  onDropPlan,
  repoOrder = [],
  table: built,
  pinnedLabels,
  openKey = null,
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
  /** `about`: the write the note reports on (GitHub#323: a failed field change's note goes once that change is over) */
  onNote?: (note: ResultNote, about?: WriteAction) => void;
  onNewInGroup?: (g: Group) => void;
  canCreate?: boolean;
  createTitle?: string;
  /** folded groups, per "group by" — kept on this machine, so switching to the board and back, or a restart, keeps them (GitHub#231) */
  folds?: TableFolds;
  /** a row dropped on another group (GitHub#294): the board's drop rule decided, the board runs it (change / refuse / ask) */
  onDropPlan?: (plan: DropPlan) => void;
  /** the saved repository order (GitHub#304; kept on this machine); empty = alphabetical */
  repoOrder?: string[];
  /** the table as built by the board (GitHub#368: its counts feed the view bar too); left out = built here from `items` */
  table?: Table;
  /** labels the cell's label picker keeps near the top, right after what the item carries (GitHub#496) */
  pinnedLabels?: readonly string[];
  /** GitHub#522: the item the floating detail shows: its row is marked */
  openKey?: string | null;
}) {
  const dark = useDarkMode();
  const tb = view.table;
  const table = built ?? buildTable(items, projects, tb, today, view.prsUnderIssues, repoOrder);
  // GitHub#304: a repository in the slice list drags to another place; the order is the one every repository list uses
  const repoDrag = useRepoDrag(table.slices?.map((s) => s.value) ?? []);
  const cols = tb.columns.filter((c) => c !== 'title');
  const folded = new Set(folds[tb.groupBy] ?? []);
  const toggle = (k: string) => void Promise.resolve(api().setTableFold(tb.groupBy, k, !folded.has(k))).catch(() => undefined);

  // ---- dragging a row to another group (GitHub#294): the board's drag, rows for cards, groups for columns ----
  const canDrag = canWrite && Boolean(onDropPlan) && boardMode(tb.groupBy) !== null;
  const dragging = useRef<{ row: Row; from: Group } | null>(null);
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const endDrag = () => {
    dragging.current = null;
    setDragRow(null);
    setOver(null);
  };
  /** the handlers that make an element take a row dropped on group `g` */
  const dropTarget = (g: Group) =>
    canDrag && g.column
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!dragging.current) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (over !== g.key) setOver(g.key);
          },
          onDragLeave: (e: React.DragEvent) => {
            const to = e.relatedTarget as Node | null;
            if (!to || !(e.currentTarget as Node).contains(to)) setOver((k) => (k === g.key ? null : k));
          },
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const d = dragging.current;
            endDrag();
            if (!d || !canWrite) return;
            const plan = tableDropPlan(d.row, d.from, g, tb.groupBy, projects);
            if (plan.kind !== 'none') onDropPlan?.(plan);
          },
        }
      : {};

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
    // GitHub#488: a recorded field change is said by the cell and the window's notice area, not here
    const said = resultNote(r, t('{repo}#{number}：{what}', { repo: item.repo, number: item.number, what: okText }));
    if (said) onNote?.(said, a);
  };

  // ---- column widths (GitHub#205): dragged on the head's right edge, kept in the view settings; double-click = default ----
  const widths = tb.widths ?? {};
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
      {columnLabel(c)}
      <span
        className={`col-resize${live?.col === c ? ' on' : ''}`}
        data-testid="col-resize"
        data-col={c}
        title={t('拖动改列宽；双击恢复默认')}
        onPointerDown={startResize(c)}
        onDoubleClick={() => resetWidth(c)}
      />
    </th>
  );

  /** `repo`: the repository heading this group sits under ("all repositories"); null = no repository layer */
  const groupBody = (g: Group, repo: string | null) => {
    const inRepo = repo !== null;
    return (
    <tbody
      key={g.key}
      className={[inRepo ? 'in-repo' : '', tb.groupBy !== 'none' ? 'grouped' : '', over === g.key ? 'drop-over' : ''].filter(Boolean).join(' ') || undefined}
      data-testid="group"
      data-key={g.key}
      data-title={g.title}
      data-drop-over={over === g.key ? 'yes' : undefined}
      {...dropTarget(g)}
    >
      {tb.groupBy !== 'none' && (
        // GitHub#229: the whole row folds; the arrow stays a button (Tab reaches it) and its click is this same one
        <tr className="group-head" data-testid="group-head" onClick={() => toggle(g.key)} title={folded.has(g.key) ? t('点一下展开这一组') : t('点一下收起这一组')}>
          <td colSpan={cols.length + 1}>
            <button className="link" data-testid="group-toggle" aria-label={folded.has(g.key) ? t('展开这一组') : t('收起这一组')}>
              {folded.has(g.key) ? '▸' : '▾'}
            </button>{' '}
            <b>
              <GroupTitle g={g} />
            </b>{' '}
            <span className="count" data-testid="group-count">{g.rows.length}</span>
            {g.current && <span className="current" data-testid="group-current">{t('当前')}</span>}
            {g.subtitle && <span className="small muted"> {g.subtitle}</span>}
          </td>
        </tr>
      )}
      {!folded.has(g.key) &&
        g.rows.map((r) => (
          <tr
            key={r.id}
            data-testid="row"
            data-key={r.item.key}
            data-depth={r.depth}
            data-under={r.under ?? undefined}
            data-pulled={r.pulled ? '' : undefined}
            data-open-item={openKey !== null && r.item.key === openKey ? 'yes' : undefined}
            className={[dragRow === r.id ? 'dragging' : '', r.pulled ? 'pulled' : '', openKey !== null && r.item.key === openKey ? 'open-item' : ''].filter(Boolean).join(' ') || undefined}
            // GitHub#368: a row shown only because an issue above it matched the search
            title={r.pulled ? tKey(PULLED_TITLE) : undefined}
            // an open cell editor keeps its text box / dropdowns usable: that row does not drag; nor does a pulled row (it sits in its parent's group, not its own)
            draggable={canDrag && !r.pulled && editing?.row !== r.id}
            onDragStart={(e) => {
              if (!canDrag || r.pulled || editing?.row === r.id) return;
              e.dataTransfer.setData('text/plain', r.item.key);
              e.dataTransfer.effectAllowed = 'move';
              dragging.current = { row: r, from: g };
              setDragRow(r.id);
            }}
            onDragEnd={endDrag}
          >
            <td
              className="title-cell"
              data-testid="title-cell"
              style={{ paddingLeft: (tb.groupBy === 'none' ? 8 : inRepo ? REPO_ROW_BASE : ROW_BASE) + r.depth * 20 }}
              {...{ [OPENS_ITEM]: '' }}
              onClick={() => onOpen(r.item.key)}
            >
              {r.under && (
                <span className="nest-mark" title={t('关联到上面这个 issue 的 PR')}>
                  ↳{' '}
                </span>
              )}
              <span className={`state ${r.item.kind} ${toneOf(r.item)}`} data-testid="row-state" data-tone={toneOf(r.item)}>
                <Icon name={itemIcon(r.item.kind, r.item.state, r.item.stateReason)} title={
                    r.item.state === 'open'
                      ? r.item.kind === 'pr' ? t('PR 开着') : t('Issue 开着')
                      : r.item.state === 'closed'
                        ? r.item.kind === 'pr' ? t('PR 已关闭') : t('Issue 已关闭')
                        : r.item.kind === 'pr' ? t('PR 已合并') : t('Issue 已合并')
                  } />
              </span>
              <a
                href={r.item.url}
                data-testid="row-title"
                // the link only stops the jump to GitHub; the click goes on to the cell, which opens (GitHub#257)
                onClick={(e) => e.preventDefault()}
              >
                <Verbatim from="github">{r.item.title}</Verbatim>
              </a>{' '}
              {/* under a repository heading the repository is already said (GitHub#275) */}
              <span className="muted small" data-verbatim="github" data-testid="row-ref">
                {rowRef(r.item, repo)}
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
                  title={editable && !open ? t('点一下修改') : undefined}
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
                      pinned={pinnedLabels}
                    />
                  ) : (
                    <Cell col={c} item={r.item} all={items} now={now} dark={dark} />
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      {tb.groupBy !== 'none' && onNewInGroup && !folded.has(g.key) && (
        <tr className="group-add">
          <td colSpan={cols.length + 1}>
            <button className="link" data-testid="group-add" disabled={!canCreate} title={createTitle} onClick={() => onNewInGroup(g)}>
              {t('＋ 新建 issue')}
            </button>
          </td>
        </tr>
      )}
    </tbody>
  );
  };

  // GitHub#275: two or more folded groups next to each other are one line: each group's name opens just it,
  // "全部展开" opens them all; a click elsewhere on the line does nothing (no unfolding a whole stretch by accident)
  const foldedRun = (key: string, groups: Group[], inRepo: boolean) => (
    <tbody key={key} className={inRepo ? 'in-repo grouped' : 'grouped'} data-testid="fold-run" data-keys={groups.map((g) => g.key).join(' ')}>
      <tr className="group-head fold-run">
        <td colSpan={cols.length + 1}>
          <span className="fold-run-mark" aria-hidden="true">
            ▸
          </span>{' '}
          <span className="fold-run-title" data-testid="fold-run-title">
            {t('已收起 {n} 组 · 共 {rows} 条', { n: groups.length, rows: groups.reduce((n, g) => n + g.rows.length, 0) })}
          </span>
          {groups.map((g) => (
            <button
              key={g.key}
              className={`link fold-run-group${over === g.key ? ' drop-over' : ''}`}
              data-testid="fold-run-group"
              data-key={g.key}
              data-drop-over={over === g.key ? 'yes' : undefined}
              {...dropTarget(g)}
              title={t('展开「{group}」', { group: isOwnGroup(g) ? tKey(g.title) : g.title })}
              {...verbatimParts('github', [isOwnGroup(g) ? null : g.title])}
              onClick={() => toggle(g.key)}
            >
              <GroupTitle g={g} /> <span className="count">{g.rows.length}</span>
              {g.current && <span className="current">{t('当前')}</span>}
            </button>
          ))}
          <button className="link fold-run-all" data-testid="fold-run-expand" onClick={() => groups.forEach((g) => toggle(g.key))}>
            {t('全部展开')}
          </button>
        </td>
      </tr>
    </tbody>
  );
  const groupList = (groups: Group[], repo: string | null) =>
    tb.groupBy === 'none'
      ? groups.map((g) => groupBody(g, repo))
      : foldRuns(groups, folded).map((run) => (run.kind === 'group' ? groupBody(run.group, repo) : foldedRun(run.key, run.groups, repo !== null)));

  return (
    <div className="table-layout" data-testid="table">
      {table.slices && (
        <nav className="slices" data-testid="slices">
          <div className="small muted">{t('仓库')}</div>
          <button className={table.slice === null ? 'slice on' : 'slice'} data-testid="slice" data-value="" onClick={() => api().setView({ table: { slice: null } })}>
            {t('全部')} <span className="count">{items.length}</span>
          </button>
          {table.slices.map((s) => (
            // GitHub#398: the link to the repository's GitHub page sits next to the slice button, shown on hover / keyboard focus
            <div className="slice-row" key={s.value}>
            <button
              className={table.slice?.toLowerCase() === s.value.toLowerCase() ? 'slice on' : 'slice'}
              data-testid="slice"
              data-value={s.value}
              title={t('点一下只看这个仓库；拖动调整仓库顺序')}
              onClick={() => api().setView({ table: { slice: s.value } })}
              {...repoDrag.props(s.value)}
            >
              <span className="slice-name"><Verbatim from="github">{s.value}</Verbatim></span> <span className="count" data-testid="slice-count">{s.count}</span>
            </button>
            <RepoWebLink repo={s.value} />
            </div>
          ))}
          {repoOrder.length > 0 && (
            <button className="link small slice-reset" data-testid="repo-order-reset" title={t('不再用拖出来的顺序，仓库回到按名称排')} onClick={() => void Promise.resolve(api().resetRepoOrder()).catch(() => undefined)}>
              {t('按名称排序')}
            </button>
          )}
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
                    <tr className="repo-head" data-testid="repo-head" onClick={() => toggle(r.key)} title={folded.has(r.key) ? t('点一下展开这个仓库') : t('点一下收起这个仓库')}>
                      <td colSpan={cols.length + 1}>
                        <button className="link" data-testid="repo-toggle" aria-label={folded.has(r.key) ? t('展开这个仓库') : t('收起这个仓库')}>
                          {folded.has(r.key) ? '▸' : '▾'}
                        </button>{' '}
                        <Icon name="repo" size={16} /> <b><Verbatim from="github">{r.title}</Verbatim></b> <span className="count" data-testid="repo-count">{r.itemCount}</span>
                        <RepoWebLink repo={r.title} />
                      </td>
                    </tr>
                  </tbody>
                  {!folded.has(r.key) && groupList(r.groups, r.title)}
                </Fragment>
              ))
            : groupList(table.groups, null)}
        </table>
        {table.itemCount === 0 && <div className="center muted" data-testid="table-empty">{t('没有符合条件的条目')}</div>}
      </div>
    </div>
  );
}
