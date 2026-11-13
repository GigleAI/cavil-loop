// GitHub#489: a reply, an edited body / comment, an edited title and a ticked task box are no longer
// sent by the detail panel and waited for there. Each one is a send record kept by the controller
// (and stored with the cache): the panel hands it over and is free at once — closed, switched,
// another item — and the result is said in the window's notice area. This file is the one place that
// decides, from a record alone, what its notice says, which one action it offers, whether it still
// holds its text, whether it keeps another change of the same entry from going out, and what proves
// it when GitHub's answer never came.
//
// The rules (the parent plan, GitHub#482, "没发出去的文字放在哪"):
//   - refused for sure, or never sent → the text goes back into that item's edit box (the panel takes
//     it from the record: `sendTakeable`), the notice may be closed; while no panel has taken it the
//     notice offers 「再发一次」;
//   - no answer → the text stays in the notice only (shown in full), never back in an edit box — it may
//     already be on GitHub; the notice offers 「再查一次」 (a read, nothing is sent). Only positive
//     evidence turns it into a success: a comment not there before the send, by this account, with
//     exactly this text (`commentProves`, the same rule an operation's comment step uses); an edited
//     body / comment / title / ticked box that GitHub now holds exactly as wanted. Not found is still
//     unknown. A person may unlock it after checking GitHub: the text stays in the notice until ×.
//   - an unknown edit / tick keeps any other change of that same entry (or title) from going out: a
//     late answer would overwrite it. A reply locks nothing.

import type { WriteAction } from './actions';
import type { OpRecord } from './ops';

export type SendKind = 'comment' | 'editEntry' | 'editTitle' | 'toggleTask';
export const SEND_KINDS: readonly SendKind[] = ['comment', 'editEntry', 'editTitle', 'toggleTask'];
export function isSendKind(k: string): k is SendKind {
  return (SEND_KINDS as readonly string[]).includes(k);
}
/** what the panel hands over (a reply carrying an operation's kept comment stays with that operation: `draftOf`) */
export type SendAction = Exclude<Extract<WriteAction, { kind: SendKind }>, { draftOf: string }>;

/** sending: on its way (not answered yet); ok / refused: GitHub said so (or it never went out); unknown: sent, no clear answer */
export type SendState = 'sending' | 'ok' | 'refused' | 'unknown';

/**
 * What proves a send whose answer never came. `comment`: the item's comment ids read right before it
 * went out (null = that read failed: never proven automatically). `source`: the body / comment must now
 * hold exactly `want`. `title`: the title must now be exactly `want`.
 */
export type SendProof = { kind: 'comment'; before: string[] | null } | { kind: 'source'; want: string } | { kind: 'title'; want: string };

export interface SendRecord {
  id: string;
  key: string;
  repo: string;
  number: number;
  action: SendAction;
  startedAt: number;
  state: SendState;
  /** the write request went out (false with `refused` = nothing was changed on GitHub) */
  sentAt: number | null;
  answeredAt: number | null;
  /** refused / unknown: why; ok: how it was proven (null = GitHub said yes) */
  reason: string | null;
  /** went through, but something after it did not (a re-read) */
  warning: string | null;
  proof: SendProof | null;
  /** the panel put the text back into its edit box (refused only) */
  returned: boolean;
  /**
   * PR #510 review round 1: the text left that box without being sent from it (the box was emptied, the
   * editor cancelled) or a newer send of it started. Until then a refused record keeps its text on disk
   * — the box itself lives in memory only — and a restart gives it back to the box again.
   */
  dropped?: boolean;
  /**
   * PR #510 review round 2: what that edit box holds now (the person may have changed the text after it went
   * back), kept on disk with the record; a restart gives back this, not the old text. Absent = the text as sent.
   */
  draft?: string;
  /**
   * A reply: the comment that is this send's (GitHub's answer to the request, or the one that proved it).
   * One comment belongs to one send: another send of the same text never takes it as its evidence.
   */
  commentId?: string | null;
  /** a person unlocked it after checking GitHub (unknown only) */
  unlocked: boolean;
  dismissed: boolean;
  /** a check is running in this run of the app (not kept over a restart) */
  checking?: boolean;
  checks?: number;
  /** what the last check could not do */
  checkProblem?: string | null;
}

/**
 * What a send keeps from going out while it is on its way or not sure: an edit / a tick its entry (a late
 * answer would overwrite a newer change), a title its item, a reply another reply with exactly the same
 * text on the same item (PR #510 review round 1: two of them could not be told apart by their evidence).
 */
export function sendSlot(a: SendAction): string {
  if (a.kind === 'comment') return `comment:${a.key}\n${a.body}`;
  if (a.kind === 'editTitle') return `title:${a.key}`;
  return `entry:${a.entryId}`;
}

/** the text a send carries (what is kept for the person); null = none (a ticked box) */
export function sendText(a: SendAction): string | null {
  if (a.kind === 'comment' || a.kind === 'editEntry') return a.body;
  if (a.kind === 'editTitle') return a.title;
  return null;
}

/** it keeps another change of the same entry from going out */
export function sendHolds(r: SendRecord): boolean {
  return r.state === 'sending' || (r.state === 'unknown' && !r.unlocked);
}

/** the record still holds a text that would be lost without it (also one in an edit box: that box is not on disk) */
export function sendKeepsText(r: SendRecord): boolean {
  if (sendText(r.action) === null) return false;
  if (r.state === 'unknown') return true;
  return r.state === 'refused' && !r.dropped;
}

/** the notice shows the text: not sure, or refused and not back in an edit box yet */
export function sendShowsText(r: SendRecord): boolean {
  if (sendText(r.action) === null) return false;
  return r.state === 'unknown' || (r.state === 'refused' && !r.returned && !r.dropped);
}

/** the text a panel takes back into its box: the box's latest text when the person changed it there (PR #510 review round 2) */
export function sendTakeText(r: SendRecord): string | null {
  return r.draft ?? sendText(r.action);
}

/**
 * PR #510 review rounds 2–4: an unknown reply (or an operation's attached comment / reply) a person unlocked after
 * checking GitHub is no longer checked by the app, and its request may still land. From then on no other request of
 * the same text on that item may take a new comment of that text as its own evidence — for good: no time limit (a
 * limit is crossed by a check that merely runs late, review round 4), kept on disk, also after every record and notice
 * is gone; only signing out (the cache of that account) drops it. What it costs: a later request of that text there
 * whose answer is lost is settled by a person, never automatically. `at`: when the mark was set (information only).
 */
export interface SameTextMark {
  key: string;
  body: string;
  at: number;
}
/** a stored mark (older stores wrote `until` instead of `at`: still a mark, no limit any more) */
export function isSameTextMark(x: unknown): x is SameTextMark {
  if (!x || typeof x !== 'object') return false;
  const m = x as Record<string, unknown>;
  return typeof m.key === 'string' && typeof m.body === 'string' && (typeof m.at === 'number' || typeof m.until === 'number');
}

/**
 * PR #510 review rounds 1–3: the one rule for "may a new comment of this text on this item prove the request of
 * `selfId`?", asked by every comment proof — a reply of the reply box, an operation's attached comment, and a reply
 * made from an operation's kept comment. A same-text comment could also be another request's when:
 *   - another reply of that text there is on its way or not sure (and not unlocked);
 *   - an operation of that item is sending / not sure of that text as its attached comment or as a reply (not unlocked);
 *   - a person unlocked such a request earlier and its same-text mark still stands (it may land late).
 * Then nothing is proven automatically; the reason is said. null = clear.
 */
export function sameTextUnclear(key: string, body: string, selfId: string, sends: readonly SendRecord[], ops: readonly OpRecord[], marks: readonly SameTextMark[]): string | null {
  const why = '这一条上还有一条文字相同的评论没有结果，分不清找到的是哪一条，只能人工核对';
  if (sends.some((o) => o.id !== selfId && o.key === key && o.action.kind === 'comment' && o.action.body === body && !o.unlocked && (o.state === 'sending' || o.state === 'unknown'))) return why;
  for (const o of ops) {
    if (o.id === selfId || o.key !== key || o.unlocked) continue;
    if ((o.replyState === 'sending' || o.replyState === 'unknown') && o.reply?.body === body) return why;
    if (o.draft.comment === body && o.steps.some((s) => s.name === 'comment' && (s.state === 'pending' || s.state === 'unknown' || (s.state === 'unsent' && o.running)))) return why;
  }
  if (marks.some((m) => m.key === key && m.body === body)) return why;
  return null;
}

/** refused: the text may go back into the item's edit box (the panel that shows it takes it) */
export function sendTakeable(r: SendRecord): boolean {
  return r.state === 'refused' && !r.returned && !r.dropped && sendText(r.action) !== null;
}

/** the notice may be put away (×): not while it is on its way, nor while it is unknown and not unlocked */
export function sendClosable(r: SendRecord): boolean {
  return r.state !== 'sending' && !(r.state === 'unknown' && !r.unlocked);
}

/**
 * A ticked box and a title show their result in their own place (the box grey until it is read again, the
 * title with 「保存中…」): on their way and when they went through they say nothing in the notice area
 * (AGENTS.md, client rule 3) — only a refusal, a missing answer or a warning does.
 */
export function sendQuiet(a: SendAction): boolean {
  return a.kind === 'toggleTask' || a.kind === 'editTitle';
}

/** the notice area shows it */
export function sendShown(r: SendRecord): boolean {
  if (r.dismissed) return false;
  // (one proven after its answer was lost was said as unknown: it says that it went through after all)
  if (sendQuiet(r.action) && (r.state === 'sending' || (r.state === 'ok' && !r.warning && !r.reason))) return false;
  return true;
}

/** green, put away after 5 s by itself */
export function sendAutoDismiss(r: SendRecord): boolean {
  return r.state === 'ok' && !r.warning && !r.dismissed;
}

/**
 * A record nothing is left to say about: put away, not holding its entry, and no text that would be lost —
 * an unknown one a person unlocked and then put away is cleared with its text (that is what × does there);
 * a refused one whose text no panel took back yet is kept, so it still goes back when the item is opened.
 */
export function sendDisposable(r: SendRecord): boolean {
  return r.dismissed && !sendHolds(r) && !(r.state === 'refused' && sendKeepsText(r));
}

export type SendButton = 'resend' | 'recheck' | 'unlock';
/** the one action of the notice (GitHub#489: 「再发一次」 only when refused, 「再查一次」 only when unknown), and the way out of a lock */
export function sendButtons(r: SendRecord): SendButton[] {
  if (r.state === 'refused') return r.returned || r.dropped ? [] : ['resend'];
  // PR #510 review round 2: unlocked = a person checked GitHub; the app no longer checks it (only × is left)
  if (r.state === 'unknown') return r.checking || r.unlocked ? [] : ['recheck', 'unlock'];
  return [];
}

export type SendTone = 'busy' | 'ok' | 'warn' | 'error';
export function sendTone(r: SendRecord): SendTone {
  if (r.state === 'sending' || r.checking) return 'busy';
  if (r.state === 'ok') return r.warning ? 'warn' : 'ok';
  if (r.state === 'refused') return 'error';
  return 'warn';
}

const WHAT: Record<SendKind, string> = { comment: '评论', editEntry: '修改', editTitle: '标题修改', toggleTask: '勾选' };
function what(a: SendAction): string {
  if (a.kind === 'toggleTask') return a.checked ? '勾选' : '取消勾选';
  if (a.kind === 'editEntry') return '正文 / 评论的修改';
  return WHAT[a.kind];
}

/** where the text goes back to */
function boxName(a: SendAction): string {
  return a.kind === 'comment' ? '回复框' : a.kind === 'editTitle' ? '标题输入框' : '编辑框';
}

/** what the notice says */
export function sendNoticeText(r: SendRecord): string {
  const w = what(r.action);
  if (r.state === 'sending') return r.action.kind === 'comment' ? '正在发评论…' : `正在保存${w}…`;
  if (r.state === 'ok') {
    const head = r.action.kind === 'comment' ? '评论已发出' : r.action.kind === 'toggleTask' ? `已${w}，GitHub 上已更新` : `${w}已保存`;
    const how = r.reason ? `（${r.reason}）` : '';
    return r.warning ? `${head}${how}。注意：${r.warning}` : `${head}${how}`;
  }
  if (r.state === 'refused') {
    const head = `${w}没有${r.action.kind === 'comment' ? '发出去' : '保存上'}：${r.reason ?? '没有发出'}`;
    if (sendText(r.action) === null) return head;
    if (r.dropped) return head;
    return r.returned ? `${head}。原文已放回${boxName(r.action)}` : `${head}。原文留在这里，打开这一条时会放回${boxName(r.action)}`;
  }
  let head = `${w}不确定有没有${r.action.kind === 'comment' ? '发出' : '保存上'}（${r.reason ?? '没有收到 GitHub 的应答'}）`;
  if (sendText(r.action) !== null) head += '。原文只留在这里，没有放回编辑框（它可能已经在 GitHub 上了，再发可能重复）';
  if (r.checking) head += '；正在查证…';
  else if (r.checkProblem) head += `；这次没能查证：${r.checkProblem}`;
  else if ((r.checks ?? 0) > 0) head += `；已核对 ${r.checks} 次，到现在还没查到（原来那次请求仍可能稍后生效）`;
  if (r.unlocked) head = `已由人核对后解除锁定：${head}`;
  return head;
}

/**
 * The rule an unknown comment is proven by (GitHub#250 code review round 1, shared with an operation's
 * comment step): a comment of `login` with exactly `body` whose id was not there before the request.
 */
export function commentProves(comments: readonly { id: string; author: string | null; body: string }[], before: readonly string[], login: string, body: string): boolean {
  return comments.some((c) => !before.includes(c.id) && c.author === login && c.body === body);
}

/**
 * GitHub's state read after the request for an unknown send. `comments`: the item's newest comments (for a
 * reply); `source`: the body / comment as GitHub holds it now (edit / tick); `title`: the title now.
 */
export interface SendEvidence {
  login: string | null;
  comments?: { id: string; author: string | null; body: string }[];
  source?: string;
  title?: string;
}

/** An unknown send against what was read: proven → ok; otherwise unchanged with what is missing. */
export function sendProve(
  r: SendRecord,
  ev: SendEvidence,
  others: readonly SendRecord[] = [],
  marks: readonly SameTextMark[] = [],
  ops: readonly OpRecord[] = [],
): { record: SendRecord; missing: string | null } {
  if (r.state !== 'unknown') return { record: r, missing: null };
  // PR #510 review round 2: unlocked by a person = settled by hand; never proven (or given a comment) by the app
  if (r.unlocked) return { record: r, missing: '已由人核对后解除锁定，不再自动核对' };
  const p = r.proof;
  const ok = (how: string) => ({ record: { ...r, state: 'ok' as const, reason: how, checkProblem: null }, missing: null });
  if (!p) return { record: r, missing: '没有记下能证明它的东西，只能人工核对' };
  if (p.kind === 'comment') {
    if (r.action.kind !== 'comment') return { record: r, missing: '记录不完整' };
    if (!p.before) return { record: r, missing: '发送前没读到这一条原有的评论，无法区分新旧，只能人工核对' };
    if (!ev.login) return { record: r, missing: '不知道当前账号是谁，查不了评论' };
    if (!ev.comments) return { record: r, missing: '没读到评论' };
    // PR #510 review round 1: another send of the same text on this item still without a result — a comment
    // found could be either one's; and a comment that already is another send's proves nothing here
    const body = r.action.body;
    const same = others.filter((o) => o.id !== r.id && o.key === r.key && o.action.kind === 'comment' && o.action.body === body);
    const unclear = sameTextUnclear(r.key, body, r.id, others, ops, marks);
    if (unclear) return { record: r, missing: unclear };
    const taken = new Set(same.map((o) => o.commentId).filter((x): x is string => !!x));
    const free = ev.comments.filter((c) => !taken.has(c.id));
    if (!commentProves(free, p.before, ev.login, body)) return { record: r, missing: null };
    const found = free.find((c) => !p.before!.includes(c.id) && c.author === ev.login && c.body === body)!;
    return { record: { ...ok('在评论列表里找到了这条评论').record, commentId: found.id }, missing: null };
  }
  if (p.kind === 'source') {
    if (ev.source === undefined) return { record: r, missing: '没读到这一条现在的原文' };
    return ev.source === p.want ? ok('重读时 GitHub 上已是改后的内容') : { record: r, missing: null };
  }
  if (ev.title === undefined) return { record: r, missing: '没读到现在的标题' };
  return ev.title === p.want ? ok('重读时 GitHub 上已是改后的标题') : { record: r, missing: null };
}

/** A record kept by an earlier run: one on its way then has no answer now — or, never sent, was not sent. */
export function sendAfterRestart(r0: SendRecord): SendRecord {
  const r: SendRecord = { ...r0, checking: false };
  // the edit box it went back to is gone with the last run: it goes back again
  if (r.state === 'refused' && r.returned && !r.dropped) return { ...r, returned: false };
  if (r.state !== 'sending') return r;
  if (r.sentAt === null) return { ...r, state: 'refused', reason: '客户端在发出前关掉了，没有发出', answeredAt: null };
  return { ...r, state: 'unknown', reason: '客户端重启前没有收到 GitHub 的应答' };
}

const STATES: readonly SendState[] = ['sending', 'ok', 'refused', 'unknown'];
function isAction(a: unknown): a is SendAction {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  if (typeof x.kind !== 'string' || !isSendKind(x.kind) || typeof x.key !== 'string') return false;
  if (x.kind === 'comment') return typeof x.body === 'string' && x.draftOf === undefined;
  if (x.kind === 'editEntry') return typeof x.entryId === 'string' && typeof x.body === 'string' && typeof x.seenSource === 'string';
  if (x.kind === 'editTitle') return typeof x.title === 'string' && typeof x.seenTitle === 'string';
  return typeof x.entryId === 'string' && typeof x.index === 'number' && typeof x.checked === 'boolean' && typeof x.seenSource === 'string';
}
function isProof(p: unknown): p is SendProof | null {
  if (p === null) return true;
  if (!p || typeof p !== 'object') return false;
  const x = p as Record<string, unknown>;
  if (x.kind === 'comment') return x.before === null || (Array.isArray(x.before) && x.before.every((s) => typeof s === 'string'));
  return (x.kind === 'source' || x.kind === 'title') && typeof x.want === 'string';
}
const numOrNull = (v: unknown) => v === null || typeof v === 'number';
/** a stored record of the right shape (anything else on disk is dropped) */
export function isSendRecord(x: unknown): x is SendRecord {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.key === 'string' &&
    typeof r.repo === 'string' &&
    typeof r.number === 'number' &&
    isAction(r.action) &&
    typeof r.startedAt === 'number' &&
    STATES.includes(r.state as SendState) &&
    numOrNull(r.sentAt) &&
    numOrNull(r.answeredAt) &&
    (r.reason === null || typeof r.reason === 'string') &&
    (r.warning === null || typeof r.warning === 'string') &&
    isProof(r.proof) &&
    typeof r.returned === 'boolean' &&
    (r.dropped === undefined || typeof r.dropped === 'boolean') &&
    (r.draft === undefined || typeof r.draft === 'string') &&
    (r.commentId === undefined || r.commentId === null || typeof r.commentId === 'string') &&
    typeof r.unlocked === 'boolean' &&
    typeof r.dismissed === 'boolean'
  );
}
