// GitHub#569: the notice of one flow label rename (project settings → 「改名…」 / 「跟进另一台的改名…」) — in
// the window's one notice area like every other result the controller holds (GitHub#482 / #488). It
// always names the repository and both names. What each place holds (GitHub, the config, the client's
// own names, the daemon's polling) is a small table. The buttons are one rule (shared/labelRename.ts
// renameActions): at most a retry, one way out and ×; × only once nothing holds the daemon any more.
// Done goes away by itself after 5 s unless other machines still have to follow (their steps are here).

import { useState } from 'react';
import { credentialText, placeWord, renameActions, renameStatusWord, type RenameJob, type RenameWatch } from '../shared/labelRename';
import { AUTO_DISMISS_MS } from '../shared/ops';
import { useAutoDismiss } from './autoDismiss';
import { api } from './api';
import { Icon } from './Icons';
import { ConfirmDialog } from './ConfirmDialog';
import { copyText } from './pasteImage';
import { t } from '../shared/i18n';
import { tNode } from './tNode';
import { Verbatim } from './Verbatim';
import { BackendText } from './WordsText';

/** the client's name of a slot (Settings → 交给 agent) */
export function slotWord(slot: string): string {
  switch (slot) {
    case 'human':
      return t('等人处理');
    case 'agent':
      return t('交给 agent');
    case 'autopilot':
      return t('托管');
    case 'running':
      return t('运行中');
    case 'blocked':
      return t('等前置');
    case 'later':
      return t('稍后处理');
    default:
      return slot;
  }
}

export function RenameNotice({ job }: { job: RenameJob }) {
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [copied, setCopied] = useState<boolean | null>(null);
  const a = renameActions(job);
  const running = job.status === 'running';
  const tone = running ? 'busy' : job.status === 'done' || job.status === 'undone' || job.status === 'abandoned' ? 'ok' : 'warn';
  const followers = job.status === 'done' && (job.stopped ?? []).length > 0;
  const auto = useAutoDismiss(tone === 'ok' && !followers, AUTO_DISMISS_MS, () => void api().labelRenameDismiss(job.id), job.id);
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
  const from = <Verbatim from="github">{job.from}</Verbatim>;
  const to = <Verbatim from="user">{job.to}</Verbatim>;
  const credential = job.labelId ? credentialText({ repo: job.repo, field: job.field, from: job.from, to: job.to, labelId: job.labelId }) : '';
  const head = running
    ? job.mode === 'follow'
      ? tNode('正在跟进改名：{from} → {to}（{repo}）保存中…', { from, to, repo })
      : tNode('正在改名：{from} → {to}（{repo}）保存中…', { from, to, repo })
    : tNode('{what}：{from} → {to}（{repo}）', { what: <b>{renameStatusWord(job.status)}</b>, from, to, repo });
  const settled = job.status === 'done' || job.status === 'undone' || job.status === 'abandoned';
  return (
    <div className={`banner ${tone} op-notice rename-notice`} data-testid="rename-notice" data-state={job.status} data-key={job.key} data-repo={job.repo} data-job={job.id} {...auto}>
      {tone === 'busy' ? <span className="spin" aria-hidden="true" /> : <Icon name={tone === 'ok' ? 'check' : 'warn'} />}
      <span className="banner-text">
        <span data-testid="rename-notice-text">{head}</span>
        {!running && !settled && (
          <table className="pcfg-changes rename-places" data-testid="rename-places">
            <tbody>
              <tr data-place="github" data-value={job.github}>
                <td>GitHub</td>
                <td>{placeWord(job.github)}</td>
              </tr>
              <tr data-place="config" data-value={job.config}>
                <td>{t('配置文件')}</td>
                <td>{placeWord(job.config)}</td>
              </tr>
              <tr data-place="client" data-value={job.client}>
                <td>{t('客户端')}</td>
                <td>{placeWord(job.client)}</td>
              </tr>
              <tr data-place="polling" data-value={job.polling}>
                <td>{t('本项目的轮询')}</td>
                <td>{placeWord(job.polling === 'unknown' ? 'unknown' : job.polling)}</td>
              </tr>
            </tbody>
          </table>
        )}
        {!running && job.message && (
          <span className="small daemon-output" data-testid="rename-notice-message">
            <BackendText said={job.messageSaid} text={job.message} />
          </span>
        )}
        {job.status === 'done' && job.slotKept && (
          <span className="small" data-testid="rename-slot-kept">
            {tNode('客户端里这个仓库的「{slot}」标签名是 {name}，不是 {from}，没有跟着改；需要的话在设置里改。', {
              slot: slotWord(job.slotKept.slot),
              name: <Verbatim from="user">{job.slotKept.name}</Verbatim>,
              from,
            })}
          </span>
        )}
        {job.status === 'done' && job.mode === 'rename' && credential && (
          <span className="small rename-credential">
            {t('别的机器跟进时要用的改名凭据：')}
            <code data-testid="rename-credential">{credential}</code>
            <button className="link" data-testid="rename-credential-copy" onClick={async () => setCopied(Boolean(await copyText(credential)))}>
              {copied === null ? t('复制') : copied ? t('已复制') : t('复制失败，请手动选中')}
            </button>
          </span>
        )}
        {followers && (
          <span className="small" data-testid="rename-followers">
            {t('停掉的这些也要跟进：在那台机器（或这台）的客户端里打开该项目的配置，点「跟进另一台的改名…」，贴上上面的凭据，做完后再启动它的轮询。')}
            <ul>
              {(job.stopped ?? []).map((m) => (
                <li key={`${m.where}:${m.id ?? ''}:${m.key}`} data-testid="rename-follower" data-where={m.where} data-key={m.key}>
                  {m.where === 'remote'
                    ? tNode('{name} 上的 {key}', { name: <Verbatim from="user">{m.name}</Verbatim>, key: <Verbatim from="user">{m.key}</Verbatim> })
                    : tNode('这台电脑上的 {key}', { key: <Verbatim from="user">{m.key}</Verbatim> })}
                </li>
              ))}
            </ul>
          </span>
        )}
        <span className="op-buttons">
          {a.retry && (
            <button
              className="link"
              data-testid="rename-retry"
              data-retry={a.retry}
              disabled={working}
              title={a.retry === 'recheck' ? t('只读一次 GitHub 和配置现在的状态，不会再发改名') : undefined}
              onClick={() => void go(() => api().labelRenameContinue(job.id))}
            >
              {a.retry === 'recheck' ? t('再查一次（只读）') : t('重试')}
            </button>
          )}
          {a.resend && (
            <button className="link" data-testid="rename-resend" disabled={working} onClick={() => void go(() => api().labelRenameResend(job.id))}>
              {t('重发改名')}
            </button>
          )}
          {a.out === 'undo' && (
            <button className="link" data-testid="rename-undo" disabled={working} title={t('GitHub 上确定没改：删掉改名记录，什么都不改')} onClick={() => void go(() => api().labelRenameUndo(job.id))}>
              {t('退回')}
            </button>
          )}
          {a.out === 'abandon' && (
            <button className="link" data-testid="rename-abandon" disabled={working} onClick={() => setAsking(true)}>
              {t('已手动处理好')}
            </button>
          )}
        </span>
        {(problem || job.problem) && (
          <span className="small err" data-testid="rename-notice-problem">
            {problem ?? job.problem}
          </span>
        )}
      </span>
      {a.close && (
        <button className="banner-close" aria-label={t('关掉提示')} title={t('关掉提示')} data-testid="rename-notice-close" onClick={() => void api().labelRenameDismiss(job.id)}>
          <Icon name="x" />
        </button>
      )}
      {asking && (
        <ConfirmDialog
          title={t('已经手动把三处都处理好了？')}
          confirmLabel={t('已处理好，恢复轮询')}
          danger
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            void go(() => api().labelRenameAbandon(job.id));
          }}
        >
          <p className="small" data-testid="rename-abandon-text">
            {tNode('确认后只删掉 daemon 的改名记录、恢复本项目的轮询，GitHub、配置文件和客户端都不再动。只在已经亲手核对过 GitHub 上的标签名、配置里的 {field} 和客户端里这个仓库的标签名都一致之后再点。', {
              field: <Verbatim from="daemon">{job.field}</Verbatim>,
            })}
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

export function RenameWatchNotice({ w }: { w: RenameWatch }) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="banner info op-notice rename-watch" data-testid="rename-watch" data-key={w.key}>
      <Icon name="warn" />
      <span className="banner-text">
        {w.name
          ? tNode('{repo} 改名时有过没回音的请求：daemon 每轮先核对标签 {name}（编号 {id}）再干活。确认 GitHub 上的名字不会再变之后点「结束核对」。', {
              repo: <Verbatim from="github">{w.repo}</Verbatim>,
              name: <Verbatim from="github">{w.name}</Verbatim>,
              id: w.labelId,
            })
          : tNode('{repo} 的标签核对记录读不了。', { repo: <Verbatim from="github">{w.repo}</Verbatim> })}
        <span className="op-buttons">
          <button
            className="link"
            data-testid="rename-watch-end"
            disabled={w.working}
            onClick={async () => {
              setProblem(null);
              const r = await api().labelRenameWatchEnd(w.key);
              if (!r.ok) setProblem(r.error);
            }}
          >
            {t('结束核对')}
          </button>
        </span>
        {(problem || w.problem) && (
          <span className="small err" data-testid="rename-watch-problem">
            {problem ?? w.problem}
          </span>
        )}
      </span>
    </div>
  );
}
