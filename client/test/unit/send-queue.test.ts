// GigleAI/cavil-loop#558 (the queue from #545): every request of the sync leaves one at a time, and
// nothing else — no quota of the client's own. A request is never held back because of how much of
// the account's quota is used; the check at the moment of sending (the read gate, a round given up
// on) still stops it; a round given up on stops waiting and the queue goes on.

import { describe, expect, it } from 'vitest';
import { SendQueue } from '../../src/data/sendQueue';
import { GitHubError } from '../../src/data/github';

/** an answer that says only 10 of the account's 5000 GraphQL points are left */
function nearlySpent(): Response {
  return new Response('{}', {
    status: 200,
    headers: { 'x-ratelimit-resource': 'graphql', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '10', 'x-ratelimit-used': '4990', 'x-ratelimit-reset': '4102444800' },
  });
}

function deferred() {
  let resolve!: (r: Response) => void;
  const p = new Promise<Response>((r) => (resolve = r));
  return { p, resolve };
}

describe('one at a time, no quota of its own', () => {
  it('the account nearly spent: every request still goes (only GitHub refuses)', async () => {
    const q = new SendQueue();
    let sent = 0;
    for (let i = 0; i < 20; i++) {
      const r = await q.send(async () => {
        sent++;
        return nearlySpent();
      });
      expect(r.status).toBe(200);
    }
    expect(sent).toBe(20);
  });

  it('the second waits for the first answer before it goes: never two on their way', async () => {
    const q = new SendQueue();
    const first = deferred();
    const order: string[] = [];
    const a = q.send(() => {
      order.push('a sent');
      return first.p;
    });
    const b = q.send(async () => {
      order.push('b sent');
      return new Response('{}');
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['a sent']);
    first.resolve(new Response('{}'));
    await a;
    await b;
    expect(order).toEqual(['a sent', 'b sent']);
  });

  it('a check at the moment of sending that throws (the read gate closed meanwhile): not sent, the queue goes on', async () => {
    const q = new SendQueue();
    let sent = 0;
    const refused = new GitHubError('http', 'gate closed');
    await expect(
      q.send(
        async () => {
          sent++;
          return new Response('{}');
        },
        () => {
          throw refused;
        },
      ),
    ).rejects.toBe(refused);
    expect(sent).toBe(0);
    await q.send(async () => {
      sent++;
      return new Response('{}');
    });
    expect(sent).toBe(1);
  });

  it('a round given up on while its request is on its way: it stops waiting at once, the queue goes on', async () => {
    const q = new SendQueue();
    const stuck = deferred();
    const given = new AbortController();
    const a = q.send(() => stuck.p, undefined, given.signal);
    given.abort();
    await expect(a).rejects.toMatchObject({ meta: { cancelled: true } });
    const b = await q.send(async () => new Response('next'));
    expect(await b.text()).toBe('next');
    stuck.resolve(new Response('late'));
  });

  it('a request that fails: the queue goes on with the next', async () => {
    const q = new SendQueue();
    await expect(q.send(() => Promise.reject(new TypeError('connection reset')))).rejects.toThrow('connection reset');
    expect((await q.send(async () => new Response('ok'))).status).toBe(200);
  });
});
