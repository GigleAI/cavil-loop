// Updating the app itself (GitHub#184): the real decisions (cavil_core::update, Rust) in the
// test harness — which release, when, one round at a time, timeouts, a stalled download, what a
// failure shows. Real HTTP to a loopback release server; the clock is the test's (moved by hand),
// so "every 6 hours" and "60 s without data" are checked at their real values.
//
// What is a stand-in here: the package's signature check (sha256 instead of minisign) and the
// install (a file instead of swapping the app). Those are Tauri's updater plugin, run for real on
// the CI Macs (scripts/mac-update-check.sh).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { tempDir } from './helpers';

const REPO = 'GigleAI/cavil-loop';
const TARGET = 'darwin-aarch64';
const HOUR = 3600_000;

// ---- the test's clock ------------------------------------------------------------------

class FakeClock {
  t = 1_800_000_000_000;
  private sleepers: { due: number; done: () => void }[] = [];
  now = () => this.t;
  sleep = (ms: number) => new Promise<void>((done) => this.sleepers.push({ due: this.t + ms, done }));
  /** move time forward, waking every sleeper on the way (each one may start the next sleep) */
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      await settle();
      const due = this.sleepers.filter((s) => s.due <= end).sort((a, b) => a.due - b.due)[0];
      if (!due) break;
      this.t = Math.max(this.t, due.due);
      const wake = this.sleepers.filter((s) => s.due <= this.t);
      this.sleepers = this.sleepers.filter((s) => s.due > this.t);
      for (const s of wake) s.done();
    }
    this.t = end;
    await settle();
  }
}

/** let the back end answer what it was sent (it is another process) */
const settle = () => new Promise((r) => setTimeout(r, 30));

// ---- a release server ------------------------------------------------------------------

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface Rel {
  tag: string;
  draft?: boolean;
  prerelease?: boolean;
  /** asset names (latest.json gets its download URL under the server's web base) */
  assets?: string[];
}

class ReleaseServer {
  server!: Server;
  base = '';
  pages: Rel[][] = [[]];
  failPage: number | null = null;
  holdReleases = false;
  manifest: any = null;
  pkg = Buffer.alloc(0);
  /** how the package is served */
  pkgMode: 'whole' | 'stall' | 'cut' | 'drip' = 'whole';
  dripRes: ServerResponse | null = null;
  log: { path: string; auth: string | undefined }[] = [];
  private sockets = new Set<Socket>();

  get api() {
    return `${this.base}/api`;
  }
  get web() {
    return `${this.base}/web`;
  }
  dl(tag: string, name: string) {
    return `${this.web}/${REPO}/releases/download/${tag}/${name}`;
  }
  rel(r: Rel) {
    return {
      tag_name: r.tag,
      draft: r.draft ?? false,
      prerelease: r.prerelease ?? false,
      assets: (r.assets ?? ['latest.json']).map((name) => ({ name, browser_download_url: this.dl(r.tag, name) })),
    };
  }
  /** one client release `v` with a manifest and a package (sha256 "signature") */
  publish(v: string, pkg = Buffer.from(`package ${v} `.repeat(4000))) {
    this.pages = [[{ tag: `client/v${v}` }, { tag: 'release/v2026.11.01.1', assets: ['x.tar.gz'] }]];
    this.pkg = pkg;
    this.manifest = { version: v, notes: 'n', platforms: { [TARGET]: { url: this.dl(`client/v${v}`, 'app.tar.gz'), signature: sha(pkg) } } };
  }
  releaseRequests() {
    return this.log.filter((l) => l.path.startsWith(`/api/repos/${REPO}/releases`));
  }

  async start() {
    this.server = createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server.close(r));
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', this.base);
    this.log.push({ path: url.pathname + url.search, auth: req.headers.authorization });
    if (url.pathname === `/api/repos/${REPO}/releases`) {
      if (this.holdReleases) return; // never answers
      const page = Number(url.searchParams.get('page') ?? '1');
      if (this.failPage === page) return void res.writeHead(502).end('bad gateway');
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify((this.pages[page - 1] ?? []).map((r) => this.rel(r))));
    }
    if (url.pathname.endsWith('/latest.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify(this.manifest));
    }
    if (url.pathname.endsWith('/app.tar.gz')) {
      res.writeHead(200, { 'content-length': String(this.pkg.length) });
      const half = this.pkg.subarray(0, 4096);
      if (this.pkgMode === 'whole') return void res.end(this.pkg);
      if (this.pkgMode === 'cut') {
        res.write(half);
        return void setTimeout(() => res.socket?.destroy(), 50);
      }
      res.write(half);
      if (this.pkgMode === 'drip') this.dripRes = res;
      return; // stall / drip: the test decides
    }
    res.writeHead(404).end();
  }
}

// ---- the harness ------------------------------------------------------------------------

let srv: ReleaseServer;
let clock: FakeClock;
let dir: string;
const open: HarnessBackend[] = [];

beforeEach(async () => {
  srv = new ReleaseServer();
  await srv.start();
  clock = new FakeClock();
  dir = tempDir();
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((b) => b.close()));
  await srv.close();
});

function harness() {
  const b = new HarnessBackend({
    db: join(dir, 'cache.sqlite'),
    endpoints: { api: srv.api, web: srv.web },
    credentials: new FileStore(join(dir, 'cred')),
    now: clock.now,
    sleep: clock.sleep,
  });
  open.push(b);
  return b;
}

async function start(b: HarnessBackend, extra: Record<string, unknown> = {}) {
  return b.call('test.update.start', { current: '0.5.0', target: TARGET, dir: join(dir, 'app'), ...extra });
}
const installed = () => join(dir, 'app', 'installed.bin');

async function pick(pages: unknown[], current = '0.5.0', web = 'https://github.com') {
  return (await harness().call('test.update.pick', { pages, current, web })) as { pick?: any; error?: string };
}

const gh = (tag: string, o: { draft?: boolean; prerelease?: boolean; manifest?: string | null } = {}) => ({
  tag_name: tag,
  draft: o.draft ?? false,
  prerelease: o.prerelease ?? false,
  assets: o.manifest === null ? [] : [{ name: 'latest.json', browser_download_url: o.manifest ?? `https://github.com/${REPO}/releases/download/${tag}/latest.json` }],
});

describe('which release is the new one (GitHub#184)', () => {
  it('only the client\'s own, published, newer releases count; the highest version wins, not the newest entry', async () => {
    const r = await pick([
      [
        gh('release/v2026.11.01.1'), // the daemon's weekly release
        gh('client/v9.0.0', { draft: true }),
        gh('client/v8.0.0', { prerelease: true }),
        gh('client/v0.6.0'),
        gh('client/v0.5'), // not X.Y.Z
        gh('client/v1.0.0-beta'),
        gh('client/v01.0.0'),
        gh('v7.0.0'),
      ],
      [gh('client/v0.7.1'), gh('client/v0.5.0'), gh('client/v0.4.9')],
    ]);
    expect(r).toEqual({ pick: { version: '0.7.1', tag: 'client/v0.7.1', manifest: `https://github.com/${REPO}/releases/download/client/v0.7.1/latest.json` } });
  });

  it('nothing newer: none (equal and older versions, drafts, pre-releases, the daemon\'s releases)', async () => {
    expect(await pick([[gh('client/v0.5.0'), gh('client/v0.4.0'), gh('client/v0.9.0', { draft: true }), gh('client/v0.8.0', { prerelease: true }), gh('release/v2026.11.01.1')]])).toEqual({ pick: null });
  });

  it('the newest release without an update manifest cannot be updated to: an error, not an older pick', async () => {
    const r = await pick([[gh('client/v0.6.0'), gh('client/v0.7.0', { manifest: null })]]);
    expect(r.error).toMatch(/0\.7\.0.*latest\.json/);
  });

  it('a manifest outside this repository\'s release downloads is refused', async () => {
    for (const bad of [
      'https://example.com/GigleAI/cavil-loop/releases/download/client/v0.6.0/latest.json',
      'https://github.com/other/repo/releases/download/client/v0.6.0/latest.json',
      'https://github.com.evil.io/GigleAI/cavil-loop/releases/download/client/v0.6.0/latest.json',
      'http://github.com/GigleAI/cavil-loop/releases/download/client/v0.6.0/latest.json',
    ]) {
      const r = await pick([[gh('client/v0.6.0', { manifest: bad })]]);
      expect(r.error, bad).toMatch(/不在本仓库的下载地址下/);
    }
  });

  it('an answer that is not a list is an error', async () => {
    expect((await pick([{ message: 'Not Found' }])).error).toMatch(/看不懂/);
  });
});

describe('one round: check, download, install (GitHub#184)', () => {
  it('finds the new version, downloads it, puts it in place, and says to restart', async () => {
    srv.publish('0.5.1');
    const b = harness();
    await start(b);
    const st = await b.call('test.update.check');
    expect(st).toMatchObject({ phase: 'ready', version: '0.5.1', current: '0.5.0', last: { ok: true, message: '新版 0.5.1 已下载，重启后生效' } });
    expect(readFileSync(installed()).equals(srv.pkg)).toBe(true);
    const phases = b.updates.map((s) => s.phase);
    expect(phases).toContain('checking');
    expect(b.updates.some((s) => s.phase === 'downloading' && s.version === '0.5.1' && s.got > 0 && s.total === srv.pkg.length)).toBe(true);
    // no credential goes along: the release list is read without a token
    expect(srv.releaseRequests().length).toBe(1);
    expect(srv.log.every((l) => l.auth === undefined)).toBe(true);
  });

  it('nothing newer: "up to date"', async () => {
    srv.publish('0.5.0');
    const b = harness();
    await start(b);
    expect(await b.call('test.update.check')).toMatchObject({ phase: 'idle', last: { ok: true, message: '已是最新' } });
    expect(existsSync(installed())).toBe(false);
  });

  it('the release list cannot be read: a failure, never "up to date"', async () => {
    srv.publish('0.5.1');
    srv.failPage = 1;
    const b = harness();
    await start(b);
    expect(await b.call('test.update.check')).toMatchObject({ phase: 'idle', last: { ok: false, message: '检查失败：GitHub 返回 HTTP 502' } });
  });

  it('a later page that fails fails the whole read', async () => {
    srv.publish('0.5.1');
    srv.pages = [Array.from({ length: 100 }, (_, i) => ({ tag: `release/v2026.01.${i}.1`, assets: [] })), [{ tag: 'client/v0.5.1' }]];
    srv.failPage = 2;
    const b = harness();
    await start(b);
    expect(await b.call('test.update.check')).toMatchObject({ last: { ok: false, message: '检查失败：GitHub 返回 HTTP 502' } });
    srv.failPage = null;
    expect(await b.call('test.update.check')).toMatchObject({ phase: 'ready', version: '0.5.1' });
  });

  it('a list that goes past 10 pages was not read to its end: a failure, never "up to date"', async () => {
    srv.publish('0.5.1');
    const daemon = (p: number) => Array.from({ length: 100 }, (_, i) => ({ tag: `release/v2026.${p}.${i}.1`, assets: [] }));
    srv.pages = [...Array.from({ length: 10 }, (_, p) => daemon(p)), [{ tag: 'client/v0.5.1' }]];
    const b = harness();
    await start(b);
    expect(await b.call('test.update.check')).toMatchObject({ phase: 'idle', last: { ok: false, message: '检查失败：发版列表超过 10 页，没读完' } });
    expect(srv.releaseRequests().map((l) => new URL(l.path, srv.base).searchParams.get('page'))).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  });

  it('a full page followed by an empty one: read to its end (both pages), the newer version found', async () => {
    srv.publish('0.5.1');
    srv.pages = [[{ tag: 'client/v0.5.1' }, ...Array.from({ length: 99 }, (_, i) => ({ tag: `release/v2026.01.${i}.1`, assets: [] }))], []];
    const b = harness();
    await start(b);
    expect(await b.call('test.update.check')).toMatchObject({ phase: 'ready', version: '0.5.1' });
    expect(srv.releaseRequests().length).toBe(2);
  });

  it('GitHub does not answer within 30 s: a failure', async () => {
    srv.publish('0.5.1');
    srv.holdReleases = true;
    const b = harness();
    await start(b);
    const round = b.call('test.update.check');
    await clock.advance(29_000);
    expect(((await b.call('test.update.status')) as any).phase).toBe('checking');
    await clock.advance(1_000);
    expect(await round).toMatchObject({ phase: 'idle', last: { ok: false, message: '检查失败：GitHub 没有回应' } });
  });

  it('a download that gets nothing for 60 s is given up; the next round downloads it again', async () => {
    srv.publish('0.5.1');
    srv.pkgMode = 'stall';
    const b = harness();
    await start(b);
    const round = b.call('test.update.check');
    await expect.poll(() => b.updates.some((s) => s.phase === 'downloading' && s.got > 0)).toBe(true);
    await clock.advance(59_000);
    expect(((await b.call('test.update.status')) as any).phase).toBe('downloading');
    await clock.advance(2_000);
    expect(await round).toMatchObject({ phase: 'idle', last: { ok: false, message: '下载 0.5.1 失败：60 秒没有收到数据' } });
    expect(existsSync(installed())).toBe(false);
    srv.pkgMode = 'whole';
    expect(await b.call('test.update.check')).toMatchObject({ phase: 'ready', version: '0.5.1' });
  });

  it('a slow download that keeps receiving data is not given up, however long it takes', async () => {
    srv.publish('0.5.1', Buffer.from('x'.repeat(4096 * 4)));
    srv.pkgMode = 'drip';
    const b = harness();
    await start(b);
    const round = b.call('test.update.check');
    await expect.poll(() => srv.dripRes !== null).toBe(true);
    for (let i = 1; i < 4; i++) {
      await clock.advance(50_000);
      srv.dripRes!.write(srv.pkg.subarray(4096 * i, 4096 * (i + 1)));
      await expect.poll(() => b.updates.some((s) => s.phase === 'downloading' && s.got === 4096 * (i + 1))).toBe(true);
    }
    srv.dripRes!.end();
    expect(await round).toMatchObject({ phase: 'ready', version: '0.5.1' });
  });

  it('the connection breaks mid-download: a failure, nothing installed', async () => {
    srv.publish('0.5.1');
    srv.pkgMode = 'cut';
    const b = harness();
    await start(b);
    const st: any = await b.call('test.update.check');
    expect(st).toMatchObject({ phase: 'idle', last: { ok: false } });
    expect(st.last.message).toMatch(/^下载 0\.5\.1 失败：网络中断/);
    expect(existsSync(installed())).toBe(false);
  });

  it('a package whose signature does not match is never installed', async () => {
    srv.publish('0.5.1');
    srv.manifest.platforms[TARGET].signature = sha(Buffer.from('another package'));
    const b = harness();
    await start(b);
    expect(await b.call('test.update.check')).toMatchObject({ phase: 'idle', last: { ok: false, message: '新版 0.5.1 签名校验失败，没有安装' } });
    expect(existsSync(installed())).toBe(false);
  });

  it('putting the new version in place fails: says so, stays on the old one', async () => {
    srv.publish('0.5.1');
    const b = harness();
    await start(b);
    await b.call('test.update.failInstall', { on: true });
    expect(await b.call('test.update.check')).toMatchObject({ phase: 'idle', last: { ok: false, message: '安装 0.5.1 失败：没有权限写入（测试要求失败）' } });
  });

  it('a manifest without a package for this machine is a failure', async () => {
    srv.publish('0.5.1');
    srv.manifest.platforms = { 'darwin-x86_64': srv.manifest.platforms[TARGET] };
    const b = harness();
    await start(b);
    const st: any = await b.call('test.update.check');
    expect(st.last).toMatchObject({ ok: false });
    expect(st.last.message).toMatch(/^检查失败：更新说明文件里没有这台机器/);
  });
});

describe('when it looks (GitHub#184)', () => {
  it('one round at a time: a second request while one runs starts nothing; once the new version is in place, no more rounds', async () => {
    srv.publish('0.5.1');
    srv.holdReleases = true;
    const b = harness();
    await start(b);
    const first = b.call('test.update.check');
    await expect.poll(() => srv.releaseRequests().length).toBe(1);
    await b.call('test.update.check'); // returns at once: one is running
    await settle();
    expect(srv.releaseRequests().length).toBe(1);
    srv.holdReleases = false;
    await clock.advance(30_000); // the held one times out
    await first;
    expect(await b.call('test.update.check')).toMatchObject({ phase: 'ready' });
    const n = srv.releaseRequests().length;
    expect(await b.call('test.update.check')).toMatchObject({ phase: 'ready', version: '0.5.1' });
    expect(srv.releaseRequests().length).toBe(n);
  });

  it('at start, then every 6 hours; turned off: neither; a manual check still runs; the switch outlives a restart', async () => {
    srv.publish('0.5.0'); // nothing newer, so every round goes back to idle
    const b = harness();
    await start(b, { run: true });
    await expect.poll(() => srv.releaseRequests().length).toBe(1);
    await clock.advance(6 * HOUR - 1);
    expect(srv.releaseRequests().length).toBe(1);
    await clock.advance(1);
    await expect.poll(() => srv.releaseRequests().length).toBe(2);
    await b.call('test.update.setAuto', { on: false });
    await clock.advance(13 * HOUR);
    expect(srv.releaseRequests().length).toBe(2);
    await b.call('test.update.check');
    expect(srv.releaseRequests().length).toBe(3);
    await b.close();
    open.splice(0);
    const again = harness();
    expect(await start(again, { run: true })).toMatchObject({ auto: false });
    await clock.advance(7 * HOUR);
    expect(srv.releaseRequests().length).toBe(3);
  });

  it('a closed "ready" banner stays closed for that version after a restart', async () => {
    const b = harness();
    await start(b);
    expect(await b.call('test.update.dismiss', { version: '0.5.1' })).toMatchObject({ dismissed: '0.5.1' });
    await b.close();
    open.splice(0);
    expect(await start(harness())).toMatchObject({ dismissed: '0.5.1', auto: true });
  });

  it('an app that cannot update itself (no update key) never looks, and says why', async () => {
    srv.publish('0.5.1');
    const b = harness();
    await start(b, { run: true, problem: '这一版没有带更新用的公钥' });
    await clock.advance(7 * HOUR);
    expect(await b.call('test.update.check')).toMatchObject({ phase: 'idle', problem: '这一版没有带更新用的公钥', last: null });
    expect(srv.releaseRequests().length).toBe(0);
  });
});
