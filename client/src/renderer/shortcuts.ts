// Keyboard shortcuts (GitHub#192): one table and one decision.
//
// SHORTCUTS is the only list of default keys. The table in effect is SHORTCUTS with the keys changed on this
// machine laid over it (GitHub#487, `tableFor` / `activeShortcuts` below): the window's single keydown listener
// (App.tsx, through `resolve`) acts on it, and the shortcut list the user sees (ShortcutHelp.tsx), the tooltips
// and the settings page are drawn from it, so the list and the behaviour cannot drift apart. `resolve` is the only place that decides who gets a key press:
// signed in or not, which layer (dialog / picker / shortcut list) is on top,
// whether the user is typing, whether an input method is composing.
//
// A shortcut only presses a button for you: every handler is the button's own
// handler, behind the same "is it enabled" condition (see the call sites).

export type Scope = 'global' | 'detail' | 'graph' | 'settings' | 'reply' | 'dialog' | 'picker' | 'help';

/**
 * `mod` = ⌘ on macOS, Ctrl elsewhere (both are accepted everywhere). `alt` = ⌥ / Alt held too.
 * `macOnly`: this key exists on macOS only (GitHub#442: ⌥⌘1/2/3, because macOS keeps ⌘⇧3 for its own
 * screenshot). `macHidden`: still acted on everywhere, but not shown on macOS (GitHub#465: ⌘⇧3 — by default
 * the system takes it for the screenshot and the window never sees it; should it ever arrive, it still acts).
 * A digit is matched by the key itself (`code`), not by what Shift / ⌥ / the layout turn it into.
 */
export type KeySpec = { key: string; mod?: boolean; shift?: boolean; alt?: boolean; macOnly?: boolean; macHidden?: boolean };

export type ShortcutId =
  | 'search'
  | 'newIssue'
  | 'viewBoard'
  | 'viewTable'
  | 'viewGraph'
  | 'closeTab'
  | 'nextTab'
  | 'prevTab'
  | 'tabAt'
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
  | 'newIssueAgent'
  | 'newIssueAutopilot'
  | 'pickerUp'
  | 'pickerDown'
  | 'pickerToggle'
  | 'pickerClose'
  | 'helpClose'
  | 'graphFit'
  | 'graphZoomIn'
  | 'graphZoomOut'
  | 'settingsBack';

/** `range`: the keys are one run (⌘1 … ⌘9), shown on screen as its first and last key */
export type Shortcut = { id: ShortcutId; scope: Scope; keys: KeySpec[]; label: string; range?: boolean };

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

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
  { id: 'sync', scope: 'global', keys: [{ key: 'r', mod: true }], label: '立即同步（详情标签页在前时：重新读这一条，同详情的刷新按钮）' },
  { id: 'settings', scope: 'global', keys: [{ key: ',', mod: true }], label: '打开设置' },
  { id: 'help', scope: 'global', keys: [{ key: '?', shift: true }], label: '快捷键一览' },
  // GitHub#372: the three layout buttons. GitHub#442: ⌘⇧1/2/3 (⌘1…⌘9 now pick a tab); on macOS also ⌥⌘1/2/3,
  // since macOS takes ⌘⇧3 for its screenshot before the window sees it. GitHub#465: on macOS the ⌥⌘ key comes
  // first (it is what tooltips and the list name first), and ⌘⇧3 is not shown there — it stays acted on
  { id: 'viewBoard', scope: 'global', keys: [{ key: '1', mod: true, alt: true, macOnly: true }, { key: '1', mod: true, shift: true }], label: '切到看板（在别的页面会先回到看板）' },
  { id: 'viewTable', scope: 'global', keys: [{ key: '2', mod: true, alt: true, macOnly: true }, { key: '2', mod: true, shift: true }], label: '切到表格（在别的页面会先回到看板）' },
  {
    id: 'viewGraph',
    scope: 'global',
    keys: [{ key: '3', mod: true, alt: true, macOnly: true }, { key: '3', mod: true, shift: true, macHidden: true }],
    label: '切到依赖图（在别的页面会先回到看板；macOS 默认把 ⌘⇧3 留给整屏截图，窗口收不到，这里用 ⌥⌘3）',
  },
  // GitHub#397: detail tabs. On macOS ⌘W is the menu's own key (the shell hands it to the window, see App);
  // with no tab in front it closes the window, as before.
  { id: 'closeTab', scope: 'global', keys: [{ key: 'w', mod: true }], label: '关掉当前标签页（在首页时：macOS 关窗，别的系统不做事）' },
  { id: 'nextTab', scope: 'global', keys: [{ key: ']', mod: true, shift: true }], label: '下一个标签页' },
  { id: 'prevTab', scope: 'global', keys: [{ key: '[', mod: true, shift: true }], label: '上一个标签页' },
  // GitHub#442: as in a browser — ⌘1 is the leftmost tab (首页), ⌘9 always the last one
  { id: 'tabAt', scope: 'global', keys: DIGITS.map((key) => ({ key, mod: true })), range: true, label: '切到第几个标签页（1 是首页，9 是最后一个；只有首页时不做事）' },
  { id: 'labels', scope: 'detail', keys: [{ key: 'l' }], label: '设置标签' },
  { id: 'milestone', scope: 'detail', keys: [{ key: 'm' }], label: '设置里程碑' },
  { id: 'reply', scope: 'detail', keys: [{ key: 'r' }], label: '跳到回复框' },
  // GitHub#413 / #433: the three buttons next to "发送". They take ⌘⇧ (Ctrl+Shift), so they also act
  // from the reply box (a ⌘ key is never typing, see `resolve`) and are forwarded by the discussion
  // frame (FRAME_FORWARD); the letters are the maintainer's choice in #433.
  { id: 'closeIssue', scope: 'detail', keys: [{ key: 'x', mod: true, shift: true }], label: '关闭 issue（只打开选原因的确认框；回复框、讨论区里也能按）' },
  { id: 'handBack', scope: 'detail', keys: [{ key: 'z', mod: true, shift: true }], label: '交给 agent（回复框、讨论区里也能按；回复框里有字时先作为评论发出，发成功后再改标签）' },
  { id: 'autopilot', scope: 'detail', keys: [{ key: 'c', mod: true, shift: true }], label: '托管（自动合并；设置里开着确认时先弹确认框；回复框、讨论区里也能按；回复框里有字时先作为评论发出）' },
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
  // GitHub#450: the new-issue dialog's two buttons, on the detail panel's keys for 交给 agent / 托管 (the
  // detail panel cannot hear them while a dialog is on top). Only that dialog handles them: in any other
  // dialog the key is left to the browser.
  { id: 'newIssueAgent', scope: 'dialog', keys: [{ key: 'z', mod: true, shift: true }], label: '新建 issue：交给 agent（加上派工标签并创建；标题、正文里也能按）' },
  { id: 'newIssueAutopilot', scope: 'dialog', keys: [{ key: 'c', mod: true, shift: true }], label: '新建 issue：托管（设置里开着确认时先弹确认框；标题、正文里也能按）' },
  { id: 'pickerUp', scope: 'picker', keys: [{ key: 'ArrowUp' }], label: '上一个' },
  { id: 'pickerDown', scope: 'picker', keys: [{ key: 'ArrowDown' }], label: '下一个' },
  { id: 'pickerToggle', scope: 'picker', keys: [{ key: 'Enter' }], label: '加上 / 去掉选中的那个' },
  { id: 'pickerClose', scope: 'picker', keys: [{ key: 'Escape' }], label: '收起选择框' },
  { id: 'helpClose', scope: 'help', keys: [{ key: 'Escape' }, { key: '?', shift: true }], label: '关掉本列表' },
];

/**
 * With Shift held a bracket key reports the brace on most layouts (GitHub#397: ⌘⇧] / ⌘⇧[). One table for every
 * place that has to know: `matches` accepts both, and a changed key is kept with the bracket (GitHub#487: the
 * recorder sees "}", the default table says "]" + Shift — the same key press, so the same key everywhere).
 */
const SHIFTED: Record<string, string> = { ']': '}', '[': '{' };
const UNSHIFTED: Record<string, string> = Object.fromEntries(Object.entries(SHIFTED).map(([a, b]) => [b, a]));

/** a key with Shift held, in the one form the tables use: "}" + Shift is "]" + Shift */
function shiftBase(key: string, shift: boolean): string {
  return shift && UNSHIFTED[key] ? UNSHIFTED[key] : key;
}

// ---- GitHub#487: keys changed on this machine ----
//
// SHORTCUTS stays the default table. The keys the user changed (one key per shortcut, replacing all of its
// default keys) are laid over it into the table in effect, `active`: the key decision (`resolveKey`), the
// tooltips (`keyText`), the shortcut list and the keys the discussion frame forwards all read that one table.
// The one rule about changed keys: the table in effect never has two shortcuts that can act at the same time
// sharing a key. Every way of changing the keys — a new key, one shortcut back to its defaults, every shortcut
// back to its defaults, reading what was saved — goes through `keysConflicts` on the whole table.

/** a changed key as kept on this machine: what a KeySpec says, minus the platform flags */
export type CustomKey = { key: string; mod?: boolean; shift?: boolean; alt?: boolean };
/** the changed keys, by shortcut; a shortcut not listed has its default keys */
export type CustomKeys = Partial<Record<ShortcutId, CustomKey>>;
/** a saved key that could not be used, and why (shown on the settings page) */
export type DroppedKey = { id: string; name: string; why: string };

/**
 * Shortcuts whose keys stay as they are: Esc / ↩ / the arrows (the same everywhere), ⌘1 … ⌘9 (one run of keys,
 * by position), ⌘W (the macOS menu's own key, it never goes through `resolve` there).
 */
export const FIXED_KEYS: ReadonlySet<ShortcutId> = new Set<ShortcutId>([
  'closeTab',
  'tabAt',
  'hide',
  'settingsBack',
  'send',
  'leaveReply',
  'confirm',
  'cancel',
  'pickerUp',
  'pickerDown',
  'pickerToggle',
  'pickerClose',
  'helpClose',
]);

export function customizable(id: unknown): id is ShortcutId {
  return typeof id === 'string' && SHORTCUTS.some((s) => s.id === id) && !FIXED_KEYS.has(id as ShortcutId);
}

/** what a shortcut does, short: its label up to the first explanation in brackets */
export function shortcutName(id: string): string {
  const s = SHORTCUTS.find((x) => x.id === id);
  return s ? s.label.split('（')[0] : id;
}

/** a key as written on screen, e.g. "⌘⇧A" / "Ctrl+Shift+A" */
export function specText(spec: KeySpec, mac: boolean = isMac()): string {
  return keyParts(spec, mac).join(mac ? '' : '+');
}

const NAMED_OK = /^F([1-9]|1[0-2])$/;

/** a stored key in one canonical shape, or null when it is not a key at all */
export function canonicalKey(raw: unknown): CustomKey | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== 'string' || r.key === '' || r.key.length > 16) return null;
  for (const f of ['mod', 'shift', 'alt']) if (r[f] !== undefined && typeof r[f] !== 'boolean') return null;
  if (r.key.length === 1 ? r.key !== r.key.toLowerCase() || /\s/.test(r.key) : false) return null;
  // '?' is Shift + / on most layouts: Shift is part of the key (see `matches`)
  const shift = Boolean(r.shift) || r.key === '?';
  const out: CustomKey = { key: shiftBase(r.key, shift) };
  if (r.mod) out.mod = true;
  if (shift) out.shift = true;
  if (r.alt) out.alt = true;
  return out;
}

/**
 * Why `spec` cannot be the key of shortcut `id` (null: it can). Conflicts with other shortcuts are not
 * looked at here — that is `keysConflicts`, on the whole table.
 */
export function keyProblem(id: ShortcutId, spec: CustomKey, mac: boolean = isMac()): string | null {
  if (!customizable(id)) return '这个操作的键是固定的，不能改';
  const k = spec.key;
  const mod = Boolean(spec.mod);
  const shift = Boolean(spec.shift);
  const alt = Boolean(spec.alt);
  if (k.length > 1 && !NAMED_OK.test(k)) return 'Esc、↩、Tab、空格、退格和方向键有固定用途，换一个键';
  if (alt && !/^[a-z0-9]$/.test(k)) return '按住 ⌥ / Alt 时只能配字母或数字';
  if (mod && !alt) {
    if (['=', '-', '+', '0'].includes(k)) return `${specText({ key: k, mod: true }, mac)} 是菜单里的缩放键，换一个`;
    if (!shift && ['q', 'h', 'm'].includes(k)) return `${specText({ key: k, mod: true }, mac)} 由系统使用（退出 / 隐藏 / 最小化），换一个`;
    if (!shift && ['c', 'v', 'x', 'a', 'z'].includes(k)) return `${specText({ key: k, mod: true }, mac)} 是输入框里的编辑键（复制 / 粘贴 / 剪切 / 全选 / 撤销），换一个`;
    if (mac && shift && ['3', '4', '5'].includes(k)) return `macOS 把 ${specText({ key: k, mod: true, shift: true }, mac)} 留给截图，窗口收不到，换一个`;
  }
  const scope = SHORTCUTS.find((s) => s.id === id)!.scope;
  // these act while the keyboard is in a text field: a key without ⌘ / Ctrl would only type there
  if ((scope === 'reply' || scope === 'dialog') && !mod) return '这个操作在输入框里也要能按，新键必须带 ⌘ / Ctrl';
  return null;
}

/** The table in effect for `keys` (already checked): a changed shortcut has exactly its one key. */
export function tableFor(keys: CustomKeys): Shortcut[] {
  const help = keys.help;
  return SHORTCUTS.map((s) => {
    const k = keys[s.id];
    if (k && !FIXED_KEYS.has(s.id)) return { ...s, keys: [{ ...k }] };
    // the shortcut list closes with Esc and with the key that opens it
    if (s.id === 'helpClose' && help) return { ...s, keys: [{ key: 'Escape' }, { ...help }] };
    return s;
  });
}

/** whether shortcuts of these two scopes can act on the same key press (see `resolveKey`) */
function together(a: Scope, b: Scope): boolean {
  if (a === b) return true;
  const layers: Scope[] = ['dialog', 'picker', 'help'];
  if (layers.includes(a) || layers.includes(b)) return false;
  if (a === 'global' || b === 'global') return true;
  const pair = [a, b].sort().join(' ');
  // the detail panel is over the graph; the reply box belongs to the detail panel
  return pair === 'detail graph' || pair === 'detail reply';
}

/** the same key press: what `matches` would tell apart (a digit by itself, '?' with its Shift) */
function sameKey(a: KeySpec, b: KeySpec): boolean {
  const norm = (k: KeySpec) => {
    const shift = Boolean(k.shift) || k.key === '?';
    return `${shiftBase(k.key === '?' ? '?' : k.key.toLowerCase(), shift)}|${Boolean(k.mod)}|${shift}|${Boolean(k.alt)}`;
  };
  return norm(a) === norm(b);
}

/** one conflict: two shortcuts that can act together share `spec` */
export type KeyConflict = { a: ShortcutId; b: ShortcutId; spec: KeySpec };

/** every conflict in the table in effect for `keys`, on this kind of machine */
export function keysConflicts(keys: CustomKeys, mac: boolean = isMac()): KeyConflict[] {
  const table = tableFor(keys);
  const out: KeyConflict[] = [];
  const live = (k: KeySpec) => !k.macOnly || mac;
  for (let i = 0; i < table.length; i++)
    for (let j = i + 1; j < table.length; j++) {
      const a = table[i];
      const b = table[j];
      if (!together(a.scope, b.scope)) continue;
      // the shortcut list closes with the key that opens it, by design
      if ((a.id === 'help' && b.id === 'helpClose') || (a.id === 'helpClose' && b.id === 'help')) continue;
      // in the reply box only the ⌘ / Ctrl keys of the other places act (a plain key there is typing)
      const inReply = (a.scope === 'reply') !== (b.scope === 'reply');
      for (const ka of a.keys.filter(live)) {
        if (inReply && !ka.mod) continue;
        const kb = b.keys.filter(live).find((x) => sameKey(ka, x));
        if (kb) {
          out.push({ a: a.id, b: b.id, spec: ka });
          break;
        }
      }
    }
  return out;
}

/** the result of a change: saved (the new keys), or refused with the reason (nothing changes) */
export type KeyChange = { ok: true; keys: CustomKeys } | { ok: false; why: string };

/**
 * Change one shortcut's key (`spec`) or put it back to its defaults (`spec` null), on the whole table:
 * refused when the key itself cannot be used, or when the table in effect afterwards would have a conflict.
 */
export function changeKey(keys: CustomKeys, id: unknown, spec: unknown, mac: boolean = isMac()): KeyChange {
  if (!customizable(id)) return { ok: false, why: '这个操作的键是固定的，不能改' };
  const next: CustomKeys = { ...keys };
  if (spec === null) delete next[id];
  else {
    const k = canonicalKey(spec);
    if (!k) return { ok: false, why: '认不出这个键' };
    const bad = keyProblem(id, k, mac);
    if (bad) return { ok: false, why: bad };
    next[id] = k;
  }
  const mine = keysConflicts(next, mac).filter((c) => c.a === id || c.b === id || (id === 'help' && (c.a === 'helpClose' || c.b === 'helpClose')));
  if (mine.length) {
    const c = mine[0];
    const other = c.a === id || (id === 'help' && c.a === 'helpClose') ? c.b : c.a;
    const key = specText(c.spec, mac);
    if (spec === null)
      return {
        ok: false,
        why: `恢复不了：默认键 ${key} 现在是「${shortcutName(other)}」的键，恢复后两个操作会抢同一个键。先把「${shortcutName(other)}」改掉或恢复默认，再来恢复这一个。`,
      };
    return { ok: false, why: `${key} 已经是「${shortcutName(other)}」的快捷键，会撞车。换一个键，或先把「${shortcutName(other)}」改掉。` };
  }
  return { ok: true, keys: next };
}

/**
 * What was saved, made usable: every entry that is not a usable key of a shortcut that may be changed is left
 * out; then, round by round, every changed key caught in any conflict is left out (that shortcut has its
 * defaults again), until the table has none. The defaults have no conflict, so this ends; it leaves out every
 * party of a conflict at once, so the result does not depend on the order things were saved in.
 */
export function repairKeys(raw: unknown, mac: boolean = isMac()): { keys: CustomKeys; dropped: DroppedKey[] } {
  const keys: CustomKeys = {};
  const dropped: DroppedKey[] = [];
  if (raw === null || raw === undefined) return { keys, dropped };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { keys, dropped: [{ id: '', name: '全部', why: '保存的内容读不出来' }] };
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!SHORTCUTS.some((s) => s.id === id)) {
      dropped.push({ id, name: id, why: '这个版本没有这个操作' });
      continue;
    }
    if (!customizable(id)) {
      dropped.push({ id, name: shortcutName(id), why: '这个操作的键是固定的' });
      continue;
    }
    const k = canonicalKey(v);
    const bad = k ? keyProblem(id, k, mac) : '保存的键读不出来';
    if (!k || bad) {
      dropped.push({ id, name: shortcutName(id), why: bad ?? '保存的键读不出来' });
      continue;
    }
    keys[id] = k;
  }
  for (;;) {
    const conflicts = keysConflicts(keys, mac);
    const owner = (id: ShortcutId): ShortcutId => (id === 'helpClose' ? 'help' : id);
    const out = new Map<ShortcutId, string>();
    for (const c of conflicts)
      for (const [me, other] of [
        [owner(c.a), c.b],
        [owner(c.b), c.a],
      ] as const)
        if (keys[me] && !out.has(me)) out.set(me, `保存的 ${specText(c.spec, mac)} 和「${shortcutName(other)}」撞车`);
    if (!out.size) break;
    for (const [id, why] of out) {
      delete keys[id];
      dropped.push({ id, name: shortcutName(id), why });
    }
  }
  return { keys, dropped };
}

/** the table in effect in this window (set by App from the controller's state) */
let active: readonly Shortcut[] = SHORTCUTS;
let activeKeys: CustomKeys = {};

/** Use these changed keys (as the controller keeps them: already repaired). Unchanged keys keep the same table. */
export function setCustomKeys(keys: CustomKeys | null | undefined): void {
  const next = keys ?? {};
  if (JSON.stringify(next) === JSON.stringify(activeKeys)) return;
  activeKeys = next;
  active = tableFor(next);
}

/** the table in effect */
export function activeShortcuts(): readonly Shortcut[] {
  return active;
}

/** whether this shortcut's key was changed on this machine */
export function isCustom(id: ShortcutId): boolean {
  return Boolean(activeKeys[id]);
}

/** the fields of a KeyboardEvent this module reads */
export type KeyLike = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  /** the physical key ("Digit1"): what a digit is matched by */
  code?: string;
};

/** what is on top: a layer takes every key, only its own shortcuts act */
export type Layer = 'none' | 'dialog' | 'picker' | 'help';
/** where the keyboard is: the reply box, another text field / select, or nowhere that takes text */
export type Typing = 'none' | 'reply' | 'other';
/** which page is showing (GitHub#369): the settings page has its own Esc; anything else is the board's keys */
export type Page = 'board' | 'settings';
/** `mac`: whether macOS-only keys count (default: this machine's answer, `isMac`) */
export type KeyContext = { signedIn: boolean; layer: Layer; typing: Typing; page?: Page; mac?: boolean };

/** an input method is building a character: its keys (Enter to pick, Esc to drop) are never ours */
export function composing(e: KeyLike): boolean {
  return e.isComposing === true || e.keyCode === 229;
}


export function matches(spec: KeySpec, e: KeyLike, mac: boolean = isMac()): boolean {
  if (spec.macOnly && !mac) return false;
  const mod = e.metaKey || e.ctrlKey;
  if (Boolean(spec.mod) !== mod || Boolean(spec.alt) !== e.altKey) return false;
  // '?' needs Shift on most layouts: it is part of the key, not a separate modifier
  if (spec.key === '?') return e.key === '?';
  if (Boolean(spec.shift) !== e.shiftKey) return false;
  // with Shift held a bracket key reports the brace on most layouts (GitHub#397: ⌘⇧] / ⌘⇧[)
  if (spec.shift && SHIFTED[spec.key]) return e.key === spec.key || e.key === SHIFTED[spec.key];
  // GitHub#442: a digit is the key itself — ⇧1 reports "!" on a US layout, a French one needs Shift for any digit
  // (no code reported — a key forwarded by the discussion frame: its text decides)
  if (/^[0-9]$/.test(spec.key)) return typeof e.code === 'string' && e.code !== '' ? /^(Digit|Numpad)[0-9]$/.test(e.code) && e.code.slice(-1) === spec.key : e.key === spec.key;
  // GitHub#487: with ⌥ held macOS types another character (⌥A → å): a letter key of a ⌥ shortcut is its position
  if (spec.alt && /^[a-z]$/.test(spec.key) && typeof e.code === 'string' && /^Key[A-Z]$/.test(e.code)) return e.code === `Key${spec.key.toUpperCase()}`;
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
  return resolveKey(e, ctx)?.id ?? null;
}

/** `resolve`, with the key that matched (GitHub#442: ⌘1…⌘9 are one shortcut, the digit says which tab) */
export function resolveKey(e: KeyLike, ctx: KeyContext): { id: ShortcutId; spec: KeySpec } | null {
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
  const mac = ctx.mac ?? isMac();
  for (const s of active) for (const k of s.keys) if (allowed(s, k) && matches(k, e, mac)) return { id: s.id, spec: k };
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
  if (spec.alt) out.push(mac ? '⌥' : 'Alt');
  if (spec.mod) out.push(mac ? '⌘' : 'Ctrl');
  if (spec.shift && spec.key !== '?') out.push(mac ? '⇧' : 'Shift');
  out.push(KEY_NAME[spec.key] ?? (spec.key.length === 1 ? spec.key.toUpperCase() : spec.key));
  return out;
}

/** one shortcut's keys as one short string (for tooltips): "⌘↩", "Ctrl+↩", "L" */
export function keyText(id: ShortcutId, mac: boolean = isMac()): string {
  const s = active.find((x) => x.id === id)!;
  const one = (k: KeySpec) => keyParts(k, mac).join(mac ? '' : '+');
  if (s.range) return `${one(s.keys[0])} … ${one(s.keys[s.keys.length - 1])}`;
  return shownKeys(s, mac).map(one).join(' / ');
}

/** the keys of a shortcut shown on this kind of machine (GitHub#465: not the ones macOS keeps for itself) */
export function shownKeys(s: Shortcut, mac: boolean = isMac()): KeySpec[] {
  return s.keys.filter((k) => (mac ? !k.macHidden : !k.macOnly));
}

/**
 * The shortcuts the isolated discussion frame passes on to the window (GitHub#322 / #433): go to the
 * reply box, and the three buttons next to "发送". The frame script carries their keys (FRAME_FORWARD,
 * built from this table into its text), and a forwarded key may only end in one of these ids
 * (keyboard.ts, frameKey) — every other key stays inside the frame (PR #171).
 */
export const FRAME_IDS: readonly ShortcutId[] = ['reply', 'closeIssue', 'handBack', 'autopilot', 'blocked', 'tabAt', 'sync'];

/**
 * Which keys may come from the discussion frame (GitHub#487): a key with ⌘ / Ctrl, or the key of 跳到回复框
 * (GitHub#322: a bare R from the discussion). A shortcut changed to a key without ⌘ does not act from there —
 * as the settings page says; the frame is not given the key, and the window refuses it should it come anyway.
 */
export function frameAllowed(id: ShortcutId, spec: KeySpec): boolean {
  return FRAME_IDS.includes(id) && (Boolean(spec.mod) || id === 'reply');
}

/** one forwarded key, as the frame script compares it: a lower-case single key (or a named one), ⌘/Ctrl, Shift, ⌥/Alt */
export type FrameKey = { key: string; mod: boolean; shift: boolean; alt: boolean };

/** the keys of FRAME_IDS in `table`, as the frame script compares them */
export function frameForward(table: readonly Shortcut[] = active): FrameKey[] {
  return FRAME_IDS.flatMap((id) =>
    table
      .find((s) => s.id === id)!
      .keys.filter((k) => frameAllowed(id, k))
      .map((k) => ({ key: k.key, mod: Boolean(k.mod), shift: Boolean(k.shift), alt: Boolean(k.alt) })),
  );
}

/**
 * The default keys of FRAME_IDS: written into the frame script's text (its hash is fixed), used until the window
 * sends the keys in effect on this machine (GitHub#487: `{ cavil: 'keys' }`, see DetailPanel).
 */
export const FRAME_FORWARD: readonly FrameKey[] = frameForward(SHORTCUTS);
