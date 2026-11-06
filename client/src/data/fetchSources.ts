// Read one source (a Project or a repository) completely, or throw.
// A source is all-or-nothing: a failure on any page means the caller keeps
// that source's previous snapshot. Never return a partial list.

import { parseStateReason } from '../shared/stateTone';
import type { Item, ItemState, Iteration, LinkedPr, ProjectMembership, ProjectMeta, SavedView, SourceConfig, SourceSnapshot, ViewField } from '../shared/types';
import { itemKey } from '../shared/sources';
import { GitHubClient, GitHubError } from './github';
import { PROJECT_ITEMS_QUERY } from './queries';

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
export interface GqlContent {
  __typename: 'Issue' | 'PullRequest' | 'DraftIssue';
  id?: string;
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  stateReason?: string | null;
  merged?: boolean;
  updatedAt?: string;
  repository?: { nameWithOwner: string };
  labels?: { nodes: { name: string; color: string }[] };
  assignees?: { nodes: { login: string }[] };
  milestone?: { number: number; title: string; dueOn: string | null } | null;
  author?: { login: string } | null;
  parent?: { number: number; repository: { nameWithOwner: string } } | null;
  subIssuesSummary?: { total: number; completed: number } | null;
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

/** An issue / PR as GraphQL returns it → the board's item (memberships filled by the caller). */
export function contentToItem(c: GqlContent, projects: ProjectMembership[], sources: string[]): Item | null {
  if (c.__typename === 'DraftIssue' || !c.repository || c.number == null) return null;
  const repo = c.repository.nameWithOwner;
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
    updatedAt: c.updatedAt ?? '',
    labels: c.labels?.nodes.map((l) => ({ name: l.name, color: l.color })) ?? [],
    assignees: c.assignees?.nodes.map((a) => a.login) ?? [],
    milestone: c.milestone ? { title: c.milestone.title, dueOn: c.milestone.dueOn } : null,
    author: c.author?.login ?? null,
    parent: c.parent ? itemKey(c.parent.repository.nameWithOwner, c.parent.number) : null,
    subIssues: subIssues(c.subIssuesSummary),
    // a pull request has no "linked pull requests" of its own: known-empty, not unknown
    linkedPrs: c.__typename === 'Issue' ? linkedPrs(c) : [],
    projects,
    sources,
  };
}

export async function fetchProject(
  client: GitHubClient,
  src: Extract<SourceConfig, { kind: 'project' }>,
  now: number,
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
    if (!p) throw new GitHubError('graphql', `找不到 Project：${src.url}（不存在，或当前账号没有权限）`);
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
      const c = node.content;
      if (node.isArchived || !c) continue;
      const it = contentToItem(c, [readMembership(meta, node.id, node.fieldValues.nodes)], [src.key]);
      if (it) items.set(it.key, it);
    }
    if (!p.items.pageInfo.hasNextPage) break;
    if (!p.items.pageInfo.endCursor) throw new GitHubError('graphql', 'Project 分页缺少游标');
    after = p.items.pageInfo.endCursor;
  }
  return { sourceKey: src.key, fetchedAt: now, items: [...items.values()], project: meta! };
}

interface RestIssue {
  number: number;
  node_id?: string;
  title: string;
  state: string;
  state_reason?: string | null;
  html_url: string;
  updated_at: string;
  labels: ({ name: string; color: string } | string)[];
  assignees?: { login: string }[] | null;
  milestone: { title: string; due_on: string | null } | null;
  pull_request?: { merged_at: string | null };
  user?: { login: string } | null;
  parent_issue_url?: string | null;
  sub_issues_summary?: { total: number; completed: number } | null;
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
    updatedAt: r.updated_at,
    labels: r.labels.map((l) => (typeof l === 'string' ? { name: l, color: '' } : { name: l.name, color: l.color })),
    assignees: (r.assignees ?? []).map((a) => a.login),
    milestone: r.milestone ? { title: r.milestone.title, dueOn: r.milestone.due_on } : null,
    author: r.user?.login ?? null,
    parent: parentKey(r.parent_issue_url),
    subIssues: subIssues(r.sub_issues_summary),
    // the REST issue list does not say which pull requests are linked
    linkedPrs: r.pull_request ? [] : null,
    projects: [],
    sources: [srcKey],
  };
}

/** Every open issue / PR, plus everything (open or closed) updated in the last 14 days. */
export async function fetchRepo(
  client: GitHubClient,
  src: Extract<SourceConfig, { kind: 'repo' }>,
  now: number,
): Promise<SourceSnapshot> {
  const repo = `${src.owner}/${src.name}`;
  const base = `/repos/${encodeURIComponent(src.owner)}/${encodeURIComponent(src.name)}/issues`;
  const since = new Date(now - REPO_RECENT_DAYS * 86_400_000).toISOString();
  const [open, recent] = await Promise.all([
    client.restList<RestIssue>(`${base}?state=open&per_page=100`),
    client.restList<RestIssue>(`${base}?state=all&since=${encodeURIComponent(since)}&per_page=100`),
  ]);
  const items = new Map<string, Item>();
  for (const r of [...open, ...recent]) {
    const it = restToItem(repo, r, src.key);
    const prev = items.get(it.key);
    if (!prev || prev.updatedAt < it.updatedAt) items.set(it.key, it);
  }
  return { sourceKey: src.key, fetchedAt: now, items: [...items.values()] };
}

export function fetchSource(client: GitHubClient, src: SourceConfig, now: number): Promise<SourceSnapshot> {
  return src.kind === 'project' ? fetchProject(client, src, now) : fetchRepo(client, src, now);
}
