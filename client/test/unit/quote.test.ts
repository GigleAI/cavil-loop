// GitHub#653: quote reply — what a quote of a whole entry keeps (everything but HTML comments, byte for
// byte), how a quote is laid out, and where it goes in the reply box. The cases of the three design-review
// rounds on #653 sit together here: each was a way a broader clean-up changed visible text.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasWords, quoteText, trimSelection, withQuote, withoutHidden } from '../../src/data/quote';
import { buildTimeline } from '../../src/data/detail';

const here = new URL('.', import.meta.url).pathname;
// a real round-log record: written by scripts/round_log.py (new_record / section_text / top_text) around two
// real usage footers from scripts/drivers/token-usage/comment-footer.sh (each with its hidden usage record)
const ROUND_LOG = readFileSync(join(here, '..', 'fixtures', 'quote', 'round-log.md'), 'utf8');

/** the text with every line that is nothing but one HTML comment taken out */
const dropCommentLines = (s: string) =>
  s
    .split('\n')
    .filter((l) => !/^<!--.*-->$/.test(l))
    .join('\n');

describe('withoutHidden: HTML comments go, everything else stays byte for byte', () => {
  it('a real round-log record: every hidden marker and both usage records go; folds, sections and the top version stay', () => {
    const out = withoutHidden(ROUND_LOG);
    expect(out).not.toMatch(/^<!--/m);
    expect(out).not.toContain('agent-metrics');
    expect(out).not.toContain('cavil-round-log:');
    expect(out).toBe(dropCommentLines(ROUND_LOG));
    // the two visible usage folds and their bullets are still there, as written
    expect(out.match(/^<details><summary>⏱️ 耗时：/gm)?.length).toBe(2);
    // inline code that shows a comment is code: kept
    expect(out).toContain('`<!-- … -->` → 原样保留');
    expect(out).toContain('**只删 HTML 片段里的 `<!-- … -->` 注释**');
  });

  it('a usage fold with its record and a fold that only looks like one: both folds stay, only the record goes', () => {
    const real = '正文\n\n---\n<details><summary>⏱️ 耗时：1m 0s</summary>\n\n- 开始 07:00\n\n</details>\n<!-- agent-metrics wall_secs=60 -->\n';
    const alike = '正文\n\n<details><summary>⏱️ 耗时：构建计时示例</summary>\n\n本地首次构建约需两分钟\n\n</details>\n';
    expect(withoutHidden(real)).toBe(real.replace('<!-- agent-metrics wall_secs=60 -->\n', ''));
    expect(withoutHidden(alike)).toBe(alike);
  });

  it('an unclosed usage opening followed by an ordinary fold: nothing is cut', () => {
    const s = '前文\n\n<details><summary>⏱️ 耗时：3s</summary>\n\n中间的正文\n\n<details><summary>普通折叠</summary>\n\n折叠里的字\n\n</details>\n\n后文\n';
    expect(withoutHidden(s)).toBe(s);
  });

  it('code keeps its blank lines and indentation', () => {
    const fenced = '说明\n\n```\na\n\n\n\nb\n```\n<!-- x -->\n';
    expect(withoutHidden(fenced)).toBe('说明\n\n```\na\n\n\n\nb\n```\n');
    const indented = '    const a = 1;\n\n\n    const b = 2;\n';
    expect(withoutHidden(indented)).toBe(indented);
    // a comment first, indented code next: the comment and the blank line go, the code stays as it is
    expect(withoutHidden('<!-- marker -->\n\n    code line\n      more\n')).toBe('    code line\n      more\n');
  });

  it('comments written as code stay', () => {
    const s = '例：\n\n```html\n<!-- agent-blocked-by: #12 -->\n```\n\n行内 `<!-- x -->` 也是代码\n';
    expect(withoutHidden(s)).toBe(s);
  });

  it('a comment over several lines goes; an inline one goes alone; a block of only comments between two paragraphs goes', () => {
    expect(withoutHidden('a\n\n<!-- one\ntwo\nthree -->\n\nb\n')).toBe('a\n\n\nb\n');
    expect(withoutHidden('前 <!-- x --> 后\n')).toBe('前  后\n');
    expect(withoutHidden('a\n\n<!-- x -->\n<!-- y -->\n\nb')).toBe('a\n\n\nb');
    // a comment at the end takes the blank lines before it: no empty quote lines at the end
    expect(withoutHidden('a\n\n<!-- x -->\n')).toBe('a\n');
    expect(withoutHidden('a\n\n<!-- x -->')).toBe('a\n');
  });

  it('no comment: the text itself, blank lines at either end included', () => {
    for (const s of ['\n\n正文\n\n', '  \n# 标题\n\n- a\n- b\n\n\n', 'x', '']) expect(withoutHidden(s)).toBe(s);
  });

  it('nothing but comments: nothing left (and nothing to quote)', () => {
    expect(withoutHidden('<!-- a -->\n\n<!-- b -->\n')).toBe('');
    expect(hasWords(withoutHidden('<!-- a -->\n'))).toBe(false);
  });

  it('CRLF sources (GitHub keeps what the browser sent)', () => {
    expect(withoutHidden('a\r\n\r\n<!-- x -->\r\n\r\nb\r\n')).toBe('a\r\n\r\n\r\nb\r\n');
  });
});

describe('quoteText / withQuote / trimSelection', () => {
  it('every line gets "> ", an empty one ">"; the last line break makes no extra line', () => {
    expect(quoteText('a')).toBe('> a');
    expect(quoteText('a\n\nb\n')).toBe('> a\n>\n> b');
    expect(quoteText('a\r\nb\rc')).toBe('> a\n> b\n> c');
    // the source's own blank lines at the ends are kept
    expect(quoteText('\nx\n\n')).toBe('>\n> x\n>');
    // indented code stays indented code inside the quote
    expect(quoteText('    code')).toBe('>     code');
  });

  it('goes after what the box holds, one blank line between, a blank line after', () => {
    expect(withQuote('', '> a')).toBe('> a\n\n');
    expect(withQuote('hi', '> a')).toBe('hi\n\n> a\n\n');
    expect(withQuote('hi\n', '> a')).toBe('hi\n\n> a\n\n');
    expect(withQuote('hi\n\n', '> a')).toBe('hi\n\n> a\n\n');
    // two quotes in a row
    expect(withQuote(withQuote('', '> a'), '> b')).toBe('> a\n\n> b\n\n');
  });

  it('selected words lose only the blank lines at their edges', () => {
    expect(trimSelection('\n  \n第一句\n\n第二句\n \n')).toBe('第一句\n\n第二句');
    expect(trimSelection('  缩进的一行')).toBe('  缩进的一行');
  });
});

describe('the detail read: which entries can be quoted whole', () => {
  const raw = {
    item: { __typename: 'Issue', id: 'I', number: 1, title: 't', url: 'u', state: 'OPEN', createdAt: '2026-01-01T00:00:00Z', bodyHTML: '<p>b</p>', body: 'b <!-- x -->', viewerCanUpdate: false, author: { login: 'a' }, labels: { nodes: [] } },
    comments: [
      { id: 'C1', url: 'u1', createdAt: '2026-01-02T00:00:00Z', bodyHTML: '<p>c</p>', body: 'c', author: { login: 'a' } },
      { id: 'C2', url: 'u2', createdAt: '2026-01-03T00:00:00Z', bodyHTML: '', body: '<!-- only hidden -->', author: { login: 'a' } },
      { id: 'C3', url: 'u3', createdAt: '2026-01-04T00:00:00Z', bodyHTML: '<p>no source read</p>', author: { login: 'a' } },
    ],
    reviews: [
      {
        id: 'R1', url: 'r1', state: 'COMMENTED', submittedAt: '2026-01-05T00:00:00Z', createdAt: '2026-01-05T00:00:00Z', bodyHTML: '<p>r</p>', body: 'review words', author: { login: 'a' },
        comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'L1', url: 'l1', createdAt: '2026-01-05T00:00:00Z', bodyHTML: '<p>l</p>', body: 'line', author: { login: 'a' }, path: 'f', line: 1, originalLine: 1 }] },
      },
    ],
  };
  it('body, comment and review carry the cleaned source; none read or nothing visible: no quote', () => {
    const tl = buildTimeline(raw as never);
    const by = (id: string) => tl.find((e) => e.id === id)!;
    expect(by('I').quoteSource).toBe('b ');
    // not editable by this account, still quotable (quoting reads only)
    expect(by('I').editSource).toBeUndefined();
    expect(by('C1').quoteSource).toBe('c');
    expect(by('C2').quoteSource).toBeUndefined();
    expect(by('C3').quoteSource).toBeUndefined();
    expect(by('R1').quoteSource).toBe('review words');
    expect(JSON.stringify(by('R1').lineComments)).not.toContain('quoteSource');
  });
});
