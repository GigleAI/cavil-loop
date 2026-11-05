// The fake GitHub's writable side (sub-item #138): labels, milestones,
// comments, Project fields, adding to a Project, merging / closing PRs,
// creating issues, plus the reads that go with them (one-item re-read, the
// detail page, label / milestone lists, the markdown renderer).
//
// An issue / PR can exist in two shapes at once — a REST issue (repository
// source) and a GraphQL `content` node inside a Project page. Every write is
// applied to every copy, so whichever read comes next sees the change.
// `digest()` serialises everything writable: "GitHub changed nothing" is
// asserted as an unchanged digest.

import { createHash } from 'node:crypto';

export interface FakePull {
  headOid: string;
  isDraft: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  reviewDecision: string | null;
  checks: string | null;
  /** GitHub refuses the merge with this (status + message), e.g. checks failing / branch protection */
  mergeRefusal: { status: number; message: string } | null;
}

export interface FakeComment {
  id: string;
  url: string;
  createdAt: string;
  bodyHTML: string;
  author: { login: string } | null;
}

export interface FakeReview {
  id: string;
  url: string;
  state: string;
  submittedAt: string | null;
  createdAt: string;
  bodyHTML: string;
  author: { login: string } | null;
  comments: { totalCount: number; nodes: (FakeComment & { path: string; line: number | null; originalLine: number | null })[] };
}

export interface WritableState {
  /** `owner/repo` lower-cased -> the repository's labels */
  repoLabels: Map<string, { name: string; color: string }[]>;
  /** `owner/repo` lower-cased -> milestones */
  milestones: Map<string, { number: number; title: string; state: 'open' | 'closed'; due_on: string | null }[]>;
  /** `owner/repo` lower-cased -> merge methods the repository allows */
  mergeMethods: Map<string, { merge: boolean; squash: boolean; rebase: boolean }>;
  /** `owner/repo#n` lower-cased -> PR state the merge endpoint checks (created on first use) */
  pulls: Map<string, FakePull>;
  /** `owner/repo#n` lower-cased -> comments (oldest first, as GitHub lists them) */
  comments: Map<string, FakeComment[]>;
  /** `owner/repo#n` lower-cased -> reviews */
  reviews: Map<string, FakeReview[]>;
  /** `owner/repo#n` lower-cased -> rendered body */
  bodies: Map<string, string>;
  /** repositories where every write answers 403 (the account has read access only) */
  readOnlyRepos: Set<string>;
  /** Project keys (`org/owner/n`) the account may not change: viewerCanUpdate false, mutations refused */
  readOnlyProjects: Set<string>;
  /** drop the connection of every write request (offline in the middle of a change) */
  dropWrites: boolean;
  /** page size of the detail page's comment / review lists */
  detailPageSize: number;
  /** clock of updated_at / createdAt written by the fake */
  clock: () => string;
}

export function defaultWritable(): WritableState {
  return {
    repoLabels: new Map(),
    milestones: new Map(),
    mergeMethods: new Map(),
    pulls: new Map(),
    comments: new Map(),
    reviews: new Map(),
    bodies: new Map(),
    readOnlyRepos: new Set(),
    readOnlyProjects: new Set(),
    dropWrites: false,
    detailPageSize: 100,
    clock: () => new Date().toISOString(),
  };
}

interface ProjectPage {
  id: string;
  title: string;
  url: string;
  viewerCanUpdate?: boolean;
  fields: { nodes: any[] };
  items: { totalCount: number; pageInfo: any; nodes: any[] };
}

export interface Store {
  projects: Map<string, ProjectPage[]>;
  repos: Map<string, any[]>;
  w: WritableState;
}

export const nodeIdOf = (kind: 'Issue' | 'PullRequest', repo: string, n: number) =>
  `${kind === 'PullRequest' ? 'PR' : 'I'}_fake_${createHash('sha256').update(`${repo.toLowerCase()}#${n}`).digest('hex').slice(0, 12)}`;
export const headOidOf = (repo: string, n: number, gen = 0) =>
  createHash('sha1').update(`${repo.toLowerCase()}#${n}@${gen}`).digest('hex');

/**
 * Fill what the recorded fixtures predate (content node ids, REST node_id):
 * derived, never hand-written into the fixture files.
 */
export function enrich(store: Store): void {
  for (const pages of store.projects.values())
    for (const p of pages)
      for (const n of p.items.nodes) {
        const c = n.content;
        if (c && c.__typename !== 'DraftIssue' && !c.id) c.id = nodeIdOf(c.__typename, c.repository.nameWithOwner, c.number);
      }
  for (const [repo, list] of store.repos)
    for (const r of list) if (!r.node_id) r.node_id = nodeIdOf(r.pull_request ? 'PullRequest' : 'Issue', repo, r.number);
  // the repository's labels: every label any of its items carries
  for (const [repo, list] of store.repos) {
    if (store.w.repoLabels.has(repo)) continue;
    const seen = new Map<string, string>();
    for (const r of list) for (const l of r.labels) seen.set(l.name, l.color);
    for (const pages of store.projects.values())
      for (const p of pages)
        for (const n of p.items.nodes)
          if (n.content?.repository?.nameWithOwner?.toLowerCase() === repo) for (const l of n.content.labels.nodes) seen.set(l.name, l.color);
    store.w.repoLabels.set(repo, [...seen].map(([name, color]) => ({ name, color })));
  }
}

export interface Copies {
  rest: any[];
  gql: any[];
  kind: 'Issue' | 'PullRequest';
  repo: string;
  number: number;
}

export function findCopies(store: Store, repo: string, n: number): Copies | null {
  const key = repo.toLowerCase();
  const rest = (store.repos.get(key) ?? []).filter((r) => r.number === n);
  const gql: any[] = [];
  for (const pages of store.projects.values())
    for (const p of pages)
      for (const node of p.items.nodes) {
        const c = node.content;
        if (c && c.number === n && c.repository?.nameWithOwner?.toLowerCase() === key) gql.push(c);
      }
  if (!rest.length && !gql.length) return null;
  const kind = gql[0]?.__typename ?? (rest[0].pull_request ? 'PullRequest' : 'Issue');
  const repoName = gql[0]?.repository.nameWithOwner ?? repo;
  return { rest, gql, kind, repo: repoName, number: n };
}

function findByNodeId(store: Store, id: string): Copies | null {
  for (const [repo, list] of store.repos) for (const r of list) if (r.node_id === id) return findCopies(store, repo, r.number);
  for (const pages of store.projects.values())
    for (const p of pages)
      for (const n of p.items.nodes) if (n.content?.id === id) return findCopies(store, n.content.repository.nameWithOwner, n.content.number);
  return null;
}

/** The GraphQL shape of an item (from a Project copy if there is one, else built from the REST copy). */
export function gqlContent(c: Copies): any {
  if (c.gql.length) return c.gql[0];
  const r = c.rest[0];
  return {
    __typename: c.kind,
    id: r.node_id,
    number: r.number,
    title: r.title,
    url: r.html_url,
    state: r.state === 'open' ? 'OPEN' : r.pull_request?.merged_at ? 'MERGED' : 'CLOSED',
    ...(c.kind === 'PullRequest' ? { merged: Boolean(r.pull_request?.merged_at) } : {}),
    updatedAt: r.updated_at,
    repository: { nameWithOwner: c.repo },
    labels: { nodes: r.labels.map((l: any) => ({ name: l.name, color: l.color })) },
    assignees: { nodes: (r.assignees ?? []).map((a: any) => ({ login: a.login })) },
    milestone: r.milestone ? { number: r.milestone.number, title: r.milestone.title, dueOn: r.milestone.due_on } : null,
  };
}

function touch(store: Store, c: Copies) {
  const now = store.w.clock();
  for (const r of c.rest) r.updated_at = now;
  for (const g of c.gql) g.updatedAt = now;
}

export function pullOf(store: Store, c: Copies): FakePull {
  const k = `${c.repo.toLowerCase()}#${c.number}`;
  let p = store.w.pulls.get(k);
  if (!p) {
    p = { headOid: headOidOf(c.repo, c.number), isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, checks: 'SUCCESS', mergeRefusal: null };
    store.w.pulls.set(k, p);
  }
  return p;
}

export function digest(store: Store): string {
  const w = store.w;
  return JSON.stringify({
    repos: [...store.repos],
    projects: [...store.projects],
    milestones: [...w.milestones],
    pulls: [...w.pulls],
    comments: [...w.comments],
    labels: [...w.repoLabels],
  });
}

type Send = (status: number, body: unknown) => void;

/** REST writes + reads of #138. Returns false when the path is not one of them. */
export function handleRest(store: Store, method: string, path: string, body: any, send: Send, sendText: (s: string) => void): boolean {
  const w = store.w;
  if (method === 'POST' && path === '/api/markdown') {
    const esc = String(body?.text ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
    sendText(`<p>${esc}</p>`);
    return true;
  }
  const m = path.match(/^\/api\/repos\/([^/]+)\/([^/]+)(\/.*)$/);
  if (!m) return false;
  const repo = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
  const key = repo.toLowerCase();
  const rest = m[3].replace(/\?.*$/, '');
  const known = store.repos.has(key) || [...store.projects.values()].some((pages) => pages.some((p) => p.items.nodes.some((n) => n.content?.repository?.nameWithOwner?.toLowerCase() === key)));
  if (!known) return false;

  if (method === 'GET' && rest === '/labels') return send(200, w.repoLabels.get(key) ?? []), true;
  if (method === 'GET' && rest === '/milestones') return send(200, w.milestones.get(key) ?? []), true;
  if (method === 'GET') return false;

  if (w.readOnlyRepos.has(key)) return send(403, { message: 'Resource not accessible by integration' }), true;

  if (method === 'POST' && rest === '/issues') {
    if (!body?.title) return send(422, { message: 'Validation Failed' }), true;
    let max = 0;
    for (const r of store.repos.get(key) ?? []) max = Math.max(max, r.number);
    for (const pages of store.projects.values()) for (const p of pages) for (const n of p.items.nodes) if (n.content?.repository?.nameWithOwner?.toLowerCase() === key) max = Math.max(max, n.content.number);
    const number = max + 1;
    const colors = new Map((w.repoLabels.get(key) ?? []).map((l) => [l.name, l.color]));
    const issue = {
      number,
      node_id: nodeIdOf('Issue', repo, number),
      title: body.title,
      state: 'open',
      html_url: `https://github.com/${repo}/issues/${number}`,
      updated_at: w.clock(),
      labels: (body.labels ?? []).map((n: string) => ({ name: n, color: colors.get(n) ?? 'ededed' })),
      assignees: [],
      milestone: null,
    };
    if (!store.repos.has(key)) store.repos.set(key, []);
    store.repos.get(key)!.push(issue);
    w.bodies.set(`${key}#${number}`, `<p>${String(body.body ?? '')}</p>`);
    return send(201, issue), true;
  }

  const im = rest.match(/^\/(issues|pulls)\/(\d+)(\/.*)?$/);
  if (!im) return false;
  const c = findCopies(store, repo, Number(im[2]));
  if (!c) return send(404, { message: 'Not Found' }), true;
  const sub = im[3] ?? '';
  const ikey = `${key}#${c.number}`;

  if (im[1] === 'issues' && method === 'POST' && sub === '/labels') {
    const add: string[] = Array.isArray(body?.labels) ? body.labels : [];
    const colors = new Map((w.repoLabels.get(key) ?? []).map((l) => [l.name, l.color]));
    for (const name of add) {
      const color = colors.get(name) ?? 'ededed';
      for (const r of c.rest) if (!r.labels.some((l: any) => l.name === name)) r.labels.push({ name, color });
      for (const g of c.gql) if (!g.labels.nodes.some((l: any) => l.name === name)) g.labels.nodes.push({ name, color });
    }
    touch(store, c);
    return send(200, gqlContent(c).labels.nodes), true;
  }
  if (im[1] === 'issues' && method === 'PUT' && sub === '/labels') {
    // the whole-list replacement: the client must never use it, but GitHub has it
    const all: string[] = Array.isArray(body?.labels) ? body.labels : [];
    const colors = new Map((w.repoLabels.get(key) ?? []).map((l) => [l.name, l.color]));
    const list = () => all.map((name) => ({ name, color: colors.get(name) ?? 'ededed' }));
    for (const r of c.rest) r.labels = list();
    for (const g of c.gql) g.labels.nodes = list();
    touch(store, c);
    return send(200, list()), true;
  }
  const dl = sub.match(/^\/labels\/(.+)$/);
  if (im[1] === 'issues' && method === 'DELETE' && dl) {
    const name = decodeURIComponent(dl[1]);
    if (!gqlContent(c).labels.nodes.some((l: any) => l.name === name)) return send(404, { message: 'Label does not exist' }), true;
    for (const r of c.rest) r.labels = r.labels.filter((l: any) => l.name !== name);
    for (const g of c.gql) g.labels.nodes = g.labels.nodes.filter((l: any) => l.name !== name);
    touch(store, c);
    return send(200, gqlContent(c).labels.nodes), true;
  }
  if (im[1] === 'issues' && method === 'PATCH' && sub === '') {
    if (body && 'milestone' in body) {
      const ms = body.milestone === null ? null : (w.milestones.get(key) ?? []).find((x) => x.number === body.milestone);
      if (body.milestone !== null && !ms) return send(422, { message: 'Validation Failed: milestone does not exist' }), true;
      for (const r of c.rest) r.milestone = ms ? { number: ms.number, title: ms.title, due_on: ms.due_on } : null;
      for (const g of c.gql) g.milestone = ms ? { number: ms.number, title: ms.title, dueOn: ms.due_on } : null;
    }
    touch(store, c);
    return send(200, { number: c.number }), true;
  }
  if (im[1] === 'issues' && method === 'POST' && sub === '/comments') {
    const list = w.comments.get(ikey) ?? [];
    const id = `IC_fake_${list.length + 1}_${c.number}`;
    list.push({ id, url: `https://github.com/${c.repo}/issues/${c.number}#issuecomment-${list.length + 1}`, createdAt: w.clock(), bodyHTML: `<p>${String(body?.body ?? '')}</p>`, author: { login: 'user-1' } });
    w.comments.set(ikey, list);
    touch(store, c);
    return send(201, { id }), true;
  }
  if (im[1] === 'pulls' && c.kind !== 'PullRequest') return send(404, { message: 'Not Found' }), true;
  if (im[1] === 'pulls' && method === 'PUT' && sub === '/merge') {
    const pr = pullOf(store, c);
    const g = gqlContent(c);
    if (g.state !== 'OPEN') return send(405, { message: 'Pull Request is not mergeable' }), true;
    const allowed = w.mergeMethods.get(key) ?? { merge: true, squash: true, rebase: true };
    const method = body?.merge_method ?? 'merge';
    if (!(allowed as any)[method]) return send(405, { message: `${method} merges are not allowed on this repository.` }), true;
    if (body?.sha !== undefined && body.sha !== pr.headOid) return send(409, { message: 'Head branch was modified. Review and try the merge again.' }), true;
    if (pr.mergeRefusal) return send(pr.mergeRefusal.status, { message: pr.mergeRefusal.message }), true;
    for (const r of c.rest) {
      r.state = 'closed';
      r.pull_request = { ...(r.pull_request ?? {}), merged_at: w.clock() };
    }
    for (const x of c.gql) {
      x.state = 'MERGED';
      x.merged = true;
    }
    touch(store, c);
    return send(200, { merged: true, sha: pr.headOid }), true;
  }
  if (im[1] === 'pulls' && method === 'PATCH' && sub === '') {
    if (body?.state === 'closed') {
      for (const r of c.rest) r.state = 'closed';
      for (const x of c.gql) if (x.state === 'OPEN') x.state = 'CLOSED';
    }
    touch(store, c);
    return send(200, { number: c.number }), true;
  }
  return false;
}

function projectByNodeId(store: Store, id: string): { key: string; pages: ProjectPage[] } | null {
  for (const [key, pages] of store.projects) if (pages[0]?.id === id) return { key, pages };
  return null;
}

type GqlAnswer = { data?: unknown; errors?: { message: string; type?: string }[] };

/** GraphQL operations of #138 (mutations, one-item re-read, detail). Returns null when `op` is not one of them. */
export function handleGraphql(store: Store, op: string | undefined, v: Record<string, any>): GqlAnswer | null {
  const w = store.w;
  const err = (message: string, type?: string): GqlAnswer => ({ errors: [{ message, ...(type ? { type } : {}) }] });
  const writable = (key: string) => !w.readOnlyProjects.has(key);

  if (op === 'CavilAddProjectItem' || op === 'CavilSetIteration' || op === 'CavilSetStatus' || op === 'CavilClearField') {
    const proj = projectByNodeId(store, v.projectId);
    if (!proj) return err(`Could not resolve to a node with the global id of '${v.projectId}'`, 'NOT_FOUND');
    if (!writable(proj.key)) return err('Resource not accessible by integration', 'FORBIDDEN');
    const nodes = proj.pages.flatMap((p) => p.items.nodes);
    if (op === 'CavilAddProjectItem') {
      const c = findByNodeId(store, v.contentId);
      if (!c) return err(`Could not resolve to a node with the global id of '${v.contentId}'`, 'NOT_FOUND');
      const existing = nodes.find((n) => n.content?.repository?.nameWithOwner?.toLowerCase() === c.repo.toLowerCase() && n.content.number === c.number);
      if (existing) return { data: { addProjectV2ItemById: { item: { id: existing.id } } } };
      const id = `PVTI_fake_${createHash('sha256').update(`${proj.key}|${v.contentId}`).digest('hex').slice(0, 12)}`;
      // a fresh GraphQL copy, so later writes reach it too
      const content = JSON.parse(JSON.stringify(gqlContent(c)));
      const last = proj.pages[proj.pages.length - 1];
      last.items.nodes.push({ id, isArchived: false, fieldValues: { nodes: [] }, content });
      for (const p of proj.pages) p.items.totalCount++;
      return { data: { addProjectV2ItemById: { item: { id } } } };
    }
    const node = nodes.find((n) => n.id === v.itemId);
    if (!node) return err(`Could not resolve to a node with the global id of '${v.itemId}'`, 'NOT_FOUND');
    const field = proj.pages[0].fields.nodes.find((f: any) => f.id === v.fieldId);
    if (!field) return err('The field does not exist', 'NOT_FOUND');
    const others = node.fieldValues.nodes.filter((x: any) => x.field?.id !== v.fieldId);
    if (op === 'CavilClearField') node.fieldValues.nodes = others;
    else if (op === 'CavilSetIteration') {
      if (field.__typename !== 'ProjectV2IterationField') return err('The field is not an iteration field');
      const it = [...field.configuration.iterations, ...field.configuration.completedIterations].find((x: any) => x.id === v.iterationId);
      if (!it) return err('The iteration does not exist');
      node.fieldValues.nodes = [...others, { __typename: 'ProjectV2ItemFieldIterationValue', iterationId: it.id, title: it.title, startDate: it.startDate, duration: it.duration, field: { id: field.id, name: field.name } }];
    } else {
      if (field.__typename !== 'ProjectV2SingleSelectField') return err('The field is not a single select field');
      const o = field.options.find((x: any) => x.id === v.optionId);
      if (!o) return err('The option does not exist');
      node.fieldValues.nodes = [...others, { __typename: 'ProjectV2ItemFieldSingleSelectValue', optionId: o.id, name: o.name, field: { id: field.id, name: field.name } }];
    }
    return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: node.id } }, clearProjectV2ItemFieldValue: { projectV2Item: { id: node.id } } } };
  }

  if (op === 'CavilItemRefresh' || op === 'CavilItemDetail') {
    const c = findCopies(store, `${v.owner}/${v.name}`, v.number);
    if (!c) return { data: { repository: { issueOrPullRequest: null } }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to an issue or pull request with the number of ${v.number}.` }] };
    const content = gqlContent(c);
    const ikey = `${c.repo.toLowerCase()}#${c.number}`;
    if (op === 'CavilItemRefresh') {
      const projectItems: any[] = [];
      for (const pages of store.projects.values())
        for (const p of pages)
          for (const n of p.items.nodes)
            if (n.content?.repository?.nameWithOwner?.toLowerCase() === c.repo.toLowerCase() && n.content.number === c.number)
              projectItems.push({ id: n.id, isArchived: n.isArchived, project: { id: p.id }, fieldValues: n.fieldValues });
      return { data: { repository: { issueOrPullRequest: { ...content, projectItems: { nodes: projectItems } } } } };
    }
    const size = w.detailPageSize;
    const pageOf = <T,>(list: T[], after: string | null) => {
      const start = after ? Number(after.replace(/^c-/, '')) : 0;
      const nodes = list.slice(start, start + size);
      const end = start + nodes.length;
      return { pageInfo: { hasNextPage: end < list.length, endCursor: nodes.length ? `c-${end}` : null }, nodes };
    };
    const isPr = c.kind === 'PullRequest';
    const pr = isPr ? pullOf(store, c) : null;
    const allowed = w.mergeMethods.get(c.repo.toLowerCase()) ?? { merge: true, squash: true, rebase: true };
    const item: any = {
      __typename: c.kind,
      id: content.id,
      number: c.number,
      title: content.title,
      url: content.url,
      state: content.state,
      createdAt: '2026-01-01T00:00:00Z',
      bodyHTML: w.bodies.get(ikey) ?? '<p>fixture body</p>',
      author: { login: 'user-1' },
      labels: content.labels,
    };
    if (v.withComments) item.comments = pageOf(w.comments.get(ikey) ?? [], v.commentsAfter ?? null);
    if (isPr) {
      Object.assign(item, {
        merged: Boolean(content.merged),
        isDraft: pr!.isDraft,
        mergeable: pr!.mergeable,
        mergeStateStatus: pr!.mergeStateStatus,
        reviewDecision: pr!.reviewDecision,
        headRefOid: pr!.headOid,
        baseRefName: 'main',
        headRefName: `feature/issue-${c.number}`,
        commits: { nodes: [{ commit: { oid: pr!.headOid, statusCheckRollup: pr!.checks ? { state: pr!.checks } : null } }] },
      });
      if (v.withReviews) item.reviews = pageOf(w.reviews.get(ikey) ?? [], v.reviewsAfter ?? null);
    }
    return { data: { repository: { mergeCommitAllowed: allowed.merge, squashMergeAllowed: allowed.squash, rebaseMergeAllowed: allowed.rebase, issueOrPullRequest: item } } };
  }
  return null;
}
