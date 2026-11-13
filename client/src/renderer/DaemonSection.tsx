// Settings → 本机 daemon (GitHub#314): is the local cavil-loop daemon installed,
// what is missing, which projects are connected and whether each one runs;
// stop / start / disconnect one, open its log, change its everyday settings
// ("配置", GitHub#388: a form — ProjectConfigDialog), update the daemon.
//
// Everything shown comes from the daemon's status script through the back end.
// Stop, start and disconnect are sent only after a confirmation, and only offered
// when the status script read the job's state: an unreadable state offers nothing
// that could register the job twice.
//
// GitHub#473: the client's own words follow the language; what the daemon's scripts, git and the
// system said, and this machine's paths and project names, are shown as is (Verbatim / BackendText).

import { RemoteHostBlock } from './RemoteHostBlock';
import { noticeTone } from '../shared/noticeTone';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Icon } from './Icons';
import { ConfirmDialog } from './ConfirmDialog';
import { ProjectConfigDialog } from './ProjectConfigDialog';
import { copyText } from './pasteImage';
import { ago, checklist, toolRows, refreshOk, refreshWord, schedWord, type DaemonProject, type DaemonResult, type DaemonStatus, type DaemonUpdate, type LocalStatus, type Outdated, type CheckRow, type Words } from '../shared/daemon';
import { t, zhKey } from '../shared/i18n';
import { Verbatim, verbatimParts } from './Verbatim';
import { tNode } from './tNode';
import { BackendText, WordsText } from './WordsText';

type Ask = { kind: 'stop' | 'start' | 'disconnect'; p: DaemonProject };

/** What one action answered: the client's words (`words`), and / or the back end's message (`said`, `text`). */
export interface DaemonNote {
  ok: boolean;
  text: string;
  words?: Words;
  said?: unknown;
}

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
  const [notes, setNotes] = useState<Record<string, DaemonNote>>({});
  const [update, setUpdate] = useState<DaemonUpdate | null>(null);
  /** the project whose "配置" dialog is open (GitHub#388) */
  const [cfg, setCfg] = useState<DaemonProject | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** `okNote`: what to say when it worked (the client's words, or the back end's own message) */
  const run = async (id: string, f: () => Promise<DaemonResult>, okWhen: (r: DaemonResult) => boolean, okNote: (r: DaemonResult) => Omit<DaemonNote, 'ok'>) => {
    setBusy(id);
    try {
      const r = await f();
      const ok = okWhen(r);
      if (alive.current) setNotes((n) => ({ ...n, [id]: ok ? { ok, ...okNote(r) } : { ok, text: r.output || r.result, said: r.output ? r.outputSaid : undefined } }));
    } catch (e) {
      if (alive.current) setNotes((n) => ({ ...n, [id]: { ok: false, text: (e as Error).message } }));
    } finally {
      if (alive.current) setBusy(null);
      await check();
    }
  };
  const words = (w: Words): Omit<DaemonNote, 'ok'> => ({ text: '', words: w });

  const confirm = async () => {
    if (!ask) return;
    const { kind, p } = ask;
    setAsk(null);
    if (kind === 'disconnect') {
      await run(p.key, () => api().daemonDisconnect(p.key), (r) => r.result === 'disconnected', () => words({ zh: zhKey('已断开 {key}（项目里的配置和状态都还在）'), params: { key: p.key }, outside: { key: 'user' } }));
    } else {
      await run(
        p.key,
        () => api().daemonService(p.key, kind),
        (r) => r.result === 'ok',
        (r) => words(kind === 'stop' ? { zh: zhKey('已停（现在：{state}）'), params: { state: schedWord(r.state) } } : { zh: zhKey('已启动（现在：{state}）'), params: { state: schedWord(r.state) } }),
      );
    }
  };

  const openFile = (p: DaemonProject, what: 'log' | 'config', okNote: (path: string) => Omit<DaemonNote, 'ok'> = (path) => words({ zh: zhKey('已打开 {path}'), params: { path }, outside: { path: 'user' } })) =>
    run(p.key, () => api().daemonOpen(p.key, what), (r) => r.result === 'ok', (r) => okNote(r.path ?? ''));

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
      <h3>{t('本机 daemon')}</h3>
      <p className="muted small">
        {t('daemon 是在这台电脑上替人处理 issue / PR 的后台程序（cavil-loop）。这里检查它装没装、缺什么、接了哪些项目、在不在跑。客户端只在本机跑 daemon 自带的脚本，不替人装系统软件，也不把客户端的 GitHub 登录交给它。')}
      </p>
      <Summary
        status={status}
        checking={checking}
        busy={busy}
        update={update}
        onUpdate={doUpdate}
        onCheck={check}
        onInstall={() => run('install', () => api().daemonInstall(), (r) => r.result === 'installed' || r.result === 'existing', (r) => (r.output ? { text: r.output, said: r.outputSaid } : { text: t('已安装') }))}
      />
      {notes.install && <Note id="install" note={notes.install} />}
      {status?.state === 'ok' && (
        <>
          <Checks st={status.status} />
          <Projects st={status.status} busy={busy} notes={notes} onAsk={setAsk} onOpen={(p) => void openFile(p, 'log')} onConfig={setCfg} />
          <Update st={status.status} busy={busy} result={update} onUpdate={doUpdate} />
          <RemoteHostBlock />
        </>
      )}
      {cfg && (
        <ProjectConfigDialog
          project={cfg}
          status={status?.state === 'ok' ? status.status : null}
          onClose={() => setCfg(null)}
          onOpenEditor={() => void openFile(cfg, 'config')}
          onUnsupported={(why, whySaid) => {
            // a daemon from before the config script: the editor, as before, and say why there is no form
            const p = cfg;
            setCfg(null);
            void openFile(p, 'config', (path) => ({ text: why, said: whySaid, words: { zh: zhKey('已用编辑器打开 {path}'), params: { path }, outside: { path: 'user' } } }));
          }}
          onSaved={() => void check()}
        />
      )}
      {ask && (
        <ConfirmDialog
          title={
            ask.kind === 'stop'
              ? tNode('停掉 {key} 的后台轮询？', { key: <Verbatim from="user">{ask.p.key}</Verbatim> })
              : ask.kind === 'start'
                ? tNode('启动 {key} 的后台轮询？', { key: <Verbatim from="user">{ask.p.key}</Verbatim> })
                : tNode('断开 {key}？', { key: <Verbatim from="user">{ask.p.key}</Verbatim> })
          }
          confirmLabel={ask.kind === 'stop' ? t('停') : ask.kind === 'start' ? t('启动') : t('断开')}
          danger={ask.kind !== 'start'}
          onConfirm={confirm}
          onCancel={() => setAsk(null)}
        >
          <p className="small" data-testid="daemon-confirm-text">
            {ask.kind === 'stop'
              ? t('停掉以后 daemon 不再替这个项目读 GitHub、不再派工；正在跑的 worker 不受影响。随时可以在这里再启动。')
              : ask.kind === 'start'
                ? t('启动以后 daemon 按配置定时读这个项目的 GitHub 并派工。')
                : t('断开 = 停掉这个项目的后台轮询并撤掉登记。项目目录里的配置文件和本机的状态目录都保留，以后重新接上就能原样回来；正在跑的 worker 不受影响。')}
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}

/** GitHub#357: the "cannot read the daemon" bar — a failed read, or the next read running */
const daemonReadTone = (checking: boolean) => noticeTone({ busy: checking, done: false, failed: true, retrying: false, rest: 'error' });

function Summary({ status, checking, busy, update, onUpdate, onCheck, onInstall }: { status: DaemonStatus | null; checking: boolean; busy: string | null; update: DaemonUpdate | null; onUpdate: () => void; onCheck: () => void; onInstall: () => void }) {
  const again = (
    <button className="ghost" data-testid="daemon-recheck" disabled={checking || !!busy} onClick={onCheck}>
      <Icon name="refresh" />
      {checking ? t('正在检查…') : t('重新检查')}
    </button>
  );
  if (!status) {
    return (
      <p className="small" data-testid="daemon-summary" data-state="loading">
        {t('正在检查…')}
      </p>
    );
  }
  if (status.state === 'missing') {
    return (
      <div data-testid="daemon-summary" data-state="missing">
        <p className="small">
          {tNode('这台电脑还没装 daemon。「安装」会从 github.com 克隆 GigleAI/cavil-loop 到 {entry}，并给 Claude Code 建同名软链（和 README 里手动安装的结果一样）。', {
            entry: (
              <code>
                <Verbatim from="user">{status.entry}</Verbatim>
              </code>
            ),
          })}
        </p>
        <div className="row">
          <button className="primary" data-testid="daemon-install" disabled={!!busy} onClick={onInstall}>
            {busy === 'install' ? t('正在安装…') : t('安装')}
          </button>
          {again}
        </div>
      </div>
    );
  }
  if (status.state === 'unreadable') {
    return (
      <div data-testid="daemon-summary" data-state="unreadable">
        {/* GitHub#357: red = the last read failed; while "重新检查" reads again it is that read running */}
        <div className={`banner ${daemonReadTone(checking)}`} data-testid="daemon-unreadable" data-kind={daemonReadTone(checking)}>
          {checking ? <span className="spin" aria-hidden="true" /> : <Icon name="warn" />}
          <span className="banner-text">
            {tNode('读不到本机 daemon 的状态：{reason}', {
              reason: (
                <span data-testid="daemon-reason">
                  <BackendText said={status.reasonSaid} text={status.reason} />
                </span>
              ),
            })}
            {checking && t('；正在重新检查…')}
          </span>
        </div>
        {status.precheck && (
          // only the common tools could be checked (the status script lacks jq): list what is missing
          <>
            <p className="small">{t('缺下面的工具时完整状态读不出来；装好后点「重新检查」。')}</p>
            <CheckList rows={toolRows(status.precheck.base_deps.missing, status.precheck.os)} />
          </>
        )}
        {status.outdated && <OutdatedDaemon o={status.outdated} busy={busy} result={update} onUpdate={onUpdate} />}
        <div className="row">{again}</div>
      </div>
    );
  }
  const d = status.status.daemon;
  return (
    <div data-testid="daemon-summary" data-state="ok">
      <p className="small">
        {tNode('已装 · 版本 {version} · 位置 {where} · {form}', {
          version: <b data-testid="daemon-version">{d.version ? <Verbatim from="daemon">{d.version.slice(0, 12)}</Verbatim> : t('读不出')}</b>,
          where: (
            <code>
              <Verbatim from="user">{d.target ?? d.entry}</Verbatim>
            </code>
          ),
          form: <span data-testid="daemon-form">{d.form === 'managed' ? t('自动更新') : d.form === 'checkout' ? t('手动更新') : t('不能在这里更新')}</span>,
        })}
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
          <span>
            <WordsText words={r.words} />
          </span>
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
        {copied === null ? t('复制') : copied ? t('已复制') : t('复制失败，请手动选中')}
      </button>
    </span>
  );
}

function Projects({
  st,
  busy,
  notes,
  onAsk,
  onOpen,
  onConfig,
}: {
  st: LocalStatus;
  busy: string | null;
  notes: Record<string, DaemonNote>;
  onAsk: (a: Ask) => void;
  onOpen: (p: DaemonProject) => void;
  onConfig: (p: DaemonProject) => void;
}) {
  if (st.projects.length === 0) {
    return (
      <p className="muted small" data-testid="daemon-projects-empty">
        {t('还没有接入任何项目。')}
      </p>
    );
  }
  const now = Date.now();
  return (
    <table className="daemon-projects" data-testid="daemon-projects">
      <thead>
        <tr>
          <th>{t('项目')}</th>
          <th>{t('仓库 / 本地目录')}</th>
          <th>agent</th>
          <th>{t('状态')}</th>
          <th>{t('上次轮询')}</th>
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
                <b>
                  <Verbatim from="user">{p.key}</Verbatim>
                </b>
                {p.layout === 'legacy' && <div className="muted small">{t('改名前装的')}</div>}
              </td>
              <td>
                <div>{p.repo ? <Verbatim from="daemon">{p.repo}</Verbatim> : <span className="muted">{t('读不出')}</span>}</div>
                <div className="muted small">
                  <code>{p.host ? <Verbatim from="user">{p.host}</Verbatim> : '—'}</code>
                </div>
              </td>
              <td>
                {worker ? <Verbatim from="daemon">{worker.agent}</Verbatim> : <span className="muted">{t('读不出')}</span>}
                {p.deps.state === 'missing' && (
                  <div className="err small" data-testid="daemon-project-missing">
                    {tNode('缺 {name}', { name: <Verbatim from="daemon">{missing.join(t('、'))}</Verbatim> })}
                  </div>
                )}
                {p.deps.state === 'unknown' && <div className="muted small">{t('依赖：读不到（配置读不出）')}</div>}
              </td>
              <td
                className="nowrap"
                data-testid="daemon-project-state"
                title={state === 'unknown' ? p.scheduler?.raw ?? '' : undefined}
                {...(state === 'unknown' ? verbatimTitle(p.scheduler?.raw) : {})}
              >
                <span className={state === 'running' ? 'ok-mark' : state === 'unknown' ? 'err' : 'muted'}>{schedWord(state)}</span>
              </td>
              <td className="small nowrap" title={p.last_poll?.iso}>
                {p.last_poll ? ago(p.last_poll.epoch, now) : <span className="muted">{t('还没轮询过')}</span>}
              </td>
              <td className="daemon-actions">
                {state === 'running' && (
                  <button data-testid="daemon-stop" disabled={!!busy} onClick={() => onAsk({ kind: 'stop', p })}>
                    {t('停')}
                  </button>
                )}
                {state === 'stopped' && (
                  <button data-testid="daemon-start" disabled={!!busy} onClick={() => onAsk({ kind: 'start', p })}>
                    {t('启')}
                  </button>
                )}
                <button data-testid="daemon-disconnect" disabled={!!busy} onClick={() => onAsk({ kind: 'disconnect', p })}>
                  {t('断开…')}
                </button>
                <button className="ghost" data-testid="daemon-log" disabled={!!busy || !p.state_dir} onClick={() => onOpen(p)}>
                  {t('日志')}
                </button>
                <button className="ghost" data-testid="daemon-config" disabled={!!busy || !p.config} title={t('改这个项目的常用设置')} onClick={() => onConfig(p)}>
                  {t('配置…')}
                </button>
                {busy === p.key && <div className="muted small">{t('正在执行…')}</div>}
                {note && <Note id={p.key} note={note} />}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** the scheduler's own words as a hover text: outside text, named so the language check takes it out */
const verbatimTitle = (raw: string | undefined) => verbatimParts('daemon', [raw]);

function Note({ id, note }: { id: string; note: DaemonNote }) {
  return (
    <pre className={`daemon-output small${note.ok ? '' : ' err'}`} data-testid="daemon-note" data-for={id} data-ok={String(note.ok)}>
      {note.words && <WordsText words={note.words} />}
      {note.words && (note.said || note.text) && '\n'}
      {(note.said || note.text) && <BackendText said={note.said} text={note.text} />}
    </pre>
  );
}

function Update({ st, busy, result, onUpdate }: { st: LocalStatus; busy: string | null; result: DaemonUpdate | null; onUpdate: () => void }) {
  const form = st.daemon.form;
  if (form === 'managed') {
    return (
      <p className="small" data-testid="daemon-update" data-form="managed">
        {tNode('daemon 自动更新：每次合入主干后几分钟内自己换到新版本，当前版本 {version}。', {
          version: <b>{st.daemon.version ? <Verbatim from="daemon">{st.daemon.version.slice(0, 12)}</Verbatim> : t('读不出')}</b>,
        })}
      </p>
    );
  }
  if (form !== 'checkout') {
    return (
      <p className="muted small" data-testid="daemon-update" data-form={form}>
        {t('这份 daemon 不是 git 代码目录，不能在这里更新。')}
      </p>
    );
  }
  return (
    <div data-testid="daemon-update" data-form="checkout">
      <p className="muted small">
        {t('「更新 daemon」只做快进拉取：代码目录里有没提交的改动、或有自己的提交分叉时停下，原样显示 git 的输出，不覆盖。拉取后对每个 Mac 项目换新后台任务配置，逐个显示结果。')}
      </p>
      <div className="row">
        <button data-testid="daemon-update-run" disabled={!!busy} onClick={onUpdate}>
          {busy === 'update' ? t('正在更新…') : t('更新 daemon')}
        </button>
      </div>
      {result && <UpdateResult result={result} />}
    </div>
  );
}

/** a commit id as git gave it */
const sha = (s: string | undefined) => <Verbatim from="system">{s?.slice(0, 12) ?? ''}</Verbatim>;

/** What one update did: the commits, git's words when it stopped, each Mac project's refresh. */
function UpdateResult({ result }: { result: DaemonUpdate }) {
  const output = <BackendText said={result.outputSaid} text={result.output} />;
  return (
    <div data-testid="daemon-update-result" data-result={result.result}>
      <p className={`small${result.result === 'blocked' || result.result === 'refused' || result.result === 'still_old' ? ' err' : ''}`}>
        {result.result === 'updated'
          ? tNode('已更新：{before} → {after}', { before: sha(result.before), after: sha(result.after) })
          : result.result === 'current'
            ? t('已经是最新')
            : result.result === 'still_old'
              ? // pulled, yet still no status script: the branch it follows has none (GitHub#320)
                tNode('已拉取（{before} → {after}），但仍读不到 daemon 的状态：这份代码当前在分支 {branch}，它跟踪的远端分支拉到最新后仍没有状态脚本。', {
                  before: sha(result.before),
                  after: sha(result.after),
                  branch: (
                    <b data-testid="daemon-update-branch">
                      <BackendText said={result.branchSaid} text={result.branch} />
                    </b>
                  ),
                })
              : result.result === 'blocked'
                ? t('没有更新：{step}', { step: result.step ?? '' })
                : result.result === 'managed'
                  ? output
                  : tNode('没有更新：{why}', { why: output })}
      </p>
      {(result.result === 'blocked' || result.result === 'still_old') && result.output && <pre className="daemon-output small err">{output}</pre>}
      {(result.refresh ?? []).length > 0 && (
        <ul className="daemon-refresh">
          {result.refresh!.map((r, i) => (
            <li key={r.key ?? i} data-testid="daemon-refresh" data-key={r.key ?? ''} data-result={r.result}>
              <span className={refreshOk(r.result) ? 'ok-mark' : 'err'}>
                <Icon name={refreshOk(r.result) ? 'check' : 'warn'} />
              </span>
              {tNode('{key}：{word}', { key: <b>{r.key ? <Verbatim from="user">{r.key}</Verbatim> : t('后台任务配置')}</b>, word: refreshWord(r.result) })}
              {!refreshOk(r.result) && (
                <pre className="daemon-output small err">
                  <BackendText said={r.outputSaid} text={r.output} />
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A daemon from before the status script (GitHub#320). A checkout gets the same fast-forward as the
 * update below; the others only get what is known — no promise that waiting helps, no manual steps.
 */
function OutdatedDaemon({ o, busy, result, onUpdate }: { o: Outdated; busy: string | null; result: DaemonUpdate | null; onUpdate: () => void }) {
  const target = (x: string) => (
    <code>
      <Verbatim from="user">{x}</Verbatim>
    </code>
  );
  if (o.form === 'checkout') {
    return (
      <div data-testid="daemon-outdated" data-form="checkout">
        <p className="small">
          {tNode('这份 daemon 是 git 代码目录 {target}，可以在这里更新到带状态脚本的新版本。「更新 daemon」只做快进拉取：代码目录里有没提交的改动、或有自己的提交分叉时停下，原样显示 git 的输出，不覆盖。更新后自动重新检查。', {
            target: target(o.target),
          })}
        </p>
        <div className="row">
          <button className="primary" data-testid="daemon-update-run" disabled={!!busy} onClick={onUpdate}>
            {busy === 'update' ? t('正在更新…') : t('更新 daemon')}
          </button>
        </div>
        {result && <UpdateResult result={result} />}
      </div>
    );
  }
  return (
    <p className="small" data-testid="daemon-outdated" data-form={o.form}>
      {o.form === 'managed'
        ? tNode('这份 daemon 是受管安装（{target}），按设计会在主干合入后自动换到新版本。它现在仍是旧版本，原因客户端判断不了（可能是定时任务没在跑、拉取失败或换版本失败）。可以稍后点「重新检查」；一直不变时需要人查看 daemon 的运行日志。', {
            target: target(o.target),
          })
        : o.form === 'directory'
          ? tNode('这份 daemon（{target}）不是 git 代码目录，也不是受管安装：客户端更新不了它，它也不会自己更新，需要维护者自行处理这份安装。', { target: target(o.target) })
          : tNode('读不出这份 daemon 是哪种安装，没有提供更新：{error}', {
              error: <span data-testid="daemon-outdated-error">{o.form === 'unknown' ? <BackendText said={o.errorSaid} text={o.error} /> : ''}</span>,
            })}
    </p>
  );
}
