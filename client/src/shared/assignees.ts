// Who an item is assigned to (GitHub#711): the rules every place that reads or changes assignees
// shares — matching an account, GitHub's cap, and the assignee picker's rows (detail and table cell
// build them here, so both offer exactly the same thing).
import { t } from './i18n';

/** GitHub logins are not case-sensitive: `Alice` and `alice` are one account. */
export function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** GitHub caps an issue / PR at this many assignees. */
export const MAX_ASSIGNEES = 10;

export interface AssigneeRow {
  name: string;
  login: string;
  checked: boolean;
  /** the signed-in account */
  note?: string;
  /** why it cannot be ticked now (the cap); unticking is never blocked */
  blocked?: string;
}

/**
 * The picker's rows: everyone assigned now (ticked — also when the candidate list could not be read,
 * or no longer has them, so they can always be taken off), then the repository's candidates. Once
 * the item has MAX_ASSIGNEES, the unticked ones are blocked, with the reason on the row.
 */
export function assigneeRows(assigned: readonly string[], candidates: readonly string[], viewer: string | null): AssigneeRow[] {
  const full = assigned.length >= MAX_ASSIGNEES;
  const rows: AssigneeRow[] = [];
  const add = (login: string, checked: boolean) => {
    if (rows.some((r) => sameLogin(r.login, login))) return;
    rows.push({
      name: login,
      login,
      checked,
      ...(viewer && sameLogin(viewer, login) ? { note: t('（自己）') } : {}),
      ...(!checked && full ? { blocked: t('GitHub 规定一条最多 {n} 个负责人，已经满了', { n: MAX_ASSIGNEES }) } : {}),
    });
  };
  for (const a of assigned) add(a, true);
  for (const c of candidates) add(c, false);
  return rows;
}
