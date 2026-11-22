// Quote reply (GitHub#653): the reply box takes someone else's words as a `> ` quote, the way
// GitHub's own "Quote reply" does. Every way in goes through the two functions here:
//
// | way in                                   | text                                   | cleaned           | quoted / put in the box |
// |------------------------------------------|----------------------------------------|-------------------|-------------------------|
// | "引用回复" on a body / comment / review   | the entry's markdown source            | `withoutHidden`   | `quoteText` → `withQuote` |
// | "引用回复" or R with words selected       | the words selected in the discussion   | no (shown words)  | `quoteText` → `withQuote` |
//
// The box itself is changed by one function in the detail panel (typing goes through it too).
//
// Cleaning removes one thing only: HTML comments, which a reader never sees on GitHub (the loop's
// hidden markers, the usage record under a usage fold). Everything else stays byte for byte —
// visible folds (the usage summary included), code, blank lines, indentation. Three review rounds
// on #653 found a variant each time something more was cut (whitespace tidying, a usage fold matched
// by its look), so nothing more is.

import { fromMarkdown } from 'mdast-util-from-markdown';

interface Node {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: Node[];
}

/** `<!-->`, `<!--->`, `<!-- … -->` — or an unclosed `<!--`, which runs to the end of its HTML piece */
const COMMENT = /<!--(?:>|->|[\s\S]*?-->|[\s\S]*$)/g;

/**
 * `source` without its HTML comments. Only comments inside what the markdown parser reads as HTML
 * (a block of HTML or inline HTML) are taken out; the same characters inside code are code and stay.
 * What goes with a comment:
 * - a line left with nothing but blanks by it (a comment on a line of its own, or a block of only
 *   comments) goes whole, with its line break;
 * - when the first (or last) top-level block of the text is such a block, the lines between it and
 *   the start (or end) of the text go too — those blank lines belong to no block.
 * Nothing else changes: with no comment the result is `source` itself.
 */
export function withoutHidden(source: string): string {
  const tree = fromMarkdown(source) as Node;
  const cut = new Uint8Array(source.length);
  let any = false;
  const walk = (n: Node) => {
    if (n.type === 'html') {
      const a = n.position?.start.offset;
      const b = n.position?.end.offset;
      if (a !== undefined && b !== undefined) {
        const piece = source.slice(a, b);
        for (const m of piece.matchAll(COMMENT)) {
          cut.fill(1, a + m.index, a + m.index + m[0].length);
          any = true;
        }
      }
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  if (!any) return source;
  // a line that is left with blanks only, and lost something to a comment, goes whole (with its line break)
  let start = 0;
  while (start < source.length) {
    let end = source.indexOf('\n', start);
    if (end < 0) end = source.length;
    let lost = false;
    let left = false;
    for (let i = start; i < end; i++) {
      if (cut[i]) lost = true;
      else if (!/\s/.test(source[i])) left = true;
    }
    if (lost && !left) cut.fill(1, start, Math.min(end + 1, source.length));
    start = end + 1;
  }
  // a first / last top-level block that is gone takes the blank lines up to the start / end of the text
  const blocks = (tree.children ?? []).filter((c) => c.position?.start.offset !== undefined && c.position.end.offset !== undefined);
  const gone = (c: Node) => {
    for (let i = c.position!.start.offset!; i < c.position!.end.offset!; i++) if (!cut[i] && !/\s/.test(source[i])) return false;
    return true;
  };
  const kept = blocks.filter((c) => !gone(c));
  if (!kept.length) return '';
  if (gone(blocks[0])) {
    // up to the line the first kept block starts on (its indentation is part of it)
    const s = kept[0].position!.start.offset!;
    cut.fill(1, 0, source.lastIndexOf('\n', s - 1) + 1);
  }
  if (gone(blocks[blocks.length - 1])) {
    // after the line the last kept block ends on (that line keeps its own line break)
    const e = kept[kept.length - 1].position!.end.offset!;
    const nl = source.indexOf('\n', e);
    if (nl >= 0) cut.fill(1, nl + 1, source.length);
  }
  let out = '';
  for (let i = 0; i < source.length; i++) if (!cut[i]) out += source[i];
  return out;
}

/** Is there anything to quote at all? */
export function hasWords(text: string): boolean {
  return /\S/.test(text);
}

/**
 * `text` as a quote: `> ` before every line, `>` alone for an empty one. Line breaks of any kind
 * count as one; the text's own last line break does not make an extra line. Blank lines at either
 * end are kept (a source is quoted as it is) — `trimSelection` is only for selected words.
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
