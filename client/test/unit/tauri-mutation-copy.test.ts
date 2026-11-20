// The real-window negative controls (test/tauri/mutations.mjs) compile a copy of the app that
// holds only src-tauri/ plus COPY_ALWAYS (and dist/ or the window's own build inputs). GitHub#586:
// the back end began compiling in src/i18n/en/*.json, the copy did not carry src/, and all seven
// entries failed to compile — every night, without one of them reaching its test. This scan reads
// every compile-time file read (include_str! / include_bytes! / include!) in the back end's
// product code and requires it to land inside what the copy carries, so a new one shows up here
// on the next push instead of in the nightly run. Reads inside `#[cfg(test)] mod … { }` blocks are
// left out: `cargo build` never compiles them.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain .mjs runner without type declarations
import { COPY_ALWAYS } from '../tauri/mutations.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tauri = join(root, 'src-tauri');

function rustFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      // build output and generated files are not part of the copy (the runner filters them the same way)
      if (dir === tauri && (e.name === 'target' || e.name === 'gen')) continue;
      if (e.name === 'target') continue;
      out.push(...rustFiles(p));
    } else if (e.name.endsWith('.rs')) out.push(p);
  }
  return out;
}

/**
 * Index just past the `}` closing the `{` at `open`, skipping comments, strings, raw strings and
 * char literals (a `'` not closed within one char / one escape is a lifetime). -1 = unbalanced.
 */
function blockEnd(s: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl + 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      let d = 1;
      i += 2;
      while (i < s.length && d > 0) {
        if (s[i] === '/' && s[i + 1] === '*') (d++, (i += 2));
        else if (s[i] === '*' && s[i + 1] === '/') (d--, (i += 2));
        else i++;
      }
      continue;
    }
    const raw = /^b?r(#*)"/.exec(s.slice(i, i + 260));
    if (raw && (i === 0 || !/[A-Za-z0-9_]/.test(s[i - 1]))) {
      const close = `"${raw[1]}`;
      const end = s.indexOf(close, i + raw[0].length);
      if (end < 0) return -1;
      i = end + close.length;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === "'") {
      const ch = /^'(\\(x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'\n])'/u.exec(s.slice(i, i + 16));
      i += ch ? ch[0].length : 1;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/** [start, end) of every `#[cfg(test)] mod name { … }` in the file. */
function testModules(s: string): [number, number][] {
  const spans: [number, number][] = [];
  const re = /#\[cfg\(test\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const open = m.index + m[0].length - 1;
    const end = blockEnd(s, open);
    if (end < 0) throw new Error(`读不懂测试模块的括号（从第 ${s.slice(0, m.index).split('\n').length} 行起）`);
    spans.push([m.index, end]);
    re.lastIndex = end;
  }
  return spans;
}

type Read = { file: string; line: number; arg: string; path?: string; test: boolean };

/** Every include_str! / include_bytes! / include! in one file; `path` = where it reads, relative to client/. */
function includes(file: string, s: string): Read[] {
  const spans = testModules(s);
  const out: Read[] = [];
  const re = /\binclude(?:_str|_bytes)?!\s*\(\s*([^)]*)\)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const at = m.index;
    const line = s.slice(0, at).split('\n').length;
    const lineStart = s.lastIndexOf('\n', at) + 1;
    if (/^\s*\/\//.test(s.slice(lineStart, at))) continue; // a doc / line comment mentioning the macro
    const arg = m[1].trim();
    const lit = /^"((?:[^"\\]|\\.)*)"$/.exec(arg);
    const r: Read = { file: relative(root, file), line, arg, test: spans.some(([a, b]) => at >= a && at < b) };
    if (lit) r.path = relative(root, resolve(dirname(file), lit[1]));
    out.push(r);
  }
  return out;
}

const inCopy = (p: string) => ['src-tauri', ...COPY_ALWAYS].some((d: string) => p === d || p.startsWith(d + sep) || p.startsWith(d + '/'));

describe('真实窗口负对照的副本带齐后台编译要读的文件（GitHub#586）', () => {
  const reads = rustFiles(tauri).flatMap((f) => includes(f, readFileSync(f, 'utf8')));
  const product = reads.filter((r) => !r.test);

  it('扫到了后台的编译时读文件（i18n.rs 的 10 份语言表算产品代码，测试模块里的算测试）', () => {
    const lang = product.filter((r) => r.file.endsWith(join('core', 'src', 'i18n.rs')) && r.path?.startsWith(join('src', 'i18n', 'en')));
    expect(lang.length).toBe(10);
    // reads inside test modules are recognised as such, not as product code
    const docs = reads.filter((r) => r.path === join('..', 'docs', 'operations.md'));
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((r) => r.test)).toBe(true);
    expect(reads.some((r) => r.test && r.path === join('..', 'scripts', '_label_rename.sh'))).toBe(true);
  });

  it('产品代码里每一处编译时读文件都落在副本会带的目录里，且文件真的存在', () => {
    const bad = product
      .filter((r) => r.path === undefined ? !r.arg.includes('OUT_DIR') : !inCopy(r.path) || !existsSync(join(root, r.path)))
      .map((r) => `${r.file}:${r.line} ${r.path ?? r.arg}`);
    expect(bad).toEqual([]);
  });

  it('扫描认得出测试模块的边界：模块里的字符串、注释、字符和生命周期都不打乱括号', () => {
    const s = [
      'const A: &str = include_str!("../../src/a.json");',
      '#[cfg(test)]',
      'mod tests {',
      "    fn f<'a>(x: &'a str) -> char { let _ = \"}\"; let _ = r#\"}{\"#; /* } */ // }",
      "        '}' }",
      '    const B: &str = include_str!("../../../docs/b.md");',
      '}',
      'const C: &[u8] = include_bytes!("../../build/c.png");',
      '// include_str!("../nowhere")',
    ].join('\n');
    const r = includes(join(tauri, 'src', 'x.rs'), s);
    expect(r.map((x) => [x.path, x.test])).toEqual([
      [join('src', 'a.json'), false],
      [join('..', 'docs', 'b.md'), true],
      [join('build', 'c.png'), false],
    ]);
    // a read outside what the copy carries is caught
    expect(inCopy(join('src', 'i18n', 'en', 'x.json'))).toBe(true);
    expect(inCopy(join('scripts', 'x.mjs'))).toBe(false);
    expect(inCopy(join('..', 'docs', 'b.md'))).toBe(false);
  });
});
