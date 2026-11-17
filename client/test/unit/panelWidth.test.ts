// GigleAI/cavil-loop#582: the floating detail panel's default width follows the window, leaving the list behind it about
// 15 characters of title; a dragged width is kept (a dragged 560 included). Pure parts: reading what was saved
// (normalizeView, the one reader every load goes through) and the width rules (panelWidthFor, the one the panel draws with).

import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, isValidView, normalizeView } from '../../src/shared/viewSettings';
import { clampWidth, FALLBACK_STRIP, panelWidthFor, stripFor } from '../../src/renderer/panelWidth';

/** settings as an older build saved them (no `panelWidth`) */
const base = { mode: 'status', swimlanes: false, selected: null };

describe('GitHub#582: reading the saved width', () => {
  const cases: [string, Record<string, unknown>, number | null][] = [
    ['older build, its default 560', { ...base, detailWidth: 560 }, null],
    ['older build, dragged to 720', { ...base, detailWidth: 720 }, 720],
    ['older build, too narrow', { ...base, detailWidth: 100 }, null],
    ['older build, too wide', { ...base, detailWidth: 10_000 }, null],
    ['older build, not a number', { ...base, detailWidth: '600' }, null],
    ['older build, nothing saved', { ...base }, null],
    ['nothing at all', {}, null],
    ['this build, dragged to 560', { ...base, detailWidth: 560, panelWidth: 560 }, 560],
    ['this build: only its own setting counts', { ...base, detailWidth: 720, panelWidth: 560 }, 560],
    ['this build, following the window, older setting 720', { ...base, detailWidth: 720, panelWidth: null }, null],
    ['this build, unreadable', { ...base, detailWidth: 720, panelWidth: 'wide' }, null],
    ['this build, out of range', { ...base, detailWidth: 720, panelWidth: 359 }, null],
  ];
  for (const [name, saved, want] of cases) {
    it(name, () => {
      const v = normalizeView(saved);
      expect(v.panelWidth).toBe(want);
      expect(isValidView(v)).toBe(true);
    });
  }

  it('the older setting is kept as it was (an older build reading the view again still finds it)', () => {
    expect(normalizeView({ ...base, detailWidth: 720, panelWidth: null }).detailWidth).toBe(720);
    expect(DEFAULT_VIEW.panelWidth).toBeNull();
  });

  it('a dragged 560 survives a save and a load (a restart), any number of times', () => {
    let v = normalizeView({ ...base, detailWidth: 560 });
    expect(v.panelWidth).toBeNull();
    v = { ...v, panelWidth: 560 };
    for (let i = 0; i < 3; i++) v = normalizeView(JSON.parse(JSON.stringify(v)));
    expect(v.panelWidth).toBe(560);
    // back to following the window (double-click on the edge), and that is kept too
    v = normalizeView(JSON.parse(JSON.stringify({ ...v, panelWidth: null })));
    expect(v.panelWidth).toBeNull();
  });

  it('only null or a width in range is a valid setting', () => {
    for (const w of [null, 360, 560, 4000]) expect(isValidView({ ...DEFAULT_VIEW, panelWidth: w })).toBe(true);
    for (const w of [359, 4001, Number.NaN, '560', undefined]) expect(isValidView({ ...DEFAULT_VIEW, panelWidth: w as any })).toBe(false);
  });
});

describe('GitHub#582: the width rules', () => {
  it('the strip is measured from where the titles start: 15 characters of their font and a little slack', () => {
    expect(stripFor(299, 13)).toBe(299 + 15 * 13 + 16);
    expect(stripFor(38, 13.5)).toBe(Math.round(38 + 15 * 13.5 + 16));
    // nothing to measure (graph, empty list, a bad reading): the fixed fallback
    for (const [l, f] of [[null, 13], [100, null], [Number.NaN, 13], [100, 0]] as const) expect(stripFor(l, f)).toBe(FALLBACK_STRIP);
  });

  // window width → [board (strip 240), table (strip 510)], as the design's table says
  const rows: [number, [number, number], [number, number]][] = [
    [1280, [1040, 240], [770, 510]],
    [870, [630, 240], [360, 510]],
    [720, [480, 240], [360, 360]],
    [520, [360, 160], [360, 160]],
    [400, [360, 40], [360, 40]],
  ];
  for (const [win, board, table] of rows) {
    it(`following a ${win} px window`, () => {
      for (const [strip, [w, left]] of [[240, board], [510, table]] as const) {
        const got = panelWidthFor(null, win, strip);
        expect(got).toBe(w);
        expect(win - got).toBe(left);
      }
    });
  }

  it('the window grows: the list keeps its strip, the panel takes the rest', () => {
    for (const win of [1000, 1280, 1920, 2560]) expect(win - panelWidthFor(null, win, 300)).toBe(300);
  });

  it('a dragged width ignores the strip and the window, within the same limits', () => {
    for (const win of [1280, 1920]) for (const strip of [240, 510]) expect(panelWidthFor(560, win, strip)).toBe(560);
    expect(panelWidthFor(2000, 1280, 240)).toBe(1160); // 120 px always left on the left
    expect(panelWidthFor(100, 1280, 240)).toBe(360); // never narrower than 360
    expect(panelWidthFor(560, 400, 240)).toBe(360); // below 480 the 360 wins over the 120
    expect(clampWidth(5000, 6000)).toBe(4000);
  });
});
