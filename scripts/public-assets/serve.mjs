#!/usr/bin/env node
// 公网资产目录的对外服务：只交出图片和视频，任何目录都返回 404。
//
// 用法：PUBLIC_ASSETS_ROOT=<资产目录> PUBLIC_ASSETS_PORT=<端口> [PUBLIC_ASSETS_PREFIX=/review-assets/] node serve.mjs
//
// 只监听 127.0.0.1——公网入口（隧道 / 反向代理）转发到这个端口，不要把它直接绑到外网地址。
// 所有拒绝对外都是同一个 404、不带原因（不告诉来访者「这里有个文件但不给你」）；
// 原因写到 stderr，本机日志里查得到。放行规则在 rules.mjs，和发图前自查（check.mjs）是同一份。
import http from 'http';
import fs from 'fs';
import { judgeFile, resolveInRoot } from './rules.mjs';

const NOT_FOUND = 'Not found.\n';

export function createServer({ root, prefix = '/review-assets/', log = (m) => console.error(m) }) {
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

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  const root = process.env.PUBLIC_ASSETS_ROOT;
  const port = Number(process.env.PUBLIC_ASSETS_PORT);
  if (!root || !Number.isInteger(port) || port < 0 || port > 65535 || process.env.PUBLIC_ASSETS_PORT === undefined) {
    console.error('用法：PUBLIC_ASSETS_ROOT=<资产目录> PUBLIC_ASSETS_PORT=<端口> [PUBLIC_ASSETS_PREFIX=/review-assets/] node serve.mjs');
    process.exit(2);
  }
  const server = createServer({ root, prefix: process.env.PUBLIC_ASSETS_PREFIX || '/review-assets/' });
  server.listen(port, '127.0.0.1', () => {
    console.error(`public-assets: 127.0.0.1:${server.address().port} → ${fs.realpathSync(root)}（只放行图片 / 视频）`);
  });
}
