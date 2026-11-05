// Every change the client makes on GitHub, one function per kind. Rules:
//   - labels: send only "add this one" / "remove this one", never the whole list
//     (a whole list would silently undo labels somebody else added meanwhile);
//   - merge: always send the commit the user saw (GitHub refuses if the PR moved);
//     never ask for an admin merge that bypasses branch protection;
//   - milestone: the item's own repository's milestone with that title; none →
//     refused before anything is sent (milestones are never created here);
//   - Project fields: only that Project, only with its own field / option ids;
//   - a refusal found before sending (ActionRefused) means nothing was sent.
// Nothing is retried or queued: one request, its answer is the result.

import type { MergeMethod, RepoOptions, WriteAction } from '../shared/actions';
import type { HandBackLabels, Item, ProjectMeta } from '../shared/types';
import { itemKey } from '../shared/sources';
import { GitHubClient, GitHubError } from './github';
import {
  ADD_PROJECT_ITEM_MUTATION,
  CLEAR_FIELD_MUTATION,
  SET_ITERATION_MUTATION,
  SET_STATUS_MUTATION,
} from './queries';

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
}

export interface ActionOutcome {
  /** items to re-read from GitHub now: [repo, number] */
  touched: [string, number][];
  /** done, but a follow-up step did not work */
  warning: string | null;
  createdKey?: string;
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

export async function addLabel(client: GitHubClient, repo: string, number: number, label: string): Promise<void> {
  await client.rest('POST', `${repoPath(repo)}/issues/${number}/labels`, { labels: [label] });
}

export async function removeLabel(client: GitHubClient, repo: string, number: number, label: string): Promise<void> {
  await client.rest('DELETE', `${repoPath(repo)}/issues/${number}/labels/${enc(label)}`);
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
        const same = ms.filter((m) => m.title === action.title);
        const pick = same.find((m) => m.state === 'open') ?? same[0];
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
      if (action.iterationId !== null && !p.iterations.some((i) => i.id === action.iterationId)) throw new ActionRefused(`看板「${p.title}」没有这个迭代`);
      if (action.status !== null && !p.statusOptionIds.some((o) => o.name === action.status)) throw new ActionRefused(`看板「${p.title}」的状态里没有「${action.status}」`);
      const r = await client.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(ADD_PROJECT_ITEM_MUTATION, {
        projectId: p.projectId,
        contentId: it.nodeId,
      });
      const itemId = r.addProjectV2ItemById.item.id;
      let warning: string | null = null;
      try {
        if (action.iterationId !== null) await setField(client, p, itemId, 'iteration', action.iterationId);
        if (action.status !== null) await setField(client, p, itemId, 'status', action.status);
      } catch (e) {
        warning = `已加入看板「${p.title}」，但设置字段没有成功：${explainError(e, action.kind)}`;
      }
      return { touched: [[it.repo, it.number]], warning };
    }
    case 'comment': {
      const it = needItem(ctx);
      if (!action.body.trim()) throw new ActionRefused('评论是空的，没有发送');
      await client.rest('POST', `${repoPath(it.repo)}/issues/${it.number}/comments`, { body: action.body });
      return { touched: [[it.repo, it.number]], warning: null };
    }
    case 'handBack': {
      const it = needItem(ctx);
      const { human, agent } = ctx.handBack;
      if (!human.trim() || !agent.trim()) throw new ActionRefused('设置里「交回 agent」的两个标签名不能为空');
      // add first: if the second step fails, the item is never left with neither label
      await addLabel(client, it.repo, it.number, agent);
      let warning: string | null = null;
      // removed whatever the cached labels say (the cache may be a round behind)
      try {
        await removeLabel(client, it.repo, it.number, human);
      } catch (e) {
        // 404 = the label is not on it (any more): that is the state we wanted
        if (!(e instanceof GitHubError && e.status === 404)) warning = `已加上「${agent}」，但摘「${human}」没有成功：${explainError(e, 'removeLabel')}`;
      }
      return { touched: [[it.repo, it.number]], warning };
    }
    case 'merge': {
      const it = needItem(ctx);
      if (it.kind !== 'pr') throw new ActionRefused('这一条不是 PR');
      if (!/^[0-9a-f]{40}$/.test(action.headOid)) throw new ActionRefused('不知道你看到的是哪个提交，请刷新详情后再合并');
      if (!(['merge', 'squash', 'rebase'] as MergeMethod[]).includes(action.method)) throw new ActionRefused('未知的合并方式');
      await client.rest('PUT', `${repoPath(it.repo)}/pulls/${it.number}/merge`, { merge_method: action.method, sha: action.headOid });
      return { touched: [[it.repo, it.number]], warning: null };
    }
    case 'closePr': {
      const it = needItem(ctx);
      if (it.kind !== 'pr') throw new ActionRefused('这一条不是 PR');
      // close first: a refused close leaves no orphan comment behind
      await client.rest('PATCH', `${repoPath(it.repo)}/pulls/${it.number}`, { state: 'closed' });
      let warning: string | null = null;
      if (action.comment.trim()) {
        try {
          await client.rest('POST', `${repoPath(it.repo)}/issues/${it.number}/comments`, { body: action.comment });
        } catch (e) {
          warning = `PR 已关闭，但附的评论没有发出去：${explainError(e, 'comment')}`;
        }
      }
      return { touched: [[it.repo, it.number]], warning };
    }
    case 'createIssue': {
      if (!action.title.trim()) throw new ActionRefused('标题不能为空');
      if (!/^[^/\s]+\/[^/\s]+$/.test(action.repo)) throw new ActionRefused('请选择仓库');
      const created = await client.rest<{ number: number; node_id: string }>('POST', `${repoPath(action.repo)}/issues`, {
        title: action.title,
        body: action.body,
        labels: action.labels,
      });
      if (!created) throw new GitHubError('http', 'GitHub 没有返回新 issue');
      const failed: string[] = [];
      for (const p of ctx.createInProjects) {
        try {
          if (!p.viewerCanUpdate) throw new ActionRefused('这个账号不能修改它');
          await client.graphql(ADD_PROJECT_ITEM_MUTATION, { projectId: p.projectId, contentId: created.node_id });
        } catch (e) {
          failed.push(`「${p.title}」（${explainError(e, 'addToProject')}）`);
        }
      }
      return {
        touched: [[action.repo, created.number]],
        warning: failed.length ? `issue #${created.number} 已建好，但没能加入看板 ${failed.join('、')}` : null,
        createdKey: itemKey(action.repo, created.number),
      };
    }
  }
}
