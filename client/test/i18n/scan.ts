// The source side of the language checks (GitHub#466 / #471): find the client's own Chinese that
// does not go through t() / tr(). Comments are not text; everything else is — string literals,
// template text, JSX text — and any Chinese in it must be the first argument of t( … ) (window)
// or tr( … ) (back end), or exactly one of the words kept in their own language (KEEP_LANG).
//
// A small lexer, not a parser: it knows comments, strings, template literals (with ${ } inside),
// regular expressions and Rust's raw strings / char literals, and nothing else. Whatever it cannot
// tell apart errs towards reporting: a misread JSX apostrophe ends at the line's end, and its
// Chinese is still reported. The run-time check (test/e2e/i18n.spec.ts) catches what is built at
// run time and never appears as a literal.

/** Chinese characters and the full-width punctuation that only ever comes with them */
export const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;

export interface Finding {
  line: number;
  text: string;
}

export interface ScanResult {
  /** Chinese outside t() / tr() and outside KEEP_LANG */
  findings: Finding[];
  /** the keys this file looks up, with the line of each use */
  keys: Map<string, number[]>;
  /** a t( / tr( whose first argument is not a plain literal */
  badCalls: Finding[];
}

type Lang = 'ts' | 'rust';

const IDENT = /[A-Za-z0-9_$]/;
/** after one of these (or at the start) a `/` begins a regular expression, not a division */
const REGEX_BEFORE = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '+', '-', '*', '%', '~', '^', '>', '']);

function unescape(raw: string): string {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (_m, e: string) => {
    if (e === 'n') return '\n';
    if (e === 't') return '\t';
    if (e === 'r') return '\r';
    if (e.startsWith('u{')) return String.fromCodePoint(parseInt(e.slice(2, -1), 16));
    if (e.length === 5 && e[0] === 'u') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e.length === 3 && e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    return e;
  });
}

export function scan(src: string, lang: Lang, keep: readonly string[]): ScanResult {
  const findings: Finding[] = [];
  const badCalls: Finding[] = [];
  const keys = new Map<string, number[]>();
  const fns = lang === 'ts' ? ['t', 'tNode', 'zhKey'] : ['tr'];
  const fn = fns.join(' / ');
  let i = 0;
  let line = 1;
  /** the last character that was not white space or a comment, in code */
  let prev = '';
  /** a t( was just read: the next literal is its key */
  let wantKey = false;
  let wantKeyLine = 0;
  /** the identifier read last (`fn tr(` / `function t(` define, they do not call) */
  let lastWord = '';
  // template literals: each entry = the brace depth inside its ${ } where it resumes
  const tplStack: number[] = [];
  let depth = 0;
  // Rust: the region of a #[cfg(test)] item (test code is not shown to anyone)
  let testArmed = false;
  let testDepth = -1;

  const report = (text: string, at: number) => {
    if (testDepth >= 0) return;
    if (CJK.test(text)) findings.push({ line: at, text: text.trim().slice(0, 80) });
  };
  const literal = (raw: string, at: number, plain: boolean) => {
    const value = plain ? unescape(raw) : raw;
    if (wantKey) {
      wantKey = false;
      if (testDepth < 0) {
        const l = keys.get(value) ?? [];
        l.push(at);
        keys.set(value, l);
      }
      return;
    }
    if (keep.includes(value)) return;
    report(value, at);
  };
  const keyNotLiteral = () => {
    if (wantKey) {
      wantKey = false;
      if (testDepth < 0) badCalls.push({ line: wantKeyLine, text: `${fn}( 的第一个参数不是字面量` });
    }
  };

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    // comments
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      let nest = 0;
      i += 2;
      for (;;) {
        if (i >= src.length) break;
        if (src[i] === '\n') line++;
        if (lang === 'rust' && src[i] === '/' && src[i + 1] === '*') {
          nest++;
          i += 2;
          continue;
        }
        if (src[i] === '*' && src[i + 1] === '/') {
          i += 2;
          if (nest === 0) break;
          nest--;
          continue;
        }
        i++;
      }
      continue;
    }
    // Rust raw / byte strings: r"…", r#"…"#, br"…", b"…"
    if (lang === 'rust' && (c === 'r' || c === 'b') && !IDENT.test(src[i - 1] ?? ' ')) {
      const m = /^(b?r)(#*)"/.exec(src.slice(i, i + 40));
      if (m) {
        const close = `"${m[2]}`;
        const start = i + m[0].length;
        const end = src.indexOf(close, start);
        const stop = end < 0 ? src.length : end;
        const body = src.slice(start, stop);
        const at = line;
        line += (body.match(/\n/g) ?? []).length;
        i = stop + close.length;
        literal(body, at, false);
        prev = '"';
        continue;
      }
      if (c === 'b' && n === '"') {
        i++;
        continue; // the string itself is read next round
      }
    }
    // strings
    if (c === '"' || (c === "'" && lang === 'ts')) {
      const at = line;
      let j = i + 1;
      let raw = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          raw += src[j] + (src[j + 1] ?? '');
          if (src[j + 1] === '\n') line++;
          j += 2;
          continue;
        }
        // a TS string never spans lines: an apostrophe in JSX text ends here, its Chinese is still reported
        if (src[j] === '\n') {
          if (lang === 'ts') break;
          line++;
        }
        raw += src[j];
        j++;
      }
      i = src[j] === c ? j + 1 : j;
      literal(raw, at, true);
      prev = '"';
      continue;
    }
    // Rust: char literal or lifetime
    if (lang === 'rust' && c === "'") {
      if (n === '\\') {
        const end = src.indexOf("'", i + 2);
        const raw = src.slice(i + 1, end);
        i = end + 1;
        report(unescape(raw), line);
        prev = '"';
        continue;
      }
      const cp = src.codePointAt(i + 1) ?? 0;
      const w = cp > 0xffff ? 2 : 1;
      if (src[i + 1 + w] === "'") {
        report(src.slice(i + 1, i + 1 + w), line);
        i += 2 + w;
        prev = '"';
        continue;
      }
      i++; // a lifetime
      continue;
    }
    // template literals (and their ${ } parts)
    if (lang === 'ts' && (c === '`' || (c === '}' && tplStack.length && tplStack[tplStack.length - 1] === depth))) {
      const startsHere = c === '`';
      if (!startsHere) {
        tplStack.pop();
        depth--;
      }
      const at = line;
      let j = i + 1;
      let raw = '';
      let opened = false;
      while (j < src.length) {
        if (src[j] === '\\') {
          raw += src.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (src[j] === '`') {
          j++;
          break;
        }
        if (src[j] === '$' && src[j + 1] === '{') {
          opened = true;
          j += 2;
          break;
        }
        if (src[j] === '\n') line++;
        raw += src[j];
        j++;
      }
      i = j;
      if (startsHere && wantKey && !opened) literal(raw, at, true);
      else {
        if (startsHere) keyNotLiteral();
        if (!keep.includes(unescape(raw))) report(unescape(raw), at);
      }
      if (opened) {
        depth++;
        tplStack.push(depth);
        prev = '{';
      } else prev = '"';
      continue;
    }
    // regular expressions
    if (lang === 'ts' && c === '/' && REGEX_BEFORE.has(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      // a regular expression full of Chinese is still the client's own text
      report(src.slice(i + 1, j), line);
      i = j + 1;
      while (IDENT.test(src[i] ?? '')) i++;
      prev = '"';
      continue;
    }
    // identifiers: t( / tr(
    if (IDENT.test(c)) {
      let j = i;
      while (j < src.length && IDENT.test(src[j])) j++;
      const word = src.slice(i, j);
      const before = src[i - 1] ?? '';
      i = j;
      if (wantKey) keyNotLiteral();
      const defining = lastWord === 'fn' || lastWord === 'function';
      lastWord = word;
      if (fns.includes(word) && before !== '.' && !IDENT.test(before) && !defining) {
        let k = i;
        while (k < src.length && /\s/.test(src[k])) k++;
        if (src[k] === '(') {
          // t( … ): skip to its first argument
          let m = k + 1;
          while (m < src.length && /\s/.test(src[m])) {
            if (src[m] === '\n') line++;
            m++;
          }
          i = m;
          wantKey = true;
          wantKeyLine = line;
          prev = '(';
          continue;
        }
      }
      if (word === 'return' || word === 'typeof' || word === 'case' || word === 'in' || word === 'of') prev = '(';
      else prev = 'a';
      report(word, line);
      continue;
    }
    if (wantKey) keyNotLiteral();
    if (lang === 'rust' && c === '#' && src.startsWith('#[cfg(test)]', i)) {
      testArmed = true;
      i += '#[cfg(test)]'.length;
      continue;
    }
    if (c === '{') {
      depth++;
      if (testArmed && testDepth < 0) {
        testDepth = depth;
        testArmed = false;
      }
    } else if (c === '}') {
      if (testDepth === depth) testDepth = -1;
      depth--;
    } else if (c === ';' && testArmed && testDepth < 0) testArmed = false;
    // anything else in code: JSX text, punctuation
    report(c, line);
    prev = c;
    i++;
  }
  return { findings: mergeLines(findings), keys, badCalls };
}

/** one finding per line: JSX text arrives a character at a time */
function mergeLines(fs: Finding[]): Finding[] {
  const out: Finding[] = [];
  for (const f of fs) {
    const last = out[out.length - 1];
    if (last && last.line === f.line) last.text = `${last.text}${f.text}`.slice(0, 80);
    else out.push({ ...f });
  }
  return out;
}
