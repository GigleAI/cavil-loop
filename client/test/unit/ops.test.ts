// GitHub#250: the one judgement of an operation record (shared/ops.ts) — tables A (lock,
// notice, buttons) and E (draft) of the approved plan, row by row. The controller and the
// views only call these functions; test/unit/ops-controller.test.ts runs them for real.

import { describe, expect, it } from 'vitest';
import {
  finishSteps,
  isOpRecord,
  opAfterRestart,
  opApplyRead,
  opAutoDismissable,
  opButtons,
  opCheckSteps,
  opNextAuto,
  opPermit,
  opProveFromSnapshot,
  opResendConfirm,
  opResendStep,
  type OpCheck,
  type OpSnapshot,
  opDisposable,
  opDraftLeft,
  opLockOf,
  opLocked,
  opPhase,
  opProveFromRecords,
  opReusableDraft,
  opProveStep,
  readBoundary,
  opFacts,
  opFullyDone,
  opText,
  opTone,
  opWithoutStale,
  type OpRecord,
  type OpStep,
  type OpStepState,
} from '../../src/shared/ops';

const step = (name: OpStep['name'], state: OpStepState, extra: Partial<OpStep> = {}): OpStep => ({
  name,
  state,
  reason: state === 'refused' ? 'GitHub 不接受' : state === 'unknown' ? '连接中断' : null,
  sentAt: state === 'unsent' ? null : 10,
  answeredAt: state === 'ok' || state === 'refused' || state === 'unknown' ? 20 : null,
  ...extra,
});
function rec(kind: OpRecord['kind'], steps: OpStep[], extra: Partial<OpRecord> = {}): OpRecord {
  const draft = kind === 'closeIssue' ? { reason: 'completed' as const, comment: '做完了' } : kind === 'closePr' ? { comment: '不合了' } : kind === 'merge' ? { method: 'squash' as const, headOid: 'a'.repeat(40) } : {};
  return { id: 'op-1', key: 'o/r#5', repo: 'o/r', number: 5, kind, startedAt: 1, steps, draft, readAt: null, targetSeen: false, unlocked: false, draftDropped: false, dismissed: false, stuck: false, checkProblem: null, ...extra };
}
const close = (a: OpStepState, b: OpStepState, extra: Partial<OpRecord> = {}) => rec('closeIssue', [step('close', a), step('comment', b)], extra);
const auto = (a: OpStepState, b: OpStepState, c: OpStepState, extra: Partial<OpRecord> = {}) =>
  rec('autopilot', [step('addLabel', a, { label: 'autopilot' }), step('addLabel', b, { label: 'pending/agent' }), step('removeLabel', c, { label: 'pending/human' })], extra);

describe('table A: phase / lock', () => {
  const rows: [string, OpRecord, string, boolean][] = [
    ['just created, nothing marked sent yet', close('unsent', 'unsent', { running: true }), 'waiting', true],
    ['a step waits for its answer', close('pending', 'unsent'), 'waiting', true],
    ['first step refused, the rest never sent', close('refused', 'unsent'), 'settled', false],
    ['first step unknown', close('unknown', 'unsent'), 'unknown', true],
    ['first step ok, later step unknown (autopilot: agent label)', auto('ok', 'unknown', 'unsent', { readAt: 30 }), 'unknown', true],
    ['all ok, no re-read yet', close('ok', 'ok'), 'settling', true],
    ['all ok, re-read landed but showing it open', close('ok', 'ok', { readAt: 30 }), 'settling', true],
    ['all ok, re-read showed it closed', close('ok', 'ok', { readAt: 30, targetSeen: true }), 'settled', false],
    ['labels: all ok, any re-read landed (the agent label may already be gone)', auto('ok', 'ok', 'ok', { readAt: 30 }), 'settled', false],
    ['labels: ok, refused, unsent and read', auto('ok', 'refused', 'unsent', { readAt: 30 }), 'settled', false],
    ['unknown unlocked by hand', close('unknown', 'unsent', { unlocked: true }), 'unlocked', false],
  ];
  for (const [name, r, phase, locked] of rows) {
    it(name, () => {
      expect(opPhase(r)).toBe(phase);
      expect(opLocked(r)).toBe(locked);
    });
  }
  it('the lock of an item is any record of it that locks', () => {
    const a = close('refused', 'unsent', { id: 'a' });
    const b = auto('ok', 'unknown', 'unsent', { id: 'b', readAt: 30 });
    expect(opLockOf([a, b], 'o/r#5')?.id).toBe('b');
    expect(opLockOf([a], 'o/r#5')).toBeNull();
    expect(opLockOf([b], 'o/r#6')).toBeNull();
  });
});

describe('table A: notice and buttons', () => {
  it('unknown: the manual unlock — never a one-click re-send, and (GitHub#359) no "check again": the checks run by themselves', () => {
    for (const r of [close('unknown', 'unsent'), auto('ok', 'unknown', 'unsent', { readAt: 30 }), rec('merge', [step('merge', 'unknown')])]) {
      const b = opButtons(r);
      expect(b).toContain('unlock');
      expect(b).not.toContain('resend');
      expect(b).not.toContain('recheck');
      expect(b).not.toContain('retry');
      expect(b).not.toContain('finish');
      expect(b).not.toContain('dismiss');
    }
  });
  it('settling: nothing until it is stuck, then the web page and the unlock', () => {
    expect(opButtons(close('ok', 'ok'))).toEqual([]);
    expect(opButtons(close('ok', 'ok', { stuck: true }))).toEqual(['openWeb', 'unlock']);
  });
  it('while a step is on its way the kept comment is not offered (it may still go out with it)', () => {
    expect(opButtons(close('pending', 'unsent'))).toEqual([]);
    expect(opButtons(close('ok', 'pending'))).toEqual([]);
    expect(opButtons(close('unsent', 'unsent', { running: true }))).toEqual([]);
  });
  it('first step refused: retry, and the kept comment can be copied / put into the reply box', () => {
    expect(opButtons(close('refused', 'unsent'))).toEqual(['retry', 'copy', 'toReply', 'dropDraft', 'dismiss']);
  });
  it('comment refused: no retry of the close; copy and reply box; comment unknown: copy only', () => {
    expect(opButtons(close('ok', 'refused', { readAt: 30, targetSeen: true }))).toEqual(['copy', 'toReply', 'dropDraft', 'dismiss']);
    const unknownComment = opButtons(close('ok', 'unknown', { readAt: 30, targetSeen: true }));
    expect(unknownComment).toContain('copy');
    expect(unknownComment).not.toContain('toReply');
  });
  it('autopilot partly done: finish only once settled', () => {
    expect(opButtons(auto('ok', 'refused', 'unsent', { readAt: 30 }))).toEqual(['finish', 'dismiss']);
    expect(opButtons(auto('ok', 'refused', 'unsent'))).toEqual([]);
  });
  it('every step is named in the notice', () => {
    expect(opText(close('pending', 'unsent'))).toBe('正在关闭 issue #5…');
    expect(opText(close('unsent', 'unsent', { running: true }))).toBe('正在关闭 issue #5…');
    expect(opText(close('refused', 'unsent'))).toBe('没有关闭 issue #5：GitHub 不接受');
    expect(opText(close('unknown', 'unsent'))).toBe('不确定 issue #5 有没有关上（连接中断）');
    expect(opText(close('ok', 'ok', { readAt: 30, targetSeen: true }))).toBe('issue #5 已关闭（已完成），评论已发出');
    expect(opText(close('ok', 'ok'))).toBe('issue #5 已关闭（已完成），评论已发出（正在等 GitHub 的最新状态）');
    expect(opText(close('ok', 'refused', { readAt: 30, targetSeen: true }))).toBe('issue #5 已关闭（已完成），但附的评论没有发出去：GitHub 不接受');
    expect(opText(close('ok', 'unknown', { readAt: 30, targetSeen: true }))).toBe('issue #5 已关闭（已完成），附的评论不确定有没有发出');
    expect(opText(close('ok', 'unsent', { readAt: 30, targetSeen: true }))).toBe('issue #5 已关闭（已完成），附的评论没有发出（关闭的应答丢了，没敢接着发）');
    expect(opText(auto('ok', 'unknown', 'unsent', { readAt: 30 }))).toBe('托管没有全部完成：已加上「autopilot」；「pending/agent」不确定有没有加上；还没摘「pending/human」');
    expect(opText(auto('ok', 'ok', 'ok', { readAt: 30 }))).toBe('已托管：已加上「autopilot」、已加上「pending/agent」、已摘掉「pending/human」');
    expect(opText(close('unknown', 'unsent', { unlocked: true }))).toMatch(/^已由人核对后解除锁定：/);
    expect(opText(rec('merge', [step('merge', 'ok')], { readAt: 30, targetSeen: true }))).toBe('PR #5 已合并');
  });
  it('tone: refused first step is an error; a step not done that nobody is working on is a warning; all done and read back is a success', () => {
    expect(opTone(close('pending', 'unsent'))).toBe('busy');
    expect(opTone(close('refused', 'unsent'))).toBe('error');
    expect(opTone(close('unknown', 'unsent'))).toBe('warn');
    expect(opTone(close('ok', 'refused', { readAt: 30, targetSeen: true }))).toBe('warn');
    expect(opTone(close('ok', 'ok', { readAt: 30, targetSeen: true }))).toBe('ok');
  });
});

describe('GitHub#256: only a fully successful notice puts itself away', () => {
  const done = { readAt: 30, targetSeen: true };
  const closeNoComment = (extra: Partial<OpRecord> = {}) => rec('closeIssue', [step('close', 'ok')], { draft: { reason: 'completed' }, ...done, ...extra });
  const merged = (extra: Partial<OpRecord> = {}) => rec('merge', [step('merge', 'ok')], { ...done, ...extra });
  const handBack = (extra: Partial<OpRecord> = {}) => rec('handBack', [step('addLabel', 'ok', { label: 'pending/agent' }), step('removeLabel', 'ok', { label: 'pending/human' })], { readAt: 30, ...extra });
  const yes: [string, OpRecord][] = [
    ['close an issue with its comment, read back closed', close('ok', 'ok', done)],
    ['close an issue without a comment, read back closed', closeNoComment()],
    ['close a PR, read back closed', rec('closePr', [step('close', 'ok'), step('comment', 'ok')], done)],
    ['merge, read back merged', merged()],
    ['autopilot, every label step done and read', auto('ok', 'ok', 'ok', { readAt: 30 })],
    ['hand back to the agent, every label step done and read', handBack()],
  ];
  for (const [name, r] of yes) it(`yes: ${name}`, () => {
    expect(opTone(r)).toBe('ok');
    expect(opAutoDismissable(r)).toBe(true);
  });
  const no: [string, OpRecord][] = [
    ['still on its way', close('pending', 'unsent')],
    ['created, first request not marked sent', close('unsent', 'unsent', { running: true })],
    ['answer never came', close('unknown', 'unsent')],
    ['waiting for the re-read', close('ok', 'ok')],
    ['re-read still shows it open', close('ok', 'ok', { readAt: 30 })],
    ['stuck waiting for the re-read', close('ok', 'ok', { stuck: true })],
    ['unlocked by hand after the person checked GitHub (all steps ok)', close('ok', 'ok', { stuck: true, unlocked: true })],
    ['unlocked by hand after an unknown step', close('unknown', 'unsent', { unlocked: true })],
    ['main step refused', close('refused', 'unsent')],
    ['comment refused, kept draft', close('ok', 'refused', done)],
    ['label step refused', auto('ok', 'refused', 'unsent', { readAt: 30 })],
    ['merged, but the linked issues could not be re-read', merged({ readProblem: '没读到这个 PR 关联的 issue（连接中断），下一轮同步会更新' })],
    ['evidence read failed (the step is still unknown)', auto('ok', 'unknown', 'unsent', { readAt: 30, checkProblem: '连接中断' })],
    ['a comment draft left (comment step dropped from the record)', rec('closeIssue', [step('close', 'ok')], { draft: { reason: 'completed', comment: '留着' }, ...done })],
    ['a reply from the kept comment on its way', closeNoComment({ replyState: 'sending' })],
    ['a reply from the kept comment unknown', closeNoComment({ replyState: 'unknown' })],
    ['already put away', closeNoComment({ dismissed: true })],
  ];
  for (const [name, r] of no) it(`no: ${name}`, () => expect(opAutoDismissable(r)).toBe(false));
  it('a notice with only × and a re-read problem stays', () => {
    const r = merged({ readProblem: '没读到这个 PR 关联的 issue' });
    expect(opButtons(r)).toEqual(['dismiss']);
    expect(opAutoDismissable(r)).toBe(false);
  });
  // PR #282 code review round 1: a read that settles the record ends "stuck"; one that does not keeps it
  it('a counting read that settles a stuck record clears stuck; a read that leaves it settling keeps it', () => {
    const stuckClose = close('ok', 'ok', { stuck: true });
    const open = opApplyRead(stuckClose, { issuedAt: 40, state: 'open', labels: [] });
    expect(opPhase(open)).toBe('settling');
    expect(open.stuck).toBe(true);
    const shut = opApplyRead(stuckClose, { issuedAt: 40, state: 'closed', labels: [] });
    expect(opPhase(shut)).toBe('settled');
    expect(shut.stuck).toBe(false);
    expect(opAutoDismissable(shut)).toBe(true);
    // too old to count: nothing changes
    expect(opApplyRead(stuckClose, { issuedAt: 1, state: 'closed', labels: [] })).toBe(stuckClose);
  });
  // GitHub#279: every step worked but the re-read did not — a warning, not a success (it used to read "ok")
  const reread: [string, OpRecord][] = [
    ['merged, linked issues not re-read', merged({ readProblem: '没读到这个 PR 关联的 issue' })],
    ['autopilot, the item not re-read', auto('ok', 'ok', 'ok', { readAt: 30, readProblem: '修改已生效，但重读这一条失败（连接中断），下一轮同步会更新' })],
    ['close, the item not re-read (still waiting for a re-read)', close('ok', 'ok', { readProblem: '修改已生效，但重读这一条失败（连接中断），下一轮同步会更新' })],
  ];
  for (const [name, r] of reread)
    it(`GitHub#279 warn: ${name}; the same record without the problem is not a warning`, () => {
      expect(opTone(r)).toBe('warn');
      expect(opTone({ ...r, readProblem: null })).not.toBe('warn');
    });
});

describe('table E: the draft goes only when its own step is done, or by hand', () => {
  const rows: [string, OpRecord, object | null][] = [
    ['close refused, comment never sent', close('refused', 'unsent'), { reason: 'completed', comment: '做完了' }],
    ['close unknown', close('unknown', 'unsent'), { reason: 'completed', comment: '做完了' }],
    ['close proven, comment never sent (settled)', close('ok', 'unsent', { readAt: 30, targetSeen: true }), { comment: '做完了' }],
    ['close ok, comment refused', close('ok', 'refused', { readAt: 30, targetSeen: true }), { comment: '做完了' }],
    ['close ok, comment unknown', close('ok', 'unknown'), { comment: '做完了' }],
    ['both done', close('ok', 'ok', { readAt: 30, targetSeen: true }), null],
    ['unlocked by hand: unlocking does not drop it', close('unknown', 'unsent', { unlocked: true }), { reason: 'completed', comment: '做完了' }],
    ['dropped by hand', close('refused', 'unsent', { draftDropped: true }), null],
    ['merge refused', rec('merge', [step('merge', 'refused')]), { method: 'squash', headOid: 'a'.repeat(40) }],
    ['merge done', rec('merge', [step('merge', 'ok')]), null],
  ];
  for (const [name, r, left] of rows) it(name, () => expect(opDraftLeft(r)).toEqual(left));
  it('a record is forgotten only when settled, put away and with nothing kept', () => {
    expect(opDisposable(close('refused', 'unsent', { dismissed: true }))).toBe(false);
    expect(opDisposable(close('refused', 'unsent', { dismissed: true, draftDropped: true }))).toBe(true);
    expect(opDisposable(close('ok', 'ok', { dismissed: true }))).toBe(false); // still settling
    expect(opDisposable(close('ok', 'ok', { dismissed: true, readAt: 30, targetSeen: true }))).toBe(true);
  });
});

describe('reads never turn "unknown" into "did not happen"', () => {
  it('a read issued before the last answer does not count', () => {
    const r = close('ok', 'ok');
    expect(opApplyRead(r, { issuedAt: 20, state: 'closed', labels: [] })).toBe(r);
    expect(opApplyRead(r, { issuedAt: 21, state: 'closed', labels: [] })).toMatchObject({ readAt: 21, targetSeen: true });
  });
  it('an unknown close read back open stays unknown; read back closed is proven', () => {
    const r = close('unknown', 'unsent');
    const open = opApplyRead(r, { issuedAt: 30, state: 'open', labels: [] });
    expect(open.steps.map((s) => s.state)).toEqual(['unknown', 'unsent']);
    expect(opPhase(open)).toBe('unknown');
    const closed = opApplyRead(open, { issuedAt: 40, state: 'closed', labels: [] });
    expect(closed.steps.map((s) => s.state)).toEqual(['ok', 'unsent']);
    expect(opPhase(closed)).toBe('settled');
  });
  it('an unknown "agent" label is never denied by the labels on the item (the daemon takes it away); GitHub#359: the label being on is the wanted state — done', () => {
    const r = auto('ok', 'unknown', 'unsent');
    for (const labels of [[], ['doing/agent']]) {
      const x = opApplyRead(r, { issuedAt: 30, state: 'open', labels });
      expect(x.steps[1].state).toBe('unknown');
      expect(opPhase(x)).toBe('unknown');
    }
    const on = opApplyRead(r, { issuedAt: 30, state: 'open', labels: ['pending/agent'] });
    expect(on.steps[1]).toMatchObject({ state: 'ok', reason: '重读时这个标签已在' });
    // a read issued before the request says nothing
    expect(opApplyRead(r, { issuedAt: 5, state: 'open', labels: ['pending/agent'] }).steps[1].state).toBe('unknown');
  });
  it('an unknown label removal is proven by the label being gone, never denied by it being there', () => {
    const r = rec('handBack', [step('addLabel', 'ok', { label: 'pending/agent' }), step('removeLabel', 'unknown', { label: 'pending/human' })]);
    expect(opApplyRead(r, { issuedAt: 30, state: 'open', labels: ['pending/human'] }).steps[1].state).toBe('unknown');
    expect(opApplyRead(r, { issuedAt: 30, state: 'open', labels: [] }).steps[1].state).toBe('ok');
  });
  it('evidence proves only an unknown step', () => {
    const r = auto('ok', 'unknown', 'unsent');
    expect(opProveStep(r, 1, 'x').steps[1].state).toBe('ok');
    expect(opProveStep(r, 2, 'x')).toBe(r);
  });
});

describe('finish: only refused / never-sent label steps, never one that worked or whose answer never came', () => {
  it('agent refused: add it and take the human label off; what is already right is skipped', () => {
    const r = auto('ok', 'refused', 'unsent', { readAt: 30 });
    expect(finishSteps(r).map((s) => [s.name, s.label])).toEqual([
      ['addLabel', 'pending/agent'],
      ['removeLabel', 'pending/human'],
    ]);
    expect(finishSteps(r, ['pending/agent', 'pending/human']).map((s) => s.label)).toEqual(['pending/human']);
    expect(finishSteps(r, ['autopilot'])).toHaveLength(1);
  });
  it('agent proven after an unknown (the daemon took it): only the human label', () => {
    const r = auto('ok', 'ok', 'unsent', { readAt: 30 });
    expect(finishSteps(r, ['pending/human', 'doing/agent']).map((s) => s.label)).toEqual(['pending/human']);
  });
  it('nothing while locked, nothing for close / merge', () => {
    expect(finishSteps(auto('ok', 'unknown', 'unsent', { readAt: 30 }))).toEqual([]);
    expect(finishSteps(close('ok', 'refused', { readAt: 30, targetSeen: true }))).toEqual([]);
  });
});

describe('restart and stored shape', () => {
  it('a request waiting when the app stopped is unknown afterwards; running is not kept', () => {
    const r = opAfterRestart(close('pending', 'unsent', { running: true }));
    expect(r.steps.map((s) => s.state)).toEqual(['unknown', 'unsent']);
    expect(r.running).toBe(false);
    expect(opPhase(r)).toBe('unknown');
  });
  it('a stored row must be a whole record', () => {
    expect(isOpRecord(close('ok', 'ok'))).toBe(true);
    expect(isOpRecord({ ...close('ok', 'ok'), kind: 'comment' })).toBe(false);
    expect(isOpRecord({ ...close('ok', 'ok'), steps: [] })).toBe(false);
    expect(isOpRecord({ ...close('ok', 'ok'), steps: [{ name: 'close', state: 'maybe' }] })).toBe(false);
  });
});

describe('code review round 1: evidence newer than the request; restart boundary', () => {
  const recs = (comments: [string, string, string][], events: [string, 'labeled' | 'unlabeled', string, string][]) => ({
    comments: comments.map(([id, author, body]) => ({ id, author, body })),
    labelEvents: events.map(([id, event, actor, label]) => ({ id, event, actor, label })),
  });
  it('an old comment / event that was there before the request proves nothing; a new one does', () => {
    const r = close('ok', 'unknown', { before: { comments: ['c1'], events: [] } });
    expect(opProveFromRecords(r, recs([['c1', 'me', '做完了']], []), 'me').record.steps[1].state).toBe('unknown');
    expect(opProveFromRecords(r, recs([['c1', 'me', '做完了'], ['c2', 'other', '做完了'], ['c3', 'me', '别的']], []), 'me').record.steps[1].state).toBe('unknown');
    expect(opProveFromRecords(r, recs([['c1', 'me', '做完了'], ['c2', 'me', '做完了']], []), 'me').record.steps[1].state).toBe('ok');
    const a = auto('ok', 'unknown', 'unsent', { before: { comments: [], events: ['e1'] } });
    expect(opProveFromRecords(a, recs([], [['e1', 'labeled', 'me', 'pending/agent']]), 'me').record.steps[1].state).toBe('unknown');
    expect(opProveFromRecords(a, recs([], [['e1', 'labeled', 'me', 'pending/agent'], ['e2', 'unlabeled', 'me', 'pending/agent']]), 'me').record.steps[1].state).toBe('unknown');
    expect(opProveFromRecords(a, recs([], [['e2', 'labeled', 'bot', 'pending/agent']]), 'me').record.steps[1].state).toBe('unknown');
    expect(opProveFromRecords(a, recs([], [['e1', 'labeled', 'me', 'pending/agent'], ['e2', 'labeled', 'me', 'pending/agent']]), 'me').record.steps[1].state).toBe('ok');
  });
  it('no list of what was there before (the read failed, or an old record): never proven, and said so', () => {
    for (const before of [null, undefined]) {
      const out = opProveFromRecords(close('ok', 'unknown', { before }), recs([['c9', 'me', '做完了']], []), 'me');
      expect(out.record.steps[1].state).toBe('unknown');
      expect(out.missing[0]).toContain('发送前没读到');
    }
  });
  it('a step whose answer never came (restart): reads count once issued after its sending, never before', () => {
    const r = opAfterRestart(close('pending', 'unsent', { running: true }));
    expect(r.steps[0].answeredAt).toBeNull();
    expect(readBoundary(r)).toBe(10);
    expect(opApplyRead(r, { issuedAt: 10, state: 'closed', labels: [] })).toBe(r);
    const x = opApplyRead(r, { issuedAt: 11, state: 'closed', labels: [] });
    expect(x.steps.map((s) => s.state)).toEqual(['ok', 'unsent']);
    expect(x.steps[0].answeredAt).toBeNull();
    expect(opPhase(x)).toBe('settled');
    expect(opDraftLeft(x)).toEqual({ comment: '做完了' });
  });
});

describe('code review round 2: a reply made from the kept comment', () => {
  const base = () => close('refused', 'unsent');
  it('on its way: waiting; no answer: unknown — locked either way, no retry, no reply box, copy only', () => {
    expect(opPhase({ ...base(), replyState: 'sending' })).toBe('waiting');
    const u = { ...base(), replyState: 'unknown' as const, reply: { body: '做完了', before: [] } };
    expect(opPhase(u)).toBe('unknown');
    expect(opLocked(u)).toBe(true);
    expect(opButtons(u)).toEqual(['unlock', 'copy', 'dropDraft']);
  });
  it('the dialog of a retry never gets that comment back; unlocked by hand neither', () => {
    const u = { ...base(), replyState: 'unknown' as const };
    expect(opDraftLeft(u)).toEqual({ reason: 'completed', comment: '做完了' });
    expect(opReusableDraft(u)).toEqual({ reason: 'completed' });
    expect(opReusableDraft({ ...u, unlocked: true })).toEqual({ reason: 'completed' });
    expect(opReusableDraft(base())).toEqual({ reason: 'completed', comment: '做完了' });
  });
  it('proven only by a comment that was not there before the reply; that ends the draft comment', () => {
    const u = { ...base(), replyState: 'unknown' as const, reply: { body: '做完了', before: ['c1'] } };
    const recs = (ids: [string, string][]) => ({ comments: ids.map(([id, author]) => ({ id, author, body: '做完了' })), labelEvents: [] });
    expect(opProveFromRecords(u, recs([['c1', 'me']]), 'me').record.replyState).toBe('unknown');
    const ok = opProveFromRecords(u, recs([['c1', 'me'], ['c2', 'me']]), 'me').record;
    expect(ok.replyState).toBeNull();
    expect(opDraftLeft(ok)).toEqual({ reason: 'completed' });
    expect(opProveFromRecords({ ...u, reply: { body: '做完了', before: null } }, recs([['c2', 'me']]), 'me').record.replyState).toBe('unknown');
  });
});

// GitHub#296: a successful autopilot notice stayed on the board for hours: an evidence read that
// could not be done ("这次没能查证：…") was kept after a later read proved the step, the notice no
// longer said it, yet it still kept the notice from putting itself away.
describe('GitHub#296: a check problem only stands while a step is unknown', () => {
  const unknownRemoval = () => auto('ok', 'ok', 'unknown', { readAt: 30, checkProblem: '读评论和标签记录失败（连接中断）' });

  it('the record of the issue: proven by a later read, it reads as a plain success — and now goes', () => {
    const before = unknownRemoval();
    expect(opPhase(before)).toBe('unknown');
    expect(opText(before)).toContain('这次没能查证');
    const read = opApplyRead(before, { issuedAt: 40, state: 'open', labels: ['autopilot'] });
    expect(opPhase(read)).toBe('settled');
    expect(opTone(read)).toBe('ok');
    expect(opButtons(read)).toEqual(['dismiss']);
    expect(opText(read)).toBe('已托管：已加上「autopilot」、已加上「pending/agent」、已摘掉「pending/human」');
    expect(opAutoDismissable(read)).toBe(true);
    expect(opWithoutStale(read).checkProblem).toBeNull();
  });

  it('kept while a step is still unknown (the notice says it); dropped once settled, proven by records or unlocked by hand', () => {
    const still = unknownRemoval();
    expect(opWithoutStale(still)).toBe(still);
    const proven = opProveStep(still, 2, '标签记录里有这次摘掉的记录');
    expect(opPhase(proven)).toBe('settled');
    expect(opWithoutStale(proven).checkProblem).toBeNull();
    const unlocked = { ...still, unlocked: true };
    expect(opWithoutStale(unlocked).checkProblem).toBeNull();
    // nothing to drop: the same object
    const clean = auto('ok', 'ok', 'ok', { readAt: 30 });
    expect(opWithoutStale(clean)).toBe(clean);
  });

  it('unlocked by hand still never goes by itself, whatever it reads like', () => {
    const r = opWithoutStale({ ...auto('ok', 'ok', 'ok', { readAt: 30 }), unlocked: true });
    expect(opAutoDismissable(r)).toBe(false);
    const s = opWithoutStale(close('ok', 'ok', { stuck: true, unlocked: true }));
    expect(opAutoDismissable(s)).toBe(false);
  });

  // Every settled record not unlocked and not put away: it goes by itself exactly when its notice
  // reads as a plain success — the success tone (no re-read problem), only the ×, no draft left. A
  // field that keeps a notice on screen without the notice showing it turns this red.
  it('settled, not unlocked, not put away: goes by itself ⇔ reads as a plain success', () => {
    const states: OpStepState[] = ['unsent', 'pending', 'ok', 'refused', 'unknown'];
    const kinds: [OpRecord['kind'], OpStep[][]][] = [];
    const combos = (n: number): OpStepState[][] => (n === 0 ? [[]] : combos(n - 1).flatMap((c) => states.map((x) => [...c, x])));
    kinds.push(['closeIssue', combos(2).map(([a, b]) => [step('close', a), step('comment', b)])]);
    kinds.push(['closeIssue', combos(1).map(([a]) => [step('close', a)])]);
    kinds.push(['closePr', combos(2).map(([a, b]) => [step('close', a), step('comment', b)])]);
    kinds.push(['merge', combos(1).map(([a]) => [step('merge', a)])]);
    kinds.push(['autopilot', combos(3).map(([a, b, c]) => [step('addLabel', a, { label: 'autopilot' }), step('addLabel', b, { label: 'pending/agent' }), step('removeLabel', c, { label: 'pending/human' })])]);
    kinds.push(['handBack', combos(2).map(([a, b]) => [step('addLabel', a, { label: 'pending/agent' }), step('removeLabel', b, { label: 'pending/human' })])]);
    const extras: Partial<OpRecord>[] = [];
    for (const readAt of [null, 30])
      for (const targetSeen of [false, true])
        for (const readProblem of [null, '重读这一条失败（连接中断）'])
          for (const checkProblem of [null, '连接中断'])
            for (const stuck of [false, true])
              for (const draftDropped of [false, true])
                for (const commentUsed of [false, true]) extras.push({ readAt, targetSeen, readProblem, checkProblem, stuck, draftDropped, commentUsed });
    let checked = 0;
    let goes = 0;
    for (const [kind, stepSets] of kinds)
      for (const steps of stepSets)
        for (const extra of extras) {
          // what the controller keeps (its one setOp)
          const r = opWithoutStale(rec(kind, steps, extra));
          if (opPhase(r) !== 'settled' || r.unlocked || r.dismissed) continue;
          checked++;
          const plain = opTone(r) === 'ok' && opButtons(r).join() === 'dismiss' && opDraftLeft(r) === null;
          if (opAutoDismissable(r) !== plain) throw new Error(`${kind} ${JSON.stringify(steps.map((x) => x.state))} ${JSON.stringify(extra)}: goes by itself ${opAutoDismissable(r)}, reads as a plain success ${plain} — ${opText(r)}`);
          if (plain) goes++;
        }
    expect(checked).toBeGreaterThan(1000);
    expect(goes).toBeGreaterThan(0);
  });
});

// GitHub#357: the colour follows what is going on with the record (shared/noticeTone.ts), one row
// per state of the approved table. `was` = the colour before the change, for the rows that keep it.
describe('GitHub#357: the colour of an operation notice, state by state', () => {
  const done = { readAt: 30, targetSeen: true };
  const partial = (extra: Partial<OpRecord> = {}) => auto('ok', 'refused', 'unsent', { readAt: 30, ...extra });
  const rows: [string, OpRecord, string][] = [
    ['a request on its way', close('pending', 'unsent'), 'busy'],
    ['created, its first request not marked sent', close('unsent', 'unsent', { running: true }), 'busy'],
    ['a reply from the kept comment on its way', close('refused', 'unsent', { replyState: 'sending' }), 'busy'],
    ['succeeded, waiting for the re-read', close('ok', 'ok'), 'busy'],
    ['succeeded, the re-read still shows it open', close('ok', 'ok', { readAt: 30 }), 'busy'],
    ['answer lost, an evidence read running', close('unknown', 'unsent', { checking: true }), 'busy'],
    ['answer lost, a second evidence read running (the first one\'s failure is not shown with it)', close('unknown', 'unsent', { checking: true, checkProblem: '连接中断' }), 'busy'],
    ['"补做" being prepared', partial({ finishing: true }), 'busy'],
    ['"补做" being prepared again after a failed one', partial({ finishing: true, finishProblem: '重读这一条失败' }), 'busy'],
    ['every step done and read back', close('ok', 'ok', done), 'ok'],
    ['labels: every step done and read', auto('ok', 'ok', 'ok', { readAt: 30 }), 'ok'],
    ['main step refused', close('refused', 'unsent'), 'error'],
    ['main step never sent', rec('merge', [step('merge', 'unsent')]), 'error'],
    ['"补做" did nothing', partial({ finishProblem: '重读这一条失败，什么都没发' }), 'error'],
    ['succeeded, the re-read failed (the next round reads again)', auto('ok', 'ok', 'ok', { readAt: 30, readProblem: '重读这一条失败' }), 'warn'],
    ['succeeded, the re-read failed while still waiting for one', close('ok', 'ok', { readProblem: '重读这一条失败' }), 'warn'],
    ['succeeded, waited too long for the re-read', close('ok', 'ok', { stuck: true }), 'warn'],
    ['answer lost, never checked (after a restart)', close('unknown', 'unsent'), 'warn'],
    // GitHub#359: a check that could not read is tried again with every sync round — the app keeps at it: yellow, not red
    ['answer lost, the evidence read ended without an answer', close('unknown', 'unsent', { checkProblem: '读评论和标签记录失败（连接中断）' }), 'warn'],
    ['a later step unknown, the evidence read failed', auto('ok', 'unknown', 'unsent', { readAt: 30, checkProblem: '连接中断' }), 'warn'],
    ['a label step read in full and not found (still not sure)', rec('autopilot', [step('addLabel', 'unknown', { label: 'autopilot', check: 'unseen' }), step('addLabel', 'unsent', { label: 'pending/agent' }), step('removeLabel', 'unsent', { label: 'pending/human' })]), 'warn'],
    ['partly done, nobody tried to finish it', partial(), 'warn'],
    ['comment refused, the close done', close('ok', 'refused', done), 'warn'],
    ['unlocked by hand, a step unknown', close('unknown', 'unsent', { unlocked: true }), 'warn'],
    ['unlocked by hand, every step done', close('ok', 'ok', { stuck: true, unlocked: true }), 'info'],
    ['every step done, a comment draft still kept (it never goes by itself)', rec('closeIssue', [step('close', 'ok')], { draft: { reason: 'completed', comment: '留着' }, ...done }), 'info'],
  ];
  for (const [name, r0, tone] of rows)
    it(`${tone}: ${name}`, () => {
      // what the controller keeps (its one setOp)
      const r = opWithoutStale(r0);
      expect(opTone(r)).toBe(tone);
    });

  it('a missing answer is never a failure — nor (GitHub#359) a check that could not read: both are checked again by every sync round', () => {
    const lost = close('unknown', 'unsent');
    expect(opFacts(lost).failed).toBe(false);
    expect(opFacts(lost).retrying).toBe(true);
    expect(opFacts({ ...lost, checkProblem: '连接中断' }).failed).toBe(false);
    expect(opFacts({ ...lost, checkProblem: '连接中断' }).retrying).toBe(true);
    // while the app's own checks run it is that, not a retry in the background
    expect(opFacts({ ...lost, checking: true })).toMatchObject({ busy: true, retrying: false });
    // out of the unknown phase the problem no longer stands (GitHub#296): not red because of it
    const proven = opWithoutStale(auto('ok', 'ok', 'ok', { readAt: 30, checkProblem: '连接中断' }));
    expect(opTone(proven)).toBe('ok');
  });

  it('running and the failure before it are never said together; the notice says which one', () => {
    const failed = close('unknown', 'unsent', { checkProblem: '连接中断' });
    expect(opText(failed)).toContain('；这次没能查证：连接中断');
    expect(opText(failed)).not.toContain('正在查证');
    const again = { ...failed, checking: true };
    expect(opText(again)).toContain('；正在查证…');
    expect(opText(again)).not.toContain('这次没能查证');
    const partialFailed = partial({ finishProblem: '离线' });
    expect(opText(partialFailed)).toContain('；这次没能补做：离线');
    const finishing = partial({ finishing: true, finishProblem: '离线' });
    expect(opText(finishing)).toContain('；正在补做…');
    expect(opText(finishing)).not.toContain('这次没能补做');
  });

  it('while a read / a "补做" runs its button is not offered a second time; a finishing notice is not put away', () => {
    // GitHub#359: while the app's own checks run nothing is offered at all (the kept comment can still be copied);
    // after them the unlock by hand — the checks go on by themselves, there is no button for one
    expect(opButtons(close('unknown', 'unsent', { checking: true }))).toEqual(['copy', 'toReply', 'dropDraft']);
    expect(opButtons(close('unknown', 'unsent'))).toEqual(['unlock', 'copy', 'toReply', 'dropDraft']);
    expect(opButtons(partial({ finishing: true }))).toEqual([]);
    expect(opButtons(partial({ finishProblem: '离线' }))).toEqual(['finish', 'dismiss']);
  });

  it('"这次没能补做" only stands while something can still be finished', () => {
    expect(opWithoutStale(partial({ finishProblem: '离线' })).finishProblem).toBe('离线');
    expect(opWithoutStale(auto('ok', 'ok', 'ok', { readAt: 30, finishProblem: '离线' })).finishProblem).toBeNull();
    expect(opWithoutStale(partial({ finishing: true, finishProblem: '离线' })).finishProblem).toBe('离线');
  });

  it('what was running when the app stopped is not running after the restart', () => {
    const r = opAfterRestart(close('unknown', 'unsent', { checking: true, finishing: true }));
    expect(r.checking).toBe(false);
    expect(r.finishing).toBe(false);
    expect(opTone(r)).toBe('warn');
  });

  // green never stays, and nothing else goes by itself: over every combination of step results and marks
  it('green ⇔ the notice puts itself away, on every record', () => {
    const states: OpStepState[] = ['unsent', 'pending', 'ok', 'refused', 'unknown'];
    const recs: OpRecord[] = [];
    const marks: Partial<OpRecord>[] = [];
    for (const readAt of [null, 30])
      for (const targetSeen of [false, true])
        for (const readProblem of [null, '重读失败'])
          for (const checkProblem of [null, '连接中断'])
            for (const stuck of [false, true])
              for (const unlocked of [false, true])
                for (const flags of [{}, { checking: true }, { finishing: true }, { finishProblem: '离线' }, { running: true }, { replyState: 'sending' as const }, { replyState: 'unknown' as const }, { draftDropped: true }])
                  marks.push({ readAt, targetSeen, readProblem, checkProblem, stuck, unlocked, ...flags });
    for (const a of states)
      for (const b of states)
        for (const m of marks) {
          recs.push(close(a, b, m));
          recs.push(rec('merge', [step('merge', a)], m));
          recs.push(rec('handBack', [step('addLabel', a, { label: 'pending/agent' }), step('removeLabel', b, { label: 'pending/human' })], m));
        }
    let green = 0;
    for (const r0 of recs) {
      const r = opWithoutStale(r0);
      const isGreen = opTone(r) === 'ok';
      if (isGreen !== opAutoDismissable(r) || isGreen !== opFullyDone(r)) throw new Error(`${r.kind} ${JSON.stringify(r.steps.map((x) => x.state))}: tone ${opTone(r)}, goes by itself ${opAutoDismissable(r)} — ${opText(r)}`);
      if (isGreen) green++;
    }
    expect(recs.length).toBeGreaterThan(10_000);
    expect(green).toBeGreaterThan(0);
    // put away by hand: no longer counted down, whatever it was
    expect(opAutoDismissable(close('ok', 'ok', { ...done, dismissed: true }))).toBe(false);
  });
});

// GitHub#359: one check verdict, one permit, and the notice / buttons / lock / dialog all read the same record.
describe('GitHub#359: the check of an unknown label step never says "it did not happen"', () => {
  const role = { autopilot: 'autopilot', 'pending/agent': 'agent', 'pending/human': 'human' } as const;
  const withRoles = (r: OpRecord): OpRecord => ({ ...r, steps: r.steps.map((s) => (s.label ? { ...s, role: role[s.label as keyof typeof role] } : s)) });
  const before = { comments: [], events: ['e0'], labels: ['pending/human'] };
  const ev = (id: string, event: 'labeled' | 'unlabeled', label: string, actor = 'me') => ({ id, event, actor, label });
  const old = ev('e0', 'labeled', 'pending/human', 'bot');
  const snap = (labels: string[], events = [old], extra: Partial<OpSnapshot> = {}): OpSnapshot => ({ complete: true, state: 'open', labels, events, ...extra });
  const unknown = (extra: Partial<OpRecord> = {}) => withRoles(auto('unknown', 'unsent', 'unsent', { before, checks: 1, ...extra }));
  const proven = (extra: Partial<OpRecord> = {}) => withRoles(auto('ok', 'unsent', 'unsent', { before, auto: true, readAt: 30, ...extra }));

  describe('the four verdicts', () => {
    const cases: [string, OpSnapshot | null, Partial<OpRecord>, string][] = [
      ['the read failed', null, {}, 'unread'],
      ['the label records were not read back to the start', snap(['pending/human'], [old], { complete: false }), {}, 'unread'],
      ['nothing from before the first request', snap(['pending/human']), { before: null }, 'unread'],
      ['a record from an older version: no labels from before', snap(['pending/human']), { before: { comments: [], events: ['e0'] } }, 'unread'],
      ['the new records do not add up to the labels read', snap(['pending/human', 'x']), {}, 'unread'],
      ['read in full: the label is not on, nobody touched it', snap(['pending/human']), {}, 'unseen'],
      ['read in full: other labels came and went, this one untouched', snap(['pending/human'], [old, ev('e1', 'labeled', 'x', 'bot'), ev('e2', 'unlabeled', 'x', 'bot')]), {}, 'unseen'],
      ['read in full: somebody else put it on and took it off', snap(['pending/human'], [old, ev('e1', 'labeled', 'autopilot', 'bot'), ev('e2', 'unlabeled', 'autopilot', 'bot')]), {}, 'touched'],
    ];
    for (const [name, s, extra, want] of cases)
      it(name, () => {
        const r = opCheckSteps(unknown(extra), s);
        expect(r.steps[0].check).toBe(want);
        // whatever the verdict: still unknown, still locked
        expect(r.steps[0].state).toBe('unknown');
        expect(opLocked(r)).toBe(true);
        // and never a sentence saying it was not added
        expect(opText(r).replace(/不确定有没有加上/g, '')).not.toContain('没有加上');
      });
    it('the wanted state there is positive evidence (the step is done), not a verdict', () => {
      const r = opProveFromSnapshot(unknown(), snap(['pending/human', 'autopilot'], [old, ev('e1', 'labeled', 'autopilot')]));
      expect(r.steps[0]).toMatchObject({ state: 'ok', reason: '重读时这个标签已在' });
    });
  });

  it('one record, four readers: the notice, the buttons, the lock and the dialog agree for every verdict', () => {
    const base = unknown();
    const rows: [OpCheck | undefined, string, string[], boolean][] = [
      [undefined, '「autopilot」不确定有没有加上；还没加', ['unlock'], false],
      ['unread', '「autopilot」不确定有没有加上；还没加', ['unlock'], false],
      ['unseen', '到现在还没查到；原来那次请求仍可能稍后生效', ['resend', 'unlock'], true],
      ['touched', '这期间这个标签被人动过', ['unlock'], false],
    ];
    for (const [check, text, buttons, dialog] of rows) {
      const r: OpRecord = { ...base, steps: base.steps.map((s, i) => (i === 0 && check ? { ...s, check } : s)) };
      expect(opText(r)).toContain(text);
      expect(opButtons(r)).toEqual(buttons);
      expect(opLocked(r)).toBe(true);
      expect(opResendConfirm(r) !== null).toBe(dialog);
      expect(opResendStep(r)).toBe(dialog ? 0 : -1);
    }
    // while the checks still run: busy, nothing to choose, no dialog — and still locked
    const busy: OpRecord = { ...base, checking: true, steps: base.steps.map((s, i) => (i === 0 ? { ...s, check: 'unseen' as const } : s)) };
    expect(opTone(busy)).toBe('busy');
    expect(opButtons(busy)).toEqual([]);
    expect(opResendConfirm(busy)).toBeNull();
    expect(opLocked(busy)).toBe(true);
    expect(opText(busy)).toBe('正在托管…「autopilot」发出后没有收到 GitHub 的应答，正在自动核对有没有加上（第 2 次）');
  });

  it('the dialog says what a second send of each label can cause', () => {
    const one = (r: OpRecord) => opResendConfirm({ ...r, steps: r.steps.map((s) => (s.state === 'unknown' ? { ...s, check: 'unseen' as const } : s)) })!;
    const a = one(unknown());
    expect(a.title).toBe('再发一次「加上 autopilot」？');
    expect(a.lines[0]).toContain('仍可能稍后生效');
    expect(a.lines[1]).toContain('托管被恢复');
    expect(a.lines[2]).toContain('就不发');
    expect(a.after).toBe('发出后会接着加「pending/agent」、摘「pending/human」。');
    const b = one(withRoles(auto('ok', 'unknown', 'unsent', { before })));
    expect(b.lines[1]).toContain('派两次工');
    const c = one(withRoles(auto('ok', 'ok', 'unknown', { before })));
    expect(c.title).toBe('再发一次「摘掉 pending/human」？');
    expect(c.lines[1]).toContain('可能被当成待派工');
    expect(c.after).toBeNull();
    // not a label step, or more than one thing unknown: nothing to send again
    expect(opResendConfirm(close('unknown', 'unsent'))).toBeNull();
    expect(opResendConfirm({ ...unknown(), replyState: 'unknown' })).toBeNull();
  });

  describe('the permit of a send nobody clicked right now', () => {
    const now = 100;
    const ok = snap(['pending/human', 'autopilot'], [old, ev('e1', 'labeled', 'autopilot')]);
    it('everything holds: allowed', () => {
      expect(opPermit(proven(), 1, ok, { mode: 'auto', now })).toEqual({ ok: true });
    });
    const no: [string, OpRecord, OpSnapshot | null, string, string][] = [
      ['not read', proven(), null, 'unread', '没能完整读到'],
      ['not read in full', proven(), { ...ok, complete: false }, 'unread', '没能完整读到'],
      ['closed', proven(), { ...ok, state: 'closed' }, 'halt', '这一条已经关闭'],
      ['merged', proven(), { ...ok, state: 'merged' }, 'halt', '这一条已经关闭'],
      ['a step done no longer stands (same account took the label off)', proven(), snap(['pending/human'], [old, ev('e1', 'labeled', 'autopilot'), ev('e2', 'unlabeled', 'autopilot')]), 'halt', '这期间「autopilot」被摘掉了'],
      ['the label still stands but was taken off and put on again in between', proven(), snap(['pending/human', 'autopilot'], [old, ev('e1', 'labeled', 'autopilot'), ev('e2', 'unlabeled', 'autopilot'), ev('e3', 'labeled', 'autopilot')]), 'halt', '这期间「autopilot」被人动过'],
      ['the label of the step itself has a record already', proven(), snap(['pending/human', 'autopilot'], [old, ev('e1', 'labeled', 'autopilot'), ev('e2', 'labeled', 'pending/agent', 'bot'), ev('e3', 'unlabeled', 'pending/agent', 'bot')]), 'halt', '这期间「pending/agent」被人动过'],
      ['"pending/human" was put on again (handed back to a person)', proven(), snap(['pending/human', 'autopilot'], [old, ev('e1', 'labeled', 'autopilot'), ev('e2', 'unlabeled', 'pending/human'), ev('e3', 'labeled', 'pending/human')]), 'halt', '这期间「pending/human」被人动过'],
      ['the wanted state is there already', proven(), snap(['pending/human', 'autopilot', 'pending/agent'], [old, ev('e1', 'labeled', 'autopilot'), ev('e2', 'labeled', 'pending/agent')]), 'halt', '被人动过'],
      ['after a restart', proven({ auto: false }), ok, 'halt', '客户端重启过'],
      ['past the time limit', proven({ startedAt: 1 }), ok, 'halt', '超过 10 分钟'],
    ];
    for (const [name, r, s, why, text] of no)
      it(`${name}: not allowed`, () => {
        const p = opPermit(r, 1, s, { mode: 'auto', now: name === 'past the time limit' ? 1 + 600_001 : now });
        expect(p.ok).toBe(false);
        if (!p.ok) {
          expect(p.why).toBe(why);
          expect(p.text).toContain(text);
        }
      });
    it('the label was on before the operation started and nothing was recorded: done without a send', () => {
      const r = withRoles(auto('ok', 'unsent', 'unsent', { before: { comments: [], events: ['e0'], labels: ['pending/human', 'pending/agent'] }, auto: true }));
      const p = opPermit(r, 1, snap(['pending/human', 'pending/agent', 'autopilot'], [old, ev('e1', 'labeled', 'autopilot')]), { mode: 'auto', now });
      expect(p).toMatchObject({ ok: false, why: 'satisfied' });
    });
    it('a second send a person confirmed: no time limit and no "same run", everything else the same', () => {
      const r = unknown({ auto: false, startedAt: 1 });
      expect(opPermit(r, 0, snap(['pending/human']), { mode: 'resend', now: 9_999_999 })).toEqual({ ok: true });
      expect(opPermit(r, 0, snap(['pending/human'], [old], { state: 'closed' }), { mode: 'resend', now }).ok).toBe(false);
      expect(opPermit(r, 0, snap(['pending/human'], [old, ev('e1', 'labeled', 'autopilot', 'bot'), ev('e2', 'unlabeled', 'autopilot', 'bot')]), { mode: 'resend', now }).ok).toBe(false);
      expect(opPermit(r, 0, null, { mode: 'resend', now })).toMatchObject({ ok: false, why: 'unread' });
    });
    it('which label was undone decides the way on: the autopilot label = start over; the agent label taken (the daemon, or a person) = finish by hand', () => {
      const a = opPermit(proven(), 1, snap(['pending/human'], [old, ev('e1', 'labeled', 'autopilot'), ev('e2', 'unlabeled', 'autopilot')]), { mode: 'auto', now });
      expect(a).toMatchObject({ ok: false, redo: true });
      const r = withRoles(auto('ok', 'ok', 'unsent', { before, auto: true }));
      const b = opPermit(r, 2, snap(['pending/human', 'autopilot', 'doing/agent'], [old, ev('e1', 'labeled', 'autopilot'), ev('e2', 'labeled', 'pending/agent'), ev('e3', 'unlabeled', 'pending/agent', 'bot'), ev('e4', 'labeled', 'doing/agent', 'bot')]), { mode: 'auto', now });
      expect(b).toMatchObject({ ok: false, why: 'halt', redo: false });
      const halted: OpRecord = { ...r, auto: false, readAt: 30, halt: { text: '这期间「pending/agent」被摘掉了', redo: false } };
      expect(opButtons(halted)).toContain('finish');
      expect(opButtons({ ...proven(), auto: false, halt: { text: '这期间「autopilot」被摘掉了', redo: true } })).toContain('retry');
      expect(opText(halted)).toContain('这期间「pending/agent」被摘掉了，没有接着往下做');
    });
  });

  it('what goes on by itself: only steps never sent, after steps all done, in the run that may', () => {
    expect(opNextAuto(proven())).toBe(1);
    expect(opNextAuto(proven({ auto: false }))).toBe(-1);
    expect(opNextAuto(proven({ halt: { text: 'x', redo: false } }))).toBe(-1);
    expect(opNextAuto(proven({ unlocked: true }))).toBe(-1);
    expect(opNextAuto(unknown({ auto: true }))).toBe(-1);
    expect(opNextAuto(withRoles(auto('ok', 'refused', 'unsent', { auto: true })))).toBe(-1);
    expect(opNextAuto(withRoles(auto('ok', 'ok', 'ok', { auto: true })))).toBe(-1);
    expect(opNextAuto({ ...close('ok', 'unsent'), auto: true })).toBe(-1);
  });

  it('a restart ends "checking" and "goes on by itself"; a verdict goes with the unknown step it was about', () => {
    const r = opAfterRestart({ ...unknown({ auto: true, checking: true }) });
    expect(r.checking).toBe(false);
    expect(r.auto).toBe(false);
    const done = opWithoutStale({ ...proven(), checking: true, steps: proven().steps.map((s, i) => (i === 0 ? { ...s, check: 'unseen' as const } : s)) });
    expect(done.checking).toBe(false);
    expect(done.steps[0].check).toBeUndefined();
  });
});
