// GitHub#489: the notice of one reply / edit / ticked box the controller sent for the window. What it
// says, whether it shows the text, which one action it offers and whether it may be closed come from
// shared/sends.ts alone; this only draws them. GitHub#490: 「重试」 + one way out + × (sendActions).

import { useState } from 'react';
import { sendActions, sendAutoDismiss, sendNoticeText, sendShowsText, sendText, sendTone, type SendRecord } from '../shared/sends';
import { AUTO_DISMISS_MS } from '../shared/ops';
import { useAutoDismiss } from './autoDismiss';
import { api } from './api';
import { Icon } from './Icons';
import { t } from '../shared/i18n';
import { Verbatim } from './Verbatim';
import { itemPageUrl, WebButton } from './NoticeButtons';

export function SendNotice({ r, onOpen }: { r: SendRecord; onOpen: (key: string) => void }) {
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const tone = sendTone(r);
  const a = sendActions(r);
  const text = sendShowsText(r) ? sendText(r.action) : null;
  const auto = useAutoDismiss(sendAutoDismiss(r), AUTO_DISMISS_MS, () => void api().sendDismiss(r.id), r.id);
  const go = async (f: () => Promise<{ ok: boolean; error: string | null }>) => {
    setWorking(true);
    setProblem(null);
    try {
      const out = await f();
      if (!out.ok) setProblem(out.error ?? t('没有成功'));
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
            <Verbatim from="github">{r.repo}</Verbatim>#{r.number}
            {t('：')}
          </b>
        </button>
        <span data-testid="send-notice-text">{said}</span>
        {text !== null && (
          <span className="op-draft" data-testid="send-text">
            {t('原文：')}
            <q>
              <Verbatim from="user">{text}</Verbatim>
            </q>
          </span>
        )}
        <span className="op-buttons">
          {a.retry === 'resend' && (
            <button className="link" data-testid="send-retry" data-retry="resend" disabled={working} onClick={() => void go(() => api().sendResend(r.id))}>
              {t('再发一次')}
            </button>
          )}
          {a.retry === 'recheck' && (
            <button className="link" data-testid="send-retry" data-retry="recheck" disabled={working} title={t('只读一次 GitHub 上现在的内容，不会再发')} onClick={() => void go(() => api().sendRecheck(r.id))}>
              {t('再查一次')}
            </button>
          )}
          {a.fallback === 'toBox' && (
            <button className="link" data-testid="send-fallback" data-fallback="toBox" title={t('打开这一条，原文回到它的编辑框')} onClick={() => onOpen(r.key)}>
              {t('放回编辑框')}
            </button>
          )}
          {a.fallback === 'checkWeb' && (
            <WebButton
              kind="checkWeb"
              url={itemPageUrl(r.repo, r.number)}
              copy={a.copy}
              webOpened={a.webOpened}
              onOpened={() => void api().sendWebOpened(r.id)}
              onUnlock={() => void api().sendUnlock(r.id)}
              testid="send-fallback"
            />
          )}
        </span>
        {problem && !said.includes(problem) && (
          <span className="small err" data-testid="send-problem">
            {' '}
            {problem}
          </span>
        )}
      </span>
      {a.close && (
        <button className="banner-close" aria-label={t('关掉提示')} title={t('关掉提示')} data-testid="send-dismiss" onClick={() => void api().sendDismiss(r.id)}>
          <Icon name="x" />
        </button>
      )}
    </div>
  );
}
