// Keyboard shortcuts (GitHub#192): one table and one decision.
//
// SHORTCUTS is the only list of keys: the window's single keydown listener
// (App.tsx, through `resolve`) acts on it, and the shortcut list the user sees
// (ShortcutHelp.tsx) is drawn from it, so the list and the behaviour cannot
// drift apart. `resolve` is the only place that decides who gets a key press:
// signed in or not, which layer (dialog / picker / shortcut list) is on top,
// whether the user is typing, whether an input method is composing.
//
// A shortcut only presses a button for you: every handler is the button's own
// handler, behind the same "is it enabled" condition (see the call sites).

export type Scope = 'global' | 'detail' | 'graph' | 'settings' | 'reply' | 'dialog' | 'picker' | 'help';

/** `mod` = ⌘ on macOS, Ctrl elsewhere (both are accepted everywhere) */
export type KeySpec = { key: string; mod?: boolean; shift?: boolean };

export type ShortcutId =
  | 'search'
  | 'newIssue'
  | 'viewBoard'
  | 'viewTable'
  | 'viewGraph'
  | 'closeTab'
  | 'nextTab'
  | 'prevTab'
  | 'sync'
  | 'settings'
  | 'help'
  | 'labels'
  | 'milestone'
  | 'reply'
  | 'closeIssue'
  | 'handBack'
  | 'autopilot'
  | 'blocked'
  | 'hide'
  | 'send'
  | 'preview'
  | 'leaveReply'
  | 'confirm'
  | 'cancel'
  | 'pickerUp'
  | 'pickerDown'
  | 'pickerToggle'
  | 'pickerClose'
  | 'helpClose'
  | 'graphFit'
  | 'graphZoomIn'
  | 'graphZoomOut'
  | 'settingsBack';

export type Shortcut = { id: ShortcutId; scope: Scope; keys: KeySpec[]; label: string };

export const SCOPE_TITLE: Record<Scope, string> = {
  global: '已登录的任何页面',
  detail: '详情标签页（光标不在输入框里时）',
  graph: '依赖图（光标不在输入框里时；拖动空白处平移，滚轮缩放）',
  settings: '设置页',
  reply: '回复框里',
  dialog: '对话框里',
  picker: '标签 / 里程碑选择框',
  help: '本列表',
};

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'search', scope: 'global', keys: [{ key: '/' }], label: '跳到搜索框（在别的页面会先回到看板）' },
  { id: 'newIssue', scope: 'global', keys: [{ key: 'c' }, { key: 'n', mod: true }], label: '新建 issue（在别的页面会先回到看板）' },
  { id: 'sync', scope: 'global', keys: [{ key: 'r', mod: true }], label: '立即同步' },
  { id: 'settings', scope: 'global', keys: [{ key: ',', mod: true }], label: '打开设置' },
  { id: 'help', scope: 'global', keys: [{ key: '?', shift: true }], label: '快捷键一览' },
  // GitHub#372: the three layout buttons
  { id: 'viewBoard', scope: 'global', keys: [{ key: '1', mod: true }], label: '切到看板（在别的页面会先回到看板）' },
  { id: 'viewTable', scope: 'global', keys: [{ key: '2', mod: true }], label: '切到表格（在别的页面会先回到看板）' },
  { id: 'viewGraph', scope: 'global', keys: [{ key: '3', mod: true }], label: '切到依赖图（在别的页面会先回到看板）' },
  // GitHub#397: detail tabs. On macOS ⌘W is the menu's own key (the shell hands it to the window, see App);
  // with no tab in front it closes the window, as before.
  { id: 'closeTab', scope: 'global', keys: [{ key: 'w', mod: true }], label: '关掉当前标签页（在首页时：macOS 关窗，别的系统不做事）' },
  { id: 'nextTab', scope: 'global', keys: [{ key: ']', mod: true, shift: true }], label: '下一个标签页' },
  { id: 'prevTab', scope: 'global', keys: [{ key: '[', mod: true, shift: true }], label: '上一个标签页' },
  { id: 'labels', scope: 'detail', keys: [{ key: 'l' }], label: '设置标签' },
  { id: 'milestone', scope: 'detail', keys: [{ key: 'm' }], label: '设置里程碑' },
  { id: 'reply', scope: 'detail', keys: [{ key: 'r' }], label: '跳到回复框' },
  // GitHub#413 / #433: the three buttons next to "发送". They take ⌘⇧ (Ctrl+Shift), so they also act
  // from the reply box (a ⌘ key is never typing, see `resolve`) and are forwarded by the discussion
  // frame (FRAME_FORWARD); the letters are the maintainer's choice in #433.
  { id: 'closeIssue', scope: 'detail', keys: [{ key: 'x', mod: true, shift: true }], label: '关闭 issue（只打开选原因的确认框；回复框、讨论区里也能按）' },
  { id: 'handBack', scope: 'detail', keys: [{ key: 'z', mod: true, shift: true }], label: '交给 agent（回复框、讨论区里也能按；回复框里的字不发出）' },
  { id: 'autopilot', scope: 'detail', keys: [{ key: 'c', mod: true, shift: true }], label: '托管（自动合并；设置里开着确认时先弹确认框；回复框、讨论区里也能按）' },
  // GitHub#434: "等前置…" next to them, same ⌘⇧ family
  { id: 'blocked', scope: 'detail', keys: [{ key: 'b', mod: true, shift: true }], label: '等前置（打开选前置的对话框；回复框、讨论区里也能按）' },
  { id: 'hide', scope: 'detail', keys: [{ key: 'Escape' }], label: '回到首页（标签页留着，没发出的文字也留着）' },
  { id: 'graphFit', scope: 'graph', keys: [{ key: 'f' }], label: '适应窗口（整张图放进窗口）' },
  { id: 'graphZoomIn', scope: 'graph', keys: [{ key: '=' }], label: '放大' },
  { id: 'graphZoomOut', scope: 'graph', keys: [{ key: '-' }], label: '缩小' },
  { id: 'settingsBack', scope: 'settings', keys: [{ key: 'Escape' }], label: '回到看板（光标在输入框里时，先离开输入框并保存）' },
  { id: 'send', scope: 'reply', keys: [{ key: 'Enter', mod: true }], label: '发送评论' },
  { id: 'preview', scope: 'reply', keys: [{ key: 'p', mod: true, shift: true }], label: '预览 / 继续编辑' },
  { id: 'leaveReply', scope: 'reply', keys: [{ key: 'Escape' }], label: '离开回复框（文字保留）' },
  { id: 'confirm', scope: 'dialog', keys: [{ key: 'Enter', mod: true }], label: '确认（创建 / 关闭 / 合并 / 托管 / 加入看板）' },
  { id: 'cancel', scope: 'dialog', keys: [{ key: 'Escape' }], label: '取消（新建 issue 里有字时不取消）' },
  { id: 'pickerUp', scope: 'picker', keys: [{ key: 'ArrowUp' }], label: '上一个' },
  { id: 'pickerDown', scope: 'picker', keys: [{ key: 'ArrowDown' }], label: '下一个' },
  { id: 'pickerToggle', scope: 'picker', keys: [{ key: 'Enter' }], label: '加上 / 去掉选中的那个' },
  { id: 'pickerClose', scope: 'picker', keys: [{ key: 'Escape' }], label: '收起选择框' },
  { id: 'helpClose', scope: 'help', keys: [{ key: 'Escape' }, { key: '?', shift: true }], label: '关掉本列表' },
];

/** the fields of a KeyboardEvent this module reads */
export type KeyLike = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

/** what is on top: a layer takes every key, only its own shortcuts act */
export type Layer = 'none' | 'dialog' | 'picker' | 'help';
/** where the keyboard is: the reply box, another text field / select, or nowhere that takes text */
export type Typing = 'none' | 'reply' | 'other';
/** which page is showing (GitHub#369): the settings page has its own Esc; anything else is the board's keys */
export type Page = 'board' | 'settings';
export type KeyContext = { signedIn: boolean; layer: Layer; typing: Typing; page?: Page };

/** an input method is building a character: its keys (Enter to pick, Esc to drop) are never ours */
export function composing(e: KeyLike): boolean {
  return e.isComposing === true || e.keyCode === 229;
}

const SHIFTED: Record<string, string> = { ']': '}', '[': '{' };

export function matches(spec: KeySpec, e: KeyLike): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (Boolean(spec.mod) !== mod || e.altKey) return false;
  // '?' needs Shift on most layouts: it is part of the key, not a separate modifier
  if (spec.key === '?') return e.key === '?';
  if (Boolean(spec.shift) !== e.shiftKey) return false;
  // with Shift held a bracket key reports the brace on most layouts (GitHub#397: ⌘⇧] / ⌘⇧[)
  if (spec.shift && SHIFTED[spec.key]) return e.key === spec.key || e.key === SHIFTED[spec.key];
  return spec.key.length === 1 ? e.key.toLowerCase() === spec.key : e.key === spec.key;
}

/**
 * Who gets this key press: the id of the shortcut to run, or null (leave the key alone).
 * The only rules, in order: never while composing; nothing before sign-in; a layer on top
 * takes every key and only its own shortcuts act; while typing, single keys are typing
 * (only the reply box's own keys and the ⌘ / Ctrl shortcuts act — judged on the key that
 * matched, not on the shortcut: GitHub#372 gave 新建 both C and ⌘N, and a C typed into a
 * field must stay a letter; in the reply box the detail panel's ⌘ keys act too, GitHub#433 —
 * in any other field they do not, a key in the search box must not close the item); otherwise the global,
 * detail-panel and graph keys (a graph key has no handler unless the graph is showing).
 * On the settings page (GitHub#369) its Esc takes the place of the board's keys, also while
 * typing in one of its fields (the first Esc leaves the field, see SettingsView).
 */
export function resolve(e: KeyLike, ctx: KeyContext): ShortcutId | null {
  if (composing(e)) return null;
  if (!ctx.signedIn) return null;
  const allowed = (s: Shortcut, k: KeySpec): boolean => {
    if (ctx.layer !== 'none') return s.scope === ctx.layer;
    const modGlobal = s.scope === 'global' && Boolean(k.mod);
    // GitHub#433: a ⌘ key of the detail panel also acts from the reply box (the box belongs to the panel)
    if (ctx.typing === 'reply') return s.scope === 'reply' || modGlobal || (s.scope === 'detail' && Boolean(k.mod));
    const settings = ctx.page === 'settings';
    if (ctx.typing === 'other') return modGlobal || (settings && s.scope === 'settings');
    if (settings) return s.scope === 'global' || s.scope === 'settings';
    return s.scope === 'global' || s.scope === 'detail' || s.scope === 'graph';
  };
  for (const s of SHORTCUTS) if (s.keys.some((k) => allowed(s, k) && matches(k, e))) return s.id;
  return null;
}

/** where the keyboard is, judged from the focused element; the reply box marks itself with data-keys="reply" */
export function typingOf(el: Element | null): Typing {
  if (!el) return 'none';
  const h = el as HTMLElement;
  if (h.dataset?.keys === 'reply') return 'reply';
  if (h.tagName === 'TEXTAREA' || h.tagName === 'SELECT' || h.isContentEditable) return 'other';
  if (h.tagName === 'INPUT') {
    const t = (h as HTMLInputElement).type;
    return t === 'checkbox' || t === 'radio' || t === 'button' || t === 'submit' ? 'none' : 'other';
  }
  return 'none';
}

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

const KEY_NAME: Record<string, string> = { Enter: '↩', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓' };

/** the keys of one spec as shown on screen, e.g. ['⌘', '↩'] or ['Ctrl', '↩'] */
export function keyParts(spec: KeySpec, mac: boolean): string[] {
  const out: string[] = [];
  if (spec.mod) out.push(mac ? '⌘' : 'Ctrl');
  if (spec.shift && spec.key !== '?') out.push(mac ? '⇧' : 'Shift');
  out.push(KEY_NAME[spec.key] ?? (spec.key.length === 1 ? spec.key.toUpperCase() : spec.key));
  return out;
}

/** one shortcut's keys as one short string (for tooltips): "⌘↩", "Ctrl+↩", "L" */
export function keyText(id: ShortcutId, mac: boolean = isMac()): string {
  const s = SHORTCUTS.find((x) => x.id === id)!;
  return s.keys.map((k) => keyParts(k, mac).join(mac ? '' : '+')).join(' / ');
}

/**
 * The shortcuts the isolated discussion frame passes on to the window (GitHub#322 / #433): go to the
 * reply box, and the three buttons next to "发送". The frame script carries their keys (FRAME_FORWARD,
 * built from this table into its text), and a forwarded key may only end in one of these ids
 * (keyboard.ts, frameKey) — every other key stays inside the frame (PR #171).
 */
export const FRAME_IDS: readonly ShortcutId[] = ['reply', 'closeIssue', 'handBack', 'autopilot', 'blocked'];

/** the keys of FRAME_IDS, as the frame script compares them: a lower-case single key, ⌘/Ctrl, Shift */
export const FRAME_FORWARD: readonly { key: string; mod: boolean; shift: boolean }[] = FRAME_IDS.flatMap((id) =>
  SHORTCUTS.find((s) => s.id === id)!.keys.map((k) => ({ key: k.key, mod: Boolean(k.mod), shift: Boolean(k.shift) })),
);
