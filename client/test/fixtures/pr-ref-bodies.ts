// GitHub#275 (PR #278 review rounds 1–2): PR descriptions and the issues they name in prose,
// one list for every check of that rule — the parser's unit tests, the three ways an item is
// built (Project page, repository list, single re-read), and the browser cross-check that
// renders each description and reads only what a reader sees (test/e2e/pr-ref-prose.spec.ts).
// `refs`: issue numbers of the repository `o/r`, in order; the PR itself is #99.

const T = '`';

export interface RefCase {
  why: string;
  body: string;
  refs: number[];
}

export const REF_CASES: RefCase[] = [
  { why: 'plain prose', body: 'Refs #6', refs: [6] },
  { why: 'every keyword form, in order, once', body: 'closes #1\nFixed #2 and RESOLVES #3; ref #4\nfixes   #5 resolved #6 close #7 refs #1', refs: [1, 2, 3, 4, 5, 6, 7] },
  { why: 'no keyword, or a word that only ends in one', body: 'see #5, follow-ups to #47; prefs #3 hotfixes #4 unrefs #5', refs: [] },
  { why: 'the PR itself', body: 'Refs #99', refs: [] },
  { why: 'an indented code block', body: 'Intro\n\n    Refs #5\n\nRefs #6', refs: [6] },
  { why: 'a fenced block', body: '```\nCloses #5\n```\n~~~md\nfixes #7\n~~~\nRefs #6', refs: [6] },
  { why: 'a four-backtick fence holding a three-backtick line', body: [T.repeat(4) + 'md', T.repeat(3), 'Refs #5', T.repeat(4), 'Refs #6'].join('\n'), refs: [6] },
  { why: 'a fence never closed hides the rest', body: 'Refs #1\n```\nRefs #2', refs: [1] },
  { why: 'inline code, also with a backtick inside', body: `${T}Refs #5${T} and ${T}${T}a ${T} Refs #7${T}${T} Refs #6`, refs: [6] },
  { why: 'a comment on its own lines', body: '<!--\nRefs #5\n-->\nRefs #6', refs: [6] },
  { why: 'a comment inside a sentence', body: 'Refs #6 and <!-- closes #7 --> fixes #8', refs: [6, 8] },
  { why: 'a comment, then prose on the same line', body: '<!-- note --> Refs #5', refs: [5] },
  { why: 'empty comments end at once', body: '<!-->Refs #5\n\n<!--->Refs #6', refs: [5, 6] },
  { why: 'a comment inside a div', body: '<div>\n<!-- Refs #5 -->\n</div>\n\nRefs #6', refs: [6] },
  { why: 'a comment inside a details', body: '<details>\n<!-- Refs #5 -->\n</details>', refs: [] },
  { why: 'a comment never closed hides the rest', body: '<div>\n<!-- open\nRefs #5\n</div>\n\nRefs #6', refs: [] },
  { why: 'prose inside a div counts', body: '<div>Refs #5</div>', refs: [5] },
  { why: 'an attribute value is not prose', body: '<div title="Refs #5">x</div> Refs #6', refs: [6] },
  { why: 'a tag between the keyword and the number', body: 'x <span>Refs</span> #5', refs: [5] },
  { why: 'a folded section (the autopilot summary) is prose', body: '<!-- autopilot-summary:begin -->\n<details><summary>背景</summary>\n\nRefs #5\n\n</details>\n<!-- autopilot-summary:end -->', refs: [5] },
  { why: 'a raw pre block', body: '<pre>\nRefs #5\n</pre>\n\nRefs #6', refs: [6] },
  { why: 'a raw script is shown as text on GitHub (its tag is filtered)', body: '<script>\nRefs #7\n</script>', refs: [7] },
  { why: 'raw inline code', body: 'a <code>Refs #5</code> b <kbd>fixes #7</kbd> Refs #6', refs: [6] },
  { why: 'raw code opened and closed across paragraphs', body: '<div><code>\n\nRefs #5\n\n</code></div>\n\nRefs #6', refs: [6] },
  { why: 'list items and quotes are prose', body: '- Refs #5\n> closes #6', refs: [5, 6] },
];

/** the keys another-repository case names (kept apart: `refs` are numbers of o/r) */
export const OTHER_REPO_CASE = { body: 'Refs Other/Repo#12, closes x.y/z-w#3', keys: ['other/repo#12', 'x.y/z-w#3'] };
