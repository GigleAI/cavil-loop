// GitHub#226: the open detail follows the board's sync rounds.
//
// The detail is read whole (every page of comments and reviews), so it is not
// re-read on a timer: each sync round already tells, per item, when GitHub last
// changed it. The panel re-reads only when a round brought fresh data of this
// item and that data says something changed — or when the detail on screen is
// one GitHub had not finished computing (checks still running, mergeability
// unknown), which GitHub does not count as "the item changed".
//
// Pure (no React): the panel calls it, tests drive it directly.

import type { ItemDetail } from '../shared/actions';
import type { Item, SourceStatus } from '../shared/types';

/**
 * The newest complete read, this session, of a source that carries `item`;
 * null = none of its sources has been read completely (or the item is not on
 * the board). A source keeps its old snapshot when a read fails, so only a
 * status that says ok counts: another source succeeding, or this one failing
 * and keeping its cache, never looks like fresh data of this item.
 */
export function freshMark(item: Pick<Item, 'sources'> | null, sources: SourceStatus[]): number | null {
  if (!item) return null;
  let mark: number | null = null;
  for (const st of sources)
    if (st.ok && st.dataFrom !== null && item.sources.includes(st.sourceKey) && (mark === null || st.dataFrom > mark)) mark = st.dataFrom;
  return mark;
}

/** The detail shows a PR state GitHub was still working out when it was read. */
export function stillSettling(detail: ItemDetail | null): boolean {
  const pr = detail?.pr;
  if (!pr || detail!.state !== 'open') return false;
  return pr.checks === 'PENDING' || pr.checks === 'EXPECTED' || pr.mergeable === 'UNKNOWN' || pr.mergeStateStatus === 'UNKNOWN';
}

export interface AutoRefreshInput {
  /** the board's copy of the item now (after the round) */
  item: Pick<Item, 'updatedAt'> | null;
  /** the board's `updatedAt` when the detail on screen was read; null = nothing read yet */
  readAt: string | null;
  /** the detail on screen (null: the first read has not landed) */
  detail: ItemDetail | null;
  /** a change is being sent from the panel: its own re-read follows */
  busy: boolean;
  /** a read of the detail is in flight */
  loading: boolean;
}

/** A round brought fresh data of the item: read the detail again? */
export function shouldAutoRefresh({ item, readAt, detail, busy, loading }: AutoRefreshInput): boolean {
  if (!item || busy || loading) return false;
  if (!detail) return true; // the first read failed: try again with the round
  if (item.updatedAt !== readAt) return true;
  return stillSettling(detail);
}

/** Two reads show the same thing (the read time aside): keep what is on screen, nothing redraws. */
export function sameDetail(a: ItemDetail | null, b: ItemDetail): boolean {
  if (!a) return false;
  return JSON.stringify({ ...a, fetchedAt: 0 }) === JSON.stringify({ ...b, fetchedAt: 0 });
}
