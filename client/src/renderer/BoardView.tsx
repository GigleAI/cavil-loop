import { stateTone } from '../shared/stateTone';
import { badgeText } from './KindBadge';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppState, BoardData, ColumnMode, Layout } from '../shared/types';
import type { RepoOptions, WriteAction } from '../shared/actions';
import { sourceLabel } from '../shared/sources';
import { buildBoard, dropPlan, writesEnabled, type Card, type Column, type DropPlan } from '../data/board';
import { api } from './api';
import { labelStyle, useDarkMode } from './colors';
import { Icon, itemIcon } from './Icons';
import brandIcon from '../../build/icon.png';
import { ConfirmDialog } from './ConfirmDialog';
import { DetailPanel, noteOf, ResultBanner, type ResultNote } from './DetailPanel';
import { NewIssueDialog } from './NewIssueDialog';
import { applyFilter, type ParsedFilter } from '../shared/filter';
import { isFiltering, type WarnKind } from './warnings';
import { TableView } from './TableView';
import { ViewSettingsPanel } from './ViewSettingsPanel';
import { Avatar } from './Avatar';

function useNow(ms = 15_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function ago(from: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - from) / 60_000));
  if (mins < 1) return '不到 1 分钟前';
  if (mins < 60) return `${mins} 分钟前`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

function localToday(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const MODE_LABEL: Record<ColumnMode, string> = { iteration: '迭代', status: '状态', milestone: '里程碑' };

interface CardOps {
  canWrite: boolean;
  open: (key: string) => void;
  act: (action: WriteAction, okText: string) => Promise<void>;
  /** repository labels, loaded on demand */
  labelsOf: (repo: string) => Promise<RepoOptions>;
  dragStart: (card: Card, from: string) => void;
  /** the "本列来自 …" line: only when two or more Projects are picked (only then can it be either) */
  showProjects: boolean;
  dark: boolean;
}

function CardView({ card, mode, col, ops }: { card: Card; mode: ColumnMode; col: string; ops: CardOps }) {
  const it = card.item;
  // GitHub's state colour and the badge's state text (draft / close reason included)
  const tone = stateTone(it.kind, it.state, it.stateReason, it.isDraft ?? null);
  const iterations = it.projects.filter((m) => m.iteration).map((m) => m.iteration!.title);
  const [adding, setAdding] = useState<RepoOptions | null>(null);
  return (
    <div
      className={`card${card.under ? ' nested' : ''}`}
      data-testid="card"
      data-key={it.key}
      data-under={card.under ?? undefined}
      draggable={ops.canWrite}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', it.key);
        e.dataTransfer.effectAllowed = 'move';
        ops.dragStart(card, col);
      }}
      onClick={() => ops.open(it.key)}
    >
      <div className="card-head">
        <span className={`kind ${it.kind} ${tone}`} data-testid="card-state" data-tone={tone}>
          {card.under && (
            <span className="nest-mark" title="关联到上面这个 issue 的 PR">
              ↳{' '}
            </span>
          )}
          <Icon name={itemIcon(it.kind, it.state, it.stateReason)} size={14} />
          {it.kind === 'pr' ? 'PR' : 'Issue'} · {badgeText(it.kind, it.state, it.stateReason, it.isDraft ?? null)}
        </span>
        <span className="ref card-repo">
          {it.repo} #{it.number}
        </span>
        <span className="spacer" />
        <span className="card-author" data-testid="card-author" title={`作者 ${it.author ?? "（已删除的账号）"}`}>
          <Avatar login={it.author} size={20} />
        </span>
      </div>
      <a
        className="card-title"
        href={it.url}
        data-testid="card-title"
        onClick={(e) => {
          e.preventDefault();
          ops.open(it.key);
        }}
      >
        {it.title}
      </a>
      <div className="labels" onClick={(e) => e.stopPropagation()}>
        {it.labels.map((l) => (
          <span key={l.name} className="label" style={labelStyle(l.color, ops.dark)}>
            {l.name}
            {ops.canWrite && (
              <button
                className="label-x"
                data-testid="card-label-remove"
                data-label={l.name}
                title={`去掉「${l.name}」`}
                onClick={() => void ops.act({ kind: 'removeLabel', key: it.key, label: l.name }, `${it.repo}#${it.number}：已去掉标签「${l.name}」`)}
              >
                ×
              </button>
            )}
          </span>
        ))}
        {ops.canWrite &&
          (adding ? (
            <select
              data-testid="card-label-add-select"
              autoFocus
              value=""
              onBlur={() => setAdding(null)}
              onChange={(e) => {
                const v = e.target.value;
                setAdding(null);
                if (v) void ops.act({ kind: 'addLabel', key: it.key, label: v }, `${it.repo}#${it.number}：已加上标签「${v}」`);
              }}
            >
              <option value="">{adding.error ?? '选一个标签'}</option>
              {adding.labels
                .filter((l) => !it.labels.some((x) => x.name === l.name))
                .map((l) => (
                  <option key={l.name} value={l.name}>
                    {l.name}
                  </option>
                ))}
            </select>
          ) : (
            <button className="label-plus" data-testid="card-label-add" title="加标签" onClick={async () => setAdding(await ops.labelsOf(it.repo))}>
              +
            </button>
          ))}
      </div>
      <div className="meta">
        {iterations.length > 0 && (
          <span title="迭代">
            <Icon name="iteration" size={14} />
            {[...new Set(iterations)].join('、')}
          </span>
        )}
        {it.milestone && (
          <span title="里程碑">
            <Icon name="milestone" size={14} />
            {it.milestone.title}
          </span>
        )}
        {it.assignees.length > 0 && (
          <span className="people" data-testid="card-assignees" title={`负责人 ${it.assignees.join('、')}`}>
            {it.assignees.map((a) => (
              <span key={a} className="person">
                <Avatar login={a} size={18} />
                {a}
              </span>
            ))}
          </span>
        )}
        {ops.showProjects && it.projects.length > 0 && (
          <span data-testid="card-projects">
            {mode !== 'milestone' && card.projectTitles.length ? '本列来自 ' + card.projectTitles.join('、') : '在 ' + it.projects.map((p) => p.projectTitle).join('、')}
          </span>
        )}
      </div>
    </div>
  );
}

function ColumnView({ col, cards, mode, ops, onDrop }: { col: Column; cards: Card[]; mode: ColumnMode; ops: CardOps; onDrop: (col: Column) => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`column${over ? ' drop-over' : ''}`}
      data-testid="column"
      data-key={col.key}
      data-title={col.title}
      onDragOver={(e) => {
        if (!ops.canWrite) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDrop(col);
      }}
    >
      <div className="column-head">
        <b>{col.title}</b> <span className="count" data-testid="column-count">{cards.length}</span>
        {col.subtitle && <div className="small muted sub">{col.subtitle}</div>}
      </div>
      <div className="column-body">
        {cards.map((c) => (
          <CardView key={c.id} card={c} mode={mode} col={col.key} ops={ops} />
        ))}
        {cards.length === 0 && <div className="empty-note">没有条目{ops.canWrite ? ' · 可把卡片拖到这里' : ''}</div>}
      </div>
    </div>
  );
}

/** The yellow bars' "×" (GitHub#153): the window decides what is shown, the board only asks. */
export interface BoardWarnings {
  shown: (kind: WarnKind) => boolean;
  close: (kind: WarnKind) => void;
}

/** A yellow bar with a "×" that closes only this bar. */
function WarnBar({ kind, warn, children }: { kind: WarnKind; warn: BoardWarnings; children: ReactNode }) {
  if (!warn.shown(kind)) return null;
  return (
    <div className="banner warn closable" data-testid={kind}>
      <Icon name="warn" />
      <span className="banner-text">{children}</span>
      <button className="banner-close" aria-label="关闭提示" title="关闭提示" data-testid={`${kind}-close`} onClick={() => warn.close(kind)}>
        <Icon name="x" />
      </button>
    </div>
  );
}

export function BoardView({
  state,
  data,
  query,
  setQuery,
  parsed,
  warn,
  focus = null,
  onFocusTaken,
  onSettings,
}: {
  state: AppState;
  data: BoardData;
  query: string;
  setQuery: (q: string) => void;
  parsed: ParsedFilter;
  warn: BoardWarnings;
  /** a clicked notification's item, to open once (GitHub#169) */
  focus?: { key: string; seq: number } | null;
  onFocusTaken?: () => void;
  onSettings: () => void;
}) {
  const now = useNow();
  const [showEnded, setShowEnded] = useState(false);
  const [panel, setPanel] = useState(false);
  const { view, sync } = state;
  const today = localToday(now);
  const items = useMemo(
    () => applyFilter(data.items, parsed, { viewer: state.viewer, today, projects: data.projects }),
    [data, parsed, state.viewer, today],
  );
  const board = useMemo(
    () => buildBoard(items, data.projects, view.mode, view.swimlanes, today, view.table.sort, view.prsUnderIssues),
    [items, data.projects, view.mode, view.swimlanes, today, view.table.sort, view.prsUnderIssues],
  );
  const selected = new Set(view.selected ?? state.sources.map((s) => s.key));
  const titles = new Map(data.projects.map((p) => [p.key, p.title]));
  const failed = sync.sources.filter((s) => !s.ok);
  const canWrite = writesEnabled(sync) && state.sources.length > 0;
  // every opening of the detail panel is its own panel instance (its React key):
  // going to another item and back is a new opening, never the old one resumed
  const [opened, setOpened] = useState<{ key: string; n: number } | null>(null);
  const openSeq = useRef(0);
  const openItem = (key: string) => setOpened((cur) => (cur?.key === key ? cur : { key, n: ++openSeq.current }));
  // a clicked notification (GitHub#169): every click opens that item, as a new opening
  useEffect(() => {
    if (!focus) return;
    setOpened({ key: focus.key, n: ++openSeq.current });
    onFocusTaken?.();
  }, [focus?.seq]);
  const [newIssue, setNewIssue] = useState(false);
  const [note, setNote] = useState<ResultNote | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Extract<DropPlan, { kind: 'confirm' }> | null>(null);
  const [choice, setChoice] = useState(0);
  const dragging = useRef<{ card: Card; from: string } | null>(null);
  const labelCache = useRef(new Map<string, Promise<RepoOptions>>());
  const dark = useDarkMode();
  const pickedProjects = state.sources.filter((s) => s.kind === 'project' && selected.has(s.key)).length;

  /** run actions one after another; stop at the first refusal (the rest are not sent) */
  const runAll = async (actions: WriteAction[], okText: string) => {
    setBusy(true);
    let warn: string[] = [];
    for (const a of actions) {
      const r = await api().act(a);
      if (!r.ok) {
        setBusy(false);
        const done = actions.indexOf(a);
        setNote({ kind: 'error', text: `${done ? `前 ${done} 项已改好；` : ''}${r.error}` });
        return;
      }
      if (r.warning) warn.push(r.warning);
    }
    setBusy(false);
    setNote(noteOf({ ok: true, error: null, warning: warn.join('；') || null }, okText));
  };
  const ops: CardOps = {
    canWrite: canWrite && !busy,
    open: openItem,
    act: (a, okText) => runAll([a], okText),
    labelsOf: (repo) => {
      let p = labelCache.current.get(repo);
      if (!p) {
        p = api().repoOptions(repo);
        labelCache.current.set(repo, p);
        p.then((r) => r.error && labelCache.current.delete(repo));
      }
      return p;
    },
    dragStart: (card, from) => (dragging.current = { card, from }),
    showProjects: pickedProjects >= 2,
    dark,
  };
  const onDrop = (col: Column) => {
    const d = dragging.current;
    dragging.current = null;
    if (!d || !canWrite) return;
    const plan = dropPlan(d.card, d.from, col, board.mode, data.projects);
    if (plan.kind === 'refuse') setNote({ kind: 'error', text: `没有修改：${plan.reason}` });
    else if (plan.kind === 'do') void runAll(plan.actions, plan.summary);
    else if (plan.kind === 'confirm') {
      setChoice(0);
      setConfirm(plan);
    }
  };
  const filtering = isFiltering(parsed);
  const hasText = parsed.clauses.some((c) => c.kind === 'text');

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    api().setView({ selected: state.sources.map((s) => s.key).filter((k) => next.has(k)) });
  };

  const ended = board.columns.filter((c) => c.ended);
  const shown = board.columns.filter((c) => !c.ended);
  const renderRow = (lane: string | null) => {
    const pick = (c: Column) => (lane ? c.cards.filter((x) => x.lane === lane) : c.cards);
    return (
      <div className="columns">
        {ended.length > 0 &&
          (showEnded ? (
            ended.map((c) => <ColumnView key={c.key} col={c} cards={pick(c)} mode={board.mode} ops={ops} onDrop={onDrop} />)
          ) : (
            <button className="column ended-group" data-testid="ended-group" onClick={() => setShowEnded(true)}>
              已结束的迭代（{ended.length} 个 · {ended.reduce((n, c) => n + pick(c).length, 0)} 张）
              <div className="small muted">点开展开</div>
            </button>
          ))}
        {shown.map((c) => (
          <ColumnView key={c.key} col={c} cards={pick(c)} mode={board.mode} ops={ops} onDrop={onDrop} />
        ))}
        {/* the floating detail covers the right of the board: room to scroll any column out from under it (#155) */}
        {opened && <div className="detail-spacer" data-testid="detail-spacer" aria-hidden="true" />}
      </div>
    );
  };

  return (
    <div className="board-page" data-testid="board">
      {/* top row: what you are looking at (sources, search), sync state, new issue, settings */}
      <header className="hdr">
        <div className="brand">
          <img src={brandIcon} alt="" />
          Cavil Loop
        </div>
        {state.sources.length > 0 && <div className="vsep" />}
        <div className="sources-pick" data-testid="source-pick">
          {state.sources.map((s) => (
            <label key={s.key} className={`src-chip${selected.has(s.key) ? ' on' : ''}`} title={sourceLabel(s, titles.get(s.key))}>
              <input type="checkbox" data-key={s.key} checked={selected.has(s.key)} onChange={() => toggle(s.key)} />
              <Icon name={s.kind === 'project' ? 'project' : 'repo'} size={14} />
              <span className="src-name">{sourceLabel(s, titles.get(s.key))}</span>
            </label>
          ))}
        </div>
        <div className="search">
          <Icon name="search" />
          <input
            data-testid="search"
            type="search"
            value={query}
            aria-label="搜索或筛选"
            placeholder="搜索标题、编号、标签，或用 GitHub 写法：label:bug assignee:@me"
            title="写法同 GitHub 网页：label:bug -status:Done iteration:@current assignee:@me"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="hdr-right">
          {sync.lastOnlineAt && (
            <span
              className={`sync-status${writesEnabled(sync) ? '' : ' offline'}${failed.length ? ' partial' : ''}`}
              data-testid="sync-status"
              title={`上次同步 ${ago(sync.lastOnlineAt, now)}`}
            >
              <span className="dot" />
              <span className="sync-text">上次同步 {ago(sync.lastOnlineAt, now)}</span>
            </span>
          )}
          <button
            className="icon-btn"
            data-testid="refresh"
            disabled={sync.syncing}
            aria-label={sync.syncing ? '同步中…' : '刷新'}
            title={sync.syncing ? '同步中…' : '刷新（马上同步一轮）'}
            onClick={() => api().syncNow()}
          >
            <Icon name="refresh" />
          </button>
          <button
            className="primary"
            data-testid="write-entry"
            disabled={!canWrite}
            title={writesEnabled(sync) ? (state.sources.length ? '新建 issue' : '先添加数据来源') : '离线时不能修改'}
            data-offline={writesEnabled(sync) ? 'no' : 'yes'}
            onClick={() => setNewIssue(true)}
          >
            <Icon name="plus" />
            新建 issue
          </button>
          <button className="icon-btn" onClick={onSettings} data-testid="open-settings" aria-label="设置" title="设置">
            <Icon name="gear" />
          </button>
          {state.viewer && (
            <span className="viewer" title={`已登录 ${state.viewer}`}>
              <Avatar login={state.viewer} size={28} />
            </span>
          )}
        </div>
      </header>

      {/* second row: how this view is laid out */}
      <div className="vbar">
        <div className="seg" data-testid="layout">
          {(['board', 'table'] as Layout[]).map((l) => (
            <button key={l} className={view.layout === l ? 'on' : ''} data-value={l} onClick={() => api().setView({ layout: l })}>
              <Icon name={l === 'board' ? 'board' : 'table'} />
              {l === 'board' ? '看板' : '表格'}
            </button>
          ))}
        </div>
        {view.layout === 'board' && (
          <>
            <label className="inline">
              分列
              <select data-testid="mode" value={view.mode} onChange={(e) => api().setView({ mode: e.target.value as ColumnMode })}>
                {(Object.keys(MODE_LABEL) as ColumnMode[]).map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </select>
            </label>
            <label className="toggle">
              <input type="checkbox" data-testid="swimlanes" checked={view.swimlanes} onChange={(e) => api().setView({ swimlanes: e.target.checked })} />
              按仓库分泳道
            </label>
          </>
        )}
        <button data-testid="open-view-panel" className={panel ? 'on' : 'ghost'} onClick={() => setPanel(!panel)}>
          <Icon name="sliders" />
          视图设置
        </button>
        <span className="vbar-count">
          {filtering ? (
            <span data-testid="match-count">
              显示 {items.length} / {data.items.length} 条
            </span>
          ) : null}
          <span data-testid="item-total" className={filtering ? 'sr-only' : undefined}>
            {data.items.length} 个条目
          </span>
        </span>
      </div>
      <WarnBar kind="filter-unsupported" warn={warn}>
        {parsed.unsupported.map((t) => `「${t}」`).join('')}本客户端不支持，已忽略，结果可能比 GitHub 网页上多。
      </WarnBar>
      <WarnBar kind="filter-incomplete" warn={warn}>
        有来源这次没读全，筛选结果可能不全（详见下方）。
      </WarnBar>
      {hasText && <div className="small muted hint">文字只搜标题、编号和标签名，不搜正文和评论。</div>}
      {view.imported && view.imported.notes.length > 0 && (
        <div className="banner info" data-testid="import-notes">
          导入网页视图{view.imported.viewName ? `「${view.imported.viewName}」` : ''}时，有些设置本客户端做不到：{view.imported.notes.join('；')}
          <button className="link" data-testid="import-notes-dismiss" onClick={() => api().setView({ imported: { ...view.imported!, notes: [] } })}>
            知道了
          </button>
        </div>
      )}
      {panel && <ViewSettingsPanel view={view} />}

      <WarnBar kind="offline" warn={warn}>
        离线 · 数据截至 {sync.dataFrom ? ago(sync.dataFrom, now) : '（还没有同步过）'}。修改功能暂不可用。
      </WarnBar>
      <WarnBar kind="incomplete" warn={warn}>
        同步不完整：
        {failed
          .map((f) => {
            const s = state.sources.find((x) => x.key === f.sourceKey);
            return `${s ? sourceLabel(s, titles.get(s.key)) : f.sourceKey} 读取失败（${f.error}），显示的是${f.dataFrom ? ` ${ago(f.dataFrom, now)}` : '空'}的数据`;
          })
          .join('；')}
      </WarnBar>
      <WarnBar kind="sync-problem" warn={warn}>
        {sync.problem}
      </WarnBar>
      <WarnBar kind="board-notify-problem" warn={warn}>
        macOS 没有让 Cavil Loop 弹出通知（{state.notifyProblem}）。请打开「系统设置 → 通知 → Cavil Loop」，打开「允许通知」；角标照常显示。
      </WarnBar>
      <ResultBanner note={note} testid="board-action-result" />
      {view.layout === 'board' && board.notice && (
        <div className="banner info" data-testid="board-notice">
          {board.notice}
        </div>
      )}
      {state.sources.length === 0 && (
        <div className="center muted" data-testid="empty">
          还没有数据来源。<button className="link" onClick={onSettings}>去设置里添加 Project 或仓库</button>
        </div>
      )}

      <div className="board-area">
      {view.layout === 'table' ? (
        <TableView items={items} projects={data.projects} view={view} today={today} now={now} onOpen={openItem} />
      ) : (
      <div className="board">
        {board.lanes
          ? board.lanes.map((lane) => (
              <div className="lane" key={lane} data-testid="lane" data-lane={lane}>
                <div className="lane-head">{lane}</div>
                {renderRow(lane)}
              </div>
            ))
          : renderRow(null)}
      </div>
      )}
      {opened && <DetailPanel key={opened.n} itemKey={opened.key} state={state} data={data} onClose={() => setOpened(null)} onLeftBehind={setNote} />}
      </div>
      {newIssue && <NewIssueDialog state={state} data={data} onClose={() => setNewIssue(false)} onCreated={openItem} />}
      {confirm && (
        <ConfirmDialog
          title="加入看板？"
          confirmLabel="加入并设置"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const c = confirm.choices[choice];
            await runAll([c.action], `已加入看板「${c.projectTitle}」`);
            setConfirm(null);
          }}
        >
          <p data-testid="confirm-question">{confirm.question}</p>
          {confirm.choices.length > 1 && (
            <select data-testid="confirm-project" value={choice} onChange={(e) => setChoice(Number(e.target.value))}>
              {confirm.choices.map((c, i) => (
                <option key={c.projectKey} value={i}>
                  {c.projectTitle}
                </option>
              ))}
            </select>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
