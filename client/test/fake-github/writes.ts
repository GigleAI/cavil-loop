// The fake GitHub's writable side (sub-item #138): labels, milestones,
// comments, Project fields, adding to a Project, merging / closing PRs, closing issues,
// creating issues, plus the reads that go with them (one-item re-read, the
// detail page, label / milestone lists, the markdown renderer).
//
// An issue / PR can exist in two shapes at once — a REST issue (repository
// source) and a GraphQL `content` node inside a Project page. Every write is
// applied to every copy, so whichever read comes next sees the change.
// `digest()` serialises everything writable: "GitHub changed nothing" is
// asserted as an unchanged digest.

import { createHash } from 'node:crypto';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';

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
  /** markdown source (GitHub#193): when set, bodyHTML is rendered from it */
  body?: string;
  /** GitHub#429: the author's standing in the repository (GitHub's authorAssociation); absent = NONE */
  authorAssociation?: string;
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
  /** `owner/repo#n` lower-cased -> markdown source of the body (GitHub#193): when set, the rendered body comes from it */
  bodySources: Map<string, string>;
  /** node ids (bodies: the item's, comments: the comment's) this account may not change: viewerCanUpdate false, edits refused */
  cannotUpdate: Set<string>;
  /** answer the re-read of a body / comment source (CavilTaskSource) with HTTP 502 */
  failTaskSource: boolean;
  /** GitHub#299: answer the re-read of a title (CavilTitleSource) with HTTP 502 */
  failTitleSource: boolean;
  /** GitHub#299: a field the re-read of a title leaves out of its answer (a GitHub that answers short) */
  titleSourceDrop: 'title' | 'viewerCanUpdate' | null;
  /** GitHub#299: what GitHub keeps of a title written by PATCH (null = exactly what was sent) */
  titleKept: ((sent: string) => string) | null;
  /** adding this label answers HTTP 422 (GitHub#205: a step of "autopilot" that fails) */
  failLabel: string | null;
  /** repositories where every write answers 403 (the account has read access only) */
  readOnlyRepos: Set<string>;
  /** GitHub#381: what the markdown renderer answers, whatever was sent (a recorded rendering of GitHub's); null = the text in a <p> */
  markdownHtml: string | null;
  /** Project keys (`org/owner/n`) the account may not change: viewerCanUpdate false, mutations refused */
  readOnlyProjects: Set<string>;
  /** drop the connection of every write request (offline in the middle of a change) */
  dropWrites: boolean;
  /** page size of the detail page's comment / review lists */
  detailPageSize: number;
  /** page size of one review's line comments (GitHub: 100) */
  reviewCommentPageSize: number;
  /** answer the follow-up page of a review's line comments with HTTP 502 */
  failReviewCommentPages: boolean;
  /** items (`owner/repo#n` lower-cased) whose detail read answers HTTP 502 */
  failDetail: Set<string>;
  /** GitHub#279: items (`owner/repo#n` lower-cased) whose one-item re-read answers HTTP 502 */
  failRefresh: Set<string>;
  /** repositories (`owner/repo` lower-cased) whose milestone list answers HTTP 502 (GitHub#214) */
  failMilestones: Set<string>;
  /** repositories whose label list answers HTTP 502 (GitHub#245: "cannot read" is not "has none") */
  failLabels: Set<string>;
  /** repositories where a new issue's labels are dropped without an error, as GitHub does for an account without write access (GitHub#245) */
  dropIssueLabels: Set<string>;
  /** clock of updated_at / createdAt written by the fake */
  clock: () => string;
  /**
   * `owner/repo#n` lower-cased (a PR) -> issues it closes besides the ones whose
   * recorded "linked pull requests" name it (GitHub's closing issues references)
   */
  closingIssues: Map<string, { repo: string; number: number }[]>;
  /** page size of a PR's closing issues list (GitHub: whatever `first:` asks, at most 100) */
  closingIssuesPageSize: number;
  /**
   * GitHub's own Project automation, run on GitHub's side after a PR is merged / closed:
   * `delayMs` later the PR and the issues the merge closed get this Status in every Project.
   * null = no automation (the recorded state).
   */
  automation: { delayMs: number; status: string } | null;
  /** GitHub#250: `owner/repo#n` lower-cased -> label events (labeled / unlabeled), oldest first */
  labelEvents: Map<string, { id: number; event: 'labeled' | 'unlabeled'; label: { name: string }; actor: { login: string }; created_at: string }[]>;
  /** GitHub#250: posting a comment answers HTTP 422 */
  failComment: boolean;
  /** GitHub#250: removing this label answers HTTP 422 */
  failUnlabel: string | null;
  /** GitHub#250: answer the item events list with HTTP 502 */
  failEvents: boolean;
  /** GitHub#250: answer the item comments list with HTTP 502 */
  failCommentList: boolean;
  /** GitHub#359: label events per page of a snapshot (0 = 100); an older page fails; the labels a snapshot reports instead of the real ones */
  eventPage: number;
  failEventPages: boolean;
  staleSnapshotLabels: { name: string }[] | null;
  /** GitHub#429: page size of the loop-registration reads (comments, label removals; 0 = 100) */
  loopPage: number;
  /** GitHub#429: answer every loop-registration read of this `owner/repo#n` (lower-cased) with HTTP 502 */
  failLoop: Set<string>;
  /** GitHub#429: answer only the older pages of those reads with HTTP 502 */
  failLoopPages: boolean;
  /** GitHub#429: `owner/repo#n` lower-cased -> answer the prerequisite read as GitHub does for an issue this account cannot see */
  hiddenEnds: Set<string>;
  /** GitHub#258: Project key (`org/owner/n`) -> its workflows; a Project not listed answers the read with an error */
  workflows: Map<string, { name: string; enabled: boolean }[]>;
  /** GitHub#258: answer this many reads of "which boards is this new issue on" with HTTP 502 */
  failCreatedBoards: number;
  /**
   * GitHub#349: `owner/repo#n` lower-cased -> the issue's relations as recorded (the nodes of
   * each list, whole). Filled by `enrich` from the fixtures; an issue not listed has none.
   * Answers are built from here every time, with each related issue's title / state taken
   * live from the fake when it knows that issue (reopen a blocker and its arrows follow).
   */
  relations: Map<string, FakeRelations>;
  /** GitHub#349: how many of each list a read carries (GitHub: what the query asks for); `more` = the follow-up pages */
  relationPage: { subIssues: number; blockedBy: number; blocking: number; more: number };
  /** GitHub#349: `owner/repo#n` lower-cased -> a follow-up page of this issue's relations (CavilIssueRelations) answers HTTP 502 */
  failRelationPages: Set<string>;
  /** GitHub#349: the batch read of relations (CavilIssueRelationsBatch) answers HTTP 502 */
  failRelationsBatch: boolean;
  /**
   * GitHub#373: `owner/repo#n` lower-cased -> what `viewerSubscription` answers for the signed-in
   * account. Not listed = 'UNSUBSCRIBED' (the account never touched the item); null = GitHub
   * answers null.
   */
  subscriptions: Map<string, 'SUBSCRIBED' | 'UNSUBSCRIBED' | 'IGNORED' | null>;
  /**
   * GitHub#373: `owner/repo#n` lower-cased -> the pull request's review requests: the people
   * asked, how many teams, and `total` when GitHub has more than the read returns (default: all).
   */
  reviewRequests: Map<string, { users: string[]; teams?: number; total?: number }>;
}

export interface FakeRelated {
  number: number;
  title: string;
  url: string;
  state: string;
  stateReason: string | null;
  repository: { nameWithOwner: string };
}
export interface FakeRelations {
  parent: FakeRelated | null;
  subIssues: FakeRelated[];
  blockedBy: FakeRelated[];
  blocking: FakeRelated[];
}
const RELATION_LISTS = ['subIssues', 'blockedBy', 'blocking'] as const;

export function defaultWritable(): WritableState {
  return {
    repoLabels: new Map(),
    milestones: new Map(),
    mergeMethods: new Map(),
    pulls: new Map(),
    comments: new Map(),
    reviews: new Map(),
    bodies: new Map(),
    bodySources: new Map(),
    cannotUpdate: new Set(),
    failLabel: null,
    failMilestones: new Set(),
    failLabels: new Set(),
    dropIssueLabels: new Set(),
    failTaskSource: false,
    failTitleSource: false,
    titleSourceDrop: null,
    titleKept: null,
    readOnlyRepos: new Set(),
    markdownHtml: null,
    readOnlyProjects: new Set(),
    dropWrites: false,
    detailPageSize: 100,
    reviewCommentPageSize: 100,
    failReviewCommentPages: false,
    failDetail: new Set(),
    failRefresh: new Set(),
    clock: () => new Date().toISOString(),
    closingIssues: new Map(),
    closingIssuesPageSize: 100,
    automation: null,
    labelEvents: new Map(),
    failUnlabel: null,
    failComment: false,
    failEvents: false,
    failCommentList: false,
    eventPage: 0,
    failEventPages: false,
    staleSnapshotLabels: null,
    loopPage: 0,
    failLoop: new Set(),
    failLoopPages: false,
    hiddenEnds: new Set(),
    workflows: new Map(),
    failCreatedBoards: 0,
    relations: new Map(),
    relationPage: { subIssues: 50, blockedBy: 20, blocking: 20, more: 100 },
    failRelationPages: new Set(),
    failRelationsBatch: false,
    subscriptions: new Map(),
    reviewRequests: new Map(),
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
  // GitHub#349: the relations as recorded — on a board item they sit in its content, for a
  // repository issue the recorder keeps them beside it under `_relations` (not part of
  // GitHub's REST answer: taken out here)
  const rels = store.w.relations;
  const recorded = (ikey: string, x: any) => {
    if (!x || rels.has(ikey)) return;
    rels.set(ikey, {
      parent: x.parent ?? null,
      subIssues: (x.subIssues?.nodes ?? []).filter(Boolean),
      blockedBy: (x.blockedBy?.nodes ?? []).filter(Boolean),
      blocking: (x.blocking?.nodes ?? []).filter(Boolean),
    });
  };
  // a recording older than #349 knows only each issue's parent: its relations are derived from
  // that (the parent, and for the parent the children the fixture holds) — never hand-written
  const related = (repo: string, number: number): FakeRelated => ({ number, title: '', url: `https://github.com/${repo}/issues/${number}`, state: 'OPEN', stateReason: null, repository: { nameWithOwner: repo } });
  const legacy: { ikey: string; self: FakeRelated; parent: FakeRelated | null }[] = [];
  for (const pages of store.projects.values())
    for (const p of pages)
      for (const n of p.items.nodes) {
        const c = n.content;
        if (c?.__typename !== 'Issue') continue;
        const ikey = `${c.repository.nameWithOwner.toLowerCase()}#${c.number}`;
        if (c.subIssues || c.blockedBy || c.blocking) recorded(ikey, c);
        else legacy.push({ ikey, self: related(c.repository.nameWithOwner, c.number), parent: c.parent ? related(c.parent.repository.nameWithOwner, c.parent.number) : null });
      }
  for (const [repo, list] of store.repos)
    for (const r of list) {
      if (r.pull_request) continue;
      const ikey = `${repo}#${r.number}`;
      if (r._relations) recorded(ikey, r._relations);
      else {
        const m = String(r.parent_issue_url ?? '').match(/\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/);
        const name = String(r.html_url ?? '').match(/github\.com\/([^/]+\/[^/]+)\//)?.[1] ?? repo;
        legacy.push({ ikey, self: related(name, r.number), parent: m ? related(m[1], Number(m[2])) : null });
      }
      delete r._relations;
    }
  const keyOf = (x: FakeRelated) => `${x.repository.nameWithOwner.toLowerCase()}#${x.number}`;
  for (const l of legacy) {
    if (rels.has(l.ikey)) continue;
    const kids = legacy.filter((x, i) => x.parent && keyOf(x.parent) === l.ikey && legacy.findIndex((y) => y.ikey === x.ikey) === i).map((x) => x.self);
    if (l.parent || kids.length) rels.set(l.ikey, { parent: l.parent, subIssues: kids, blockedBy: [], blocking: [] });
  }
  for (const [repo, list] of store.repos)
    for (const r of list) {
      // a hand-built issue without the counts: derived from its relations (none = zeros), as GitHub always sends them
      if (!r.pull_request && !r.issue_dependencies_summary) {
        const rel = rels.get(`${repo}#${r.number}`);
        const open = (xs: FakeRelated[]) => xs.filter((x) => x.state === 'OPEN').length;
        r.issue_dependencies_summary = { blocked_by: open(rel?.blockedBy ?? []), blocking: open(rel?.blocking ?? []), total_blocked_by: rel?.blockedBy.length ?? 0, total_blocking: rel?.blocking.length ?? 0 };
      }
    }
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

/** GitHub#349: a related issue as the fake knows it now (its own copy when it has one), else as recorded. */
function liveRelated(store: Store, x: FakeRelated): FakeRelated {
  const c = findCopies(store, x.repository.nameWithOwner, x.number);
  if (!c) return x;
  if (c.gql.length) return { ...x, title: c.gql[0].title, state: c.gql[0].state === 'OPEN' ? 'OPEN' : 'CLOSED', stateReason: c.gql[0].stateReason ?? null };
  const r = c.rest[0];
  return { ...x, title: r.title, state: r.state === 'open' ? 'OPEN' : 'CLOSED', stateReason: r.state_reason ? String(r.state_reason).toUpperCase() : null };
}

function relationSlice(store: Store, list: FakeRelated[], after: string | null | undefined, size: number) {
  const start = after ? Number(String(after).replace(/^rel-/, '')) : 0;
  const nodes = list.slice(start, start + size).map((x) => liveRelated(store, x));
  const end = start + nodes.length;
  return { pageInfo: { hasNextPage: end < list.length, endCursor: nodes.length ? `rel-${end}` : null }, nodes };
}

/** GitHub#349: the relation fields of one issue as a read carries them (first page of each list). */
export function relationFields(store: Store, repo: string, number: number): any {
  const rel = store.w.relations.get(`${repo.toLowerCase()}#${number}`);
  const size = store.w.relationPage;
  return {
    parent: rel?.parent ? liveRelated(store, rel.parent) : null,
    subIssues: relationSlice(store, rel?.subIssues ?? [], null, size.subIssues),
    blockedBy: relationSlice(store, rel?.blockedBy ?? [], null, size.blockedBy),
    blocking: relationSlice(store, rel?.blocking ?? [], null, size.blocking),
  };
}

/** GitHub#373: how the signed-in account stands to an item, as a read answers it now. */
export function viewerFields(store: Store, kind: string, repo: string, number: number): any {
  const ikey = `${repo.toLowerCase()}#${number}`;
  const sub = store.w.subscriptions.has(ikey) ? store.w.subscriptions.get(ikey) : 'UNSUBSCRIBED';
  if (kind !== 'PullRequest') return { viewerSubscription: sub };
  const rr = store.w.reviewRequests.get(ikey) ?? { users: [] };
  const nodes = [
    ...rr.users.map((login) => ({ requestedReviewer: { __typename: 'User', login } })),
    ...Array.from({ length: rr.teams ?? 0 }, () => ({ requestedReviewer: { __typename: 'Team' } })),
  ];
  // the issues GitHub lists as linked to the pull request (GitHub computes these live), the first 20
  const c = findCopies(store, repo, number);
  const closing = c ? closingIssuesOf(store, c) : [];
  const shown = closing.slice(0, 20).map((x) => ({ number: x.number, repository: { nameWithOwner: x.repo } }));
  return { viewerSubscription: sub, reviewRequests: { totalCount: rr.total ?? nodes.length, nodes }, closingIssuesReferences: { totalCount: closing.length, nodes: shown } };
}

/**
 * Content as a read answers it: an issue with its relations as they are now (GitHub#349), an
 * issue / pull request with how the signed-in account stands to it (GitHub#373).
 */
export function withRelationFields(store: Store, content: any): any {
  if (!content || (content.__typename !== 'Issue' && content.__typename !== 'PullRequest')) return content;
  const viewer = viewerFields(store, content.__typename, content.repository.nameWithOwner, content.number);
  if (content.__typename !== 'Issue') return { ...content, ...viewer };
  return { ...content, ...viewer, ...relationFields(store, content.repository.nameWithOwner, content.number) };
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
    ...(c.kind === 'Issue' ? { stateReason: r.state_reason ? String(r.state_reason).toUpperCase() : null } : { isDraft: Boolean(r.draft) }),
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

/** Every GraphQL content copy of any item (Project pages), for reference updates. */
function allGqlContents(store: Store): any[] {
  return [...store.projects.values()].flatMap((pages) => pages.flatMap((p) => p.items.nodes.map((n) => n.content).filter(Boolean)));
}

/** The issues PR `c` closes: the extra list plus every recorded issue whose "linked pull requests" name it, in that order. */
export function closingIssuesOf(store: Store, c: Copies): { repo: string; number: number }[] {
  const out: { repo: string; number: number }[] = [];
  const seen = new Set<string>();
  const add = (repo: string, number: number) => {
    const k = `${repo.toLowerCase()}#${number}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ repo, number });
  };
  for (const x of store.w.closingIssues.get(`${c.repo.toLowerCase()}#${c.number}`) ?? []) add(x.repo, x.number);
  for (const g of allGqlContents(store))
    if (g.__typename === 'Issue' && (g.closedByPullRequestsReferences?.nodes ?? []).some((r: any) => r.number === c.number && r.repository.nameWithOwner.toLowerCase() === c.repo.toLowerCase()))
      add(g.repository.nameWithOwner, g.number);
  return out;
}

/** The PR's state as the issues' "linked pull requests" show it (GitHub computes these live). */
function updateReferences(store: Store, c: Copies, state: 'MERGED' | 'CLOSED') {
  for (const g of allGqlContents(store))
    for (const r of g.closedByPullRequestsReferences?.nodes ?? [])
      if (r.number === c.number && r.repository.nameWithOwner.toLowerCase() === c.repo.toLowerCase()) {
        r.state = state;
        r.merged = state === 'MERGED';
      }
}

/** GitHub's Project automation, `delayMs` after the change: these items get the Status `status` in every Project. */
function runAutomation(store: Store, items: { repo: string; number: number }[]) {
  const a = store.w.automation;
  if (!a) return;
  setTimeout(() => {
    for (const pages of store.projects.values()) {
      const field = pages[0]?.fields.nodes.find((f: any) => f.__typename === 'ProjectV2SingleSelectField' && f.name === 'Status');
      const option = field?.options.find((o: any) => o.name === a.status);
      if (!option) continue;
      for (const p of pages)
        for (const n of p.items.nodes)
          if (items.some((x) => n.content?.repository?.nameWithOwner?.toLowerCase() === x.repo.toLowerCase() && n.content.number === x.number))
            n.fieldValues.nodes = [
              ...n.fieldValues.nodes.filter((v: any) => v.field?.id !== field.id),
              { __typename: 'ProjectV2ItemFieldSingleSelectValue', optionId: option.id, name: option.name, field: { id: field.id, name: field.name } },
            ];
    }
  }, a.delayMs);
}

/**
 * The fake's markdown renderer (GitHub#193): CommonMark + GFM, with task-list
 * boxes in GitHub's own markup. Only the fake uses it — the client's reading of
 * the source is checked against GitHub's real rendering (test/fixtures/tasklists.github.json).
 */
export function renderMarkdown(md: string): string {
  return micromark(md, { extensions: [gfm()], htmlExtensions: [gfmHtml()] })
    .replace(/<li><input type="checkbox" disabled="" checked="" \/>/g, '<li class="task-list-item"><input type="checkbox" id="" disabled="" class="task-list-item-checkbox" aria-label="Completed task" checked="">')
    .replace(/<li><input type="checkbox" disabled="" \/>/g, '<li class="task-list-item"><input type="checkbox" id="" disabled="" class="task-list-item-checkbox" aria-label="Incomplete task">');
}

/** A comment as the detail query answers it: its source, rendered HTML and "may this account change it". */
function commentAnswer(store: Store, c: FakeComment, repoKey: string) {
  return {
    id: c.id,
    url: c.url,
    createdAt: c.createdAt,
    author: c.author,
    body: c.body ?? '',
    bodyHTML: c.body !== undefined ? renderMarkdown(c.body) : c.bodyHTML,
    viewerCanUpdate: !store.w.cannotUpdate.has(c.id) && !store.w.readOnlyRepos.has(repoKey),
  };
}

/** Find a comment by node id: [the item key `owner/repo#n` lower-cased, the comment]. */
function findComment(store: Store, id: string): [string, FakeComment] | null {
  for (const [k, list] of store.w.comments) {
    const c = list.find((x) => x.id === id);
    if (c) return [k, c];
  }
  return null;
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
    bodySources: [...w.bodySources],
  });
}

type Send = (status: number, body: unknown) => void;

/** REST writes + reads of #138. Returns false when the path is not one of them. */
export function handleRest(store: Store, method: string, path: string, body: any, send: Send, sendText: (s: string) => void, actor = 'user-1'): boolean {
  const w = store.w;
  if (method === 'POST' && path === '/api/markdown') {
    const esc = String(body?.text ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
    sendText(w.markdownHtml ?? `<p>${esc}</p>`);
    return true;
  }
  const m = path.match(/^\/api\/repos\/([^/]+)\/([^/]+)(\/.*)$/);
  if (!m) return false;
  const repo = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
  const key = repo.toLowerCase();
  const rest = m[3].replace(/\?.*$/, '');
  const known = store.repos.has(key) || [...store.projects.values()].some((pages) => pages.some((p) => p.items.nodes.some((n) => n.content?.repository?.nameWithOwner?.toLowerCase() === key)));
  if (!known) return false;

  if (method === 'GET' && rest === '/labels') {
    if (w.failLabels.has(key)) return send(502, { message: 'Server Error' }), true;
    return send(200, w.repoLabels.get(key) ?? []), true;
  }
  if (method === 'GET' && rest === '/milestones') {
    if (w.failMilestones.has(key)) return send(502, { message: 'Server Error' }), true;
    return send(200, w.milestones.get(key) ?? []), true;
  }
  // GitHub#250: an item's comments and events (what proves a write whose answer was lost)
  const gm = rest.match(/^\/issues\/(\d+)\/(comments|events)$/);
  if (method === 'GET' && gm) {
    const gc = findCopies(store, repo, Number(gm[1]));
    if (!gc) return send(404, { message: 'Not Found' }), true;
    const gk = `${key}#${gc.number}`;
    if (gm[2] === 'events') {
      if (w.failEvents) return send(502, { message: 'Server Error' }), true;
      return send(200, w.labelEvents.get(gk) ?? []), true;
    }
    if (w.failCommentList) return send(502, { message: 'Server Error' }), true;
    return send(200, (w.comments.get(gk) ?? []).map((x, i) => ({ id: i + 1, node_id: x.id, body: x.body ?? '', created_at: x.createdAt, user: x.author ? { login: x.author.login } : null }))), true;
  }
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
      labels: (w.dropIssueLabels.has(key) ? [] : (body.labels ?? [])).map((n: string) => ({ name: n, color: colors.get(n) ?? 'ededed' })),
      assignees: [],
      milestone: null as null | { number: number; title: string; due_on: string | null },
    };
    // GitHub#214: created with a milestone (its number); one that does not exist is refused, nothing created
    if (body.milestone != null) {
      const ms = (w.milestones.get(key) ?? []).find((x) => x.number === body.milestone);
      if (!ms) return send(422, { message: 'Validation Failed: milestone does not exist' }), true;
      issue.milestone = { number: ms.number, title: ms.title, due_on: ms.due_on };
    }
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
    if (w.failLabel !== null && add.includes(w.failLabel)) return send(422, { message: 'Validation Failed' }), true;
    const colors = new Map((w.repoLabels.get(key) ?? []).map((l) => [l.name, l.color]));
    for (const name of add) {
      const color = colors.get(name) ?? 'ededed';
      if (!gqlContent(c).labels.nodes.some((l: any) => l.name === name)) labelEvent(w, ikey, 'labeled', name, actor);
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
    if (w.failUnlabel === name) return send(422, { message: 'Validation Failed' }), true;
    labelEvent(w, ikey, 'unlabeled', name, actor);
    for (const r of c.rest) r.labels = r.labels.filter((l: any) => l.name !== name);
    for (const g of c.gql) g.labels.nodes = g.labels.nodes.filter((l: any) => l.name !== name);
    touch(store, c);
    return send(200, gqlContent(c).labels.nodes), true;
  }
  if (im[1] === 'issues' && method === 'PATCH' && sub === '') {
    // GitHub#299: the title of an issue or a PR (GitHub's issues endpoint takes both)
    let title: string | undefined;
    if (body && 'title' in body) {
      if (typeof body.title !== 'string' || !body.title.trim()) return send(422, { message: 'Validation Failed: title cannot be blank' }), true;
      if (w.cannotUpdate.has(gqlContent(c).id)) return send(403, { message: 'Must have admin rights to Repository.' }), true;
      title = w.titleKept ? w.titleKept(body.title) : body.title;
      for (const r of c.rest) r.title = title;
      for (const g of c.gql) g.title = title;
    }
    if (body && 'milestone' in body) {
      const ms = body.milestone === null ? null : (w.milestones.get(key) ?? []).find((x) => x.number === body.milestone);
      if (body.milestone !== null && !ms) return send(422, { message: 'Validation Failed: milestone does not exist' }), true;
      for (const r of c.rest) r.milestone = ms ? { number: ms.number, title: ms.title, due_on: ms.due_on } : null;
      for (const g of c.gql) g.milestone = ms ? { number: ms.number, title: ms.title, dueOn: ms.due_on } : null;
    }
    if (body && 'state' in body) {
      // GitHub: state open / closed; state_reason completed / not_planned / duplicate / reopened (closing without one = completed)
      if (body.state !== 'open' && body.state !== 'closed') return send(422, { message: 'Validation Failed: state' }), true;
      const reason = body.state_reason ?? (body.state === 'closed' ? 'completed' : 'reopened');
      if (!['completed', 'not_planned', 'duplicate', 'reopened'].includes(reason)) return send(422, { message: 'Validation Failed: state_reason' }), true;
      for (const r of c.rest) Object.assign(r, { state: body.state, state_reason: reason });
      for (const g of c.gql)
        if (g.state !== 'MERGED') Object.assign(g, { state: body.state === 'open' ? 'OPEN' : 'CLOSED', ...(c.kind === 'Issue' ? { stateReason: reason.toUpperCase() } : {}) });
    }
    touch(store, c);
    return send(200, { number: c.number, ...(title !== undefined ? { title } : {}) }), true;
  }
  if (im[1] === 'issues' && method === 'POST' && sub === '/comments') {
    if (w.failComment) return send(422, { message: 'Validation Failed: body is too long' }), true;
    const list = w.comments.get(ikey) ?? [];
    const id = `IC_fake_${list.length + 1}_${c.number}`;
    list.push({ id, url: `https://github.com/${c.repo}/issues/${c.number}#issuecomment-${list.length + 1}`, createdAt: w.clock(), bodyHTML: `<p>${String(body?.body ?? '')}</p>`, author: { login: actor }, body: String(body?.body ?? '') });
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
    // GitHub closes the issues the PR closes, and its Project automation runs later
    const closing = closingIssuesOf(store, c);
    for (const ref of closing) {
      const ic = findCopies(store, ref.repo, ref.number);
      if (!ic) continue;
      // a merge closes them as completed (GitHub's state_reason)
      for (const r of ic.rest) Object.assign(r, { state: 'closed', state_reason: 'completed' });
      for (const g of ic.gql) Object.assign(g, { state: 'CLOSED', stateReason: 'COMPLETED' });
      touch(store, ic);
    }
    updateReferences(store, c, 'MERGED');
    runAutomation(store, [{ repo: c.repo, number: c.number }, ...closing]);
    return send(200, { merged: true, sha: pr.headOid }), true;
  }
  if (im[1] === 'pulls' && method === 'PATCH' && sub === '') {
    if (body?.state === 'closed') {
      for (const r of c.rest) r.state = 'closed';
      for (const x of c.gql) if (x.state === 'OPEN') x.state = 'CLOSED';
      updateReferences(store, c, 'CLOSED');
      runAutomation(store, [{ repo: c.repo, number: c.number }]);
    }
    touch(store, c);
    return send(200, { number: c.number }), true;
  }
  return false;
}

function labelEvent(w: WritableState, ikey: string, event: 'labeled' | 'unlabeled', name: string, actor: string) {
  const list = w.labelEvents.get(ikey) ?? [];
  list.push({ id: list.length + 1, event, label: { name }, actor: { login: actor }, created_at: w.clock() });
  w.labelEvents.set(ikey, list);
}

function projectByNodeId(store: Store, id: string): { key: string; pages: ProjectPage[] } | null {
  for (const [key, pages] of store.projects) if (pages[0]?.id === id) return { key, pages };
  return null;
}

type GqlAnswer = { data?: unknown; errors?: { message: string; type?: string }[]; httpStatus?: number };

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

  // ---- GitHub#193: re-read one body / comment source, write it back ----
  if (op === 'CavilTaskSource') {
    if (w.failTaskSource) return { httpStatus: 502 };
    const cm = findComment(store, v.id);
    if (cm) {
      const [k, c] = cm;
      const [repoKey, n] = k.split('#');
      const ic = findCopies(store, repoKey, Number(n))!;
      return { data: { node: { __typename: 'IssueComment', body: c.body ?? '', viewerCanUpdate: commentAnswer(store, c, repoKey).viewerCanUpdate, issue: { number: ic.number, repository: { nameWithOwner: ic.repo } } } } };
    }
    const it = findByNodeId(store, v.id);
    if (!it) return { data: { node: null }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a node with the global id of '${v.id}'` }] };
    const k = `${it.repo.toLowerCase()}#${it.number}`;
    return {
      data: {
        node: {
          __typename: it.kind,
          body: w.bodySources.get(k) ?? '',
          viewerCanUpdate: !w.cannotUpdate.has(v.id) && !w.readOnlyRepos.has(it.repo.toLowerCase()),
          number: it.number,
          repository: { nameWithOwner: it.repo },
        },
      },
    };
  }
  // ---- GitHub#299: re-read one item's title ----
  if (op === 'CavilTitleSource') {
    if (w.failTitleSource) return { httpStatus: 502 };
    const c = findCopies(store, `${v.owner}/${v.name}`, v.number);
    if (!c) return { data: { repository: { issueOrPullRequest: null } }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to an issue or pull request with the number of ${v.number}.` }] };
    const content = gqlContent(c);
    const node: Record<string, unknown> = {
      __typename: c.kind,
      title: content.title,
      viewerCanUpdate: !w.cannotUpdate.has(content.id) && !w.readOnlyRepos.has(c.repo.toLowerCase()),
      number: c.number,
    };
    if (w.titleSourceDrop) delete node[w.titleSourceDrop];
    return { data: { repository: { issueOrPullRequest: node } } };
  }
  if (op === 'CavilUpdateComment' || op === 'CavilUpdateIssueBody' || op === 'CavilUpdatePrBody') {
    const text = String(v.body ?? '');
    if (op === 'CavilUpdateComment') {
      const cm = findComment(store, v.id);
      if (!cm) return err(`Could not resolve to a node with the global id of '${v.id}'`, 'NOT_FOUND');
      const [k, c] = cm;
      if (w.cannotUpdate.has(c.id) || w.readOnlyRepos.has(k.split('#')[0])) return err('Resource not accessible by integration', 'FORBIDDEN');
      c.body = text;
      return { data: { updateIssueComment: { issueComment: { body: text } } } };
    }
    const it = findByNodeId(store, v.id);
    const want = op === 'CavilUpdateIssueBody' ? 'Issue' : 'PullRequest';
    if (!it || it.kind !== want) return err(`Could not resolve to a ${want} with the global id of '${v.id}'`, 'NOT_FOUND');
    if (w.cannotUpdate.has(v.id) || w.readOnlyRepos.has(it.repo.toLowerCase())) return err('Resource not accessible by integration', 'FORBIDDEN');
    w.bodySources.set(`${it.repo.toLowerCase()}#${it.number}`, text);
    touch(store, it);
    return { data: want === 'Issue' ? { updateIssue: { issue: { body: text } } } : { updatePullRequest: { pullRequest: { body: text } } } };
  }

  if (op === 'CavilReviewComments') {
    if (w.failReviewCommentPages) return { httpStatus: 502 };
    for (const list of w.reviews.values()) {
      const r = list.find((x) => x.id === v.id);
      if (!r) continue;
      const start = v.after ? Number(String(v.after).replace(/^l-/, '')) : 0;
      const nodes = r.comments.nodes.slice(start, start + w.reviewCommentPageSize);
      const end = start + nodes.length;
      return { data: { node: { comments: { pageInfo: { hasNextPage: end < r.comments.nodes.length, endCursor: nodes.length ? `l-${end}` : null }, nodes } } } };
    }
    return { data: { node: null }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a node with the global id of '${v.id}'` }] };
  }

  if (op === 'CavilClosingIssues') {
    const c = findCopies(store, `${v.owner}/${v.name}`, v.number);
    if (!c || c.kind !== 'PullRequest')
      return { data: { repository: { pullRequest: null } }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a PullRequest with the number of ${v.number}.` }] };
    const all = closingIssuesOf(store, c);
    const start = v.after ? Number(String(v.after).replace(/^ci-/, '')) : 0;
    const page = all.slice(start, start + w.closingIssuesPageSize);
    const end = start + page.length;
    return {
      data: {
        repository: {
          pullRequest: {
            closingIssuesReferences: {
              pageInfo: { hasNextPage: end < all.length, endCursor: page.length ? `ci-${end}` : null },
              nodes: page.map((x) => ({ number: x.number, repository: { nameWithOwner: x.repo } })),
            },
          },
        },
      },
    };
  }

  // GitHub#258: which boards a (new) issue is on, by its node id, with every field value there
  if (op === 'CavilCreatedItemBoards') {
    if (w.failCreatedBoards > 0) {
      w.failCreatedBoards--;
      return { httpStatus: 502 };
    }
    const c = findByNodeId(store, v.id);
    if (!c) return { data: { node: null }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a node with the global id of '${v.id}'` }] };
    const nodes: any[] = [];
    for (const pages of store.projects.values())
      for (const p of pages)
        for (const n of p.items.nodes)
          if (n.content?.repository?.nameWithOwner?.toLowerCase() === c.repo.toLowerCase() && n.content.number === c.number)
            nodes.push({ id: n.id, isArchived: n.isArchived, project: { id: pages[0].id }, fieldValues: { totalCount: n.fieldValues.nodes.length, nodes: n.fieldValues.nodes } });
    return { data: { node: { projectItems: { totalCount: nodes.length, nodes } } } };
  }
  if (op === 'CavilProjectWorkflows') {
    const proj = projectByNodeId(store, v.id);
    const list = proj ? w.workflows.get(proj.key) : undefined;
    if (!list) return err('Resource not accessible by integration', 'FORBIDDEN');
    return { data: { node: { workflows: { totalCount: list.length, nodes: list } } } };
  }

  // GitHub#250: the newest comments and label events of an item (what proves a write whose answer was lost)
  if (op === 'CavilOpRecords') {
    const c = findCopies(store, `${v.owner}/${v.name}`, v.number);
    if (!c) return { data: { repository: { issueOrPullRequest: null } }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to an issue or pull request with the number of ${v.number}.` }] };
    if (w.failEvents || w.failCommentList) return { httpStatus: 502 };
    const ikey = `${c.repo.toLowerCase()}#${c.number}`;
    const comments = (w.comments.get(ikey) ?? []).slice(-100).map((x) => ({ id: x.id, body: x.body ?? '', author: x.author }));
    const events = (w.labelEvents.get(ikey) ?? []).slice(-100).map((e) => ({ __typename: e.event === 'labeled' ? 'LabeledEvent' : 'UnlabeledEvent', id: `LE_${ikey}_${e.id}`, actor: e.actor, label: e.label }));
    return { data: { repository: { issueOrPullRequest: { __typename: c.kind, comments: { nodes: comments }, timelineItems: { nodes: events } } } } };
  }
  // GitHub#359: state, labels, comments and one page of label events (walked back with `before`)
  if (op === 'CavilOpSnapshot') {
    const c = findCopies(store, `${v.owner}/${v.name}`, v.number);
    if (!c) return { data: { repository: { issueOrPullRequest: null } }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to an issue or pull request with the number of ${v.number}.` }] };
    if (w.failEvents || w.failCommentList) return { httpStatus: 502 };
    // an older page of the label events cannot be read (the newest one can)
    if (w.failEventPages && v.before) return { httpStatus: 502 };
    const ikey = `${c.repo.toLowerCase()}#${c.number}`;
    const content = gqlContent(c);
    const comments = (w.comments.get(ikey) ?? []).slice(-100).map((x) => ({ id: x.id, body: x.body ?? '', author: x.author }));
    const all = (w.labelEvents.get(ikey) ?? []).map((e) => ({ __typename: e.event === 'labeled' ? 'LabeledEvent' : 'UnlabeledEvent', id: `LE_${ikey}_${e.id}`, actor: e.actor, label: e.label }));
    const end = v.before ? Number(String(v.before).replace(/^ev:/, '')) : all.length;
    const from = Math.max(0, end - (w.eventPage || 100));
    // like GitHub: the first 100 labels of the item, and how many it has (PR #365 code review round 1)
    const allLabels = w.staleSnapshotLabels ?? (content.labels?.nodes ?? []).map((l: any) => ({ name: l.name }));
    const labels = allLabels.slice(0, 100);
    return {
      data: {
        repository: {
          issueOrPullRequest: {
            __typename: c.kind,
            state: content.state,
            ...(c.kind === 'PullRequest' ? { merged: content.merged === true } : {}),
            labels: { totalCount: allLabels.length, nodes: labels },
            comments: { nodes: comments },
            timelineItems: { pageInfo: { hasPreviousPage: from > 0, startCursor: from > 0 ? `ev:${from}` : null }, nodes: all.slice(from, end) },
          },
        },
      },
    };
  }
  // GitHub#429: the loop's registration — newest comments and label removals, walked back with `before`
  if (op === 'CavilLoopBlocked' || op === 'CavilLoopBlockedMore') {
    const size = w.loopPage || 100;
    const page = <T,>(all: T[], before: string | null | undefined, prefix: string) => {
      const end = before ? Number(String(before).replace(prefix, '')) : all.length;
      const from = Math.max(0, end - size);
      return { pageInfo: { hasPreviousPage: from > 0, startCursor: from > 0 ? `${prefix}${from}` : null }, nodes: all.slice(from, end) };
    };
    const loopNode = (id: string, comments: boolean, cBefore: string | null, events: boolean, eBefore: string | null): any => {
      const c = findByNodeId(store, id);
      if (!c) return null;
      if (c.kind !== 'Issue') return { __typename: c.kind };
      const ikey = `${c.repo.toLowerCase()}#${c.number}`;
      if (w.failLoop.has(ikey)) throw Object.assign(new Error('502'), { http: 502 });
      if (w.failLoopPages && (cBefore || eBefore)) throw Object.assign(new Error('502'), { http: 502 });
      const all = (w.comments.get(ikey) ?? []).map((x, i) => ({ databaseId: i + 1, body: x.body ?? '', createdAt: x.createdAt, authorAssociation: x.authorAssociation ?? 'NONE' }));
      const evs = (w.labelEvents.get(ikey) ?? []).filter((e) => e.event === 'unlabeled').map((e) => ({ __typename: 'UnlabeledEvent', createdAt: e.created_at, label: e.label }));
      return {
        __typename: 'Issue',
        id,
        ...(comments ? { comments: page(all, cBefore, 'lc:') } : {}),
        ...(events ? { timelineItems: page(evs, eBefore, 'le:') } : {}),
      };
    };
    try {
      if (op === 'CavilLoopBlocked') return { data: { nodes: (v.ids as string[]).map((id) => loopNode(id, true, null, true, null)) } };
      return { data: { node: loopNode(v.id, v.comments, v.commentsBefore, v.events, v.eventsBefore) } };
    } catch (e) {
      if ((e as any).http) return { httpStatus: (e as any).http };
      throw e;
    }
  }
  if (op === 'CavilLoopEnd') {
    const c = findCopies(store, `${v.owner}/${v.name}`, v.number);
    const missing = { data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a Repository with the name '${v.owner}/${v.name}'.` }] };
    if (!c || w.hiddenEnds.has(`${String(v.owner).toLowerCase()}/${String(v.name).toLowerCase()}#${v.number}`)) return missing;
    const g = gqlContent(c);
    const base = { __typename: c.kind, number: c.number, title: g.title, url: g.url, repository: { nameWithOwner: c.repo } };
    const node = c.kind === 'Issue' ? { ...base, state: g.state, stateReason: g.stateReason ?? null } : { ...base, state: g.state === 'MERGED' ? 'MERGED' : g.state, merged: g.state === 'MERGED' || g.merged === true, isDraft: g.isDraft === true };
    return { data: { repository: { issueOrPullRequest: node } } };
  }
  if (op === 'CavilIssueRelations') {
    const c = findByNodeId(store, v.id);
    if (!c || c.kind !== 'Issue') return { data: { node: null }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a node with the global id of '${v.id}'` }] };
    const ikey = `${c.repo.toLowerCase()}#${c.number}`;
    if (w.failRelationPages.has(ikey)) return { httpStatus: 502 };
    const rel = w.relations.get(ikey);
    const node: any = { __typename: 'Issue' };
    for (const name of RELATION_LISTS) if (v[name]) node[name] = relationSlice(store, rel?.[name] ?? [], v[`${name}After`], w.relationPage.more);
    return { data: { node } };
  }
  if (op === 'CavilIssueRelationsBatch') {
    if (w.failRelationsBatch) return { httpStatus: 502 };
    const nodes = (v.ids as string[]).map((id) => {
      const c = findByNodeId(store, id);
      if (!c) return null;
      if (c.kind !== 'Issue') return { __typename: c.kind, id, ...viewerFields(store, c.kind, c.repo, c.number) };
      return { __typename: 'Issue', id, ...viewerFields(store, c.kind, c.repo, c.number), ...relationFields(store, c.repo, c.number) };
    });
    return { data: { nodes } };
  }
  if (op === 'CavilItemRefresh' || op === 'CavilItemDetail') {
    const c = findCopies(store, `${v.owner}/${v.name}`, v.number);
    if (!c) return { data: { repository: { issueOrPullRequest: null } }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to an issue or pull request with the number of ${v.number}.` }] };
    const content = gqlContent(c);
    const ikey = `${c.repo.toLowerCase()}#${c.number}`;
    if (op === 'CavilItemRefresh' && w.failRefresh.has(ikey)) return { httpStatus: 502 };
    if (op === 'CavilItemRefresh') {
      const projectItems: any[] = [];
      for (const pages of store.projects.values())
        for (const p of pages)
          for (const n of p.items.nodes)
            if (n.content?.repository?.nameWithOwner?.toLowerCase() === c.repo.toLowerCase() && n.content.number === c.number)
              projectItems.push({ id: n.id, isArchived: n.isArchived, project: { id: p.id }, fieldValues: n.fieldValues });
      // like GitHub: the first ITEM_LABELS_FIRST labels the query asks for (PR #365 code review round 1)
      const asked = { ...content, ...(content.labels ? { labels: { ...content.labels, nodes: content.labels.nodes.slice(0, 50) } } : {}) };
      return { data: { repository: { issueOrPullRequest: { ...withRelationFields(store, asked), projectItems: { nodes: projectItems } } } } };
    }
    if (w.failDetail.has(ikey)) return { httpStatus: 502 };
    const size = w.detailPageSize;
    const pageOf = <T,>(list: T[], after: string | null) => {
      const start = after ? Number(after.replace(/^c-/, '')) : 0;
      const nodes = list.slice(start, start + size);
      const end = start + nodes.length;
      return { pageInfo: { hasNextPage: end < list.length, endCursor: nodes.length ? `c-${end}` : null }, nodes };
    };
    const isPr = c.kind === 'PullRequest';
    const pr = isPr ? pullOf(store, c) : null;
    const linePage = (r: FakeReview, after: string | null) => {
      const start = after ? Number(after.replace(/^l-/, '')) : 0;
      const nodes = r.comments.nodes.slice(start, start + w.reviewCommentPageSize);
      const end = start + nodes.length;
      return { pageInfo: { hasNextPage: end < r.comments.nodes.length, endCursor: nodes.length ? `l-${end}` : null }, nodes };
    };
    const allowed = w.mergeMethods.get(c.repo.toLowerCase()) ?? { merge: true, squash: true, rebase: true };
    const item: any = {
      __typename: c.kind,
      id: content.id,
      number: c.number,
      title: content.title,
      url: content.url,
      state: content.state,
      createdAt: '2026-01-01T00:00:00Z',
      bodyHTML: w.bodySources.has(ikey) ? renderMarkdown(w.bodySources.get(ikey)!) : (w.bodies.get(ikey) ?? '<p>fixture body</p>'),
      body: w.bodySources.get(ikey) ?? '',
      viewerCanUpdate: !w.cannotUpdate.has(content.id) && !w.readOnlyRepos.has(c.repo.toLowerCase()),
      author: { login: 'user-1' },
      labels: content.labels,
    };
    if (v.withComments) {
      const page = pageOf(w.comments.get(ikey) ?? [], v.commentsAfter ?? null);
      item.comments = { ...page, nodes: page.nodes.map((x) => commentAnswer(store, x, c.repo.toLowerCase())) };
    }
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
      if (v.withReviews) {
        const rp = pageOf(w.reviews.get(ikey) ?? [], v.reviewsAfter ?? null);
        item.reviews = { ...rp, nodes: rp.nodes.map((r) => ({ ...r, comments: linePage(r, null) })) };
      }
    }
    return { data: { repository: { mergeCommitAllowed: allowed.merge, squashMergeAllowed: allowed.squash, rebaseMergeAllowed: allowed.rebase, issueOrPullRequest: item } } };
  }
  return null;
}
