// GitHub#490: what each failed notice offers — at most 「重试」 + one way out + × — decided from the record alone
// (shared/ops.ts opActions / opRedoAction, shared/sends.ts sendActions, shared/noticeTone.ts createActions), one
// case per row of the table in the issue. The controller runs these for real in notice-actions-controller.test.ts.

import { describe, expect, it } from 'vitest';
import { opActions, opRedoAction, type OpRecord, type OpStep, type OpStepState } from '../../src/shared/ops';
import { sendActions, type SendAction, type SendRecord } from '../../src/shared/sends';
import { createActions } from '../../src/shared/noticeTone';
import type { CreateJob } from '../../src/shared/types';

const step = (name: OpStep['name'], state: OpStepState, extra: Partial<OpStep> = {}): OpStep => ({
  name,
  state,
  reason: state === 'refused' ? 'GitHub 不接受' : state === 'unknown' ? '连接中断' : null,
  sentAt: state === 'unsent' ? null : 10,
  answeredAt: state === 'ok' || state === 'refused' || state === 'unknown' ? 20 : null,
  ...extra,
});
function rec(kind: OpRecord['kind'], steps: OpStep[], extra: Partial<OpRecord> = {}): OpRecord {
  const draft = kind === 'closeIssue' ? { reason: 'not_planned' as const, comment: '做完了' } : kind === 'closePr' ? { comment: '不合了' } : kind === 'merge' ? { method: 'squash' as const, headOid: 'a'.repeat(40) } : {};
  return { id: 'op-1', key: 'o/r#5', repo: 'o/r', number: 5, kind, startedAt: 1, steps, draft, readAt: 30, targetSeen: true, unlocked: false, draftDropped: false, dismissed: false, stuck: false, checkProblem: null, ...extra };
}
const hand = (kind: 'autopilot' | 'handBack', states: OpStepState[], extra: Partial<OpStep>[] = [], r: Partial<OpRecord> = {}) => {
  const labels: [OpStep['name'], string, OpStep['role']][] = [
    ...(kind === 'autopilot' ? ([['addLabel', 'autopilot', 'autopilot']] as [OpStep['name'], string, OpStep['role']][]) : []),
    ['addLabel', 'pending/agent', 'agent'],
    ['removeLabel', 'pending/human', 'human'],
  ];
  return rec(kind, labels.map(([n, l, role], i) => step(n, states[i], { label: l, role, ...(extra[i] ?? {}) })), r);
};

describe('an operation: one retry, one way out, ×', () => {
  const rows: [string, OpRecord, Partial<ReturnType<typeof opActions>>][] = [
    ['close refused for sure: redo, handle on GitHub with the comment copied, ×; × gives the comment back to the box', rec('closeIssue', [step('close', 'refused'), step('comment', 'unsent')]), { retry: 'redo', fallback: 'handleWeb', close: true, toBox: true, copy: '做完了' }],
    ['close never sent: redo', rec('closeIssue', [step('close', 'unsent'), step('comment', 'unsent')]), { retry: 'redo', fallback: 'handleWeb', close: true }],
    ['merge refused: redo', rec('merge', [step('merge', 'refused')]), { retry: 'redo', fallback: 'handleWeb', close: true, copy: null }],
    ['hand-back refused on its first label: redo', hand('handBack', ['refused', 'unsent']), { retry: 'redo', fallback: 'handleWeb', close: true }],
    ['fully done: nothing but × (it puts itself away)', rec('closeIssue', [step('close', 'ok'), step('comment', 'ok')]), { retry: null, fallback: null, close: true }],
    ['on its way: nothing, no ×', rec('closeIssue', [step('close', 'pending'), step('comment', 'unsent')]), { retry: null, fallback: null, close: false, copy: null }],
    [
      'unknown label step the rules let be sent again: 「重发…」 + check on GitHub, no ×',
      hand('autopilot', ['ok', 'unknown', 'unsent'], [{}, { check: 'unseen' }]),
      { retry: 'resend', fallback: 'checkWeb', close: false },
    ],
    ['unknown label step not read in full: recheck only', hand('autopilot', ['ok', 'unknown', 'unsent'], [{}, { check: 'unread' }]), { retry: 'recheck', fallback: 'checkWeb', close: false }],
    ['unknown label step someone touched: recheck only', hand('handBack', ['unknown', 'unsent'], [{ check: 'touched' }]), { retry: 'recheck', fallback: 'checkWeb', close: false }],
    ['close without an answer: recheck + check on GitHub (comment copied), no ×, never back to the box', rec('closeIssue', [step('close', 'unknown'), step('comment', 'unsent')]), { retry: 'recheck', fallback: 'checkWeb', close: false, copy: '做完了' }],
    ['merge without an answer: recheck', rec('merge', [step('merge', 'unknown')]), { retry: 'recheck', fallback: 'checkWeb', close: false }],
    ['attached comment without an answer: recheck, no ×', rec('closeIssue', [step('close', 'ok'), step('comment', 'unknown')]), { retry: 'recheck', fallback: 'checkWeb', close: false, toBox: false }],
    ['while the app checks by itself: nothing to press', rec('merge', [step('merge', 'unknown')], { checking: true }), { retry: null, fallback: null, close: false }],
    ['the page opened: the same place now is the unlock', rec('merge', [step('merge', 'unknown')], { webOpened: true }), { retry: 'recheck', fallback: 'checkWeb', webOpened: true, close: false }],
    ['unlocked by a person: × only (the text stays until ×)', rec('closeIssue', [step('close', 'unknown'), step('comment', 'unsent')], { unlocked: true }), { retry: null, fallback: null, close: true, copy: '做完了' }],
    ['succeeded but never read back for long: check on GitHub (two steps)', rec('closeIssue', [step('close', 'ok'), step('comment', 'ok')], { readAt: null, targetSeen: false, stuck: true }), { retry: null, fallback: 'checkWeb', close: false }],
    ['main step done, label steps surely not: 「补做」 + handle on GitHub', hand('handBack', ['ok', 'refused']), { retry: 'finish', fallback: 'handleWeb', close: true }],
    ['closed, the attached comment surely not sent: 「再发评论」', rec('closeIssue', [step('close', 'ok'), step('comment', 'refused')]), { retry: 'sendComment', fallback: 'handleWeb', close: true, toBox: true }],
    [
      '"等前置…" not finished: its dialog again + handle on GitHub',
      rec('blocked', [step('addLabel', 'ok', { blocked: 'pause', label: 'pending/human' }), step('comment', 'refused', { blocked: 'comment' })]),
      { retry: 'blocked', fallback: 'handleWeb', close: true },
    ],
  ];
  for (const [what, r, want] of rows)
    it(what, () => {
      const a = opActions(r);
      expect(a).toMatchObject(want);
      // while something is not sure, 「重试」 never does it again: it reads, or it is the one guarded label resend
      if (r.steps.some((s) => s.state === 'unknown') && !r.unlocked) expect(['recheck', 'resend', null]).toContain(a.retry);
    });

  it('a refusal is done again with exactly its choices; anything else is not done again from here', () => {
    expect(opRedoAction(rec('closeIssue', [step('close', 'refused'), step('comment', 'unsent')]))).toEqual({ kind: 'closeIssue', key: 'o/r#5', reason: 'not_planned', comment: '做完了' });
    expect(opRedoAction(rec('closePr', [step('close', 'refused'), step('comment', 'unsent')]))).toEqual({ kind: 'closePr', key: 'o/r#5', comment: '不合了' });
    expect(opRedoAction(rec('merge', [step('merge', 'refused')]))).toEqual({ kind: 'merge', key: 'o/r#5', method: 'squash', headOid: 'a'.repeat(40) });
    expect(opRedoAction(hand('handBack', ['refused', 'unsent']))).toEqual({ kind: 'handBack', key: 'o/r#5' });
    // a comment a reply made from it may already have posted never goes out again
    expect(opRedoAction(rec('closeIssue', [step('close', 'refused'), step('comment', 'unsent')], { replyState: 'unknown' }))).toEqual(expect.any(String));
    expect(opRedoAction(rec('closeIssue', [step('close', 'unknown'), step('comment', 'unsent')]))).toEqual(expect.any(String));
    expect(opRedoAction(rec('merge', [step('merge', 'ok')]))).toEqual(expect.any(String));
    expect(opRedoAction(rec('blocked', [step('comment', 'refused', { blocked: 'comment' })]))).toEqual(expect.any(String));
  });
});

const K = 'gigleai/cavil-loop#138';
function send(action: SendAction, patch: Partial<SendRecord> = {}): SendRecord {
  return { id: 'send-1', key: K, repo: 'GigleAI/cavil-loop', number: 138, action, startedAt: 1, state: 'sending', sentAt: null, answeredAt: null, reason: null, warning: null, proof: null, returned: false, unlocked: false, dismissed: false, ...patch };
}
const reply: SendAction = { kind: 'comment', key: K, body: '原文' };
const edit: SendAction = { kind: 'editEntry', key: K, entryId: 'IC_1', body: '新', seenSource: '旧' };
const title: SendAction = { kind: 'editTitle', key: K, title: '新标题', seenTitle: '旧标题' };
const tick: SendAction = { kind: 'toggleTask', key: K, entryId: 'IC_1', index: 0, checked: true, seenSource: '- [ ] a' };

describe('a reply / an edit / a title / a ticked box', () => {
  for (const a of [reply, edit, title])
    it(`${a.kind} refused for sure: 「再发一次」 + 「放回编辑框」, ×, nothing copied`, () => {
      expect(sendActions(send(a, { state: 'refused', reason: 'x' }))).toEqual({ retry: 'resend', fallback: 'toBox', close: true, copy: null, webOpened: false });
    });
  it('refused and already back in its box: × only', () => {
    expect(sendActions(send(reply, { state: 'refused', returned: true }))).toEqual({ retry: null, fallback: null, close: true, copy: null, webOpened: false });
  });
  it('a ticked box refused: 「再发一次」, no box to go back to', () => {
    expect(sendActions(send(tick, { state: 'refused' }))).toMatchObject({ retry: 'resend', fallback: null, close: true });
  });
  for (const a of [reply, edit, title])
    it(`${a.kind} without an answer: 「再查一次」 + check on GitHub copying the text, no ×`, () => {
      expect(sendActions(send(a, { state: 'unknown', sentAt: 1 }))).toMatchObject({ retry: 'recheck', fallback: 'checkWeb', close: false, copy: a.kind === 'editTitle' ? '新标题' : a.kind === 'comment' ? '原文' : '新' });
    });
  it('the page opened: still no ×, the second step shows', () => {
    expect(sendActions(send(reply, { state: 'unknown', webOpened: true }))).toMatchObject({ fallback: 'checkWeb', webOpened: true, close: false });
  });
  it('unlocked: × only, the text still shown until ×', () => {
    expect(sendActions(send(reply, { state: 'unknown', unlocked: true }))).toMatchObject({ retry: null, fallback: null, close: true, copy: '原文' });
  });
  it('while it checks: nothing to press', () => {
    expect(sendActions(send(reply, { state: 'unknown', checking: true }))).toMatchObject({ retry: null, fallback: null, close: false });
  });
});

function job(patch: Partial<CreateJob>): CreateJob {
  return { id: 1, repo: 'o/r', title: 't', status: 'running', message: null, draft: { repo: 'o/r', title: 't', body: 'b', labels: [], projects: [] }, ...patch };
}
describe('a new issue', () => {
  it('failed for sure: 「重试」 the same draft + 「重新打开草稿」, ×', () => {
    expect(createActions(job({ status: 'failed' }))).toEqual({ retry: 'recreate', fallback: 'reopenDraft', close: true });
  });
  it('not sure it was created: 「再查一次」 + the list on GitHub, × — nothing on it creates again', () => {
    for (const j of [job({ status: 'unknown' }), job({ status: 'unknown', candidates: [{ number: 9, url: 'u', createdAt: 'c' }] }), job({ status: 'unknown', lookError: 'x' })]) {
      const a = createActions(j);
      expect(a).toEqual({ retry: 'look', fallback: 'webList', close: true });
      expect(a.retry).not.toBe('recreate');
    }
    expect(createActions(job({ status: 'unknown', looking: true })).retry).toBeNull();
  });
  it('created, not on a board: 「再试加入看板」 + open it, ×', () => {
    expect(createActions(job({ status: 'partial', createdKey: 'o/r#9', number: 9, boards: [{ projectKey: 'p', title: 'P', state: 'missing', reason: 'x' } as any] }))).toEqual({ retry: 'projects', fallback: 'openItem', close: true });
    expect(createActions(job({ status: 'partial', createdKey: 'o/r#9', number: 9, boards: [{ projectKey: 'p', title: 'P', state: 'fieldsFailed', reason: 'x' } as any] }))).toEqual({ retry: null, fallback: 'openItem', close: true });
  });
  it('on its way: nothing', () => {
    expect(createActions(job({ status: 'running' }))).toEqual({ retry: null, fallback: null, close: false });
  });
});
