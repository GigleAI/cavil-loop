// GitHub#434: the REST endpoints "等前置…" uses, on the fake's own state: one issue / PR, an issue's
// native "Blocked by" list (read and add — the same `relations` store the board's GraphQL reads, so
// the dependency graph follows), and GitHub's issue search. Comments and label events are served by
// writes.ts (handleRest).

import { createHash } from 'node:crypto';
import { findCopies, gqlContent, type FakeRelated, type Store } from './writes';

type Send = (status: number, body?: unknown) => void;

/** GitHub's numeric id of an issue / PR in the fake: stable, from its repository and number */
export function restIdOf(repo: string, n: number): number {
  return 10_000_000 + (parseInt(createHash('sha256').update(`${repo.toLowerCase()}#${n}`).digest('hex').slice(0, 7), 16) % 89_000_000);
}

function restIssue(store: Store, repo: string, n: number): Record<string, unknown> | null {
  const c = findCopies(store, repo, n);
  if (!c) return null;
  const g = c.gql[0];
  const r = c.rest[0];
  const labels = gqlContent(c).labels.nodes.map((l: any) => ({ name: l.name, color: l.color ?? 'ededed' }));
  const state = g ? (g.state === 'OPEN' ? 'open' : 'closed') : r.state;
  const merged = g ? g.state === 'MERGED' || g.merged === true : !!r?.pull_request?.merged_at;
  return {
    id: restIdOf(c.repo, n),
    node_id: g?.id ?? r?.node_id,
    number: n,
    title: g?.title ?? r?.title ?? '',
    state,
    state_reason: r?.state_reason ?? (g?.stateReason ? String(g.stateReason).toLowerCase() : null),
    html_url: g?.url ?? r?.html_url ?? `https://github.com/${c.repo}/issues/${n}`,
    labels,
    repository_url: `https://api.github.com/repos/${c.repo}`,
    ...(c.kind === 'PullRequest' ? { pull_request: { merged_at: merged ? '2026-01-01T00:00:00Z' : null } } : {}),
  };
}

function allItems(store: Store): { repo: string; number: number }[] {
  const out = new Map<string, { repo: string; number: number }>();
  for (const [repo, list] of store.repos) for (const r of list) out.set(`${repo}#${r.number}`, { repo, number: r.number });
  for (const pages of store.projects.values())
    for (const p of pages)
      for (const node of p.items.nodes) {
        const c = node.content;
        if (c?.repository?.nameWithOwner && typeof c.number === 'number') out.set(`${c.repository.nameWithOwner.toLowerCase()}#${c.number}`, { repo: c.repository.nameWithOwner, number: c.number });
      }
  return [...out.values()];
}

/** true = answered */
export function handleBlockedRest(store: Store, method: string, path: string, body: any, send: Send): boolean {
  const w = store.w as any;
  const url = new URL(`http://x${path}`);
  if (method === 'GET' && url.pathname === '/api/search/issues') {
    if (w.failSearch) return send(502, { message: 'Server Error' }), true;
    const q = url.searchParams.get('q') ?? '';
    const repo = /repo:(\S+)/.exec(q)?.[1]?.toLowerCase() ?? '';
    const words = q
      .split(/\s+/)
      .filter((x) => x && !/^(repo|is|in):/.test(x))
      .map((x) => x.toLowerCase());
    const items = allItems(store)
      .filter((x) => x.repo.toLowerCase() === repo)
      .map((x) => restIssue(store, x.repo, x.number)!)
      .filter((i) => i && i.state === 'open' && words.every((wd) => String(i.title).toLowerCase().includes(wd)));
    return send(200, { total_count: items.length, incomplete_results: false, items }), true;
  }
  const m = url.pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)(\/dependencies\/blocked_by)?$/);
  if (!m) return false;
  const repo = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
  const n = Number(m[3]);
  const c = findCopies(store, repo, n);
  if (!c) return false;
  const key = `${repo.toLowerCase()}#${n}`;
  if (!m[4]) {
    if (method !== 'GET') return false;
    if (w.failIssueRead?.has(key)) return send(502, { message: 'Server Error' }), true;
    return send(200, restIssue(store, repo, n)), true;
  }
  const rel = w.relations.get(key) ?? { parent: null, subIssues: [], blockedBy: [], blocking: [] };
  if (method === 'GET') {
    if (w.failDependencies) return send(502, { message: 'Server Error' }), true;
    if (c.kind === 'PullRequest') return send(200, []), true;
    return send(200, rel.blockedBy.map((x: FakeRelated) => restIssue(store, x.repository.nameWithOwner, x.number) ?? { id: restIdOf(x.repository.nameWithOwner, x.number), number: x.number, title: x.title, state: x.state === 'OPEN' ? 'open' : 'closed', repository_url: `https://api.github.com/repos/${x.repository.nameWithOwner}` })), true;
  }
  if (method === 'POST') {
    if (c.kind === 'PullRequest') return send(422, { message: 'Validation Failed' }), true;
    const target = allItems(store).find((x) => restIdOf(x.repo, x.number) === body?.issue_id);
    if (!target) return send(422, { message: 'Validation Failed: issue not found' }), true;
    const tc = findCopies(store, target.repo, target.number)!;
    // measured on GitHub (scripts/_lib.sh, GitHub#157): a PR as the blocker is refused
    if (tc.kind === 'PullRequest') return send(422, { message: 'Target issue may only be an issue' }), true;
    if (rel.blockedBy.some((x: FakeRelated) => x.number === target.number && x.repository.nameWithOwner.toLowerCase() === target.repo.toLowerCase())) return send(422, { message: 'Validation Failed: already exists' }), true;
    const t = restIssue(store, target.repo, target.number)!;
    rel.blockedBy.push({ number: target.number, title: String(t.title), url: String(t.html_url), state: t.state === 'open' ? 'OPEN' : 'CLOSED', stateReason: null, repository: { nameWithOwner: tc.repo } });
    w.relations.set(key, rel);
    (w.dependencyWrites ??= []).push({ key, target: `${target.repo.toLowerCase()}#${target.number}` });
    return send(201, t), true;
  }
  return false;
}
