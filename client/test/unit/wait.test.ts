// GitHub#649: the shared wait (test/support/wait.ts) stops when its test times out or ends — it reads
// nothing more after that — and says what it was waiting for.
import { describe, expect, it } from 'vitest';
import { WaitStopped, waitUntil } from '../support/wait';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the shared wait', () => {
  const timedOut = { calls: 0, err: null as unknown };
  it.fails(
    'a condition that never holds: the wait ends with its test (this test is meant to time out)',
    async () => {
      try {
        await waitUntil(
          () => {
            timedOut.calls++;
            return false;
          },
          '永远不成立的条件',
          () => ({ calls: timedOut.calls }),
        );
      } catch (e) {
        timedOut.err = e;
        throw e;
      }
    },
    300,
  );

  it('…after which it reads nothing more, and said what it waited for and what it last saw', async () => {
    await sleep(50);
    const before = timedOut.calls;
    expect(before).toBeGreaterThan(0);
    await sleep(200);
    expect(timedOut.calls).toBe(before);
    expect(timedOut.err).toBeInstanceOf(WaitStopped);
    expect(String((timedOut.err as Error).message)).toContain('在等：永远不成立的条件');
    expect(String((timedOut.err as Error).message)).toContain('最后一次看到');
  });

  const ended = { calls: 0, settled: null as Promise<unknown> | null };
  it('a wait still running when its test ends normally…', async () => {
    ended.settled = waitUntil(() => (ended.calls++, false), '用例结束后不该再看').then(
      () => 'resolved',
      (e) => e,
    );
    await sleep(30);
  });

  it('…stops and reads nothing more', async () => {
    const r = await ended.settled;
    expect(r).toBeInstanceOf(WaitStopped);
    const n = ended.calls;
    await sleep(100);
    expect(ended.calls).toBe(n);
  });

  it('returns as soon as the condition holds', async () => {
    let n = 0;
    await waitUntil(() => ++n >= 3, '第三次');
    expect(n).toBe(3);
  });
});
