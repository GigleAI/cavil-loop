import { badgeText, stateTone } from '../shared/stateTone';
import { UpdateInstalledBar, UpdateReadyBar } from './UpdateViews';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import type { AppState, BoardData, ColumnMode, CreateJob, Layout } from '../shared/types';
import { copyText } from './pasteImage';
import type { RepoOptions, WriteAction } from '../shared/actions';
import { sourceLabel } from '../shared/sources';
import { ago, headerText, hoverLines, offlineDataText } from './syncTimes';
import { buildBoard, dropPlan, writesEnabled, type Card, type Column, type DropPlan } from '../data/board';
import { api } from './api';
import { labelStyle, useDarkMode } from './colors';
import { Icon, itemIcon } from './Icons';
import brandIcon from '../../build/icon.png';
import { ConfirmDialog } from './ConfirmDialog';
import { OPENS_ITEM } from './outsideClick';
import { createFailures, createTone, editsTone } from '../shared/noticeTone';
import { DetailPanel, noteOf, ResultBanner, type ResultNote } from './DetailPanel';
import { OpNotice } from './OpNotice';
import { noteEditOf, stepNoteEdits, type NoteEdit } from './noteEdits';
import { NewIssueDialog, type GroupSeed } from './NewIssueDialog';
import { applyFilter, type ParsedFilter } from '../shared/filter';
import { isFiltering, syncTrouble, type SyncTrouble, type WarnKind } from './warnings';
import { useLayer, useShortcuts } from './keyboard';
import { TableView } from './TableView';
import { localToday } from './iterationOptions';
import { ViewSettingsPanel } from './ViewSettingsPanel';
import { Avatar } from './Avatar';
import type { BoardRequest } from './App';
import { keyText } from './shortcuts';
import { useRepoDrag } from './repoDrag';

function useNow(ms = 15_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
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
function SyncTroubleButton({ trouble, describe }: { trouble: SyncTrouble; describe: (f: SyncTrouble['failed'][number]) => string }) {
  const [open, setOpen] = useState(false);
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
        onClick={() => setOpen(!open)}
      >
        <Icon name="warn" />
      </button>
      {open && <SyncTroublePanel trouble={trouble} describe={describe} box={box} onClose={() => setOpen(false)} />}
    </span>
  );
}

function SyncTroublePanel({
  trouble,
  describe,
  box,
  onClose,
}: {
  trouble: SyncTrouble;
  describe: (f: SyncTrouble['failed'][number]) => string;
  box: RefObject<HTMLSpanElement | null>;
  onClose: () => void;
}) {
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
              </li>
            ))}
          </ul>
        </>
      )}
      {trouble.filterIncomplete && (
        <div className="trouble-filter" data-testid="sync-trouble-filter">
          有来源这次没读全，筛选结果可能不全。
        </div>
      )}
      <div className="trouble-foot">
        <button data-testid="sync-trouble-resync" onClick={() => void api().restartSync()}>
          <Icon name="refresh" />
          重新同步
        </button>
      </div>
    </div>
  );
}

/**
 * GitHub#229: changes that need the user (not saved / not confirmed), also the ones left
 * from the last run. Each item's own list (both values side by side) is in its detail.
 */
function EditsBar({ state, data, onOpen }: { state: AppState; data: BoardData; onOpen: (key: string) => void }) {
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  if (!state.editsNeedingAction) return null;
  const items = data.items.filter((i) => i.edits?.some((m) => m.status === 'failed' || m.status === 'unconfirmed'));
  const go = async (fn: () => Promise<{ ok: boolean; error: string | null } | void>) => {
    setWorking(true);
    setResult(null);
    try {
      const r = await fn();
      if (r && !r.ok) setResult(r.error);
    } finally {
      setWorking(false);
    }
  };
  // GitHub#357: blue while a resend a person asked for is running (the controller's fact, the same one the detail reads)
  const sending = state.editsResending.length > 0;
  const tone = editsTone(sending);
  return (
    <div className={`banner ${tone}`} data-testid="edits-bar" data-count={state.editsNeedingAction} data-kind={tone}>
      {sending ? <span className="spin" aria-hidden="true" /> : <Icon name="warn" />}
      <span className="banner-text">
        有 {state.editsNeedingAction} 处修改没保存上或没确认保存到 GitHub
        {sending && <span data-testid="edits-bar-sending">；正在重新发送…</span>}
        {items.length > 0 && (
          <>
            （
            {items.map((i, n) => (
              <span key={i.key}>
                {n > 0 && '、'}
                <button className="link" data-testid="edits-bar-item" onClick={() => onOpen(i.key)}>
                  {i.repo.split('/')[1]} #{i.number}
                </button>
              </span>
            ))}
            ；打开可逐条看两边的值）
          </>
        )}
        。{' '}
        <button className="link" data-testid="edits-resend-all" disabled={working || sending || !writesEnabled(state.sync)} onClick={() => void go(() => api().resendAllEdits())}>
          全部重新发送
        </button>
        <button className="link" data-testid="edits-abandon-all" disabled={working} onClick={() => void go(() => api().abandonAllEdits())}>
          全部放弃
        </button>
        {result && (
          <span className="small" data-testid="edits-bar-result">
            {' '}
            {result}
          </span>
        )}
      </span>
    </div>
  );
}

/** GitHub#229: one new issue on its way, or what came of it. Only "surely nothing was created" gives the draft back. */
function CreateBar({ job, onOpen, onDraft }: { job: CreateJob; onOpen: (key: string) => void; onDraft: (d: CreateJob['draft']) => void }) {
  const [copied, setCopied] = useState(false);
  // GitHub#357: the colour, "running" and why the last attempt failed all come from the job itself
  // (shared/noticeTone.ts), never from this bar's own memory of a click
  const tone = createTone(job);
  const mark = tone === 'busy' ? <span className="spin" aria-hidden="true" /> : <Icon name="warn" />;
  const working = job.retrying === true || (job.watch ?? []).some((w) => w.busy === true);
  const failures = createFailures(job);
  const close = (
    <button className="banner-close" aria-label="关闭提示" title="关闭提示" data-testid="create-bar-close" onClick={() => void api().dismissCreate(job.id)}>
      <Icon name="x" />
    </button>
  );
  // GitHub#258: created, only boards not ticked still being watched: nothing to say
  if (job.status === 'watching') return null;
  if (job.status === 'running')
    return (
      <div className={`banner ${tone}`} data-testid="create-bar" data-status="running" data-kind={tone}>
        <span className="spin" aria-hidden="true" />
        <span className="banner-text">正在新建「{job.title}」… 建好后自动打开它</span>
      </div>
    );
  if (job.status === 'partial')
    return (
      <div className={`banner ${tone} closable`} data-testid="create-bar" data-status="partial" data-kind={tone}>
        {mark}
        <span className="banner-text">
          <b>#{job.number} 已建好</b>，{job.message?.replace(/^issue #\d+ 已建好，但/, '但') ?? ''}{' '}
          <button className="link" data-testid="create-open" onClick={() => job.createdKey && onOpen(job.createdKey)}>
            打开 #{job.number}
          </button>
          {(job.boards ?? []).some((b) => b.state === 'missing') &&
            (job.retrying ? (
              <span className="small muted" data-testid="create-retrying">
                {' '}
                正在再试加入看板…
              </span>
            ) : (
              <button className="link" data-testid="create-retry-projects" disabled={working} onClick={() => void api().retryCreateProjects(job.id)}>
                再试加入看板
              </button>
            ))}
          {(job.watch ?? [])
            .filter((w) => w.state === 'human')
            .map((w) => (
              <button
                key={w.projectKey}
                className="link"
                data-testid="create-watch-apply"
                data-project={w.projectKey}
                disabled={working}
                onClick={() => void api().applyCreateWatch(job.id, w.projectKey)}
              >
                在「{w.title}」改成「{w.label}」
              </button>
            ))}
          {failures.length > 0 && !working && (
            <span className="small err" data-testid="create-retry-error">
              {' '}
              {failures.join('；')}
            </span>
          )}
        </span>
        {close}
      </div>
    );
  if (job.status === 'unknown')
    return (
      <div className={`banner ${tone} closable`} data-testid="create-bar" data-status="unknown" data-kind={tone}>
        {mark}
        <span className="banner-text">
          <b>不确定「{job.title}」有没有建好</b>：{job.message}。GitHub 可能稍后才建出来，请先去看一眼再决定要不要重建。
          {job.looking && <span data-testid="create-looking">正在查最近建的同标题 issue…</span>}
          {job.lookError && !job.looking && <span data-testid="create-look-error">没能查到最近建的 issue：{job.lookError}。</span>}{' '}
          <button className="link" data-testid="create-web" onClick={() => void api().openExternal(`https://github.com/${job.repo}/issues?q=${encodeURIComponent('is:issue author:@me sort:created-desc')}`)}>
            在网页上看我最近建的 issue
          </button>
          <button
            className="link"
            data-testid="create-copy"
            onClick={() => void copyText(`${job.draft.title}\n\n${job.draft.body}`).then((ok) => setCopied(Boolean(ok)))}
          >
            {copied ? '已复制' : '复制草稿内容'}
          </button>
          {job.candidates && (
            <span className="small muted" data-testid="create-candidates">
              {' '}
              {job.candidates.length
                ? '最近 10 分钟你在这个仓库建的同标题 issue（仅供查看）：'
                : '没找到最近 10 分钟你在这个仓库建的同标题 issue（原请求仍可能稍后完成）'}
              {job.candidates.map((c) => (
                <a key={c.number} href={c.url} data-testid="create-candidate" onClick={(e) => (e.preventDefault(), void api().openExternal(c.url))}>
                  {' '}
                  #{c.number}
                </a>
              ))}
            </span>
          )}
        </span>
        {close}
      </div>
    );
  return (
    <div className={`banner ${tone} closable`} data-testid="create-bar" data-status="failed" data-kind={tone}>
      <Icon name="warn" />
      <span className="banner-text">
        没能新建「{job.title}」：{job.message}。{' '}
        <button
          className="link"
          data-testid="create-reopen"
          onClick={() => {
            onDraft(job.draft);
            void api().dismissCreate(job.id);
          }}
        >
          重新打开草稿
        </button>
      </span>
      {close}
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
  request = null,
  onRequestTaken,
  onSettings,
  onKeysHelp,
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
  /** a shortcut that needs the board (GitHub#192): done once, then handed back */
  request?: BoardRequest | null;
  onRequestTaken?: () => void;
  onSettings: () => void;
  onKeysHelp?: () => void;
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
    () => buildBoard(items, data.projects, view.mode, view.swimlanes, today, view.table.sort, view.prsUnderIssues, state.repoOrder),
    [items, data.projects, view.mode, view.swimlanes, today, view.table.sort, view.prsUnderIssues, state.repoOrder],
  );
  const selected = new Set(view.selected ?? state.sources.map((s) => s.key));
  const titles = new Map(data.projects.map((p) => [p.key, p.title]));
  const failed = sync.sources.filter((s) => !s.ok);
  const trouble = syncTrouble(sync, parsed);
  const labelOf = (sourceKey: string) => {
    const s = state.sources.find((x) => x.key === sourceKey);
    return s ? sourceLabel(s, titles.get(s.key)) : sourceKey;
  };
  const describeFailed = (f: (typeof failed)[number]) => {
    return `${labelOf(f.sourceKey)} 读取失败（${f.error}），显示的是${f.dataFrom ? ` ${ago(f.dataFrom, now)}` : '空'}的数据`;
  };
  const canWrite = writesEnabled(sync) && state.sources.length > 0;
  // every opening of the detail panel is its own panel instance (its React key):
  // going to another item and back is a new opening, never the old one resumed
  const [opened, setOpened] = useState<{ key: string; n: number; intent?: { opId: string; what: 'retry' | 'toReply' } } | null>(null);
  const openSeq = useRef(0);
  const openItem = (key: string) => setOpened((cur) => (cur?.key === key ? cur : { key, n: ++openSeq.current }));
  // a clicked notification (GitHub#169): every click opens that item, as a new opening
  useEffect(() => {
    if (!focus) return;
    setOpened({ key: focus.key, n: ++openSeq.current });
    onFocusTaken?.();
  }, [focus?.seq]);
  // false = closed; true = the plain dialog; a seed = from a table group's "+" (GitHub#214)
  const [newIssue, setNewIssue] = useState<boolean | GroupSeed | { draft: CreateJob['draft'] }>(false);
  const searchBox = useRef<HTMLInputElement>(null);
  // GitHub#323: the bar's note, and the field change a failed one is about (it goes once that change is over)
  const [shownNote, setShownNote] = useState<{ note: ResultNote; watch: NoteEdit[] } | null>(null);
  const note = shownNote?.note ?? null;
  const setNote = (n: ResultNote | null, about?: WriteAction) => {
    const e = n?.kind === 'error' && about ? noteEditOf(about) : null;
    setShownNote(n ? { note: n, watch: e ? [e] : [] } : null);
  };
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
      searchBox.current?.focus();
      searchBox.current?.select();
    } else if (canWrite) setNewIssue(true);
    onRequestTaken?.();
  }, [request?.seq]);
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
    for (const a of actions) {
      const r = await api().act(a);
      if (!r.ok) {
        setBusy(false);
        const done = actions.indexOf(a);
        setNote({ kind: 'error', text: `${done ? `前 ${done} 项已改好；` : ''}${r.error}` }, a);
        return;
      }
      if (r.warning) warn.push(r.warning);
    }
    setBusy(false);
    setNote(noteOf({ ok: true, error: null, warning: warn.join('；') || null }, okText));
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

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    api().setView({ selected: state.sources.map((s) => s.key).filter((k) => next.has(k)) });
  };

  const ended = board.columns.filter((c) => c.ended);
  const shown = board.columns.filter((c) => !c.ended);
  // GitHub#297: with swimlanes, a column is at most half of the board's visible height, and never so tall
  // that this lane's head plus the next lane's head stop fitting in what is left of the board (the window
  // size and every bar above count, as they shrink the board); only below LANE_COL_MIN does it stop shrinking
  const laneFolded = new Set(state.laneFolds);
  const boardRef = useRef<HTMLDivElement>(null);
  const [laneMax, setLaneMax] = useState<number | null>(null);
  const withLanes = view.layout !== 'table' && board.lanes !== null;
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
        <div
          className="sources-pick"
          data-testid="source-pick"
          // a mouse wheel only scrolls up and down; turn it sideways so a plain mouse reaches every source
          onWheel={(e) => {
            const el = e.currentTarget;
            if (e.deltaX === 0 && e.deltaY !== 0 && el.scrollWidth > el.clientWidth) el.scrollLeft += e.deltaY;
          }}
        >
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
            ref={searchBox}
            type="search"
            value={query}
            aria-label="搜索或筛选"
            placeholder="搜索标题、编号、标签，或用 GitHub 写法：label:bug assignee:@me（按 / 跳到这里）"
            title="写法同 GitHub 网页：label:bug -status:Done iteration:@current assignee:@me"
            onChange={(e) => setQuery(e.target.value)}
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
          {trouble && <SyncTroubleButton trouble={trouble} describe={describeFailed} />}
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
            className="primary"
            data-testid="write-entry"
            disabled={!canWrite}
            title={writesEnabled(sync) ? (state.sources.length ? `新建 issue（${keyText('newIssue')}）` : '先添加数据来源') : '离线时不能修改'}
            data-offline={writesEnabled(sync) ? 'no' : 'yes'}
            onClick={() => setNewIssue(true)}
          >
            <Icon name="plus" />
            新建 issue
          </button>
          <button className="icon-btn" onClick={onSettings} data-testid="open-settings" aria-label="设置" title={`设置（${keyText('settings')}）`}>
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
        <button className="ghost" onClick={onKeysHelp} data-testid="open-shortcuts" title={`快捷键一览（${keyText('help')}）`}>
          快捷键 <kbd>?</kbd>
        </button>
      </div>
      {/* GitHub#260: everything under the view bar. The detail panel floats from its top, so bars never push it
          down; while it is open the bars keep to the left of it (the board itself keeps its width, #155) */}
      <div className="below-bar">
      <div className={`board-bars${opened ? ' beside-detail' : ''}`} data-testid="board-bars">
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
      {panel && <ViewSettingsPanel view={view} />}

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
      <EditsBar state={state} data={data} onOpen={openItem} />
      {state.ops
        .filter((r) => !r.dismissed && r.key !== opened?.key)
        .map((r) => (
          <OpNotice
            key={r.id}
            r={r}
            prefix={`${r.repo}#${r.number}：`}
            onOpen={openItem}
            onRetry={(x) => setOpened({ key: x.key, n: ++openSeq.current, intent: { opId: x.id, what: 'retry' } })}
            onToReply={(x) => setOpened({ key: x.key, n: ++openSeq.current, intent: { opId: x.id, what: 'toReply' } })}
          />
        ))}
      {state.creates.map((j) => (
        <CreateBar key={j.id} job={j} onOpen={openItem} onDraft={(d) => setNewIssue({ draft: d })} />
      ))}
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

      </div>
      <div className="board-area">
      {view.layout === 'table' ? (
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
                  {!isFolded && renderRow(lane)}
                </div>
              );
            })
          : renderRow(null)}
      </div>
      )}
      </div>
      {opened && <DetailPanel key={opened.n} itemKey={opened.key} state={state} data={data} onClose={() => setOpened(null)} onLeftBehind={setNote} intent={opened.intent ?? null} />}
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
