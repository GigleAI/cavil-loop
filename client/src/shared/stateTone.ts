import type { IssueStateReason, ItemKind, ItemState } from './types';

/**
 * GitHub's state colours (GitHub#172 review: "keep issue / PR state colours the
 * same as GitHub"). GitHub's palette has four state roles:
 *   open    green   open issue, open PR
 *   closed  red     PR closed without merging
 *   done    purple  merged PR, issue closed as completed (or closed with no reason recorded)
 *   neutral grey    draft PR, issue closed as not planned / duplicate
 * The one rule every place that colours a state goes through (detail badge, board
 * card, table row).
 *
 * `isDraft` is the PR's draft mark: the lists (Project, repository, one-item re-read)
 * carry it, and the detail badge prefers the fresher detail read. null = not known,
 * never "draft". Closed and merged always win over a draft mark.
 * An issue closed before GitHub recorded reasons has none and GitHub shows it as
 * completed, so a missing reason is `done` too.
 */
export type StateTone = 'open' | 'closed' | 'done' | 'neutral';

export function stateTone(kind: ItemKind, state: ItemState, reason: IssueStateReason | null | undefined, isDraft: boolean | null): StateTone {
  if (kind === 'pr') {
    if (state === 'merged') return 'done';
    if (state === 'closed') return 'closed';
    return isDraft === true ? 'neutral' : 'open';
  }
  if (state === 'open') return 'open';
  return reason === 'not_planned' || reason === 'duplicate' ? 'neutral' : 'done';
}

const REASONS: IssueStateReason[] = ['completed', 'not_planned', 'duplicate', 'reopened'];

/** GraphQL `COMPLETED` / REST `completed` → `completed`; anything else (missing, a value GitHub may add later) → null */
export function parseStateReason(v: unknown): IssueStateReason | null {
  if (typeof v !== 'string') return null;
  const r = v.toLowerCase() as IssueStateReason;
  return REASONS.includes(r) ? r : null;
}
