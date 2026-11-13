// What a new issue is handed to when it is created (GitHub#245): nobody, the agent, or autopilot.
// One set of rules, used by the dialog (what it shows, what the web page gets) and by the data layer
// (what the create request carries, checked again from a fresh read): pure, no Node, no GitHub.

import type { HandBackLabels } from './types';
import { t } from './i18n';

export type Handoff = 'none' | 'agent' | 'autopilot';
export const HANDOFFS: readonly Handoff[] = ['none', 'agent', 'autopilot'];

/** Whatever was saved: one of the three, anything else is "none" (never hand over by accident). */
export function normalizeHandoff(raw: unknown): Handoff {
  return HANDOFFS.includes(raw as Handoff) ? (raw as Handoff) : 'none';
}

/** The labels a hand-over adds, by the names in Settings: autopilot first, then the agent one. null = no autopilot label set. */
export function handoffLabelNames(h: Handoff, hb: HandBackLabels): string[] | null {
  if (h === 'none') return [];
  const agent = hb.agent.trim();
  if (h === 'agent') return [agent];
  const auto = hb.autopilot.trim();
  return auto ? [auto, agent] : null;
}

/** The repository's labels as far as they are known: still being read, could not be read, or read. */
export type LabelRead = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ok'; names: string[] };

/**
 * Can `h` be used in this repository, and with which labels exactly (the repository's own spelling)?
 *   ok      — every label is there
 *   loading — not known yet
 *   error   — the list could not be read: unknown, never "the repository has none"
 *   missing — the list was read and these labels are not in it (sending them would make GitHub create them)
 *   unset   — autopilot with no autopilot label in Settings
 */
export type HandoffCheck =
  | { state: 'ok'; labels: string[] }
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'missing'; missing: string[] }
  | { state: 'unset' };

export function checkHandoff(h: Handoff, hb: HandBackLabels, read: LabelRead): HandoffCheck {
  const names = handoffLabelNames(h, hb);
  if (names === null) return { state: 'unset' };
  if (!names.length) return { state: 'ok', labels: [] };
  if (read.state !== 'ok') return read;
  // GitHub label names are case-insensitive: use the repository's spelling
  const byLower = new Map(read.names.map((n) => [n.toLowerCase(), n]));
  const missing = names.filter((n) => !byLower.has(n.toLowerCase()));
  if (missing.length) return { state: 'missing', missing };
  return { state: 'ok', labels: names.map((n) => byLower.get(n.toLowerCase())!) };
}

/** The hand-over labels first, then the ones picked by hand; one of each (case-insensitive). */
export function mergeLabels(handoff: string[], picked: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of [...handoff, ...picked]) {
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

/** Labels sent with a new issue that GitHub's answer does not carry (case-insensitive). */
export function droppedLabels(sent: string[], got: string[]): string[] {
  const have = new Set(got.map((n) => n.toLowerCase()));
  return sent.filter((n) => !have.has(n.toLowerCase()));
}

/** The dialog's line under the choice: which labels go on, what happens next. */
export function handoffSummary(h: Handoff, labels: string[]): string {
  if (h === 'none' || !labels.length) return '';
  const list = labels.map((n) => t('「{name}」', { name: n })).join(t('和'));
  if (h === 'agent') return t('会加上标签{list}，建好后 daemon 派给 agent', { list });
  return t('会加上标签{list}：agent 从方案到合并不再等人确认，复审和检查通过后由 daemon 自动合并。要叫停，在网页上去掉「{first}」', { list, first: labels[0] });
}

/** Why `h` cannot be used now, for the line next to it; '' when it can. */
export function handoffProblem(repo: string, check: HandoffCheck): string {
  switch (check.state) {
    case 'ok':
      return '';
    case 'loading':
      return t('正在读取仓库 {repo} 的标签…', { repo });
    case 'error':
      return t('读不到仓库 {repo} 的标签，暂时不能确认标签在不在（{error}）', { repo, error: check.error });
    case 'missing':
      return t('仓库 {repo} 没有标签{names}', { repo, names: check.missing.map((n) => t('「{name}」', { name: n })).join(t('、')) });
    case 'unset':
      return t('设置里没有填托管标签');
  }
}
