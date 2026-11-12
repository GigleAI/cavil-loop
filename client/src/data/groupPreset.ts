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
//     not read" is never taken for "there is none";
//   - GitHub#276: every ticked Project whose iteration is still empty after that
//     gets the iteration `today` falls in (the table's "当前" rule), unless the
//     group is an iteration or a "no iteration" one. Nothing to say when it is set
//     or when there is none; only two at once (overlapping dates) is said, and
//     then nothing is guessed. The unticked boards are never touched by this.

import type { CreatePlan, GroupPreset, IterationPick, MilestonePick, Picks, RepoOptions } from '../shared/actions';
export type { IterationPick, MilestonePick, Picks } from '../shared/actions';
import { isCurrentIteration, iterationSections } from '../shared/filter';
import type { Item, Iteration, ProjectMeta } from '../shared/types';

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
export function previewCreate(preset: GroupPreset, projects: ProjectMeta[], repo: string, read: MilestoneRead, others: ProjectMeta[] = [], today: string | null = null): CreatePreview {
  const out = previewGroup(preset, projects, repo, read, others);
  if (out.plan && today !== null && fillsCurrentIteration(preset)) fillCurrentIteration(out.plan, projects, today, out.lines);
  return out;
}

/** What the iteration picker holds when not touched: the group's iteration, none for a "no iteration" group, else the current one. */
export function defaultIterationPick(preset: GroupPreset): IterationPick {
  if (preset.by === 'iteration') return { kind: 'set', title: preset.title, startDate: preset.startDate };
  if (preset.by === 'none' && preset.field === 'iteration') return { kind: 'none' };
  return { kind: 'auto' };
}

/** What the milestone picker holds when not touched: the group's milestone, else none. */
export function defaultMilestonePick(preset: GroupPreset): MilestonePick {
  return preset.by === 'milestone' ? { kind: 'set', title: preset.title } : { kind: 'none' };
}

export function samePick(a: IterationPick | MilestonePick, b: IterationPick | MilestonePick): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind !== 'set' || b.kind !== 'set') return true;
  return a.title === b.title && ('startDate' in a ? a.startDate : '') === ('startDate' in b ? b.startDate : '');
}

/** Whether any ticked board can take an iteration from this dialog: only then is the iteration picker shown. */
export function canPickIteration(projects: ProjectMeta[]): boolean {
  return projects.some(carriesIteration);
}

function carriesIteration(p: ProjectMeta): boolean {
  return p.viewerCanUpdate && p.hasIterationField && Boolean(p.iterationFieldId);
}

/** The key of an iteration across boards (the table's grouping key): title + start date. */
export function iterationKey(it: { title: string; startDate: string }): string {
  return `${it.title}\u0000${it.startDate}`;
}

/**
 * The iterations the picker offers: the current and upcoming ones of the ticked boards that can
 * take one, one entry per title + start date (`id` = that key), so the picker's sections and order
 * are the detail panel's. Ended ones are not offered.
 */
export function iterationChoices(projects: ProjectMeta[], today: string): Iteration[] {
  const out = new Map<string, Iteration>();
  for (const p of projects.filter(carriesIteration))
    for (const it of p.iterations) {
      const k = iterationKey(it);
      if (!out.has(k)) out.set(k, { ...it, id: k });
    }
  const s = iterationSections([...out.values()], today);
  return [...s.current, ...s.upcoming];
}

/** The milestones the picker offers: the repository's open ones, one per title (the title is what a plan picks by). */
export function milestoneChoices(read: MilestoneRead): string[] {
  if (read.state !== 'ok') return [];
  const out: string[] = [];
  for (const m of read.milestones) if (m.state === 'open' && !out.includes(m.title)) out.push(m.title);
  return out;
}

/**
 * GitHub#372: the plan of a new issue with the pickers' values. One rule with the group's "+":
 * a picked iteration is planned exactly like an iteration group, a picked milestone exactly like a
 * milestone group (`previewGroup`), and a status group keeps its status. Untouched pickers give
 * the same plan as `previewCreate` (pinned by the unit tests). Unticked boards are only watched
 * for the group's own value (GitHub#258): a different iteration picked by hand is set on the
 * ticked boards only.
 */
export function previewCreateWith(preset: GroupPreset, picks: Picks, projects: ProjectMeta[], repo: string, read: MilestoneRead, others: ProjectMeta[] = [], today: string | null = null): CreatePreview {
  const groupIt = defaultIterationPick(preset);
  const it = picks.iteration ?? groupIt;
  const ms = picks.milestone ?? defaultMilestonePick(preset);
  const parts: CreatePreview[] = [];
  // the group's own value when it is neither an iteration nor a milestone (status, repository, none)
  if (preset.by !== 'iteration' && preset.by !== 'milestone') parts.push(previewGroup(preset, projects, repo, read, others));
  if (it.kind === 'set') parts.push(previewGroup({ by: 'iteration', title: it.title, startDate: it.startDate }, projects, repo, read, samePick(it, groupIt) ? others : []));
  else if (it.kind === 'none') parts.push(previewGroup({ by: 'none', field: 'iteration' }, projects, repo, read, others));
  if (ms.kind === 'set') parts.push(previewGroup({ by: 'milestone', title: ms.title }, projects, repo, read, others));
  const lines: PreviewLine[] = [];
  for (const part of parts) for (const l of part.lines) if (!lines.some((x) => x.target === l.target && x.text === l.text)) lines.push(l);
  const blocked = parts.find((x) => x.blocked)?.blocked ?? null;
  if (parts.some((x) => !x.plan)) return { plan: null, lines, blocked };
  const plans = parts.map((x) => x.plan!);
  const watch = plans.flatMap((x) => x.watch ?? []);
  const plan: CreatePlan = {
    milestone: plans.find((x) => x.milestone)?.milestone ?? null,
    projects: projects.map((p) => {
      const mine = plans.map((x) => x.projects.find((e) => e.projectKey === p.key));
      return { projectKey: p.key, iterationId: mine.find((e) => e?.iterationId)?.iterationId ?? null, status: mine.find((e) => e?.status)?.status ?? null };
    }),
    ...(watch.length ? { watch } : {}),
  };
  if (it.kind === 'auto' && today !== null) fillCurrentIteration(plan, projects, today, lines);
  return { plan, lines, blocked };
}

/** GitHub#276: does a new issue from this group get the current iteration where its own value leaves it empty? */
export function fillsCurrentIteration(preset: GroupPreset): boolean {
  if (preset.by === 'iteration') return false;
  if (preset.by === 'none' && preset.field === 'iteration') return false;
  return true;
}

/**
 * GitHub#276: the iteration `today` falls in, for each ticked Project the plan leaves without one.
 * A Project this account cannot change, or without an iteration field, or with no current one:
 * left as it is, said nowhere (the iteration was not asked for). Two or more current at once:
 * not guessed, one line saying so.
 */
function fillCurrentIteration(plan: CreatePlan, projects: ProjectMeta[], today: string, lines: PreviewLine[]): void {
  for (const entry of plan.projects) {
    if (entry.iterationId !== null) continue;
    const p = projects.find((x) => x.key === entry.projectKey);
    if (!p || !p.viewerCanUpdate || !p.hasIterationField || !p.iterationFieldId) continue;
    const current = p.iterations.filter((it) => isCurrentIteration(it, today));
    if (current.length === 1) entry.iterationId = current[0].id;
    else if (current.length > 1)
      lines.push({ target: `${p.key}:iteration`, text: `看板「${p.title}」同时有 ${current.length} 个当前迭代（日期重叠），没有自动设迭代`, applies: false });
  }
}

function previewGroup(preset: GroupPreset, projects: ProjectMeta[], repo: string, read: MilestoneRead, others: ProjectMeta[]): CreatePreview {
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
