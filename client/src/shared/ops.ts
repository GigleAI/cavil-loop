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
  /** the re-read after the answers (the item, a merged / closed PR's issues) did not work in full; the next sync round catches up */
  readProblem?: string | null;
  /** this record finishes the label steps of an earlier one ("补做剩下的步骤") */
  finishOf?: string;
}

/** how long a succeeded operation waits for a re-read before the manual unlock is offered */
export const STUCK_MS = 120_000;
/** GitHub's clock vs this machine's: evidence written this long before the request was sent still counts */
export const CLOCK_SLACK_MS = 120_000;

export const CLOSE_REASON_NAME: Record<IssueCloseReason, string> = { completed: '已完成', not_planned: '不计划' };

export type OpPhase = 'waiting' | 'unknown' | 'settling' | 'settled' | 'unlocked';

/** The phase of a record (table A). */
export function opPhase(r: OpRecord): OpPhase {
  if (r.unlocked) return 'unlocked';
  if (r.running || r.steps.some((s) => s.state === 'pending')) return 'waiting';
  if (r.steps.some((s) => s.state === 'unknown')) return 'unknown';
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
  if (r.checkProblem && p === 'unknown') head += `；这次没能查证：${r.checkProblem}`;
  if (r.readProblem && p !== 'waiting') head += `；${r.readProblem}`;
  return head;
}

export type OpTone = 'busy' | 'ok' | 'warn' | 'error';
export function opTone(r: OpRecord): OpTone {
  const p = opPhase(r);
  if (p === 'waiting') return 'busy';
  const m = main(r);
  if (m.state === 'refused' || m.state === 'unsent') return 'error';
  if (r.steps.some((s) => s.state !== 'ok')) return 'warn';
  if (p === 'settling') return r.stuck ? 'warn' : 'ok';
  return 'ok';
}

/** What the draft still holds (table E), null = nothing kept. */
export function opDraftLeft(r: OpRecord): OpDraft | null {
  if (r.draftDropped) return null;
  const step = (n: OpStepName) => r.steps.find((s) => s.name === n);
  const out: OpDraft = {};
  const close = step('close');
  if (r.draft.reason && close && close.state !== 'ok') out.reason = r.draft.reason;
  const comment = r.draft.comment?.trim() ? r.draft.comment : undefined;
  if (comment !== undefined) {
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
  if (p === 'unknown') out.push('recheck', 'openWeb', 'unlock');
  if (p === 'settling' && r.stuck) out.push('openWeb', 'unlock');
  if (p === 'settled') {
    const m = main(r);
    if (m.state === 'refused' || m.state === 'unsent') out.push('retry');
    else if (finishSteps(r).length) out.push('finish');
  }
  const left = opDraftLeft(r);
  // while a step is still on its way the comment may yet go out with it: nothing to recover yet
  if (left?.comment !== undefined && p !== 'waiting') {
    out.push('copy');
    const cs = commentState(r);
    if (cs === 'refused' || cs === 'unsent') out.push('toReply');
  }
  if (left && p !== 'waiting') out.push('dropDraft');
  if (!opLocked(r)) out.push('dismiss');
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
 * now). It counts only when issued after every answer: then it settles the wait, and
 * is positive evidence for an unknown close / merge (read back closed / merged) and an
 * unknown label removal (the label is gone). It never turns anything into "did not
 * happen". Returns the same object when nothing changed.
 */
export function opApplyRead(r: OpRecord, read: { issuedAt: number; state: 'open' | 'closed' | 'merged'; labels: readonly string[] }): OpRecord {
  if (r.unlocked) return r;
  if (r.steps.some((s) => s.state === 'pending')) return r;
  const last = lastAnswer(r);
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
  return changed ? next : r;
}

/** Positive evidence for one unknown step (the comment found, the label event found). */
export function opProveStep(r: OpRecord, index: number, how: string): OpRecord {
  const s = r.steps[index];
  if (!s || s.state !== 'unknown') return r;
  return { ...r, steps: r.steps.map((x, i) => (i === index ? { ...x, state: 'ok' as const, reason: how } : x)) };
}

/** A record kept on disk by an earlier run: a request still waiting then has no answer now, and nothing is sent again. */
export function opAfterRestart(r: OpRecord): OpRecord {
  if (!r.steps.some((s) => s.state === 'pending')) return { ...r, running: false };
  return { ...r, running: false, steps: r.steps.map((s) => (s.state === 'pending' ? { ...s, state: 'unknown' as const, reason: '客户端重启前没有收到 GitHub 的应答' } : s)) };
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
