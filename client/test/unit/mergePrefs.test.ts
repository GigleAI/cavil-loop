// GitHub#175: the merge method is remembered per repository. The pure rules
// here; persistence across a restart is in controller.test.ts, the real window
// in test/e2e/app.spec.ts.

import { describe, expect, it } from 'vitest';
import { EMPTY_MERGE_PREFS, normalizeMergePrefs, pickMergeMethod, rememberMergeMethod } from '../../src/shared/mergePrefs';
import type { MergeMethod } from '../../src/shared/actions';

const ALL: MergeMethod[] = ['merge', 'squash', 'rebase'];

describe('merge method: which one the box starts with', () => {
  it('nothing remembered: the first method the repository allows', () => {
    expect(pickMergeMethod(EMPTY_MERGE_PREFS, 'A/one', ALL)).toBe('merge');
    expect(pickMergeMethod(EMPTY_MERGE_PREFS, 'A/one', ['rebase', 'squash'])).toBe('rebase');
    expect(pickMergeMethod(EMPTY_MERGE_PREFS, 'A/one', [])).toBe('');
  });

  it('this repository first, then the last one chosen anywhere, then the first allowed', () => {
    let p = rememberMergeMethod(EMPTY_MERGE_PREFS, 'A/one', 'squash');
    p = rememberMergeMethod(p, 'B/two', 'rebase');
    expect(pickMergeMethod(p, 'A/one', ALL)).toBe('squash'); // its own, not the newer one from B
    expect(pickMergeMethod(p, 'a/ONE', ALL)).toBe('squash'); // GitHub names are case-insensitive
    expect(pickMergeMethod(p, 'C/three', ALL)).toBe('rebase'); // never chosen there: last anywhere
    expect(pickMergeMethod(p, 'A/one', ['merge', 'rebase'])).toBe('rebase'); // own one switched off: last anywhere
    expect(pickMergeMethod(p, 'A/one', ['merge'])).toBe('merge'); // neither allowed: first allowed
    expect(pickMergeMethod(p, 'A/one', [])).toBe('');
  });

  it('remembering one repository leaves the others as they were', () => {
    const a = rememberMergeMethod(EMPTY_MERGE_PREFS, 'A/one', 'squash');
    const b = rememberMergeMethod(a, 'B/two', 'rebase');
    expect(b).toEqual({ byRepo: { 'a/one': 'squash', 'b/two': 'rebase' }, last: 'rebase' });
    expect(a).toEqual({ byRepo: { 'a/one': 'squash' }, last: 'squash' }); // not mutated
  });

  it('an unknown method or no repository changes nothing', () => {
    const a = rememberMergeMethod(EMPTY_MERGE_PREFS, 'A/one', 'squash');
    expect(rememberMergeMethod(a, 'A/one', 'fast-forward')).toBe(a);
    expect(rememberMergeMethod(a, 'A/one', '')).toBe(a);
    expect(rememberMergeMethod(a, '', 'rebase')).toBe(a);
  });

  it('a saved setting that is missing or broken reads as nothing remembered; valid parts are kept', () => {
    for (const raw of [undefined, null, 'squash', 42, [], { byRepo: [], last: 'nope' }, { byRepo: 'x' }])
      expect(normalizeMergePrefs(raw)).toEqual(EMPTY_MERGE_PREFS);
    expect(normalizeMergePrefs({ byRepo: { 'A/One': 'squash', 'b/two': 'zip', 'c/three': 3, '': 'merge' }, last: 'rebase' })).toEqual({
      byRepo: { 'a/one': 'squash' },
      last: 'rebase',
    });
  });
});
