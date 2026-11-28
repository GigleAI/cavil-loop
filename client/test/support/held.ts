// GitHub#733 / #755: a clock a test moves by hand (with the timers that run on it), and a back end that
// holds chosen calls of the window until released — the boundaries the sync watch and the read limit of a
// refresh by hand are measured at. Shared by sync-watch.test.ts and reread-limit.test.ts.

import type { SyncTimers } from '../../src/app/controller';
import type { Backend } from '../../src/backend/backend';

const S = 1000;

/** A clock moved by hand, with the timers that run on it (in time order). `skip` jumps without firing (sleep). */
export function manualClock(t0: number) {
  interface Job {
    id: number;
    at: number;
    fn: () => void;
    every: number | null;
  }
  let t = t0;
  let seq = 0;
  let jobs: Job[] = [];
  const add = (fn: () => void, ms: number, every: number | null): Job => {
    const j = { id: ++seq, at: t + ms, fn, every };
    jobs.push(j);
    return j;
  };
  const drop = (h: unknown) => {
    jobs = jobs.filter((j) => j !== h);
  };
  const timers: SyncTimers = {
    setTimeout: (fn, ms) => add(fn, ms, null),
    clearTimeout: drop,
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearInterval: drop,
  };
  return {
    timers,
    now: () => t,
    /** move `sec` seconds on, firing what is due on the way */
    by(sec: number) {
      const target = t + sec * S;
      for (;;) {
        const due = jobs.filter((j) => j.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        t = Math.max(t, due.at);
        if (due.every === null) drop(due);
        else due.at += due.every;
        due.fn();
      }
      t = Math.max(t, target);
    },
    /** the machine sleeps `sec` seconds: no timer fires; each repeating one comes next a period after waking */
    sleep(sec: number) {
      t += sec * S;
      for (const j of jobs) if (j.at < t) j.at = j.every === null ? t : t + j.every;
    },
  };
}

/** Holds the window's calls to the back end that match, until released (the boundary the watch observes). */
export class HoldingBackend implements Backend {
  private rules: { match: (cmd: string, args?: Record<string, unknown>) => boolean; once: boolean; used: boolean }[] = [];
  private waiting: { release: () => void; cmd: string; args?: Record<string, unknown> }[] = [];
  readonly calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  constructor(private readonly inner: Backend) {}
  /** hold the next call that matches (or every one, `once: false`) */
  hold(match: (cmd: string, args?: Record<string, unknown>) => boolean, once = true): void {
    this.rules.push({ match, once, used: false });
  }
  stopHolding(): void {
    this.rules = [];
  }
  held(): number {
    return this.waiting.length;
  }
  /** let the oldest held call go on */
  releaseOne(): void {
    this.waiting.shift()?.release();
  }
  releaseAll(): void {
    this.rules = [];
    for (const w of this.waiting.splice(0)) w.release();
  }
  async call<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ cmd, ...(args ? { args } : {}) });
    const rule = this.rules.find((r) => !(r.once && r.used) && r.match(cmd, args));
    if (rule) {
      rule.used = true;
      await new Promise<void>((release) => this.waiting.push({ release, cmd, ...(args ? { args } : {}) }));
    }
    return this.inner.call<T>(cmd, args);
  }
}
