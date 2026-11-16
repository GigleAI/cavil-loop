// GitHub#559: the box a dialog shows when the repository it shows lacks the labels a button needs —
// the new-issue dialog (交给 agent / 托管) and 等前置 share it. The button asks the controller to create
// them (the request, its result and the notice are the controller's, bound to the repository of the
// press); when the account may not, or GitHub refused, it says which labels to create and where.
// What it shows is decided by shared/labelSetup.ts (labelBoxState); this only draws it.

import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../shared/types';
import { jobFor, labelBoxState, labelListText, labelsPageUrl, labelSpecs, type LabelPermission, type LabelRole } from '../shared/labelSetup';
import { api } from './api';
import { copyText } from './pasteImage';
import { labelStyle, useDarkMode } from './colors';
import { t } from '../shared/i18n';
import { tNode } from './tNode';
import { Verbatim, verbatimParts } from './Verbatim';

export function LabelSetupBox({
  repo,
  wants,
  state,
  onReread,
  testid = 'label-setup',
}: {
  /** the repository the dialog shows now */
  repo: string;
  /** the labels it lacks (read from it, complete): nothing = no box */
  wants: { name: string; role: LabelRole }[];
  state: AppState;
  /** read the repository's labels again (the dialog's own read; only its newest answer counts) */
  onReread: () => void;
  testid?: string;
}) {
  const specs = labelSpecs(wants);
  const dark = useDarkMode();
  const [perm, setPerm] = useState<{ repo: string; value: LabelPermission } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean | null>(null);
  const [permRound, setPermRound] = useState(0);
  const [checking, setChecking] = useState(false);
  // the permission belongs to the repository it was read for: only the newest read lands
  const permSeq = useRef(0);
  const show = specs.length > 0;
  useEffect(() => {
    setProblem(null);
    setCopied(null);
    if (!show || !repo) return;
    const my = ++permSeq.current;
    void api()
      .labelPermission(repo)
      .then((v) => {
        if (my === permSeq.current) setPerm({ repo, value: v });
      });
  }, [repo, show, permRound]);

  // this repository's newest press: once it settles (made, refused, or found missing by 「再查一次」), read again —
  // a press for another repository never makes this dialog read or change anything
  const job = repo ? jobFor(state.labelJobs, repo) : null;
  // a refusal too: some of the labels may have been made before GitHub refused the rest
  const settled = job && (job.status === 'done' || job.status === 'missing' || job.status === 'refused') ? `${job.id}:${job.status}` : '';
  const lastSettled = useRef({ repo, settled });
  useEffect(() => {
    const before = lastSettled.current;
    lastSettled.current = { repo, settled };
    // another repository picked: its state is what the dialog's own read of it shows, nothing to do here
    if (before.repo !== repo || before.settled === settled) return;
    if (settled) onReread();
  }, [repo, settled]);

  if (!show) return null;
  const permission: LabelPermission = perm && perm.repo === repo ? perm.value : 'unknown';
  const box = labelBoxState(permission, job);
  const create = async () => {
    setProblem(null);
    const r = await api().startLabelCreate(repo, specs.map((s) => ({ name: s.name, role: s.role })));
    if (!r.ok) setProblem(r.error);
  };
  const chips = (
    <span className="label-setup-chips">
      {specs.map((s) => (
        <span key={s.name} className="label" data-testid={`${testid}-label`} data-label={s.name} style={labelStyle(s.color, dark)} {...verbatimParts('user', [s.name])}>
          <Verbatim from="user">{s.name}</Verbatim>
        </span>
      ))}
    </span>
  );
  const n = specs.length;
  return (
    <div className={`label-setup ${box.kind === 'guide' || box.kind === 'unknown' ? 'guide' : ''}`} data-testid={testid} data-kind={box.kind} data-repo={repo}>
      {box.kind === 'unknown' && (
        <>
          <div data-testid={`${testid}-why`} data-why="unknown">
            {tNode('上一次在 {repo} 建标签没收到 GitHub 的回答，不知道建没建成。先「再查一次」（只读，不会再建）：', { repo: <Verbatim from="github">{repo}</Verbatim> })}
          </div>
          {chips}
          <div className="label-setup-row">
            <button
              className="primary small"
              data-testid={`${testid}-recheck`}
              disabled={box.checking || checking}
              onClick={async () => {
                setProblem(null);
                setChecking(true);
                try {
                  const r = await api().labelJobRecheck(box.jobId);
                  if (!r.ok) setProblem(r.error);
                } finally {
                  setChecking(false);
                }
              }}
            >
              {box.checking || checking ? t('正在读取…') : t('再查一次')}
            </button>
            <span className="small muted">{t('查到已经建好就能直接用；查到还没有，再按建标签')}</span>
          </div>
        </>
      )}
      {(box.kind === 'create' || box.kind === 'running') && (
        <>
          <div>{tNode('仓库 {repo} 还没有这些标签：', { repo: <Verbatim from="github">{repo}</Verbatim> })}</div>
          {chips}
          <div className="label-setup-row">
            <button className="primary small" data-testid={`${testid}-create`} disabled={box.kind === 'running'} onClick={() => void create()}>
              {box.kind === 'running' ? t('正在建标签…') : n === 1 ? t('在这个仓库建好这个标签') : t('在这个仓库建好这 {n} 个标签', { n })}
            </button>
            <span className="small muted">{t('按 cavil-loop 的默认颜色和说明新建，不改仓库已有的标签')}</span>
          </div>
        </>
      )}
      {box.kind === 'guide' && (
        <>
          <div data-testid={`${testid}-why`} data-why={box.why}>
            {box.why === 'noPermission'
              ? tNode('当前账号不能在 {repo} 建标签（需要这个仓库的写权限）。请仓库管理员建好下面这些标签，建好后点「重新读取」：', { repo: <Verbatim from="github">{repo}</Verbatim> })
              : tNode('GitHub 没让在 {repo} 建标签（{why}）。请有写权限的人建好下面这些标签，建好后点「重新读取」：', {
                  repo: <Verbatim from="github">{repo}</Verbatim>,
                  why: <Verbatim from="github">{box.error ?? t('没有说明原因')}</Verbatim>,
                })}
            {box.app && <div className="small">{t('登录用的 GitHub App 可能没被允许在这个仓库建标签。')}</div>}
          </div>
          <table className="label-setup-table" data-testid={`${testid}-list`}>
            <tbody>
              {specs.map((s) => (
                <tr key={s.name}>
                  <td>
                    <span className="label" data-testid={`${testid}-label`} data-label={s.name} style={labelStyle(s.color, dark)} {...verbatimParts('user', [s.name])}>
                      <Verbatim from="user">{s.name}</Verbatim>
                    </span>
                  </td>
                  <td className="small">{t('颜色 {color}', { color: s.color })}</td>
                  <td className="small">{s.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="label-setup-row">
            <button className="small" data-testid={`${testid}-web`} onClick={() => void api().openExternal(labelsPageUrl(state.githubWeb, repo))}>
              {t('打开仓库的标签页')}
            </button>
            <button className="small" data-testid={`${testid}-copy`} onClick={async () => setCopied(await copyText(labelListText(specs)))}>
              {t('复制标签清单')}
            </button>
            <button
              className="small"
              data-testid={`${testid}-reread`}
              onClick={() => {
                setPermRound((x) => x + 1);
                onReread();
              }}
            >
              {t('重新读取')}
            </button>
            {box.why === 'refused' && (
              <button className="small" data-testid={`${testid}-create`} onClick={() => void create()}>
                {t('再试一次建标签')}
              </button>
            )}
            {copied !== null && <span className="small muted">{copied ? t('已复制') : t('复制失败，请手动选中上面的清单')}</span>}
          </div>
        </>
      )}
      {problem && (
        <div className="warn-text small" data-testid={`${testid}-problem`}>
          {problem}
        </div>
      )}
    </div>
  );
}
