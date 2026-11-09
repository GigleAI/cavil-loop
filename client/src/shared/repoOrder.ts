// The order repositories are listed in (GitHub#304): the table's repository slices, its
// "all repositories" sections, its "group by repository" groups, the board's swimlanes and the
// new-issue dialog's repository list all go by one saved order, kept on this machine (not part of
// the view settings, so importing a Project's web view never touches it).
// Pure; shared by the controller (reads / writes the setting) and the renderer.

/** Repositories that were not on screen when the order was last changed: at most this many are kept. */
export const MAX_HIDDEN_REPOS = 500;

const lower = (r: string) => r.toLowerCase();

/**
 * Whatever was saved: the strings (lower-cased, trimmed, first occurrence wins). Never cut to a
 * length — a cut would drop repositories that were on screen when the order was last changed.
 */
export function normalizeRepoOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const k = lower(v.trim());
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * Compare two repository names (`owner/name`, any case): the saved ones in the saved order, then
 * the rest alphabetically (case-insensitive) — with nothing saved, plain alphabetical, as before.
 */
export function repoComparator(order: readonly string[]): (a: string, b: string) => number {
  const rank = new Map(order.map((r, i) => [lower(r), i]));
  return (a, b) => {
    const la = lower(a), lb = lower(b);
    const ra = rank.get(la), rb = rank.get(lb);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return la.localeCompare(lb);
  };
}

/** `names` in the saved order (a new array). */
export function sortRepos<T extends string>(names: readonly T[], order: readonly string[]): T[] {
  return [...names].sort(repoComparator(order));
}

/**
 * The list shown, with `dragged` put right before (or after) `target`; null when either is not in
 * the list, or they are the same. Both drag places (the table's slices, the board's swimlane heads)
 * go through this.
 */
export function moveRepo(shown: readonly string[], dragged: string, target: string, after: boolean): string[] | null {
  const d = lower(dragged), t = lower(target);
  if (d === t) return null;
  const rest = shown.filter((r) => lower(r) !== d);
  const moving = shown.find((r) => lower(r) === d);
  const at = rest.findIndex((r) => lower(r) === t);
  if (moving === undefined || at < 0) return null;
  rest.splice(after ? at + 1 : at, 0, moving);
  return rest;
}

/**
 * The saved order after a drag. `shown` is the list on screen before the drag (the repositories the
 * user can see: the search / filter may hide others), `next` the same repositories in the new order.
 *
 * 1. The whole order: the saved one, then the shown repositories not saved yet, alphabetically
 *    (exactly where the list showed them).
 * 2. Walk it: each place held by a shown repository takes the next one of `next`; a place held by a
 *    repository not shown keeps it. Repositories off screen do not move.
 * 3. Every shown repository is kept; of the others, the first MAX_HIDDEN_REPOS (in the new order).
 *
 * null = nothing to write: `next` is not exactly the repositories of `shown` (one more, one less,
 * one twice), or the order does not change.
 */
export function reorderRepos(saved: readonly string[], shown: readonly unknown[], next: readonly unknown[]): string[] | null {
  if (!shown.every((r) => typeof r === 'string') || !next.every((r) => typeof r === 'string')) return null;
  const vis = (shown as string[]).map(lower);
  const nxt = (next as string[]).map(lower);
  const visSet = new Set(vis);
  if (vis.length === 0 || visSet.size !== vis.length || nxt.length !== vis.length || new Set(nxt).size !== nxt.length || !nxt.every((r) => visSet.has(r)))
    return null;
  const base = normalizeRepoOrder(saved);
  const known = new Set(base);
  const full = [...base, ...vis.filter((r) => !known.has(r)).sort((a, b) => a.localeCompare(b))];
  let i = 0;
  const placed = full.map((r) => (visSet.has(r) ? nxt[i++] : r));
  let hidden = 0;
  const out = placed.filter((r) => visSet.has(r) || ++hidden <= MAX_HIDDEN_REPOS);
  return out.length === base.length && out.every((r, n) => r === base[n]) ? null : out;
}
