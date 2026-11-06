// "待处理" (items waiting for a human): every item of every configured source
// that carries the pending label (`pending/human` by default), open, closed
// or merged alike. Notifications, the Dock badge and the start-up summary are
// all computed here, from the same sets, so they can never disagree.
//
// The rules (GigleAI/cavil-loop#139):
//   - only a source read completely this round takes part in the comparison;
//     a source whose read failed (offline, revoked credential, a page failing
//     mid-pagination) keeps last round's set as-is — no "new", no "removed";
//   - a source's first complete read in this run (app start, a newly added
//     source, a new account) is its baseline: what it already has goes into
//     one summary, never into one notification per item;
//   - one item is one entry (`owner/repo#N`), whichever sources carry it;
//   - an item that was not pending last round and is now → one notification;
//     a label removed and put back later counts as new again.

import type { Item, SourceSnapshot } from '../shared/types';

export const DEFAULT_PENDING_LABEL = 'pending/human';

export interface PendingSummary {
  /** items pending now (= the badge) */
  total: number;
  /** of those, closed issues / closed or merged PRs */
  closed: number;
  /** how many of them came in with the source(s) read for the first time this round */
  fromNewSources: number;
  /** true when this is the first summary of this run / account (app start) */
  atStart: boolean;
}

export interface PendingChange {
  /** became pending this round, one notification each */
  appeared: Item[];
  /** a source was read for the first time: one summary instead of per-item notifications (null = none) */
  summary: PendingSummary | null;
}

/** GitHub label names are case-insensitive. */
export function hasLabel(item: Item, label: string): boolean {
  const want = label.trim().toLowerCase();
  return want !== '' && item.labels.some((l) => l.name.toLowerCase() === want);
}

export function normalizeLabel(label: string): string {
  return label.trim();
}

export class PendingTracker {
  /** per baselined source: pending items by key, as of its latest complete read */
  private bySource = new Map<string, Map<string, Item>>();
  /** has any source been baselined since the last reset (decides "at start") */
  private started = false;

  constructor(private label: string = DEFAULT_PENDING_LABEL) {}

  /** Forget everything: sign-out, another account. The next complete reads are baselines again. */
  reset(): void {
    this.bySource.clear();
    this.started = false;
  }

  /** Drop sources no longer configured (their items stop counting; nothing is notified). */
  prune(configured: string[]): void {
    for (const k of [...this.bySource.keys()]) if (!configured.includes(k)) this.bySource.delete(k);
  }

  /**
   * Another label name: recompute every baselined source from the snapshots
   * already held, silently (a settings change is not "new work arrived").
   */
  relabel(label: string, snapshots: Map<string, SourceSnapshot>): void {
    this.label = label;
    for (const k of [...this.bySource.keys()]) {
      const snap = snapshots.get(k);
      if (snap) this.bySource.set(k, this.pendingOf(snap));
      else this.bySource.delete(k);
    }
  }

  /**
   * One sync round. `fresh` = the snapshots read completely this round (and
   * accepted); every other source keeps its previous set. `configured` = the
   * sources configured now.
   */
  observe(fresh: SourceSnapshot[], configured: string[]): PendingChange {
    this.prune(configured);
    const before = this.union();
    const newSources: Map<string, Item>[] = [];
    for (const snap of fresh) {
      if (!configured.includes(snap.sourceKey)) continue;
      const set = this.pendingOf(snap);
      if (!this.bySource.has(snap.sourceKey)) newSources.push(set);
      this.bySource.set(snap.sourceKey, set);
    }
    // Real changes come only from sources that already had a baseline.
    const appeared = new Map<string, Item>();
    for (const [k, set] of this.bySource) {
      if (newSources.includes(set)) continue;
      for (const [key, it] of set) if (!before.has(key)) appeared.set(key, this.latest(key) ?? it);
    }
    // What a first read brought in that was neither pending before nor just notified.
    const brought = new Set<string>();
    for (const set of newSources) for (const key of set.keys()) if (!before.has(key) && !appeared.has(key)) brought.add(key);
    let summary: PendingSummary | null = null;
    if (brought.size) {
      const now = this.pending();
      summary = {
        total: now.length,
        closed: now.filter((it) => it.state !== 'open').length,
        fromNewSources: brought.size,
        atStart: !this.started,
      };
    }
    if (newSources.length) this.started = true;
    return { appeared: [...appeared.values()], summary };
  }

  /** Pending now: one entry per item, the most recently updated copy. */
  pending(): Item[] {
    return [...this.union().values()];
  }

  count(): number {
    return this.union().size;
  }

  /** Is this item pending now (in any source still counted)? */
  has(key: string): boolean {
    return this.union().has(key);
  }

  private pendingOf(snap: SourceSnapshot): Map<string, Item> {
    const out = new Map<string, Item>();
    for (const it of snap.items) if (hasLabel(it, this.label)) out.set(it.key, it);
    return out;
  }

  private latest(key: string): Item | undefined {
    let best: Item | undefined;
    for (const set of this.bySource.values()) {
      const it = set.get(key);
      if (it && (!best || it.updatedAt > best.updatedAt)) best = it;
    }
    return best;
  }

  private union(): Map<string, Item> {
    const out = new Map<string, Item>();
    for (const set of this.bySource.values()) {
      for (const [key, it] of set) {
        const prev = out.get(key);
        if (!prev || it.updatedAt > prev.updatedAt) out.set(key, it);
      }
    }
    return out;
  }
}

/** Text of the notification for one item (shared by the app and its tests). */
export function itemAlertText(it: Pick<Item, 'repo' | 'number' | 'state' | 'kind' | 'title'>): { title: string; body: string } {
  const state = it.state === 'merged' ? '（已合并）' : it.state === 'closed' ? '（已关闭）' : '';
  const kind = it.kind === 'pr' ? 'PR' : 'issue';
  return { title: `待处理：${it.repo}#${it.number}${state}`, body: `${kind} · ${it.title}` };
}

/** Text of the summary notification. */
export function summaryAlertText(s: PendingSummary): { title: string; body: string } {
  const closed = s.closed ? `其中 ${s.closed} 条已关闭 / 已合并。` : '';
  const from = s.atStart ? '' : `新加的来源带来 ${s.fromNewSources} 条。`;
  return { title: `${s.total} 条待处理`, body: `${from}${closed}`.trim() || '点开查看看板' };
}
