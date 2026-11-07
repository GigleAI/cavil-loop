import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AppState, BoardData } from '../shared/types';
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

/** GitHub#205: an image was pasted where it cannot be uploaded from; offer the web page instead. */
export function PasteImageNotice({ copied, onWeb, onDismiss, webLabel = '到 GitHub 网页上继续写' }: { copied: boolean | null; onWeb: () => void; onDismiss: () => void; webLabel?: string }) {
  return (
    <div className="banner warn paste-image" data-testid="paste-image-note">
      <Icon name="warn" />
      <span className="banner-text">
        {PASTE_IMAGE_NOTE}
        {copied === true && ' 你写的文字已复制，在网页上粘贴后再贴图。'}
        {copied === false && ' 没能复制你写的文字，请先手动复制。'}
      </span>
      <button data-testid="paste-image-web" onClick={onWeb}>
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
}: {
  itemKey: string;
  state: AppState;
  data: BoardData;
  onClose: () => void;
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
  const [closeComment, setCloseComment] = useState('');
  const [closeReason, setCloseReason] = useState<IssueCloseReason>('completed');
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

  // a fresh panel per opening: nothing to reset here, just read
  useEffect(() => {
    void load();
  }, [load]);
  // GitHub#226: a sync round read a source carrying this item completely → maybe read the detail again.
  // The mark the panel opened with is not a new round (the opening read is already on its way).
  const mark = freshMark(item, state.sync.sources);
  const lastMark = useRef(mark);
  useEffect(() => {
    if (mark === lastMark.current) return;
    lastMark.current = mark;
    if (mark === null) return;
    if (shouldAutoRefresh({ item, readAt: readAt.current, detail, busy, loading })) void load(true);
    // only a new round decides; the values are this render's
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mark]);
  useEffect(() => {
    if (!repo) return;
    setOpts(null);
    const mine = session.begin('options');
    api()
      .repoOptions(repo)
      .then((o) => mine() && setOpts(o));
  }, [repo, session]);
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
  const pickBlocked = !item || !canWrite || busy || !opts;
  const send = async () => {
    if (!item) return;
    const r = await run({ kind: 'comment', key: item.key, body: reply }, '评论已发出');
    if (r.ok && r.here) {
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
        <KindBadge kind={item.kind} state={item.state} reason={item.stateReason} isDraft={detail?.pr ? detail.pr.isDraft : (item.isDraft ?? null)} />
        <span className="ref">
          {item.repo} #{item.number}
        </span>
        <div className="spacer" />
        <button className="ghost" onClick={() => api().openExternal(item.url)} data-testid="detail-open-web">
          <Icon name="ext" />
          在网页打开
        </button>
        {/* clickable while reading too (GitHub#217): a newer read supersedes the one in flight */}
        <button
          className={`icon-btn${loading ? ' spinning' : ''}`}
          onClick={() => void load()}
          data-testid="detail-refresh"
          data-loading={loading ? 'yes' : 'no'}
          aria-label={loading ? '读取中…（点一下重新读取）' : '刷新这一条'}
          title={loading ? '读取中…（点一下：重新读取）' : '刷新这一条'}
        >
          <Icon name="refresh" />
        </button>
        <button className="ghost" onClick={onClose} data-testid="detail-close" title={HIDE_TITLE}>
          {HIDE_LABEL}
        </button>
      </div>
      <h3 className="detail-title">{item.title}</h3>
      <ResultBanner note={note} testid="action-result" />
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

      <section className="detail-fields">
        <div className="field-row" data-testid="detail-people">
          <span className="field-name">作者</span>
          <Person login={item.author} size={20} />
          {item.assignees.length > 0 && (
            <>
              <span className="field-name">负责人</span>
              <span className="people">
                {item.assignees.map((a) => (
                  <Person key={a} login={a} size={20} />
                ))}
              </span>
            </>
          )}
        </div>
        <div className="field-row">
          <span className="field-name">标签</span>
          <div className="labels">
            {item.labels.map((l) => (
              <span key={l.name} className="label" style={labelStyle(l.color, isDark)}>
                {l.name}
                <button
                  className="label-x"
                  data-testid="label-remove"
                  data-label={l.name}
                  title={offlineWhy ?? `去掉「${l.name}」`}
                  disabled={!canWrite || busy}
                  onClick={() => void run({ kind: 'removeLabel', key: item.key, label: l.name }, `已去掉标签「${l.name}」`)}
                >
                  <Icon name="x" size={10} />
                </button>
              </span>
            ))}
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
                  disabled={!canWrite || busy}
                  items={[
                    ...opts.labels.map((l) => ({ name: l.name, color: l.color, checked: item.labels.some((x) => x.name === l.name) })),
                    ...item.labels.filter((l) => !opts.labels.some((x) => x.name === l.name)).map((l) => ({ name: l.name, color: l.color, checked: true })),
                  ]}
                  onToggle={(l) =>
                    void (l.checked
                      ? run({ kind: 'removeLabel', key: item.key, label: l.name }, `已去掉标签「${l.name}」`)
                      : run({ kind: 'addLabel', key: item.key, label: l.name }, `已加上标签「${l.name}」`))
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
              void run({ kind: 'setMilestone', key: item.key, title: e.target.value || null }, e.target.value ? `里程碑改成「${e.target.value}」` : '已去掉里程碑')
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
                disabled={!canWrite || busy}
                items={[
                  ...(item.milestone && !msTitles.includes(item.milestone.title) ? [item.milestone.title] : []),
                  ...msTitles,
                ].map((t) => ({ name: t, checked: item.milestone?.title === t }))}
                onToggle={(m) => {
                  setPicker(null);
                  void run({ kind: 'setMilestone', key: item.key, title: m.checked ? null : m.name }, m.checked ? '已去掉里程碑' : `里程碑改成「${m.name}」`);
                }}
                onClose={() => setPicker(null)}
              />
            )}
          </span>
          {opts?.error && <span className="small err">{opts.error}</span>}
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
                  disabled={!canWrite || ro || busy}
                  title={why}
                  onChange={(e) =>
                    void run(
                      { kind: 'setIteration', key: item.key, projectKey: p.key, iterationId: e.target.value || null },
                      `看板「${p.title}」的迭代已改`,
                    )
                  }
                >
                  <option value="">（无迭代）</option>
                  {m.iteration && !p.iterations.some((i) => i.id === m.iteration!.id) && <option value={m.iteration.id}>{m.iteration.title}</option>}
                  {p.iterations.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.title}（{i.startDate} 起）
                    </option>
                  ))}
                </select>
              )}
              {p.statusFieldId && (
                <select
                  data-testid="status-select"
                  value={m.status ?? ''}
                  disabled={!canWrite || ro || busy}
                  title={why}
                  onChange={(e) =>
                    void run({ kind: 'setStatus', key: item.key, projectKey: p.key, status: e.target.value || null }, `看板「${p.title}」的状态已改`)
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
                disabled={!canWrite || busy || !method || conflict}
                title={offlineWhy ?? (conflict ? conflictWhy : undefined)}
                onClick={() => setAsk('merge')}
              >
                {conflict ? '有冲突，不能合并' : '合并…'}
              </button>
              <button className="danger" data-testid="close-pr" disabled={!canWrite || busy} title={offlineWhy} onClick={() => setAsk('close')}>
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
            <button className="danger" data-testid="close-issue" disabled={!canWrite || busy} title={offlineWhy ?? '在 GitHub 上关闭这个 issue（先选原因）'} onClick={() => setAsk('closeIssue')}>
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
                disabled={!canWrite || busy}
                title={offlineWhy ?? `加上「${hb.agent}」、去掉「${hb.human}」（标签名在设置里改）`}
                onClick={() => void run({ kind: 'handBack', key: item.key }, `已交给 agent：加上「${hb.agent}」、去掉「${hb.human}」`)}
              >
                交给 agent
              </button>
              {hb.autopilot && (
                <button
                  data-testid="autopilot"
                  disabled={!canWrite || busy}
                  title={offlineWhy ?? `加上「${hb.autopilot}」再交给 agent：复审通过、检查通过后由 daemon 自动合并（标签名在设置里改）`}
                  onClick={() => setAsk('autopilot')}
                >
                  托管（自动合并）…
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
          onCancel={() => setAsk(null)}
          onConfirm={async () => {
            const r = await run({ kind: 'merge', key: item.key, method, headOid: pr.headOid }, `PR #${item.number} 已合并`);
            if (r.here) setAsk(null);
          }}
        >
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
          onCancel={() => setAsk(null)}
          onConfirm={async () => {
            const r = await run({ kind: 'autopilot', key: item.key }, `已托管：加上「${hb.autopilot}」「${hb.agent}」、去掉「${hb.human}」`);
            if (r.here) setAsk(null);
          }}
        >
          <p data-testid="autopilot-explain">
            会加上标签 <code>{hb.autopilot}</code> 和 <code>{hb.agent}</code>、去掉 <code>{hb.human}</code>：agent 接手，从方案到合并不再等你确认；独立复审通过、检查通过后由 daemon 自动合并。
            要叫停，在网页上去掉 <code>{hb.autopilot}</code> 标签。只有维护者亲手加的托管标签才算数。
          </p>
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
          onCancel={() => setAsk(null)}
          onConfirm={async () => {
            const r = await run({ kind: 'closePr', key: item.key, comment: closeComment }, `PR #${item.number} 已关闭`);
            if (!r.here) return;
            if (r.ok) setCloseComment('');
            setAsk(null);
          }}
        >
          <textarea data-testid="close-comment" placeholder="可选：附一句评论（关闭成功后发出）" value={closeComment} onChange={(e) => setCloseComment(e.target.value)} />
        </ConfirmDialog>
      )}
      {ask === 'closeIssue' && (
        <ConfirmDialog
          title={`关闭 issue #${item.number}？`}
          confirmLabel="确认关闭"
          danger
          busy={busy}
          onCancel={() => setAsk(null)}
          onConfirm={async () => {
            const reason = closeReason;
            const r = await run({ kind: 'closeIssue', key: item.key, reason, comment: closeComment }, `issue #${item.number} 已关闭（${CLOSE_REASON[reason].name}）`);
            if (!r.here) return;
            if (r.ok) setCloseComment('');
            setAsk(null);
          }}
        >
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
