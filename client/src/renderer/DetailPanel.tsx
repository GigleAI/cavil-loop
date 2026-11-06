import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, BoardData } from '../shared/types';
import { ISSUE_CLOSE_REASONS, type IssueCloseReason, type ItemDetail, type MergeMethod, type RepoOptions, type WriteAction, type WriteResult } from '../shared/actions';
import { writesEnabled } from '../data/board';
import { api } from './api';
import { ConfirmDialog } from './ConfirmDialog';
import { pickMergeMethod } from '../shared/mergePrefs';
import { FRAME_SANDBOX, timelineDocument, escapeHtml, FRAME_CSP, type Unfold } from './detailHtml';
import { Person } from './Avatar';
import { usePanelWidth } from './panelWidth';
import { textColor } from './colors';
import { createOpenSession, type OpenSession } from './openSession';
import { KindBadge } from './KindBadge';
import { hidesPanel, pressAt, releaseAt, type Press } from './outsideClick';

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
const HIDE_TITLE = '收起（或点面板以外的地方、按 Esc；点过讨论后，先点一下讨论以外的地方再按 Esc）';
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
      {note.text}
    </div>
  );
}

function dark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [opts, setOpts] = useState<RepoOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ResultNote | null>(null);
  const [reply, setReply] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [replied, setReplied] = useState(false);
  /** the method picked by hand in this opening; null = none yet */
  const [picked, setPicked] = useState<MergeMethod | null>(null);
  const [ask, setAsk] = useState<'merge' | 'close' | 'closeIssue' | null>(null);
  const [closeComment, setCloseComment] = useState('');
  const [closeReason, setCloseReason] = useState<IssueCloseReason>('completed');
  const canWrite = writesEnabled(state.sync);
  const offlineWhy = canWrite ? undefined : '离线时不能修改';
  const repo = item?.repo ?? '';

  const load = useCallback(async () => {
    const mine = session.begin('detail');
    setLoading(true);
    const r = await api().loadDetail(itemKey);
    if (!mine()) return;
    setLoading(false);
    if (r.ok) {
      setDetail(r.detail);
      setLoadError(null);
    } else setLoadError(r.error);
  }, [itemKey, session]);

  // a fresh panel per opening: nothing to reset here, just read
  useEffect(() => {
    void load();
  }, [load]);
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
    setBusy(true);
    const r = await api().act(action);
    if (!mine()) {
      onLeftBehind(noteOf(r, `${label}：${okText}`));
      return { ...r, here: false };
    }
    setBusy(false);
    setNote(noteOf(r, okText));
    if (r.ok) void load();
    return { ...r, here: true };
  };

  // which entries are unfolded: the newest only, until the user asks for all / none (GitHub#155)
  const [unfold, setUnfold] = useState<Unfold>('latest');
  const doc = useMemo(() => (detail ? timelineDocument(detail, dark(), unfold) : ''), [detail, unfold]);
  const { width, dragging, startDrag } = usePanelWidth(state.view.detailWidth);
  // the board leaves this much room to scroll past the panel (BoardView's spacer)
  useEffect(() => {
    document.documentElement.style.setProperty('--detail-space', `${width}px`);
  }, [width]);
  // Esc closes the panel — not while typing (a draft is not thrown away by a key) or while a dialog asks.
  // Not while the discussion frame has the keyboard either: its keys stay inside it (PR #171 review,
  // the maintainer chose to keep the frame isolated); a click on the panel outside the frame gives it back.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || ask) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      onClose();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [ask, onClose]);
  // A click outside the panel puts it away (GitHub#191; the rule is outsideClick.ts): not on a card or
  // a row title (those switch items), not while a dialog was open, not with a reply typed.
  const panelRef = useRef<HTMLElement | null>(null);
  const draftRef = useRef(reply);
  draftRef.current = reply;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    let press: Press | null = null;
    const down = (e: PointerEvent) => {
      press = pressAt(e, panelRef.current);
    };
    const click = (e: MouseEvent) => {
      const p = press;
      press = null;
      if (hidesPanel(p, releaseAt(e, panelRef.current), draftRef.current)) closeRef.current();
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('click', click, true);
    };
  }, []);
  const shell = (key: string | undefined, children: React.ReactNode) => (
    // tabIndex: a click on the panel's own blank space takes the keyboard back from the discussion frame,
    // whose keys never reach this window (the frame is isolated and runs no scripts) — Esc works again after it
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
          <button onClick={onClose} data-testid="detail-close" title={HIDE_TITLE}>
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
  const missingLabels = (opts?.labels ?? []).filter((l) => !item.labels.some((x) => x.name === l.name));
  const msTitles = [...new Set((opts?.milestones ?? []).map((m) => m.title))];

  return shell(
    item.key,
    <>
      <div className="detail-head">
        <KindBadge kind={item.kind} state={item.state} reason={item.stateReason} isDraft={detail?.pr ? detail.pr.isDraft : (item.isDraft ?? null)} />
        <span className="muted small">
          {item.repo} #{item.number}
        </span>
        <div className="spacer" />
        <button className="link" onClick={() => api().openExternal(item.url)} data-testid="detail-open-web">
          在网页打开
        </button>
        <button onClick={() => void load()} disabled={loading} data-testid="detail-refresh">
          {loading ? '读取中…' : '刷新'}
        </button>
        <button onClick={onClose} data-testid="detail-close" title={HIDE_TITLE}>
          {HIDE_LABEL}
        </button>
      </div>
      <h3 className="detail-title">{item.title}</h3>
      <ResultBanner note={note} testid="action-result" />
      {loadError && (
        <div className="banner error" data-testid="detail-error">
          {loadError}
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
              <span key={l.name} className="label" style={{ background: `#${l.color || 'ddd'}`, color: textColor(l.color) }}>
                {l.name}
                <button
                  className="label-x"
                  data-testid="label-remove"
                  data-label={l.name}
                  title={offlineWhy ?? `去掉「${l.name}」`}
                  disabled={!canWrite || busy}
                  onClick={() => void run({ kind: 'removeLabel', key: item.key, label: l.name }, `已去掉标签「${l.name}」`)}
                >
                  ×
                </button>
              </span>
            ))}
            <select
              data-testid="label-add"
              value=""
              disabled={!canWrite || busy || !opts}
              title={offlineWhy ?? (opts?.error ? opts.error : `候选来自 ${item.repo} 的标签`)}
              onChange={(e) => e.target.value && void run({ kind: 'addLabel', key: item.key, label: e.target.value }, `已加上标签「${e.target.value}」`)}
            >
              <option value="">{opts ? '+ 加标签' : '读取标签…'}</option>
              {missingLabels.map((l) => (
                <option key={l.name} value={l.name}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field-row">
          <span className="field-name">里程碑</span>
          <select
            data-testid="milestone-select"
            value={item.milestone?.title ?? ''}
            disabled={!canWrite || busy || !opts}
            title={offlineWhy ?? `${item.repo} 的里程碑；客户端不新建里程碑`}
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
        <section className="pr-box" data-testid="pr-box">
          <div className="small" data-testid="pr-status">
            {pr.merged ? (
              '已合并'
            ) : (
              <>
                <span>合并：{MERGE_STATE[pr.mergeStateStatus] ?? pr.mergeStateStatus}</span>
                <span>冲突：{MERGEABLE[pr.mergeable] ?? pr.mergeable}</span>
                <span>检查：{pr.checks ? (CHECKS[pr.checks] ?? pr.checks) : '没有检查'}</span>
                <span>评审：{pr.reviewDecision ? (REVIEW[pr.reviewDecision] ?? pr.reviewDecision) : '无要求'}</span>
                <span className="muted">
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
              <button className="primary" data-testid="merge" disabled={!canWrite || busy || !method} title={offlineWhy} onClick={() => setAsk('merge')}>
                合并…
              </button>
              <button className="danger" data-testid="close-pr" disabled={!canWrite || busy} title={offlineWhy} onClick={() => setAsk('close')}>
                关闭 PR…
              </button>
            </div>
          )}
          {prOpen && pr.mergeMethods.length === 0 && <div className="small err">这个仓库没有开启任何合并方式</div>}
        </section>
      )}

      {detail && detail.timeline.length > 1 && (
        <div className="timeline-tools small">
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
          <iframe title="评论" data-testid="timeline-frame" sandbox={FRAME_SANDBOX} srcDoc={doc} />
        ) : (
          !loadError && <div className="muted center">正在从 GitHub 读取…</div>
        )}
      </div>

      <section className="reply" data-testid="reply">
        <textarea
          data-testid="reply-input"
          value={reply}
          placeholder={canWrite ? '回复（支持 markdown）' : '离线时不能回复'}
          disabled={!canWrite || busy}
          onChange={(e) => {
            setReply(e.target.value);
            session.supersede('preview');
            setPreview(null);
          }}
        />
        {preview !== null && (
          <iframe
            className="preview"
            title="预览"
            data-testid="reply-preview"
            sandbox={FRAME_SANDBOX}
            srcDoc={`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(FRAME_CSP)}"><base target="_blank"><body style="font:13px/1.5 sans-serif;margin:6px;color:${dark() ? '#e6edf3' : '#1f2328'}">${preview}</body>`}
          />
        )}
        <div className="row end">
          {replied && (
            <button
              data-testid="hand-back"
              disabled={!canWrite || busy}
              title={`去掉「${state.handBack.human}」、加上「${state.handBack.agent}」（标签名在设置里改）`}
              onClick={async () => {
                const r = await run({ kind: 'handBack', key: item.key }, `已交回 agent：去掉「${state.handBack.human}」、加上「${state.handBack.agent}」`);
                if (r.ok && r.here) setReplied(false);
              }}
            >
              交回 agent
            </button>
          )}
          {issueOpen && (
            <button data-testid="close-issue" disabled={!canWrite || busy} title={offlineWhy ?? '在 GitHub 上关闭这个 issue（先选原因）'} onClick={() => setAsk('closeIssue')}>
              关闭 issue…
            </button>
          )}
          <div className="spacer" />
          <button
            data-testid="reply-preview-toggle"
            disabled={!canWrite || !reply.trim()}
            onClick={async () => {
              if (preview !== null) return setPreview(null);
              const mine = session.begin('preview');
              const r = await api().previewMarkdown(item.repo, reply);
              if (!mine()) return;
              setPreview(r.ok ? (r.html ?? '') : `<p>${escapeHtml(r.error ?? '预览失败')}</p>`);
            }}
          >
            {preview !== null ? '继续编辑' : '预览'}
          </button>
          <button
            className="primary"
            data-testid="reply-send"
            disabled={!canWrite || busy || !reply.trim()}
            onClick={async () => {
              const r = await run({ kind: 'comment', key: item.key, body: reply }, '评论已发出');
              if (r.ok && r.here) {
                setReply('');
                setPreview(null);
                setReplied(true);
              }
            }}
          >
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
