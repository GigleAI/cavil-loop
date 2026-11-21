// GitHub#586: the real-window negative controls (test/tauri/mutations.mjs) compile a copy of the app
// made by prepareCopy. When the back end began compiling in src/i18n/en/*.json the copy did not
// carry src/, and all seven entries failed to compile every night without reaching their test.
//
// What guards it now is the compiler itself: `node test/tauri/mutations.mjs --check-copy` (run by
// `npm run test:rust` on every push) makes an unbroken copy of each entry shape with prepareCopy and
// runs `cargo check` on it. Nothing keeps a list of the files the back end reads — three review rounds
// on PR #592 each found a way a hand-written scan of the Rust source disagreed with the compiler.
//
// These cases check that wiring on one-file crates: each compiles in its own tree; the check must
// fail exactly when the copy leaves out a file the crate reads. They keep the examples of all three
// rounds (macro forms, attribute paths, module-relative paths, a path built at build time).

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers';
// @ts-expect-error plain .mjs runner without type declarations
import { prepareCopy, checkCopies, copySources, checkSources } from '../tauri/mutations.mjs';

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const dirs: string[] = [];
const made = () => {
  const d = tempDir();
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = made();
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), t);
  }
  return root;
}

const CARGO = '[package]\nname = "cavil-loop-client"\nversion = "0.0.0"\nedition = "2021"\n\n[workspace]\n';

/** A client/-shaped tree around one crate: src-tauri/ (with target/ and gen/), src/, dist/, scripts/. */
function crate(main: string, files: Record<string, string>, buildRs?: string): string {
  return tree({
    'src-tauri/Cargo.toml': CARGO,
    'src-tauri/src/main.rs': main,
    ...(buildRs ? { 'src-tauri/build.rs': buildRs } : {}),
    'src/index.ts': '',
    'dist/renderer/index.html': '',
    ...files,
  });
}

const cargoCheck = (root: string, targetDir: string) =>
  spawnSync('cargo', ['check', '-q', '-p', 'cavil-loop-client'], { cwd: join(root, 'src-tauri'), env: { ...process.env, CARGO_TARGET_DIR: targetDir }, encoding: 'utf8' });

describe('真实窗口负对照的副本：由编译器判断能不能编（GitHub#586）', () => {
  it('副本的形状：外壳项带 src-tauri（不含 target、gen）、src、dist；界面项另带构建所需', () => {
    const from = tree({
      'src-tauri/Cargo.toml': CARGO,
      'src-tauri/src/main.rs': '',
      'src-tauri/gen/x': '',
      'src-tauri/target/x': '',
      'src/i18n/en/a.json': '{}',
      'dist/renderer/index.html': '',
      'scripts/build.mjs': '',
      'build/icon.png': '',
      'package.json': '{}',
      'tsconfig.json': '{}',
      'node_modules/.keep': '',
      'docs/x.md': '',
    });
    const shell = made();
    prepareCopy(shell, false, from);
    for (const p of ['src-tauri/Cargo.toml', 'src-tauri/src/main.rs', 'src/i18n/en/a.json', 'dist/renderer/index.html']) expect(existsSync(join(shell, p)), p).toBe(true);
    for (const p of ['src-tauri/gen', 'src-tauri/target', 'scripts', 'node_modules', 'docs']) expect(existsSync(join(shell, p)), p).toBe(false);
    const win = made();
    prepareCopy(win, true, from);
    for (const p of ['src/i18n/en/a.json', 'scripts/build.mjs', 'build/icon.png', 'package.json', 'tsconfig.json']) expect(existsSync(join(win, p)), p).toBe(true);
    expect(lstatSync(join(win, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(win, 'dist'))).toBe(false); // the window entry builds its own
  });

  const CASES: { name: string; main: string; files: Record<string, string>; buildRs?: string; missing: boolean }[] = [
    // the nightly failure itself, and its correct counterpart
    { name: '读 src 下的语言表（副本带 src）', main: 'const A: &str = include_str!("../../src/i18n/en/a.json");\nfn main() { let _ = A; }', files: { 'src/i18n/en/a.json': '{}' }, missing: false },
    { name: '读副本不带的顶层目录', main: 'const A: &[u8] = include_bytes!("../../scripts/a.bin");\nfn main() { let _ = A; }', files: { 'scripts/a.bin': 'a' }, missing: true },
    // review round 1: excluded folders, other macro forms
    { name: '读被排除的 gen/（圆括号）', main: 'const A: &str = include_str!("../gen/a.txt");\nfn main() { let _ = A; }', files: { 'src-tauri/gen/a.txt': 'a' }, missing: true },
    { name: '花括号的 include_str 读 gen/', main: 'const A: &str = include_str! {"../gen/a.txt"};\nfn main() { let _ = A; }', files: { 'src-tauri/gen/a.txt': 'a' }, missing: true },
    { name: '方括号的 include_bytes 读 target/', main: 'const A: &[u8] = include_bytes! ["../target/a.bin"];\nfn main() { let _ = A; }', files: { 'src-tauri/target/a.bin': 'a' }, missing: true },
    // review round 2: paths inside attributes
    { name: '条件属性里的 path 指向 gen/', main: '#[cfg_attr(all(), path = "../gen/schema.rs")]\nmod schema;\nfn main() { schema::f(); }', files: { 'src-tauri/gen/schema.rs': 'pub fn f() {}' }, missing: true },
    { name: '两层条件属性', main: '#[cfg_attr(all(), cfg_attr(all(), path = "../gen/schema.rs"))]\nmod schema;\nfn main() { schema::f(); }', files: { 'src-tauri/gen/schema.rs': 'pub fn f() {}' }, missing: true },
    // review round 3: module-relative paths (no false alarm), a path built at build time
    { name: '内联模块里的 path（相对模块目录，副本能编）', main: 'mod outer {\n    #[path = "schema.rs"]\n    pub mod schema;\n}\nfn main() { outer::schema::f(); }', files: { 'src-tauri/src/outer/schema.rs': 'pub fn f() {}' }, missing: false },
    {
      name: '构建脚本给出的目录拼出的路径指向 gen/',
      main: 'const A: &str = include_str!(concat!(env!("GEN_DIR"), "/schema.txt"));\nfn main() { let _ = A; }',
      buildRs: 'fn main() { println!("cargo:rustc-env=GEN_DIR={}/gen", std::env::var("CARGO_MANIFEST_DIR").unwrap()); }',
      files: { 'src-tauri/gen/schema.txt': 'a' },
      missing: true,
    },
  ];

  for (const c of CASES) {
    it(`没改坏的副本能不能编，与它读的文件在不在副本里一致：${c.name}`, () => {
      const from = crate(c.main, c.files, c.buildRs);
      const targetDir = made();
      const own = cargoCheck(from, targetDir);
      if (own.error) throw new Error(`cargo 跑不起来：${own.error.message}`);
      expect(own.status, own.stderr).toBe(0); // the crate itself compiles in its own tree
      const problems: string[] = checkCopies({ from, shapes: [false], targetDir });
      expect(problems.length > 0, problems.join('\n')).toBe(c.missing);
      if (c.missing) expect(problems[0]).toContain('没改坏的副本编译不过');
    });
  }

  // Review round 4 on PR #592: the nightly path lost the folder it builds into and runs the app from.
  // Run the real `--one 4` (a shell entry: 关窗不拦) of a copy of the runner in a sandbox client tree (the real back-end sources),
  // with stand-ins for cargo and Playwright that record what they were given.
  // GitHub#631: the same sandbox also runs `--check-copy` (the window shape's build script is a stand-in that does
  // nothing), and `edit` changes the sandbox's sources first.
  const runCli = (args: string[], { override, edit }: { override?: string; edit?: (r: string) => void } = {}) => {
    const r = made();
    copySources(r, clientRoot);
    mkdirSync(join(r, 'dist', 'renderer'), { recursive: true });
    mkdirSync(join(r, 'scripts'), { recursive: true });
    mkdirSync(join(r, 'build'), { recursive: true });
    writeFileSync(join(r, 'scripts', 'build.mjs'), '');
    writeFileSync(join(r, 'package.json'), '{}');
    writeFileSync(join(r, 'tsconfig.json'), '{}');
    edit?.(r);
    for (const f of ['test/tauri/mutations.mjs', 'test/mutation/select.mjs']) {
      mkdirSync(dirname(join(r, f)), { recursive: true });
      cpSync(join(clientRoot, f), join(r, f));
    }
    const rec = made();
    const bin = made();
    writeFileSync(
      join(bin, 'cargo'),
      '#!/bin/sh\nprintf \'%s\\n\' "$CARGO_TARGET_DIR" "$*" "$(grep -cF \'if false && d.hide_on_close() {\' src/main.rs)" > "$REC/cargo.txt"\nexit 0\n',
    );
    chmodSync(join(bin, 'cargo'), 0o755);
    mkdirSync(join(r, 'node_modules', '@playwright', 'test'), { recursive: true });
    writeFileSync(join(r, 'node_modules', '@playwright', 'test', 'cli.js'), "require('fs').writeFileSync(process.env.REC + '/app.txt', String(process.env.CAVIL_TAURI_APP)); process.exit(1);\n");
    const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH}`, REC: rec };
    delete env.CAVIL_TAURI_MUT_TARGET;
    if (override) env.CAVIL_TAURI_MUT_TARGET = override;
    const run = spawnSync(process.execPath, [join(r, 'test', 'tauri', 'mutations.mjs'), ...args], { cwd: r, env, encoding: 'utf8' });
    const read = (f: string) => (existsSync(join(rec, f)) ? readFileSync(join(rec, f), 'utf8') : '');
    return { r, run, cargo: read('cargo.txt').split('\n'), cargoRan: existsSync(join(rec, 'cargo.txt')), app: read('app.txt') };
  };
  const nightly = (override?: string) => runCli(['--one', '4'], { override });

  it('每晚的执行路径：没设覆盖时，编译输出目录和被测程序位置都是默认的那一个', () => {
    const { r, run, cargo, app } = nightly();
    const want = join(r, 'src-tauri', 'target', 'tauri-mutation');
    expect(run.stderr).not.toMatch(/ReferenceError|TypeError/);
    // it really got past preparing and breaking the copy: cargo ran inside it, on the broken main.rs
    // (the marker is that entry's edit, absent from the real main.rs)
    expect(readFileSync(join(clientRoot, 'src-tauri', 'src', 'main.rs'), 'utf8')).not.toContain('if false && d.hide_on_close() {');
    expect(cargo[1]).toBe('build -q -p cavil-loop-client');
    expect(cargo[2]).toBe('1');
    expect(cargo[0]).toBe(want);
    expect(app).toBe(join(want, 'debug', 'cavil-loop-client'));
    // the stand-in test run exits 1 without the expected step: reported as such, the entry fails
    expect(run.stdout).toContain('红了，但不是在预期那一步');
    expect(run.status).toBe(1);
  });

  it('每晚的执行路径：设了覆盖时，两处都用覆盖的那一个', () => {
    const custom = join(made(), 'mut-target');
    const { cargo, app, run } = nightly(custom);
    expect(run.stderr).not.toMatch(/ReferenceError|TypeError/);
    expect(cargo[0]).toBe(custom);
    expect(app).toBe(join(custom, 'debug', 'cavil-loop-client'));
  });

  // GitHub#631: each entry's text must occur exactly once in its file — 0 = the code moved on and the entry did not
  // follow (it only failed to prepare, at night), 2 = which spot it breaks depends on the order
  it('每条要改的原文在目标文件里恰好出现一次：0 次、2 次、读不到都报出来，1 次不报', () => {
    const from = tree({
      'src-tauri/src/main.rs': 'fn a() {}\nfn b() {}\nfn b() {}\n',
      'src/renderer/x.tsx': "else if (m.cavil === 'link') go();\n",
    });
    const m = (what: string, file: string | undefined, text: string) => ({ what, file, from: text, to: '', expect: '' });
    const problems: string[] = checkSources({
      from,
      mutations: [
        m('一次（外壳，默认文件）', undefined, 'fn a() {}'),
        m('一次（界面）', 'src/renderer/x.tsx', "else if (m.cavil === 'link') go();\n"),
        m('零次', undefined, 'fn c() {}'),
        m('两次', undefined, 'fn b() {}'),
        m('文件不在', 'src/renderer/gone.tsx', 'x'),
      ],
    });
    expect(problems).toHaveLength(3);
    expect(problems[0]).toBe('要改的原文在 src-tauri/src/main.rs 里出现 0 次（应为 1 次）：零次');
    expect(problems[1]).toBe('要改的原文在 src-tauri/src/main.rs 里出现 2 次（应为 1 次）：两次');
    expect(problems[2]).toMatch(/^读不到 src\/renderer\/gone\.tsx（.*）：文件不在$/);
  });

  it('仓库里现有的每条真实窗口负对照，原文都在目标文件里恰好出现一次', () => {
    expect(checkSources()).toEqual([]);
  });

  // GitHub#631 review round 1: the real command line, as `npm run test:rust` runs it
  const LINK = "      else if (m.cavil === 'link') openFrameLink(m.url, 'frame');\n";
  const PANEL = 'src/renderer/DetailPanel.tsx';
  const twice = (r: string) => {
    const f = join(r, PANEL);
    const t = readFileSync(f, 'utf8');
    expect(t.split(LINK)).toHaveLength(2); // the real file holds it once
    writeFileSync(f, t.replace(LINK, LINK + LINK));
  };

  it('--check-copy 命令：原文都恰好一次时退出 0，并且确实走到了副本编译', () => {
    const { run, cargoRan } = runCli(['--check-copy']);
    expect(run.stdout).toContain('7 个真实窗口负对照要改的原文，各自在目标文件里恰好出现一次');
    expect(run.stdout).toContain('真实窗口负对照的副本（没改坏）能编译');
    expect(cargoRan).toBe(true);
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });

  const BAD: { name: string; edit: (r: string) => void; says: RegExp }[] = [
    { name: '重复', edit: twice, says: /要改的原文在 src\/renderer\/DetailPanel\.tsx 里出现 2 次（应为 1 次）/ },
    {
      name: '缺失',
      edit: (r) => {
        const f = join(r, PANEL);
        writeFileSync(f, readFileSync(f, 'utf8').replace(LINK, ''));
      },
      says: /要改的原文在 src\/renderer\/DetailPanel\.tsx 里出现 0 次（应为 1 次）/,
    },
    { name: '读不到', edit: (r) => rmSync(join(r, PANEL)), says: /读不到 src\/renderer\/DetailPanel\.tsx（/ },
  ];
  for (const c of BAD) {
    it(`--check-copy 命令：原文${c.name}时退出非零（副本照样编译通过也一样）`, () => {
      const { run, cargoRan } = runCli(['--check-copy'], { edit: c.edit });
      expect(run.stdout).toMatch(c.says);
      expect(cargoRan).toBe(true); // the copies were still checked, and passed
      expect(run.stdout).toContain('真实窗口负对照的副本（没改坏）能编译');
      expect(run.status).toBe(1);
    });
  }

  it('每晚的执行路径：原文出现两次时在准备时就失败，不改、不编译、不跑测试', () => {
    const { run, cargoRan, app } = runCli(['--one', '0'], { edit: twice });
    expect(run.stdout).toContain('准备失败（要改的原文在 src/renderer/DetailPanel.tsx 里出现 2 次（应为 1 次）');
    expect(cargoRan).toBe(false);
    expect(app).toBe('');
    expect(run.status).toBe(1);
  });

  it('每晚的执行路径：原文恰好一次时照常改坏、构建、跑测试（界面代码的条目）', () => {
    const { run, cargoRan, app } = runCli(['--one', '0']);
    expect(run.stderr).not.toMatch(/ReferenceError|TypeError/);
    expect(cargoRan).toBe(true);
    expect(app).not.toBe('');
    expect(run.stdout).toContain('红了，但不是在预期那一步');
  });
});
