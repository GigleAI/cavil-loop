// Small per-machine preferences of the window (GitHub#231), each under its own setting key — not
// part of the view settings, so importing a Project's web view never touches them.
// Pure; shared by the controller (reads / writes the settings) and the renderer.

import type { GroupBy } from './types';
import { GROUP_BYS } from './viewSettings';

/**
 * Which table groups are folded, kept apart per "group by" (folding "无迭代" while grouped by
 * iteration does not fold "无状态" under status). Each list is oldest first.
 */
export type TableFolds = Partial<Record<GroupBy, string[]>>;

/** At most this many folded groups are kept per "group by"; past that the oldest one is dropped. */
export const MAX_FOLDS_PER_GROUPING = 200;

/** Whatever was saved: keep each valid list (strings, no repeats, the newest 200), drop the rest. */
export function normalizeTableFolds(raw: unknown): TableFolds {
  const out: TableFolds = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [by, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!GROUP_BYS.includes(by as GroupBy) || !Array.isArray(list)) continue;
    const keys = [...new Set(list.filter((k): k is string => typeof k === 'string' && k !== ''))];
    if (keys.length) out[by as GroupBy] = keys.slice(-MAX_FOLDS_PER_GROUPING);
  }
  return out;
}

/** Fold (`folded` true) or unfold one group under `by`. A fold goes to the end (newest); unknown input changes nothing. */
export function setFold(folds: TableFolds, by: unknown, key: unknown, folded: unknown): TableFolds {
  if (!GROUP_BYS.includes(by as GroupBy) || typeof key !== 'string' || key === '' || typeof folded !== 'boolean') return folds;
  const g = by as GroupBy;
  const cur = folds[g] ?? [];
  if (!folded && !cur.includes(key)) return folds;
  const rest = cur.filter((k) => k !== key);
  const next = folded ? [...rest, key].slice(-MAX_FOLDS_PER_GROUPING) : rest;
  const out: TableFolds = { ...folds };
  if (next.length) out[g] = next;
  else delete out[g];
  return out;
}

/**
 * GitHub#297: which board swimlanes (one per repository, `owner/name` as shown) are folded to their
 * head line. Kept on this machine like the table folds, apart from them (folding a repository on the
 * board does not fold it in the table). Oldest first.
 */
export type LaneFolds = string[];

/** At most this many folded swimlanes are kept; past that the oldest one is dropped. */
export const MAX_LANE_FOLDS = 200;

/** Whatever was saved: strings, no repeats, the newest 200; anything else reads as "nothing folded". */
export function normalizeLaneFolds(raw: unknown): LaneFolds {
  if (!Array.isArray(raw)) return [];
  const keys = [...new Set(raw.filter((k): k is string => typeof k === 'string' && k !== ''))];
  return keys.slice(-MAX_LANE_FOLDS);
}

/** Fold (`folded` true) or unfold one swimlane. A fold goes to the end (newest); unknown input changes nothing. */
export function setLaneFold(folds: LaneFolds, lane: unknown, folded: unknown): LaneFolds {
  if (typeof lane !== 'string' || lane === '' || typeof folded !== 'boolean') return folds;
  if (!folded && !folds.includes(lane)) return folds;
  const rest = folds.filter((k) => k !== lane);
  return folded ? [...rest, lane].slice(-MAX_LANE_FOLDS) : rest;
}

/** "托管" asks first unless the user ticked "不再提示" (GitHub#231); anything but an explicit `false` asks. */
export function normalizeAutopilotConfirm(raw: unknown): boolean {
  return raw !== false;
}

/**
 * GitHub#369: switching to the window takes back every delivered notification only when the user
 * ticked it in Settings; anything but an explicit `true` keeps them (a click still takes back the one clicked).
 */
export function normalizeClearAllOnActivate(raw: unknown): boolean {
  return raw === true;
}
