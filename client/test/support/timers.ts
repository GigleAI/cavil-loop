// GitHub#649: timers a test steps by hand, for the controller's `timers` dependency. Nothing fires on
// its own: the test sees what is queued (`queued`) and runs it (`fire`). "No further round is coming"
// is then a fact the test reads — nothing of that kind is queued — instead of a fixed sleep.

import type { SyncTimers } from '../../src/app/controller';

type Entry = { fn: () => void; ms: number; kind: 'timeout' | 'interval' };

export class ManualTimers implements SyncTimers {
  private seq = 1;
  private readonly entries = new Map<number, Entry>();

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.seq++;
    this.entries.set(id, { fn, ms, kind: 'timeout' });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.entries.delete(handle as number);
  }
  setInterval(fn: () => void, ms: number): unknown {
    const id = this.seq++;
    this.entries.set(id, { fn, ms, kind: 'interval' });
    return id;
  }
  clearInterval(handle: unknown): void {
    this.entries.delete(handle as number);
  }

  /** one-shot timers queued now, with this delay (any delay when omitted) */
  queued(ms?: number): number {
    return [...this.entries.values()].filter((e) => e.kind === 'timeout' && (ms === undefined || e.ms === ms)).length;
  }

  /** run every one-shot timer with this delay that is queued now; returns how many ran */
  fire(ms: number): number {
    const due = [...this.entries].filter(([, e]) => e.kind === 'timeout' && e.ms === ms);
    for (const [id] of due) this.entries.delete(id);
    for (const [, e] of due) e.fn();
    return due.length;
  }
}
