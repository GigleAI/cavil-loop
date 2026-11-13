// GitHub#489: the notice of one reply / edit / ticked box the controller sent for the window. What it
// says, whether it shows the text, which one action it offers and whether it may be closed come from
// shared/sends.ts alone; this only draws them.

import { useState } from 'react';
import { sendAutoDismiss, sendButtons, sendClosable, sendNoticeText, sendShowsText, sendText, sendTone, type SendRecord } from '../shared/sends';
import { AUTO_DISMISS_MS } from '../shared/ops';
import { useAutoDismiss } from './autoDismiss';
import { api } from './api';
import { Icon } from './Icons';

export function SendNotice({ r, onOpen }: { r: SendRecord; onOpen: (key: string) => void }) {
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const tone = sendTone(r);
  const buttons = sendButtons(r);
  const text = sendShowsText(r) ? sendText(r.action) : null;
  const auto = useAutoDismiss(sendAutoDismiss(r), AUTO_DISMISS_MS, () => void api().sendDismiss(r.id), r.id);
  const go = async (f: () => Promise<{ ok: boolean; error: string | null }>) => {
    setWorking(true);
    setProblem(null);
    try {
      const out = await f();
      if (!out.ok) setProblem(out.error ?? '没有成功');
    } finally {
      setWorking(false);
    }
  };
  const said = sendNoticeText(r);
  return (
    <div className={`banner ${tone} op-notice send-notice`} data-testid="send-notice" data-kind={tone} data-state={r.state} data-send={r.id} data-key={r.key} data-what={r.action.kind} {...auto}>
      {tone === 'busy' ? <span className="spin" aria-hidden="true" /> : <Icon name={tone === 'ok' ? 'check' : 'warn'} />}
      <span className="banner-text">
        <button className="link" data-testid="send-open" onClick={() => onOpen(r.key)}>
          <b>
            {r.repo}#{r.number}：
          </b>
        </button>
        <span data-testid="send-notice-text">{said}</span>
        {text !== null && (
          <span className="op-draft" data-testid="send-text">
            原文：<q>{text}</q>
          </span>
        )}
        <span className="op-buttons">
          {buttons.includes('resend') && (
            <button className="link" data-testid="send-resend" disabled={working} onClick={() => void go(() => api().sendResend(r.id))}>
              再发一次
            </button>
          )}
          {buttons.includes('recheck') && (
            <button className="link" data-testid="send-recheck" disabled={working} title="只读一次 GitHub 上现在的内容，不会再发" onClick={() => void go(() => api().sendRecheck(r.id))}>
              再查一次
            </button>
          )}
          {buttons.includes('unlock') && (
            <button className="link" data-testid="send-unlock" title="在 GitHub 页面核对过以后再点：只解开这里的锁定，不会往 GitHub 发任何请求；原文仍留在这里" onClick={() => void api().sendUnlock(r.id)}>
              已核对，解除锁定
            </button>
          )}
        </span>
        {problem && !said.includes(problem) && (
          <span className="small err" data-testid="send-problem">
            {' '}
            {problem}
          </span>
        )}
      </span>
      {sendClosable(r) && (
        <button className="banner-close" aria-label="关掉提示" title="关掉提示" data-testid="send-dismiss" onClick={() => void api().sendDismiss(r.id)}>
          <Icon name="x" />
        </button>
      )}
    </div>
  );
}
