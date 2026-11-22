// Quote reply (GitHub#653): the reply box takes someone else's words as a `> ` quote, the way
// GitHub's own "Quote reply" does. Every way in goes through the functions here:
//
// | way in                                   | text                                 | made quotable        | quoted / put in the box   |
// |------------------------------------------|--------------------------------------|----------------------|---------------------------|
// | "引用回复" on a body / comment / review   | the entry's markdown source          | `withoutHidden`      | `quoteText` → `withQuote` |
// | "引用回复" or R with words selected       | the words selected in the discussion | `selectionMarkdown`  | `quoteText` → `withQuote` |
//
// The box itself is changed by one function in the detail panel (typing goes through it too).
//
// A whole entry keeps its markdown; only the words inside HTML comments go. Those hold the loop's
// hidden markers, and they must not come along: the daemon takes `<!-- agent-blocked-by: … -->`
// from anywhere in a collaborator's comment, quoted or not. A comment is not deleted but emptied in
// place, keeping its own line breaks — `<!-- -->` stands where it stood — so the parser meets a comment
// at the same place, every other character of the text stays where it was, and nothing around it can
// join, split, or turn into something else (a task box, a strikethrough, a longer autolink, two lists
// made one, a blank line inside <pre> gone: each was found once while comments or their lines were
// being deleted). No line is deleted, anywhere. Where comments are is read by micromark with GitHub's
// extensions, the same parser the client renders with; the result is checked against the source's
// token structure, and a text the check refuses is not quoted whole.

import { parse as mmParse, postprocess, preprocess } from 'micromark';
import { gfm } from 'micromark-extension-gfm';

/**
 * The HTML comments of a piece of raw HTML, as [start, end) offsets: read the way a browser tokenizes it
 * — a `<!--` inside a tag (an attribute value) or a processing instruction / declaration / CDATA section
 * is not a comment. `<!-->` and `<!--->` are whole (empty) comments; an unclosed one runs to the end.
 */
export function htmlComments(s: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  const skipTo = (from: number, end: string) => {
    const k = s.indexOf(end, from);
    return k < 0 ? s.length : k + end.length;
  };
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    i = lt;
    if (s.startsWith('<!--', i)) {
      const end = s.startsWith('<!-->', i) ? i + 5 : s.startsWith('<!--->', i) ? i + 6 : skipTo(i + 4, '-->');
      out.push([i, end]);
      i = end;
    } else if (s.startsWith('<![CDATA[', i)) i = skipTo(i + 9, ']]>');
    else if (s.startsWith('<?', i)) i = skipTo(i + 2, '?>');
    else if (/^<!?\/?[A-Za-z]/.test(s.slice(i, i + 3))) {
      // a tag (or a declaration): to its `>`, quoted attribute values included
      let j = i + 1;
      let q = '';
      for (; j < s.length; j++) {
        const c = s[j];
        if (q) {
          if (c === q) q = '';
        } else if (c === '"' || c === "'") q = c;
        else if (c === '>') break;
      }
      i = j + 1;
    } else i++;
  }
  return out;
}

interface Tok {
  type: string;
  start: { offset: number };
  end: { offset: number };
  _spread?: boolean;
}

/** how many times a text was parsed (tests hold the cost of one quote to a fixed number of parses) */
export const parses = { n: 0 };

/** micromark's events for `s`, GitHub's extensions on */
function events(s: string): ['enter' | 'exit', Tok][] {
  parses.n++;
  const ev = postprocess(mmParse({ extensions: [gfm()] }).document().write(preprocess()(s, undefined, true)));
  return ev.map(([k, tok]) => [k, tok as unknown as Tok]);
}

/**
 * What an emptied comment keeps: its own line breaks, each with the prefix the next line opened with (a
 * blockquote's `>`, a list item's indentation), so every line around it starts and ends where it did.
 * `<!-- a -->` becomes `<!-- -->`; a comment over three lines inside a quote keeps three quoted lines.
 */
export function emptied(comment: string): string {
  const inner = comment.replace(/^<!--/, '').replace(/-->$/, '');
  const breaks = inner.match(/\n[ \t>]*/g) ?? [];
  // on one line: `<!-- -->`; over several: only the breaks (emptying an emptied comment changes nothing)
  return breaks.length ? `<!--${breaks.join('')}-->` : '<!-- -->';
}

const emptyComments = (s: string) => {
  let out = '';
  let at = 0;
  for (const [a, b] of htmlComments(s)) {
    out += s.slice(at, a) + emptied(s.slice(a, b));
    at = b;
  }
  return out + s.slice(at);
};

/**
 * What a text is made of, the words inside comments aside: every token in order (lists with their tight
 * / loose flag), the exact text of text, code and raw HTML — raw HTML with each comment emptied — and
 * nothing for line endings, indentation prefixes or blank lines between blocks (those are compared through
 * the tokens they make). Nothing is squashed: inside `<pre>` every space and line counts.
 */
function structure(s: string): string {
  const out: string[] = [];
  let skip = 0;
  for (const [k, tok] of events(s)) {
    const slice = () => s.slice(tok.start.offset, tok.end.offset);
    const whole = tok.type === 'htmlFlow' || tok.type === 'htmlText' || tok.type === 'codeFenced' || tok.type === 'codeIndented' || tok.type === 'codeText';
    if (k === 'exit') {
      if (whole) skip--;
      continue;
    }
    if (skip) {
      if (whole) skip++;
      continue;
    }
    if (whole) {
      skip++;
      out.push(`${tok.type}:${tok.type.startsWith('html') ? emptyComments(slice()) : slice()}`);
      continue;
    }
    if (/^(lineEnding|lineEndingBlank|linePrefix|whitespace|blockQuotePrefixWhitespace)$/.test(tok.type)) continue;
    if (tok.type === 'data' || tok.type === 'characterEscapeValue' || tok.type === 'characterReferenceValue') {
      const last = out[out.length - 1];
      if (last?.startsWith('data:')) out[out.length - 1] = last + slice();
      else out.push(`data:${slice()}`);
      continue;
    }
    out.push(tok._spread === undefined ? tok.type : `${tok.type}:${tok._spread}`);
  }
  return JSON.stringify(out);
}

/**
 * `source` with the words inside every HTML comment taken out (hidden markers gone), and every other
 * character where it was: each comment is emptied in place, keeping its line breaks (`emptied`); no line
 * is deleted, no whitespace touched. A comment is one where micromark with GitHub's extensions reads HTML
 * (the same characters in code are code; inside a tag they are an attribute value; a `|` of a table row
 * splits it before it could be one). The result must have the source's token structure — a comment whose
 * words decided where a block of raw HTML ends (a `</pre>` written inside it) would fail that — and is
 * `null` then: the entry is not quoted whole (words selected in it still can be). `''` when nothing but
 * comments and blanks is there; with no comment, `source` itself.
 */
export function withoutHidden(source: string): string | null {
  const cut: [number, number][] = [];
  for (const [k, tok] of events(source)) {
    if (k !== 'enter' || (tok.type !== 'htmlFlow' && tok.type !== 'htmlText')) continue;
    const a = tok.start.offset;
    for (const [x, y] of htmlComments(source.slice(a, tok.end.offset))) cut.push([a + x, a + y]);
  }
  if (!cut.length) return source;
  cut.sort((x, y) => x[0] - y[0]);
  let out = '';
  let at = 0;
  let visible = false;
  for (const [a, b] of cut) {
    const between = source.slice(at, a);
    if (/\S/.test(between)) visible = true;
    out += between + emptied(source.slice(a, b));
    at = b;
  }
  if (/\S/.test(source.slice(at))) visible = true;
  out += source.slice(at);
  if (!visible) return '';
  return structure(out) === structure(source) ? out : null;
}

/** Is there anything to quote at all? */
export function hasWords(text: string): boolean {
  return /\S/.test(text);
}

/**
 * Selected words as markdown that shows exactly them: every character markdown, GitHub's references or
 * HTML could read as syntax is escaped (`[a](b)`, `**b**`, `#12`, `@name`, `:x:`, `<b>`, `&amp;`, list and
 * heading marks…), indentation is kept as non-breaking spaces (not code), and each line ends where it
 * ended (a line break, not one paragraph). Blank lines at the selection's edges are only its edges.
 */
export function selectionMarkdown(text: string): string {
  const lines = trimSelection(text).split('\n');
  return lines
    .map((line, i) => {
      const lead = /^[ \t]*/.exec(line)![0];
      const body = line.slice(lead.length).replace(/[!#$&()*+\-.:<=>@[\\\]^_`{|}~]/g, '\\$&');
      const shown = lead.replace(/\t/g, '    ').replace(/ /g, ' ') + body;
      const next = lines[i + 1];
      // a hard line break when the next line is part of the same block of text
      return shown.trim() && next !== undefined && next.trim() ? `${shown}\\` : shown;
    })
    .join('\n');
}

/**
 * `text` as a quote: `> ` before every line, `>` alone for an empty one. Line breaks of any kind
 * count as one; the text's own last line break does not make an extra line. Blank lines at either
 * end are kept (a source is quoted as it is).
 */
export function quoteText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  return lines.map((l) => (l === '' ? '>' : `> ${l}`)).join('\n');
}

/** Selected words: blank lines at the start and end are only the selection's edges. */
export function trimSelection(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/^(?:[^\S\n]*\n)+/, '')
    .replace(/(?:\n[^\S\n]*)+$/, '');
}

/**
 * The reply box after a quote went in: after what was there, with one blank line between, and a
 * blank line after the quote so the cursor starts a new paragraph (GitHub's own layout).
 */
export function withQuote(current: string, quote: string): string {
  const gap = current === '' || current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  return `${current}${gap}${quote}\n\n`;
}
