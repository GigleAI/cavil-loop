// A new issue from a table group's "+" (GitHub#214): what it will carry. Pure,
// shared by the dialog (what it shows) and the tests. The write layer never
// re-derives any of this: it receives the plan the dialog showed and only
// checks it again against GitHub right before writing (actions.ts).
//
// Rules:
//   - iteration / status belong to each Project: every ticked Project gets the
//     one with the same name (an iteration also the same start date — the key
//     the table and the board group by); a Project without it only gets the item;
//   - milestone belongs to the repository: the one with that title, an open one
//     first (the same rule as changing it in the detail, `pickMilestone`);
//   - the milestone list not read yet, or not readable: no plan at all — "could
//     not read" is never taken for "there is none".

import type { CreatePlan, GroupPreset, RepoOptions } from '../shared/actions';
import type { Item, ProjectMeta } from '../shared/types';

/** The repository's milestone with this title: an open one first. One rule for the detail and for a new issue. */
export function pickMilestone<T extends { title: string; state: string }>(list: T[], title: string): T | null {
  const same = list.filter((m) => m.title === title);
  return same.find((m) => m.state === 'open') ?? same[0] ?? null;
}

/** The chosen repository's milestones, as far as the dialog knows them. */
export type MilestoneRead = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ok'; milestones: RepoOptions['milestones'] };

export interface PreviewLine {
  /** a Project key, or `milestone` / `group` */
  target: string;
  text: string;
  /** false = shown as "will not be set" */
  applies: boolean;
}

export interface CreatePreview {
  /** null while it cannot be told what would be set (then creating is not offered) */
  plan: CreatePlan | null;
  lines: PreviewLine[];
  /** why creating is not offered now; null = it is */
  blocked: string | null;
}

export function previewCreate(preset: GroupPreset, projects: ProjectMeta[], repo: string, read: MilestoneRead): CreatePreview {
  const lines: PreviewLine[] = [];
  const entries: CreatePlan['projects'] = projects.map((p) => ({ projectKey: p.key, iterationId: null, status: null }));
  if (preset.by === 'iteration' || preset.by === 'status') {
    const what = preset.by === 'iteration' ? '迭代' : '状态';
    const value = preset.by === 'iteration' ? preset.title : preset.status;
    if (projects.length === 0) lines.push({ target: 'group', text: `当前没有勾选看板，不会设置${what}`, applies: false });
    projects.forEach((p, i) => {
      const head = `看板「${p.title}」`;
      if (!p.viewerCanUpdate) return lines.push({ target: p.key, text: `${head}：这个账号不能修改它，不会设置${what}`, applies: false });
      if (preset.by === 'iteration') {
        const it = p.hasIterationField && p.iterationFieldId ? p.iterations.find((x) => x.title === preset.title && x.startDate === preset.startDate) : undefined;
        if (!it) return lines.push({ target: p.key, text: `${head}：没有这个迭代，只加入、不设迭代`, applies: false });
        entries[i].iterationId = it.id;
      } else {
        const ok = p.statusFieldId && p.statusOptionIds.some((o) => o.name === preset.status);
        if (!ok) return lines.push({ target: p.key, text: `${head}：没有这个状态，只加入、不设状态`, applies: false });
        entries[i].status = preset.status;
      }
      lines.push({ target: p.key, text: `${head}：${what} = ${value}`, applies: true });
    });
    return { plan: { milestone: null, projects: entries }, lines, blocked: null };
  }
  if (preset.by === 'milestone') {
    if (read.state === 'loading') {
      lines.push({ target: 'milestone', text: `正在读取仓库 ${repo} 的里程碑…`, applies: false });
      return { plan: null, lines, blocked: '还在读取里程碑' };
    }
    if (read.state === 'error') {
      lines.push({ target: 'milestone', text: `读不到仓库 ${repo} 的里程碑，没法确认能不能带上（${read.error}）`, applies: false });
      return { plan: null, lines, blocked: '读不到里程碑' };
    }
    const m = pickMilestone(read.milestones, preset.title);
    lines.push(
      m
        ? { target: 'milestone', text: `里程碑 = ${preset.title}`, applies: true }
        : { target: 'milestone', text: `仓库 ${repo} 没有「${preset.title}」这个里程碑，不会设置`, applies: false },
    );
    return { plan: { milestone: m ? { number: m.number, title: m.title } : null, projects: entries }, lines, blocked: null };
  }
  if (preset.by === 'repo') lines.push({ target: 'group', text: `仓库 = ${preset.repo}（已在上面预选）`, applies: true });
  if (preset.by === 'none') lines.push({ target: 'group', text: '这一组没有值，不设字段', applies: false });
  return { plan: { milestone: null, projects: entries }, lines, blocked: null };
}

/**
 * The repository the dialog starts on: the group's own for a repository group,
 * else the one most of the group's items are in (ties: the first in `repos`),
 * else the first of `repos`. Only repositories in `repos` are picked.
 */
export function defaultRepo(preset: GroupPreset, items: Item[], repos: string[]): string {
  const known = new Map(repos.map((r) => [r.toLowerCase(), r]));
  if (preset.by === 'repo' && known.has(preset.repo.toLowerCase())) return known.get(preset.repo.toLowerCase())!;
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.key)) continue;
    seen.add(it.key);
    const r = it.repo.toLowerCase();
    if (known.has(r)) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const r of repos) {
    const n = counts.get(r.toLowerCase()) ?? 0;
    if (n > 0 && (best === null || n > (counts.get(best.toLowerCase()) ?? 0))) best = r;
  }
  return best ?? repos[0] ?? '';
}
