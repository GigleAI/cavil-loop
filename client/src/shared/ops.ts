// GitHub#250: closing an issue / PR, merging, "autopilot" and "hand to the agent"
// no longer hold a dialog. Each one is an operation record kept by the controller
// (and stored with the cache); this file is the one place that decides, from a
// record alone, whether it still locks its item, what its notice says, which
// buttons it offers and which part of its draft is still kept. The send gate,
// the panel's buttons, the panel's / board's notice all read these functions.
//
// One rule locks (plan revision 5, table A):
//   - a step still waiting for GitHub, or a step whose answer never came
//     ("unknown"), locks the item: nothing that conflicts is sent from anywhere;
//   - once every step has a definite result, a record with a succeeded step still
//     locks until a re-read issued after the last answer landed (close / merge:
//     one that shows the item closed / merged);
//   - a person may unlock by hand after checking GitHub.
// Unknown never turns into "did not happen": only positive evidence turns it
// into a success. Nothing is ever re-sent by itself, and an unknown step has no
// one-click re-send.
//
// The draft (close reason, attached comment, merge method) follows its own rule
// (table E): a part goes only when its own step is confirmed done, or when a
// person drops it. Settling never deletes a draft.

import type { IssueCloseReason, MergeMethod } from './actions';
import { noticeTone, type NoticeFacts, type NoticeTone } from './noticeTone';

export type OpKind = 'closeIssue' | 'closePr' | 'merge' | 'autopilot' | 'handBack';
export const OP_KINDS: readonly OpKind[] = ['closeIssue', 'closePr', 'merge', 'autopilot', 'handBack'];
export function isOpKind(k: string): k is OpKind {
  return (OP_KINDS as readonly string[]).includes(k);
}

export type OpStepName = 'close' | 'comment' | 'merge' | 'addLabel' | 'removeLabel';
/** unsent: never went out; pending: sent, no answer yet; ok / refused: GitHub said so; unknown: sent, no clear answer */
export type OpStepState = 'unsent' | 'pending' | 'ok' | 'refused' | 'unknown';

export interface OpStep {
  name: OpStepName;
  /** addLabel / removeLabel: the label (names from Settings at the moment the operation started) */
  label?: string;
  state: OpStepState;
  /** GitHub's reason (refused / unknown), or how a success was proven */
  reason: string | null;
  /** stamps (controller clock) */
  sentAt: number | null;
  answeredAt: number | null;
}

export interface OpDraft {
  reason?: IssueCloseReason;
  comment?: string;
  method?: MergeMethod;
  headOid?: string;
}

export interface OpRecord {
  id: string;
  key: string;
  repo: string;
  number: number;
  kind: OpKind;
  startedAt: number;
  steps: OpStep[];
  draft: OpDraft;
  /** the newest landed re-read issued after every answer (its issue stamp); null = none yet */
  readAt: number | null;
  /** close / merge: such a re-read showed the item closed / merged */
  targetSeen: boolean;
  /** a person unlocked it by hand after checking GitHub */
  unlocked: boolean;
  /** the draft was dropped by a person, or handed to a newer operation */
  draftDropped: boolean;
  /** the notice was put away (a kept draft still shows as one line in the panel) */
  dismissed: boolean;
  /** a succeeded record waited STUCK_MS without a re-read showing the result: offer the manual unlock */
  stuck: boolean;
  /** the last evidence read that could not be done */
  checkProblem: string | null;
  /**
   * its requests / re-reads / evidence reads are still running in this run of the app: it
   * locks like a waiting step (from the moment it is created, before its first request is
   * marked sent — a second click in between must not get through). Not kept over a restart.
   */
  running?: boolean;
  /**
   * Code review round 1: the item's comments and label events (GitHub node ids) read right before
   * the first request went out. Evidence for a step whose answer never came must be a record not
   * in here — an older comment with the same text, or an older "labeled" event of the same label,
   * proves nothing about this request. null = that read failed: such a step can never be proven
   * automatically (a person checks and unlocks). Absent = the operation has no step needing it.
   */
  before?: { comments: string[]; events: string[] } | null;
  /**
   * Code review round 1: a reply built from this record's kept comment ("放进回复框") is on its
   * way ('sending') or its answer never came ('unknown'). Either way the comment may already be on
   * GitHub: it is not offered for the reply box again (copy only). Done = the draft is dropped;
   * refused for sure = cleared, offered again.
   */
  replyState?: 'sending' | 'unknown' | null;
  /**
   * Code review round 2: the reply above — its exact text, and the item's comments read right before it
   * went out (only a comment not in this list proves it; null = that read failed: never proven).
   */
  reply?: { body: string; before: string[] | null } | null;
  /** a reply made from the kept comment went out (or was proven): the comment is done, the rest of the draft stays */
  commentUsed?: boolean;
  /** the re-read after the answers (the item, a merged / closed PR's issues) did not work in full; the next sync round catches up */
  readProblem?: string | null;
  /** this record finishes the label steps of an earlier one ("补做剩下的步骤") */
  finishOf?: string;
  /**
   * GitHub#357: an evidence read (the automatic one after a lost answer, or "重新查证据") is running
   * in this run of the app. Only the notice reads it (blue, "正在查证…"): the lock, the phase and the
   * draft are as before. Not kept over a restart.
   */
  checking?: boolean;
  /** GitHub#357: "补做剩下的步骤" is being prepared (the item is read first) in this run of the app. Not kept over a restart. */
  finishing?: boolean;
  /** GitHub#357: why the last "补做剩下的步骤" did nothing; cleared when the next one starts, and once nothing is left to finish */
  finishProblem?: string | null;
}

/** how long a succeeded operation waits for a re-read before the manual unlock is offered */
export const STUCK_MS = 120_000;

export const CLOSE_REASON_NAME: Record<IssueCloseReason, string> = { completed: '已完成', not_planned: '不计划' };

export type OpPhase = 'waiting' | 'unknown' | 'settling' | 'settled' | 'unlocked';

/** The phase of a record (table A). */
export function opPhase(r: OpRecord): OpPhase {
  if (r.unlocked) return 'unlocked';
  if (r.running || r.replyState === 'sending' || r.steps.some((s) => s.state === 'pending')) return 'waiting';
  // code review round 2: a reply made from the kept comment whose answer never came is an unknown step of this record
  if (r.replyState === 'unknown' || r.steps.some((s) => s.state === 'unknown')) return 'unknown';
  if (!r.steps.some((s) => s.state === 'ok')) return 'settled';
  if (r.readAt === null) return 'settling';
  if (needsTarget(r) && !r.targetSeen) return 'settling';
  return 'settled';
}

/** close / merge succeeded: the item must be read back closed / merged */
function needsTarget(r: OpRecord): boolean {
  return r.steps.some((s) => (s.name === 'close' || s.name === 'merge') && s.state === 'ok');
}

export function opLocked(r: OpRecord): boolean {
  const p = opPhase(r);
  return p === 'waiting' || p === 'unknown' || p === 'settling';
}

/** The record that locks this item, if any (at most one: the send gate refuses a second). */
export function opLockOf(records: readonly OpRecord[], key: string): OpRecord | null {
  return records.find((r) => r.key === key && opLocked(r)) ?? null;
}

/** the last answer of the record (stamp), null before the first */
export function lastAnswer(r: OpRecord): number | null {
  const t = r.steps.map((s) => s.answeredAt).filter((x): x is number => x !== null);
  return t.length ? Math.max(...t) : null;
}

/**
 * The boundary a re-read must be issued after to count (code review round 1): the last answer;
 * for a step whose answer never came at all (a request still waiting when the app stopped) its
 * sending time — never a made-up answer. null = nothing was ever sent.
 */
export function readBoundary(r: OpRecord): number | null {
  const t = r.steps.flatMap((s) => [s.answeredAt, s.state === 'unknown' ? s.sentAt : null]).filter((x): x is number => x !== null);
  return t.length ? Math.max(...t) : null;
}

const main = (r: OpRecord) => r.steps[0];

function what(r: OpRecord): string {
  return `${r.kind === 'closeIssue' ? 'issue' : r.kind === 'closePr' || r.kind === 'merge' ? 'PR' : '这一条'} #${r.number}`;
}

/** how one label step reads */
function labelText(s: OpStep): string {
  const L = `「${s.label ?? ''}」`;
  const add = s.name === 'addLabel';
  switch (s.state) {
    case 'ok':
      return add ? `已加上${L}` : `已摘掉${L}`;
    case 'refused':
      return `${add ? '加' : '摘'}${L}没有成功：${s.reason ?? ''}`;
    case 'unknown':
      return `${L}不确定有没有${add ? '加上' : '摘掉'}`;
    case 'pending':
      return `正在${add ? '加' : '摘'}${L}…`;
    case 'unsent':
      return `还没${add ? '加' : '摘'}${L}`;
  }
}

/** The notice of a record: every step that did not simply succeed is named, nothing is left out. */
export function opText(r: OpRecord): string {
  // created, its first request not marked sent yet: it reads as on its way
  const m = r.running && r.steps[0].state === 'unsent' ? { ...r.steps[0], state: 'pending' as const } : main(r);
  const w = what(r);
  const rest = r.steps.slice(1);
  let head: string;
  if (r.kind === 'closeIssue' || r.kind === 'closePr') {
    const reason = r.kind === 'closeIssue' && r.draft.reason ? `（${CLOSE_REASON_NAME[r.draft.reason]}）` : '';
    head =
      m.state === 'pending'
        ? `正在关闭 ${w}…`
        : m.state === 'refused'
          ? `没有关闭 ${w}：${m.reason ?? ''}`
          : m.state === 'unknown'
            ? `不确定 ${w} 有没有关上（${m.reason ?? '没有收到 GitHub 的应答'}）`
            : m.state === 'unsent'
              ? `没有关闭 ${w}：${m.reason ?? '没有发出'}`
              : `${w} 已关闭${reason}`;
    const c = rest[0];
    if (c && m.state === 'ok') {
      head +=
        c.state === 'ok'
          ? '，评论已发出'
          : c.state === 'refused'
            ? `，但附的评论没有发出去：${c.reason ?? ''}`
            : c.state === 'unknown'
              ? '，附的评论不确定有没有发出'
              : c.state === 'pending'
                ? '，正在发评论…'
                : '，附的评论没有发出（关闭的应答丢了，没敢接着发）';
    }
  } else if (r.kind === 'merge') {
    head =
      m.state === 'pending'
        ? `正在合并 ${w}…`
        : m.state === 'refused'
          ? `没有合并 ${w}：${m.reason ?? ''}`
          : m.state === 'unknown'
            ? `不确定 ${w} 有没有合并（${m.reason ?? '没有收到 GitHub 的应答'}）`
            : m.state === 'unsent'
              ? `没有合并 ${w}：${m.reason ?? '没有发出'}`
              : `${w} 已合并`;
  } else {
    const verb = r.kind === 'autopilot' ? '托管' : '交给 agent';
    const allOk = r.steps.every((s) => s.state === 'ok');
    if (m.state === 'pending') head = `正在${verb}…`;
    else if (m.state === 'refused' || m.state === 'unsent') head = `没有${verb}：${labelText(m)}`;
    else if (allOk) head = r.kind === 'autopilot' ? `已托管：${r.steps.map(labelText).join('、')}` : `已交给 agent：${r.steps.map(labelText).join('、')}`;
    else head = `${verb}没有全部完成：${r.steps.map(labelText).join('；')}`;
  }
  const p = opPhase(r);
  if (p === 'settling') head += r.stuck ? '（一直没读到 GitHub 上的最新状态，请到 GitHub 页面核对）' : '（正在等 GitHub 的最新状态）';
  if (p === 'unlocked') head = `已由人核对后解除锁定：${head}`;
  // GitHub#357: a read that is running says so; what the one before could not do is gone by then
  if (r.checking && p === 'unknown') head += '；正在查证…';
  else if (r.checkProblem && p === 'unknown') head += `；这次没能查证：${r.checkProblem}`;
  if (r.finishing) head += '；正在补做…';
  else if (r.finishProblem) head += `；这次没能补做：${r.finishProblem}`;
  if (r.readProblem && p !== 'waiting') head += `；${r.readProblem}`;
  if (r.replyState === 'sending') head += '；正在用附的评论原文发回复…';
  if (r.replyState === 'unknown') head += '；用附的评论原文发的回复不确定有没有发出，请到 GitHub 页面核对';
  return head;
}

export type OpTone = NoticeTone;

/**
 * GitHub#357: what a record says about itself, for the one colour rule (noticeTone.ts).
 *  - busy: a request, the wait for the re-read after it, an evidence read, the preparation of
 *    "补做剩下的步骤". A wait that ran long (`stuck`) or whose re-read failed is no longer this
 *    record's own request: the sync rounds catch up (retrying).
 *  - done: exactly the records that put themselves away (opFullyDone) — green never stays.
 *  - failed: the main step refused / never sent; an evidence read that ended without an answer
 *    ("这次没能查证"); a "补做" that did nothing. A missing answer alone is never a failure.
 *  - rest: a step not done that nobody is working on is yellow as it always was; otherwise the
 *    plain blue (unlocked by hand, a draft still kept).
 */
export function opFacts(r: OpRecord): NoticeFacts {
  const p = opPhase(r);
  const m = main(r);
  return {
    busy: p === 'waiting' || (p === 'unknown' && r.checking === true) || r.finishing === true || (p === 'settling' && !r.stuck && !r.readProblem),
    done: opFullyDone(r),
    failed: m.state === 'refused' || m.state === 'unsent' || (p === 'unknown' && !!r.checkProblem) || !!r.finishProblem,
    retrying: !!r.readProblem || (p === 'settling' && r.stuck),
    rest: r.steps.some((s) => s.state !== 'ok') ? 'warn' : 'info',
  };
}

export function opTone(r: OpRecord): OpTone {
  return noticeTone(opFacts(r));
}

/** What the draft still holds (table E), null = nothing kept. */
export function opDraftLeft(r: OpRecord): OpDraft | null {
  if (r.draftDropped) return null;
  const step = (n: OpStepName) => r.steps.find((s) => s.name === n);
  const out: OpDraft = {};
  const close = step('close');
  if (r.draft.reason && close && close.state !== 'ok') out.reason = r.draft.reason;
  const comment = r.draft.comment?.trim() ? r.draft.comment : undefined;
  if (comment !== undefined && !r.commentUsed) {
    const c = step('comment');
    if (!c || c.state !== 'ok') out.comment = comment;
  }
  const merge = step('merge');
  if (r.draft.method && merge && merge.state !== 'ok') {
    out.method = r.draft.method;
    if (r.draft.headOid) out.headOid = r.draft.headOid;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * What may be put back into a dialog to do the operation again ("重新关闭 / 合并…", code review
 * round 2): the draft left, minus a comment that a reply made from it may already have posted.
 * That comment can still be copied (opDraftLeft keeps it), never sent again from here.
 */
export function opReusableDraft(r: OpRecord): OpDraft | null {
  const left = opDraftLeft(r);
  if (!left) return null;
  if (!r.replyState) return left;
  const { comment: _c, ...rest } = left;
  return Object.keys(rest).length ? rest : null;
}

/** the comment step's state, when the record carries a comment */
function commentState(r: OpRecord): OpStepState | null {
  const c = r.steps.find((s) => s.name === 'comment');
  if (c) return c.state;
  return r.draft.comment?.trim() ? 'unsent' : null;
}

export type OpButton =
  | 'recheck' // read the evidence again (reads only)
  | 'openWeb' // the item on GitHub
  | 'unlock' // "已核对，解除锁定": local only, nothing is sent
  | 'retry' // the main step was refused: the dialog again, draft restored
  | 'finish' // label steps refused / not sent after the main one worked
  | 'copy' // copy the comment kept in the draft
  | 'toReply' // put the comment kept in the draft into the reply box
  | 'dropDraft'
  | 'dismiss';

/** The buttons a record offers (tables A and B). */
export function opButtons(r: OpRecord): OpButton[] {
  const p = opPhase(r);
  const out: OpButton[] = [];
  if (p === 'unknown') out.push(...(r.checking ? [] : (['recheck'] as const)), 'openWeb', 'unlock');
  if (p === 'settling' && r.stuck) out.push('openWeb', 'unlock');
  if (p === 'settled') {
    const m = main(r);
    if (m.state === 'refused' || m.state === 'unsent') out.push('retry');
    else if (finishSteps(r).length && !r.finishing) out.push('finish');
  }
  const left = opDraftLeft(r);
  // while a step is still on its way the comment may yet go out with it: nothing to recover yet
  if (left?.comment !== undefined && p !== 'waiting') {
    out.push('copy');
    const cs = commentState(r);
    if ((cs === 'refused' || cs === 'unsent') && !r.replyState) out.push('toReply');
  }
  if (left && p !== 'waiting') out.push('dropDraft');
  if (!opLocked(r) && !r.finishing) out.push('dismiss');
  return out;
}

/**
 * "补做剩下的步骤": the label steps of a settled autopilot / hand-back whose main step
 * worked and that were refused or never sent. A step that succeeded or whose answer
 * never came is never in it (an "agent" label the daemon took away must not be added
 * twice). `labels` = the item's labels from a re-read made just now: an autopilot
 * label already there is skipped, a "human" label no longer there is skipped.
 */
export function finishSteps(r: OpRecord, labels?: readonly string[]): OpStep[] {
  if (r.kind !== 'autopilot' && r.kind !== 'handBack') return [];
  if (opPhase(r) !== 'settled' || main(r).state !== 'ok') return [];
  const out: OpStep[] = [];
  for (const s of r.steps.slice(1)) {
    if (s.state !== 'refused' && s.state !== 'unsent') continue;
    if (labels && s.name === 'addLabel' && labels.includes(s.label ?? '')) continue;
    if (labels && s.name === 'removeLabel' && !labels.includes(s.label ?? '')) continue;
    out.push({ name: s.name, label: s.label, state: 'unsent', reason: null, sentAt: null, answeredAt: null });
  }
  return out;
}

/**
 * A re-read of the item landed (issued at `issuedAt`, reads the board data as it is
 * now). It counts only when issued after every answer (and after the sending of a step
whose answer never came, see readBoundary): then it settles the wait, and
 * is positive evidence for an unknown close / merge (read back closed / merged) and an
 * unknown label removal (the label is gone). It never turns anything into "did not
 * happen". Returns the same object when nothing changed.
 */
export function opApplyRead(r: OpRecord, read: { issuedAt: number; state: 'open' | 'closed' | 'merged'; labels: readonly string[] }): OpRecord {
  if (r.unlocked) return r;
  if (r.steps.some((s) => s.state === 'pending')) return r;
  const last = readBoundary(r);
  if (last === null || read.issuedAt <= last) return r;
  let changed = false;
  const steps = r.steps.map((s) => {
    if (s.state !== 'unknown') return s;
    if (s.name === 'close' && (read.state === 'closed' || read.state === 'merged')) return ((changed = true), { ...s, state: 'ok' as const, reason: '重读时已是关闭状态' });
    if (s.name === 'merge' && read.state === 'merged') return ((changed = true), { ...s, state: 'ok' as const, reason: '重读时已是合并状态' });
    if (s.name === 'removeLabel' && !read.labels.includes(s.label ?? '')) return ((changed = true), { ...s, state: 'ok' as const, reason: '重读时这个标签已不在' });
    return s;
  });
  const next: OpRecord = { ...r, steps };
  if (r.readAt === null || read.issuedAt > r.readAt) {
    next.readAt = read.issuedAt;
    changed = true;
  }
  const target = r.kind === 'merge' ? read.state === 'merged' : r.kind === 'closeIssue' || r.kind === 'closePr' ? read.state === 'closed' || read.state === 'merged' : false;
  if (target && !r.targetSeen) {
    next.targetSeen = true;
    changed = true;
  }
  // PR #282 code review round 1: "stuck" only says the wait for this re-read ran long; once a read
  // that counts has settled the record, it is over (it would keep the notice from ever putting itself away)
  if (next.stuck && opPhase(next) === 'settled') {
    next.stuck = false;
    changed = true;
  }
  return changed ? next : r;
}

/** steps whose result may need a comment / a label event as evidence */
export function needsRecords(s: OpStep): boolean {
  return s.name === 'comment' || s.name === 'addLabel' || s.name === 'removeLabel';
}

/**
 * Positive evidence from the item's comments and label events (code review round 1): an unknown
 * comment step is proven by a comment of `login` with exactly the draft's text, an unknown label
 * step by a "labeled" / "unlabeled" event of that label by `login` — in both cases one whose id
 * was not there before the operation's first request (`r.before`). Without that list nothing is
 * proven. `missing` lists the unknown steps nothing was found for (or that cannot be proven).
 */
export function opProveFromRecords(
  r: OpRecord,
  records: { comments: { id: string; author: string | null; body: string }[]; labelEvents: { id: string; event: 'labeled' | 'unlabeled'; actor: string | null; label: string }[] },
  login: string,
): { record: OpRecord; missing: string[] } {
  let record = r;
  const missing: string[] = [];
  if (r.replyState === 'unknown') {
    const reply = r.reply;
    if (!reply || !reply.before) missing.push('用附的评论原文发的回复：发送前没读到这一条原有的评论，无法区分新旧，只能人工核对');
    else if (records.comments.some((c) => !reply.before!.includes(c.id) && c.author === login && c.body === reply.body))
      record = { ...record, replyState: null, reply: null, commentUsed: true };
    else missing.push('评论列表里没有用附的评论原文发的那条回复（可能还没出现）');
  }
  r.steps.forEach((s, i) => {
    if (s.state !== 'unknown' || !needsRecords(s)) return;
    const what = s.name === 'comment' ? '附带评论' : `「${s.label ?? ''}」`;
    if (!r.before) {
      missing.push(`${what}：发送前没读到这一条原有的评论和标签记录，无法区分新旧，只能人工核对`);
      return;
    }
    const before = r.before;
    const found =
      s.name === 'comment'
        ? records.comments.some((c) => !before.comments.includes(c.id) && c.author === login && c.body === (r.draft.comment ?? ''))
        : records.labelEvents.some((e) => !before.events.includes(e.id) && e.actor === login && e.label === s.label && e.event === (s.name === 'addLabel' ? 'labeled' : 'unlabeled'));
    if (found) record = opProveStep(record, i, s.name === 'comment' ? '在评论列表里找到了这次发出的评论' : '在 GitHub 的标签记录里找到了这一步');
    else missing.push(s.name === 'comment' ? '评论列表里没有这次发出的评论（可能还没出现）' : `标签记录里没有这次的「${s.label}」`);
  });
  return { record, missing };
}

/** Positive evidence for one unknown step (the comment found, the label event found). */
export function opProveStep(r: OpRecord, index: number, how: string): OpRecord {
  const s = r.steps[index];
  if (!s || s.state !== 'unknown') return r;
  return { ...r, steps: r.steps.map((x, i) => (i === index ? { ...x, state: 'ok' as const, reason: how } : x)) };
}

/** A record kept on disk by an earlier run: a request still waiting then has no answer now, and nothing is sent again. */
export function opAfterRestart(r0: OpRecord): OpRecord {
  // GitHub#357: what was running then is not running now
  const r: OpRecord = { ...r0, checking: false, finishing: false };
  const replyState = r.replyState === 'sending' ? ('unknown' as const) : (r.replyState ?? null);
  if (!r.steps.some((s) => s.state === 'pending')) return { ...r, running: false, replyState };
  return { ...r, running: false, replyState, steps: r.steps.map((s) => (s.state === 'pending' ? { ...s, state: 'unknown' as const, reason: '客户端重启前没有收到 GitHub 的应答' } : s)) };
}

/** How long a fully successful notice stays before it puts itself away (GitHub#256; 5 s since GitHub#279). */
export const AUTO_DISMISS_MS = 5_000;

/**
 * GitHub#256: a notice that may put itself away after AUTO_DISMISS_MS. Judged on the record's
 * whole state, never on its tone or buttons (a merge whose linked issues could not be re-read
 * still reads "ok" with only the × — it must stay). Every condition must hold:
 * settled (not waiting / unknown / settling, and not unlocked by hand), every step ok, a
 * close / merge read back closed / merged, no re-read problem, not stuck, no draft left, no
 * reply on its way or unknown, not put away already. (An evidence problem only stands while a
 * step is unknown, and "stuck" only while settling, so neither reaches a kept settled record:
 * GitHub#296, opWithoutStale.)
 */
export function opAutoDismissable(r: OpRecord): boolean {
  return !r.dismissed && opFullyDone(r);
}

/**
 * GitHub#357: everything went through — the one condition behind both "the notice is green" (opFacts)
 * and "the notice puts itself away" (opAutoDismissable), so a green notice never stays on screen.
 */
export function opFullyDone(r: OpRecord): boolean {
  if (r.unlocked || r.stuck || r.finishing || r.finishProblem) return false;
  if (opPhase(r) !== 'settled') return false;
  if (!r.steps.every((s) => s.state === 'ok')) return false;
  if (needsTarget(r) && !r.targetSeen) return false;
  if (r.readAt === null) return false;
  // GitHub#296: a check problem is only said while a step is unknown (opText) and only stands then
  // (opWithoutStale): a settled record is never kept by one the notice no longer shows
  if (r.readProblem) return false;
  if (r.replyState) return false;
  return opDraftLeft(r) === null;
}

/**
 * GitHub#296: two marks only stand in the phase they are about, and only there does the notice
 * say them: what an evidence read could not do ("这次没能查证：…") is about the steps still
 * unknown, "stuck" about a wait for the re-read (settling). Out of that phase — proven by a later
 * read or by records, unlocked by hand — they are dropped. Every record the controller keeps goes
 * through this (its one setOp), so a sync read, the end of a recheck and a record loaded from an
 * earlier run all drop them the same way: a notice must never be kept on screen by a problem it
 * does not show. Returns the same object when nothing changes.
 */
export function opWithoutStale(r: OpRecord): OpRecord {
  const p = opPhase(r);
  const check = !!r.checkProblem && p !== 'unknown';
  const stuck = r.stuck && p !== 'settling';
  // GitHub#357: the same for "这次没能补做": it is about steps that can still be finished
  const finish = !!r.finishProblem && !r.finishing && finishSteps(r).length === 0;
  if (!check && !stuck && !finish) return r;
  return { ...r, ...(check ? { checkProblem: null } : {}), ...(stuck ? { stuck: false } : {}), ...(finish ? { finishProblem: null } : {}) };
}

/** Records may be dropped once settled, put away and with no draft left. */
export function opDisposable(r: OpRecord): boolean {
  return !opLocked(r) && r.dismissed && opDraftLeft(r) === null;
}

export function isOpRecord(x: unknown): x is OpRecord {
  const r = x as OpRecord;
  return (
    !!r &&
    typeof r.id === 'string' &&
    typeof r.key === 'string' &&
    typeof r.repo === 'string' &&
    typeof r.number === 'number' &&
    isOpKind(r.kind as string) &&
    Array.isArray(r.steps) &&
    r.steps.length > 0 &&
    r.steps.every((s) => s && typeof s.name === 'string' && ['unsent', 'pending', 'ok', 'refused', 'unknown'].includes(s.state)) &&
    !!r.draft &&
    typeof r.draft === 'object'
  );
}
