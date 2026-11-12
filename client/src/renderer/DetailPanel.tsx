import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AppState, BoardData, EditMark } from '../shared/types';
import { ISSUE_CLOSE_REASONS, type IssueCloseReason, type ItemDetail, type MergeMethod, type RepoOptions, type WriteAction, type WriteResult } from '../shared/actions';
import { writesEnabled } from '../data/board';
import { api } from './api';
import { ConfirmDialog } from './ConfirmDialog';
import { pickMergeMethod } from '../shared/mergePrefs';
import { FRAME_SANDBOX, TIMELINE_SANDBOX, timelineDocument, previewDocument, escapeHtml, type FrameView, type Unfold } from './detailHtml';
import { imageFailureText, parseReleaseImage } from '../shared/images';
import { renderedTaskBoxes } from '../data/taskList';
import { Person } from './Avatar';
import { labelStyle, useDarkMode } from './colors';
import { Icon } from './Icons';
import { createOpenSession, type OpenSession } from './openSession';
import { KindBadge } from './KindBadge';
import { frameKey, useLayer, useShortcuts } from './keyboard';
import { LabelPicker } from './LabelPicker';
import { keyText } from './shortcuts';
import { copyText, isImageOnlyPaste, PASTE_IMAGE_NOTE } from './pasteImage';
import { freshMark, sameDetail, shouldAutoRefresh } from './autoRefresh';
import { IterationOptions, localToday } from './iterationOptions';
import { AUTO_DISMISS_MS, opAutoDismissable, opDraftLeft, opLockOf, opReusableDraft, opText, opTone, type OpRecord } from '../shared/ops';
import { OpNotice } from './OpNotice';
import { BlockedDialog } from './BlockedDialog';
import { entryState } from '../shared/blocked';
import { editsTone, resultTone } from '../shared/noticeTone';
import { useAutoDismiss } from './autoDismiss';
import { prStatusIcons, type PrTone } from './prStatus';

const METHOD_LABEL: Record<MergeMethod, string> = { merge: '合并提交（merge commit）', squash: '压成一个提交（squash）', rebase: '变基（rebase）' };
const CLOSE_REASON: Record<IssueCloseReason, { name: string; hint: string }> = {
  completed: { name: '已完成', hint: '做完了 / 问题已解决' },
  not_planned: { name: '不计划', hint: '不做了、不是问题' },
};
/** GitHub#322: clicks on these in the reply card do their own thing; a click anywhere else there goes to the reply box */
const CARD_OWN_CLICK = 'button, select, a, input, textarea, label, summary, iframe, [tabindex], [contenteditable]';
/** the reply box's least height: about four lines (also in styles.css, .reply textarea) */
const REPLY_MIN_PX = 96;

/**
 * GitHub#397: what a tab's detail holds that was not sent yet. Only one detail is mounted (the tab
 * in front); the window keeps this per tab, so switching tabs never drops typed text.
 */
export interface TabDraft {
  reply: string;
  /** the reply box holds an operation's kept comment (GitHub#250) */
  replyFromOp: string | null;
  editing: { entryId: string; kind: 'body' | 'comment'; url: string; source: string; text: string } | null;
  titleEdit: { seen: string; text: string } | null;
}

/** Text that closing the tab would lose. */
export function draftDirty(d: TabDraft | null | undefined): boolean {
  if (!d) return false;
  return d.reply.trim() !== '' || (d.editing !== null && d.editing.text !== d.editing.source) || (d.titleEdit !== null && d.titleEdit.text !== d.titleEdit.seen);
}

export type ResultNote = { kind: 'ok' | 'error' | 'warn'; text: string };

export function noteOf(r: WriteResult, okText: string): ResultNote {
  if (!r.ok) return { kind: 'error', text: `${r.error ?? '没有成功'}` };
  if (r.warning) return { kind: 'warn', text: `${okText}。注意：${r.warning}` };
  return { kind: 'ok', text: okText };
}

/** how long a plain success note stays when its bar opts in (GitHub#256; 5 s since GitHub#279) */
export const NOTE_AUTO_DISMISS_MS = 5_000;

export function ResultBanner({
  note,
  testid,
  onExpire,
  onClose,
}: {
  note: ResultNote | null;
  testid: string;
  /** GitHub#256: clears a plain success note after 5 s; warnings and errors stay */
  onExpire?: () => void;
  /** GitHub#323: an × that puts the note away, whatever its kind (only closes the bar: nothing is sent or abandoned) */
  onClose?: () => void;
}) {
  const auto = useAutoDismiss(!!note && note.kind === 'ok' && !!onExpire, NOTE_AUTO_DISMISS_MS, () => onExpire?.(), note);
  if (!note) return null;
  // GitHub#357: green when it went through (and then it goes by itself: every caller passes onExpire)
  return (
    <div className={`banner ${resultTone(note.kind)}`} data-testid={testid} data-kind={note.kind} {...auto}>
      <Icon name={note.kind === 'ok' ? 'check' : 'warn'} />
      <span className="banner-text">{note.text}</span>
      {onClose && (
        <button className="banner-close" aria-label="关闭提示" title="关闭提示" data-testid={`${testid}-close`} onClick={onClose}>
          <Icon name="x" />
        </button>
      )}
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
export function EditIssues({ marks, canWrite, resending }: { marks: EditMark[]; canWrite: boolean; resending: readonly string[] }) {
  const [working, setWorking] = useState<string | null>(null);
  const open = marks.filter((m) => m.status === 'failed' || m.status === 'unconfirmed');
  if (!open.length) return null;
  // GitHub#357: blue while a resend of one of them is running (the fact is the controller's, so the board's bar agrees)
  const sending = open.some((m) => resending.includes(m.id));
  const tone = editsTone(sending);
  const go = async (id: string, fn: () => Promise<unknown>) => {
    setWorking(id);
    try {
      await fn();
    } finally {
      setWorking(null);
    }
  };
  return (
    <div className={`banner ${tone} edit-issues`} data-testid="edit-issues" data-kind={tone}>
      {sending ? <span className="spin" aria-hidden="true" /> : <Icon name="warn" />}
      <div className="banner-text">
        <b>{open.length} 处修改{open.some((m) => m.status === 'failed') ? '没保存上' : '没确认'}</b>
        {sending && <span data-testid="edit-issues-sending">；正在重新发送…</span>}
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
                <button className="link" data-testid="edit-force" disabled={!canWrite || working !== null || sending} onClick={() => void go(m.id, () => api().resendEdit(m.id, true))}>
                  {m.hold.kind === 'changed' ? '仍然覆盖' : '仍然发送'}
                </button>
              ) : (
                <button className="link" data-testid="edit-resend" disabled={!canWrite || working !== null || sending} onClick={() => void go(m.id, () => api().resendEdit(m.id))}>
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

/** GitHub#260: a plain success note, a short line in the panel's head that goes away by itself (never a row above the discussion). */
function HeadNote({ note, onExpire }: { note: ResultNote; onExpire: () => void }) {
  const auto = useAutoDismiss(true, NOTE_AUTO_DISMISS_MS, onExpire, note);
  return (
    <span className="head-note" data-testid="action-result" data-kind={note.kind} title={note.text} role="status" {...auto}>
      <Icon name="check" size={13} />
      <span className="head-note-text">{note.text}</span>
    </span>
  );
}

/**
 * GitHub#260: an operation that fully succeeded (the one rule, opAutoDismissable) is said in the head like a
 * plain success, and puts itself away after 5 s exactly like its × (GitHub#256) — never hidden behind the
 * notices button, where it would count down and go without being seen.
 */
function HeadOp({ r }: { r: OpRecord }) {
  const auto = useAutoDismiss(true, AUTO_DISMISS_MS, () => void api().opDismiss(r.id, true), r.id);
  return (
    <span className="head-note" data-testid="op-notice" data-kind={opTone(r)} data-op={r.id} data-key={r.key} title={opText(r)} role="status" {...auto}>
      <Icon name="check" size={13} />
      <span className="head-note-text" data-testid="op-notice-text">
        {opText(r)}
      </span>
      <button className="banner-close" aria-label="关掉提示" title="关掉提示" data-testid="op-dismiss" onClick={() => void api().opDismiss(r.id, true)}>
        <Icon name="x" size={12} />
      </button>
    </span>
  );
}

/** the notices button: the plain blue of a remark shows as the quiet check it always was */
export type NoticeTone = 'busy' | 'error' | 'warn' | 'ok';

/**
 * GitHub#260: everything the panel has to say that is not a plain success — failed changes,
 * operations and their drafts, a failed read — behind one button in the head with a count. A
 * click opens them (the same notices, the same buttons as before); a second click, a click
 * outside or Esc puts them away. The notices stay mounted while closed, so an operation's own
 * timers and records carry on; a new one never opens the list by itself.
 */
function DetailNotices({ count, tone, children }: { count: number; tone: NoticeTone; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const label = tone === 'busy' ? `${count} 条提示，有操作正在进行（点开看）` : `${count} 条提示（点开看）`;
  return (
    <span className="trouble-anchor notices-anchor" ref={box}>
      <button
        className={`icon-btn notices-btn tone-${tone}${open ? ' on' : ''}`}
        data-testid="detail-notices-toggle"
        data-count={count}
        data-tone={tone}
        data-open={open ? 'yes' : 'no'}
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={() => setOpen(!open)}
      >
        {tone === 'busy' ? <span className="spin" aria-hidden="true" /> : <Icon name={tone === 'ok' ? 'check' : 'warn'} />}
        <span className="notices-count">{count}</span>
      </button>
      {open && <NoticesLayer box={box} onClose={() => setOpen(false)} />}
      <div className="trouble-panel notices-panel" data-testid="detail-notices" role="dialog" aria-label="提示" hidden={!open}>
        {children}
      </div>
    </span>
  );
}

/** While the notices are open: Esc and a click outside put them away (the same rules as the board's ⚠️). */
function NoticesLayer({ box, onClose }: { box: React.RefObject<HTMLSpanElement | null>; onClose: () => void }) {
  useLayer('picker');
  useShortcuts({ pickerClose: onClose });
  useEffect(() => {
    const out = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    // a click into the isolated discussion never reaches this document (another origin): the window
    // loses focus to the frame instead — that is a click outside too (PR #269 review round 1)
    const blur = () =>
      setTimeout(() => {
        if (document.activeElement instanceof HTMLIFrameElement) onClose();
      }, 0);
    document.addEventListener('mousedown', out);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('mousedown', out);
      window.removeEventListener('blur', blur);
    };
  }, [box, onClose]);
  return null;
}

/** GitHub#260: one icon per PR state; the words show when the pointer rests on it. */
function PrToneIcon({ tone }: { tone: PrTone }) {
  return (
    <svg className={`pr-dot tone-${tone}`} viewBox="0 0 16 16" width={15} height={15} aria-hidden="true">
      {tone === 'none' ? <circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" strokeWidth="1.5" /> : <circle cx="8" cy="8" r="7" fill="currentColor" />}
      {tone === 'ok' && <path d="M4.6 8.3l2.2 2.2 4.6-4.8" stroke="#fff" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />}
      {tone === 'bad' && <path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />}
      {tone === 'warn' && <path d="M8 4.3v4.4M8 11.3v.2" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />}
      {tone === 'pending' && <path d="M4.8 8h.1M8 8h.1M11.2 8h.1" stroke="#fff" strokeWidth="2" strokeLinecap="round" />}
      {tone === 'none' && <path d="M5.3 8h5.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
    </svg>
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
  onHome,
  onLeftBehind,
  intent,
  draft,
  onDraft,
}: {
  itemKey: string;
  state: AppState;
  data: BoardData;
  /** Esc: back to the home tab (this tab stays open) */
  onHome: () => void;
  /** GitHub#397: what this tab held unsent when it was last in front, and where changes to it are reported */
  draft?: TabDraft | null;
  onDraft?: (d: TabDraft) => void;
  /** GitHub#250: opened from a notice above the board to do this with one of the item's operations */
  intent?: { opId: string; what: 'retry' | 'toReply' } | null;
  /** a change made on an item the panel has since left: its result goes to the board instead */
  /** `about`: the write the note reports on (GitHub#323: the board's bar follows a failed field change) */
  onLeftBehind: (note: ResultNote, about?: WriteAction) => void;
}) {
  // GitHub#397: the controller hands over a tab's item whole when the view does not hold it, or holds an older copy than
  // the tab's own check read — that copy wins, so the badge, the buttons and the tab agree
  const item = data.tabItems?.find((i) => i.key === itemKey) ?? data.items.find((i) => i.key === itemKey) ?? null;
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
  const [reply, setReply] = useState(draft?.reply ?? '');
  const [preview, setPreview] = useState<string | null>(null);
  /** GitHub#205: the body / comment being edited (its source when the edit started), and the text so far */
  const [editing, setEditing] = useState<{ entryId: string; kind: 'body' | 'comment'; url: string; source: string; text: string } | null>(draft?.editing ?? null);
  const [editNote, setEditNote] = useState<ResultNote | null>(null);
  /** GitHub#299: the title being edited (the title shown when the edit started), and the text so far */
  const [titleEdit, setTitleEdit] = useState<{ seen: string; text: string } | null>(draft?.titleEdit ?? null);
  const [titleNote, setTitleNote] = useState<ResultNote | null>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const titleOpen = titleEdit !== null;
  // runs after the dialog's own effect (which focuses the dialog box): the caret goes into the field, the title selected
  useEffect(() => {
    if (titleOpen) titleInput.current?.select();
  }, [titleOpen]);
  /** GitHub#205: an image was pasted into the reply / edit box (it cannot be uploaded from here) */
  const [pasted, setPasted] = useState<{ where: 'reply' | 'edit'; copied: boolean | null } | null>(null);
  /** the method picked by hand in this opening; null = none yet */
  const [picked, setPicked] = useState<MergeMethod | null>(null);
  const [ask, setAsk] = useState<'merge' | 'close' | 'closeIssue' | 'autopilot' | null>(null);
  /** GitHub#434: the "等前置…" dialog is open */
  const [blockedOpen, setBlockedOpen] = useState(false);
  /** GitHub#231: "不再提示" in the 托管 dialog, unticked every time it opens */
  const [noMoreAsk, setNoMoreAsk] = useState(false);
  const [closeComment, setCloseComment] = useState('');
  const [closeReason, setCloseReason] = useState<IssueCloseReason>('completed');
  /** GitHub#250: the dialog was opened again from an operation's notice: its draft moves to the new one */
  const [retryFrom, setRetryFrom] = useState<string | null>(null);
  /** GitHub#250: the operation refused at once (nothing sent): said inside the dialog, which stays */
  const [dialogNote, setDialogNote] = useState<ResultNote | null>(null);
  /** GitHub#250: the reply box holds an operation's kept comment: sent = that draft is done */
  const [replyFromOp, setReplyFromOp] = useState<string | null>(draft?.replyFromOp ?? null);
  /** the label / milestone picker that is open (GitHub#192) */
  const [picker, setPicker] = useState<'labels' | 'milestone' | null>(null);
  // GitHub#397: the unsent text is the tab's, not this mounting's — reported on every change
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  /**
   * The reply text whose send is on its way. It is not "unsent text" any more: a tab left while
   * the send runs comes back with an empty box, never with the text GitHub is already taking
   * (sent twice otherwise). A send refused here puts it back: the box still holds it.
   */
  const [sendingReply, setSendingReply] = useState<string | null>(null);
  useEffect(() => {
    const inFlight = sendingReply !== null && sendingReply === reply;
    onDraftRef.current?.({ reply: inFlight ? '' : reply, replyFromOp: inFlight ? null : replyFromOp, editing, titleEdit });
  }, [reply, replyFromOp, editing, titleEdit, sendingReply]);
  const replyBox = useRef<HTMLTextAreaElement>(null);
  const canWrite = writesEnabled(state.sync);
  const offlineWhy = canWrite ? undefined : '离线时不能修改';
  const repo = item?.repo ?? '';

  // GitHub#226: the board's `updatedAt` of this item when the detail on screen was read. Set only
  // when a read lands: a read that was dropped, superseded or failed leaves it, so the next round tries again.
  // GitHub#397: the newest `updatedAt` known of the item. While a complete read carries it that is
  // the board's copy; otherwise the tab's own check may know more than a cached source does.
  const tabInfo = state.tabs.find((t) => t.key === itemKey) ?? null;
  const knownAt = !item ? null : tabInfo && !tabInfo.listed && tabInfo.item.updatedAt > item.updatedAt ? tabInfo.item.updatedAt : item.updatedAt;
  const knownRef = useRef(knownAt);
  knownRef.current = knownAt;
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
      const seen = knownRef.current;
      setLoading(true);
      // GitHub#357: a read a person asked for starts over — the failure of the one before is not shown while it runs
      if (!quiet) setLoadError(null);
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
  // GitHub#397: an item no complete read carries has no round of its own: every answer of the tab's own
  // check of it (the controller's, with every round) is its round — the same rule then decides, so a PR
  // whose checks are still running is read again even when its `updatedAt` did not move (code review round 2).
  const mark = freshMark(item, state.sync.sources);
  const ownMark = tabInfo?.checkedAt ?? null;
  const trigger = mark !== null ? `round:${mark}` : ownMark !== null ? `own:${ownMark}` : null;
  const lastMark = useRef(trigger);
  useEffect(() => {
    if (trigger === lastMark.current) return;
    lastMark.current = trigger;
    if (trigger === null) return;
    if (shouldAutoRefresh({ item: knownAt === null ? null : { updatedAt: knownAt }, readAt: readAt.current, detail, busy: busy || changing > 0, loading })) void load(true);
    // only a new round decides; the values are this render's
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);
  // GitHub#397: this tab is in front. An item no complete read carries is checked now (once per
  // opening), and whatever `updatedAt` the tab shows is seen: the "something new" dot is for the
  // tabs that are not in front.
  useEffect(() => {
    void Promise.resolve(api().checkTab(itemKey)).catch(() => undefined);
  }, [itemKey]);
  const shownAt = knownAt;
  useEffect(() => {
    if (shownAt !== null) void Promise.resolve(api().seenTab(itemKey, shownAt)).catch(() => undefined);
  }, [itemKey, shownAt]);
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
    // never a comment a reply made from it may already have posted (code review round 2)
    const d = opReusableDraft(r) ?? {};
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
    } else if (r.kind === 'blocked') {
      // GitHub#434: done again from the dialog, which reads the item afresh
      setRetryFrom(null);
      setBlockedOpen(true);
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
      onLeftBehind(noteOf(r, `${label}：${okText}`), action);
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
      onLeftBehind(noteOf(r, `${label}：${okText}`), action);
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
  /**
   * GitHub#358: the box click still on its way. From the click until the re-read after it ended, that
   * box shows what was asked for in grey and no box takes a click; a refused / failed write takes it
   * back at once. `written`: GitHub answered yes — only the re-read is still awaited.
   */
  const [pendingTick, setPendingTick] = useState<{ entryId: string; index: number; checked: boolean; written: boolean } | null>(null);
  // the re-read ended (landed or failed) and no other change is in flight: the frame shows what GitHub holds
  // again — decided while rendering, so the read that lands draws the frame once, not grey first and then again
  const tickOver = Boolean(pendingTick?.written) && !loading && !busy;
  const waitingTick = tickOver ? null : pendingTick;
  useEffect(() => {
    if (tickOver) setPendingTick(null);
  }, [tickOver]);
  const canTick = canWrite && !busy && !waitingTick;
  // GitHub#381: the "wrap long lines" switch of the code blocks. The frame flips itself at the click and
  // reports it; kept in a ref (not state) so the report does not draw the frame again — the next drawing,
  // whatever causes it, carries the switch. Remembered with the other view settings.
  const wrapRef = useRef(state.view.codeWrap);
  const setWrap = (on: boolean) => {
    wrapRef.current = on;
    void Promise.resolve(api().setView({ codeWrap: on })).catch(() => undefined);
  };
  const frame = useMemo(() => {
    if (!detail) return { doc: '', render: '' };
    const render = `r${++renderSeq.current}`;
    return { doc: timelineDocument(detail, isDark, unfold, { render, canTick, view: viewRef.current, pending: waitingTick, wrap: wrapRef.current, web: state.githubWeb, offline: !canWrite }), render };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, unfold, isDark, canTick, canWrite, redraw, waitingTick?.entryId, waitingTick?.index, waitingTick?.checked]);
  const doc = frame.doc;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  /** the rendering whose script reported in: the frame's script ran (tests wait on it) */
  const [readyRender, setReadyRender] = useState('');

  /** A box was ticked in the frame. Sent only when everything the window knows says it may be. */
  const tick = async (entryId: unknown, index: unknown, checked: unknown) => {
    const e = detail?.timeline.find((x) => x.id === entryId && (x.kind === 'body' || x.kind === 'comment'));
    const t = e?.tasks;
    const count = e ? renderedTaskBoxes(e.bodyHtml).length : 0;
    if (!item || !e || !t?.clickable || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count || typeof checked !== 'boolean' || !canWrite || busy || waitingTick) {
      setRedraw((n) => n + 1);
      return;
    }
    setPendingTick({ entryId: e.id, index, checked, written: false });
    const r = await run(
      { kind: 'toggleTask', key: item.key, entryId: e.id, index, checked, seenSource: t.source },
      checked ? '已勾上，GitHub 上已更新' : '已取消勾选，GitHub 上已更新',
    );
    if (!r.here) return;
    // refused or failed: the box goes back to what is on screen at once, and `run` reads again, so it
    // ends up showing what GitHub holds now (a re-read with the same content does not redraw by itself)
    if (!r.ok) {
      setPendingTick(null);
      setRedraw((n) => n + 1);
    }
    // written: the grey stays until the re-read `run` started has ended (the effect above)
    else setPendingTick((p) => (p ? { ...p, written: true } : p));
  };
  // What the listener below reads: the latest values of this render, set before the frame can load.
  /** GitHub#205: "edit" was clicked in the frame. Opened only for an entry GitHub said this account may change. */
  const edit = (entryId: unknown) => {
    const e = detail?.timeline.find((x) => x.id === entryId && (x.kind === 'body' || x.kind === 'comment'));
    if (!e || e.editSource === undefined || !canWrite || busy || editing) return;
    setEditNote(null);
    setEditing({ entryId: e.id, kind: e.kind as 'body' | 'comment', url: e.url, source: e.editSource, text: e.editSource });
  };
  /**
   * GitHub#395: the frame asks for a release attachment image (`id` = its number in that rendering).
   * The controller fetches it with the sign-in (or answers from memory / "rate limited until …");
   * the answer goes back to the frame that asked — a frame rendered again meanwhile asks by itself.
   */
  const image = (render: string, id: unknown, src: unknown) => {
    if (typeof id !== 'string' || typeof src !== 'string' || !parseReleaseImage(src, state.githubWeb)) return;
    void api()
      .loadImage(src)
      .then((r) => {
        const now = live.current;
        if (now.render !== render) return;
        const answer = r.ok
          ? { cavil: 'image', render, id, ok: true, data: r.dataUrl }
          : { cavil: 'image', render, id, ok: false, state: r.kind === 'limited' ? 'limited' : 'failed', why: imageFailureText(r), ...(r.kind === 'limited' ? { until: r.until } : {}) };
        frameRef.current?.contentWindow?.postMessage(answer, '*');
      })
      .catch(() => undefined);
  };
  /** GitHub#395: "reload" on an image that did not load: read the discussion again (fresh addresses) and draw the frame again */
  const reread = () => {
    if (!canWrite) return;
    void load(false).then(() => setRedraw((n) => n + 1));
  };
  const live = useRef({ tick, edit, setWrap, image, reread, render: frame.render, ids: [] as string[] });
  live.current = { tick, edit, setWrap, image, reread, render: frame.render, ids: detail?.timeline.map((x) => x.id) ?? [] };
  // One listener for the panel's whole life, in place before the first frame loads (a layout effect
  // runs right after the frame is inserted, before its document can run): a frame that loads fast
  // must not report before anyone listens.
  useLayoutEffect(() => {
    const on = (ev: MessageEvent) => {
      const f = frameRef.current;
      // only the frame on screen, only its current rendering: anything else is dropped
      if (!f || ev.source !== f.contentWindow) return;
      const m = ev.data as { cavil?: unknown; render?: unknown; view?: unknown; entry?: unknown; index?: unknown; checked?: unknown; key?: unknown; mod?: unknown; shift?: unknown; on?: unknown; id?: unknown; src?: unknown } | null;
      const now = live.current;
      if (!m || typeof m !== 'object' || m.render !== now.render) return;
      const v = m.view as { open?: unknown; scroll?: unknown } | undefined;
      if (v && Array.isArray(v.open) && typeof v.scroll === 'number')
        viewRef.current = { known: now.ids, open: v.open.filter((x): x is string => typeof x === 'string'), scroll: v.scroll };
      if (m.cavil === 'ready') setReadyRender(now.render);
      else if (m.cavil === 'task') void now.tick(m.entry, m.index, m.checked);
      else if (m.cavil === 'edit') now.edit(m.entry);
      else if (m.cavil === 'wrap' && typeof m.on === 'boolean') now.setWrap(m.on);
      else if (m.cavil === 'image') now.image(now.render, m.id, m.src);
      else if (m.cavil === 'reread') now.reread();
      // GitHub#322 / #433: the frame passes on a few keys (R, and the ⌘⇧ keys of the three buttons); the window's
      // own rules decide, and only those shortcuts may act (frameKey)
      else if (m.cavil === 'key') frameKey(m.key, m.mod ?? false, m.shift ?? false);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);
  // GitHub#260: the labels / milestone / board fields can be folded away; remembered on this machine
  const [fieldsShown, setFieldsShown] = useState(state.view.detailFields);
  const showFields = (v: boolean) => {
    setFieldsShown(v);
    void Promise.resolve(api().setView({ detailFields: v })).catch(() => undefined);
  };
  // ---- keyboard (GitHub#192): each key presses a button, behind that button's own enabled condition ----
  const sendBlocked = !item || !canWrite || busy || !reply.trim();
  const previewBlocked = !item || !canWrite || !reply.trim();
  /** the label / milestone controls: the same condition as their buttons */
  const pickBlocked = !item || !canWrite || !opts;
  const send = async () => {
    if (!item) return;
    // GitHub#250: a reply carrying an operation's kept comment says so — the controller finishes that draft, wherever this panel is by then
    setSendingReply(reply);
    const r = await run({ kind: 'comment', key: item.key, body: reply, ...(replyFromOp ? { draftOf: replyFromOp } : {}) }, '评论已发出');
    if (r.here) setSendingReply(null);
    if (r.ok && r.here) {
      setReplyFromOp(null);
      setReply('');
      setPreview(null);
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
  /** R and a click on the reply card's free space (GitHub#322): the reply box, when it can take text */
  const focusReply = () => {
    if (!item || !canWrite || busy) return;
    replyBox.current?.focus();
  };
  /** a click on the reply card that hit nothing of its own (no button, list, link, field…) and selected no text */
  const replyCardClick = (e: React.MouseEvent) => {
    const t = e.target as Element | null;
    if (!t || typeof t.closest !== 'function') return;
    // only inside the card: the panel around it is focusable too
    const own = t.closest(CARD_OWN_CLICK);
    if (own && e.currentTarget.contains(own)) return;
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed && sel.toString()) return;
    focusReply();
  };
  // GitHub#322: the box grows with its text up to 40% of the panel as it is now, then scrolls. The height
  // is worked out again whenever the text, the item or the panel's size changes (a smaller window, a
  // narrower panel that wraps more). Only a real drag of the box's own corner — a press on the box whose
  // release leaves it at another height — is kept, as the least it shrinks back to.
  const replyAuto = useRef<{ set: number; dragged: number }>({ set: 0, dragged: 0 });
  const fitReply = () => {
    const el = replyBox.current;
    if (!el) return;
    const a = replyAuto.current;
    el.style.height = 'auto';
    const max = Math.max(REPLY_MIN_PX, Math.round((panelRef.current?.clientHeight ?? 0) * 0.4));
    const want = Math.min(Math.max(el.scrollHeight, a.dragged, REPLY_MIN_PX), Math.max(max, a.dragged));
    el.style.height = `${want}px`;
    a.set = el.offsetHeight;
  };
  const fitRef = useRef(fitReply);
  fitRef.current = fitReply;
  useLayoutEffect(fitReply, [reply, item?.key]);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fitRef.current());
    ro.observe(panel);
    return () => ro.disconnect();
  }, []);
  const replyPress = () => {
    const done = () => {
      window.removeEventListener('mouseup', done, true);
      const el = replyBox.current;
      const a = replyAuto.current;
      if (!el || Math.abs(el.offsetHeight - a.set) <= 1) return;
      a.dragged = el.offsetHeight;
      a.set = el.offsetHeight;
    };
    window.addEventListener('mouseup', done, true);
  };
  /**
   * GitHub#413: the three buttons next to "发送" (关闭 issue / 交给 agent / 托管), set further down
   * once the item is known: each is the button's own handler when that button is showing and can be
   * pressed, else undefined — so a key never does what the button would not.
   */
  const quickKeys = useRef<Partial<Record<'closeIssue' | 'handBack' | 'autopilot' | 'blocked', () => void>>>({});
  useShortcuts({
    closeIssue: () => quickKeys.current.closeIssue?.(),
    handBack: () => quickKeys.current.handBack?.(),
    autopilot: () => quickKeys.current.autopilot?.(),
    blocked: () => quickKeys.current.blocked?.(),
    // folded fields come back first: the picker opens next to them (GitHub#260)
    labels: () => {
      if (pickBlocked) return;
      if (!fieldsShown) showFields(true);
      setPicker('labels');
    },
    milestone: () => {
      if (pickBlocked) return;
      if (!fieldsShown) showFields(true);
      setPicker('milestone');
    },
    reply: focusReply,
    // GitHub#397: Esc goes back to the home tab; this tab stays open and keeps its unsent text, so a
    // key never drops a draft. (Dialogs and pickers are layers: their Esc never gets here. Neither does
    // a key pressed inside the isolated discussion frame — PR #171, the maintainer chose to keep it
    // isolated; its one script reports ticked boxes and the view (GitHub#193) and a bare R (GitHub#322),
    // never any other key.)
    hide: () => onHome(),
    send: () => {
      if (!sendBlocked) void send();
    },
    preview: () => {
      if (!previewBlocked) void togglePreview();
    },
    leaveReply: () => replyBox.current?.blur(),
  });

  const panelRef = useRef<HTMLElement | null>(null);
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
    <section ref={panelRef} className="detail" data-testid="detail" data-key={key} tabIndex={-1}>
      {children}
    </section>
  );

  quickKeys.current = {};
  if (!item) {
    return shell(
      undefined,
      <>
        <div className="detail-head">
          <span className="muted" data-testid="detail-gone">
            这一条现在读不到（来源里没有它，单独读取也还没有结果）。下一轮同步会再读；也可以关掉这个标签页。
          </span>
        </div>
      </>,
    );
  }

  const metaOf = (k: string) => data.projects.find((p) => p.key === k);
  // GitHub#299: the title as this opening last read it from GitHub, else the board's copy (which may
  // be a round behind — e.g. right after a title change was refused because someone else changed it)
  const shownTitle = detail && fromCache === null ? detail.title : item.title;
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
  // GitHub#413: one condition per button, read by the button and by its key alike
  const opBlocked = !canWrite || busy || Boolean(lock);
  const pressCloseIssue = () => openAsk('closeIssue');
  const pressHandBack = () => void startOp({ kind: 'handBack', key: item.key }, false);
  const pressAutopilot = () => {
    // GitHub#231: "不再提示" was ticked once — no dialog, the same write as its "确认托管"
    if (!state.autopilotConfirm) return void runAutopilot();
    setNoMoreAsk(false);
    openAsk('autopilot');
  };
  // GitHub#434: "等前置…" — only when a waiting label is set; greyed (with why) when the item is in another flow
  const blockedLabel = state.blockedLabels.blocked;
  const itemOpen = detail ? detail.state === 'open' : item.state === 'open';
  const blockedEntry = entryState(detail?.labels.map((l) => l.name) ?? item.labels.map((l) => l.name), hb, state.blockedLabels);
  const blockedWhy = !itemOpen ? '这一条已经关闭' : blockedEntry.kind === 'other' ? `挂着「${blockedEntry.label}」：这一条还在别的流程里，daemon 这时不会处理等前置。等它回到「${hb.human}」后再登记` : null;
  const pressBlocked = () => setBlockedOpen(true);
  quickKeys.current = {
    blocked: detailRead && blockedLabel && !opBlocked && !blockedWhy ? pressBlocked : undefined,
    closeIssue: issueOpen && !opBlocked ? pressCloseIssue : undefined,
    handBack: detailRead && !opBlocked ? pressHandBack : undefined,
    autopilot: detailRead && hb.autopilot && !opBlocked ? pressAutopilot : undefined,
  };
    const msTitles = [...new Set((opts?.milestones ?? []).map((m) => m.title))];

  // GitHub#260: what goes behind the notices button in the head (see DetailNotices)
  const headOps = myOps.filter((r) => opAutoDismissable(r));
  const liveOps = myOps.filter((r) => !r.dismissed && !opAutoDismissable(r));
  const draftOps = myOps.filter((r) => r.dismissed && opDraftLeft(r));
  const openMarks = marks.filter((m) => m.status === 'failed' || m.status === 'unconfirmed');
  const noteIn = note !== null && note.kind !== 'ok';
  const loadErrIn = Boolean(loadError && detail);
  const noticeCount = liveOps.length + draftOps.length + openMarks.length + (noteIn ? 1 : 0) + (loadErrIn ? 1 : 0);
  const opTones = liveOps.map((r) => opTone(r));
  // GitHub#357: the button follows the same facts as the notices behind it
  const noticeTone: NoticeTone = opTones.includes('busy') || openMarks.some((m) => state.editsResending.includes(m.id))
    ? 'busy'
    : opTones.includes('error') || openMarks.length > 0 || loadErrIn || note?.kind === 'error'
      ? 'error'
      : opTones.includes('warn') || note?.kind === 'warn' || draftOps.length > 0
        ? 'warn'
        : 'ok';

  return shell(
    item.key,
    <>
      <div className="detail-head">
        {/* a detail shown from this run's memory (GitHub#229) is older than the board: the board's draft mark wins until it is read again */}
        <span className="head-info">
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
        {note?.kind === 'ok' && <HeadNote note={note} onExpire={() => setNote(null)} />}
        {headOps.map((r) => (
          <HeadOp key={r.id} r={r} />
        ))}
        </span>
        {/* GitHub#260: the buttons stay together; on a narrow panel they move to a line of their own instead of running off the edge */}
        <span className="head-actions">
        <button className="icon-btn" onClick={() => api().openExternal(item.url)} data-testid="detail-open-web" aria-label="在网页打开" title="在网页打开">
          <Icon name="ext" />
        </button>
        <button
          className={`icon-btn fields-btn${fieldsShown ? ' on' : ''}`}
          data-testid="fields-toggle"
          data-shown={fieldsShown ? 'yes' : 'no'}
          aria-pressed={fieldsShown}
          aria-label={fieldsShown ? '收起标签、里程碑、看板字段' : '显示标签、里程碑、看板字段'}
          title={fieldsShown ? '收起标签、里程碑、看板字段' : '显示标签、里程碑、看板字段'}
          onClick={() => showFields(!fieldsShown)}
        >
          <Icon name="sliders" />
        </button>
        {noticeCount > 0 && (
          <DetailNotices count={noticeCount} tone={noticeTone}>
            {note && note.kind !== 'ok' && <ResultBanner note={note} testid="action-result" />}
            {loadError && detail && (
              <div className="banner error" data-testid="detail-error">
                <Icon name="warn" />
                <span className="banner-text">{loadError}</span>
              </div>
            )}
            {liveOps.map((r) => (
              <OpNotice key={r.id} r={r} onRetry={retryOp} onToReply={toReply} />
            ))}
            {draftOps.map((r) => (
              <div key={r.id} className="detail-stale small op-draft-line">
                <button className="link" data-testid="op-draft-line" onClick={() => void api().opDismiss(r.id, false)}>
                  {opDraftLeft(r)?.comment !== undefined ? '有一条没发出的附带评论' : '有一次没完成的操作的草稿'}，点这里找回
                </button>
              </div>
            ))}
            <EditIssues marks={marks} canWrite={canWrite} resending={state.editsResending} />
          </DetailNotices>
        )}
        {/* clickable while reading too (GitHub#217): a newer read supersedes the one in flight */}
        <button
          className={`icon-btn${loading ? ' spinning' : ''}`}
          onClick={() => {
            void load();
            rereadOptions();
            // GitHub#397: an item no complete read carries: its tab's own check too
            void Promise.resolve(api().checkTab(itemKey)).catch(() => undefined);
          }}
          data-testid="detail-refresh"
          data-loading={loading ? 'yes' : 'no'}
          aria-label={loading ? '读取中…（点一下重新读取）' : '刷新这一条'}
          title={loading ? '读取中…（点一下：重新读取）' : '刷新这一条（连同标签 / 里程碑列表）'}
        >
          <Icon name="refresh" />
        </button>
        </span>
      </div>
      <div className="detail-title-row">
        <h3 className="detail-title" data-testid="detail-title">{shownTitle}</h3>
        {/* GitHub#299: only where GitHub said this account may change the item */}
        {detail?.canEdit === true && (
          <button
            className="icon-btn"
            data-testid="detail-edit-title"
            aria-label="编辑标题"
            title={canWrite && !busy && !editing ? '编辑标题' : (offlineWhy ?? '有修改在途时不能编辑')}
            disabled={!canWrite || busy || !!editing}
            onClick={() => {
              setTitleNote(null);
              setTitleEdit({ seen: shownTitle, text: shownTitle });
            }}
          >
            <Icon name="pencil" />
          </button>
        )}
      </div>
      {fromCache !== null && !loadError && autoFailed === null && (
        <div className="detail-stale muted" data-testid="detail-cached" role="status">
          显示 {clock(fromCache)} 读到的内容{loading ? ' · 正在更新…' : ''}
        </div>
      )}
      {/* nothing read yet: the failure takes the discussion's place, in the open */}
      {loadError && !detail && (
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

      {fieldsShown && (
      <section className="detail-fields" data-testid="detail-fields">
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
            <div className="field-row project-row" key={m.projectKey} data-testid="project-fields" data-project={m.projectKey}>
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

      <section className="reply" data-testid="reply" onClick={replyCardClick}>
        <textarea
          data-testid="reply-input"
          data-keys="reply"
          ref={replyBox}
          onMouseDown={replyPress}
          value={reply}
          placeholder={canWrite ? `回复（支持 markdown）· 按 ${keyText('reply')} 随时跳到这里` : '离线时不能回复'}
          disabled={!canWrite || busy}
          onChange={(e) => {
            setReply(e.target.value);
            if (!e.target.value.trim()) {
              // emptied: what is sent next is not that operation's kept comment any more
              setReplyFromOp(null);
            }
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
        {preview !== null && (
          <iframe
            className="preview"
            title="预览"
            data-testid="reply-preview"
            sandbox={FRAME_SANDBOX}
            srcDoc={previewDocument(preview, isDark)}
          />
        )}
        {item.kind === 'pr' && pr && (
          <div className={`pr-bar${prOpen && pr.mergeStateStatus === 'CLEAN' ? ' mergeable' : ''}${conflict ? ' conflict' : ''}`} data-testid="pr-box" data-conflict={conflict ? 'yes' : 'no'}>
            {conflict && (
              <div className="banner error" data-testid="pr-conflict">
                <Icon name="warn" />
                <span className="banner-text">
                  <b>有冲突</b>：这个 PR 和目标分支 <code>{pr.baseRef}</code> 有冲突，GitHub 不能合并。先在分支上解决冲突（或在网页上点「Resolve conflicts」），再回来合并。
                </span>
              </div>
            )}
            <div className="pr-line">
              {/* GitHub#260: one icon per state, its words on hover (and for screen readers); the colour comes from prStatus.ts alone */}
              <span className="pr-status" data-testid="pr-status">
                {pr.merged ? (
                  <span className="kind done">
                    <Icon name="pr-merged" />
                    已合并
                  </span>
                ) : (
                  <>
                    {prStatusIcons(pr).map((x) => (
                      <span key={x.key} className="pr-icon" data-testid="pr-icon" data-key={x.key} data-tone={x.tone} title={x.text} tabIndex={0}>
                        <PrToneIcon tone={x.tone} />
                        <span className="pr-icon-name" aria-hidden="true">
                          {x.name}
                        </span>
                        <span className="sr-only">{x.text}</span>
                      </span>
                    ))}
                    <span className="branch" data-testid="pr-branch" title={`${pr.headRef} → ${pr.baseRef} · 提交 ${pr.headOid.slice(0, 7)}`} tabIndex={0}>
                      <span aria-hidden="true">→ {pr.baseRef}</span>
                      <span className="sr-only">
                        {pr.headRef} → {pr.baseRef} · 提交 {pr.headOid.slice(0, 7)}
                      </span>
                    </span>
                  </>
                )}
              </span>
              {prOpen && (
                <span className="pr-actions">
                  <select
                    data-testid="merge-method"
                    value={method}
                    onChange={(e) => {
                      const m = e.target.value as MergeMethod;
                      setPicked(m);
                      void Promise.resolve(api().setMergeMethod(item.repo, m)).catch(() => undefined);
                    }}
                    disabled={!canWrite || busy}
                    title={method ? METHOD_LABEL[method] : undefined}
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
                </span>
              )}
            </div>
            {prOpen && pr.mergeMethods.length === 0 && <div className="small err pr-note">这个仓库没有开启任何合并方式</div>}
          </div>
        )}
        <div className="row end">
          {issueOpen && (
            <button
              className="danger"
              data-testid="close-issue"
              disabled={opBlocked}
              title={offlineWhy ?? lockWhy ?? `在 GitHub 上关闭这个 issue（先选原因，${keyText('closeIssue')}）`}
              onClick={pressCloseIssue}
            >
              关闭 issue…
              <kbd>{keyText('closeIssue')}</kbd>
            </button>
          )}
          <div className="spacer" />
          {/* GitHub#433: every button with a key carries it itself, the same way */}
          <button data-testid="reply-preview-toggle" disabled={previewBlocked} title={`预览（${keyText('preview')}）`} onClick={() => void togglePreview()}>
            {preview !== null ? '继续编辑' : '预览'}
            <kbd>{keyText('preview')}</kbd>
          </button>
          {detailRead && (
            <span className="quick-actions" data-testid="quick-actions">
              {blockedLabel && (
                <button
                  data-testid="blocked-open"
                  disabled={opBlocked || Boolean(blockedWhy)}
                  title={offlineWhy ?? lockWhy ?? blockedWhy ?? `选这一条要等的 issue / PR，登记后挂上「${blockedLabel}」；前置全部完成后 daemon 自动翻回「${hb.agent}」（${keyText('blocked')}）`}
                  onClick={pressBlocked}
                >
                  等前置…
                  <kbd>{keyText('blocked')}</kbd>
                </button>
              )}
              <button
                data-testid="hand-back"
                disabled={opBlocked}
                title={offlineWhy ?? lockWhy ?? `加上「${hb.agent}」、去掉「${hb.human}」（标签名在设置里改，${keyText('handBack')}）`}
                onClick={pressHandBack}
              >
                交给 agent
                <kbd>{keyText('handBack')}</kbd>
              </button>
              {hb.autopilot && (
                <button
                  data-testid="autopilot"
                  disabled={opBlocked}
                  title={
                    offlineWhy ??
                    lockWhy ??
                    `加上「${hb.autopilot}」再交给 agent：复审通过、检查通过后由 daemon 自动合并（标签名在设置里改）${state.autopilotConfirm ? '' : '；已设为不再提示，点了直接托管（设置里可改回）'}（${keyText('autopilot')}）`
                  }
                  onClick={pressAutopilot}
                >
                  {state.autopilotConfirm ? '托管（自动合并）…' : '托管（自动合并）'}
                  <kbd>{keyText('autopilot')}</kbd>
                </button>
              )}
            </span>
          )}
          <button className="primary" data-testid="reply-send" disabled={sendBlocked} title={`发送（${keyText('send')}）`} onClick={() => void send()}>
            发送
            <kbd>{keyText('send')}</kbd>
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
      {blockedOpen && <BlockedDialog item={item} state={state} items={data.items} onClose={() => setBlockedOpen(false)} />}
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
      {titleEdit && (
        <ConfirmDialog
          title="编辑标题"
          confirmLabel="保存到 GitHub"
          busy={busy}
          disabled={!titleEdit.text.trim() || titleEdit.text.trim() === titleEdit.seen}
          dirty={titleEdit.text !== titleEdit.seen}
          onCancel={() => setTitleEdit(null)}
          onConfirm={async () => {
            const r = await run({ kind: 'editTitle', key: item.key, title: titleEdit.text, seenTitle: titleEdit.seen }, '标题已保存');
            if (!r.here) return;
            if (r.ok) {
              setTitleEdit(null);
              setTitleNote(null);
            } else setTitleNote(noteOf(r, ''));
          }}
        >
          {/* not in a form: a plain Enter submits nothing — only the button or ⌘↩ (as in every dialog) */}
          <input
            ref={titleInput}
            className="title-box"
            data-testid="edit-title-input"
            aria-label="标题"
            value={titleEdit.text}
            onChange={(e) => setTitleEdit({ ...titleEdit, text: e.target.value })}
          />
          <ResultBanner note={titleNote} testid="edit-title-result" />
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
