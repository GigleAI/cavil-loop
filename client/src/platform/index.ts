// Everything that touches the operating system goes through here:
// credentials now; notifications, Dock badge / tray and launch-at-login join
// in later sub-items. UI and data layers never branch on the platform.

import { CredentialStore, FileStore, MacKeychainStore, MemoryStore } from './credentials';
import type { Endpoints } from '../data/github';
import { GITHUB_ENDPOINTS } from '../data/github';

export interface Platform {
  credentials: CredentialStore;
  endpoints: Endpoints;
  /** open a URL in the system browser; only github.com (or the test server) is allowed */
  openExternal(url: string): Promise<void>;
  testMode: boolean;
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
}

/**
 * Test mode (CAVIL_CLIENT_TEST_MODE=1) exists for the automated suite only:
 * it may point the GitHub endpoints at a loopback fake server (loopback
 * only — a test switch can never send the token to another host), store the
 * credential in a file, and record browser opens instead of performing them.
 */
export function createPlatform({ platform, env, shellOpen }: PlatformEnv): Platform {
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
  return {
    credentials,
    endpoints,
    testMode,
    async openExternal(url: string) {
      if (!isAllowedExternal(url, endpoints)) throw new Error(`不打开非 GitHub 链接：${url}`);
      if (testMode && opened) {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(opened, `${url}\n`);
        return;
      }
      await shellOpen(url);
    },
  };
}
