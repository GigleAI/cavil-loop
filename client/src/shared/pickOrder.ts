// GitHub#496: the order a label / milestone picker lists its choices in. Three groups, each keeping the
// order it was given in (the repository's own order):
//   1. what the item carried when the picker opened (the pinned labels first among them)
//   2. the pinned labels it did not carry, in the order given (autopilot → pending/human → pending/later → pending/agent)
//   3. everything else
// "Carried when the picker opened" is a snapshot the picker takes once: a click while it is open only moves
// the tick, never the row under the pointer. Label names are compared without case, as GitHub does.
// A pinned name the list does not have adds nothing; an empty pinned name is skipped.
import type { HandBackLabels } from './types';

export function pickOrder<T extends { name: string }>(items: readonly T[], checkedAtOpen: ReadonlySet<string>, pinned: readonly string[] = []): T[] {
  const pins = pinned.map((p) => p.trim().toLowerCase()).filter(Boolean);
  const pinAt = (n: string) => {
    const i = pins.indexOf(n.toLowerCase());
    return i < 0 ? pins.length : i;
  };
  const opened = new Set([...checkedAtOpen].map((n) => n.toLowerCase()));
  const group = (n: string) => (opened.has(n.toLowerCase()) ? 0 : pinAt(n) < pins.length ? 1 : 2);
  return items
    .map((item, at) => ({ item, at, g: group(item.name), p: pinAt(item.name) }))
    .sort((a, b) => a.g - b.g || (a.g === 2 ? 0 : a.p - b.p) || a.at - b.at)
    .map((x) => x.item);
}

/**
 * The labels a label picker keeps near the top: the flow labels Settings names for "autopilot", "waits for a
 * human", "parked" (GitHub#513) and "hand to the agent". Every picker (detail, table cell, new issue) builds
 * its list here from the whole setting, so a label added to this list reaches all of them.
 */
export function pinnedLabels(hb: Pick<HandBackLabels, 'autopilot' | 'human' | 'later' | 'agent'>): string[] {
  return [hb.autopilot, hb.human, hb.later, hb.agent];
}
