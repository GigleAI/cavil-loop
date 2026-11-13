// GitHub#488: the order of the window's notice area (NoticeArea.tsx), kept apart so it can be tested alone.

/**
 * Newest first, by when this window first saw each notice. Notices already there when the window
 * starts are ordered by when they began (an operation's start; a new issue's sequence number).
 */
export function noticeOrder(ids: { id: string; order: number }[], seen: Map<string, number>, next: { n: number }): string[] {
  for (const e of [...ids].sort((a, b) => a.order - b.order)) if (!seen.has(e.id)) seen.set(e.id, ++next.n);
  for (const k of [...seen.keys()]) if (!ids.some((e) => e.id === k)) seen.delete(k);
  return ids.map((e) => e.id).sort((a, b) => seen.get(b)! - seen.get(a)!);
}
