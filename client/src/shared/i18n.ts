// Chinese / English for the client's own words (GitHub#466 / #471).
//
// The Chinese text is the key: `t('已合并 {n} 个', { n })`. The English is looked up in the
// tables under src/i18n/en/ — one table per area of the window, so the parts migrated in
// parallel do not edit the same file. The back end (Rust, crates/core/src/i18n.rs) compiles the
// very same JSON files in and fills them by the same rules; test/fixtures/i18n-cases.json is run
// through both and must give the same text.
//
// Three kinds of text in the window:
//   ① the client's own words           → through t(); English must exist
//   ② words kept in their own language → KEEP_LANG below (the language section names itself)
//   ③ text from outside, shown as is   → only through <Verbatim> (src/renderer/Verbatim.tsx),
//                                        whose source must be one of VERBATIM_SOURCES
//
// The checks (test/unit/i18n-*.test.ts, test/e2e/i18n.spec.ts) read these same lists.

import shell from '../i18n/en/shell.json' with { type: 'json' };
import board from '../i18n/en/board.json' with { type: 'json' };
import daemon from '../i18n/en/daemon.json' with { type: 'json' };
import remote from '../i18n/en/remote.json' with { type: 'json' };
import update from '../i18n/en/update.json' with { type: 'json' };
import session from '../i18n/en/session.json' with { type: 'json' };

export type Lang = 'zh' | 'en';
/** what the user picked in Settings; 'auto' = follow the system */
export type LangSetting = 'zh' | 'en' | 'auto';
/** an English entry: one text, or two when a number `{n}` decides (1 → one, anything else → other) */
export type EnText = string | { one: string; other: string };

/** the settings key, kept on this machine only */
export const LANG_SETTING = 'uiLanguage';
/** nothing set, or a value this version does not know: Chinese, as before the language setting existed */
export const DEFAULT_LANG_SETTING: LangSetting = 'zh';

/** the English tables by area (file name without .json); the checks read them one by one */
export const EN_TABLES: Readonly<Record<string, Readonly<Record<string, EnText>>>> = { shell, board, daemon, remote, update, session } as Record<string, Record<string, EnText>>;

/** the tables as one, as the window and the back end look them up */
function mergeTables(): Map<string, EnText> {
  const m = new Map<string, EnText>();
  for (const table of Object.values(EN_TABLES)) for (const [k, v] of Object.entries(table)) if (!m.has(k)) m.set(k, v);
  return m;
}
const EN = mergeTables();

/**
 * Words that stay in their own language whatever the window shows: the language section names
 * itself in both languages, so someone who cannot read the current one still finds the way back.
 * Each must be rendered with `data-keep-lang` and the matching `lang` attribute; the run-time check
 * lets exactly these texts through, nothing else.
 */
export const KEEP_LANG: readonly { text: string; lang: Lang }[] = [
  { text: '语言', lang: 'zh' },
  { text: '简体中文', lang: 'zh' },
  { text: 'Language', lang: 'en' },
  { text: 'English', lang: 'en' },
];

/**
 * Where text shown as is may come from (the closed list of GitHub#466's plan). Fixed words must
 * never be put inside a <Verbatim>: only the outside text itself.
 */
export const VERBATIM_SOURCES = ['github', 'daemon', 'remote', 'system', 'user'] as const;
export type VerbatimSource = (typeof VERBATIM_SOURCES)[number];

let current: Lang = 'zh';

export function getLang(): Lang {
  return current;
}

/** set the language t() answers in (the window re-renders through its state, see Controller.setUiLanguage) */
export function setLang(lang: Lang): void {
  current = lang;
}

/**
 * GitHub#473: how many times the back end has taken a new language (it words its own messages in
 * the language it last got). Parts of the window that hold a status the back end worded — the
 * local / remote daemon sections — read it again when this changes, so a status read before the
 * switch does not stay in the old language.
 */
let backendRound = 0;
const backendListeners = new Set<() => void>();

export function backendLangRound(): number {
  return backendRound;
}

/** the back end has answered `setLanguage` */
export function noteBackendLang(): void {
  backendRound++;
  for (const f of [...backendListeners]) f();
}

export function onBackendLang(f: () => void): () => void {
  backendListeners.add(f);
  return () => backendListeners.delete(f);
}

/** a stored setting as this version reads it: anything it does not know is Chinese */
export function normalizeLangSetting(raw: unknown): LangSetting {
  return raw === 'zh' || raw === 'en' || raw === 'auto' ? raw : DEFAULT_LANG_SETTING;
}

/** "follow the system": the first preferred language; any `zh…` is Chinese, everything else English; nothing readable = Chinese */
export function systemLang(preferred: readonly string[] | null | undefined): Lang {
  const first = (preferred ?? []).find((x) => typeof x === 'string' && x.trim() !== '');
  if (first === undefined) return 'zh';
  return first.trim().toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** the language the window shows for a setting and the system's preferred languages */
export function resolveLang(setting: unknown, preferred: readonly string[] | null | undefined): Lang {
  const s = normalizeLangSetting(setting);
  return s === 'auto' ? systemLang(preferred) : s;
}

/** the system's preferred languages as the window sees them */
export function preferredLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  const list = navigator.languages && navigator.languages.length ? navigator.languages : navigator.language ? [navigator.language] : [];
  return list;
}

export type Params = Readonly<Record<string, string | number>>;

/**
 * GitHub#471 (PR #480 review round 2): a message the back end words with holes for outside text
 * (crates/core/src/i18n.rs `Said`): `template` is already in the window's language, each part fills
 * its `{name}` hole and is shown as written, marked as coming from `from`.
 */
export interface Said {
  template: string;
  parts: { name: string; text: string; from: VerbatimSource }[];
}

/** a Said as one string (what it reads like with every hole filled) */
export function saidText(s: Said): string {
  return s.template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, name: string) => s.parts.find((p) => p.name === name)?.text ?? all);
}

/** a value from the back end that should be a Said: anything malformed is not one (null) */
export function readSaid(v: unknown): Said | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { template?: unknown; parts?: unknown };
  if (typeof o.template !== 'string' || !Array.isArray(o.parts)) return null;
  const parts: Said['parts'] = [];
  for (const p of o.parts) {
    const x = p as { name?: unknown; text?: unknown; from?: unknown };
    if (typeof x?.name !== 'string' || typeof x.text !== 'string' || !(VERBATIM_SOURCES as readonly unknown[]).includes(x.from)) return null;
    parts.push({ name: x.name, text: x.text, from: x.from as VerbatimSource });
  }
  return { template: o.template, parts };
}

/** `{name}` → the value; a placeholder with no value stays as written */
function fill(text: string, params: Params | undefined): string {
  if (!params) return text;
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, name: string) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : all));
}

/** the English entry for a key, or undefined (the window then shows the Chinese) */
export function enEntry(zh: string): EnText | undefined {
  return EN.get(zh);
}

/** the pure rule t() applies, for one language (the back end applies the same) */
export function translate(lang: Lang, zh: string, params?: Params): string {
  if (lang === 'zh') return fill(zh, params);
  const en = EN.get(zh);
  // a missing English line shows the Chinese rather than nothing; the table check catches it
  if (en === undefined) return fill(zh, params);
  if (typeof en === 'string') return fill(en, params);
  const n = params?.n;
  return fill(Number(n) === 1 ? en.one : en.other, params);
}

/**
 * A Chinese key kept as data rather than shown at once — a default that is saved as the user's own
 * value once they edit it (the default view-bar names). The checks treat it as a key (it needs its
 * English); `tKey` shows it in the window's language.
 */
export function zhKey<T extends string>(zh: T): T {
  return zh;
}

/** a key marked with zhKey, in the window's language (anything else: as written) */
export function tKey(zh: string): string {
  return EN.has(zh) ? translate(current, zh) : zh;
}

/** the client's own words, in the language the window shows */
export function t(zh: string, params?: Params): string {
  return translate(current, zh, params);
}

/** the placeholders a text names, sorted and unique (the table check compares them) */
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]))].sort();
}
