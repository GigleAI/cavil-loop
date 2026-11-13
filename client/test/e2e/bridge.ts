// UI tests: the real window (dist/renderer-test, built with --test-bridge) in a
// browser engine Playwright drives, talking to the real back end — the Rust
// code the app ships, run as the test harness — through this loopback bridge.
// The bridge serves the page with the app's own Content-Security-Policy (read
// from src-tauri/tauri.conf.json) and answers `POST /call`.
//
// What this does not cover, and where it is covered instead: Tauri's IPC and
// the system WebKit window (CI: the packaged app's smoke test on both Macs and
// on Linux; the maintainer's hands-on check).
//
// `POST /desktop` plays the shell's desktop side (src-tauri/src/desktop.rs) for
// the window: it records every notification and badge, can refuse notifications
// like macOS does, and hands the window the events the test sends (a sync beat,
// a clicked notification). Hiding the window on close is the shell's own and is
// tested on the real app (test/tauri).

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
  desktop: FakeDesktop;
  close(): Promise<void>;
}

/** What the window asked of the shell's desktop side, and the events the test sends it. */
export interface FakeDesktop {
  /** `{ op: 'notify', alert, result }` / `{ op: 'badge', count }` / `{ op: 'loginItem', on }` / `{ op: 'clearNotifications' }`, in order */
  records: any[];
  /** answer every notification with this refusal (null = shown) */
  refuse: string | null;
  /** launch at login as the "system" has it (null = this platform cannot) */
  loginItem: boolean | null;
  /** the updater as the "shell" has it (GitHub#184; null = this build does not update itself) */
  update: any | null;
  /** a beat sent without `everyMs` is sent with 0: no gap after a round that ran over a beat (GitHub#324 — the test keeps the time; the gap itself is in test/unit/timed-sync.test.ts) */
  push(ev: { kind: 'tick'; everyMs?: number } | { kind: 'open'; key: string; url: string } | { kind: 'update'; status: any } | { kind: 'active' } | { kind: 'inactive' } | { kind: 'closeTab' }): void;
  /** the shell changed the updater's status: the window hears it the way it hears the real one */
  setUpdate(status: any): void;
}

function fakeDesktop(): FakeDesktop & { next(): Promise<unknown>; stop(): void } {
  const queue: unknown[] = [];
  const waiters: ((e: unknown) => void)[] = [];
  return {
    records: [],
    refuse: null,
    loginItem: false,
    update: null,
    setUpdate(status) {
      this.update = status;
      this.push({ kind: 'update', status });
    },
    push(sent) {
      const ev = sent.kind === 'tick' && sent.everyMs === undefined ? { ...sent, everyMs: 0 } : sent;
      const w = waiters.shift();
      if (w) w(ev);
      else queue.push(ev);
    },
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
    stop() {
      waiters.length = 0;
    },
  };
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
/**
 * Web APIs the oldest WebKit the app supports (macOS 11 = Safari 14) does not have.
 * `launchApp(env, { oldEngine: true })` removes them before the window's code runs,
 * so a dependency on any of them fails a test instead of failing only on old Macs.
 * An emulation: it catches missing APIs, not missing syntax or rendering differences.
 */
export const NOT_IN_SAFARI_14 = [
  'AbortSignal.timeout', 'AbortSignal.any', 'Array.prototype.at', 'String.prototype.at', 'Array.prototype.findLast',
  'Array.prototype.findLastIndex', 'Array.prototype.toSorted', 'Array.prototype.toReversed', 'Array.prototype.toSpliced',
  'Array.prototype.with', 'Object.hasOwn', 'Object.groupBy', 'Map.groupBy', 'Promise.withResolvers', 'structuredClone',
  'Crypto.prototype.randomUUID', 'Set.prototype.union', 'Set.prototype.intersection', 'Set.prototype.difference',
];

export async function launchApp(env: AppEnv, opts: { oldEngine?: boolean; backendEnv?: Record<string, string>; /** GitHub#471: the system language the window sees (navigator.languages); default the engine's */ locale?: string } = {}): Promise<RunningApp> {
  const opened: string[] = [];
  const desktop = fakeDesktop();
  const backend = new HarnessBackend({
    db: join(env.userData, 'cache.sqlite'),
    endpoints: { api: env.fake.api, web: env.fake.web },
    credentials: new FileStore(env.cred),
    // GitHub#314: the local-daemon switches (fake HOME, PATH, scheduler) for the settings section
    ...(opts.backendEnv ? { env: opts.backendEnv } : {}),
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
    if (req.method === 'POST' && req.url === '/desktop') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', async () => {
        const { op, args } = JSON.parse(body);
        let ok: unknown = null;
        if (op === 'notify') {
          ok = desktop.refuse ? { ok: false, error: desktop.refuse } : { ok: true };
          desktop.records.push({ op, alert: args.alert, result: ok });
        } else if (op === 'badge') {
          desktop.records.push({ op, count: args.count });
        } else if (op === 'loginItem') {
          ok = desktop.loginItem;
        } else if (op === 'setLoginItem') {
          desktop.loginItem = Boolean(args.on);
          desktop.records.push({ op: 'loginItem', on: desktop.loginItem });
        } else if (op === 'nextEvent') {
          ok = await desktop.next();
        } else if (op === 'updateStatus') {
          ok = desktop.update;
        } else if (op === 'checkUpdate' || op === 'restartToUpdate' || op === 'clearNotifications' || op === 'closeWindow') {
          desktop.records.push({ op });
        } else if (op === 'setAutoUpdate') {
          desktop.records.push({ op, on: args.on });
          desktop.setUpdate({ ...desktop.update, auto: Boolean(args.on) });
        } else if (op === 'setUpdateChannel') {
          desktop.records.push({ op, channel: args.channel });
          desktop.setUpdate({ ...desktop.update, channel: args.channel });
        } else if (op === 'dismissUpdate') {
          desktop.records.push({ op, version: args.version });
          desktop.setUpdate({ ...desktop.update, dismissed: args.version });
        } else if (op === 'dismissInstalledUpdate') {
          desktop.records.push({ op, version: args.version });
          desktop.setUpdate({ ...desktop.update, installed: desktop.update?.installed ? { ...desktop.update.installed, dismissed: true } : null });
        }
        if (res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok }));
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

  const context: BrowserContext = await (await engine()).newContext({ viewport: { width: 1280, height: 800 }, ...(opts.locale ? { locale: opts.locale } : {}) });
  // Nothing leaves the machine. Every request the window makes outside the bridge is recorded;
  // the hosts the app may load images from (github.com / api.github.com, and GitHub's avatar
  // host since #155, its image hosts since #205, a repo's raw files since #267) get a 1×1 PNG,
  // anything else is refused. (No redirects: Playwright routes only the first address of a redirect,
  // so the target would go out to the real network.)
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(`${origin}/`)) return route.continue();
    appendFileSync(env.requests, `request ${url}\n`);
    if (/^https:\/\/((api\.)?github\.com|(avatars|private-user-images|user-images|camo|raw)\.githubusercontent\.com)\//.test(url)) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    return route.abort();
  });
  // `<a target="_blank">` in the detail view: the app's shell never opens a window for it,
  // it hands the address to the back end's open-in-browser rule (src-tauri/src/main.rs,
  // on_new_window). Same here: close the popup, ask the back end to open its address.
  if (opts.oldEngine) {
    await context.addInitScript((names: string[]) => {
      for (const n of names) {
        const parts = n.split('.');
        const prop = parts.pop()!;
        let owner: any = globalThis;
        for (const p of parts) owner = owner?.[p];
        if (owner && prop in owner) {
          try {
            delete owner[prop];
          } catch {
            /* non-configurable: shadow it */
          }
          if (prop in owner) Object.defineProperty(owner, prop, { value: undefined, configurable: true, writable: true });
        }
      }
      (globalThis as any).__removedApis = names.filter((n) => {
        const parts = n.split('.');
        const prop = parts.pop()!;
        let owner: any = globalThis;
        for (const p of parts) owner = owner?.[p];
        return !owner || owner[prop] === undefined;
      });
    }, NOT_IN_SAFARI_14);
  }
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
    desktop,
    async close() {
      desktop.stop();
      await context.close();
      await backend.close();
      // a waiting `nextEvent` must not hold the server open
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
