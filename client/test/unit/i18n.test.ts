// GitHub#466 / #471: Chinese / English. Three things here:
//   1. the rules of t() (placeholders, singular / plural, a missing line, the language setting);
//      the shared cases also run through the back end (crates/core/src/i18n.rs) and must agree
//   2. the source scan: the client's own Chinese goes through t() / tr(), outside the files still
//      on the "not migrated yet" list (test/i18n/untranslated.txt)
//   3. the tables: every key used has its English, no line is unused, placeholders agree
// The run-time half (what the window really shows in English) is test/e2e/i18n.spec.ts.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EN_TABLES, KEEP_LANG, VERBATIM_SOURCES, normalizeLangSetting, placeholders, resolveLang, setLang, systemLang, translate, type Lang } from '../../src/shared/i18n';
import { CJK, scan } from '../i18n/scan';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEEP = KEEP_LANG.map((k) => k.text);

describe('t(): the rules', () => {
  const cases: { lang: Lang; key: string; params: Record<string, string>; expect: string }[] = JSON.parse(readFileSync(join(root, 'test/fixtures/i18n-cases.json'), 'utf8'));

  it('gives the shared cases the text the back end gives them (the Rust side runs the same file)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(8);
    for (const c of cases) expect(translate(c.lang, c.key, c.params), JSON.stringify(c)).toBe(c.expect);
  });

  it('numbers as numbers: 1 is singular, anything else plural; Chinese has no plural', () => {
    expect(translate('en', '{n} 个条目', { n: 1 })).toBe('1 item');
    expect(translate('en', '{n} 个条目', { n: 26 })).toBe('26 items');
    expect(translate('en', '{n} 个条目', { n: 0 })).toBe('0 items');
    expect(translate('zh', '{n} 个条目', { n: 1 })).toBe('1 个条目');
  });

  it('a line missing from the English shows the Chinese, never an empty string', () => {
    expect(translate('en', '没有这一句', {})).toBe('没有这一句');
  });

  it('the setting: only zh / en / auto; anything else (nothing set, an old or a broken value) is Chinese', () => {
    for (const v of ['zh', 'en', 'auto'] as const) expect(normalizeLangSetting(v)).toBe(v);
    for (const v of [undefined, null, '', 'EN', 'fr', 1, {}, ['en']]) expect(normalizeLangSetting(v)).toBe('zh');
    expect(resolveLang(undefined, ['en-US'])).toBe('zh');
    expect(resolveLang('fr', ['en-US'])).toBe('zh');
  });

  it('follow the system: the first preferred language decides; any zh… is Chinese, the rest English, nothing readable is Chinese', () => {
    expect(systemLang(['zh-CN'])).toBe('zh');
    expect(systemLang(['zh-TW', 'en-US'])).toBe('zh');
    expect(systemLang(['zh-Hant-HK'])).toBe('zh');
    expect(systemLang(['ZH'])).toBe('zh');
    expect(systemLang(['en-US', 'zh-CN'])).toBe('en');
    expect(systemLang(['ja-JP'])).toBe('en');
    expect(systemLang([])).toBe('zh');
    expect(systemLang(undefined)).toBe('zh');
    expect(systemLang(['', ' '])).toBe('zh');
    expect(resolveLang('auto', ['ja-JP'])).toBe('en');
    expect(resolveLang('auto', ['zh-TW'])).toBe('zh');
    expect(resolveLang('en', ['zh-CN'])).toBe('en');
    expect(resolveLang('zh', ['en-US'])).toBe('zh');
  });
});

describe('the system notification follows the language; its GitHub parts stay as they are', () => {
  it('Chinese by default, English once set', async () => {
    const { itemAlertText } = await import('../../src/data/pending');
    const it1 = { repo: 'GigleAI/cavil-loop', number: 7, kind: 'issue' as const, title: '客户端支持英文' };
    expect(itemAlertText(it1)).toEqual({ title: '待处理：GigleAI/cavil-loop#7', body: 'issue · 客户端支持英文' });
    setLang('en');
    try {
      expect(itemAlertText(it1)).toEqual({ title: 'Pending: GigleAI/cavil-loop#7', body: 'issue · 客户端支持英文' });
    } finally {
      setLang('zh');
    }
  });
});

describe('the source scan itself', () => {
  const ts = (src: string) => scan(src, 'ts', KEEP);
  it('reports Chinese in strings, templates, JSX text and attributes', () => {
    expect(ts(`const a = '你好';`).findings).toHaveLength(1);
    expect(ts(`const a = "你好";`).findings).toHaveLength(1);
    expect(ts('const a = `共 ${n} 个`;').findings).toHaveLength(1);
    expect(ts('const a = `${x ? `前 ${done} 项` : ""}`;').findings).toHaveLength(1);
    expect(ts(`const x = <b>返回看板</b>;`).findings).toHaveLength(1);
    expect(ts(`const x = <input placeholder="搜索" />;`).findings).toHaveLength(1);
    expect(ts(`const x = <b title={'设置'}>x</b>;`).findings).toHaveLength(1);
    expect(ts(`const x = s.t('设置');`).findings).toHaveLength(1);
    expect(ts(`const x = at('设置');`).findings).toHaveLength(1);
  });
  it('lets through t( / tNode( literals, comments and the kept words', () => {
    const r = ts(`// 注释\n/* 注释 */\nconst a = t('刷新');\nconst b = t(\n  '同步中…（{n}）',\n  { n });\nconst c = <b>{t("设置")}</b>;\nconst d = tNode('已登录：{v}', { v: 1 });\nconst e = <KeepLang text="简体中文" />;\nconst f = \`\${t('分钟')}\`;\nconst g = 'https://x//y'; const h = '你好';`);
    expect(r.findings.map((f) => f.line)).toEqual([11]);
    expect([...r.keys.keys()].sort()).toEqual(['分钟', '刷新', '同步中…（{n}）', '已登录：{v}', '设置'].sort());
  });
  it('GitHub#472: outsideWords( literals (the daemon\'s words, words written to GitHub) are neither findings nor keys; only its first literal, and only a plain one', () => {
    const r = ts(`const a = outsideWords('耗时：');\nconst b = outsideWords('在等 {list}').replace('{list}', '、');\nconst c = x.outsideWords('你好');`);
    expect(r.findings.map((f) => f.line)).toEqual([2, 3]);
    expect([...r.keys.keys()]).toEqual([]);
    expect(ts('const a = outsideWords(`在等 ${x}`);').badCalls).toHaveLength(1);
    // the marker never stands in for t(): the same literal in a t( is still a key needing English
    expect([...ts(`const a = t('耗时：');`).keys.keys()]).toEqual(['耗时：']);
  });
  it('a key that is not a plain literal is reported', () => {
    expect(ts('const a = t(`共 ${n} 个`);').badCalls).toHaveLength(1);
    expect(ts('const a = t(name);').badCalls).toHaveLength(1);
    expect(ts('function t(zh: string) { return zh; }').badCalls).toHaveLength(0);
  });
  it('Rust: strings, raw strings and char literals; tr( literals and #[cfg(test)] modules are not', () => {
    const r = scan(
      `fn a() -> String { tr("放大", &[]) }\nfn b() { let x = "缩小"; let y = r#"实际"#; let c = '缩'; let l: &'static str = "a"; }\n#[cfg(test)]\nmod tests { fn t() { assert_eq!(x, "测试"); } }\nfn c() { let z = "关闭"; }`,
      'rust',
      KEEP,
    );
    expect(r.findings.map((f) => f.line)).toEqual([2, 5]);
    expect([...r.keys.keys()]).toEqual(['放大']);
    const said = scan(`fn s() -> Said { Said::compose("{a}；{b}", &[]); Said::new("没能保存（{e}）", &[("e", x)], "system") }\nfn n() { let v = Vec::new("中文"); }`, 'rust', KEEP);
    expect([...said.keys.keys()].sort()).toEqual(['没能保存（{e}）', '{a}；{b}'].sort());
    expect(said.findings.map((f) => f.line)).toEqual([2]);
  });
});

// ── the whole client ──

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const sources = [
  ...walk(join(root, 'src')).filter((f) => /\.(ts|tsx)$/.test(f)),
  ...walk(join(root, 'src-tauri', 'src')).filter((f) => f.endsWith('.rs')),
  ...walk(join(root, 'src-tauri', 'crates', 'core', 'src')).filter((f) => f.endsWith('.rs')),
]
  .map((f) => relative(root, f))
  .sort();
const results = new Map(sources.map((f) => [f, scan(readFileSync(join(root, f), 'utf8'), f.endsWith('.rs') ? 'rust' : 'ts', KEEP)]));
const listed = readFileSync(join(root, 'test/i18n/untranslated.txt'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

describe('the source scan over the client', () => {
  it('scans the files it should (the window and both Rust crates of the app)', () => {
    expect(sources).toContain('src/renderer/SettingsView.tsx');
    expect(sources).toContain('src-tauri/src/main.rs');
    expect(sources).toContain('src-tauri/crates/core/src/api.rs');
    expect(sources.length).toBeGreaterThan(120);
  });

  it('outside the "not migrated yet" list, all Chinese goes through t() / tr()', () => {
    const bad = sources.filter((f) => !listed.includes(f)).flatMap((f) => results.get(f)!.findings.map((x) => `${f}:${x.line} ${x.text}`));
    expect(bad).toEqual([]);
  });

  it('every t( / tr( names a plain literal key (the checks can only follow literals)', () => {
    const bad = sources.flatMap((f) => results.get(f)!.badCalls.map((x) => `${f}:${x.line} ${x.text}`));
    expect(bad).toEqual([]);
  });

  it('GitHub#473: Chinese marked as never shown (not_text) is only the release page marks the updater matches', () => {
    // (the window's own marker, outsideWords, is listed in the same place; this pins the back end's)
    const marks = sources.filter((f) => f.endsWith('.rs')).flatMap((f) => results.get(f)!.notText.map((x) => `${f} ${x.text}`)).sort();
    expect(marks).toEqual(
      ['### 更新内容', '### 这一版', '（', '）', '：', '开发版 '].map((m) => `src-tauri/crates/core/src/update.rs ${m}`).sort(),
    );
    // the scan reads them as marks, not as keys and not as findings
    const r = scan('const H: &str = not_text("### 更新内容"); fn x() { y(not_text(z)); }', 'rust', KEEP);
    expect(r.notText.map((x) => x.text)).toEqual(['### 更新内容']);
    expect(r.findings).toEqual([]);
    expect([...r.keys.keys()]).toEqual([]);
    expect(r.badCalls).toHaveLength(1);
  });

  it("GitHub#473: the local / remote daemon, update and sign-in renewal areas are migrated (they are not on the list)", () => {
    for (const f of [
      'src/renderer/DaemonSection.tsx',
      'src/renderer/ConnectDialog.tsx',
      'src/renderer/ProjectConfigDialog.tsx',
      'src/shared/daemon.ts',
      'src-tauri/crates/core/src/daemon.rs',
      'src-tauri/crates/core/src/daemon_config.rs',
      'src-tauri/crates/core/src/daemon_connect.rs',
      'src/renderer/RemoteSection.tsx',
      'src/renderer/RemoteHostBlock.tsx',
      'src/shared/remote.ts',
      'src-tauri/crates/core/src/remote.rs',
      'src-tauri/crates/core/src/remote_host.rs',
      'src/renderer/UpdateViews.tsx',
      'src-tauri/crates/core/src/update.rs',
      'src-tauri/src/updater.rs',
      'src-tauri/crates/core/src/release_image.rs',
      'src-tauri/crates/core/src/engine.rs',
      'src-tauri/crates/core/src/api.rs',
      'src-tauri/crates/core/src/http.rs',
      'src-tauri/crates/core/src/store.rs',
      'src-tauri/crates/core/src/platform.rs',
    ])
      expect(listed, f).not.toContain(f);
  });

  it('the list names only existing files, each once, each still holding Chinese to migrate', () => {
    expect(new Set(listed).size).toBe(listed.length);
    for (const f of listed) {
      expect(existsSync(join(root, f)), `${f} is listed but does not exist`).toBe(true);
      expect(results.get(f), `${f} is listed but not scanned`).toBeDefined();
      expect(results.get(f)!.findings.length, `${f} has nothing left to migrate: remove its line from test/i18n/untranslated.txt`).toBeGreaterThan(0);
    }
  });

  it("this sub-issue's areas are migrated (they are not on the list)", () => {
    for (const f of [
      'src/renderer/SettingsView.tsx',
      'src/renderer/LoginView.tsx',
      'src/renderer/AppKindPicker.tsx',
      'src/renderer/AppKindHelp.tsx',
      'src/shared/appKind.ts',
      'src/renderer/syncTimes.ts',
      'src/renderer/App.tsx',
      'src/data/pending.ts',
      'src/data/flowTally.ts',
      'src-tauri/src/main.rs',
      'src-tauri/src/mac.rs',
      'src-tauri/src/desktop.rs',
    ])
      expect(listed, f).not.toContain(f);
  });

  it("sub-issue ②'s areas (#472: board, table, dependency view, detail, tabs, new issue, dialogs, notices, shortcuts) are migrated", () => {
    for (const f of [
      'src/data/actions.ts',
      'src/data/autoJoin.ts',
      'src/data/blocked.ts',
      'src/data/board.ts',
      'src/data/changeCheck.ts',
      'src/data/detail.ts',
      'src/data/edits.ts',
      'src/data/fetchSources.ts',
      'src/data/github.ts',
      'src/data/groupPreset.ts',
      'src/data/itemRefresh.ts',
      'src/data/loopBlocked.ts',
      'src/data/newIssueFields.ts',
      'src/data/projectChoices.ts',
      'src/data/relations.ts',
      'src/data/table.ts',
      'src/data/taskList.ts',
      'src/renderer/BlockedDialog.tsx',
      'src/renderer/BoardView.tsx',
      'src/renderer/ConfirmDialog.tsx',
      'src/renderer/DetailPanel.tsx',
      'src/renderer/EmptyGuide.tsx',
      'src/renderer/FailureNote.tsx',
      'src/renderer/FindBar.tsx',
      'src/renderer/GraphView.tsx',
      'src/renderer/KindBadge.tsx',
      'src/renderer/LabelPicker.tsx',
      'src/renderer/NewIssueDialog.tsx',
      'src/renderer/NoticeArea.tsx',
      'src/renderer/OpNotice.tsx',
      'src/renderer/OpenMenu.tsx',
      'src/renderer/ProjectPicker.tsx',
      'src/renderer/RepoWebLink.tsx',
      'src/renderer/SendNotice.tsx',
      'src/renderer/ShortcutHelp.tsx',
      'src/renderer/ShortcutSettings.tsx',
      'src/renderer/TabBar.tsx',
      'src/renderer/TableView.tsx',
      'src/renderer/ViewSettingsPanel.tsx',
      'src/renderer/codeBlocks.ts',
      'src/renderer/detailHtml.ts',
      'src/renderer/frameScript.ts',
      'src/renderer/iterationOptions.tsx',
      'src/renderer/pasteImage.ts',
      'src/renderer/prStatus.ts',
      'src/renderer/reread.ts',
      'src/renderer/shortcuts.ts',
      'src/shared/agentMetrics.ts',
      'src/shared/blocked.ts',
      'src/shared/handoff.ts',
      'src/shared/images.ts',
      'src/shared/noticeTone.ts',
      'src/shared/ops.ts',
      'src/shared/readFailure.ts',
      'src/shared/sends.ts',
      'src/shared/stateTone.ts',
      'src/shared/tabs.ts',
      'src/shared/viewImport.ts',
    ])
      expect(listed, f).not.toContain(f);
  });
});

describe('the English tables', () => {
  const used = new Map<string, string[]>();
  for (const [f, r] of results) for (const k of r.keys.keys()) used.set(k, [...(used.get(k) ?? []), f]);
  const all = new Map<string, { table: string; en: unknown }[]>();
  for (const [table, entries] of Object.entries(EN_TABLES)) for (const [k, en] of Object.entries(entries)) all.set(k, [...(all.get(k) ?? []), { table, en }]);

  it('every table the window imports is the one the back end compiles in (same files, same order)', () => {
    const rs = readFileSync(join(root, 'src-tauri/crates/core/src/i18n.rs'), 'utf8');
    const inRust = [...rs.matchAll(/\("(\w+)", include_str!\("\.\.\/\.\.\/\.\.\/\.\.\/src\/i18n\/en\/(\w+)\.json"\)\)/g)].map((m) => [m[1], m[2]]);
    expect(inRust.map(([a]) => a)).toEqual(Object.keys(EN_TABLES));
    for (const [a, b] of inRust) expect(a).toBe(b);
    expect(readdirSync(join(root, 'src/i18n/en')).sort()).toEqual(Object.keys(EN_TABLES).map((k) => `${k}.json`).sort());
  });

  it('every key used has its English', () => {
    expect([...used.keys()].filter((k) => !all.has(k))).toEqual([]);
  });

  it('no line is unused, and none is in two tables', () => {
    expect([...all.keys()].filter((k) => !used.has(k))).toEqual([]);
    expect([...all].filter(([, v]) => v.length > 1).map(([k, v]) => `${k}: ${v.map((x) => x.table).join(', ')}`)).toEqual([]);
  });

  it('each English form names the same placeholders as its Chinese; a plural is decided by {n}', () => {
    const bad: string[] = [];
    for (const [k, [{ en }]] of all) {
      const forms = typeof en === 'string' ? [en] : [(en as any).one, (en as any).other];
      for (const form of forms) if (JSON.stringify(placeholders(form)) !== JSON.stringify(placeholders(k))) bad.push(`${k} → ${form}`);
      if (typeof en !== 'string' && !placeholders(k).includes('n')) bad.push(`${k}: a plural needs {n}`);
    }
    expect(bad).toEqual([]);
  });

  it('the English is English: no Chinese in it', () => {
    expect([...all].filter(([, [{ en }]]) => CJK.test(JSON.stringify(en))).map(([k]) => k)).toEqual([]);
  });

  it('the kept words and the sources of outside text are the fixed lists of the plan', () => {
    expect(KEEP_LANG).toEqual([
      { text: '语言', lang: 'zh' },
      { text: '简体中文', lang: 'zh' },
      { text: 'Language', lang: 'en' },
      { text: 'English', lang: 'en' },
    ]);
    expect([...VERBATIM_SOURCES]).toEqual(['github', 'daemon', 'remote', 'system', 'user']);
  });
});
