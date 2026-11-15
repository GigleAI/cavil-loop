// GigleAI/cavil-loop#545: the quota guard on its own — every sync request goes through it, one at a
// time, never taking the account's hourly quota below half; requests whose outcome is not known keep
// their worst cost reserved until the window they may be charged in is over; after a restart nothing
// is sent until the previous run's requests are settled. The answers here are real Response objects
// with GitHub's x-ratelimit-* headers; the clock is moved by hand.

import { describe, expect, it } from 'vitest';
import { QuotaGuard, QuotaHeldError, SETTLE_MS, bucketFromHeaders, readingOf, type QuotaReading } from '../../src/data/quota';
import { GitHubError } from '../../src/data/github';

const MIN = 60_000;
const T0 = Date.parse('2026-11-15T03:00:00Z');
const RESET = T0 + 40 * MIN;

function harness(opts: { lastSend?: number | null | 'unreadable'; write?: (at: number | null) => boolean } = {}) {
  const clock = { t: T0 };
  const writes: (number | null)[] = [];
  const g = new QuotaGuard({
    now: () => clock.t,
    noteSend: async (at) => {
      const ok = opts.write ? opts.write(at) : true;
      if (ok) writes.push(at);
      return ok;
    },
  });
  if (opts.lastSend !== undefined) g.startAfter(opts.lastSend);
  return { g, clock, writes };
}

/** GitHub's figures for both quotas */
function reading(graphqlRemaining: number, coreRemaining = 5000, reset = RESET): QuotaReading {
  return {
    graphql: { limit: 5000, remaining: graphqlRemaining, used: 5000 - graphqlRemaining, resetAt: reset },
    core: { limit: 5000, remaining: coreRemaining, used: 5000 - coreRemaining, resetAt: reset },
  };
}

/** an answer that says the quota now has `remaining` left */
function answer(resource: 'graphql' | 'core', remaining: number, reset = RESET): Response {
  return new Response('{}', {
    status: 200,
    headers: {
      'x-ratelimit-resource': resource,
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': String(remaining),
      'x-ratelimit-used': String(5000 - remaining),
      'x-ratelimit-reset': String(reset / 1000),
    },
  });
}

/** a fake GitHub account: every request costs `cost`, and its answer tells the new remaining */
function account(start: number) {
  const s = { remaining: start, sent: 0 };
  const go = (cost: number, resource: 'graphql' | 'core' = 'graphql') => async () => {
    s.sent++;
    s.remaining -= cost;
    return answer(resource, s.remaining);
  };
  return { s, go };
}

describe('the floor: never below half of the hourly quota', () => {
  it('2510 left, 8 points a request: it sends while 8 more still leaves 2500, then holds every request', async () => {
    const { g } = harness();
    g.takeReading(reading(2510));
    const a = account(2510);
    const results: string[] = [];
    for (let i = 0; i < 4; i++) {
      results.push(
        await g.send('graphql', 8, a.go(8)).then(
          () => 'sent',
          (e) => (e instanceof QuotaHeldError ? 'held' : 'error'),
        ),
      );
    }
    // 2510 → 2502 (one sent); 2502 − 8 < 2500: held from there on
    expect(results).toEqual(['sent', 'held', 'held', 'held']);
    expect(a.s.sent).toBe(1);
    expect(a.s.remaining).toBeGreaterThanOrEqual(2500);
  });

  it('the figures not read this round: nothing is sent at all', async () => {
    const { g } = harness();
    g.takeReading(null);
    const a = account(5000);
    await expect(g.send('graphql', 1, a.go(1))).rejects.toBeInstanceOf(QuotaHeldError);
    await expect(g.send('core', 1, a.go(1, 'core'))).rejects.toBeInstanceOf(QuotaHeldError);
    expect(a.s.sent).toBe(0);
    // control: the same requests with the figures known go out
    g.takeReading(reading(5000));
    await g.send('graphql', 1, a.go(1));
    expect(a.s.sent).toBe(1);
  });

  it('REST has its own floor: GraphQL plenty, REST at half → REST held, GraphQL sent', async () => {
    const { g } = harness();
    g.takeReading(reading(5000, 2500));
    const a = account(5000);
    await expect(g.send('core', 1, a.go(1, 'core'))).rejects.toBeInstanceOf(QuotaHeldError);
    await g.send('graphql', 1, a.go(1));
    expect(a.s.sent).toBe(1);
  });

  it('the actual cost is twice the estimate: it goes below half by at most that one request, then holds', async () => {
    const { g } = harness();
    g.takeReading(reading(2520));
    const a = account(2520);
    const out: string[] = [];
    for (let i = 0; i < 3; i++) out.push(await g.send('graphql', 8, a.go(16)).then(() => 'sent', () => 'held'));
    expect(out).toEqual(['sent', 'held', 'held']);
    expect(a.s.remaining).toBe(2504);
    // the next decision takes GitHub's figure (2504), not the estimate: 2504 − 8 < 2500
    expect(g.allows('graphql', 8)).toBe(false);
  });
});

describe('one at a time: two requests never pass on the same figure', () => {
  it('two sources reach the guard together at 2502, each 2 points: the first goes, the second is held', async () => {
    const { g } = harness();
    g.takeReading(reading(2502));
    const a = account(2502);
    const both = await Promise.allSettled([g.send('graphql', 2, a.go(2)), g.send('graphql', 2, a.go(2))]);
    expect(both.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((both[1] as PromiseRejectedResult).reason).toBeInstanceOf(QuotaHeldError);
    expect(a.s.sent).toBe(1);
    expect(a.s.remaining).toBe(2500);
  });

  it('the second waits for the first answer before it goes: never two on their way', async () => {
    const { g } = harness();
    g.takeReading(reading(5000));
    let open = 0;
    let most = 0;
    const go = () => async () => {
      open++;
      most = Math.max(most, open);
      await new Promise((r) => setTimeout(r, 20));
      open--;
      return answer('graphql', 4990);
    };
    await Promise.all([g.send('graphql', 1, go()), g.send('graphql', 1, go()), g.send('core', 1, go())]);
    expect(most).toBe(1);
  });

  it('a check at the moment of sending that throws (the read gate closed meanwhile): not sent, nothing reserved', async () => {
    const { g } = harness();
    g.takeReading(reading(5000));
    const a = account(5000);
    const gate = new GitHubError('http', 'closed');
    await expect(
      g.send('graphql', 8, a.go(8), () => {
        throw gate;
      }),
    ).rejects.toBe(gate);
    expect(a.s.sent).toBe(0);
    expect(g.view('graphql')!.reserved).toBe(0);
  });
});

describe('a request whose outcome is not known keeps its worst cost reserved', () => {
  it('timed out, charged later by GitHub: the 16 points stay reserved until the window resets — "used went up" clears nothing', async () => {
    const { g, clock } = harness();
    g.takeReading(reading(2520));
    // a request that never answers
    await expect(g.send('graphql', 8, async () => Promise.reject(new Error('timeout')))).rejects.toThrow('timeout');
    expect(g.view('graphql')!.reserved).toBe(16);
    // 2520 − 16 − 8 < 2500: held
    expect(g.allows('graphql', 8)).toBe(false);
    // GitHub charges it late (8 points) and another program spends 16 more: the next reading says so
    clock.t += MIN;
    g.takeReading(reading(2520 - 8 - 16));
    expect(g.view('graphql')!.reserved).toBe(16);
    expect(g.allows('graphql', 1)).toBe(false);
    // a new window: nothing of the old one is reserved any more, sending goes on
    clock.t = RESET + 1;
    g.takeReading(reading(5000, 5000, RESET + 60 * MIN));
    expect(g.view('graphql')!.reserved).toBe(0);
    expect(g.allows('graphql', 8)).toBe(true);
  });

  it('three timeouts in a row: the reservations add up (and the guard holds earlier)', async () => {
    const { g } = harness();
    g.takeReading(reading(5000));
    for (let i = 0; i < 3; i++) await g.send('graphql', 8, async () => Promise.reject(new Error('timeout'))).catch(() => undefined);
    expect(g.view('graphql')!.reserved).toBe(48);
    g.takeReading(reading(2560));
    expect(g.allows('graphql', 8)).toBe(true); // 2560 − 48 − 8 = 2504
    expect(g.allows('graphql', 16)).toBe(false);
  });

  it('an answer without the rate-limit headers is not known either', async () => {
    const { g } = harness();
    g.takeReading(reading(5000));
    await g.send('core', 1, async () => new Response('{}', { status: 200 }));
    expect(g.view('core')!.reserved).toBe(1);
  });

  it('sent less than SETTLE_MS before the window resets: it may be charged in the next window, so it stays reserved there', async () => {
    const { g, clock } = harness();
    clock.t = RESET - 30_000;
    g.takeReading(reading(5000));
    await g.send('graphql', 8, async () => Promise.reject(new Error('timeout'))).catch(() => undefined);
    clock.t = RESET + 30_000;
    g.takeReading(reading(5000, 5000, RESET + 60 * MIN));
    expect(g.view('graphql')!.reserved).toBe(16);
    clock.t = RESET + 60 * MIN + 1;
    g.takeReading(reading(5000, 5000, RESET + 120 * MIN));
    expect(g.view('graphql')!.reserved).toBe(0);
  });

  it('a round given up on while its request is on its way: the queue goes on, the request stays reserved', async () => {
    const { g } = harness();
    g.takeReading(reading(5000));
    const stop = new AbortController();
    let late!: (r: Response) => void;
    const first = g.send('graphql', 8, () => new Promise<Response>((r) => (late = r)), undefined, stop.signal);
    const second = g.send('graphql', 1, async () => answer('graphql', 4990));
    stop.abort();
    await expect(first).rejects.toBeInstanceOf(GitHubError);
    await expect(second).resolves.toBeInstanceOf(Response);
    late(answer('graphql', 4000)); // its answer, whenever it comes, is not read
    expect(g.view('graphql')!.reserved).toBe(16);
  });
});

describe('the time of the last request on disk, and the wait after a restart', () => {
  it('written before every request; a write that fails sends nothing', async () => {
    let ok = true;
    const { g, writes } = harness({ write: () => ok });
    g.takeReading(reading(5000));
    const a = account(5000);
    await g.send('graphql', 1, a.go(1));
    expect(writes[0]).toBe(T0);
    ok = false;
    await expect(g.send('graphql', 1, a.go(1))).rejects.toThrow('本机记录发送时间失败');
    expect(a.s.sent).toBe(1);
  });

  it('every request answered and nothing unknown lately: the record is cleared (a restart then waits for nothing)', async () => {
    const { g, writes } = harness();
    g.takeReading(reading(5000));
    const a = account(5000);
    await Promise.all([g.send('graphql', 1, a.go(1)), g.send('core', 1, a.go(1, 'core'))]);
    await new Promise((r) => setTimeout(r, 0));
    expect(writes.at(-1)).toBeNull();
    // one with an unknown outcome: the record stays (a restart must wait)
    await g.send('graphql', 1, async () => Promise.reject(new Error('cut'))).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(writes.at(-1)).toBe(T0);
  });

  it('restarted 30 s after the last request: nothing until 2 minutes after it; then it goes', async () => {
    const { g, clock } = harness({ lastSend: T0 - 30_000 });
    g.takeReading(reading(5000));
    const a = account(5000);
    expect(g.quietTill()).toBe(T0 - 30_000 + SETTLE_MS);
    await expect(g.send('graphql', 1, a.go(1))).rejects.toBeInstanceOf(QuotaHeldError);
    clock.t = T0 - 30_000 + SETTLE_MS;
    await g.send('graphql', 1, a.go(1));
    expect(a.s.sent).toBe(1);
  });

  it('restarted again while waiting: the wait still counts from that same last request', () => {
    const first = harness({ lastSend: T0 - 30_000 });
    const second = harness({ lastSend: T0 - 30_000 });
    second.clock.t = T0 + 20_000;
    expect(second.g.quietTill()).toBe(first.g.quietTill());
  });

  it('the record cannot be read: 2 minutes from the start; none (never sent, or cleared): no wait', () => {
    const unreadable = harness({ lastSend: 'unreadable' });
    expect(unreadable.g.quietTill()).toBe(T0 + SETTLE_MS);
    const none = harness({ lastSend: null });
    expect(none.g.quietTill()).toBe(0);
  });
});

describe('reading GitHub\'s figures', () => {
  it('the rate-limit endpoint: both quotas or nothing', () => {
    const r = readingOf({ resources: { core: { limit: 5000, used: 10, remaining: 4990, reset: 1794713268 }, graphql: { limit: 5000, used: 295, remaining: 4705, reset: 1794713268 } } });
    expect(r).toEqual({
      core: { limit: 5000, used: 10, remaining: 4990, resetAt: 1794713268000 },
      graphql: { limit: 5000, used: 295, remaining: 4705, resetAt: 1794713268000 },
    });
    expect(readingOf({ resources: { core: { limit: 5000, used: 10, remaining: 4990, reset: 1 } } })).toBeNull();
    expect(readingOf({ resources: { core: { limit: 5000, used: 10, remaining: 'x', reset: 1 }, graphql: { limit: 5000, used: 0, remaining: 5000, reset: 1 } } })).toBeNull();
    expect(readingOf('not json')).toBeNull();
  });

  it('an answer\'s headers: the resource it drew on, or nothing when any figure is missing', () => {
    expect(bucketFromHeaders(answer('core', 4000).headers)).toEqual({ resource: 'core', bucket: { limit: 5000, remaining: 4000, used: 1000, resetAt: RESET } });
    const h = new Headers({ 'x-ratelimit-resource': 'graphql', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '10' });
    expect(bucketFromHeaders(h)).toBeNull();
    expect(bucketFromHeaders(new Headers({ 'x-ratelimit-resource': 'search', 'x-ratelimit-limit': '30', 'x-ratelimit-remaining': '1', 'x-ratelimit-used': '29', 'x-ratelimit-reset': '1' }))).toBeNull();
  });
});
