// GitHub#569: 「改名…」 and 「跟进另一台的改名…」 on a flow label of the project settings window.
//
// 改名: a new name; the daemon's own checks (label-rename.sh check, read-only) run as it is typed and are
// listed with ✓ / ✗ / ?. Every other daemon this client knows of that polls the same repository is
// listed — the other projects of this computer and the paired machines' — each with 「停掉它的轮询」 and the
// state read back; a machine that cannot be read counts as not stopped. The person ticks that nothing
// else polls the repository. Only then 「改名（三处一起改）」: the controller runs the rename (closing this
// dialog does not stop it) and the notice area says how it went.
//
// 跟进: on another machine, after the rename was done elsewhere — the rename credential pasted (filled in
// when this client did the rename), the daemon's follow checks, then the controller's follow.

import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { ConfirmDialog } from './ConfirmDialog';
import { Icon } from './Icons';
import { otherPollers, parseCredential, renameMissing, NAME_RE, type Poller, type RenameCheck, type StoppedMachine } from '../shared/labelRename';
import { readOk, remoteName } from '../shared/remote';
import type { ConfigField, DaemonProject, LocalStatus, ProjectConfig } from '../shared/daemon';
import { schedWord } from '../shared/daemon';
import { t } from '../shared/i18n';
import { tNode } from './tNode';
import { Verbatim } from './Verbatim';

/** how long typing pauses before the read-only check runs */
const CHECK_DELAY_MS = 400;

function CheckList({ checks }: { checks: RenameCheck[] | null }) {
  if (!checks) return null;
  return (
    <ul className="daemon-checks rename-checks" data-testid="rename-checks">
      {checks.map((c) => (
        <li key={c.id} data-testid="rename-check" data-id={c.id} data-ok={String(c.ok)}>
          <span className={`mark ${c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'unknown'}`}>{c.ok === true ? '✓' : c.ok === false ? '✗' : '?'}</span>{' '}
          <Verbatim from="daemon">{c.text}</Verbatim>
        </li>
      ))}
    </ul>
  );
}

/** the read-only check, run again whenever `args` change (after a short pause) */
function useCheck(key: string, args: Record<string, unknown> | null): { checks: RenameCheck[] | null; checking: boolean; error: string | null } {
  const [checks, setChecks] = useState<RenameCheck[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const sig = args ? JSON.stringify(args) : '';
  useEffect(() => {
    const n = ++seq.current;
    setChecks(null);
    setError(null);
    if (!args) return setChecking(false);
    setChecking(true);
    const timer = setTimeout(() => {
      api()
        .daemonLabelRename(key, 'check', args)
        .then((r) => {
          if (n !== seq.current) return;
          setChecks(Array.isArray(r.checks) && r.checks.length ? r.checks : null);
          setError(Array.isArray(r.checks) && r.checks.length ? null : r.output || r.result);
        })
        .catch((e) => n === seq.current && setError((e as Error).message))
        .finally(() => n === seq.current && setChecking(false));
    }, CHECK_DELAY_MS);
    return () => clearTimeout(timer);
    // the signature is the dependency (a new object with the same values is the same check)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sig]);
  return { checks, checking, error };
}

export function LabelRenameDialog({
  project,
  config,
  field,
  status,
  onStarted,
  onClose,
}: {
  project: DaemonProject;
  config: ProjectConfig;
  field: ConfigField;
  /** this computer's daemon status as last read (the other projects of the same repository) */
  status: LocalStatus | null;
  onStarted: () => void;
  onClose: () => void;
}) {
  const repo = project.repo ?? '';
  const [name, setName] = useState('');
  const [ticked, setTicked] = useState(false);
  const [local, setLocal] = useState<LocalStatus | null>(status);
  // null = still reading; 'failed' = the list could not be read (never taken for "no paired machines")
  const [remotes, setRemotes] = useState<{ id: string; name: string; status: LocalStatus | null }[] | 'failed' | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [stopNote, setStopNote] = useState<Record<string, string>>({});
  const [stopped, setStopped] = useState<StoppedMachine[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const to = name.trim();
  const nameOk = NAME_RE.test(to) && to !== field.value;
  const { checks, checking, error } = useCheck(project.key, nameOk ? { field: field.name, from: field.value, to, othersStopped: ticked } : null);

  const readRemotes = async () => {
    let list;
    try {
      list = await api().remoteList();
    } catch {
      return setRemotes('failed');
    }
    if (!list || !Array.isArray(list.remotes)) return setRemotes('failed');
    const paired = list.remotes.filter((e) => e.state === 'paired');
    const got = await Promise.all(
      paired.map(async (e) => {
        try {
          const r = await api().remoteStatus(e.id);
          return { id: e.id, name: remoteName(e.host), status: readOk(r) ? r.status : null };
        } catch {
          return { id: e.id, name: remoteName(e.host), status: null };
        }
      }),
    );
    setRemotes(got);
  };
  const readLocal = async () => {
    try {
      const s = await api().daemonStatus();
      setLocal(s.state === 'ok' ? s.status : null);
    } catch {
      setLocal(null);
    }
  };
  useEffect(() => {
    void readRemotes();
    void readLocal();
    // once when the dialog opens; a stop reads its machine again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const remotesState: 'loading' | 'failed' | 'read' = remotes === null ? 'loading' : remotes === 'failed' ? 'failed' : 'read';
  const pollers: Poller[] = otherPollers(local, project.key, repo, Array.isArray(remotes) ? remotes : []);
  // a local status that could not be read: this computer's other projects are not known either
  const localUnknown = local === null;
  const list: Poller[] = localUnknown ? [{ where: 'local', key: '', name: '', state: 'unknown', unreadable: true }, ...pollers] : pollers;

  const stop = async (p: Poller) => {
    const id = `${p.where}:${p.id ?? ''}:${p.key}`;
    setStopping(id);
    try {
      const r = p.where === 'local' ? await api().daemonService(p.key, 'stop') : await api().remoteService(p.id!, p.key, 'stop');
      if (r.result !== 'ok') setStopNote((n) => ({ ...n, [id]: r.output || r.result }));
      else setStopped((s) => [...s.filter((x) => !(x.where === p.where && x.key === p.key && x.id === p.id)), { where: p.where, name: p.name, key: p.key, ...(p.id ? { id: p.id } : {}) }]);
    } catch (e) {
      setStopNote((n) => ({ ...n, [id]: (e as Error).message }));
    } finally {
      // read back: only what the machine says now counts
      if (p.where === 'local') await readLocal();
      else await readRemotes();
      setStopping(null);
    }
  };

  const missing = renameMissing({ checks: nameOk ? checks : null, checking, pollers: list, ticked, remotes: remotesState });
  if (!nameOk) missing.unshift(to === '' ? t('还没填新名字') : t('新名字只能用字母、数字和 . _ : / @ + -，1–50 个字符，并且和旧名字不同'));
  const go = async () => {
    if (missing.length) return;
    const r = await api().startLabelRename({ key: project.key, repo, mode: 'rename', field: field.name, from: field.value, to, rev: config.rev, othersStopped: true, stopped });
    if (!r.ok) return setProblem(r.error);
    onStarted();
  };

  return (
    <ConfirmDialog
      wide
      title={tNode('给流程标签改名：{label}', { label: <Verbatim from="daemon">{field.label}</Verbatim> })}
      confirmLabel={t('改名（三处一起改）')}
      disabled={missing.length > 0}
      dirty={to !== ''}
      onConfirm={() => void go()}
      onCancel={onClose}
      footnote={
        <div className="small muted rename-missing" data-testid="rename-missing" data-count={missing.length}>
          {missing.length ? tNode('还差：{list}', { list: missing.join(t('；')) }) : t('都齐了：GitHub 上的标签、配置文件和客户端会一起改成新名字。')}
          {problem && (
            <div className="err" data-testid="rename-start-problem">
              {problem}
            </div>
          )}
        </div>
      }
    >
      <div data-testid="rename-dialog" data-mode="rename">
        <p className="small">
          {tNode('{repo} 的 {setting} 现在是 {old}。改名会在 GitHub 上把这个标签改名（挂着它的条目跟着变），再改配置文件，再改客户端里这个仓库的标签名；做完之前 daemon 暂停这个项目。', {
            repo: <Verbatim from="daemon">{repo}</Verbatim>,
            setting: <code>{field.name}</code>,
            old: (
              <code>
                <Verbatim from="daemon">{field.value}</Verbatim>
              </code>
            ),
          })}
        </p>
        <label className="rename-name">
          {t('新名字')}{' '}
          <input data-testid="rename-new-name" value={name} spellCheck={false} autoFocus onChange={(e) => setName(e.target.value)} />
        </label>
        {checking && (
          <div className="small muted" data-testid="rename-checking">
            {t('正在检查…')}
          </div>
        )}
        {error && !checking && (
          <div className="small err" data-testid="rename-check-error">
            {error}
          </div>
        )}
        <CheckList checks={nameOk ? checks : null} />
        <h4>{t('别处在轮询这个仓库的 daemon')}</h4>
        {remotes === null ? (
          <div className="small muted" data-testid="rename-remotes-loading">{t('正在读取…')}</div>
        ) : remotes === 'failed' ? (
          <div className="small err" data-testid="rename-remotes-failed">
            {t('读不到配对过的远程机器列表，判断不了有没有别的机器在轮询这个仓库。')}{' '}
            <button className="link" data-testid="rename-remotes-retry" onClick={() => { setRemotes(null); void readRemotes(); }}>
              {t('再读一次')}
            </button>
          </div>
        ) : list.length === 0 ? (
          <div className="small muted" data-testid="rename-pollers-none">
            {t('这个客户端知道的 daemon 里，没有别的在轮询这个仓库。')}
          </div>
        ) : (
          <ul className="rename-pollers" data-testid="rename-pollers">
            {list.map((p) => {
              const id = `${p.where}:${p.id ?? ''}:${p.key}`;
              return (
                <li key={id} data-testid="rename-poller" data-where={p.where} data-key={p.key} data-state={p.state} data-repo-unknown={p.repoUnknown ? 'true' : undefined}>
                  {p.unreadable
                    ? p.where === 'local'
                      ? t('这台电脑的 daemon 状态读不到（算作没停）')
                      : tNode('{name}：读不到（算作没停）', { name: <Verbatim from="user">{p.name}</Verbatim> })
                    : p.repoUnknown
                      ? p.where === 'local'
                        ? tNode('这台电脑上的 {key}：读不到它轮询哪个仓库，{state}（没停就算作在轮询本仓库）', { key: <Verbatim from="user">{p.key}</Verbatim>, state: schedWord(p.state) })
                        : tNode('{name} 上的 {key}：读不到它轮询哪个仓库，{state}（没停就算作在轮询本仓库）', { name: <Verbatim from="user">{p.name}</Verbatim>, key: <Verbatim from="user">{p.key}</Verbatim>, state: schedWord(p.state) })
                      : p.where === 'local'
                        ? tNode('这台电脑上的 {key}：{state}', { key: <Verbatim from="user">{p.key}</Verbatim>, state: schedWord(p.state) })
                        : tNode('{name} 上的 {key}：{state}', { name: <Verbatim from="user">{p.name}</Verbatim>, key: <Verbatim from="user">{p.key}</Verbatim>, state: schedWord(p.state) })}{' '}
                  {!p.unreadable && p.state === 'running' && (
                    <button className="link" data-testid="rename-stop" disabled={stopping !== null} onClick={() => void stop(p)}>
                      {stopping === id ? t('正在停…') : t('停掉它的轮询')}
                    </button>
                  )}
                  {p.state === 'stopped' && <Icon name="check" />}
                  {stopNote[id] && <span className="small err">{stopNote[id]}</span>}
                </li>
              );
            })}
          </ul>
        )}
        <label className="row rename-confirm">
          <input type="checkbox" data-testid="rename-others-stopped" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
          <span className="small">{t('已确认：除了上面列出的，没有别的机器在轮询本仓库（或已经停掉）')}</span>
        </label>
      </div>
    </ConfirmDialog>
  );
}

export function LabelFollowDialog({
  project,
  config,
  field,
  prefill,
  onStarted,
  onClose,
}: {
  project: DaemonProject;
  config: ProjectConfig;
  field: ConfigField;
  /** the credential of a rename this client did for the same repository (filled in) */
  prefill: string;
  onStarted: () => void;
  onClose: () => void;
}) {
  const repo = project.repo ?? '';
  const [text, setText] = useState(prefill);
  const [problem, setProblem] = useState<string | null>(null);
  const cred = parseCredential(text);
  const why = !text.trim()
    ? t('还没贴改名凭据')
    : !cred
      ? t('这不是一条改名凭据（应该是一行，以 cavil-label-rename v1 开头）')
      : cred.repo.toLowerCase() !== repo.toLowerCase()
        ? t('凭据是仓库 {repo} 的，不是这个项目的仓库', { repo: cred.repo })
        : cred.field !== field.name
          ? t('凭据改的是 {field}，不是这一项', { field: cred.field })
          : cred.from !== field.value
            ? t('凭据的旧名字是 {from}，这个项目的配置里现在是 {now}', { from: cred.from, now: field.value })
            : null;
  const args = cred && !why ? { field: field.name, from: cred.from, to: cred.to, follow: true, labelId: cred.labelId } : null;
  const { checks, checking, error } = useCheck(project.key, args);
  const allOk = !!checks && checks.every((c) => c.ok === true);
  const missing = why ? [why] : checking || !checks ? [t('检查还没做完')] : allOk ? [] : [t('有 {n} 项检查没过', { n: checks.filter((c) => c.ok !== true).length })];
  const go = async () => {
    if (missing.length || !cred) return;
    const r = await api().startLabelRename({ key: project.key, repo, mode: 'follow', field: field.name, from: cred.from, to: cred.to, labelId: cred.labelId, rev: config.rev });
    if (!r.ok) return setProblem(r.error);
    onStarted();
  };
  return (
    <ConfirmDialog
      wide
      title={tNode('跟进另一台的改名：{label}', { label: <Verbatim from="daemon">{field.label}</Verbatim> })}
      confirmLabel={t('跟进')}
      disabled={missing.length > 0}
      onConfirm={() => void go()}
      onCancel={onClose}
      footnote={
        <div className="small muted rename-missing" data-testid="rename-missing" data-count={missing.length}>
          {missing.length ? tNode('还差：{list}', { list: missing.join(t('；')) }) : t('都齐了：这个项目的配置文件和客户端会改成新名字，GitHub 上已经是新名字。')}
          {problem && (
            <div className="err" data-testid="rename-start-problem">
              {problem}
            </div>
          )}
        </div>
      }
    >
      <div data-testid="rename-dialog" data-mode="follow">
        <p className="small">{t('另一台机器已经在 GitHub 上把这个标签改了名：把那边提示里的改名凭据贴在这里，这个项目的配置和客户端就跟着改。')}</p>
        <textarea className="rename-credential-box" data-testid="rename-credential-input" rows={2} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
        {checking && (
          <div className="small muted" data-testid="rename-checking">
            {t('正在检查…')}
          </div>
        )}
        {error && !checking && (
          <div className="small err" data-testid="rename-check-error">
            {error}
          </div>
        )}
        <CheckList checks={args ? checks : null} />
      </div>
    </ConfirmDialog>
  );
}
