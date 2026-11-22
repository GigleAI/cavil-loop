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
// A whole entry keeps its markdown; only HTML comments go — a reader never sees them on GitHub (the
// loop's hidden markers, the usage record under a usage fold). Removing one must not change what the
// rest renders to: two blocks a comment kept apart must stay apart, a comment-looking attribute value
// is not a comment. So the result is checked against the parsed structure of the source, and a comment
// whose removal would change it is left as an empty comment instead. Words selected in the discussion
// are plain text: they are escaped so they show exactly as selected, never as a link or emphasis.

import { fromMarkdown } from 'mdast-util-from-markdown';

interface Node {
  type: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: Node[];
  [k: string]: unknown;
}

/** CommonMark: where HTML (and so a comment) starts and ends is the same with GitHub's extensions on */
const parse = (s: string) => fromMarkdown(s) as Node;

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

const stripComments = (s: string) => {
  let out = '';
  let at = 0;
  for (const [a, b] of htmlComments(s)) {
    out += s.slice(at, a);
    at = b;
  }
  return out + s.slice(at);
};

const squash = (s: string) => s.replace(/[ \t\r\n]+/g, ' ');

/** What a text renders to, without positions and without comments: two texts that render the same give the same string. */
function shape(tree: Node): string {
  const walk = (n: Node): unknown => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n)) if (k !== 'position' && k !== 'children') o[k] = v;
    // runs of whitespace in text and raw HTML render as one space (code keeps its own: it is not text)
    if (n.type === 'html') o.value = squash(stripComments(n.value ?? '')).trim();
    if (n.type === 'text') o.value = squash(n.value ?? '');
    if (n.children) {
      const kids: Record<string, unknown>[] = [];
      for (const c of n.children) {
        const w = walk(c) as Record<string, unknown> | null;
        if (!w) continue;
        // a comment taken out of a line joins the text on either side of it
        const last = kids[kids.length - 1];
        if (w.type === 'text' && last?.type === 'text') last.value = squash(String(last.value) + String(w.value));
        else kids.push(w);
      }
      // a block's text starts and ends where its words do
      const head = kids[0];
      const tail = kids[kids.length - 1];
      if (head?.type === 'text') head.value = String(head.value).replace(/^ /, '');
      if (tail?.type === 'text') tail.value = String(tail.value).replace(/ $/, '');
      o.children = kids.filter((k) => k.type !== 'text' || k.value !== '');
    }
    return n.type === 'html' && o.value === '' ? null : o;
  };
  return JSON.stringify(walk(tree));
}

/** a comment left in place, empty: what stands between two blocks when removing the comment would join them */
const PLACEHOLDER = '<!-- -->';

/**
 * `source` without its HTML comments, rendering to exactly what `source` renders to (the comments aside).
 * A comment is taken out where it is a comment for the markdown parser (in HTML, block or inline — the same
 * characters in code are code, and inside an HTML tag they are an attribute value). A line left with
 * nothing but blanks goes whole, and a first / last block of only comments takes the blank lines up to the
 * start / end of the text. Where taking a comment out would change the rest (two paragraphs or two lists it
 * kept apart would become one, a link would form across it), it stays as an empty comment. Nothing else
 * changes: with no comment the result is `source` itself.
 */
export function withoutHidden(source: string): string {
  const tree = parse(source);
  const comments: [number, number][] = [];
  const walk = (n: Node) => {
    if (n.type === 'html') {
      const a = n.position?.start.offset;
      const b = n.position?.end.offset;
      if (a !== undefined && b !== undefined) for (const [x, y] of htmlComments(source.slice(a, b))) comments.push([a + x, a + y]);
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  if (!comments.length) return source;
  const want = shape(tree);
  const blocks = (tree.children ?? []).filter((c) => c.position?.start.offset !== undefined && c.position.end.offset !== undefined);

  /** the text with the comments marked `true` taken out and the others left as an empty comment */
  const build = (out: boolean[], edges: boolean): string => {
    const cut = new Uint8Array(source.length);
    const ph = new Map<number, number>();
    comments.forEach(([a, b], i) => {
      cut.fill(1, a, b);
      if (!out[i]) ph.set(a, b);
    });
    // a line left with blanks only by comments taken out (none left in it) goes whole, with its line break
    for (let start = 0; start < source.length; ) {
      let end = source.indexOf('\n', start);
      if (end < 0) end = source.length;
      let lost = false;
      let left = false;
      for (let i = start; i < end; i++) {
        if (ph.has(i)) left = true;
        if (cut[i]) lost = true;
        else if (!/\s/.test(source[i])) left = true;
      }
      if (lost && !left) cut.fill(1, start, Math.min(end + 1, source.length));
      start = end + 1;
    }
    if (edges) {
      const gone = (c: Node) => {
        for (let i = c.position!.start.offset!; i < c.position!.end.offset!; i++) if (ph.has(i) || (!cut[i] && !/\s/.test(source[i]))) return false;
        return true;
      };
      const kept = blocks.filter((c) => !gone(c));
      if (!kept.length) return '';
      if (gone(blocks[0])) cut.fill(1, 0, source.lastIndexOf('\n', kept[0].position!.start.offset! - 1) + 1);
      if (gone(blocks[blocks.length - 1])) {
        const nl = source.indexOf('\n', kept[kept.length - 1].position!.end.offset!);
        if (nl >= 0) cut.fill(1, nl + 1, source.length);
      }
    }
    let s = '';
    for (let i = 0; i < source.length; i++) {
      const p = ph.get(i);
      if (p !== undefined) {
        s += PLACEHOLDER;
        i = p - 1;
      } else if (!cut[i]) s += source[i];
    }
    return s;
  };
  const same = (s: string) => shape(parse(s)) === want;

  const all = comments.map(() => true);
  const first = build(all, true);
  if (first === '' || same(first)) return first;
  // one at a time: every comment starts as an empty comment and is taken out when that changes nothing
  const out = comments.map(() => false);
  for (let i = 0; i < comments.length; i++) {
    out[i] = true;
    if (!same(build(out, false))) out[i] = false;
  }
  const withEdges = build(out, true);
  return same(withEdges) ? withEdges : build(out, false);
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
