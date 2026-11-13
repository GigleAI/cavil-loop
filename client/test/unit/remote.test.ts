// "远程 daemon" (GitHub#387): the real back end (Rust, child process) against the daemon's real
// remote-access service, behind a stand-in for Tailscale's HTTPS forwarding
// (test/support/remote-world.ts). Every case reads the result back from both machines — the
// requests that actually arrived, the paired-device list, the scheduler — not from the back
// end's word. A case that says "nothing was sent" sits next to one where the same thing is sent.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { MemoryStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { connect, daemonEnv, daemonWorld, dropWorlds, installByHand, keepTmp, pathFor, type DaemonWorld } from '../support/daemon-world';
import { BOX, CLIENT_IP, addDevice, arrived, closeRemote, devices, installFakeTailscale, makeCert, pairCode, remoteWorld, setHosts, startFront, type RemoteWorld } from '../support/remote-world';
import { FAKE_TOKEN, tempDir } from './helpers';

const ID = `${BOX}:47387`;
const open: HarnessBackend[] = [];
let w: DaemonWorld;
let r: RemoteWorld;
let path: string;

let snapshot: string;

// The machine (daemon installed, one project connected with the real setup.sh) is the same for
// every case: build it once and put it back from a copy before each case, at the same path, so
// the absolute paths setup.sh wrote stay valid. Rebuilding it per case cost ~2 s of real scripts
// each and slowed the whole client suite down enough for a neighbouring timed test to miss its
// budget on CI (PR #400 review round 5).
beforeAll(() => {
  w = daemonWorld(tempDir());
  installFakeTailscale(w);
  installByHand(w);
  path = pathFor(w);
  connect(w, 'widget', 'Linux', path);
  snapshot = `${w.dir}.tar`;
  execFileSync('tar', ['-cf', snapshot, '-C', w.dir, '.']);
}, 60_000);
// the machine and its copy go when the file is done (GitHub#469)
afterAll(() => {
  dropWorlds();
  if (snapshot) rmSync(snapshot, { force: true });
});

/** A fresh copy of the machine, and the remote-access service on it. */
async function world(serverEnv: Record<string, string> = {}) {
  execFileSync('bash', ['-c', 'rm -rf "$1" && mkdir -p "$1" && tar -xf "$2" -C "$1"', '_', w.dir, snapshot]);
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
    const out = spawnSync('bash', [join(w.skill, 'scripts/remote-access.sh'), 'revoke', 'test-client'], { env: { ...keepTmp(), HOME: w.home, PATH: path, FAKE_TS: r.ts, FAKE_SD: w.sd, FAKE_LD: w.ld }, encoding: 'utf8' });
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

// GitHub#387 round 7 ("pair without a terminal"): picking the machine from this computer's
// Tailscale instead of copying its name, and this machine's own switch / code / paired computers
// run through the daemon's real remote-access.sh — the same command a server uses.
describe('picking a machine from this computer’s Tailscale', () => {
  const freePort = () =>
    new Promise<number>((res) => {
      const srv = createServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => res(p));
      });
    });
  const peers = (list: Record<string, unknown>) => writeFileSync(join(r.ts, 'peers.json'), JSON.stringify(list));
  const peer = (name: string, online: boolean) => ({ HostName: name, DNSName: `${name}.tailnet.ts.net.`, OS: 'linux', Online: online });

  it('lists the machines and tells open / closed / could-not-tell / offline apart, sending nothing but one unsigned hello each', async () => {
    const closed = await freePort();
    // a machine whose certificate is for another name: could not tell, never "closed"
    const wrong = await startFront(r, { cert: join(r.dir, 'box.pem'), key: join(r.dir, 'box.key') }, r.backendPort);
    setHosts(r, {
      [BOX]: { resolves: ['100.64.0.5'], connect: `127.0.0.1:${r.frontPort}` },
      'shut.tailnet.ts.net': { resolves: ['100.64.0.6'], connect: `127.0.0.1:${closed}` },
      'wrong.tailnet.ts.net': { resolves: ['100.64.0.8'], connect: `127.0.0.1:${wrong}` },
    });
    // this computer is "me" here (the stand-ins share one fake Tailscale); it is never listed
    writeFileSync(join(r.ts, 'certdomain'), 'me.tailnet.ts.net');
    peers({ a: peer('box', true), b: peer('shut', true), c: peer('wrong', true), d: peer('phone', false), e: peer('me', true) });
    const b = backend({ local: { FAKE_TS: r.ts } });
    const got = await b.call('remoteTailnet');
    expect(got.result).toBe('ok');
    const by = Object.fromEntries((got.devices as any[]).map((d) => [d.host, d.remote]));
    expect(by).toEqual({ [BOX]: 'open', 'shut.tailnet.ts.net': 'closed', 'wrong.tailnet.ts.net': 'unknown', 'phone.tailnet.ts.net': 'offline' });
    expect((got.devices as any[]).find((d) => d.host === 'wrong.tailnet.ts.net').why).toMatch(/证书/);
    // what reached the open machine: one hello, no signature, nothing about this computer
    const came = arrived(r);
    expect(came.map((q) => `${q.method} ${q.path}`)).toEqual(['GET /v1/hello']);
    expect(Object.keys(came[0].headers).filter((h) => /^x-cavil/i.test(h))).toEqual([]);
    // the list pairs the same way as a typed name
    expect(await pair(b, (got.devices as any[]).find((d) => d.remote === 'open').host)).toEqual({ result: 'paired', id: ID });
  });

  it('a device list that cannot be read is unreadable — never an empty list', async () => {
    peers({ a: peer('box', true) });
    expect(await backend({ local: { FAKE_TS: r.ts, FAKE_TS_STATUS: 'fail' } }).call('remoteTailnet')).toMatchObject({ result: 'unreadable', output: expect.stringMatching(/tailscaled/) });
    expect(await backend({ local: { FAKE_TS: r.ts, FAKE_TS_STATUS: 'garbage' } }).call('remoteTailnet')).toMatchObject({ result: 'unreadable' });
    // valid JSON that is not Tailscale's status shape, or Tailscale not running: still unreadable (PR #400 review round 7)
    for (const raw of ['{"unexpected":true}', '{"BackendState":"Running","Self":{},"Peer":{"k":{"DNSName":"a.tailnet.ts.net."}}}', '{"BackendState":"Stopped","Self":{},"Peer":null}']) {
      writeFileSync(join(r.ts, 'status.raw'), raw);
      expect(await backend({ local: { FAKE_TS: r.ts, FAKE_TS_STATUS: 'raw' } }).call('remoteTailnet'), raw).toMatchObject({ result: 'unreadable' });
    }
    // no daemon setting on this computer at all (no HOME to run from): unreadable too
    expect(await backend().call('remoteTailnet')).toMatchObject({ result: 'unreadable' });
    expect(arrived(r)).toEqual([]);
    // and the readable case next to it: no other machine is an empty list, not unreadable
    writeFileSync(join(r.ts, 'peers.json'), '');
    expect(await backend({ local: { FAKE_TS: r.ts } }).call('remoteTailnet')).toEqual({ result: 'ok', devices: [] });
  });
});

describe('this machine as the one being connected to', () => {
  const host = (b: HarnessBackend, action: string, target?: string) => b.call('remoteHost', target === undefined ? { action } : { action, target });
  const pairing = () => join(r.state, 'pairing.json');

  it('switch on, a code that pairs, void a code, the paired computers, revoke, switch off — each read back', async () => {
    const b = backend({ local: { FAKE_TS: r.ts } });
    expect(await host(b, 'status')).toMatchObject({ state: 'closed', devices: 0 });
    const on = await host(b, 'enable');
    expect(on).toMatchObject({ result: 'enabled', status: { state: 'open', host: BOX, devices: 0 } });
    expect(readFileSync(join(w.sd, 'cavil-loop-remote.service.active'), 'utf8').trim()).toBe('active');

    // the code shown is the one the machine waits for, and it pairs
    const c = await host(b, 'code');
    expect(c).toMatchObject({ result: 'code', host: BOX });
    expect(c.code).toMatch(/^\d{8}$/);
    const now = Date.now() / 1000;
    expect(c.expires).toBeGreaterThan(now + 590);
    expect(c.expires).toBeLessThan(now + 610);
    expect(JSON.parse(readFileSync(pairing(), 'utf8')).hash).toBe(createHash('sha256').update(c.code).digest('hex'));
    const other = backend();
    expect(await other.call('remotePair', { host: BOX, code: c.code })).toEqual({ result: 'paired', id: ID });

    // a voided code no longer pairs
    const c2 = await host(b, 'code');
    expect(await host(b, 'cancel')).toMatchObject({ result: 'cancelled' });
    expect(existsSync(pairing())).toBe(false);
    expect(await backend().call('remotePair', { host: BOX, code: c2.code })).toMatchObject({ result: 'refused', reason: 'pairing_closed' });

    // the paired computers, and revoking one: its key stops working at once
    const d = await host(b, 'devices');
    expect(d.result).toBe('ok');
    expect(d.devices.map((x: any) => x.name)).toEqual(['test-client']);
    expect(await host(b, 'status')).toMatchObject({ state: 'open', devices: 1 });
    expect(await host(b, 'revoke', 'not-an-id')).toMatchObject({ result: 'refused' });
    expect(devices(r)).toHaveLength(1);
    expect(await host(b, 'revoke', d.devices[0].id)).toMatchObject({ result: 'ok' });
    expect(devices(r)).toEqual([]);
    expect(await other.call('remoteStatus', { id: ID })).toMatchObject({ state: 'revoked' });
    expect(await host(b, 'revoke', d.devices[0].id)).toMatchObject({ result: 'not_found' });

    const off = await host(b, 'disable');
    expect(off).toMatchObject({ result: 'disabled', status: { state: 'closed' } });
    expect(readFileSync(join(w.sd, 'cavil-loop-remote.service.active'), 'utf8').trim()).not.toBe('active');
  });

  // A code the window cannot read: it is voided, and "已作废" is said only when the void is confirmed
  // (PR #400 review round 7). The real script makes a real waiting code; a thin wrapper in front of
  // it spoils the CODE= line and, when asked, fails the void the way the real script reports a failure.
  function spoilCode() {
    const dir = join(w.skill, 'scripts');
    execFileSync('mv', [join(dir, 'remote-access.sh'), join(dir, 'remote-access.real.sh')]);
    writeFileSync(
      join(dir, 'remote-access.sh'),
      `#!/usr/bin/env bash
echo "$*" >> "$FAKE_TS/wrapper-calls"
d="$(cd "$(dirname "$0")" && pwd)"
case "$1" in
  pair) bash "$d/remote-access.real.sh" "$@" | grep -v '^RESULT='; echo CODE=12ab; echo RESULT=code ;;
  pair-cancel) if [ "\${SPOIL_CANCEL:-}" = fail ]; then echo "删不掉"; echo RESULT=failed; exit 3; fi; exec bash "$d/remote-access.real.sh" "$@" ;;
  *) exec bash "$d/remote-access.real.sh" "$@" ;;
esac
`,
    );
  }
  const calls = () => readFileSync(join(r.ts, 'wrapper-calls'), 'utf8').trim().split('\n');

  it('a code it cannot read is voided; "已作废" only when the void is confirmed', async () => {
    spoilCode();
    const b = backend({ local: { FAKE_TS: r.ts } });
    expect(await host(b, 'enable')).toMatchObject({ result: 'enabled' });
    const got = await host(b, 'code');
    expect(got.result).toBe('failed');
    expect(got.code).toBeUndefined();
    expect(got.output).toContain('已作废');
    expect(calls().slice(-2)).toEqual(['pair', 'pair-cancel']);
    expect(existsSync(pairing())).toBe(false);
  });

  it('…and when the void fails, it says the code may still be waiting — never "已作废"', async () => {
    spoilCode();
    const b = backend({ local: { FAKE_TS: r.ts, SPOIL_CANCEL: 'fail' } });
    expect(await host(b, 'enable')).toMatchObject({ result: 'enabled' });
    const got = await host(b, 'code');
    expect(got.result).toBe('failed');
    expect(got.output).not.toContain('已作废');
    expect(got.output).toContain('没能确认把它作废（作废结果：failed）');
    expect(got.output).toContain('删不掉');
    expect(calls().slice(-2)).toEqual(['pair', 'pair-cancel']);
    // the waiting code really is still there — which is what the message says
    expect(existsSync(pairing())).toBe(true);
  });

  it('cannot read the state: unknown, never closed; a device list it cannot read is not "none"; an old daemon is "missing"', async () => {
    const b = backend({ local: { FAKE_TS: r.ts, FAKE_TS_SERVE_STATUS: 'fail' } });
    expect(await host(b, 'status')).toMatchObject({ state: 'unknown' });
    writeFileSync(join(r.state, 'devices.json'), '{not json');
    const ok = backend({ local: { FAKE_TS: r.ts } });
    expect(await host(ok, 'status')).toMatchObject({ state: 'closed', devices: null });
    expect(await host(ok, 'devices')).toMatchObject({ result: 'unreadable' });
    execFileSync('rm', ['-f', join(w.skill, 'scripts/remote-access.sh')]);
    expect(await host(ok, 'status')).toMatchObject({ state: 'missing' });
    expect(await host(ok, 'enable')).toMatchObject({ result: 'refused' });
  });
});
