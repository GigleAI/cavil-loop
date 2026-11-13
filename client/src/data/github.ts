// Minimal GitHub HTTP client. Only ever talks to the two configured bases
// (production: https://api.github.com and https://github.com); pagination
// links that point anywhere else are refused so the token never leaves them.

import type { FailureInput } from '../shared/readFailure';
import { t, tKey, zhKey } from '../shared/i18n';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Endpoints {
  /** REST + GraphQL base, e.g. https://api.github.com */
  api: string;
  /** web base used for the OAuth device flow, e.g. https://github.com */
  web: string;
}

export const GITHUB_ENDPOINTS: Endpoints = { api: 'https://api.github.com', web: 'https://github.com' };

export type GitHubErrorKind = 'network' | 'auth' | 'http' | 'graphql';

/**
 * GitHub#401: what an answer said besides its message — read by the failure classifier
 * (shared/readFailure.ts) to tell an organisation's restriction, single sign-on or a missing scope
 * from a plain "not found". Filled where the answer is at hand; absent = not said.
 */
export interface GitHubErrorMeta {
  /** GraphQL error types (NOT_FOUND, FORBIDDEN, INSUFFICIENT_SCOPES, …) */
  gqlTypes?: string[];
  /** X-GitHub-SSO */
  sso?: string | null;
  /** X-OAuth-Scopes (an OAuth app's granted scopes) */
  scopes?: string | null;
  /** the read was given up on (a dropped round), not refused */
  cancelled?: boolean;
}

export class GitHubError extends Error {
  meta: GitHubErrorMeta = {};
  /** GitHub's own words of a refused answer ('' = it gave none); undefined = not a refused answer (GitHub#472: kept apart from the client's sentence) */
  said?: string;
  constructor(
    readonly kind: GitHubErrorKind,
    message: string,
    readonly status?: number,
    /** GitHub#374: a GraphQL error GitHub calls temporary ("something went wrong", a timeout) */
    readonly transient = false,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

const USER_AGENT = 'cavil-loop-client';

/**
 * GitHub#374: GitHub said this account may not ask for more right now (its hourly quota is used
 * up, or a secondary limit). `resetAt` = when GitHub says it may ask again (epoch ms, from
 * x-ratelimit-reset), `retryAfterMs` = the same said as a wait (retry-after); both null = it did
 * not say. `sent` = false when the sync's read gate refused before anything went out.
 */
export class RateLimitError extends GitHubError {
  constructor(
    message: string,
    status: number | undefined,
    readonly resetAt: number | null,
    readonly retryAfterMs: number | null,
    readonly sent: boolean,
  ) {
    super('http', message, status);
    this.name = 'RateLimitError';
  }
  /** when the answer arrived (a retry-after counts from here) */
  readonly heardAt: number | null = Date.now();
}

/** an answer's headers the failure classifier reads (GitHub#401) */
function headerMeta(res: Response): GitHubErrorMeta {
  return { sso: res.headers.get('x-github-sso'), scopes: res.headers.get('x-oauth-scopes') };
}

/** GitHub#401: an error as the failure classifier takes it; anything not a GitHubError is "unknown" */
export function failureInput(e: unknown): FailureInput {
  if (!(e instanceof GitHubError)) return { kind: 'unknown', message: e instanceof Error ? e.message : String(e) };
  const limited = e instanceof RateLimitError;
  const retryAt = limited ? (e.retryAfterMs !== null ? (e.heardAt ?? Date.now()) + e.retryAfterMs : e.resetAt) : null;
  return {
    kind: e.kind,
    message: e.message,
    ...(e.status !== undefined ? { status: e.status } : {}),
    ...(e.meta.cancelled ? { cancelled: true } : {}),
    ...(limited ? { rateLimited: true, retryAt } : {}),
    ...(e.transient ? { transient: true } : {}),
    ...(e.meta.gqlTypes ? { gqlTypes: e.meta.gqlTypes } : {}),
    ...(e.meta.sso !== undefined ? { sso: e.meta.sso } : {}),
    ...(e.meta.scopes !== undefined ? { scopes: e.meta.scopes } : {}),
  };
}

/** a key: shown through tKey when the error is made */
export const RATE_LIMIT_MESSAGE = zhKey('GitHub 限流（这个账号的查询额度暂时用完了）');

/** A rate-limit answer, or null: 403 / 429 with the quota at 0, a retry-after, or GitHub's own words for it. */
export function rateLimitOf(res: Response, detail: string): RateLimitError | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const remaining = res.headers.get('x-ratelimit-remaining');
  const after = res.headers.get('retry-after');
  if (remaining !== '0' && after === null && !/rate limit/i.test(detail) && res.status !== 429) return null;
  return limitError(res, res.status);
}

/**
 * What an answer that is not a success means — the one rule, for every request and (GitHub#395) for
 * the answer the back end hands over when a release attachment could not be downloaded: a refused
 * credential, a rate limit (a 403 is not "no access" before this said so), or GitHub's own error.
 */
export async function refusalOf(res: Response): Promise<GitHubError> {
  if (res.status === 401) return new GitHubError('auth', t('GitHub 凭据无效（可能已被撤销或过期）'), 401);
  let detail = '';
  try {
    detail = ((await res.json()) as { message?: string }).message ?? '';
  } catch {
    /* body not JSON */
  }
  let e: GitHubError | null = rateLimitOf(res, detail);
  if (!e) {
    e = new GitHubError('http', detail ? t('GitHub 返回 HTTP {status}：{detail}', { status: res.status, detail }) : t('GitHub 返回 HTTP {status}', { status: res.status }), res.status);
    e.said = detail;
  }
  e.meta = headerMeta(res);
  return e;
}

function limitError(res: Response, status: number | undefined): RateLimitError {
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  const after = Number(res.headers.get('retry-after'));
  const resetAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : null;
  const retryAfterMs = res.headers.get('retry-after') !== null && Number.isFinite(after) && after >= 0 ? after * 1000 : null;
  return new RateLimitError(tKey(RATE_LIMIT_MESSAGE), status, resetAt, retryAfterMs, true);
}

/** GitHub's GraphQL error words for "something broke on our side, ask again" (not a wrong query). */
const TRANSIENT_GRAPHQL = /something went wrong|timed? ?out|try (again|later)|temporarily|service unavailable/i;

/**
 * GitHub#374: an answer worth asking for once more, the same request: GitHub's own server
 * errors and its GraphQL "something went wrong / timed out". Never a rate limit (asking again
 * makes it worse), a refused credential, a missing board or a wrong query. A broken connection
 * is already asked again by the back end where that is safe (GitHub#364).
 */
export function isTransient(e: unknown): boolean {
  if (!(e instanceof GitHubError) || e instanceof RateLimitError) return false;
  if (e.kind === 'http') return e.status !== undefined && e.status >= 500 && e.status <= 599;
  if (e.kind === 'graphql') return e.transient;
  return false;
}

/**
 * GitHub#374: the sync's reads, all through one gate. Once any of them is told "rate limited",
 * no further read goes out until GitHub's reset time — the rest of the round, and every round
 * after, until then. Only the sync's own client carries it: writes and the detail panel are
 * not held back (they say GitHub's answer as before).
 *
 * One gate belongs to one account and one stretch of rounds: another account, or a refresh by
 * hand, gets a new gate object (the controller swaps it), so an answer that arrives late for a
 * round given up on can only ever close the gate it was sent through — never the new one
 * (PR #375 review round 1). A client whose round was given up on writes to no gate at all.
 */
export class ReadGate {
  /** no read goes out before this (epoch ms); null = open */
  until: number | null = null;
  /** limits in a row that did not say when to ask again (each waits longer) */
  private blind = 0;

  constructor(private readonly now: () => number) {}

  /** throws the "rate limited" error, without sending, while closed */
  check(): void {
    if (this.until !== null && this.now() < this.until) throw new RateLimitError(tKey(RATE_LIMIT_MESSAGE), undefined, this.until, null, false);
  }

  /** a rate-limit answer arrived: closed until GitHub's time, or 1, 2, 4, 8, 10 min when it gave none (never past an hour) */
  hit(e: RateLimitError): void {
    const now = this.now();
    let at = e.retryAfterMs !== null ? now + e.retryAfterMs : e.resetAt;
    if (at === null || at <= now) at = now + backoffStep(++this.blind);
    at = Math.min(at, now + MAX_LIMIT_WAIT_MS);
    this.until = Math.max(this.until ?? 0, at);
  }

  /**
   * A whole round heard no limit at all: the limits in a row are over, the next one without a
   * time waits 1 minute again. Never one request's success — "who am I" answering says nothing
   * about the board count that keeps being refused after it (PR #375 review round 1).
   */
  roundClean(): void {
    if (this.until === null || this.now() >= this.until) this.blind = 0;
  }
}

/** a reset time further away than this is not believed (GitHub's hourly window, with room) */
export const MAX_LIMIT_WAIT_MS = 65 * 60_000;

/** GitHub#374: the wait after the n-th failure in a row (n >= 1): 1, 2, 4, 8, then 10 minutes */
export function backoffStep(n: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, n - 1), 10 * 60_000);
}

/** GitHub#374: the sync's reads — the gate, and the waits before asking a failed page again */
export interface ReadOptions {
  gate: ReadGate;
  /** each entry = one more try of the same request after that many ms */
  retryDelaysMs: number[];
  sleep?: (ms: number) => Promise<void>;
}

export const READ_RETRY_DELAYS_MS = [1000, 3000];

/**
 * A signal that aborts after `ms`. Not `AbortSignal.timeout`: this code now runs in
 * the window, i.e. the system WebKit, and macOS 11's (Safari 14) does not have it
 * (GitHub#151 review). In the app the back end's own 30 s limit applies as well.
 */
export function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  // Node (tests, record.mjs): a pending timer must not keep the process alive
  (t as unknown as { unref?: () => void }).unref?.();
  return c.signal;
}

export class GitHubClient {
  constructor(
    private readonly endpoints: Endpoints,
    /** null: the request goes through the back end, which adds the credential (the window never has it) */
    private readonly token: string | null,
    private readonly fetchImpl: FetchLike = fetch,
    /** aborted: this client's work was given up on (a dropped sync round, GitHub#217) — send nothing more */
    private readonly cancelled?: AbortSignal,
    /** GitHub#374: the sync's client only — the read gate and asking a failed read again */
    private readonly reads?: ReadOptions,
  ) {}

  /**
   * GitHub#374: one read, asked again after each of `retryDelaysMs` while the answer is a
   * temporary failure (only for the sync's client; everything else is one try, as before).
   */
  private async again<T>(read: () => Promise<T>): Promise<T> {
    const delays = this.reads?.retryDelaysMs ?? [];
    for (let i = 0; ; i++) {
      try {
        return await read();
      } catch (e) {
        if (i >= delays.length || !isTransient(e) || this.cancelled?.aborted) throw e;
        await (this.reads?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(delays[i]);
      }
    }
  }

  /** a rate limit heard: closes this client's gate — unless its round was given up on meanwhile */
  private limitHeard(e: RateLimitError): void {
    if (!this.cancelled?.aborted) this.reads?.gate.hit(e);
  }

  private async send(url: string, init: RequestInit, notModifiedOk = false): Promise<Response> {
    if (this.cancelled?.aborted) {
      const given = new GitHubError('network', t('已放弃这一轮同步'));
      given.meta.cancelled = true;
      throw given;
    }
    this.reads?.gate.check();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          'User-Agent': USER_AGENT,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: init.signal ?? timeoutSignal(30_000),
      });
    } catch (e) {
      throw new GitHubError('network', t('无法连接 GitHub：{why}', { why: (e as Error).message }));
    }
    if (res.status === 401) throw await refusalOf(res);
    if (notModifiedOk && res.status === 304) return res;
    if (!res.ok) {
      const refused = await refusalOf(res);
      if (refused instanceof RateLimitError) this.limitHeard(refused);
      throw refused;
    }
    return res;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    // a write is never asked twice (the first may have landed)
    return /^\s*mutation\b/.test(query) ? this.graphqlOnce<T>(query, variables) : this.again(() => this.graphqlOnce<T>(query, variables));
  }

  private async graphqlOnce<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.send(`${this.endpoints.api}/graphql`, {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
      headers: { 'Content-Type': 'application/json' },
    });
    let body: { data?: T; errors?: { message: string; type?: string }[] };
    try {
      body = (await res.json()) as typeof body;
    } catch (e) {
      throw new GitHubError('network', t('GitHub 回应不完整：{why}', { why: (e as Error).message }));
    }
    if (body.errors && body.errors.length) {
      if (body.errors.some((e) => e.type === 'RATE_LIMITED')) {
        const limited = limitError(res, res.status);
        this.limitHeard(limited);
        throw limited;
      }
      const transient = body.errors.every((e) => !e.type && TRANSIENT_GRAPHQL.test(e.message));
      const err = new GitHubError('graphql', body.errors.map((e) => e.message).reduce((a, b) => t('{a}；{b}', { a, b })), undefined, transient);
      err.meta = { ...headerMeta(res), gqlTypes: body.errors.map((e) => e.type).filter((t): t is string => typeof t === 'string') };
      throw err;
    }
    if (!body.data) throw new GitHubError('graphql', t('GitHub 回应缺少 data'));
    return body.data;
  }

  /**
   * One REST write (or read) that is not a list. Returns the parsed JSON body,
   * or null for an empty answer (204). Errors carry GitHub's own message.
   */
  async rest<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T | null> {
    const res = await this.send(`${this.endpoints.api}${path}`, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
    });
    if (res.status === 204) return null;
    const text = await res.text().catch(() => '');
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new GitHubError('network', t('GitHub 回应不完整：{why}', { why: (e as Error).message }));
    }
  }

  /** POST that answers with text (GitHub's markdown renderer). */
  async restText(path: string, body: unknown): Promise<string> {
    const res = await this.send(`${this.endpoints.api}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Accept: 'text/html' },
    });
    return res.text();
  }

  /**
   * GitHub#261: one conditional request of the change check. `etag` from an earlier answer
   * goes out as If-None-Match; GitHub answers 304 (nothing changed, not counted against the
   * quota) or 200 with the current version tag. Any other answer throws, like every request —
   * and so does a 200 or 304 without a version tag (nothing to compare with: not "unchanged").
   * HEAD reads headers only; GET also returns the parsed body (null for HEAD / 304).
   * `pathOrUrl` is an API path or a full URL from an earlier `next` (same API origin only).
   */
  async conditional(method: 'GET' | 'HEAD', pathOrUrl: string, etag: string | null): Promise<ConditionalAnswer> {
    const url = /^https?:/.test(pathOrUrl) ? pathOrUrl : `${this.endpoints.api}${pathOrUrl}`;
    if (new URL(url).origin !== new URL(this.endpoints.api).origin) throw new GitHubError('http', t('拒绝跟随指向其他主机的链接：{url}', { url }));
    const res = await this.again(() => this.send(url, { method, ...(etag ? { headers: { 'If-None-Match': etag } } : {}) }, true));
    const tag = res.headers.get('etag');
    const next = nextLink(res.headers.get('link'));
    // an answer without a version tag says nothing checkable — "not modified" included (PR #272 review round 1)
    if ((res.status === 304 || res.status === 200) && !tag) throw new GitHubError('http', t('变化检查：HTTP {status} 的回答没有版本标记', { status: res.status }), res.status);
    if (res.status === 304) return { status: 304, etag: tag!, next, body: null };
    // only a plain 200 says "this is the current version"; any other success is not checkable
    if (res.status !== 200) throw new GitHubError('http', t('变化检查收到意外的 HTTP {status}', { status: res.status }), res.status);
    let body: unknown = null;
    if (method === 'GET') {
      try {
        body = await res.json();
      } catch (e) {
        throw new GitHubError('network', t('GitHub 回应不完整：{why}', { why: (e as Error).message }));
      }
    }
    return { status: 200, etag: tag!, next, body };
  }

  /** GET a REST list endpoint and follow every `Link: rel="next"` page. */
  async restList<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = `${this.endpoints.api}${path}`;
    const origin = new URL(this.endpoints.api).origin;
    while (url) {
      if (new URL(url).origin !== origin) throw new GitHubError('http', t('拒绝跟随指向其他主机的分页链接：{url}', { url }));
      const at: string = url;
      const res = await this.again(() => this.send(at, { method: 'GET' }));
      let page: unknown;
      try {
        page = await res.json();
      } catch (e) {
        throw new GitHubError('network', t('GitHub 回应不完整：{why}', { why: (e as Error).message }));
      }
      if (!Array.isArray(page)) throw new GitHubError('http', t('GitHub 列表接口回应不是数组：{path}', { path }));
      out.push(...(page as T[]));
      url = nextLink(res.headers.get('link'));
    }
    return out;
  }
}

export interface ConditionalAnswer {
  status: 200 | 304;
  /** the version tag GitHub sent (an answer without one throws: it is not checkable) */
  etag: string;
  /** `Link: rel="next"` (GitHub sends none with a 304) */
  next: string | null;
  body: unknown;
}

export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (m && m[2].split(/\s+/).includes('next')) return m[1];
  }
  return null;
}
