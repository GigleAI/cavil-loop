// GitHub#649: the one "wait until this is true" of the unit tests. It has no time limit of its own:
// the limit is the test's. When the test times out or is cancelled (vitest aborts the test's signal)
// or the test ends, the wait stops at once — it clears its timer and reads nothing more — and fails
// with what it was waiting for and the last thing it saw. Outside a test (a hook) it gives up after
// `HOOK_LIMIT_MS`, since hooks have no signal of their own.

import { TestRunner, onTestFinished } from 'vitest';

const HOOK_LIMIT_MS = 20_000;
const POLL_MS = 10;

/** tests whose end has already been registered (one hook per test, not per wait) */
const ended = new WeakMap<object, { done: boolean }>();

function testState(): { signal: AbortSignal | null; end: { done: boolean } | null } {
  const t = TestRunner.getCurrentTest() as { context?: { signal?: AbortSignal } } | undefined;
  if (!t) return { signal: null, end: null };
  let end = ended.get(t);
  if (!end) {
    const e = { done: false };
    end = e;
    ended.set(t, e);
    onTestFinished(() => {
      e.done = true;
    });
  }
  return { signal: t.context?.signal ?? null, end };
}

export class WaitStopped extends Error {}

/**
 * Wait until `pred()` holds. `show` describes the current value for the failure message.
 * Resolves as soon as `pred()` is true; rejects when the test times out, is cancelled or ends.
 */
export async function waitUntil(pred: () => boolean, what: string, show?: () => unknown): Promise<void> {
  const { signal, end } = testState();
  const deadline = signal ? Infinity : Date.now() + HOOK_LIMIT_MS;
  const last = () => {
    if (!show) return '';
    try {
      return `，最后一次看到：${JSON.stringify(show())}`;
    } catch {
      return '';
    }
  };
  for (;;) {
    if (signal?.aborted || end?.done) throw new WaitStopped(`在等：${what}（用例已结束或超时）${last()}`);
    if (pred()) return;
    if (Date.now() > deadline) throw new WaitStopped(`在等：${what}（准备步骤等了 ${HOOK_LIMIT_MS} ms）${last()}`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, POLL_MS);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}
