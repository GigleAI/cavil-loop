// "待处理" (items waiting for a human): every open item of every configured
// source that carries the pending label (`pending/human` by default).
// Notifications and the Dock badge are both computed from the sets kept here,
// so they can never disagree.
//
// The rules (GigleAI/cavil-loop#139, narrowed by #251):
//   - only an open issue / PR (a draft PR is open) is a to-do: a closed issue or
//     a closed / merged PR never counts, whatever its labels;
//   - only a source read completely this round takes part in the comparison;
//     a source whose read failed (offline, revoked credential, a page failing
//     mid-pagination) keeps last round's set as-is — no "new", no "removed";
//   - a source's first complete read in this run (app start, a newly added
//     source, a new account) is only its baseline: what it already has is
//     history, it is neither notified nor summarised nor unread (#251);
//   - one item is one entry (`owner/repo#N`), whichever sources carry it;
//   - an item that was not pending last round and is now → one notification;
//     a label removed and put back, or a labelled item reopened, counts as new again.

import type { Item, SourceSnapshot } from '../shared/types';

export const DEFAULT_PENDING_LABEL = 'pending/human';

export interface PendingChange {
  /** became pending this round, one notification each (a first read's baseline is never here) */
  appeared: Item[];
}

/** GitHub label names are case-insensitive. */
export function hasLabel(item: Item, label: string): boolean {
  const want = label.trim().toLowerCase();
  return want !== '' && item.labels.some((l) => l.name.toLowerCase() === want);
}

/** A to-do: open (a draft PR is open) and carrying the label (#251: closed / merged never counts). */
export function isPending(item: Item, label: string): boolean {
  return item.state === 'open' && hasLabel(item, label);
}

export function normalizeLabel(label: string): string {
  return label.trim();
}

export class PendingTracker {
  /** per baselined source: pending items by key, as of its latest complete read */
  private bySource = new Map<string, Map<string, Item>>();

  constructor(private label: string = DEFAULT_PENDING_LABEL) {}

  /** Forget everything: sign-out, another account. The next complete reads are baselines again. */
  reset(): void {
    this.bySource.clear();
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
    // Real changes come only from sources that already had a baseline; a first read is history.
    const appeared = new Map<string, Item>();
    for (const set of this.bySource.values()) {
      if (newSources.includes(set)) continue;
      for (const [key, it] of set) if (!before.has(key)) appeared.set(key, this.latest(key) ?? it);
    }
    return { appeared: [...appeared.values()] };
  }

  /** Pending now: one entry per item, the most recently updated copy. */
  pending(): Item[] {
    return [...this.union().values()];
  }

  count(): number {
    return this.union().size;
  }

  /** Is this item pending now (through any source)? */
  has(key: string): boolean {
    for (const set of this.bySource.values()) if (set.has(key)) return true;
    return false;
  }

  /** The sources that count this item as pending now (empty = not pending). */
  carriers(key: string): string[] {
    return [...this.bySource].filter(([, set]) => set.has(key)).map(([k]) => k);
  }

  private pendingOf(snap: SourceSnapshot): Map<string, Item> {
    const out = new Map<string, Item>();
    for (const it of snap.items) if (isPending(it, this.label)) out.set(it.key, it);
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

/** Text of the notification for one item (shared by the app and its tests). Only open items are pending. */
export function itemAlertText(it: Pick<Item, 'repo' | 'number' | 'kind' | 'title'>): { title: string; body: string } {
  const kind = it.kind === 'pr' ? 'PR' : 'issue';
  return { title: `待处理：${it.repo}#${it.number}`, body: `${kind} · ${it.title}` };
}
