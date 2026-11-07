// Minimal GitHub HTTP client. Only ever talks to the two configured bases
// (production: https://api.github.com and https://github.com); pagination
// links that point anywhere else are refused so the token never leaves them.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Endpoints {
  /** REST + GraphQL base, e.g. https://api.github.com */
  api: string;
  /** web base used for the OAuth device flow, e.g. https://github.com */
  web: string;
}

export const GITHUB_ENDPOINTS: Endpoints = { api: 'https://api.github.com', web: 'https://github.com' };

export type GitHubErrorKind = 'network' | 'auth' | 'http' | 'graphql';

export class GitHubError extends Error {
  constructor(
    readonly kind: GitHubErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

const USER_AGENT = 'cavil-loop-client';

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
  ) {}

  private async send(url: string, init: RequestInit): Promise<Response> {
    if (this.cancelled?.aborted) throw new GitHubError('network', '已放弃这一轮同步');
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
      throw new GitHubError('network', `无法连接 GitHub：${(e as Error).message}`);
    }
    if (res.status === 401) throw new GitHubError('auth', 'GitHub 凭据无效（可能已被撤销或过期）', 401);
    if (!res.ok) {
      let detail = '';
      try {
        detail = ((await res.json()) as { message?: string }).message ?? '';
      } catch {
        /* body not JSON */
      }
      throw new GitHubError('http', `GitHub 返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`, res.status);
    }
    return res;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.send(`${this.endpoints.api}/graphql`, {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
      headers: { 'Content-Type': 'application/json' },
    });
    let body: { data?: T; errors?: { message: string; type?: string }[] };
    try {
      body = (await res.json()) as typeof body;
    } catch (e) {
      throw new GitHubError('network', `GitHub 回应不完整：${(e as Error).message}`);
    }
    if (body.errors && body.errors.length) {
      throw new GitHubError('graphql', body.errors.map((e) => e.message).join('；'));
    }
    if (!body.data) throw new GitHubError('graphql', 'GitHub 回应缺少 data');
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
      throw new GitHubError('network', `GitHub 回应不完整：${(e as Error).message}`);
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

  /** GET a REST list endpoint and follow every `Link: rel="next"` page. */
  async restList<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = `${this.endpoints.api}${path}`;
    const origin = new URL(this.endpoints.api).origin;
    while (url) {
      if (new URL(url).origin !== origin) throw new GitHubError('http', `拒绝跟随指向其他主机的分页链接：${url}`);
      const res = await this.send(url, { method: 'GET' });
      let page: unknown;
      try {
        page = await res.json();
      } catch (e) {
        throw new GitHubError('network', `GitHub 回应不完整：${(e as Error).message}`);
      }
      if (!Array.isArray(page)) throw new GitHubError('http', `GitHub 列表接口回应不是数组：${path}`);
      out.push(...(page as T[]));
      url = nextLink(res.headers.get('link'));
    }
    return out;
  }
}

export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (m && m[2].split(/\s+/).includes('next')) return m[1];
  }
  return null;
}
