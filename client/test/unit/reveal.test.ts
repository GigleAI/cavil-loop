// GitHub#522: how far the board scrolls sideways so the item the floating detail opened is clear of the panel.
import { describe, expect, it } from 'vitest';
import { PANEL_GAP, sidewaysShift } from '../../src/renderer/reveal';

describe('sidewaysShift (GitHub#522)', () => {
  // the panel's left edge at 720, the scrolling box starting at 16
  const cover = 720;
  const boxLeft = 16;
  it('already clear of the panel (with the gap): nothing moves', () => {
    expect(sidewaysShift(100, cover - PANEL_GAP, cover, boxLeft)).toBe(0);
    expect(sidewaysShift(20, 300, cover, boxLeft)).toBe(0);
  });
  it('under the panel: just far enough to end the gap left of its edge', () => {
    expect(sidewaysShift(640, 914, cover, boxLeft)).toBe(914 - (cover - PANEL_GAP));
    expect(sidewaysShift(900, 1174, cover, boxLeft)).toBe(1174 - (cover - PANEL_GAP));
  });
  it('wider than the room left of the panel: its own left edge stops the gap right of the box edge', () => {
    expect(sidewaysShift(400, 1200, cover, boxLeft)).toBe(400 - boxLeft - PANEL_GAP);
    expect(sidewaysShift(boxLeft + PANEL_GAP, 1200, cover, boxLeft)).toBe(0);
  });
  it('never scrolls backwards', () => {
    expect(sidewaysShift(0, 1000, cover, boxLeft)).toBe(0);
  });
});
