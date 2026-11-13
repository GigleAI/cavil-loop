// Every change the client makes on GitHub, one function per kind. Rules:
//   - labels: send only "add this one" / "remove this one", never the whole list
//     (a whole list would silently undo labels somebody else added meanwhile);
//   - merge: always send the commit the user saw (GitHub refuses if the PR moved);
//     never ask for an admin merge that bypasses branch protection;
//   - milestone: the item's own repository's milestone with that title; none →
//     refused before anything is sent (milestones are never created here);
//   - Project fields: only that Project, only with its own field / option ids;
//   - closing (PR or issue): close first, the attached comment only after it;
//     an issue only with a reason the client offers (completed / not planned);
//   - a task-list box (GitHub#193): GitHub has no "change one box" and no
//     conditional edit, so the body / comment is read again right before the
//     write; it must still belong to this item, still be changeable by this
//     account and still hold exactly the source the click was made on — else
//     nothing is written. Exactly one character of it changes;
//   - "hand to the agent" / "autopilot" (GitHub#205): labels added before the
//     "waiting for a human" one is removed; autopilot adds its own label first;
//   - editing a body / comment (GitHub#205): the same read-before-write as a
//     task-list box — written only while GitHub still holds the text the edit
//     started from;
//   - a refusal found before sending (ActionRefused) means nothing was sent.
// Nothing is retried or queued: one request, its answer is the result.

import type { CreateBoard } from '../shared/types';
import type { SendAction, SendProof } from '../shared/sends';
import { ISSUE_CLOSE_REASONS, type CreatePlan, type IssueCloseReason, type MergeMethod, type RepoOptions, type WriteAction } from '../shared/actions';
import type { HandBackLabels, Item, ProjectMeta } from '../shared/types';
import { itemKey } from '../shared/sources';
import { GitHubClient, GitHubError } from './github';
import {
  ADD_PROJECT_ITEM_MUTATION,
  CLEAR_FIELD_MUTATION,
  CLOSING_ISSUES_QUERY,
  OP_RECORDS_QUERY, OP_SNAPSHOT_QUERY,
  SET_ITERATION_MUTATION,
  SET_STATUS_MUTATION,
  TASK_SOURCE_QUERY,
  TITLE_SOURCE_QUERY,
  UPDATE_COMMENT_MUTATION,
  UPDATE_ISSUE_BODY_MUTATION,
  UPDATE_PR_BODY_MUTATION,
} from './queries';
import { flipTask } from './taskList';
import { pickMilestone } from './groupPreset';
import { checkHandoff, droppedLabels, handoffProblem, HANDOFFS, mergeLabels } from '../shared/handoff';

/** The app refused before sending anything to GitHub. */
export class ActionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionRefused';
  }
}

export interface ActionContext {
  /** the item as the board has it (null for createIssue) */
  item: Item | null;
  projects: ProjectMeta[];
  handBack: HandBackLabels;
  /** Projects a new issue joins (the ones ticked in the view) */
  createInProjects: ProjectMeta[];
  /** every item the cache holds (all configured sources): a merged / closed PR's issues are re-read only when cached */
  cached: Item[];
}

export interface ActionOutcome {
  /** items to re-read from GitHub now: [repo, number] — the changed item first, then what the change also changed */
  touched: [string, number][];
  /** done, but a follow-up step did not work */
  warning: string | null;
  createdKey?: string;
  /** createIssue: the boards the new issue is not finished on (GitHub#229: missing / a field not set) */
  boards?: CreateBoard[];
  /** createIssue: the new issue's node id, from GitHub's own answer (what a retry adds to a board) */
  createdNodeId?: string;
  /** createIssue (GitHub#245): labels GitHub dropped, as said in the notice; kept apart from the boards so neither hides the other */
  labelsNote?: string;
}

/**
 * GitHub#229: add an issue this app just created (its node id from the create answer)
 * to one Project, then set the iteration / status it was meant to carry. Works whether or
 * not the issue is on any source yet — it is not, when joining that very board failed.
 * Returns the field error (joined, a field not set), null when everything was set.
 */
export function createBoard(p: ProjectMeta, state: CreateBoard['state'], reason: string, entry?: { iterationId: string | null; status: string | null }): CreateBoard {
  return { projectKey: p.key, title: p.title, state, reason, iterationId: entry?.iterationId ?? null, status: entry?.status ?? null };
}

export async function joinCreatedIssue(client: GitHubClient, p: ProjectMeta, nodeId: string, iterationId: string | null, status: string | null): Promise<unknown | null> {
  if (!p.projectId) throw new ActionRefused('这个看板的数据是旧版本缓存的，请先刷新一次');
  if (!p.viewerCanUpdate) throw new ActionRefused(`你在看板「${p.title}」上没有修改权限（GitHub 说这个账号不能改它）`);
  if (!nodeId) throw new ActionRefused('不知道新 issue 在 GitHub 上的编号，不能补加；请到网页上加进看板');
  checkFieldValues(p, iterationId, status);
  return joinProject(client, p, nodeId, iterationId, status);
}

/**
 * GitHub#258: set the group's iteration or status on a board that took a new issue in by itself
 * (`itemId`: its item there). Refused before sending when the board cannot take it now.
 */
export async function setCreatedField(client: GitHubClient, p: ProjectMeta, itemId: string, iterationId: string | null, status: string | null): Promise<void> {
  if (!p.projectId) throw new ActionRefused('这个看板的数据是旧版本缓存的，请先刷新一次');
  if (!p.viewerCanUpdate) throw new ActionRefused('这个账号不能修改这个看板');
  checkFieldValues(p, iterationId, status);
  if (iterationId !== null) await setField(client, p, itemId, 'iteration', iterationId);
  else if (status !== null) await setField(client, p, itemId, 'status', status);
  else throw new ActionRefused('不知道要设哪个字段');
}

/**
 * createIssue (GitHub#229): the create request went out but no clear answer came
 * back — a lost connection, a timeout, a server error (5xx), an answer without the
 * new issue. GitHub may or may not have created it: it must never be sent again
 * from the draft as if nothing had happened.
 */
export class CreateUnanswered extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'CreateUnanswered';
  }
}

/**
 * Did GitHub refuse for sure (nothing changed)? A refusal before sending, an
 * answered GraphQL error, a 401, or an HTTP 4xx other than 408 (timeout) / 429
 * (too many requests): yes. A network failure, a timeout or a 5xx: no — the
 * request may have been carried out (GitHub#229).
 */
export function refusedForSure(e: unknown): boolean {
  if (e instanceof ActionRefused) return true;
  if (!(e instanceof GitHubError)) return false;
  if (e.kind === 'graphql' || e.kind === 'auth') return true;
  if (e.kind === 'http') {
    const st = e.status ?? 0;
    return st >= 400 && st < 500 && st !== 408 && st !== 429;
  }
  return false;
}

const enc = encodeURIComponent;
function repoPath(repo: string): string {
  const [owner, name] = repo.split('/');
  return `/repos/${enc(owner)}/${enc(name)}`;
}

/** What to tell the user when GitHub refused (or could not be reached). Nothing was changed by the refused request. */
export function explainError(e: unknown, kind: WriteAction['kind']): string {
  if (e instanceof ActionRefused) return e.message;
  if (!(e instanceof GitHubError)) return `出错：${(e as Error)?.message ?? String(e)}`;
  const gh = e.message.replace(/^GitHub 返回 HTTP \d+：?/, '');
  if (e.kind === 'network') return `连不上 GitHub，没有修改（${e.message}）`;
  if (e.kind === 'auth') return 'GitHub 凭据失效，没有修改；请重新登录';
  if (e.kind === 'graphql') {
    if (/permission|not accessible|resource not accessible|insufficient/i.test(e.message)) return `没有权限修改这个看板（GitHub：${e.message}）`;
    return `GitHub 拒绝了这次修改：${e.message}`;
  }
  const st = e.status ?? 0;
  if (kind === 'merge') {
    if (st === 409) return `PR 在你查看之后有了新提交，GitHub 拒绝合并；请刷新详情、看过新提交再决定（GitHub：${gh || '提交已变'}）`;
    if (st === 405) return `GitHub 不允许现在合并：${gh || '检查没过或分支保护规则不满足'}`;
  }
  if (st === 403) return `没有权限（GitHub：${gh || 'Forbidden'}）`;
  if (st === 404) return `找不到，或当前账号没有权限（GitHub：${gh || 'Not Found'}）`;
  if (st === 410) return `这个仓库关闭了 issue 功能（GitHub：${gh}）`;
  if (st === 422) return `GitHub 不接受这次修改：${gh || '内容无效'}`;
  return e.message;
}

function needItem(ctx: ActionContext): Item {
  if (!ctx.item) throw new ActionRefused('看板上找不到这一条（可能刚被同步掉了），请刷新后再试');
  return ctx.item;
}

function projectOf(ctx: ActionContext, key: string): ProjectMeta {
  const p = ctx.projects.find((x) => x.key === key);
  if (!p) throw new ActionRefused('这个看板不在当前来源里，请刷新后再试');
  if (!p.projectId) throw new ActionRefused('这个看板的数据是旧版本缓存的，请先刷新一次');
  if (!p.viewerCanUpdate) throw new ActionRefused(`你在看板「${p.title}」上没有修改权限（GitHub 说这个账号不能改它）`);
  return p;
}

function membershipOf(item: Item, p: ProjectMeta) {
  const m = item.projects.find((x) => x.projectKey === p.key);
  if (!m || !m.itemId) throw new ActionRefused(`这一条不在看板「${p.title}」上`);
  return m;
}

export async function listRepoOptions(client: GitHubClient, repo: string): Promise<RepoOptions> {
  const base = repoPath(repo);
  const [labels, milestones] = await Promise.all([
    client.restList<{ name: string; color: string }>(`${base}/labels?per_page=100`),
    client.restList<{ number: number; title: string; state: string; due_on: string | null }>(`${base}/milestones?state=all&per_page=100`),
  ]);
  return {
    labels: labels.map((l) => ({ name: l.name, color: l.color })),
    milestones: milestones.map((m) => ({ number: m.number, title: m.title, state: m.state === 'closed' ? 'closed' : 'open', dueOn: m.due_on })),
    error: null,
  };
}

async function setField(client: GitHubClient, p: ProjectMeta, itemId: string, field: 'iteration' | 'status', value: string | null) {
  const fieldId = field === 'iteration' ? p.iterationFieldId : p.statusFieldId;
  if (!fieldId) throw new ActionRefused(`看板「${p.title}」没有${field === 'iteration' ? '迭代' : '状态'}字段`);
  if (value === null) {
    await client.graphql(CLEAR_FIELD_MUTATION, { projectId: p.projectId, itemId, fieldId });
    return;
  }
  if (field === 'iteration') {
    if (!p.iterations.some((i) => i.id === value)) throw new ActionRefused(`看板「${p.title}」没有这个迭代`);
    await client.graphql(SET_ITERATION_MUTATION, { projectId: p.projectId, itemId, fieldId, iterationId: value });
  } else {
    const opt = p.statusOptionIds.find((o) => o.name === value);
    if (!opt) throw new ActionRefused(`看板「${p.title}」的状态里没有「${value}」`);
    await client.graphql(SET_STATUS_MUTATION, { projectId: p.projectId, itemId, fieldId, optionId: opt.id });
  }
}

/** The iteration / status a Project item is about to get still exist in that Project (as last synced). */
function checkFieldValues(p: ProjectMeta, iterationId: string | null, status: string | null): void {
  if (iterationId !== null && !p.iterations.some((i) => i.id === iterationId)) throw new ActionRefused(`看板「${p.title}」没有这个迭代`);
  if (status !== null && !p.statusOptionIds.some((o) => o.name === status)) throw new ActionRefused(`看板「${p.title}」的状态里没有「${status}」`);
}

/**
 * Put `contentId` on Project `p`, then set its iteration and status (null = leave unset).
 * A refused add throws; a field that could not be set after the add is returned
 * (the item stays on the Project), null = all set. One path for "add to board" and a new issue.
 */
async function joinProject(client: GitHubClient, p: ProjectMeta, contentId: string, iterationId: string | null, status: string | null): Promise<unknown | null> {
  const r = await client.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(ADD_PROJECT_ITEM_MUTATION, { projectId: p.projectId, contentId });
  const itemId = r.addProjectV2ItemById.item.id;
  try {
    if (iterationId !== null) await setField(client, p, itemId, 'iteration', iterationId);
    if (status !== null) await setField(client, p, itemId, 'status', status);
  } catch (e) {
    return e;
  }
  return null;
}

export async function addLabel(client: GitHubClient, repo: string, number: number, label: string): Promise<void> {
  await client.rest('POST', `${repoPath(repo)}/issues/${number}/labels`, { labels: [label] });
}

export async function removeLabel(client: GitHubClient, repo: string, number: number, label: string): Promise<void> {
  await client.rest('DELETE', `${repoPath(repo)}/issues/${number}/labels/${enc(label)}`);
}

// ---- GitHub#250: the steps of a close / merge / autopilot / hand-back, one request each ----
// The controller runs them one after the other (data/../shared/ops.ts decides what a result
// means); every check that can be made before sending is made by the caller first.

/** Close an issue (with its reason) or a PR. */
export async function closeStep(client: GitHubClient, it: Item, reason: IssueCloseReason | undefined): Promise<void> {
  if (it.kind === 'issue') {
    if (!reason || !ISSUE_CLOSE_REASONS.includes(reason)) throw new ActionRefused('未知的关闭原因');
    await client.rest('PATCH', `${repoPath(it.repo)}/issues/${it.number}`, { state: 'closed', state_reason: reason });
  } else {
    await client.rest('PATCH', `${repoPath(it.repo)}/pulls/${it.number}`, { state: 'closed' });
  }
}

export async function commentStep(client: GitHubClient, it: Item, body: string): Promise<void> {
  await client.rest('POST', `${repoPath(it.repo)}/issues/${it.number}/comments`, { body });
}

/** Merge exactly the commit the user saw (GitHub refuses when the PR moved). */
export async function mergeStep(client: GitHubClient, it: Item, method: MergeMethod, headOid: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(headOid)) throw new ActionRefused('不知道你看到的是哪个提交，请刷新详情后再合并');
  if (!(['merge', 'squash', 'rebase'] as MergeMethod[]).includes(method)) throw new ActionRefused('未知的合并方式');
  await client.rest('PUT', `${repoPath(it.repo)}/pulls/${it.number}/merge`, { merge_method: method, sha: headOid });
}

/** GitHub#250: an item's newest comments and label events (ids are GitHub's node ids). */
export interface ItemRecords {
  comments: { id: string; author: string | null; body: string }[];
  labelEvents: { id: string; event: 'labeled' | 'unlabeled'; actor: string | null; label: string }[];
}

/** Read the item's newest 100 comments and 100 label events; throws when GitHub did not give them. */
export async function readItemRecords(client: GitHubClient, repo: string, number: number): Promise<ItemRecords> {
  const [owner, name] = repo.split('/');
  type Node = { id: string; body?: string; author?: { login?: string } | null; actor?: { login?: string } | null; label?: { name?: string } | null; __typename?: string };
  const data = await client.graphql<{ repository: { issueOrPullRequest: { comments?: { nodes: Node[] }; timelineItems?: { nodes: Node[] } } | null } | null }>(OP_RECORDS_QUERY, { owner, name, number });
  const it = data.repository?.issueOrPullRequest;
  if (!it || !it.comments || !it.timelineItems) throw new GitHubError('graphql', `读不到 ${repo}#${number} 的评论和标签记录`);
  return {
    comments: it.comments.nodes.filter((n) => n?.id).map((n) => ({ id: n.id, author: n.author?.login ?? null, body: n.body ?? '' })),
    labelEvents: it.timelineItems.nodes
      .filter((n) => n?.id && (n.__typename === 'LabeledEvent' || n.__typename === 'UnlabeledEvent'))
      .map((n) => ({ id: n.id, event: n.__typename === 'LabeledEvent' ? 'labeled' : 'unlabeled', actor: n.actor?.login ?? null, label: n.label?.name ?? '' })),
  };
}

/** GitHub#359: how many pages of label events a snapshot walks back at most (100 events each) */
const SNAPSHOT_PAGES = 20;

/**
 * GitHub#359: the item's state, labels, newest comments and label events in one read (further
 * pages of label events only when needed). `known`: the ids of label events seen before the
 * operation started — the events are read back until one of them shows up, or to the first event
 * ever; null = the newest page only. `complete` is false when that could not be done (more pages
 * than SNAPSHOT_PAGES, a page without a way back, more labels than one page): such a read must
 * never be taken for "nothing happened". Throws when GitHub did not answer.
 */
export async function readItemSnapshot(client: GitHubClient, repo: string, number: number, known: readonly string[] | null): Promise<ItemRecords & { complete: boolean; labelsComplete: boolean; state: 'open' | 'closed' | 'merged'; labels: string[] }> {
  const [owner, name] = repo.split('/');
  type Node = { id: string; body?: string; author?: { login?: string } | null; actor?: { login?: string } | null; label?: { name?: string } | null; __typename?: string };
  type It = {
    state?: string;
    merged?: boolean;
    labels?: { totalCount?: number; nodes: { name: string }[] };
    comments?: { nodes: Node[] };
    timelineItems?: { pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null }; nodes: Node[] };
  };
  const seen = new Set(known ?? []);
  let first: It | null = null;
  let events: ItemRecords['labelEvents'] = [];
  let before: string | null = null;
  let complete = false;
  for (let page = 0; page < SNAPSHOT_PAGES; page++) {
    const data: { repository: { issueOrPullRequest: It | null } | null } = await client.graphql(OP_SNAPSHOT_QUERY, { owner, name, number, before });
    const it: It | null | undefined = data.repository?.issueOrPullRequest;
    if (!it || !it.comments || !it.timelineItems || !it.labels || typeof it.state !== 'string') throw new GitHubError('graphql', `读不到 ${repo}#${number} 的状态、标签和标签记录`);
    if (!first) first = it;
    const nodes = it.timelineItems.nodes
      .filter((n) => n?.id && (n.__typename === 'LabeledEvent' || n.__typename === 'UnlabeledEvent'))
      .map((n) => ({ id: n.id, event: n.__typename === 'LabeledEvent' ? ('labeled' as const) : ('unlabeled' as const), actor: n.actor?.login ?? null, label: n.label?.name ?? '' }));
    events = [...nodes, ...events];
    const more = it.timelineItems.pageInfo?.hasPreviousPage === true;
    if (!more || known === null || nodes.some((e) => seen.has(e.id))) {
      // the newest page alone is everything only when there is nothing before it
      complete = !more || (known !== null && nodes.some((e) => seen.has(e.id)));
      break;
    }
    before = it.timelineItems.pageInfo?.startCursor ?? null;
    if (!before) break;
  }
  const it = first!;
  const labels = it.labels!.nodes.map((l) => l.name);
  // GitHub's count of the item's labels: a missing count is "cannot tell", never "complete"
  const labelsComplete = typeof it.labels!.totalCount === 'number' && it.labels!.totalCount === labels.length;
  if (!labelsComplete) complete = false;
  const st = String(it.state).toLowerCase();
  return {
    complete,
    labelsComplete,
    state: it.merged === true || st === 'merged' ? 'merged' : st === 'open' ? 'open' : 'closed',
    labels,
    comments: it.comments!.nodes.filter((n) => n?.id).map((n) => ({ id: n.id, author: n.author?.login ?? null, body: n.body ?? '' })),
    labelEvents: events,
  };
}

/**
 * The cached issues a merge / close of `pr` also changes (GigleAI/cavil-loop#177):
 * the issues GitHub says the PR closes — every page — plus the cached issues
 * whose "linked pull requests" list it (repository sources do not know those
 * links, Project sources do). Only issues the cache holds: the others are on
 * no board. A list GitHub did not give in full is never taken for the whole
 * list: what was read is still returned, with `problem` saying it is partial.
 */
export async function relatedIssues(client: GitHubClient, pr: Item, cached: Item[]): Promise<{ items: [string, number][]; problem: string | null }> {
  const issues = new Map<string, Item>();
  for (const it of cached) if (it.kind === 'issue' && !issues.has(it.key)) issues.set(it.key, it);
  const found: string[] = [];
  let problem: string | null = null;
  const [owner, name] = pr.repo.split('/');
  try {
    let after: string | null = null;
    const seen = new Set<string>();
    for (;;) {
      const data: { repository: { pullRequest: { closingIssuesReferences: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { number: number; repository: { nameWithOwner: string } }[] } } | null } | null } =
        await client.graphql(CLOSING_ISSUES_QUERY, { owner, name, number: pr.number, after });
      const conn = data.repository?.pullRequest?.closingIssuesReferences;
      if (!conn) throw new GitHubError('graphql', `找不到 ${pr.repo}#${pr.number}`);
      for (const n of conn.nodes ?? []) found.push(itemKey(n.repository.nameWithOwner, n.number));
      if (!conn.pageInfo?.hasNextPage) break;
      const next = conn.pageInfo.endCursor;
      // "there is more" without a way to get it: the list is not complete
      if (!next || seen.has(next)) throw new GitHubError('graphql', 'GitHub 说还有下一页，但没有给出翻页位置');
      seen.add(next);
      after = next;
    }
  } catch (e) {
    problem = `修改已生效，但没读全这个 PR 关联的 issue（${(e as Error).message}），稍后的同步会更新`;
  }
  for (const it of issues.values()) if (it.linkedPrs?.some((l) => l.key === pr.key)) found.push(it.key);
  const items: [string, number][] = [];
  const done = new Set<string>();
  for (const key of found) {
    const it = issues.get(key);
    if (!it || done.has(key)) continue;
    done.add(key);
    items.push([it.repo, it.number]);
  }
  return { items, problem };
}

/** What an edit is refused with when the body / comment changed on GitHub since the edit started (GitHub#205). */
export const EDIT_CHANGED = '这一条在你编辑期间被别人改过，没有保存（你的文字还在编辑框里）；请复制留底后重新打开详情再改';

/** What a title change is refused with when the title changed on GitHub since the edit started (GitHub#299). */
export const TITLE_CHANGED = '标题在你编辑期间被别人改过，没有保存（你的文字还在输入框里）；请复制留底后重新打开详情再改';

/** What a ticked box is refused with when the body / comment changed since the click was made on it. */
export const TASK_CHANGED = '这一条刚被改过（和你看到的不一样了），没有修改；已重新读取，请看过后再勾';

interface TaskSource {
  kind: 'IssueComment' | 'Issue' | 'PullRequest';
  body: string;
  canUpdate: boolean;
  repo: string;
  number: number;
}

/** The body / comment as GitHub holds it now. Anything missing from the answer is an error, never "empty". */
async function readTaskSource(client: GitHubClient, id: string): Promise<TaskSource> {
  type Ref = { number?: number; repository?: { nameWithOwner?: string } };
  const d = await client.graphql<{ node: ({ __typename?: string; body?: unknown; viewerCanUpdate?: unknown; issue?: Ref } & Ref) | null }>(TASK_SOURCE_QUERY, { id });
  const n = d.node;
  if (!n) throw new ActionRefused('GitHub 上找不到这一条评论（可能已被删除），没有修改');
  const kind = n.__typename;
  if (kind !== 'IssueComment' && kind !== 'Issue' && kind !== 'PullRequest') throw new ActionRefused('这不是正文或评论，没有修改');
  const ref = kind === 'IssueComment' ? n.issue : n;
  if (typeof n.body !== 'string' || typeof n.viewerCanUpdate !== 'boolean' || typeof ref?.number !== 'number' || typeof ref.repository?.nameWithOwner !== 'string')
    throw new GitHubError('graphql', 'GitHub 的回应缺少原文、权限或所属条目，没有修改');
  return { kind, body: n.body, canUpdate: n.viewerCanUpdate, repo: ref.repository.nameWithOwner, number: ref.number };
}

/** An item's title as GitHub holds it now (GitHub#299). Anything missing from the answer is an error, never "empty". */
async function readTitle(client: GitHubClient, repo: string, number: number): Promise<{ title: string; canUpdate: boolean }> {
  const [owner, name] = repo.split('/');
  const d = await client.graphql<{ repository: { issueOrPullRequest: { __typename?: string; title?: unknown; viewerCanUpdate?: unknown; number?: unknown } | null } | null }>(
    TITLE_SOURCE_QUERY,
    { owner, name, number },
  );
  const n = d.repository?.issueOrPullRequest;
  if (!n) throw new ActionRefused('GitHub 上找不到这一条（可能已被删除或转移），没有修改');
  if ((n.__typename !== 'Issue' && n.__typename !== 'PullRequest') || n.number !== number || typeof n.title !== 'string' || typeof n.viewerCanUpdate !== 'boolean')
    throw new GitHubError('graphql', 'GitHub 的回应缺少标题或权限，没有修改');
  return { title: n.title, canUpdate: n.viewerCanUpdate };
}

async function writeTaskSource(client: GitHubClient, kind: TaskSource['kind'], id: string, body: string): Promise<unknown> {
  if (kind === 'IssueComment') return (await client.graphql<any>(UPDATE_COMMENT_MUTATION, { id, body }))?.updateIssueComment?.issueComment?.body;
  if (kind === 'Issue') return (await client.graphql<any>(UPDATE_ISSUE_BODY_MUTATION, { id, body }))?.updateIssue?.issue?.body;
  return (await client.graphql<any>(UPDATE_PR_BODY_MUTATION, { id, body }))?.updatePullRequest?.pullRequest?.body;
}

/**
 * Before a new issue from a group's "+" is created (GitHub#214): what the dialog showed must
 * still hold. The Projects it would join are the ones it showed; each promised iteration /
 * status still exists there; a promised milestone is read again and must still be that
 * number with that title. Anything else — including a read that fails — refuses, and nothing
 * has been written. A "none" in the plan stays none, whatever GitHub holds now.
 */
async function checkCreatePlan(client: GitHubClient, repo: string, plan: CreatePlan, joining: ProjectMeta[]): Promise<void> {
  const shown = plan.projects.map((x) => x.projectKey).sort();
  const now = joining.map((p) => p.key).sort();
  if (shown.length !== now.length || shown.some((k, i) => k !== now[i])) throw new ActionRefused('勾选的看板在打开对话框后变了，没有新建；请关掉对话框重开');
  for (const entry of plan.projects) {
    const p = joining.find((x) => x.key === entry.projectKey)!;
    try {
      checkFieldValues(p, entry.iterationId, entry.status);
    } catch (e) {
      throw new ActionRefused(`${(e as Error).message}（打开对话框后变了），没有新建；请关掉对话框重开`);
    }
  }
  if (!plan.milestone) return;
  const want = plan.milestone;
  const ms = await client.restList<{ number: number; title: string }>(`${repoPath(repo)}/milestones?state=all&per_page=100`);
  if (!ms.some((m) => m.number === want.number && m.title === want.title))
    throw new ActionRefused(`里程碑「${want.title}」已经不在仓库 ${repo} 里（或被改了名），没有新建；请关掉对话框重开`);
}

/**
 * GitHub#489: a reply / an edit / a ticked box, made ready to send. Everything that can refuse it is
 * checked here — each read that fails throws, and then nothing was sent. `write` is the one request
 * that changes GitHub (null: GitHub already holds it, nothing to send); it returns a warning when
 * GitHub's answer does not show what was written. `proof` is what proves it when that answer never
 * comes. `proofs`: a reply reads the comments already there first (only a send record needs them).
 */
export async function prepareSend(client: GitHubClient, action: SendAction, it: Item, opts: { proofs?: boolean } = {}): Promise<{ write: (() => Promise<string | null>) | null; proof: SendProof }> {
  switch (action.kind) {
    case 'comment': {
      if (!action.body.trim()) throw new ActionRefused('评论是空的，没有发送');
      let before: string[] | null = null;
      if (opts.proofs) {
        try {
          before = (await readItemRecords(client, it.repo, it.number)).comments.map((x) => x.id);
        } catch (e) {
          // sent anyway; if its answer never comes it can only be checked by a person
          if (e instanceof GitHubError && e.kind === 'auth') throw e;
        }
      }
      return { write: async () => (await commentStep(client, it, action.body), null), proof: { kind: 'comment', before } };
    }
    case 'toggleTask': {
      if (!Number.isInteger(action.index) || action.index < 0 || typeof action.checked !== 'boolean') throw new ActionRefused('不知道点的是哪一个勾选框，没有修改');
      if (typeof action.seenSource !== 'string' || !action.entryId) throw new ActionRefused('不知道你看到的原文，请刷新详情后再勾');
      const now = await readTaskSource(client, action.entryId);
      if (now.repo.toLowerCase() !== it.repo.toLowerCase() || now.number !== it.number) throw new ActionRefused('这条评论不属于当前这一条，没有修改');
      if (!now.canUpdate) throw new ActionRefused('GitHub 说你没有权限改这一条，没有修改');
      if (now.body !== action.seenSource) throw new ActionRefused(TASK_CHANGED);
      const next = flipTask(now.body, action.index, action.checked);
      if (next === null) throw new ActionRefused(TASK_CHANGED);
      return {
        write: async () => ((await writeTaskSource(client, now.kind, action.entryId, next)) === next ? null : 'GitHub 返回的内容和要写的不一致，请刷新详情核对'),
        proof: { kind: 'source', want: next },
      };
    }
    case 'editEntry': {
      if (typeof action.body !== 'string' || typeof action.seenSource !== 'string' || !action.entryId) throw new ActionRefused('不知道你改的是哪一条、原文是什么，请刷新详情后再改');
      const now = await readTaskSource(client, action.entryId);
      if (now.repo.toLowerCase() !== it.repo.toLowerCase() || now.number !== it.number) throw new ActionRefused('这条评论不属于当前这一条，没有修改');
      if (!now.canUpdate) throw new ActionRefused('GitHub 说你没有权限改这一条，没有修改');
      if (now.body !== action.seenSource) throw new ActionRefused(EDIT_CHANGED);
      if (now.kind === 'IssueComment' && !action.body.trim()) throw new ActionRefused('评论不能改成空的，没有修改（要删掉请去网页）');
      const proof = { kind: 'source' as const, want: action.body };
      if (action.body === now.body) return { write: null, proof };
      return {
        write: async () => ((await writeTaskSource(client, now.kind, action.entryId, action.body)) === action.body ? null : 'GitHub 返回的内容和要写的不一致，请刷新详情核对'),
        proof,
      };
    }
    case 'editTitle': {
      if (typeof action.title !== 'string' || typeof action.seenTitle !== 'string') throw new ActionRefused('不知道你改的标题、原来的标题是什么，请刷新详情后再改');
      // GitHub keeps a title without its outer spaces: what is sent is what it will hold
      const title = action.title.trim();
      if (!title) throw new ActionRefused('标题不能为空，没有修改');
      const now = await readTitle(client, it.repo, it.number);
      if (!now.canUpdate) throw new ActionRefused('GitHub 说你没有权限改这一条，没有修改');
      if (now.title !== action.seenTitle) throw new ActionRefused(TITLE_CHANGED);
      const proof = { kind: 'title' as const, want: title };
      if (title === now.title) return { write: null, proof };
      return {
        write: async () => {
          const written = await client.rest<{ title?: unknown }>('PATCH', `${repoPath(it.repo)}/issues/${it.number}`, { title });
          return written?.title === title ? null : 'GitHub 返回的标题和要写的不一致，请刷新详情核对';
        },
        proof,
      };
    }
  }
}

/** GitHub#489: what GitHub holds now that proves (or not) a send whose answer never came. Throws when it could not be read. */
export async function readSendEvidence(client: GitHubClient, action: SendAction, repo: string, number: number): Promise<{ comments?: ItemRecords['comments']; source?: string; title?: string }> {
  if (action.kind === 'comment') return { comments: (await readItemRecords(client, repo, number)).comments };
  if (action.kind === 'editTitle') return { title: (await readTitle(client, repo, number)).title };
  return { source: (await readTaskSource(client, action.entryId)).body };
}

export async function performAction(client: GitHubClient, action: WriteAction, ctx: ActionContext): Promise<ActionOutcome> {
  switch (action.kind) {
    case 'addLabel': {
      const it = needItem(ctx);
      await addLabel(client, it.repo, it.number, action.label);
      return { touched: [[it.repo, it.number]], warning: null };
    }
    case 'removeLabel': {
      const it = needItem(ctx);
      await removeLabel(client, it.repo, it.number, action.label);
      return { touched: [[it.repo, it.number]], warning: null };
    }
    case 'setMilestone': {
      const it = needItem(ctx);
      let number: number | null = null;
      if (action.title !== null) {
        const ms = await client.restList<{ number: number; title: string; state: string }>(
          `${repoPath(it.repo)}/milestones?state=all&per_page=100`,
        );
        const pick = pickMilestone(ms, action.title);
        if (!pick) throw new ActionRefused(`仓库 ${it.repo} 没有名为「${action.title}」的里程碑；客户端不新建里程碑，没有修改`);
        number = pick.number;
      }
      await client.rest('PATCH', `${repoPath(it.repo)}/issues/${it.number}`, { milestone: number });
      return { touched: [[it.repo, it.number]], warning: null };
    }
    case 'setIteration':
    case 'setStatus': {
      const it = needItem(ctx);
      const p = projectOf(ctx, action.projectKey);
      const m = membershipOf(it, p);
      if (action.kind === 'setIteration') await setField(client, p, m.itemId, 'iteration', action.iterationId);
      else await setField(client, p, m.itemId, 'status', action.status);
      return { touched: [[it.repo, it.number]], warning: null };
    }
    case 'addToProject': {
      const it = needItem(ctx);
      const p = projectOf(ctx, action.projectKey);
      if (!it.nodeId) throw new ActionRefused('这一条的数据是旧版本缓存的，请先刷新一次');
      // check everything that can be checked before the first write
      checkFieldValues(p, action.iterationId, action.status);
      const fieldError = await joinProject(client, p, it.nodeId, action.iterationId, action.status);
      const warning = fieldError === null ? null : `已加入看板「${p.title}」，但设置字段没有成功：${explainError(fieldError, action.kind)}`;
      return { touched: [[it.repo, it.number]], warning };
    }
    case 'comment': {
      const it = needItem(ctx);
      if (!action.body.trim()) throw new ActionRefused('评论是空的，没有发送');
      await client.rest('POST', `${repoPath(it.repo)}/issues/${it.number}/comments`, { body: action.body });
      return { touched: [[it.repo, it.number]], warning: null };
    }
    case 'handBack':
    case 'autopilot':
    case 'merge':
    case 'closePr':
    case 'closeIssue':
      // GitHub#250: these run step by step in the controller (closeStep / commentStep / mergeStep / labels), never here
      throw new ActionRefused('这类操作走后台的逐步执行，不在这里发送');
    case 'toggleTask':
    case 'editEntry':
    case 'editTitle': {
      // GitHub#489: the same read-before-write a send record makes (prepareSend), done and written here at once
      const it = needItem(ctx);
      const p = await prepareSend(client, action, it);
      if (!p.write) return { touched: [], warning: null };
      return { touched: [[it.repo, it.number]], warning: await p.write() };
    }
    case 'createIssue': {
      if (!action.title.trim()) throw new ActionRefused('标题不能为空');
      if (!/^[^/\s]+\/[^/\s]+$/.test(action.repo)) throw new ActionRefused('请选择仓库');
      const handoff = action.handoff ?? 'none';
      if (!HANDOFFS.includes(handoff)) throw new ActionRefused('不知道建好后交给谁，没有新建');
      const plan = action.plan;
      if (plan) await checkCreatePlan(client, action.repo, plan, ctx.createInProjects);
      // GitHub#245: the hand-over labels are checked against the repository's labels read right now —
      // a label it does not have would be created by GitHub; a list that cannot be read is unknown, not "none"
      let handoffLabels: string[] = [];
      if (handoff !== 'none') {
        let names: string[];
        try {
          names = (await client.restList<{ name: string }>(`${repoPath(action.repo)}/labels?per_page=100`)).map((l) => l.name);
        } catch (e) {
          if (e instanceof GitHubError && e.kind === 'auth') throw e; // the credential: handled like any other call
          throw new ActionRefused(`读不到仓库 ${action.repo} 的标签，暂时不能确认标签在不在，没有新建：${explainError(e, 'createIssue')}`);
        }
        const check = checkHandoff(handoff, ctx.handBack, { state: 'ok', names });
        if (check.state !== 'ok') throw new ActionRefused(`${handoffProblem(action.repo, check)}，没有新建`);
        handoffLabels = check.labels;
      }
      const labels = mergeLabels(handoffLabels, action.labels);
      let created: { number: number; node_id: string; labels?: { name: string }[] } | null;
      try {
        created = await client.rest<{ number: number; node_id: string; labels?: { name: string }[] }>('POST', `${repoPath(action.repo)}/issues`, {
          title: action.title,
          body: action.body,
          labels,
          ...(plan?.milestone ? { milestone: plan.milestone.number } : {}),
        });
      } catch (e) {
        if (refusedForSure(e)) throw e;
        throw new CreateUnanswered((e as Error)?.message ?? String(e));
      }
      if (!created || typeof created.number !== 'number') throw new CreateUnanswered('GitHub 的回应里没有新 issue');
      // GitHub drops the labels of an account without write access to the repository, without an error: said, never silent
      const dropped = Array.isArray(created.labels) ? droppedLabels(labels, created.labels.map((l) => l.name)) : [];
      const droppedHandoff = dropped.some((n) => handoffLabels.some((h) => h.toLowerCase() === n.toLowerCase()));
      const failed: string[] = [];
      const fields: string[] = [];
      const boards: CreateBoard[] = [];
      for (const p of ctx.createInProjects) {
        const entry = plan?.projects.find((x) => x.projectKey === p.key);
        try {
          if (!p.viewerCanUpdate) throw new ActionRefused('这个账号不能修改它');
          const fieldError = await joinProject(client, p, created.node_id, entry?.iterationId ?? null, entry?.status ?? null);
          if (fieldError !== null) {
            fields.push(`「${p.title}」（${explainError(fieldError, 'addToProject')}）`);
            boards.push(createBoard(p, 'fieldsFailed', explainError(fieldError, 'addToProject'), entry));
          }
        } catch (e) {
          failed.push(`「${p.title}」（${explainError(e, 'addToProject')}）`);
          boards.push(createBoard(p, 'missing', explainError(e, 'addToProject'), entry));
        }
      }
      const labelsNote = dropped.length ? `GitHub 没有加上标签${dropped.map((n) => `「${n}」`).join('、')}（这个账号可能没有该仓库的写权限）${droppedHandoff ? '，还没有交给 agent' : ''}` : '';
      const problems = [
        labelsNote,
        failed.length ? `没能加入看板 ${failed.join('、')}` : '',
        fields.length ? `已加入看板但字段没设上 ${fields.join('、')}` : '',
      ].filter(Boolean);
      return {
        touched: [[action.repo, created.number]],
        warning: problems.length ? `issue #${created.number} 已建好，但${problems.join('；')}` : null,
        createdKey: itemKey(action.repo, created.number),
        boards,
        createdNodeId: created.node_id,
        ...(labelsNote ? { labelsNote } : {}),
      };
    }
  }
}
