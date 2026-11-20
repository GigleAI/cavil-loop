// GitHub#591: where a setting's ⓘ explanation opens — below the ⓘ, moved up or left when the window has no room,
// never off the window's edge.

import { describe, expect, it } from 'vitest';
import { tipPlace } from '../../src/renderer/InfoTip';

const view = { width: 1000, height: 800 };
const at = (left: number, top: number) => ({ left, top, right: left + 16, bottom: top + 16 });

describe('tipPlace', () => {
  it('opens below the ⓘ, a little to its left', () => {
    expect(tipPlace(at(200, 100), { width: 300, height: 60 }, view)).toEqual({ left: 190, top: 122, above: false });
  });
  it('near the bottom: opens above when there is room there', () => {
    expect(tipPlace(at(200, 760), { width: 300, height: 60 }, view)).toEqual({ left: 190, top: 694, above: true });
  });
  it('no room above either: stays below rather than going off the top', () => {
    expect(tipPlace(at(200, 40), { width: 300, height: 790 }, view).above).toBe(false);
  });
  it('near the right edge: moved left so all of it is inside the window', () => {
    const p = tipPlace(at(900, 100), { width: 300, height: 60 }, view);
    expect(p.left + 300).toBeLessThanOrEqual(view.width - 8);
  });
  it('never past the left edge', () => {
    expect(tipPlace(at(2, 100), { width: 300, height: 60 }, view).left).toBe(8);
  });
});
