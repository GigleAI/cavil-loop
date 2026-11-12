// Code blocks in GitHub's rendered HTML (GitHub#381): the two buttons each one
// gets in the discussion frame ("wrap" and "copy"), and the styles every place
// that shows GitHub's HTML shares — the frame and the reply preview — so one
// block looks the same in both.
//
// Syntax colours come from GitHub: a fenced block that names its language is
// already rendered with `pl-*` spans; this file only gives those classes
// GitHub's colours. A block without a language has no such spans and stays
// plain — nothing here guesses a language.

const PRE_OPEN = /<pre\b[^>]*>/gi;
const PRE_CLOSE = /<\/pre\s*>/gi;

/** the two buttons of one block; what they do is in FRAME_SCRIPT, by these attributes */
function bar(wrap: boolean): string {
  return `<div class="cbar"><button type="button" class="cbtn" data-code-wrap aria-pressed="${wrap ? 'true' : 'false'}" title="长的一行折到下一行（所有代码块一起切换）">换行</button><button type="button" class="cbtn" data-code-copy title="复制这一块代码">复制</button></div>`;
}

/**
 * GitHub's HTML with every code block (`<pre>`) wrapped in `<div class="cb">`
 * and the two buttons put before it. Inline code is not a block and gets
 * nothing. When the `<pre>` tags do not pair up the HTML is returned as it is:
 * no buttons is better than a wrapper that swallows what follows.
 */
export function annotateCodeBlocks(html: string, wrap = false): string {
  const opens = html.match(PRE_OPEN)?.length ?? 0;
  const closes = html.match(PRE_CLOSE)?.length ?? 0;
  if (!opens || opens !== closes) return html;
  return html.replace(PRE_OPEN, (tag) => `<div class="cb">${bar(wrap)}${tag}`).replace(PRE_CLOSE, (tag) => `${tag}</div>`);
}

/** How many code blocks `annotateCodeBlocks` gives buttons to. */
export function codeBlockCount(html: string): number {
  const opens = html.match(PRE_OPEN)?.length ?? 0;
  return opens === (html.match(PRE_CLOSE)?.length ?? 0) ? opens : 0;
}

/** GitHub's own syntax colours (its "prettylights" set), light and dark. */
function palette(dark: boolean) {
  return dark
    ? { comment: '#9198a1', constant: '#79c0ff', entity: '#d2a8ff', fg: '#f0f6fc', tag: '#7ee787', keyword: '#ff7b72', string: '#a5d6ff', variable: '#ffa657', bad: '#f85149', illFg: '#f0f6fc', illBg: '#8e1519', regexp: '#7ee787', list: '#f2cc60', heading: '#1f6feb', delFg: '#ffdcd7', delBg: '#67060c', insFg: '#aff5b4', insBg: '#033a16', chgFg: '#ffdfb6', chgBg: '#5a1e02', ignFg: '#f0f6fc', ignBg: '#1158c7', range: '#d2a8ff', sub: '#3d444d' }
    : { comment: '#59636e', constant: '#0550ae', entity: '#6639ba', fg: '#1f2328', tag: '#0550ae', keyword: '#cf222e', string: '#0a3069', variable: '#953800', bad: '#82071e', illFg: '#f6f8fa', illBg: '#82071e', regexp: '#116329', list: '#3b2300', heading: '#0550ae', delFg: '#82071e', delBg: '#ffebe9', insFg: '#116329', insBg: '#dafbe1', chgFg: '#953800', chgBg: '#ffd8b5', ignFg: '#d1d9e0', ignBg: '#0550ae', range: '#8250df', sub: '#818b98' };
}

/**
 * The styles of code in GitHub's HTML: inline code, blocks, and the syntax
 * colours. `scope` is put before the element selectors (".md " in the frame,
 * nothing in the reply preview, whose whole body is GitHub's HTML).
 */
export function codeCss(dark: boolean, scope = ''): string {
  const p = palette(dark);
  const inline = dark ? '#212830' : '#eef1f4';
  const canvas = dark ? '#0d1117' : '#f6f8fa';
  return `${scope}code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:${inline};padding:1px 4px;border-radius:4px}
${scope}pre code{background:none;padding:0}
${scope}pre{overflow:auto;background:${canvas};padding:10px;border-radius:6px}
.pl-c,.pl-ba{color:${p.comment}}
.pl-c1,.pl-s .pl-v{color:${p.constant}}
.pl-e,.pl-en{color:${p.entity}}
.pl-smi,.pl-s .pl-s1{color:${p.fg}}
.pl-ent{color:${p.tag}}
.pl-k{color:${p.keyword}}
.pl-s,.pl-pds,.pl-s .pl-pse .pl-s1,.pl-sr,.pl-sr .pl-cce,.pl-sr .pl-sre,.pl-sr .pl-sra{color:${p.string}}
.pl-v,.pl-smw{color:${p.variable}}
.pl-bu{color:${p.bad}}
.pl-ii{color:${p.illFg};background-color:${p.illBg}}
.pl-c2{color:${p.illFg};background-color:${p.keyword}}
.pl-sr .pl-cce{font-weight:bold;color:${p.regexp}}
.pl-ml{color:${p.list}}
.pl-mh,.pl-mh .pl-en,.pl-ms{font-weight:bold;color:${p.heading}}
.pl-mi{font-style:italic;color:${p.fg}}
.pl-mb{font-weight:bold;color:${p.fg}}
.pl-md{color:${p.delFg};background-color:${p.delBg}}
.pl-mi1{color:${p.insFg};background-color:${p.insBg}}
.pl-mc{color:${p.chgFg};background-color:${p.chgBg}}
.pl-mi2{color:${p.ignFg};background-color:${p.ignBg}}
.pl-mdr{font-weight:bold;color:${p.range}}
.pl-sg{color:${p.sub}}
.pl-corl{text-decoration:underline;color:${p.string}}`;
}
