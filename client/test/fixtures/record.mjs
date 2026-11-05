#!/usr/bin/env node
// Re-record the GitHub response fixtures from the real `cavil project`
// (GigleAI Project #11) and the GigleAI/cavil-loop repository, then scrub
// them. Run by hand with a logged-in `gh`:
//
//   node test/fixtures/record.mjs
//
// What is kept: the exact response *shape* (field names, nesting, typenames,
// pagination, iteration configuration, label names, open/closed/merged state,
// dates). What is replaced: titles, logins, bodies, node ids and cursors
// (stable per-run mapping so cross-references stay consistent).
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../src/data/queries.ts'), 'utf8');
const contentFields = src.match(/const CONTENT_FIELDS = `([\s\S]*?)`;/)[1];
const query = src
  .match(/PROJECT_ITEMS_QUERY = `([\s\S]*?)\n`;/)[1]
  .replace('${CONTENT_FIELDS}', contentFields);

function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20 }));
}

const ids = new Map();
const scrubId = (prefix, v) => {
  if (!ids.has(v)) ids.set(v, `${prefix}_fixture_${createHash('sha256').update(v).digest('hex').slice(0, 12)}`);
  return ids.get(v);
};
const logins = new Map();
const scrubLogin = (l) => {
  if (!logins.has(l)) logins.set(l, `user-${logins.size + 1}`);
  return logins.get(l);
};
// Keep one CJK sample per title so search / rendering paths see real scripts.
const scrubTitle = (n, kind) => `${kind === 'PullRequest' ? '示例 PR' : '示例 issue'} ${n}：fixture title`;

function scrubContent(c) {
  if (!c) return c;
  if (c.__typename === 'DraftIssue') return { ...c, title: 'Draft fixture' };
  return {
    ...c,
    title: scrubTitle(c.number, c.__typename),
    assignees: { nodes: c.assignees.nodes.map((a) => ({ login: scrubLogin(a.login) })) },
  };
}

const pages = [];
let after = null;
for (;;) {
  const args = ['api', 'graphql', '-f', `query=${query}`, '-f', 'owner=GigleAI', '-F', 'number=11', '-F', 'isOrg=true'];
  if (after) args.push('-f', `after=${after}`);
  const r = gh(args);
  if (r.errors) throw new Error(JSON.stringify(r.errors));
  const p = r.data.organization.projectV2;
  pages.push(p);
  if (!p.items.pageInfo.hasNextPage) break;
  after = p.items.pageInfo.endCursor;
}

const scrubbedPages = pages.map((p, i) => ({
  ...p,
  id: scrubId('PVT', p.id),
  fields: {
    nodes: p.fields.nodes.map((f) => (f.id ? { ...f, id: scrubId('PVTF', f.id) } : f)),
  },
  items: {
    ...p.items,
    pageInfo: {
      hasNextPage: p.items.pageInfo.hasNextPage,
      endCursor: p.items.pageInfo.endCursor ? `cursor-${i + 1}` : null,
    },
    nodes: p.items.nodes.map((it) => ({
      ...it,
      id: scrubId('PVTI', it.id),
      fieldValues: {
        nodes: it.fieldValues.nodes.map((v) =>
          v.field && v.field.id ? { ...v, field: { ...v.field, id: scrubId('PVTF', v.field.id) } } : v,
        ),
      },
      content: scrubContent(it.content),
    })),
  },
}));

writeFileSync(
  join(here, 'cavil-project-11.pages.json'),
  JSON.stringify(
    {
      _note:
        'Recorded from GigleAI Project #11 ("cavil project") with test/fixtures/record.mjs; titles, logins, node ids and cursors scrubbed. Each element is one GraphQL page of organization.projectV2.',
      recordedAt: new Date().toISOString(),
      pages: scrubbedPages,
    },
    null,
    1,
  ) + '\n',
);

// REST: a slice of the repository issue list (state=all, sorted by update) —
// enough to pin the shape the repo source reads (pull_request.merged_at etc.).
const rest = gh(['api', 'repos/GigleAI/cavil-loop/issues?state=all&per_page=40&sort=updated&direction=desc']);
const keep = (x) => ({
  number: x.number,
  title: scrubTitle(x.number, x.pull_request ? 'PullRequest' : 'Issue'),
  state: x.state,
  html_url: x.html_url,
  updated_at: x.updated_at,
  labels: x.labels.map((l) => ({ name: l.name, color: l.color })),
  assignees: x.assignees.map((a) => ({ login: scrubLogin(a.login) })),
  milestone: x.milestone ? { number: x.milestone.number, title: x.milestone.title, due_on: x.milestone.due_on } : null,
  ...(x.pull_request ? { pull_request: { html_url: x.pull_request.html_url, merged_at: x.pull_request.merged_at } } : {}),
});
writeFileSync(
  join(here, 'cavil-loop.issues.json'),
  JSON.stringify(
    {
      _note:
        'Recorded from GET /repos/GigleAI/cavil-loop/issues?state=all&sort=updated with test/fixtures/record.mjs; only fields the client reads are kept, titles and logins scrubbed.',
      recordedAt: new Date().toISOString(),
      issues: rest.map(keep),
    },
    null,
    1,
  ) + '\n',
);
console.log(`project pages: ${pages.length}, items: ${pages.reduce((n, p) => n + p.items.nodes.length, 0)}, rest issues: ${rest.length}`);
