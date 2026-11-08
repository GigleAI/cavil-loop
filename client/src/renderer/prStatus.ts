// GitHub#260: the PR's merge state at the bottom of the detail panel, as four icons whose words
// show when the pointer rests on them. The words are the ones the panel always said; only the
// colour is new, and it is decided here, once: anything GitHub reports that is not listed below
// (a new value, or one still being computed) is "unknown", never "ok".

import type { PrStatus } from '../shared/actions';

export type PrTone = 'ok' | 'bad' | 'warn' | 'pending' | 'none';

export type PrStatusIcon = {
  key: 'merge' | 'conflict' | 'checks' | 'review';
  /** the short name shown next to the icon */
  name: string;
  /** the whole sentence: the tooltip and the text a screen reader reads */
  text: string;
  tone: PrTone;
};

export const MERGEABLE: Record<string, string> = { MERGEABLE: '没有冲突', CONFLICTING: '有冲突', UNKNOWN: 'GitHub 还在计算能否合并' };
export const MERGE_STATE: Record<string, string> = {
  CLEAN: '可以合并',
  BLOCKED: '被分支保护规则挡住（缺评审或必需检查没过）',
  BEHIND: '落后目标分支，规则要求先更新',
  DIRTY: '有冲突，合不了',
  UNSTABLE: '能合并，但有检查没通过',
  HAS_HOOKS: '可以合并（有合并前钩子）',
  DRAFT: '草稿 PR，不能合并',
  UNKNOWN: 'GitHub 还在计算',
};
export const CHECKS: Record<string, string> = { SUCCESS: '全部通过', FAILURE: '有失败', ERROR: '出错', PENDING: '进行中', EXPECTED: '等待中' };
export const REVIEW: Record<string, string> = { APPROVED: '已批准', CHANGES_REQUESTED: '要求修改', REVIEW_REQUIRED: '需要评审' };

const MERGE_TONE: Record<string, PrTone> = {
  CLEAN: 'ok',
  HAS_HOOKS: 'ok',
  UNSTABLE: 'warn',
  BLOCKED: 'warn',
  BEHIND: 'warn',
  DRAFT: 'warn',
  DIRTY: 'bad',
};
const MERGEABLE_TONE: Record<string, PrTone> = { MERGEABLE: 'ok', CONFLICTING: 'bad' };
const CHECKS_TONE: Record<string, PrTone> = { SUCCESS: 'ok', FAILURE: 'bad', ERROR: 'bad' };
const REVIEW_TONE: Record<string, PrTone> = { APPROVED: 'ok', CHANGES_REQUESTED: 'bad', REVIEW_REQUIRED: 'warn' };

const toneOf = (table: Record<string, PrTone>, v: string): PrTone => (Object.prototype.hasOwnProperty.call(table, v) ? table[v] : 'pending');
const say = (table: Record<string, string>, v: string): string => (Object.prototype.hasOwnProperty.call(table, v) ? table[v] : v);

/** The four icons of an open PR, in the order the panel always listed them. */
export function prStatusIcons(pr: Pick<PrStatus, 'mergeStateStatus' | 'mergeable' | 'checks' | 'reviewDecision'>): PrStatusIcon[] {
  return [
    { key: 'merge', name: '合并', text: `合并：${say(MERGE_STATE, pr.mergeStateStatus)}`, tone: toneOf(MERGE_TONE, pr.mergeStateStatus) },
    { key: 'conflict', name: '冲突', text: `冲突：${say(MERGEABLE, pr.mergeable)}`, tone: toneOf(MERGEABLE_TONE, pr.mergeable) },
    pr.checks
      ? { key: 'checks', name: '检查', text: `检查：${say(CHECKS, pr.checks)}`, tone: toneOf(CHECKS_TONE, pr.checks) }
      : { key: 'checks', name: '检查', text: '检查：没有检查', tone: 'none' },
    pr.reviewDecision
      ? { key: 'review', name: '评审', text: `评审：${say(REVIEW, pr.reviewDecision)}`, tone: toneOf(REVIEW_TONE, pr.reviewDecision) }
      : { key: 'review', name: '评审', text: '评审：无要求', tone: 'none' },
  ];
}
