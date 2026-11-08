// GitHub#267: an image written as a repo file on github.com (`/<owner>/<repo>/raw/<ref>/<path>`) is
// answered by GitHub with a redirect to raw.githubusercontent.com, and the page's policies check the
// redirect target again. This spec makes that redirect really happen, without leaving the machine.
//
// Why not the UI tests' request interception: Playwright routes only the first address of a
// redirect, so a 302 answered there sends the target out to the real network. Here the browser
// goes through a local proxy instead; every HTTPS host is tunnelled to one local TLS server
// (a throwaway self-signed certificate, accepted for this context only) that answers by host
// name. Anything not plain HTTPS-through-the-proxy is refused, and every request is recorded.
//
// The window policy is the real one (tauri.conf.json, read the way the UI tests' bridge sends it),
// the discussion frame the real one (timelineDocument with its own policy, the app's sandbox).
import { test, expect, chromium, webkit, type Browser, type BrowserContext } from '@playwright/test';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { appCsp } from './bridge';
import { escapeHtml, timelineDocument, TIMELINE_SANDBOX } from '../../src/renderer/detailHtml';
import type { ItemDetail } from '../../src/shared/actions';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const PAGE_HOST = 'cavil-window.test';

const IMAGES = [
  // a repo file on github.com → GitHub's redirect to the raw host (allowed since GitHub#267)
  '<p><img alt="via redirect" src="https://github.com/GigleAI/cavil-loop/raw/main/docs/design/a.png"></p>',
  // the same redirect pointing at a look-alike of the raw host: the policies must stop it at the redirect
  '<p><img alt="redirect to look-alike" src="https://github.com/o/r/raw/main/evil.png"></p>',
  // the raw host directly, for comparison
  '<p><img alt="direct" src="https://raw.githubusercontent.com/o/r/main/direct.png"></p>',
].join('');

const detail: ItemDetail = {
  key: 'o/r#1',
  repo: 'o/r',
  number: 1,
  kind: 'issue',
  title: 't',
  url: 'https://github.com/o/r/issues/1',
  state: 'open',
  pr: null,
  fetchedAt: 0,
  labels: [],
  timeline: [{ kind: 'comment', id: 'C_IMG', url: '', author: 'a', at: '2026-11-08T00:00:00Z', bodyHtml: IMAGES }],
};

let dir: string;
let tls: https.Server;
let proxy: http.Server;
let browser: Browser;
let context: BrowserContext;
/** every request that reached a "remote" host, `host path` */
const seen: string[] = [];
/** every attempt that was refused (not HTTPS through the proxy) */
const refused: string[] = [];

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cavil-redirect-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=cavil-test', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  tls = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => {
    const host = (req.headers.host ?? '').replace(/:443$/, '');
    const path = req.url ?? '/';
    seen.push(`${host} ${path}`);
    if (host === PAGE_HOST && path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': appCsp("'self'") });
      return res.end(`<!doctype html><iframe sandbox="${TIMELINE_SANDBOX}" style="width:600px;height:400px" srcdoc="${escapeHtml(timelineDocument(detail, false, 'all'))}"></iframe>`);
    }
    const repoFile = host === 'github.com' ? /^\/([^/]+)\/([^/]+)\/raw\/(.+)$/.exec(path) : null;
    if (repoFile) {
      const target = repoFile[3].endsWith('evil.png') ? 'raw.githubusercontent.com.evil.example' : 'raw.githubusercontent.com';
      res.writeHead(302, { Location: `https://${target}/${repoFile[1]}/${repoFile[2]}/${repoFile[3]}` });
      return res.end();
    }
    if (host === 'raw.githubusercontent.com' || host === 'raw.githubusercontent.com.evil.example' || host === 'avatars.githubusercontent.com') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(PNG);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r));
  const tlsPort = (tls.address() as AddressInfo).port;
  // the proxy: CONNECT to port 443 of any host goes to the local TLS server; everything else is refused
  proxy = http.createServer((req, res) => {
    refused.push(`${req.method} ${req.url}`);
    res.writeHead(403);
    res.end();
  });
  proxy.on('connect', (req, client: net.Socket, head) => {
    if (!/:443$/.test(req.url ?? '')) {
      refused.push(`CONNECT ${req.url}`);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const up = net.connect(tlsPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  browser = await (process.env.CAVIL_E2E_ENGINE === 'chromium' ? chromium : webkit).launch({
    proxy: { server: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, bypass: '<-loopback>' },
  });
  context = await browser.newContext({ ignoreHTTPSErrors: true });
});

test.afterAll(async () => {
  await context?.close();
  await browser?.close();
  proxy?.close();
  tls?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('GitHub#267: a repo file on github.com is redirected to the raw host and shows; a redirect to a look-alike does not', async () => {
  const p = await context.newPage();
  await p.goto(`https://${PAGE_HOST}/`);
  const f = p.frames().find((x) => x !== p.mainFrame())!;
  await f.waitForLoadState();
  const shown = (alt: string) => f.locator(`img[alt="${alt}"]`).evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0);

  // the redirect really happened: the first address and the target both reached the "network"
  await expect.poll(() => seen).toContain('github.com /GigleAI/cavil-loop/raw/main/docs/design/a.png');
  await expect.poll(() => seen).toContain('raw.githubusercontent.com /GigleAI/cavil-loop/main/docs/design/a.png');
  // ...and the same image element shows the target's picture
  await expect.poll(() => shown('via redirect')).toBe(true);
  await expect.poll(() => shown('direct')).toBe(true);

  // the look-alike: the first address is allowed and asked, the redirect target is stopped by the policy
  await expect.poll(() => seen).toContain('github.com /o/r/raw/main/evil.png');
  await expect.poll(() => f.locator('img[alt="redirect to look-alike"]').evaluate((i: HTMLImageElement) => i.complete)).toBe(true);
  expect(await shown('redirect to look-alike')).toBe(false);
  expect(seen.filter((l) => l.startsWith('raw.githubusercontent.com.evil.example'))).toEqual([]);

  // nothing went anywhere but through the proxy to the local server
  expect(refused).toEqual([]);
  await p.close();
});
