// The real-window negative controls (test/tauri/mutations.mjs) compile a copy of the app built by
// `copySources` (src-tauri/ without target/ and gen/, plus COPY_ALWAYS) and then dist/ or the
// window's own build inputs. GitHub#586: the back end began compiling in src/i18n/en/*.json, the
// copy did not carry src/, and all seven entries failed to compile — every night, without one of
// them reaching its test.
//
// This test runs the real `copySources` into a temporary directory, scans every Rust file of the
// copy for compile-time file reads and requires each read of product code to resolve to a file
// that is there in the copy. A new read of a folder the copy does not carry goes red on the next
// push instead of in the nightly run.
//
// What counts as a read: `include_str!`, `include_bytes!`, `include!` (also with a `std::` /
// `core::` path, whitespace or comments around `!`, and `(…)`, `[…]` or `{…}` delimiters) and
// `#[path = "…"]` on a module. Text inside comments and string / char literals is not code. Reads
// inside `#[cfg(test)] mod … { }` are left out: `cargo build` never compiles them. Anything the
// scan cannot resolve to one file — an argument that is not a plain string literal (`concat!`,
// a macro variable; `env!("OUT_DIR")` is build output and allowed), a string with escapes, one of
// these macros imported under another name — is reported as a problem, never skipped.
// Not covered: files read by build scripts (build.rs) or procedural macros (tauri's
// generate_context! reads tauri.conf.json and dist/, which every entry provides on its own); a
// plain build of the copy (PR #592) is the check for those.

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers';
// @ts-expect-error plain .mjs runner without type declarations
import { copySources } from '../tauri/mutations.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function rustFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...rustFiles(p));
    else if (e.name.endsWith('.rs')) out.push(p);
  }
  return out;
}

/**
 * The source with comments blanked to spaces and the inside of string / char literals blanked to
 * `_` (quotes, prefixes and newlines kept), same length: offsets map back onto the original.
 */
function mask(s: string): string {
  const o = s.split('');
  const blank = (a: number, b: number, ch: string) => {
    for (let k = a; k < b && k < o.length; k++) if (o[k] !== '\n') o[k] = ch;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const prevWord = i > 0 && /[A-Za-z0-9_]/.test(s[i - 1]);
    if (c === '/' && s[i + 1] === '/') {
      const nl = s.indexOf('\n', i);
      const end = nl < 0 ? s.length : nl;
      blank(i, end, ' ');
      i = end;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const start = i;
      let d = 1;
      i += 2;
      while (i < s.length && d > 0) {
        if (s[i] === '/' && s[i + 1] === '*') (d++, (i += 2));
        else if (s[i] === '*' && s[i + 1] === '/') (d--, (i += 2));
        else i++;
      }
      blank(start, i, ' ');
      continue;
    }
    const raw = prevWord ? null : /^(?:b|c)?r(#*)"/.exec(s.slice(i, i + 300));
    if (raw) {
      const close = `"${raw[1]}`;
      const from = i + raw[0].length;
      const end = s.indexOf(close, from);
      const stop = end < 0 ? s.length : end;
      blank(from, stop, '_');
      i = stop + close.length;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      blank(i + 1, j, '_');
      i = j + 1;
      continue;
    }
    if (c === "'") {
      const ch = /^'(\\(x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'\n])'/u.exec(s.slice(i, i + 16));
      if (ch) {
        blank(i + 1, i + ch[0].length - 1, '_');
        i += ch[0].length;
        continue;
      }
    }
    i++;
  }
  return o.join('');
}

/** Index of the bracket closing the one at `open` in masked text (any of ()[]{}), -1 = unbalanced. */
function closing(m: string, open: number): number {
  let depth = 0;
  for (let i = open; i < m.length; i++) {
    if ('([{'.includes(m[i])) depth++;
    else if (')]}'.includes(m[i]) && --depth === 0) return i;
  }
  return -1;
}

const lineOf = (s: string, at: number) => s.slice(0, at).split('\n').length;

/** [start, end) of every `#[cfg(test)] mod name { … }` in the file. */
function testModules(m: string): [number, number][] {
  const spans: [number, number][] = [];
  const re = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*(?:#\s*\[[^\]]*\]\s*)*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+\w+\s*\{/g;
  for (let x = re.exec(m); x; x = re.exec(m)) {
    const open = x.index + x[0].length - 1;
    const end = closing(m, open);
    if (end < 0) throw new Error(`读不懂测试模块的括号（从第 ${lineOf(m, x.index)} 行起）`);
    spans.push([x.index, end + 1]);
    re.lastIndex = end + 1;
  }
  return spans;
}

/** The value of a plain Rust string literal, or undefined when it is not one the scan can read for sure. */
function literal(arg: string): string | undefined {
  const raw = /^(?:r(#*)"([\s\S]*)"\1)$/.exec(arg);
  if (raw) return raw[2];
  const plain = /^"([^"\\]*)"$/.exec(arg);
  return plain ? plain[1] : undefined;
}

type Read = { file: string; line: number; what: string; target?: string; test: boolean; why?: string };

/** Every compile-time file read in one file; `target` = the absolute path it reads. */
function reads(file: string, s: string): Read[] {
  const m = mask(s);
  const spans = testModules(m);
  const inTest = (at: number) => spans.some(([a, b]) => at >= a && at < b);
  const out: Read[] = [];
  const at = (i: number, what: string, extra: Partial<Read>): Read => ({ file, line: lineOf(s, i), what, test: inTest(i), ...extra });

  const macro = /\b(include(?:_str|_bytes)?)\s*!\s*([([{])/g;
  for (let x = macro.exec(m); x; x = macro.exec(m)) {
    const open = x.index + x[0].length - 1;
    const close = closing(m, open);
    if (close < 0) {
      out.push(at(x.index, x[1], { why: '括号不配对' }));
      continue;
    }
    const arg = s.slice(open + 1, close).trim().replace(/,\s*$/, '').trim();
    const lit = literal(arg);
    if (lit !== undefined) out.push(at(x.index, x[1], { target: resolve(dirname(file), lit) }));
    else if (/\benv\s*!\s*\(\s*"OUT_DIR"\s*\)/.test(arg)) continue; // build output, made by the copy's own build
    else out.push(at(x.index, x[1], { why: `参数不是能确定的单个路径：${arg}` }));
  }
  const pathAttr = /#\s*!?\s*\[\s*path\s*=\s*"/g;
  for (let x = pathAttr.exec(m); x; x = pathAttr.exec(m)) {
    const q = x.index + x[0].length - 1;
    const end = m.indexOf('"', q + 1);
    const lit = literal(s.slice(q, end + 1));
    out.push(at(x.index, '#[path]', lit === undefined ? { why: '路径写法读不懂' } : { target: resolve(dirname(file), lit) }));
  }
  const alias = /\b(include(?:_str|_bytes)?)\s+as\s+\w+/g;
  for (let x = alias.exec(m); x; x = alias.exec(m)) out.push(at(x.index, x[1], { why: '换了名字导入，扫描认不出用到它的地方' }));
  return out;
}

/** Scan a copy made by the real copySources: every product-code read and what is wrong with it. */
function scanCopy(work: string) {
  const all = rustFiles(join(work, 'src-tauri')).flatMap((f) => reads(f, readFileSync(f, 'utf8')));
  const product = all.filter((r) => !r.test);
  const problems = product
    .filter((r) => r.why !== undefined || r.target === undefined || !r.target.startsWith(work + sep) || !existsSync(r.target))
    .map((r) => `${relative(work, r.file)}:${r.line} ${r.what} ${r.why ?? `读的文件副本里没有：${relative(work, r.target!)}`}`);
  return { all, product, problems };
}

const dirs: string[] = [];
const made = () => {
  const d = tempDir();
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('真实窗口负对照的副本带齐后台编译要读的文件（GitHub#586）', () => {
  it('按负对照的真实拷法造副本：后台产品代码在编译时读的每个文件副本里都有', () => {
    const work = made();
    copySources(work);
    const { all, product, problems } = scanCopy(work);
    // it really found the 10 language tables, as product code, inside the copy
    const lang = product.filter((r) => r.file.endsWith(join('core', 'src', 'i18n.rs')) && r.target?.startsWith(join(work, 'src', 'i18n', 'en') + sep));
    expect(lang.length).toBe(10);
    // reads in test modules are recognised as such (they point outside the copy on purpose)
    expect(all.some((r) => r.test && r.target === join(work, '..', 'docs', 'operations.md'))).toBe(true);
    expect(all.some((r) => r.test && r.target === join(work, '..', 'scripts', '_label_rename.sh'))).toBe(true);
    expect(problems).toEqual([]);
  });

  it('副本不带的目录（target、gen、别的顶层目录）里的文件，原目录里有也算缺', () => {
    const src = made();
    const files: Record<string, string> = {
      'src-tauri/gen/schema.txt': 'x',
      'src-tauri/target/out.txt': 'x',
      'src-tauri/res/kept.txt': 'x',
      'src/i18n/en/a.json': '{}',
      'scripts/tool.sh': 'x',
    };
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(src, p)), { recursive: true });
      writeFileSync(join(src, p), t);
    }
    mkdirSync(join(src, 'src-tauri', 'src'), { recursive: true });
    writeFileSync(
      join(src, 'src-tauri', 'src', 'main.rs'),
      [
        'const A: &str = include_str!("../gen/schema.txt");',
        'const B: &str = include_str!("../target/out.txt");',
        'const C: &str = include_str!("../res/kept.txt");',
        'const D: &str = include_str!("../../src/i18n/en/a.json");',
        'const E: &str = include_str!("../../scripts/tool.sh");',
      ].join('\n'),
    );
    const work = made();
    copySources(work, src);
    expect(existsSync(join(work, 'src-tauri', 'gen'))).toBe(false);
    expect(scanCopy(work).problems).toEqual([
      'src-tauri/src/main.rs:1 include_str 读的文件副本里没有：src-tauri/gen/schema.txt',
      'src-tauri/src/main.rs:2 include_str 读的文件副本里没有：src-tauri/target/out.txt',
      'src-tauri/src/main.rs:5 include_str 读的文件副本里没有：scripts/tool.sh',
    ].map((l) => l.split('/').join(sep)));
  });

  it('各种合法写法都进路径校验；注释、字符串里的字样和测试模块里的不算', () => {
    const work = made();
    const dir = join(work, 'src-tauri', 'src');
    mkdirSync(dir, { recursive: true });
    const s = [
      'const A: &str = include_str! {"../m1"};', // 1
      'const B: &str = include_str ! ["../m2"];', // 2
      'const C: &[u8] = std::include_bytes!("../m3");', // 3
      'const D: &str = core :: include_str!(r#"../m4"#);', // 4
      'const E: &str = include_str! /* x */ ("../m5",);', // 5
      'include!("../m6");', // 6
      'const F: &str = include_str!(concat!("../", "m7"));', // 7
      'use std::include_str as inc;', // 8
      '#[path = "../m9.rs"] mod nine;', // 9
      'const G: &str = include_str!("..\\\\m10");', // 10
      'const H: &str = include_str!(concat!(env!("OUT_DIR"), "/gen.rs"));', // 11
      '// include_str!("../comment") and /* include_bytes!("../block") */', // 12
      'const I: &str = "include_str!(\\"../in-string\\")";', // 13
      '#[cfg(test)]', // 14
      'mod tests {', // 15
      "    fn f<'a>(x: &'a str) -> char { let _ = \"}\"; let _ = r#\"}{\"#; /* } */ // }", // 16
      "        '}' }", // 17
      '    const T: &str = include_str!("../../../docs/t.md");', // 18
      '}', // 19
      'const Z: &str = include_str!("../after-tests");', // 20
    ].join('\n');
    writeFileSync(join(dir, 'lib.rs'), s);
    const { all, problems } = scanCopy(work);
    const lines = (xs: string[]) => xs.map((p) => Number(/:(\d+) /.exec(p)![1]));
    // every form landed in the path check (none of these files exist), the ignored ones did not
    expect(lines(problems).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20]);
    expect(problems.find((p) => p.includes(':7 '))).toContain('参数不是能确定的单个路径');
    expect(problems.find((p) => p.includes(':8 '))).toContain('换了名字导入');
    expect(all.filter((r) => r.test).map((r) => r.line)).toEqual([18]);
    // with the files there, the same forms pass
    for (const f of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm9.rs', 'after-tests']) writeFileSync(join(work, 'src-tauri', f), 'x');
    expect(lines(scanCopy(work).problems).sort((a, b) => a - b)).toEqual([7, 8, 10]);
  });
});
