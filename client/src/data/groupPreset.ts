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
  /** false = "will not be set" */
  applies: boolean;
  /**
   * GitHub#270: never shown in the dialog even when `applies` is false — not a value of the
   * ticked boards / repository that fails to land: the unticked boards (GitHub#258) and a group
   * with no value. The plan is the same with or without it.
   */
  quiet?: true;
}

export interface CreatePreview {
  /** null while it cannot be told what would be set (then creating is not offered) */
  plan: CreatePlan | null;
  lines: PreviewLine[];
  /** why creating is not offered now; null = it is */
  blocked: string | null;
}

/**
 * `others` (GitHub#258): the configured boards NOT ticked. For an iteration / status group each
 * one that could carry the value is watched after creating: if GitHub's own auto-add puts the
 * issue there and the field is still empty, the value is set (never added by the client, never
 * overwriting a value already there). They go into `plan.watch` and get a line of their own.
 */
export function previewCreate(preset: GroupPreset, projects: ProjectMeta[], repo: string, read: MilestoneRead, others: ProjectMeta[] = []): CreatePreview {
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
    const watch = watchEntries(preset, projects, others, lines);
    return { plan: { milestone: null, projects: entries, ...(watch.length ? { watch } : {}) }, lines, blocked: null };
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
  if (preset.by === 'none') lines.push({ target: 'group', text: '这一组没有值，不设字段', applies: false, quiet: true });
  return { plan: { milestone: null, projects: entries }, lines, blocked: null };
}

/**
 * GitHub#270: what the dialog shows of a preview — only what will NOT happen as the group
 * says (a value the ticked boards / repository cannot take, a milestone list still being read
 * or unreadable). Everything that will be set is already in the dialog title, and the unticked
 * boards are never announced; nothing to show = no box at all.
 */
export function shownLines(preview: CreatePreview): PreviewLine[] {
  return preview.lines.filter((l) => !l.applies && !l.quiet);
}

/** The boards not ticked that are watched after creating (GitHub#258), each with its line. */
function watchEntries(preset: Extract<GroupPreset, { by: 'iteration' | 'status' }>, ticked: ProjectMeta[], others: ProjectMeta[], lines: PreviewLine[]): NonNullable<CreatePlan['watch']> {
  const out: NonNullable<CreatePlan['watch']> = [];
  const what = preset.by === 'iteration' ? '迭代' : '状态';
  const value = preset.by === 'iteration' ? preset.title : preset.status;
  for (const p of others) {
    if (ticked.some((t) => t.key === p.key)) continue;
    const head = `看板「${p.title}」没勾`;
    if (!p.viewerCanUpdate) {
      lines.push({ target: p.key, text: `${head}：这个账号不能修改它，GitHub 自动收进这条也不会补设${what}`, applies: false, quiet: true });
      continue;
    }
    if (preset.by === 'iteration') {
      const it = p.hasIterationField && p.iterationFieldId ? p.iterations.find((x) => x.title === preset.title && x.startDate === preset.startDate) : undefined;
      if (!it) {
        lines.push({ target: p.key, text: `${head}：没有这个迭代，GitHub 自动收进这条也不会补设迭代`, applies: false, quiet: true });
        continue;
      }
      out.push({ projectKey: p.key, iterationId: it.id, status: null, label: value });
    } else {
      if (!(p.statusFieldId && p.statusOptionIds.some((o) => o.name === preset.status))) {
        lines.push({ target: p.key, text: `${head}：没有这个状态，GitHub 自动收进这条也不会补设状态`, applies: false, quiet: true });
        continue;
      }
      out.push({ projectKey: p.key, iterationId: null, status: preset.status, label: value });
    }
    lines.push({ target: p.key, text: `${head}：如果 GitHub 按它的自动加入规则收进这条、${what}还空着，会补设 ${what} = ${value}（已有别的值不改，提示里可一键改）`, applies: true, quiet: true });
  }
  return out;
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
