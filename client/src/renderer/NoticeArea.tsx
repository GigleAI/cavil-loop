// GitHub#488: the window's one notice area. Every result the controller holds — an operation (close,
// merge, 托管, 交给 agent, 等前置), a new issue on its way or what came of it, changes not saved — is
// said here, under the tab bar and above every page, whichever page / tab / panel is showing. Nowhere
// else says them (not the detail, not above the board), so each is said exactly once. What each notice
// says and which buttons it has are unchanged: the same components and the same rules as before.
// Newest on top; three at most, the rest folded behind 「还有 N 条」. A click in it never puts the floating
// panel away (like the tab bar): its buttons act on the item the panel may well be showing.

import { useRef, useState } from 'react';
import type { AppState, BoardData, CreateJob } from '../shared/types';
import { writesEnabled } from '../data/board';
import { createFailures, createTone, editsTone } from '../shared/noticeTone';
import type { OpRecord } from '../shared/ops';
import { api } from './api';
import { Icon } from './Icons';
import { copyText } from './pasteImage';
import { OpNotice } from './OpNotice';
import { EditIssues } from './DetailPanel';
import type { OpenIntent } from './BoardView';
import type { OpenHow } from './OpenMenu';
import { noticeOrder } from './noticeOrder';
import { KEEPS_PANEL } from './outsideClick';

/** how many notices show before the rest fold behind 「还有 N 条」 */
export const NOTICE_SHOWN = 3;

type Entry = { id: string; order: number; node: React.ReactNode };

export function NoticeArea({
  state,
  data,
  open,
  onDraft,
}: {
  state: AppState;
  data: BoardData;
  open: (key: string, how: OpenHow, intent?: OpenIntent | null) => void;
  /** a failed create's 重新打开草稿: the new-issue dialog on the board, with that draft */
  onDraft: (d: CreateJob['draft']) => void;
}) {
  const seen = useRef(new Map<string, number>());
  const next = useRef({ n: 0 });
  const [all, setAll] = useState(false);
  const openFloat = (key: string) => open(key, 'float');
  const entries: Entry[] = [];
  for (const r of state.ops) {
    if (r.dismissed) continue;
    entries.push({
      id: `op:${r.id}`,
      order: r.startedAt,
      node: (
        <OpNotice
          key={`op:${r.id}`}
          r={r}
          prefix={`${r.repo}#${r.number}：`}
          onOpen={openFloat}
          onRetry={(x: OpRecord) => open(x.key, 'float', { opId: x.id, what: 'retry' })}
          onToReply={(x: OpRecord) => open(x.key, 'float', { opId: x.id, what: 'toReply' })}
        />
      ),
    });
  }
  for (const j of state.creates) {
    // GitHub#258: created, only boards not ticked still being watched: nothing to say
    if (j.status === 'watching') continue;
    entries.push({ id: `create:${j.id}`, order: Number.MAX_SAFE_INTEGER - 1e6 + j.id, node: <CreateBar key={`create:${j.id}`} job={j} onOpen={openFloat} onDraft={onDraft} /> });
  }
  if (state.editsNeedingAction) entries.push({ id: 'edits', order: Number.MAX_SAFE_INTEGER, node: <EditsNotice key="edits" state={state} data={data} onOpen={openFloat} /> });
  const order = noticeOrder(entries, seen.current, next.current);
  if (!entries.length) return null;
  const byId = new Map(entries.map((e) => [e.id, e]));
  const more = order.length - NOTICE_SHOWN;
  const shown = all || more <= 0 ? order : order.slice(0, NOTICE_SHOWN);
  return (
    <div className="notice-area" data-testid="notice-area" data-count={order.length} role="region" aria-label="操作结果" {...{ [KEEPS_PANEL]: '' }}>
      {shown.map((id) => byId.get(id)!.node)}
      {more > 0 && (
        <button className="link notice-more" data-testid="notice-more" data-more={more} aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? '收起，只看最新 3 条' : `还有 ${more} 条`}
        </button>
      )}
    </div>
  );
}

/**
 * The items with a change not saved / not confirmed, each once: the board data can carry one item in several
 * rows (two iterations, two Projects), its changes are the same record (said once, GitHub#488).
 */
export function itemsWithIssues(data: BoardData): BoardData['items'] {
  const seen = new Set<string>();
  return data.items.filter((i) => {
    if (seen.has(i.key) || !i.edits?.some((m) => m.status === 'failed' || m.status === 'unconfirmed')) return false;
    seen.add(i.key);
    return true;
  });
}

/** the changes not saved: the bar for all of them, then each item's own list */
function EditsNotice({ state, data, onOpen }: { state: AppState; data: BoardData; onOpen: (key: string) => void }) {
  const items = itemsWithIssues(data);
  return (
    <div className="notice-edits" data-testid="notice-edits">
      <EditsBar state={state} data={data} onOpen={onOpen} />
      {items.map((i) => (
        <EditIssues
          key={i.key}
          marks={i.edits ?? []}
          canWrite={writesEnabled(state.sync)}
          resending={state.editsResending}
          about={
            <button className="link edit-issues-about" data-testid="edit-issues-item" data-key={i.key} onClick={() => onOpen(i.key)}>
              {i.repo}#{i.number}：
            </button>
          }
        />
      ))}
    </div>
  );
}

/**
 * GitHub#229: changes that need the user (not saved / not confirmed), also the ones left
 * from the last run. GitHub#488: each item's own list (both values side by side, its own
 * resend / give-up buttons) follows right under it — no longer in the item's detail.
 */
function EditsBar({ state, data, onOpen }: { state: AppState; data: BoardData; onOpen: (key: string) => void }) {
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  if (!state.editsNeedingAction) return null;
  const items = itemsWithIssues(data);
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
            ；下面逐条列出两边的值）
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
export function CreateBar({ job, onOpen, onDraft }: { job: CreateJob; onOpen: (key: string) => void; onDraft: (d: CreateJob['draft']) => void }) {
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
