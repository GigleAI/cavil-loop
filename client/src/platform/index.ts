// Everything that touches the operating system goes through here:
// credentials, notifications, the Dock badge, launch at login, and whether
// closing the window keeps the app running. UI and data layers never branch
// on the platform. v1 implements macOS; elsewhere these are simply absent.

import { appendFileSync } from 'node:fs';
import { CredentialStore, FileStore, MacKeychainStore, MemoryStore } from './credentials';
import type { Endpoints } from '../data/github';
import type { Alert, Alerts, Delivery, LoginItem } from './alerts';
import { GITHUB_ENDPOINTS } from '../data/github';

export interface Platform {
  credentials: CredentialStore;
  endpoints: Endpoints;
  /** open a URL in the system browser; only github.com (or the test server) is allowed */
  openExternal(url: string): Promise<void>;
  testMode: boolean;
  /** notifications + badge; null where v1 has none */
  alerts: Alerts | null;
  /** launch at login; null where v1 has none */
  loginItem: LoginItem | null;
  /** closing the window hides it and the app keeps syncing (macOS: stays in the Dock) */
  keepRunningWhenClosed: boolean;
}

/** The operating-system calls the platform layer is built on (Electron's, injected by main.ts). */
export interface OsHooks {
  /** show a system notification; `onClick` runs when the user clicks it, `onResult` when the system shows or refuses it */
  notify(title: string, body: string, onClick: () => void, onResult: (d: Delivery) => void): void;
  setBadgeCount(n: number): void;
  getOpenAtLogin(): boolean;
  setOpenAtLogin(on: boolean): void;
  /** bring the app window to the front */
  showWindow(): void;
}

function isLoopback(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  } catch {
    return false;
  }
}

export function isAllowedExternal(url: string, endpoints: Endpoints): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && (u.hostname === 'github.com' || u.hostname.endsWith('.github.com'))) return true;
    return isLoopback(url) && u.origin === new URL(endpoints.web).origin;
  } catch {
    return false;
  }
}

/**
 * Requests the window (pages, frames, images) may make: GitHub's two hosts,
 * plus — in test mode only — the loopback fake. Everything else is cancelled
 * in the main process, whatever a page's own policy says.
 */
export function isAllowedRequest(url: string, endpoints: Endpoints): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && (u.hostname === 'github.com' || u.hostname === 'api.github.com')) return true;
    return isLoopback(url) && (u.origin === new URL(endpoints.api).origin || u.origin === new URL(endpoints.web).origin);
  } catch {
    return false;
  }
}

export interface PlatformEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  shellOpen: (url: string) => Promise<void>;
  os?: OsHooks;
}

/**
 * Test mode (CAVIL_CLIENT_TEST_MODE=1) exists for the automated suite only:
 * it may point the GitHub endpoints at a loopback fake server (loopback
 * only — a test switch can never send the token to another host), store the
 * credential in a file, and record browser opens instead of performing them.
 */
export function createPlatform({ platform, env, shellOpen, os }: PlatformEnv): Platform {
  const testMode = env.CAVIL_CLIENT_TEST_MODE === '1';
  let endpoints = GITHUB_ENDPOINTS;
  if (testMode && env.CAVIL_CLIENT_TEST_API && env.CAVIL_CLIENT_TEST_WEB) {
    if (!isLoopback(env.CAVIL_CLIENT_TEST_API) || !isLoopback(env.CAVIL_CLIENT_TEST_WEB)) {
      throw new Error('测试模式只允许把 GitHub 地址指向本机回环地址');
    }
    endpoints = { api: env.CAVIL_CLIENT_TEST_API.replace(/\/$/, ''), web: env.CAVIL_CLIENT_TEST_WEB.replace(/\/$/, '') };
  }
  let credentials: CredentialStore;
  if (testMode && env.CAVIL_CLIENT_TEST_CREDENTIAL_FILE) credentials = new FileStore(env.CAVIL_CLIENT_TEST_CREDENTIAL_FILE);
  else if (platform === 'darwin') credentials = new MacKeychainStore();
  else credentials = new MemoryStore();

  const opened = env.CAVIL_CLIENT_TEST_OPENED_FILE;
  async function openExternal(url: string) {
    if (!isAllowedExternal(url, endpoints)) throw new Error(`不打开非 GitHub 链接：${url}`);
    if (testMode && opened) {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(opened, `${url}\n`);
      return;
    }
    await shellOpen(url);
  }

  // Test mode: every notification / badge change is appended to a file (one JSON
  // per line) so the UI tests can count them on any OS; the real calls are skipped.
  const alertFile = testMode ? env.CAVIL_CLIENT_TEST_ALERTS_FILE : undefined;
  const mac = platform === 'darwin';
  let alerts: Alerts | null = null;
  if (alertFile) {
    // CAVIL_CLIENT_TEST_NOTIFY_REFUSE=<message>: answer every notification the way macOS does when not allowed
    const refuse = env.CAVIL_CLIENT_TEST_NOTIFY_REFUSE;
    alerts = {
      notify: (a, done) => {
        recordLine(alertFile, { type: 'notify', ...a });
        done?.(refuse ? { ok: false, error: refuse } : { ok: true });
      },
      setBadge: (n) => recordLine(alertFile, { type: 'badge', count: n }),
    };
  } else if (mac && os) {
    alerts = {
      // a click on one item opens it on GitHub; on the summary, brings the window up
      notify: (a: Alert, done) =>
        os.notify(
          a.title,
          a.body,
          () => {
            if (a.kind === 'item') openExternal(a.url).catch(() => {});
            else os.showWindow();
          },
          (d) => done?.(d),
        ),
      setBadge: (n) => os.setBadgeCount(n),
    };
  }
  const loginItem: LoginItem | null = mac && os ? { get: () => os.getOpenAtLogin(), set: (on) => os.setOpenAtLogin(on) } : null;

  return {
    credentials,
    endpoints,
    testMode,
    openExternal,
    alerts,
    loginItem,
    keepRunningWhenClosed: mac || (testMode && env.CAVIL_CLIENT_TEST_KEEP_RUNNING === '1'),
  };
}

function recordLine(file: string, entry: unknown): void {
  // synchronous on purpose: tests read the file right after the state changes
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}
