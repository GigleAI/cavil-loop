// Which Project a new issue joins by default (GitHub#231). Pure: the controller builds the input
// from every configured Project's own snapshot, so the top filter plays no part.

import type { BoardRepoCount, Item, ProjectMeta } from '../shared/types';

export type { BoardRepoCount };

/** Count one Project snapshot's items per repository. */
export function countRepos(items: Item[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const r = it.repo.toLowerCase();
    out[r] = (out[r] ?? 0) + 1;
  }
  return out;
}

export interface DefaultBoards {
  /** the Projects ticked when nothing was changed by hand: none, or the one holding the most of `repo`'s items */
  ticked: string[];
  /** Projects not read completely yet: left out of the choice, the dialog says so */
  unsynced: BoardRepoCount[];
}

/**
 * The default for a new issue in `repo` (GitHub#231): among the Projects this account may change
 * (`projects`, `viewerCanUpdate`), the one holding the most of `repo`'s items; a tie goes to the
 * one added first (`boards` is in the order the sources were added). None when no such Project
 * holds any of them. A Project never read completely is unknown, never counted as "holds none".
 */
export function defaultBoards(boards: BoardRepoCount[], projects: ProjectMeta[], repo: string): DefaultBoards {
  const writable = new Set(projects.filter((p) => p.viewerCanUpdate).map((p) => p.key));
  const r = repo.toLowerCase();
  let best: { key: string; n: number } | null = null;
  const unsynced: BoardRepoCount[] = [];
  for (const b of boards) {
    if (!b.repos) {
      unsynced.push(b);
      continue;
    }
    const n = b.repos[r] ?? 0;
    if (n > 0 && writable.has(b.key) && (!best || n > best.n)) best = { key: b.key, n };
  }
  return { ticked: best ? [best.key] : [], unsynced };
}
