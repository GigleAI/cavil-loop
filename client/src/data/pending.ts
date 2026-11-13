// "待处理" (items waiting for a human): every item of every configured source
// that carries the pending label (`pending/human` by default), open or closed.
// Notifications and the Dock badge are both computed from the sets kept here,
// so they can never disagree.
//
// The rules (GigleAI/cavil-loop#139, narrowed by #251):
//   - the label alone decides (GitHub#462, reversing #251's "open only"): an
//     autopilot item is closed when its pull request merges and keeps the label
//     to remind a human to look at it, so a closed issue / closed or merged PR
//     carrying it counts as well; the label coming off is what ends the to-do;
//   - only a source read completely this round takes part in the comparison;
//     a source whose read failed (offline, revoked credential, a page failing
//     mid-pagination) keeps last round's set as-is — no "new", no "removed";
//   - a source's first complete read in this run (app start, a newly added
//     source, a new account) is only its baseline: what it already has is
//     history, it is neither notified nor summarised nor unread (#251); so is a
//     repository's first read under another pending label (GitHub#462: it brings
//     in closed items that carried the label all along);
//   - one item is one entry (`owner/repo#N`), whichever sources carry it;
//   - an item that was not pending last round and is now → one notification;
//     a label removed and put back counts as new again; an item closing or reopening
//     with the label on is the same to-do, not a new one.

//
// GitHub#373 — which pending items remind is a second question, asked of the same sets:
//   - 'all' (the default): every pending item, exactly as before;
//   - 'mine': only the ones that concern the signed-in account (`concernsViewer` below), judged on
//     everything held now — a pull request follows the issue it is linked to, and that issue may
//     be in a source that was not read this round;
//   - an item that starts to concern the account is a notification only when that follows without
//     the sources read for the first time this round: what the app merely sees for the first time
//     (a new source, a start) is history, here too.

import type { Item, NotifyScope, SourceSnapshot } from '../shared/types';
import { mergeSnapshots } from './merge';
import { t } from '../shared/i18n';


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

/** A to-do: carrying the label, open or closed (GitHub#462: a closed item with the label still waits for a human). */
export function isPending(item: Item, label: string): boolean {
  return hasLabel(item, label);
}

export function normalizeLabel(label: string): string {
  return label.trim();
}

/** Whose reminders: the scope chosen in Settings and the signed-in login (null = not known yet). */
export interface Audience {
  scope: NotifyScope;
  viewer: string | null;
}

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Who answers for an item, as GitHub records it: the account ('mine'), somebody else ('others'),
 * or nobody. A pull request whose review requests could not be read whole is 'mine' — the account
 * may be among the ones not read, and unknown never drops a reminder.
 */
function answersFor(it: Item, viewer: string): 'mine' | 'others' | 'nobody' {
  if (it.assignees.some((a) => sameLogin(a, viewer))) return 'mine';
  if (it.kind !== 'pr') return it.assignees.length ? 'others' : 'nobody';
  const asked = it.reviewRequested;
  if (asked === undefined || asked === null) return 'mine';
  if (asked.users.some((u) => sameLogin(u, viewer))) return 'mine';
  if (it.assignees.length || asked.users.length || asked.others) return 'others';
  // nobody answers for it, and the issues GitHub links to it were read but not whole: the
  // account's issue may be among the ones not read
  return it.closingIssues === null ? 'mine' : 'nobody';
}

/** Subscribed, or not known not to be (unknown never drops a reminder). */
const follows = (it: Item) => it.viewerSubscribed !== false;

/**
 * GitHub#373: does this item concern the account? In order, the first that applies:
 *   1. assigned to the account, or the account is asked to review it → yes;
 *   2. assigned to / review asked of somebody else → no, even when the account subscribes
 *      (handing an item to someone else hands its reminders over);
 *   3. nobody answers for it → a pull request follows the issues it is linked to (`linked`: the
 *      ones found in the data held — named in its description, or linked on GitHub; any of them concerning the account by these same rules is
 *      enough); with none found, and for an issue: the account subscribes to it, or that is unknown.
 */
export function concernsViewer(it: Item, viewer: string, linked: Item[] = []): boolean {
  const who = answersFor(it, viewer);
  if (who !== 'nobody') return who === 'mine';
  const issues = it.kind === 'pr' ? linked.filter((x) => x.kind === 'issue') : [];
  if (issues.length) return issues.some((x) => concernsViewer(x, viewer));
  return follows(it);
}

export class PendingTracker {
  /** per baselined source: pending items by key, as of its latest complete read */
  private bySource = new Map<string, Map<string, Item>>();
  /** per baselined source: that read itself (GitHub#373: who an item concerns is judged across sources) */
  private held = new Map<string, SourceSnapshot>();
  /** what reminds now: one entry per item (the most recently updated copy), pending and within the audience */
  private alert = new Map<string, Item>();

  constructor(
    private label: string = DEFAULT_PENDING_LABEL,
    private audience: Audience = { scope: 'all', viewer: null },
  ) {}

  /** Forget everything: sign-out, another account. The next complete reads are baselines again. */
  reset(): void {
    this.bySource.clear();
    this.held.clear();
    this.alert.clear();
  }

  /** Drop sources no longer configured (their items stop counting; nothing is notified). */
  prune(configured: string[]): void {
    for (const k of [...this.bySource.keys()]) {
      if (configured.includes(k)) continue;
      this.bySource.delete(k);
      this.held.delete(k);
    }
    this.alert = this.alertOf([...this.bySource.keys()]);
  }

  /**
   * Another label name: recompute every baselined source from the snapshots
   * already held, silently (a settings change is not "new work arrived").
   */
  relabel(label: string, snapshots: Map<string, SourceSnapshot>): void {
    this.label = label;
    for (const k of [...this.bySource.keys()]) {
      const snap = snapshots.get(k);
      if (snap) {
        this.bySource.set(k, this.pendingOf(snap));
        this.held.set(k, snap);
      } else {
        this.bySource.delete(k);
        this.held.delete(k);
      }
    }
    this.alert = this.alertOf([...this.bySource.keys()]);
  }

  /**
   * GitHub#373: another scope, or the login became known / changed. Recomputed silently, like a
   * label rename: a settings change is not "new work arrived".
   */
  setAudience(audience: Audience): void {
    if (audience.scope === this.audience.scope && audience.viewer === this.audience.viewer) return;
    this.audience = { ...audience };
    this.alert = this.alertOf([...this.bySource.keys()]);
  }

  /**
   * One sync round. `fresh` = the snapshots read completely this round (and
   * accepted); every other source keeps its previous set. `configured` = the
   * sources configured now.
   *
   * New (one notification each) = reminding now, not reminding before this round, and reminding
   * also when the sources read for the first time this round are left out: a first read is a
   * baseline for what it carries and for what it tells about other sources' items alike.
   */
  observe(fresh: SourceSnapshot[], configured: string[]): PendingChange {
    this.prune(configured);
    const before = new Set(this.alert.keys());
    const first: string[] = [];
    for (const snap of fresh) {
      if (!configured.includes(snap.sourceKey)) continue;
      // GitHub#462: a repository read for another pending label than the one held (the label was
      // renamed in Settings, or the snapshot is from before closed items were read) brings in closed
      // items that were pending all along — a baseline, like a first read
      const held = this.held.get(snap.sourceKey);
      const relisted = held !== undefined && (held.pendingLabel ?? '') !== (snap.pendingLabel ?? '');
      if (!this.bySource.has(snap.sourceKey) || relisted) first.push(snap.sourceKey);
      this.bySource.set(snap.sourceKey, this.pendingOf(snap));
      this.held.set(snap.sourceKey, snap);
    }
    const all = [...this.bySource.keys()];
    this.alert = this.alertOf(all);
    const known = first.length ? this.alertOf(all.filter((k) => !first.includes(k))) : this.alert;
    const appeared: Item[] = [];
    for (const [key, it] of this.alert) if (known.has(key) && !before.has(key)) appeared.push(it);
    return { appeared };
  }

  /** Reminding now: one entry per item, the most recently updated copy. */
  pending(): Item[] {
    return [...this.alert.values()];
  }

  count(): number {
    return this.alert.size;
  }

  /** Does this item remind now (pending through any source, and within the audience)? */
  has(key: string): boolean {
    return this.alert.has(key);
  }

  /** The sources that count this item as pending now (empty = it does not remind). */
  carriers(key: string): string[] {
    if (!this.alert.has(key)) return [];
    return [...this.bySource].filter(([, set]) => set.has(key)).map(([k]) => k);
  }

  private pendingOf(snap: SourceSnapshot): Map<string, Item> {
    const out = new Map<string, Item>();
    for (const it of snap.items) if (isPending(it, this.label)) out.set(it.key, it);
    return out;
  }

  /**
   * What reminds, going by these sources alone: their pending items (one entry per item, the most
   * recently updated copy), and of those — scope 'mine' with a known login — the ones that concern
   * the account, judged on these sources' items merged the way the board merges them.
   */
  private alertOf(sources: string[]): Map<string, Item> {
    const pending = new Map<string, Item>();
    for (const k of sources) {
      for (const [key, it] of this.bySource.get(k) ?? []) {
        const prev = pending.get(key);
        if (!prev || it.updatedAt > prev.updatedAt) pending.set(key, it);
      }
    }
    const viewer = this.audience.viewer;
    if (this.audience.scope !== 'mine' || !viewer || pending.size === 0) return pending;
    const merged = new Map(mergeSnapshots(sources.flatMap((k) => this.held.get(k) ?? []), null).items.map((it) => [it.key, it] as const));
    // pull request → the issues linked to it: the ones its description names, the ones GitHub lists
    // for it (a repository list knows a sidebar link only this way), and the ones that list it
    const links = new Map<string, Set<string>>();
    const link = (pr: string, issue: string) => links.set(pr, (links.get(pr) ?? new Set()).add(issue));
    for (const it of merged.values()) {
      if (it.kind === 'pr') for (const k of [...(it.refIssues ?? []), ...(it.closingIssues ?? [])]) link(it.key, k);
      else for (const pr of it.linkedPrs ?? []) link(pr.key, it.key);
    }
    const out = new Map<string, Item>();
    for (const [key, it] of pending) {
      const linked = [...(links.get(key) ?? [])].flatMap((k) => merged.get(k) ?? []);
      if (concernsViewer(merged.get(key) ?? it, viewer, linked)) out.set(key, it);
    }
    return out;
  }
}

/** Text of the notification for one item (shared by the app and its tests). */
export function itemAlertText(it: Pick<Item, 'repo' | 'number' | 'kind' | 'title'>): { title: string; body: string } {
  const kind = it.kind === 'pr' ? 'PR' : 'issue';
  return { title: t('待处理：{repo}#{number}', { repo: it.repo, number: it.number }), body: `${kind} · ${it.title}` };
}
