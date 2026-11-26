// GitHub#713 — "和我有关的新动态": GitHub's own notification inbox, read alongside the sources.
//
// Someone @-mentions the account, replies in a discussion it took part in, asks it for a review or
// assigns it an item — GitHub files that in the account's notification inbox; the pending label
// (pending.ts) never sees it. This module decides, from that inbox, which threads remind and what
// the reminder says. It is apart from pending.ts because its input is the inbox, not a source's
// snapshot (the snapshots only decide which threads are "in the data sources").
//
// The rules (the design confirmed on GitHub#713):
//   - only `participating` threads, and of those only issues / pull requests whose reason is one of
//     REASONS (a watched repository's traffic, CI, security alerts… never remind);
//   - only threads whose item is in a data source (a repository source, or on a Project source's
//     list as last read), the maintainer's choice on GitHub#713;
//   - "new" = unread, and updated after the time remembered for that thread (a thread never seen:
//     after the first complete read). The first complete read of an account is the baseline:
//     history, nothing reminds. Every thread of the inbox is remembered, in a source or not, so a
//     source added later brings no history with it: its old unread threads were remembered already
//     and remind only when they change again (a "first read of a new source is a baseline" rule on
//     top would drop an @ that came right after the source was added — seen in the e2e test);
//   - a read that failed (any page) changes nothing: no reminder, nothing remembered;
//   - the words: a specific "X @了我" / "X 回复了" only when the latest comment is proven to be
//     new this time — its address differs from the one remembered AND it was written after the
//     time remembered for the thread. Anything else says "有新动态" plus how the thread relates
//     to the account (GitHub's reason is the thread's relation, not what happened this time).

import type { Endpoints } from './github';
import { itemKey } from '../shared/sources';
import { t } from '../shared/i18n';

/** The reasons that remind (GitHub's own words). Everything else (subscribed, state_change, ci_activity, …) does not. */
export const REASONS = ['mention', 'team_mention', 'comment', 'author', 'review_requested', 'assign'] as const;
export type Reason = (typeof REASONS)[number];

/** At most this many latest comments are read per round to word the reminders; the rest say "有新动态". */
export const COMMENT_READS_PER_ROUND = 5;

/** One thread of the inbox as GitHub sends it (only the fields read here). */
export interface RawThread {
  id: string;
  unread: boolean;
  reason: string;
  updated_at: string;
  subject: { title: string; url: string | null; latest_comment_url: string | null; type: string };
  repository: { full_name: string };
}

/** One thread as kept here. */
export interface Thread {
  id: string;
  /** `owner/repo#N`, lower-cased like every item key */
  key: string;
  /** `owner/repo` as GitHub spells it */
  repo: string;
  number: number;
  kind: 'issue' | 'pr';
  title: string;
  reason: Reason;
  unread: boolean;
  /** ms */
  updatedAt: number;
  /** the latest comment's API address; null = none (or it is the item itself) */
  commentUrl: string | null;
  /** the item's API address */
  apiUrl: string;
}

/** The latest comment, as read for the words of a reminder. */
export interface CommentFacts {
  author: string;
  /** ms */
  createdAt: number;
  body: string;
  htmlUrl: string | null;
}

/** A thread that reminds this round; `readComment` = its latest comment may prove what happened. */
export interface Candidate {
  thread: Thread;
  readComment: boolean;
  /** the time the comment must be newer than (the remembered update, or the baseline) */
  since: number;
}

/** In which sources an item is: the source keys (empty = in none). */
export type SourcesOf = (key: string) => string[];

/** Parse GitHub's inbox. A thread of another kind, an unknown reason or an unreadable shape is left out. */
export function parseThreads(raw: unknown): Thread[] {
  if (!Array.isArray(raw)) return [];
  const out: Thread[] = [];
  for (const r of raw as RawThread[]) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' && typeof r.id !== 'number') continue;
    const s = r.subject;
    if (!s || (s.type !== 'Issue' && s.type !== 'PullRequest') || typeof s.url !== 'string') continue;
    if (!(REASONS as readonly string[]).includes(r.reason)) continue;
    const m = s.url.match(/\/repos\/([^/]+)\/([^/]+)\/(?:issues|pulls)\/(\d+)$/);
    const at = Date.parse(r.updated_at);
    if (!m || !Number.isFinite(at)) continue;
    const repo = r.repository?.full_name ?? `${m[1]}/${m[2]}`;
    const number = Number(m[3]);
    const comment = typeof s.latest_comment_url === 'string' && s.latest_comment_url !== s.url ? s.latest_comment_url : null;
    out.push({
      id: String(r.id),
      key: itemKey(repo, number),
      repo,
      number,
      kind: s.type === 'PullRequest' ? 'pr' : 'issue',
      title: typeof s.title === 'string' ? s.title : '',
      reason: r.reason as Reason,
      unread: r.unread === true,
      updatedAt: at,
      commentUrl: comment,
      apiUrl: s.url,
    });
  }
  return out;
}

interface Remembered {
  updatedAt: number;
  commentUrl: string | null;
}

export class ActivityTracker {
  /** thread id → what was seen last */
  private seen = new Map<string, Remembered>();
  /** GitHub's time of the first complete read; null = none yet (the next one is the baseline) */
  private baselineAt: number | null = null;
  /** the inbox as last read whole (for "is this thread still unread", and a 304 meaning "same as before") */
  private last: Thread[] = [];

  /** Forget everything: sign-out, another account, the setting switched off. */
  reset(): void {
    this.seen.clear();
    this.baselineAt = null;
    this.last = [];
  }

  /** The inbox as last read whole (empty before the first read). */
  threads(): Thread[] {
    return this.last;
  }

  /** Has a complete read happened (since the last reset)? */
  started(): boolean {
    return this.baselineAt !== null;
  }

  /**
   * One complete read. `threads` = the inbox read now, or null = GitHub said it is unchanged (a 304:
   * the inbox last read stands). `sourcesOf` = which data sources hold an item (none = it does not
   * remind); `readAt` = GitHub's clock at the read. Returns the threads that remind, in GitHub's order.
   */
  observe(threads: Thread[] | null, sourcesOf: SourcesOf, readAt: number): Candidate[] {
    const list = threads ?? this.last;
    const first = this.baselineAt === null;
    const out: Candidate[] = [];
    for (const th of list) {
      const was = this.seen.get(th.id);
      const since = was ? was.updatedAt : (this.baselineAt ?? readAt);
      if (!first && th.unread && th.updatedAt > since && sourcesOf(th.key).length > 0) {
        out.push({ thread: th, readComment: th.commentUrl !== null && th.commentUrl !== (was?.commentUrl ?? null), since });
      }
      if (!was || th.updatedAt > was.updatedAt || was.commentUrl !== th.commentUrl) this.seen.set(th.id, { updatedAt: Math.max(th.updatedAt, was?.updatedAt ?? 0), commentUrl: th.commentUrl });
    }
    if (first) this.baselineAt = readAt;
    this.last = list;
    return out;
  }

  /** The unread threads of one item, as last read (what "mark as read" would clear). */
  unreadOf(key: string): Thread[] {
    return this.last.filter((th) => th.key === key && th.unread);
  }

  /** A thread marked read on GitHub: not unread here any more (until GitHub lists it unread again). */
  markedRead(id: string): void {
    this.last = this.last.map((th) => (th.id === id ? { ...th, unread: false } : th));
  }
}

/** `@login` written in a text (GitHub's rules: not part of an e-mail address or a longer name). */
export function mentions(body: string, login: string): boolean {
  const esc = login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_\`/-])@${esc}(?![A-Za-z0-9_-])`, 'i').test(body);
}

/** The relation a thread's reason states (not what happened this time). */
function relation(th: Thread): string {
  switch (th.reason) {
    case 'review_requested':
      return t('请我 review 的 PR');
    case 'assign':
      return t('指派给我的');
    case 'author':
      return t('我开的');
    case 'mention':
    case 'team_mention':
      return t('提到过我的');
    default:
      return t('我参与过的');
  }
}

const firstLine = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('>')) ?? '';

/**
 * The words of one reminder. `comment` = the latest comment as read (null: not read, unreadable, or
 * none); it is used only when proven new: written by someone else after `since`.
 */
export function activityText(c: Candidate, comment: CommentFacts | null, viewer: string | null): { title: string; body: string } {
  const th = c.thread;
  const ref = `${th.repo}#${th.number}`;
  const proven = comment !== null && c.readComment && comment.createdAt > c.since && viewer !== null && comment.author.toLowerCase() !== viewer.toLowerCase();
  if (proven) {
    const line = firstLine(comment.body);
    const body = line ? t('{title} —「{line}」', { title: th.title, line: line.length > 120 ? `${line.slice(0, 119)}…` : line }) : th.title;
    return mentions(comment.body, viewer)
      ? { title: t('{who} 在 {ref} 里 @了我', { who: comment.author, ref }), body }
      : { title: t('{who} 回复了 {ref}', { who: comment.author, ref }), body };
  }
  return { title: t('{ref} 有新动态', { ref }), body: t('{title} · {relation}', { title: th.title, relation: relation(th) }) };
}

/** The web address of a thread's item (where a click goes when the item is not on the board). */
export function threadWebUrl(th: Thread, endpoints: Endpoints, comment: CommentFacts | null): string {
  if (comment?.htmlUrl) return comment.htmlUrl;
  return `${endpoints.web}/${th.repo}/${th.kind === 'pr' ? 'pull' : 'issues'}/${th.number}`;
}

/** A comment as GitHub sends it → the facts read; null = not the shape expected. */
export function parseComment(raw: unknown): CommentFacts | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { user?: { login?: unknown }; created_at?: unknown; body?: unknown; html_url?: unknown };
  const at = typeof r.created_at === 'string' ? Date.parse(r.created_at) : NaN;
  if (typeof r.user?.login !== 'string' || !Number.isFinite(at)) return null;
  return { author: r.user.login, createdAt: at, body: typeof r.body === 'string' ? r.body : '', htmlUrl: typeof r.html_url === 'string' ? r.html_url : null };
}
