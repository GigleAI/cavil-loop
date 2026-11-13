// Settings → 本机 daemon → 远程连接 (GitHub#387, "pair without a terminal"): this machine as the
// one other computers connect to. A switch that opens / closes its remote entry, a pairing code
// shown here instead of in a terminal, voiding it, the computers paired with it and revoking one.
//
// The back end runs the daemon's own scripts/remote-access.sh for every one of these — the same
// command a server without a window uses — and the switch shows only what a fresh read says
// afterwards. A read that fails is "状态未知" with the switch not offered, never "off".

import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Icon } from './Icons';
import { ConfirmDialog } from './ConfirmDialog';
import { SettingsMore } from './SettingsMore';
import { codeLeft, remoteName, spacedCode, type HostDevice, type HostResult, type HostStatus } from '../shared/remote';

type Code = { code: string; expires: number; host: string | null };

export function RemoteHostBlock() {
  const [st, setSt] = useState<HostStatus | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [code, setCode] = useState<Code | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [devices, setDevices] = useState(false);
  const alive = useRef(true);

  const read = async () => {
    setReading(true);
    let r: HostStatus;
    try {
      r = await api().remoteHost('status');
    } catch (e) {
      r = { state: 'unknown', output: (e as Error).message };
    }
    if (!alive.current) return;
    setSt(r);
    setReading(false);
  };
  useEffect(() => {
    alive.current = true;
    void read();
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [code]);

  const act = async (what: 'enable' | 'disable' | 'code' | 'cancel') => {
    setBusy(what);
    setNote(null);
    let r: HostResult;
    try {
      r = await api().remoteHost(what);
    } catch (e) {
      r = { result: 'refused', output: (e as Error).message };
    }
    if (!alive.current) return;
    setBusy(null);
    if (r.status) setSt(r.status);
    if (what === 'code') {
      if (r.result === 'code' && r.code && r.expires) {
        setNow(Date.now() / 1000);
        setCode({ code: r.code, expires: r.expires, host: r.host ?? null });
      } else setNote({ ok: false, text: r.output || r.result });
      return;
    }
    if (what === 'cancel') {
      if (r.result === 'cancelled') {
        setCode(null);
        setNote({ ok: true, text: '配对码已作废。' });
      } else setNote({ ok: false, text: r.output || r.result });
      return;
    }
    // enable / disable: a code made before is void once the entry closes; the read-back decides the rest
    if (what === 'disable') setCode(null);
    const want = what === 'enable' ? 'enabled' : 'disabled';
    if (r.result === want) setNote(null);
    else setNote({ ok: false, text: r.output || r.result });
  };

  if (st === null) return <p className="muted small" data-testid="local-remote" data-state="reading">远程连接：正在读取…</p>;
  if (st.state === 'missing')
    return (
      <p className="muted small" data-testid="local-remote" data-state="missing">
        远程连接：{st.output}
      </p>
    );

  const on = st.state === 'open';
  const left = code ? codeLeft(code.expires, now) : null;
  const name = st.host ? remoteName(st.host) : '这台机器';
  return (
    <div className="remote-host-block" data-testid="local-remote" data-state={st.state}>
      <div className="remote-switch-row">
        <button
          className="remote-switch"
          role="switch"
          aria-checked={on}
          aria-label="允许其他电脑远程连接"
          data-testid="local-remote-switch"
          disabled={!!busy || reading || st.state === 'unknown' || st.state === 'partial'}
          onClick={() => void act(on ? 'disable' : 'enable')}
        />
        <b>允许其他电脑远程连接</b>
        <span className="muted small" data-testid="local-remote-summary">
          {busy === 'enable'
            ? '正在打开…'
            : busy === 'disable'
              ? '正在关闭…'
              : st.state === 'unknown'
                ? '状态未知（读不到），没有提供开关'
                : st.state === 'partial'
                  ? '只开了一半'
                  : on
                    ? `只经 Tailscale${st.host ? `，地址 ${st.host}` : ''} · 已配对 ${st.devices ?? '?'} 台`
                    : `关着 · 已配对 ${st.devices ?? '?'} 台（重新打开后还能连）`}
        </span>
        <span className="remote-spacer" />
        <button className="ghost" data-testid="local-remote-reread" disabled={reading || !!busy} onClick={() => void read()}>
          {reading ? '正在读取…' : '重新读取'}
        </button>
        <button data-testid="local-remote-devices" disabled={!!busy} onClick={() => setDevices(true)}>
          已配对的电脑…
        </button>
      </div>
      {st.state === 'unknown' && (
        <div className="banner error remote-inline" data-testid="local-remote-unknown">
          <Icon name="warn" />
          <span className="banner-text">读不到这台机器的远程连接是开是关，所以没有提供开关（不当成「关着」）。{st.output}</span>
        </div>
      )}
      {st.state === 'partial' && (
        <div className="banner warn remote-inline" data-testid="local-remote-partial">
          <Icon name="warn" />
          <span className="banner-text">
            远程连接只开了一半（上次打开或关闭没做完）。选一个把它做完：
            <button className="link" disabled={!!busy} data-testid="local-remote-finish-enable" onClick={() => void act('enable')}>
              打开
            </button>
            {' · '}
            <button className="link" disabled={!!busy} data-testid="local-remote-finish-disable" onClick={() => void act('disable')}>
              关闭
            </button>
          </span>
        </div>
      )}
      {note && (
        <div className={`banner ${note.ok ? 'info' : 'error'} remote-inline`} data-testid="local-remote-note">
          <Icon name={note.ok ? 'check' : 'warn'} />
          <span className="banner-text" style={{ whiteSpace: 'pre-wrap' }}>
            {note.text}
          </span>
        </div>
      )}
      {on && (
        <div className="remote-code-box" data-testid="local-remote-code-box">
          {code && left ? (
            <>
              <div className="small">在另一台电脑的「设置 → 远程 daemon → 添加远程 daemon」里选 <b>{name}</b>，填这个配对码：</div>
              <div className="remote-code-big" data-testid="local-remote-code">
                {spacedCode(code.code)}
              </div>
              <div className="muted small" data-testid="local-remote-code-left">
                {left}后失效 · 只能用一次 · 连续填错 5 次作废 · 再生成一个会顶替这一个
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="ghost" data-testid="local-remote-cancel" disabled={!!busy} onClick={() => void act('cancel')}>
                  作废这个码
                </button>
                <button className="ghost" data-testid="local-remote-code-again" disabled={!!busy} onClick={() => void act('code')}>
                  换一个码
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="small">{code ? '配对码已过期。' : ''}要让另一台电脑连进来，先在这里生成一个配对码，再在那台电脑上选这台机器、填码。</div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="primary" data-testid="local-remote-code-make" disabled={!!busy} onClick={() => void act('code')}>
                  {busy === 'code' ? '正在生成…' : '生成配对码'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {/* GitHub#514: the longer explanation, folded */}
      <SettingsMore title="打开、关掉远程连接会怎样" testid="local-remote-more">
        打开 = 只在本 Tailscale 网络里开一个入口，配对过的电脑能看这台机器的 daemon、停 / 启项目、看日志。关掉开关 = 关闭入口；已配对的电脑保留，重新打开后还能连。打开时如果 Tailscale 要求管理员权限，会在这里说明怎么做。
      </SettingsMore>
      {devices && <DevicesDialog onClose={() => setDevices(false)} onChanged={() => void read()} />}
    </div>
  );
}

function DevicesDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [list, setList] = useState<HostDevice[] | null>(null);
  // two separate things: why the list could not be read, and why a revoke did not happen —
  // a successful re-read after a failed revoke must not wipe the revoke's failure (PR #400 review round 8)
  const [err, setErr] = useState<string | null>(null);
  const [opErr, setOpErr] = useState<string | null>(null);
  const [ask, setAsk] = useState<HostDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const load = async () => {
    setErr(null);
    let r: HostResult;
    try {
      r = await api().remoteHost('devices');
    } catch (e) {
      r = { result: 'unreadable', output: (e as Error).message };
    }
    if (!alive.current) return;
    if (r.result === 'ok' && r.devices) setList(r.devices);
    else {
      setList(null);
      setErr(r.output || r.result);
    }
  };
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, []);
  const revoke = async (d: HostDevice) => {
    setBusy(true);
    setOpErr(null);
    let r: HostResult;
    try {
      r = await api().remoteHost('revoke', d.id);
    } catch (e) {
      r = { result: 'failed', output: (e as Error).message };
    }
    if (!alive.current) return;
    setBusy(false);
    setAsk(null);
    if (r.result === 'not_found') setOpErr(`没有撤销 ${d.name}：这台机器上已经没有它的记录（可能刚被别处撤销）。${r.output ?? ''}`);
    else if (r.result !== 'ok') setOpErr(`没有确认撤销 ${d.name}，它的授权可能还在，下面的列表是重新读到的：${r.output || r.result}`);
    await load();
    onChanged();
  };
  if (ask)
    return (
      <ConfirmDialog title={`撤销 ${ask.name}？`} confirmLabel={busy ? '正在撤销…' : '撤销'} danger busy={busy} onConfirm={() => void revoke(ask)} onCancel={() => setAsk(null)}>
        <p className="small" data-testid="local-remote-revoke-text">
          撤销后 {ask.name} 的钥匙立刻失效，它再也读不到、也操作不了这台机器；要再连，得重新配对。
        </p>
      </ConfirmDialog>
    );
  return (
    <ConfirmDialog title="已配对的电脑" confirmLabel="关闭" onConfirm={onClose} onCancel={onClose}>
      <div data-testid="local-remote-devices-dialog">
        {opErr && (
          <div className="banner error remote-inline" data-testid="local-remote-revoke-error">
            <Icon name="warn" />
            <span className="banner-text" style={{ whiteSpace: 'pre-wrap' }}>
              {opErr}
            </span>
          </div>
        )}
        {err && (
          <div className="banner error remote-inline" data-testid="local-remote-devices-error">
            <Icon name="warn" />
            <span className="banner-text">读不到已配对的电脑（不是「没有」）：{err}</span>
          </div>
        )}
        {list === null && !err && <p className="muted small">正在读取…</p>}
        {list && list.length === 0 && <p className="muted small" data-testid="local-remote-devices-none">还没有配对过的电脑。</p>}
        {list && list.length > 0 && (
          <table className="daemon-projects">
            <thead>
              <tr>
                <th>电脑</th>
                <th>Tailscale 设备</th>
                <th>配对时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.id} data-testid="local-remote-device" data-id={d.id}>
                  <td>
                    <b>{d.name}</b>
                  </td>
                  <td className="small">{d.node}</td>
                  <td className="small nowrap">{d.paired}</td>
                  <td className="daemon-actions">
                    <button data-testid="local-remote-revoke" onClick={() => setAsk(d)}>
                      撤销…
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </ConfirmDialog>
  );
}
