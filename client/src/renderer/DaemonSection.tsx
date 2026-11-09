// Settings → 本机 daemon (GitHub#314): is the local cavil-loop daemon installed,
// what is missing, which projects are connected and whether each one runs;
// stop / start / disconnect one, open its log or config, update the daemon.
//
// Everything shown comes from the daemon's status script through the back end.
// Stop, start and disconnect are sent only after a confirmation, and only offered
// when the status script read the job's state: an unreadable state offers nothing
// that could register the job twice.

import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Icon } from './Icons';
import { ConfirmDialog } from './ConfirmDialog';
import { copyText } from './pasteImage';
import { ago, checklist, toolRows, refreshOk, refreshWord, schedWord, type DaemonProject, type DaemonResult, type DaemonStatus, type DaemonUpdate, type LocalStatus, type CheckRow } from '../shared/daemon';

type Ask = { kind: 'stop' | 'start' | 'disconnect'; p: DaemonProject };

export interface DaemonState {
  status: DaemonStatus | null;
  checking: boolean;
  check: () => Promise<void>;
}

/**
 * The daemon's status, read once when settings open and again on request. Shared by this section
 * and the repository list's "接上 daemon" (GitHub#315), so both show the same answer.
 */
export function useDaemonStatus(): DaemonState {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const alive = useRef(true);
  const check = async () => {
    setChecking(true);
    try {
      const s = await api().daemonStatus();
      if (alive.current) setStatus(s);
    } catch (e) {
      if (alive.current) setStatus({ state: 'unreadable', reason: (e as Error).message, entry: null });
    } finally {
      if (alive.current) setChecking(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    void check();
    return () => {
      alive.current = false;
    };
  }, []);
  return { status, checking, check };
}

export function DaemonSection({ daemon }: { daemon: DaemonState }) {
  const { status, checking, check } = daemon;
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  /** the last answer per project (or "install"), shown under it */
  const [notes, setNotes] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [update, setUpdate] = useState<DaemonUpdate | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = async (id: string, f: () => Promise<DaemonResult>, okWhen: (r: DaemonResult) => boolean, okText: (r: DaemonResult) => string) => {
    setBusy(id);
    try {
      const r = await f();
      const ok = okWhen(r);
      if (alive.current) setNotes((n) => ({ ...n, [id]: { ok, text: ok ? okText(r) : r.output || r.result } }));
    } catch (e) {
      if (alive.current) setNotes((n) => ({ ...n, [id]: { ok: false, text: (e as Error).message } }));
    } finally {
      if (alive.current) setBusy(null);
      await check();
    }
  };

  const confirm = async () => {
    if (!ask) return;
    const { kind, p } = ask;
    setAsk(null);
    if (kind === 'disconnect') {
      await run(p.key, () => api().daemonDisconnect(p.key), (r) => r.result === 'disconnected', () => `已断开 ${p.key}（项目里的配置和状态都还在）`);
    } else {
      await run(p.key, () => api().daemonService(p.key, kind), (r) => r.result === 'ok', (r) => `${kind === 'stop' ? '已停' : '已启动'}（现在：${schedWord(r.state)}）`);
    }
  };

  const doUpdate = async () => {
    setBusy('update');
    setUpdate(null);
    try {
      const r = await api().daemonUpdate();
      if (alive.current) setUpdate(r);
    } catch (e) {
      if (alive.current) setUpdate({ result: 'refused', output: (e as Error).message });
    } finally {
      if (alive.current) setBusy(null);
      await check();
    }
  };

  return (
    <section id="set-daemon" data-testid="daemon-settings">
      <h3>本机 daemon</h3>
      <p className="muted small">
        daemon 是在这台电脑上替人处理 issue / PR 的后台程序（cavil-loop）。这里检查它装没装、缺什么、接了哪些项目、在不在跑。客户端只在本机跑 daemon 自带的脚本，不替人装系统软件，也不把客户端的 GitHub 登录交给它。
      </p>
      <Summary status={status} checking={checking} busy={busy} onCheck={check} onInstall={() => run('install', () => api().daemonInstall(), (r) => r.result === 'installed' || r.result === 'existing', (r) => r.output ?? '已安装')} />
      {notes.install && <Note id="install" note={notes.install} />}
      {status?.state === 'ok' && (
        <>
          <Checks st={status.status} />
          <Projects st={status.status} busy={busy} notes={notes} onAsk={setAsk} onOpen={(p, what) => run(p.key, () => api().daemonOpen(p.key, what), (r) => r.result === 'ok', (r) => `已打开 ${r.path}`)} />
          <Update st={status.status} busy={busy} result={update} onUpdate={doUpdate} />
        </>
      )}
      {ask && (
        <ConfirmDialog
          title={ask.kind === 'stop' ? `停掉 ${ask.p.key} 的后台轮询？` : ask.kind === 'start' ? `启动 ${ask.p.key} 的后台轮询？` : `断开 ${ask.p.key}？`}
          confirmLabel={ask.kind === 'stop' ? '停' : ask.kind === 'start' ? '启动' : '断开'}
          danger={ask.kind !== 'start'}
          onConfirm={confirm}
          onCancel={() => setAsk(null)}
        >
          <p className="small" data-testid="daemon-confirm-text">
            {ask.kind === 'stop'
              ? '停掉以后 daemon 不再替这个项目读 GitHub、不再派工；正在跑的 worker 不受影响。随时可以在这里再启动。'
              : ask.kind === 'start'
                ? '启动以后 daemon 按配置定时读这个项目的 GitHub 并派工。'
                : '断开 = 停掉这个项目的后台轮询并撤掉登记。项目目录里的配置文件和本机的状态目录都保留，以后重新接上就能原样回来；正在跑的 worker 不受影响。'}
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function Summary({ status, checking, busy, onCheck, onInstall }: { status: DaemonStatus | null; checking: boolean; busy: string | null; onCheck: () => void; onInstall: () => void }) {
  const again = (
    <button className="ghost" data-testid="daemon-recheck" disabled={checking || !!busy} onClick={onCheck}>
      <Icon name="refresh" />
      {checking ? '正在检查…' : '重新检查'}
    </button>
  );
  if (!status) {
    return (
      <p className="small" data-testid="daemon-summary" data-state="loading">
        正在检查…
      </p>
    );
  }
  if (status.state === 'missing') {
    return (
      <div data-testid="daemon-summary" data-state="missing">
        <p className="small">
          这台电脑还没装 daemon。「安装」会从 github.com 克隆 GigleAI/cavil-loop 到 <code>{status.entry}</code>，并给 Claude Code 建同名软链（和 README 里手动安装的结果一样）。
        </p>
        <div className="row">
          <button className="primary" data-testid="daemon-install" disabled={!!busy} onClick={onInstall}>
            {busy === 'install' ? '正在安装…' : '安装'}
          </button>
          {again}
        </div>
      </div>
    );
  }
  if (status.state === 'unreadable') {
    return (
      <div data-testid="daemon-summary" data-state="unreadable">
        <div className="banner error">
          <Icon name="warn" />
          <span className="banner-text">
            读不到本机 daemon 的状态：<span data-testid="daemon-reason">{status.reason}</span>
          </span>
        </div>
        {status.precheck && (
          // only the common tools could be checked (the status script lacks jq): list what is missing
          <>
            <p className="small">缺下面的工具时完整状态读不出来；装好后点「重新检查」。</p>
            <CheckList rows={toolRows(status.precheck.base_deps.missing, status.precheck.os)} />
          </>
        )}
        <div className="row">{again}</div>
      </div>
    );
  }
  const d = status.status.daemon;
  return (
    <div data-testid="daemon-summary" data-state="ok">
      <p className="small">
        已装 · 版本 <b data-testid="daemon-version">{d.version ? d.version.slice(0, 12) : '读不出'}</b> · 位置 <code>{d.target ?? d.entry}</code> ·{' '}
        <span data-testid="daemon-form">{d.form === 'managed' ? '自动更新' : d.form === 'checkout' ? '手动更新' : '不能在这里更新'}</span>
      </p>
      <div className="row">{again}</div>
    </div>
  );
}

function Checks({ st }: { st: LocalStatus }) {
  return <CheckList rows={checklist(st)} />;
}

function CheckList({ rows }: { rows: CheckRow[] }) {
  return (
    <ul className="daemon-checks" data-testid="daemon-checks">
      {rows.map((r) => (
        <li key={r.id} data-testid="daemon-check" data-id={r.id} data-ok={String(r.ok)}>
          <span className={r.ok ? 'ok-mark' : 'err'}>
            <Icon name={r.ok ? 'check' : 'warn'} />
          </span>
          <span>{r.text}</span>
          {r.command && <Command text={r.command} />}
        </li>
      ))}
    </ul>
  );
}

function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <span className="daemon-command">
      <code data-testid="daemon-command">{text}</code>
      <button className="ghost small" data-testid="daemon-copy" onClick={async () => setCopied(await copyText(text))}>
        {copied === null ? '复制' : copied ? '已复制' : '复制失败，请手动选中'}
      </button>
    </span>
  );
}

function Projects({ st, busy, notes, onAsk, onOpen }: { st: LocalStatus; busy: string | null; notes: Record<string, { ok: boolean; text: string }>; onAsk: (a: Ask) => void; onOpen: (p: DaemonProject, what: 'log' | 'config') => void }) {
  if (st.projects.length === 0) {
    return (
      <p className="muted small" data-testid="daemon-projects-empty">
        还没有接入任何项目。
      </p>
    );
  }
  const now = Date.now();
  return (
    <table className="daemon-projects" data-testid="daemon-projects">
      <thead>
        <tr>
          <th>项目</th>
          <th>仓库 / 本地目录</th>
          <th>agent</th>
          <th>状态</th>
          <th>上次轮询</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {st.projects.map((p) => {
          const state = p.scheduler?.state ?? 'unknown';
          const worker = p.agents?.find((a) => a.role === 'worker');
          const missing = p.deps.missing ?? [];
          const note = notes[p.key];
          return (
            <tr key={p.key} data-testid="daemon-project" data-key={p.key} data-state={state}>
              <td>
                <b>{p.key}</b>
                {p.layout === 'legacy' && <div className="muted small">改名前装的</div>}
              </td>
              <td>
                <div>{p.repo ?? <span className="muted">读不出</span>}</div>
                <div className="muted small">
                  <code>{p.host ?? '—'}</code>
                </div>
              </td>
              <td>
                {worker ? worker.agent : <span className="muted">读不出</span>}
                {p.deps.state === 'missing' && (
                  <div className="err small" data-testid="daemon-project-missing">
                    缺 {missing.join('、')}
                  </div>
                )}
                {p.deps.state === 'unknown' && <div className="muted small">依赖：读不到（配置读不出）</div>}
              </td>
              <td className="nowrap" data-testid="daemon-project-state" title={state === 'unknown' ? p.scheduler?.raw ?? '' : undefined}>
                <span className={state === 'running' ? 'ok-mark' : state === 'unknown' ? 'err' : 'muted'}>{schedWord(state)}</span>
              </td>
              <td className="small nowrap" title={p.last_poll?.iso}>
                {p.last_poll ? ago(p.last_poll.epoch, now) : <span className="muted">还没轮询过</span>}
              </td>
              <td className="daemon-actions">
                {state === 'running' && (
                  <button data-testid="daemon-stop" disabled={!!busy} onClick={() => onAsk({ kind: 'stop', p })}>
                    停
                  </button>
                )}
                {state === 'stopped' && (
                  <button data-testid="daemon-start" disabled={!!busy} onClick={() => onAsk({ kind: 'start', p })}>
                    启
                  </button>
                )}
                <button data-testid="daemon-disconnect" disabled={!!busy} onClick={() => onAsk({ kind: 'disconnect', p })}>
                  断开…
                </button>
                <button className="ghost" data-testid="daemon-log" disabled={!!busy || !p.state_dir} onClick={() => onOpen(p, 'log')}>
                  日志
                </button>
                <button className="ghost" data-testid="daemon-config" disabled={!!busy || !p.config} onClick={() => onOpen(p, 'config')}>
                  配置
                </button>
                {busy === p.key && <div className="muted small">正在执行…</div>}
                {note && <Note id={p.key} note={note} />}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Note({ id, note }: { id: string; note: { ok: boolean; text: string } }) {
  return (
    <pre className={`daemon-output small${note.ok ? '' : ' err'}`} data-testid="daemon-note" data-for={id} data-ok={String(note.ok)}>
      {note.text}
    </pre>
  );
}

function Update({ st, busy, result, onUpdate }: { st: LocalStatus; busy: string | null; result: DaemonUpdate | null; onUpdate: () => void }) {
  const form = st.daemon.form;
  if (form === 'managed') {
    return (
      <p className="small" data-testid="daemon-update" data-form="managed">
        daemon 自动更新：每次合入主干后几分钟内自己换到新版本，当前版本 <b>{st.daemon.version?.slice(0, 12) ?? '读不出'}</b>。
      </p>
    );
  }
  if (form !== 'checkout') {
    return (
      <p className="muted small" data-testid="daemon-update" data-form={form}>
        这份 daemon 不是 git 代码目录，不能在这里更新。
      </p>
    );
  }
  return (
    <div data-testid="daemon-update" data-form="checkout">
      <p className="muted small">
        「更新 daemon」只做快进拉取：代码目录里有没提交的改动、或有自己的提交分叉时停下，原样显示 git 的输出，不覆盖。拉取后对每个 Mac 项目换新后台任务配置，逐个显示结果。
      </p>
      <div className="row">
        <button data-testid="daemon-update-run" disabled={!!busy} onClick={onUpdate}>
          {busy === 'update' ? '正在更新…' : '更新 daemon'}
        </button>
      </div>
      {result && (
        <div data-testid="daemon-update-result" data-result={result.result}>
          <p className={`small${result.result === 'blocked' || result.result === 'refused' ? ' err' : ''}`}>
            {result.result === 'updated'
              ? `已更新：${result.before?.slice(0, 12)} → ${result.after?.slice(0, 12)}`
              : result.result === 'current'
                ? '已经是最新'
                : result.result === 'blocked'
                  ? `没有更新：${result.step}`
                  : result.result === 'managed'
                    ? result.output
                    : `没有更新：${result.output}`}
          </p>
          {result.result === 'blocked' && result.output && <pre className="daemon-output small err">{result.output}</pre>}
          {(result.refresh ?? []).length > 0 && (
            <ul className="daemon-refresh">
              {result.refresh!.map((r, i) => (
                <li key={r.key ?? i} data-testid="daemon-refresh" data-key={r.key ?? ''} data-result={r.result}>
                  <span className={refreshOk(r.result) ? 'ok-mark' : 'err'}>
                    <Icon name={refreshOk(r.result) ? 'check' : 'warn'} />
                  </span>
                  <b>{r.key ?? '后台任务配置'}</b>：{refreshWord(r.result)}
                  {!refreshOk(r.result) && <pre className="daemon-output small err">{r.output}</pre>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
