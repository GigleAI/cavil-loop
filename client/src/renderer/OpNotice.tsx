// GitHub#250: the notice of one close / merge / autopilot / hand-back operation. What it
// says and which buttons it offers come from shared/ops.ts alone (the same functions the
// send gate uses), in the panel and above the board alike.

import { useState, type ReactNode } from 'react';
import { t, tKey, zhKey } from '../shared/i18n';
import { Verbatim } from './Verbatim';
import { AUTO_DISMISS_MS, opAutoDismissable, opButtons, opDraftLeft, opPhase, opResendConfirm, opText, opTone, type OpButton, type OpRecord } from '../shared/ops';
import { ConfirmDialog } from './ConfirmDialog';
import { useAutoDismiss } from './autoDismiss';
import { api } from './api';
import { Icon } from './Icons';
import { copyText } from './pasteImage';

/** Chinese keys, shown through tKey() */
const RETRY_LABEL: Record<OpRecord['kind'], string> = {
  closeIssue: zhKey('重新关闭…'),
  closePr: zhKey('重新关闭…'),
  merge: zhKey('重新合并…'),
  autopilot: zhKey('重新托管…'),
  handBack: zhKey('重新交给 agent'),
  // GitHub#434: opens the dialog again, read afresh
  blocked: zhKey('等前置…（重新登记）'),
};

export function opItemUrl(r: OpRecord): string {
  // GitHub sends /issues/N of a PR on to the PR itself
  return `https://github.com/${r.repo}/issues/${r.number}`;
}

export function OpNotice({
  r,
  prefix,
  onRetry,
  onToReply,
  onOpen,
}: {
  r: OpRecord;
  /** above the board: which item it is about */
  prefix?: ReactNode;
  /** the dialog again, with the draft restored */
  onRetry: (r: OpRecord) => void;
  /** the kept comment into the reply box */
  onToReply: (r: OpRecord) => void;
  /** above the board: open the item */
  onOpen?: (key: string) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean | null>(null);
  const [working, setWorking] = useState(false);
  // GitHub#359: "仍要重发…" asks first, saying what a second send can cause
  const [asking, setAsking] = useState(false);
  const confirm = opResendConfirm(r);
  const tone = opTone(r);
  const phase = opPhase(r);
  const buttons = opButtons(r);
  const left = opDraftLeft(r);
  const has = (b: OpButton) => buttons.includes(b);
  // GitHub#357: the tone is the class (styles.css), decided by shared/noticeTone.ts alone
  // GitHub#256: a fully successful notice puts itself away after 5 s, exactly like the ×
  const auto = useAutoDismiss(opAutoDismissable(r), AUTO_DISMISS_MS, () => void api().opDismiss(r.id, true), r.id);
  const run = async (f: () => Promise<{ ok: boolean; error: string | null } | void>) => {
    setWorking(true);
    setProblem(null);
    try {
      const out = await f();
      if (out && !out.ok) setProblem(out.error ?? t('没有成功'));
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className={`banner ${tone} op-notice`} data-testid="op-notice" data-kind={tone} data-phase={phase} data-op={r.id} data-key={r.key} {...auto}>
      {tone === 'busy' ? <span className="spin" aria-hidden="true" /> : <Icon name={tone === 'ok' || tone === 'info' ? 'check' : 'warn'} />}
      <span className="banner-text">
        {prefix && <b>{prefix}</b>}
        <span data-testid="op-notice-text">{opText(r)}</span>
        {left?.comment !== undefined && phase !== 'waiting' && (
          <span className="op-draft" data-testid="op-draft-comment">
            {t('附的评论原文：')}
            <q>
              <Verbatim from="user">{left.comment}</Verbatim>
            </q>
          </span>
        )}
        <span className="op-buttons">
          {onOpen && (
            <button className="link" data-testid="op-open" onClick={() => onOpen(r.key)}>
              {t('打开')}
            </button>
          )}
          {has('resend') && (
            <button className="link" data-testid="op-resend" disabled={working} onClick={() => setAsking(true)}>
              {t('仍要重发…')}
            </button>
          )}
          {has('openWeb') && (
            <button className="link" data-testid="op-open-web" onClick={() => void api().openExternal(opItemUrl(r))}>
              {t('去 GitHub 页面核对')}
            </button>
          )}
          {has('unlock') && (
            <button className="link" data-testid="op-unlock" title={t('在 GitHub 页面核对过以后再点：只解开这里的锁定，不会往 GitHub 发任何请求')} onClick={() => void api().opUnlock(r.id)}>
              {t('已核对，解除锁定')}
            </button>
          )}
          {has('retry') && (
            <button className="link" data-testid="op-retry" onClick={() => onRetry(r)}>
              {tKey(RETRY_LABEL[r.kind])}
            </button>
          )}
          {has('finish') && (
            <button className="link" data-testid="op-finish" disabled={working} onClick={() => void run(() => api().opFinish(r.id))}>
              {t('补做剩下的步骤')}
            </button>
          )}
          {has('copy') && left?.comment !== undefined && (
            <button
              className="link"
              data-testid="op-copy"
              onClick={() => {
                const text = left.comment ?? '';
                void copyText(text).then(setCopied);
              }}
            >
              {copied === true ? t('已复制') : copied === false ? t('复制失败') : t('复制原文')}
            </button>
          )}
          {has('toReply') && (
            <button className="link" data-testid="op-to-reply" onClick={() => onToReply(r)}>
              {t('放进回复框')}
            </button>
          )}
          {has('dropDraft') && (
            <button className="link" data-testid="op-drop-draft" title={t('丢掉以后找不回来')} onClick={() => void api().opDropDraft(r.id)}>
              {t('丢掉草稿')}
            </button>
          )}
        </span>
        {/* GitHub#357: what the record itself says ("这次没能查证 / 补做：…") is not said twice */}
        {problem && !opText(r).includes(problem) && (
          <span className="small err" data-testid="op-problem">
            {' '}
            {problem}
          </span>
        )}
      </span>
      {asking && confirm && (
        <ConfirmDialog
          title={confirm.title}
          confirmLabel={t('仍要重发')}
          busy={working}
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            void run(() => api().opResend(r.id));
          }}
        >
          <div data-testid="op-resend-confirm">
            {confirm.lines.map((line, i) => (
              <p key={i}>{line}</p>
            ))}
            {confirm.after && <p className="small">{confirm.after}</p>}
          </div>
        </ConfirmDialog>
      )}
      {has('dismiss') && (
        <button className="banner-close" aria-label={t('关掉提示')} title={left ? t('关掉提示（草稿还留着，可以从这一条的详情里找回）') : t('关掉提示')} data-testid="op-dismiss" onClick={() => void api().opDismiss(r.id, true)}>
          <Icon name="x" />
        </button>
      )}
    </div>
  );
}
