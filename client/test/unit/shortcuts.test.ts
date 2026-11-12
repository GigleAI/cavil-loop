// GitHub#192: who gets a key press. `resolve` is the only decision; the window's one listener and
// the shortcut list both read SHORTCUTS. These cases pin the rules; the window tests
// (test/e2e/app.spec.ts, "GitHub#192: …") press the real keys and check what GitHub received.
import { describe, expect, it } from 'vitest';
import { SHORTCUTS, keyParts, keyText, matches, resolve, type KeyContext, type KeyLike, type KeySpec, type Scope } from '../../src/renderer/shortcuts';

const key = (k: string, o: Partial<KeyLike> = {}): KeyLike => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
const idle: KeyContext = { signedIn: true, layer: 'none', typing: 'none' };
/** the event a spec describes, with ⌘ (mac) or Ctrl */
const eventOf = (spec: KeySpec, mod: 'meta' | 'ctrl' = 'meta'): KeyLike =>
  key(spec.key === '?' ? '?' : spec.shift && spec.key.length === 1 ? spec.key.toUpperCase() : spec.key, {
    metaKey: Boolean(spec.mod) && mod === 'meta',
    ctrlKey: Boolean(spec.mod) && mod === 'ctrl',
    shiftKey: Boolean(spec.shift),
  });
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
      for (const [d, id] of [['1', 'viewBoard'], ['2', 'viewTable'], ['3', 'viewGraph']] as const) {
        expect(resolve(key(d, { metaKey: true }), ctx), `${where}: ⌘${d}`).toBe(id);
        expect(resolve(key(d), ctx), `${where}: ${d}`).toBeNull();
      }
    }
    // nothing typed: both keys of 新建 act; on the settings page too
    expect(resolve(key('c'), idle)).toBe('newIssue');
    expect(resolve(key('n', { metaKey: true }), idle)).toBe('newIssue');
    expect(resolve(key('c'), { ...idle, page: 'settings' })).toBe('newIssue');
    expect(resolve(key('2', { ctrlKey: true }), { ...idle, page: 'settings' })).toBe('viewTable');
    // a bare N or digit is nobody's; ⌘N / ⌘1 with Shift or Alt neither
    for (const k of ['n', '1', '2', '3']) expect(resolve(key(k), idle), k).toBeNull();
    expect(resolve(key('N', { metaKey: true, shiftKey: true }), idle)).toBeNull();
    expect(resolve(key('1', { metaKey: true, altKey: true }), idle)).toBeNull();
    // a layer on top (dialog, picker, shortcut list) takes them
    for (const layer of ['dialog', 'picker', 'help'] as const) {
      expect(resolve(key('n', { metaKey: true }), { ...idle, layer }), layer).toBeNull();
      expect(resolve(key('1', { metaKey: true }), { ...idle, layer }), layer).toBeNull();
    }
  });
  it('GitHub#413: X opens the close dialog, Shift+A hands to the agent, Shift+P is autopilot — only with nothing typed and nothing on top', () => {
    // nothing typed, no layer: the three keys act (Caps Lock X too)
    expect(resolve(key('x'), idle)).toBe('closeIssue');
    expect(resolve(key('X'), idle)).toBe('closeIssue');
    expect(resolve(key('A', { shiftKey: true }), idle)).toBe('handBack');
    expect(resolve(key('P', { shiftKey: true }), idle)).toBe('autopilot');
    // the two that write at once need Shift: a bare a / p (or Caps Lock A / P) is nobody's
    for (const k of ['a', 'p', 'A', 'P']) expect(resolve(key(k), idle), k).toBeNull();
    // Shift+X is not X; ⌘ / Alt with any of them is nobody's (⌘⇧P outside the reply box neither)
    expect(resolve(key('X', { shiftKey: true }), idle)).toBeNull();
    for (const [k, o] of [
      ['x', { metaKey: true }],
      ['A', { metaKey: true, shiftKey: true }],
      ['P', { metaKey: true, shiftKey: true }],
      ['P', { ctrlKey: true, shiftKey: true }],
      ['A', { altKey: true, shiftKey: true }],
    ] as const)
      expect(resolve(key(k, o), idle), `${k} ${JSON.stringify(o)}`).toBeNull();
    // typing: an x, a capital A or P is text — in the reply box, another field, a settings field
    for (const ctx of [{ ...idle, typing: 'reply' }, { ...idle, typing: 'other' }, { ...idle, page: 'settings', typing: 'other' }] as KeyContext[]) {
      expect(resolve(key('x'), ctx)).toBeNull();
      expect(resolve(key('A', { shiftKey: true }), ctx)).toBeNull();
      expect(resolve(key('P', { shiftKey: true }), ctx)).toBeNull();
    }
    // the reply box keeps its ⌘⇧P (preview)
    expect(resolve(key('P', { metaKey: true, shiftKey: true }), { ...idle, typing: 'reply' })).toBe('preview');
    // a layer on top takes them; the settings page has no detail keys; never while composing
    for (const layer of ['dialog', 'picker', 'help'] as const) {
      expect(resolve(key('x'), { ...idle, layer }), layer).toBeNull();
      expect(resolve(key('A', { shiftKey: true }), { ...idle, layer }), layer).toBeNull();
      expect(resolve(key('P', { shiftKey: true }), { ...idle, layer }), layer).toBeNull();
    }
    expect(resolve(key('x'), { ...idle, page: 'settings' })).toBeNull();
    expect(resolve(key('A', { shiftKey: true }), { ...idle, page: 'settings' })).toBeNull();
    expect(resolve(key('x', { isComposing: true }), idle)).toBeNull();
    expect(resolve(key('A', { shiftKey: true, keyCode: 229 }), idle)).toBeNull();
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
    expect(keyText('viewGraph', true)).toBe('⌘3');
    // GitHub#413
    expect(keyText('closeIssue', true)).toBe('X');
    expect(keyText('handBack', true)).toBe('⇧A');
    expect(keyText('handBack', false)).toBe('Shift+A');
    expect(keyText('autopilot', true)).toBe('⇧P');
    expect(keyText('autopilot', false)).toBe('Shift+P');
  });
});
