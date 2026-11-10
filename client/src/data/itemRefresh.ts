// After a change succeeded on GitHub, read that one item again and put the
// fresh copy into every cached source that carries it. Still "GitHub is the
// only source": the cache only ever takes what GitHub just answered; a
// failed re-read changes nothing (the next sync round reads it anyway).

import type { Item, ProjectMeta, SourceSnapshot } from '../shared/types';
import { GitHubClient, GitHubError } from './github';
import { contentToItem, readMembership, withRelations, type GqlContent, type GqlFieldValue } from './fetchSources';
import { ITEM_REFRESH_QUERY } from './queries';

interface GqlProjectItem {
  id: string;
  isArchived: boolean;
  project: { id: string };
  fieldValues: { nodes: GqlFieldValue[] };
}

export interface FreshItem {
  /** GitHub#349: epoch ms taken before the read went out (when its relations are from) */
  readAt: number;
  content: GqlContent;
  projectItems: GqlProjectItem[];
}

export async function fetchItem(client: GitHubClient, repo: string, number: number, now: number = Date.now()): Promise<FreshItem> {
  const [owner, name] = repo.split('/');
  const data = await client.graphql<{ repository: { issueOrPullRequest: (GqlContent & { projectItems?: { nodes: GqlProjectItem[] } }) | null } | null }>(
    ITEM_REFRESH_QUERY,
    { owner, name, number },
  );
  const c = data.repository?.issueOrPullRequest;
  if (!c) throw new GitHubError('graphql', `找不到 ${repo}#${number}`);
  // GitHub#349: the same relation fields as a full read, read to the last page the same way —
  // a re-read that cannot finish them fails as a whole (the item keeps what the cache holds)
  return { readAt: now, content: await withRelations(client, c), projectItems: c.projectItems?.nodes ?? [] };
}

/**
 * What `fresh` says each snapshot should hold for this item: the item as that
 * source carries it, or null when it is not there (a Project it is not on, or
 * archived there). Sources it says nothing about (another repository) are left
 * out. The one rule both the cache update and the check of a pending change
 * (GitHub#229) read the re-read through.
 */
export function freshViews(snapshots: SourceSnapshot[], fresh: FreshItem): { snap: SourceSnapshot; item: Item | null }[] {
  const base = contentToItem(fresh.content, [], [], fresh.readAt);
  if (!base) return [];
  const out: { snap: SourceSnapshot; item: Item | null }[] = [];
  for (const snap of snapshots) {
    if (snap.project) {
      const meta: ProjectMeta = snap.project;
      const pi = fresh.projectItems.find((p) => p.project.id === meta.projectId && !p.isArchived);
      out.push({ snap, item: pi ? { ...base, projects: [readMembership(meta, pi.id, pi.fieldValues.nodes)], sources: [snap.sourceKey] } : null });
    } else if (snap.sourceKey === `repo:${base.repo.toLowerCase()}`) {
      out.push({ snap, item: { ...base, projects: [], sources: [snap.sourceKey] } });
    }
  }
  return out;
}

/** The key of the item `fresh` describes (null when GitHub returned something the board cannot show). */
export function freshKey(fresh: FreshItem): string | null {
  return contentToItem(fresh.content, [], [])?.key ?? null;
}

/**
 * Put `fresh` into the snapshots. Returns only the snapshots that changed
 * (same fetchedAt: the rest of the source is as old as it was).
 *   Project source: the item is on that Project (not archived) → upsert with that Project's values;
 *                   not on it → removed from that source.
 *   repository source of the item's repository → upsert.
 *   anything else → untouched.
 */
export function applyFreshItem(snapshots: SourceSnapshot[], fresh: FreshItem): SourceSnapshot[] {
  const key = freshKey(fresh);
  if (!key) return [];
  const changed: SourceSnapshot[] = [];
  for (const { snap, item: next } of freshViews(snapshots, fresh)) {
    const had = snap.items.some((x) => x.key === key);
    if (!next && !had) continue;
    // replace in place: the array order is the Project's own order ("Project 里的顺序"
    // in the table, and the board's tie order), so an edit must not move the item;
    // only an item new to this source is appended (the next full sync puts it where
    // GitHub has it)
    const items = next
      ? had
        ? snap.items.map((x) => (x.key === key ? next : x))
        : [...snap.items, next]
      : snap.items.filter((x) => x.key !== key);
    changed.push({ ...snap, items });
  }
  return changed;
}
