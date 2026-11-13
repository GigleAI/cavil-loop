// GitHub#496: the label / milestone picker's order — what the item carried when it opened, then the
// pinned flow labels, then the rest, each group in the order given.
import { describe, expect, it } from 'vitest';
import { pickOrder, pinnedLabels } from '../../src/shared/pickOrder';
import { DEFAULT_HAND_BACK } from '../../src/shared/types';

// the repository order the label list comes back in (the real one of GigleAI/cavil-loop, cut short)
const REPO = ['doing/agent', 'Done', 'autopilot', 'pending/PR', 'pending/human', 'priority/p2', 'pending/agent', 'pending/review', 'enhancement'];
const items = (names = REPO) => names.map((name) => ({ name }));
const order = (checked: string[], pinned: readonly string[] = pinnedLabels(DEFAULT_HAND_BACK), names = REPO) =>
  pickOrder(items(names), new Set(checked), pinned).map((i) => i.name);

describe('pickOrder', () => {
  it('nothing checked: the three pinned labels first, in their own order, then the rest as given', () => {
    expect(order([])).toEqual(['autopilot', 'pending/human', 'pending/agent', 'doing/agent', 'Done', 'pending/PR', 'priority/p2', 'pending/review', 'enhancement']);
  });

  it('checked ones first (in the given order), then the pinned ones not checked, then the rest', () => {
    expect(order(['enhancement', 'pending/review'])).toEqual(['pending/review', 'enhancement', 'autopilot', 'pending/human', 'pending/agent', 'doing/agent', 'Done', 'pending/PR', 'priority/p2']);
  });

  it('a checked pinned label is listed once, among the checked, ahead of the other checked ones', () => {
    const got = order(['enhancement', 'pending/human', 'Done']);
    expect(got).toEqual(['pending/human', 'Done', 'enhancement', 'autopilot', 'pending/agent', 'doing/agent', 'pending/PR', 'priority/p2', 'pending/review']);
    expect(got).toHaveLength(REPO.length);
  });

  it('names are compared without case, both for pinned and for checked', () => {
    expect(order(['DONE'], ['Pending/Human', 'AUTOPILOT']).slice(0, 3)).toEqual(['Done', 'pending/human', 'autopilot']);
  });

  it('a pinned name the repository does not have adds nothing; empty pinned names are skipped', () => {
    const names = REPO.filter((n) => n !== 'pending/agent');
    const got = order([], ['autopilot', '', '  ', 'pending/human', 'pending/agent', 'not-there'], names);
    expect(got).toEqual(['autopilot', 'pending/human', 'doing/agent', 'Done', 'pending/PR', 'priority/p2', 'pending/review', 'enhancement']);
  });

  it('pinned names follow the labels named in Settings (renamed ones included)', () => {
    const hb = { ...DEFAULT_HAND_BACK, human: 'pending/review', autopilot: '' };
    expect(pinnedLabels(hb)).toEqual(['', 'pending/review', 'pending/agent']);
    expect(order([], pinnedLabels(hb)).slice(0, 3)).toEqual(['pending/review', 'pending/agent', 'doing/agent']);
  });

  it('no pinned list: only "checked first" (the milestone picker)', () => {
    expect(pickOrder(items(['v1', 'v2', 'v3']), new Set(['v3'])).map((i) => i.name)).toEqual(['v3', 'v1', 'v2']);
  });

  it('keeps the objects it was given and does not change the input', () => {
    const input = REPO.map((name) => ({ name, checked: name === 'Done' }));
    const copy = input.map((x) => ({ ...x }));
    const got = pickOrder(input, new Set(['Done']), ['autopilot']);
    expect(got[0]).toBe(input[1]);
    expect(input).toEqual(copy);
  });
});
