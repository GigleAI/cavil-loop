// GitHub#559: the notice of one press of "建标签" — in the window's notice area like every other result
// the controller holds (GitHub#482 / #488). It always names the repository the labels were created in
// (the one of the press, whatever a dialog shows now). Done goes away by itself after 5 s; a refusal
// offers 「重试」 (send again), no answer offers 「再查一次」 (reads only); both offer the labels page.

import { useState } from 'react';
import type { LabelJob } from '../shared/labelSetup';
import { labelsPageUrl } from '../shared/labelSetup';
import { AUTO_DISMISS_MS } from '../shared/ops';
import { useAutoDismiss } from './autoDismiss';
import { api } from './api';
import { Icon } from './Icons';
import { t } from '../shared/i18n';
import { tNode } from './tNode';
import { Verbatim } from './Verbatim';

function names(job: LabelJob) {
  return job.labels.map((l) => <span key={l.name}>{tNode('「{name}」', { name: <Verbatim from="user">{l.name}</Verbatim> })}</span>);
}

export function LabelJobNotice({ job, web }: { job: LabelJob; web: string }) {
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const tone = job.status === 'running' || job.checking ? 'busy' : job.status === 'done' ? 'ok' : 'warn';
  const auto = useAutoDismiss(job.status === 'done', AUTO_DISMISS_MS, () => void api().labelJobDismiss(job.id), job.id);
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
  const repo = <Verbatim from="github">{job.repo}</Verbatim>;
  const labels = <>{names(job)}</>;
  const text =
    job.status === 'running'
      ? tNode('正在 {repo} 建标签{labels}…', { repo, labels })
      : job.status === 'done'
        ? tNode('已在 {repo} 建好标签{labels}', { repo, labels })
        : job.status === 'refused'
          ? tNode('没能在 {repo} 建标签{labels}：{why}', { repo, labels, why: <Verbatim from="github">{job.error ?? t('没有说明原因')}</Verbatim> })
          : job.status === 'unknown'
            ? tNode('在 {repo} 建标签{labels}没收到 GitHub 的回答，不知道建没建成（{why}）', { repo, labels, why: <Verbatim from="github">{job.error ?? ''}</Verbatim> })
            : tNode('{repo} 里还没有标签{labels}：可以在对话框里重新按「建标签」', { repo, labels });
  return (
    <div className={`banner ${tone} op-notice label-notice`} data-testid="label-notice" data-state={job.status} data-repo={job.repo} data-job={job.id} {...auto}>
      {tone === 'busy' ? <span className="spin" aria-hidden="true" /> : <Icon name={tone === 'ok' ? 'check' : 'warn'} />}
      <span className="banner-text">
        <span data-testid="label-notice-text">{text}</span>
        {job.app && job.status === 'refused' && <span className="small">{t('登录用的 GitHub App 可能没被允许在这个仓库建标签。')}</span>}
        <span className="op-buttons">
          {job.status === 'refused' && (
            <button className="link" data-testid="label-notice-retry" data-retry="resend" disabled={working} onClick={() => void go(() => api().labelJobRetry(job.id))}>
              {t('重试')}
            </button>
          )}
          {job.status === 'unknown' && (
            <button className="link" data-testid="label-notice-retry" data-retry="recheck" disabled={working || job.checking} title={t('只读一次仓库现在的标签，不会再建')} onClick={() => void go(() => api().labelJobRecheck(job.id))}>
              {t('再查一次')}
            </button>
          )}
          {(job.status === 'refused' || job.status === 'unknown' || job.status === 'missing') && (
            <button className="link" data-testid="label-notice-web" onClick={() => void api().openExternal(labelsPageUrl(web, job.repo))}>
              {t('打开仓库的标签页')}
            </button>
          )}
        </span>
        {problem && (
          <span className="small" data-testid="label-notice-problem">
            {problem}
          </span>
        )}
      </span>
      {job.status !== 'running' && (
        <button className="banner-close" aria-label={t('关掉提示')} title={t('关掉提示')} data-testid="label-notice-close" onClick={() => void api().labelJobDismiss(job.id)}>
          <Icon name="x" />
        </button>
      )}
    </div>
  );
}
