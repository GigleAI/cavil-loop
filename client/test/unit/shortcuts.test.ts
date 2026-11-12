// GitHub#192: who gets a key press. `resolve` is the only decision; the window's one listener and
// the shortcut list both read SHORTCUTS. These cases pin the rules; the window tests
// (test/e2e/app.spec.ts, "GitHub#192: …") press the real keys and check what GitHub received.
import { describe, expect, it } from 'vitest';
import { FRAME_FORWARD, FRAME_IDS, SHORTCUTS, keyParts, keyText, matches, resolve, resolveKey, type KeyContext, type KeyLike, type KeySpec, type Scope } from '../../src/renderer/shortcuts';

const key = (k: string, o: Partial<KeyLike> = {}): KeyLike => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
const idle: KeyContext = { signedIn: true, layer: 'none', typing: 'none', mac: true };
/** a digit's key as a US layout reports it with Shift / ⌥ held (GitHub#442: matched by `code`, not by this) */
const SHIFTED_DIGIT: Record<string, string> = { '1': '!', '2': '@', '3': '#' };
const ALT_DIGIT: Record<string, string> = { '1': '¡', '2': '™', '3': '£' };
/** the event a spec describes, with ⌘ (mac) or Ctrl — as the browser reports it, `code` included */
const eventOf = (spec: KeySpec, mod: 'meta' | 'ctrl' = 'meta'): KeyLike => {
  const digit = /^[0-9]$/.test(spec.key);
  const k =
    spec.key === '?' ? '?' : digit ? (spec.shift ? (SHIFTED_DIGIT[spec.key] ?? spec.key) : spec.alt ? (ALT_DIGIT[spec.key] ?? spec.key) : spec.key) : spec.shift && spec.key.length === 1 ? spec.key.toUpperCase() : spec.key;
  return key(k, {
    metaKey: Boolean(spec.mod) && mod === 'meta',
    ctrlKey: Boolean(spec.mod) && mod === 'ctrl',
    shiftKey: Boolean(spec.shift),
    altKey: Boolean(spec.alt),
    ...(digit ? { code: `Digit${spec.key}` } : {}),
  });
};
/** a context in which a scope's shortcuts are the ones meant to act */
const ctxFor = (scope: Scope): KeyContext =>
  scope === 'global' || scope === 'detail' || scope === 'graph'
    ? idle
    : scope === 'settings'
      ? { ...idle, page: 'settings' }
      : scope === 'reply'
        ? { ...idle, typing: 'reply' }
        : { ...idle, layer: scope };

describe('the shortcut table', () => {
  it('every key of every shortcut reaches that shortcut in its own place, with ⌘ and with Ctrl', () => {
    for (const s of SHORTCUTS)
      for (const k of s.keys) {
        expect(resolve(eventOf(k, 'meta'), ctxFor(s.scope)), `${s.id} ${k.key}`).toBe(s.id);
        expect(resolve(eventOf(k, 'ctrl'), ctxFor(s.scope)), `${s.id} ${k.key} (Ctrl)`).toBe(s.id);
      }
  });
  it('ids are unique and every shortcut says what it does', () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
    for (const s of SHORTCUTS) expect(s.label.length, s.id).toBeGreaterThan(1);
  });
});

describe('resolve: who gets the key', () => {
  it('nothing before sign-in', () => {
    for (const s of SHORTCUTS) for (const k of s.keys) expect(resolve(eventOf(k), { ...ctxFor(s.scope), signedIn: false })).toBeNull();
  });
  it('never while an input method is composing (isComposing, or the legacy keyCode 229)', () => {
    expect(resolve(key('Enter', { metaKey: true, isComposing: true }), { ...idle, typing: 'reply' })).toBeNull();
    expect(resolve(key('Escape', { keyCode: 229 }), { ...idle, typing: 'reply' })).toBeNull();
    expect(resolve(key('Escape', { isComposing: true }), { ...idle, layer: 'dialog' })).toBeNull();
    expect(resolve(key('Enter', { metaKey: true }), { ...idle, typing: 'reply' })).toBe('send');
  });
  it('typing in a field: single keys are text; only ⌘ / Ctrl shortcuts act', () => {
    const typing: KeyContext = { ...idle, typing: 'other' };
    for (const k of ['/', 'c', 'l', 'm', 'r', '?', 'Escape']) expect(resolve(key(k, { shiftKey: k === '?' }), typing), k).toBeNull();
    expect(resolve(key('r', { metaKey: true }), typing)).toBe('sync');
    expect(resolve(key(',', { ctrlKey: true }), typing)).toBe('settings');
  });
  it('typing in the reply box: its own keys and the ⌘ / Ctrl globals; letters are text', () => {
    const r: KeyContext = { ...idle, typing: 'reply' };
    for (const k of ['/', 'c', 'l', 'm', 'r', '?']) expect(resolve(key(k, { shiftKey: k === '?' }), r), k).toBeNull();
    expect(resolve(key('Escape'), r)).toBe('leaveReply');
    expect(resolve(key('Enter', { ctrlKey: true }), r)).toBe('send');
    expect(resolve(key('P', { metaKey: true, shiftKey: true }), r)).toBe('preview');
    expect(resolve(key('r', { metaKey: true }), r)).toBe('sync');
    expect(resolve(key('Enter'), r)).toBeNull();
  });
  it('a layer on top takes every key: only its own shortcuts act', () => {
    for (const layer of ['dialog', 'picker', 'help'] as const) {
      const ctx: KeyContext = { ...idle, layer };
      for (const k of ['/', 'c', 'l', 'm', 'r', '?']) {
        const got = resolve(key(k, { shiftKey: k === '?' }), ctx);
        expect(got === null || SHORTCUTS.find((s) => s.id === got)!.scope === layer, `${layer} ${k}`).toBe(true);
      }
      expect(resolve(key('r', { metaKey: true }), ctx), `${layer} ⌘R`).toBeNull();
    }
    expect(resolve(key('Escape'), { ...idle, layer: 'dialog' })).toBe('cancel');
    expect(resolve(key('Escape'), { ...idle, layer: 'picker', typing: 'other' })).toBe('pickerClose');
    expect(resolve(key('?', { shiftKey: true }), { ...idle, layer: 'help' })).toBe('helpClose');
    // a plain Enter in a dialog is nobody's: only ⌘↩ confirms
    expect(resolve(key('Enter'), { ...idle, layer: 'dialog' })).toBeNull();
    expect(resolve(key('Enter', { metaKey: true }), { ...idle, layer: 'dialog', typing: 'reply' })).toBe('confirm');
  });
  it('GitHub#369: on the settings page Esc is its own (also in a field, where it first leaves the field); the board keeps its Esc; a layer still comes first', () => {
    const settings: KeyContext = { ...idle, page: 'settings' };
    expect(resolve(key('Escape'), settings)).toBe('settingsBack');
    expect(resolve(key('Escape'), { ...settings, typing: 'other' })).toBe('settingsBack');
    // the board's own keys are not the settings page's
    for (const k of ['l', 'm', 'r', 'f', '=']) expect(resolve(key(k), settings), k).toBeNull();
    // the globals still act there
    expect(resolve(key('/'), settings)).toBe('search');
    expect(resolve(key(',', { metaKey: true }), settings)).toBe('settings');
    expect(resolve(key('?', { shiftKey: true }), settings)).toBe('help');
    // typing in a settings field: letters are text
    for (const k of ['/', 'c', '?']) expect(resolve(key(k, { shiftKey: k === '?' }), { ...settings, typing: 'other' }), k).toBeNull();
    // a layer on top (the shortcut list, a dialog) takes Esc first
    expect(resolve(key('Escape'), { ...settings, layer: 'help' })).toBe('helpClose');
    expect(resolve(key('Escape'), { ...settings, layer: 'dialog' })).toBe('cancel');
    // never while composing
    expect(resolve(key('Escape', { isComposing: true }), settings)).toBeNull();
    // the board (no page, or 'board'): Esc is still the detail panel's, and typing in a field still keeps it
    expect(resolve(key('Escape'), { ...idle, page: 'board' })).toBe('hide');
    expect(resolve(key('Escape'), { ...idle, page: 'board', typing: 'other' })).toBeNull();
  });
  it('nothing typed, no layer: global and detail keys; extra modifiers never match', () => {
    expect(resolve(key('/'), idle)).toBe('search');
    expect(resolve(key('C'), idle)).toBe('newIssue'); // Caps Lock
    expect(resolve(key('l'), idle)).toBe('labels');
    expect(resolve(key('Escape'), idle)).toBe('hide');
    expect(resolve(key('l', { altKey: true }), idle)).toBeNull();
    expect(resolve(key('l', { shiftKey: true }), idle)).toBeNull();
    expect(resolve(key('c', { metaKey: true }), idle)).toBeNull(); // ⌘C stays copy
    expect(resolve(key('Enter', { metaKey: true }), idle)).toBeNull();
  });
  it('GitHub#372: 新建 has C and ⌘N — while typing only the key actually pressed counts, so a typed C stays a letter', () => {
    const places: [string, KeyContext][] = [
      ['a field (search box)', { ...idle, typing: 'other' }],
      ['the reply box', { ...idle, typing: 'reply' }],
      ['a settings field', { ...idle, page: 'settings', typing: 'other' }],
    ];
    for (const [where, ctx] of places) {
      for (const ch of ['c', 'C', 'a', 'h', 'e']) expect(resolve(key(ch), ctx), `${where}: ${ch}`).toBeNull();
      expect(resolve(key('n', { metaKey: true }), ctx), `${where}: ⌘N`).toBe('newIssue');
      expect(resolve(key('n', { ctrlKey: true }), ctx), `${where}: Ctrl+N`).toBe('newIssue');
      // GitHub#442: the layouts are ⌘⇧1/2/3 now, ⌘1…⌘9 pick a tab — both ⌘ keys, so they act in a field too
      for (const [d, id] of [['1', 'viewBoard'], ['2', 'viewTable'], ['3', 'viewGraph']] as const) {
        expect(resolve(key(SHIFTED_DIGIT[d], { metaKey: true, shiftKey: true, code: `Digit${d}` }), ctx), `${where}: ⌘⇧${d}`).toBe(id);
        expect(resolve(key(d, { metaKey: true }), ctx), `${where}: ⌘${d}`).toBe('tabAt');
        expect(resolve(key(d), ctx), `${where}: ${d}`).toBeNull();
      }
    }
    // nothing typed: both keys of 新建 act; on the settings page too
    expect(resolve(key('c'), idle)).toBe('newIssue');
    expect(resolve(key('n', { metaKey: true }), idle)).toBe('newIssue');
    expect(resolve(key('c'), { ...idle, page: 'settings' })).toBe('newIssue');
    expect(resolve(key('@', { ctrlKey: true, shiftKey: true, code: 'Digit2' }), { ...idle, page: 'settings' })).toBe('viewTable');
    // a bare N or digit is nobody's; ⌘N with Shift neither; ⌥⌘1 only on macOS (GitHub#442)
    for (const k of ['n', '1', '2', '3']) expect(resolve(key(k), idle), k).toBeNull();
    expect(resolve(key('N', { metaKey: true, shiftKey: true }), idle)).toBeNull();
    expect(resolve(key('¡', { metaKey: true, altKey: true, code: 'Digit1' }), idle)).toBe('viewBoard');
    expect(resolve(key('1', { ctrlKey: true, altKey: true, code: 'Digit1' }), { ...idle, mac: false })).toBeNull();
    expect(resolve(key('4', { metaKey: true, altKey: true, code: 'Digit4' }), idle)).toBeNull();
    // a layer on top (dialog, picker, shortcut list) takes them
    for (const layer of ['dialog', 'picker', 'help'] as const) {
      expect(resolve(key('n', { metaKey: true }), { ...idle, layer }), layer).toBeNull();
      expect(resolve(key('1', { metaKey: true }), { ...idle, layer }), layer).toBeNull();
    }
  });
  it('GitHub#413 / #433: ⌘⇧X closes (dialog), ⌘⇧Z hands to the agent, ⌘⇧C is autopilot — also from the reply box, never from another field', () => {
    const ev = (k: string, o: Partial<KeyLike> = {}) => key(k, { shiftKey: true, ...o });
    const three = [
      ['X', 'closeIssue'],
      ['Z', 'handBack'],
      ['C', 'autopilot'],
    ] as const;
    for (const [k, id] of three) {
      // nothing typed, with ⌘ or Ctrl, upper or lower case (macOS reports a lower-case key with ⌘⇧)
      for (const o of [{ metaKey: true }, { ctrlKey: true }])
        for (const kk of [k, k.toLowerCase()]) expect(resolve(ev(kk, o), idle), `${kk} ${JSON.stringify(o)}`).toBe(id);
      // the reply box: they act (GitHub#433) — a ⌘ key is never typing
      expect(resolve(ev(k, { metaKey: true }), { ...idle, typing: 'reply' }), k).toBe(id);
      expect(resolve(ev(k, { ctrlKey: true }), { ...idle, typing: 'reply' }), k).toBe(id);
      // another field (search box, the new issue's title, a settings field): nobody's
      expect(resolve(ev(k, { metaKey: true }), { ...idle, typing: 'other' }), k).toBeNull();
      expect(resolve(ev(k, { metaKey: true }), { ...idle, page: 'settings', typing: 'other' }), k).toBeNull();
      // without ⌘, without Shift, with Alt: not these
      expect(resolve(ev(k), idle), k).toBeNull();
      expect(resolve(key(k.toLowerCase(), { metaKey: true }), idle), k).not.toBe(id);
      expect(resolve(ev(k, { metaKey: true, altKey: true }), idle), k).toBeNull();
      // a layer on top takes them; the settings page has no detail keys; never while composing
      // (GitHub#450: in a dialog ⌘⇧Z / ⌘⇧C are the new-issue dialog's own two buttons, never the detail panel's)
      const inDialog = k === 'Z' ? 'newIssueAgent' : k === 'C' ? 'newIssueAutopilot' : null;
      expect(resolve(ev(k, { metaKey: true }), { ...idle, layer: 'dialog' }), 'dialog').toBe(inDialog);
      for (const layer of ['picker', 'help'] as const) expect(resolve(ev(k, { metaKey: true }), { ...idle, layer }), layer).toBeNull();
      expect(resolve(ev(k, { metaKey: true }), { ...idle, page: 'settings' })).toBeNull();
      expect(resolve(ev(k, { metaKey: true, isComposing: true }), idle)).toBeNull();
      expect(resolve(ev(k, { ctrlKey: true, keyCode: 229 }), { ...idle, typing: 'reply' })).toBeNull();
    }
    // the old keys are nobody's now: a bare x, Shift+A, Shift+P — and in the reply box they stay letters
    for (const ctx of [idle, { ...idle, typing: 'reply' }] as KeyContext[]) {
      expect(resolve(key('x'), ctx)).toBeNull();
      expect(resolve(key('A', { shiftKey: true }), ctx)).toBeNull();
      expect(resolve(key('P', { shiftKey: true }), ctx)).toBeNull();
    }
    // the letters keep their other jobs: a bare C is still 新建 outside a field, ⌘⇧P still 预览 in the reply box
    expect(resolve(key('c'), idle)).toBe('newIssue');
    expect(resolve(key('c'), { ...idle, typing: 'reply' })).toBeNull();
    expect(resolve(key('P', { metaKey: true, shiftKey: true }), { ...idle, typing: 'reply' })).toBe('preview');
    // the other detail keys stay letters in the reply box
    for (const k of ['l', 'm', 'r']) expect(resolve(key(k), { ...idle, typing: 'reply' }), k).toBeNull();
  });
  it('GitHub#450: in a dialog ⌘⇧Z / ⌘⇧C are the new-issue dialog\'s 交给 agent / 托管 — also while typing in its title or body; nowhere else', () => {
    const ev = (k: string, o: Partial<KeyLike> = {}) => key(k, { shiftKey: true, ...o });
    const dialog: KeyContext = { ...idle, layer: 'dialog' };
    for (const [k, id] of [
      ['Z', 'newIssueAgent'],
      ['C', 'newIssueAutopilot'],
    ] as const) {
      for (const o of [{ metaKey: true }, { ctrlKey: true }])
        for (const kk of [k, k.toLowerCase()])
          for (const typing of ['none', 'other', 'reply'] as const) expect(resolve(ev(kk, o), { ...dialog, typing }), `${kk} ${typing}`).toBe(id);
      // without Shift / without ⌘ / with Alt / while composing: not these
      expect(resolve(key(k.toLowerCase(), { metaKey: true }), dialog)).toBeNull();
      expect(resolve(ev(k), { ...dialog, typing: 'other' })).toBeNull();
      expect(resolve(ev(k, { metaKey: true, altKey: true }), dialog)).toBeNull();
      expect(resolve(ev(k, { metaKey: true, isComposing: true }), dialog)).toBeNull();
      // with no dialog the same keys are still the detail panel's
      expect(resolve(ev(k, { metaKey: true }), idle)).toBe(k === 'Z' ? 'handBack' : 'autopilot');
    }
    // ⌘↩ still confirms (创建), Esc still cancels
    expect(resolve(key('Enter', { metaKey: true }), { ...dialog, typing: 'other' })).toBe('confirm');
    expect(keyText('newIssueAgent', true)).toBe('⌘⇧Z');
    expect(keyText('newIssueAutopilot', false)).toBe('Ctrl+Shift+C');
    // the two keys are the detail panel's 交给 agent / 托管 keys, from the same table
    const keysOf = (id: string) => JSON.stringify(SHORTCUTS.find((s) => s.id === id)!.keys);
    expect(keysOf('newIssueAgent')).toBe(keysOf('handBack'));
    expect(keysOf('newIssueAutopilot')).toBe(keysOf('autopilot'));
  });
  it('GitHub#433: the keys the discussion frame passes on are exactly those of FRAME_IDS, and each resolves to its own id', () => {
    expect([...FRAME_IDS]).toEqual(['reply', 'closeIssue', 'handBack', 'autopilot', 'blocked', 'tabAt', 'sync']);
    expect([...FRAME_FORWARD]).toEqual([
      { key: 'r', mod: false, shift: false },
      { key: 'x', mod: true, shift: true },
      { key: 'z', mod: true, shift: true },
      { key: 'c', mod: true, shift: true },
      // GitHub#434: "等前置…"
      { key: 'b', mod: true, shift: true },
      // GitHub#442: ⌘1 … ⌘9 pick a tab from inside the discussion too
      ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => ({ key: k, mod: true, shift: false })),
      // GitHub#442: ⌘R — in a detail tab it reads that item again
      { key: 'r', mod: true, shift: false },
    ]);
    // one table: every forwarded key is a single lower-case key or digit that resolves (outside any field) to a FRAME_IDS shortcut
    for (const f of FRAME_FORWARD) {
      expect(f.key).toMatch(/^[a-z1-9]$/);
      const id = resolve(key(f.key, { metaKey: f.mod, shiftKey: f.shift }), idle);
      expect(FRAME_IDS, JSON.stringify(f)).toContain(id);
    }
    // and every key of every FRAME_IDS shortcut is forwarded
    for (const id of FRAME_IDS)
      for (const k of SHORTCUTS.find((s) => s.id === id)!.keys)
        expect(FRAME_FORWARD).toContainEqual({ key: k.key, mod: Boolean(k.mod), shift: Boolean(k.shift) });
  });
  it('matches: ⌘ and Ctrl both count as the modifier', () => {
    expect(matches({ key: 'r', mod: true }, key('r', { ctrlKey: true }))).toBe(true);
    expect(matches({ key: 'r', mod: true }, key('r', { metaKey: true }))).toBe(true);
    expect(matches({ key: 'r', mod: true }, key('r'))).toBe(false);
  });
});

describe('keys on screen', () => {
  it('⌘ on macOS, Ctrl elsewhere', () => {
    expect(keyParts({ key: 'Enter', mod: true }, true)).toEqual(['⌘', '↩']);
    expect(keyParts({ key: 'Enter', mod: true }, false)).toEqual(['Ctrl', '↩']);
    expect(keyParts({ key: 'p', mod: true, shift: true }, true)).toEqual(['⌘', '⇧', 'P']);
    expect(keyText('send', true)).toBe('⌘↩');
    expect(keyText('send', false)).toBe('Ctrl+↩');
    expect(keyText('labels', true)).toBe('L');
    expect(keyText('helpClose', true)).toBe('Esc / ?');
    expect(keyText('newIssue', true)).toBe('C / ⌘N');
    expect(keyText('newIssue', false)).toBe('C / Ctrl+N');
    // GitHub#442: ⌘⇧1/2/3, and on macOS also ⌥⌘1/2/3 (macOS keeps ⌘⇧3 for its screenshot)
    expect(keyText('viewGraph', true)).toBe('⌘⇧3 / ⌥⌘3');
    expect(keyText('viewGraph', false)).toBe('Ctrl+Shift+3');
    expect(keyText('viewBoard', true)).toBe('⌘⇧1 / ⌥⌘1');
    expect(keyText('tabAt', true)).toBe('⌘1 … ⌘9');
    expect(keyText('tabAt', false)).toBe('Ctrl+1 … Ctrl+9');
    // GitHub#413 / #433
    expect(keyText('closeIssue', true)).toBe('⌘⇧X');
    expect(keyText('closeIssue', false)).toBe('Ctrl+Shift+X');
    expect(keyText('handBack', true)).toBe('⌘⇧Z');
    expect(keyText('handBack', false)).toBe('Ctrl+Shift+Z');
    expect(keyText('autopilot', true)).toBe('⌘⇧C');
    expect(keyText('autopilot', false)).toBe('Ctrl+Shift+C');
    expect(keyText('preview', false)).toBe('Ctrl+Shift+P');
  });
});

describe('GitHub#442: ⌘1 … ⌘9 and ⌘⇧1/2/3', () => {
  it('⌘N picks the tab at N: one shortcut, the digit that matched says which', () => {
    for (let n = 1; n <= 9; n++) {
      const hit = resolveKey(key(String(n), { metaKey: true, code: `Digit${n}` }), idle);
      expect(hit?.id).toBe('tabAt');
      expect(hit?.spec.key).toBe(String(n));
      expect(resolveKey(key(String(n), { ctrlKey: true, code: `Digit${n}` }), { ...idle, mac: false })?.spec.key).toBe(String(n));
    }
    // ⌘0 is the menu's "实际大小", never a tab
    expect(resolve(key('0', { metaKey: true, code: 'Digit0' }), idle)).toBeNull();
  });
  it('a digit is matched by the key itself: Shift and the layout do not change which key it is', () => {
    // US: ⌘⇧1 reports "!"; some systems report "1"; a French layout reports "&" for ⌘1 and "1" for ⌘⇧1
    expect(resolve(key('!', { metaKey: true, shiftKey: true, code: 'Digit1' }), idle)).toBe('viewBoard');
    expect(resolve(key('1', { metaKey: true, shiftKey: true, code: 'Digit1' }), idle)).toBe('viewBoard');
    expect(resolve(key('&', { metaKey: true, code: 'Digit1' }), idle)).toBe('tabAt');
    expect(resolveKey(key('é', { ctrlKey: true, code: 'Digit2' }), { ...idle, mac: false })?.spec.key).toBe('2');
    // the number pad counts as its digit
    expect(resolveKey(key('3', { metaKey: true, code: 'Numpad3' }), idle)?.spec.key).toBe('3');
    // no code reported (a forwarded key from the discussion frame): the key text decides
    expect(resolveKey(key('4', { metaKey: true }), idle)?.spec.key).toBe('4');
    // another key that reports a digit's text is not that digit
    expect(resolve(key('1', { metaKey: true, code: 'KeyQ' }), idle)).toBeNull();
  });
  it('the macOS-only backup keys are nobody\'s elsewhere, and are not shown there', () => {
    for (const d of ['1', '2', '3']) {
      expect(resolve(key(d, { ctrlKey: true, altKey: true, code: `Digit${d}` }), { ...idle, mac: false }), d).toBeNull();
      expect(resolve(key(d, { metaKey: true, altKey: true, code: `Digit${d}` }), idle), d).not.toBeNull();
    }
    expect(keyText('viewTable', false)).toBe('Ctrl+Shift+2');
  });
});
