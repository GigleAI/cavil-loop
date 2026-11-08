// GitHub#261: before a sync round reads a source in full, ask GitHub whether anything
// changed since the last read — with conditional requests, which GitHub answers with
// 304 ("nothing changed", not counted against the quota) when the version tag still
// matches. Only an unbroken chain of explicit 304s (plus an unchanged item count on a
// board) lets the round keep the previous snapshot; anything else — a 200, an error,
// a missing tag, a different number of pages, an unreadable count — means "read it
// in full", exactly as before. The full read itself is untouched.
//
// What the check sees (and what it cannot):
//   board   every page of the REST item list (HEAD, every field of the board asked
//           for) + the REST field list (GET, for the field ids, options and
//           iterations) + the board's item count from one GraphQL query per round
//           (a 304 carries no "next page" link, so an item appended after a full
//           last page would otherwise go unseen)
//   repo    "the most recently updated issue / PR" (HEAD, one item)
// Neither shows saved views, the board title, the account's write permission, or
// (repo) an issue deleted / transferred / sliding out of the 14-day window: every
// source is read in full at least every FULL_READ_EVERY_MS regardless.

import type { SourceConfig } from '../shared/types';
import { GitHubClient, GitHubError } from './github';
import { projectCountsQuery } from './queries';

/** A source is read in full at least this often, whatever the check says. */
export const FULL_READ_EVERY_MS = 10 * 60_000;

/** Pages of a board's REST item list the check follows before giving up (same bound as the full read). */
const MAX_CHECK_PAGES = 200;

export interface PageTag {
  url: string;
  etag: string;
}

/** What one source's check recorded: the version tags taken just before a read whose result is `snapshotAt`. */
export interface SourceCheck {
  /** fetchedAt of the snapshot these tags vouch for (the tags were taken before that read began) */
  snapshotAt: number;
  /** when the source was last read in full */
  fullAt: number;
  /** board: every page of the item list, in order; repo: the one probe */
  pages: PageTag[];
  /** board: the field list */
  fields: PageTag | null;
  /** board: the item count when the tags were taken (null = unknown, never "unchanged") */
  count: number | null;
}

/** The check's verdict for one source. */
export interface CheckResult {
  /** every request answered 304 against `old` (and the board count is the same) */
  unchanged: boolean;
  /** the tags as of now, to keep if the round's result lands */
  record: Omit<SourceCheck, 'snapshotAt' | 'fullAt'>;
}

type Board = Extract<SourceConfig, { kind: 'project' }>;
type Repo = Extract<SourceConfig, { kind: 'repo' }>;

function boardBase(src: Board): string {
  return `/${src.ownerType === 'org' ? 'orgs' : 'users'}/${encodeURIComponent(src.owner)}/projectsV2/${src.number}`;
}

async function checkBoard(client: GitHubClient, src: Board, old: SourceCheck | null, count: number | null): Promise<CheckResult> {
  // the field list: its ids go into the item list's URL (REST lists only the fields asked for)
  const fieldsUrl = `${boardBase(src)}/fields?per_page=100`;
  const oldFields = old?.fields && old.fields.url === fieldsUrl ? old.fields : null;
  const fa = await client.conditional('GET', fieldsUrl, oldFields?.etag ?? null);
  let fieldIds: string;
  let fields: PageTag;
  let changed = false;
  if (fa.status === 304) {
    if (!oldFields) throw new GitHubError('http', '变化检查：字段列表回了 304，但没有上一次的记录');
    const m = /[?&]fields=([^&]*)/.exec(old!.pages[0]?.url ?? '');
    if (!m) throw new GitHubError('http', '变化检查：上一次的记录缺字段');
    fieldIds = decodeURIComponent(m[1]);
    fields = oldFields;
  } else {
    if (!Array.isArray(fa.body)) throw new GitHubError('http', '变化检查：字段列表不是数组');
    // GitHub allows 50 fields; a second page would mean the ids below are incomplete
    if (fa.next) throw new GitHubError('http', '变化检查：字段列表超过一页');
    const ids = (fa.body as { id?: unknown }[]).map((f) => f.id).filter((id): id is number | string => typeof id === 'number' || typeof id === 'string');
    if (ids.length === 0) throw new GitHubError('http', '变化检查：字段列表为空');
    fieldIds = ids.join(',');
    fields = { url: fieldsUrl, etag: fa.etag };
    changed = true;
  }

  const pages: PageTag[] = [];
  let url: string | null = `${boardBase(src)}/items?per_page=100&fields=${encodeURIComponent(fieldIds)}`;
  for (let i = 0; url; i++) {
    if (i >= MAX_CHECK_PAGES) throw new GitHubError('http', `变化检查：看板超过 ${MAX_CHECK_PAGES} 页`);
    const was: PageTag | undefined = old?.pages[i];
    const prior: PageTag | null = was && was.url === url ? was : null;
    const a = await client.conditional('HEAD', url, prior?.etag ?? null);
    if (a.status === 304) {
      if (!prior) throw new GitHubError('http', '变化检查：条目列表回了 304，但没有上一次的记录');
      pages.push(prior);
      // a 304 has no "next" link: the same page leads to the same next page as last time
      url = old!.pages[i + 1]?.url ?? null;
    } else {
      pages.push({ url, etag: a.etag });
      changed = true;
      url = a.next;
    }
  }
  const unchanged = Boolean(old) && !changed && pages.length === old!.pages.length && count !== null && count === old!.count;
  return { unchanged, record: { pages, fields, count } };
}

async function checkRepo(client: GitHubClient, src: Repo, old: SourceCheck | null): Promise<CheckResult> {
  const url = `/repos/${encodeURIComponent(src.owner)}/${encodeURIComponent(src.name)}/issues?state=all&sort=updated&direction=desc&per_page=1`;
  const prior = old?.pages.length === 1 && old.pages[0].url === url ? old.pages[0] : null;
  const a = await client.conditional('HEAD', url, prior?.etag ?? null);
  if (a.status === 304) {
    if (!prior) throw new GitHubError('http', '变化检查：仓库回了 304，但没有上一次的记录');
    return { unchanged: true, record: { pages: [prior], fields: null, count: null } };
  }
  return { unchanged: false, record: { pages: [{ url, etag: a.etag }], fields: null, count: null } };
}

/** Check one source against what was recorded (`old`, null = nothing usable: tags are taken, never "unchanged"). */
export function checkSource(client: GitHubClient, src: SourceConfig, old: SourceCheck | null, counts: Map<string, number>): Promise<CheckResult> {
  return src.kind === 'project' ? checkBoard(client, src, old, counts.get(src.key) ?? null) : checkRepo(client, src, old);
}

/**
 * Every board's item count, in one GraphQL query. Any failure (a board gone, no access,
 * GitHub unreachable) = no counts at all: those boards are then read in full this round.
 */
export async function boardCounts(client: GitHubClient, sources: SourceConfig[]): Promise<Map<string, number>> {
  const boards = sources.filter((s): s is Board => s.kind === 'project');
  const out = new Map<string, number>();
  if (!boards.length) return out;
  const { query, variables } = projectCountsQuery(boards.map((b) => ({ owner: b.owner, number: b.number, isOrg: b.ownerType === 'org' })));
  try {
    const data = await client.graphql<Record<string, { projectV2: { items: { totalCount: number } } | null } | null>>(query, variables);
    boards.forEach((b, i) => {
      const n = data[`p${i}`]?.projectV2?.items?.totalCount;
      if (typeof n === 'number' && Number.isInteger(n) && n >= 0) out.set(b.key, n);
    });
  } catch {
    out.clear();
  }
  return out;
}
