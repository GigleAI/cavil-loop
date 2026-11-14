// GitHub#250: the notice of one close / merge / autopilot / hand-back operation. What it
// says and which buttons it offers come from shared/ops.ts alone (the same functions the
// send gate uses). GitHub#490: at most 「重试」, one way out and × (opActions).

import { useState, type ReactNode } from 'react';
import { t, tKey, zhKey } from '../shared/i18n';
import { Verbatim } from './Verbatim';
import { AUTO_DISMISS_MS, opActions, opAutoDismissable, opDraftLeft, opPhase, opResendConfirm, opText, opTone, type OpRecord, type OpRetry } from '../shared/ops';
import { ConfirmDialog } from './ConfirmDialog';
import { useAutoDismiss } from './autoDismiss';
import { api } from './api';
import { Icon } from './Icons';
import { itemPageUrl, WebButton } from './NoticeButtons';

/** GitHub#490: 「重试」 says what it does again; the redo goes out at once (no dialog). Chinese keys, shown through tKey() */
const REDO_LABEL: Record<OpRecord['kind'], string> = {
  closeIssue: zhKey('重新关闭'),
  closePr: zhKey('重新关闭'),
  merge: zhKey('重新合并'),
  autopilot: zhKey('重新托管'),
  handBack: zhKey('重新交给 agent'),
  // GitHub#434: opens the dialog again, read afresh
  blocked: zhKey('等前置…（重新登记）'),
};

function retryLabel(r: OpRecord, retry: OpRetry): string {
  switch (retry) {
    case 'redo':
    case 'blocked':
      return tKey(REDO_LABEL[r.kind]);
    case 'finish':
      return t('补做剩下的步骤');
    case 'sendComment':
      return t('再发评论');
    case 'resend':
      return t('重发…');
    case 'recheck':
      return t('再查一次');
  }
}

export function opItemUrl(r: OpRecord): string {
  return itemPageUrl(r.repo, r.number);
}

export function OpNotice({
  r,
  prefix,
  onBlocked,
  onOpen,
}: {
  r: OpRecord;
  /** above the board: which item it is about */
  prefix?: ReactNode;
  /** a "等前置…" that did not finish: its dialog again (on the item) */
  onBlocked: (r: OpRecord) => void;
  /** above the board: open the item */
  onOpen?: (key: string) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  // GitHub#359: "重发…" asks first, saying what a second send can cause
  const [asking, setAsking] = useState(false);
  const confirm = opResendConfirm(r);
  const tone = opTone(r);
  const phase = opPhase(r);
  // GitHub#490: at most one retry, one way out and ×, from the one rule
  const a = opActions(r);
  const left = opDraftLeft(r);
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
  const retry = (x: OpRetry) => {
    switch (x) {
      case 'redo':
        return void run(() => api().opRedo(r.id));
      case 'blocked':
        return onBlocked(r);
      case 'finish':
        return void run(() => api().opFinish(r.id));
      case 'sendComment':
        return void run(() => api().opSendComment(r.id));
      case 'resend':
        return setAsking(true);
      case 'recheck':
        return void run(() => api().opRecheck(r.id));
    }
  };
  return (
    <div className={`banner ${tone} op-notice`} data-testid="op-notice" data-kind={tone} data-phase={phase} data-op={r.id} data-key={r.key} data-retry={a.retry ?? ''} data-fallback={a.fallback ?? ''} {...auto}>
      {tone === 'busy' ? <span className="spin" aria-hidden="true" /> : <Icon name={tone === 'ok' || tone === 'info' ? 'check' : 'warn'} />}
      <span className="banner-text">
        {prefix && onOpen ? (
          <button className="link" data-testid="op-open" onClick={() => onOpen(r.key)}>
            <b>{prefix}</b>
          </button>
        ) : (
          prefix && <b>{prefix}</b>
        )}
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
          {a.retry && (
            <button className="link" data-testid="op-retry" data-retry={a.retry} disabled={working} onClick={() => retry(a.retry!)}>
              {retryLabel(r, a.retry)}
            </button>
          )}
          {a.fallback && (
            <WebButton
              kind={a.fallback}
              url={opItemUrl(r)}
              copy={a.copy}
              webOpened={a.webOpened}
              onOpened={() => void api().opWebOpened(r.id)}
              onUnlock={() => void api().opUnlock(r.id)}
              testid="op-fallback"
            />
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
      {a.close && (
        <button
          className="banner-close"
          aria-label={t('关掉提示')}
          title={a.toBox ? t('关掉提示（没发出的附带评论放回这一条的回复框）') : t('关掉提示')}
          data-testid="op-dismiss"
          onClick={() => void api().opClose(r.id)}
        >
          <Icon name="x" />
        </button>
      )}
    </div>
  );
}
