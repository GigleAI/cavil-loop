import type { BoardData, Item, ProjectMeta, SourceSnapshot } from '../shared/types';

/**
 * Merge the snapshots of the selected sources into one item list.
 * One item (issue / PR) = one entry no matter how many sources carry it:
 * Project memberships are unioned per Project, the content fields come from
 * the copy with the latest `updatedAt`.
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
      byKey.set(it.key, { ...newer, projects: memberships, sources });
    }
  }
  return { items: [...byKey.values()], projects };
}
