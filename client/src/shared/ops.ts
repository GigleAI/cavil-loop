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
// into a success. Nothing is ever re-sent by itself.
//
// GitHub#359: an unknown step is checked again by the controller itself (a few
// times, then with every sync round). Proven done = the steps not sent yet go out
// by themselves, each one only after `opPermit` allowed it on a fresh read. Not
// found is still unknown (the request may yet land): the record stays locked and
// a person may send that label step again after reading what that can cause
// (`opResendConfirm`). The check's verdict (`opCheckSteps`), the permit, the
// notice, the buttons and the dialog's words all come from this file.
//
// The draft (close reason, attached comment, merge method) follows its own rule
// (table E): a part goes only when its own step is confirmed done, or when a
// person drops it. Settling never deletes a draft.

import type { IssueCloseReason, MergeMethod } from './actions';
import { noticeTone, type NoticeFacts, type NoticeTone } from './noticeTone';
import type { BlockedStepName, Facts, Pick, Ref } from './blocked';

export type OpKind = 'closeIssue' | 'closePr' | 'merge' | 'autopilot' | 'handBack' | 'blocked';
export const OP_KINDS: readonly OpKind[] = ['closeIssue', 'closePr', 'merge', 'autopilot', 'handBack', 'blocked'];
export function isOpKind(k: string): k is OpKind {
  return (OP_KINDS as readonly string[]).includes(k);
}

/** GitHub#434: 'relation' = one native "Blocked by"; 'check' = a read, nothing sent (the registration is the newest one) */
export type OpStepName = 'close' | 'comment' | 'merge' | 'addLabel' | 'removeLabel' | 'relation' | 'check';
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
  /** GitHub#359: which of the three labels this step is about (decides what a second send can cause) */
  role?: OpLabelRole;
  /** GitHub#359: what the last check of this unknown label step found (see opCheckSteps); absent = never checked */
  check?: OpCheck;
  /** GitHub#359: how often a person sent this step again */
  resent?: number;
  /** GitHub#434: which step of "等前置…" this is (its label steps keep their addLabel / removeLabel names) */
  blocked?: BlockedStepName;
  /** GitHub#434: a 'relation' step: the prerequisite's key */
  target?: string;
}

/**
 * GitHub#434: what a "等前置…" record carries besides its steps. `basis` is what the person confirmed
 * (the facts of the read the dialog showed); before every write the item is read again and must hold
 * `basis` plus exactly what the steps done so far changed (shared/blocked.ts).
 */
export interface BlockedOpData {
  /** this operation's id, written hidden into its registration (finds it again when the answer was lost) */
  opId: string;
  basis: Facts;
  /** the waiting label's and the "等人处理" label's names when it started */
  labels: { blocked: string; human: string };
  /** the native relations to add, by key */
  picks: Pick[];
  /** the prerequisites the registration lists */
  markRefs: Ref[];
  /** the registration's comment, once posted (its numeric id) */
  commentId?: number | null;
  /** why it stopped (null = it did not), and whether the last full read showed the item paused */
  stop?: { text: string; paused: 'yes' | 'unconfirmed' | 'none' } | null;
}

export type OpLabelRole = 'autopilot' | 'agent' | 'human';
/**
 * GitHub#359: the verdict of a check on a label step whose answer never came. There is no
 * "it did not happen": `unseen` only says this read did not show it.
 *   unread  — the read failed, was not complete, did not add up, or there is no list from before
 *   unseen  — read in full: the wanted state is not there and nobody touched this label since
 *   touched — read in full: the wanted state is not there, but this label has newer records
 */
export type OpCheck = 'unread' | 'unseen' | 'touched';

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
  before?: { comments: string[]; events: string[]; labels?: string[] } | null;
  /**
   * GitHub#359, this run of the app only (never kept over a restart): the steps not sent yet may go
   * out by themselves once the unknown one is proven (set when the sending stopped at an unknown
   * step, or when a person sent a step again), within OP_AUTO_MS of `autoSince`.
   */
  auto?: boolean;
  autoSince?: number;
  /** GitHub#359: how many checks were made */
  checks?: number;
  /** GitHub#359: why the steps not sent yet were not sent by themselves; `redo` = start over ("重新托管…") instead of finishing */
  halt?: { text: string; redo: boolean } | null;
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
   * GitHub#357: an evidence read is running in this run of the app. Only the notice reads it (blue,
   * "正在查证…"): the lock, the phase and the draft are as before. Not kept over a restart.
   * GitHub#359: it stands for the whole burst of the app's own checks right after a lost answer (the
   * one made at once and the few after it, seconds apart) and for the check before a second send a
   * person asked for; while it stands the notice offers nothing. The check of every later sync round
   * is a background loop and never sets it.
   */
  checking?: boolean;
  /** GitHub#357: "补做剩下的步骤" is being prepared (the item is read first) in this run of the app. Not kept over a restart. */
  finishing?: boolean;
  /** GitHub#357: why the last "补做剩下的步骤" did nothing; cleared when the next one starts, and once nothing is left to finish */
  finishProblem?: string | null;
  /** GitHub#434: a "等前置…" record */
  blocked?: BlockedOpData;
}

/**
 * How many labels the board's reads of an item ask for (`labels(first: …)` in data/queries.ts). A read that came back
 * with this many may have left labels out: a label missing from it proves nothing (PR #365 code review round 1).
 */
export const ITEM_LABELS_FIRST = 50;

/** how long a succeeded operation waits for a re-read before the manual unlock is offered */
export const STUCK_MS = 120_000;
/** GitHub#359: the automatic checks after the first one (made at once) */
export const OP_CHECK_DELAYS_MS: readonly number[] = [3_000, 10_000, 30_000];
/** GitHub#359: steps not sent yet go out by themselves only this long after the operation started (or was sent again by a person) */
export const OP_AUTO_MS = 600_000;

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

/** GitHub#359: what the last check of an unknown label step found — never "it did not happen" */
function checkText(s: OpStep, checks: number): string {
  if (s.check === 'unseen') return `（已核对 ${Math.max(1, checks)} 次，到现在还没查到；原来那次请求仍可能稍后生效；还会继续自动核对）`;
  if (s.check === 'touched') return '（这期间这个标签被人动过，请到 GitHub 页面核对）';
  return '';
}

/** how one label step reads */
function labelText(s: OpStep, checks = 0): string {
  const L = `「${s.label ?? ''}」`;
  const add = s.name === 'addLabel';
  switch (s.state) {
    case 'ok':
      return add ? `已加上${L}` : `已摘掉${L}`;
    case 'refused':
      return `${add ? '加' : '摘'}${L}没有成功：${s.reason ?? ''}`;
    case 'unknown':
      return `${L}不确定有没有${add ? '加上' : '摘掉'}${checkText(s, checks)}`;
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
  } else if (r.kind === 'blocked') {
    head = blockedText(r);
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
    const u = r.steps.find((s) => s.state === 'unknown');
    if (m.state === 'pending') head = `正在${verb}…`;
    else if (r.checking && u && !r.steps.some((s) => s.state === 'pending'))
      head = `正在${verb}…「${u.label ?? ''}」发出后没有收到 GitHub 的应答，正在自动核对有没有${u.name === 'addLabel' ? '加上' : '摘掉'}（第 ${(r.checks ?? 0) + 1} 次）`;
    else if (m.state === 'refused' || m.state === 'unsent') head = `没有${verb}：${labelText(m)}`;
    else if (allOk) head = r.kind === 'autopilot' ? `已托管：${r.steps.map((s) => labelText(s)).join('、')}` : `已交给 agent：${r.steps.map((s) => labelText(s)).join('、')}`;
    else head = `${verb}没有全部完成：${r.steps.map((s) => labelText(s, r.checks ?? 0)).join('；')}`;
  }
  const p = opPhase(r);
  const labelOp = r.kind === 'autopilot' || r.kind === 'handBack';
  if (r.halt && p !== 'waiting' && !r.steps.every((s) => s.state === 'ok')) head += `。${r.halt.text}，没有接着往下做`;
  if (p === 'settling') head += r.stuck ? '（一直没读到 GitHub 上的最新状态，请到 GitHub 页面核对）' : '（正在等 GitHub 的最新状态）';
  if (p === 'unlocked') head = `已由人核对后解除锁定：${head}`;
  // GitHub#357: a read that is running says so; what the one before could not do is gone by then.
  // GitHub#359: a hand-over says it in its own sentence above; the checks go on with every sync round
  if (r.checking && p === 'unknown') head += labelOp ? '' : '；正在查证…';
  else if (r.checkProblem && p === 'unknown') head += `；这次没能查证：${r.checkProblem}；之后每次同步还会再核对`;
  if (r.finishing) head += '；正在补做…';
  else if (r.finishProblem) head += `；这次没能补做：${r.finishProblem}`;
  if (r.readProblem && p !== 'waiting') head += `；${r.readProblem}`;
  if (r.replyState === 'sending') head += '；正在用附的评论原文发回复…';
  if (r.replyState === 'unknown') head += '；用附的评论原文发的回复不确定有没有发出，请到 GitHub 页面核对';
  return head;
}

/** GitHub#434: how one step of "等前置…" reads */
function blockedStepText(s: OpStep): string {
  switch (s.blocked) {
    case 'pause':
    case 'repause':
      return `挂「${s.label ?? ''}」暂停`;
    case 'unpause':
      return `摘「${s.label ?? ''}」恢复等待`;
    case 'addBlocked':
      return `挂「${s.label ?? ''}」`;
    case 'relation':
      return `把 ${s.target ?? ''} 设成「Blocked by」`;
    case 'comment':
      return '发登记评论';
    case 'check':
      return '核对登记';
    default:
      return s.name;
  }
}

/** GitHub#434: the notice of a "等前置…" record. */
function blockedText(r: OpRecord): string {
  const b = r.blocked;
  const u = r.steps.find((s) => s.state === 'unknown');
  const pending = r.steps.find((s) => s.state === 'pending') ?? (r.running && r.steps[0].state === 'unsent' ? r.steps[0] : undefined);
  const done = r.steps.filter((s) => s.state === 'ok' && s.blocked !== 'check').map(blockedStepText);
  const refused = r.steps.find((s) => s.state === 'refused');
  if (pending) return `正在登记前置：${blockedStepText(pending)}…`;
  if (r.steps.every((s) => s.state === 'ok')) return `已登记前置：${done.join('、')}`;
  const parts: string[] = [];
  if (u) parts.push(`${blockedStepText(u)}发出后没有收到 GitHub 的应答，不确定有没有生效（${u.reason ?? ''}）`);
  else if (refused) parts.push(`${blockedStepText(refused)}没有成功：${refused.reason ?? ''}`);
  else if (b?.stop) parts.push(`停在「${blockedStepText(r.steps.find((s) => s.state === 'unsent') ?? r.steps[r.steps.length - 1])}」之前：${b.stop.text}`);
  else {
    const first = r.steps.find((s) => s.state === 'unsent');
    if (first) parts.push(`没有${blockedStepText(first)}：${first.reason ?? '没有发出'}`);
  }
  parts.push(done.length ? `已做：${done.join('、')}` : 'GitHub 上什么都没改');
  const paused = b?.stop?.paused;
  if (paused === 'yes') parts.push(`已暂停：挂着「${b!.labels.human}」，daemon 不会按这份登记接着干。核对后点「等前置…」重新登记`);
  else if (paused === 'unconfirmed') parts.push(`暂停状态未确认，daemon 可能按缺项的登记接着干，请到 GitHub 页面核对，或点「等前置…」重新登记`);
  return `登记前置没有完成：${parts.join('；')}`;
}

export type OpTone = NoticeTone;

/**
 * GitHub#357: what a record says about itself, for the one colour rule (noticeTone.ts).
 *  - busy: a request, the wait for the re-read after it, an evidence read, the preparation of
 *    "补做剩下的步骤". A wait that ran long (`stuck`) or whose re-read failed is no longer this
 *    record's own request: the sync rounds catch up (retrying).
 *  - done: exactly the records that put themselves away (opFullyDone) — green never stays.
 *  - failed: the main step refused / never sent; a "补做" that did nothing. A missing answer alone is
 *    never a failure — nor, since GitHub#359, a check that could not read ("这次没能查证"): the app
 *    checks again with every sync round (retrying).
 *  - rest: a step not done that nobody is working on is yellow as it always was; otherwise the
 *    plain blue (unlocked by hand, a draft still kept).
 */
export function opFacts(r: OpRecord): NoticeFacts {
  const p = opPhase(r);
  const m = main(r);
  return {
    busy: p === 'waiting' || (p === 'unknown' && r.checking === true) || r.finishing === true || (p === 'settling' && !r.stuck && !r.readProblem),
    done: opFullyDone(r),
    failed: m.state === 'refused' || m.state === 'unsent' || !!r.finishProblem,
    // GitHub#359: a step whose answer never came is checked again with every sync round — also after a
    // check that could not read ("这次没能查证"): the app keeps at it, so it is yellow, not a dead end
    retrying: !!r.readProblem || (p === 'settling' && r.stuck) || (p === 'unknown' && !r.checking),
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
  | 'resend' // GitHub#359: "仍要重发…" — a label step read in full and not found; a dialog says what a second send can cause
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
  // GitHub#359: while the app's own checks run there is nothing to choose; after them the checks go on
  // with every sync round, so there is no "check again" — only the second send (when a full read did not
  // find the step) and the unlock by hand
  if (p === 'unknown' && !r.checking) {
    if (opResendStep(r) >= 0) out.push('resend');
    out.push('unlock');
  }
  if (p === 'settling' && r.stuck) out.push('openWeb', 'unlock');
  if (p === 'settled') {
    const m = main(r);
    // GitHub#434: a "等前置…" that did not finish is done again from the dialog (read afresh)
    if (m.state === 'refused' || m.state === 'unsent' || (r.halt?.redo && !r.steps.every((s) => s.state === 'ok')) || (r.kind === 'blocked' && !r.steps.every((s) => s.state === 'ok'))) out.push('retry');
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
    out.push({ name: s.name, label: s.label, state: 'unsent', reason: null, sentAt: null, answeredAt: null, ...(s.role ? { role: s.role } : {}) });
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
    // a label missing proves the removal only when the read cannot have left labels out (PR #365 code review round 1)
    if (s.name === 'removeLabel' && read.labels.length < ITEM_LABELS_FIRST && !read.labels.includes(s.label ?? '')) return ((changed = true), { ...s, state: 'ok' as const, reason: '重读时这个标签已不在' });
    // GitHub#359: the wanted state is there in a read issued after the request — the step is done, whoever did it
    if (s.name === 'addLabel' && read.labels.includes(s.label ?? '')) return ((changed = true), { ...s, state: 'ok' as const, reason: '重读时这个标签已在' });
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
    else if (s.name === 'comment') missing.push('评论列表里没有这次发出的评论（可能还没出现）');
    // GitHub#359: a label step not found says so itself, through its check (opCheckSteps)
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
  // GitHub#357: what was running then is not running now. GitHub#359: nor does a record go on by itself
  // in another run of the app than the one that started it
  const r: OpRecord = { ...r0, checking: false, finishing: false, auto: false };
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
  // GitHub#359: "still checking" and a check's verdict are about an unknown step only
  const checking = !!r.checking && p !== 'unknown';
  const verdict = r.steps.some((s) => s.check !== undefined && s.state !== 'unknown');
  if (!check && !stuck && !finish && !checking && !verdict) return r;
  return {
    ...r,
    ...(check ? { checkProblem: null } : {}),
    ...(stuck ? { stuck: false } : {}),
    ...(finish ? { finishProblem: null } : {}),
    ...(checking ? { checking: false } : {}),
    ...(verdict ? { steps: r.steps.map((s) => (s.check !== undefined && s.state !== 'unknown' ? (({ check: _c, ...rest }) => rest)(s) : s)) } : {}),
  };
}

// ---- GitHub#359: the check of an unknown label step, the permit for a send nobody clicked, the second send ----

/** One read of the item for a check / before a send: state, labels and label records, with whether it was read in full. */
export interface OpSnapshot {
  /** false = the label records could not be read back to what was there before the operation, or the labels not in full */
  complete: boolean;
  /**
   * PR #365 code review round 1: the label list alone was read in full (GitHub's count of the item's labels equals
   * what came back). Only then may a label's absence prove anything; a label seen in it proves its presence either way.
   */
  labelsComplete: boolean;
  state: 'open' | 'closed' | 'merged';
  labels: string[];
  /** the label records read, oldest first */
  events: { id: string; event: 'labeled' | 'unlabeled'; actor: string | null; label: string }[];
}

/**
 * The label records made since the operation started, oldest first — or null when that cannot be
 * told: the read was not complete, there is no list (or no label list) from before the first
 * request, or the new records applied to the labels from before do not give the labels read now
 * (the two were not read at one moment). null is "not read", never "nothing happened".
 */
export function opNewEvents(r: OpRecord, snap: OpSnapshot | null): OpSnapshot['events'] | null {
  if (!snap || !snap.complete) return null;
  const before = r.before;
  if (!before || !Array.isArray(before.labels)) return null;
  const known = new Set(before.events);
  let from = 0;
  snap.events.forEach((e, i) => {
    if (known.has(e.id)) from = i + 1;
  });
  const news = snap.events.slice(from);
  const labels = new Set(before.labels);
  for (const e of news) {
    if (e.event === 'labeled') labels.add(e.label);
    else labels.delete(e.label);
  }
  if (labels.size !== snap.labels.length || snap.labels.some((l) => !labels.has(l))) return null;
  return news;
}

const isLabelStep = (s: OpStep) => s.name === 'addLabel' || s.name === 'removeLabel';
const reached = (s: OpStep, labels: readonly string[]) => (s.name === 'addLabel' ? labels.includes(s.label ?? '') : !labels.includes(s.label ?? ''));

/**
 * Positive evidence from a snapshot read after the request: the wanted state of an unknown label
 * step is there (the label is on / off) — the step is done, whoever did it. Says nothing about
 * whether the steps after it may still go out: that is opPermit's.
 */
export function opProveFromSnapshot(r: OpRecord, snap: OpSnapshot | null): OpRecord {
  if (!snap) return r;
  let record = r;
  r.steps.forEach((s, i) => {
    if (s.state !== 'unknown' || !isLabelStep(s)) return;
    // a label seen is on; a label not seen is off only when the list came back whole (PR #365 code review round 1)
    if (s.name === 'addLabel' ? snap.labels.includes(s.label ?? '') : snap.labelsComplete && !snap.labels.includes(s.label ?? ''))
      record = opProveStep(record, i, s.name === 'addLabel' ? '重读时这个标签已在' : '重读时这个标签已不在');
  });
  return record;
}

/**
 * The verdict of one check on every label step still unknown (after the positive evidence was
 * applied: a step proven is no longer unknown). Returns the same object when nothing changes.
 */
export function opCheckSteps(r: OpRecord, snap: OpSnapshot | null): OpRecord {
  const news = opNewEvents(r, snap);
  let changed = false;
  const steps = r.steps.map((s) => {
    if (s.state !== 'unknown' || !isLabelStep(s)) return s;
    const check: OpCheck = news === null || !snap ? 'unread' : reached(s, snap.labels) ? 'unread' : news.some((e) => e.label === s.label) ? 'touched' : 'unseen';
    if (s.check === check) return s;
    changed = true;
    return { ...s, check };
  });
  return changed ? { ...r, steps } : r;
}

export type OpPermit =
  | { ok: true }
  /** satisfied: the wanted state is already there — the step is done without a send */
  | { ok: false; why: 'unread' | 'satisfied' | 'halt'; text: string; redo?: boolean };

/**
 * May step `index` go out now without a person having asked for exactly this send at this moment?
 * One judgement for the steps sent by themselves after an unknown one was proven (`mode: 'auto'`)
 * and for a second send a person confirmed (`mode: 'resend'`); the controller asks it when it
 * decides and again from a fresh read right before the request. Everything must hold:
 *   - the read is complete and adds up (opNewEvents);
 *   - the item is still open;
 *   - every step of this operation already done still stands (a label added is on, one removed is off);
 *   - the operation's labels have no record since it started other than one per step done, in that
 *     step's direction — whoever made it (a maintainer on the web is the same account as this app);
 *   - the step's wanted state is not there yet (else: done, nothing to send);
 *   - auto: within OP_AUTO_MS, in the run that started it (`r.auto`).
 */
export function opPermit(r: OpRecord, index: number, snap: OpSnapshot | null, opts: { mode: 'auto' | 'resend'; now: number; autoMs?: number }): OpPermit {
  const s = r.steps[index];
  if (!s || !isLabelStep(s)) return { ok: false, why: 'halt', text: '这一步不是改标签' };
  if (opts.mode === 'auto') {
    if (!r.auto) return { ok: false, why: 'halt', text: '客户端重启过，剩下的步骤不再自动发' };
    if (opts.now - (r.autoSince ?? r.startedAt) > (opts.autoMs ?? OP_AUTO_MS)) return { ok: false, why: 'halt', text: '离发起已经超过 10 分钟，剩下的步骤不再自动发' };
  }
  const news = opNewEvents(r, snap);
  if (news === null || !snap) return { ok: false, why: 'unread', text: '没能完整读到这一条现在的状态和标签记录' };
  if (snap.state !== 'open') return { ok: false, why: 'halt', text: '这一条已经关闭', redo: true };
  const allowed = new Map<string, number>();
  for (const d of r.steps) {
    if (d === s || d.state !== 'ok' || !isLabelStep(d)) continue;
    // a label of the hand-over taken away again is somebody picking the item up (or taking it back): the rest can be finished by hand
    if (!reached(d, snap.labels)) return { ok: false, why: 'halt', text: `这期间「${d.label ?? ''}」${d.name === 'addLabel' ? '被摘掉了' : '又被加上了'}`, redo: d.role === 'autopilot' };
    const k = `${d.name === 'addLabel' ? 'labeled' : 'unlabeled'} ${d.label ?? ''}`;
    allowed.set(k, (allowed.get(k) ?? 0) + 1);
  }
  const mine = new Set(r.steps.filter(isLabelStep).map((d) => d.label ?? ''));
  for (const e of news) {
    if (!mine.has(e.label)) continue;
    const k = `${e.event} ${e.label}`;
    const left = allowed.get(k) ?? 0;
    if (left <= 0) return { ok: false, why: 'halt', text: `这期间「${e.label}」被人动过`, redo: r.steps.some((d) => d.label === e.label && d.role === 'autopilot') };
    allowed.set(k, left - 1);
  }
  if (reached(s, snap.labels)) return { ok: false, why: 'satisfied', text: s.name === 'addLabel' ? '这个标签已经在' : '这个标签已经不在' };
  return { ok: true };
}

/**
 * GitHub#359: the step a person may send again ("仍要重发…"), -1 = none. Only the first unknown
 * step, only a label step, only when its last check read everything and did not find it, and only
 * when nothing else of the record is unknown or on its way.
 */
export function opResendStep(r: OpRecord): number {
  // GitHub#434: a "等前置…" step is never sent a second time from the notice (each write needs the whole permit)
  if (r.kind === 'blocked') return -1;
  if (r.unlocked || r.running || r.checking || r.replyState) return -1;
  if (r.steps.some((s) => s.state === 'pending')) return -1;
  const i = r.steps.findIndex((s) => s.state === 'unknown');
  if (i < 0) return -1;
  const s = r.steps[i];
  return isLabelStep(s) && s.check === 'unseen' && r.steps.filter((x) => x.state === 'unknown').length === 1 ? i : -1;
}

/** What a second send of each label can cause when the first one lands late after all (said where the person decides). */
const RESEND_RISK: Record<OpLabelRole, (label: string) => string> = {
  autopilot: (l) => `如果之后摘掉「${l}」来叫停托管，上一次请求迟到生效时会把它重新加上，托管被恢复。`,
  agent: (l) => `如果上一次请求稍后也生效，而这一次加上的「${l}」已被取走开工，这一条会被派两次工。`,
  human: (l) => `如果之后 agent 把这一条交回给人，上一次请求迟到生效时会把「${l}」再摘掉，这一条可能被当成待派工。`,
};

/** GitHub#359: the words of the dialog behind "仍要重发…"; null = nothing to send again. */
export function opResendConfirm(r: OpRecord): { title: string; lines: string[]; after: string | null } | null {
  const i = opResendStep(r);
  if (i < 0) return null;
  const s = r.steps[i];
  const L = s.label ?? '';
  const role: OpLabelRole = s.role ?? (s.name === 'removeLabel' ? 'human' : 'agent');
  const rest = r.steps.slice(i + 1).filter((x) => x.state === 'unsent');
  return {
    title: `再发一次「${s.name === 'addLabel' ? '加上' : '摘掉'} ${L}」？`,
    lines: [
      '到现在还没查到上一次请求生效，但它仍可能稍后生效，GitHub 上已发出的请求撤不回来。',
      RESEND_RISK[role](L),
      '发之前客户端会再核对一次：这一条已关闭、或这期间有人动过这几个标签，就不发。',
    ],
    after: rest.length ? `发出后会接着${rest.map((x) => `${x.name === 'addLabel' ? '加' : '摘'}「${x.label ?? ''}」`).join('、')}。` : null,
  };
}

/**
 * GitHub#359: the first step not sent yet that may go out by itself — every step before it done,
 * nothing unknown or on its way, the record still in the run that may go on. -1 = none.
 */
export function opNextAuto(r: OpRecord): number {
  if (r.kind !== 'autopilot' && r.kind !== 'handBack') return -1;
  if (r.unlocked || !r.auto || r.halt || r.running || r.replyState) return -1;
  if (r.steps.some((s) => s.state === 'pending' || s.state === 'unknown' || s.state === 'refused')) return -1;
  const i = r.steps.findIndex((s) => s.state === 'unsent');
  return i > 0 && r.steps.slice(0, i).every((s) => s.state === 'ok') ? i : -1;
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
