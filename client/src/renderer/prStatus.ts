// GitHub#260: the PR's merge state at the bottom of the detail panel, as four icons whose words
// show when the pointer rests on them. The words are the ones the panel always said; only the
// colour is new, and it is decided here, once: anything GitHub reports that is not listed below
// (a new value, or one still being computed) is "unknown", never "ok".

import type { PrStatus } from '../shared/actions';
import { t, tKey, zhKey } from '../shared/i18n';

export type PrTone = 'ok' | 'bad' | 'warn' | 'pending' | 'none';

export type PrStatusIcon = {
  key: 'merge' | 'conflict' | 'checks' | 'review';
  /** the short name shown next to the icon */
  name: string;
  /** the whole sentence: the tooltip and the text a screen reader reads */
  text: string;
  tone: PrTone;
};

// the words are kept as their Chinese keys and shown in the current language by say()
export const MERGEABLE: Record<string, string> = { MERGEABLE: zhKey('没有冲突'), CONFLICTING: zhKey('有冲突'), UNKNOWN: zhKey('GitHub 还在计算能否合并') };
export const MERGE_STATE: Record<string, string> = {
  CLEAN: zhKey('可以合并'),
  BLOCKED: zhKey('被分支保护规则挡住（缺评审或必需检查没过）'),
  BEHIND: zhKey('落后目标分支，规则要求先更新'),
  DIRTY: zhKey('有冲突，合不了'),
  UNSTABLE: zhKey('能合并，但有检查没通过'),
  HAS_HOOKS: zhKey('可以合并（有合并前钩子）'),
  DRAFT: zhKey('草稿 PR，不能合并'),
  UNKNOWN: zhKey('GitHub 还在计算'),
};
export const CHECKS: Record<string, string> = { SUCCESS: zhKey('全部通过'), FAILURE: zhKey('有失败'), ERROR: zhKey('出错'), PENDING: zhKey('进行中'), EXPECTED: zhKey('等待中') };
export const REVIEW: Record<string, string> = { APPROVED: zhKey('已批准'), CHANGES_REQUESTED: zhKey('要求修改'), REVIEW_REQUIRED: zhKey('需要评审') };

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
const say = (table: Record<string, string>, v: string): string => (Object.prototype.hasOwnProperty.call(table, v) ? tKey(table[v]) : v);

/** The four icons of an open PR, in the order the panel always listed them. */
export function prStatusIcons(pr: Pick<PrStatus, 'mergeStateStatus' | 'mergeable' | 'checks' | 'reviewDecision'>): PrStatusIcon[] {
  return [
    { key: 'merge', name: t('合并'), text: t('合并：{state}', { state: say(MERGE_STATE, pr.mergeStateStatus) }), tone: toneOf(MERGE_TONE, pr.mergeStateStatus) },
    { key: 'conflict', name: t('冲突'), text: t('冲突：{state}', { state: say(MERGEABLE, pr.mergeable) }), tone: toneOf(MERGEABLE_TONE, pr.mergeable) },
    pr.checks
      ? { key: 'checks', name: t('检查'), text: t('检查：{state}', { state: say(CHECKS, pr.checks) }), tone: toneOf(CHECKS_TONE, pr.checks) }
      : { key: 'checks', name: t('检查'), text: t('检查：没有检查'), tone: 'none' },
    pr.reviewDecision
      ? { key: 'review', name: t('评审'), text: t('评审：{state}', { state: say(REVIEW, pr.reviewDecision) }), tone: toneOf(REVIEW_TONE, pr.reviewDecision) }
      : { key: 'review', name: t('评审'), text: t('评审：无要求'), tone: 'none' },
  ];
}
