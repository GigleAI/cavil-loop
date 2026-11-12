// GitHub#401: which card the empty board shows — the one decision, so the board, the table and the
// dependency graph (all drawn by the board page) show the same one.
//
// - no source at all: how to add one ("add")
// - every source in view has *finished* a read that failed and nothing of theirs is on hand: why
//   ("failed") — a source still waiting for its first answer is not a failure, so the card never
//   flashes up during the first sync
// - anything else (some source read, or not every one answered yet): no card; a source that failed
//   next to ones that worked is the ⚠️'s business

import type { SourceConfig, SourceStatus } from './types';

export type EmptyGuide = { kind: 'add' } | { kind: 'failed'; failed: SourceStatus[] } | null;

export function emptyGuideOf(
  sources: readonly SourceConfig[],
  /** the sources the view shows (null = all) */
  selected: readonly string[] | null,
  status: readonly SourceStatus[],
  /** the source keys each item on hand belongs to */
  itemSources: readonly (readonly string[])[],
): EmptyGuide {
  if (sources.length === 0) return { kind: 'add' };
  const inView = sources.filter((s) => !selected || selected.includes(s.key)).map((s) => s.key);
  if (inView.length === 0) return null;
  const failed: SourceStatus[] = [];
  for (const key of inView) {
    const st = status.find((x) => x.sourceKey === key);
    if (!st || st.ok) return null;
    failed.push(st);
  }
  if (itemSources.some((ks) => ks.some((k) => inView.includes(k)))) return null;
  return { kind: 'failed', failed };
}
