// GitHub#545: the sync never spends more than half of the account's hourly quota.
//
// GitHub counts two quotas per account and hour: GraphQL points and REST calls (`core`). The
// sync's own GitHub client sends every request through one QuotaGuard:
//
//   - one request at a time (a queue), so two requests can never both pass on the same
//     "remaining" figure;
//   - before each request: remaining − reservations − this request's most ≥ limit / 2, else
//     the request is not sent (QuotaHeldError, `sent` = false);
//   - after each answer: remaining / limit / reset taken from the answer's own headers
//     (x-ratelimit-*; a 304 carries them too);
//   - an answer whose outcome is not known (no answer, cut off, no rate-limit headers): GitHub
//     may still have charged it, possibly late. Its worst cost is reserved until the reset of
//     the window it was sent in — or of the next one when that reset is less than SETTLE_MS
//     after the request went out. A reservation is never cleared by "used went up": the count
//     is the whole account's, other programs spend from it too (#545 design review round 4).
//   - the remaining figures come from GitHub's rate-limit endpoint (`/rate_limit`, not counted
//     against either quota) at the start of each round; unknown = no request at all.
//
// Persisted across restarts: the time of the last request whose outcome may still be open (a
// setting, written before each send — a write that fails sends nothing — and cleared once every
// request sent so far has its answer and none had an unknown outcome within SETTLE_MS). On start,
// nothing is sent until SETTLE_MS after that time: by then every request of the previous run has
// been charged or dropped by GitHub (assumption: GitHub ends a request within SETTLE_MS; its
// documented query limit is 10 s), and the rate-limit endpoint's figures include it. A run that
// ended with everything answered left nothing open: no wait.

import { GitHubError, MAX_LIMIT_WAIT_MS, type QuotaResource } from './github';
export { resourceOf, graphqlCost, type QuotaResource } from './github';
import { t } from '../shared/i18n';

/** GitHub ends (charges or drops) a request within this time after it went out (assumption, see above). */
export const SETTLE_MS = 2 * 60_000;

/** the account's own figures for one quota */
export interface QuotaBucket {
  limit: number;
  remaining: number;
  used: number;
  /** epoch ms (GitHub's x-ratelimit-reset × 1000) */
  resetAt: number;
}

export interface QuotaReading {
  graphql: QuotaBucket;
  core: QuotaBucket;
}

interface Reservation {
  resource: QuotaResource;
  cost: number;
  /** cleared once this time is reached (epoch ms) */
  until: number;
}

/**
 * Not sent: the request would take this quota below half of its limit (or the figures are not
 * known). Not a failure of the source: nothing was asked.
 */
export class QuotaHeldError extends GitHubError {
  readonly sent = false;
  constructor(
    readonly resource: QuotaResource | null,
    /** when the quota that held it resets (epoch ms); null = not known */
    readonly resetAt: number | null,
    message: string,
  ) {
    super('http', message);
    this.name = 'QuotaHeldError';
  }
}

/** a whole, non-negative number, or null */
function count(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** one bucket from the rate-limit endpoint's `resources.<name>`, or null when anything is missing / malformed */
export function bucketOf(raw: unknown): QuotaBucket | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const limit = count(r.limit);
  const remaining = count(r.remaining);
  const used = count(r.used);
  const reset = count(r.reset);
  if (limit === null || limit === 0 || remaining === null || used === null || reset === null || remaining > limit) return null;
  return { limit, remaining, used, resetAt: reset * 1000 };
}

/** the figures an answer's headers carry, or null when any is missing / malformed */
export function bucketFromHeaders(h: Headers): { resource: QuotaResource; bucket: QuotaBucket } | null {
  const name = h.get('x-ratelimit-resource');
  const resource: QuotaResource | null = name === 'graphql' ? 'graphql' : name === 'core' ? 'core' : null;
  if (!resource) return null;
  const b = bucketOf({ limit: h.get('x-ratelimit-limit'), remaining: h.get('x-ratelimit-remaining'), used: h.get('x-ratelimit-used'), reset: h.get('x-ratelimit-reset') });
  return b ? { resource, bucket: b } : null;
}

export interface QuotaDeps {
  now: () => number;
  /** writes the time of the request about to go out (null = nothing open any more); false / a throw = not written (nothing is sent) */
  noteSend: (at: number | null) => Promise<boolean>;
}

/** what the window shows of one quota */
export interface QuotaView {
  resource: QuotaResource;
  limit: number;
  used: number;
  remaining: number;
  resetAt: number;
  /** reserved for requests whose outcome is not known */
  reserved: number;
}

export class QuotaGuard {
  private figures: Partial<Record<QuotaResource, QuotaBucket>> = {};
  /** true once this round read the rate-limit endpoint; false = nothing may be sent */
  private known = false;
  private reservations: Reservation[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  /** no request before this (epoch ms): SETTLE_MS after the last send of an earlier run */
  private quietUntil = 0;
  /** requests queued or on their way */
  private inFlight = 0;
  /** the latest request whose outcome was not known (epoch ms of its send); the record stays until SETTLE_MS after it */
  private lastUnknownAt = -Infinity;
  /** what the record on disk says: true = a time is written (something may be open) */
  private recordOpen = true;

  constructor(private readonly deps: QuotaDeps) {}

  /** On start: hold every request until SETTLE_MS after `lastSend` (null = never sent; NaN / unreadable = wait SETTLE_MS from now). */
  startAfter(lastSend: number | null | 'unreadable'): void {
    const now = this.deps.now();
    if (lastSend === 'unreadable') this.quietUntil = now + SETTLE_MS;
    else if (lastSend !== null) this.quietUntil = Math.min(lastSend + SETTLE_MS, now + SETTLE_MS);
  }

  /** epoch ms until which nothing is sent after a restart (0 = not waiting) */
  quietTill(): number {
    return this.deps.now() < this.quietUntil ? this.quietUntil : 0;
  }

  /** A round starts without figures: until `takeReading`, nothing may be sent. */
  forget(): void {
    this.known = false;
  }

  /** The rate-limit endpoint's answer (`resources`), or null when it could not be read. */
  takeReading(r: QuotaReading | null): void {
    this.prune();
    if (!r) {
      this.known = false;
      return;
    }
    this.figures = { graphql: r.graphql, core: r.core };
    this.known = true;
  }

  isKnown(): boolean {
    return this.known;
  }

  /** what the window shows (null = not known this round) */
  view(resource: QuotaResource): QuotaView | null {
    const b = this.figures[resource];
    if (!this.known || !b) return null;
    return { resource, limit: b.limit, used: b.used, remaining: b.remaining, resetAt: b.resetAt, reserved: this.reserved(resource) };
  }

  private prune(): void {
    const now = this.deps.now();
    this.reservations = this.reservations.filter((r) => r.until > now);
  }

  private reserved(resource: QuotaResource): number {
    this.prune();
    return this.reservations.filter((r) => r.resource === resource).reduce((n, r) => n + r.cost, 0);
  }

  /** would a request of `cost` on `resource` pass now? (the same rule `send` applies) */
  allows(resource: QuotaResource, cost: number): boolean {
    if (!this.known || this.deps.now() < this.quietUntil) return false;
    const b = this.figures[resource];
    if (!b || this.deps.now() >= b.resetAt) return false;
    return b.remaining - this.reserved(resource) - cost >= b.limit / 2;
  }

  /**
   * One request through the guard: queued behind every earlier one, checked, its time written,
   * sent, and its answer's figures taken (or its worst cost reserved when the outcome is unknown).
   */
  send(resource: QuotaResource, cost: number, go: () => Promise<Response>, admit?: () => void, given?: AbortSignal): Promise<Response> {
    this.inFlight++;
    const run = this.queue
      .then(() => this.sendNow(resource, cost, go, admit, given))
      .finally(async () => {
        this.inFlight--;
        // the last one in the queue, everything answered and nothing unknown lately: nothing is open at GitHub
        if (this.inFlight === 0 && this.recordOpen && this.deps.now() >= this.lastUnknownAt + SETTLE_MS) {
          try {
            if (await this.deps.noteSend(null)) this.recordOpen = false;
          } catch {
            /* stays open: the next start waits, which is only careful */
          }
        }
      });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async sendNow(resource: QuotaResource, cost: number, go: () => Promise<Response>, admit?: () => void, given?: AbortSignal): Promise<Response> {
    // checks that belong to the moment of sending (the read gate, a round given up on): a throw sends nothing
    admit?.();
    const now = this.deps.now();
    if (now < this.quietUntil) throw new QuotaHeldError(null, this.quietUntil, t('刚重新打开，等上次关闭前的请求结清后再读 GitHub'));
    if (!this.known) throw new QuotaHeldError(null, null, t('读不到这个账号本小时的 GitHub 额度，这一轮不发会扣额度的请求'));
    const b = this.figures[resource];
    if (!b || now >= b.resetAt) throw new QuotaHeldError(resource, null, t('这个账号本小时的 GitHub 额度已过期，等下一轮重新读'));
    if (!this.allows(resource, cost)) throw new QuotaHeldError(resource, b.resetAt, t('额度保护中：这个账号本小时的 GitHub 额度只剩 {left} / {limit}，客户端最多用到一半', { left: b.remaining, limit: b.limit }));
    let written = false;
    try {
      written = await this.deps.noteSend(now);
    } catch {
      written = false;
    }
    if (!written) throw new GitHubError('http', t('本机记录发送时间失败，这个请求没有发出'));
    this.recordOpen = true;
    let res: Response;
    try {
      // a round given up on stops waiting for its request: the queue goes on (the request's worst
      // cost stays reserved — its answer, whenever it comes, is not read)
      res = given ? await raceAbort(go(), given) : await go();
    } catch (e) {
      // no answer: GitHub may have charged it, possibly late
      this.reserve(resource, cost, now, b.resetAt);
      throw e;
    }
    const heard = bucketFromHeaders(res.headers);
    if (heard && heard.resource === resource) this.figures[resource] = heard.bucket;
    else this.reserve(resource, cost, now, b.resetAt);
    return res;
  }

  private reserve(resource: QuotaResource, cost: number, sentAt: number, resetAt: number): void {
    this.lastUnknownAt = Math.max(this.lastUnknownAt, sentAt);
    const worst = resource === 'graphql' ? Math.max(1, Math.ceil(cost * 2)) : 1;
    // charged in the window it was sent in, or — when that window ends within SETTLE_MS — maybe the next one
    const until = resetAt - sentAt >= SETTLE_MS ? resetAt : resetAt + 60 * 60_000;
    this.reservations.push({ resource, cost: worst, until: Math.min(until, sentAt + MAX_LIMIT_WAIT_MS + 60 * 60_000) });
  }
}

/** `p`, or a rejection as soon as `signal` aborts (the request itself is not stopped: only no longer waited for) */
function givenUp(): GitHubError {
  const e = new GitHubError('network', t('已放弃这一轮同步'));
  e.meta.cancelled = true;
  return e;
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(givenUp());
  }
  return new Promise<T>((resolve, reject) => {
    const off = () => {
      p.catch(() => undefined);
      reject(givenUp());
    };
    signal.addEventListener('abort', off, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', off);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', off);
        reject(e);
      },
    );
  });
}

/** GitHub#545: the rate-limit endpoint's answer → both buckets, or null when either is not whole */
export function readingOf(body: unknown): QuotaReading | null {
  const res = (body as { resources?: Record<string, unknown> } | null)?.resources;
  if (!res || typeof res !== 'object') return null;
  const graphql = bucketOf(res.graphql);
  const core = bucketOf(res.core);
  return graphql && core ? { graphql, core } : null;
}

