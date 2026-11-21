#!/usr/bin/env node
// 公网资产目录的对外服务：只交出图片和视频，任何目录都返回 404。
//
// 用法：PUBLIC_ASSETS_ROOT=<资产目录> PUBLIC_ASSETS_PORT=<端口> [PUBLIC_ASSETS_PREFIX=/review-assets/] node serve.mjs
//
// 严格模式（GitHub#613，PUBLIC_ASSETS_STRICT=1）：只交出项目子目录下的文件（<key>/<条目编号或
// weekly-report>/<文件>，key 是本机登记过的项目），或旧图清单里路径和内容都对得上的旧图；每个文件
// 整份读进内存，在这份内存上判格式、查凭证、比清单，再从这份内存送出——检查过的就是送出去的。
// 不开严格模式时行为和之前一模一样（这是切换失败时的退回状态）。两种模式都在启动后写一份不对外的
// 状态文件（PUBLIC_ASSETS_STATUS），发布命令和切换命令靠它知道「服务端拦截有没有生效」。
//
// 只监听 127.0.0.1——公网入口（隧道 / 反向代理）转发到这个端口，不要把它直接绑到外网地址。
// 所有拒绝对外都是同一个 404、不带原因（不告诉来访者「这里有个文件但不给你」）；
// 原因写到 stderr，本机日志里查得到。放行规则在 rules.mjs，和发图前自查（check.mjs）是同一份。
import http from 'http';
import fs from 'fs';
import path from 'path';
import { judgeBuffer, judgeFile, projectPath, resolveInRoot } from './rules.mjs';
import { RULES_VERSION, codeId, loadLegacy, procStart, projectKeys, sha256 } from './strict.mjs';

const NOT_FOUND = 'Not found.\n';

export function createServer({ root, prefix = '/review-assets/', log = (m) => console.error(m), strict = null }) {
  const realRoot = fs.realpathSync(root);
  const pre = prefix.endsWith('/') ? prefix : prefix + '/';

  const deny = (res, req, why) => {
    log(`404 ${req.method} ${req.url} — ${why}`);
    res.writeHead(404, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(NOT_FOUND),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : NOT_FOUND);
  };

  // 严格模式下的缓存：文件身份（设备号、inode、大小、修改 / 状态变更时间，纳秒）→ 判过的那一份内容。
  // 原地改写一定改变状态变更时间（普通用户也改不回去），所以身份不变 = 内容没变。
  const cache = new Map();
  let cacheBytes = 0;
  const remember = (id, entry) => {
    cache.set(id, entry);
    cacheBytes += entry.data ? entry.data.length : 0;
    while (cacheBytes > strict.cacheBytes && cache.size > 1) {
      const [k, v] = cache.entries().next().value;
      cache.delete(k);
      cacheBytes -= v.data ? v.data.length : 0;
    }
  };
  const identity = (st) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;

  // 判一个严格模式下的请求：返回 { ok, data, type } 或 { ok: false, reason }。
  const judgeStrict = (file) => {
    const rel = path.relative(realRoot, file);
    if (rel.split(path.sep).some((seg) => seg.startsWith('.'))) return { ok: false, reason: '路径里有以 . 开头的段' };
    let keys;
    try {
      keys = strict.keys();
    } catch (e) {
      return { ok: false, reason: `读不出登记的项目（${e.code || e.message}）` };
    }
    const inProject = projectPath(rel, keys);
    const legacy = inProject ? null : strict.legacy.ok ? strict.legacy.map.get(rel) : undefined;
    if (!inProject && !legacy) {
      return { ok: false, reason: strict.legacy.ok ? '不在项目子目录下，也不在旧图清单里' : `不在项目子目录下；旧图清单不可用（${strict.legacy.why}）` };
    }
    let fd;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return { ok: false, reason: '文件不存在' };
    }
    try {
      const st = fs.fstatSync(fd, { bigint: true });
      if (!st.isFile()) return { ok: false, reason: '不是普通文件（目录不对外）' };
      if (st.size > BigInt(strict.maxBytes)) return { ok: false, reason: `超过单文件上限 ${strict.maxBytes} 字节` };
      const id = identity(st);
      const hit = cache.get(id);
      if (hit) {
        cache.delete(id);
        cache.set(id, hit);
        return hit.ok ? { ...hit, mtimeMs: Number(st.mtimeMs) } : hit;
      }
      const size = Number(st.size);
      const data = Buffer.alloc(size);
      let got = 0;
      while (got < size) {
        const n = fs.readSync(fd, data, got, size - got, got);
        if (n <= 0) break;
        got += n;
      }
      const extra = fs.readSync(fd, Buffer.alloc(1), 0, 1, size);
      const after = identity(fs.fstatSync(fd, { bigint: true }));
      if (got !== size || extra !== 0 || after !== id) return { ok: false, reason: '读取期间文件变化' };
      let entry;
      const v = judgeBuffer(file, data);
      if (!v.ok) entry = { ok: false, reason: v.reason };
      else if (legacy && (legacy.size !== size || legacy.sha256 !== sha256(data))) entry = { ok: false, reason: '旧图内容和清单不符' };
      else entry = { ok: true, data, type: v.type };
      remember(id, entry);
      return entry.ok ? { ...entry, mtimeMs: Number(st.mtimeMs) } : entry;
    } finally {
      fs.closeSync(fd);
    }
  };

  const serveStrict = (req, res, file, deny) => {
    const v = judgeStrict(file);
    if (!v.ok) return deny(res, req, v.reason);
    const size = v.data.length;
    const headers = {
      'content-type': v.type,
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      'last-modified': new Date(v.mtimeMs).toUTCString(),
      'cache-control': 'public, max-age=31536000, immutable',
    };
    if (v.type === 'image/svg+xml') {
      headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    }
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = req.headers.range;
    if (range && size > 0) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      const bad = () => {
        res.writeHead(416, { 'content-range': `bytes */${size}`, 'content-length': 0 });
        res.end();
      };
      if (!m || (m[1] === '' && m[2] === '')) return bad();
      if (m[1] === '') {
        const n = Number(m[2]);
        if (n === 0) return bad();
        start = Math.max(0, size - n);
      } else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
      }
      if (start > end || start >= size) return bad();
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['content-length'] = size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || size === 0) return res.end();
    res.end(v.data.subarray(start, end + 1));
  };

  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(res, req, '只接受 GET / HEAD');
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      return deny(res, req, '地址解不开');
    }
    // 入口转发时可能带着前缀，也可能已经剥掉；两种都认。
    const rel = pathname.startsWith(pre) ? pathname.slice(pre.length) : pathname.replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) return deny(res, req, '目录不对外');
    const file = resolveInRoot(realRoot, rel);
    if (!file) return deny(res, req, '不存在或不在资产目录内');
    if (strict) return serveStrict(req, res, file, deny);
    const verdict = judgeFile(realRoot, file);
    if (!verdict.ok) return deny(res, req, verdict.reason);

    const headers = {
      'content-type': verdict.type,
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      'last-modified': new Date(verdict.mtimeMs).toUTCString(),
      // 文件名带唯一戳、内容不变，可以长缓存。
      'cache-control': 'public, max-age=31536000, immutable',
    };
    // SVG 是能带脚本的文档：直接打开时不许它执行任何东西、也不许它再去加载别的资源。
    if (verdict.type === 'image/svg+xml') {
      headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    }

    let start = 0;
    let end = verdict.size - 1;
    let status = 200;
    const range = req.headers.range;
    if (range && verdict.size > 0) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      const bad = () => {
        res.writeHead(416, { 'content-range': `bytes */${verdict.size}`, 'content-length': 0 });
        res.end();
      };
      if (!m || (m[1] === '' && m[2] === '')) return bad();
      if (m[1] === '') {
        const n = Number(m[2]);
        if (n === 0) return bad();
        start = Math.max(0, verdict.size - n);
      } else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(Number(m[2]), verdict.size - 1);
      }
      if (start > end || start >= verdict.size) return bad();
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${verdict.size}`;
    }
    headers['content-length'] = verdict.size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || verdict.size === 0) return res.end();
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

// 状态文件：先写临时文件再改名，读的一方不会读到半截。
function writeStatus(file, st) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(st) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const listFrom = (v) => (v || '').split(':').filter(Boolean);

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  const env = process.env;
  const root = env.PUBLIC_ASSETS_ROOT;
  const port = Number(env.PUBLIC_ASSETS_PORT);
  if (!root || !Number.isInteger(port) || port < 0 || port > 65535 || env.PUBLIC_ASSETS_PORT === undefined) {
    console.error('用法：PUBLIC_ASSETS_ROOT=<资产目录> PUBLIC_ASSETS_PORT=<端口> [PUBLIC_ASSETS_PREFIX=/review-assets/] node serve.mjs');
    process.exit(2);
  }
  const realRoot = fs.realpathSync(root);
  const prefix = env.PUBLIC_ASSETS_PREFIX || '/review-assets/';
  const posInt = (v, d) => (/^[1-9][0-9]*$/.test(v || '') ? Number(v) : d);
  let strict = null;
  if (env.PUBLIC_ASSETS_STRICT === '1') {
    const dirs = listFrom(env.PUBLIC_ASSETS_PROJECT_DIRS);
    let keysAt = 0;
    let keys = null;
    const legacy = loadLegacy(listFrom(env.PUBLIC_ASSETS_LEGACY_LISTS), env.PUBLIC_ASSETS_LEGACY_SHA, realRoot);
    if (!legacy.ok) console.error(`public-assets: 旧图清单不可用，旧结构一律不交出：${legacy.why}`);
    strict = {
      legacy,
      maxBytes: posInt(env.PUBLIC_ASSETS_MAX_BYTES, 256 * 1024 * 1024),
      cacheBytes: posInt(env.PUBLIC_ASSETS_CACHE_BYTES, 512 * 1024 * 1024),
      // 登记的项目每 30 秒重读一次；读不出时抛错，调用方当「不知道」拒绝。
      keys: () => {
        if (!keys || Date.now() - keysAt > 30000) {
          keys = projectKeys(dirs);
          keysAt = Date.now();
        }
        return keys;
      },
    };
  }
  const server = createServer({ root, prefix, strict });
  server.listen(port, '127.0.0.1', () => {
    const p = server.address().port;
    console.error(`public-assets: 127.0.0.1:${p} → ${realRoot}（只放行图片 / 视频${strict ? '；严格模式' : ''}）`);
    if (env.PUBLIC_ASSETS_STATUS) {
      try {
        writeStatus(env.PUBLIC_ASSETS_STATUS, {
          rules: RULES_VERSION,
          strict: !!strict,
          root: realRoot,
          prefix,
          port: p,
          pid: process.pid,
          start: procStart(process.pid) || '',
          code: codeId(),
          legacy_ok: !!(strict && strict.legacy.ok),
          legacy_sha: strict && strict.legacy.ok ? env.PUBLIC_ASSETS_LEGACY_SHA : '',
          legacy_why: strict && !strict.legacy.ok ? strict.legacy.why : '',
          max_bytes: strict ? strict.maxBytes : 0,
        });
      } catch (e) {
        console.error(`public-assets: 状态文件写不成（${e.code || e.message}）`);
      }
    }
  });
}
