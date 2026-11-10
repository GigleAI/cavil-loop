import type { BoardData, Item, ProjectMeta, SourceSnapshot } from '../shared/types';
import { relationsKnown } from './relations';

/** GitHub#349: which of the two copies of one item the relations are taken from (null: neither has any). */
function newerRelations(newer: Item, older: Item): Item | null {
  if (!newer.relations) return older.relations ? older : null;
  if (!older.relations) return newer;
  // read at the same moment (or a time is missing): the copy the other fields come from
  return (older.relationsAt ?? 0) > (newer.relationsAt ?? 0) ? older : newer;
}

/**
 * Merge the snapshots of the selected sources into one item list.
 * One item (issue / PR) = one entry no matter how many sources carry it:
 * Project memberships are unioned per Project, the content fields come from
 * the copy with the latest `updatedAt`. Relations (GitHub#349) come from the
 * copy that has them; when both do, from the one whose relations were read
 * later (`relationsAt`) — not the one with the later `updatedAt`: closing a
 * blocker changes what the blocked issue's relations say without touching the
 * blocked issue. A source whose snapshot predates relations is listed in
 * `relationsUnknown`.
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
      const { relations: _r, relationsAt: _t, ...rest } = newer;
      const from = newerRelations(newer, older);
      const rel = from ? { relations: from.relations!, ...(from.relationsAt !== undefined ? { relationsAt: from.relationsAt } : {}) } : {};
      byKey.set(it.key, { ...rest, linkedPrs: linked, ...rel, projects: memberships, sources });
    }
  }
  return { items: [...byKey.values()], projects, relationsUnknown: pick.filter((s) => !relationsKnown(s.items)).map((s) => s.sourceKey) };
}
