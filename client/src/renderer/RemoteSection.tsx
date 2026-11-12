// Settings → 远程 daemon (GitHub#387): daemons on other machines, reached over Tailscale after
// pairing. Per machine: its projects and whether each runs, stop / start one (after a
// confirmation), the tail of one poll log, unpair.
//
// The back end proves the other end is the paired machine before it sends anything and holds the
// key; this section only shows what came back. A machine that cannot be read shows why, with the
// last status that was read greyed out and no actions — never "no projects" or "stopped".
// Unpairing counts only when the machine confirmed it; otherwise the row stays as "取消配对未完成".

import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Icon } from './Icons';
import { ConfirmDialog } from './ConfirmDialog';
import { useLayer, useShortcuts } from './keyboard';
import { MODAL } from './outsideClick';
import { copyText } from './pasteImage';
import { ago, schedWord, type DaemonProject, type LocalStatus } from '../shared/daemon';
import { PAIR_COMMAND, clock, codeDigits, readOk, remoteName, remotePill, revokeCommand, sortTailnet, tailnetPill, type RemoteEntry, type RemoteFail, type RemoteRead, type RemoteResult, type TailnetDevice, type TailnetList } from '../shared/remote';

type Ask =
  | { kind: 'stop' | 'start'; e: RemoteEntry; p: DaemonProject }
  /** `reason`: the machine could not confirm just now — what the offline question shows */
  | { kind: 'unpair'; e: RemoteEntry; offline: boolean; reason?: string };

type Note = { ok: boolean; text: string };

export function RemoteSection() {
  const [list, setList] = useState<RemoteEntry[] | null>(null);
  const [persistent, setPersistent] = useState(true);
  const [reads, setReads] = useState<Record<string, RemoteRead>>({});
  const [reading, setReading] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [ask, setAsk] = useState<Ask | null>(null);
  const [pairing, setPairing] = useState(false);
  const [log, setLog] = useState<{ e: RemoteEntry; key: string } | null>(null);
  const alive = useRef(true);

  const note = (id: string, n: Note | null) =>
    setNotes((all) => {
      const next = { ...all };
      if (n) next[id] = n;
      else delete next[id];
      return next;
    });

  const read = async (id: string) => {
    setReading((r) => ({ ...r, [id]: true }));
    let got: RemoteRead;
    try {
      got = await api().remoteStatus(id);
    } catch (e) {
      got = { state: 'local', message: (e as Error).message };
    }
    if (!alive.current) return;
    setReads((r) => ({ ...r, [id]: got }));
    setReading((r) => ({ ...r, [id]: false }));
    if (readOk(got)) await load(false);
  };

  /** the list as the back end keeps it; `fresh`: also read every paired machine and retry every unfinished unpairing */
  const load = async (fresh: boolean) => {
    let l;
    try {
      l = await api().remoteList();
    } catch {
      return;
    }
    if (!alive.current) return;
    setList(l.remotes);
    setPersistent(l.persistent);
    if (!fresh) return;
    for (const e of l.remotes) {
      if (e.state === 'paired') void read(e.id);
      else void retryRevoke(e, true);
    }
  };

  useEffect(() => {
    alive.current = true;
    void load(true);
    return () => {
      alive.current = false;
    };
  }, []);

  const act = async (id: string, f: () => Promise<RemoteResult>, okWhen: (r: RemoteResult) => boolean, okText: (r: RemoteResult) => string): Promise<RemoteResult | null> => {
    setBusy(id);
    try {
      const r = await f();
      if (alive.current) note(id, { ok: okWhen(r), text: okWhen(r) ? okText(r) : r.output || r.result });
      return r;
    } catch (e) {
      if (alive.current) note(id, { ok: false, text: (e as Error).message });
      return null;
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  /** ask the machine again to revoke; `quiet`: the automatic try when settings open says nothing when it fails again */
  const retryRevoke = async (e: RemoteEntry, quiet: boolean) => {
    let r: RemoteResult;
    try {
      r = await api().remoteUnpair(e.id, false);
    } catch (err) {
      r = { result: 'refused', output: (err as Error).message };
    }
    if (!alive.current) return;
    if (r.result === 'unpaired') {
      note(e.id, null);
      await load(false);
    } else if (!quiet) {
      note(e.id, { ok: false, text: `还是没能让那台机器确认撤销：${r.output || r.result}` });
    }
  };

  const confirm = async () => {
    if (!ask) return;
    const a = ask;
    setAsk(null);
    if (a.kind === 'unpair') {
      setBusy(a.e.id);
      let r: RemoteResult;
      try {
        r = await api().remoteUnpair(a.e.id, a.offline);
      } catch (err) {
        r = { result: 'refused', output: (err as Error).message };
      }
      if (!alive.current) return;
      setBusy(null);
      if (r.result === 'unconfirmed') {
        // the machine did not confirm: say what that means before anything changes here
        setAsk({ kind: 'unpair', e: a.e, offline: true, reason: r.output });
        return;
      }
      if (r.result === 'unpaired') note(a.e.id, r.output ? { ok: true, text: r.output } : null);
      else if (r.result !== 'pending') note(a.e.id, { ok: false, text: r.output || r.result });
      await load(false);
      return;
    }
    const id = `${a.e.id} ${a.p.key}`;
    const r = await act(id, () => api().remoteService(a.e.id, a.p.key, a.kind as 'stop' | 'start'), (r) => r.result === 'ok', (r) => `${a.kind === 'stop' ? '已停' : '已启动'}（现在：${schedWord(r.state)}）`);
    if (r) await read(a.e.id);
  };

  return (
    <section id="set-remote" data-testid="remote-settings">
      <h3>远程 daemon</h3>
      <p className="muted small">
        看和管理另一台机器上的 daemon。只通过 Tailscale 连接；先在那台机器上生成配对码，再在这里配对。这台电脑上不需要装 daemon，也不会把客户端的 GitHub 登录发给那台机器。
      </p>
      {list && list.length === 0 && (
        <p className="muted small" data-testid="remote-empty">
          还没有配对任何远程机器。
        </p>
      )}
      {list?.map((e) =>
        e.state === 'pending_revoke' ? (
          <Pending key={e.id} e={e} busy={busy === e.id} note={notes[e.id]} onRetry={() => retryRevoke(e, false)} onForget={async () => {
            await act(e.id, () => api().remoteForget(e.id), (r) => r.result === 'unpaired', () => '');
            note(e.id, null);
            await load(false);
          }} />
        ) : (
          <Machine
            key={e.id}
            e={e}
            read={reads[e.id] ?? null}
            reading={!!reading[e.id]}
            busy={busy}
            notes={notes}
            onRead={() => read(e.id)}
            onAsk={setAsk}
            onLog={(key) => setLog({ e, key })}
          />
        ),
      )}
      {!persistent && (
        <p className="muted small" data-testid="remote-not-kept">
          这个系统上配对用的钥匙只保存到 App 退出为止，下次打开要重新配对。
        </p>
      )}
      <div className="row">
        <button className="primary" data-testid="remote-add" onClick={() => setPairing(true)}>
          添加远程 daemon…
        </button>
      </div>
      {pairing && (
        <PairDialog
          paired={(list ?? []).map((e) => e.id)}
          onClose={() => setPairing(false)}
          onPaired={async (id) => {
            setPairing(false);
            await load(false);
            void read(id);
          }}
        />
      )}
      {log && <LogDialog e={log.e} projectKey={log.key} onClose={() => setLog(null)} />}
      {ask && ask.kind !== 'unpair' && (
        <ConfirmDialog
          title={ask.kind === 'stop' ? `停掉 ${remoteName(ask.e.host)} 上 ${ask.p.key} 的后台轮询？` : `启动 ${remoteName(ask.e.host)} 上 ${ask.p.key} 的后台轮询？`}
          confirmLabel={ask.kind === 'stop' ? '停' : '启动'}
          danger={ask.kind === 'stop'}
          onConfirm={confirm}
          onCancel={() => setAsk(null)}
        >
          <p className="small" data-testid="remote-confirm-text">
            {ask.kind === 'stop'
              ? '停掉以后那台机器上的 daemon 不再替这个项目读 GitHub、不再派工；正在跑的 worker 不受影响。随时可以在这里再启动。'
              : '启动以后那台机器上的 daemon 按配置定时读这个项目的 GitHub 并派工。'}
          </p>
        </ConfirmDialog>
      )}
      {ask && ask.kind === 'unpair' && (
        <ConfirmDialog
          title={`取消和 ${remoteName(ask.e.host)} 的配对？`}
          confirmLabel={ask.offline ? '只在这台电脑上取消' : '取消配对'}
          danger
          onConfirm={confirm}
          onCancel={() => setAsk(null)}
        >
          {ask.offline ? (
            <div data-testid="remote-unpair-text" data-offline="true">
              <div className="banner warn remote-inline">
                <Icon name="warn" />
                <span className="banner-text">
                  现在没能让那台机器确认，<b>它上面的授权这次撤销不了</b>。{ask.reason && <span data-testid="remote-unpair-reason">（{ask.reason}）</span>}
                </span>
              </div>
              <p className="small">继续的话：这台电脑不再连接它，并在列表里保留一行「取消配对未完成」，直到那台机器确认撤销（恢复连接后自动重试），或者在那台机器上手动撤销。</p>
            </div>
          ) : (
            <p className="small" data-testid="remote-unpair-text" data-offline="false">
              会先让那台机器撤销这台电脑的授权，那台机器确认后，这台电脑才删除自己的钥匙。之后要再连它，需要重新配对。
            </p>
          )}
        </ConfirmDialog>
      )}
    </section>
  );
}

function Machine({ e, read, reading, busy, notes, onRead, onAsk, onLog }: { e: RemoteEntry; read: RemoteRead | null; reading: boolean; busy: string | null; notes: Record<string, Note>; onRead: () => void; onAsk: (a: Ask) => void; onLog: (key: string) => void }) {
  const pill = remotePill(e, reading, read);
  const live = readOk(read) ? read : null;
  const failed: RemoteFail | null = read && !readOk(read) ? read : null;
  // what to show: the status just read, else the last one that was (old, no actions)
  const shown: LocalStatus | null = live ? live.status : e.last?.status ?? null;
  const at = live ? live.at : e.last?.at;
  const now = Date.now();
  return (
    <div className="remote-host" data-testid="remote-host" data-id={e.id} data-state={live ? 'ok' : reading ? 'reading' : failed ? 'failed' : 'idle'}>
      <div className="remote-head">
        <b>{remoteName(e.host)}</b>
        <span className={`remote-pill ${pill.tone}`} data-testid="remote-pill">
          {pill.word}
        </span>
        <span className="muted small">
          {e.host}
          {live && (
            <>
              {' · 版本 '}
              <b data-testid="remote-version">{live.status.daemon.version ? live.status.daemon.version.slice(0, 12) : '读不出'}</b>
              {' · '}
              {live.status.daemon.form === 'managed' ? '自动更新' : live.status.daemon.form === 'checkout' ? '手动更新' : '不能在这里更新'}
              {' · '}
              {ago(live.at, now)}读取
            </>
          )}
          {!live && at !== undefined && <span data-testid="remote-last-at">{` · 上次读到：${clock(at)}`}</span>}
        </span>
        <span className="remote-spacer" />
        <button className="ghost" data-testid="remote-reload" disabled={reading || !!busy} onClick={onRead}>
          <Icon name="refresh" />
          {reading ? '正在读取…' : '重新读取'}
        </button>
        <button data-testid="remote-unpair" disabled={!!busy} onClick={() => onAsk({ kind: 'unpair', e, offline: !live })}>
          取消配对…
        </button>
      </div>
      {failed && (
        <div className="banner error remote-inline" data-testid="remote-problem" data-kind={failed.state}>
          <Icon name="warn" />
          <span className="banner-text">
            {failed.message}
            {shown && '。下面是上次读到的内容，不能操作。'}
          </span>
        </div>
      )}
      {notes[e.id] && <NoteBox id={e.id} note={notes[e.id]} />}
      {shown &&
        (shown.projects.length === 0 ? (
          <p className="muted small" data-testid="remote-projects-empty">
            那台机器上还没有接入任何项目。
          </p>
        ) : (
          <table className={`daemon-projects${live ? '' : ' remote-old'}`} data-testid="remote-projects" data-live={String(!!live)}>
            <thead>
              <tr>
                <th>项目</th>
                <th>仓库 / 目录（在那台机器上）</th>
                <th>agent</th>
                <th>状态</th>
                <th>上次轮询</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.projects.map((p) => {
                const state = p.scheduler?.state ?? 'unknown';
                const worker = p.agents?.find((a) => a.role === 'worker');
                const id = `${e.id} ${p.key}`;
                return (
                  <tr key={p.key} data-testid="remote-project" data-key={p.key} data-state={state}>
                    <td>
                      <b>{p.key}</b>
                    </td>
                    <td>
                      <div>{p.repo ?? <span className="muted">读不出</span>}</div>
                      <div className="muted small">
                        <code>{p.host ?? '—'}</code>
                      </div>
                    </td>
                    <td>{worker ? worker.agent : <span className="muted">读不出</span>}</td>
                    <td className="nowrap" data-testid="remote-project-state">
                      <span className={!live ? 'muted' : state === 'running' ? 'ok-mark' : state === 'unknown' ? 'err' : 'muted'}>
                        {schedWord(state)}
                        {!live && '（上次读到）'}
                      </span>
                    </td>
                    <td className="small nowrap">{p.last_poll ? (live ? ago(p.last_poll.epoch, now) : clock(p.last_poll.epoch)) : <span className="muted">还没轮询过</span>}</td>
                    <td className="daemon-actions">
                      {live && state === 'running' && (
                        <button data-testid="remote-stop" disabled={!!busy} onClick={() => onAsk({ kind: 'stop', e, p })}>
                          停
                        </button>
                      )}
                      {live && state === 'stopped' && (
                        <button data-testid="remote-start" disabled={!!busy} onClick={() => onAsk({ kind: 'start', e, p })}>
                          启
                        </button>
                      )}
                      {live && (
                        <button className="ghost" data-testid="remote-log" disabled={!!busy} onClick={() => onLog(p.key)}>
                          日志
                        </button>
                      )}
                      {busy === id && <div className="muted small">正在执行…</div>}
                      {notes[id] && <NoteBox id={id} note={notes[id]} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
    </div>
  );
}

function Pending({ e, busy, note, onRetry, onForget }: { e: RemoteEntry; busy: boolean; note?: Note; onRetry: () => void; onForget: () => void }) {
  const [trying, setTrying] = useState(false);
  const cmd = revokeCommand(e);
  return (
    <div className="remote-host" data-testid="remote-host" data-id={e.id} data-state="pending">
      <div className="remote-head">
        <b>{remoteName(e.host)}</b>
        <span className="remote-pill bad" data-testid="remote-pill">
          取消配对未完成
        </span>
        <span className="muted small">{e.host}</span>
        <span className="remote-spacer" />
        <button
          data-testid="remote-retry"
          disabled={busy || trying}
          onClick={async () => {
            setTrying(true);
            try {
              await onRetry();
            } finally {
              setTrying(false);
            }
          }}
        >
          {trying ? '正在重试…' : '再试一次'}
        </button>
        <button className="ghost" data-testid="remote-forget" disabled={busy || trying} onClick={onForget}>
          已在那台机器上取消，移除此行
        </button>
      </div>
      <div className="banner warn remote-inline" data-testid="remote-pending">
        <Icon name="warn" />
        <span className="banner-text">
          这台电脑已不再连接它，但<b>那台机器上的授权还没有撤销</b>（取消时没能得到它的确认）。恢复连接后点「再试一次」，或在那台机器上运行：
          <br />
          <Command text={cmd} />
        </span>
      </div>
      {note && <NoteBox id={e.id} note={note} />}
    </div>
  );
}

function PairDialog({ paired, onClose, onPaired }: { paired: string[]; onClose: () => void; onPaired: (id: string) => void }) {
  const [host, setHost] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ reason: string; text: string } | null>(null);
  // this computer's Tailscale devices: null while reading
  const [net, setNet] = useState<TailnetList | null>(null);
  const [manual, setManual] = useState(false);
  const alive = useRef(true);
  const digits = codeDigits(code);
  const readNet = async () => {
    setNet(null);
    let r: TailnetList;
    try {
      r = await api().remoteTailnet();
    } catch (e) {
      r = { result: 'unreadable', output: (e as Error).message };
    }
    if (alive.current) setNet(r);
  };
  useEffect(() => {
    alive.current = true;
    void readNet();
    return () => {
      alive.current = false;
    };
  }, []);
  const devices = net?.result === 'ok' ? sortTailnet(net.devices) : [];
  const picked = manual ? undefined : devices.find((d) => d.host === host);
  const showManual = manual || net?.result === 'unreadable' || (net?.result === 'ok' && devices.length === 0);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api().remotePair(host, digits);
      if (r.result === 'paired' && r.id) return onPaired(r.id);
      setError({ reason: r.reason ?? 'failed', text: r.output || r.result });
    } catch (e) {
      setError({ reason: 'local', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const isPaired = (h: string) => paired.some((p) => p.split(':')[0] === h);
  return (
    <ConfirmDialog title="添加远程 daemon" confirmLabel={busy ? '正在配对…' : '配对'} busy={busy} disabled={host.trim() === '' || digits.length !== 8 || picked?.remote === 'offline'} dirty={host !== '' || code !== ''} onConfirm={submit} onCancel={onClose}>
      <div data-testid="remote-pair-dialog">
        {error && (
          <div className="banner error remote-inline" data-testid="remote-pair-error" data-reason={error.reason}>
            <Icon name="warn" />
            <span className="banner-text">没有配对：{error.text}</span>
          </div>
        )}
        {!showManual && (
          <>
            <p className="muted small">
              下面是这台电脑的 Tailscale 里能看到的机器。选一台已打开远程连接的，再填它显示的配对码。
              <button className="link" data-testid="remote-tailnet-again" disabled={net === null} onClick={() => void readNet()}>
                {net === null ? '正在读取…' : '重新读取'}
              </button>
            </p>
            {net === null && <p className="muted small" data-testid="remote-tailnet-loading">正在读取这台电脑的 Tailscale 设备，并逐台看远程连接开没开…</p>}
            <div className="remote-devices" role="radiogroup" aria-label="Tailscale 里的机器" data-testid="remote-tailnet">
              {devices.map((d) => {
                const pill = tailnetPill(d);
                const already = isPaired(d.host);
                return (
                  <button
                    key={d.host}
                    role="radio"
                    aria-checked={host === d.host}
                    className={`remote-device${host === d.host ? ' sel' : ''}${d.remote === 'offline' ? ' off' : ''}`}
                    data-testid="remote-tailnet-device"
                    data-host={d.host}
                    data-remote={d.remote}
                    disabled={already}
                    title={d.why}
                    onClick={() => setHost(d.host)}
                  >
                    <b>{d.name}</b>
                    <span className={`remote-pill ${pill.tone}`}>{already ? '已在列表里' : pill.word}</span>
                    {d.os && <span className="muted small">{d.os}</span>}
                    <span className="remote-spacer" />
                    <span className="muted small">{d.host}</span>
                  </button>
                );
              })}
            </div>
            {picked && picked.remote !== 'open' && <NotOpen d={picked} />}
          </>
        )}
        {showManual && (
          <>
            {net?.result === 'unreadable' && (
              <div className="banner warn remote-inline" data-testid="remote-tailnet-unreadable">
                <Icon name="warn" />
                <span className="banner-text">读不到这台电脑的 Tailscale 设备列表（{net.output}）。请手动输入机器名，或确认 Tailscale 已连上后重新读取。</span>
              </div>
            )}
            {net?.result === 'ok' && devices.length === 0 && !manual && <p className="muted small">这台电脑的 Tailscale 里没有别的机器，请手动输入机器名。</p>}
            <ol className="remote-steps small">
              <li>
                在那台机器上打开远程连接并生成配对码：装了本客户端的，在它的「设置 → 本机 daemon」里打开「允许其他电脑远程连接」、点「生成配对码」；没有窗口的服务器，在它上面运行（入口还没开时会先打开）：
                <br />
                <Command text={PAIR_COMMAND} />
              </li>
              <li>把那台机器显示的完整机器名（以 .ts.net 结尾）和 8 位配对码填到下面。配对码 10 分钟内有效、只能用一次。</li>
            </ol>
            <label className="remote-field">
              <span>机器名（Tailscale 里的完整名字，以 .ts.net 结尾）</span>
              <input data-testid="remote-pair-host" value={host} placeholder="mybox.tailnet-name.ts.net" spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(e) => setHost(e.target.value)} />
            </label>
          </>
        )}
        <label className="remote-field">
          <span>配对码{picked ? `（在 ${picked.name} 上显示的 8 位数字）` : ''}</span>
          <input data-testid="remote-pair-code" className="remote-code" value={code} placeholder="0000 0000" inputMode="numeric" spellCheck={false} onChange={(e) => setCode(e.target.value)} />
        </label>
        <p className="muted small">
          列表只读这台电脑的 Tailscale，再逐台问一声远程入口开没开，不发出这台电脑的任何信息。只接受 .ts.net 机器名。发出配对码之前，先核对对面出示的是 Tailscale 发给那台机器的证书、且连接走的是 Tailscale 地址；任何一项对不上就不发送。配对成功后，这台电脑得到一把只属于它的钥匙，存在系统钥匙串里。
        </p>
        {(!showManual || (manual && devices.length > 0)) && (
          <p className="small">
            <button
              className="link"
              data-testid="remote-pair-manual"
              onClick={() => {
                setManual(!manual);
                setHost('');
              }}
            >
              {manual ? '从列表里选' : '手动输入机器名'}
            </button>
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}

/** The picked machine's remote entry is not (known to be) open: how to open it there — this computer cannot. */
function NotOpen({ d }: { d: TailnetDevice }) {
  if (d.remote === 'offline')
    return (
      <div className="banner warn remote-inline" data-testid="remote-not-open" data-remote="offline">
        <Icon name="warn" />
        <span className="banner-text">{d.name} 现在不在线（Tailscale 这样说），连不上它。等它上线后再试。</span>
      </div>
    );
  return (
    <div className="banner warn remote-inline" data-testid="remote-not-open" data-remote={d.remote}>
      <Icon name="warn" />
      <span className="banner-text">
        {d.remote === 'unknown' ? `看不出 ${d.name} 的远程连接开没开${d.why ? `（${d.why}）` : ''}。已经打开的话，照样填配对码试试；` : `${d.name} 还没有打开远程连接。`}
        远程入口只能在那台机器上打开——这台电脑没有办法替它打开（否则任何连得上的设备都能打开别人的入口）。
        <br />
        <b>那台机器装了本客户端：</b>在它的「设置 → 本机 daemon」里打开「允许其他电脑远程连接」，点「生成配对码」。
        <br />
        <b>那台机器没有窗口（服务器）：</b>在它上面运行一次下面这条命令；它会打开入口并显示配对码。以后再加别的电脑，也只需要这一条。
        <br />
        <Command text={PAIR_COMMAND} />
      </span>
    </div>
  );
}

function LogDialog({ e, projectKey, onClose }: { e: RemoteEntry; projectKey: string; onClose: () => void }) {
  useLayer('dialog');
  useShortcuts({ cancel: onClose });
  const [got, setGot] = useState<RemoteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  const box = useRef<HTMLDivElement>(null);
  const fetchLog = async () => {
    setLoading(true);
    let r: RemoteResult;
    try {
      r = await api().remoteLog(e.id, projectKey);
    } catch (err) {
      r = { result: 'refused', output: (err as Error).message };
    }
    if (!alive.current) return;
    setGot(r);
    setLoading(false);
  };
  useEffect(() => {
    alive.current = true;
    box.current?.focus();
    void fetchLog();
    return () => {
      alive.current = false;
    };
  }, []);
  return (
    <div className="modal-back" {...{ [MODAL]: '' }} data-testid="remote-log-dialog" onClick={onClose}>
      <div className="modal remote-log" role="dialog" aria-modal="true" tabIndex={-1} ref={box} onClick={(ev) => ev.stopPropagation()}>
        <h3>
          日志 · {remoteName(e.host)} / {projectKey}
        </h3>
        <p className="muted small">
          那台机器上这个项目轮询日志的最后 200 行（只读）。
          <button className="link" data-testid="remote-log-again" disabled={loading} onClick={fetchLog}>
            {loading ? '正在读取…' : '再读一次'}
          </button>
        </p>
        {got && got.result !== 'ok' && (
          <div className="banner error remote-inline" data-testid="remote-log-error">
            <Icon name="warn" />
            <span className="banner-text">没读到日志：{got.output || got.result}</span>
          </div>
        )}
        {got && got.result === 'ok' && !got.exists && (
          <p className="muted small" data-testid="remote-log-none">
            这个项目还没有轮询日志（{got.path}）。
          </p>
        )}
        {got && got.result === 'ok' && got.exists && (
          <pre className="daemon-output small" data-testid="remote-log-text">
            {got.text}
          </pre>
        )}
        <div className="row end">
          <button data-testid="remote-log-close" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function NoteBox({ id, note }: { id: string; note: Note }) {
  if (!note.text) return null;
  return (
    <pre className={`daemon-output small${note.ok ? '' : ' err'}`} data-testid="remote-note" data-for={id} data-ok={String(note.ok)}>
      {note.text}
    </pre>
  );
}

export function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <span className="daemon-command">
      <code data-testid="remote-command">{text}</code>
      <button className="ghost small" data-testid="remote-copy" onClick={async () => setCopied(await copyText(text))}>
        {copied === null ? '复制' : copied ? '已复制' : '复制失败，请手动选中'}
      </button>
    </span>
  );
}
