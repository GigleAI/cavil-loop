// GigleAI/cavil-loop#464: the "显示已关闭" switches in the view settings, and the one-time migration of a
// search saved by a build from before them. Pure (normalizeView / isValidView); the real back end's
// restart path is in controller.test.ts.

import { describe, expect, it } from 'vitest';
import { DEFAULT_SHOW_CLOSED, DEFAULT_VIEW, isValidView, migrateQuery, normalizeView, SHOW_CLOSED_MAX } from '../../src/shared/viewSettings';

/** settings as a build from before GitHub#464 saved them: no `showClosed` */
const old = (query: unknown) => ({ mode: 'iteration', swimlanes: false, selected: null, query });

describe('GitHub#464: a search saved by an older build', () => {
  const cases: [string, string][] = [
    // only words that hid finished items: emptied (the switch does that now)
    ['-Status:done -label:Done', ''],
    ['-label:Done -status:Done', ''],
    ['-status:DONE', ''],
    ['is:open', ''],
    ['  is:open  ', ''],
    // a flow number's old click query: the new one, so the number stays lit
    ['is:open label:"pending/human"', 'label:"pending/human"'],
    ['is:open label:"wait for, me"', 'label:"wait for, me"'],
    ['is:open no:label', 'no:label'],
    // anything else: kept as it was
    ['-label:Done label:bug', '-label:Done label:bug'],
    ['is:open label:bug', 'is:open label:bug'],
    ['label:"pending/human" is:open', 'label:"pending/human" is:open'],
    ['bug', 'bug'],
    ['', ''],
  ];

  it('each wording, through the reader of saved settings', () => {
    for (const [saved, now] of cases) {
      expect(migrateQuery(saved), saved).toBe(now);
      const v = normalizeView(old(saved));
      expect(v.query, saved).toBe(now);
      expect(v.showClosed, saved).toEqual(DEFAULT_SHOW_CLOSED);
      expect(isValidView(v), saved).toBe(true);
    }
  });

  it('settings this build saved (they carry the switches) are never migrated', () => {
    for (const [saved] of cases) expect(normalizeView({ ...old(saved), showClosed: {} }).query, saved).toBe(saved);
  });

  it('never saved at all: the default, an empty box', () => {
    expect(normalizeView({}).query).toBe('');
    expect(normalizeView(undefined).query).toBe('');
    expect(DEFAULT_VIEW.query).toBe('');
    // a broken saved text falls back to the default
    expect(normalizeView(old(7)).query).toBe('');
  });
});

describe('GitHub#464: the switches as saved', () => {
  it('each saved switch kept, a bad value only turns that one off, numbers made in Settings keep theirs', () => {
    const v = normalizeView({ ...old(''), showClosed: { board: true, table: 1, human: 'x', 't-a': true, 't-b': 'no', '': true } });
    expect(v.showClosed).toEqual({ ...DEFAULT_SHOW_CLOSED, board: true, 't-a': true });
    expect(normalizeView({ ...old(''), showClosed: [true] }).showClosed).toEqual(DEFAULT_SHOW_CLOSED);
    expect(normalizeView({ ...old(''), showClosed: null }).showClosed).toEqual(DEFAULT_SHOW_CLOSED);
  });

  it('at most SHOW_CLOSED_MAX switches are kept; the default ones always', () => {
    const many = Object.fromEntries(Array.from({ length: SHOW_CLOSED_MAX + 20 }, (_, i) => [`t-${i}`, true]));
    const v = normalizeView({ ...old(''), showClosed: many });
    expect(Object.keys(v.showClosed)).toHaveLength(SHOW_CLOSED_MAX);
    for (const k of Object.keys(DEFAULT_SHOW_CLOSED)) expect(v.showClosed[k], k).toBe(false);
  });

  it('a view whose switches are missing a default one, hold a non-boolean or are too many is not valid as a whole', () => {
    expect(isValidView(DEFAULT_VIEW)).toBe(true);
    expect(isValidView({ ...DEFAULT_VIEW, showClosed: { ...DEFAULT_SHOW_CLOSED, 't-a': true } })).toBe(true);
    const { board: _b, ...noBoard } = DEFAULT_SHOW_CLOSED;
    expect(isValidView({ ...DEFAULT_VIEW, showClosed: noBoard })).toBe(false);
    expect(isValidView({ ...DEFAULT_VIEW, showClosed: { ...DEFAULT_SHOW_CLOSED, table: 'yes' } })).toBe(false);
    const many = Object.fromEntries(Array.from({ length: SHOW_CLOSED_MAX }, (_, i) => [`t-${i}`, true]));
    expect(isValidView({ ...DEFAULT_VIEW, showClosed: { ...DEFAULT_SHOW_CLOSED, ...many } })).toBe(false);
  });
});
