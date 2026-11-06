// The merge method the user last chose, remembered per repository (GitHub#175)
// so the detail panel does not start from the first method every time.
// Pure; shared by the controller (reads / writes the setting) and the detail
// panel (picks the default).

import type { MergeMethod } from './actions';

export const MERGE_METHODS: readonly MergeMethod[] = ['merge', 'squash', 'rebase'];

export interface MergePrefs {
  /** lower-cased `owner/repo` → the method last chosen there */
  byRepo: Record<string, MergeMethod>;
  /** the method last chosen in any repository */
  last: MergeMethod | null;
}

export const EMPTY_MERGE_PREFS: MergePrefs = { byRepo: {}, last: null };

const isMethod = (v: unknown): v is MergeMethod => typeof v === 'string' && (MERGE_METHODS as readonly string[]).includes(v);

export const repoKey = (repo: string) => repo.toLowerCase();

/** Whatever was saved: keep each valid entry, drop the rest (a missing or broken setting is "nothing remembered"). */
export function normalizeMergePrefs(raw: unknown): MergePrefs {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const byRepo: Record<string, MergeMethod> = {};
  if (typeof r.byRepo === 'object' && r.byRepo !== null && !Array.isArray(r.byRepo)) {
    for (const [k, v] of Object.entries(r.byRepo as Record<string, unknown>)) if (k && isMethod(v)) byRepo[repoKey(k)] = v;
  }
  return { byRepo, last: isMethod(r.last) ? r.last : null };
}

/**
 * The method the panel starts with in `repo`, among the ones the repository
 * allows: what was last chosen there, else what was last chosen anywhere, else
 * the first allowed one ('' when none is allowed).
 */
export function pickMergeMethod(prefs: MergePrefs, repo: string, allowed: readonly MergeMethod[]): MergeMethod | '' {
  for (const m of [prefs.byRepo[repoKey(repo)], prefs.last]) if (m && allowed.includes(m)) return m;
  return allowed[0] ?? '';
}

/** A choice the user made in `repo`. Unknown methods or an empty repo change nothing. */
export function rememberMergeMethod(prefs: MergePrefs, repo: string, method: unknown): MergePrefs {
  if (!repo || !isMethod(method)) return prefs;
  return { byRepo: { ...prefs.byRepo, [repoKey(repo)]: method }, last: method };
}
