// The board's yellow bars (GitHub#153): which ones are up right now, what
// problem each one is about, and which ones the user closed with "×".
//
// A bar is closed for *its current problem*, not for its current wording:
// the wording carries relative times ("1 分钟前") that change every 15 s, the
// problem does not. So every bar gets a fault id made only of stable facts.
// A closed bar stays closed while its id stays the same; the moment the bar
// is no longer up (the problem went away, the filter was cleared) or its id
// changes, the record is dropped and the next occurrence shows again.
//
// Everything here is pure; the window (App.tsx) keeps the records in memory
// for this run only and reconciles them on every render, whichever page is
// showing, so a recovery that happens while the settings page is open is not
// missed.

import type { SourceStatus, SyncState } from '../shared/types';
import type { ParsedFilter } from '../shared/filter';

export const WARN_KINDS = ['filter-unsupported', 'offline', 'sync-problem', 'board-notify-problem'] as const;
export type WarnKind = (typeof WARN_KINDS)[number];

/** kind -> fault id of every bar that is up; a kind that is absent is not up */
export type WarnIds = Partial<Record<WarnKind, string>>;
/** kind -> the fault id the user closed */
export type Dismissed = Partial<Record<WarnKind, string>>;

/** is the search box narrowing the board at all (same rule the board uses) */
export function isFiltering(parsed: ParsedFilter): boolean {
  return parsed.clauses.length > 0 || parsed.unsupported.length > 0;
}

const sorted = (xs: string[]) => JSON.stringify([...xs].sort());

/**
 * The bars that are up, with their fault ids. The conditions are exactly the
 * ones the board renders them on; no id contains a time of any kind.
 */
export function warningIds(sync: SyncState, parsed: ParsedFilter): WarnIds {
  const out: WarnIds = {};
  if (parsed.unsupported.length > 0) out['filter-unsupported'] = sorted(parsed.unsupported);
  if (sync.offline) out.offline = 'offline';
  if (sync.problem) out['sync-problem'] = sync.problem;
  return out;
}

/**
 * Sources that failed this round (GitHub#248). They used to be two full-width
 * bars ("filter may be incomplete", "sync incomplete"); now they are one ⚠️
 * next to the refresh button whose popover holds both parts, each shown on the
 * condition its bar had:
 *  - `incomplete`: some source failed and the app is not offline (the offline
 *    bar already says how old the data is)
 *  - `filterIncomplete`: some source failed while the search box narrows the board
 *    (offline or not)
 * null = neither part is up, so there is no ⚠️ at all.
 */
export interface SyncTrouble {
  failed: SourceStatus[];
  incomplete: boolean;
  filterIncomplete: boolean;
}

export function syncTrouble(sync: SyncState, parsed: ParsedFilter): SyncTrouble | null {
  const failed = sync.sources.filter((s) => !s.ok);
  if (failed.length === 0) return null;
  const incomplete = !sync.offline;
  const filterIncomplete = isFiltering(parsed);
  return incomplete || filterIncomplete ? { failed, incomplete, filterIncomplete } : null;
}

/**
 * The "macOS refused the notification" bar (GitHub#139): up while the latest
 * notification was refused; its fault id is the system's own reason, which
 * carries no time. Kept apart from warningIds because it comes from the
 * app state, not from the sync or the search box.
 */
export function notifyWarningIds(notifyProblem: string | null): WarnIds {
  return notifyProblem ? { 'board-notify-problem': notifyProblem } : {};
}

/**
 * Drop the records whose bar is no longer up or now shows another problem.
 * Returns `dismissed` itself when nothing changes (so a caller can tell).
 */
export function reconcile(dismissed: Dismissed, current: WarnIds): Dismissed {
  let changed = false;
  const next: Dismissed = {};
  for (const k of Object.keys(dismissed) as WarnKind[]) {
    if (current[k] !== undefined && current[k] === dismissed[k]) next[k] = dismissed[k];
    else changed = true;
  }
  return changed ? next : dismissed;
}

/** the bar of `kind` is up and not closed for this very problem */
export function isShown(kind: WarnKind, current: WarnIds, dismissed: Dismissed): boolean {
  return current[kind] !== undefined && dismissed[kind] !== current[kind];
}

/** close the bar of `kind` for the problem it shows now (no-op when it is not up) */
export function dismiss(dismissed: Dismissed, current: WarnIds, kind: WarnKind): Dismissed {
  const base = reconcile(dismissed, current);
  const id = current[kind];
  return id === undefined ? base : { ...base, [kind]: id };
}
