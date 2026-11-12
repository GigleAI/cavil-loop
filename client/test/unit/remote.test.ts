// "远程 daemon" (GitHub#387): the real back end (Rust, child process) against the daemon's real
// remote-access service, behind a stand-in for Tailscale's HTTPS forwarding
// (test/support/remote-world.ts). Every case reads the result back from both machines — the
// requests that actually arrived, the paired-device list, the scheduler — not from the back
// end's word. A case that says "nothing was sent" sits next to one where the same thing is sent.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { MemoryStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { connect, daemonEnv, daemonWorld, installByHand, pathFor, type DaemonWorld } from '../support/daemon-world';
import { BOX, CLIENT_IP, addDevice, arrived, closeRemote, devices, installFakeTailscale, makeCert, pairCode, remoteWorld, setHosts, startFront, type RemoteWorld } from '../support/remote-world';
import { FAKE_TOKEN, tempDir } from './helpers';

const ID = `${BOX}:47387`;
const open: HarnessBackend[] = [];
let w: DaemonWorld;
let r: RemoteWorld;
let path: string;

async function world(serverEnv: Record<string, string> = {}) {
  w = daemonWorld(tempDir());
  installFakeTailscale(w);
  installByHand(w);
  path = pathFor(w);
  connect(w, 'widget', 'Linux', path);
  r = await remoteWorld(w, path, serverEnv);
}

beforeEach(async () => {
  await world();
}, 60_000);
afterEach(async () => {
  await Promise.all(open.splice(0).map((b) => b.close()));
  await closeRemote(r);
});

/** `local`: the same back end also sees the machine as its own (for comparing the two ways in) */
function backend(o: { local?: Record<string, string> | true; credentials?: MemoryStore } = {}) {
  const b = new HarnessBackend({
    db: join(w.dir, `cache-${open.length}.sqlite`),
    endpoints: { api: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
    credentials: o.credentials ?? new MemoryStore(),
    env: { ...(o.local ? daemonEnv(w, { os: 'Linux', path, extra: o.local === true ? undefined : o.local }) : {}), ...r.env },
  });
  open.push(b);
  return b;
}

const pair = (b: HarnessBackend, host = BOX) => b.call('remotePair', { host, code: pairCode(w, r) });
const list = async (b: HarnessBackend) => (await b.call('remoteList')).remotes as any[];
const keys = () => (existsSync(r.keys) ? JSON.parse(readFileSync(r.keys, 'utf8')) : {});
const sdCalls = (re: RegExp) => (existsSync(join(w.sd, 'calls')) ? readFileSync(join(w.sd, 'calls'), 'utf8').split('\n').filter((l) => re.test(l)) : []);
const timer = 'cavil-loop-poll@widget.timer';
const active = () => readFileSync(join(w.sd, `${timer}.active`), 'utf8').trim();
const offTailscale = () => setHosts(r, {});
const onTailscale = () => setHosts(r, { [BOX]: { resolves: ['100.64.0.5'], connect: `127.0.0.1:${r.frontPort}` } });

describe('pairing', () => {
  it('pairs: the code goes out once, the key is kept here and recorded there, and never shown to the window', async () => {
    const b = backend();
    const got = await pair(b);
    expect(got).toEqual({ result: 'paired', id: ID });
    const l = await list(b);
    expect(l).toMatchObject([{ id: ID, host: BOX, port: 47387, state: 'paired', last: null }]);
    const there = devices(r);
    expect(there).toHaveLength(1);
    expect(there[0]).toMatchObject({ name: 'test-client', node: 'nCLIENT', id: l[0].device });
    expect(keys()[ID]).toBe(there[0].key);
    expect(arrived(r).map((q) => `${q.method} ${q.path}`)).toEqual(['POST /v1/pair']);
    // the window gets the list, not the key: nothing that crossed to it holds the key
    expect(JSON.stringify(b.received)).not.toContain(there[0].key);
  });

  it('only a full Tailscale name is a remote machine: an address or another domain is refused with nothing sent', async () => {
    const b = backend();
    for (const host of ['100.64.0.5', '100.64.0.5:47387', 'box', 'box.tailnet.example.com', `${BOX}.evil.example`]) {
      const got = await b.call('remotePair', { host, code: pairCode(w, r) });
      expect(got, host).toMatchObject({ result: 'refused', reason: 'bad_host' });
    }
    expect(arrived(r)).toEqual([]);
    expect(await list(b)).toEqual([]);
    // the same code, to the real name: sent and accepted
    expect((await pair(b)).result).toBe('paired');
  });

  it('Tailscale not running, or the name leading off Tailscale: refused before any connection, the code is not sent', async () => {
    const b = backend();
    const tables: Record<string, any>[] = [
      {}, // the name does not resolve (MagicDNS is gone with Tailscale)
      { [BOX]: { resolves: ['8.8.8.8'], connect: `127.0.0.1:${r.frontPort}` } },
      { [BOX]: { resolves: ['192.168.1.20'], connect: `127.0.0.1:${r.frontPort}` } },
      // one Tailscale address and one that is not: the connection could go to the other one
      { [BOX]: { resolves: ['100.64.0.5', '8.8.8.8'], connect: `127.0.0.1:${r.frontPort}` } },
    ];
    const code = pairCode(w, r);
    for (const t of tables) {
      setHosts(r, t);
      const got = await b.call('remotePair', { host: BOX, code });
      expect(got, JSON.stringify(t)).toMatchObject({ result: 'refused', reason: 'not_tailscale' });
      expect(got.output).toContain('没有发出任何内容');
    }
    expect(arrived(r)).toEqual([]);
    expect(devices(r)).toEqual([]);
    onTailscale();
    expect(await b.call('remotePair', { host: BOX, code })).toMatchObject({ result: 'paired' });
    expect(arrived(r)).toHaveLength(1);
  });

  it('an address in the Tailscale range that is not that machine (wrong or untrusted certificate): the handshake fails, the code is not sent', async () => {
    const b = backend();
    const code = pairCode(w, r);
    const ca = { cert: r.ca, key: join(r.dir, 'ca.key') };
    const fronts = [
      // a valid certificate, for another machine's name
      await startFront(r, makeCert(r.dir, 'other', 'other.tailnet.ts.net', ca), r.backendPort),
      // the right name, signed by nobody the client trusts
      await startFront(r, makeCert(r.dir, 'selfsigned', BOX), r.backendPort),
    ];
    for (const port of fronts) {
      setHosts(r, { [BOX]: { resolves: ['100.64.0.5'], connect: `127.0.0.1:${port}` } });
      const got = await b.call('remotePair', { host: BOX, code });
      expect(got, got.output).toMatchObject({ result: 'refused', reason: 'identity' });
      expect(got.output).toContain('没有发出任何内容');
    }
    expect(arrived(r)).toEqual([]);
    // the code was never tried on that machine
    expect(JSON.parse(readFileSync(join(r.state, 'pairing.json'), 'utf8')).tries).toBe(0);
    onTailscale();
    expect(await b.call('remotePair', { host: BOX, code })).toMatchObject({ result: 'paired' });
  });

  it('a wrong code is refused in that machine’s words; the right one still works; a paired machine is not paired twice', async () => {
    const b = backend();
    const code = pairCode(w, r);
    const wrong = String((Number(code) + 1) % 100000000).padStart(8, '0');
    const bad = await b.call('remotePair', { host: BOX, code: wrong });
    expect(bad).toMatchObject({ result: 'refused', reason: 'pairing_wrong' });
    expect(bad.output).toContain('配对码不对');
    expect(await list(b)).toEqual([]);
    expect(keys()).toEqual({});
    expect(await b.call('remotePair', { host: BOX, code: `${code.slice(0, 4)} ${code.slice(4)}` })).toMatchObject({ result: 'paired' });
    expect(await pair(b)).toMatchObject({ result: 'refused', reason: 'exists' });
    expect(devices(r)).toHaveLength(1);
    expect(await b.call('remotePair', { host: 'other.tailnet.ts.net', code: '1234' })).toMatchObject({ result: 'refused', reason: 'bad_code' });
  });

  it('the window cannot write the list of remote machines', async () => {
    const b = backend();
    await expect(b.call('setSetting', { key: 'remotes', value: [{ id: 'x' }] })).rejects.toThrow();
    expect(await list(b)).toEqual([]);
  });
});

describe('reading and acting', () => {
  it('the status is the machine’s own status script, the same object the local section gets', async () => {
    const b = backend({ local: true });
    await pair(b);
    const remote = await b.call('remoteStatus', { id: ID });
    expect(remote.state).toBe('ok');
    expect(remote.status.projects.map((p: any) => [p.key, p.scheduler.state])).toEqual([['widget', 'running']]);
    const local = await b.call('daemonStatus');
    const strip = (s: any) => ({ ...s, projects: s.projects.map((p: any) => ({ ...p, last_poll: null })) });
    expect(strip(remote.status)).toEqual(strip(local.status));
    // kept as the last status read
    expect((await list(b))[0].last.status.projects[0].key).toBe('widget');
    // the GitHub credential has no part in it
    for (const q of arrived(r)) expect(Object.keys(q.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('no request to the machine carries the GitHub credential', async () => {
    const credentials = new MemoryStore();
    await credentials.set(FAKE_TOKEN);
    const b = backend({ credentials });
    await pair(b);
    await b.call('remoteStatus', { id: ID });
    await b.call('remoteService', { id: ID, key: 'widget', action: 'stop' });
    await b.call('remoteLog', { id: ID, key: 'widget' });
    const all = readFileSync(r.log, 'utf8');
    expect(arrived(r).length).toBeGreaterThanOrEqual(4);
    expect(all).not.toContain(FAKE_TOKEN);
  });

  it('stop and start: the remote way and the local way give the same answers on the same scenarios', async () => {
    const b = backend({ local: true });
    await pair(b);
    const both = async (action: 'stop' | 'start') => {
      const before = active();
      const remote = await b.call('remoteService', { id: ID, key: 'widget', action });
      const afterRemote = active();
      writeFileSync(join(w.sd, `${timer}.active`), `${before}\n`); // back to the same starting point
      const local = await b.call('daemonService', { key: 'widget', action });
      return { remote: { result: remote.result, state: remote.state ?? null, now: afterRemote }, local: { result: local.result, state: local.state ?? null, now: active() } };
    };
    // running → start: refused by both, nothing run
    let got = await both('start');
    expect(got.remote).toEqual({ result: 'refused', state: 'running', now: 'active' });
    expect(got.local).toMatchObject({ result: 'refused', now: 'active' });
    expect(sdCalls(/^--user (start|stop) /)).toEqual([]);
    // running → stop: both stop it and read "stopped" back
    got = await both('stop');
    expect(got.remote).toEqual({ result: 'ok', state: 'stopped', now: 'inactive' });
    expect(got.local).toEqual(got.remote);
    // stopped → stop: refused by both
    got = await both('stop');
    expect(got.remote).toEqual({ result: 'refused', state: 'stopped', now: 'inactive' });
    expect(got.local).toMatchObject({ result: 'refused', now: 'inactive' });
    // stopped → start
    got = await both('start');
    expect(got.remote).toEqual({ result: 'ok', state: 'running', now: 'active' });
    expect(got.local).toEqual(got.remote);
    // a project that is not connected: neither runs anything
    const n = sdCalls(/^--user (start|stop) /).length;
    expect(n).toBe(4);
    expect((await b.call('remoteService', { id: ID, key: 'nope', action: 'stop' })).result).toBe('not_found');
    expect((await b.call('daemonService', { key: 'nope', action: 'stop' })).result).toBe('refused');
    expect(sdCalls(/^--user (start|stop) /)).toHaveLength(n);
  });

  it('a scheduler that cannot be read: neither way stops or starts, and neither says "stopped"', async () => {
    await closeRemote(r);
    await world({ FAKE_SD_MODE: 'fail' });
    const b = backend({ local: { FAKE_SD_MODE: 'fail' } });
    await pair(b);
    const st = await b.call('remoteStatus', { id: ID });
    expect(st.status.projects[0].scheduler.state).toBe('unknown');
    for (const action of ['stop', 'start']) {
      const remote = await b.call('remoteService', { id: ID, key: 'widget', action });
      const local = await b.call('daemonService', { key: 'widget', action });
      expect(remote).toMatchObject({ result: 'refused', state: 'unknown' });
      expect(local.result).toBe('refused');
    }
    expect(sdCalls(/^--user (start|stop) /)).toEqual([]);
    expect(sdCalls(/ show /).length).toBeGreaterThan(0);
  }, 60_000);

  it('the tail of the poll log comes back as that machine has it', async () => {
    const b = backend();
    await pair(b);
    const st = await b.call('remoteStatus', { id: ID });
    const dir = st.status.projects[0].state_dir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'poll.log'), Array.from({ length: 450 }, (_, i) => `[widget] line ${i + 1}`).join('\n') + '\n');
    const got = await b.call('remoteLog', { id: ID, key: 'widget' });
    expect(got).toMatchObject({ result: 'ok', exists: true, path: join(dir, 'poll.log') });
    const lines = got.text.split('\n');
    expect([lines.length, lines[0], lines.at(-1)]).toEqual([200, '[widget] line 251', '[widget] line 450']);
    expect(await b.call('remoteLog', { id: ID, key: 'nope' })).toMatchObject({ result: 'refused', reason: 'no_project' });
  });
});

describe('after pairing, when the other end is not the paired machine any more', () => {
  it('this computer leaves Tailscale: nothing is sent, the reason is shown, the last status read is kept', async () => {
    const b = backend();
    await pair(b);
    expect((await b.call('remoteStatus', { id: ID })).state).toBe('ok');
    const n = arrived(r).length;
    offTailscale();
    const st = await b.call('remoteStatus', { id: ID });
    expect(st).toMatchObject({ state: 'not_tailscale' });
    expect(st.status).toBeUndefined();
    expect(await b.call('remoteService', { id: ID, key: 'widget', action: 'stop' })).toMatchObject({ result: 'refused', reason: 'not_tailscale' });
    expect(await b.call('remoteLog', { id: ID, key: 'widget' })).toMatchObject({ result: 'refused', reason: 'not_tailscale' });
    expect(arrived(r)).toHaveLength(n);
    expect(active()).toBe('active');
    expect((await list(b))[0].last.status.projects[0].scheduler.state).toBe('running');
    onTailscale();
    expect((await b.call('remoteStatus', { id: ID })).state).toBe('ok');
    expect(arrived(r).length).toBeGreaterThan(n);
  });

  it('another device takes the name (valid certificate, no key): its answers are not believed, it never receives the key, the entry stays', async () => {
    const b = backend();
    await pair(b);
    await b.call('remoteStatus', { id: ID });
    const key = devices(r)[0].key;
    const imp = { procs: r.procs, log: join(r.dir, 'impostor.jsonl'), callerFile: r.callerFile };
    writeFileSync(imp.log, '');
    const port = await startFront(imp, { cert: join(r.dir, 'box.pem'), key: join(r.dir, 'box.key') });
    setHosts(r, { [BOX]: { resolves: ['100.64.0.5'], connect: `127.0.0.1:${port}` } });
    const st = await b.call('remoteStatus', { id: ID });
    expect(st).toMatchObject({ state: 'mismatch' });
    expect(st.status).toBeUndefined();
    // the impostor's "no projects" did not replace what the real machine said
    expect((await list(b))[0].last.status.projects.map((p: any) => p.key)).toEqual(['widget']);
    expect((await b.call('remoteService', { id: ID, key: 'widget', action: 'stop' })).result).toBe('refused');
    // its unsigned "revoked" does not count as a revocation
    expect(await b.call('remoteUnpair', { id: ID, localOnly: false })).toMatchObject({ result: 'unconfirmed' });
    expect((await list(b))[0].state).toBe('paired');
    expect(keys()[ID]).toBe(key);
    const seen = readFileSync(imp.log, 'utf8');
    expect(arrived(imp).length).toBeGreaterThanOrEqual(3);
    expect(seen).not.toContain(key);
    expect(devices(r)).toHaveLength(1);
  });

  it('the key used from another Tailscale device, and a pairing revoked on the machine: both refused, shown as such', async () => {
    const b = backend();
    await pair(b);
    addDevice(r, '100.64.0.9', 'nOTHER', 'other-box');
    writeFileSync(r.callerFile, '100.64.0.9');
    expect(await b.call('remoteStatus', { id: ID })).toMatchObject({ state: 'device_mismatch' });
    writeFileSync(r.callerFile, CLIENT_IP);
    expect((await b.call('remoteStatus', { id: ID })).state).toBe('ok');
    const out = spawnSync('bash', [join(w.skill, 'scripts/remote-access.sh'), 'revoke', 'test-client'], { env: { HOME: w.home, PATH: path, FAKE_TS: r.ts, FAKE_SD: w.sd, FAKE_LD: w.ld }, encoding: 'utf8' });
    expect(out.stdout).toContain('已撤销');
    const st = await b.call('remoteStatus', { id: ID });
    expect(st).toMatchObject({ state: 'revoked' });
    expect(await b.call('remoteService', { id: ID, key: 'widget', action: 'stop' })).toMatchObject({ result: 'refused', reason: 'revoked' });
    expect(active()).toBe('active');
    // still listed (with its last status) until the person unpairs it here
    expect((await list(b))[0]).toMatchObject({ state: 'paired' });
  });
});

describe('unpairing', () => {
  it('reachable: the machine revokes first; then the key and the entry are gone here, and the old key is refused there', async () => {
    const b = backend();
    await pair(b);
    const dev = devices(r)[0];
    expect(await b.call('remoteUnpair', { id: ID, localOnly: false })).toEqual({ result: 'unpaired' });
    expect(devices(r)).toEqual([]);
    expect(await list(b)).toEqual([]);
    expect(keys()).toEqual({});
    expect(await b.call('remoteStatus', { id: ID })).toMatchObject({ state: 'no_remote' });
    // the old key, used by hand: that machine no longer knows it
    const sent = execFileSync('python3', [join(w.skill, 'tests/fixtures/remote-access-client.py'), '--port', String(r.backendPort), '--xff', CLIENT_IP, 'call', 'GET', '/v1/status', '--id', dev.id, '--key', dev.key]).toString();
    expect(JSON.parse(sent)).toMatchObject({ status: 401, body: { error: 'revoked' } });
  });

  it('unreachable: nothing changes until the person agrees; then it is "取消配对未完成" — the authorization there still stands — and is finished once the machine confirms', async () => {
    const b = backend();
    await pair(b);
    await b.call('remoteStatus', { id: ID });
    const key = keys()[ID];
    offTailscale();
    const first = await b.call('remoteUnpair', { id: ID, localOnly: false });
    expect(first).toMatchObject({ result: 'unconfirmed', reason: 'not_tailscale' });
    expect((await list(b))[0].state).toBe('paired');
    expect(keys()[ID]).toBe(key);
    const second = await b.call('remoteUnpair', { id: ID, localOnly: true });
    expect(second).toMatchObject({ result: 'pending' });
    expect((await list(b))[0].state).toBe('pending_revoke');
    // the machine was never told: this computer is still authorized there
    expect(devices(r)).toHaveLength(1);
    // the key is kept only for the revocation to come: reading and acting are over
    onTailscale();
    const n = arrived(r).length;
    expect(await b.call('remoteStatus', { id: ID })).toMatchObject({ state: 'pending_revoke' });
    expect(await b.call('remoteService', { id: ID, key: 'widget', action: 'stop' })).toMatchObject({ result: 'refused', reason: 'pending_revoke' });
    expect(await b.call('remoteLog', { id: ID, key: 'widget' })).toMatchObject({ result: 'refused', reason: 'pending_revoke' });
    expect(arrived(r)).toHaveLength(n);
    expect(active()).toBe('active');
    // the connection is back: the retry gets the machine's confirmation
    expect(await b.call('remoteUnpair', { id: ID, localOnly: false })).toEqual({ result: 'unpaired' });
    expect(devices(r)).toEqual([]);
    expect(await list(b)).toEqual([]);
    expect(keys()).toEqual({});
  });

  it('"已在那台机器上取消": only an unfinished unpairing can be dropped that way', async () => {
    const b = backend();
    await pair(b);
    expect(await b.call('remoteForget', { id: ID })).toMatchObject({ result: 'refused' });
    expect(await list(b)).toHaveLength(1);
    offTailscale();
    await b.call('remoteUnpair', { id: ID, localOnly: true });
    expect(await b.call('remoteForget', { id: ID })).toEqual({ result: 'unpaired' });
    expect(await list(b)).toEqual([]);
    expect(keys()).toEqual({});
  });
});
