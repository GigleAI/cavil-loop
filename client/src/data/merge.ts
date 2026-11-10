import type { BoardData, Item, ProjectMeta, SourceSnapshot } from '../shared/types';
import { relationsKnown } from './relations';

/**
 * Merge the snapshots of the selected sources into one item list.
 * One item (issue / PR) = one entry no matter how many sources carry it:
 * Project memberships are unioned per Project, the content fields come from
 * the copy with the latest `updatedAt`. Relations (GitHub#349) come from the
 * copy that has them — the newer one when both do; a source whose snapshot
 * predates them is listed in `relationsUnknown`.
 */
export function mergeSnapshots(snapshots: SourceSnapshot[], selected: string[] | null): BoardData {
  const pick = selected ? snapshots.filter((s) => selected.includes(s.sourceKey)) : snapshots;
  const byKey = new Map<string, Item>();
  const projects: ProjectMeta[] = [];
  for (const snap of pick) {
    if (snap.project) projects.push(snap.project);
    for (const it of snap.items) {
      const prev = byKey.get(it.key);
      if (!prev) {
        byKey.set(it.key, { ...it, projects: [...it.projects], sources: [...it.sources] });
        continue;
      }
      const newer = it.updatedAt > prev.updatedAt ? it : prev;
      const memberships = [...prev.projects];
      for (const m of it.projects) {
        if (!memberships.some((x) => x.projectKey === m.projectKey)) memberships.push(m);
      }
      const sources = [...prev.sources];
      for (const s of it.sources) if (!sources.includes(s)) sources.push(s);
      const older = newer === it ? prev : it;
      // a repository list does not know linked pull requests; take them from the copy that does
      const linked = newer.linkedPrs ?? older.linkedPrs;
      // a snapshot cached before #349 has no relations: unknown, so the other copy's are taken
      const relations = newer.relations ?? older.relations;
      byKey.set(it.key, { ...newer, linkedPrs: linked, ...(relations ? { relations } : {}), projects: memberships, sources });
    }
  }
  return { items: [...byKey.values()], projects, relationsUnknown: pick.filter((s) => !relationsKnown(s.items)).map((s) => s.sourceKey) };
}
