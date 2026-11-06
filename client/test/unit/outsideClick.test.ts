// GitHub#191: when a click outside the detail panel puts it away. Expected values follow the
// agreed rule table on the issue (not the implementation's output).
import { describe, expect, it } from 'vitest';
import { hidesPanel, MOVE_SLOP, type Press, type Release } from '../../src/renderer/outsideClick';

const press = (o: Partial<Press> = {}): Press => ({ button: 0, x: 100, y: 100, inPanel: false, opensItem: false, onScrollbar: false, dialogOpen: false, ...o });
const release = (o: Partial<Release> = {}): Release => ({ x: 100, y: 100, inPanel: false, opensItem: false, keyboard: false, ...o });

describe('detail panel: does this click put it away?', () => {
  const rows: [string, Press | null, Release, string, boolean][] = [
    ['blank board / toolbar, left button, no draft', press(), release(), '', true],
    ['moved a little (within the slop) is still a click', press(), release({ x: 100 + MOVE_SLOP, y: 100 - MOVE_SLOP }), '', true],
    ['inside the panel', press({ inPanel: true }), release({ inPanel: true }), '', false],
    ['pressed inside (resize edge, selection), released outside', press({ inPanel: true }), release(), '', false],
    ['pressed outside, released inside', press(), release({ inPanel: true }), '', false],
    ['on a card / a row title: it switches items instead', press({ opensItem: true }), release({ opensItem: true }), '', false],
    ['a dialog was open when the button went down (its backdrop)', press({ dialogOpen: true }), release(), '', false],
    ['a reply is typed', press(), release(), '看过了', false],
    ['a reply of spaces only is still typed text', press(), release(), ' ', false],
    ['on a scrollbar', press({ onScrollbar: true }), release(), '', false],
    ['a drag that moved (scrollbar thumb, text selection)', press(), release({ x: 100 + MOVE_SLOP + 1 }), '', false],
    ['right / middle button', press({ button: 2 }), release(), '', false],
    ['a click from the keyboard (Enter on a toolbar button)', press(), release({ keyboard: true }), '', false],
    ['no press seen by this window (it went into the discussion frame)', null, release(), '', false],
  ];
  for (const [name, p, r, draft, want] of rows) it(name, () => expect(hidesPanel(p, r, draft)).toBe(want));
});
