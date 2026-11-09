#!/usr/bin/env node
// Re-record the GitHub response fixtures from the real `cavil project`
// (GigleAI Project #11) and the GigleAI/cavil-loop repository, then scrub
// them. Run by hand with a logged-in `gh`:
//
//   node test/fixtures/record.mjs
//
// What is kept: the exact response *shape* (field names, nesting, typenames,
// pagination, iteration configuration, label names, open/closed/merged state,
// dates, saved views). Titles are kept for items of public repositories
// (anyone can read them on github.com, and the filter parity test needs the
// real text); items of any other repository get a placeholder title. What is
// replaced: logins, bodies, node ids and cursors (stable per-run mapping so
// cross-references stay consistent).
//
// It also records GitHub's own server-side filter (`items(query:)`) for every
// query in FILTER_QUERIES, in the same run, so the client's local filter can
// be compared item by item against what GitHub returned for the same data
// (cavil-project-11.filters.json).
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
const publicRepos = new Map();
const isPublic = (nameWithOwner) => {
  if (!publicRepos.has(nameWithOwner)) {
    let vis = 'unknown';
    try {
      vis = gh(['api', `repos/${nameWithOwner}`]).visibility;
    } catch {
      /* unreadable = not public */
    }
    publicRepos.set(nameWithOwner, vis === 'public');
  }
  return publicRepos.get(nameWithOwner);
};
// logins inside a saved filter / a recorded query (`assignee:luosky`, `author:a,b`)
const scrubQueryLogins = (q) =>
  (q ?? '').replace(/\b(assignee|author):([^\s]+)/gi, (_, f, v) =>
    `${f}:${v.split(',').map((x) => (x.startsWith('@') || !x ? x : scrubLogin(x.replace(/"/g, '')))).join(',')}`,
  );

/** only the "Closes / Fixes / Resolves / Refs #N" words of a private description (GitHub#275) */
const scrubBody = (b) => (b.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\s+(?:[\w.-]+\/[\w.-]+)?#\d+\b/gi) ?? []).join('\n');

function scrubContent(c) {
  if (!c) return c;
  if (c.__typename === 'DraftIssue') return { ...c, title: 'Draft fixture' };
  return {
    ...c,
    ...(c.id ? { id: scrubId(c.__typename === 'PullRequest' ? 'PR' : 'I', c.id) } : {}),
    title: isPublic(c.repository.nameWithOwner) ? c.title : scrubTitle(c.number, c.__typename),
    assignees: { nodes: c.assignees.nodes.map((a) => ({ login: scrubLogin(a.login) })) },
    author: c.author ? { login: scrubLogin(c.author.login) } : c.author,
    // GitHub#275: a PR's description says which issues it names; private repositories keep only those words
    ...(typeof c.body === 'string' ? { body: isPublic(c.repository.nameWithOwner) ? c.body : scrubBody(c.body) } : {}),
  };
}

const recordedAt = new Date().toISOString();
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
  views: { nodes: p.views.nodes.map((v) => ({ ...v, filter: v.filter == null ? v.filter : scrubQueryLogins(v.filter) })) },
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
        'Recorded from GigleAI Project #11 ("cavil project") with test/fixtures/record.mjs; logins, node ids and cursors scrubbed, titles kept for public repositories. Each element is one GraphQL page of organization.projectV2.',
      recordedAt,
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
  node_id: scrubId(x.pull_request ? 'PR' : 'I', x.node_id),
  title: x.title,
  state: x.state,
  html_url: x.html_url,
  updated_at: x.updated_at,
  labels: x.labels.map((l) => ({ name: l.name, color: l.color })),
  assignees: x.assignees.map((a) => ({ login: scrubLogin(a.login) })),
  milestone: x.milestone ? { number: x.milestone.number, title: x.milestone.title, due_on: x.milestone.due_on } : null,
  user: x.user ? { login: scrubLogin(x.user.login) } : null,
  parent_issue_url: x.parent_issue_url ?? null,
  sub_issues_summary: x.sub_issues_summary ?? null,
  ...(x.pull_request ? { pull_request: { html_url: x.pull_request.html_url, merged_at: x.pull_request.merged_at }, body: x.body ?? null } : {}),
});
writeFileSync(
  join(here, 'cavil-loop.issues.json'),
  JSON.stringify(
    {
      _note:
        'Recorded from GET /repos/GigleAI/cavil-loop/issues?state=all&sort=updated with test/fixtures/record.mjs; only fields the client reads are kept, logins scrubbed (the repository is public, titles are kept).',
      recordedAt,
      issues: rest.map(keep),
    },
    null,
    1,
  ) + '\n',
);
// ---- GitHub's server-side filter on the same board, same run --------------
// Values that depend on the data (an iteration title, a login) are picked
// from the pages just read so the queries keep meaning something after a
// re-record. Logins go through the same scrub as the pages.
const nodes = pages.flatMap((p) => p.items.nodes).filter((n) => n.content && n.content.__typename !== 'DraftIssue');
const tally = (xs) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1]).map(([k]) => k);
const iterTitles = tally(nodes.map((n) => n.fieldValues.nodes.find((v) => v.iterationId)?.title).filter(Boolean));
const assignees = tally(nodes.flatMap((n) => n.content.assignees.nodes.map((a) => a.login)));
const authors = tally(nodes.map((n) => n.content.author?.login).filter(Boolean));
const q = (s) => (/\s|,/.test(s) ? `"${s}"` : s);
const FILTER_QUERIES = [
  'label:pending/human',
  '-label:Done',
  'label:pending/human,pending/agent',
  '-label:Done,pending/PR',
  'label:"pending/human"',
  'no:label',
  'has:label',
  'label:done',
  'Label:Done',
  'status:Done',
  '-status:Done',
  'status:"In progress"',
  'status:"In review",Backlog',
  'no:status',
  'status:done',
  'iteration:@current',
  'iteration:@next',
  'iteration:@previous',
  '-iteration:@current',
  `iteration:${q(iterTitles[0])}`,
  `iteration:${q(iterTitles[0])},${q(iterTitles[1])}`,
  'no:iteration',
  'has:iteration',
  `iteration:${q(iterTitles[0].toLowerCase())}`,
  'no:milestone',
  'milestone:"v1"',
  'assignee:@me',
  `assignee:${assignees[0]}`,
  'no:assignee',
  'has:assignee',
  `author:${authors[0]}`,
  `-author:${authors[0]}`,
  'author:@me',
  'repo:GigleAI/cavil-loop',
  'is:open',
  'is:closed',
  'is:merged',
  'is:issue',
  'is:pr',
  '-is:pr',
  'is:open is:pr',
  'is:open,merged',
  '-is:closed',
  '-label:Done -status:Done',
  'is:open label:pending/human',
  'autopilot',
  'Autopilot',
  'review gate',
  '"review gate"',
  'pending',
  '135',
  '#135',
  'is:pr 140',
  '客户端',
];
const filterResults = [];
for (const query of FILTER_QUERIES) {
  const keys = [];
  let cur = null;
  for (;;) {
    const args = [
      'api', 'graphql',
      '-f', `query=query($q: String!, $after: String) { organization(login: "GigleAI") { projectV2(number: 11) { items(first: 100, after: $after, query: $q) { pageInfo { hasNextPage endCursor } nodes { isArchived content { __typename ... on Issue { number repository { nameWithOwner } } ... on PullRequest { number repository { nameWithOwner } } } } } } } }`,
      '-f', `q=${query}`,
    ];
    if (cur) args.push('-f', `after=${cur}`);
    const r = gh(args);
    if (r.errors) throw new Error(`${query}: ${JSON.stringify(r.errors)}`);
    const it = r.data.organization.projectV2.items;
    for (const n of it.nodes) {
      if (n.isArchived || !n.content || n.content.__typename === 'DraftIssue') continue;
      keys.push(`${n.content.repository.nameWithOwner.toLowerCase()}#${n.content.number}`);
    }
    if (!it.pageInfo.hasNextPage) break;
    cur = it.pageInfo.endCursor;
  }
  filterResults.push({ query: scrubQueryLogins(query), server: keys.sort() });
}
writeFileSync(
  join(here, 'cavil-project-11.filters.json'),
  JSON.stringify(
    {
      _note:
        "GitHub's own server-side filter (ProjectV2.items(query:)) on GigleAI Project #11, recorded by test/fixtures/record.mjs in the same run as cavil-project-11.pages.json. `server` = item keys GitHub returned (archived and draft items dropped, as the client does). Logins in queries are scrubbed with the same mapping as the pages; `viewer` is the scrubbed login @me resolved to.",
      recordedAt,
      viewer: scrubLogin(gh(['api', 'user']).login),
      results: filterResults,
    },
    null,
    1,
  ) + '\n',
);

console.log(`project pages: ${pages.length}, items: ${pages.reduce((n, p) => n + p.items.nodes.length, 0)}, rest issues: ${rest.length}`);
