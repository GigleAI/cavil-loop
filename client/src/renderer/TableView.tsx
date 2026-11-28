import { stateTone } from '../shared/stateTone';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GroupBy, Item, ProjectMeta, TableColumn, ViewSettings } from '../shared/types';
import type { RepoAssignees, RepoOptions, WriteAction } from '../shared/actions';
import { COLUMN_MAX_WIDTH, COLUMN_MIN_WIDTH } from '../shared/viewSettings';
import { boardMode, buildTable, columnSlot, foldRuns, foldTally, isOwnGroup, moveColumn, tableDropPlan, type Group, type Row, type Table } from '../data/table';
import type { DropPlan } from '../data/board';
import { issuePrLinks } from '../data/prNest';
import { DONE_DAYS_CHOICES, DONE_DAYS_MAX, DONE_DAYS_MIN, SLICE_DONE, SLICE_INBOX, validDoneDays, type SpecialSlice } from '../data/inbox';
import { api } from './api';
import { Person } from './Avatar';
import { CELL_EDITOR, MOVE_SLOP, OPENS_ITEM } from './outsideClick';
import { useLayer, useShortcuts } from './keyboard';
import { labelStyle, useDarkMode } from './colors';
import { Icon, itemIcon } from './Icons';
import { LabelPicker } from './LabelPicker';
import { AssigneePicker } from './AssigneePicker';
import { sameLogin } from '../shared/assignees';
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
export const PULLED_TITLE = zhKey('此条目不符合筛选条件；因上层有命中的 issue 而显示');
/** GitHub#622: the hover text of an issue shown only because a matched PR goes under it */
export const CARRIED_TITLE = zhKey('此 issue 不符合筛选条件；因下面有命中的 PR 而显示');

/** a faded row's hover text: one line per reason it is shown (GitHub#622: a row can have both) */
export function fadedTitle(r: { pulled: boolean; carried: boolean }): string | undefined {
  const lines = [...(r.pulled ? [tKey(PULLED_TITLE)] : []), ...(r.carried ? [tKey(CARRIED_TITLE)] : [])];
  return lines.length ? lines.join('\n') : undefined;
}

function Cell({ col, item, all, now, dark }: { col: TableColumn; item: Item; all: Item[]; now: number; dark: boolean }) {
  switch (col) {
    case 'assignees':
      return (
        <span className="people">
          {item.assignees.map((a) => (
            <span key={a} className={item.edits?.some((m) => m.field === 'assignee' && m.login !== undefined && sameLogin(m.login, a) && ['saving', 'verifying', 'observing'].includes(m.status)) ? 'pending' : undefined} data-testid="cell-assignee" data-login={a}>
              <Person login={a} />
            </span>
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
export const EDITABLE_COLUMNS: readonly TableColumn[] = ['labels', 'assignees', 'iteration', 'status', 'milestone'];

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

/** GitHub#752: what the left column's 「收件箱」 / 「最近完成」 and the line above their list say */
export interface TableLists {
  inbox: number;
  done: number;
  /** closed issues in 「最近完成」's range whose close reason is not known yet (left out of it) */
  unknown: number;
  days: number;
  /** the signed-in account is known (unknown: both lists are empty, and the line says why) */
  viewerKnown: boolean;
  /** why GitHub's notifications are not in 「收件箱」 now; null = they are */
  inboxNote: string | null;
}

/** GitHub#752: a 「收件箱」 row that is there because of a GitHub notification: its reason, in a few words */
function whyText(why: string): string {
  switch (why) {
    case 'mention':
      return t('@ 了我');
    case 'team_mention':
      return t('@ 了我的团队');
    case 'review_requested':
      return t('请我 review');
    case 'assign':
      return t('指派给我');
    case 'author':
      return t('我开的 · 有新动态');
    default:
      return t('有新回复');
  }
}

/** GitHub#752: the line above a flat list — what it holds, in what order, what it leaves out; 「最近完成」's days are picked here */
function ListLine({ kind, lists, count }: { kind: SpecialSlice; lists: TableLists; count: number }) {
  const [custom, setCustom] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const choices = DONE_DAYS_CHOICES.includes(lists.days) ? DONE_DAYS_CHOICES : [...DONE_DAYS_CHOICES, lists.days].sort((a, b) => a - b);
  const apply = () => {
    const n = Number((custom ?? '').trim());
    if (!validDoneDays(n)) {
      setBad(true);
      return;
    }
    void Promise.resolve(api().setDoneDays(n)).catch(() => undefined);
    setCustom(null);
    setBad(false);
  };
  return (
    <div className="list-line small muted" data-testid="list-line" data-kind={kind}>
      {!lists.viewerKnown ? (
        <span data-testid="list-no-viewer">{t('还没读到登录账号，暂时列不出和我有关的条目')}</span>
      ) : kind === 'inbox' ? (
        <>
          <span>{t('收件箱 · 和我有关、要处理的 {n} 条，按更新时间从新到旧', { n: count })}</span>
          {lists.inboxNote && (
            <span className="list-note" data-testid="inbox-note">
              {' · '}
              {t('GitHub 通知没有列入：{why}', { why: lists.inboxNote })}
            </span>
          )}
        </>
      ) : (
        <>
          <span>{t('最近完成 · 和我有关、最近')}</span>{' '}
          <select
            data-testid="done-days"
            aria-label={t('最近几天')}
            value={custom !== null ? 'custom' : String(lists.days)}
            onChange={(e) => {
              if (e.target.value === 'custom') {
                setCustom(String(lists.days));
                setBad(false);
              } else void Promise.resolve(api().setDoneDays(Number(e.target.value))).catch(() => undefined);
            }}
          >
            {choices.map((d) => (
              <option key={d} value={String(d)}>
                {t('{n} 天', { n: d })}
              </option>
            ))}
            <option value="custom">{t('自定义…')}</option>
          </select>
          {custom !== null && (
            <>
              {' '}
              <input
                data-testid="done-days-custom"
                className="days-input"
                inputMode="numeric"
                value={custom}
                autoFocus
                onChange={(e) => {
                  setCustom(e.target.value);
                  setBad(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') apply();
                  if (e.key === 'Escape') setCustom(null);
                }}
              />{' '}
              <button className="link" data-testid="done-days-apply" onClick={apply}>
                {t('确定')}
              </button>
              {bad && (
                <span className="list-bad" data-testid="done-days-bad">
                  {' '}
                  {t('请填 {min}–{max} 之间的整数', { min: DONE_DAYS_MIN, max: DONE_DAYS_MAX })}
                </span>
              )}
            </>
          )}{' '}
          <span>{t('内更新、已完成的 {n} 条，按更新时间从新到旧', { n: count })}</span>
          {lists.unknown > 0 && (
            <span className="list-note" data-testid="done-unknown" title={t('后续同步确认原因后更新')}>
              {' · '}
              {t('另有 {n} 条已关闭的 issue 还没确认关闭原因，未列出', { n: lists.unknown })}
            </span>
          )}
        </>
      )}
    </div>
  );
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
  /** GitHub#711: the assignee picker's candidates (null = still being read) and the signed-in account */
  assignees: RepoAssignees | null;
  viewer: string | null;
  disabled: boolean;
  /** YYYY-MM-DD: which iteration is current (GitHub#231) */
  today: string;
  act: (a: WriteAction, okText: string) => void;
  close: () => void;
  /** labels the label picker keeps near the top (GitHub#496) */
  pinned?: readonly string[];
};

/** The open editor of one cell: a picker for labels / assignees, a list in the page for the milestone, one per Project for iteration / status (GitHub#747). */
function CellEditor({ item, col, projects, options, assignees, viewer, disabled, today, act, close, pinned }: Editor) {
  // a press outside the editor puts it away and does nothing else: one rule for every cell editor, in TableView (GitHub#747)
  if (col === 'assignees') {
    return (
      <span className="picker-anchor">
        <AssigneePicker item={item} candidates={assignees} viewer={viewer} testid="cell-assignee-picker" disabled={disabled} act={act} onClose={close} />
      </span>
    );
  }
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
    const now = item.milestone?.title ?? '';
    return (
      <CellLists
        close={close}
        lists={[
          {
            key: 'milestone',
            testid: 'cell-milestone',
            disabled,
            value: now,
            commit: (v) => {
              if (v !== now) act({ kind: 'setMilestone', key: item.key, title: v || null }, v ? t('里程碑改成「{title}」', { title: v }) : t('已去掉里程碑'));
              close();
            },
            options: (
              <>
                <option value="">{t('（无）')}</option>
                {titles.map((x) => (
                  <option key={x} value={x} data-verbatim="github">
                    {x}
                  </option>
                ))}
              </>
            ),
          },
        ]}
      />
    );
  }
  // iteration / status: one list per Project the item is on (the values belong to the Project)
  const field = col as 'iteration' | 'status';
  const rows = item.projects
    .map((m) => ({ m, p: projects.find((x) => x.key === m.projectKey) }))
    .filter((x): x is { m: Item['projects'][number]; p: ProjectMeta } => Boolean(x.p && (field === 'iteration' ? x.p.hasIterationField : x.p.statusFieldId)));
  if (!rows.length) return <span className="small muted">{item.projects.length ? t('看板没有这个字段') : t('不在看板上；加入看板请在详情里')}</span>;
  return (
    <CellLists
      close={close}
      lists={rows.map(({ m, p }) => {
        const ro = !p.viewerCanUpdate;
        const now = field === 'iteration' ? (m.iteration?.id ?? '') : (m.status ?? '');
        return {
          key: p.key,
          testid: `cell-${field}`,
          project: p.key,
          disabled: disabled || ro,
          title: ro ? t('你在看板「{board}」上没有修改权限', { board: p.title }) : t('看板「{board}」', { board: p.title }),
          boardTitle: p.title,
          value: now,
          commit: (v: string) => {
            if (v !== now)
              act(
                field === 'iteration'
                  ? { kind: 'setIteration', key: item.key, projectKey: p.key, iterationId: v || null }
                  : { kind: 'setStatus', key: item.key, projectKey: p.key, status: v || null },
                field === 'iteration' ? t('看板「{board}」的迭代已改', { board: p.title }) : t('看板「{board}」的状态已改', { board: p.title }),
              );
            close();
          },
          options: (
            <>
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
            </>
          ),
        };
      })}
    />
  );
}

/** One list of a cell editor (GitHub#747): a milestone, or one Project's iteration / status. */
type CellList = {
  key: string;
  testid: string;
  /** the Project the list belongs to (iteration / status) */
  project?: string;
  /** the Project's name, GitHub's text (the hover text names it) */
  boardTitle?: string;
  title?: string;
  disabled: boolean;
  /** the item's value now */
  value: string;
  options: React.ReactNode;
  /** a value picked: written when it differs from `value`, and the editor put away */
  commit: (v: string) => void;
};

/** the part of an open cell editor that floats out of the cell: the label / assignee picker, the lists */
const EDITOR_POPS = '.picker, .cell-lists';

/** keys a list box would act on by itself (type-ahead, paging): each would be a write, so they do nothing here */
const LIST_KEYS_KEPT = new Set(['PageUp', 'PageDown', 'Home', 'End']);

/**
 * GitHub#747: the milestone / iteration / status editor of a table cell. The same dropdown with its
 * options as before, shown as a list in the page (`size` > 1) instead of the system's pop-up menu:
 * a system menu is not part of the page, so the table cannot keep a click outside it from reaching
 * what lies under it, and it ignores the row's fading rules. A click on an option (or a value set
 * directly) writes it; ↑↓ only move the mark — a list box changes its value with every arrow, and
 * each change would be a write — and Enter writes the marked one; Esc puts it away.
 */
function CellLists({ lists, close }: { lists: CellList[]; close: () => void }) {
  useLayer('picker');
  const refs = useRef<(HTMLSelectElement | null)[]>([]);
  const [marked, setMarked] = useState<Record<string, string>>({});
  const valueOf = (l: CellList) => marked[l.key] ?? l.value;
  // one pick per open list, however it came (a change, a click on the marked option, Enter): never written twice
  const picked = useRef(false);
  const pick = (l: CellList, v: string) => {
    if (picked.current || l.disabled) return;
    picked.current = true;
    l.commit(v);
  };
  useLayoutEffect(() => {
    // as many rows as it has (options and section headings), up to 10, never 1 (that is the pop-up menu again)
    for (const sel of refs.current) if (sel) sel.size = Math.max(2, Math.min(10, sel.options.length + sel.querySelectorAll('optgroup').length));
  }, [lists.length]);
  useEffect(() => {
    refs.current.find((x) => x && !x.disabled)?.focus();
  }, []);
  const focused = () => Math.max(0, refs.current.findIndex((x) => x !== null && x === document.activeElement));
  const move = (step: number) => {
    const i = focused();
    const sel = refs.current[i];
    const l = lists[i];
    if (!sel || !l || sel.disabled) return;
    const values = [...sel.options].filter((o) => !o.disabled).map((o) => o.value);
    if (!values.length) return;
    const at = values.indexOf(valueOf(l));
    const next = values[Math.max(0, Math.min(values.length - 1, at < 0 ? 0 : at + step))];
    setMarked((m) => ({ ...m, [l.key]: next }));
    sel.querySelector<HTMLOptionElement>(`option[value="${CSS.escape(next)}"]`)?.scrollIntoView?.({ block: 'nearest' });
  };
  useShortcuts({
    pickerUp: () => move(-1),
    pickerDown: () => move(1),
    pickerToggle: () => {
      const l = lists[focused()];
      if (l) pick(l, valueOf(l));
    },
    pickerClose: close,
  });
  return (
    <span className="picker-anchor">
      <span className="cell-lists" data-testid="cell-lists">
        {lists.map((l, i) => (
          <select
            key={l.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            size={10}
            className="cell-select"
            data-testid={l.testid}
            data-project={l.project}
            disabled={l.disabled}
            title={l.title}
            {...(l.boardTitle !== undefined ? verbatimParts('github', [l.boardTitle]) : {})}
            value={valueOf(l)}
            onChange={(e) => pick(l, e.target.value)}
            onKeyDown={(e) => {
              if ((e.key.length === 1 && !e.metaKey && !e.ctrlKey) || LIST_KEYS_KEPT.has(e.key)) e.preventDefault();
            }}
            onMouseDown={(e) => {
              // only the main button picks: another (right / middle) must not move the selection, which would be a change
              if (e.button !== 0) e.preventDefault();
            }}
            onMouseUp={(e) => {
              if (e.button !== 0) return;
              // a click on an option picks it, also the one already marked (no change event then): the marked one
              // after ↑↓ is written, the item's own value just puts the list away (commit writes only a different value)
              const o = e.target as HTMLElement;
              if (o.tagName === 'OPTION' && !(o as HTMLOptionElement).disabled) pick(l, (o as HTMLOptionElement).value);
            }}
          >
            {l.options}
          </select>
        ))}
      </span>
    </span>
  );
}

/** GitHub#587: what a repository line's "+" hands the new-issue dialog: a group of that repository with no rows */
function blankGroup(repo: string): Group {
  return { key: `repo:${repo.toLowerCase()}`, title: repo, subtitle: null, current: false, empty: false, preset: { by: 'repo', repo }, column: null, section: null, rows: [] };
}

/**
 * A folded run's line (GitHub#275): its groups and their rows. A group of a repository never read
 * (GitHub#587) has an unknown count: never added in as 0 — the line says how many such groups there are.
 */
function foldedSummary(groups: Group[]): string {
  const { rows, unknown } = foldTally(groups);
  return unknown === 0
    ? t('已收起 {n} 组 · 共 {rows} 条', { n: groups.length, rows })
    : t('已收起 {n} 组 · 已知 {rows} 条，另有 {unknown} 组还没读到', { n: groups.length, rows, unknown });
}

/** GitHub#587: the table draws at least one repository line (then "no matching items" is not said again) */
function hasBlank(table: Table): boolean {
  return Boolean(table.blankRepo) || (table.repos ?? []).some((r) => r.groups.length === 0) || table.groups.some((g) => g.rows.length === 0 && g.preset.by === 'repo');
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
  viewer = null,
  lists = null,
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
  /** GitHub#569: the label picker's pinned names for an item of this repository */
  pinnedLabels?: (repo: string) => readonly string[];
  /** GitHub#522: the item the floating detail shows: its row is marked */
  openKey?: string | null;
  /** GitHub#711: the signed-in account (the assignee picker marks it and keeps it near the top) */
  viewer?: string | null;
  /** GitHub#752: 「收件箱」 / 「最近完成」 at the top of the left column (their counts and the line above their list); null = not shown */
  lists?: TableLists | null;
}) {
  const dark = useDarkMode();
  const tb = view.table;
  const table = built ?? buildTable(items, projects, tb, today, view.prsUnderIssues, repoOrder);
  // GitHub#304: a repository in the slice list drags to another place; the order is the one every repository list uses
  const repoDrag = useRepoDrag(table.slices?.map((s) => s.value) ?? []);
  // GitHub#752: one of the flat lists is shown — no groups, and the repository is always a column (items of every repository mix)
  const flat = table.flat ?? null;
  const grouping: GroupBy = flat ? 'none' : tb.groupBy;
  const saved = tb.columns.filter((c) => c !== 'title');
  const cols: TableColumn[] = flat && !saved.includes('repo') ? [...saved, 'repo'] : saved;
  const folded = new Set(folds[tb.groupBy] ?? []);
  const toggle = (k: string) => void Promise.resolve(api().setTableFold(tb.groupBy, k, !folded.has(k))).catch(() => undefined);

  // ---- dragging a row to another group (GitHub#294): the board's drag, rows for cards, groups for columns ----
  const canDrag = !flat && canWrite && Boolean(onDropPlan) && boardMode(tb.groupBy) !== null;
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
  // GitHub#747: a press outside an open cell editor only puts it away. Listening from the window's capture phase,
  // before anything under the pointer reacts, this press and what follows from it (button up, click, a drag, the
  // context menu) are kept from the page; the next press is an ordinary one. Installed once: putting the editor
  // away removes it from the page in the middle of that very click, and the rest of the click must still be kept.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useEffect(() => {
    let swallowing = false;
    let until = 0;
    const keep = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const down = (e: Event) => {
      const cellBox = editingRef.current ? document.querySelector(`[${CELL_EDITOR}]`) : null;
      if (!cellBox) return;
      // inside = the picker / lists that float out of the cell; the cell itself only while nothing floats yet
      // ("读取标签…", an error, "不在看板上"): blank space of the cell around a picker or list is outside
      const box = cellBox.querySelector(`${EDITOR_POPS}`) ?? cellBox;
      if (e.target instanceof Node && box.contains(e.target)) return;
      swallowing = true;
      until = 0;
      keep(e);
      setEditing(null);
    };
    const follow = (e: Event) => {
      if (!swallowing) return;
      keep(e);
      // the button went up: the click (and a double-click's second one) still to come belongs to this press
      if (e.type === 'pointerup' || e.type === 'pointercancel') until = window.setTimeout(() => (swallowing = false), 0);
    };
    const kinds = ['mousedown', 'pointerup', 'pointercancel', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'dragstart'];
    window.addEventListener('pointerdown', down, true);
    for (const k of kinds) window.addEventListener(k, follow, true);
    return () => {
      window.clearTimeout(until);
      window.removeEventListener('pointerdown', down, true);
      for (const k of kinds) window.removeEventListener(k, follow, true);
    };
  }, []);
  // GitHub#747: an editor that would stick out past the table's right edge opens leftwards, from the cell's right edge
  const [flip, setFlip] = useState(false);
  // GitHub#711: the assignee candidates per repository, asked the first time a cell of that repository opens
  const [assignees, setAssignees] = useState<Record<string, RepoAssignees>>({});
  const askedAssignees = useRef(new Set<string>());
  const needAssignees = (repo: string) => {
    if (askedAssignees.current.has(repo)) return;
    askedAssignees.current.add(repo);
    void api()
      .repoAssignees(repo)
      .then((o) => {
        setAssignees((m) => ({ ...m, [repo]: o }));
        // a failed read is asked again next time the cell is opened
        if (o.error) askedAssignees.current.delete(repo);
      });
  };
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
    if (col === 'assignees') needAssignees(item.repo);
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

  useLayoutEffect(() => {
    if (!editing) return setFlip(false);
    const pop = document.querySelector(`[${CELL_EDITOR}]`)?.querySelector<HTMLElement>(EDITOR_POPS);
    const scroller = pop?.closest('.table-scroll');
    if (!pop || !scroller) return;
    if (!flip && pop.getBoundingClientRect().right > scroller.getBoundingClientRect().right) setFlip(true);
  });

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
  // ---- moving a column by its heading (GitHub#747): pressed and moved past MOVE_SLOP, the heading follows the
  // pointer, a line shows where it goes; let go = saved in the view settings. The title column stays first.
  /** ends a column drag still going without saving (the table going away) */
  const colDragEnd = useRef<(() => void) | null>(null);
  useEffect(() => () => colDragEnd.current?.(), []);
  const [colDrag, setColDrag] = useState<{ col: TableColumn; x: number; top: number; slot: number; line: number | null; bottom: number } | null>(null);
  const startMove = (col: TableColumn) => (e: React.PointerEvent<HTMLTableCellElement>) => {
    if (col === 'title' || e.button !== 0) return;
    const table = (e.currentTarget as HTMLElement).closest('table');
    if (!table) return;
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const top = (e.currentTarget as HTMLElement).getBoundingClientRect().top;
    let on = false;
    let slot = -1;
    /** where the dragged heading goes, read from the headings as drawn now */
    const place = (x: number) => {
      const heads = [...table.querySelectorAll<HTMLElement>('thead [data-testid="col-head"]')].filter((h) => h.dataset.col !== 'title');
      const rects = heads.map((h) => h.getBoundingClientRect());
      slot = columnSlot(rects.map((r) => r.left + r.width / 2), x);
      const scroller = table.closest('.table-scroll')?.getBoundingClientRect();
      const line = slot < rects.length ? rects[slot].left : (rects[rects.length - 1]?.right ?? null);
      const bottom = Math.min(table.getBoundingClientRect().bottom, scroller?.bottom ?? Infinity);
      setColDrag({ col, x, top, slot, line, bottom });
    };
    const move = (ev: PointerEvent) => {
      if (!on && Math.abs(ev.clientX - x0) <= MOVE_SLOP && Math.abs(ev.clientY - y0) <= MOVE_SLOP) return;
      on = true;
      place(ev.clientX);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', esc, true);
      if (colDragEnd.current === cancel) colDragEnd.current = null;
      setColDrag(null);
    };
    // the system took the pointer away, the window lost focus, or the table goes: the drag ends, nothing is saved
    const cancel = () => {
      on = false;
      stop();
    };
    const up = () => {
      stop();
      if (!on) return;
      const next = moveColumn(tb.columns, col, slot);
      if (next) void api().setView({ table: { columns: next } });
    };
    const esc = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      cancel();
    };
    colDragEnd.current?.();
    colDragEnd.current = cancel;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', esc, true);
  };
  const head = (c: TableColumn) => (
    <th
      key={c}
      data-testid="col-head"
      data-col={c}
      data-width={sized ? widthOf(c, shown) : undefined}
      className={[c !== 'title' ? 'col-movable' : '', colDrag?.col === c ? 'col-moving' : ''].filter(Boolean).join(' ') || undefined}
      title={c !== 'title' ? t('拖动换列的位置') : undefined}
      onPointerDown={startMove(c)}
    >
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

  /**
   * GitHub#587: the line a repository source with nothing to show gets — in its section, its group
   * (grouped by repository) or the table of the one picked repository — whatever the grouping, with
   * its own "+" (the group's "+" row is not drawn without a grouping). Never read: said, no "+".
   */
  const blankLine = (repo: string, unread: boolean, named: boolean, pad: number) => (
    <tr className="repo-blank" data-testid="repo-blank" data-repo={repo} data-unread={unread ? 'yes' : undefined}>
      <td colSpan={cols.length + 1} style={{ paddingLeft: pad }}>
        {named && (
          <>
            <b>
              <Verbatim from="github">{repo}</Verbatim>
            </b>
            {' · '}
          </>
        )}
        <span className="muted" data-testid="repo-blank-text">
          {unread
            ? named
              ? t('还没读到，读到之后才知道有没有条目')
              : t('这个仓库还没读到，读到之后才知道有没有条目')
            : named
              ? t('没有要显示的 issue / PR')
              : t('这个仓库没有要显示的 issue / PR')}
        </span>
        {!unread && onNewInGroup && (
          <>
            {' '}
            <button className="link" data-testid="repo-blank-add" disabled={!canCreate} title={createTitle} onClick={() => onNewInGroup(blankGroup(repo))}>
              {t('＋ 新建 issue')}
            </button>
          </>
        )}
      </td>
    </tr>
  );
  /** the count a repository / its group shows: "—" when its source was never read (GitHub#587) */
  const countOf = (n: number, unread: boolean | undefined) => (unread ? <span title={t('还没读到，条目数未知')}>—</span> : n);

  /** `repo`: the repository heading this group sits under ("all repositories"); null = no repository layer */
  const groupBody = (g: Group, repo: string | null) => {
    const inRepo = repo !== null;
    return (
    <tbody
      key={g.key}
      className={[inRepo ? 'in-repo' : '', grouping !== 'none' ? 'grouped' : '', over === g.key ? 'drop-over' : ''].filter(Boolean).join(' ') || undefined}
      data-testid="group"
      data-key={g.key}
      data-title={g.title}
      data-drop-over={over === g.key ? 'yes' : undefined}
      {...dropTarget(g)}
    >
      {grouping !== 'none' && (
        // GitHub#229: the whole row folds; the arrow stays a button (Tab reaches it) and its click is this same one
        <tr className="group-head" data-testid="group-head" onClick={() => toggle(g.key)} title={folded.has(g.key) ? t('点一下展开这一组') : t('点一下收起这一组')}>
          <td colSpan={cols.length + 1}>
            <button className="link" data-testid="group-toggle" aria-label={folded.has(g.key) ? t('展开这一组') : t('收起这一组')}>
              {folded.has(g.key) ? '▸' : '▾'}
            </button>{' '}
            <b>
              <GroupTitle g={g} />
            </b>{' '}
            <span className="count" data-testid="group-count">{countOf(g.rows.length, g.unread)}</span>
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
            data-carried={r.carried ? '' : undefined}
            data-open-item={openKey !== null && r.item.key === openKey ? 'yes' : undefined}
            className={[dragRow === r.id ? 'dragging' : '', r.pulled || r.carried ? 'pulled' : '', openKey !== null && r.item.key === openKey ? 'open-item' : ''].filter(Boolean).join(' ') || undefined}
            // GitHub#368: a row shown only because an issue above it matched the search; GitHub#622: or because a PR below it did
            title={fadedTitle(r)}
            // an open cell editor keeps its text box / dropdowns usable: that row does not drag; nor does a pulled row
            // (it sits in its parent's group, not its own), nor a carried one (it did not match the search)
            draggable={canDrag && !r.pulled && !r.carried && editing?.row !== r.id}
            onDragStart={(e) => {
              if (!canDrag || r.pulled || r.carried || editing?.row === r.id) return;
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
              style={{ paddingLeft: (grouping === 'none' ? 8 : inRepo ? REPO_ROW_BASE : ROW_BASE) + r.depth * 20 }}
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
              {r.carried && (
                <span className="carried-tag" data-testid="carried-tag">
                  {t('随 PR 显示')}
                </span>
              )}
              {r.why && (
                // GitHub#752: in 「收件箱」 because of a GitHub notification, not the pending label
                <span className="carried-tag inbox-why" data-testid="inbox-why" data-why={r.why} title={t('GitHub 通知里还没读的动态')}>
                  {whyText(r.why)}
                </span>
              )}
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
                  {...(open ? { [CELL_EDITOR]: '', 'data-flip': flip ? 'yes' : undefined } : {})}
                  title={editable && !open ? t('点一下修改') : undefined}
                  onClick={editable && !open ? () => startEdit(r.id, r.item, c) : undefined}
                >
                  {open ? (
                    <CellEditor
                      item={r.item}
                      col={c}
                      projects={projects}
                      options={options[r.item.repo] ?? null}
                      assignees={assignees[r.item.repo] ?? null}
                      viewer={viewer}
                      disabled={!canWrite || busy.has(r.item.key)}
                      today={today}
                      act={(a, ok) => void act(r.item)(a, ok)}
                      close={() => setEditing(null)}
                      pinned={pinnedLabels?.(r.item.repo)}
                    />
                  ) : (
                    <Cell col={c} item={r.item} all={items} now={now} dark={dark} />
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      {!folded.has(g.key) && g.rows.length === 0 && g.preset.by === 'repo' && blankLine(g.preset.repo, Boolean(g.unread), false, inRepo ? REPO_ROW_BASE : ROW_BASE)}
      {grouping !== 'none' && onNewInGroup && !folded.has(g.key) && g.rows.length > 0 && (
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
            {foldedSummary(groups)}
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
              <GroupTitle g={g} /> <span className="count" data-testid="fold-run-count">{countOf(g.rows.length, g.unread)}</span>
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
    grouping === 'none'
      ? groups.map((g) => groupBody(g, repo))
      : foldRuns(groups, folded).map((run) => (run.kind === 'group' ? groupBody(run.group, repo) : foldedRun(run.key, run.groups, repo !== null)));

  return (
    <div className="table-layout" data-testid="table">
      {(table.slices || lists) && (
        <nav className="slices" data-testid="slices">
          {lists && (
            <>
              <button className={flat === 'inbox' ? 'slice on' : 'slice'} data-testid="slice-inbox" title={t('等人处理的条目，和 GitHub 通知里还没读的、和我有关的条目；只列「只看我的」范围内的')} onClick={() => api().setView({ table: { slice: SLICE_INBOX } })}>
                <span className="slice-name">{t('收件箱')}</span> <span className={lists.inbox > 0 ? 'count hot' : 'count'} data-testid="slice-inbox-count">{lists.inbox}</span>
              </button>
              <button className={flat === 'done' ? 'slice on' : 'slice'} data-testid="slice-done" title={t('最近 {n} 天内更新、已完成的条目；只列「只看我的」范围内的', { n: lists.days })} onClick={() => api().setView({ table: { slice: SLICE_DONE } })}>
                <span className="slice-name">{t('最近完成')}</span> <span className="count" data-testid="slice-done-count">{lists.done}</span>
              </button>
              {table.slices && <hr className="slices-sep" />}
            </>
          )}
          {table.slices && (
          <>
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
              <span className="slice-name"><Verbatim from="github">{s.value}</Verbatim></span> <span className="count" data-testid="slice-count">{countOf(s.count, s.unread)}</span>
            </button>
            <RepoWebLink repo={s.value} />
            </div>
          ))}
          {repoOrder.length > 0 && (
            <button className="link small slice-reset" data-testid="repo-order-reset" title={t('不再用拖出来的顺序，仓库回到按名称排')} onClick={() => void Promise.resolve(api().resetRepoOrder()).catch(() => undefined)}>
              {t('按名称排序')}
            </button>
          )}
          </>
          )}
        </nav>
      )}
      <div className="table-scroll">
        {flat && lists && <ListLine kind={flat} lists={lists} count={table.itemCount} />}
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
                        <Icon name="repo" size={16} /> <b><Verbatim from="github">{r.title}</Verbatim></b> <span className="count" data-testid="repo-count">{countOf(r.itemCount, r.unread)}</span>
                        <RepoWebLink repo={r.title} />
                      </td>
                    </tr>
                  </tbody>
                  {!folded.has(r.key) &&
                    (r.groups.length === 0 ? (
                      <tbody className="in-repo" data-testid="repo-blank-body" data-key={r.key}>
                        {blankLine(r.title, Boolean(r.unread), false, 32)}
                      </tbody>
                    ) : (
                      groupList(r.groups, r.title)
                    ))}
                </Fragment>
              ))
            : groupList(table.groups, null)}
          {table.blankRepo && <tbody data-testid="repo-blank-body">{blankLine(table.blankRepo.repo, Boolean(table.blankRepo.unread), true, 12)}</tbody>}
        </table>
        {colDrag && colDrag.line !== null && (
          <>
            <div className="col-drop-line" data-testid="col-drop-line" style={{ left: colDrag.line - 1, top: colDrag.top, height: Math.max(0, colDrag.bottom - colDrag.top) }} />
            <div className="col-drag-ghost" data-testid="col-drag-ghost" style={{ left: colDrag.x + 12, top: colDrag.top + 4 }}>
              {columnLabel(colDrag.col)}
            </div>
          </>
        )}
        {table.itemCount === 0 && !hasBlank(table) && (
          <div className="center muted" data-testid="table-empty">
            {flat === 'inbox' ? t('收件箱里没有条目') : flat === 'done' ? t('这段时间没有完成的条目') : t('没有符合条件的条目')}
          </div>
        )}
      </div>
    </div>
  );
}
