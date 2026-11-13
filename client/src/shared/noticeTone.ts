// GitHub#357: the colour of a notice, decided in one place from what is going on — never from
// which kind of notice it is. Every notice (an operation, a new issue, changes not saved, a result
// bar) states its facts and asks here; no caller picks a colour by itself.
//
// The rules, in order, first match wins:
//   1. a request of this notice's own is running (the operation, an evidence read, a re-attempt
//      a person started)                                             → busy  (blue, spinner)
//   2. everything went through                                        → ok    (green; goes after 5 s)
//   3. refused for sure, or the latest attempt to deal with it failed → error (red)
//   4. something went wrong and the app keeps retrying by itself      → warn  (yellow)
//   5. none of the above (a problem nobody is working on and no attempt failed, or a plain
//      remark): the notice keeps the colour it always had             → `rest`
//
// A background loop (the offline retry, the catch-up re-read of every sync round, the timed looks
// at a board) is rule 4, never rule 1: it waits most of the time, and counting it as "running"
// would show a notice with a problem as busy for minutes.
// GitHub#359: the app's own checks right after an operation's answer never came (one at once, a
// few more seconds apart, under a minute in all) are rule 1 as one burst; the check every later
// sync round makes is this background loop — rule 4, also after a check that could not read.

import type { CreateJob, CreateWatch } from './types';

/** `info` is the plain blue of a remark (rule 5 only): nothing is running, nothing went wrong */
export type NoticeTone = 'busy' | 'ok' | 'error' | 'warn' | 'info';

export interface NoticeFacts {
  /** a request of this notice's own is running right now */
  busy: boolean;
  /** everything went through */
  done: boolean;
  /** refused for sure, or the latest attempt (automatic or by a button) ended in failure */
  failed: boolean;
  /** the app keeps retrying in the background */
  retrying: boolean;
  /** rule 5: the colour this notice has when none of the above holds */
  rest: 'warn' | 'info' | 'error';
}

export function noticeTone(f: NoticeFacts): NoticeTone {
  if (f.busy) return 'busy';
  if (f.done) return 'ok';
  if (f.failed) return 'error';
  if (f.retrying) return 'warn';
  return f.rest;
}

/** One watched board of a new issue: its automatic write / check / look ended in failure. */
export function watchFailed(w: CreateWatch): boolean {
  return w.state === 'failed' || w.state === 'unverified' || w.state === 'unread';
}

/**
 * What a new issue's notice still holds that an attempt to deal with it failed on, one line per
 * part (the words the notice shows): a retry that could not start, every board a retry left
 * unfinished, every board whose "改成…" click failed. Each part is cleared only by a later attempt
 * on that very part — a success elsewhere never hides it (PR #361 code review round 1).
 */
export function createFailures(job: CreateJob): string[] {
  const out: string[] = [];
  if (job.retryError) out.push(job.retryError);
  for (const b of job.boards ?? []) if (b.retryFailed) out.push(`再试后「${b.title}」${b.state === 'missing' ? '仍没加入' : '已加入但字段没设上'}（${b.reason}）`);
  for (const w of job.watch ?? []) if (w.clickError) out.push(`「${w.title}」：${w.clickError}`);
  return out;
}

/** The facts of a new issue's notice (GitHub#229 / #258). A `watching` job has no notice. */
export function createFacts(job: CreateJob): NoticeFacts {
  const watch = job.watch ?? [];
  return {
    busy: job.status === 'running' || job.retrying === true || job.looking === true || watch.some((w) => w.busy === true),
    done: false,
    failed: job.status === 'failed' || createFailures(job).length > 0 || !!job.lookError || watch.some(watchFailed),
    retrying: false,
    rest: 'warn',
  };
}

export function createTone(job: CreateJob): NoticeTone {
  return noticeTone(createFacts(job));
}

/** Changes not saved / not confirmed (GitHub#229): red, blue while a resend a person asked for is running. */
export function editsTone(resending: boolean): NoticeTone {
  return noticeTone({ busy: resending, done: false, failed: true, retrying: false, rest: 'error' });
}

/** A one-off result bar (a label / status change): done, done with a re-read left to the next round, or failed. */
export function resultTone(kind: 'ok' | 'warn' | 'error'): NoticeTone {
  return noticeTone({ busy: false, done: kind === 'ok', failed: kind === 'error', retrying: kind === 'warn', rest: 'warn' });
}

/**
 * GitHub#490: what a new issue's notice offers — at most one retry, one way out and ×:
 *   failed for sure (nothing was created) → 「重试」 (the same draft again) + 「重新打开草稿」;
 *   not sure it was created → 「再查一次」 (looks for a same-title issue again: links to look at, never
 *     proof of anything) + 「到 GitHub 上看最近建的 issue」 (the list, the draft copied). Nothing on it creates again;
 *   created, not on every board → 「再试加入看板」 + 「打开这条 issue」.
 */
export type CreateRetry = 'recreate' | 'look' | 'projects';
export type CreateFallback = 'reopenDraft' | 'webList' | 'openItem';
export function createActions(job: CreateJob): { retry: CreateRetry | null; fallback: CreateFallback | null; close: boolean } {
  if (job.status === 'running' || job.status === 'watching') return { retry: null, fallback: null, close: false };
  if (job.status === 'failed') return { retry: 'recreate', fallback: 'reopenDraft', close: true };
  if (job.status === 'unknown') return { retry: job.looking ? null : 'look', fallback: 'webList', close: true };
  const missing = (job.boards ?? []).some((b) => b.state === 'missing');
  return { retry: missing && !job.retrying ? 'projects' : null, fallback: job.createdKey ? 'openItem' : null, close: true };
}
