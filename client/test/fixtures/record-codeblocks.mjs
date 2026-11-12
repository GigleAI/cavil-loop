#!/usr/bin/env node
// Record how GitHub itself renders code blocks (GitHub#381), for the tests of
// the "copy" / "wrap" buttons and the syntax colours. Run by hand with a
// logged-in `gh`:
//
//   node test/fixtures/record-codeblocks.mjs
//
// Two kinds of sample, both GitHub's own answers, never hand-written:
//   - `samples`: short markdown pieces rendered by GitHub's markdown endpoint
//     (what the reply preview shows), one per kind of block;
//   - `comments`: a real public comment of GigleAI/cavil-loop that carries a
//     block with a language, one without, inline code and task boxes, read
//     through GraphQL (`bodyHTML`, exactly what the discussion shows).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = 'GigleAI/cavil-loop';

const LONG = `echo "${'a long line that does not fit the panel '.repeat(8).trim()}"`;
const SAMPLES = {
  'shell with a language, a long line': `\`\`\`bash\n# stop the timer, then look\nsystemctl --user stop cavil-loop-poll@workloop.timer\n${LONG}\n\`\`\`\n`,
  'typescript: indentation, <, > and &': '```ts\nexport function isUnfolded(i: number, unfold: Unfold): boolean {\n  // newest only\n  if (i < 1 && unfold !== \'none\') return true;\n\treturn unfold === \'all\' || (a > b && c);\n}\n```\n',
  'sql': "```sql\n-- reprint\nselect id, name from quiz_items where print_payload is not null and name = 'x';\n```\n",
  'diff': '```diff\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context\n```\n',
  'json': '```json\n{ "a": [1, true, null], "b": "text" }\n```\n',
  'no language': '```\n⎿  plain output\n    indented    columns\n\nlast line after a blank one\n```\n',
  'indented code': 'text\n\n    four spaces in\n      six\n\nafter\n',
  'inline code only': 'run `npm test` and `npm run typecheck`, nothing else\n',
  'two blocks and inline code': 'first `inline`:\n\n```sh\necho one\n```\n\nthen:\n\n```\ntwo\n```\n',
  'a block inside a list item': '- item\n\n  ```js\n  const x = 1;\n  ```\n- [ ] a box after it\n',
  'raw <pre> written by hand': '<pre>raw   pre\n  second line</pre>\n',
  'a block inside <details>': '<details><summary>log</summary>\n\n```text\nfolded away\n```\n\n</details>\n',
};

/** a public comment with a shell block, a block without a language, inline code and two task boxes (#374) */
const COMMENTS = [6795853087];

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

writeFileSync(join(here, 'codeblocks.github.json'), `${JSON.stringify({ recordedFrom: 'https://api.github.com', repo: REPO, samples, comments }, null, 1)}\n`);
