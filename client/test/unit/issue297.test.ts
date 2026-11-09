// GitHub#297: folded board swimlanes (one per repository), kept on this machine.

import { describe, expect, it } from 'vitest';
import { MAX_LANE_FOLDS, normalizeLaneFolds, setLaneFold } from '../../src/shared/uiPrefs';

describe('folded board swimlanes (GitHub#297)', () => {
  it('fold adds, unfold removes, folding again moves to the newest; unknown input changes nothing', () => {
    let f = setLaneFold([], 'GigleAI/cavil-loop', true);
    f = setLaneFold(f, 'GigleAI/zeta', true);
    expect(f).toEqual(['GigleAI/cavil-loop', 'GigleAI/zeta']);
    f = setLaneFold(f, 'GigleAI/cavil-loop', true);
    expect(f).toEqual(['GigleAI/zeta', 'GigleAI/cavil-loop']);
    f = setLaneFold(f, 'GigleAI/zeta', false);
    expect(f).toEqual(['GigleAI/cavil-loop']);
    for (const [lane, folded] of [['', true], [3, true], [null, false], ['GigleAI/x', 'yes']] as const) expect(setLaneFold(f, lane, folded)).toBe(f);
    expect(setLaneFold(f, 'GigleAI/never-folded', false)).toBe(f);
  });

  it(`at most ${MAX_LANE_FOLDS}: the oldest goes first; a saved list that is too long keeps the newest`, () => {
    let f: string[] = [];
    for (let i = 0; i <= MAX_LANE_FOLDS; i++) f = setLaneFold(f, `o/r${i}`, true);
    expect(f).toHaveLength(MAX_LANE_FOLDS);
    expect(f[0]).toBe('o/r1');
    expect(f.at(-1)).toBe(`o/r${MAX_LANE_FOLDS}`);
    const long = Array.from({ length: MAX_LANE_FOLDS + 5 }, (_, i) => `o/r${i}`);
    expect(normalizeLaneFolds(long)).toEqual(long.slice(5));
  });

  it('a broken saved value keeps only the valid parts', () => {
    expect(normalizeLaneFolds(null)).toEqual([]);
    expect(normalizeLaneFolds({ a: ['x'] })).toEqual([]);
    expect(normalizeLaneFolds('o/r')).toEqual([]);
    expect(normalizeLaneFolds(['o/r', 2, 'o/r', '', 'o/s'])).toEqual(['o/r', 'o/s']);
  });
});
