// GitHub#545: read only what changed. When the change check says a source changed (or some item
// was read too close to its last change to be sure the read saw it), the round finds the changed
// items with REST lists — not counted against GraphQL points — re-reads only those (up to
// DELTA_MAX, one GraphQL request) and merges them into the previous snapshot. Anything this path
// cannot handle answers 'full': the caller reads the source in full, exactly as before.
//
// Two ways of finding changes, both needed (measured on a real board: an issue's own change does
// not always move its board item's updated time — 3 of 45 items lagged 5–13 minutes):
//   board       the board's item list filtered by updated date (whole days only: one day earlier is
//               asked for, the rest filtered here) — field values, items added to the board
//   repository  each repository's issue list since a time (to the second) — the issue / PR itself
//
// What may be skipped: an item whose listed times both equal the snapshot's AND are at least
// STABLE_MS before the read that produced the snapshot's copy began (GitHub's clock). GitHub's
// times are whole seconds and two changes can share one, so "same time" alone proves nothing.
// Every other candidate is re-read. Items not yet "stable" are re-read every round until they are,
// whether or not the check saw a change (`unstableItems`, computed from the snapshot alone).

import type { Item, ProjectMeta, SourceConfig, SourceSnapshot } from '../shared/types';
import { itemKey } from '../shared/sources';
import { GitHubClient, GitHubError } from './github';
import { t } from '../shared/i18n';
import { PROJECT_ITEMS_BY_IDS_QUERY } from './queries';
import { completeRepoItems, contentToItem, readMembership, repoListItem, withRelations, type GqlContent, type GqlFieldValue } from './fetchSources';
import { readLoopBlocked, type LabelFor } from './loopBlocked';
import { RELATION_BATCH_SIZE } from './relations';

/** a change at least this long before a read began was certainly seen by it (GitHub ends a query within 10 s) */
export const STABLE_MS = 10_000;
/** how far before the last read the lists look again (this machine's and GitHub's clocks may differ) */
export const LOOKBACK_MS = 5 * 60_000;
/** more changed items than this in one round: the source is read in full (one page of 100 costs about 8 points) */
export const DELTA_MAX = 100;

type Board = Extract<SourceConfig, { kind: 'project' }>;
type Repo = Extract<SourceConfig, { kind: 'repo' }>;

const ms = (iso: string | undefined | null): number | null => {
  if (typeof iso !== 'string' || !iso) return null;
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : null;
};

/** the times an item of this source carries: its own (content) and, on a board, its board item's */
function timesOf(it: Item, board: boolean): (number | null)[] {
  return board ? [ms(it.updatedAt), ms(it.projects[0]?.itemUpdatedAt)] : [ms(it.updatedAt)];
}

/**
 * Can a read of changes start from this snapshot? It needs GitHub's time of the last read, and every
 * item's times (GitHub gave them) and the time it was read. One item without = the whole source is
 * read in full (a filter by time cannot find an item that has no time, #545 design review round 10).
 */
export function deltaReady(snap: SourceSnapshot | undefined, src: SourceConfig): snap is SourceSnapshot {
  if (!snap || typeof snap.syncedThrough !== 'number') return false;
  const board = src.kind === 'project';
  if (board && (!snap.project || !Array.isArray(snap.boardItemIds))) return false;
  return snap.items.every((it) => typeof it.seenAt === 'number' && timesOf(it, board).every((x) => x !== null) && (!board || !!it.projects[0]?.itemId));
}

/** an item whose copy may predate its latest change: a change within STABLE_MS of the read's start */
export function isUnstable(it: Item, board: boolean): boolean {
  if (typeof it.seenAt !== 'number') return true;
  return timesOf(it, board).some((x) => x === null || x > it.seenAt! - STABLE_MS);
}

export function unstableItems(snap: SourceSnapshot, src: SourceConfig): Item[] {
  const board = src.kind === 'project';
  return snap.items.filter((it) => isUnstable(it, board));
}

/** from when the lists are read: LOOKBACK_MS before the last read, and never after an unstable item's change */
export function sinceOf(snap: SourceSnapshot, src: SourceConfig): number {
  let since = snap.syncedThrough! - LOOKBACK_MS;
  for (const it of unstableItems(snap, src)) for (const x of timesOf(it, src.kind === 'project')) if (x !== null) since = Math.min(since, x - 1000);
  return since;
}

/** the day before `at` (UTC), as the board filter takes it: `updated:>=YYYY-MM-DD` */
export function boardDay(at: number): string {
  return new Date(at - 86_400_000).toISOString().slice(0, 10);
}

/**
 * Keep a candidate? (the "may be skipped" rule above). `listed` = the times the list gave (null =
 * that list did not say), `old` = the snapshot's copy (null = not in the snapshot: new).
 */
export function needsRead(old: Item | null, listed: { content?: number | null; board?: number | null }, board: boolean): boolean {
  if (!old) return true;
  if (isUnstable(old, board)) return true;
  const [c, b] = timesOf(old, board);
  if (listed.content !== undefined && (listed.content === null || c === null || listed.content !== c)) return true;
  if (board && listed.board !== undefined && (listed.board === null || b === null || listed.board !== b)) return true;
  return false;
}

export type DeltaResult = { kind: 'read'; snap: SourceSnapshot; count: number } | { kind: 'full'; why: string };

interface RestBoardItem {
  node_id?: string;
  updated_at?: string;
  content_type?: string;
  content?: { number?: number; updated_at?: string; repository_url?: string } | null;
}

interface GqlBoardItem {
  __typename?: string;
  id: string;
  isArchived: boolean;
  updatedAt?: string;
  project?: { id: string } | null;
  fieldValues: { nodes: GqlFieldValue[] };
  content: GqlContent | null;
}

function boardBase(src: Board): string {
  return `/${src.ownerType === 'org' ? 'orgs' : 'users'}/${encodeURIComponent(src.owner)}/projectsV2/${src.number}`;
}

function repoOfUrl(url: string | undefined): string | null {
  const m = url?.match(/\/repos\/([^/]+)\/([^/]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * A board: the changed items since the last read, re-read and merged. `count` = GitHub's item count
 * this round (null = not known: the merged snapshot cannot be checked, so the source is read in full).
 */
export async function readBoardChanges(
  client: GitHubClient,
  src: Board,
  snap: SourceSnapshot,
  serverAt: number,
  count: number | null,
  now: number,
  loopLabel: LabelFor,
): Promise<DeltaResult> {
  if (count === null) return { kind: 'full', why: 'count' };
  const meta: ProjectMeta = snap.project!;
  const since = sinceOf(snap, src);
  const byItemId = new Map(snap.items.map((it) => [it.projects[0]!.itemId, it]));
  const byKey = new Map(snap.items.map((it) => [it.key, it]));
  const want = new Set<string>();
  const added = new Set<string>();
  // the board's own list: field values, items added
  const listed = await client.restList<RestBoardItem>(`${boardBase(src)}/items?per_page=100&q=${encodeURIComponent(`updated:>=${boardDay(since)}`)}`);
  for (const r of listed) {
    const id = r.node_id;
    const bt = ms(r.updated_at);
    if (!id || bt === null) return { kind: 'full', why: 'board-list' };
    const ct = r.content ? ms(r.content.updated_at) : null;
    if (bt <= since && (ct === null || ct <= since)) continue;
    const old = byItemId.get(id) ?? null;
    if (!old) {
      // not shown: a new item, or one counted but hidden (archived, a draft) that changed — it may
      // have come back (restored from the archive, a draft turned into an issue), so it is read too
      if (!snap.boardItemIds!.includes(id)) added.add(id);
      want.add(id);
      continue;
    }
    if (needsRead(old, { board: bt, ...(r.content ? { content: ct } : {}) }, true)) want.add(id);
  }
  // each repository's own list: the issue / PR itself
  const repos = new Set(snap.items.map((it) => it.repo));
  for (const repo of repos) {
    const [o, n] = repo.split('/');
    const list = await client.restList<{ number?: number; updated_at?: string }>(
      `/repos/${encodeURIComponent(o)}/${encodeURIComponent(n)}/issues?state=all&since=${encodeURIComponent(new Date(since).toISOString())}&per_page=100`,
    );
    for (const r of list) {
      if (typeof r.number !== 'number') return { kind: 'full', why: 'repo-list' };
      const old = byKey.get(itemKey(repo, r.number));
      if (!old) continue; // not on this board (an item added to it shows in the board list)
      const ct = ms(r.updated_at);
      if (needsRead(old, { content: ct }, true)) want.add(old.projects[0]!.itemId);
    }
  }
  // not yet certain the last read saw them: re-read, whatever the lists say
  for (const it of unstableItems(snap, src)) want.add(it.projects[0]!.itemId);
  if (want.size > DELTA_MAX) return { kind: 'full', why: 'too-many' };
  const ids = [...want];
  const gone = new Set<string>();
  const fresh = new Map<string, Item>();
  const hidden = new Set<string>();
  if (ids.length) {
    const data = await client.graphql<{ nodes: (GqlBoardItem | null)[] }>(PROJECT_ITEMS_BY_IDS_QUERY, { ids });
    if (!Array.isArray(data.nodes) || data.nodes.length !== ids.length) throw new GitHubError('graphql', t('读取变化：回应的条数和请求的不一致'));
    for (let i = 0; i < ids.length; i++) {
      const node = data.nodes[i];
      if (!node) {
        gone.add(ids[i]);
        continue;
      }
      if (node.__typename !== undefined && node.__typename !== 'ProjectV2Item') throw new GitHubError('graphql', t('读取变化：{id} 不是看板条目', { id: ids[i] }));
      // an item of another board: this board no longer has it
      if (node.project?.id !== meta.projectId) {
        gone.add(ids[i]);
        continue;
      }
      if (typeof node.updatedAt !== 'string' || !node.updatedAt) return { kind: 'full', why: 'no-time' };
      if (node.isArchived || !node.content || node.content.__typename === 'DraftIssue') {
        hidden.add(ids[i]);
        continue;
      }
      const c = await withRelations(client, node.content);
      const it = contentToItem(c, [readMembership(meta, node.id, node.fieldValues.nodes, node.updatedAt)], [src.key], now);
      if (!it) {
        hidden.add(ids[i]);
        continue;
      }
      if (!it.relations) throw new GitHubError('graphql', t('{item} 的关系没有读全', { item: `${it.repo}#${it.number}` }));
      if (!it.updatedAt) return { kind: 'full', why: 'no-time' };
      fresh.set(ids[i], { ...it, seenAt: serverAt });
    }
    await readLoopBlocked(client, [...fresh.values()], loopLabel);
  }
  const boardItemIds = [...snap.boardItemIds!.filter((id) => !gone.has(id)), ...[...added].filter((id) => !gone.has(id))];
  // GitHub's count is the only way an item taken off the board shows: they must agree
  if (boardItemIds.length !== count) return { kind: 'full', why: 'count-differs' };
  // in the board's own order, as a full read lists them: a changed item stays where it was, a new
  // one goes where its id is (the end) — the table's "Project 里的顺序" and each group's order follow it
  const items = new Map<string, Item>();
  for (const id of boardItemIds) {
    if (hidden.has(id)) continue;
    const it = fresh.get(id) ?? byItemId.get(id);
    if (it) items.set(it.key, it);
  }
  return {
    kind: 'read',
    count: ids.length,
    snap: { ...snap, fetchedAt: now, items: [...items.values()], boardItemIds, syncedThrough: serverAt, lastRead: { kind: 'delta', at: now, count: ids.length } },
  };
}

/** A repository: the issues / PRs updated since the last read, re-read (REST + their relations) and merged (GitHub#718: every item stays). */
export async function readRepoChanges(
  client: GitHubClient,
  src: Repo,
  snap: SourceSnapshot,
  serverAt: number,
  now: number,
  loopLabel: LabelFor,
  pendingLabel: string,
  batchSize: number = RELATION_BATCH_SIZE,
): Promise<DeltaResult> {
  const pending = pendingLabel.trim();
  if ((snap.pendingLabel ?? '') !== pending) return { kind: 'full', why: 'pending-label' };
  const repo = `${src.owner}/${src.name}`;
  const since = sinceOf(snap, src);
  const byKey = new Map(snap.items.map((it) => [it.key, it]));
  const list = await client.restList<{ number?: number; updated_at?: string }>(
    `/repos/${encodeURIComponent(src.owner)}/${encodeURIComponent(src.name)}/issues?state=all&since=${encodeURIComponent(new Date(since).toISOString())}&per_page=100`,
  );
  const picked: { item: Item; related: boolean }[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    if (typeof r.number !== 'number' || ms(r.updated_at) === null) return { kind: 'full', why: 'repo-list' };
    const key = itemKey(repo, r.number);
    seen.add(key);
    const old = byKey.get(key) ?? null;
    if (!needsRead(old, { content: ms(r.updated_at) }, false)) continue;
    picked.push(repoListItem(repo, r, src.key));
  }
  // an unstable item the list did not show (transferred, deleted, …): only a full read can tell
  if (unstableItems(snap, src).some((it) => !seen.has(it.key))) return { kind: 'full', why: 'unstable-missing' };
  if (picked.length > DELTA_MAX) return { kind: 'full', why: 'too-many' };
  const fresh = picked.map((p) => p.item);
  if (fresh.length) await completeRepoItems(client, repo, fresh, new Map(picked.map((p) => [p.item.key, p.related])), now, batchSize, loopLabel, pending);
  const items = new Map(snap.items.map((it) => [it.key, it]));
  for (const it of fresh) items.set(it.key, { ...it, seenAt: serverAt });
  return {
    kind: 'read',
    count: fresh.length,
    snap: {
      ...snap,
      fetchedAt: now,
      items: [...items.values()],
      syncedThrough: serverAt,
      lastRead: { kind: 'delta', at: now, count: fresh.length },
    },
  };
}
