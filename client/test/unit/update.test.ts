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
  /** the release page's text and when it was published (GitHub#348); left out = GitHub's fields are not there */
  body?: string;
  published_at?: string;
}

class ReleaseServer {
  server!: Server;
  base = '';
  pages: Rel[][] = [[]];
  failPage: number | null = null;
  holdReleases = false;
  manifest: any = null;
  pkg = Buffer.alloc(0);
  /** GitHub#215: several releases at once, each with its own manifest and package (by tag) */
  byTag = new Map<string, { manifest: any; pkg: Buffer }>();
  /** manifests of these tags never answer */
  holdManifest = new Set<string>();
  /** held release-list requests (answered by `releaseHeld`) */
  held: (() => void)[] = [];
  holdAndKeep = false;
  /** packages of these tags are dripped (first 4 KB, then nothing) */
  dripTags = new Set<string>();
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
      ...(r.body === undefined ? {} : { body: r.body }),
      ...(r.published_at === undefined ? {} : { published_at: r.published_at }),
    };
  }
  /** one client release `v` with a manifest and a package (sha256 "signature") */
  publish(v: string, pkg = Buffer.from(`package ${v} `.repeat(4000))) {
    this.pages = [[{ tag: `client/v${v}` }, { tag: 'release/v2026.11.01.1', assets: ['x.tar.gz'] }]];
    this.pkg = pkg;
    this.manifest = { version: v, notes: 'n', platforms: { [TARGET]: { url: this.dl(`client/v${v}`, 'app.tar.gz'), signature: sha(pkg) } } };
  }
  /** GitHub#215: these versions as releases (`-dev.N` ones as pre-releases), newest first in the list */
  publishAll(versions: string[]) {
    this.byTag.clear();
    this.pages = [[...versions.map((v) => ({ tag: `client/v${v}`, prerelease: v.includes('-') })), { tag: 'release/v2026.11.01.1', assets: ['x.tar.gz'] }]];
    for (const v of versions) {
      const tag = `client/v${v}`;
      const pkg = Buffer.from(`package ${v} `.repeat(4000));
      this.byTag.set(tag, { pkg, manifest: { version: v, notes: 'n', platforms: { [TARGET]: { url: this.dl(tag, 'app.tar.gz'), signature: sha(pkg) } } } });
    }
  }
  releaseHeld() {
    for (const go of this.held.splice(0)) go();
  }
  manifestRequests() {
    return this.log.filter((l) => l.path.endsWith('/latest.json')).map((l) => decodeURIComponent(l.path.split('/releases/download/')[1].replace(/\/latest\.json$/, '')));
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
      if (this.holdAndKeep) {
        const body = JSON.stringify((this.pages[page - 1] ?? []).map((r) => this.rel(r)));
        return void this.held.push(() => {
          if (res.destroyed) return;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(body);
        });
      }
      if (this.failPage === page) return void res.writeHead(502).end('bad gateway');
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify((this.pages[page - 1] ?? []).map((r) => this.rel(r))));
    }
    const tagged = /\/releases\/download\/(.+)\/(latest\.json|app\.tar\.gz)$/.exec(url.pathname);
    const one = tagged && this.byTag.get(decodeURIComponent(tagged[1]));
    if (one && tagged[2] === 'latest.json') {
      if (this.holdManifest.has(decodeURIComponent(tagged[1]))) return; // never answers
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify(one.manifest));
    }
    if (one) {
      res.writeHead(200, { 'content-length': String(one.pkg.length) });
      if (!this.dripTags.has(decodeURIComponent(tagged![1]))) return void res.end(one.pkg);
      return void res.write(one.pkg.subarray(0, 4096));
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

async function pick(pages: unknown[], current = '0.5.0', web = 'https://github.com', channel = 'stable') {
  return (await harness().call('test.update.pick', { pages, current, web, channel })) as { pick?: any; error?: string };
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

describe('GitHub#473: the updater words its own part in the window\'s language, the outside words as written', () => {
  it('English: the last round, the problems and the refusals; switching back re-words the same round in Chinese', async () => {
    srv.publish('0.5.1');
    const b = harness();
    await b.call('setLanguage', { lang: 'en' });
    await start(b);
    // the release list fails: all the back end's own words
    srv.failPage = 1;
    let st: any = await b.call('test.update.check');
    expect(st.last).toMatchObject({ ok: false, message: 'Check failed: GitHub answered HTTP 502', said: { template: 'Check failed: GitHub answered HTTP 502', parts: [] } });
    // putting it in place fails: the installer's words in their hole, exactly as it said them
    srv.failPage = null;
    await b.call('test.update.failInstall', { on: true });
    st = await b.call('test.update.check');
    expect(st.last).toMatchObject({
      ok: false,
      message: 'Installing 0.5.1 failed: 没有权限写入（测试要求失败）',
      said: { template: 'Installing 0.5.1 failed: {e_e}', parts: [{ name: 'e_e', text: '没有权限写入（测试要求失败）', from: 'system' }] },
    });
    // back to Chinese: the same round, worded as before
    await b.call('setLanguage', { lang: 'zh' });
    st = await b.call('test.update.status');
    expect(st.last).toMatchObject({ message: '安装 0.5.1 失败：没有权限写入（测试要求失败）', said: { template: '安装 0.5.1 失败：{e_e}' } });
  });

  it('English on a machine with no development builds: why, and the refusal; Chinese as before', async () => {
    const b = harness();
    await b.call('setLanguage', { lang: 'en' });
    const st: any = await start(b, { devSupported: false, target: 'darwin-x86_64' });
    expect(st.devUnavailable).toBe('Development builds exist for Apple silicon only; this Mac can only use Release');
    expect(await b.call('test.update.setChannel', { channel: 'dev' })).toEqual({ ok: false, error: 'Development builds exist for Apple silicon only; this Mac can only use Release' });
    await b.call('setLanguage', { lang: 'zh' });
    expect(((await b.call('test.update.status')) as any).devUnavailable).toBe('开发版只有 Apple 芯片的包，这台 Mac 只能用正式版');
  });

  it('a stalled download in English: the client\'s own words, no outside part', async () => {
    srv.publish('0.5.1');
    srv.pkgMode = 'stall';
    const b = harness();
    await b.call('setLanguage', { lang: 'en' });
    await start(b);
    const round = b.call('test.update.check');
    await expect.poll(() => b.updates.some((s) => s.phase === 'downloading' && s.got > 0)).toBe(true);
    await clock.advance(61_000);
    expect(await round).toMatchObject({ last: { ok: false, message: 'Downloading 0.5.1 failed: No data received for 60 seconds', said: { parts: [] } } });
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

// ---- two channels (GitHub#215) ------------------------------------------------------------
// Release: the tagged `client/vX.Y.Z` releases only. Development: also the `client/vX.Y.Z-dev.N`
// pre-releases CI publishes from main. Expected values below are derived from semver precedence
// (what the updater plugin compares with), not read off the implementation.

const dev = (tag: string, o: { draft?: boolean; prerelease?: boolean; manifest?: string | null } = {}) => gh(tag, { prerelease: true, ...o });
const picked = async (pages: unknown[], current: string, channel: string) => (await pick(pages, current, 'https://github.com', channel)).pick?.version ?? null;

describe('which release, per channel (GitHub#215)', () => {
  it('the release channel never takes a development build, however high', async () => {
    const list = [[dev('client/v0.9.1-dev.400'), gh('client/v0.5.1'), gh('release/v2026.11.01.1')]];
    expect(await picked(list, '0.5.0', 'stable')).toBe('0.5.1');
    expect(await picked([[dev('client/v0.9.1-dev.400')]], '0.5.0', 'stable')).toBe(null);
  });

  it('the development channel takes whichever is higher: a development build or a release', async () => {
    expect(await picked([[dev('client/v0.5.1-dev.387'), gh('client/v0.5.0')]], '0.5.0', 'dev')).toBe('0.5.1-dev.387');
    // 0.6.0 > 0.5.1-dev.N: the release wins
    expect(await picked([[dev('client/v0.5.1-dev.387'), gh('client/v0.6.0')]], '0.5.0', 'dev')).toBe('0.6.0');
    // same X.Y.Z: the release is higher than any of its development builds
    expect(await picked([[dev('client/v0.5.1-dev.999'), gh('client/v0.5.1')]], '0.5.0', 'dev')).toBe('0.5.1');
  });

  it('development builds compare by N as a number (dev.10 > dev.9), not as text', async () => {
    expect(await picked([[dev('client/v0.5.1-dev.9'), dev('client/v0.5.1-dev.10')]], '0.5.0', 'dev')).toBe('0.5.1-dev.10');
    expect(await picked([[dev('client/v0.5.1-dev.10'), dev('client/v0.5.1-dev.9')]], '0.5.0', 'dev')).toBe('0.5.1-dev.10');
  });

  it('running a development build: older or equal is nothing; a newer one, or its release, is picked — on either channel for the release', async () => {
    const cur = '0.5.1-dev.300';
    expect(await picked([[dev('client/v0.5.1-dev.299'), dev('client/v0.5.1-dev.300'), gh('client/v0.5.0')]], cur, 'dev')).toBe(null);
    expect(await picked([[dev('client/v0.5.1-dev.301')]], cur, 'dev')).toBe('0.5.1-dev.301');
    expect(await picked([[gh('client/v0.5.1')]], cur, 'dev')).toBe('0.5.1');
    // switched back to the release channel: no downgrade to 0.5.0, the next higher release is taken
    expect(await picked([[gh('client/v0.5.0'), dev('client/v0.5.1-dev.301')]], cur, 'stable')).toBe(null);
    expect(await picked([[gh('client/v0.5.1')]], cur, 'stable')).toBe('0.5.1');
  });

  it('only the exact shapes count: no other suffix, no leading zero, development builds must be marked pre-release and releases must not', async () => {
    const list = [
      [
        dev('client/v0.9.0-rc.1'),
        dev('client/v0.9.0-dev.01'),
        dev('client/v0.9.0-dev.'),
        dev('client/v0.9.0-dev'),
        dev('client/v0.9.0-dev.1.2'),
        dev('client/v0.9.0-dev.1+meta'),
        dev('client/v0.9.0-DEV.1'),
        gh('client/v0.9.0-dev.5'), // a development version not marked pre-release
        dev('client/v0.9.0'), // a release version marked pre-release
        dev('client/v0.9.0-dev.7', { draft: true }),
        dev('release/v0.9.0-dev.8'),
      ],
    ];
    expect(await picked(list, '0.5.0', 'dev')).toBe(null);
    expect(await picked(list, '0.5.0', 'stable')).toBe(null);
  });

  it('an unknown channel name is the release channel', async () => {
    expect(await picked([[dev('client/v0.5.1-dev.3')]], '0.5.0', 'nightly')).toBe(null);
  });
});

describe('choosing the channel (GitHub#215)', () => {
  it('defaults to the release channel; the choice outlives a restart; anything unreadable stored reads as the release channel', async () => {
    const b = harness();
    expect(await start(b)).toMatchObject({ channel: 'stable', devUnavailable: null });
    expect(await b.call('test.update.setChannel', { channel: 'dev' })).toEqual({ ok: true });
    expect(await b.call('test.update.status')).toMatchObject({ channel: 'dev' });
    await b.close();
    open.splice(0);
    const again = harness();
    expect(await start(again)).toMatchObject({ channel: 'dev' });
    for (const bad of ['nightly', 'DEV', 1, true, null, { channel: 'dev' }]) {
      await again.call('test.update.storeChannel', { value: bad });
      expect(await again.call('test.update.status'), JSON.stringify(bad)).toMatchObject({ channel: 'stable' });
    }
  });

  it('a machine with no development builds: says why, refuses the development channel, and treats an earlier choice as the release channel', async () => {
    srv.publishAll(['0.5.1-dev.9']);
    const b = harness();
    await start(b);
    await b.call('test.update.setChannel', { channel: 'dev' });
    await expect.poll(async () => ((await b.call('test.update.status')) as any).phase).toBe('ready');
    await b.close();
    open.splice(0);
    srv.log = [];
    const intel = harness();
    const st: any = await start(intel, { devSupported: false, target: 'darwin-x86_64' });
    expect(st).toMatchObject({ channel: 'stable', devUnavailable: '开发版只有 Apple 芯片的包，这台 Mac 只能用正式版' });
    expect(await intel.call('test.update.setChannel', { channel: 'dev' })).toEqual({ ok: false, error: '开发版只有 Apple 芯片的包，这台 Mac 只能用正式版' });
    expect(await intel.call('test.update.check')).toMatchObject({ channel: 'stable', last: { ok: true, message: '已是最新' } });
    expect(srv.manifestRequests()).toEqual([]);
  });

  it('on the development channel a round installs the development build; on the release channel the release', async () => {
    srv.publishAll(['0.5.1-dev.387', '0.5.0']);
    const b = harness();
    await start(b);
    expect(await b.call('test.update.check')).toMatchObject({ phase: 'idle', last: { ok: true, message: '已是最新' } });
    await b.call('test.update.setChannel', { channel: 'dev' });
    await expect.poll(async () => ((await b.call('test.update.status')) as any).phase).toBe('ready');
    expect(await b.call('test.update.status')).toMatchObject({ channel: 'dev', version: '0.5.1-dev.387' });
    expect(readFileSync(installed()).equals(srv.byTag.get('client/v0.5.1-dev.387')!.pkg)).toBe(true);
  });
});

describe('switching the channel mid-round (GitHub#215)', () => {
  const status = async (b: HarnessBackend) => (await b.call('test.update.status')) as any;
  const installs = async (b: HarnessBackend) => (await b.call('test.update.installs')) as string[];

  it('while reading the release list: that round is dropped, one runs on the new channel', async () => {
    srv.publishAll(['0.5.1-dev.387', '0.5.0']);
    srv.holdAndKeep = true;
    const b = harness();
    await start(b);
    void b.call('test.update.check');
    await expect.poll(() => srv.held.length).toBe(1);
    await b.call('test.update.setChannel', { channel: 'dev' });
    await expect.poll(() => srv.held.length).toBe(2);
    srv.holdAndKeep = false;
    srv.releaseHeld();
    await expect.poll(async () => (await status(b)).phase).toBe('ready');
    expect(await status(b)).toMatchObject({ channel: 'dev', version: '0.5.1-dev.387' });
    expect(await installs(b)).toEqual(['0.5.1-dev.387']);
  });

  it('while reading the update manifest: what it read is dropped, never downloaded', async () => {
    srv.publishAll(['0.5.2-dev.5', '0.5.1']);
    srv.holdManifest.add('client/v0.5.1');
    const b = harness();
    await start(b);
    void b.call('test.update.check');
    await expect.poll(() => srv.manifestRequests()).toEqual(['client/v0.5.1']);
    await b.call('test.update.setChannel', { channel: 'dev' });
    await expect.poll(async () => (await status(b)).phase).toBe('ready');
    expect(await status(b)).toMatchObject({ channel: 'dev', version: '0.5.2-dev.5' });
    expect(await installs(b)).toEqual(['0.5.2-dev.5']);
    expect(srv.log.filter((l) => l.path.endsWith('/client/v0.5.1/app.tar.gz'))).toEqual([]);
  });

  it('while downloading: the download stops, the other channel\'s build is installed, the old version never comes back on screen', async () => {
    srv.publishAll(['0.5.2-dev.5', '0.5.1']);
    srv.dripTags.add('client/v0.5.1');
    const b = harness();
    await start(b);
    void b.call('test.update.check');
    await expect.poll(() => b.updates.some((s) => s.phase === 'downloading' && s.version === '0.5.1' && s.got > 0)).toBe(true);
    await b.call('test.update.setChannel', { channel: 'dev' });
    const at = b.updates.length;
    await expect.poll(async () => (await status(b)).phase).toBe('ready');
    expect(await status(b)).toMatchObject({ channel: 'dev', version: '0.5.2-dev.5' });
    expect(await installs(b)).toEqual(['0.5.2-dev.5']);
    expect(b.updates.slice(at).filter((s) => s.version === '0.5.1')).toEqual([]);
    expect(readFileSync(installed()).equals(srv.byTag.get('client/v0.5.2-dev.5')!.pkg)).toBe(true);
  });

  it('while the new app is being put in place: switching is refused, the channel and the install stay as they were', async () => {
    srv.publishAll(['0.5.1']);
    const b = harness();
    await start(b);
    await b.call('test.update.holdInstall', { on: true });
    void b.call('test.update.check');
    await expect.poll(async () => (await status(b)).phase).toBe('installing');
    expect(await status(b)).toMatchObject({ version: '0.5.1', channel: 'stable' });
    expect(await b.call('test.update.setChannel', { channel: 'dev' })).toEqual({ ok: false, error: '正在安装 0.5.1，装好后可以切换' });
    expect(await status(b)).toMatchObject({ channel: 'stable', phase: 'installing' });
    await b.call('test.update.releaseInstall');
    await expect.poll(async () => (await status(b)).phase).toBe('ready');
    expect(await installs(b)).toEqual(['0.5.1']);
    // once it is in place, switching is allowed again; nothing more is looked for until the restart
    const n = srv.releaseRequests().length;
    expect(await b.call('test.update.setChannel', { channel: 'dev' })).toEqual({ ok: true });
    await settle();
    expect(await status(b)).toMatchObject({ channel: 'dev', phase: 'ready', version: '0.5.1' });
    expect(srv.releaseRequests().length).toBe(n);
  });

  it('back and forth mid-round: only the last choice runs, and installs once', async () => {
    srv.publishAll(['0.5.2-dev.5', '0.5.1']);
    srv.holdAndKeep = true;
    const b = harness();
    await start(b);
    void b.call('test.update.check');
    await expect.poll(() => srv.held.length).toBe(1);
    await b.call('test.update.setChannel', { channel: 'dev' });
    await expect.poll(() => srv.held.length).toBe(2);
    await b.call('test.update.setChannel', { channel: 'stable' });
    await expect.poll(() => srv.held.length).toBe(3);
    srv.holdAndKeep = false;
    srv.releaseHeld();
    await expect.poll(async () => (await status(b)).phase).toBe('ready');
    expect(await status(b)).toMatchObject({ channel: 'stable', version: '0.5.1' });
    expect(await installs(b)).toEqual(['0.5.1']);
    expect(srv.manifestRequests()).toEqual(['client/v0.5.1']);
  });

  it('choosing the channel already chosen restarts nothing', async () => {
    srv.publishAll(['0.5.1']);
    srv.holdAndKeep = true;
    const b = harness();
    await start(b);
    void b.call('test.update.check');
    await expect.poll(() => srv.held.length).toBe(1);
    await b.call('test.update.setChannel', { channel: 'stable' });
    await settle();
    expect(srv.held.length).toBe(1);
    srv.holdAndKeep = false;
    srv.releaseHeld();
    await expect.poll(async () => (await status(b)).phase).toBe('ready');
    expect(await installs(b)).toEqual(['0.5.1']);
  });
});

// ---- what the versions in between changed (GitHub#348) ---------------------------------
// The list itself is checked on GitHub's real release list in update-notes.test.ts; here: a whole
// round carries it, the restarted app still has it, and it never gets in the way of the update.

describe('what the update changes, through a whole round (GitHub#348)', () => {
  const status = async (b: HarnessBackend) => (await b.call('test.update.status')) as any;
  const page = (v: string, title: string) => `开发版 ${v}，构建自 main 的 ${'a'.repeat(40)}：${title}\n\n只有开发渠道会装它。`;
  /** these development builds (newest first) with release pages, plus the running release */
  const publish = (versions: string[], bodies = true) => {
    srv.publishAll([...versions, '0.5.0']);
    if (bodies) for (const r of srv.pages[0]) if (r.tag.includes('-dev.')) Object.assign(r, { body: page(r.tag.slice('client/v'.length), `change ${r.tag.split('.').pop()}`), published_at: '2026-11-10T01:00:00Z' });
  };
  const versions = (n: any) => n.entries.map((e: any) => [e.version, e.items.map((i: any) => i.title)]);

  it('downloading, installing and ready all show the same list; idle and checking show none; no request beyond the round\'s own', async () => {
    publish(['0.5.1-dev.9', '0.5.1-dev.7', '0.5.1-dev.3']);
    const b = harness();
    expect(await start(b)).toMatchObject({ phase: 'idle', notes: null, installed: null });
    await b.call('test.update.holdInstall', { on: true });
    await b.call('test.update.setChannel', { channel: 'dev' });
    await expect.poll(async () => (await status(b)).phase).toBe('installing');
    const want = [
      ['0.5.1-dev.9', ['change 9']],
      ['0.5.1-dev.7', ['change 7']],
      ['0.5.1-dev.3', ['change 3']],
    ];
    expect(versions((await status(b)).notes)).toEqual(want);
    await b.call('test.update.releaseInstall');
    await expect.poll(async () => (await status(b)).phase).toBe('ready');
    const ready = await status(b);
    expect(ready.notes).toMatchObject({ from: '0.5.0', to: '0.5.1-dev.9', complete: true, more: 0 });
    expect(versions(ready.notes)).toEqual(want);
    // every status sent to the window: a list only together with a version on screen, and always this one
    const seen = b.updates.filter((s) => s.notes);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => ['downloading', 'installing', 'ready'].includes(s.phase) && s.version === '0.5.1-dev.9' && s.notes.to === '0.5.1-dev.9')).toBe(true);
    expect(b.updates.filter((s) => s.phase === 'downloading').every((s) => s.notes?.entries.length === 3)).toBe(true);
    expect(b.updates.filter((s) => s.phase === 'idle' || s.phase === 'checking').every((s) => s.notes === null)).toBe(true);
    // the round's own requests only: the release list, one manifest, one package — nothing more for the list, no credential
    const other = srv.log.filter((l) => !l.path.startsWith(`/api/repos/${REPO}/releases`) && !l.path.endsWith('/latest.json') && !l.path.endsWith('/app.tar.gz'));
    expect(other).toEqual([]);
    expect(srv.manifestRequests()).toEqual(['client/v0.5.1-dev.9']);
    expect(srv.log.every((l) => l.auth === undefined)).toBe(true);
  });

  it('after the restart into the new version: the list is still there, with its notice open; closing it stays closed; another version shows nothing', async () => {
    publish(['0.5.1-dev.9', '0.5.1-dev.7']);
    const b = harness();
    await start(b);
    await b.call('test.update.setChannel', { channel: 'dev' });
    await expect.poll(async () => (await status(b)).phase).toBe('ready');
    // still the old app: nothing "installed" to show yet
    expect((await status(b)).installed).toBeNull();
    await b.close();
    open.splice(0);
    // the new app starts
    const next = harness();
    const st = (await start(next, { current: '0.5.1-dev.9' })) as any;
    expect(st).toMatchObject({ phase: 'idle', notes: null, installed: { from: '0.5.0', to: '0.5.1-dev.9', dismissed: false, complete: true } });
    expect(versions(st.installed)).toEqual([
      ['0.5.1-dev.9', ['change 9']],
      ['0.5.1-dev.7', ['change 7']],
    ]);
    // closing a notice of another version is not this one's
    expect(((await next.call('test.update.dismissInstalled', { version: '0.5.1-dev.7' })) as any).installed.dismissed).toBe(false);
    expect(((await next.call('test.update.dismissInstalled', { version: '0.5.1-dev.9' })) as any).installed.dismissed).toBe(true);
    await next.close();
    open.splice(0);
    const again = harness();
    expect(((await start(again, { current: '0.5.1-dev.9' })) as any).installed).toMatchObject({ dismissed: true, to: '0.5.1-dev.9' });
    await again.close();
    open.splice(0);
    // an app of any other version (installed by hand, an older one put back): nothing kept is its own
    expect(((await start(harness(), { current: '0.5.1-dev.7' })) as any).installed).toBeNull();
  });

  it('release pages that say nothing (no text at all, as an older GitHub answer): the update goes through all the same, the versions are listed without items', async () => {
    publish(['0.5.1-dev.9', '0.5.1-dev.7'], false);
    const b = harness();
    await start(b);
    await b.call('test.update.setChannel', { channel: 'dev' });
    await expect.poll(async () => (await status(b)).phase).toBe('ready');
    expect(readFileSync(installed()).equals(srv.byTag.get('client/v0.5.1-dev.9')!.pkg)).toBe(true);
    const n = (await status(b)).notes;
    expect(n.entries.map((e: any) => [e.version, e.items, e.at])).toEqual([
      ['0.5.1-dev.9', [], null],
      ['0.5.1-dev.7', [], null],
    ]);
  });

  it('an install that fails keeps nothing for a restart; a download on the other channel dropped by a switch leaves none of its list behind', async () => {
    publish(['0.5.1-dev.9']);
    const b = harness();
    await start(b);
    await b.call('test.update.failInstall', { on: true });
    await b.call('test.update.setChannel', { channel: 'dev' });
    await expect.poll(async () => (await status(b)).last?.ok).toBe(false);
    expect(await status(b)).toMatchObject({ phase: 'idle', notes: null });
    await b.close();
    open.splice(0);
    expect(((await start(harness(), { current: '0.5.1-dev.9' })) as any).installed).toBeNull();

    // the development build is dripping in; switching back to the release channel drops that round
    srv.dripTags.add('client/v0.5.1-dev.9');
    const c = harness();
    await start(c);
    await c.call('test.update.setChannel', { channel: 'dev' });
    await expect.poll(() => c.updates.some((s) => s.phase === 'downloading' && s.got > 0 && s.notes?.to === '0.5.1-dev.9')).toBe(true);
    const at = c.updates.length;
    await c.call('test.update.setChannel', { channel: 'stable' });
    await expect.poll(async () => (await status(c)).phase).toBe('idle');
    expect(c.updates.slice(at).every((s) => s.notes === null)).toBe(true);
    expect(await status(c)).toMatchObject({ channel: 'stable', notes: null, last: { ok: true, message: '已是最新' } });
  });

  it('kept notes that cannot be read (a hand edit, another shape, a broken entry deep inside) are nothing to show, never an error; what a real round kept is shown whole', async () => {
    const good = { from: '0.4.0', to: '0.5.0', complete: true, more: 0, entries: [{ version: '0.5.0', at: null, more: 0, items: [{ title: 't', more: null }] }] };
    const entry = (o: Record<string, unknown>) => ({ ...good, entries: [{ ...good.entries[0], ...o }] });
    const without = (o: Record<string, unknown>, k: string) => Object.fromEntries(Object.entries(o).filter(([x]) => x !== k));
    const bad: unknown[] = [
      'text',
      7,
      null,
      [],
      { to: '0.5.0' },
      { to: '0.5.0', entries: 'x' },
      { ...good, to: '0.4.0' },
      { to: '0.5.0', entries: [] },
      { ...good, from: 4 },
      { ...good, complete: 'yes' },
      { ...good, more: -1 },
      { ...good, more: '0' },
      without(good, 'more'),
      { ...good, entries: [null] },
      { ...good, entries: ['0.5.0'] },
      { ...good, entries: [good.entries[0], 3] },
      entry({ items: null }),
      entry({ items: 'x' }),
      entry({ items: [null] }),
      entry({ items: [{ title: 5, more: null }] }),
      entry({ items: [{ more: null }] }),
      entry({ items: [{ title: 't', more: 9 }] }),
      entry({ items: [{ title: 't', more: null }, 't2'] }),
      entry({ version: 1 }),
      entry({ at: 5 }),
      entry({ more: null }),
      entry({ more: 1.5 }),
    ];
    const b = harness();
    for (const value of bad) {
      await b.call('test.update.storeInstalled', { value });
      expect(((await start(b)) as any).installed, JSON.stringify(value)).toBeNull();
    }
    // the same shapes, well formed, are shown — whole
    for (const value of [good, { ...good, entries: [] }, entry({ at: '2026-11-10T01:00:00Z', more: 3, items: [{ title: 't', more: 'm' }, { title: 'u', more: null }] })]) {
      await b.call('test.update.storeInstalled', { value });
      expect(((await start(b)) as any).installed, JSON.stringify(value)).toEqual({ ...value, dismissed: false });
    }
    // what a real round keeps passes the same check (the round's test above reads it back after a restart)
    srv.publishAll(['0.5.1']);
    Object.assign(srv.pages[0][0], { body: '### 这一版（0.5）\n\n- **甲**：一\n', published_at: '2026-11-10T01:00:00Z' });
    const c = harness();
    await start(c);
    await c.call('test.update.check');
    expect((await status(c)).phase).toBe('ready');
    await c.close();
    open.splice(0);
    expect(((await start(harness(), { current: '0.5.1' })) as any).installed).toMatchObject({ to: '0.5.1', entries: [{ version: '0.5.1', items: [{ title: '甲', more: '一' }] }] });
  });
});
