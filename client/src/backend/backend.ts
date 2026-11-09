// The window's only way to the back end (Rust, src-tauri/crates/core). The
// back end holds the GitHub credential; nothing that crosses this interface
// carries it — the window names a session and the back end signs the request.
//
// Two transports, one command set (src-tauri/crates/core/src/api.rs):
//   tauri.ts            the app: Tauri's IPC
//   test/support/...    the suites: the same Rust code as a child process

import type { SourceSnapshot } from '../shared/types';
import type { Endpoints, FetchLike } from '../data/github';

export interface Backend {
  call<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

export interface BackendInit {
  /** every setting except the ones that describe the credential */
  settings: Record<string, unknown>;
  snapshots: SourceSnapshot[];
  /** the credential survives a restart (keychain) */
  persistent: boolean;
  /** the GitHub the back end talks to (production: api.github.com / github.com; test mode: a loopback fake) */
  endpoints: Endpoints;
}

export type FreshResult = 'ok' | 'unreachable' | 'ended' | 'failed' | 'changed';

export interface FreshOut {
  result: FreshResult;
  /** absent: leave the shown problem; null: clear it */
  problem?: string | null;
  signedOut?: { session: number; reason: string };
  /** GitHub#270: with 'unreachable' only — why GitHub could not be used for the refresh */
  reason?: string;
}

export interface GrantInfo {
  signedIn: boolean;
  session: number;
  gen: number;
  canRefresh?: boolean;
  /** the access token is past its deadline */
  expired?: boolean;
}

interface Proxied {
  status?: number;
  headers?: [string, string][];
  body?: string;
  error?: 'stale' | 'refused' | 'network';
  message?: string;
}

/**
 * A fetch for GitHubClient that goes through the back end: it adds the
 * credential of `session` and refuses anything but the configured GitHub API.
 */
export function proxyFetch(backend: Backend, session: number): FetchLike {
  return async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const r = await backend.call<Proxied>('request', {
      session,
      method: init?.method ?? 'GET',
      url,
      headers,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    if (r.error) throw new Error(r.message ?? r.error);
    const status = r.status ?? 0;
    const body = status === 204 || status === 205 || status === 304 ? null : (r.body ?? '');
    return new Response(body, { status, headers: r.headers ?? [] });
  };
}
