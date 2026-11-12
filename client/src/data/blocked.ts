// GitHub#434: the GitHub side of "等前置…" — one full read of an item (state, labels, the waiting
// label's events, the registrations, the native "Blocked by" list), the search of the picker, and
// the native relation write. Every list is read to its last page; anything short throws (the caller
// reads a throw as "could not read", never as "nothing there"). The rules are shared/blocked.ts.

import type { BlockedRead, Pick, Ref, RestComment, RestEvent } from '../shared/blocked';
import { roundMarks, roundOf } from '../shared/blocked';
import { GitHubClient, GitHubError } from './github';

function repoPath(repo: string): string {
  const [owner, name] = repo.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

interface RestIssue {
  id?: number;
  number?: number;
  title?: string;
  state?: string;
  state_reason?: string | null;
  html_url?: string;
  labels?: ({ name?: string } | string)[];
  pull_request?: { merged_at?: string | null } | null;
  repository_url?: string;
}

/** One item as the picker shows it. */
export interface Candidate extends Pick {
  state: 'open' | 'closed' | 'merged';
  url: string;
}

function stateOf(i: RestIssue): 'open' | 'closed' | 'merged' {
  if (i.pull_request && i.pull_request.merged_at) return 'merged';
  return i.state === 'open' ? 'open' : 'closed';
}

function candidateOf(repo: string, i: RestIssue): Candidate {
  if (typeof i.id !== 'number' || typeof i.number !== 'number' || typeof i.state !== 'string') throw new GitHubError('http', `${repo} 的条目缺字段`);
  return { repo: repo.toLowerCase(), number: i.number, kind: i.pull_request ? 'pr' : 'issue', id: i.id, title: i.title ?? '', state: stateOf(i), url: i.html_url ?? '' };
}

function repoOfUrl(url: string | undefined): string | null {
  const m = /\/repos\/([^/]+\/[^/]+)$/.exec(url ?? '');
  return m ? m[1].toLowerCase() : null;
}

/** GitHub#434: one item, by repository and number (the picker's "编号" search, and a prerequisite's state). */
export async function readCandidate(client: GitHubClient, repo: string, number: number): Promise<Candidate> {
  const i = await client.rest<RestIssue>('GET', `${repoPath(repo)}/issues/${number}`);
  if (!i) throw new GitHubError('http', `读不到 ${repo}#${number}`);
  return candidateOf(repo, i);
}

/** GitHub#434: open issues / PRs of `repo` whose title has `text` (GitHub's search; one page is enough for a picker). */
export async function searchCandidates(client: GitHubClient, repo: string, text: string): Promise<Candidate[]> {
  const q = `repo:${repo} is:open in:title ${text.replace(/"/g, ' ')}`;
  const r = await client.rest<{ items?: RestIssue[] }>('GET', `/search/issues?q=${encodeURIComponent(q)}&per_page=20`);
  if (!r || !Array.isArray(r.items)) throw new GitHubError('http', 'GitHub 搜索的回应不完整');
  return r.items.map((i) => candidateOf(repoOfUrl(i.repository_url) ?? repo, i));
}

/**
 * GitHub#434: everything "等前置…" decides on, read now in full. `blocked`: the waiting label's name
 * (its events make the current wait). Throws when any part could not be read whole.
 */
export async function readBlocked(client: GitHubClient, repo: string, number: number, blocked: string): Promise<BlockedRead> {
  const base = `${repoPath(repo)}/issues/${number}`;
  const [item, events, comments, deps] = await Promise.all([
    client.rest<RestIssue>('GET', base),
    client.restList<RestEvent>(`${base}/events?per_page=100`),
    client.restList<RestComment>(`${base}/comments?per_page=100`),
    client.restList<RestIssue>(`${base}/dependencies/blocked_by?per_page=100`),
  ]);
  if (!item || typeof item.state !== 'string' || !Array.isArray(item.labels)) throw new GitHubError('http', `读不到 ${repo}#${number} 的状态和标签`);
  const labels = item.labels.map((l) => (typeof l === 'string' ? l : (l?.name ?? '')));
  if (labels.some((l) => !l)) throw new GitHubError('http', `${repo}#${number} 的标签缺名字`);
  for (const e of events) if (typeof e?.id !== 'number' || typeof e.event !== 'string') throw new GitHubError('http', `${repo}#${number} 的标签记录缺字段`);
  for (const c of comments) if (typeof c?.id !== 'number' || typeof c.created_at !== 'string') throw new GitHubError('http', `${repo}#${number} 的评论缺字段`);
  const native: Ref[] = deps.map((d) => {
    const r = repoOfUrl(d.repository_url);
    if (!r || typeof d.number !== 'number') throw new GitHubError('http', `${repo}#${number} 的「Blocked by」缺字段`);
    return { repo: r, number: d.number };
  });
  const round = roundOf(events, blocked);
  return {
    state: stateOf(item),
    isPr: !!item.pull_request,
    labels,
    round,
    marks: roundMarks(comments, round, repo),
    native,
  };
}

/** GitHub#434: the comments of an item (to find this operation's registration when its answer was lost). */
export async function readComments(client: GitHubClient, repo: string, number: number): Promise<RestComment[]> {
  return client.restList<RestComment>(`${repoPath(repo)}/issues/${number}/comments?per_page=100`);
}

/** GitHub#434: one native "Blocked by" (the prerequisite by GitHub's numeric issue id). */
export async function addBlockedBy(client: GitHubClient, repo: string, number: number, issueId: number): Promise<void> {
  await client.rest('POST', `${repoPath(repo)}/issues/${number}/dependencies/blocked_by`, { issue_id: issueId });
}

/** GitHub#434: post the registration; returns the new comment's numeric id (null when GitHub did not say). */
export async function postComment(client: GitHubClient, repo: string, number: number, body: string): Promise<number | null> {
  const r = await client.rest<{ id?: number }>('POST', `${repoPath(repo)}/issues/${number}/comments`, { body });
  return typeof r?.id === 'number' ? r.id : null;
}
