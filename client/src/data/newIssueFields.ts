// GitHub#405: the new-issue dialog keeps its labels, milestone and iteration in one fold, shut when
// the dialog opens. The fold's head line says what the three are set to. What it says about the
// iteration and the milestone is the text of the option the picker holds — one function for both,
// fed the same list of current iteration names, so the folded line and the open picker never disagree.

import type { Iteration, ProjectMeta } from '../shared/types';
import { isCurrentIteration } from '../shared/filter';
import type { MilestoneRead } from './groupPreset';
import { t, tKey, zhKey } from '../shared/i18n';

/** what marks a current iteration among a picker's options */
export const CURRENT_MARK = zhKey('（当前）');

/** one iteration in the new-issue dialog's picker, before the mark */
export function iterationOptionLabel(it: Iteration): string {
  return t('{title}（{date} 起）', { title: it.title, date: it.startDate });
}

/**
 * The names of the iterations `today` falls in, on the ticked boards that can take an iteration:
 * every board's current ones together, each name once. A board with none adds nothing; two boards
 * (or one board with overlapping dates) on the same name give that name once.
 */
export function currentIterationNames(ticked: ProjectMeta[], today: string): string[] {
  return [...new Set(ticked.filter((p) => p.viewerCanUpdate && p.hasIterationField && p.iterationFieldId).flatMap((p) => p.iterations.filter((i) => isCurrentIteration(i, today)).map((i) => i.title)))];
}

/** "当前迭代": the one name when there is exactly one, otherwise "按各看板" (each board its own, or none) */
export function autoIterationText(currents: string[]): string {
  return currents.length === 1 ? t('当前迭代（{name}）', { name: currents[0] }) : t('当前迭代（按各看板）');
}

/**
 * The text of the iteration picker's option with this value: `auto`, `none`, an offered iteration's
 * id, or the kept one (an ended iteration a group gave, shown by its title alone). '' = no such option.
 */
export function iterationPickText(value: string, choices: Iteration[], kept: Iteration | null, currents: string[], today: string): string {
  if (value === 'auto') return autoIterationText(currents);
  if (value === 'none') return t('不设迭代');
  const it = choices.find((i) => i.id === value);
  if (it) return iterationOptionLabel(it) + (isCurrentIteration(it, today) ? tKey(CURRENT_MARK) : '');
  if (kept && kept.id === value) return kept.title;
  return '';
}

/** what the milestone picker shows, by the same read: still reading / unreadable / the value */
export function milestoneText(read: MilestoneRead, value: string): { text: string; tone: 'plain' | 'muted' | 'error' } {
  if (read.state === 'loading') return { text: t('读取里程碑…'), tone: 'muted' };
  if (read.state === 'error') return { text: t('里程碑读取失败'), tone: 'error' };
  return value ? { text: value, tone: 'plain' } : { text: t('不设里程碑'), tone: 'muted' };
}

/** how many chosen labels the folded line shows by name before "+N" */
export const FOLD_LABELS_SHOWN = 3;

export type LabelsRead = 'loading' | 'error' | 'ok';

export type FoldPart =
  | { kind: 'labels'; names: string[]; more: number }
  | { kind: 'text'; field: 'labels' | 'milestone' | 'iteration'; text: string; tone: 'plain' | 'muted' | 'error' };

/**
 * The fold's title and its head line. Chosen labels are named (the first few, then "+N") even
 * while the list is being read — they were picked from an earlier read and go with the issue; only
 * with none chosen does the line say the list is still being read / could not be read. The
 * iteration part is left out when no ticked board can take one (the picker is not shown then).
 */
export function foldSummary(input: {
  labels: string[];
  labelsRead: LabelsRead;
  milestone: { text: string; tone: 'plain' | 'muted' | 'error' };
  /** the iteration picker's chosen option text; null = no iteration picker */
  iteration: string | null;
}): { title: string; parts: FoldPart[] } {
  const parts: FoldPart[] = [];
  if (input.labels.length) parts.push({ kind: 'labels', names: input.labels.slice(0, FOLD_LABELS_SHOWN), more: Math.max(0, input.labels.length - FOLD_LABELS_SHOWN) });
  else if (input.labelsRead === 'loading') parts.push({ kind: 'text', field: 'labels', text: t('读取标签…'), tone: 'muted' });
  else if (input.labelsRead === 'error') parts.push({ kind: 'text', field: 'labels', text: t('标签读取失败'), tone: 'error' });
  else parts.push({ kind: 'text', field: 'labels', text: t('未选标签'), tone: 'muted' });
  parts.push({ kind: 'text', field: 'milestone', ...input.milestone });
  if (input.iteration !== null) parts.push({ kind: 'text', field: 'iteration', text: input.iteration, tone: 'plain' });
  return { title: input.iteration !== null ? t('标签、里程碑、迭代') : t('标签、里程碑'), parts };
}
