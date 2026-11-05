// UI tests: the real window (dist/renderer-test, built with --test-bridge) in a
// browser engine Playwright drives, talking to the real back end — the Rust
// code the app ships, run as the test harness — through this loopback bridge.
// The bridge serves the page with the app's own Content-Security-Policy (read
// from src-tauri/tauri.conf.json) and answers `POST /call`.
//
// What this does not cover, and where it is covered instead: Tauri's IPC and
// the system WebKit window (CI: the packaged app's smoke test on both Macs and
// on Linux; the maintainer's hands-on check).

import { chromium, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessBackend } from '../support/harness';
import { FileStore } from '../support/credentials';
import type { FakeGitHub } from '../fake-github/server';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pageDir = join(root, 'dist', 'renderer-test');

/** The app's policy, as Tauri sends it, plus same-origin `fetch` for the bridge itself. */
export function appCsp(extraConnect: string): string {
  const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const csp: Record<string, string> = { ...conf.app.security.csp };
  csp['connect-src'] = `${extraConnect}`;
  return Object.entries(csp)
    .map(([k, v]) => `${k} ${v}`)
    .join('; ');
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json' };
// a 1×1 PNG: what "GitHub" answers for an image the window was allowed to ask for
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

export interface AppEnv {
  fake: FakeGitHub;
  userData: string;
  cred: string;
  opened: string;
  /** every request the window made outside the bridge, one per line: "request <url>" */
  requests: string;
}

export interface RunningApp {
  page: Page;
  backend: HarnessBackend;
  close(): Promise<void>;
}

let browser: Browser | null = null;
async function engine(): Promise<Browser> {
  if (browser) return browser;
  // CI runs WebKit (the engine family of the macOS app); CAVIL_E2E_ENGINE=chromium where WebKit cannot start
  const which = process.env.CAVIL_E2E_ENGINE ?? 'webkit';
  browser = await (which === 'chromium' ? chromium : webkit).launch();
  return browser;
}

export async function closeEngine() {
  await browser?.close();
  browser = null;
}

/** Start the app: back end (Rust) on the profile in `env`, the window in a fresh browser context. */
export async function launchApp(env: AppEnv): Promise<RunningApp> {
  const opened: string[] = [];
  const backend = new HarnessBackend({
    db: join(env.userData, 'cache.sqlite'),
    endpoints: { api: env.fake.api, web: env.fake.web },
    credentials: new FileStore(env.cred),
    opened: new Proxy(opened, {
      get(t, k) {
        if (k === 'push') return (u: string) => (appendFileSync(env.opened, `${u}\n`), t.push(u));
        return (t as any)[k];
      },
    }),
  });
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/call') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', async () => {
        let reply: unknown;
        try {
          const { cmd, args } = JSON.parse(body);
          reply = { ok: (await backend.call(cmd, args)) ?? null };
        } catch (e) {
          reply = { err: (e as Error).message };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
      return;
    }
    const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    const file = join(pageDir, path === '/' ? 'index.html' : path);
    if (!file.startsWith(pageDir) || !existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': appCsp("'self'") });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const context: BrowserContext = await (await engine()).newContext({ viewport: { width: 1280, height: 800 } });
  // Nothing leaves the machine. Every request the window makes outside the bridge is recorded;
  // GitHub's image hosts get a 1×1 PNG, anything else is refused.
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(`${origin}/`)) return route.continue();
    appendFileSync(env.requests, `request ${url}\n`);
    if (/^https:\/\/(api\.)?github\.com\//.test(url)) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    return route.abort();
  });
  // `<a target="_blank">` in the detail view: the app's shell never opens a window for it,
  // it hands the address to the back end's open-in-browser rule (src-tauri/src/main.rs,
  // on_new_window). Same here: close the popup, ask the back end to open its address.
  const page = await context.newPage();
  context.on('page', async (popup) => {
    if (popup === page) return;
    let url = popup.url();
    if (url === 'about:blank') {
      try {
        await popup.waitForURL((u) => u.href !== 'about:blank', { timeout: 5000 });
      } catch {
        /* never navigated */
      }
      url = popup.url();
    }
    await popup.close().catch(() => {});
    if (url && url !== 'about:blank') await backend.call('openExternal', { url }).catch(() => {});
  });
  page.on('pageerror', (e) => console.error('[window]', e.message));
  await page.goto(`${origin}/index.html`);
  await page.waitForSelector('[data-testid="app-root"]');
  return {
    page,
    backend,
    async close() {
      await context.close();
      await backend.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
