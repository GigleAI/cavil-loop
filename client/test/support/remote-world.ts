// A daemon on "another machine" for the 远程 daemon section (GitHub#387): the daemon's real
// remote-access service (scripts/remote-access/remote_access.py) on a loopback port, behind a
// stand-in for Tailscale's HTTPS forwarding (tests/fixtures/remote-access-front.py: terminates
// TLS with a certificate for the machine's name, stamps the caller's Tailscale address), with the
// fake `tailscale` the daemon's own tests use answering "who is this address".
//
// The back end (test mode) gets a table of what each name "resolves to" and where its stand-in
// listens, plus the suite's certificate authority — so the checks it makes are the real ones:
// the resolved address must be a Tailscale address, the certificate must be valid for the name.

import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, type DaemonWorld } from './daemon-world';

export const BOX = 'box.tailnet.ts.net';
export const CLIENT_IP = '100.64.0.7';

export interface RemoteWorld {
  dir: string;
  /** the daemon side's state folder (devices.json, pairing.json) */
  state: string;
  /** fake tailscale's state */
  ts: string;
  ca: string;
  hosts: string;
  keys: string;
  /** every request that reached the machine (one JSON per line) */
  log: string;
  callerFile: string;
  frontPort: number;
  backendPort: number;
  procs: ChildProcess[];
  env: Record<string, string>;
}

const sh = (script: string, ...args: string[]) => {
  const r = spawnSync('bash', ['-c', script, '_', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${script}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};

/** A certificate authority and a server certificate for `name` signed by it (or self-signed when `selfSigned`). */
export function makeCert(dir: string, tag: string, name: string, ca?: { cert: string; key: string }): { cert: string; key: string } {
  const key = join(dir, `${tag}.key`);
  const cert = join(dir, `${tag}.pem`);
  const ext = join(dir, `${tag}.ext`);
  writeFileSync(ext, `subjectAltName=DNS:${name}\nbasicConstraints=CA:FALSE\n`);
  if (ca) {
    sh('openssl req -newkey rsa:2048 -nodes -keyout "$1" -subj "/CN=$3" -out "$2.csr" 2>/dev/null && openssl x509 -req -in "$2.csr" -CA "$4" -CAkey "$5" -CAcreateserial -days 2 -extfile "$6" -out "$2" 2>/dev/null', key, cert, name, ca.cert, ca.key, ext);
  } else {
    sh('openssl req -x509 -newkey rsa:2048 -nodes -keyout "$1" -out "$2" -days 2 -subj "/CN=$3" -addext "subjectAltName=DNS:$3" 2>/dev/null', key, cert, name);
  }
  return { cert, key };
}

export function makeCa(dir: string): { cert: string; key: string } {
  const key = join(dir, 'ca.key');
  const cert = join(dir, 'ca.pem');
  sh('openssl req -x509 -newkey rsa:2048 -nodes -keyout "$1" -out "$2" -days 2 -subj "/CN=cavil test CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" 2>/dev/null', key, cert);
  return { cert, key };
}

function waitLine(p: ChildProcess, re: RegExp, what: string): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`${what} did not start: ${buf}`)), 15_000);
    const on = (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(re);
      if (m) {
        clearTimeout(timer);
        resolve(m);
      }
    };
    p.stdout?.on('data', on);
    p.stderr?.on('data', on);
    p.on('exit', (c) => reject(new Error(`${what} exited ${c}: ${buf}`)));
  });
}

/** A TLS front on a fresh port. `backend`: forward there; without it, an impostor that answers everything unsigned. */
export async function startFront(r: Pick<RemoteWorld, 'procs' | 'log' | 'callerFile'>, cert: { cert: string; key: string }, backend?: number): Promise<number> {
  const args = [join(REPO, 'tests/fixtures/remote-access-front.py'), '--cert', cert.cert, '--key', cert.key, '--log', r.log, ...(backend ? ['--backend', String(backend), '--caller-file', r.callerFile] : ['--impostor'])];
  const p = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  r.procs.push(p);
  return Number((await waitLine(p, /listening (\d+)/, 'the TLS front'))[1]);
}

/**
 * The remote machine: `w` is its fake HOME (daemon installed, projects connected by the caller),
 * `path` the PATH its scripts run with (from `pathFor`, made after `installFakeTailscale`).
 */
export async function remoteWorld(w: DaemonWorld, path: string, serverEnv: Record<string, string> = {}): Promise<RemoteWorld> {
  const dir = join(w.dir, 'remote');
  mkdirSync(dir, { recursive: true });
  const ts = join(w.dir, 'ts');
  const state = join(w.home, '.local/state/cavil-loop/remote-access');
  const ca = makeCa(dir);
  const good = makeCert(dir, 'box', BOX, ca);
  const r: RemoteWorld = { dir, state, ts, ca: ca.cert, hosts: join(dir, 'hosts.json'), keys: join(dir, 'keys.json'), log: join(dir, 'requests.jsonl'), callerFile: join(dir, 'caller'), frontPort: 0, backendPort: 0, procs: [], env: {} };
  writeFileSync(r.callerFile, CLIENT_IP);
  writeFileSync(r.log, '');
  addDevice(r, CLIENT_IP, 'nCLIENT', 'test-client');
  const server = spawn('python3', [join(w.skill, 'scripts/remote-access/remote_access.py'), 'serve', '--state', state, '--port', '0', '--skill', w.skill], {
    env: { HOME: w.home, PATH: path, TZ: 'UTC', FAKE_UNAME: 'Linux', FAKE_SD: w.sd, FAKE_LD: w.ld, FAKE_TS: ts, ...serverEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  r.procs.push(server);
  r.backendPort = Number((await waitLine(server, /127\.0\.0\.1:(\d+)/, 'the remote-access service'))[1]);
  r.frontPort = await startFront(r, good, r.backendPort);
  setHosts(r, { [BOX]: { resolves: [CLIENT_IP.replace(/\d+$/, '5')], connect: `127.0.0.1:${r.frontPort}` } });
  r.env = { CAVIL_CLIENT_TEST_REMOTE_HOSTS: r.hosts, CAVIL_CLIENT_TEST_REMOTE_CA: r.ca, CAVIL_CLIENT_TEST_REMOTE_KEYS: r.keys, CAVIL_CLIENT_TEST_REMOTE_NAME: 'test-client' };
  return r;
}

export function installFakeTailscale(w: DaemonWorld): void {
  sh('source "$1/tests/fixtures/remote-access-fakes.sh" && install_fake_tailscale "$2"', REPO, w.fakes);
}

/** What each name resolves to, and where its stand-in listens (re-read by the back end on every request). */
export function setHosts(r: Pick<RemoteWorld, 'hosts'>, table: Record<string, { resolves: string[]; connect: string }>): void {
  writeFileSync(r.hosts, JSON.stringify(table));
}

/** Register a Tailscale device the machine's `tailscale whois` knows. */
export function addDevice(r: Pick<RemoteWorld, 'ts'>, ip: string, id: string, name: string): void {
  mkdirSync(join(r.ts, 'whois'), { recursive: true });
  writeFileSync(join(r.ts, 'whois', `${ip}.json`), JSON.stringify({ Node: { StableID: id, ComputedName: name, Name: `${name}.tailnet.ts.net.` } }));
}

/** A pairing code, made the way a person makes one on that machine (without the enable step: the stand-ins are already up). */
export function pairCode(w: DaemonWorld, r: RemoteWorld): string {
  return execFileSync('python3', [join(w.skill, 'scripts/remote-access/remote_access.py'), 'pair-code', '--state', r.state]).toString().trim();
}

export const devices = (r: RemoteWorld): any[] => (existsSync(join(r.state, 'devices.json')) ? JSON.parse(readFileSync(join(r.state, 'devices.json'), 'utf8')) : []);

/** Every request that reached a stand-in so far. */
export const arrived = (r: Pick<RemoteWorld, 'log'>): any[] =>
  readFileSync(r.log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

export async function closeRemote(r: RemoteWorld): Promise<void> {
  for (const p of r.procs.splice(0)) {
    if (p.exitCode === null) {
      const gone = new Promise((res) => p.once('exit', res));
      p.kill();
      await gone;
    }
  }
}
