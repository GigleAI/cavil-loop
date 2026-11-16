// GitHub#545 / #558: the sync's requests leave one at a time.
//
// GitHub asks clients to send one account's requests one after another, not side by side — side by
// side is what trips its short-time ("secondary") rate limit. One queue per controller: every request
// of the sync waits for the one before it to be answered. A refusal is read while the request still
// holds its turn, so a rate limit closes the read gate before the next request is let through (the
// `admit` check of that next request then refuses it without sending).
//
// There is no quota of the client's own any more (GitHub#558: the maintainer found keeping half of the
// account's hourly quota too careful): the client reads as long as GitHub answers, and says so only
// when GitHub itself refuses with a rate limit.

import { GitHubError, type RequestQueue } from './github';
import { t } from '../shared/i18n';

export class SendQueue implements RequestQueue {
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * One request: queued behind every earlier one; `admit` is checked when its turn comes (a throw
   * sends nothing); `given` aborted = the round was given up on — stop waiting for the answer (the
   * request itself is not stopped) and let the queue go on.
   */
  send(go: () => Promise<Response>, admit?: () => void, given?: AbortSignal): Promise<Response> {
    const run = this.queue.then(() => {
      admit?.();
      return given ? raceAbort(go(), given) : go();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function givenUp(): GitHubError {
  const e = new GitHubError('network', t('已放弃这一轮同步'));
  e.meta.cancelled = true;
  return e;
}

/** `p`, or a rejection as soon as `signal` aborts (the request itself is not stopped: only no longer waited for) */
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
