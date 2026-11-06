#!/usr/bin/env node
// Record how GitHub itself renders task-list boxes (GitHub#193), for the test
// that compares the client's reading of the markdown source box for box with
// GitHub's rendering. Run by hand with a logged-in `gh`:
//
//   node test/fixtures/record-tasklists.mjs
//
// Two kinds of sample, both GitHub's own answers, never hand-written:
//   - `samples`: short markdown pieces rendered by GitHub's markdown endpoint
//     (the same renderer as comments), one per tricky placement of `- [ ]`;
//   - `comments`: real public comments of GigleAI/cavil-loop that carry choice
//     questions, read through GraphQL (`body` + `bodyHTML`, exactly what the
//     client reads).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = 'GigleAI/cavil-loop';

const SAMPLES = {
  'plain list, lower and upper x': '- [ ] **A. one**\n- [x] B two\n- [X] C three\n',
  'ordered list': '1. [ ] first\n2. [x] second\n10) [ ] paren marker\n',
  'nested under a task': '- [ ] parent\n  - [x] child\n    - [ ] grandchild\n',
  'nested under a plain item': '- plain\n  - [ ] inner\n',
  'fenced code block is not a box': '- [ ] real\n\n```\n- [ ] in code\n```\n\n- [x] real too\n',
  'tilde fence and indented code are not boxes': '~~~md\n- [ ] in tilde fence\n~~~\n\n    - [ ] indented code\n\n- [ ] real\n',
  'inside <details> after a blank line': '<details><summary>s</summary>\n\n- [ ] inside details\n- [x] also inside\n\n</details>\n',
  'inside <details> without a blank line is raw HTML': '<details><summary>s</summary>\n- [ ] raw html line\n</details>\n\n- [ ] after\n',
  'HTML comment is not a box': '<!-- - [ ] hidden -->\n- [ ] shown\n',
  'block quote': '> - [ ] quoted\n> - [x] quoted 2\n',
  'table cell is not a box': '| a |\n|---|\n| - [ ] cell |\n\n- [ ] after table\n',
  'no space after ] or empty item': '- [ ]no space\n- [ ]\n- [ ] \n- [ ] real\n',
  'five spaces after marker': '-     [ ] indented code inside item\n- [ ] real\n',
  'CRLF line endings': '- [ ] one\r\n- [x] two\r\n',
  'box text with brackets and code': '- [ ] uses `[x]` in code\n- [ ] link [x](https://github.com)\n',
  'star and plus markers': '* [ ] star\n+ [x] plus\n',
  'tab after marker': '-\t[ ] tab\n',
  'choice question as the templates write it': '**Q1: 一句话问题**（默认 A —— 理由）\n\n- [ ] **A. 选项 A** — 效果\n  - 好处：x\n  - 代价：y\n- [ ] **B. 选项 B** — 效果\n  - 好处：x\n  - 代价：y\n\n不勾会怎样：按 A 走\n',
};

/** public comments with choice questions: this issue's first proposal, and one the maintainer ticked on the web (#151) */
const COMMENTS = [6685180266, 6669513385];

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 64 << 20 });
}

const samples = {};
for (const [name, text] of Object.entries(SAMPLES)) {
  const html = gh(['api', '-X', 'POST', '/markdown', '--input', '-'], JSON.stringify({ text, mode: 'gfm', context: REPO }));
  samples[name] = { markdown: text, html };
}

const comments = [];
for (const id of COMMENTS) {
  const nodeId = JSON.parse(gh(['api', `repos/${REPO}/issues/comments/${id}`])).node_id;
  const q = 'query($id:ID!){node(id:$id){... on IssueComment{url body bodyHTML}}}';
  const n = JSON.parse(gh(['api', 'graphql', '-f', `query=${q}`, '-f', `id=${nodeId}`])).data.node;
  comments.push({ url: n.url, body: n.body, bodyHTML: n.bodyHTML });
}

writeFileSync(join(here, 'tasklists.github.json'), `${JSON.stringify({ recordedFrom: 'https://api.github.com', repo: REPO, samples, comments }, null, 1)}\n`);
console.log(`recorded ${Object.keys(samples).length} samples, ${comments.length} comments`);
