// GitHub#487: shortcut keys changed on this machine. The one rule: the table in effect never has two shortcuts
// that can act together sharing a key — after a new key, one shortcut back to its defaults, every shortcut back
// to its defaults, and reading what was saved. And the four places that show or use a key (the key decision,
// the tooltips, the shortcut list, the keys the discussion frame forwards) read the same table.
import { afterEach, describe, expect, it } from 'vitest';
import {
  FIXED_KEYS,
  FRAME_FORWARD,
  SHORTCUTS,
  activeShortcuts,
  canonicalKey,
  changeKey,
  customizable,
  frameAllowed,
  frameForward,
  isCustom,
  keyProblem,
  keyText,
  keysConflicts,
  matches,
  repairKeys,
  resolve,
  setCustomKeys,
  tableFor,
  type CustomKey,
  type CustomKeys,
  type KeyContext,
  type KeyLike,
  type ShortcutId,
} from '../../src/renderer/shortcuts';
import { frameEvent } from '../../src/renderer/keyboard';
import { recordedKey } from '../../src/renderer/ShortcutSettings';

const key = (k: string, o: Partial<KeyLike> = {}): KeyLike => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
const idle: KeyContext = { signedIn: true, layer: 'none', typing: 'none', mac: true };
const MS = { mod: true, shift: true };
const ok = (r: ReturnType<typeof changeKey>): CustomKeys => {
  if (!r.ok) throw new Error(r.why);
  return r.keys;
};
/** what a shortcut's keys are in the table in effect for `keys` */
const keysOf = (keys: CustomKeys, id: ShortcutId) => tableFor(keys).find((s) => s.id === id)!.keys.map((k) => ({ ...k }));
const defaults = (id: ShortcutId) => SHORTCUTS.find((s) => s.id === id)!.keys.map((k) => ({ ...k }));

afterEach(() => setCustomKeys({}));

describe('the default table', () => {
  it('has no conflict, on macOS and elsewhere (so "全部恢复默认" always works)', () => {
    expect(keysConflicts({}, true)).toEqual([]);
    expect(keysConflicts({}, false)).toEqual([]);
  });
  it('nothing changed: the table, the tooltips and the forwarded keys are exactly as before', () => {
    setCustomKeys({});
    expect(activeShortcuts()).toBe(SHORTCUTS);
    expect(tableFor({})).toEqual(SHORTCUTS);
    expect(frameForward()).toEqual(FRAME_FORWARD);
    for (const s of SHORTCUTS) expect(isCustom(s.id)).toBe(false);
  });
  it('the fixed shortcuts are Esc / ↩ / the arrows / ⌘1…⌘9 / ⌘W, every other one may be changed', () => {
    for (const s of SHORTCUTS) expect(customizable(s.id), s.id).toBe(!FIXED_KEYS.has(s.id));
    for (const id of FIXED_KEYS)
      expect(
        SHORTCUTS.find((s) => s.id === id)!.keys.every((k) => ['Escape', 'Enter', 'ArrowUp', 'ArrowDown', 'w', '?'].includes(k.key) || /^[1-9]$/.test(k.key)),
        id,
      ).toBe(true);
  });
});

describe('one table for every place that uses a key', () => {
  it('交给 agent → ⌘⇧A: the key decision, the tooltip, the list and the frame all say ⌘⇧A; ⌘⇧Z no longer does it', () => {
    const keys = ok(changeKey({}, 'handBack', { key: 'a', ...MS }, true));
    setCustomKeys(keys);
    expect(resolve(key('A', { metaKey: true, shiftKey: true }), idle)).toBe('handBack');
    expect(resolve(key('A', { ctrlKey: true, shiftKey: true }), idle)).toBe('handBack');
    expect(resolve(key('Z', { metaKey: true, shiftKey: true }), idle)).toBeNull();
    // also from the reply box (a ⌘ key of the detail panel)
    expect(resolve(key('A', { metaKey: true, shiftKey: true }), { ...idle, typing: 'reply' })).toBe('handBack');
    expect(keyText('handBack', true)).toBe('⌘⇧A');
    expect(keyText('handBack', false)).toBe('Ctrl+Shift+A');
    expect(activeShortcuts().find((s) => s.id === 'handBack')!.keys).toEqual([{ key: 'a', mod: true, shift: true }]);
    expect(isCustom('handBack')).toBe(true);
    expect(frameForward()).toContainEqual({ key: 'a', mod: true, shift: true, alt: false });
    expect(frameForward()).not.toContainEqual({ key: 'z', mod: true, shift: true, alt: false });
    // the frame's report of that key ends in the same shortcut
    expect(resolve(frameEvent('A', true, true, 'KeyA'), idle)).toBe('handBack');
  });
  it('a ⌥ key: matched by its key position (⌥A types "å" on macOS), from the window and from the frame', () => {
    const keys = ok(changeKey({}, 'labels', { key: 'a', alt: true, mod: true }, true));
    setCustomKeys(keys);
    expect(resolve(key('å', { code: 'KeyA', altKey: true, metaKey: true }), idle)).toBe('labels');
    expect(resolve(frameEvent('å', true, false, 'KeyA', true), idle)).toBe('labels');
    expect(resolve(key('l'), idle)).toBeNull();
    expect(keyText('labels', true)).toBe('⌥⌘A');
  });
  it('新建 issue has two default keys: one new key replaces both; restoring brings both back', () => {
    let keys = ok(changeKey({}, 'newIssue', { key: 'i', ...MS }, true));
    setCustomKeys(keys);
    expect(resolve(key('c'), idle)).toBeNull();
    expect(resolve(key('n', { metaKey: true }), idle)).toBeNull();
    expect(resolve(key('I', { metaKey: true, shiftKey: true }), idle)).toBe('newIssue');
    keys = ok(changeKey(keys, 'newIssue', null, true));
    setCustomKeys(keys);
    expect(keys).toEqual({});
    expect(resolve(key('c'), idle)).toBe('newIssue');
    expect(resolve(key('n', { metaKey: true }), idle)).toBe('newIssue');
  });
  it('the shortcut list closes with the key that opens it, changed or not', () => {
    const keys = ok(changeKey({}, 'help', { key: 'k', mod: true }, true));
    setCustomKeys(keys);
    expect(resolve(key('k', { metaKey: true }), idle)).toBe('help');
    expect(resolve(key('k', { metaKey: true }), { ...idle, layer: 'help' })).toBe('helpClose');
    expect(resolve(key('?', { shiftKey: true }), { ...idle, layer: 'help' })).toBeNull();
    expect(resolve(key('Escape'), { ...idle, layer: 'help' })).toBe('helpClose');
  });
});

describe('which keys are not taken', () => {
  const cases: [ShortcutId, CustomKey, boolean][] = [
    ['labels', { key: 'Escape' }, false],
    ['labels', { key: 'Enter', mod: true }, false],
    ['labels', { key: 'ArrowUp' }, false],
    ['labels', { key: 'Tab' }, false],
    ['labels', { key: 'F5' }, true],
    ['labels', { key: '[', alt: true }, false],
    ['labels', { key: 'k', alt: true }, true],
    ['search', { key: 'q', mod: true }, false],
    ['search', { key: 'q', mod: true, shift: true }, true],
    ['search', { key: '=', mod: true }, false],
    ['search', { key: '0', mod: true, shift: true }, false],
    ['search', { key: 'c', mod: true }, false],
    ['search', { key: 'v', mod: true }, false],
    ['search', { key: 'z', mod: true }, false],
    ['search', { key: 'k', mod: true }, true],
    ['viewTable', { key: '4', ...MS }, false], // macOS screenshot
    ['preview', { key: 'p' }, false], // acts in the reply box: needs ⌘
    ['preview', { key: 'e', mod: true }, true],
    ['newIssueAgent', { key: 'g' }, false], // in a dialog with text fields
    ['newIssueAgent', { key: 'g', mod: true }, true],
    ['hide', { key: 'q' }, false], // fixed
    ['tabAt', { key: 'q' }, false], // fixed
  ];
  for (const [id, spec, accepted] of cases)
    it(`${id} ← ${JSON.stringify(spec)}: ${accepted ? 'taken' : 'refused'}`, () => {
      const r = changeKey({}, id, spec, true);
      expect(r.ok, r.ok ? '' : r.why).toBe(accepted);
      if (!r.ok) expect(r.why.length).toBeGreaterThan(4);
    });
  it('⌘⇧3 / ⌘⇧4 are refused on macOS only', () => {
    expect(keyProblem('viewTable', { key: '4', ...MS }, true)).not.toBeNull();
    expect(changeKey({}, 'search', { key: '4', ...MS }, false).ok).toBe(true);
  });
  it('not a key at all: refused, nothing changes', () => {
    for (const bad of [null as unknown, 'a', { key: '' }, { key: 'A' }, { key: 'a', mod: 'yes' }, { key: ' ' }, []])
      expect(changeKey({}, 'search', bad === null ? undefined : bad, true).ok, JSON.stringify(bad)).toBe(false);
    expect(changeKey({}, 'nope', { key: 'k' }, true).ok).toBe(false);
  });
  it('"?" carries its Shift', () => {
    expect(canonicalKey({ key: '?' })).toEqual({ key: '?', shift: true });
  });
});

describe('a new key that would share a key: refused, naming the other one', () => {
  it('交给 agent → ⌘⇧B, the key of 等前置', () => {
    const before: CustomKeys = { search: { key: 'k', mod: true } };
    const snapshot = JSON.stringify(before);
    const r = changeKey(before, 'handBack', { key: 'b', ...MS }, true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain('「等前置」');
    expect(JSON.stringify(before)).toBe(snapshot);
  });
  it('a global key against a detail key, and a detail key against a graph key', () => {
    expect(changeKey({}, 'search', { key: 'l' }, true).ok).toBe(false); // 设置标签 (detail) is L
    expect(changeKey({}, 'labels', { key: 'f' }, true).ok).toBe(false); // 适应窗口 (graph) is F
  });
  it('shortcuts that never act together may share a key', () => {
    // 新建对话框's 交给 agent (dialog) and the detail panel's 交给 agent both have ⌘⇧Z by default
    expect(changeKey({}, 'newIssueAgent', { key: 'b', ...MS }, true).ok).toBe(true);
    // the settings page and the graph
    expect(changeKey({}, 'graphFit', { key: 'k', mod: true }, true).ok).toBe(true);
  });
  it('a fixed key counts: ⌘W, ⌘1, Esc', () => {
    expect(changeKey({}, 'search', { key: 'w', mod: true }, true).ok).toBe(false);
    expect(changeKey({}, 'search', { key: '1', mod: true }, true).ok).toBe(false);
  });
});

describe('putting one shortcut back to its defaults', () => {
  it('the review example: 新建 → ⌘⇧I, 搜索 → C, then restore 新建: refused, both stay', () => {
    let keys = ok(changeKey({}, 'newIssue', { key: 'i', ...MS }, true));
    keys = ok(changeKey(keys, 'search', { key: 'c' }, true));
    const r = changeKey(keys, 'newIssue', null, true);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.why).toContain('恢复不了');
      expect(r.why).toContain('「跳到搜索框」');
    }
    expect(keys).toEqual({ newIssue: { key: 'i', mod: true, shift: true }, search: { key: 'c' } });
    expect(keysOf(keys, 'newIssue')).toEqual([{ key: 'i', mod: true, shift: true }]);
    expect(keysOf(keys, 'search')).toEqual([{ key: 'c' }]);
  });
  it('the same, in the other order: 搜索 first, then 新建 — both work, back to the defaults', () => {
    let keys = ok(changeKey({}, 'newIssue', { key: 'i', ...MS }, true));
    keys = ok(changeKey(keys, 'search', { key: 'c' }, true));
    keys = ok(changeKey(keys, 'search', null, true));
    keys = ok(changeKey(keys, 'newIssue', null, true));
    expect(keys).toEqual({});
    expect(keysOf(keys, 'newIssue')).toEqual(defaults('newIssue'));
  });
  it('restoring a shortcut that was not changed changes nothing', () => {
    expect(ok(changeKey({}, 'search', null, true))).toEqual({});
  });
});

describe('reading what was saved', () => {
  it('nothing saved: nothing changed, nothing to tell', () => {
    expect(repairKeys(null, true)).toEqual({ keys: {}, dropped: [] });
    expect(repairKeys(undefined, true)).toEqual({ keys: {}, dropped: [] });
  });
  it('good keys are kept as they are', () => {
    const saved = { handBack: { key: 'a', mod: true, shift: true }, search: { key: 'k', mod: true } };
    expect(repairKeys(saved, true)).toEqual({ keys: saved, dropped: [] });
  });
  it('the review example: 新建 broken, 搜索 = C → 新建 back to C / ⌘N, 搜索 back to /, both named', () => {
    const r = repairKeys({ newIssue: { key: 7 }, search: { key: 'c' } }, true);
    expect(r.keys).toEqual({});
    expect(keysOf(r.keys, 'newIssue')).toEqual(defaults('newIssue'));
    expect(keysOf(r.keys, 'search')).toEqual(defaults('search'));
    expect(r.dropped.map((d) => d.id)).toEqual(['newIssue', 'search']);
    expect(r.dropped[1].why).toContain('「新建 issue」');
    expect(keysConflicts(r.keys, true)).toEqual([]);
  });
  it('two saved keys on one key (a damaged file): both go, neither is picked by order', () => {
    const a = repairKeys({ handBack: { key: 'a', ...MS }, autopilot: { key: 'a', ...MS } }, true);
    const b = repairKeys({ autopilot: { key: 'a', ...MS }, handBack: { key: 'a', ...MS } }, true);
    expect(a.keys).toEqual({});
    expect(b.keys).toEqual({});
    expect(a.dropped.map((d) => d.id).sort()).toEqual(['autopilot', 'handBack']);
  });
  it('a chain: 新建 broken → its C pushes 搜索 out → 搜索 back on / pushes 跳到回复框 out → all defaults, no conflict', () => {
    const r = repairKeys({ newIssue: 'garbage', search: { key: 'c' }, reply: { key: '/' }, labels: { key: 'k', mod: true } }, true);
    expect(r.keys).toEqual({ labels: { key: 'k', mod: true } }); // not involved: kept
    expect(r.dropped.map((d) => d.id)).toEqual(['newIssue', 'search', 'reply']);
    expect(keysConflicts(r.keys, true)).toEqual([]);
  });
  it('a new default in a later version taking a saved key: the saved one goes (the defaults never move)', () => {
    // 跳到搜索框 saved on L: L is the default of 设置标签
    const r = repairKeys({ search: { key: 'l' } }, true);
    expect(r.keys).toEqual({});
    expect(r.dropped[0].why).toContain('「设置标签」');
  });
  it('unknown shortcuts, fixed shortcuts, keys that are not taken: left out, each with its reason', () => {
    const r = repairKeys({ nope: { key: 'k' }, hide: { key: 'q' }, search: { key: 'q', mod: true }, labels: { key: 'k' } }, true);
    expect(r.keys).toEqual({ labels: { key: 'k' } });
    expect(r.dropped.map((d) => d.id)).toEqual(['nope', 'hide', 'search']);
    for (const d of r.dropped) expect(d.why.length).toBeGreaterThan(3);
  });
  it('a value that is not a list of keys at all: everything at its defaults, said so', () => {
    for (const raw of ['x', 3, [1, 2]]) {
      const r = repairKeys(raw, true);
      expect(r.keys).toEqual({});
      expect(r.dropped.length).toBe(1);
    }
  });
});

describe('the rule holds whatever the order of changes', () => {
  it('a few thousand changes and restores in a pseudo-random order: the table never has a conflict, a refusal never changes anything', () => {
    const ids = SHORTCUTS.filter((s) => customizable(s.id)).map((s) => s.id);
    const pool: CustomKey[] = [
      { key: 'c' },
      { key: '/' },
      { key: 'l' },
      { key: 'r' },
      { key: 'f' },
      { key: 'k' },
      { key: 'a', ...MS },
      { key: 'b', ...MS },
      { key: 'z', ...MS },
      { key: 'n', mod: true },
      { key: 'p', ...MS },
      { key: 'k', mod: true },
      { key: 'x', alt: true },
      ...['g', 'j', 'o', 't', 'u', 'y'].map((k) => ({ key: k })),
      ...['d', 'e', 'g', 'h', 'j', 'o', 'u', 'y'].map((k) => ({ key: k, ...MS })),
      ...['g', 'j', 'o', 'u'].map((k) => ({ key: k, mod: true })),
      // PR #498 review round 1: the brace a Shift+bracket press reports, and the bracket itself
      { key: '}', ...MS },
      { key: ']', ...MS },
      { key: '{', ...MS },
    ];
    // mulberry32: the same sequence on every run
    let seed = 487;
    const rnd = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    let keys: CustomKeys = {};
    let refused = 0;
    let saved = 0;
    for (let i = 0; i < 3000; i++) {
      const id = ids[rnd(ids.length)];
      const spec = rnd(4) === 0 ? null : pool[rnd(pool.length)];
      const before = JSON.stringify(keys);
      const r = changeKey(keys, id, spec, true);
      if (r.ok) {
        keys = r.keys;
        saved++;
      } else {
        refused++;
        expect(JSON.stringify(keys)).toBe(before);
      }
      expect(keysConflicts(keys, true)).toEqual([]);
      if (i % 50 === 0) expect(clashes(keys, true), `step ${i}`).toEqual([]);
      // what is saved reads back unchanged
      expect(repairKeys(JSON.parse(JSON.stringify(keys)), true).keys).toEqual(keys);
    }
    expect(saved).toBeGreaterThan(300);
    expect(refused).toBeGreaterThan(100);
  });
});

describe('recording a key press', () => {
  it('letters, digits, ⌥ letters and ⇧ digits by their position; modifiers alone are not a key yet', () => {
    const ev = (k: string, code: string, o: Partial<KeyLike> = {}) => ({ ...key(k, o), code });
    expect(recordedKey(ev('A', 'KeyA', { shiftKey: true, metaKey: true }))).toEqual({ key: 'a', mod: true, shift: true });
    expect(recordedKey(ev('å', 'KeyA', { altKey: true, metaKey: true }))).toEqual({ key: 'a', mod: true, alt: true });
    expect(recordedKey(ev('!', 'Digit1', { shiftKey: true, ctrlKey: true }))).toEqual({ key: '1', mod: true, shift: true });
    expect(recordedKey(ev('?', 'Slash', { shiftKey: true }))).toEqual({ key: '?', shift: true });
    expect(recordedKey(ev('F5', 'F5'))).toEqual({ key: 'F5' });
    expect(recordedKey(ev('Shift', 'ShiftLeft', { shiftKey: true }))).toBeNull();
    expect(recordedKey(ev('Meta', 'MetaLeft', { metaKey: true }))).toBeNull();
  });
  it('a recorded key, saved, is matched by the very same key press', () => {
    const presses = [
      { ...key('A', { shiftKey: true, metaKey: true }), code: 'KeyA' },
      { ...key('å', { altKey: true, metaKey: true }), code: 'KeyA' },
      { ...key('#', { shiftKey: true, ctrlKey: true }), code: 'Digit3' },
      { ...key('k'), code: 'KeyK' },
    ];
    for (const p of presses) {
      const spec = recordedKey(p)!;
      expect(matches(spec, p, false), JSON.stringify(p)).toBe(true);
    }
  });
});

// ---- PR #498 review round 1 ----

/** US-layout characters with Shift held (what the browser reports as `key`) */
const US_SHIFT: Record<string, string> = { '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')', ']': '}', '[': '{', '/': '?', '=': '+', '-': '_', ',': '<', '.': '>', ';': ':' };
const US_CODE: Record<string, string> = { ']': 'BracketRight', '[': 'BracketLeft', '/': 'Slash', '?': 'Slash', '=': 'Equal', '-': 'Minus', ',': 'Comma', '.': 'Period', ';': 'Semicolon', Enter: 'Enter', Escape: 'Escape', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown' };

/** the key press a spec stands for, as a browser on a US layout reports it (`key` and `code`), with ⌘ or Ctrl */
function pressOf(k: { key: string; mod?: boolean; shift?: boolean; alt?: boolean }, ctrl: boolean): KeyLike {
  const shift = Boolean(k.shift) || k.key === '?';
  const base = k.key === '?' ? '/' : k.key;
  const letter = /^[a-z]$/.test(base);
  const digit = /^[0-9]$/.test(base);
  const code = letter ? `Key${base.toUpperCase()}` : digit ? `Digit${base}` : (US_CODE[base] ?? base);
  const typed = k.alt && letter ? 'ß' : shift ? (letter ? base.toUpperCase() : (US_SHIFT[base] ?? base)) : base;
  return { key: typed, code, metaKey: Boolean(k.mod) && !ctrl, ctrlKey: Boolean(k.mod) && ctrl, shiftKey: shift, altKey: Boolean(k.alt) };
}

/**
 * Where each shortcut's key may act, written out from the rules on their own (client/README.md, "谁接键") — not
 * from the conflict checker: the board with nothing focused, the reply box, another text field, the settings
 * page, each layer on top.
 */
const PLACES: { name: string; acts: (scope: string, mod: boolean) => boolean }[] = [
  { name: 'board', acts: (s) => s === 'global' || s === 'detail' || s === 'graph' },
  { name: 'reply box', acts: (s, mod) => s === 'reply' || (mod && (s === 'global' || s === 'detail')) },
  { name: 'other field', acts: (s, mod) => mod && s === 'global' },
  { name: 'settings', acts: (s) => s === 'global' || s === 'settings' },
  { name: 'settings field', acts: (s, mod) => s === 'settings' || (mod && s === 'global') },
  ...(['dialog', 'picker', 'help'] as const).map((layer) => ({ name: layer, acts: (s: string) => s === layer })),
];

/**
 * Every real key press of the table in effect that two different shortcuts would both take in one place — found
 * by pressing each key of each shortcut (US layout, ⌘ and Ctrl) and asking `matches` of every other shortcut.
 */
function clashes(keys: CustomKeys, mac: boolean): string[] {
  const table = tableFor(keys);
  const out: string[] = [];
  for (const s of table)
    for (const k of s.keys) {
      if (k.macOnly && !mac) continue;
      for (const ctrl of [false, true]) {
        const e = pressOf(k, ctrl);
        for (const place of PLACES) {
          const hit = new Set<string>();
          for (const t of table) for (const tk of t.keys) if (place.acts(t.scope, Boolean(tk.mod)) && matches(tk, e, mac)) hit.add(t.id);
          // the shortcut list closes with the key that opens it, by design
          if (hit.has('help') && hit.has('helpClose')) hit.delete('helpClose');
          if (hit.size > 1) out.push(`${place.name}: ${JSON.stringify(e.key)}${e.shiftKey ? '+Shift' : ''}${e.ctrlKey || e.metaKey ? '+Mod' : ''} → ${[...hit].sort().join(', ')}`);
        }
      }
    }
  return [...new Set(out)];
}

describe('PR #498 review round 1: one key press, one shortcut — checked by pressing the keys, not by the checker', () => {
  it('the default table: no real key press is taken by two shortcuts in one place, on macOS and elsewhere', () => {
    expect(clashes({}, true)).toEqual([]);
    expect(clashes({}, false)).toEqual([]);
  });
  it('跳到搜索框 → Ctrl+Shift+] as recorded ("}"): refused, it is 下一个标签页; the same as written with "]"', () => {
    const e = { key: '}', code: 'BracketRight', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false };
    const rec = recordedKey(e)!;
    for (const spec of [rec, { key: '}', mod: true, shift: true }, { key: ']', mod: true, shift: true }]) {
      const r = changeKey({}, 'search', spec, false);
      expect(r.ok, JSON.stringify(spec)).toBe(false);
      if (!r.ok) expect(r.why).toContain('「下一个标签页」');
      // had it been saved anyway, the press would go to two shortcuts — which the press check sees
      expect(clashes({ search: spec } as CustomKeys, false).length, JSON.stringify(spec)).toBeGreaterThan(0);
    }
  });
  it('a saved "}" + Shift reads back as "]" + Shift: a clash with 下一个标签页 is found and left out; where nothing else takes it, it is kept, as "]"', () => {
    const r = repairKeys({ search: { key: '}', mod: true, shift: true } }, false);
    expect(r.keys).toEqual({});
    expect(r.dropped.map((d) => d.id)).toEqual(['search']);
    expect(r.dropped[0].why).toContain('「下一个标签页」');
    // 新建对话框的「交给 agent」only acts inside that dialog: free there
    const kept = repairKeys({ newIssueAgent: { key: '}', mod: true, shift: true } }, false);
    expect(kept.keys).toEqual({ newIssueAgent: { key: ']', mod: true, shift: true } });
    // and that key still acts on the real press
    setCustomKeys(kept.keys);
    expect(resolve({ key: '}', code: 'BracketRight', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, { ...idle, mac: false, layer: 'dialog' })).toBe('newIssueAgent');
  });
  it('a free key is still taken after the change (no false clash)', () => {
    expect(changeKey({}, 'newIssueAgent', { key: '}', mod: true, shift: true }, false).ok).toBe(true);
    expect(changeKey({}, 'search', { key: 'k', mod: true }, false).ok).toBe(true);
  });
});

describe('PR #498 review round 1: a key without ⌘ never comes from the discussion frame (except 跳到回复框)', () => {
  it('交给 agent → A: the frame is not given A; the window would refuse it anyway', () => {
    const keys = ok(changeKey({}, 'handBack', { key: 'a' }, true));
    setCustomKeys(keys);
    expect(frameForward().some((f) => f.key === 'a')).toBe(false);
    expect(frameAllowed('handBack', { key: 'a' })).toBe(false);
    // still acts from the panel itself
    expect(resolve(key('a'), idle)).toBe('handBack');
  });
  it('交给 agent → ⌘⇧A: forwarded; 跳到回复框 keeps its bare key, changed or not', () => {
    setCustomKeys(ok(changeKey({}, 'handBack', { key: 'a', ...MS }, true)));
    expect(frameForward()).toContainEqual({ key: 'a', mod: true, shift: true, alt: false });
    expect(frameForward()).toContainEqual({ key: 'r', mod: false, shift: false, alt: false });
    setCustomKeys(ok(changeKey({}, 'reply', { key: 'j' }, true)));
    expect(frameForward()).toContainEqual({ key: 'j', mod: false, shift: false, alt: false });
    expect(frameAllowed('reply', { key: 'j' })).toBe(true);
  });
  it('nothing changed: the frame gets exactly the default list it always had', () => {
    setCustomKeys({});
    expect(frameForward()).toEqual(FRAME_FORWARD);
    expect(FRAME_FORWARD.filter((f) => !f.mod).map((f) => f.key)).toEqual(['r']);
  });
});

describe('PR #498 review round 2: a saved key named like a built-in property is just a bad key', () => {
  it('constructor / toString / __proto__ / hasOwnProperty, with and without Shift: left out with a reason, no exception', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])
      for (const shift of [true, false]) {
        const r = repairKeys({ labels: { key: name, shift }, search: { key: 'k', mod: true } }, false);
        expect(r.keys, `${name} ${shift}`).toEqual({ search: { key: 'k', mod: true } });
        expect(r.dropped.map((d) => d.id)).toEqual(['labels']);
        expect(r.dropped[0].why.length).toBeGreaterThan(3);
        const c = changeKey({}, 'labels', { key: name, shift }, false);
        expect(c.ok, `${name} ${shift}`).toBe(false);
      }
  });
  it('the brace still becomes the bracket, and a usable key is still kept', () => {
    expect(canonicalKey({ key: '}', mod: true, shift: true })).toEqual({ key: ']', mod: true, shift: true });
    expect(canonicalKey({ key: '{', shift: true })).toEqual({ key: '[', shift: true });
    expect(repairKeys({ newIssueAgent: { key: '}', mod: true, shift: true } }, false).keys).toEqual({ newIssueAgent: { key: ']', mod: true, shift: true } });
  });
});
