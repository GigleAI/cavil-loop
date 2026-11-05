// After a change succeeded on GitHub, read that one item again and put the
// fresh copy into every cached source that carries it. Still "GitHub is the
// only source": the cache only ever takes what GitHub just answered; a
// failed re-read changes nothing (the next sync round reads it anyway).

import type { Item, ProjectMeta, SourceSnapshot } from '../shared/types';
import { GitHubClient, GitHubError } from './github';
import { contentToItem, readMembership, type GqlContent, type GqlFieldValue } from './fetchSources';
import { ITEM_REFRESH_QUERY } from './queries';

interface GqlProjectItem {
  id: string;
  isArchived: boolean;
  project: { id: string };
  fieldValues: { nodes: GqlFieldValue[] };
}

export interface FreshItem {
  content: GqlContent;
  projectItems: GqlProjectItem[];
}

export async function fetchItem(client: GitHubClient, repo: string, number: number): Promise<FreshItem> {
  const [owner, name] = repo.split('/');
  const data = await client.graphql<{ repository: { issueOrPullRequest: (GqlContent & { projectItems?: { nodes: GqlProjectItem[] } }) | null } | null }>(
    ITEM_REFRESH_QUERY,
    { owner, name, number },
  );
  const c = data.repository?.issueOrPullRequest;
  if (!c) throw new GitHubError('graphql', `找不到 ${repo}#${number}`);
  return { content: c, projectItems: c.projectItems?.nodes ?? [] };
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
  const changed: SourceSnapshot[] = [];
  const base = contentToItem(fresh.content, [], []);
  if (!base) return changed;
  for (const snap of snapshots) {
    let next: Item | null = null;
    if (snap.project) {
      const meta: ProjectMeta = snap.project;
      const pi = fresh.projectItems.find((p) => p.project.id === meta.projectId && !p.isArchived);
      if (pi) next = { ...base, projects: [readMembership(meta, pi.id, pi.fieldValues.nodes)], sources: [snap.sourceKey] };
    } else if (snap.sourceKey === `repo:${base.repo.toLowerCase()}`) {
      next = { ...base, projects: [], sources: [snap.sourceKey] };
    } else continue;
    const had = snap.items.some((x) => x.key === base.key);
    if (!next && !had) continue;
    const items = snap.items.filter((x) => x.key !== base.key);
    if (next) items.push(next);
    changed.push({ ...snap, items });
  }
  return changed;
}
