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
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tempDir } from './helpers';
// @ts-expect-error plain .mjs runner without type declarations
import { prepareCopy, checkCopies } from '../tauri/mutations.mjs';

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
});
