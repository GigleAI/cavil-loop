// GitHub#653: quote reply — what a quote of a whole entry keeps (everything; HTML comments emptied), how
// a quote is laid out, and where it goes in the reply box. The cases of the three design-review rounds on
// #653 and the two code-review rounds on PR #659 sit together in one corpus: each was a way a clean-up
// changed visible text, and every one of them is checked by rendering, as the source and as a quote.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { hasWords, htmlComments, parses, quoteText, selectionMarkdown, trimSelection, withQuote, withoutHidden } from '../../src/data/quote';
import { buildTimeline } from '../../src/data/detail';

const here = new URL('.', import.meta.url).pathname;
// a real round-log record: written by scripts/round_log.py (new_record / section_text / top_text) around two
// real usage footers from scripts/drivers/token-usage/comment-footer.sh (each with its hidden usage record)
const ROUND_LOG = readFileSync(join(here, '..', 'fixtures', 'quote', 'round-log.md'), 'utf8');

/** GitHub-flavoured rendering with raw HTML kept (as GitHub keeps comments and tags), comments then taken out */
const render = (md: string) =>
  micromark(md, { allowDangerousHtml: true, extensions: [gfm()], htmlExtensions: [gfmHtml()] })
    .replace(/<!--[\s\S]*?-->/g, '')
    // whitespace reads as a browser shows it — one space — except inside <pre>, where every line counts
    .split(/(<pre[\s\S]*?<\/pre>)/)
    .map((part, i) => (i % 2 ? part : part.replace(/\s+/g, ' ')))
    .join('')
    .replace(/> </g, '><')
    .trim();
/** the rendering as it comes (line breaks in it kept), for reading the words back */
const renderRaw = (md: string) =>
  micromark(md, { allowDangerousHtml: true, extensions: [gfm()], htmlExtensions: [gfmHtml()] })
    .replace(/>\s+</g, '><')
    .trim();
/** what a quote shows as text: tags out, entities and line breaks as they read */
const shownText = (html: string) =>
  html
    .replace(/<br \/>\n?/g, '\n')
    .replace(/<\/p><p>/g, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\u00a0/g, ' ')
    .replace(/^\n+|\n+$/g, '');
/** a whole quote renders to what the source does, the comments aside — as the source and as a quote */
const sameRender = (source: string) => {
  const out = withoutHidden(source);
  expect(out).not.toBeNull();
  expect(render(out!)).toBe(render(source));
  expect(render(quoteText(out!))).toBe(render(quoteText(source)));
  return out!;
};

/** every case of every round, in one place: each must render the same as the source, and as a quote */
const CORPUS: Record<string, string> = {
  roundLog: ROUND_LOG,
  // design review rounds on #653
  usageFold: '正文\n\n---\n<details><summary>⏱️ 耗时：1m 0s</summary>\n\n- 开始 07:00\n\n</details>\n<!-- agent-metrics wall_secs=60 -->\n',
  foldAlike: '正文\n\n<details><summary>⏱️ 耗时：构建计时示例</summary>\n\n本地首次构建约需两分钟\n\n</details>\n',
  unclosedFold: '前文\n\n<details><summary>⏱️ 耗时：3s</summary>\n\n中间的正文\n\n<details><summary>普通折叠</summary>\n\n折叠里的字\n\n</details>\n\n后文\n',
  fencedBlanks: '说明\n\n```\na\n\n\n\nb\n```\n<!-- x -->\n',
  indentedOnly: '    const a = 1;\n\n\n    const b = 2;\n',
  commentThenCode: '<!-- marker -->\n\n    code line\n      more\n',
  commentAsCode: '例：\n\n```html\n<!-- agent-blocked-by: #12 -->\n```\n\n行内 `<!-- x -->` 也是代码\n',
  multiLine: 'a\n\n<!-- one\ntwo\nthree -->\n\nb\n',
  inline: '前 <!-- x --> 后\n',
  twoBetween: 'a\n\n<!-- x -->\n<!-- y -->\n\nb',
  edgesBlank: '\n\n正文\n\n',
  crlf: 'a\r\n\r\n<!-- x -->\r\n\r\nb\r\n',
  // PR #659 code review round 1
  twoParagraphs: 'First\n<!-- hidden -->\nSecond',
  twoLists: '- first\n<!-- hidden -->\n- second',
  twoListsBlank: '- first\n\n<!-- hidden -->\n\n- second',
  twoCodes: '    one\n\n<!-- x -->\n\n    two\n',
  linkAcross: '[a]<!-- x -->(b)',
  attribute: '<span title="<!-- literal -->">visible</span><!-- marker --> text\n',
  inItem: '- item\n\n  <!-- inside the item -->\n\n  more of it\n',
  inQuote: '> quoted\n> <!-- x -->\n> more\n',
  // PR #659 code review round 2: GitHub's extensions
  taskBox: '- [<!-- hidden -->x] item',
  strike: '~<!-- hidden -->~text~~',
  autolink: 'https://exa<!-- hidden -->mple.com',
  tablePipe: '| a | b |\n|---|---|\n| c <!-- d | e --> | f |\n',
};

describe('withoutHidden: every comment emptied, everything else as it was', () => {
  it('every case of every round renders the same as the source, as itself and as a quote', () => {
    for (const [name, s] of Object.entries(CORPUS)) {
      try {
        sameRender(s);
      } catch (e) {
        throw new Error(`${name}: ${(e as Error).message}`);
      }
    }
  });

  it('the hidden words are gone; empty comments stand where comments stood', () => {
    expect(withoutHidden(CORPUS.twoParagraphs)).toBe('First\n<!-- -->\nSecond');
    expect(withoutHidden(CORPUS.twoLists)).toBe('- first\n<!-- -->\n- second');
    expect(withoutHidden(CORPUS.taskBox)).toBe('- [<!-- -->x] item');
    expect(withoutHidden(CORPUS.strike)).toBe('~<!-- -->~text~~');
    expect(withoutHidden(CORPUS.autolink)).toBe('https://exa<!-- -->mple.com');
    expect(withoutHidden(CORPUS.inline)).toBe('前 <!-- --> 后\n');
    expect(withoutHidden(CORPUS.multiLine)).toBe('a\n\n<!-- -->\n\nb\n');
    expect(withoutHidden(CORPUS.attribute)).toBe('<span title="<!-- literal -->">visible</span><!-- --> text\n');
    expect(htmlComments('<a title=\'x <!-- y\'>z</a><!-- real -->')).toEqual([[25, 38]]);
  });

  it('what is not a comment stays as written: code, an attribute value, a cell a table row splits', () => {
    for (const k of ['commentAsCode', 'tablePipe', 'foldAlike', 'indentedOnly', 'edgesBlank']) expect(withoutHidden(CORPUS[k])).toBe(CORPUS[k]);
    expect(withoutHidden(CORPUS.fencedBlanks)).toBe('说明\n\n```\na\n\n\n\nb\n```\n');
  });

  it('whole lines go only inside raw HTML that has more in it, and at the very start and end', () => {
    // the usage record under the fold's closing tag (raw HTML with more in it)
    expect(withoutHidden(CORPUS.usageFold)).toBe(CORPUS.usageFold.replace('<!-- agent-metrics wall_secs=60 -->\n', ''));
    // the start: a comment first, indented code next — the code stays code
    expect(withoutHidden(CORPUS.commentThenCode)).toBe('    code line\n      more\n');
    // the end: no empty quote lines after the words
    expect(withoutHidden('a\n\n<!-- x -->\n')).toBe('a\n');
    expect(withoutHidden('a\n\n<!-- x -->')).toBe('a\n');
    // nothing but comments: nothing to quote
    expect(withoutHidden('<!-- a -->\n\n<!-- b -->\n')).toBe('');
  });

  it('a real round-log record: no hidden marker or usage record left; folds, sections and the top version all there', () => {
    const out = withoutHidden(ROUND_LOG)!;
    expect(out).not.toMatch(/cavil-round-log:|agent-metrics/);
    expect(out.match(/^<details><summary>⏱️ 耗时：/gm)?.length).toBe(2);
    expect(out).toContain('`<!-- … -->` → 原样保留');
    // every line of the record that holds no comment is there, in order
    const kept = ROUND_LOG.split('\n').filter((l) => !l.includes('<!--') || l.includes('`<!--'));
    let at = 0;
    for (const l of kept) {
      const i = out.indexOf(l, at);
      expect(i, l).toBeGreaterThanOrEqual(0);
      at = i + l.length;
    }
  });

  it('no comment: the text itself', () => {
    for (const s of ['\n\n正文\n\n', '  \n# 标题\n\n- a\n- b\n\n\n', 'x', '']) expect(withoutHidden(s)).toBe(s);
  });

  it('PR #659 code review round 2, problem 5: a long comment costs a fixed number of parses, whatever its number of comments', () => {
    // 200 short paragraphs, each kept apart from the next by a hidden marker on its own line
    const long = Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 段正文，说明这一步。\n<!-- marker ${i} -->`).join('\n');
    const before = parses.n;
    const out = sameRender(long);
    // the render check above parses with micromark itself, not through the quote module: only the quote's own parses count
    expect(parses.n - before).toBeLessThanOrEqual(3);
    expect(out.split('<!-- -->').length - 1).toBe(199);
    expect(out).not.toContain('marker');
    const t0 = performance.now();
    withoutHidden(long);
    // measured well under 50 ms; the bound leaves room for a loaded machine
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe('PR #659 code review round 1, problem 4: selected words show exactly as selected', () => {
  const shows = (text: string) => shownText(renderRaw(quoteText(selectionMarkdown(text))));
  /** what the selection reads as: blank lines at its edges gone, runs of blank lines one paragraph break */
  const reads = (text: string) =>
    trimSelection(text)
      .split('\n')
      .map((l) => (l.trim() ? l : ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');

  it('markdown, references and HTML in the selected words stay words', () => {
    for (const s of [
      '[draft](notes.md)',
      '**ready**',
      '_a_ and *b* and ~~c~~',
      '#12 and GigleAI/cavil-loop#12 and @luosky',
      ':smile: $x$ `code`',
      '<b>bold?</b> &amp; &lt;',
      'https://example.com/a_b and www.example.com and a@b.co',
      '1. one\n2) two\n- three\n+ four\n> five\n# six\n===\n***',
      '| a | b |\n|---|---|',
      'back\\slash at the end\\',
    ]) {
      expect(shows(s)).toBe(reads(s));
      // and the quote is one quote: nothing in it became a link, emphasis, heading, list, code or HTML
      expect(renderRaw(quoteText(selectionMarkdown(s)))).toMatch(/^<blockquote><p>[^]*<\/p><\/blockquote>$/);
      expect(renderRaw(quoteText(selectionMarkdown(s)))).not.toMatch(/<(a|strong|em|del|code|h\d|ul|ol|li|table|b|hr|pre)\b/);
    }
  });

  it('line breaks stay line breaks; indentation stays visible without becoming code', () => {
    expect(shows('第一行\n第二行\n\n新段落')).toBe('第一行\n第二行\n\n新段落');
    expect(shows('    缩进的一行\n\t制表')).toBe('    缩进的一行\n    制表');
  });

  it('random text of letters, spaces, line breaks and every ASCII punctuation mark shows back as it was', () => {
    const chars = 'ab 12\n' + '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
    let seed = 653;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
    for (let k = 0; k < 400; k++) {
      let s = '';
      for (let i = 0, n = 1 + rnd(40); i < n; i++) s += chars[rnd(chars.length)];
      // a selection of shown text: no trailing blanks on a line (a browser does not show them)
      s = s.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');
      if (!hasWords(s)) continue;
      expect([s, shows(s)]).toEqual([s, reads(s)]);
    }
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
    expect(by('I').quoteSource).toBe('b <!-- -->');
    // not editable by this account, still quotable (quoting reads only)
    expect(by('I').editSource).toBeUndefined();
    expect(by('C1').quoteSource).toBe('c');
    expect(by('C2').quoteSource).toBeUndefined();
    expect(by('C3').quoteSource).toBeUndefined();
    expect(by('R1').quoteSource).toBe('review words');
    expect(JSON.stringify(by('R1').lineComments)).not.toContain('quoteSource');
  });
});
