import type { IssueStateReason, ItemKind, ItemState } from '../shared/types';
import { badgeText, stateTone } from '../shared/stateTone';

/**
 * The type badge at the top of the detail panel (GitHub#172): an issue and a PR
 * differ by shape and full name; the background is GitHub's state colour
 * (`stateTone`, the same rule the board card and the table row use).
 *
 * `state` / `reason` are the board item's own (there as soon as the panel
 * opens). `isDraft` is chosen by the caller: the detail read's mark when it has
 * arrived (fresher), otherwise the board item's; null when neither knows, and
 * then it is not treated as a draft. Closed and merged always win over a draft
 * mark: only an open PR marked as a draft turns grey.
 */
const NAME: Record<ItemKind, string> = { issue: 'Issue', pr: 'Pull Request' };

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

export function KindBadge({
  kind,
  state,
  reason,
  isDraft,
}: {
  kind: ItemKind;
  state: ItemState;
  reason: IssueStateReason | null | undefined;
  isDraft: boolean | null;
}) {
  const tone = stateTone(kind, state, reason, isDraft);
  const text = badgeText(kind, state, reason, isDraft);
  return (
    <span className={`kind-badge ${tone}`} role="img" aria-label={`${NAME[kind]}，${text}`} data-testid="detail-kind" data-kind={kind} data-tone={tone}>
      {kind === 'pr' ? <PrIcon /> : <IssueIcon />}
      <span className="kind-name">{NAME[kind]}</span>
      <span className="kind-sep">·</span>
      <span className="kind-state">{text}</span>
    </span>
  );
}
