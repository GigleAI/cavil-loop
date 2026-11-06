import type { ItemKind, ItemState } from '../shared/types';

/**
 * The type badge at the top of the detail panel (GitHub#172): an issue and a PR
 * differ by shape and full name, the colour only says open / closed / merged.
 *
 * `state` is the board item's own (there as soon as the panel opens, the same
 * as today); `isDraft` comes from the detail read and is null until it arrives
 * or when it failed. Closed and merged always win over a draft mark: only an
 * open PR the detail confirmed as a draft turns grey.
 */
export type BadgeTone = ItemState | 'draft';

const NAME: Record<ItemKind, string> = { issue: 'Issue', pr: 'Pull Request' };
const TEXT: Record<BadgeTone, string> = { open: '开', closed: '已关闭', merged: '已合并', draft: '草稿' };
const SPOKEN: Record<BadgeTone, string> = { open: '开着', closed: '已关闭', merged: '已合并', draft: '草稿' };

export function badgeTone(kind: ItemKind, state: ItemState, isDraft: boolean | null): BadgeTone {
  return kind === 'pr' && state === 'open' && isDraft === true ? 'draft' : state;
}

/** circle with a dot */
function IssueIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" data-icon="issue">
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="1.75" fill="currentColor" />
    </svg>
  );
}

/** two nodes on a line, a third joined back to it */
function PrIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" data-icon="pr" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="4" cy="3.5" r="1.75" />
      <circle cx="4" cy="12.5" r="1.75" />
      <circle cx="12" cy="12.5" r="1.75" />
      <path d="M4 5.25v5.5" />
      <path d="M12 10.75V6.5a2 2 0 0 0-2-2H7.5" />
      <path d="M9 3l-1.5 1.5L9 6" />
    </svg>
  );
}

export function KindBadge({ kind, state, isDraft }: { kind: ItemKind; state: ItemState; isDraft: boolean | null }) {
  const tone = badgeTone(kind, state, isDraft);
  return (
    <span
      className={`kind-badge ${tone}`}
      role="img"
      aria-label={`${NAME[kind]}，${SPOKEN[tone]}`}
      data-testid="detail-kind"
      data-kind={kind}
      data-tone={tone}
    >
      {kind === 'pr' ? <PrIcon /> : <IssueIcon />}
      <span className="kind-name">{NAME[kind]}</span>
      <span className="kind-sep">·</span>
      <span className="kind-state">{TEXT[tone]}</span>
    </span>
  );
}
