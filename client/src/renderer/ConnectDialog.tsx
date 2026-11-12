// "接上 daemon" on a repository in Settings → 数据来源 (GitHub#315): connect
// that repository to the local cavil-loop daemon.
//
// The dialog picks a local copy (found by the back end, chosen with the
// system's folder picker, or typed) or a place to clone it, and an agent (the
// daemon's own list, claude by default). What is missing for that agent comes
// from the daemon's status script; anything missing and "开始" stays off.
// "开始" runs the daemon's own setup.sh in the back end; its output is shown
// as it comes. "已接上" only when the back end read the project back from the
// daemon's status afterwards — a failure shows the script's own words.

import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Icon } from './Icons';
import { useLayer, useShortcuts } from './keyboard';
import { copyText } from './pasteImage';
import { precheckRows, projectsFor, schedWord, type ConnectInfo, type ConnectOutcome, type ConnectPoll, type DirCheck, type Precheck2 } from '../shared/daemon';
import type { DaemonState } from './DaemonSection';

/** how often the dialog reads the running setup.sh's output */
const POLL_MS = 250;

export function ConnectButton({ repo, daemon }: { repo: string; daemon: DaemonState }) {
  const [open, setOpen] = useState(false);
  const st = daemon.status;
  if (st?.state === 'ok') {
    const here = projectsFor(st.status, repo);
    if (here.length > 0) {
      const title = here.map((p) => `${p.key}：${p.host ?? ''}（${schedWord(p.scheduler?.state)}）`).join('\n');
      // "已接上" only while a poller runs; a registration whose job is stopped or unreadable says so
      const runs = here.some((p) => p.scheduler?.state === 'running');
      return runs ? (
        <span className="ok-mark small" data-testid="connect-connected" data-state="running" title={title}>
          <Icon name="check" />
          已接上
        </span>
      ) : (
        <span className="muted small" data-testid="connect-connected" data-state={here[0].scheduler?.state ?? 'unknown'} title={title}>
          已登记，后台轮询{schedWord(here[0].scheduler?.state)}（见下面「本机 daemon」）
        </span>
      );
    }
  }
  const why = !st ? '正在检查本机 daemon…' : st.state === 'missing' ? '本机还没装 daemon：先在下面「本机 daemon」里安装' : st.state === 'unreadable' ? '读不到本机 daemon 的状态，见下面「本机 daemon」' : undefined;
  return (
    <>
      <button className="ghost" data-testid="connect-open" disabled={!!why} title={why ?? '让本机 daemon 替这个仓库处理 issue / PR'} onClick={() => setOpen(true)}>
        接上 daemon
      </button>
      {open && (
        <ConnectDialog
          repo={repo}
          onClose={() => {
            setOpen(false);
            void daemon.check();
          }}
        />
      )}
    </>
  );
}

type Mode = 'existing' | 'clone';

export function ConnectDialog({ repo, onClose }: { repo: string; onClose: () => void }) {
  useLayer('dialog');
  const name = repo.split('/')[1] ?? repo;
  const [info, setInfo] = useState<ConnectInfo | null>(null);
  const [mode, setMode] = useState<Mode>('existing');
  const [dir, setDir] = useState('');
  const [dirCheck, setDirCheck] = useState<DirCheck | null>(null);
  const [cloneInto, setCloneInto] = useState('');
  const [agent, setAgent] = useState('claude');
  const [pre, setPre] = useState<Precheck2 | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  /** the running / finished connect */
  const [job, setJob] = useState<number | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [output, setOutput] = useState('');
  const [outcome, setOutcome] = useState<ConnectOutcome | null>(null);
  const alive = useRef(true);
  const box = useRef<HTMLDivElement>(null);
  const out = useRef<HTMLPreElement>(null);
  const running = job !== null && !outcome;

  useEffect(() => {
    alive.current = true;
    box.current?.focus();
    void (async () => {
      const i = await api().daemonConnectInfo(repo).catch((e) => ({ result: 'refused', output: (e as Error).message }) as ConnectInfo);
      if (!alive.current) return;
      setInfo(i);
      if (i.result !== 'ok') return;
      if (i.agents?.length && !i.agents.includes('claude')) setAgent(i.agents[0]);
      setCloneInto(i.clone_parent ?? '');
      if (i.candidates?.length) {
        setMode('existing');
        setDir(i.candidates[0]);
      } else setMode('clone');
    })();
    return () => {
      alive.current = false;
    };
  }, [repo]);

  // the folder: checked by the back end each time it changes (the same check runs again at "开始")
  useEffect(() => {
    setDirCheck(null);
    if (mode !== 'existing' || !dir.trim()) return;
    let current = true;
    const t = setTimeout(async () => {
      const r = await api().daemonCheckDir(repo, dir.trim()).catch((e) => ({ result: 'refused', output: (e as Error).message }) as DirCheck);
      if (!current || !alive.current) return;
      setDirCheck(r);
      // a config already in the folder keeps its agent (setup.sh does not rewrite it)
      if (r.result === 'ok' && r.config?.agent) setAgent(r.config.agent);
    }, 300);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [repo, mode, dir]);

  // what is missing for the agent
  useEffect(() => {
    if (info?.result !== 'ok') return;
    let current = true;
    setPre(null);
    void api()
      .daemonPrecheck(agent)
      .catch((e) => ({ result: 'refused', output: (e as Error).message }) as Precheck2)
      .then((p) => current && alive.current && setPre(p));
    return () => {
      current = false;
    };
  }, [info, agent]);

  // the running setup.sh's output, as it comes
  useEffect(() => {
    if (job === null) return;
    let from = 0;
    let stop = false;
    const tick = async () => {
      while (!stop && alive.current) {
        const r: ConnectPoll = await api().daemonConnectPoll(job, from).catch((e) => ({ result: 'refused', output: (e as Error).message }));
        if (stop || !alive.current) return;
        if (r.result !== 'ok') {
          setOutcome({ result: 'failed', output: `读不到接上的进度：${r.output ?? r.result}` });
          return;
        }
        if (r.output) setOutput((o) => o + r.output);
        from = r.next ?? from;
        if (r.done) {
          setOutcome(r.outcome ?? { result: 'failed', output: '没有结果' });
          return;
        }
        await new Promise((res) => setTimeout(res, POLL_MS));
      }
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [job]);

  useEffect(() => {
    if (out.current) out.current.scrollTop = out.current.scrollHeight;
  }, [output]);

  const pick = async (which: 'dir' | 'clone') => {
    setPicking(null);
    const r = await api()
      .daemonPickFolder((which === 'dir' ? dir : cloneInto) || info?.clone_parent)
      .catch((e) => ({ result: 'refused', output: (e as Error).message }) as { result: string; path?: string | null; output?: string });
    if (!alive.current) return;
    if (r.result !== 'ok') return setPicking(r.output ?? r.result);
    if (!r.path) return;
    if (which === 'dir') setDir(r.path);
    else setCloneInto(r.path);
  };

  const configAgent = mode === 'existing' && dirCheck?.result === 'ok' ? dirCheck.config : null;
  const placeOk = mode === 'existing' ? dirCheck?.result === 'ok' : cloneInto.trim().startsWith('/');
  const canStart = info?.result === 'ok' && pre?.result === 'ok' && pre.ready === true && pre.agent === agent && placeOk && job === null && !(configAgent && configAgent.agent === null);

  const start = async () => {
    if (!canStart) return;
    setStartError(null);
    const r = await api()
      .daemonConnect({ repo, agent, ...(mode === 'existing' ? { dir: dir.trim() } : { cloneInto: cloneInto.trim() }) })
      .catch((e) => ({ result: 'refused', output: (e as Error).message }) as { result: string; output?: string; job?: number });
    if (!alive.current) return;
    if (r.result !== 'started' || typeof r.job !== 'number') return setStartError(r.output ?? r.result);
    setOutput('');
    setOutcome(null);
    setJob(r.job);
  };

  const close = () => {
    if (!running) onClose();
  };
  useShortcuts({ cancel: close, confirm: () => (outcome ? close() : void start()) });

  return (
    <div className="modal-back" data-testid="connect-dialog" onClick={close}>
      <div className="modal connect" role="dialog" aria-modal="true" tabIndex={-1} ref={box} onClick={(e) => e.stopPropagation()}>
        <h3>把 {repo} 接上本机 daemon</h3>
        {!info && <p className="small">正在读本机 daemon…</p>}
        {info && info.result !== 'ok' && (
          <div className="banner error" data-testid="connect-error">
            <Icon name="warn" />
            <span className="banner-text">{info.output}</span>
          </div>
        )}
        {info?.result === 'ok' && (
          <fieldset disabled={job !== null} className="connect-form">
            {(info.connected ?? []).length > 0 && (
              <p className="small warn-text" data-testid="connect-already">
                这个仓库已经接上了：{info.connected!.map((p) => `${p.key}（${p.host ?? ''}）`).join('、')}。再接一份会有两个轮询抢同一批 issue。
              </p>
            )}
            <div className="connect-mode">
              <label>
                <input type="radio" name="connect-mode" data-testid="connect-mode-existing" checked={mode === 'existing'} onChange={() => setMode('existing')} />
                用本机已有的目录
              </label>
              <label>
                <input type="radio" name="connect-mode" data-testid="connect-mode-clone" checked={mode === 'clone'} onChange={() => setMode('clone')} />
                克隆一份
              </label>
            </div>
            {mode === 'existing' ? (
              <div>
                {(info.candidates ?? []).length > 0 ? (
                  <p className="muted small">在本机找到 {info.candidates!.length} 份（origin 是 {repo}）：</p>
                ) : (
                  <p className="muted small" data-testid="connect-none-found">
                    常用的代码目录里没找到 origin 是 {repo} 的仓库；选一个目录，或改选「克隆一份」。
                  </p>
                )}
                {(info.candidates ?? []).map((c) => (
                  <label key={c} className="connect-candidate">
                    <input type="radio" name="connect-dir" data-testid="connect-candidate" checked={dir === c} onChange={() => setDir(c)} />
                    <code>{c}</code>
                  </label>
                ))}
                <div className="row">
                  <input className="title-box" data-testid="connect-dir" value={dir} placeholder="/Users/me/github/项目" onChange={(e) => setDir(e.target.value)} />
                  <button data-testid="connect-pick-dir" onClick={() => void pick('dir')}>
                    选…
                  </button>
                </div>
                {dirCheck && (
                  <p className={`small ${dirCheck.result === 'ok' ? 'ok-mark' : 'err'}`} data-testid="connect-dir-check" data-ok={String(dirCheck.result === 'ok')}>
                    {dirCheck.result === 'ok' ? `可以用：${dirCheck.dir}` : dirCheck.output}
                  </p>
                )}
                {configAgent && (
                  <p className="small warn-text" data-testid="connect-config-note">
                    {configAgent.agent
                      ? `这个目录里已有项目配置（${configAgent.path}），setup.sh 沿用它，agent 跟着配置用 ${configAgent.agent}。`
                      : `这个目录里已有项目配置（${configAgent.path}），但读不出里面用的 agent，不能在这里接上；请在终端里跑 setup.sh。`}
                  </p>
                )}
              </div>
            ) : (
              <div>
                <p className="muted small">从 https://github.com/{repo}.git 克隆到下面这个目录里的 {name}：</p>
                <div className="row">
                  <input className="title-box" data-testid="connect-clone-into" value={cloneInto} onChange={(e) => setCloneInto(e.target.value)} />
                  <button data-testid="connect-pick-clone" onClick={() => void pick('clone')}>
                    选…
                  </button>
                </div>
                {cloneInto.trim() && (
                  <p className="muted small" data-testid="connect-clone-target">
                    会克隆到 <code>{`${cloneInto.trim().replace(/\/+$/, '')}/${name}`}</code>
                  </p>
                )}
              </div>
            )}
            {picking && <p className="small err">{picking}</p>}
            <label className="connect-agent">
              agent
              <select data-testid="connect-agent" value={agent} disabled={!!configAgent} onChange={(e) => setAgent(e.target.value)}>
                {(info.agents ?? []).map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <div data-testid="connect-precheck" data-ready={pre ? String(pre.ready === true) : 'loading'}>
              {!pre ? (
                <p className="small muted">正在检查 {agent} 需要的程序…</p>
              ) : (
                <ul className="daemon-checks">
                  {precheckRows(pre).map((r) => (
                    <li key={r.id} data-testid="connect-check" data-id={r.id} data-ok={String(r.ok)}>
                      <span className={r.ok ? 'ok-mark' : 'err'}>
                        <Icon name={r.ok ? 'check' : 'warn'} />
                      </span>
                      <span>{r.text}</span>
                      {r.command && <Copyable text={r.command} />}
                    </li>
                  ))}
                </ul>
              )}
              {pre && pre.ready !== true && pre.result === 'ok' && <p className="small muted">装好后改一下 agent 或重新打开这个对话框，会重新检查。</p>}
            </div>
          </fieldset>
        )}
        {startError && (
          <div className="banner error" data-testid="connect-start-error">
            <Icon name="warn" />
            <span className="banner-text">{startError}</span>
          </div>
        )}
        {job !== null && (
          <>
            <p className="small">{running ? '正在接上（daemon 自带的 setup.sh）…' : 'setup.sh 的输出：'}</p>
            <pre className="daemon-output small" data-testid="connect-output" ref={out}>
              {output}
            </pre>
          </>
        )}
        {outcome && (
          <div
            className={outcome.result === 'connected' ? 'small ok-mark' : 'banner error'}
            data-testid="connect-result"
            data-result={outcome.result}
          >
            {outcome.result === 'connected' ? (
              <span>
                <Icon name="check" /> 已接上：{outcome.key}（后台轮询{schedWord(outcome.state)}）{outcome.already ? '，原来就接着' : ''}
              </span>
            ) : (
              <>
                <Icon name="warn" />
                <span className="banner-text" data-testid="connect-failure">
                  {outcome.output}
                </span>
              </>
            )}
          </div>
        )}
        <div className="row end">
          <button data-testid="connect-close" onClick={close} disabled={running}>
            {outcome ? '关闭' : '取消'}
          </button>
          {!outcome && (
            <button data-testid="connect-start" className="primary" disabled={!canStart} onClick={() => void start()}>
              {running ? '正在接上…' : '开始'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Copyable({ text }: { text: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <span className="daemon-command">
      <code data-testid="connect-command">{text}</code>
      <button className="ghost small" onClick={async () => setCopied(await copyText(text))}>
        {copied === null ? '复制' : copied ? '已复制' : '复制失败，请手动选中'}
      </button>
    </span>
  );
}
