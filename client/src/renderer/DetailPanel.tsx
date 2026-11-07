import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AppState, BoardData, EditMark } from '../shared/types';
import { ISSUE_CLOSE_REASONS, type IssueCloseReason, type ItemDetail, type MergeMethod, type RepoOptions, type WriteAction, type WriteResult } from '../shared/actions';
import { writesEnabled } from '../data/board';
import { api } from './api';
import { ConfirmDialog } from './ConfirmDialog';
import { pickMergeMethod } from '../shared/mergePrefs';
import { FRAME_SANDBOX, TIMELINE_SANDBOX, timelineDocument, escapeHtml, FRAME_CSP, type FrameView, type Unfold } from './detailHtml';
import { renderedTaskBoxes } from '../data/taskList';
import { Person } from './Avatar';
import { usePanelWidth } from './panelWidth';
import { labelStyle, useDarkMode } from './colors';
import { Icon } from './Icons';
import { createOpenSession, type OpenSession } from './openSession';
import { KindBadge } from './KindBadge';
import { hidesPanel, pressAt, releaseAt, releaseOfClick, type Press, type Release } from './outsideClick';
import { useShortcuts } from './keyboard';
import { LabelPicker } from './LabelPicker';
import { Keys } from './ShortcutHelp';
import { isMac, keyParts, keyText, SHORTCUTS } from './shortcuts';
import { copyText, isImageOnlyPaste, PASTE_IMAGE_NOTE } from './pasteImage';
import { freshMark, sameDetail, shouldAutoRefresh } from './autoRefresh';
import { IterationOptions, localToday } from './iterationOptions';
import { opDraftLeft, opLockOf, opText, type OpRecord } from '../shared/ops';
import { OpNotice } from './OpNotice';

const METHOD_LABEL: Record<MergeMethod, string> = { merge: '合并提交（merge commit）', squash: '压成一个提交（squash）', rebase: '变基（rebase）' };
const MERGEABLE: Record<string, string> = { MERGEABLE: '没有冲突', CONFLICTING: '有冲突', UNKNOWN: 'GitHub 还在计算能否合并' };
const MERGE_STATE: Record<string, string> = {
  CLEAN: '可以合并',
  BLOCKED: '被分支保护规则挡住（缺评审或必需检查没过）',
  BEHIND: '落后目标分支，规则要求先更新',
  DIRTY: '有冲突，合不了',
  UNSTABLE: '能合并，但有检查没通过',
  HAS_HOOKS: '可以合并（有合并前钩子）',
  DRAFT: '草稿 PR，不能合并',
  UNKNOWN: 'GitHub 还在计算',
};
const CHECKS: Record<string, string> = { SUCCESS: '全部通过', FAILURE: '有失败', ERROR: '出错', PENDING: '进行中', EXPECTED: '等待中' };
const CLOSE_REASON: Record<IssueCloseReason, { name: string; hint: string }> = {
  completed: { name: '已完成', hint: '做完了 / 问题已解决' },
  not_planned: { name: '不计划', hint: '不做了、不是问题' },
};
/** the panel's own "put it away" button: not "关闭", which on an issue / PR means closing it on GitHub (GitHub#180) */
const HIDE_LABEL = '收起 ›';
const HIDE_TITLE = '收起（或点面板以外的地方、按 Esc；回复框里有没发出的文字时都不收起；点过讨论后，先点一下讨论以外的地方再按 Esc）';
const REVIEW: Record<string, string> = { APPROVED: '已批准', CHANGES_REQUESTED: '要求修改', REVIEW_REQUIRED: '需要评审' };

export type ResultNote = { kind: 'ok' | 'error' | 'warn'; text: string };

export function noteOf(r: WriteResult, okText: string): ResultNote {
  if (!r.ok) return { kind: 'error', text: `${r.error ?? '没有成功'}` };
  if (r.warning) return { kind: 'warn', text: `${okText}。注意：${r.warning}` };
  return { kind: 'ok', text: okText };
}

export function ResultBanner({ note, testid }: { note: ResultNote | null; testid: string }) {
  if (!note) return null;
  return (
    <div className={`banner ${note.kind === 'error' ? 'error' : note.kind === 'warn' ? 'warn' : 'info'}`} data-testid={testid} data-kind={note.kind}>
      <Icon name={note.kind === 'ok' ? 'check' : 'warn'} />
      <span className="banner-text">{note.text}</span>
    </div>
  );
}

/** GitHub#229: what a change on its way says next to its field. */
export const EDIT_WORDS: Record<EditMark['status'], string> = {
  saving: '保存中…',
  verifying: '已保存，待核对',
  observing: '已保存，观察中',
  unconfirmed: '没确认',
  failed: '没保存上',
};

/** The small status next to a milestone / status / iteration that is on its way (the others are listed above the fields). */
function EditStatus({ mark, field }: { mark: EditMark | null; field: EditMark['field'] }) {
  if (!mark || mark.status === 'failed' || mark.status === 'unconfirmed') return null;
  return (
    <span className="saving" data-testid="edit-status" data-field={field} data-edit={mark.status}>
      {mark.status === 'saving' && <span className="spin" aria-hidden="true" />}
      {EDIT_WORDS[mark.status]}
    </span>
  );
}

function at(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * GitHub#229: the changes of this item that need the user — not saved (GitHub refused, or
 * it read back an earlier change's value) or not confirmed (no answer). Each shows what the
 * user wants beside what GitHub holds, and offers to send it again or give it up. A resend
 * reads GitHub first and is held back when somebody changed it (or it could not be read):
 * then only an explicit "overwrite anyway" / "send anyway" sends it.
 */
export function EditIssues({ marks, canWrite }: { marks: EditMark[]; canWrite: boolean }) {
  const [working, setWorking] = useState<string | null>(null);
  const open = marks.filter((m) => m.status === 'failed' || m.status === 'unconfirmed');
  if (!open.length) return null;
  const go = async (id: string, fn: () => Promise<unknown>) => {
    setWorking(id);
    try {
      await fn();
    } finally {
      setWorking(null);
    }
  };
  return (
    <div className="banner error edit-issues" data-testid="edit-issues">
      <Icon name="warn" />
      <div className="banner-text">
        <b>{open.length} 处修改{open.some((m) => m.status === 'failed') ? '没保存上' : '没确认'}</b>
        {open.map((m) => (
          <div key={m.id} className="edit-issue" data-testid="edit-issue" data-id={m.id} data-edit={m.status} data-field={m.field}>
            <div>
              你要{m.field === 'label' ? '' : '设成：'}
              <b data-testid="edit-target">{m.targetText}</b> <span className="muted small">{m.status === 'failed' ? '没保存上' : '没确认'}</span>
            </div>
            <div className={`small${m.changedByOthers ? ' err' : ''}`} data-testid="edit-github">
              {!m.github
                ? 'GitHub 现在：还没读到'
                : 'unreadable' in m.github
                  ? `GitHub 现在：读不到（${m.github.unreadable}），没法确认有没有人改过`
                  : `GitHub 现在：${m.github.text}（${at(m.github.at)} 读到）${m.changedByOthers ? '，你改之后有人改过' : ''}`}
            </div>
            {m.failure && (
              <div className="small" data-testid="edit-failure">
                {m.failure}
              </div>
            )}
            {m.hold && (
              <div className="small err" data-testid="edit-hold">
                {m.hold.text}
              </div>
            )}
            <div className="row" style={{ margin: '2px 0 0' }}>
              {m.hold ? (
                <button className="link" data-testid="edit-force" disabled={!canWrite || working !== null} onClick={() => void go(m.id, () => api().resendEdit(m.id, true))}>
                  {m.hold.kind === 'changed' ? '仍然覆盖' : '仍然发送'}
                </button>
              ) : (
                <button className="link" data-testid="edit-resend" disabled={!canWrite || working !== null} onClick={() => void go(m.id, () => api().resendEdit(m.id))}>
                  重新发送
                </button>
              )}
              <button
                className="link"
                data-testid="edit-abandon"
                disabled={working !== null}
                title="不再显示这处修改，显示 GitHub 上的值；没确认的那次请求如果之后才执行，下一次同步会如实显示 GitHub 的值"
                onClick={() => void go(m.id, () => api().abandonEdit(m.id))}
              >
                放弃
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** GitHub#205: an image was pasted where it cannot be uploaded from; offer the web page instead. */
export function PasteImageNotice({
  copied,
  onWeb,
  onDismiss,
  webLabel = '到 GitHub 网页上继续写',
  webBlocked = '',
}: {
  copied: boolean | null;
  onWeb: () => void;
  onDismiss: () => void;
  webLabel?: string;
  /** why the web page cannot be opened yet ('' = it can) — GitHub#245: the hand-over labels are still being read */
  webBlocked?: string;
}) {
  return (
    <div className="banner warn paste-image" data-testid="paste-image-note">
      <Icon name="warn" />
      <span className="banner-text">
        {PASTE_IMAGE_NOTE}
        {copied === true && ' 你写的文字已复制，在网页上粘贴后再贴图。'}
        {copied === false && ' 没能复制你写的文字，请先手动复制。'}
      </span>
      <button data-testid="paste-image-web" onClick={onWeb} disabled={Boolean(webBlocked)} title={webBlocked || undefined}>
        {webLabel}
      </button>
      <button className="ghost" data-testid="paste-image-dismiss" onClick={onDismiss}>
        知道了
      </button>
    </div>
  );
}

/** HH:MM of an epoch-ms time, local clock */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function DetailPanel({
  itemKey,
  state,
  data,
  onClose,
  onLeftBehind,
  intent,
}: {
  itemKey: string;
  state: AppState;
  data: BoardData;
  onClose: () => void;
  /** GitHub#250: opened from a notice above the board to do this with one of the item's operations */
  intent?: { opId: string; what: 'retry' | 'toReply' } | null;
  /** a change made on an item the panel has since left: its result goes to the board instead */
  onLeftBehind: (note: ResultNote) => void;
}) {
  const item = data.items.find((i) => i.key === itemKey) ?? null;
  // One panel instance = one opening (the board gives every opening its own
  // React key). Every late answer goes through `session` (openSession.ts):
  // after the opening ended, or once a newer call of the same kind started,
  // it may not touch this panel.
  const sessionRef = useRef<OpenSession | null>(null);
  if (!sessionRef.current) sessionRef.current = createOpenSession();
  const session = sessionRef.current;
  useEffect(() => () => session.end(), [session]);
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [opts, setOpts] = useState<RepoOptions | null>(null);
  const [busy, setBusy] = useState(false);
  /** GitHub#229: label / milestone / status / iteration changes of this opening still waiting for GitHub (nothing waits for them, but a sync round does not read the detail meanwhile) */
  const [changing, setChanging] = useState(0);
  const [note, setNote] = useState<ResultNote | null>(null);
  const [reply, setReply] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  /** GitHub#205: the body / comment being edited (its source when the edit started), and the text so far */
  const [editing, setEditing] = useState<{ entryId: string; kind: 'body' | 'comment'; url: string; source: string; text: string } | null>(null);
  const [editNote, setEditNote] = useState<ResultNote | null>(null);
  /** GitHub#205: an image was pasted into the reply / edit box (it cannot be uploaded from here) */
  const [pasted, setPasted] = useState<{ where: 'reply' | 'edit'; copied: boolean | null } | null>(null);
  /** the method picked by hand in this opening; null = none yet */
  const [picked, setPicked] = useState<MergeMethod | null>(null);
  const [ask, setAsk] = useState<'merge' | 'close' | 'closeIssue' | 'autopilot' | null>(null);
  /** GitHub#231: "不再提示" in the 托管 dialog, unticked every time it opens */
  const [noMoreAsk, setNoMoreAsk] = useState(false);
  const [closeComment, setCloseComment] = useState('');
  const [closeReason, setCloseReason] = useState<IssueCloseReason>('completed');
  /** GitHub#250: the dialog was opened again from an operation's notice: its draft moves to the new one */
  const [retryFrom, setRetryFrom] = useState<string | null>(null);
  /** GitHub#250: the operation refused at once (nothing sent): said inside the dialog, which stays */
  const [dialogNote, setDialogNote] = useState<ResultNote | null>(null);
  /** GitHub#250: the reply box holds an operation's kept comment: sent = that draft is done */
  const [replyFromOp, setReplyFromOp] = useState<string | null>(null);
  /** the label / milestone picker that is open (GitHub#192) */
  const [picker, setPicker] = useState<'labels' | 'milestone' | null>(null);
  /** Esc was pressed while the reply box held unsent text: the panel stayed, say why */
  const [escKept, setEscKept] = useState(false);
  const replyBox = useRef<HTMLTextAreaElement>(null);
  const canWrite = writesEnabled(state.sync);
  const offlineWhy = canWrite ? undefined : '离线时不能修改';
  const repo = item?.repo ?? '';

  // GitHub#226: the board's `updatedAt` of this item when the detail on screen was read. Set only
  // when a read lands: a read that was dropped, superseded or failed leaves it, so the next round tries again.
  const itemRef = useRef(item);
  itemRef.current = item;
  const readAt = useRef<string | null>(null);
  /** an automatic re-read failed: what is on screen was last confirmed by a read at this time (epoch ms) */
  const [autoFailed, setAutoFailed] = useState<number | null>(null);
  /**
   * When GitHub last confirmed what is on screen: every read that lands moves it, also one with the
   * same content (the object on screen is kept then, so its own read time is older). A read that
   * failed or was dropped never moves it.
   */
  const confirmedAt = useRef<number | null>(null);
  /**
   * Read the detail. `quiet`: a read nobody asked for (a sync round, the re-read after a
   * failed change) — a failure keeps what is on screen and says so in small print, no error
   * banner; with nothing on screen yet it shows the banner like any read.
   */
  const load = useCallback(
    async (quiet = false) => {
      const mine = session.begin('detail');
      const seen = itemRef.current?.updatedAt ?? null;
      setLoading(true);
      const r = await api().loadDetail(itemKey);
      if (!mine()) return;
      setLoading(false);
      if (r.ok) {
        readAt.current = seen;
        confirmedAt.current = r.detail.fetchedAt;
        setFromCache(null);
        // same content: keep the object on screen, so the frame is not rendered again
        setDetail((prev) => (sameDetail(prev, r.detail) ? prev : r.detail));
        setLoadError(null);
        setAutoFailed(null);
      } else {
        const shown = detailRef.current;
        if (quiet && shown) setAutoFailed(confirmedAt.current ?? shown.fetchedAt);
        else setLoadError(r.error);
      }
    },
    [itemKey, session],
  );

  // a fresh panel per opening: show what this run read last (GitHub#229), then read
  const [fromCache, setFromCache] = useState<number | null>(null);
  useEffect(() => {
    void (async () => {
      const kept = await api().cachedDetail(itemKey);
      if (!session.current()) return;
      if (kept && !detailRef.current) {
        confirmedAt.current = kept.fetchedAt;
        setDetail(kept);
        setFromCache(kept.fetchedAt);
      }
      // with something on screen the opening read is a quiet one: a failure keeps it and says so in small print
      void load(Boolean(kept));
    })();
  }, [load, itemKey, session]);
  // GitHub#226: a sync round read a source carrying this item completely → maybe read the detail again.
  // The mark the panel opened with is not a new round (the opening read is already on its way).
  const mark = freshMark(item, state.sync.sources);
  const lastMark = useRef(mark);
  useEffect(() => {
    if (mark === lastMark.current) return;
    lastMark.current = mark;
    if (mark === null) return;
    if (shouldAutoRefresh({ item, readAt: readAt.current, detail, busy: busy || changing > 0, loading })) void load(true);
    // only a new round decides; the values are this render's
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mark]);
  // GitHub#229: the refresh button and "重试" read the labels / milestones again (a failed read used to stay until the panel closed)
  const [optsRound, setOptsRound] = useState(0);
  useEffect(() => {
    if (!repo) return;
    const mine = session.begin('options');
    api()
      .repoOptions(repo, optsRound > 0)
      .then((o) => mine() && setOpts((prev) => (o.error && prev && !prev.error ? prev : o)));
  }, [repo, session, optsRound]);
  const rereadOptions = () => setOptsRound((n) => n + 1);
  // What the merge box starts with (GitHub#175): a hand pick of this opening while the repository
  // (as last read) still allows it, else the remembered one. Derived, never stored: a detail that
  // arrives late or is re-read cannot overwrite the pick, and a fallback is never remembered.
  const allowed = detail?.pr?.mergeMethods ?? [];
  const method: MergeMethod | '' = picked && allowed.includes(picked) ? picked : pickMergeMethod(state.mergePrefs, repo, allowed);

  /**
   * `here` is false when this opening ended while the change was in flight (the
   * panel closed, went to another item, or left and came back: that is a new
   * opening with its own draft). The result then goes to the board, never into
   * whatever panel is on screen.
   */
  /**
   * GitHub#250: close / merge / autopilot / hand-back start in the background and hold nothing:
   * true = started (the dialog closes), false = refused before anything was sent (said here).
   */
  const startOp = async (action: Parameters<ReturnType<typeof api>['startOp']>[0], inDialog: boolean): Promise<boolean> => {
    // GitHub#226: a read already on its way carries GitHub as it was before this change — it never lands
    session.supersede('detail');
    setLoading(false);
    const from = retryFrom ?? undefined;
    const r = await api().startOp(action, from);
    if (!session.current()) return r.ok;
    if (!r.ok) {
      const n: ResultNote = { kind: 'error', text: r.error ?? '没有发送' };
      if (inDialog) setDialogNote(n);
      else setNote(n);
      return false;
    }
    setRetryFrom(null);
    setDialogNote(null);
    setNote(null);
    return true;
  };
  const runAutopilot = () => startOp({ kind: 'autopilot', key: item!.key }, ask === 'autopilot');
  /** the dialog of an operation again, its draft restored (GitHub#250) */
  const retryOp = (r: OpRecord) => {
    const d = opDraftLeft(r) ?? {};
    setRetryFrom(r.id);
    setDialogNote(null);
    if (r.kind === 'closeIssue') {
      if (d.reason) setCloseReason(d.reason);
      setCloseComment(d.comment ?? '');
      setAsk('closeIssue');
    } else if (r.kind === 'closePr') {
      setCloseComment(d.comment ?? '');
      setAsk('close');
    } else if (r.kind === 'merge') {
      if (d.method) setPicked(d.method);
      setAsk('merge');
    } else if (r.kind === 'autopilot') {
      setNoMoreAsk(false);
      setAsk('autopilot');
    } else {
      void (async () => {
        setRetryFrom(r.id);
        const res = await api().startOp({ kind: 'handBack', key: r.key }, r.id);
        if (!session.current()) return;
        setRetryFrom(null);
        setNote(res.ok ? null : { kind: 'error', text: res.error ?? '没有发送' });
      })();
    }
  };
  const toReply = (r: OpRecord) => {
    const c = opDraftLeft(r)?.comment;
    if (c === undefined) return;
    setReply((cur) => (cur.trim() ? `${cur}\n\n${c}` : c));
    setReplyFromOp(r.id);
    session.supersede('preview');
    setPreview(null);
    replyBox.current?.focus();
  };
  const run = async (action: WriteAction, okText: string): Promise<WriteResult & { here: boolean }> => {
    const label = item ? `${item.repo}#${item.number}` : itemKey;
    const mine = session.begin('write');
    // GitHub#226: a read already on its way carries GitHub as it was before this change — it never
    // lands; the read after the change does (both ways it ends, so the panel never stays behind)
    session.supersede('detail');
    setLoading(false);
    setBusy(true);
    const r = await api().act(action);
    if (!mine()) {
      onLeftBehind(noteOf(r, `${label}：${okText}`));
      return { ...r, here: false };
    }
    setBusy(false);
    setNote(noteOf(r, okText));
    // refused or failed: read again too, so the panel shows what GitHub holds now (the change's own banner says what went wrong)
    void load(!r.ok);
    return { ...r, here: true };
  };

  /**
   * GitHub#229: a label / milestone / status / iteration change. It shows at once (the board
   * data carries it, marked), nothing else in the panel waits for it; the outcome comes in a
   * note when GitHub answered. A change made here and answered after the panel moved on
   * goes to the board like any other.
   */
  const change = async (action: WriteAction, okText: string): Promise<WriteResult> => {
    const label = item ? `${item.repo}#${item.number}` : itemKey;
    // GitHub#226: a detail read already on its way carries GitHub as it was before this change — it never lands
    session.supersede('detail');
    setLoading(false);
    setChanging((n) => n + 1);
    let r: WriteResult;
    try {
      r = await api().act(action);
    } finally {
      setChanging((n) => n - 1);
    }
    if (!session.current()) {
      onLeftBehind(noteOf(r, `${label}：${okText}`));
      return r;
    }
    setNote(noteOf(r, okText));
    // read again either way, so the panel shows what GitHub holds now
    void load(!r.ok);
    return r;
  };
  const marks = item?.edits ?? [];
  const markFor = (field: EditMark['field'], extra: { label?: string; projectKey?: string } = {}) =>
    marks.find((m) => m.field === field && (extra.label === undefined || m.label === extra.label) && (extra.projectKey === undefined || m.projectKey === extra.projectKey)) ?? null;

  // which entries are unfolded: the newest only, until the user asks for all / none (GitHub#155)
  const [unfold, setUnfoldRule] = useState<Unfold>('latest');
  const isDark = useDarkMode();
  // what the frame last reported (unfolded entries, scroll): a re-render puts it back (GitHub#193)
  const viewRef = useRef<FrameView | null>(null);
  const setUnfold = (u: Unfold) => {
    viewRef.current = null;
    setUnfoldRule(u);
  };
  // bumped to render the frame again as it was (e.g. a click on a box that was not sent): the box shows its real state
  const [redraw, setRedraw] = useState(0);
  const renderSeq = useRef(0);
  const canTick = canWrite && !busy;
  const frame = useMemo(() => {
    if (!detail) return { doc: '', render: '' };
    const render = `r${++renderSeq.current}`;
    return { doc: timelineDocument(detail, isDark, unfold, { render, canTick, view: viewRef.current }), render };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, unfold, isDark, canTick, redraw]);
  const doc = frame.doc;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  /** the rendering whose script reported in: the frame's script ran (tests wait on it) */
  const [readyRender, setReadyRender] = useState('');

  /** A box was ticked in the frame. Sent only when everything the window knows says it may be. */
  const tick = async (entryId: unknown, index: unknown, checked: unknown) => {
    const e = detail?.timeline.find((x) => x.id === entryId && (x.kind === 'body' || x.kind === 'comment'));
    const t = e?.tasks;
    const count = e ? renderedTaskBoxes(e.bodyHtml).length : 0;
    if (!item || !e || !t?.clickable || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count || typeof checked !== 'boolean' || !canWrite || busy) {
      setRedraw((n) => n + 1);
      return;
    }
    const r = await run(
      { kind: 'toggleTask', key: item.key, entryId: e.id, index, checked, seenSource: t.source },
      checked ? '已勾上，GitHub 上已更新' : '已取消勾选，GitHub 上已更新',
    );
    // refused or failed: the box goes back to what is on screen at once, and `run` reads again, so it
    // ends up showing what GitHub holds now (a re-read with the same content does not redraw by itself)
    if (r.here && !r.ok) setRedraw((n) => n + 1);
  };
  // What the listener below reads: the latest values of this render, set before the frame can load.
  /** GitHub#205: "edit" was clicked in the frame. Opened only for an entry GitHub said this account may change. */
  const edit = (entryId: unknown) => {
    const e = detail?.timeline.find((x) => x.id === entryId && (x.kind === 'body' || x.kind === 'comment'));
    if (!e || e.editSource === undefined || !canWrite || busy || editing) return;
    setEditNote(null);
    setEditing({ entryId: e.id, kind: e.kind as 'body' | 'comment', url: e.url, source: e.editSource, text: e.editSource });
  };
  const live = useRef({ tick, edit, render: frame.render, ids: [] as string[] });
  live.current = { tick, edit, render: frame.render, ids: detail?.timeline.map((x) => x.id) ?? [] };
  // One listener for the panel's whole life, in place before the first frame loads (a layout effect
  // runs right after the frame is inserted, before its document can run): a frame that loads fast
  // must not report before anyone listens.
  useLayoutEffect(() => {
    const on = (ev: MessageEvent) => {
      const f = frameRef.current;
      // only the frame on screen, only its current rendering: anything else is dropped
      if (!f || ev.source !== f.contentWindow) return;
      const m = ev.data as { cavil?: unknown; render?: unknown; view?: unknown; entry?: unknown; index?: unknown; checked?: unknown } | null;
      const now = live.current;
      if (!m || typeof m !== 'object' || m.render !== now.render) return;
      const v = m.view as { open?: unknown; scroll?: unknown } | undefined;
      if (v && Array.isArray(v.open) && typeof v.scroll === 'number')
        viewRef.current = { known: now.ids, open: v.open.filter((x): x is string => typeof x === 'string'), scroll: v.scroll };
      if (m.cavil === 'ready') setReadyRender(now.render);
      else if (m.cavil === 'task') void now.tick(m.entry, m.index, m.checked);
      else if (m.cavil === 'edit') now.edit(m.entry);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);
  const { width, dragging, startDrag } = usePanelWidth(state.view.detailWidth);
  // the board leaves this much room to scroll past the panel (BoardView's spacer)
  useEffect(() => {
    document.documentElement.style.setProperty('--detail-space', `${width}px`);
  }, [width]);
  // ---- keyboard (GitHub#192): each key presses a button, behind that button's own enabled condition ----
  const sendBlocked = !item || !canWrite || busy || !reply.trim();
  const previewBlocked = !item || !canWrite || !reply.trim();
  /** the label / milestone controls: the same condition as their buttons */
  const pickBlocked = !item || !canWrite || !opts;
  const send = async () => {
    if (!item) return;
    const r = await run({ kind: 'comment', key: item.key, body: reply }, '评论已发出');
    if (r.ok && r.here) {
      // GitHub#250: the operation's kept comment went out with this reply
      if (replyFromOp) void api().opDropDraft(replyFromOp);
      setReplyFromOp(null);
      setReply('');
      setPreview(null);
      setEscKept(false);
      setPasted(null);
    }
  };
  const togglePreview = async () => {
    if (!item) return;
    if (preview !== null) return setPreview(null);
    const mine = session.begin('preview');
    const r = await api().previewMarkdown(item.repo, reply);
    if (!mine()) return;
    setPreview(r.ok ? (r.html ?? '') : `<p>${escapeHtml(r.error ?? '预览失败')}</p>`);
  };
  useShortcuts({
    labels: () => {
      if (!pickBlocked) setPicker('labels');
    },
    milestone: () => {
      if (!pickBlocked) setPicker('milestone');
    },
    reply: () => replyBox.current?.focus(),
    // Esc puts the panel away — never while the reply box holds unsent text: a key never drops a draft.
    // (Dialogs and pickers are layers: their Esc never gets here. Neither does a key pressed inside the
    // isolated discussion frame — PR #171, the maintainer chose to keep it isolated; its one script since
    // GitHub#193 reports ticked boxes and the view, never keys.)
    hide: () => {
      if (reply.trim()) {
        setEscKept(true);
        return;
      }
      onClose();
    },
    send: () => {
      if (!sendBlocked) void send();
    },
    preview: () => {
      if (!previewBlocked) void togglePreview();
    },
    leaveReply: () => replyBox.current?.blur(),
  });

  // A click outside the panel puts it away (GitHub#191; the rule is outsideClick.ts): not on a card or
  // a row title (those switch items), not while a dialog was open, not with a reply typed.
  const panelRef = useRef<HTMLElement | null>(null);
  const draftRef = useRef(reply);
  draftRef.current = reply;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    let press: Press | null = null;
    let release: Release | null = null;
    const down = (e: PointerEvent) => {
      press = pressAt(e, panelRef.current);
      release = null;
    };
    // where the button really went up: the click's own target is the common ancestor of press and release
    const up = (e: PointerEvent) => {
      release = releaseAt(e, panelRef.current);
    };
    const click = (e: MouseEvent) => {
      const p = press;
      const r = releaseOfClick(e, release);
      press = null;
      release = null;
      if (hidesPanel(p, r, draftRef.current)) closeRef.current();
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('click', click, true);
    };
  }, []);
  // ---- GitHub#250: this item's operations ----
  const myOps = state.ops.filter((r) => r.key === itemKey);
  const lock = opLockOf(state.ops, itemKey);
  const lockWhy = lock ? `上一次操作还没结清：${opText(lock)}` : undefined;
  // an operation got an answer or settled: read the detail again, so the panel shows what GitHub holds now
  const opSig = myOps.map((r) => `${r.id}:${r.steps.map((x) => x.state).join(',')}:${r.readAt ?? ''}`).join('|');
  const seenSig = useRef(opSig);
  useEffect(() => {
    if (opSig === seenSig.current) return;
    seenSig.current = opSig;
    void load(true);
  }, [opSig, load]);
  // opened from a notice above the board (GitHub#250): do what was asked there, once
  const intentDone = useRef(false);
  useEffect(() => {
    if (intentDone.current || !intent || !item) return;
    const r = state.ops.find((x) => x.id === intent.opId);
    intentDone.current = true;
    if (!r) return;
    if (intent.what === 'retry') retryOp(r);
    else toReply(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent, item]);
  const openAsk = (k: 'merge' | 'close' | 'closeIssue' | 'autopilot') => {
    setRetryFrom(null);
    setDialogNote(null);
    setAsk(k);
  };
  const cancelAsk = () => {
    setAsk(null);
    setRetryFrom(null);
    setDialogNote(null);
  };

  const shell = (key: string | undefined, children: React.ReactNode) => (
    // tabIndex: a click on the panel's own blank space takes the keyboard back from the discussion frame,
    // whose keys never reach this window (another origin; its own script forwards no keys) — Esc works again after it
    <aside ref={panelRef} className={`detail${dragging ? ' resizing' : ''}`} data-testid="detail" data-key={key} style={{ width }} data-width={width} tabIndex={-1}>
      <div className="detail-resize" data-testid="detail-resize" title="拖动改宽度" onPointerDown={startDrag} />
      {children}
    </aside>
  );

  if (!item) {
    return shell(
      undefined,
      <>
        <div className="detail-head">
          <span className="muted">这一条已不在当前视图里</span>
          <div className="spacer" />
          <button className="ghost" onClick={onClose} data-testid="detail-close" title={HIDE_TITLE}>
            {HIDE_LABEL}
          </button>
        </div>
      </>,
    );
  }

  const metaOf = (k: string) => data.projects.find((p) => p.key === k);
  const pr = detail?.pr ?? null;
  const prOpen = item.kind === 'pr' && detail?.state === 'open';
  // only once the detail read says it is open: the board's copy may be a round behind
  const issueOpen = item.kind === 'issue' && detail?.state === 'open';
  // GitHub#205: a conflict is said loudly, and the merge button is off (GitHub refuses the merge anyway)
  const conflict = Boolean(pr && prOpen && (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY'));
  const conflictWhy = '有冲突，GitHub 不能合并：先在分支上解决冲突（或在网页上点「Resolve conflicts」）';
  // the buttons need the detail read (labels can be changed on a closed item too: it may be waiting for a decision)
  const detailRead = Boolean(detail);
  const hb = state.handBack;
    const msTitles = [...new Set((opts?.milestones ?? []).map((m) => m.title))];

  return shell(
    item.key,
    <>
      <div className="detail-head">
        {/* a detail shown from this run's memory (GitHub#229) is older than the board: the board's draft mark wins until it is read again */}
        <KindBadge kind={item.kind} state={item.state} reason={item.stateReason} isDraft={detail?.pr && fromCache === null ? detail.pr.isDraft : (item.isDraft ?? detail?.pr?.isDraft ?? null)} />
        <span className="ref">
          {item.repo} #{item.number}
        </span>
        {/* GitHub#229: author and assignees moved up from the field rows, to keep the head short */}
        <span className="head-people" data-testid="detail-people">
          <span className="sep">·</span>
          <Person login={item.author} size={16} />
          {item.assignees.length > 0 && (
            <>
              <span className="muted small">负责人</span>
              <span className="people">
                {item.assignees.map((a) => (
                  <Person key={a} login={a} size={16} />
                ))}
              </span>
            </>
          )}
        </span>
        <div className="spacer" />
        <button className="icon-btn" onClick={() => api().openExternal(item.url)} data-testid="detail-open-web" aria-label="在网页打开" title="在网页打开">
          <Icon name="ext" />
        </button>
        {/* clickable while reading too (GitHub#217): a newer read supersedes the one in flight */}
        <button
          className={`icon-btn${loading ? ' spinning' : ''}`}
          onClick={() => {
            void load();
            rereadOptions();
          }}
          data-testid="detail-refresh"
          data-loading={loading ? 'yes' : 'no'}
          aria-label={loading ? '读取中…（点一下重新读取）' : '刷新这一条'}
          title={loading ? '读取中…（点一下：重新读取）' : '刷新这一条（连同标签 / 里程碑列表）'}
        >
          <Icon name="refresh" />
        </button>
        <button className="ghost" onClick={onClose} data-testid="detail-close" title={HIDE_TITLE}>
          {HIDE_LABEL}
        </button>
      </div>
      <h3 className="detail-title">{item.title}</h3>
      {fromCache !== null && !loadError && autoFailed === null && (
        <div className="detail-stale muted" data-testid="detail-cached" role="status">
          显示 {clock(fromCache)} 读到的内容{loading ? ' · 正在更新…' : ''}
        </div>
      )}
      <ResultBanner note={note} testid="action-result" />
      {myOps
        .filter((r) => !r.dismissed)
        .map((r) => (
          <OpNotice key={r.id} r={r} onRetry={retryOp} onToReply={toReply} />
        ))}
      {myOps
        .filter((r) => r.dismissed && opDraftLeft(r))
        .map((r) => (
          <div key={r.id} className="detail-stale small op-draft-line">
            <button className="link" data-testid="op-draft-line" onClick={() => void api().opDismiss(r.id, false)}>
              {opDraftLeft(r)?.comment !== undefined ? '有一条没发出的附带评论' : '有一次没完成的操作的草稿'}，点这里找回
            </button>
          </div>
        ))}
      {loadError && (
        <div className="banner error" data-testid="detail-error">
          <Icon name="warn" />
          <span className="banner-text">{loadError}</span>
        </div>
      )}
      {autoFailed !== null && !loadError && (
        <div className="detail-stale muted" data-testid="detail-stale" role="status">
          自动更新失败，显示的是 {clock(autoFailed)} 的内容
        </div>
      )}
      <EditIssues marks={marks} canWrite={canWrite} />

      <section className="detail-fields">
        <div className="field-row">
          <span className="field-name">标签</span>
          <div className="labels">
            {item.labels.map((l) => {
              const m = markFor('label', { label: l.name });
              const pend = m && (m.status === 'saving' || m.status === 'verifying' || m.status === 'observing') ? m : null;
              return (
                <span
                  key={l.name}
                  className={`label${pend ? ' pending' : ''}`}
                  style={labelStyle(l.color, isDark)}
                  data-testid="detail-label"
                  data-label={l.name}
                  data-edit={pend?.status ?? ''}
                  title={pend ? EDIT_WORDS[pend.status] : undefined}
                >
                  {pend?.status === 'saving' && <span className="spin" aria-hidden="true" />}
                  {l.name}
                  <button
                    className="label-x"
                    data-testid="label-remove"
                    data-label={l.name}
                    title={offlineWhy ?? `去掉「${l.name}」`}
                    disabled={!canWrite}
                    onClick={() => void change({ kind: 'removeLabel', key: item.key, label: l.name }, `已去掉标签「${l.name}」`)}
                  >
                    <Icon name="x" size={10} />
                  </button>
                </span>
              );
            })}
            {marks
              .filter((m) => m.field === 'label' && m.label && !item.labels.some((l) => l.name === m.label) && (m.status === 'saving' || m.status === 'verifying' || m.status === 'observing'))
              .map((m) => (
                <span key={m.id} className="label pending removing" style={labelStyle(m.color ?? '', isDark)} data-testid="detail-label-removing" data-label={m.label} data-edit={m.status} title={`正在去掉 · ${EDIT_WORDS[m.status]}`}>
                  {m.label}
                </span>
              ))}
            {marks.some((m) => m.field === 'label' && (m.status === 'saving' || m.status === 'verifying' || m.status === 'observing')) && (
              <span className="saving" data-testid="edit-status" data-field="label">
                {EDIT_WORDS[marks.find((m) => m.field === 'label' && (m.status === 'saving' || m.status === 'verifying' || m.status === 'observing'))!.status]}
              </span>
            )}
            <span className="picker-anchor">
              <button
                className="label-plus"
                data-testid="label-add"
                disabled={pickBlocked}
                title={offlineWhy ?? (opts?.error ? opts.error : `候选来自 ${item.repo} 的标签（${keyText('labels')}）`)}
                onClick={() => setPicker(picker === 'labels' ? null : 'labels')}
              >
                {opts ? '+ 加标签' : '读取标签…'}
                <kbd>{keyText('labels')}</kbd>
              </button>
              {picker === 'labels' && opts && (
                <LabelPicker
                  title="设置标签"
                  hint={item.repo}
                  testid="label-picker"
                  disabled={!canWrite}
                  items={[
                    ...opts.labels.map((l) => ({ name: l.name, color: l.color, checked: item.labels.some((x) => x.name === l.name) })),
                    ...item.labels.filter((l) => !opts.labels.some((x) => x.name === l.name)).map((l) => ({ name: l.name, color: l.color, checked: true })),
                  ]}
                  onToggle={(l) =>
                    void (l.checked
                      ? change({ kind: 'removeLabel', key: item.key, label: l.name }, `已去掉标签「${l.name}」`)
                      : change({ kind: 'addLabel', key: item.key, label: l.name, ...(l.color ? { color: l.color } : {}) }, `已加上标签「${l.name}」`))
                  }
                  onClose={() => setPicker(null)}
                />
              )}
            </span>
          </div>
        </div>
        <div className="field-row">
          <span className="field-name">里程碑</span>
          <select
            data-testid="milestone-select"
            value={item.milestone?.title ?? ''}
            disabled={pickBlocked}
            title={offlineWhy ?? `${item.repo} 的里程碑；客户端不新建里程碑（${keyText('milestone')}）`}
            onChange={(e) =>
              void change({ kind: 'setMilestone', key: item.key, title: e.target.value || null }, e.target.value ? `里程碑改成「${e.target.value}」` : '已去掉里程碑')
            }
          >
            <option value="">（无）</option>
            {item.milestone && !msTitles.includes(item.milestone.title) && <option value={item.milestone.title}>{item.milestone.title}</option>}
            {msTitles.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <span className="picker-anchor">
            <kbd>{keyText('milestone')}</kbd>
            {picker === 'milestone' && opts && (
              <LabelPicker
                title="设置里程碑"
                hint={`${item.repo}；再选一次当前的就是去掉`}
                testid="milestone-picker"
                disabled={!canWrite}
                items={[
                  ...(item.milestone && !msTitles.includes(item.milestone.title) ? [item.milestone.title] : []),
                  ...msTitles,
                ].map((t) => ({ name: t, checked: item.milestone?.title === t }))}
                onToggle={(m) => {
                  setPicker(null);
                  void change({ kind: 'setMilestone', key: item.key, title: m.checked ? null : m.name }, m.checked ? '已去掉里程碑' : `里程碑改成「${m.name}」`);
                }}
                onClose={() => setPicker(null)}
              />
            )}
          </span>
          <EditStatus mark={markFor('milestone')} field="milestone" />
          {opts?.error && (
            <>
              <span className="small err" data-testid="options-error" title={opts.error}>
                <Icon name="warn" size={12} /> 没读到标签 / 里程碑列表
              </span>
              <button className="link small" data-testid="options-retry" onClick={rereadOptions}>
                重试
              </button>
            </>
          )}
        </div>
        {item.projects.map((m) => {
          const p = metaOf(m.projectKey);
          if (!p) return null;
          const ro = !p.viewerCanUpdate;
          const why = offlineWhy ?? (ro ? `你在看板「${p.title}」上没有修改权限（GitHub 说这个账号不能改它），迭代和状态只能看` : undefined);
          return (
            <div className="field-row" key={m.projectKey} data-testid="project-fields" data-project={m.projectKey}>
              <span className="field-name">{p.title}</span>
              {p.hasIterationField && (
                <select
                  data-testid="iteration-select"
                  value={m.iteration?.id ?? ''}
                  disabled={!canWrite || ro}
                  title={why}
                  onChange={(e) =>
                    void change(
                      { kind: 'setIteration', key: item.key, projectKey: p.key, iterationId: e.target.value || null },
                      `看板「${p.title}」的迭代已改`,
                    )
                  }
                >
                  <option value="">（无迭代）</option>
                  <IterationOptions iterations={p.iterations} chosen={m.iteration} today={localToday(Date.now())} label={(i) => `${i.title}（${i.startDate} 起）`} />
                </select>
              )}
              <EditStatus mark={markFor('iteration', { projectKey: p.key })} field="iteration" />
              {p.statusFieldId && (
                <select
                  data-testid="status-select"
                  value={m.status ?? ''}
                  disabled={!canWrite || ro}
                  title={why}
                  onChange={(e) =>
                    void change({ kind: 'setStatus', key: item.key, projectKey: p.key, status: e.target.value || null }, `看板「${p.title}」的状态已改`)
                  }
                >
                  <option value="">（无状态）</option>
                  {p.statusOptions.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              )}
              <EditStatus mark={markFor('status', { projectKey: p.key })} field="status" />
              {ro && (
                <span className="small muted" data-testid="project-readonly">
                  只读：这个账号不能修改看板「{p.title}」
                </span>
              )}
            </div>
          );
        })}
      </section>

      {item.kind === 'pr' && pr && (
        <section className={`pr-box${prOpen && pr.mergeStateStatus === 'CLEAN' ? ' mergeable' : ''}${conflict ? ' conflict' : ''}`} data-testid="pr-box">
          {conflict && (
            <div className="banner error" data-testid="pr-conflict">
              <Icon name="warn" />
              <span className="banner-text">
                <b>有冲突</b>：这个 PR 和目标分支 <code>{pr.baseRef}</code> 有冲突，GitHub 不能合并。先在分支上解决冲突（或在网页上点「Resolve conflicts」），再回来合并。
              </span>
            </div>
          )}
          <div data-testid="pr-status">
            {pr.merged ? (
              <span className="kind done">
                <Icon name="pr-merged" />
                已合并
              </span>
            ) : (
              <>
                <b>合并：{MERGE_STATE[pr.mergeStateStatus] ?? pr.mergeStateStatus}</b>
                <span>冲突：{MERGEABLE[pr.mergeable] ?? pr.mergeable}</span>
                <span>检查：{pr.checks ? (CHECKS[pr.checks] ?? pr.checks) : '没有检查'}</span>
                <span>评审：{pr.reviewDecision ? (REVIEW[pr.reviewDecision] ?? pr.reviewDecision) : '无要求'}</span>
                <span className="branch">
                  {pr.headRef} → {pr.baseRef} · 提交 {pr.headOid.slice(0, 7)}
                </span>
              </>
            )}
          </div>
          {prOpen && (
            <div className="row">
              <select
                data-testid="merge-method"
                value={method}
                onChange={(e) => {
                  const m = e.target.value as MergeMethod;
                  setPicked(m);
                  void Promise.resolve(api().setMergeMethod(item.repo, m)).catch(() => undefined);
                }}
                disabled={!canWrite || busy}
              >
                {pr.mergeMethods.map((m) => (
                  <option key={m} value={m}>
                    {METHOD_LABEL[m]}
                  </option>
                ))}
              </select>
              <button
                className={conflict ? 'danger' : 'primary'}
                data-testid="merge"
                data-conflict={conflict ? 'yes' : 'no'}
                disabled={!canWrite || busy || !method || conflict || Boolean(lock)}
                title={offlineWhy ?? lockWhy ?? (conflict ? conflictWhy : undefined)}
                onClick={() => openAsk('merge')}
              >
                {conflict ? '有冲突，不能合并' : '合并…'}
              </button>
              <button className="danger" data-testid="close-pr" disabled={!canWrite || busy || Boolean(lock)} title={offlineWhy ?? lockWhy} onClick={() => openAsk('close')}>
                关闭 PR…
              </button>
            </div>
          )}
          {prOpen && pr.mergeMethods.length === 0 && <div className="small err pr-note">这个仓库没有开启任何合并方式</div>}
        </section>
      )}

      {detail && detail.timeline.length > 1 && (
        <div className="timeline-tools small">
          <b>动态</b>
          <span className="muted">
            {unfold === 'latest' ? '只展开了最新一条，点标题展开其他' : unfold === 'all' ? '已全部展开' : '已全部收起'}
          </span>
          <div className="spacer" />
          <button className="link" data-testid="unfold-toggle" data-unfold={unfold} onClick={() => setUnfold(unfold === 'all' ? 'none' : 'all')}>
            {unfold === 'all' ? '全部收起' : '全部展开'}
          </button>
        </div>
      )}
      <div className="timeline">
        {detail ? (
          <iframe
            ref={frameRef}
            title="评论"
            data-testid="timeline-frame"
            data-render={frame.render}
            data-ready={readyRender === frame.render ? 'yes' : 'no'}
            sandbox={TIMELINE_SANDBOX}
            srcDoc={doc}
          />
        ) : (
          !loadError && <div className="muted center">正在从 GitHub 读取…</div>
        )}
      </div>

      <section className="reply" data-testid="reply">
        <textarea
          data-testid="reply-input"
          data-keys="reply"
          ref={replyBox}
          value={reply}
          placeholder={canWrite ? '回复（支持 markdown）' : '离线时不能回复'}
          disabled={!canWrite || busy}
          onChange={(e) => {
            setReply(e.target.value);
            if (!e.target.value.trim()) setEscKept(false);
            session.supersede('preview');
            setPreview(null);
          }}
          onPaste={(e) => {
            if (!isImageOnlyPaste(e.clipboardData)) return;
            e.preventDefault();
            setPasted({ where: 'reply', copied: null });
          }}
        />
        {pasted?.where === 'reply' && (
          <PasteImageNotice
            copied={pasted.copied}
            onWeb={async () => {
              const copied = reply.trim() ? await copyText(reply) : null;
              setPasted({ where: 'reply', copied });
              void api().openExternal(item.url);
            }}
            onDismiss={() => setPasted(null)}
          />
        )}
        {escKept && reply.trim() && (
          <div className="banner warn draft-kept" data-testid="draft-esc-hint" ref={(el) => el?.scrollIntoView?.({ block: 'nearest' })}>
            回复框里还有没发出的文字，按 Esc 不会收起面板（免得文字丢掉）。发出去、清空，或点右上角「收起 ›」（文字会丢）。
          </div>
        )}
        {preview !== null && (
          <iframe
            className="preview"
            title="预览"
            data-testid="reply-preview"
            sandbox={FRAME_SANDBOX}
            srcDoc={`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(FRAME_CSP)}"><base target="_blank"><body style="font:13px/1.5 sans-serif;margin:6px;color:${isDark ? '#e6edf3' : '#1f2328'};background:${isDark ? '#151b23' : '#ffffff'}">${preview}</body>`}
          />
        )}
        <div className="row end">
          {issueOpen && (
            <button className="danger" data-testid="close-issue" disabled={!canWrite || busy || Boolean(lock)} title={offlineWhy ?? lockWhy ?? '在 GitHub 上关闭这个 issue（先选原因）'} onClick={() => openAsk('closeIssue')}>
              关闭 issue…
            </button>
          )}
          <div className="spacer" />
          <span className="small muted keys-hint">
            按 <Keys parts={keyParts(SHORTCUTS.find((x) => x.id === 'send')!.keys[0], isMac())} /> 发送
          </span>
          <button data-testid="reply-preview-toggle" disabled={previewBlocked} title={`预览（${keyText('preview')}）`} onClick={() => void togglePreview()}>
            {preview !== null ? '继续编辑' : '预览'}
          </button>
          {detailRead && (
            <span className="quick-actions" data-testid="quick-actions">
              <button
                data-testid="hand-back"
                disabled={!canWrite || busy || Boolean(lock)}
                title={offlineWhy ?? lockWhy ?? `加上「${hb.agent}」、去掉「${hb.human}」（标签名在设置里改）`}
                onClick={() => void startOp({ kind: 'handBack', key: item.key }, false)}
              >
                交给 agent
              </button>
              {hb.autopilot && (
                <button
                  data-testid="autopilot"
                  disabled={!canWrite || busy || Boolean(lock)}
                  title={
                    offlineWhy ??
                    lockWhy ??
                    `加上「${hb.autopilot}」再交给 agent：复审通过、检查通过后由 daemon 自动合并（标签名在设置里改）${state.autopilotConfirm ? '' : '；已设为不再提示，点了直接托管（设置里可改回）'}`
                  }
                  onClick={() => {
                    // GitHub#231: "不再提示" was ticked once — no dialog, the same write as its "确认托管"
                    if (!state.autopilotConfirm) return void runAutopilot();
                    setNoMoreAsk(false);
                    openAsk('autopilot');
                  }}
                >
                  {state.autopilotConfirm ? '托管（自动合并）…' : '托管（自动合并）'}
                </button>
              )}
            </span>
          )}
          <button className="primary" data-testid="reply-send" disabled={sendBlocked} title={`发送（${keyText('send')}）`} onClick={() => void send()}>
            发送
          </button>
        </div>
      </section>

      {ask === 'merge' && pr && method && (
        <ConfirmDialog
          title={`合并 PR #${item.number}？`}
          confirmLabel="确认合并"
          busy={busy}
          onCancel={cancelAsk}
          onConfirm={async () => {
            if (await startOp({ kind: 'merge', key: item.key, method, headOid: pr.headOid }, true)) setAsk(null);
          }}
        >
          <ResultBanner note={dialogNote} testid="dialog-result" />
          <p>
            把 <code>{pr.headRef}</code> 合进 <code>{pr.baseRef}</code>，方式：{METHOD_LABEL[method]}。
          </p>
        </ConfirmDialog>
      )}
      {ask === 'autopilot' && (
        <ConfirmDialog
          title={`托管 ${item.kind === 'pr' ? 'PR' : 'issue'} #${item.number}？`}
          confirmLabel="确认托管"
          busy={busy}
          onCancel={cancelAsk}
          onConfirm={async () => {
            // the tick counts only with "确认托管": "取消" keeps asking
            if (noMoreAsk) void Promise.resolve(api().setAutopilotConfirm(false)).catch(() => undefined);
            if (await runAutopilot()) setAsk(null);
          }}
        >
          <ResultBanner note={dialogNote} testid="dialog-result" />
          <div data-testid="autopilot-explain">
            <p data-testid="autopilot-explain-labels">
              会加上标签 <code>{hb.autopilot}</code> 和 <code>{hb.agent}</code>、去掉 <code>{hb.human}</code>。
            </p>
            <p data-testid="autopilot-explain-then">agent 接手，从方案到合并不再等你确认；独立复审通过、检查通过后由 daemon 自动合并。</p>
            <p data-testid="autopilot-explain-stop">
              要叫停，在网页上去掉 <code>{hb.autopilot}</code> 标签。只有维护者亲手加的托管标签才算数。
            </p>
          </div>
          <label className="row small">
            <input type="checkbox" data-testid="autopilot-no-more-ask" checked={noMoreAsk} disabled={busy} onChange={(e) => setNoMoreAsk(e.target.checked)} />
            不再提示，以后点「托管」直接执行（设置里可改回）
          </label>
        </ConfirmDialog>
      )}
      {editing && (
        <ConfirmDialog
          title={editing.kind === 'body' ? '编辑正文' : '编辑评论'}
          confirmLabel="保存到 GitHub"
          busy={busy}
          disabled={editing.text === editing.source || (editing.kind === 'comment' && !editing.text.trim())}
          dirty={editing.text !== editing.source}
          onCancel={() => {
            setEditing(null);
            if (pasted?.where === 'edit') setPasted(null);
          }}
          onConfirm={async () => {
            const r = await run({ kind: 'editEntry', key: item.key, entryId: editing.entryId, body: editing.text, seenSource: editing.source }, editing.kind === 'body' ? '正文已保存' : '评论已保存');
            if (!r.here) return;
            if (r.ok) {
              setEditing(null);
              setEditNote(null);
              if (pasted?.where === 'edit') setPasted(null);
            } else setEditNote(noteOf(r, ''));
          }}
        >
          <textarea
            className="edit-box"
            data-testid="edit-input"
            value={editing.text}
            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            onPaste={(e) => {
              if (!isImageOnlyPaste(e.clipboardData)) return;
              e.preventDefault();
              setPasted({ where: 'edit', copied: null });
            }}
          />
          {pasted?.where === 'edit' && (
            <PasteImageNotice
              copied={pasted.copied}
              onWeb={async () => {
                const copied = await copyText(editing.text);
                setPasted({ where: 'edit', copied });
                void api().openExternal(editing.url || item.url);
              }}
              onDismiss={() => setPasted(null)}
            />
          )}
          <ResultBanner note={editNote} testid="edit-result" />
        </ConfirmDialog>
      )}
      {ask === 'close' && (
        <ConfirmDialog
          title={`关闭 PR #${item.number}（不合并）？`}
          confirmLabel="确认关闭"
          danger
          busy={busy}
          onCancel={cancelAsk}
          onConfirm={async () => {
            // the comment now lives in the operation (kept until it went out, or dropped by hand)
            if (!(await startOp({ kind: 'closePr', key: item.key, comment: closeComment }, true))) return;
            setCloseComment('');
            setAsk(null);
          }}
        >
          <ResultBanner note={dialogNote} testid="dialog-result" />
          <textarea data-testid="close-comment" placeholder="可选：附一句评论（关闭成功后发出）" value={closeComment} onChange={(e) => setCloseComment(e.target.value)} />
        </ConfirmDialog>
      )}
      {ask === 'closeIssue' && (
        <ConfirmDialog
          title={`关闭 issue #${item.number}？`}
          confirmLabel="确认关闭"
          danger
          busy={busy}
          onCancel={cancelAsk}
          onConfirm={async () => {
            if (!(await startOp({ kind: 'closeIssue', key: item.key, reason: closeReason, comment: closeComment }, true))) return;
            setCloseComment('');
            setAsk(null);
          }}
        >
          <ResultBanner note={dialogNote} testid="dialog-result" />
          <div className="close-reasons" data-testid="close-reason">
            {ISSUE_CLOSE_REASONS.map((r) => (
              <label key={r} className="radio">
                <input type="radio" name="close-reason" value={r} data-testid={`close-reason-${r}`} checked={closeReason === r} onChange={() => setCloseReason(r)} />
                <b>{CLOSE_REASON[r].name}</b>
                <span className="muted">{CLOSE_REASON[r].hint}</span>
              </label>
            ))}
          </div>
          <textarea data-testid="close-comment" placeholder="可选：附一句评论（关闭成功后发出）" value={closeComment} onChange={(e) => setCloseComment(e.target.value)} />
        </ConfirmDialog>
      )}
    </>,
  );
}
