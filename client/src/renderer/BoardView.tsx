import { badgeText, stateTone } from '../shared/stateTone';
import { UpdateInstalledBar, UpdateReadyBar } from './UpdateViews';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { AppState, BoardData, ColumnMode, CreateJob, Layout } from '../shared/types';
import type { RepoOptions, WriteAction } from '../shared/actions';
import { sourceLabel } from '../shared/sources';
import { RETRY_BY_HAND, ago, headerText, hoverLines, offlineDataText, retryText } from './syncTimes';
import { buildBoard, dropPlan, writesEnabled, type Card, type Column, type DropPlan } from '../data/board';
import { api } from './api';
import { labelStyle, useDarkMode } from './colors';
import { Icon, itemIcon } from './Icons';
import { ConfirmDialog } from './ConfirmDialog';
import { OPENS_ITEM } from './outsideClick';
import { noteOf, ResultBanner, type ResultNote } from './DetailPanel';
import { noteEditOf, stepNoteEdits, type NoteEdit } from './noteEdits';
import { NewIssueDialog, type GroupSeed } from './NewIssueDialog';
import { applyFilter, openOnly, parseFilter, statesStated, type ParsedFilter } from '../shared/filter';
import { isFiltering, syncTrouble, type SyncTrouble, type WarnKind } from './warnings';
import { useLayer, useShortcuts } from './keyboard';
import { EmptyGuide, type SettingsIntent } from './EmptyGuide';
import { FailureNote } from './FailureNote';
import { REREAD_OK_TEXT, rereadResultText, rereadRunningText, useReread, type Reread } from './reread';
import { emptyGuideOf } from '../shared/emptyGuide';
import { describeFailure, failureOf } from '../shared/readFailure';
import { TableView } from './TableView';
import { pinnedLabels } from '../shared/pickOrder';
import { buildTable } from '../data/table';
import { GraphView, type GraphSourceInfo } from './GraphView';
import { buildGraph } from '../data/graph';
import { localToday } from './iterationOptions';
import { ViewSettingsPanel } from './ViewSettingsPanel';
import { Avatar } from './Avatar';
import type { BoardRequest } from './App';
import { keyText, type ShortcutId } from './shortcuts';
import { useRepoDrag } from './repoDrag';
import { RepoWebLink } from './RepoWebLink';
import { litTally, showClosedDefault, showClosedKey, tallyClick, tallyEntries, tallyForget, UNLABELED_QUERY, type TallyEntry } from '../data/flowTally';
import { effectiveTallies } from '../shared/tallies';

function useNow(ms = 15_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** GitHub#372: each layout button's shortcut (the same action, see App) */
const LAYOUT_KEY: Record<Layout, ShortcutId> = { board: 'viewBoard', table: 'viewTable', graph: 'viewGraph' };
const MODE_LABEL: Record<ColumnMode, string> = { iteration: '迭代', status: '状态', milestone: '里程碑' };
const LAYOUT_LABEL: Record<Layout, string> = { board: '看板', table: '表格', graph: '依赖图' };

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
      {...{ [OPENS_ITEM]: '' }}
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
        {it.edits?.some((m) => m.status === 'failed' || m.status === 'unconfirmed') && (
          <span className="edit-flag" data-testid="card-edit-flag" title="有修改没保存上或没确认，打开看详情">
            <Icon name="warn" size={12} /> 修改未保存
          </span>
        )}
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
          <span key={l.name} className={`label${it.edits?.some((m) => m.label === l.name && ['saving', 'verifying', 'observing'].includes(m.status)) ? ' pending' : ''}`} style={labelStyle(l.color, ops.dark)}>
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

/** GitHub#297: below this a swimlane's columns stop shrinking (one card's head still shows) */
export const LANE_COL_MIN = 48;

/**
 * GitHub#297: the tallest a column in a swimlane may be on this board: half the board's visible height,
 * and no more than what is left once this lane's head, its row's padding and scrollbar, the gap and
 * the next lane's head are taken out — all measured from the page, not assumed.
 */
function laneColumnMax(board: HTMLElement): number {
  const cs = getComputedStyle(board);
  const h = board.clientHeight - parseFloat(cs.paddingTop || '0') - parseFloat(cs.paddingBottom || '0');
  const head = board.querySelector<HTMLElement>('.lane-head');
  const headH = head ? head.offsetHeight + parseFloat(getComputedStyle(head).marginBottom || '0') : 36;
  const lane = board.querySelector<HTMLElement>('.lane');
  const gap = lane ? parseFloat(getComputedStyle(lane).marginBottom || '0') : 16;
  let row = 6;
  for (const r of board.querySelectorAll<HTMLElement>('.lane > .columns'))
    row = Math.max(row, parseFloat(getComputedStyle(r).paddingBottom || '0') + (r.offsetHeight - r.clientHeight));
  const room = Math.floor(h - 2 * headH - row - gap - 2);
  return Math.max(LANE_COL_MIN, Math.min(Math.floor(h / 2), room));
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

/**
 * GitHub#248: sources that failed this round, as a ⚠️ next to the refresh button instead of two
 * full-width bars. A click opens the details (what the bars used to say); a second click, a click
 * outside or Esc puts them away. Mounted only while there is trouble, so a later failure never
 * opens it by itself.
 */
/** GitHub#455: how long "已重新读取，所有来源都读到了" stays next to refresh */
const REREAD_OK_MS = 5000;

function SyncTroubleButton({ trouble, describe, retryOf, appKind, reread }: { trouble: SyncTrouble; describe: (f: SyncTrouble['failed'][number]) => string; retryOf: (f: SyncTrouble['failed'][number]) => string | null; appKind: AppState['signedInAppKind']; reread: Reread }) {
  const [open, setOpen] = useState(false);
  // GitHub#455: the outcome line stays until the next click or until the panel is put away
  const close = () => {
    setOpen(false);
    reread.clear();
  };
  const box = useRef<HTMLSpanElement>(null);
  const n = trouble.failed.length;
  const label = trouble.incomplete
    ? `同步不完整：${n} 个来源读取失败（点开看详情）`
    : '有来源这次没读全，筛选结果可能不全（点开看详情）';
  return (
    <span className="trouble-anchor" ref={box}>
      <button
        className={`icon-btn trouble-btn${open ? ' on' : ''}`}
        data-testid="sync-trouble"
        data-open={open ? 'yes' : 'no'}
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon name="warn" />
      </button>
      {open && <SyncTroublePanel trouble={trouble} describe={describe} retryOf={retryOf} appKind={appKind} box={box} reread={reread} onClose={close} />}
    </span>
  );
}

function SyncTroublePanel({
  trouble,
  describe,
  retryOf,
  appKind,
  box,
  reread,
  onClose,
}: {
  trouble: SyncTrouble;
  describe: (f: SyncTrouble['failed'][number]) => string;
  retryOf: (f: SyncTrouble['failed'][number]) => string | null;
  appKind: AppState['signedInAppKind'];
  box: RefObject<HTMLSpanElement | null>;
  /** GitHub#455: the one reread both buttons start; the panel shows it running and what it came to */
  reread: Reread;
  onClose: () => void;
}) {
  const rs = reread.state;
  const running = rs.phase === 'running';
  const result = rs.phase === 'done' ? rereadResultText(rs) : null;
  // on top while open: Esc is ours (the same layer the label picker uses)
  useLayer('picker');
  useShortcuts({ pickerClose: onClose });
  useEffect(() => {
    const out = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', out);
    return () => document.removeEventListener('mousedown', out);
  }, [box, onClose]);
  return (
    <div className="trouble-panel" data-testid="sync-trouble-panel" role="dialog" aria-label="同步不完整">
      {trouble.incomplete && (
        <>
          <div className="trouble-head">
            <Icon name="warn" />
            同步不完整
          </div>
          <ul data-testid="sync-trouble-incomplete">
            {trouble.failed.map((f) => (
              <li key={f.sourceKey} data-testid="sync-trouble-source" data-key={f.sourceKey}>
                {describe(f)}
                {retryOf(f) && (
                  <small className="trouble-retry" data-testid="sync-trouble-retry">
                    {retryOf(f)}
                  </small>
                )}
                {/* GitHub#401: the same explanation, buttons and GitHub's words as Settings and the empty board */}
                <FailureNote failure={failureOf(f)} state={{ signedInAppKind: appKind }} reread={reread} testid="sync-trouble-failure" />
              </li>
            ))}
          </ul>
          {trouble.failed.some((f) => retryOf(f) !== null) && (
            <div className="trouble-note" data-testid="sync-trouble-by-hand">
              {RETRY_BY_HAND}
            </div>
          )}
        </>
      )}
      {trouble.filterIncomplete && (
        <div className="trouble-filter" data-testid="sync-trouble-filter">
          有来源这次没读全，筛选结果可能不全。
        </div>
      )}
      {running && (
        <div className="reread-line running" data-testid="sync-trouble-running" role="status">
          <span className="spin" aria-hidden="true" />
          <span>{rereadRunningText(rs.startedAt)}</span>
        </div>
      )}
      {result && (
        <div className="reread-line bad" data-testid="sync-trouble-result" data-kind={rs.phase === 'done' ? rs.outcome.kind : undefined} role="status">
          <Icon name="warn" />
          <span>{result}</span>
        </div>
      )}
      <div className="trouble-foot">
        <button className={running ? 'reread-busy' : undefined} data-testid="sync-trouble-resync" data-running={running ? 'yes' : 'no'} onClick={reread.run}>
          {running ? <span className="spin" aria-hidden="true" /> : <Icon name="refresh" />}
          {running ? '正在重新同步…' : '重新同步'}
        </button>
      </div>
    </div>
  );
}

/** GitHub#250: opened from a notice above the board to do this with one of the item's operations */
export type OpenIntent = { opId: string; what: 'retry' | 'toReply' };

export function BoardView({
  state,
  data,
  query,
  setQuery,
  parsed,
  warn,
  onOpen,
  detailKey,
  floatKey = null,
  floatPanel = null,
  leftNote = null,
  request = null,
  onRequestTaken,
  onSettings,
  onKeysHelp,
  tallySaved,
  tools = null,
  onFront,
  tallyPick: pickProp,
  onTallyPick,
}: {
  state: AppState;
  data: BoardData;
  query: string;
  setQuery: (q: string) => void;
  parsed: ParsedFilter;
  warn: BoardWarnings;
  /**
   * Open this item (`intent`: to do this with one of its operations, GitHub#250). GitHub#442: in the
   * floating panel by default, in a tab with ⌘ / Ctrl held — the window decides (App).
   */
  onOpen: (key: string, intent?: OpenIntent) => void;
  /**
   * GitHub#397: the item whose detail tab is in front; null = the home tab is. Behind a detail tab the
   * board stays mounted, but its keys are not its own.
   */
  detailKey: string | null;
  /** GitHub#442: the item the floating detail shows over the board, and the panel itself */
  floatKey?: string | null;
  floatPanel?: ReactNode;
  /** a change made in a detail tab that has since been left: its result is said here (`seq` changes with every one) */
  leftNote?: { note: ResultNote; about?: WriteAction; seq: number } | null;
  /** a shortcut that needs the board (GitHub#192): done once, then handed back */
  request?: BoardRequest | null;
  onRequestTaken?: () => void;
  onSettings: (intent?: SettingsIntent) => void;
  onKeysHelp?: () => void;
  /** GitHub#404: the search text from before a flow number was clicked; kept by the window so the settings page does not lose it */
  tallySaved?: { current: string | null };
  /**
   * GitHub#467: the window's top row, where the board draws its tools (search, sync state, refresh, new
   * issue, settings, the account) — they stay there while a detail tab is in front. null: not drawn yet.
   */
  tools?: HTMLElement | null;
  /**
   * GitHub#467: bring the board to the front (a tool used while a detail tab is in front). `keepFocus`:
   * the search box is being typed in — it stays focused (and open) for the next key.
   */
  onFront?: (keepFocus?: boolean) => void;
  /** GitHub#464: the number last clicked (kept by the window) — tells numbers with the same click text apart */
  tallyPick?: string | null;
  onTallyPick?: (kind: string | null) => void;
}) {
  const now = useNow();
  const [showEnded, setShowEnded] = useState(false);
  const [panel, setPanel] = useState(false);
  const { view, sync } = state;
  const today = localToday(now);
  // GitHub#496: the table's label picker keeps these near the top, like the detail panel's
  const { autopilot: pinA, human: pinH, agent: pinG } = state.handBack;
  const pinned = useMemo(() => pinnedLabels({ autopilot: pinA, human: pinH, agent: pinG }), [pinA, pinH, pinG]);
  // GitHub#404: the flow numbers, over every item of the ticked sources (not the search result)
  // GitHub#468: the numbers are the table set in Settings; a condition of one's own is judged with the board's context
  const { running, agent, human } = state.handBack;
  const tallyDefs = state.tallies;
  const tally = useMemo(
    () => tallyEntries(data.items, effectiveTallies(tallyDefs), { running, agent, human }, { viewer: state.viewer, today, projects: data.projects }),
    [data.items, data.projects, tallyDefs, running, agent, human, state.viewer, today],
  );
  // a window without its own memory (tests mounting the board alone) keeps the pick here
  const [ownPick, setOwnPick] = useState<string | null>(null);
  const pick = onTallyPick ? (pickProp ?? null) : ownPick;
  const setPick = onTallyPick ?? setOwnPick;
  const lit = litTally(query, tally, pick);
  const litEntry = tally.find((e) => e.kind === lit) ?? null;
  // GitHub#464: the "显示已关闭" switch in effect (the lit number's, else the layout's); a search that
  // says open / closed / merged itself decides instead, and the switch is greyed out
  const closedKey = showClosedKey(view.layout, lit);
  const statesInSearch = statesStated(parsed);
  // a number not switched yet starts as it counts (on for "等人处理", GitHub#462); a layout is always stored
  const closedOn = view.showClosed[closedKey] ?? showClosedDefault(litEntry);
  const hideClosed = !statesInSearch && !closedOn;
  const items = useMemo(() => {
    const hit = applyFilter(data.items, parsed, { viewer: state.viewer, today, projects: data.projects });
    return hideClosed ? openOnly(hit) : hit;
  }, [data, parsed, state.viewer, today, hideClosed]);
  const board = useMemo(
    () => buildBoard(items, data.projects, view.mode, view.swimlanes, today, view.table.sort, view.prsUnderIssues, state.repoOrder),
    [items, data.projects, view.mode, view.swimlanes, today, view.table.sort, view.prsUnderIssues, state.repoOrder],
  );
  // GitHub#368: built once here, so the view bar's counts and the table come from the same result
  const table = useMemo(
    () => (view.layout === 'table' ? buildTable(items, data.projects, view.table, today, view.prsUnderIssues, state.repoOrder, data.items) : null),
    [view.layout, items, data.projects, view.table, today, view.prsUnderIssues, state.repoOrder, data.items],
  );
  const selected = new Set(view.selected ?? state.sources.map((s) => s.key));
  const titles = new Map(data.projects.map((p) => [p.key, p.title]));
  // GitHub#350: the dependency graph of what the sources and search picked
  // GitHub#429: plus the loop's own prerequisite registrations, read under the waiting label setting
  const loopLabel = state.handBack.blocked;
  const graph = useMemo(() => (view.layout === 'graph' ? buildGraph(data.items, items, loopLabel) : null), [view.layout, data.items, items, loopLabel]);
  const ownSaved = useRef<string | null>(null);
  const saved = tallySaved ?? ownSaved;
  // the box changed some other way and no longer shows a number's query: the remembered search is void
  useEffect(() => {
    saved.current = tallyForget(saved.current, query, tally);
    // no number shown any more: the remembered pick is void too (a later text typed by hand starts from the first)
    if (litTally(query, tally) === null && pick !== null) setPick(null);
  }, [query, tally, saved, pick, setPick]);
  const clickTally = (e: TallyEntry) => {
    const next = tallyClick(query, saved.current, e, tally, pick);
    saved.current = next.saved;
    setPick(next.pick);
    if (next.query !== query) setQuery(next.query);
  };
  const failed = sync.sources.filter((s) => !s.ok);
  const trouble = syncTrouble(sync, parsed);
  // GitHub#455: a reread started from the ⚠️ panel; kept here so its outcome outlives the panel (all read → ⚠️ and panel go).
  // The green note is not a state of its own: it is shown exactly while the reread's latest outcome is "all read"
  // (and nothing failed since), and its timer puts that outcome back to idle. A new click replaces the outcome, so an
  // old note can never come back (PR #458 review round 1: a separate "shown" value outlived the timer that cleared it).
  const reread = useReread();
  const rereadOk = reread.state.phase === 'done' && reread.state.outcome.kind === 'ok' ? reread.state.at : null;
  useEffect(() => {
    if (rereadOk === null) return;
    const t = setTimeout(() => reread.clear(), REREAD_OK_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rereadOk]);
  // something failed again after it: that "all read" is over for good, not just hidden until the next recovery
  const troubleNow = trouble !== null;
  useEffect(() => {
    if (rereadOk !== null && troubleNow) reread.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rereadOk, troubleNow]);
  const okShown = rereadOk !== null && !troubleNow;
  const labelOf = (sourceKey: string) => {
    const s = state.sources.find((x) => x.key === sourceKey);
    return s ? sourceLabel(s, titles.get(s.key)) : sourceKey;
  };
  // GitHub#401: the same words as Settings and the empty board's card (shared/readFailure.ts)
  const describeFailed = (f: (typeof failed)[number]) => {
    const shown = `显示的是${f.dataFrom ? ` ${ago(f.dataFrom, now)}` : '空'}的数据`;
    return `${labelOf(f.sourceKey)} 读取失败（${describeFailure(failureOf(f), now, state.signedInAppKind ?? 'oauth').title}），${shown}`;
  };
  // GitHub#401: the empty board's card (add a source / why nothing was read)
  const guide = emptyGuideOf(
    state.sources,
    view.selected,
    sync.sources,
    data.items.map((it) => it.sources),
  );
  const canWrite = writesEnabled(sync) && state.sources.length > 0;
  // GitHub#397: an item opens in its own detail tab (the window's, see App)
  const openItem = (key: string) => onOpen(key);
  // false = closed; true = the plain dialog; a seed = from a table group's "+" (GitHub#214)
  const [newIssue, setNewIssue] = useState<boolean | GroupSeed | { draft: CreateJob['draft'] }>(false);
  const searchBox = useRef<HTMLInputElement>(null);
  // GitHub#467: the search box is small until it is used (focused), then wide; leaving it keeps what it holds
  const [searchOpen, setSearchOpen] = useState(false);
  // GitHub#323: the bar's note, and the field change a failed one is about (it goes once that change is over)
  const [shownNote, setShownNote] = useState<{ note: ResultNote; watch: NoteEdit[] } | null>(null);
  const note = shownNote?.note ?? null;
  const setNote = (n: ResultNote | null, about?: WriteAction) => {
    const e = n?.kind === 'error' && about ? noteEditOf(about) : null;
    setShownNote(n ? { note: n, watch: e ? [e] : [] } : null);
  };
  useEffect(() => {
    if (leftNote) setNote(leftNote.note, leftNote.about);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftNote?.seq]);
  useEffect(() => {
    if (!shownNote?.watch.length) return;
    const step = stepNoteEdits(shownNote.watch, data.items);
    if (step.over) setShownNote((cur) => (cur === shownNote ? null : cur));
    else if (step.watch !== shownNote.watch) setShownNote((cur) => (cur === shownNote ? { ...cur, watch: step.watch } : cur));
  }, [shownNote, data.items]);
  const [busy, setBusy] = useState(false);
  // a shortcut pressed on any page (GitHub#192): done once here, then dropped by App so coming
  // back to the board later never repeats it. "New issue" only when its button would work.
  useEffect(() => {
    if (!request) return;
    if (request.kind === 'search') {
      // GitHub#467: the box lives in the window's top row; coming back from a page without that row it is
      // drawn a moment after the board — the request waits for it (it is taken once the box is there)
      if (!searchBox.current) return;
      searchBox.current.focus();
      searchBox.current.select();
    } else if (request.draft) setNewIssue({ draft: request.draft });
    else if (canWrite) setNewIssue(true);
    onRequestTaken?.();
  }, [request?.seq, tools]);
  const [confirm, setConfirm] = useState<Extract<DropPlan, { kind: 'confirm' }> | null>(null);
  const [choice, setChoice] = useState(0);
  const dragging = useRef<{ card: Card; from: string } | null>(null);
  // GitHub#304: a swimlane's head drags the repository to another place; a card drag that never landed is forgotten first
  const laneDrag = useRepoDrag(board.lanes ?? [], () => (dragging.current = null));
  const labelCache = useRef(new Map<string, Promise<RepoOptions>>());
  const dark = useDarkMode();
  const pickedProjects = state.sources.filter((s) => s.kind === 'project' && selected.has(s.key)).length;

  /** run actions one after another; stop at the first refusal (the rest are not sent) */
  const runAll = async (actions: WriteAction[], okText: string) => {
    setBusy(true);
    let warn: string[] = [];
    // GitHub#488: field changes the controller recorded are said by the card and the window's notice area
    let allHeld = true;
    for (const a of actions) {
      const r = await api().act(a);
      if (!r.ok) {
        setBusy(false);
        const done = actions.indexOf(a);
        if (!r.held) setNote({ kind: 'error', text: `${done ? `前 ${done} 项已改好；` : ''}${r.error}` }, a);
        return;
      }
      if (!r.held) allHeld = false;
      if (r.warning) warn.push(r.warning);
    }
    setBusy(false);
    if (!allHeld || warn.length) setNote(noteOf({ ok: true, error: null, warning: warn.join('；') || null }, okText));
  };
  const ops: CardOps = {
    // GitHub#229: a change shows on the card at once; the board does not wait for GitHub's answer
    canWrite,
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
    applyPlan(dropPlan(d.card, d.from, col, board.mode, data.projects));
  };
  /** what a drop decided, for a card on the board and a row in the table alike (GitHub#294) */
  const applyPlan = (plan: DropPlan) => {
    if (plan.kind === 'refuse') setNote({ kind: 'error', text: `没有修改：${plan.reason}` });
    else if (plan.kind === 'do') void runAll(plan.actions, plan.summary);
    else if (plan.kind === 'confirm') {
      setChoice(0);
      setConfirm(plan);
    }
  };
  const filtering = isFiltering(parsed);
  const hasText = parsed.clauses.some((c) => c.kind === 'text');

  const ended = board.columns.filter((c) => c.ended);
  const shown = board.columns.filter((c) => !c.ended);
  // GitHub#297: with swimlanes, a column is at most half of the board's visible height, and never so tall
  // that this lane's head plus the next lane's head stop fitting in what is left of the board (the window
  // size and every bar above count, as they shrink the board); only below LANE_COL_MIN does it stop shrinking
  const laneFolded = new Set(state.laneFolds);
  const boardRef = useRef<HTMLDivElement>(null);
  const [laneMax, setLaneMax] = useState<number | null>(null);
  const withLanes = view.layout === 'board' && board.lanes !== null;
  const laneShape = board.lanes ? `${board.lanes.join('\n')}\u0000${state.laneFolds.join('\n')}` : '';
  useLayoutEffect(() => {
    const el = boardRef.current;
    if (!withLanes || !el) return;
    const measure = () => setLaneMax(laneColumnMax(el));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [withLanes, laneShape]);
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
        {floatKey && <div className="detail-spacer" data-testid="detail-spacer" aria-hidden="true" />}
      </div>
    );
  };

  return (
    <div className="board-page" data-testid="board">
      {/* GitHub#467: the tools live in the window's one top row (TopBar), also while a detail tab is in front */}
      {tools &&
        createPortal(
          <>
            <div
              className={`search${searchOpen ? ' open' : ' mini'}`}
              data-testid="search-box"
              data-open={searchOpen ? 'yes' : 'no'}
              // a press anywhere on the small box opens it (the icon too, not only the text)
              onMouseDown={(e) => {
                if (e.target === searchBox.current) return;
                e.preventDefault();
                searchBox.current?.focus();
              }}
            >
              <Icon name="search" />
              <input
                data-testid="search"
                ref={searchBox}
                type="search"
                value={query}
                aria-label="搜索或筛选"
                placeholder={searchOpen ? '搜索标题、编号、标签，或用 GitHub 写法：label:bug assignee:@me' : `搜索（${keyText('search')}）`}
                title="写法同 GitHub 网页：label:bug -status:Done iteration:@current assignee:@me"
                onFocus={() => setSearchOpen(true)}
                onBlur={() => setSearchOpen(false)}
                onKeyDown={(e) => {
                  // Esc folds the box away and keeps its text (a search field's own Esc would empty it)
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    searchBox.current?.blur();
                  }
                }}
                onChange={(e) => {
                  // GitHub#467: typed in while a detail tab is in front: the board comes to the front to show the result
                  onFront?.(true);
                  setQuery(e.target.value);
                }}
              />
            </div>
            <div className="hdr-right">
              {/* GitHub#324: the oldest check, not "GitHub answered"; the hover has every source's two times */}
              {headerText(sync, now) !== null && (
                <span
                  className={`sync-status${writesEnabled(sync) ? '' : ' offline'}${failed.length ? ' partial' : ''}`}
                  data-testid="sync-status"
                  title={hoverLines(sync, labelOf, now).join('\n')}
                >
                  <span className="dot" />
                  <span className="sync-text">{headerText(sync, now)}</span>
                </span>
              )}
              {okShown && (
                <span className="reread-ok" data-testid="sync-reread-ok" role="status">
                  <Icon name="check" />
                  {REREAD_OK_TEXT}
                </span>
              )}
              {trouble && <SyncTroubleButton trouble={trouble} describe={describeFailed} retryOf={(f) => retryText(f, now)} appKind={state.signedInAppKind} reread={reread} />}
              {/* never greyed out while a round runs (GitHub#217): a click starts over */}
              <button
                className={`icon-btn${sync.syncing ? ' spinning' : ''}`}
                data-testid="refresh"
                data-syncing={sync.syncing ? 'yes' : 'no'}
                aria-label={sync.syncing ? '同步中…（点一下重新同步）' : '刷新'}
                title={sync.syncing ? `同步中…（点一下：放弃这一轮，重新同步，${keyText('sync')}）` : `刷新（马上同步一轮，${keyText('sync')}）`}
                onClick={() => api().restartSync()}
              >
                <Icon name="refresh" />
              </button>
              <button
                className="primary icon-only"
                data-testid="write-entry"
                aria-label="新建 issue"
                disabled={!canWrite}
                title={writesEnabled(sync) ? (state.sources.length ? `新建 issue（${keyText('newIssue')}）` : '先添加数据来源') : '离线时不能修改'}
                data-offline={writesEnabled(sync) ? 'no' : 'yes'}
                onClick={() => {
                  onFront?.();
                  setNewIssue(true);
                }}
              >
                <Icon name="plus" />
              </button>
              <button
                className="icon-btn"
                onClick={() => {
                  onFront?.();
                  onSettings();
                }}
                data-testid="open-settings"
                aria-label="设置"
                title={`设置（${keyText('settings')}）`}
              >
                <Icon name="gear" />
              </button>
              {state.viewer && (
                <span className="viewer" title={`已登录 ${state.viewer}`}>
                  <Avatar login={state.viewer} size={28} />
                </span>
              )}
            </div>
          </>,
          tools,
        )}

      {/* second row: how this view is laid out */}
      <div className="vbar">
        <div className="seg" data-testid="layout">
          {(['board', 'table', 'graph'] as Layout[]).map((l) => (
            <button key={l} className={view.layout === l ? 'on' : ''} data-value={l} title={`${LAYOUT_LABEL[l]}（${keyText(LAYOUT_KEY[l])}）`} onClick={() => api().setView({ layout: l })}>
              <Icon name={l} />
              {LAYOUT_LABEL[l]}
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
        <label
          className={`toggle${statesInSearch ? ' disabled' : ''}`}
          data-testid="show-closed-toggle"
          data-view={closedKey}
          title={
            statesInSearch
              ? '搜索框已经指定了开 / 关状态（is:open、is:closed、is:merged），以搜索框为准'
              : `打开后连已关闭、已合并的条目一起显示。只限已读到的条目：仓库来源读全部开着的、近 14 天更新过的和挂着「等人处理的标签」的已关闭条目，Project 来源读看板上的全部条目。\n看板、表格、依赖图，以及顶栏四个数点亮时，各记一份。`
          }
        >
          <input
            type="checkbox"
            data-testid="show-closed"
            checked={statesInSearch ? false : closedOn}
            disabled={statesInSearch}
            onChange={(e) => api().setView({ showClosed: { [closedKey]: e.target.checked } })}
          />
          显示已关闭{litEntry ? `（${litEntry.name}）` : ''}
        </label>
        {view.layout !== 'graph' && (
          <button data-testid="open-view-panel" className={panel ? 'on' : 'ghost'} onClick={() => setPanel(!panel)}>
            <Icon name="sliders" />
            视图设置
          </button>
        )}
        <span className="vbar-count">
          {graph ? (
            <span data-testid="graph-count">
              显示 {graph.entries} 个有关系的条目 · 共 {data.items.length} 个条目
            </span>
          ) : (
            <span className="tally" data-testid="flow-tally">
              {tally.map((e) => {
                const on = lit === e.kind;
                const tip = [
                  // GitHub#462: a row following the "等人处理" label counts closed items carrying it too
                  `${e.source === 'flow' ? (e.flow === 'human' ? `带 ${e.label} 标签的条目（开着的和已关闭的都算）` : `开着的条目里带 ${e.label} 标签的`) : e.query === UNLABELED_QUERY ? '开着的条目里一个标签都没有的' : `${statesStated(parseFilter(e.query!)) ? '' : '开着的条目里'}符合「${e.query}」的`}有 ${e.count} 个 · ${e.query === null ? '这个标签名写不进搜索框（含双引号，或以 < > 开头），不能点开筛选' : on ? '再点一下回到之前的搜索' : '点一下只看这些'}`,
                  `当前来源共 ${data.items.length} 个条目`,
                  ...(filtering ? [`搜索命中 ${table?.matchCount ?? items.length} 条`] : []),
                  ...(filtering && table && table.pulledCount > 0 ? [`另有 ${table.pulledCount} 个子 issue 随父 issue 显示`] : []),
                ].join('\n');
                return (
                  <button
                    key={e.kind}
                    type="button"
                    className={`tally-item${on ? ' on' : ''}${e.count === 0 ? ' zero' : ''}`}
                    data-testid="tally"
                    data-kind={e.kind}
                    aria-pressed={on}
                    disabled={e.query === null}
                    title={tip}
                    onClick={() => clickTally(e)}
                  >
                    <i className={`dot c-${e.color}`} aria-hidden="true" />
                    {e.name} <b data-testid="tally-count">{e.count}</b>
                  </button>
                );
              })}
            </span>
          )}
          <span data-testid="item-total" className="sr-only">
            {data.items.length} 个条目
          </span>
        </span>
        <button className="ghost" onClick={onKeysHelp} data-testid="open-shortcuts" title={`快捷键一览（${keyText('help')}）`}>
          快捷键 <kbd>?</kbd>
        </button>
      </div>
      {/* everything under the view bar */}
      <div className="below-bar">
      <div className={`board-bars${floatKey ? ' beside-detail' : ''}`} data-testid="board-bars">
      <WarnBar kind="filter-unsupported" warn={warn}>
        {parsed.unsupported.map((t) => `「${t}」`).join('')}本客户端不支持，已忽略，结果可能比 GitHub 网页上多。
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
      {panel && view.layout !== 'graph' && <ViewSettingsPanel view={view} />}

      <UpdateReadyBar update={state.update} />
      <UpdateInstalledBar update={state.update} />
      <WarnBar kind="offline" warn={warn}>
        {sync.offlineReason ? `离线：${sync.offlineReason}` : '离线'} · {offlineDataText(sync, now)} · 每分钟自动重试，点刷新可立刻重试。修改功能暂不可用。
      </WarnBar>
      <WarnBar kind="sync-problem" warn={warn}>
        {sync.problem}
      </WarnBar>
      <WarnBar kind="board-notify-problem" warn={warn}>
        macOS 没有让 Cavil Loop 弹出通知（{state.notifyProblem}）。请打开「系统设置 → 通知 → Cavil Loop」，打开「允许通知」；角标照常显示。
      </WarnBar>
      <ResultBanner note={note} testid="board-action-result" onExpire={() => setNote(null)} onClose={() => setNote(null)} />
      {view.layout === 'board' && board.notice && !guide && (
        <div className="banner info" data-testid="board-notice">
          {board.notice}
        </div>
      )}
      {guide && (
        <div className="center-guide" data-testid="empty">
          <EmptyGuide guide={guide} state={state} labelOf={labelOf} onSettings={onSettings} />
        </div>
      )}

      </div>
      <div className="board-area">
      {graph ? (
        <GraphView
          model={graph}
          items={data.items}
          sources={state.sources
            .filter((s) => selected.has(s.key))
            .map((s): GraphSourceInfo => ({
              key: s.key,
              label: labelOf(s.key),
              status: sync.sources.find((x) => x.sourceKey === s.key) ?? null,
              unknown: (data.relationsUnknown ?? []).includes(s.key),
              unknownItems: data.items.filter((i) => i.relations === undefined && i.sources.includes(s.key)).length,
            }))}
          syncing={sync.syncing}
          now={now}
          dark={dark}
          onOpen={openItem}
          keys={detailKey === null}
        />
      ) : view.layout === 'table' ? (
        <TableView
          items={items}
          projects={data.projects}
          view={view}
          today={today}
          now={now}
          canWrite={canWrite}
          onOpen={openItem}
          onNote={setNote}
          canCreate={canWrite}
          createTitle={writesEnabled(sync) ? (state.sources.length ? '在这一组新建 issue，带上这一组的字段' : '先添加数据来源') : '离线时不能修改'}
          onNewInGroup={(g) => setNewIssue({ preset: g.preset, title: g.title, items: g.rows.map((r) => r.item) })}
          folds={state.tableFolds}
          onDropPlan={applyPlan}
          repoOrder={state.repoOrder}
          table={table ?? undefined}
          pinnedLabels={pinned}
        />
      ) : (
      <div className={`board${board.lanes ? ' with-lanes' : ''}`} ref={boardRef} style={laneMax ? ({ '--lane-col-max': `${laneMax}px` } as CSSProperties) : undefined}>
        {board.lanes
          ? board.lanes.map((lane) => {
              // GitHub#297: each repository scrolls on its own (sideways in the row, up and down in each column) and folds to its head
              const isFolded = laneFolded.has(lane);
              const count = board.columns.reduce((n, c) => n + c.cards.filter((x) => x.lane === lane).length, 0);
              return (
                <div className={`lane${isFolded ? ' folded' : ''}`} key={lane} data-testid="lane" data-lane={lane} data-folded={isFolded ? '' : undefined}>
                  {/* GitHub#398: the head row holds the fold / drag button and, next to it, the link to the repository's GitHub page */}
                  <div className="lane-head-row" data-testid="lane-head">
                  <button
                    className="lane-head"
                    data-testid="lane-toggle"
                    aria-expanded={!isFolded}
                    title={`${isFolded ? '点一下展开这个仓库' : '点一下收起这个仓库'}；拖动调整仓库顺序`}
                    onClick={() => void Promise.resolve(api().setLaneFold(lane, !isFolded)).catch(() => undefined)}
                    {...laneDrag.props(lane)}
                  >
                    <span className="lane-mark" aria-hidden="true">
                      {isFolded ? '▸' : '▾'}
                    </span>
                    <Icon name="repo" size={14} />
                    <span className="lane-name">{lane}</span>
                    <span className="count" data-testid="lane-count">
                      {count}
                    </span>
                  </button>
                  <RepoWebLink repo={lane} />
                  </div>
                  {!isFolded && renderRow(lane)}
                </div>
              );
            })
          : renderRow(null)}
      </div>
      )}
      </div>
      {floatPanel}
      </div>
      {newIssue && (
        <NewIssueDialog
          state={state}
          data={data}
          group={newIssue === true || 'draft' in newIssue ? undefined : newIssue}
          draft={newIssue !== true && 'draft' in newIssue ? newIssue.draft : undefined}
          onClose={() => setNewIssue(false)}
        />
      )}
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
