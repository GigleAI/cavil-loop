// Read one source (a Project or a repository) completely, or throw.
// A source is all-or-nothing: a failure on any page means the caller keeps
// that source's previous snapshot. Never return a partial list.

import { parseStateReason } from '../shared/stateTone';
import type { Item, ItemState, Iteration, LinkedPr, ProjectMembership, ProjectMeta, SavedView, SourceConfig, SourceSnapshot, ViewField } from '../shared/types';
import { itemKey } from '../shared/sources';
import { GitHubClient, GitHubError } from './github';
import { ISSUE_RELATIONS_BATCH_QUERY, PROJECT_ITEMS_QUERY } from './queries';
import { bodyIssueRefs } from './prNest';
import { completeRelations, fetchNodesBatch, noRelations, readRelations, RELATION_BATCH_SIZE, type GqlRelationFields } from './relations';
import { readViewerTies, type GqlViewerFields } from './viewerTies';
import { readLoopBlocked } from './loopBlocked';
import { hasLabel } from './pending';

export const STATUS_FIELD_NAME = 'Status';
export const REPO_RECENT_DAYS = 14;
const MAX_PROJECT_PAGES = 200;

interface GqlIteration {
  id: string;
  title: string;
  startDate: string;
  duration: number;
}
interface GqlField {
  __typename: string;
  id?: string;
  name?: string;
  configuration?: { iterations: GqlIteration[]; completedIterations: GqlIteration[] };
  options?: { id: string; name: string }[];
}
export interface GqlFieldValue {
  __typename: string;
  iterationId?: string;
  title?: string;
  startDate?: string;
  duration?: number;
  optionId?: string;
  name?: string;
  field?: { id?: string; name?: string };
}
export interface GqlContent extends GqlRelationFields, GqlViewerFields {
  __typename: 'Issue' | 'PullRequest' | 'DraftIssue';
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  stateReason?: string | null;
  merged?: boolean;
  isDraft?: boolean | null;
  updatedAt?: string;
  repository?: { nameWithOwner: string };
  labels?: { nodes: { name: string; color: string }[] };
  assignees?: { nodes: { login: string }[] };
  milestone?: { number: number; title: string; dueOn: string | null } | null;
  author?: { login: string } | null;
  subIssuesSummary?: { total: number; completed: number } | null;
  /** pull requests only: the description (GitHub#275: which issues it names) */
  body?: string | null;
  closedByPullRequestsReferences?: {
    nodes: { number: number; url: string; state: string; merged: boolean; repository: { nameWithOwner: string } }[];
  } | null;
}
type GqlViewField = { name?: string; dataType?: string } | null;
interface GqlView {
  number: number;
  name: string;
  layout: string;
  filter: string | null;
  groupByFields?: { nodes: GqlViewField[] } | null;
  verticalGroupByFields?: { nodes: GqlViewField[] } | null;
  sortByFields?: { nodes: { direction: string; field: GqlViewField }[] } | null;
  fields?: { nodes: GqlViewField[] } | null;
}
interface GqlProject {
  id: string;
  title: string;
  url: string;
  viewerCanUpdate?: boolean;
  fields: { nodes: GqlField[] };
  views?: { nodes: GqlView[] } | null;
  items: {
    totalCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: { id: string; isArchived: boolean; fieldValues: { nodes: GqlFieldValue[] }; content: GqlContent | null }[];
  };
}
type GqlProjectResponse = {
  organization?: { projectV2: GqlProject | null } | null;
  user?: { projectV2: GqlProject | null } | null;
};

function viewFields(nodes: GqlViewField[] | undefined): ViewField[] {
  return (nodes ?? []).filter((f): f is { name: string; dataType: string } => Boolean(f?.name && f.dataType)).map((f) => ({ name: f.name, dataType: f.dataType }));
}

function toSavedView(v: GqlView): SavedView {
  return {
    number: v.number,
    name: v.name,
    layout: v.layout,
    filter: v.filter ?? '',
    groupBy: viewFields(v.groupByFields?.nodes),
    verticalGroupBy: viewFields(v.verticalGroupByFields?.nodes),
    sortBy: (v.sortByFields?.nodes ?? [])
      .filter((s) => s.field?.name && s.field.dataType)
      .map((s) => ({ field: { name: s.field!.name!, dataType: s.field!.dataType! }, direction: s.direction === 'ASC' ? 'ASC' : 'DESC' })),
    fields: viewFields(v.fields?.nodes),
  };
}

function linkedPrs(c: GqlContent): LinkedPr[] {
  return (c.closedByPullRequestsReferences?.nodes ?? []).map((pr) => {
    const state: ItemState = pr.merged ? 'merged' : pr.state === 'OPEN' ? 'open' : 'closed';
    return { key: itemKey(pr.repository.nameWithOwner, pr.number), repo: pr.repository.nameWithOwner, number: pr.number, url: pr.url, state };
  });
}

function subIssues(s: { total: number; completed: number } | null | undefined): Item['subIssues'] {
  return s && s.total > 0 ? { total: s.total, completed: s.completed } : null;
}

function contentState(c: GqlContent): Item['state'] {
  if (c.__typename === 'PullRequest' && c.merged) return 'merged';
  return c.state === 'OPEN' ? 'open' : 'closed';
}

/** One Project item's iteration / status, read with that Project's own field ids. */
export function readMembership(
  meta: ProjectMeta,
  itemId: string,
  values: GqlFieldValue[],
): ProjectMembership {
  let iteration: Iteration | null = null;
  let status: string | null = null;
  for (const v of values) {
    if (v.__typename === 'ProjectV2ItemFieldIterationValue' && v.field?.id === meta.iterationFieldId && v.iterationId) {
      iteration = { id: v.iterationId, title: v.title ?? '', startDate: v.startDate ?? '', duration: v.duration ?? 0 };
    } else if (v.__typename === 'ProjectV2ItemFieldSingleSelectValue' && v.field?.id === meta.statusFieldId) {
      status = v.name ?? null;
    }
  }
  return { projectKey: meta.key, projectTitle: meta.title, itemId, iteration, status };
}

/**
 * An issue / PR as GraphQL returns it → the board's item (memberships filled by the caller).
 * Relations (GitHub#349) are taken only when `c` carries them whole — see `readRelations`; the
 * readers below call `completeRelations` first, and a source read refuses an issue without them.
 */
export function contentToItem(c: GqlContent, projects: ProjectMembership[], sources: string[], readAt?: number): Item | null {
  if (c.__typename === 'DraftIssue' || !c.repository || c.number == null) return null;
  const repo = c.repository.nameWithOwner;
  // a pull request has no parent, sub-issues or blocking relations on GitHub: known-empty
  const relations = c.__typename === 'PullRequest' ? noRelations() : readRelations(c);
  // GitHub#373: taken only from a read that says when it went out (the time is what a merge goes by)
  const ties = readAt !== undefined ? readViewerTies(c, c.__typename === 'PullRequest' ? 'pr' : 'issue', readAt) : null;
  return {
    key: itemKey(repo, c.number),
    nodeId: c.id ?? '',
    repo,
    number: c.number,
    title: c.title ?? '',
    url: c.url ?? '',
    kind: c.__typename === 'PullRequest' ? 'pr' : 'issue',
    state: contentState(c),
    stateReason: c.__typename === 'Issue' ? parseStateReason(c.stateReason) : null,
    isDraft: c.__typename === 'PullRequest' && typeof c.isDraft === 'boolean' ? c.isDraft : null,
    updatedAt: c.updatedAt ?? '',
    labels: c.labels?.nodes.map((l) => ({ name: l.name, color: l.color })) ?? [],
    assignees: c.assignees?.nodes.map((a) => a.login) ?? [],
    milestone: c.milestone ? { title: c.milestone.title, dueOn: c.milestone.dueOn } : null,
    author: c.author?.login ?? null,
    parent: c.parent ? itemKey(c.parent.repository.nameWithOwner, c.parent.number) : null,
    subIssues: subIssues(c.subIssuesSummary),
    // a pull request has no "linked pull requests" of its own: known-empty, not unknown
    linkedPrs: c.__typename === 'Issue' ? linkedPrs(c) : [],
    ...(c.__typename === 'PullRequest' ? { refIssues: bodyIssueRefs(c.body, repo, c.number) } : {}),
    ...(relations ? { relations, ...(readAt !== undefined ? { relationsAt: readAt } : {}) } : {}),
    ...(ties ?? {}),
    projects,
    sources,
  };
}

/**
 * GitHub#349: `c` with its relation lists read to the last page (no request when none is cut),
 * for every reader of GraphQL content. Throws when a later page cannot be read.
 */
export function withRelations(client: GitHubClient, c: GqlContent): Promise<GqlContent> {
  if (c.__typename !== 'Issue' || !c.repository || c.number == null) return Promise.resolve(c);
  return completeRelations(client, c, `${c.repository.nameWithOwner}#${c.number}`);
}

export async function fetchProject(
  client: GitHubClient,
  src: Extract<SourceConfig, { kind: 'project' }>,
  now: number,
  /** GitHub#429: the "waiting for a prerequisite" label setting; '' = the loop's registrations are not read */
  loopLabel: string = '',
): Promise<SourceSnapshot> {
  let after: string | null = null;
  let meta: ProjectMeta | null = null;
  const items = new Map<string, Item>();
  for (let page = 0; ; page++) {
    if (page >= MAX_PROJECT_PAGES) throw new GitHubError('http', `Project 分页超过 ${MAX_PROJECT_PAGES} 页，已停止`);
    const data: GqlProjectResponse = await client.graphql<GqlProjectResponse>(PROJECT_ITEMS_QUERY, {
      owner: src.owner,
      number: src.number,
      after,
      isOrg: src.ownerType === 'org',
    });
    const p = (src.ownerType === 'org' ? data.organization : data.user)?.projectV2;
    if (!p) {
      const missing = new GitHubError('graphql', `找不到 Project：${src.url}（不存在，或当前账号没有权限）`);
      missing.meta.gqlTypes = ['NOT_FOUND'];
      throw missing;
    }
    if (!meta) {
      const iterField = p.fields.nodes.find((f) => f.__typename === 'ProjectV2IterationField');
      const statusField = p.fields.nodes.find(
        (f) => f.__typename === 'ProjectV2SingleSelectField' && f.name === STATUS_FIELD_NAME,
      );
      const iterations: Iteration[] = iterField?.configuration
        ? [...iterField.configuration.completedIterations, ...iterField.configuration.iterations].map((i) => ({
            id: i.id,
            title: i.title,
            startDate: i.startDate,
            duration: i.duration,
          }))
        : [];
      meta = {
        key: src.key,
        title: p.title,
        url: p.url,
        projectId: p.id,
        // not answered = not known to be writable: the write entries stay grey
        viewerCanUpdate: p.viewerCanUpdate === true,
        iterationFieldId: iterField?.id ?? null,
        statusFieldId: statusField?.id ?? null,
        statusOptionIds: statusField?.options?.map((o) => ({ id: o.id, name: o.name })) ?? [],
        hasIterationField: Boolean(iterField),
        iterations,
        statusOptions: statusField?.options?.map((o) => o.name) ?? [],
        views: (p.views?.nodes ?? []).map(toSavedView),
      };
    }
    for (const node of p.items.nodes) {
      if (node.isArchived || !node.content) continue;
      // GitHub#349: the relations belong to the same snapshot — a list that cannot be read to
      // its end fails this source's read (the previous snapshot stays), it is never stored short
      const c = await withRelations(client, node.content);
      const it = contentToItem(c, [readMembership(meta, node.id, node.fieldValues.nodes)], [src.key], now);
      if (it && !it.relations) throw new GitHubError('graphql', `${it.repo}#${it.number} 的关系没有读全`);
      if (it) items.set(it.key, it);
    }
    if (!p.items.pageInfo.hasNextPage) break;
    if (!p.items.pageInfo.endCursor) throw new GitHubError('graphql', 'Project 分页缺少游标');
    after = p.items.pageInfo.endCursor;
  }
  // GitHub#429: part of the same read — a failure fails the source (its previous snapshot stays)
  await readLoopBlocked(client, [...items.values()], loopLabel);
  return { sourceKey: src.key, fetchedAt: now, items: [...items.values()], project: meta! };
}

interface RestIssue {
  number: number;
  node_id?: string;
  title: string;
  state: string;
  state_reason?: string | null;
  /** pull requests only */
  draft?: boolean;
  html_url: string;
  updated_at: string;
  labels: ({ name: string; color: string } | string)[];
  assignees?: { login: string }[] | null;
  milestone: { title: string; due_on: string | null } | null;
  pull_request?: { merged_at: string | null };
  user?: { login: string } | null;
  parent_issue_url?: string | null;
  sub_issues_summary?: { total: number; completed: number } | null;
  /** how many issues block this one / it blocks (open ones and all of them) */
  issue_dependencies_summary?: { total_blocked_by?: number; total_blocking?: number } | null;
  body?: string | null;
}

/**
 * GitHub#349: does this issue of the list have any relation to read? The list itself carries
 * the counts and the parent's address. An issue without the blocking counts in its answer is
 * read too: a count that is not there is not a zero.
 */
function hasRelations(r: RestIssue): boolean {
  if (r.pull_request) return false;
  const d = r.issue_dependencies_summary;
  if (!d || typeof d.total_blocked_by !== 'number' || typeof d.total_blocking !== 'number') return true;
  return d.total_blocked_by > 0 || d.total_blocking > 0 || (r.sub_issues_summary?.total ?? 0) > 0 || Boolean(r.parent_issue_url);
}

/** `https://api.github.com/repos/<o>/<r>/issues/<n>` -> item key */
function parentKey(url: string | null | undefined): string | null {
  const m = url?.match(/\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
  return m ? itemKey(`${m[1]}/${m[2]}`, Number(m[3])) : null;
}

function restToItem(repo: string, r: RestIssue, srcKey: string): Item {
  const key = itemKey(repo, r.number);
  return {
    key,
    nodeId: r.node_id ?? '',
    repo,
    number: r.number,
    title: r.title,
    url: r.html_url,
    kind: r.pull_request ? 'pr' : 'issue',
    state: r.pull_request?.merged_at ? 'merged' : r.state === 'open' ? 'open' : 'closed',
    stateReason: r.pull_request ? null : parseStateReason(r.state_reason),
    isDraft: r.pull_request && typeof r.draft === 'boolean' ? r.draft : null,
    updatedAt: r.updated_at,
    labels: r.labels.map((l) => (typeof l === 'string' ? { name: l, color: '' } : { name: l.name, color: l.color })),
    assignees: (r.assignees ?? []).map((a) => a.login),
    milestone: r.milestone ? { title: r.milestone.title, dueOn: r.milestone.due_on } : null,
    author: r.user?.login ?? null,
    parent: parentKey(r.parent_issue_url),
    subIssues: subIssues(r.sub_issues_summary),
    // the REST issue list does not say which pull requests are linked
    linkedPrs: r.pull_request ? [] : null,
    ...(r.pull_request ? { refIssues: bodyIssueRefs(r.body, repo, r.number) } : {}),
    projects: [],
    sources: [srcKey],
  };
}

/**
 * GitHub#462: the closed items carrying `label`, as one REST list. A name GitHub's `labels` parameter
 * can carry whole is asked for directly; one with a comma (the parameter's separator) cannot, so every
 * closed item is read and the caller keeps the ones carrying the whole name.
 */
export function closedPendingPath(base: string, label: string): string {
  return label.includes(',') ? `${base}?state=closed&per_page=100` : `${base}?state=closed&labels=${encodeURIComponent(label)}&per_page=100`;
}

/**
 * Every open issue / PR, plus everything (open or closed) updated in the last 14 days, plus
 * (GitHub#462) every closed one carrying the pending label (`pendingLabel`, '' = not read): those
 * still wait for a human however long ago they last changed. The snapshot says which label that
 * third list was read for (`pendingLabel`), so a read under another setting is not vouched for.
 */
export async function fetchRepo(
  client: GitHubClient,
  src: Extract<SourceConfig, { kind: 'repo' }>,
  now: number,
  /** tests: a smaller batch, to cross the batch boundary with the recorded items */
  batchSize: number = RELATION_BATCH_SIZE,
  /** GitHub#429: the "waiting for a prerequisite" label setting; '' = the loop's registrations are not read */
  loopLabel: string = '',
  /** GitHub#462: the pending ("等人处理") label setting; '' = closed items carrying it are not read */
  pendingLabel: string = '',
): Promise<SourceSnapshot> {
  const repo = `${src.owner}/${src.name}`;
  const base = `/repos/${encodeURIComponent(src.owner)}/${encodeURIComponent(src.name)}/issues`;
  const since = new Date(now - REPO_RECENT_DAYS * 86_400_000).toISOString();
  const pending = pendingLabel.trim();
  const [open, recent, closedPending] = await Promise.all([
    client.restList<RestIssue>(`${base}?state=open&per_page=100`),
    client.restList<RestIssue>(`${base}?state=all&since=${encodeURIComponent(since)}&per_page=100`),
    // GitHub's `labels` takes a comma-separated list (items carrying all of them): a name with a comma
    // in it cannot be asked for whole — GitHub would answer for its parts and never return an item
    // carrying the whole name (PR #481 review round 1). Such a name reads every closed item instead;
    // either answer is filtered here to the items really carrying the whole name.
    pending ? client.restList<RestIssue>(closedPendingPath(base, pending)) : Promise.resolve([] as RestIssue[]),
  ]);
  const items = new Map<string, Item>();
  const related = new Map<string, boolean>();
  const carries = (r: RestIssue) => r.labels.some((l) => (typeof l === 'string' ? l : l.name).toLowerCase() === pending.toLowerCase());
  for (const r of [...open, ...recent, ...closedPending.filter(carries)]) {
    const it = restToItem(repo, r, src.key);
    const prev = items.get(it.key);
    if (!prev || prev.updatedAt < it.updatedAt) {
      items.set(it.key, it);
      related.set(it.key, hasRelations(r));
    }
  }
  // GitHub#349: the list says only how many relations an issue has; the ones that have any are
  // read by node id. GitHub#373: nor does it say how the signed-in account stands to an item —
  // every open issue / PR is read for that too, and (GitHub#462) every closed one carrying the
  // pending label (a to-do too). One batch for all, 100 ids a request. Part of the same read: a
  // failure here fails the source.
  const todo = (it: Item) => it.state === 'open' || (pending !== '' && hasLabel(it, pending));
  const wanted = [...items.values()].filter((it) => related.get(it.key) || todo(it));
  const missingId = wanted.find((it) => !it.nodeId);
  if (missingId) throw new GitHubError('http', `${repo}#${missingId.number} 缺少读关系要用的 id`);
  const nodes = await fetchNodesBatch<GqlRelationFields & GqlViewerFields>(client, ISSUE_RELATIONS_BATCH_QUERY, wanted.map((it) => it.nodeId), batchSize);
  for (let i = 0; i < wanted.length; i++) {
    const it = wanted[i];
    const node = nodes[i];
    const what = `${repo}#${it.number}`;
    if (!node || node.__typename !== (it.kind === 'pr' ? 'PullRequest' : 'Issue')) throw new GitHubError('graphql', `${what} 的关系没有读到`);
    if (related.get(it.key)) {
      const rel = readRelations(await completeRelations(client, node, what));
      if (!rel) throw new GitHubError('graphql', `${what} 的关系没有读全`);
      it.relations = rel;
    }
    if (todo(it)) {
      const ties = readViewerTies(node, it.kind, now);
      if (!ties) throw new GitHubError('graphql', `${what} 的订阅状态没有读到`);
      Object.assign(it, ties);
    }
  }
  for (const it of items.values()) {
    it.relations ??= noRelations();
    it.relationsAt = now;
  }
  // GitHub#429: part of the same read — a failure fails the source (its previous snapshot stays)
  await readLoopBlocked(client, [...items.values()], loopLabel);
  return { sourceKey: src.key, fetchedAt: now, items: [...items.values()], pendingLabel: pending };
}

export function fetchSource(client: GitHubClient, src: SourceConfig, now: number, loopLabel: string = '', pendingLabel: string = ''): Promise<SourceSnapshot> {
  return src.kind === 'project' ? fetchProject(client, src, now, loopLabel) : fetchRepo(client, src, now, RELATION_BATCH_SIZE, loopLabel, pendingLabel);
}
